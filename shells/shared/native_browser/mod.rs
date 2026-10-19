//! Physical native page owner. This module never advances a Session or executes a
//! tool policy: Kernel invokes the same exact page operations as the GUI controls.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, WebviewUrl};
#[cfg(windows)]
mod control_indicator;
#[cfg(feature = "debug-control")]
pub mod debug;
#[cfg(any(windows, test))]
mod preview_image;
mod services;
#[cfg(windows)]
use control_indicator::{ControlIndicator, ControlState};

static PAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn resource_id(binding: &HostBinding, kind: &str) -> String {
    format!(
        "{kind}-{}-{}",
        binding.host_instance_id,
        PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBinding {
    pub host_instance_id: String,
    pub window_label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(flatten)]
    binding: HostBinding,
    preview_id: String,
    url: String,
    status: String,
    visible: bool,
    service_owner: String,
    session_id: Option<String>,
    service_id: Option<String>,
    kind: String,
    surface: SurfaceState,
    #[serde(skip)]
    preview_run_id: Option<String>,
    #[serde(skip)]
    preview_sequence: u64,
    #[cfg(windows)]
    control: ControlState,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceState {
    generation: u64,
    sequence: u64,
    activation_id: u64,
    activation_ack: u64,
    reason: String,
    bounds: Option<[f64; 4]>,
}

impl Page {
    fn matches_target(
        &self,
        session_id: &Option<String>,
        url: &str,
        service_id: &Option<String>,
        kind: &str,
    ) -> bool {
        self.session_id == *session_id
            && self.url == url
            && self.service_id == *service_id
            && self.kind == kind
    }
}

pub struct NativeBrowser {
    directories: deepcode_host_connection::UserDirectories,
    binding: HostBinding,
    pages: Mutex<HashMap<String, Page>>,
    page_changed: Condvar,
    opening: tauri::async_runtime::Mutex<()>,
    previewing: tauri::async_runtime::Mutex<()>,
    stop: Arc<AtomicBool>,
    services: Mutex<HashMap<String, services::DevelopmentService>>,
    self_bootstrap: String,
    on_stop: Box<dyn Fn() + Send + Sync>,
    #[cfg(windows)]
    controls: control_indicator::ControlRuns,
}

impl NativeBrowser {
    pub fn stop(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        control_indicator::wake_on_stop(self);
        (self.on_stop)();
        if let Ok(mut services) = self.services.lock() {
            services.clear();
        }
    }
}

pub fn start(
    app: &tauri::AppHandle,
    directories: deepcode_host_connection::UserDirectories,
    host_instance_id: String,
    token: String,
    self_bootstrap: String,
    #[cfg(windows)] read_control_statuses: Box<
        dyn Fn(&[String]) -> Result<Value, String> + Send + Sync,
    >,
    on_stop: Box<dyn Fn() + Send + Sync>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let endpoint = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .to_string();
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    app.manage(NativeBrowser {
        #[cfg(windows)]
        controls: control_indicator::ControlRuns::default(),
        directories,
        binding: HostBinding {
            host_instance_id,
            window_label: "main".into(),
        },
        pages: Mutex::new(HashMap::new()),
        page_changed: Condvar::new(),
        opening: tauri::async_runtime::Mutex::new(()),
        previewing: tauri::async_runtime::Mutex::new(()),
        stop: Arc::clone(&stop),
        services: Mutex::new(HashMap::new()),
        self_bootstrap,
        on_stop,
    });
    #[cfg(windows)]
    control_indicator::start(app.clone(), read_control_statuses);
    let app = app.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || serve_connection(app, stream, &token));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(40))
                }
                Err(_) => break,
            }
        }
    });
    Ok(endpoint)
}

fn serve_connection(app: tauri::AppHandle, mut stream: TcpStream, token: &str) {
    let mut line = String::new();
    #[cfg(feature = "debug-control")]
    let mut debug_shutdown = false;
    // Darwin can inherit the listener's nonblocking flag. Framed worker reads
    // use blocking I/O with deadlines, independently of the accept loop.
    let read = stream
        .set_nonblocking(false)
        .and_then(|()| stream.set_read_timeout(Some(Duration::from_secs(5))))
        .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(5))))
        .and_then(|()| BufReader::new((&stream).take(1024 * 1024)).read_line(&mut line));
    let response = read.map_err(|error| error.to_string()).and_then(|_| {
        let request: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if request.get("token").and_then(Value::as_str) != Some(token) {
            return Err("native_browser_connection_rejected".into());
        }
        #[cfg(feature = "debug-control")]
        {
            debug_shutdown = request["input"]["action"] == "debug:shutdown";
        }
        tauri::async_runtime::block_on(execute(
            app.clone(),
            request["binding"].clone(),
            request["input"].clone(),
        ))
        .map(|data| json!({"ok":true,"data":data}))
    });
    let envelope = match response {
        Ok(envelope) => envelope,
        Err(message) => json!({"ok":false,"message":message}),
    };
    if let Ok(mut encoded) = serde_json::to_vec(&envelope) {
        encoded.push(b'\n');
        let _ = stream.write_all(&encoded);
    }
    #[cfg(feature = "debug-control")]
    if debug_shutdown && envelope["ok"] == true {
        let _ = stream.flush();
        app.exit(0);
    }
}

