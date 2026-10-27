use crate::prelude::*;
use crate::*;

pub(crate) async fn health(State(host): State<HostState>) -> Json<ApiResponse> {
    let services = match host.execution.wait().await {
        Ok(services) => services,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let state = AppState {
        local_agent: services.local_agent,
        session_service: services.session_service,
        host,
    };
    let service = state.session_service.clone();
    match tokio::task::spawn_blocking(move || service.check_ready()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return ApiResponse::error(error.code, error.message),
        Err(error) => {
            return ApiResponse::error("session_service_health_failed", error.to_string())
        }
    }
    let workspace = current_workspace(&state.host_services.workspace)
        .ok()
        .and_then(|workspace| serde_json::to_value(workspace).ok())
        .unwrap_or(Value::Null);
    let build_info = packaged_build_info().unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "service": "achbit-kernel-daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "ok": true,
        "status": "ok",
        "kernel": "ready",
        "session": "ready",
        "buildCommit": build_commit(),
        "buildInfo": build_info,
        "protocolVersion": "achbit.local-agent",
        "workspace": workspace
    }))
}

pub(crate) fn build_commit() -> String {
    std::env::var("ACHBIT_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("ACHBIT_BUILD_COMMIT").map(str::to_string))
        .or_else(read_packaged_build_commit)
        .unwrap_or_else(|| "unknown".to_string())
}

fn read_packaged_build_commit() -> Option<String> {
    packaged_build_info()
        .and_then(|value| {
            value
                .get("sourceCommit")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|commit| !commit.trim().is_empty())
}

pub(crate) fn packaged_build_info() -> Option<Value> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))?;
    read_best_effort_json_file(
        &achbit_host_connection::runtime_root(&exe_dir)
            .ok()?
            .join("BUILDINFO.json"),
    )
}

pub(crate) async fn api_route_not_found(
    method: Method,
    Path(path): Path<String>,
) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        ApiResponse::error(
            "api_route_not_found",
            format!("{method} /api/{path} does not match a registered API route"),
        ),
    )
}
