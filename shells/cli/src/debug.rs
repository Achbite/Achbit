//! Structured control client shipped only by the explicit Debug build.
use deepcode_host_connection::{LocalHostConnection, UserDirectories};
use deepcode_kernel_abi::{HostProcessIdentity, HostShutdownReceipt};
use deepcode_kernel_client::{KernelBootstrap, KernelBootstrapOptions};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const HELP: &str = r#"DeepCode Debug CLI (debug-only)
  launch --artifact DIR --workspace DIR --state-root DIR [--headless]
  instances | inspect | attach --workspace DIR | detach | stop
  tools list | tools inspect --tool fs.read
  tools call --tool fs.read --input '{"path":"example.txt"}' [--no-wait]
  operation inspect|cancel|respond --operation-id ID [--decision-id ID --decision allow|deny]
  components list|inspect|activate [--params @JSON_FILE]
  surfaces list|inspect [--target main] | action --target main --name NAME --args JSON
  task submit --text TEXT [--profile-id ID] [--follow]
  task inspect|message|cancel|respond --session-id ID [--text TEXT | --run-id ID | --command JSON]
  observe subscribe --session-id ID [--run-id ID]
  observe --subscription-id ID [--follow] [--wait-ms 180000]
  metrics query|export [--kind tool|component|session|provider|usage] [--params @JSON_FILE]
  result read --operation-id ID | --record-id ID | --session-id ID --event-sequence N
Every connected command requires --state-root DIR (or explicit DEEPCODE_USER_ROOT).
--control-id ID overrides the local attachment receipt. --params JSON or @FILE supplies
structured method parameters. Results go to stdout; errors use JSON on stderr.
Observation streams and metrics export use JSONL. Failed terminal operations exit nonzero.
The CLI never starts an Agent Loop for tools or UI actions. Timeout does not cancel work.
"#;