#[tauri::command]
pub fn deepcode_browser_host(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<HostBinding, String> {
    require_main(&webview)?;
    Ok(app.state::<NativeBrowser>().binding.clone())
}

#[tauri::command]
pub async fn deepcode_browser_command(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    binding: Value,
    input: Value,
) -> Result<Value, String> {
    require_main(&webview)?;
    if input["action"]
        .as_str()
        .is_some_and(|action| action.starts_with("debug:"))
    {
        return Err("Debug control requires the external operator connection.".into());
    }
    if input["action"]
        .as_str()
        .is_some_and(|action| action.starts_with("computer:"))
    {
        return Err("Computer control requires a Kernel-approved tool call.".into());
    }
    execute(app, binding, input).await
}

fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Browser controls belong to the primary GUI view.".into());
    }
    Ok(())
}

fn checked_binding(app: &tauri::AppHandle, binding: &Value) -> Result<HostBinding, String> {
    let state = app.state::<NativeBrowser>();
    let expected = &state.binding;
    if binding["hostInstanceId"].as_str() != Some(expected.host_instance_id.as_str())
        || binding["windowLabel"].as_str() != Some(expected.window_label.as_str())
    {
        return Err("native_browser_host_binding_mismatch".into());
    }
    Ok(expected.clone())
}

fn string<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

fn page_state(app: &tauri::AppHandle, preview_id: &str) -> Result<Page, String> {
    let state = app.state::<NativeBrowser>();
    let pages = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?;
    pages
        .get(preview_id)
        .cloned()
        .ok_or_else(|| format!("native_browser_page_closed: {preview_id}"))
}

fn publish(app: &tauri::AppHandle, page: &Page) {
    let _ = app.emit_to("main", "deepcode:browser-page", page);
}

/// Navigation belongs to the native page, independently of the selected Reader.
async fn ready_page(app: tauri::AppHandle, preview_id: String) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeBrowser>();
        let pages = state
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?;
        let (pages, _) = state
            .page_changed
            .wait_timeout_while(pages, Duration::from_secs(15), |pages| {
                pages
                    .get(&preview_id)
                    .is_some_and(|page| page.status == "loading")
            })
            .map_err(|_| "native_browser_state_unavailable")?;
        let page = pages
            .get(&preview_id)
            .ok_or_else(|| format!("native_browser_page_closed: {preview_id}"))?;
        if page.status != "ready" {
            return Err(format!(
                "native_browser_navigation_not_ready: {preview_id}; status={}; url={}",
                page.status, page.url
            ));
        }
        Ok(page.clone())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn activate(app: tauri::AppHandle, page: Page) -> Result<Value, String> {
    let mut page = ready_page(app.clone(), page.preview_id).await?;
    let activation_id = PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    {
        let state = app.state::<NativeBrowser>();
        let mut pages = state
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?;
        let current = pages
            .get_mut(&page.preview_id)
            .ok_or("native_browser_page_closed")?;
        current.surface.activation_id = activation_id;
        current.surface.reason = "mounting".into();
        page = current.clone();
    }
    app.emit_to("main", "deepcode:browser-activate", &page)
        .map_err(|error| error.to_string())?;
    let app_for_wait = app.clone();
    let page = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_wait.state::<NativeBrowser>();
        let pages = state
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?;
        let (pages, _) = state
            .page_changed
            .wait_timeout_while(pages, Duration::from_secs(5), |pages| {
                pages
                    .get(&page.preview_id)
                    .is_some_and(|page| page.surface.activation_ack < activation_id)
            })
            .map_err(|_| "native_browser_state_unavailable")?;
        let page = pages
            .get(&page.preview_id)
            .ok_or_else(|| format!("native_browser_page_closed: {}", page.preview_id))?;
        if page.surface.activation_ack < activation_id
            || !page.visible
            || page.surface.reason != "visible"
        {
            return Err(format!(
                "native_browser_page_not_visible: {}; reason={}; session={}",
                page.preview_id,
                if page.surface.activation_ack < activation_id {
                    "surfaceNotMounted"
                } else {
                    &page.surface.reason
                },
                page.session_id.as_deref().unwrap_or("")
            ));
        }
        Ok::<_, String>(page.clone())
    })
    .await
    .map_err(|error| error.to_string())??;
    let result = serde_json::to_value(&page).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let view = app
            .get_webview(&page.preview_id)
            .ok_or("native_browser_page_closed")?;
        let readiness = accessibility_macos::prepare(view, &page.url).await?;
        let mut result = result;
        result["readiness"] = readiness;
        return Ok(result);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(result)
}

#[cfg(target_os = "macos")]
mod accessibility_macos;

fn page_url(input: &Value) -> Result<tauri::Url, String> {
    if let Some(path) = input.get("filePath").and_then(Value::as_str) {
        let path = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("Browser file: {error}"))?;
        if !path.is_file() {
            return Err("Browser target is not a file.".into());
        }
        return tauri::Url::from_file_path(path).map_err(|_| "Invalid browser file path.".into());
    }
    let url = tauri::Url::parse(string(input, "url")?).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(
            "Browser URLs require HTTP or HTTPS; use filePath for a local HTML file.".into(),
        );
    }
    Ok(url)
}

