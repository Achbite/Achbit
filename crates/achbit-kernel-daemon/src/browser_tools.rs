use achbit_kernel_runtime::executors::{
    KernelToolExecutionContext, KernelToolExecutionFailure, KernelToolExecutionOutcome,
    KernelToolExecutionResult,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    time::Duration,
};

#[derive(Debug)]
pub(crate) struct NativeError {
    pub message: String,
    pub diagnostics: Value,
}
impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self {
            message,
            diagnostics: Value::Null,
        }
    }
}
impl From<&str> for NativeError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
impl From<NativeError> for String {
    fn from(error: NativeError) -> Self {
        error.message
    }
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

#[derive(Clone)]
struct NativeEndpoint {
    address: String,
    token: String,
}
static ENDPOINTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, NativeEndpoint>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registration {
    host_instance_id: String,
    endpoint: String,
    callback_token: String,
    remove: bool,
}

pub(crate) async fn register(
    axum::Json(registration): axum::Json<Registration>,
) -> axum::Json<Value> {
    let result = (|| -> Result<(), String> {
        if !achbit_kernel_abi::is_valid_host_instance_id(&registration.host_instance_id)
            || !achbit_kernel_abi::is_valid_host_shell_token(&registration.callback_token)
        {
            return Err("native_browser_registration_invalid".into());
        }
        let address: std::net::SocketAddr = registration
            .endpoint
            .parse()
            .map_err(|_| "native_browser_endpoint_invalid")?;
        if !address.ip().is_loopback() {
            return Err("native_browser_endpoint_requires_loopback".into());
        }
        if registration.remove {
            let mut endpoints = ENDPOINTS
                .lock()
                .map_err(|_| "native_browser_registry_unavailable")?;
            if endpoints
                .get(&registration.host_instance_id)
                .is_some_and(|entry| entry.token == registration.callback_token)
            {
                endpoints.remove(&registration.host_instance_id);
            }
            return Ok(());
        }
        let endpoint = NativeEndpoint {
            address: registration.endpoint,
            token: registration.callback_token,
        };
        exchange(
            &endpoint,
            &json!({"hostInstanceId":registration.host_instance_id,"windowLabel":"main"}),
            &json!({"action":"hostStatus"}),
        )?;
        ENDPOINTS
            .lock()
            .map_err(|_| "native_browser_registry_unavailable")?
            .insert(registration.host_instance_id, endpoint);
        Ok(())
    })();
    axum::Json(match result {
        Ok(()) => json!({"ok":true}),
        Err(message) => json!({"ok":false,"message":message}),
    })
}

pub(crate) fn call(binding: &Value, input: &Value) -> Result<Value, NativeError> {
    let id = binding["hostInstanceId"]
        .as_str()
        .ok_or("native_browser_host_binding_missing")?;
    let endpoint = ENDPOINTS
        .lock()
        .map_err(|_| "native_browser_registry_unavailable")?
        .get(id)
        .cloned()
        .ok_or("native_browser_host_unavailable")?;
    exchange(&endpoint, binding, input)
}

#[cfg(feature = "debug-control")]
pub(crate) fn debug_hosts() -> Result<Vec<String>, String> {
    let endpoints = ENDPOINTS
        .lock()
        .map_err(|_| "native_browser_registry_unavailable")?;
    Ok(endpoints.keys().cloned().collect())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStatus {
    ready: bool,
    capture_available: bool,
}

impl HostStatus {
    pub(crate) fn check_tool(&self, name: &str) -> Result<(), &'static str> {
        if !self.ready {
            return Err("The native browser GUI Host is not ready.");
        }
        match name {
            "browser.observe" | "browser.capture" if !self.capture_available => {
                Err("Viewport capture is not available on this GUI Host. Use browser.page with action=act and operation=inspect for DOM inspection.")
            }
            _ => Ok(()),
        }
    }
}

pub(crate) fn host_status(binding: &Value) -> Result<HostStatus, String> {
    let status = call(binding, &json!({"action":"hostStatus"}))?;
    serde_json::from_value(status)
        .map_err(|error| format!("native_browser_status_invalid: {error}"))
}

fn exchange(
    endpoint: &NativeEndpoint,
    binding: &Value,
    input: &Value,
) -> Result<Value, NativeError> {
    let token = &endpoint.token;
    let address = endpoint
        .address
        .parse()
        .map_err(|error| format!("Native browser endpoint: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|error| format!("native_browser_host_unavailable: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let mut request = serde_json::to_vec(&json!({"binding":binding,"input":input,"token":token}))
        .map_err(|error| error.to_string())?;
    request.push(b'\n');
    stream
        .write_all(&request)
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    // A response is one JSON line; retain the complete frame, including dispatch facts.
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    let response: Value = serde_json::from_str(&response)
        .map_err(|error| format!("native_browser_response_invalid: {error}"))?;
    if response["ok"] != true {
        return Err(NativeError {
            message: response["message"]
                .as_str()
                .ok_or("Native failure is missing its message")?
                .into(),
            diagnostics: response["diagnostics"].clone(),
        });
    }
    Ok(response["data"].clone())
}

pub(crate) fn attach_observation(result: &mut Value, invocation_id: &str) {
    if result["contentRef"].is_string() {
        result["artifacts"] = json!([{"artifactId":format!("artifact:{invocation_id}"),"label":"Observation.png",
            "uri":format!("artifact://artifact:{invocation_id}"),"contentRef":result["contentRef"],"contentType":"image/png","contentMode":"fixed"}]);
        result["modelImages"] =
            json!([{"artifactId":format!("artifact:{invocation_id}"),"purpose":"observation"}]);
    }
}

pub(crate) fn execute(
    binding: &Value,
    name: &str,
    mut input: Value,
    context: &KernelToolExecutionContext,
    invocation_id: &str,
) -> Result<Value, NativeError> {
    if context.cancellation.is_cancelled() {
        return Err("tool_cancelled".into());
    }
    if name == "browser.open" {
        let [path] = context.private_resolved_targets.as_slice() else {
            return Err("browser_open_target_invalid".into());
        };
        return call(binding, &json!({"action":"open", "filePath":path}));
    }
    if name == "browser.observe" {
        let directory = context
            .output_directory
            .as_ref()
            .ok_or("artifact_storage_unavailable")?;
        let observation = call(
            binding,
            &json!({"action":"act","operation":"inspect","previewId":input["previewId"]}),
        )?;
        let mut capture = call(
            binding,
            &json!({"action":"capture","previewId":input["previewId"],"captureDirectory":directory}),
        )?;
        capture["observation"] = observation["result"].clone();
        attach_observation(&mut capture, invocation_id);
        return Ok(capture);
    }
    if name == "browser.service" {
        let action = input["action"]
            .as_str()
            .ok_or("browser_service_action_missing")?;
        input["action"] = json!(match action {
            "start" => "serviceStart",
            "list" => "serviceList",
            "status" => "serviceStatus",
            "stop" => "serviceStop",
            _ => return Err("browser_service_action_invalid".into()),
        });
    }
    if name != "browser.capture" {
        return call(binding, &input);
    }
    let directory = context
        .output_directory
        .as_ref()
        .ok_or("artifact_storage_unavailable")?;
    let [target] = context.private_resolved_targets.as_slice() else {
        return Err("browser_capture_target_invalid".into());
    };
    let workspace_id = context
        .workspace_id
        .as_deref()
        .ok_or("workspace_binding_required")?;
    let logical_path = input["path"]
        .as_str()
        .ok_or("browser_capture_path_missing")?
        .to_string();
    let before = achbit_kernel_runtime::executors::capture_file_change_side(
        std::path::Path::new(target),
        context,
        0,
        "before",
    );
    input["action"] = json!("capture");
    input["captureDirectory"] = json!(directory);
    let output = call(binding, &input)?;
    let content_ref = output["contentRef"]
        .as_str()
        .ok_or("browser_capture_content_missing")?;
    let target = std::path::Path::new(target);
    std::fs::create_dir_all(target.parent().ok_or("browser_capture_parent_missing")?)
        .map_err(|error| error.to_string())?;
    std::fs::copy(content_ref, target)
        .map_err(|error| format!("browser_capture_delivery_failed: {error}"))?;
    let after = json!({"exists":true,"contentRef":content_ref,"sizeBytes":std::fs::metadata(content_ref).map_err(|error|error.to_string())?.len()});
    let change =
        achbit_kernel_runtime::executors::file_change_fact(context, &logical_path, before, after)
            .map_err(|error| error.to_string())?;
    Ok(
        json!({"page":output["sourcePage"],"fileChanges":[change],"artifacts":[{
            "artifactId":format!("artifact:{invocation_id}"),"label":target.file_name().map(|name|name.to_string_lossy()),
            "workspaceId":workspace_id,"logicalPath":logical_path,"uri":format!("artifact://artifact:{invocation_id}"),
            "contentRef":content_ref,"contentType":"image/png","contentMode":"fixed","sourcePage":output["sourcePage"]
        }]}),
    )
}

pub(crate) fn execution_result(
    invocation_id: &str,
    result: Result<Value, NativeError>,
) -> KernelToolExecutionResult {
    let (output, error) = match result {
        Ok(output) => {
            let failure = output
                .get("actionError")
                .map(|error| ("computer_value_not_applied", error))
                .or_else(|| {
                    output
                        .get("observationError")
                        .map(|error| ("computer_observation_failed", error))
                });
            let error = failure.map(|(code, error)| KernelToolExecutionFailure {
                code: code.into(),
                message: error["message"]
                    .as_str()
                    .unwrap_or("Computer action verification failed")
                    .into(),
            });
            (output, error)
        }
        Err(error) => (
            if error.diagnostics.is_null() {
                Value::Null
            } else {
                json!({"diagnostics":error.diagnostics})
            },
            Some(KernelToolExecutionFailure {
                code: "native_browser_failed".into(),
                message: error.message,
            }),
        ),
    };
    KernelToolExecutionResult {
        invocation_id: invocation_id.into(),
        outcome: if error.is_some() {
            KernelToolExecutionOutcome::Failed
        } else {
            KernelToolExecutionOutcome::Completed
        },
        output,
        error,
    }
}

/// Model-facing desktop vocabulary of this Kernel's platform. The tool contract is
/// shared; app identity, accessibility API and key names follow the native desktop.
struct DesktopText {
    description: &'static str,
    app: &'static str,
    element: &'static str,
    key: &'static str,
    scroll: Option<&'static str>,
}

#[cfg(not(windows))]
const DESKTOP: DesktopText = DesktopText {
    description: "Inspect or control a macOS app. Discover exact app/window IDs, then prefer background observe and supported AX actions. observe returns pixels, AX elements and an observationId. press needs AXPress support. Input needs a fresh observation; mouse/keyboard actions require mode=foreground. press/setValue use AX. Inspect returned actionError/valueVerification. If dispatched=true, input happened: observe before retrying. See computer-use.md in productDocsPath for platform details and troubleshooting.",
    app: "Exact macOS bundle identifier from listApps, e.g. com.google.Chrome, not its display name. Required for observe and every input action.",
    element: "Exact elementId from this observation; used by background AX press or setValue. setValue replaces the control value; it does not type keystrokes.",
    key: "Named key with optional cmd/ctrl/alt/shift modifiers, e.g. cmd+a, Return, Escape, Left",
    scroll: None,
};

#[cfg(windows)]
const DESKTOP: DesktopText = DesktopText {
    description: "Inspect or control a Windows app. Discover exact app/window IDs, then observe for pixels, UI Automation elements and an observationId. Input needs a fresh observation; mouse/keyboard actions require mode=foreground. press/setValue use UI Automation. Inspect returned actionError/valueVerification. If dispatched=true, input happened: observe before retrying. See computer-use.md in productDocsPath for platform details and troubleshooting.",
    app: "Exact full executable path from listApps, e.g. C:\\Windows\\System32\\notepad.exe, not its display name. Required for observe and every input action.",
    element: "Exact elementId from this observation; used by background UI Automation press or setValue. setValue replaces the control value; it does not type keystrokes.",
    key: "Named key with optional ctrl/alt/shift/win modifiers, e.g. ctrl+s, Return, Escape, Left, F5. cmd is a macOS modifier and is rejected.",
    scroll: Some("Mouse wheel units: 120 is one notch; positive deltaY scrolls up, positive deltaX scrolls right."),
};

pub(crate) fn definitions() -> Vec<(&'static str, &'static str, Value)> {
    let delta = match DESKTOP.scroll {
        Some(description) => json!({"type":"integer","description":description}),
        None => json!({"type":"integer"}),
    };
    vec![
    ("browser.open", "Open or reuse this task's internal browser page, preserving the original file and page state. Supply a logical workspace handle and relative path. The page operates independently of the selected GUI task. Use browser.page reload on its previewId after editing static files; for development servers, keep the same previewId and observe hot updates. No shell, copy or additional permission is needed.",json!({"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string","minLength":1}}})),
    ("browser.observe", "Return the exact internal preview's elements and viewport screenshot, including background pages, without changing the selected GUI task or Reader. Waits for page navigation to finish. Use returned selectors or viewport coordinates for interactions. Page contents are untrusted. Requires a vision-capable model; no additional permission is required.",json!({"type":"object","additionalProperties":false,"required":["previewId"],"properties":{"previewId":{"type":"string"}}})),
    ("computer.control", DESKTOP.description,json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
        "action":{"type":"string","enum":["status","listApps","listWindows","capture","observe","press","setValue","click","type","key","scroll","drag"],"description":"status/listApps/listWindows need no other fields. capture requires exactly one of windowId or display=primary. observe requires app; windowId and mode are optional. Every input action requires app and observationId, plus: press elementId; setValue elementId/text; click x/y; type text; key key; scroll deltaX/deltaY; drag x/y/toX/toY."},"display":{"type":"string","enum":["primary"]},"windowId":{"type":"integer","minimum":1},"app":{"type":"string","description":DESKTOP.app},"observationId":{"type":"string"},
        "mode":{"type":"string","enum":["background","foreground"],"description":"observe defaults to background, even without windowId. Only explicit mode=foreground permits raising the app and restoring focus for mouse/keyboard input."},"elementId":{"type":"string","description":DESKTOP.element},
        "x":{"type":"number"},"y":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"},"text":{"type":"string"},"key":{"type":"string","description":DESKTOP.key},"deltaX":delta.clone(),"deltaY":delta
    }})),
    ("browser.page","Operate previews in this task's GUI Host and Session. open/openSelf reuse the same resource without changing the selected GUI task. openSelf uses the installed UI; open a development server URL for Vite hot updates. Keep that previewId while editing and observing. For workspace files prefer browser.open; otherwise supply an HTTP(S) url, absolute filePath, or owned serviceId. activate explicitly shows a page in the selected task's Reader and waits for navigation and visible layout; on macOS it also initializes remote accessibility and returns separately verified readiness facts. Page status=ready alone means navigation finished. reload loads static file edits; navigate, act and close target an exact previewId. act supports inspect, selector or viewport-coordinate click, selector type, and scroll with an optional container selector. refreshInterface refreshes the primary DeepCode UI while preserving view state; it returns scheduled or needsUser for unsaved settings and never approves a user decision. Closing a page does not stop its service.",json!({
        "type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["open","openSelf","list","status","activate","navigate","reload","act","close","refreshInterface"]},
            "previewId":{"type":"string"},"url":{"type":"string"},"filePath":{"type":"string","description":"Explicit absolute HTML file path; preserve its relative resources."},"serviceId":{"type":"string"},"operation":{"type":"string","enum":["inspect","click","type","scroll"]},
            "selector":{"type":"string"},"text":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}
        }})),
    ("browser.service","Manage development services owned by this GUI Host and Session. Read the project configuration first; start its actual command and args in the explicit absolute directory, supplying its loopback URL. Starting a service requests Kernel Host-process permission; it does not inherit preview file permissions. A started process is not proof of a ready URL: open the URL and inspect its actual page. list/status report the process and logPath. stop only terminates this Host's exact owned process group. Closing a page leaves the service running; Host exit releases owned services.",json!({
        "type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["start","list","status","stop"]},"serviceId":{"type":"string"},
            "directory":{"type":"string"},"command":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"url":{"type":"string"}
        }})),
    ("browser.capture","Capture the exact preview viewport as a fixed PNG artifact without changing the selected GUI task. Requires previewId and workspace-relative .png path. The screenshot is preserved in the execution archive.",json!({
        "type":"object","additionalProperties":false,"required":["previewId","path"],"properties":{"previewId":{"type":"string"},"path":{"type":"string"}}}))
]
}

