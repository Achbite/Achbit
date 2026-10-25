use crate::api_response::ApiResponse;
use crate::prelude::*;
use crate::{AppState, HostState};
use achbit_kernel_abi::{
    is_valid_host_instance_id, HostProcessIdentity, HostShutdownReceipt, HostShutdownRequest,
    HOST_INSTANCE_ID_ENV, HOST_SHUTDOWN_IDENTITY_CONFLICT, HOST_SHUTDOWN_OWNER,
    KERNEL_DAEMON_SERVICE,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static HOST_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static HOST_PROCESS_IDENTITY: OnceLock<HostProcessIdentity> = OnceLock::new();

fn daemon_identity_from_environment(
    address: SocketAddr,
) -> Result<HostProcessIdentity, &'static str> {
    let instance_id = std::env::var(HOST_INSTANCE_ID_ENV)
        .map_err(|_| "Host instance identity is not configured")?;
    if !is_valid_host_instance_id(&instance_id) {
        return Err("Host instance identity must contain 256 bits of entropy");
    }
    Ok(HostProcessIdentity {
        service: KERNEL_DAEMON_SERVICE.to_string(),
        instance_id,
        pid: std::process::id(),
        address: format!("http://{address}"),
    })
}

pub(crate) fn configure_host_process_identity(address: SocketAddr) -> Result<(), &'static str> {
    let identity = daemon_identity_from_environment(address)?;
    HOST_PROCESS_IDENTITY
        .set(identity)
        .map_err(|_| "Host process identity is already configured")
}

pub(crate) fn host_process_identity() -> &'static HostProcessIdentity {
    HOST_PROCESS_IDENTITY
        .get()
        .expect("Host process identity must be configured before serving")
}

pub(crate) async fn host_identity() -> Json<ApiResponse> {
    ApiResponse::ok(
        serde_json::to_value(host_process_identity())
            .expect("Host process identity must serialize"),
    )
}

pub(crate) async fn host_shutdown(
    State(state): State<HostState>,
    Json(request): Json<HostShutdownRequest>,
) -> Response {
    let identity = host_process_identity();
    if request.expected_identity != *identity {
        return (
            StatusCode::CONFLICT,
            ApiResponse::error(
                HOST_SHUTDOWN_IDENTITY_CONFLICT,
                "Host shutdown token does not match the running process identity",
            ),
        )
            .into_response();
    }
    let cleanup_complete = shutdown_owned_host_resources(&state).await;
    request_host_shutdown();
    let receipt = HostShutdownReceipt {
        accepted: true,
        owner: HOST_SHUTDOWN_OWNER.to_string(),
        identity: identity.clone(),
        cleanup_complete,
    };
    (
        StatusCode::OK,
        ApiResponse::ok(
            serde_json::to_value(receipt).expect("Host shutdown receipt must serialize"),
        ),
    )
        .into_response()
}

pub(crate) async fn shutdown_owned_host_resources(host: &HostState) -> bool {
    host.execution.stop_admission();
    crate::host_lifecycle::begin_host_shutdown();
    let services = match host.execution.wait().await {
        Ok(services) => services,
        // Initialization cleans up its partial resources before publishing errors.
        Err(_) => return host.execution.initialization_cleanup_complete(),
    };
    let state = &AppState {
        local_agent: services.local_agent,
        session_service: services.session_service,
        host: host.clone(),
    };
    crate::conversation_api::shutdown_conversation_titles(state).await;
    let session_service = state.session_service.clone();
    let session_cleanup_ok =
        match tokio::task::spawn_blocking(move || session_service.shutdown()).await {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                eprintln!("Session shutdown failed: {}: {}", error.code, error.message);
                false
            }
            Err(error) => {
                eprintln!("Session shutdown task failed: {error}");
                false
            }
        };
    let local_agent = state.local_agent.clone();
    let plugin_cleanup_ok =
        match tokio::task::spawn_blocking(move || local_agent.shutdown_plugins()).await {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                eprintln!("Kernel shutdown failed: {error}");
                false
            }
            Err(error) => {
                eprintln!("Kernel shutdown task failed: {error}");
                false
            }
        };
    session_cleanup_ok && plugin_cleanup_ok
}

pub(crate) fn request_host_shutdown() {
    HOST_SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

pub(crate) async fn wait_for_host_shutdown() {
    while !HOST_SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