/// Every operation names an exact Host/window; existing page operations also
/// require an exact preview id. No lookup by the most recently focused window.
pub async fn execute(app: tauri::AppHandle, binding: Value, input: Value) -> Result<Value, String> {
    let session_id = binding["sessionId"].as_str().map(str::to_string);
    let preview_run_id = binding["runId"].as_str().map(str::to_string);
    let tool_request = binding["runId"].is_string();
    #[cfg(windows)]
    let control_binding = binding.clone();
    let binding = checked_binding(&app, &binding)?;
    let action = string(&input, "action")?;
    #[cfg(feature = "debug-control")]
    if action.starts_with("debug:") {
        if tool_request || session_id.is_some() {
            return Err("Debug control is not a Provider tool.".into());
        }
        return debug::execute(app, input).await;
    }
    if action == "controlPreview" {
        if tool_request {
            return Err("Preview frames belong to the GUI Host.".into());
        }
        return control_preview(app, session_id, input).await;
    }
    if action.starts_with("computer:") {
        return Err("Computer control requires the Kernel native transport.".into());
    }
    if action.starts_with("service") {
        let directory = app
            .state::<NativeBrowser>()
            .directories
            .log_dir
            .join("development-services")
            .join(&binding.host_instance_id);
        let state = app.state::<NativeBrowser>();
        let mut services = state
            .services
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?;
        return services::execute(&mut services, directory, session_id.as_deref(), &input);
    }
    if action == "hostStatus" {
        return Ok(json!({
            "binding": binding,
            "ready": true,
            "captureAvailable": cfg!(any(target_os = "macos", windows)),
        }));
    }
    if action == "refreshInterface" {
        let view = app
            .get_webview(&binding.window_label)
            .ok_or("native_browser_window_closed")?;
        return eval(view, "(()=>{if(!window.__DEEPCODE_INTERFACE__)throw Error('Interface refresh is unavailable in this document');return window.__DEEPCODE_INTERFACE__.refresh()})()".into()).await;
    }
    if action == "list" {
        let pages = app
            .state::<NativeBrowser>()
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .values()
            .filter(|page| session_id.is_none() || page.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        return Ok(json!({"pages":pages}));
    }
    if matches!(action, "open" | "openSelf") {
        let state = app.state::<NativeBrowser>();
        let opening = state.opening.lock().await;
        let service_id = input["serviceId"].as_str().map(str::to_string);
        let url = if action == "openSelf" {
            tauri::Url::parse("deepcode-gui://localhost/index.html")
                .map_err(|error| error.to_string())?
        } else if let Some(service_id) = service_id.as_deref() {
            let state = app.state::<NativeBrowser>();
            let services = state
                .services
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let service = services
                .get(service_id)
                .ok_or("Development service is not owned by this Host.")?;
            if session_id.is_some()
                && service.description["sessionId"].as_str() != session_id.as_deref()
            {
                return Err("native_browser_service_session_mismatch".into());
            }
            page_url(&service.description)?
        } else {
            page_url(&input)?
        };
        let kind = if action == "openSelf" {
            "deepcode"
        } else {
            "page"
        };
        let existing = state
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .values()
            .find(|page| page.matches_target(&session_id, url.as_str(), &service_id, kind))
            .cloned();
        if let Some(page) = existing {
            drop(opening);
            bind_preview_target(&app, &page.preview_id, preview_run_id.as_deref())?;
            #[cfg(windows)]
            let _control = if tool_request {
                Some(ControlIndicator::begin(
                    &app,
                    &control_binding,
                    Some(&page.preview_id),
                )?)
            } else {
                None
            };
            let page = if tool_request {
                ready_page(app.clone(), page.preview_id).await?
            } else {
                page
            };
            return serde_json::to_value(page).map_err(|error| error.to_string());
        }
        let id = resource_id(&binding, "preview");
        let page = Page {
            binding: binding.clone(),
            preview_id: id.clone(),
            url: url.to_string(),
            status: "loading".into(),
            visible: false,
            service_owner: if service_id.is_some() {
                "host"
            } else if action == "openSelf" {
                "sharedHost"
            } else if url.scheme() == "file" {
                "file"
            } else {
                "external"
            }
            .into(),
            session_id,
            service_id,
            kind: kind.into(),
            surface: SurfaceState::default(),
            preview_run_id: None,
            preview_sequence: 0,
            #[cfg(windows)]
            control: ControlState::default(),
        };
        app.state::<NativeBrowser>()
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .insert(id.clone(), page.clone());
        let app_for_create = app.clone();
        let id_for_create = id.clone();
        let self_bootstrap =
            (action == "openSelf").then(|| app.state::<NativeBrowser>().self_bootstrap.clone());
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let outcome = (|| {
                let window = app_for_create
                    .get_window(&binding.window_label)
                    .ok_or("native_browser_window_closed")?;
                let mut builder =
                    tauri::webview::WebviewBuilder::new(&id_for_create, WebviewUrl::External(url))
                        .initialization_script("window.__DEEPCODE_BROWSER_PREVIEW__ = true;")
                        .data_directory(
                            app_for_create
                                .state::<NativeBrowser>()
                                .directories
                                .cache_dir
                                .join("webview"),
                        )
                        .on_page_load(|webview, payload| {
                            let app = webview.app_handle();
                            let state = app.state::<NativeBrowser>();
                            if let Ok(mut pages) = state.pages.lock() {
                                if let Some(page) = pages.get_mut(webview.label()) {
                                    page.url = payload.url().to_string();
                                    page.status = match payload.event() {
                                        tauri::webview::PageLoadEvent::Started => "loading",
                                        tauri::webview::PageLoadEvent::Finished => "ready",
                                    }
                                    .into();
                                    publish(app, page);
                                    state.page_changed.notify_all();
                                }
                            };
                        });
                if let Some(script) = self_bootstrap {
                    builder = builder.initialization_script(script).on_navigation(|url| {
                        (url.scheme() == "deepcode-gui" && url.host_str() == Some("localhost"))
                            || (url.scheme() == "about" && matches!(url.path(), "srcdoc" | "blank"))
                    });
                }
                #[cfg(feature = "debug-control")]
                let builder =
                    builder.initialization_script_for_all_frames(debug::initialization_script());
                let view = window
                    .add_child(
                        builder,
                        tauri::LogicalPosition::new(0.0, 0.0),
                        tauri::LogicalSize::new(1280.0, 800.0),
                    )
                    .map_err(|error| error.to_string())?;
                view.hide().map_err(|error| error.to_string())?;
                Ok::<_, String>(())
            })();
            let _ = tx.send(outcome);
        })
        .map_err(|error| error.to_string())?;
        let created = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(15))
                .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?;
        if let Err(error) = created {
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .remove(&id);
            return Err(error);
        }
        let page = page_state(&app, &id)?;
        bind_preview_target(&app, &id, preview_run_id.as_deref())?;
        #[cfg(windows)]
        control_indicator::publish_current(&app, &id)?;
        #[cfg(not(windows))]
        publish(&app, &page);
        drop(opening);
        if tool_request {
            #[cfg(windows)]
            let _control = ControlIndicator::begin(&app, &control_binding, Some(&id))?;
            return serde_json::to_value(ready_page(app.clone(), id).await?)
                .map_err(|error| error.to_string());
        }
        return serde_json::to_value(page).map_err(|error| error.to_string());
    }
    let id = string(&input, "previewId")?;
    let mut page = page_state(&app, id)?;
    if session_id.is_some() && page.session_id != session_id {
        return Err("native_browser_page_session_mismatch".into());
    }
    let view = app.get_webview(id).ok_or("native_browser_page_closed")?;
    if tool_request
        && matches!(
            action,
            "act" | "capture" | "activate" | "navigate" | "reload"
        )
    {
        bind_preview_target(&app, id, preview_run_id.as_deref())?;
    }
    #[cfg(windows)]
    let _control = if tool_request
        && matches!(
            action,
            "act" | "capture" | "activate" | "navigate" | "reload"
        ) {
        Some(ControlIndicator::begin(&app, &control_binding, Some(id))?)
    } else {
        None
    };
    if matches!(action, "act" | "capture" | "reviewStart") {
        page = ready_page(app.clone(), id.to_string()).await?;
    }
    match action {
        "activateControlPreview" => {
            if tool_request || page.preview_run_id.as_deref() != input["runId"].as_str() {
                return Err("native_browser_preview_target_changed".into());
            }
            let result = activate(app.clone(), page).await?;
            view.window()
                .set_focus()
                .map_err(|error| error.to_string())?;
            view.set_focus().map_err(|error| error.to_string())?;
            return Ok(result);
        }
        "activate" => return activate(app.clone(), page).await,
        "reviewStart" => {
            if !page.visible {
                return Err("Open the page before annotating it.".into());
            }
            let options = json!({"labels": input["labels"], "annotation": input["annotation"], "reviewId": input["reviewId"]});
            return eval(view, format!("{}({options})", include_str!("review.js"))).await;
        }
        "reviewRead" => {
            return eval(view, "JSON.parse(JSON.stringify({active:Boolean(window.__deepcodeReview?.active),exitReason:window.__deepcodeReview?.exitReason??null,pending:window.__deepcodeReview?.pending??null}))".into()).await;
        }
        "reviewAcknowledge" => {
            let id =
                serde_json::to_string(string(&input, "id")?).map_err(|error| error.to_string())?;
            return eval(
                view,
                format!(
                    "(()=>{{window.__deepcodeReview?.acknowledge({id});return {{ok:true}}}})()"
                ),
            )
            .await;
        }
        "reviewEnd" => {
            let review_id =
                serde_json::to_string(&input["reviewId"]).map_err(|error| error.to_string())?;
            return eval(
                view,
                format!("(()=>{{const state=window.__deepcodeReview;if(state?.reviewId==={review_id})state.dispose();return {{active:Boolean(window.__deepcodeReview?.active)}}}})()"),
            )
            .await;
        }
        "bindSurface" => {
            if tool_request {
                return Err("Browser surfaces are owned by the GUI Host.".into());
            }
            let state = app.state::<NativeBrowser>();
            let mut pages = state
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let current = pages.get_mut(id).ok_or("native_browser_page_closed")?;
            current.surface.generation += 1;
            current.surface.sequence = 0;
            current.surface.reason = "mounting".into();
            return serde_json::to_value(current).map_err(|error| error.to_string());
        }
        "activationResult" => {
            if tool_request {
                return Err("Browser activation replies are owned by the GUI Host.".into());
            }
            let state = app.state::<NativeBrowser>();
            let mut pages = state
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let current = pages.get_mut(id).ok_or("native_browser_page_closed")?;
            if input["activationId"].as_u64() == Some(current.surface.activation_id) {
                let reason = string(&input, "reason")?;
                if reason != "sessionNotSelected" {
                    return Err("Invalid activation result.".into());
                }
                current.surface.activation_ack = current.surface.activation_id;
                current.surface.reason = reason.into();
                state.page_changed.notify_all();
            }
            return serde_json::to_value(current).map_err(|error| error.to_string());
        }
        "status" => {
            return serde_json::to_value(page).map_err(|error| error.to_string());
        }
        "focus" => {
            view.set_focus().map_err(|error| error.to_string())?;
        }
        "navigate" => {
            if page.kind == "deepcode" {
                return Err("The DeepCode preview remains connected to its original Host; open a separate page to navigate.".into());
            }
            let url = page_url(&input)?;
            {
                let state = app.state::<NativeBrowser>();
                let mut pages = state
                    .pages
                    .lock()
                    .map_err(|_| "native_browser_state_unavailable")?;
                let current = pages.get_mut(id).ok_or("native_browser_page_closed")?;
                current.url = url.to_string();
                current.status = "loading".into();
            }
            view.navigate(url).map_err(|error| error.to_string())?;
        }
        "reload" => {
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .get_mut(id)
                .ok_or("native_browser_page_closed")?
                .status = "loading".into();
            view.reload().map_err(|error| error.to_string())?;
        }
        "layout" => {
            if tool_request {
                return Err("Browser layout is owned by the GUI Host.".into());
            }
            let state = app.state::<NativeBrowser>();
            let mut pages = state
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let current = pages.get_mut(id).ok_or("native_browser_page_closed")?;
            let generation = input["surfaceGeneration"]
                .as_u64()
                .ok_or("surfaceGeneration is required")?;
            let sequence = input["sequence"].as_u64().ok_or("sequence is required")?;
            if generation != current.surface.generation || sequence <= current.surface.sequence {
                return serde_json::to_value(current).map_err(|error| error.to_string());
            }
            let visible = input["visible"].as_bool().ok_or("visible is required")?;
            let reason = if visible {
                "visible"
            } else {
                let reason = string(&input, "reason")?;
                if !matches!(reason, "inactive" | "covered" | "emptyBounds" | "unmounted") {
                    return Err("Invalid visibility reason.".into());
                }
                reason
            };
            if visible {
                let coordinate = |field: &str| {
                    input[field]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| format!("Invalid browser {field}"))
                };
                let (x, y, width, height) = (
                    coordinate("x")?,
                    coordinate("y")?,
                    coordinate("width")?,
                    coordinate("height")?,
                );
                if width < 1.0 || height < 1.0 {
                    return Err("Browser bounds are empty.".into());
                }
                view.set_bounds(tauri::Rect {
                    position: tauri::LogicalPosition::new(x, y).into(),
                    size: tauri::LogicalSize::new(width, height).into(),
                })
                .map_err(|error| error.to_string())?;
                view.show().map_err(|error| error.to_string())?;
                current.surface.bounds = Some([x, y, width, height]);
            } else {
                view.hide().map_err(|error| error.to_string())?;
            }
            current.visible = visible;
            current.surface.sequence = sequence;
            current.surface.reason = reason.into();
            // Inactive/unmount messages can arrive while the selected Reader is mounting.
            // Only the active surface or an explicit session rejection settles activation.
            if matches!(reason, "visible" | "covered" | "emptyBounds")
                && input["activationId"].as_u64() == Some(current.surface.activation_id)
            {
                current.surface.activation_ack = current.surface.activation_id;
            }
            state.page_changed.notify_all();
        }
        "act" => {
            let operation = string(&input, "operation")?;
            let code = match operation {
                "click" | "type" | "scroll" => {
                    format!("return ({})({input});", include_str!("act.js"))
                }
                "inspect" => include_str!("observe.js").into(),
                _ => return Err("Unsupported browser operation.".into()),
            };
            let result = eval(view, format!("(()=>{{{code}}})()")).await?;
            return Ok(json!({"page":page,"result":result}));
        }
        "capture" => {
            let state = app.state::<NativeBrowser>();
            let _capture_owner = state.previewing.lock().await;
            page = page_state(&app, id)?;
            page.url = view.url().map_err(|error| error.to_string())?.to_string();
            // A capture belongs to one acknowledged surface geometry.
            let geometry = (page.surface.generation, page.surface.sequence);
            #[cfg(windows)]
            let offscreen = show_offscreen_for_capture(&app, id, &view)?;
            let captured = capture(view.clone()).await;
            #[cfg(windows)]
            if let Some(previous) = offscreen {
                hide_after_offscreen_capture(&app, id, &view, previous, geometry);
            }
            let capture = captured?;
            let current = page_state(&app, id)?;
            if geometry != (current.surface.generation, current.surface.sequence) {
                return Err(format!("native_browser_layout_changed: {id}"));
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis();
            let directory = match input.get("captureDirectory").and_then(Value::as_str) {
                Some(path) => PathBuf::from(path),
                None => app
                    .state::<NativeBrowser>()
                    .directories
                    .cache_dir
                    .join("browser-captures")
                    .join(&binding.host_instance_id),
            };
            std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let path = directory.join(format!(
                "{id}-{stamp}-{}.png",
                PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            file.write_all(&capture.bytes)
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            return Ok(
                json!({"contentRef":path,"contentType":"image/png","width":capture.width,"height":capture.height,"sourcePage":{"hostInstanceId":binding.host_instance_id,"windowLabel":binding.window_label,"previewId":id,"url":page.url,"capturedAt":stamp.to_string(),"range":"viewport"}}),
            );
        }
        "close" => {
            view.close().map_err(|error| error.to_string())?;
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .remove(id);
            app.state::<NativeBrowser>().page_changed.notify_all();
            page.status = "closed".into();
            page.visible = false;
            publish(&app, &page);
            return Ok(json!({"previewId":id,"status":"closed"}));
        }
        _ => return Err(format!("Unsupported browser action: {action}")),
    }
    // Page-load callbacks own navigation state. A layout/focus request must not
    // restore an older cloned URL or status after one of those callbacks.
    let page = if tool_request && matches!(action, "reload" | "navigate") {
        ready_page(app.clone(), id.to_string()).await?
    } else {
        page_state(&app, id)?
    };
    if action != "layout" {
        #[cfg(windows)]
        control_indicator::publish_current(&app, id)?;
        #[cfg(not(windows))]
        publish(&app, &page);
    }
    serde_json::to_value(page).map_err(|error| error.to_string())
}

async fn eval(view: tauri::Webview, script: String) -> Result<Value, String> {
    let preview_id = view.label().to_string();
    let script = format!("(()=>{{try{{return {{ok:true,data:({script})}}}}catch(error){{return {{ok:false,message:String(error)}}}}}})()");
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.eval_with_callback(script, move |value| {
        let _ = tx.send(value);
    })
    .map_err(|error| error.to_string())?;
    let value =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("native_browser_evaluation_failed: {preview_id}; {error}"))?;
    let result: Value =
        serde_json::from_str(&value).map_err(|error| format!("Browser evaluation: {error}"))?;
    if result["ok"] != true {
        return Err(format!(
            "native_browser_evaluation_failed: {preview_id}; {}",
            result["message"]
                .as_str()
                .unwrap_or("Invalid browser evaluation response")
        ));
    }
    Ok(result["data"].clone())
}