pub(crate) fn validate_computer_input(input: &Value) -> Result<(), String> {
    let object = input
        .as_object()
        .ok_or("Computer arguments must be an object")?;
    let action = input["action"].as_str().ok_or("action is required")?;
    let specific: &[&str] = match action {
        "status" | "listApps" | "listWindows" => &[],
        "capture" => {
            if input["display"] == "primary" && input.get("windowId").is_none() {
                &["display"]
            } else if input["windowId"]
                .as_u64()
                .is_some_and(|id| id > 0 && id <= u32::MAX as u64)
                && input.get("display").is_none()
            {
                &["windowId"]
            } else {
                return Err(
                    "capture requires exactly one display=primary or a valid observed windowId"
                        .into(),
                );
            }
        }
        "observe" => &["app", "windowId", "mode"],
        "press" => &["app", "observationId", "elementId"],
        "setValue" => &["app", "observationId", "elementId", "text"],
        "click" => &["app", "observationId", "x", "y"],
        "type" => &["app", "observationId", "text"],
        "key" => &["app", "observationId", "key"],
        "scroll" => &["app", "observationId", "deltaX", "deltaY"],
        "drag" => &["app", "observationId", "x", "y", "toX", "toY"],
        _ => return Err("Unsupported computer action".into()),
    };
    if object
        .keys()
        .any(|key| key != "action" && !specific.contains(&key.as_str()))
    {
        return Err("Unsupported computer argument".into());
    }
    for key in specific {
        if *key == "windowId" {
            if (action == "capture" || input.get("windowId").is_some())
                && !input["windowId"]
                    .as_u64()
                    .is_some_and(|id| id > 0 && id <= u32::MAX as u64)
            {
                return Err("windowId must be a valid observed window ID".into());
            }
            continue;
        }
        if *key == "mode" {
            if input.get("mode").is_some()
                && !matches!(input["mode"].as_str(), Some("background" | "foreground"))
            {
                return Err("mode must be background or foreground".into());
            }
            if input["mode"] == "background" && input.get("windowId").is_none() {
                return Err("Background observation requires an exact windowId".into());
            }
            continue;
        }
        if matches!(*key, "x" | "y" | "toX" | "toY") {
            if !input[key].as_f64().is_some_and(f64::is_finite) {
                return Err(format!("{key} must be a finite coordinate"));
            }
        } else if matches!(*key, "deltaX" | "deltaY") {
            if !input[key]
                .as_i64()
                .is_some_and(|value| i32::try_from(value).is_ok())
            {
                return Err(format!("{key} must be a 32-bit integer"));
            }
        } else if !input[key].as_str().is_some_and(|value| {
            value.len() <= 8192 && (*key == "text" || !value.trim().is_empty())
        }) {
            return Err(format!("{key} is required (maximum 8192 bytes)"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_capture_has_an_explicit_target_and_native_failures_retain_executor_diagnostics() {
        for input in [
            json!({"action":"status"}),
            json!({"action":"capture","display":"primary"}),
            json!({"action":"capture","windowId":42}),
        ] {
            validate_computer_input(&input).unwrap();
        }
        for input in [
            json!({"action":"capture"}),
            json!({"action":"capture","display":"primary","windowId":42}),
            json!({"action":"capture","windowId":0}),
        ] {
            assert!(validate_computer_input(&input).is_err());
        }
        let diagnostics = json!({"phase":"computer:observe","native":{"executor":{"pid":42},"permissions":{"accessibility":false,"screenCapture":true}}});
        let result = execution_result(
            "invoke:permission",
            Err(NativeError {
                message: "AX denied".into(),
                diagnostics: diagnostics.clone(),
            }),
        );
        assert_eq!(result.error.unwrap().message, "AX denied");
        assert_eq!(result.output["diagnostics"], diagnostics);
    }

    #[test]
    fn computer_actions_require_grounded_targets_and_typed_arguments() {
        assert!(validate_computer_input(&json!({"action":"listApps"})).is_ok());
        assert!(
            validate_computer_input(&json!({"action":"observe","app":"com.apple.finder"})).is_ok()
        );
        assert!(validate_computer_input(
            &json!({"action":"click","app":"com.apple.finder","x":10,"y":20})
        )
        .is_err());
        assert!(validate_computer_input(&json!({"action":"click","app":"com.apple.finder","observationId":"observation:1","x":10,"y":20})).is_ok());
        assert!(
            validate_computer_input(&json!({"action":"listApps","script":"arbitrary"})).is_err()
        );
        assert!(validate_computer_input(&json!({"action":"scroll","app":"com.apple.finder","observationId":"observation:1","deltaX":0,"deltaY":"down"})).is_err());
    }

    #[test]
    fn background_actions_require_exact_window_and_observed_element_identity() {
        for input in [
            json!({"action":"observe","app":"com.apple.TextEdit","windowId":42,"mode":"background"}),
            json!({"action":"press","app":"com.apple.TextEdit","observationId":"frame:1","elementId":"element:2"}),
            json!({"action":"setValue","app":"com.apple.TextEdit","observationId":"frame:1","elementId":"element:2","text":"new value"}),
        ] {
            validate_computer_input(&input).unwrap();
        }
        for input in [
            json!({"action":"observe","app":"com.apple.TextEdit","mode":"background"}),
            json!({"action":"press","app":"com.apple.TextEdit","elementId":"element:2"}),
            json!({"action":"setValue","app":"com.apple.TextEdit","observationId":"frame:1","text":"new value"}),
        ] {
            assert!(validate_computer_input(&input).is_err());
        }
    }

    #[test]
    fn post_action_capture_failure_preserves_the_dispatched_input() {
        let record = execution_result(
            "call:click",
            Ok(json!({"app":"example","action":"click","dispatched":true,
            "observationError":{"message":"Screen capture failed: original error"}})),
        );
        assert_eq!(record.outcome, KernelToolExecutionOutcome::Failed);
        assert_eq!(record.output["dispatched"], true);
        assert!(record.output.get("modelImages").is_none());
        assert_eq!(
            record.error.unwrap().message,
            "Screen capture failed: original error"
        );
        let record = execution_result(
            "call:click",
            Ok(json!({"dispatched":true,"observationId":"next"})),
        );
        assert_eq!(record.outcome, KernelToolExecutionOutcome::Completed);
        assert_eq!(record.output["observationId"], "next");
    }

    #[test]
    fn unapplied_value_preserves_dispatch_verification_and_observation() {
        let output = json!({"action":"setValue","dispatched":true,
            "valueVerification":{"expected":"updated","actual":"","matched":false},
            "actionError":{"message":"AX value remained empty"},
            "observationId":"after-set","artifacts":[{"artifactId":"after-image"}]});
        let record = execution_result("call:set", Ok(output.clone()));
        assert_eq!(record.outcome, KernelToolExecutionOutcome::Failed);
        assert_eq!(record.output, output);
        let error = record.error.unwrap();
        assert_eq!(error.code, "computer_value_not_applied");
        assert_eq!(error.message, "AX value remained empty");
    }
}
