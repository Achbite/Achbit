//! Preparing an installation update is reversible; shutdown is the commit point.
use crate::prelude::*;
use crate::*;
use achbit_host_connection::installation::Installation;
use achbit_kernel_abi::{HostProcessIdentity, HostShutdownReceipt, HOST_SHUTDOWN_OWNER};
use axum::{extract::Request, middleware::Next};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{OwnedRwLockWriteGuard, RwLock};

struct Prepared {
    token: u64,
    _guard: OwnedRwLockWriteGuard<()>,
}

pub(crate) struct Updates {
    admission: Arc<RwLock<()>>,
    prepared: Mutex<Option<Prepared>>,
    sequence: AtomicU64,
    installation: Installation,
}

impl Updates {
    pub(crate) fn new() -> std::io::Result<Self> {
        Ok(Self {
            admission: Arc::new(RwLock::new(())),
            prepared: Mutex::new(None),
            sequence: AtomicU64::new(0),
            installation: Installation::current()?,
        })
    }

    fn abort(&self, token: u64) -> Result<(), String> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| "Update state lock poisoned")?;
        if prepared
            .as_ref()
            .is_some_and(|pending| pending.token == token)
        {
            self.installation
                .resume()
                .map_err(|error| error.to_string())?;
            prepared.take();
        }
        Ok(())
    }
}

/// In-flight external requests finish before prepare can obtain exclusive admission.
/// Session's internal settlement requests remain available while draining.
pub(crate) async fn admission(
    State(updates): State<Arc<Updates>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path == "/api/host/update" || path.starts_with("/api/local-agent/") {
        return next.run(request).await;
    }
    let Ok(_guard) = updates.admission.clone().try_read_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            ApiResponse::error("host_updating", "Achbit is preparing an update."),
        )
            .into_response();
    };
    next.run(request).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRequest {
    action: String,
    expected_identity: HostProcessIdentity,
    token: Option<u64>,
}

pub(crate) async fn update(
    State(host): State<HostState>,
    Json(request): Json<UpdateRequest>,
) -> Response {
    if request.expected_identity != *host_process_identity() {
        return (
            StatusCode::CONFLICT,
            ApiResponse::error(
                "host_identity_conflict",
                "Update request does not identify this Host.",
            ),
        )
            .into_response();
    }
    match handle(&host, request).await {
        Ok(value) => ApiResponse::ok(value).into_response(),
        Err(error) => (
            StatusCode::CONFLICT,
            ApiResponse::error("host_update_failed", error),
        )
            .into_response(),
    }
}

async fn handle(host: &HostState, request: UpdateRequest) -> Result<Value, String> {
    match request.action.as_str() {
        "prepare" => {
            let Ok(guard) = host.updates.admission.clone().try_write_owned() else {
                return Ok(json!({"prepared":false,"reason":"requests"}));
            };
            if !crate::host_lifecycle::can_prepare_update() {
                return Ok(json!({"prepared":false,"reason":"clients"}));
            }
            let services = host
                .execution
                .current()
                .ok_or("Host is still starting")?
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let service = services.session_service;
            let activity =
                tokio::task::spawn_blocking(move || service.request("activity", json!({})))
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let active = activity
                .get("active")
                .and_then(Value::as_bool)
                .ok_or("Invalid Session activity response")?;
            let executing = services
                .local_agent
                .kernel
                .has_active_work()
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if active || executing {
                return Ok(json!({"prepared":false,"reason":"tasks"}));
            }
            host.updates
                .installation
                .release()
                .map_err(|error| error.to_string())?;
            let token = host.updates.sequence.fetch_add(1, Ordering::SeqCst) + 1;
            *host
                .updates
                .prepared
                .lock()
                .map_err(|_| "Update state lock poisoned")? = Some(Prepared {
                token,
                _guard: guard,
            });
            let watched = host.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if let Err(error) = watched.updates.abort(token) {
                    eprintln!("update preparation recovery failed: {error}");
                    shutdown_owned_host_resources(&watched).await;
                    request_host_shutdown();
                }
            });
            Ok(json!({"prepared":true,"token":token}))
        }
        "abort" => {
            host.updates
                .abort(request.token.ok_or("Update token is missing")?)?;
            Ok(json!({"aborted":true}))
        }
        "commit" => {
            let prepared = {
                let mut slot = host
                    .updates
                    .prepared
                    .lock()
                    .map_err(|_| "Update state lock poisoned")?;
                if slot.as_ref().map(|prepared| prepared.token) != request.token {
                    return Err("Update preparation expired or does not match".into());
                }
                slot.take().ok_or("Host has not prepared an update")?
            };
            let cleanup_complete = shutdown_owned_host_resources(host).await;
            request_host_shutdown();
            drop(prepared);
            Ok(serde_json::to_value(HostShutdownReceipt {
                accepted: true,
                owner: HOST_SHUTDOWN_OWNER.into(),
                identity: host_process_identity().clone(),
                cleanup_complete,
            })
            .map_err(|error| error.to_string())?)
        }
        _ => Err("Unknown update action".into()),
    }
}
