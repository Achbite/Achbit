//! Native product updates. Session remains the authority for task activity.
#[cfg(any(target_os = "macos", test))]
mod macos;

use super::{runtime_locations, HostApiEnvelope, HostProcessGroup};
use achbit_host_connection::installation::{wait_for_process_exit, Installation};
use achbit_host_connection::loopback_http::request_loopback_json_until;
use achbit_kernel_abi::{HostProcessIdentity, HostShutdownReceipt, HOST_SHELL_TOKEN_HEADER};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{oneshot, Notify};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: String,
    current_version: String,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    reason: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Restart {
    version: String,
    storage: BTreeMap<String, String>,
    error: Option<String>,
}

type Reply = Option<BTreeMap<String, String>>;
pub struct ProductUpdates {
    status: Mutex<Status>,
    preparation: Mutex<Option<(u64, oneshot::Sender<Reply>)>>,
    sequence: AtomicU64,
    wake: Notify,
    installation: Installation,
    enabled: AtomicBool,
    automatic: AtomicBool,
    check_requested: AtomicBool,
    install_requested: AtomicBool,
}

fn restart_path() -> PathBuf {
    runtime_locations()
        .user
        .data_dir
        .join("gui-update-restart.json")
}

impl ProductUpdates {
    fn publish(&self, app: &AppHandle, phase: &str, reason: Option<&str>, error: Option<String>) {
        let mut status = self.status.lock().expect("Product update status");
        if status.phase != phase || status.reason.as_deref() != reason || error.is_some() {
            eprintln!(
                "[product-update] phase={phase} version={:?} reason={reason:?} error={error:?}",
                status.version
            );
        }
        status.phase = phase.into();
        status.reason = reason.map(str::to_owned);
        status.error = error;
        let _ = app.emit("achbit:product-update", status.clone());
    }
}

pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let installation = Installation::current()?;
    let enabled = installation.root().is_some()
        && app.state::<super::LaunchTarget>().ssh.is_none()
        && !super::env_truthy("ACHBIT_SHELL_CONNECT_ONLY")
        && (!cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some());
    #[cfg(feature = "debug-control")]
    let enabled = enabled && std::env::var_os("ACHBIT_DEBUG_UPDATE_URL").is_some();
    let current_version = app.package_info().version.to_string();
    let mut status = Status {
        phase: if enabled { "idle" } else { "disabled" }.into(),
        current_version: current_version.clone(),
        version: None,
        downloaded: 0,
        total: None,
        reason: None,
        error: None,
    };
    if restart_path().is_file() {
        let restart: Restart = serde_json::from_slice(&std::fs::read(restart_path())?)?;
        status.version = Some(restart.version.clone());
        status.error = restart.error.or_else(|| {
            (restart.version != current_version).then(|| {
                format!(
                    "Expected version {}, started {current_version}",
                    restart.version
                )
            })
        });
        status.phase = if status.error.is_some() {
            "error"
        } else {
            "updated"
        }
        .into();
    }
    let failed_restart = status.error.is_some();
    app.manage(ProductUpdates {
        status: Mutex::new(status),
        installation,
        preparation: Mutex::new(None),
        sequence: AtomicU64::new(0),
        wake: Notify::new(),
        enabled: AtomicBool::new(enabled),
        // The GUI supplies the saved preference after loading user settings.
        automatic: AtomicBool::new(false),
        check_requested: AtomicBool::new(false),
        install_requested: AtomicBool::new(false),
    });
    if enabled {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let updates = app.state::<ProductUpdates>();
            let mut automatic_retry = !failed_restart;
            let mut next_check = Instant::now() + Duration::from_secs(5);
            loop {
                let manual = updates.check_requested.swap(false, Ordering::SeqCst);
                automatic_retry |= manual;
                let automatic = updates.enabled.load(Ordering::SeqCst)
                    && automatic_retry
                    && updates.automatic.load(Ordering::SeqCst);
                if updates.enabled.load(Ordering::SeqCst)
                    && (manual || (automatic && Instant::now() >= next_check))
                {
                    if let Err(error) = check(&app).await {
                        updates.publish(&app, "error", None, Some(error));
                    }
                    next_check = Instant::now() + Duration::from_secs(30 * 60);
                    continue;
                }
                if automatic {
                    let _ = tokio::time::timeout(
                        next_check.saturating_duration_since(Instant::now()),
                        updates.wake.notified(),
                    )
                    .await;
                } else {
                    updates.wake.notified().await;
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn achbit_update_status(updates: State<'_, ProductUpdates>) -> Status {
    updates
        .status
        .lock()
        .expect("Product update status")
        .clone()
}
#[tauri::command]
pub fn achbit_update_check(updates: State<'_, ProductUpdates>) -> Result<(), String> {
    if !updates.enabled.load(Ordering::SeqCst) {
        return Err(updates
            .status
            .lock()
            .map_err(|_| "Product update status lock poisoned")?
            .error
            .clone()
            .unwrap_or_else(|| "Product updates are unavailable for this window".into()));
    }
    updates.check_requested.store(true, Ordering::SeqCst);
    updates.wake.notify_one();
    Ok(())
}
#[tauri::command]
pub fn achbit_update_configure(updates: State<'_, ProductUpdates>, enabled: bool) {
    updates.automatic.store(enabled, Ordering::SeqCst);
    updates.wake.notify_one();
}
#[tauri::command]
pub fn achbit_update_install(updates: State<'_, ProductUpdates>) -> Result<(), String> {
    let status = updates
        .status
        .lock()
        .map_err(|_| "Product update status lock poisoned")?;
    if !updates.enabled.load(Ordering::SeqCst) || status.phase != "waiting" {
        return Err("No downloaded update is ready to install".into());
    }
    updates.install_requested.store(true, Ordering::SeqCst);
    updates.wake.notify_one();
    Ok(())
}
#[tauri::command]
pub fn achbit_update_prepare_response(
    updates: State<'_, ProductUpdates>,
    nonce: u64,
    storage: Reply,
) -> Result<(), String> {
    if let Some(storage) = &storage {
        if storage.keys().any(|key| {
            !(key.starts_with("achbit:composer:")
                || key.starts_with("achbit:reader:")
                || key == "achbit:interface-reload")
        }) {
            return Err("Update snapshot contains unsupported state".into());
        }
    }
    let mut pending = updates
        .preparation
        .lock()
        .map_err(|_| "Update preparation lock poisoned")?;
    if pending
        .as_ref()
        .is_some_and(|(expected, _)| *expected == nonce)
    {
        let (_, reply) = pending.take().expect("Matching preparation");
        let _ = reply.send(storage);
    }
    Ok(())
}
#[tauri::command]
pub fn achbit_update_restore() -> Result<Option<BTreeMap<String, String>>, String> {
    match std::fs::read(restart_path()) {
        Ok(bytes) => serde_json::from_slice::<Restart>(&bytes)
            .map(|restart| Some(restart.storage))
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
#[tauri::command]
pub fn achbit_update_restored() -> Result<(), String> {
    match std::fs::remove_file(restart_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ProductUpdates>();
    state.publish(app, "checking", None, None);
    let builder = app.updater_builder().timeout(Duration::from_secs(180));
    #[cfg(feature = "debug-control")]
    let builder = {
        let url = std::env::var("ACHBIT_DEBUG_UPDATE_URL").map_err(|error| error.to_string())?;
        let endpoint = url
            .parse::<tauri::Url>()
            .map_err(|error| error.to_string())?;
        if !matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        ) {
            return Err("Debug update feed must use loopback".into());
        }
        builder
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .no_proxy()
    };
    #[cfg(windows)]
    let builder = {
        // The standard updater launches NSIS and exits this process.
        let handle = app.clone();
        let builder = builder.on_before_exit(move || {
            handle.state::<HostProcessGroup>().detach();
            if let Some(browser) = handle.try_state::<super::native_browser::NativeBrowser>() {
                browser.stop();
            }
            handle.cleanup_before_exit();
        });
        let root = state
            .installation
            .root()
            .ok_or("Installation directory is unavailable")?;
        builder.installer_arg(format!("/D={}", root.display()))
    };
    let Some(update) = builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        state.publish(app, "current", None, None);
        return Ok(());
    };
    {
        let mut status = state.status.lock().expect("Product update status");
        status.version = Some(update.version.clone());
        status.downloaded = 0;
        status.total = None;
    }
    state.publish(app, "downloading", None, None);
    let mut last_progress = Instant::now();
    let bytes = update
        .download(
            |length, total| {
                let mut status = state.status.lock().expect("Product update status");
                status.downloaded += length as u64;
                status.total = total;
                if last_progress.elapsed() >= Duration::from_millis(500) {
                    let _ = app.emit("achbit:product-update", status.clone());
                    last_progress = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    let bytes = Arc::new(bytes);
    state.publish(app, "waiting", None, None);
    loop {
        if !state.automatic.load(Ordering::SeqCst)
            && !state.install_requested.load(Ordering::SeqCst)
        {
            state.wake.notified().await;
            continue;
        }
        let _owner = match state.installation.update_owner() {
            Ok(owner) => owner,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                state.publish(app, "waiting", Some("clients"), None);
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        let nonce = state.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let manual = state.install_requested.swap(false, Ordering::SeqCst);
        let (send, receive) = oneshot::channel();
        *state
            .preparation
            .lock()
            .map_err(|_| "Update preparation lock poisoned")? = Some((nonce, send));
        app.emit(
            "achbit:update-prepare",
            json!({ "nonce": nonce, "manual": manual }),
        )
        .map_err(|error| error.to_string())?;
        let reply = tokio::time::timeout(Duration::from_secs(5), receive).await;
        state
            .preparation
            .lock()
            .map_err(|_| "Update preparation lock poisoned")?
            .take();
        if let Ok(Ok(Some(storage))) = reply {
            if !manual && !state.automatic.load(Ordering::SeqCst) {
                let _ = app.emit("achbit:update-resume", ());
                continue;
            }
            state.publish(app, "preparing", None, None);
            let handle = app.clone();
            let update = update.clone();
            let bytes = bytes.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                install(&handle, &update, &bytes, storage)
            })
            .await
            .map_err(|error| error.to_string())??
            {
                true => app.restart(),
                false => state.publish(app, "waiting", Some("tasks"), None),
            }
        } else {
            state.publish(app, "waiting", Some("interface"), None);
        }
        let _ = app.emit("achbit:update-resume", ());
        let _ = tokio::time::timeout(Duration::from_secs(10), state.wake.notified()).await;
    }
}

#[derive(Clone)]
struct Host {
    host: String,
    port: String,
    token: String,
    identity: HostProcessIdentity,
}
impl Host {
    fn request(&self, action: &str, token: Option<u64>) -> Result<Value, String> {
        let body =
            json!({"action":action,"token":token,"expectedIdentity":self.identity}).to_string();
        let request = format!("POST /api/host/update HTTP/1.1\r\nHost: {}:{}\r\n{}: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.host,self.port,HOST_SHELL_TOKEN_HEADER,self.token,body.len(),body);
        let reply: HostApiEnvelope<Value> = request_loopback_json_until(
            &self.host,
            &self.port,
            &request,
            Instant::now() + Duration::from_secs(45),
        )
        .map_err(|error| error.to_string())?;
        reply.into_data().map_err(|error| error.to_string())
    }
}
fn local_host(app: &AppHandle) -> Result<Option<Host>, String> {
    let processes = app.state::<HostProcessGroup>();
    let state = processes
        .state
        .lock()
        .map_err(|_| "Host process lock poisoned")?;
    if state.active_startups > 0 || state.shutting_down {
        return Err("Host startup or shutdown is in progress".into());
    }
    Ok(state.children.as_ref().map(|children| Host {
        host: children.daemon_host.clone(),
        port: children.daemon_port.clone(),
        token: children.daemon_token.clone(),
        identity: children.daemon_identity.clone(),
    }))
}
fn save_restart(restart: &Restart) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(&runtime_locations().user.data_dir)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, restart).map_err(|error| error.to_string())?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    file.persist(restart_path())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn install(
    app: &AppHandle,
    update: &Update,
    bytes: &[u8],
    storage: BTreeMap<String, String>,
) -> Result<bool, String> {
    let state = app.state::<ProductUpdates>();
    let host = local_host(app)?;
    if host.is_none() {
        return Ok(false);
    }
    let token = match &host {
        Some(host) => {
            let reply = host.request("prepare", None)?;
            if reply["prepared"] != true {
                return Ok(false);
            }
            Some(
                reply["token"]
                    .as_u64()
                    .ok_or("Host update token is missing")?,
            )
        }
        None => None,
    };
    let mut committed = false;
    let mut can_restart = true;
    let mut restart = Restart {
        version: update.version.clone(),
        storage,
        error: None,
    };
    let result = (|| -> Result<bool, String> {
        state
            .installation
            .release()
            .map_err(|error| error.to_string())?;
        let _exclusive = match state.installation.exclusive() {
            Ok(exclusive) => exclusive,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        save_restart(&restart)?;
        if let Some(host) = &host {
            committed = true;
            let receipt: HostShutdownReceipt =
                serde_json::from_value(host.request("commit", token)?)
                    .map_err(|error| error.to_string())?;
            wait_for_process_exit(host.identity.pid, Duration::from_secs(30))
                .map_err(|error| error.to_string())?;
            if !receipt.confirms_shutdown_of(&host.identity) {
                return Err("Host cleanup did not complete".into());
            }
        }
        committed = true;
        app.state::<HostProcessGroup>().detach();
        if let Some(browser) = app.try_state::<super::native_browser::NativeBrowser>() {
            browser.stop();
        }
        state.publish(app, "installing", None, None);
        #[cfg(target_os = "macos")]
        let replacement = macos::install(
            state
                .installation
                .root()
                .ok_or("Installation directory is unavailable")?,
            bytes,
        )
        .map_err(|failure| (failure.message, failure.can_restart));
        #[cfg(not(target_os = "macos"))]
        let replacement = update
            .install(bytes)
            .map_err(|error| (error.to_string(), true));
        if let Err((error, restart_allowed)) = replacement {
            can_restart = restart_allowed;
            return Err(error);
        }
        Ok(true)
    })();
    if !committed {
        state
            .installation
            .resume()
            .map_err(|error| error.to_string())?;
        if let Some(host) = &host {
            host.request("abort", token)?;
        }
        if let Err(error) = &result {
            let _ = app.emit("achbit:update-resume", ());
            eprintln!("Update preparation failed: {error}");
        }
    } else if let Err(error) = &result {
        restart.error = Some(error.clone());
        let mut failure = error.clone();
        if let Err(save_error) = save_restart(&restart) {
            failure.push_str(&format!(
                "; cannot save update recovery state: {save_error}"
            ));
            can_restart = false;
        }
        if can_restart {
            state.publish(app, "error", None, Some(failure));
            // The replacement either left the App untouched or restored it successfully.
            app.restart();
        }
        // Keep the recovery error visible; do not start another automatic update against
        // an installation that requires manual recovery. Keep the GUI open for the error.
        state.enabled.store(false, Ordering::SeqCst);
        if let Err(lease_error) = state.installation.resume() {
            failure.push_str(&format!(
                "; cannot resume installation lease: {lease_error}"
            ));
        }
        state.publish(app, "error", None, Some(failure.clone()));
        let _ = app.emit("achbit:update-resume", ());
        return Err(failure);
    }
    result
}