struct Capture {
    bytes: Vec<u8>,
    width: i64,
    height: i64,
}

fn bind_preview_target(app: &tauri::AppHandle, id: &str, run: Option<&str>) -> Result<(), String> {
    let Some(run) = run else { return Ok(()) };
    let state = app.state::<NativeBrowser>();
    let mut pages = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?;
    let session = pages
        .get(id)
        .ok_or("native_browser_page_closed")?
        .session_id
        .clone();
    // One actual tool target per Session/run. Closing it must not resurrect an older page.
    for page in pages.values_mut() {
        if page.preview_id != id
            && page.session_id == session
            && page.preview_run_id.as_deref() == Some(run)
        {
            page.preview_run_id = None;
        }
    }
    let page = pages.get_mut(id).ok_or("native_browser_page_closed")?;
    page.preview_run_id = Some(run.to_string());
    page.preview_sequence = PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn control_preview(
    app: tauri::AppHandle,
    session: Option<String>,
    input: Value,
) -> Result<Value, String> {
    let run = string(&input, "runId")?;
    if session.is_none() {
        return Err("native_browser_preview_session_required".into());
    }
    let state = app.state::<NativeBrowser>();
    let Ok(_capture_owner) = state.previewing.try_lock() else {
        return Ok(json!({"pending":true}));
    };
    let page = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?
        .values()
        .filter(|page| page.session_id == session && page.preview_run_id.as_deref() == Some(run))
        .max_by_key(|page| page.preview_sequence)
        .cloned();
    let Some(page) = page else {
        return Ok(if input["expectedPreviewId"].is_string() {
            json!({"state":"closed","reason":"native_browser_page_closed"})
        } else {
            json!({"state":"inactive"})
        });
    };
    let target = json!({"previewId":page.preview_id,"url":page.url,"hostInstanceId":page.binding.host_instance_id,
        "windowLabel":page.binding.window_label,"sessionId":page.session_id});
    if page.status != "ready" {
        return Ok(json!({"state":"updating","target":target,"reason":page.status}));
    }
    let view = app
        .get_webview(&page.preview_id)
        .ok_or("native_browser_page_closed")?;
    let geometry = (page.surface.generation, page.surface.sequence);
    #[cfg(windows)]
    let frame = match show_offscreen_for_capture(&app, &page.preview_id, &view) {
        Ok(previous) => {
            let frame = capture_preview(view.clone()).await;
            if let Some(previous) = previous {
                hide_after_offscreen_capture(&app, &page.preview_id, &view, previous, geometry);
            }
            frame
        }
        Err(error) => Err(error),
    };
    #[cfg(not(windows))]
    let frame = capture_preview(view).await;
    let current = page_state(&app, &page.preview_id)?;
    if current.preview_run_id != page.preview_run_id
        || current.preview_sequence != page.preview_sequence
        || current.url != page.url
        || current.status != "ready"
        || (current.surface.generation, current.surface.sequence) != geometry
    {
        return Ok(
            json!({"state":"updating","target":target,"reason":"native_browser_target_changed"}),
        );
    }
    match frame {
        Ok(frame) => Ok(json!({"state":"active","target":target,"frame":frame})),
        Err(error) => Ok(json!({"state":"failed","target":target,"frameError":error})),
    }
}

#[cfg(target_os = "macos")]
async fn capture_preview(view: tauri::Webview) -> Result<Value, String> {
    use objc2_foundation::{NSData, NSDataBase64EncodingOptions};
    let scale = view
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let size = view.size().map_err(|error| error.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Err("native_browser_preview_empty_bounds".into());
    }
    let width = 720.0 * f64::from(size.width) / f64::from(size.width.max(size.height)) / scale;
    let capture = capture_macos(view, Some(width)).await?;
    if capture.width > 722 || capture.height > 722 || capture.bytes.len() > 1_048_576 {
        return Err("native_browser_preview_frame_too_large".into());
    }
    let encoded = NSData::with_bytes(&capture.bytes)
        .base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(
        json!({"sequence":PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed),"capturedAt":stamp.to_string(),
        "width":capture.width,"height":capture.height,"dataUrl":format!("data:image/jpeg;base64,{encoded}")}),
    )
}

