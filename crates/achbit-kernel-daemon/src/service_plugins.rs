//! Host-owned long-lived plugin processes. They do not register models or tools.
use achbit_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree_until, OwnedHostProcess,
};
use achbit_kernel_abi::{valid_service_plugin_id, ServicePluginManifest, SERVICE_PLUGIN_PROTOCOL};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    id: String,
    path: PathBuf,
    enabled: bool,
}

pub(crate) fn sources(settings: &Value) -> Result<Vec<Source>, String> {
    let encoded = match settings.get("plugins.services") {
        None => "[]",
        Some(value) => value
            .as_str()
            .ok_or("plugins.services must be a JSON array string")?,
    };
    let sources: Vec<Source> =
        serde_json::from_str(encoded).map_err(|e| format!("plugins.services: {e}"))?;
    let mut ids = BTreeSet::new();
    for source in &sources {
        if !valid_service_plugin_id(&source.id)
            || !source.path.is_absolute()
            || !ids.insert(&source.id)
        {
            return Err(
                "Service plugin sources require unique ids and absolute folder paths".into(),
            );
        }
    }
    Ok(sources)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    protocol: String,
    base_url: String,
    #[serde(default)]
    page_url: Option<String>,
}

fn loopback_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Service plugin URLs must use http://127.0.0.1:PORT without credentials, query or fragment".into());
    }
    Ok(())
}

#[derive(Default)]
struct InstanceState {
    ready: Option<Ready>,
    error: Option<String>,
}

struct Supervisor {
    stop: mpsc::Sender<mpsc::SyncSender<Result<(), String>>>,
    thread: std::thread::JoinHandle<Result<(), String>>,
}

struct Instance {
    source: Source,
    state: Arc<Mutex<InstanceState>>,
    supervisor: Option<Supervisor>,
}

/// Only the supervisor owns Child and the process tree, including shutdown.
#[derive(Default)]
struct ServiceProcess(Option<OwnedHostProcess>);
impl ServiceProcess {
    fn stop(&mut self, graceful: bool) -> Result<(), String> {
        if let Some(process) = &mut self.0 {
            drop(process.child.stdin.take());
            if graceful {
                let deadline = Instant::now() + Duration::from_secs(1);
                while process
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            terminate_owned_process_tree_until(process, Instant::now() + Duration::from_secs(2))
                .map_err(|error| error.to_string())?;
        }
        self.0 = None;
        Ok(())
    }
}
impl Drop for ServiceProcess {
    fn drop(&mut self) {
        // Preserve ownership until the final stop attempt, including a supervisor panic.
        let _ = self.stop(false);
    }
}

impl Instance {
    fn start(
        &mut self,
        data: &Path,
        node: Result<PathBuf, String>,
        changes: tokio::sync::watch::Sender<()>,
    ) -> Result<(), String> {
        let source = self.source.clone();
        let data = data.to_owned();
        let state = Arc::clone(&self.state);
        let (stop, commands) = mpsc::channel::<mpsc::SyncSender<Result<(), String>>>();
        let (started, startup) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("achbit-plugin-service".into())
            .spawn(move || {
                let mut process = ServiceProcess::default();
                let startup = start_service(&source, &data, node, &mut process);
                let mut active = startup.is_ok();
                let result = match startup {
                    Ok(ready) => {
                        state.lock().expect("service state lock").ready = Some(ready);
                        Ok(())
                    }
                    Err(error) => {
                        let error = with_cleanup_error(error, process.stop(false));
                        state.lock().expect("service state lock").error = Some(error.clone());
                        Err(error)
                    }
                };
                changes.send_replace(());
                let _ = started.send(result);
                while process.0.is_some() {
                    // This Host adapter checks OS exit/cancellation, never GUI or model state.
                    let command = if active {
                        commands.recv_timeout(Duration::from_millis(20))
                    } else {
                        commands
                            .recv()
                            .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                    };
                    match command {
                        Ok(reply) => {
                            let result = process.stop(true);
                            active = false;
                            {
                                let mut state = state.lock().expect("service state lock");
                                state.ready = None;
                                if let Err(error) = &result {
                                    state.error = Some(match state.error.take() {
                                        Some(original) => format!("{original}; cleanup: {error}"),
                                        None => error.clone(),
                                    });
                                }
                            }
                            changes.send_replace(());
                            let _ = reply.send(result);
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let failure =
                                match process.0.as_mut().expect("owned service").child.try_wait() {
                                    Ok(None) => None,
                                    Ok(Some(status)) => {
                                        Some(format!("Service exited: {status}; see runtime.log"))
                                    }
                                    Err(error) => Some(error.to_string()),
                                };
                            if let Some(error) = failure {
                                let error = with_cleanup_error(error, process.stop(false));
                                active = false;
                                {
                                    let mut state = state.lock().expect("service state lock");
                                    state.ready = None;
                                    state.error = Some(error);
                                }
                                changes.send_replace(());
                            }
                        }
                    }
                }
                process.stop(false)
            })
            .map_err(|error| error.to_string())?;
        self.supervisor = Some(Supervisor { stop, thread });
        startup
            .recv()
            .map_err(|error| format!("Service supervisor startup: {error}"))?
    }

