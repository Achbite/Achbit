//! Debug-only Host adapter. Execution facts remain in Kernel / Session / GUI.
use crate::ReadyState;
use crate::{ApiResponse, AppState};
use axum::{
    extract::Path,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

#[derive(Clone)]
struct Control {
    id: String,
    workspace: String,
}
#[derive(Clone)]
struct Subscription {
    control_id: String,
    session_id: String,
    receiver: Arc<tokio::sync::Mutex<mpsc::Receiver<Value>>>,
}
static CONTROL: LazyLock<Mutex<Option<Control>>> = LazyLock::new(|| Mutex::new(None));
static SUBSCRIPTIONS: LazyLock<Mutex<HashMap<String, Subscription>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Command {
    method: String,
    #[serde(default)]
    params: Value,
}

fn id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(format!(
        "{prefix}-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("debug_parameter_required: {key}"))
}
fn control(params: &Value) -> Result<Control, String> {
    let requested = text(params, "controlId")?;
    CONTROL
        .lock()
        .map_err(|_| "debug_control_lock_failed")?
        .as_ref()
        .filter(|entry| entry.id == requested)
        .cloned()
        .ok_or_else(|| "debug_control_not_attached".into())
}
fn data(reply: Json<ApiResponse>) -> Result<Value, String> {
    if reply.0.ok {
        reply
            .0
            .data
            .ok_or_else(|| "debug_response_data_missing".into())
    } else {
        Err(format!(
            "{}: {}",
            reply.0.error.unwrap_or_default(),
            reply.0.message.unwrap_or_default()
        ))
    }
}
fn service_error(error: crate::SessionServiceError) -> String {
    format!("{}: {}", error.code, error.message)
}
fn task_scope(state: &AppState, session_id: &str, workspace: &str) -> Result<(), String> {
    let gui = state.gui.lock().map_err(|_| "gui_state_lock_failed")?;
    let catalog = &gui.conversation_catalog;
    let session = catalog
        .session(session_id)
        .ok_or("debug_session_not_found")?;
    if session.workspace_bindings.is_empty() {
        return Err("debug_session_workspace_required".into());
    }
    for binding in &session.workspace_bindings {
        let bound = catalog
            .workspace(&binding.workspace_id)
            .ok_or("debug_session_workspace_missing")?;
        if bound.canonical_root != workspace
            && bound.owner_session_id.as_deref() != Some(session_id)
        {
            return Err("debug_session_workspace_scope_mismatch".into());
        }
    }
    Ok(())
}

async fn gui_command(action: &str, mut params: Value) -> Result<Value, String> {
    let hosts = crate::browser_tools::debug_hosts()?;
    let host = match params["guiHostId"].as_str() {
        Some(id) if hosts.iter().any(|host| host == id) => id.to_string(),
        Some(_) => return Err("debug_gui_host_unknown".into()),
        None if hosts.len() == 1 => hosts[0].clone(),
        None if hosts.is_empty() => return Err("debug_gui_not_connected".into()),
        None => return Err("debug_gui_host_required".into()),
    };
    params["action"] = json!(action);
    let binding = json!({"hostInstanceId":host,"windowLabel":"main"});
    tokio::task::spawn_blocking(move || {
        crate::browser_tools::call(&binding, &params).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn command(
    ReadyState(state): ReadyState,
    Json(command): Json<Command>,
) -> Json<ApiResponse> {
    match dispatch(state, &command.method, command.params).await {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => ApiResponse::error("debug_command_failed", error),
    }
}

async fn dispatch(state: AppState, method: &str, mut params: Value) -> Result<Value, String> {
    if !params.is_object() && !params.is_null() {
        return Err("debug_params_must_be_object".into());
    }
    if params.is_null() {
        params = json!({});
    }
    if method == "inspect" || method == "instances" {
        let dirs = state
            .gui
            .lock()
            .map_err(|_| "gui_state_lock_failed")?
            .paths
            .directories
            .clone();
        let attached = CONTROL
            .lock()
            .map_err(|_| "debug_control_lock_failed")?
            .as_ref()
            .map(|c| json!({"controlId":c.id,"workspace":c.workspace}));
        return Ok(
            json!({"schemaVersion":"deepcode.debug.v1", "buildKind":"debug", "identity":crate::host_process_identity(),
            "directories":dirs,"control":attached,"guiHosts":crate::browser_tools::debug_hosts()?,
            "capabilities":["tools", "operations", "surfaces", "tasks", "observations", "metrics"]}),
        );
    }
    if method == "attach" {
        if text(&params, "instanceId")? != crate::host_process_identity().instance_id {
            return Err("debug_instance_mismatch".into());
        }
        let path = PathBuf::from(text(&params, "workspace")?)
            .canonicalize()
            .map_err(|e| format!("debug_workspace_invalid: {e}"))?;
        if !path.is_dir() {
            return Err("debug_workspace_not_directory".into());
        }
        let mut attached = CONTROL.lock().map_err(|_| "debug_control_lock_failed")?;
        if attached.is_some() {
            return Err("debug_instance_already_controlled".into());
        }
        let next = Control {
            id: id("control")?,
            workspace: path.to_string_lossy().into_owned(),
        };
        let reply = json!({"controlId":next.id,"workspace":next.workspace,"instanceId":crate::host_process_identity().instance_id});
        *attached = Some(next);
        return Ok(reply);
    }
    if method == "gui.stop" {
        if params["expectedIdentity"] != json!(crate::host_process_identity()) {
            return Err("debug_instance_mismatch".into());
        }
        return gui_command("debug:shutdown", params).await;
    }
    let selected = control(&params)?;
    if method == "detach" {
        crate::debug_tools::dispatch(&state, "control.release", params.clone()).await?;
        let ids: Vec<_> = SUBSCRIPTIONS
            .lock()
            .map_err(|_| "debug_observation_lock_failed")?
            .iter()
            .filter(|(_, s)| s.control_id == selected.id)
            .map(|(id, _)| id.clone())
            .collect();
        for sub in ids {
            SUBSCRIPTIONS
                .lock()
                .map_err(|_| "debug_observation_lock_failed")?
                .remove(&sub);
            let service = state.session_service.clone();
            tokio::task::spawn_blocking(move || service.debug_unsubscribe(&sub))
                .await
                .map_err(|e| e.to_string())?
                .map_err(service_error)?;
        }
        *CONTROL.lock().map_err(|_| "debug_control_lock_failed")? = None;
        return Ok(json!({"detached":true,"controlId":selected.id}));
    }
    if let Some(workspace) = params.get("workspace") {
        if workspace.as_str() != Some(&selected.workspace) {
            return Err("debug_workspace_scope_mismatch".into());
        }
    }
    params["workspace"] = json!(selected.workspace);
    if method == "result.read" && params["sessionId"].is_string() {
        task_scope(&state, text(&params, "sessionId")?, &selected.workspace)?;
        let service = state.session_service.clone();
        return tokio::task::spawn_blocking(move || service.request("debug.resultRead", params))
            .await
            .map_err(|e| e.to_string())?
            .map_err(service_error);
    }
    if method.starts_with("tools.")
        || method.starts_with("operation.")
        || method.starts_with("components.")
        || method == "result.read"
    {
        return crate::debug_tools::dispatch(&state, method, params).await;
    }
    if method.starts_with("surfaces.")
        || method == "gui.ready"
        || method == "action"
        || (method.starts_with("metrics.")
            && matches!(params["kind"].as_str(), Some("component" | "ui" | "event")))
    {
        let action = match method {
            "surfaces.list" => "debug:surfaces",
            "surfaces.inspect" => "debug:inspect",
            "gui.ready" => "debug:ready",
            "action" => "debug:action",
            _ => "debug:metrics",
        };
        return gui_command(action, params).await;
    }
    if method == "observe.subscribe" {
        let session = text(&params, "sessionId")?.to_string();
        task_scope(&state, &session, &selected.workspace)?;
        let run = params["runId"].as_str().map(str::to_owned);
        let budget = params["inputBudgetTokens"].as_u64();
        let service = state.session_service.clone();
        let session_id = session.clone();
        let (subscription_id, receiver) = tokio::task::spawn_blocking(move || {
            service.debug_subscribe(&session, run.as_deref(), budget)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(service_error)?;
        SUBSCRIPTIONS
            .lock()
            .map_err(|_| "debug_observation_lock_failed")?
            .insert(
                subscription_id.clone(),
                Subscription {
                    control_id: selected.id,
                    session_id,
                    receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
                },
            );
        return Ok(json!({"subscriptionId":subscription_id,"delivery":"future-events"}));
    }
    if method == "task.submit" {
        let message = text(&params, "text")?.to_string();
        let session_id = match params["sessionId"].as_str() {
            Some(value) => {
                task_scope(&state, value, &selected.workspace)?;
                value.to_string()
            }
            None => {
                let request = serde_json::from_value(json!({"workspacePaths":[selected.workspace],"profileId":params["profileId"],"recipe":params["recipe"],"subagentSettings":params["subagentSettings"]})).map_err(|e| e.to_string())?;
                let projection = data(
                    crate::conversation_api::conversation_session_create(
                        ReadyState(state.clone()),
                        Json(request),
                    )
                    .await,
                )?;
                text(&projection, "sessionId")?.to_string()
            }
        };
        let service = state.session_service.clone();
        let session = session_id.clone();
        let budget = params["inputBudgetTokens"].as_u64();
        let (subscription_id, receiver) =
            tokio::task::spawn_blocking(move || service.debug_subscribe(&session, None, budget))
                .await
                .map_err(|e| e.to_string())?
                .map_err(service_error)?;
        let mut command = json!({"schemaVersion":"deepcode.command.v3","type":"message.submit","commandId":id("debug-input")?,"sessionId":session_id,"text":message});
        for field in ["profileId", "pluginSelections", "guidanceReferences"] {
            if let Some(value) = params.get(field) {
                command[field] = value.clone();
            }
        }
        let submitted = data(
            crate::conversation_api::conversation_command_submit(
                ReadyState(state.clone()),
                Path(session_id.clone()),
                Json(command),
            )
            .await,
        );
        match submitted {
            Ok(reply) if reply["status"] != "rejected" => {
                SUBSCRIPTIONS
                    .lock()
                    .map_err(|_| "debug_observation_lock_failed")?
                    .insert(
                        subscription_id.clone(),
                        Subscription {
                            control_id: selected.id,
                            session_id: session_id.clone(),
                            receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
                        },
                    );
                return Ok(
                    json!({"sessionId":session_id,"subscriptionId":subscription_id,"submission":reply}),
                );
            }
            result => {
                let service = state.session_service.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    service.debug_unsubscribe(&subscription_id)
                })
                .await;
                return match result {
                    Err(error) => Err(error),
                    Ok(reply) => Err(format!("debug_task_rejected: {}", reply["error"])),
                };
            }
        }
    }
    if method.starts_with("metrics.") && params["kind"] == "provider" {
        return state.model_usage.debug_records(&params);
    }
    if method == "task.message" || method == "task.cancel" || method == "task.respond" {
        let session = text(&params, "sessionId")?.to_string();
        task_scope(&state, &session, &selected.workspace)?;
        let mut command = if method == "task.respond" {
            params["command"].clone()
        } else if method == "task.message" {
            json!({"type":"message.submit","text":text(&params,"text")?})
        } else {
            json!({"type":"run.cancel","runId":text(&params,"runId")?})
        };
        if !command.is_object() {
            return Err("debug_command_must_be_object".into());
        }
        command["schemaVersion"] = json!("deepcode.command.v3");
        command["commandId"] = json!(id("debug-input")?);
        command["sessionId"] = json!(session);
        return data(
            crate::conversation_api::conversation_command_submit(
                ReadyState(state),
                Path(session),
                Json(command),
            )
            .await,
        );
    }
    if method == "task.inspect"
        || (method.starts_with("metrics.")
            && matches!(params["kind"].as_str(), Some("session" | "run")))
    {
        let session = text(&params, "sessionId")?.to_string();
        task_scope(&state, &session, &selected.workspace)?;
        if method == "task.inspect" {
            return data(
                crate::conversation_api::conversation_projection_get(
                    ReadyState(state),
                    Path(session),
                )
                .await,
            );
        }
        let service = state.session_service.clone();
        return tokio::task::spawn_blocking(move || {
            service.request(
                "debug.metrics",
                json!({"sessionId":session,"runId":params["runId"]}),
            )
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(service_error);
    }
    if method.starts_with("metrics.") && params["kind"] == "usage" {
        let query = serde_json::from_value(params["query"].clone())
            .map_err(|e| format!("usage_query_invalid: {e}"))?;
        return data(crate::model_usage::query(ReadyState(state), Json(query)).await);
    }
    if method.starts_with("metrics.") {
        return crate::debug_tools::dispatch(&state, method, params).await;
    }
    if method == "observe.status" {
        let subscription = text(&params, "subscriptionId")?.to_string();
        let service = state.session_service.clone();
        return tokio::task::spawn_blocking(move || {
            service.debug_observation_status(&subscription)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(service_error);
    }
    Err(format!("debug_method_unknown: {method}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObserveRequest {
    control_id: String,
    subscription_id: String,
    #[serde(default)]
    follow: bool,
    wait_ms: Option<u64>,
}
struct SubscriptionGuard {
    service: crate::SessionServiceProcess,
    id: String,
    close: bool,
}
impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        if !self.close {
            return;
        }
        if let Ok(mut entries) = SUBSCRIPTIONS.lock() {
            entries.remove(&self.id);
        }
        let service = self.service.clone();
        let id = self.id.clone();
        tokio::task::spawn_blocking(move || {
            let _ = service.debug_unsubscribe(&id);
        });
    }
}
pub(crate) async fn observe(
    ReadyState(state): ReadyState,
    Json(request): Json<ObserveRequest>,
) -> Response {
    let result = (|| -> Result<Subscription, String> {
        control(&json!({"controlId":request.control_id}))?;
        let entries = SUBSCRIPTIONS
            .lock()
            .map_err(|_| "debug_observation_lock_failed")?;
        entries
            .get(&request.subscription_id)
            .filter(|subscription| subscription.control_id == request.control_id)
            .cloned()
            .ok_or_else(|| "debug_subscription_not_available".into())
    })();
    let subscription = match result {
        Ok(s) => s,
        Err(e) => return ApiResponse::error("debug_observe_failed", e).into_response(),
    };
    let mut receiver = match subscription.receiver.clone().try_lock_owned() {
        Ok(receiver) => receiver,
        Err(_) => {
            return ApiResponse::error(
                "debug_observe_busy",
                "This subscription already has a reader",
            )
            .into_response()
        }
    };
    let wait = Duration::from_millis(request.wait_ms.unwrap_or(180_000).clamp(1, 180_000));
    let guard = SubscriptionGuard {
        service: state.session_service.clone(),
        id: request.subscription_id.clone(),
        close: request.follow,
    };
    let stream = async_stream::stream! {
        let mut guard=guard;
        loop {
            let frame=match tokio::time::timeout(wait,receiver.recv()).await {
                Ok(Some(value))=>value,
                Ok(None)=> {
                    let service=state.session_service.clone(); let id=request.subscription_id.clone();
                    let status=tokio::task::spawn_blocking(move||service.debug_observation_status(&id)).await;
                    let status=match status{Ok(Ok(value))=>value,Ok(Err(e))=>json!({"status":"failed","error":e.code,"message":e.message}),Err(e)=>json!({"status":"failed","error":e.to_string()})};
                    guard.close=true;
                    yield Ok::<_,std::io::Error>(bytes::Bytes::from(format!("{}\n",json!({"type":"observation.closed","subscriptionId":request.subscription_id,"state":status}))));
                    break;
                },
                Err(_)=> {
                    let service=state.session_service.clone();let session=subscription.session_id.clone();
                    let snapshot=tokio::task::spawn_blocking(move||service.request("snapshot",json!({"sessionId":session}))).await;
                    let status=match snapshot {Ok(Ok(value))=>json!({"run":value["run"],"revision":value["revision"]}),Ok(Err(e))=>json!({"error":e.code,"message":e.message}),Err(e)=>json!({"error":e.to_string()})};
                    json!({"type":"observation.wait_timeout","subscriptionId":request.subscription_id,"state":status,"modelInput":false})
                }
            };
            let terminal=matches!(frame["status"].as_str(),Some("settled"|"failed"));
            if terminal {guard.close=true;}
            yield Ok::<_,std::io::Error>(bytes::Bytes::from(format!("{frame}\n")));
            if terminal || !request.follow {break;}
        }
    };
    (
        [(axum::http::header::CONTENT_TYPE, "application/x-ndjson")],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}
