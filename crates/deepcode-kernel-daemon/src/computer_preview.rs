//! GUI-only current target preview. Frames never enter tool records or Session history.
use crate::prelude::*;
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewRequest {
    session_id: String,
    run_id: String,
    after_sequence: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActivateRequest {
    session_id: String,
    run_id: String,
    window_id: u32,
    generation: u64,
}

pub(crate) async fn preview(
    State(state): State<AppState>,
    Json(input): Json<PreviewRequest>,
) -> Json<Value> {
    let desktop = state.local_agent.kernel.desktop.clone();
    reply(
        tokio::task::spawn_blocking(move || {
            desktop.preview(&input.session_id, &input.run_id, input.after_sequence)
        })
        .await,
    )
}

pub(crate) async fn activate(
    State(state): State<AppState>,
    Json(input): Json<ActivateRequest>,
) -> Json<Value> {
    let desktop = state.local_agent.kernel.desktop.clone();
    reply(
        tokio::task::spawn_blocking(move || {
            desktop.activate_target(
                &input.session_id,
                &input.run_id,
                input.window_id,
                input.generation,
            )
        })
        .await,
    )
}

fn reply(
    result: Result<Result<Value, crate::browser_tools::NativeError>, tokio::task::JoinError>,
) -> Json<Value> {
    Json(match result {
        Ok(Ok(data)) => json!({ "ok": true, "data": data }),
        Ok(Err(error)) => {
            json!({ "ok": false, "error": "computer_preview_failed", "message": error.message, "diagnostics": error.diagnostics })
        }
        Err(error) => {
            json!({ "ok": false, "error": "computer_preview_failed", "message": error.to_string() })
        }
    })
}
