//! Debug transport adapter. Lifecycle and execution facts belong to the Kernel.
use crate::local_agent_kernel::{
    LocalAgentKernel, LocalAgentKernelError, LocalAgentPermissionPolicy,
};
use crate::local_agent_plugins::PluginSelectionInput;
use crate::AppState;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

fn error(error: LocalAgentKernelError) -> String {
    format!("{}: {}", error.code, error.message)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("debug_argument_missing: {key}"))
}

pub(crate) async fn dispatch(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let control = string(&params, "controlId")?;
    let kernel = &state.local_agent.kernel;
    if matches!(
        method,
        "tools.list" | "tools.inspect" | "tools.call" | "components.activate"
    ) {
        if method == "components.activate" || !kernel.debug_has_control(control).map_err(error)? {
            let state = state.clone();
            let params = params.clone();
            let replace = method == "components.activate";
            tokio::task::spawn_blocking(move || prepare_control(&state, &params, replace))
                .await
                .map_err(|e| e.to_string())??;
        }
    }
    match method {
        "tools.list" => kernel.debug_catalog(control).map_err(error),
        "tools.inspect" => {
            let catalog = kernel.debug_catalog(control).map_err(error)?;
            let tool = params["tool"]
                .as_str()
                .or(params["toolName"].as_str())
                .ok_or("debug_argument_missing: tool")?;
            catalog["tools"]
                .as_array()
                .and_then(|tools| tools.iter().find(|item| item["name"] == tool))
                .cloned()
                .ok_or_else(|| format!("tool_not_found: {tool}"))
        }
        "tools.call" => kernel
            .debug_call(
                control,
                params["tool"]
                    .as_str()
                    .or(params["toolName"].as_str())
                    .ok_or("debug_argument_missing: tool")?,
                params["input"].clone(),
            )
            .map_err(error),
        "operation.inspect" => kernel
            .debug_inspect(
                Path::new(string(&params, "workspace")?),
                string(&params, "operationId")?,
                params["waitMs"].as_u64().unwrap_or(0),
            )
            .await
            .map_err(error),
        "operation.cancel" => kernel
            .debug_cancel(control, string(&params, "operationId")?)
            .map_err(error),
        "operation.respond" => kernel
            .debug_respond(
                control,
                string(&params, "operationId")?,
                string(&params, "decisionId")?,
                string(&params, "decision")?,
            )
            .map_err(error),
        "operation.release" => kernel
            .debug_release(control, string(&params, "operationId")?)
            .map_err(error),
        "components.list" | "components.inspect" => {
            let gui = state.gui.lock().map_err(|_| "gui_state_lock_failed")?;
            let catalog =
                crate::local_agent_plugins::plugin_catalog_projection(&gui.user_settings)?;
            if method == "components.list" {
                return Ok(catalog);
            }
            let uri = string(&params, "uri")?;
            catalog["plugins"]
                .as_array()
                .and_then(|plugins| plugins.iter().find(|p| p["uri"] == uri))
                .cloned()
                .ok_or_else(|| format!("plugin_not_found: {uri}"))
        }
        "components.activate" => kernel.debug_catalog(control).map_err(error),
        "metrics.query" | "metrics.export" => kernel.debug_metrics(control, &params).map_err(error),
        "result.read" => kernel.debug_result(control, &params).map_err(error),
        "control.release" => {
            kernel.debug_release_control(control).map_err(error)?;
            Ok(json!({"released":true,"controlId":control}))
        }
        _ => Err(format!("debug_method_unknown: {method}")),
    }
}

fn prepare_control(state: &AppState, params: &Value, replace: bool) -> Result<Value, String> {
    let control = string(params, "controlId")?;
    let _guard = state
        .local_agent
        .kernel
        .debug_catalog_guard()
        .map_err(error)?;
    if !replace
        && state
            .local_agent
            .kernel
            .debug_has_control(control)
            .map_err(error)?
    {
        return state
            .local_agent
            .kernel
            .debug_catalog(control)
            .map_err(error);
    }
    let workspace = Path::new(string(params, "workspace")?);
    if !workspace.is_absolute() {
        return Err("debug_workspace_invalid: expected an absolute directory".into());
    }
    let (settings, mut config, secrets) = {
        let gui = state.gui.lock().map_err(|_| "gui_state_lock_failed")?;
        let (config, secrets) = crate::runtime_tool_configuration(&gui)?;
        (gui.user_settings.clone(), config, secrets)
    };
    let mut selections: Vec<PluginSelectionInput> = params
        .get("pluginSelections")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let plugins =
        crate::local_agent_plugins::resolve_plugin_selection(&settings, &mut selections, false)?;
    let environment = crate::session_environment::prepare(&settings, None, false)?;
    config.shell_program =
        serde_json::from_value(environment["shell"].clone()).map_err(|e| e.to_string())?;
    config.execution_path = Some(string(&environment, "executionPath")?.into());
    config.file_read_roots = plugins.file_read_roots();
    if let Some(path) = environment["productDocsPath"].as_str() {
        config.file_read_roots.push(path.into());
    }
    #[cfg(target_os = "macos")]
    if let Some(commands) = environment["commandPaths"].as_object() {
        for path in commands.values().filter_map(Value::as_str) {
            config
                .file_read_roots
                .push(Path::new(path).canonicalize().map_err(|e| e.to_string())?);
        }
    }
    #[cfg(windows)]
    {
        // Match ordinary native runs: Windows execution aliases need not be
        // readable files. Grant only the existing runtime's recognized roots.
        let command_paths = environment["commandPaths"]
            .as_object()
            .into_iter()
            .flat_map(|commands| commands.values());
        for path in command_paths.chain(std::iter::once(&environment["shell"]["executable"])) {
            if let Some(path) = path.as_str() {
                config.file_read_roots.extend(
                    achbit_kernel_runtime::shell_environment::windows_runtime_read_roots(
                        Path::new(path),
                    ),
                );
            }
        }
    }
    let enable_web = achbit_kernel_runtime::executors::web_search_availability(&config)
        == achbit_kernel_tools::ToolAvailability::Callable;
    let mcp = crate::local_agent_mcp::McpRuntime::from_selected_sources(
        &plugins.mcp_sources,
        plugins.mcp_plugin_instances(),
        Some(workspace.to_owned()),
    )
    .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let product = crate::local_agent_product_tools::ProductTools::new(Arc::new(
        state.session_service.clone(),
    ))
    .with_plugin_settings(settings.clone(), false)
    .with_documents(plugins.document_instance())
    .with_containers(plugins.container_instance())
    .with_computer_use(plugins.computer_use_instance())
    .with_document_python(settings["agent.documents.pythonPath"].as_str());
    let prepared = LocalAgentKernel::prepare_generation(
        &crate::utils::new_runtime_ref("extension-generation")?,
        config,
        Arc::new(secrets),
        mcp,
        LocalAgentPermissionPolicy::from_settings(&settings).map_err(error)?,
        enable_web,
        Arc::new(product),
    )
    .map_err(error)?;
    state
        .local_agent
        .kernel
        .debug_bind_control(
            control,
            workspace,
            prepared,
            Arc::new({
                let gui = state.gui.clone();
                move || {
                    let gui = gui.lock().map_err(|_| {
                        LocalAgentKernelError::new(
                            "debug_permission_source_unavailable",
                            "GUI settings lock is poisoned",
                        )
                    })?;
                    LocalAgentPermissionPolicy::from_settings(&gui.user_settings)
                }
            }),
        )
        .map_err(error)
}
