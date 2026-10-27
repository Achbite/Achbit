#![recursion_limit = "256"]

mod api_response;
mod artifact_resources;
mod command_denylist;
mod config_root_lease;
mod config_setup;
mod container_tools;
mod conversation_api;
mod conversation_catalog;
mod conversation_resources;
#[cfg(feature = "debug-control")]
mod debug_control;
#[cfg(feature = "debug-control")]
mod debug_tools;
mod host_connection;
mod host_inspection;
mod host_lifecycle;
mod host_runtime;
mod host_services;
mod host_shutdown;
mod kernel_api;
mod kernel_tool_worker;
mod llm_profiles;
mod llm_provider_transport;
mod llm_stream_parser;
mod llm_transport;
mod local_agent_api;
mod local_agent_authorities;
mod local_agent_cli;
mod local_agent_first_party_plugins;
mod local_agent_kernel;
mod local_agent_mcp;
mod local_agent_permissions;
mod local_agent_plugins;
mod local_agent_product_tools;
mod local_agent_provider_runtime;
mod local_agent_recipe;
mod local_agent_resources;
mod local_agent_search;
mod local_agent_store;
mod local_agent_tool_catalog;
mod local_agent_tool_prompts;
mod managed_processes;
mod model_auth;
mod model_connections;
mod model_usage;
mod plugin_installation;
mod prelude;
mod provider_transport;
mod routes;
mod service_plugins;
mod session_environment;
mod session_events;
mod session_service;
mod settings_api;
mod state;
mod tool_images;
mod utils;
mod workspace_api;

use crate::prelude::*;

pub(crate) use api_response::*;
pub(crate) use config_root_lease::*;
pub(crate) use conversation_api::*;
use conversation_resources::*;
mod browser_tools;
mod desktop_tools;
pub(crate) use host_connection::*;
pub(crate) use host_lifecycle::*;
pub(crate) use host_services::*;
pub(crate) use host_shutdown::*;
pub(crate) use kernel_api::*;
pub(crate) use llm_profiles::*;
pub(crate) use llm_provider_transport::*;
pub(crate) use llm_stream_parser::*;
pub(crate) use llm_transport::*;
pub(crate) use local_agent_api::*;
pub(crate) use session_service::*;
pub(crate) use settings_api::*;
pub(crate) use state::*;
pub(crate) use utils::*;
pub(crate) use workspace_api::*;

fn main() {
    achbit_host_connection::startup::timing("kernel.entry");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("create async runtime");
    achbit_host_connection::startup::timing("kernel.runtime");
    runtime.block_on(run());
}

