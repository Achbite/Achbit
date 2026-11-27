//! Native control of the exact local Host attached to this GUI. Never resolve a new
//! Host from the data directory when carrying out a previously confirmed action.
use super::{HostApiEnvelope, HostProcessGroup};
use achbit_host_connection::installation::wait_for_process_exit;
use achbit_host_connection::loopback_http::request_loopback_json_until;
use achbit_kernel_abi::{
    HostProcessIdentity, HostQuitStatus, HostShutdownReceipt, HOST_SHELL_TOKEN_HEADER,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub(super) struct Host {
    host: String,
    port: String,
    token: String,
    pub(super) identity: HostProcessIdentity,
}
impl Host {
    fn post(&self, path: &str, body: Value, timeout: Duration) -> Result<Value, String> {
        let body = body.to_string();
        let request = format!("POST {path} HTTP/1.1\r\nHost: {}:{}\r\n{}: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", self.host, self.port, HOST_SHELL_TOKEN_HEADER, self.token, body.len(), body);
        let reply: HostApiEnvelope<Value> =
            request_loopback_json_until(&self.host, &self.port, &request, Instant::now() + timeout)
                .map_err(|e| e.to_string())?;
        reply.into_data().map_err(|e| e.to_string())
    }

    pub(super) fn request(
        &self,
        action: &str,
        token: Option<u64>,
        manual: bool,
        confirmed: bool,
    ) -> Result<Value, String> {
        self.post("/api/host/update", json!({"action":action,"token":token,"expectedIdentity":self.identity,"manual":manual,"confirmed":confirmed}), Duration::from_secs(45))
    }
}
pub(super) fn local_host(app: &AppHandle) -> Result<Option<Host>, String> {
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

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum QuitOutcome {
    ConfirmationRequired { host_id: String, active: bool },
    Exiting,
}

// The idle fast path uses the existing atomic admission/activity barrier. Once
// confirmed, explicit shutdown drains even in-flight work without another idle veto.
fn quit_local_host(
    host: &Host,
    confirmation: Option<&str>,
    unsaved: bool,
) -> Result<QuitOutcome, String> {
    let id = &host.identity.instance_id;
    if confirmation.is_some_and(|selected| selected != id) {
        return Err("quit_host_changed".into());
    }
    let ask = |active| QuitOutcome::ConfirmationRequired {
        host_id: id.clone(),
        active,
    };
    if confirmation.is_none() {
        let status: HostQuitStatus =
            serde_json::from_value(host.request("quitStatus", None, false, false)?)
                .map_err(|error| error.to_string())?;
        match status {
            HostQuitStatus::InitializationFailed { code, message } => {
                eprintln!("{code}: {message}");
                // Nothing can be submitted to this failed runtime. Leave the decision (including
                // any unsaved edits) to the user and retain the original expected identity.
                return Ok(ask(false));
            }
            HostQuitStatus::Ready { active } if active || unsaved => return Ok(ask(active)),
            HostQuitStatus::Ready { .. } => {} // The atomic prepare still rechecks work below.
        }
    }
    let result = if confirmation.is_some() {
        host.post(
            "/api/host/shutdown?cancelActiveRuns=true",
            json!({"expectedIdentity":host.identity}),
            Duration::from_millis(achbit_kernel_abi::HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS),
        )?
    } else {
        let prepared = host.request("prepare", None, true, false)?;
        match (prepared["prepared"].as_bool(), prepared["reason"].as_str()) {
            (Some(false), Some("tasks")) => return Ok(ask(true)),
            (Some(false), Some("requests")) => {
                let busy = host.request("status", None, false, false)?["active"]
                    .as_bool()
                    .ok_or("Invalid Host activity response")?;
                return Ok(ask(busy));
            }
            (Some(false), Some(reason)) => {
                return Err(format!("Host shutdown could not start: {reason}"))
            }
            (Some(true), _) => {}
            _ => return Err("Invalid Host shutdown preparation".into()),
        }
        let token = prepared["token"]
            .as_u64()
            .ok_or("Host shutdown preparation token is missing")?;
        host.request("commit", Some(token), true, false)?
    };
    let receipt: HostShutdownReceipt = serde_json::from_value(result).map_err(|e| e.to_string())?;
    if !receipt.accepts_shutdown_of(&host.identity) {
        return Err("The Host shutdown receipt did not match the requested instance".into());
    }
    wait_for_process_exit(host.identity.pid, Duration::from_secs(30)).map_err(|e| e.to_string())?;
    if !receipt.cleanup_complete {
        // An incomplete cleanup is not a live Host. Preserve the failure, but don't
        // strand the user in a disconnected window after an explicit Quit.
        eprintln!(
            "quit_host_cleanup_incomplete: {}",
            host.identity.instance_id
        );
    }
    Ok(QuitOutcome::Exiting)
}

#[tauri::command]
pub(super) async fn achbit_quit(
    app: AppHandle,
    confirm_host_id: Option<String>,
    has_unsaved_changes: bool,
) -> Result<QuitOutcome, String> {
    if app.state::<super::LaunchTarget>().ssh.is_some()
        || super::env_truthy("ACHBIT_SHELL_CONNECT_ONLY")
    {
        return Err("Quit Achbit requires a local desktop Host".into());
    }
    let host = local_host(&app)?.ok_or("No local desktop Host is attached")?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        quit_local_host(&host, confirm_host_id.as_deref(), has_unsaved_changes)
    })
    .await
    .map_err(|e| e.to_string())??;
    if matches!(outcome, QuitOutcome::Exiting) {
        app.exit(0);
    }
    Ok(outcome)
}