    fn stop(&mut self) -> Result<(), String> {
        let Some(supervisor) = &self.supervisor else {
            return Ok(());
        };
        let (reply, stopped) = mpsc::sync_channel(1);
        if supervisor.stop.send(reply).is_ok() {
            // An independently observed exit can finish between send and receive.
            // Joining below proves cleanup; a missing reply is not assumed success.
            if let Ok(result) = stopped.recv() {
                result?;
            }
        }
        let supervisor = self.supervisor.take().expect("owned supervisor");
        supervisor
            .thread
            .join()
            .map_err(|_| "Service supervisor panicked".to_owned())??;
        self.state.lock().expect("service state lock").ready = None;
        Ok(())
    }
}

fn with_cleanup_error(error: String, cleanup: Result<(), String>) -> String {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => format!("{error}; cleanup: {cleanup}"),
    }
}

fn start_service(
    source: &Source,
    data: &Path,
    node: Result<PathBuf, String>,
    owned: &mut ServiceProcess,
) -> Result<Ready, String> {
    let (manifest, entry) = ServicePluginManifest::read(&source.path)?;
    if manifest.id != source.id {
        return Err("Service plugin id changed; remove it and import again".into());
    }
    if manifest.debug_only && !cfg!(feature = "debug-control") {
        return Err("This service plugin requires an Achbit Debug build".into());
    }
    std::fs::create_dir_all(data).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("runtime.log"))
        .map_err(|error| error.to_string())?;
    let mut command = Command::new(node?);
    command
        .arg(entry)
        .args(manifest.args)
        .current_dir(&source.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log);
    owned.0 = Some(spawn_owned_host_process(&mut command).map_err(|error| error.to_string())?);
    let process = owned.0.as_mut().expect("spawned process");
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("Service stdout missing")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut bytes = Vec::new();
        let result = reader
            .by_ref()
            .take(65537)
            .read_until(b'\n', &mut bytes)
            .map_err(|error| error.to_string())
            .and_then(|_| {
                if bytes.len() > 65536 || !bytes.ends_with(b"\n") {
                    Err(
                        "Service exited or returned an invalid startup line; see runtime.log"
                            .into(),
                    )
                } else {
                    serde_json::from_slice::<Ready>(&bytes).map_err(|error| error.to_string())
                }
            });
        let _ = tx.send(result);
        // Pipe EOF is not process exit; only the supervisor publishes that fact.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let stdin = process
        .child
        .stdin
        .as_mut()
        .ok_or("Service stdin missing")?;
    writeln!(
        stdin,
        "{}",
        json!({"protocol":SERVICE_PLUGIN_PROTOCOL,"stateDirectory":data})
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let ready = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|error| format!("Service startup handshake: {error}; see runtime.log"))??;
    if ready.protocol != SERVICE_PLUGIN_PROTOCOL {
        return Err("Service startup protocol mismatch".into());
    }
    loopback_url(&ready.base_url)?;
    if let Some(page) = &ready.page_url {
        loopback_url(page)?;
    }
    if let Some(status) = process
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
    {
        return Err(format!(
            "Service exited during startup: {status}; see runtime.log"
        ));
    }
    Ok(ready)
}

