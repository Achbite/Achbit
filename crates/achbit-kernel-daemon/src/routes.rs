use crate::prelude::*;
use crate::*;
use axum::routing::delete;
#[path = "computer_preview.rs"]
mod computer_preview;

pub(crate) fn build_app(state: HostState) -> Router {
    let host_connection = state.host_connection.clone();
    let app = Router::new()
        .route("/api/host/identity", get(host_identity))
        .route("/api/host/client", get(host_client))
        .route("/api/health", get(health))
        .route("/api/host/readiness", get(crate::host_runtime::readiness))
        .route("/api/host/instance", get(crate::host_runtime::instance))
        .route("/api/host/shutdown", post(host_shutdown))
        .route(
            "/api/host/computer-preview",
            post(computer_preview::preview),
        )
        .route(
            "/api/host/computer-preview/activate",
            post(computer_preview::activate),
        )
        .route(
            "/api/host/native-browser",
            post(crate::browser_tools::register),
        )
        .route("/api/workspaces/current", get(workspace_current))
        .route("/api/workspaces/default-path", get(workspace_default_path))
        .route("/api/workspaces/open", post(workspace_open))
        .route("/api/workspaces/save-file", post(workspace_save_file))
        .route("/api/fs/initial-locations", get(fs_initial_locations))
        .route("/api/fs/browse", get(fs_browse))
        .route("/api/fs/read", post(fs_read))
        .route(
            "/api/user-settings",
            get(user_settings_get).patch(user_settings_patch),
        )
        .route(
            "/api/user-settings/workspace-sandbox",
            post(workspace_sandbox_setup),
        )
        .route(
            "/api/llm/profiles",
            get(llm_profiles_get).patch(llm_profiles_patch),
        )
        .route("/api/llm/probe", post(llm_probe))
        .route(
            "/api/host/plugins/install",
            post(crate::plugin_installation::install),
        )
        .route("/api/plugin-services", get(crate::service_plugins::list))
        .route(
            "/api/plugin-services/events",
            get(crate::service_plugins::events),
        )
        .route(
            "/api/llm/connections",
            get(model_connections::get).patch(model_connections::patch),
        )
        .route("/api/llm/usage", post(model_usage::query))
        .route("/api/llm/prices", get(model_usage::catalog))
        .route("/api/llm/auth", post(model_auth::start))
        .route(
            "/api/llm/auth/:id",
            get(model_auth::read).delete(model_auth::cancel),
        )
        .route("/api/llm/connections/:id/logout", post(model_auth::logout))
        .route("/api/llm/connections/:id/quota", get(model_auth::quota))
        .route(
            "/api/local-agent/journal/sessions",
            post(local_agent_session_create),
        )
        .route(
            "/api/local-agent/agents/settings",
            get(local_agent_settings_get).post(local_agent_settings_set),
        )
        .route(
            "/api/local-agent/agents/models",
            get(local_agent_models_get),
        )
        .route(
            "/api/local-agent/agents/sessions",
            post(local_agent_child_session_create),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id",
            delete(local_agent_session_delete),
        )
        .route(
            "/api/local-agent/journal/events",
            post(local_agent_event_append),
        )
        .route(
            "/api/local-agent/journal/events/batch",
            post(local_agent_events_append_batch),
        )
        .route(
            "/api/local-agent/journal/commands",
            post(local_agent_command_commit),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/events",
            get(local_agent_events_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/resources",
            post(local_agent_resources_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/run-lifecycle",
            get(local_agent_run_lifecycle_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/agent-lifecycle",
            get(local_agent_agent_lifecycle_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/provider-usage",
            get(local_agent_provider_usage_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/commands/:command_id",
            get(local_agent_command_read),
        )
        .route(
            "/api/local-agent/runtime/prepare-run",
            post(local_agent_run_runtime_prepare),
        )
        .route(
            "/api/local-agent/runtime/release-run",
            post(local_agent_run_runtime_release),
        )
        .route(
            "/api/local-agent/runtime/retire-tool-views",
            post(local_agent_tool_views_retire),
        )
        .route(
            "/api/local-agent/kernel/processes",
            post(local_agent_processes),
        )
        .route(
            "/api/local-agent/plans/admission",
            post(local_agent_plan_admission),
        )
        .route(
            "/api/local-agent/kernel/prepare",
            post(local_agent_kernel_prepare),
        )
        .route(
            "/api/local-agent/kernel/execute",
            post(local_agent_tool_execute),
        )
        .route(
            "/api/local-agent/kernel/cancel",
            post(local_agent_tool_cancel),
        )
        .route(
            "/api/local-agent/kernel/records/:call_id",
            get(local_agent_tool_record),
        )
        .route(
            "/api/local-agent/provider/stream",
            post(local_agent_provider_stream)
                .layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/conversation/sessions",
            post(conversation_session_create),
        )
        .route(
            "/api/conversation/events",
            get(crate::session_events::conversation_events),
        )
        .route("/api/conversation/catalog", get(conversation_catalog_get))
        .route(
            "/api/conversation/catalog/events",
            get(conversation_catalog_events),
        )
        .route("/api/conversation/statuses", get(conversation_statuses_get))
        .route(
            "/api/conversation/plugins",
            get(conversation_plugin_catalog_get),
        )
        .route(
            "/api/conversation/plugins/skills",
            get(conversation_skill_settings_get),
        )
        .route(
            "/api/conversation/catalog/manage",
            get(conversation_catalog_management_get),
        )
        .route(
            "/api/conversation/projects",
            post(conversation_project_create),
        )
        .route(
            "/api/conversation/projects/:project_id",
            patch(conversation_project_update).delete(conversation_project_delete),
        )
        .route(
            "/api/conversation/sessions/:session_id",
            patch(conversation_session_update).delete(conversation_session_delete),
        )
        .route(
            "/api/conversation/sessions/:session_id/commands",
            post(conversation_command_submit).layer(DefaultBodyLimit::max(34 * 1024 * 1024)),
        )
        .route(
            "/api/conversation/sessions/:session_id/directory-indexes",
            post(conversation_directory_index_attach),
        )
        .route(
            "/api/conversation/sessions/:session_id/input-resources/:input_id",
            post(conversation_input_upload).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route(
            "/api/conversation/sessions/:session_id/filesystem-references/resolve",
            post(conversation_filesystem_references_resolve),
        )
        .route(
            "/api/conversation/sessions/:session_id/directory-indexes/:workspace_id",
            delete(conversation_directory_index_detach),
        )
        .route(
            "/api/conversation/sessions/:session_id/read",
            post(conversation_read),
        )
        .route(
            "/api/conversation/sessions/:session_id/projection",
            get(conversation_projection_get),
        )
        .route(
            "/api/conversation/sessions/:session_id/context-compositions/:provider_request_id",
            get(conversation_context_composition_get),
        )
        .route(
            "/api/conversation/sessions/:session_id/changes/read",
            post(conversation_change_read),
        )
        .route(
            "/api/conversation/sessions/:session_id/resources/roots",
            get(conversation_resource_roots),
        )
        .route(
            "/api/conversation/sessions/:session_id/resources/list",
            post(conversation_resource_list),
        )
        .route(
            "/api/conversation/sessions/:session_id/resources/watch",
            post(conversation_resources_watch),
        )
        .route(
            "/api/conversation/sessions/:session_id/resources/read",
            post(conversation_resource_read),
        )
        .route(
            "/api/conversation/sessions/:session_id/artifacts/:artifact_id/content",
            get(conversation_artifact_read),
        )
        .route("/api/*path", any(api_route_not_found));
    #[cfg(feature = "debug-control")]
    let app = app
        .route("/api/debug/command", post(crate::debug_control::command))
        .route("/api/debug/observe", post(crate::debug_control::observe));
    app.with_state(state)
        .layer(localhost_cors_layer())
        .layer(axum::middleware::from_fn_with_state(
            host_connection,
            trusted_host_connection_gate,
        ))
        .layer(axum::middleware::from_fn(trusted_local_origin_gate))
}