async fn run() {
    if std::env::args().nth(1).as_deref() == Some("--kernel-tool-worker") {
        if let Err(error) = kernel_tool_worker::run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let user_directories =
        achbit_host_connection::UserDirectories::resolve().expect("解析 Achbit 用户目录");
    achbit_host_connection::startup::timing("kernel.directories");
    #[cfg(windows)]
    {
        achbit_kernel_runtime::executors::suppress_error_dialogs();
        // Sandbox identities and recorded grants belong to this data root.
        achbit_kernel_runtime::workspace_sandbox::windows::configure(
            &user_directories
                .data_dir
                .join("agent-runtime")
                .join("windows-sandbox"),
        )
        .expect("初始化 Windows 工作区沙箱状态");
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--workspace-sandbox-init") {
        if let Err(error) = achbit_kernel_runtime::workspace_sandbox::windows::request_setup() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--workspace-sandbox-reset") {
        if let Err(error) = achbit_kernel_runtime::workspace_sandbox::windows::reset() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--user-directories") {
        println!(
            "{}",
            serde_json::to_string(&user_directories).expect("user directories")
        );
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--workspace-sandbox-status") {
        println!(
            "{}",
            serde_json::to_string(&achbit_kernel_runtime::workspace_sandbox::probe())
                .expect("Sandbox status")
        );
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--prepare-user-config") {
        match config_setup::prepare(&user_directories) {
            Ok(report) => println!("{}", serde_json::to_string(&report).expect("config report")),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let host = std::env::var("ACHBIT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = match std::env::var("ACHBIT_PORT") {
        Ok(value) => achbit_host_connection::loopback_http::parse_port(&value),
        Err(std::env::VarError::NotPresent) => Ok(31245),
        Err(error) => Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, error)),
    }
    .unwrap_or_else(|error| {
        eprintln!("host_port_invalid: ACHBIT_PORT: {error}");
        std::process::exit(1);
    });
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
    assert!(
        addr.ip().is_loopback(),
        "Achbit 本地 daemon 只监听 loopback"
    );

    let mut gui_state = GuiState::open_in(&user_directories).expect("打开当前用户目录");
    achbit_host_connection::startup::timing("kernel.gui_state");
    let model_usage = Arc::new(
        model_usage::UsageStore::open(&gui_state.paths.usage_store_path).expect("打开用量索引"),
    );
    achbit_host_connection::startup::timing("kernel.usage");
    let session_store_path = gui_state.paths.session_store_path.clone();
    let tool_record_store_path = gui_state.paths.tool_record_store_path.clone();
    let user_settings = gui_state.user_settings.clone();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| panic!("无法绑定 Achbit 本地 daemon：{error}"));
    let addr = listener.local_addr().expect("读取 Host 监听地址");
    achbit_host_connection::startup::timing("kernel.listener");
    match service_plugins::sources(&user_settings) {
        Ok(sources) => gui_state
            .service_plugins
            .activate(&sources, &user_directories.data_dir),
        Err(error) => eprintln!("Service plugin settings invalid: {error}"),
    }
    let gui = Arc::new(Mutex::new(gui_state));
    let workspace_resolver = Arc::new(crate::local_agent_kernel::HostWorkspaceResolver::new(
        gui.clone(),
    ));
    configure_host_process_identity(addr).expect("初始化 Host 进程身份");
    let desktop = Arc::new(desktop_tools::DesktopHost::new(
        host_process_identity().instance_id.clone(),
        std::env::var(HOST_SHELL_TOKEN_ENV).expect("Host shell token"),
    ));
    achbit_host_connection::startup::timing("kernel.identity_desktop");
    let catalog_reader = local_agent_store::SessionCatalogReader::open(&session_store_path)
        .expect("打开 Session 目录读取器");
    achbit_host_connection::startup::timing("kernel.catalog_reader");
    let host_connection =
        HostConnection::from_environment().expect("初始化 Host Shell 本地连接凭证");
    let state = HostState {
        host_connection,
        gui,
        catalog_reader,
        execution: host_runtime::HostRuntime::default(),
        host_services: HostServices::new(),
        model_auth: Arc::new(model_auth::AuthService::default()),
        model_usage,
    };
    let execution = state.execution.clone();
    tokio::spawn(async move {
        let cleanup = execution.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut local_agent = LocalAgentRuntime::open(
                &session_store_path,
                &tool_record_store_path,
                workspace_resolver,
                &user_settings,
            )
            .map_err(|message| {
                let code = message
                    .split_once(": ")
                    .map(|(code, _)| code)
                    .unwrap_or("host_runtime_initialization_failed")
                    .to_string();
                SessionServiceError::new(code, message)
            })?;
            local_agent.kernel.desktop = desktop;
            let session_service = match SessionServiceProcess::spawn(
                &format!("http://{addr}"),
                local_agent.service_token(),
            ) {
                Ok(service) => service,
                Err(mut error) => {
                    if let Err(message) = local_agent.shutdown_plugins() {
                        cleanup.record_cleanup_failure();
                        error
                            .message
                            .push_str(&format!("; Kernel cleanup failed: {message}"));
                    }
                    return Err(error);
                }
            };
            Ok(host_runtime::ExecutionServices {
                local_agent,
                session_service,
            })
        })
        .await
        .unwrap_or_else(|error| {
            execution.record_cleanup_failure();
            Err(SessionServiceError::new(
                "host_runtime_initialization_failed",
                error.to_string(),
            ))
        });
        if let Err(error) = &result {
            eprintln!("{}: {}", error.code, error.message);
        }
        execution.publish(result);
        achbit_host_connection::startup::timing("kernel.execution_finished");
    });
    achbit_host_connection::startup::timing("kernel.execution_spawned");
    configure_host_lifetime().expect("初始化 Host 生命周期");
    let app = routes::build_app(state.clone());
    achbit_host_connection::startup::timing("kernel.routes");
    let lifetime_monitor = tokio::spawn(monitor_host_lifetime(state.clone()));
    // Host bootstrap publishes transport credentials while the config-root lease
    // is held. Shells attach to this instance; they never copy Session state.
    let _connection_publication = achbit_host_connection::LocalHostConnection::new(
        host_process_identity().clone(),
        std::env::var(HOST_SHELL_TOKEN_ENV).expect("Host shell token"),
    )
    .and_then(|connection| connection.publish(&user_directories.data_dir))
    .expect("发布共享 Host 本地连接");
    achbit_host_connection::startup::timing("kernel.published");
    println!("Achbit local Agent daemon listening on http://{addr}");
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_host_shutdown())
        .await;
    lifetime_monitor.abort();
    let cleanup_complete = shutdown_owned_host_resources(&state).await;
    assert!(cleanup_complete, "Achbit 本地资源未完整回收");
    if let Err(error) = result {
        panic!("Achbit 本地 daemon 运行失败：{error}");
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DaemonSecretProvider {
    values: HashMap<String, String>,
}

impl achbit_kernel_runtime::executors::SecretProvider for DaemonSecretProvider {
    fn resolve(&self, secret_ref: &str) -> Option<String> {
        let key = secret_ref
            .strip_prefix("local-secret:")
            .unwrap_or(secret_ref);
        self.values.get(key).cloned()
    }
}

pub(crate) fn runtime_tool_configuration(
    gui: &GuiState,
) -> Result<
    (
        achbit_kernel_runtime::executors::KernelExecutorConfig,
        DaemonSecretProvider,
    ),
    String,
> {
    let settings = &gui.user_settings;
    let setting = |key: &str| -> Result<&str, String> {
        match settings.get(key) {
            Some(Value::String(value)) => Ok(value),
            Some(_) => Err(format!("{key} 必须是字符串。")),
            None => Ok(""),
        }
    };
    let secret_store = match read_optional_json_file(&gui.paths.llm_secrets_path)? {
        Some(value) if llm_secret_store_is_current(&value) => value,
        Some(_) => return Err("本地 LLM secret 文件不是当前字符串映射格式。".to_string()),
        None => json!({}),
    };
    let secret_values: HashMap<String, String> = secret_store
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|secret| (key, secret.to_string())))
        .collect();
    Ok((
        achbit_kernel_runtime::executors::KernelExecutorConfig {
            temporary_root: Some(gui.paths.temporary_root.clone()),
            shell_cache_root: Some(gui.paths.directories.cache_dir.join("agent-shell")),
            web_search_endpoint_template: setting("agent.web.search.endpointTemplate")?.to_string(),
            web_search_auth_header_name: setting("agent.web.search.authHeaderName")?.to_string(),
            web_search_auth_secret_ref: setting("agent.web.search.authSecretRef")?.to_string(),
            ..Default::default()
        },
        DaemonSecretProvider {
            values: secret_values,
        },
    ))
}