pub(crate) struct ServicePlugins {
    entries: BTreeMap<String, Instance>,
    closed: bool,
    changes: tokio::sync::watch::Sender<()>,
}
impl Default for ServicePlugins {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            closed: false,
            changes: tokio::sync::watch::channel(()).0,
        }
    }
}
impl std::fmt::Debug for ServicePlugins {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.entries.keys()).finish()
    }
}
impl ServicePlugins {
    /// Stop before publishing a disable/removal. A cleanup failure retains ownership.
    pub(crate) fn prepare(&mut self, desired: &[Source]) -> Result<(), String> {
        if self.closed {
            return Err("Host is shutting down".into());
        }
        let removing = self
            .entries
            .iter()
            .filter(|(_, item)| {
                !desired
                    .iter()
                    .any(|source| source.enabled && *source == item.source)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in removing {
            self.entries
                .get_mut(&id)
                .expect("known instance")
                .stop()
                .map_err(|e| format!("{id}: {e}"))?;
            self.entries.remove(&id);
            self.changes.send_replace(());
        }
        Ok(())
    }

    pub(crate) fn activate(&mut self, desired: &[Source], data: &Path) {
        self.activate_with_node(desired, data, || {
            crate::session_service::resolve_node().map_err(|e| e.message)
        });
    }

    fn activate_with_node(
        &mut self,
        desired: &[Source],
        data: &Path,
        node: impl Fn() -> Result<PathBuf, String>,
    ) {
        for source in desired.iter().filter(|source| source.enabled) {
            if self.entries.contains_key(&source.id) {
                continue;
            }
            let mut item = Instance {
                source: source.clone(),
                state: Arc::new(Mutex::new(InstanceState::default())),
                supervisor: None,
            };
            if let Err(error) = item.start(
                &data.join("service-plugins").join(&source.id),
                node(),
                self.changes.clone(),
            ) {
                item.state.lock().expect("service state lock").error = Some(error);
            }
            self.entries.insert(source.id.clone(), item);
        }
        // Settings also change disabled/imported entries which have no process.
        self.changes.send_replace(());
    }

    pub(crate) fn subscribe(&self) -> tokio::sync::watch::Receiver<()> {
        self.changes.subscribe()
    }

    pub(crate) fn snapshot(&self, desired: &[Source], data: &Path) -> Value {
        let items = desired.iter().map(|source| {
            let metadata = ServicePluginManifest::read(&source.path).map(|(manifest, _)| manifest);
            let state = self.entries.get(&source.id).map(|item| item.state.lock().expect("service state lock"));
            let (status, ready, error) = match state.as_deref() {
                Some(state) => (if state.error.is_some() { "failed" } else if state.ready.is_some() { "running" } else { "stopped" }, state.ready.as_ref(), state.error.as_deref()),
                None => ("stopped", None, None),
            };
            json!({"id":source.id,"path":source.path,"enabled":source.enabled,
                "name":metadata.as_ref().map(|m| m.name.as_str()).unwrap_or(&source.id),
                "description":metadata.as_ref().map(|m| m.description.as_str()).unwrap_or(""),
                "status":status,"error":error.or_else(|| metadata.as_ref().err().map(String::as_str)),
                "baseUrl":ready.map(|r| &r.base_url),"pageUrl":ready.and_then(|r| r.page_url.as_ref()),
                "stateDirectory":data.join("service-plugins").join(&source.id)})
        }).collect::<Vec<_>>();
        json!({"services":items})
    }

    pub(crate) fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true;
        let errors = self
            .entries
            .iter_mut()
            .filter_map(|(id, entry)| entry.stop().err().map(|e| format!("{id}: {e}")))
            .collect::<Vec<_>>();
        if errors.is_empty() {
            self.entries.clear();
            self.changes.send_replace(());
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}
impl Drop for ServicePlugins {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(crate) async fn list(
    crate::ReadyState(state): crate::ReadyState,
) -> axum::Json<crate::ApiResponse> {
    match tokio::task::spawn_blocking(move || {
        let gui = state.gui.lock().expect("gui state lock");
        let desired = sources(&gui.user_settings)?;
        let data = gui.paths.directories.data_dir.clone();
        Ok::<_, String>(gui.service_plugins.snapshot(&desired, &data))
    })
    .await
    {
        Ok(Ok(value)) => crate::ApiResponse::ok(value),
        Ok(Err(error)) => crate::ApiResponse::error("plugin_services_unavailable", error),
        Err(error) => crate::ApiResponse::error("plugin_services_unavailable", error.to_string()),
    }
}

pub(crate) async fn events(
    crate::ReadyState(state): crate::ReadyState,
) -> axum::response::Response {
    use axum::response::{sse::Event, IntoResponse, Sse};
    let mut changes = state
        .gui
        .lock()
        .expect("gui state lock")
        .service_plugins
        .subscribe();
    let stream = async_stream::stream! {
        // Subscribe before ready, then read the inventory without an event gap.
        yield Ok::<_, std::convert::Infallible>(Event::default().event("ready").data("{}"));
        while changes.changed().await.is_ok() {
            yield Ok(Event::default().event("change").data("{}"));
        }
    };
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{SocketAddr, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(script: &str, debug_only: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "achbit-service-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("entry.cjs"), script).unwrap();
            std::fs::write(root.join("achbit-service.json"), serde_json::to_vec(&json!({"schema":SERVICE_PLUGIN_PROTOCOL,"id":"sample","name":"Sample","description":"Fixture","entry":"entry.cjs","debugOnly":debug_only})).unwrap()).unwrap();
            Self(root)
        }
        fn source(&self, enabled: bool) -> Vec<Source> {
            vec![Source {
                id: "sample".into(),
                path: self.0.clone(),
                enabled,
            }]
        }
        fn address(&self) -> SocketAddr {
            std::fs::read_to_string(self.0.join("address"))
                .unwrap()
                .parse()
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    const SERVER: &str = r#"
const fs=require('node:fs'), http=require('node:http'), readline=require('node:readline');
readline.createInterface({input:process.stdin}).once('line', line => {
 const init=JSON.parse(line);
 const server=http.createServer((req,res)=>{if(req.url==='/crash'){process.exit(7)}else{res.end('ok')}});
 server.listen(0,'127.0.0.1',()=>{
  fs.appendFileSync('starts','1'); fs.writeFileSync('address','127.0.0.1:'+server.address().port);
  console.log(JSON.stringify({protocol:init.protocol,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'}));
 });
 process.stdin.once('end',()=>{server.closeAllConnections();server.close()});
});
"#;

    #[test]
    fn service_lifecycle_starts_once_and_releases_on_disable_remove_shutdown() {
        let fixture = Fixture::new(SERVER, false);
        let mut registry = ServicePlugins::default();
        let mut changes = registry.subscribe();
        for removal in [false, true, false] {
            let desired = fixture.source(true);
            registry.activate_with_node(&desired, &fixture.0, || Ok("node".into()));
            assert!(
                changes.has_changed().unwrap(),
                "startup publishes a service change"
            );
            changes.borrow_and_update();
            let value = registry.snapshot(&desired, &fixture.0);
            assert_eq!(value["services"][0]["status"], "running", "{value}");
            let address = fixture.address();
            assert!(TcpStream::connect(address).is_ok());
            let starts = std::fs::read_to_string(fixture.0.join("starts")).unwrap();
            registry.activate_with_node(&desired, &fixture.0, || panic!("must not relaunch"));
            assert_eq!(
                std::fs::read_to_string(fixture.0.join("starts")).unwrap(),
                starts
            );
            changes.borrow_and_update();
            if starts.len() == 3 {
                registry.shutdown().unwrap();
            } else {
                registry
                    .prepare(&if removal {
                        vec![]
                    } else {
                        fixture.source(false)
                    })
                    .unwrap();
            }
            assert!(
                changes.has_changed().unwrap(),
                "disable/remove/shutdown publishes a service change"
            );
            assert!(
                registry.entries.is_empty(),
                "successful stop joins and removes the supervisor"
            );
            assert!(
                TcpStream::connect(address).is_err(),
                "port must be released"
            );
        }
        assert!(registry
            .prepare(&fixture.source(true))
            .unwrap_err()
            .contains("shutting down"));
    }

    #[tokio::test]
    async fn service_exit_and_startup_errors_remain_visible_without_restart() {
        let fixture = Fixture::new(SERVER, false);
        let desired = fixture.source(true);
        let mut registry = ServicePlugins::default();
        let mut changes = registry.subscribe();
        registry.activate_with_node(&desired, &fixture.0, || Ok("node".into()));
        changes.borrow_and_update();
        let mut socket = TcpStream::connect(fixture.address()).unwrap();
        socket
            .write_all(b"GET /crash HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let _ = socket.read_to_end(&mut bytes);
        tokio::time::timeout(Duration::from_secs(3), changes.changed())
            .await
            .unwrap()
            .unwrap();
        // No inventory/status read has occurred since launch. Exit detection and
        // cleanup must already be complete before the first read after the event.
        let value = registry.snapshot(&desired, &fixture.0);
        assert_eq!(value["services"][0]["status"], "failed", "{value}");
        assert!(value["services"][0]["error"]
            .as_str()
            .unwrap()
            .contains('7'));
        assert!(!value["services"][0]["error"]
            .as_str()
            .unwrap()
            .contains("cleanup:"));
        assert!(value["services"][0]["baseUrl"].is_null());
        assert!(
            TcpStream::connect(fixture.address()).is_err(),
            "exit notification follows process cleanup"
        );
        registry.activate_with_node(&desired, &fixture.0, || panic!("no automatic restart"));
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("starts")).unwrap(),
            "1"
        );
        registry.prepare(&fixture.source(false)).unwrap();
        std::fs::write(
            fixture.0.join("entry.cjs"),
            "process.stderr.write('fixture startup failure');process.exit(3)",
        )
        .unwrap();
        registry.activate_with_node(&desired, &fixture.0, || Ok("node".into()));
        let value = registry.snapshot(&desired, &fixture.0);
        assert_eq!(value["services"][0]["status"], "failed");
        assert!(value["services"][0]["error"]
            .as_str()
            .unwrap()
            .contains("startup line"));
        assert!(
            std::fs::read_to_string(fixture.0.join("service-plugins/sample/runtime.log"))
                .unwrap()
                .contains("fixture startup failure")
        );
    }

    #[test]
    fn service_manifest_rejects_escape_and_settings_reject_duplicate_ids() {
        let fixture = Fixture::new(SERVER, false);
        assert!(ServicePluginManifest::read(&fixture.0).is_ok());
        assert!(
            !fixture.0.join("starts").exists(),
            "inspection must not execute"
        );
        let path = fixture.0.join("achbit-service.json");
        let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["entry"] = json!("../entry.cjs");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(ServicePluginManifest::read(&fixture.0)
            .unwrap_err()
            .contains("relative file"));
        let mut duplicate = fixture.source(true);
        duplicate.extend(fixture.source(false));
        assert!(
            sources(&json!({"plugins.services":serde_json::to_string(&duplicate).unwrap()}))
                .is_err()
        );
        assert!(sources(&json!({"plugins.services":[]})).is_err());
        assert!(loopback_url("http://0.0.0.0:1234").is_err());
        assert!(loopback_url("http://127.0.0.1:1234/?token=secret").is_err());
    }

    #[test]
    fn service_debug_only_gate_matches_host_build() {
        let fixture = Fixture::new(SERVER, true);
        let desired = fixture.source(true);
        let mut registry = ServicePlugins::default();
        registry.activate_with_node(&desired, &fixture.0, || Ok("node".into()));
        let value = registry.snapshot(&desired, &fixture.0);
        assert_eq!(
            value["services"][0]["status"],
            if cfg!(feature = "debug-control") {
                "running"
            } else {
                "failed"
            }
        );
        if !cfg!(feature = "debug-control") {
            assert!(!fixture.0.join("starts").exists());
        }
    }
}