struct Args {
    method: String,
    options: HashMap<String, String>,
    flags: Vec<String>,
}
impl Args {
    fn parse(values: &[String]) -> Result<Self, String> {
        let mut positionals = Vec::new();
        let mut options = HashMap::new();
        let mut flags = Vec::new();
        let mut i = 0;
        while i < values.len() {
            let item = &values[i];
            if let Some(key) = item.strip_prefix("--") {
                if matches!(key, "follow" | "headless" | "no-wait" | "help") {
                    flags.push(key.to_string());
                } else {
                    i += 1;
                    let value = values
                        .get(i)
                        .ok_or_else(|| format!("Missing --{key} value"))?;
                    if value.starts_with("--") {
                        return Err(format!("Missing --{key} value"));
                    }
                    options.insert(key.to_string(), value.clone());
                }
            } else {
                positionals.push(item.clone());
            }
            i += 1;
        }
        let method = positionals.join(".");
        Ok(Self {
            method,
            options,
            flags,
        })
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }
    fn option(&self, name: &str) -> Option<&str> {
        self.options.get(name).map(String::as_str)
    }
    fn required(&self, name: &str) -> Result<&str, String> {
        self.option(name)
            .ok_or_else(|| format!("--{name} is required"))
    }
    fn params(&self) -> Result<Value, String> {
        let mut value = match self.option("params") {
            Some(text) => parse_json(text)?,
            None => json!({}),
        };
        if !value.is_object() {
            return Err("--params must be a JSON object".into());
        }
        for (key, item) in &self.options {
            if matches!(key.as_str(), "params" | "state-root" | "artifact") {
                continue;
            }
            let mut parts = key.split('-');
            let mut field = parts.next().unwrap_or_default().to_string();
            for part in parts {
                let mut chars = part.chars();
                if let Some(first) = chars.next() {
                    field.extend(first.to_uppercase());
                    field.push_str(chars.as_str());
                }
            }
            value[&field] = if matches!(
                key.as_str(),
                "input" | "args" | "command" | "query" | "plugin-selections" | "recipe"
            ) {
                parse_json(item)?
            } else if matches!(
                key.as_str(),
                "wait-ms"
                    | "event-sequence"
                    | "input-budget-tokens"
                    | "offset"
                    | "limit"
                    | "from-ms"
                    | "to-ms"
            ) {
                json!(item
                    .parse::<u64>()
                    .map_err(|_| format!("--{key} must be an integer"))?)
            } else {
                json!(item)
            };
        }
        Ok(value)
    }
}
fn parse_json(text: &str) -> Result<Value, String> {
    let content = match text.strip_prefix('@') {
        Some(path) => fs::read_to_string(path).map_err(|e| e.to_string())?,
        None => text.to_string(),
    };
    serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {e}"))
}
fn root(args: &Args) -> Result<PathBuf, String> {
    let value = args
        .option("state-root")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("DEEPCODE_USER_ROOT").map(PathBuf::from))
        .ok_or("--state-root or DEEPCODE_USER_ROOT is required")?;
    if value.as_os_str().is_empty() {
        return Err("Empty state root".into());
    }
    std::path::absolute(value).map_err(|e| e.to_string())
}
fn receipt_path(root: &Path) -> PathBuf {
    root.join("data/agent-runtime/debug-controller.json")
}
fn read_receipt(root: &Path) -> Result<Value, String> {
    match fs::read(receipt_path(root)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}
fn save_receipt(root: &Path, value: &Value) -> Result<(), String> {
    let path = receipt_path(root);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn record_attachment(receipt: &mut Value, attached: &Value, identity: &HostProcessIdentity) {
    if receipt["instanceId"] != identity.instance_id {
        receipt["ownsHost"] = json!(false);
        receipt["guiPid"] = Value::Null;
    }
    receipt["controlId"] = attached["controlId"].clone();
    receipt["workspace"] = attached["workspace"].clone();
    receipt["instanceId"] = json!(identity.instance_id);
    receipt["identity"] = json!(identity);
}
fn validate_shutdown(result: &Value, expected: &HostProcessIdentity) -> Result<(), String> {
    let receipt: HostShutdownReceipt = serde_json::from_value(result.clone())
        .map_err(|e| format!("Invalid Host shutdown receipt: {e}"))?;
    if !receipt.confirms_shutdown_of(expected) {
        return Err(format!(
            "Host shutdown was not confirmed complete: {result}"
        ));
    }
    Ok(())
}
fn gui_process_definitely_absent(pid: u64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        if pid <= 0 {
            return false;
        }
        // Signal 0 checks existence without signalling the process. EPERM and all
        // other errors leave absence unproven, so the original stop path remains.
        let result = unsafe { libc::kill(pid, 0) };
        result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let Ok(pid) = u32::try_from(pid) else {
            return false;
        };
        if pid == 0 {
            return false;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_INVALID_PARAMETER as i32);
            }
            let exited = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
            CloseHandle(handle);
            exited
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}
struct Client {
    http: reqwest::Client,
    base: String,
}
impl Client {
    fn new(connection: &LocalHostConnection) -> Result<Self, String> {
        let mut headers = reqwest::header::HeaderMap::new();
        let mut token = reqwest::header::HeaderValue::from_str(connection.shell_token())
            .map_err(|e| e.to_string())?;
        token.set_sensitive(true);
        headers.insert(deepcode_kernel_abi::HOST_SHELL_TOKEN_HEADER, token);
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            base: connection.identity.address.clone(),
        })
    }
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let response = self
            .http
            .post(format!("{}/api/debug/command", self.base))
            .timeout(Duration::from_secs(195))
            .json(&json!({"method":method,"params":params}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        decode(response).await
    }
    async fn observe(&self, params: Value) -> Result<(), String> {
        let mut response = self
            .http
            .post(format!("{}/api/debug/observe", self.base))
            .json(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some("application/x-ndjson")
        {
            decode(response).await?;
            return Err("Debug observation stream expected".into());
        }
        let mut pending = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            pending.extend_from_slice(&chunk);
            while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = pending.drain(..=end).collect();
                let frame: Value = serde_json::from_slice(&line)
                    .map_err(|e| format!("Invalid observation frame: {e}"))?;
                std::io::stdout()
                    .write_all(&line)
                    .map_err(|e| e.to_string())?;
                std::io::stdout().flush().map_err(|e| e.to_string())?;
                if observation_failed(&frame) {
                    return Err(format!("Observation failed: {frame}"));
                }
            }
        }
        if !pending.is_empty() {
            return Err("Observation stream ended inside a frame".into());
        }
        Ok(())
    }
}
fn observation_failed(frame: &Value) -> bool {
    frame["status"] == "failed"
        || frame["state"]["status"] == "failed"
        || frame["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["eventType"] == "run.settled"
                    && item["payload"]["outcome"] == "failed"
                    && item
                        .get("sourceSessionId")
                        .is_none_or(|source| *source == frame["sessionId"])
            })
        })
}
async fn decode(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("HTTP {status}: {e}"))?;
    if !status.is_success() || value["ok"] != true {
        return Err(format!("{}: {}", value["error"], value["message"]));
    }
    Ok(value["data"].clone())
}
fn configure(root: &Path, resources: &Path, kernel: &Path) {
    for key in [
        "DEEPCODE_API_URL",
        "DEEPCODE_PORT",
        deepcode_kernel_abi::HOST_SHELL_TOKEN_ENV,
        deepcode_kernel_abi::HOST_INSTANCE_ID_ENV,
    ] {
        std::env::remove_var(key);
    }
    std::env::set_var("DEEPCODE_USER_ROOT", root);
    std::env::set_var("DEEPCODE_RUNTIME_DIR", resources);
    std::env::set_var("DEEPCODE_KERNEL_BIN", kernel);
}
fn output(value: &Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|e| e.to_string())?
    );
    Ok(())
}