#[cfg(windows)]
async fn capture_preview(view: tauri::Webview) -> Result<Value, String> {
    use base64::Engine;
    let capture = capture(view).await?;
    let (bytes, width, height) =
        tauri::async_runtime::spawn_blocking(move || preview_image::jpeg(&capture.bytes))
            .await
            .map_err(|error| error.to_string())??;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(
        json!({"sequence":PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed),"capturedAt":stamp.to_string(),
        "width":width,"height":height,"dataUrl":format!("data:image/jpeg;base64,{encoded}")}),
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn capture_preview(_view: tauri::Webview) -> Result<Value, String> {
    Err("native_browser_preview_requires_macos_or_windows".into())
}

#[cfg(target_os = "macos")]
async fn capture(view: tauri::Webview) -> Result<Capture, String> {
    capture_macos(view, None).await
}

#[cfg(target_os = "macos")]
async fn capture_macos(
    view: tauri::Webview,
    snapshot_width: Option<f64>,
) -> Result<Capture, String> {
    use objc2::{AnyThread, MainThreadOnly};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *const WKWebView);
        let completion = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let outcome = (|| {
                if let Some(error) = error.as_ref() {
                    return Err(error.localizedDescription().to_string());
                }
                let image = image
                    .as_ref()
                    .ok_or("WKWebView returned no snapshot image")?;
                let tiff = image
                    .TIFFRepresentation()
                    .ok_or("Snapshot image encoding failed")?;
                let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                    .ok_or("Snapshot bitmap encoding failed")?;
                let data = bitmap
                    .representationUsingType_properties(
                        if snapshot_width.is_some() {
                            NSBitmapImageFileType::JPEG
                        } else {
                            NSBitmapImageFileType::PNG
                        },
                        &NSDictionary::new(),
                    )
                    .ok_or("Snapshot image encoding failed")?;
                Ok(Capture {
                    bytes: data.to_vec(),
                    width: bitmap.pixelsWide() as i64,
                    height: bitmap.pixelsHigh() as i64,
                })
            })();
            let _ = tx.send(outcome);
        });
        let configuration = WKSnapshotConfiguration::new(webview.mtm());
        if let Some(width) = snapshot_width {
            configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
            configuration.setAfterScreenUpdates(false);
        }
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &completion);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A hidden WebView2 produces no frames, so CapturePreview would never complete.
/// Render the page outside the host window's client area for this capture: it
/// is drawn by WebView2 but never shown, and the GUI's layout state is unchanged.
/// Returns the bounds to restore, or None for a page the GUI already shows.
#[cfg(windows)]
fn show_offscreen_for_capture(
    app: &tauri::AppHandle,
    id: &str,
    view: &tauri::Webview,
) -> Result<Option<tauri::Rect>, String> {
    let state = app.state::<NativeBrowser>();
    // Layout changes take this lock while they show, hide or move the page.
    let pages = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?;
    let current = pages.get(id).ok_or("native_browser_page_closed")?;
    if current.visible {
        return Ok(None);
    }
    let previous = view.bounds().map_err(|error| error.to_string())?;
    let size = current
        .surface
        .bounds
        .map(|[_, _, width, height]| tauri::LogicalSize::new(width, height).into())
        .unwrap_or(previous.size);
    view.set_bounds(tauri::Rect {
        position: tauri::PhysicalPosition::new(-16000, -16000).into(),
        size,
    })
    .map_err(|error| error.to_string())?;
    view.show().map_err(|error| error.to_string())?;
    Ok(Some(previous))
}