pub(super) async fn run(values: &[String]) -> Result<(), String> {
    let args = Args::parse(values)?;
    if args.method.is_empty() || args.method == "help" || args.flag("help") {
        println!("{HELP}");
        return Ok(());
    }
    let root = root(&args)?;
    if args.method == "launch" {
        return launch(&args, &root).await;
    }
    let directories = UserDirectories::isolated(&root);
    let connection =
        LocalHostConnection::discover(&directories.data_dir).map_err(|e| e.to_string())?;
    let Some(connection) = connection else {
        if args.method == "instances" {
            return output(&json!({"instances":[]}));
        }
        return Err("No running Host in the selected state root".into());
    };
    let client = Client::new(&connection)?;
    let identity = client.call("inspect", json!({})).await?;
    if identity["buildKind"] != "debug" {
        return Err("Selected Host is not a Debug build".into());
    }
    let mut receipt = read_receipt(&root)?;
    let mut params = args.params()?;
    if params.get("controlId").is_none() {
        params["controlId"] = receipt["controlId"].clone();
    }
    if args.method == "attach" {
        params["instanceId"] = json!(connection.identity.instance_id);
        let result = client.call("attach", params).await?;
        record_attachment(&mut receipt, &result, &connection.identity);
        save_receipt(&root, &receipt)?;
        return output(&result);
    }
    if args.method == "stop" {
        if receipt["ownsHost"] != true || receipt["instanceId"] != connection.identity.instance_id {
            return Err(
                "This receipt does not own the selected Host; stop it through its owner".into(),
            );
        }
        if receipt["guiPid"].is_number()
            && !receipt["guiPid"]
                .as_u64()
                .is_some_and(gui_process_definitely_absent)
        {
            let hosts = identity["guiHosts"]
                .as_array()
                .ok_or("GUI host list missing")?;
            let selected =
                match params["guiHostId"].as_str() {
                    Some(id) => json!(id),
                    None if hosts.len() == 1 => hosts[0].clone(),
                    None if hosts.is_empty() => return Err(
                        "Owned GUI process is not confirmed absent, but no GUI control endpoint is available".into(),
                    ),
                    None => return Err(
                        "Multiple GUI hosts; select the owned GUI with --gui-host-id from inspect"
                            .into(),
                    ),
                };
            client.call("gui.stop",json!({"guiHostId":selected,"expectedPid":receipt["guiPid"],"expectedIdentity":connection.identity})).await?;
        }
        let response = client
            .http
            .post(format!("{}/api/host/shutdown", client.base))
            .timeout(Duration::from_secs(30))
            .json(&json!({"expectedIdentity":connection.identity}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let result = decode(response).await?;
        // Retain the actual receipt even when the Host accepted shutdown but
        // could not complete cleanup. Such a result must not exit successfully.
        output(&result)?;
        validate_shutdown(&result, &connection.identity)?;
        receipt["ownsHost"] = json!(false);
        receipt["controlId"] = Value::Null;
        save_receipt(&root, &receipt)?;
        return Ok(());
    }
    if args.method == "observe" {
        params["follow"] = json!(args.flag("follow"));
        return client.observe(params).await;
    }
    let mut result = client.call(&args.method, params.clone()).await?;
    if args.method == "tools.call" && !args.flag("no-wait") && result["operationId"].is_string() {
        result=client.call("operation.inspect",json!({"controlId":params["controlId"],"operationId":result["operationId"],"waitMs":params.get("waitMs").cloned().unwrap_or(json!(180000))})).await?;
    }
    if args.method == "detach" {
        receipt["controlId"] = Value::Null;
        save_receipt(&root, &receipt)?;
    }
    if args.method == "metrics.export" {
        if let Some(records) = result["records"].as_array() {
            for record in records {
                output(record)?;
            }
        }
        let mut metadata = result.clone();
        if let Some(object) = metadata.as_object_mut() {
            object.remove("records");
        }
        output(&json!({"type":"metrics.summary","data":metadata}))?;
    } else {
        output(&result)?;
    }
    if command_failed(&args.method, &result) {
        return Err(format!("Command rejected: {}", result["error"]));
    }
    if args.method == "task.submit" && args.flag("follow") {
        client.observe(json!({"controlId":params["controlId"],"subscriptionId":result["subscriptionId"],"follow":true,"waitMs":params.get("waitMs").cloned().unwrap_or(json!(180000))})).await?;
    }
    Ok(())
}

fn command_failed(method: &str, result: &Value) -> bool {
    result["status"] == "rejected"
        || (matches!(method, "tools.call" | "operation.inspect" | "action")
            && matches!(
                result["status"].as_str(),
                Some(
                    "inputRejected"
                        | "failed"
                        | "partial"
                        | "denied"
                        | "indeterminate"
                        | "cancelled"
                )
            ))
}

fn gui_ready(state: &Value) -> bool {
    state["readyState"] == "complete"
        && state["bridgeLoaded"] == true
        && state["hostStatus"] == "connected"
        && state["components"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["slot"] == "workbench.layout"))
}

async fn wait_for_gui(client: &Client, gui: &mut Child, control: &Value) -> Result<Value, String> {
    let waiting = async {
        loop {
            if let Some(status) = gui.try_wait().map_err(|error| error.to_string())? {
                return Err(format!("debug_gui_exited_before_ready: {status}"));
            }
            let state = client.call("inspect", json!({})).await?;
            let hosts = state["guiHosts"]
                .as_array()
                .ok_or("GUI host list missing")?;
            if hosts.len() > 1 {
                return Err("debug_gui_launch_multiple_hosts".into());
            }
            if let Some(host) = hosts.first() {
                let surface = client
                    .call(
                        "gui.ready",
                        json!({"controlId":control,"guiHostId":host,"target":"main"}),
                    )
                    .await?;
                if gui_ready(&surface) {
                    return Ok(
                        json!({"status":"ready","hostId":host,"readyState":surface["readyState"],"hostStatus":surface["hostStatus"]}),
                    );
                }
            }
            // A bounded startup wait, not a replay of failed UI actions.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(20), waiting)
        .await
        .map_err(|_| "debug_gui_ready_timeout".to_string())?
}

async fn launch(args: &Args, root: &Path) -> Result<(), String> {
    // Keep the ordinary absolute path for the packaged Node entrypoint. Rust's
    // canonicalize adds a Windows verbatim prefix which Node's loader rejects.
    let artifact = std::path::absolute(args.required("artifact")?).map_err(|e| e.to_string())?;
    let (resources, kernel, gui_binary) = artifact_paths(&artifact, std::env::consts::OS)?;
    let metadata: Value = serde_json::from_slice(
        &fs::read(resources.join("BUILDINFO.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if metadata["buildKind"] != "debug" || metadata["debugControl"] != true {
        return Err("Artifact is not an explicit Debug build".into());
    }
    let workspace = PathBuf::from(args.required("workspace")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !workspace.is_dir() {
        return Err("workspace must be a directory".into());
    }
    let dirs = UserDirectories::isolated(root);
    if LocalHostConnection::discover(&dirs.data_dir)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("A Host already exists in this root; use attach explicitly".into());
    }
    dirs.create().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    isolate_launcher_streams()?;
    configure(root, &resources, &kernel);
    let host = KernelBootstrap::connect(KernelBootstrapOptions::new(None).persistent(true))
        .await
        .map_err(|e| e.to_string())?;
    let connection = LocalHostConnection::discover(&dirs.data_dir)
        .map_err(|e| e.to_string())?
        .ok_or("Started Host did not publish a connection")?;
    let client = Client::new(&connection)?;
    let mut receipt = json!({"instanceId":connection.identity.instance_id,"identity":connection.identity,"controlId":null,"workspace":workspace,"artifact":artifact,"ownsHost":true,"guiPid":null});
    // Preserve the explicit stop handle even if attachment or GUI startup fails.
    save_receipt(root, &receipt)?;
    let attached = client
        .call(
            "attach",
            json!({"instanceId":connection.identity.instance_id,"workspace":workspace}),
        )
        .await?;
    receipt["controlId"] = attached["controlId"].clone();
    save_receipt(root, &receipt)?;
    let mut gui_error = None;
    receipt["gui"] = json!({"status":"not-requested"});
    if !args.flag("headless") {
        let started = Instant::now();
        let log = File::create(dirs.log_dir.join("debug-gui.log")).map_err(|e| e.to_string())?;
        let mut gui = deepcode_host_connection::process::spawn_independent_shell(
            Command::new(gui_binary)
                .current_dir(&workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
                .stderr(Stdio::from(log)),
        )
        .map_err(|e| format!("GUI spawn failed (Host retained for explicit stop): {e}"))?;
        receipt["guiPid"] = json!(gui.id());
        save_receipt(root, &receipt)?;
        receipt["gui"] = match wait_for_gui(&client, &mut gui, &receipt["controlId"]).await {
            Ok(ready) => ready,
            Err(error) => {
                gui_error = Some(error.clone());
                json!({"status":"failed","error":error})
            }
        };
        receipt["gui"]["readyDurationMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        save_receipt(root, &receipt)?;
    }
    drop(host);
    output(
        &json!({"instanceId":receipt["instanceId"],"controlId":receipt["controlId"],"workspace":workspace,"stateRoot":root,"artifact":artifact,"ownsHost":true,"guiPid":receipt["guiPid"],"gui":receipt["gui"],"build":metadata}),
    )?;
    if let Some(error) = gui_error {
        return Err(format!("{error}; Host retained for explicit stop"));
    }
    Ok(())
}

#[cfg(windows)]
fn isolate_launcher_streams() -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    // A controller may supply inheritable pipes. The long-lived Host and GUI
    // have explicit log streams, but CreateProcess also inherits other marked
    // handles. Keep this CLI's pipes from delaying EOF after launch has exited.
    for handle in [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ] {
        if !handle.is_null()
            && handle != INVALID_HANDLE_VALUE
            && unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0
        {
            return Err(format!(
                "Could not isolate Debug launcher streams: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

fn artifact_paths(artifact: &Path, platform: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    match platform {
        "windows" => Ok((
            artifact.to_path_buf(),
            artifact.join("deepcode-kernel.exe"),
            artifact.join("DeepCode-Debug.exe"),
        )),
        "macos" => {
            let app = if artifact.extension().is_some_and(|x| x == "app") {
                artifact.to_path_buf()
            } else {
                artifact.join("DeepCode-Debug.app")
            };
            Ok((
                app.join("Contents/Resources"),
                app.join("Contents/MacOS/deepcode-kernel"),
                app.join("Contents/MacOS/DeepCode-GUI"),
            ))
        }
        _ => Err(format!("Debug launch is not supported on {platform}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_artifact_paths_select_the_platform_package() {
        let root = Path::new("package with spaces");
        assert_eq!(
            artifact_paths(root, "windows").unwrap(),
            (
                root.to_path_buf(),
                root.join("deepcode-kernel.exe"),
                root.join("DeepCode-Debug.exe")
            )
        );
        let mac = root.join("DeepCode-Debug.app");
        assert_eq!(
            artifact_paths(root, "macos").unwrap(),
            artifact_paths(&mac, "macos").unwrap()
        );
        assert!(artifact_paths(root, "linux").is_err());
    }
    #[test]
    fn debug_partial_observation_is_not_a_successful_command() {
        assert!(command_failed(
            "action",
            &json!({"status":"partial","result":{"dispatched":true}})
        ));
        assert!(command_failed("action", &json!({"status":"failed"})));
        assert!(!command_failed("action", &json!({"status":"observed"})));
        assert!(!command_failed(
            "tools.call",
            &json!({"status":"approvalRequired"})
        ));
    }
    #[test]
    fn debug_observation_preserves_the_observed_tasks_failure() {
        assert!(observation_failed(&json!({"status":"failed"})));
        let mut frame = json!({"sessionId":"parent","status":"settled","items":[
            {"eventType":"run.settled","payload":{"outcome":"failed"}}
        ]});
        assert!(observation_failed(&frame));
        frame["items"][0]["sourceSessionId"] = json!("child");
        assert!(!observation_failed(&frame));
        frame["items"][0]["sourceSessionId"] = json!("parent");
        assert!(observation_failed(&frame));
        frame["items"][0]["payload"]["outcome"] = json!("completed");
        assert!(!observation_failed(&frame));
        frame["items"][0] =
            json!({"eventType":"tool.call.completed","payload":{"outcome":"failed"}});
        assert!(!observation_failed(&frame));
    }
    #[test]
    fn debug_gui_ready_requires_loaded_workbench_and_connected_host() {
        assert!(!gui_ready(
            &json!({"readyState":"complete","hostStatus":"connected","components":[]})
        ));
        let mut state = json!({"readyState":"complete","bridgeLoaded":true,"hostStatus":"connected","components":[{"slot":"workbench.layout"}]});
        assert!(gui_ready(&state));
        state["bridgeLoaded"] = json!(false);
        assert!(!gui_ready(&state));
        state["bridgeLoaded"] = json!(true);
        state["hostStatus"] = json!("error");
        assert!(!gui_ready(&state));
        state["hostStatus"] = json!("connected");
        state["readyState"] = json!("loading");
        assert!(!gui_ready(&state));
    }
    fn identity(suffix: char) -> HostProcessIdentity {
        HostProcessIdentity {
            service: deepcode_kernel_abi::KERNEL_DAEMON_SERVICE.into(),
            instance_id: format!("dcinstance_{}", suffix.to_string().repeat(64)),
            pid: 123,
            address: "http://127.0.0.1:12345".into(),
        }
    }
    #[test]
    fn attachment_does_not_transfer_process_ownership_to_another_instance() {
        let original = identity('a');
        let next = identity('b');
        let mut receipt = json!({"instanceId":original.instance_id,"identity":original,
            "ownsHost":true,"guiPid":456,"controlId":"control:old"});
        let attached = json!({"controlId":"control:new","workspace":"/workspace"});
        record_attachment(&mut receipt, &attached, &original);
        assert_eq!(receipt["ownsHost"], true);
        assert_eq!(receipt["guiPid"], 456);
        record_attachment(&mut receipt, &attached, &next);
        assert_eq!(receipt["ownsHost"], false);
        assert_eq!(receipt["guiPid"], Value::Null);
        assert_eq!(receipt["identity"], json!(next));
        assert_eq!(receipt["controlId"], attached["controlId"]);
    }
    #[test]
    fn shutdown_requires_confirmed_cleanup_for_the_owned_host() {
        let expected = identity('a');
        let mut result = json!(HostShutdownReceipt {
            accepted: true,
            owner: deepcode_kernel_abi::HOST_SHUTDOWN_OWNER.into(),
            identity: expected.clone(),
            cleanup_complete: true,
        });
        assert!(validate_shutdown(&result, &expected).is_ok());
        result["cleanupComplete"] = json!(false);
        let original = result.clone();
        assert!(validate_shutdown(&result, &expected)
            .unwrap_err()
            .contains("not confirmed complete"));
        assert_eq!(result, original, "Failure must preserve the actual receipt");
        result["cleanupComplete"] = json!(true);
        assert!(validate_shutdown(&result, &identity('b')).is_err());
    }
    #[cfg(any(unix, windows))]
    #[test]
    fn gui_absence_requires_os_confirmation_after_process_exit() {
        assert!(!gui_process_definitely_absent(
            u64::from(std::process::id())
        ));
        #[cfg(unix)]
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        #[cfg(windows)]
        let mut child = Command::new("cmd.exe")
            .args(["/c", "exit", "0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        assert!(gui_process_definitely_absent(u64::from(pid)));
        assert!(!gui_process_definitely_absent(0));
    }
    #[test]
    fn parses_structured_independent_tool_call() {
        let args = Args::parse(
            &[
                "tools",
                "call",
                "--tool",
                "fs.read",
                "--input",
                "{\"path\":\"one file.txt\"}",
                "--no-wait",
            ]
            .map(str::to_string),
        )
        .unwrap();
        assert_eq!(args.method, "tools.call");
        assert!(args.flag("no-wait"));
        assert_eq!(args.params().unwrap()["input"]["path"], "one file.txt");
    }
    #[test]
    fn missing_values_and_invalid_inputs_are_rejected() {
        assert!(Args::parse(&["tools", "call", "--tool"].map(str::to_string)).is_err());
        assert!(parse_json("not json").is_err());
    }
}