/// Hide again only if the GUI did not change this page's layout meanwhile; a
/// newer layout already owns its visibility and the capture reports the change.
#[cfg(windows)]
fn hide_after_offscreen_capture(
    app: &tauri::AppHandle,
    id: &str,
    view: &tauri::Webview,
    previous: tauri::Rect,
    geometry: (u64, u64),
) {
    let state = app.state::<NativeBrowser>();
    let Ok(pages) = state.pages.lock() else {
        return;
    };
    if pages.get(id).is_some_and(|current| {
        !current.visible && (current.surface.generation, current.surface.sequence) == geometry
    }) {
        let _ = view.hide();
        let _ = view.set_bounds(previous);
    }
}

/// WebView2 renders its own viewport into a PNG stream, independent of window
/// stacking. The completion handler runs on the GUI thread that owns the WebView.
#[cfg(windows)]
async fn capture(view: tauri::Webview) -> Result<Capture, String> {
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::System::Com::{
        IStream, StructuredStorage::CreateStreamOnHGlobal, STATFLAG_NONAME, STATSTG,
        STREAM_SEEK_SET,
    };
    fn read_stream(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        unsafe {
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            if stat.cbSize > 64 * 1024 * 1024 {
                return Err(windows::core::Error::new(
                    windows::Win32::Foundation::E_OUTOFMEMORY,
                    "WebView2 capture exceeds 64 MiB",
                ));
            }
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut bytes = vec![0u8; stat.cbSize as usize];
            let mut read = 0u32;
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut read),
                )
                .ok()?;
            bytes.truncate(read as usize);
            Ok(bytes)
        }
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, String>>(1);
    view.with_webview(move |platform| {
        let failed = tx.clone();
        let started = (|| -> windows::core::Result<()> {
            unsafe {
                let webview = platform.controller().CoreWebView2()?;
                let stream = CreateStreamOnHGlobal(Default::default(), true)?;
                let target = stream.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    let outcome = result
                        .and_then(|()| read_stream(&target))
                        .map_err(|error| format!("WebView2 capture failed: {error}"));
                    let _ = tx.send(outcome);
                    Ok(())
                }));
                webview.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
            }
        })();
        if let Err(error) = started {
            let _ = failed.send(Err(format!("WebView2 capture failed: {error}")));
        }
    })
    .map_err(|error| error.to_string())?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|error| error.to_string())??;
    let (width, height) = png_dimensions(&bytes)?;
    Ok(Capture {
        bytes,
        width,
        height,
    })
}

/// Width and height from the PNG IHDR chunk.
#[cfg(any(windows, test))]
fn png_dimensions(bytes: &[u8]) -> Result<(i64, i64), String> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("WebView2 capture is not a PNG image".into());
    }
    let read = |offset: usize| {
        u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as i64
    };
    let (width, height) = (read(16), read(20));
    if width == 0 || height == 0 {
        return Err("WebView2 capture is empty; the preview may not be rendered".into());
    }
    Ok((width, height))
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn capture(_view: tauri::Webview) -> Result<Capture, String> {
    Err("Native viewport capture is not implemented for this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_come_from_the_header_and_reject_empty_frames() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&1280u32.to_be_bytes());
        png.extend_from_slice(&720u32.to_be_bytes());
        assert_eq!(png_dimensions(&png).unwrap(), (1280, 720));
        let mut empty = png.clone();
        empty[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert!(png_dimensions(&empty).is_err());
        assert!(png_dimensions(b"GIF89a").is_err());
    }

    #[test]
    fn page_reuse_preserves_resource_and_session_identity() {
        let page = Page {
            binding: HostBinding {
                host_instance_id: "host".into(),
                window_label: "main".into(),
            },
            preview_id: "preview-1".into(),
            url: "file:///input/interactive-test.html".into(),
            session_id: Some("session:one".into()),
            service_id: None,
            kind: "page".into(),
            service_owner: "file".into(),
            status: "ready".into(),
            visible: false,
            surface: SurfaceState::default(),
            preview_run_id: None,
            preview_sequence: 0,
            #[cfg(windows)]
            control: ControlState::default(),
        };
        assert!(
            page.matches_target(&page.session_id, &page.url, &None, "page"),
            "a hidden user page can be reused by a tool"
        );
        assert!(!page.matches_target(&Some("session:two".into()), &page.url, &None, "page"));
        assert!(!page.matches_target(
            &page.session_id,
            "file:///project/interactive-test.html",
            &None,
            "page"
        ));
        assert!(!page.matches_target(
            &page.session_id,
            &page.url,
            &Some("service:one".into()),
            "page"
        ));
        assert!(!page.matches_target(&page.session_id, &page.url, &None, "deepcode"));
    }
}
