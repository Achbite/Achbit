use crate::local_agent_cli::CliClient;
use crate::local_agent_first_party_plugins::{
    self, FirstPartyPluginDescriptor, FirstPartyToolBinding, FirstPartyToolDescriptor,
    FirstPartyToolEffect,
};
use deepcode_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree_checked, OwnedHostProcess,
};
use deepcode_kernel_runtime::executors::{KernelCancellationToken, KernelToolExecutionContext};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_MCP_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_MCP_TOOLS: usize = 256;
const MAX_MCP_STDERR_BYTES: usize = 16 * 1024;
const MCP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone)]
pub(crate) struct McpPluginDescriptor {
    pub(crate) uri: String,
    pub(crate) name: String,
    pub(crate) short_description: String,
    pub(crate) activation_media_types: Vec<String>,
    pub(crate) implementation: Value,
    pub(crate) content: Arc<[u8]>,
    pub(crate) provider_ref: String,
    pub(crate) capability_refs: Vec<String>,
    pub(crate) capability_summary: String,
    pub(crate) tool_prompt_provider: Option<Value>,
    pub(crate) enabled: bool,
    pub(crate) error: Option<McpRuntimeError>,
    pub(crate) management: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpToolEffectScope {
    WorkspaceRead,
    Network,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum McpToolBindingRequirement {
    None,
    WorkspacePath { argument: String },
}

#[derive(Debug, Clone)]
pub(crate) struct McpRuntimeError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl McpRuntimeError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct McpTool {
    pub(crate) public_name: String,
    pub(crate) remote_name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    pub(crate) target: String,
    pub(crate) plugin_uri: String,
    pub(crate) plugin_instance_ref: String,
    pub(crate) provider_ref: String,
    pub(crate) contribution_ref: String,
    pub(crate) effect_scope: McpToolEffectScope,
    pub(crate) binding_requirement: McpToolBindingRequirement,
    instance: Arc<ToolInstance>,
}

#[derive(Debug)]
pub(crate) struct McpToolCallResult {
    pub(crate) output: Value,
    pub(crate) failure: Option<McpToolCallFailure>,
}

#[derive(Debug)]
pub(crate) struct McpToolCallFailure {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl McpTool {
    pub(crate) fn call(
        &self,
        mut input: Value,
        context: &KernelToolExecutionContext,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        if self.plugin_uri == "plugin://chrome-devtools@builtin" && self.remote_name == "new_page" {
            if let Some(arguments) = input.as_object_mut() {
                arguments.entry("background").or_insert(json!(true));
            }
        }
        let metadata = match &self.binding_requirement {
            McpToolBindingRequirement::None => None,
            McpToolBindingRequirement::WorkspacePath { .. } => {
                let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                    McpRuntimeError::new(
                        "mcp_workspace_binding_missing",
                        "First-party workspace tool 缺少 prepared workspace identity。",
                    )
                })?;
                Some(json!({
                    "deepcode": {
                        "workspaceId": workspace_id,
                        "resolvedWorkspaceTargets": context.private_resolved_targets,
                    }
                }))
            }
        };
        let mut result = match &self.instance.client {
            ToolClient::Mcp(client) => {
                client.call_tool(&self.remote_name, input, metadata, &context.cancellation)
            }
            ToolClient::Cli(client) => client.call(&self.remote_name, input, metadata, context),
        }?;
        if self.plugin_uri == "plugin://chrome-devtools@builtin" {
            if let Some(content) = result.output["content"].as_array_mut() {
                for block in content {
                    if block["type"] == "image" {
                        block["_meta"]["deepcode"]["purpose"] = json!("observation");
                    }
                }
            }
        }
        Ok(result)
    }

    pub(crate) fn logical_targets(&self, input: &Value) -> Result<Vec<String>, McpRuntimeError> {
        match &self.binding_requirement {
            McpToolBindingRequirement::None => Ok(Vec::new()),
            McpToolBindingRequirement::WorkspacePath { argument } => {
                let target = input
                    .get(argument)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        McpRuntimeError::new(
                            "mcp_workspace_target_invalid",
                            format!("Workspace tool requires logical path field {argument}."),
                        )
                    })?;
                Ok(vec![target.to_string()])
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct McpRuntime {
    tools: Arc<BTreeMap<String, McpTool>>,
    view: Arc<McpView>,
    // Frozen with the run, including before Chrome is activated in a later view.
    session_workdir: Option<PathBuf>,
}

pub(crate) fn session_workdir_for_run(
    catalog: &crate::conversation_catalog::ConversationCatalog,
    session_id: &str,
) -> Result<Option<PathBuf>, McpRuntimeError> {
    let Some(workspace) = catalog.workspaces.iter().find(|workspace| {
        workspace.session_workdir && workspace.owner_session_id.as_deref() == Some(session_id)
    }) else {
        return Ok(None);
    };
    let root = Path::new(&workspace.canonical_root)
        .canonicalize()
        .map_err(|error| {
            McpRuntimeError::new(
                "mcp_session_workdir_invalid",
                format!("无法解析当前会话私有目录：{error}"),
            )
        })?;
    if !root.is_dir() {
        return Err(McpRuntimeError::new(
            "mcp_session_workdir_invalid",
            "当前会话私有工作区不是目录。",
        ));
    }
    Ok(Some(root))
}

#[derive(Debug)]
struct ToolInstance {
    client: ToolClient,
    views: AtomicUsize,
}

#[derive(Default)]
struct McpView {
    instances: BTreeMap<String, Arc<ToolInstance>>,
    released: AtomicBool,
}

impl McpView {
    fn shutdown(&self) -> Result<(), McpRuntimeError> {
        if self.released.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let mut first_error = None;
        for instance in self.instances.values() {
            if instance.views.fetch_sub(1, Ordering::AcqRel) == 1 {
                if let Err(error) = instance.client.shutdown() {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for McpView {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            tools: Arc::new(BTreeMap::new()),
            view: Arc::new(McpView::default()),
            session_workdir: None,
        }
    }
}

impl McpRuntime {
    fn from_parts(
        tools: BTreeMap<String, McpTool>,
        instances: BTreeMap<String, Arc<ToolInstance>>,
        session_workdir: Option<PathBuf>,
    ) -> Self {
        for instance in instances.values() {
            instance.views.fetch_add(1, Ordering::Relaxed);
        }
        Self {
            tools: Arc::new(tools),
            view: Arc::new(McpView {
                instances,
                released: AtomicBool::new(false),
            }),
            session_workdir,
        }
    }
    /// Reuse unchanged instances and prepare selected replacements; old views stay pinned.
    pub(crate) fn extend_selected_sources(
        &self,
        sources: &[McpServerSource],
        selected: &BTreeMap<String, String>,
    ) -> Result<Self, McpRuntimeError> {
        let additions = selected
            .iter()
            .filter(|(_, instance)| !self.view.instances.contains_key(*instance))
            .map(|(uri, instance)| (uri.clone(), instance.clone()))
            .collect();
        let added = Self::from_selected_sources(sources, &additions, self.session_workdir.clone())?;
        let mut tools = self
            .tools
            .iter()
            .filter(|(_, tool)| selected.get(&tool.plugin_uri) == Some(&tool.plugin_instance_ref))
            .map(|(name, tool)| (name.clone(), tool.clone()))
            .collect::<BTreeMap<_, _>>();
        for (name, tool) in added.tools.iter() {
            if tools.insert(name.clone(), tool.clone()).is_some() {
                return Err(McpRuntimeError::new(
                    "plugin_tool_duplicate",
                    format!("工具名称重复：{name}"),
                ));
            }
        }
        let instances = self
            .view
            .instances
            .iter()
            .chain(added.view.instances.iter())
            .filter(|(id, _)| selected.values().any(|selected| selected == *id))
            .map(|(id, instance)| (id.clone(), Arc::clone(instance)))
            .collect();
        Ok(Self::from_parts(
            tools,
            instances,
            self.session_workdir.clone(),
        ))
    }

    pub(crate) fn from_selected_sources(
        sources: &[McpServerSource],
        selected_plugin_instances: &BTreeMap<String, String>,
        session_workdir: Option<PathBuf>,
    ) -> Result<Self, McpRuntimeError> {
        if selected_plugin_instances.is_empty() {
            return Ok(Self::from_parts(
                BTreeMap::new(),
                BTreeMap::new(),
                session_workdir,
            ));
        }
        let available = sources
            .iter()
            .filter(|server| server.setting.enabled)
            .map(|server| server.descriptor.uri.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(missing) = selected_plugin_instances
            .keys()
            .find(|uri| !available.contains(uri.as_str()))
        {
            return Err(McpRuntimeError::new(
                "plugin_selection_unavailable",
                format!("显式选择的 MCP-backed 插件不可用：{missing}"),
            ));
        }
        Self::from_servers(
            sources
                .iter()
                .filter(|server| {
                    server.setting.enabled
                        && selected_plugin_instances.contains_key(&server.descriptor.uri)
                })
                .cloned()
                .collect(),
            selected_plugin_instances,
            session_workdir,
        )
    }

    fn from_servers(
        servers: Vec<McpServerSource>,
        selected_plugin_instances: &BTreeMap<String, String>,
        session_workdir: Option<PathBuf>,
    ) -> Result<Self, McpRuntimeError> {
        let mut servers_by_id = BTreeMap::new();
        for server in servers {
            validate_server(&server.setting)?;
            let server_id = server.setting.id.clone();
            if servers_by_id.insert(server_id.clone(), server).is_some() {
                return Err(McpRuntimeError::new(
                    "mcp_server_duplicate",
                    format!("MCP Server id 重复：{server_id}"),
                ));
            }
        }
        let mut tools = BTreeMap::new();
        let mut instances = BTreeMap::new();
        for (_, server) in servers_by_id {
            let (client, definitions) = if server.setting.transport == "cli" {
                let (definitions, args) = match &server.contract {
                    McpServerContract::FirstParty(tools) => (
                        tools
                            .iter()
                            .map(|tool| RemoteToolDefinition {
                                name: tool.remote_name.clone(),
                                description: Some(tool.description.clone()),
                                input_schema: tool.input_schema.clone(),
                            })
                            .collect(),
                        split_args(&server.setting.args)?,
                    ),
                    McpServerContract::LocalCli { tools, args } => (tools.clone(), args.clone()),
                    McpServerContract::External => {
                        return Err(McpRuntimeError::new(
                            "cli_manifest_missing",
                            "CLI tools require a local manifest",
                        ))
                    }
                };
                (
                    ToolClient::Cli(CliClient {
                        command: server.setting.command.clone(),
                        args,
                        entry: server.cli_entry.clone(),
                    }),
                    definitions,
                )
            } else {
                let workspace = if server.descriptor.uri == "plugin://chrome-devtools@builtin" {
                    Some(session_workdir.as_deref().ok_or_else(|| {
                        McpRuntimeError::new(
                            "mcp_session_workdir_missing",
                            "Chrome 文件工具需要当前会话的私有工作目录。",
                        )
                    })?)
                } else {
                    None
                };
                let client = McpClient::start(&server.setting, workspace)?;
                let definitions = client.list_tools()?;
                (ToolClient::Mcp(client), definitions)
            };
            let plugin_instance_ref = selected_plugin_instances
                .get(&server.descriptor.uri)
                .expect("selected server has a plugin instance")
                .clone();
            let instance = Arc::new(ToolInstance {
                client,
                views: AtomicUsize::new(0),
            });
            for definition in definitions {
                let mut contract = tool_contract(&server, &definition)?;
                if server.descriptor.uri == "plugin://chrome-devtools@builtin"
                    && definition.name == "new_page"
                {
                    contract.input_schema["properties"]["background"]["description"] =
                        json!("Open in the background by default. Set false explicitly to bring the page forward.");
                }
                let public_name = contract.public_name;
                let tool = McpTool {
                    public_name: public_name.clone(),
                    remote_name: definition.name.clone(),
                    description: contract.description,
                    input_schema: contract.input_schema,
                    target: contract
                        .logical_target
                        .unwrap_or_else(|| format!("{}: {}", server.setting.name, definition.name)),
                    plugin_uri: server.descriptor.uri.clone(),
                    plugin_instance_ref: plugin_instance_ref.clone(),
                    provider_ref: contract.provider_ref,
                    contribution_ref: contract.contribution_ref,
                    effect_scope: contract.effect_scope,
                    binding_requirement: contract.binding_requirement,
                    instance: Arc::clone(&instance),
                };
                if tools.insert(public_name.clone(), tool).is_some() {
                    return Err(McpRuntimeError::new(
                        "mcp_tool_duplicate",
                        format!("MCP 工具名称重复：{public_name}"),
                    ));
                }
                if tools.len() > MAX_MCP_TOOLS {
                    return Err(McpRuntimeError::new(
                        "mcp_tool_limit_exceeded",
                        format!("MCP 工具数量超过首版上限 {MAX_MCP_TOOLS}"),
                    ));
                }
            }
            instances.insert(plugin_instance_ref, instance);
        }
        Ok(Self::from_parts(tools, instances, session_workdir))
    }

    pub(crate) fn tools(&self) -> impl Iterator<Item = &McpTool> {
        self.tools.values()
    }

    pub(crate) fn shutdown(&self) -> Result<(), McpRuntimeError> {
        self.view.shutdown()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct McpServerSource {
    setting: McpServerSetting,
    pub(crate) descriptor: McpPluginDescriptor,
    contract: McpServerContract,
    cli_entry: Option<(String, Vec<u8>)>,
}

#[derive(Debug, Clone)]
enum McpServerContract {
    External,
    LocalCli {
        tools: Vec<RemoteToolDefinition>,
        args: Vec<String>,
    },
    FirstParty(Vec<FirstPartyToolDescriptor>),
}

struct McpToolContract {
    public_name: String,
    description: String,
    input_schema: Value,
    provider_ref: String,
    contribution_ref: String,
    effect_scope: McpToolEffectScope,
    logical_target: Option<String>,
    binding_requirement: McpToolBindingRequirement,
}

pub(crate) fn available_server_sources(
    settings: &Value,
) -> Result<Vec<McpServerSource>, McpRuntimeError> {
    let mut sources = configured_servers(settings)?
        .into_iter()
        .map(external_server_source)
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(target_os = "macos")]
    sources.push(chrome_devtools_source(settings)?);
    let provider_binary = local_agent_first_party_plugins::provider_binary()
        .map_err(|message| McpRuntimeError::new("first_party_provider_unavailable", message))?;
    let provider_binary = provider_binary.to_str().ok_or_else(|| {
        McpRuntimeError::new(
            "first_party_provider_unavailable",
            "First-party provider 路径不是 UTF-8。",
        )
    })?;
    for descriptor in local_agent_first_party_plugins::descriptors()
        .map_err(|message| McpRuntimeError::new("first_party_manifest_invalid", message))?
    {
        let mut source = first_party_server_source(descriptor, provider_binary);
        let disabled: Vec<String> = serde_json::from_str(
            settings
                .get("plugins.disabled")
                .and_then(Value::as_str)
                .unwrap_or("[]"),
        )
        .map_err(|error| McpRuntimeError::new("plugin_config_invalid", error.to_string()))?;
        source.setting.enabled = !disabled.contains(&source.descriptor.uri);
        source.descriptor.enabled = source.setting.enabled;
        sources.push(source);
    }
    let local: Vec<LocalPluginSource> = serde_json::from_str(
        settings
            .get("plugins.sources")
            .and_then(Value::as_str)
            .unwrap_or("[]"),
    )
    .map_err(|error| McpRuntimeError::new("plugin_config_invalid", error.to_string()))?;
    for source in local {
        sources.push(local_cli_source(source));
    }
    let mut ids = BTreeSet::new();
    let mut uris = BTreeSet::new();
    for source in &mut sources {
        if source.setting.enabled && source.descriptor.error.is_none() {
            source.descriptor.error = validate_server(&source.setting)
                .and_then(|()| split_args(&source.setting.args).map(|_| ()))
                .err();
        }
        if !ids.insert(source.setting.id.clone()) {
            return Err(McpRuntimeError::new(
                "mcp_server_duplicate",
                format!("MCP Server id 重复：{}", source.setting.id),
            ));
        }
        if !uris.insert(source.descriptor.uri.clone()) {
            return Err(McpRuntimeError::new(
                "plugin_uri_duplicate",
                format!("MCP-backed plugin URI 重复：{}", source.descriptor.uri),
            ));
        }
    }
    Ok(sources)
}

fn external_server_source(setting: McpServerSetting) -> Result<McpServerSource, McpRuntimeError> {
    let identity = json!({
        "id": setting.id,
        "name": setting.name,
        "description": setting.description,
        "transport": setting.transport,
        "command": setting.command,
        "args": setting.args,
    });
    let descriptor = McpPluginDescriptor {
        management: json!({"key":"mcp.servers","id":setting.id}),
        uri: mcp_plugin_uri(&setting.id),
        name: setting.name.clone(),
        short_description: if setting.description.trim().is_empty() {
            "连接的外部工具".into()
        } else {
            setting.description.clone()
        },
        activation_media_types: Vec::new(),
        implementation: identity,
        content: Arc::from([]),
        provider_ref: "tool-provider:mcp".to_string(),
        capability_refs: vec![format!("mcp-server:{}", setting.id)],
        capability_summary: format!(
            "{}\nIts callable tools are supplied by the current tool catalog after activation.",
            if setting.description.trim().is_empty() {
                "No capability description was provided at registration."
            } else {
                &setting.description
            }
        ),
        tool_prompt_provider: None,
        enabled: setting.enabled,
        error: None,
    };
    Ok(McpServerSource {
        setting,
        descriptor,
        contract: McpServerContract::External,
        cli_entry: None,
    })
}

/// The official MCP runs as an ordinary Kernel-owned tool plugin. Desktop
/// capture and page debugging retain separate platform and target identities.
#[cfg(target_os = "macos")]
fn chrome_devtools_source(settings: &Value) -> Result<McpServerSource, McpRuntimeError> {
    let executable = std::env::current_exe()
        .map_err(|e| McpRuntimeError::new("chrome_runtime_unavailable", e.to_string()))?;
    let root = deepcode_host_connection::runtime_root(executable.parent().ok_or_else(|| {
        McpRuntimeError::new(
            "chrome_runtime_unavailable",
            "Runtime executable has no directory",
        )
    })?)
    .map_err(|e| McpRuntimeError::new("chrome_runtime_unavailable", e.to_string()))?;
    let entry = root.join("chrome-devtools/build/src/bin/chrome-devtools-mcp.js");
    let node = root.join("node/bin/node");
    let disabled: Vec<String> = serde_json::from_str(
        settings
            .get("plugins.disabled")
            .and_then(Value::as_str)
            .unwrap_or("[]"),
    )
    .map_err(|e| McpRuntimeError::new("plugin_config_invalid", e.to_string()))?;
    let uri = "plugin://chrome-devtools@builtin";
    // split_args parses quotes without invoking a shell.
    let quoted_entry = format!(
        "\"{}\"",
        entry
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    );
    let mut source = external_server_source(McpServerSetting {
        id: "deepcode-chrome".into(), name: "Chrome".into(),
        description: "Control existing Chrome browser pages and tabs by pageId: inspect, click, fill, navigate and capture screenshots. 浏览器 Chrome 页面和标签页控制。".into(),
        transport: "stdio".into(), command: node.to_string_lossy().into(),
        args: format!("{quoted_entry} --autoConnect --experimental-structured-content --no-usage-statistics --no-performance-crux"),
        enabled: !disabled.iter().any(|disabled| disabled == uri),
    })?;
    source.descriptor.uri = uri.into();
    source.descriptor.management = json!({"key":"plugins.disabled","id":uri});
    source.descriptor.capability_summary.push_str("\nEvery page operation names its returned pageId. New pages stay in the background by default; bringing a page forward is explicit. Chrome itself requests connection approval. A stopped connection is an execution result, not an instruction to use desktop input instead.");
    if !entry.is_file() {
        source.descriptor.error = Some(McpRuntimeError::new(
            "chrome_runtime_unavailable",
            "This runtime does not contain Chrome DevTools MCP.",
        ));
    }
    Ok(source)
}

fn first_party_server_source(
    plugin: FirstPartyPluginDescriptor,
    provider_binary: &str,
) -> McpServerSource {
    let FirstPartyPluginDescriptor {
        id,
        uri,
        display_name,
        short_description,
        activation_media_types,
        provider_ref,
        implementation,
        capability_refs,
        capability_summary,
        tools,
    } = plugin;
    let prompt_contributions = tools
        .iter()
        .map(|tool| {
            json!({
                "contributionRef": tool.prompt_contribution.contribution_ref,
                "canonicalToolName": tool.canonical_name,
                "promptSnippet": tool.prompt_contribution.prompt_snippet,
                "usageGuidelines": tool.prompt_contribution.usage_guidelines,
            })
        })
        .collect::<Vec<_>>();
    let descriptor = McpPluginDescriptor {
        management: json!({"key":"plugins.disabled","id":uri}),
        uri: uri.clone(),
        name: display_name.clone(),
        short_description,
        activation_media_types,
        implementation: json!({"manifest": implementation, "command": provider_binary}),
        content: Arc::from([]),
        provider_ref,
        capability_refs,
        capability_summary,
        tool_prompt_provider: Some(json!({
            "providerRef": format!("tool-prompt-provider:first-party:{id}"),
            "origin": "extension",
            "pluginUri": uri,
            "contributions": prompt_contributions,
        })),
        enabled: true,
        error: None,
    };
    McpServerSource {
        setting: McpServerSetting {
            id: format!("first-party.{id}"),
            name: display_name,
            description: descriptor.short_description.clone(),
            transport: "cli".to_string(),
            command: provider_binary.to_string(),
            args: format!("--plugin {id} --call"),
            enabled: true,
        },
        descriptor,
        contract: McpServerContract::FirstParty(tools),
        cli_entry: None,
    }
}

fn tool_contract(
    server: &McpServerSource,
    definition: &RemoteToolDefinition,
) -> Result<McpToolContract, McpRuntimeError> {
    match &server.contract {
        McpServerContract::External | McpServerContract::LocalCli { .. } => Ok(McpToolContract {
            public_name: if server.setting.transport == "cli" {
                format!("{}.{}", server.setting.id, definition.name)
            } else {
                public_tool_name(&server.setting.id, &definition.name)?
            },
            description: definition
                .description
                .clone()
                .unwrap_or_else(|| format!("MCP tool {}", definition.name)),
            input_schema: definition.input_schema.clone(),
            provider_ref: server.descriptor.provider_ref.clone(),
            contribution_ref: format!(
                "tool-contribution:mcp:{}",
                public_tool_name(&server.setting.id, &definition.name)?
            ),
            effect_scope: McpToolEffectScope::External,
            logical_target: None,
            binding_requirement: McpToolBindingRequirement::None,
        }),
        McpServerContract::FirstParty(tools) => {
            let tool = tools
                .iter()
                .find(|tool| tool.remote_name == definition.name)
                .expect("validated first-party tool set");
            Ok(McpToolContract {
                public_name: tool.canonical_name.clone(),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
                provider_ref: server.descriptor.provider_ref.clone(),
                contribution_ref: tool.tool_contribution_ref.clone(),
                effect_scope: match tool.effect {
                    FirstPartyToolEffect::NetworkRead => McpToolEffectScope::Network,
                    FirstPartyToolEffect::WorkspaceRead => McpToolEffectScope::WorkspaceRead,
                },
                logical_target: tool.logical_target.clone(),
                binding_requirement: match &tool.binding {
                    FirstPartyToolBinding::None => McpToolBindingRequirement::None,
                    FirstPartyToolBinding::WorkspacePath { argument } => {
                        McpToolBindingRequirement::WorkspacePath {
                            argument: argument.clone(),
                        }
                    }
                },
            })
        }
    }
}

fn mcp_plugin_uri(server_id: &str) -> String {
    let slug = server_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    format!(
        "plugin://{}@mcp",
        if slug.is_empty() { "plugin" } else { slug }
    )
}

fn configured_servers(settings: &Value) -> Result<Vec<McpServerSetting>, McpRuntimeError> {
    let encoded = settings
        .get("mcp.servers")
        .and_then(Value::as_str)
        .unwrap_or("[]");
    serde_json::from_str(encoded).map_err(|error| {
        McpRuntimeError::new(
            "mcp_config_invalid",
            format!("解析 mcp.servers 失败：{error}"),
        )
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerSetting {
    id: String,
    #[serde(default = "default_server_name")]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_transport")]
    transport: String,
    command: String,
    #[serde(default)]
    args: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteToolDefinition {
    name: String,
    description: Option<String>,
    #[serde(default = "default_input_schema")]
    input_schema: Value,
}

#[derive(Clone, Debug)]
enum ToolClient {
    Mcp(McpClient),
    Cli(CliClient),
}
impl ToolClient {
    fn shutdown(&self) -> Result<(), McpRuntimeError> {
        match self {
            Self::Mcp(client) => client.shutdown(),
            Self::Cli(_) => Ok(()),
        }
    }
}

#[derive(Deserialize)]
struct LocalPluginSource {
    id: String,
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}
#[derive(Deserialize)]
struct LocalCliManifest {
    id: String,
    name: String,
    description: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    entry: String,
    tools: Vec<RemoteToolDefinition>,
}
fn local_cli_source(source: LocalPluginSource) -> McpServerSource {
    let mut result = McpServerSource {
        setting: McpServerSetting {
            id: source.id.clone(),
            name: source.id.clone(),
            description: String::new(),
            transport: "cli".into(),
            command: String::new(),
            args: String::new(),
            enabled: source.enabled,
        },
        descriptor: McpPluginDescriptor {
            management: json!({"key":"plugins.sources","id":source.id,"path":source.path}),
            uri: format!("plugin://{}@cli", source.id),
            name: source.id.clone(),
            short_description: "本地工具".into(),
            activation_media_types: vec![],
            implementation: Value::Null,
            content: Arc::from([]),
            provider_ref: format!("tool-provider:cli:{}", source.id),
            capability_refs: vec![],
            capability_summary: String::new(),
            tool_prompt_provider: None,
            enabled: source.enabled,
            error: None,
        },
        contract: McpServerContract::LocalCli {
            tools: vec![],
            args: vec![],
        },
        cli_entry: None,
    };
    let loaded = (|| -> Result<(), String> {
        let root = std::path::Path::new(&source.path);
        if !root.is_absolute() {
            return Err("插件目录必须是绝对路径".into());
        }
        let encoded = std::fs::read(root.join("deepcode-tool.json"))
            .map_err(|error| format!("{}: {error}", root.display()))?;
        let manifest: LocalCliManifest =
            serde_json::from_slice(&encoded).map_err(|error| error.to_string())?;
        if manifest.id != source.id
            || manifest.id.is_empty()
            || normalized_name(&manifest.id) != manifest.id
            || manifest.name.trim().is_empty()
            || manifest.description.trim().is_empty()
            || manifest.tools.is_empty()
            || manifest.command.trim().is_empty()
        {
            return Err("插件需要有效的 id、name、description、command 和 tools".into());
        }
        let entry = std::path::Path::new(&manifest.entry);
        if entry.components().count() != 1
            || !matches!(
                entry.components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err("CLI entry 必须是插件目录中的单文件构建产物".into());
        }
        let bytes = std::fs::read(root.join(entry)).map_err(|error| error.to_string())?;
        if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
            return Err("CLI entry 必须是非空且不超过 4 MiB 的文件".into());
        }
        let mut names = BTreeSet::new();
        for tool in &manifest.tools {
            if tool.name.is_empty()
                || normalized_name(&tool.name) != tool.name
                || !names.insert(&tool.name)
                || !tool.input_schema.is_object()
                || tool.description.as_deref().is_none_or(str::is_empty)
            {
                return Err("工具需要唯一名称、用途和 inputSchema".into());
            }
        }
        result.descriptor.implementation =
            serde_json::from_slice(&encoded).map_err(|error| error.to_string())?;
        result.descriptor.content = Arc::from(bytes.as_slice());
        result.descriptor.name = manifest.name.clone();
        result.descriptor.short_description = manifest.description.clone();
        result.descriptor.capability_summary = format!(
            "{}\nTools:\n{}",
            manifest.description,
            manifest
                .tools
                .iter()
                .map(|tool| format!(
                    "- {}: {}",
                    tool.name,
                    tool.description
                        .as_deref()
                        .expect("validated tool description")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
        result.descriptor.capability_refs = manifest
            .tools
            .iter()
            .map(|tool| format!("{}.{}", source.id, tool.name))
            .collect();
        result.setting.name = manifest.name;
        result.setting.description = manifest.description;
        result.setting.command = manifest.command;
        result.cli_entry = Some((manifest.entry, bytes));
        result.contract = McpServerContract::LocalCli {
            tools: manifest.tools,
            args: manifest.args,
        };
        Ok(())
    })();
    if let Err(message) = loaded {
        result.descriptor.error = Some(McpRuntimeError::new("local_plugin_unavailable", message));
    }
    result
}

#[derive(Clone, Debug)]
struct McpClient {
    server_id: Arc<str>,
    process: Arc<Mutex<OwnedMcpProcess>>,
}

impl McpClient {
    fn start(server: &McpServerSetting, workspace: Option<&Path>) -> Result<Self, McpRuntimeError> {
        let args = split_args(&server.args)?;
        let mut command = Command::new(&server.command);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(workspace) = workspace {
            command
                .arg("--workspace")
                .arg(workspace)
                .current_dir(workspace);
        }
        let child = spawn_owned_host_process(&mut command).map_err(|error| {
            McpRuntimeError::new(
                "mcp_server_spawn_failed",
                format!("启动 MCP Server {} 失败：{error}", server.id),
            )
        })?;
        let mut starting = ChildStartupGuard::new(child);
        let stdin = starting.child_mut().stdin.take().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_pipe_failed", "MCP Server 缺少标准输入管道。")
        })?;
        let stdout = starting.child_mut().stdout.take().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_pipe_failed", "MCP Server 缺少标准输出管道。")
        })?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let stdout_reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader) {
                    Ok(None) => break,
                    Ok(Some(frame)) => {
                        if sender.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr_receipt = Arc::new(Mutex::new(Vec::new()));
        let stderr_reader = starting.child_mut().stderr.take().map(|mut stderr| {
            let receipt = Arc::clone(&stderr_receipt);
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 4096];
                loop {
                    let read = stderr.read(&mut buffer);
                    let mut tail = receipt.lock().expect("MCP stderr receipt lock");
                    match read {
                        Ok(0) => break,
                        Ok(read) => tail.extend_from_slice(&buffer[..read]),
                        Err(ref error) => {
                            tail.extend_from_slice(
                                format!("\nMCP stderr read failed: {error}").as_bytes(),
                            );
                        }
                    }
                    if tail.len() > MAX_MCP_STDERR_BYTES {
                        let remove = tail.len() - MAX_MCP_STDERR_BYTES;
                        tail.drain(..remove);
                    }
                    if read.is_err() {
                        break;
                    }
                }
            })
        });
        let (writes, pending_writes) = mpsc::channel::<McpWrite>();
        let stdin_writer = std::thread::spawn(move || {
            let mut stdin = BufWriter::new(stdin);
            for write in pending_writes {
                let result = stdin
                    .write_all(&write.bytes)
                    .and_then(|()| stdin.flush())
                    .map_err(|error| error.to_string());
                let failed = result.is_err();
                let _ = write.complete.send(result);
                if failed {
                    break;
                }
            }
        });
        let child = starting.commit();
        let client = Self {
            server_id: Arc::from(server.id.as_str()),
            process: Arc::new(Mutex::new(OwnedMcpProcess {
                owned: child,
                writes: Some(writes),
                responses: Some(receiver),
                stdin_writer: Some(stdin_writer),
                stdout_reader: Some(stdout_reader),
                stderr_reader,
                stderr_receipt,
                next_id: 1,
                stopped: false,
                stop_error: None,
            })),
        };
        client.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "DeepCode", "version": env!("CARGO_PKG_VERSION") },
            }),
            None,
        )?;
        client.notify("notifications/initialized", json!({}))?;
        Ok(client)
    }

    fn list_tools(&self) -> Result<Vec<RemoteToolDefinition>, McpRuntimeError> {
        let mut cursor: Option<String> = None;
        let mut seen_cursors = BTreeSet::new();
        let mut tools = Vec::new();
        loop {
            let result = self.request(
                "tools/list",
                cursor
                    .as_ref()
                    .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor })),
                None,
            )?;
            let page = result.get("tools").cloned().ok_or_else(|| {
                McpRuntimeError::new("mcp_tools_invalid", "MCP tools/list 缺少 tools。")
            })?;
            let mut decoded: Vec<RemoteToolDefinition> =
                serde_json::from_value(page).map_err(|error| {
                    McpRuntimeError::new(
                        "mcp_tools_invalid",
                        format!("MCP tools/list 返回无效：{error}"),
                    )
                })?;
            if decoded
                .iter()
                .any(|tool| tool.name.is_empty() || !tool.input_schema.is_object())
            {
                return Err(McpRuntimeError::new(
                    "mcp_tools_invalid",
                    "MCP 工具名称或 inputSchema 无效。",
                ));
            }
            tools.append(&mut decoded);
            if tools.len() > MAX_MCP_TOOLS {
                return Err(McpRuntimeError::new(
                    "mcp_tool_limit_exceeded",
                    format!("MCP 工具数量超过首版上限 {MAX_MCP_TOOLS}"),
                ));
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            match cursor.as_ref() {
                None => return Ok(tools),
                Some(next) if !seen_cursors.insert(next.clone()) => {
                    return Err(McpRuntimeError::new(
                        "mcp_tools_invalid",
                        "MCP tools/list returned a repeated pagination cursor.",
                    ));
                }
                Some(_) => {}
            }
        }
    }

    fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        metadata: Option<Value>,
        cancellation: &KernelCancellationToken,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        let mut params = json!({ "name": name, "arguments": arguments });
        if let Some(metadata) = metadata {
            params["_meta"] = metadata;
        }
        let result = self.request("tools/call", params, Some(cancellation))?;
        decode_tool_call_result(name, result)
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        cancellation: Option<&KernelCancellationToken>,
    ) -> Result<Value, McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.request(&self.server_id, method, params, cancellation)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.write_message(
            &json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }),
            None,
            Instant::now() + MCP_RESPONSE_TIMEOUT,
        )
    }

    fn shutdown(&self) -> Result<(), McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.stop()
    }
}

fn decode_tool_call_result(
    name: &str,
    output: Value,
) -> Result<McpToolCallResult, McpRuntimeError> {
    let is_error = match output.get("isError") {
        None => false,
        Some(value) => value.as_bool().ok_or_else(|| {
            McpRuntimeError::new(
                "mcp_response_invalid",
                format!("MCP 工具 {name} 的 isError 不是布尔值。"),
            )
        })?,
    };
    let failure = is_error.then(|| {
        let provider_error = output
            .pointer("/structuredContent/error")
            .and_then(Value::as_object);
        McpToolCallFailure {
            code: provider_error
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .filter(|code| !code.is_empty())
                .unwrap_or("mcp_tool_failed")
                .to_string(),
            message: provider_error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    // Image bytes belong to the artifact archive, never to diagnostic text.
                    if !output["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|block| block["type"] == "image")
                    {
                        return format!("MCP 工具 {name} 返回错误：{output}");
                    }
                    let text = output["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|block| block["type"] == "text")
                        .filter_map(|block| block["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if text.is_empty() {
                        format!("MCP 工具 {name} 返回错误，详见工具结果。")
                    } else {
                        format!("MCP 工具 {name} 返回错误：{text}")
                    }
                }),
        }
    });
    Ok(McpToolCallResult { output, failure })
}

struct ChildStartupGuard {
    child: Option<OwnedHostProcess>,
}

impl ChildStartupGuard {
    fn new(child: OwnedHostProcess) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self
            .child
            .as_mut()
            .expect("starting child is present")
            .child
    }

    fn commit(mut self) -> OwnedHostProcess {
        self.child.take().expect("starting child is present")
    }
}

impl Drop for ChildStartupGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Err(error) = terminate_owned_process_tree_checked(child) {
                eprintln!("MCP startup cleanup failed: {error}");
            }
        }
    }
}

struct McpWrite {
    bytes: Vec<u8>,
    complete: mpsc::Sender<Result<(), String>>,
}

struct OwnedMcpProcess {
    owned: OwnedHostProcess,
    writes: Option<mpsc::Sender<McpWrite>>,
    responses: Option<Receiver<Result<Vec<u8>, String>>>,
    stdin_writer: Option<JoinHandle<()>>,
    stdout_reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_receipt: Arc<Mutex<Vec<u8>>>,
    next_id: u64,
    stopped: bool,
    stop_error: Option<McpRuntimeError>,
}

impl std::fmt::Debug for OwnedMcpProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OwnedMcpProcess")
    }
}

impl OwnedMcpProcess {
    fn request(
        &mut self,
        server_id: &str,
        method: &str,
        params: Value,
        cancellation: Option<&KernelCancellationToken>,
    ) -> Result<Value, McpRuntimeError> {
        if self.stopped {
            return Err(McpRuntimeError::new(
                "mcp_server_stopped",
                format!("MCP Server {server_id} 已停止。"),
            ));
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let deadline = Instant::now() + MCP_RESPONSE_TIMEOUT;
        self.write_message(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }),
            cancellation,
            deadline,
        )?;
        loop {
            if cancellation.is_some_and(KernelCancellationToken::is_cancelled) {
                return Err(self.stop_after_error(McpRuntimeError::new(
                    "mcp_tool_cancelled",
                    format!("MCP Server {server_id} request was cancelled and reclaimed."),
                )));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(self.stop_after_error(McpRuntimeError::new(
                    "mcp_server_timeout",
                    format!("MCP Server {server_id} 请求超时。"),
                )));
            }
            let frame = match self
                .responses
                .as_ref()
                .expect("running MCP process has a response receiver")
                .recv_timeout(remaining.min(MCP_CANCEL_POLL_INTERVAL))
            {
                Ok(Ok(frame)) => frame,
                Ok(Err(error)) => {
                    return Err(self.stop_after_error(McpRuntimeError::new(
                        "mcp_server_read_failed",
                        format!("读取 MCP Server {server_id} 失败：{error}"),
                    )))
                }
                Err(RecvTimeoutError::Timeout) => {
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.stop_after_error(McpRuntimeError::new(
                        "mcp_server_ended",
                        format!("MCP Server {server_id} 已退出。"),
                    )))
                }
            };
            let value =
                decode_frame(server_id, frame).map_err(|error| self.stop_after_error(error))?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(McpRuntimeError::new(
                    "mcp_request_failed",
                    format!("MCP Server {server_id} 拒绝 {method}：{error}"),
                ));
            }
            return value.get("result").cloned().ok_or_else(|| {
                McpRuntimeError::new(
                    "mcp_response_invalid",
                    format!("MCP Server {server_id} 回复缺少 result。"),
                )
            });
        }
    }

    fn write_message(
        &mut self,
        value: &Value,
        cancellation: Option<&KernelCancellationToken>,
        deadline: Instant,
    ) -> Result<(), McpRuntimeError> {
        if self.stopped {
            return Err(McpRuntimeError::new(
                "mcp_server_stopped",
                "MCP Server 已停止。",
            ));
        }
        let mut encoded = serde_json::to_vec(value).map_err(|error| {
            McpRuntimeError::new(
                "mcp_request_encode_failed",
                format!("编码 MCP 请求失败：{error}"),
            )
        })?;
        if encoded.len() > MAX_MCP_FRAME_BYTES {
            return Err(McpRuntimeError::new(
                "mcp_request_too_large",
                "MCP 请求超过本地 transport 上限。",
            ));
        }
        encoded.push(b'\n');
        let writes = self.writes.as_ref().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_stopped", "MCP Server 输入已经关闭。")
        })?;
        let (complete, result) = mpsc::channel();
        if writes
            .send(McpWrite {
                bytes: encoded,
                complete,
            })
            .is_err()
        {
            return Err(self.stop_after_error(McpRuntimeError::new(
                "mcp_server_write_failed",
                "MCP stdin writer has stopped.",
            )));
        }
        loop {
            if cancellation.is_some_and(KernelCancellationToken::is_cancelled) {
                return Err(self.stop_after_error(McpRuntimeError::new(
                    "mcp_tool_cancelled",
                    "MCP request was cancelled during write.",
                )));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(self.stop_after_error(McpRuntimeError::new(
                    "mcp_server_timeout",
                    "MCP request timed out during write.",
                )));
            }
            match result.recv_timeout(remaining.min(MCP_CANCEL_POLL_INTERVAL)) {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => {
                    return Err(self.stop_after_error(McpRuntimeError::new(
                        "mcp_server_write_failed",
                        format!("写入 MCP Server 失败：{error}"),
                    )))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.stop_after_error(McpRuntimeError::new(
                        "mcp_server_write_failed",
                        "MCP stdin writer ended before reporting its result.",
                    )))
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn stop_after_error(&mut self, mut error: McpRuntimeError) -> McpRuntimeError {
        if let Err(cleanup) = self.stop() {
            error.message.push_str(&format!(
                "; cleanup failed: {}: {}",
                cleanup.code, cleanup.message
            ));
        }
        match self.owned.child.try_wait() {
            Ok(Some(status)) => error.message.push_str(&format!("; MCP process {status}")),
            Ok(None) => {}
            Err(wait_error) => error
                .message
                .push_str(&format!("; MCP process status failed: {wait_error}")),
        }
        match self.stderr_receipt.lock() {
            Ok(tail) if !tail.is_empty() => error.message.push_str(&format!(
                "; MCP stderr (last {MAX_MCP_STDERR_BYTES} bytes): {}",
                String::from_utf8_lossy(&tail).trim()
            )),
            Ok(_) => {}
            Err(lock_error) => error
                .message
                .push_str(&format!("; MCP stderr receipt failed: {lock_error}")),
        }
        error
    }

    fn stop(&mut self) -> Result<(), McpRuntimeError> {
        if self.stopped {
            return self.stop_error.clone().map_or(Ok(()), Err);
        }
        self.writes.take();
        self.responses.take();
        if let Err(error) = terminate_owned_process_tree_checked(&mut self.owned) {
            let error = McpRuntimeError::new(
                "mcp_server_stop_failed",
                format!("回收 MCP Server process tree 失败：{error}"),
            );
            self.stop_error = Some(error.clone());
            return Err(error);
        }
        let mut first_error = None;
        for (stream, reader) in [
            ("stdin", self.stdin_writer.take()),
            ("stdout", self.stdout_reader.take()),
            ("stderr", self.stderr_reader.take()),
        ] {
            if reader.is_some_and(|reader| reader.join().is_err()) {
                first_error.get_or_insert_with(|| {
                    McpRuntimeError::new(
                        "mcp_server_reader_join_failed",
                        format!("回收 MCP Server {stream} reader 失败。"),
                    )
                });
            }
        }
        self.stopped = true;
        self.stop_error = first_error.clone();
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for OwnedMcpProcess {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!(
                "MCP process cleanup failed: {}: {}",
                error.code, error.message
            );
        }
    }
}

fn validate_server(server: &McpServerSetting) -> Result<(), McpRuntimeError> {
    if server.id.is_empty() || server.id.len() > 80 || server.id.chars().any(char::is_control) {
        return Err(McpRuntimeError::new(
            "mcp_server_identity_invalid",
            "MCP Server id 无效。",
        ));
    }
    if !matches!(server.transport.as_str(), "stdio" | "cli") {
        return Err(McpRuntimeError::new(
            "mcp_transport_unsupported",
            format!("首版本地 MCP 仅支持 stdio：{}", server.id),
        ));
    }
    if server.command.trim().is_empty() {
        return Err(McpRuntimeError::new(
            "mcp_server_command_missing",
            format!("MCP Server {} 缺少 command。", server.id),
        ));
    }
    let command = std::path::Path::new(&server.command);
    if command.is_absolute() && !command.is_file() {
        return Err(McpRuntimeError::new(
            "mcp_server_command_unavailable",
            format!(
                "MCP Server {} 启动命令不存在：{}",
                server.id, server.command
            ),
        ));
    }
    Ok(())
}

fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    let count = reader
        .take((MAX_MCP_FRAME_BYTES + 2) as u64)
        .read_until(b'\n', &mut frame)?;
    if count == 0 {
        return Ok(None);
    }
    if frame.len() > MAX_MCP_FRAME_BYTES + 1 || frame.last() != Some(&b'\n') {
        return Err(std::io::Error::other(
            "MCP response exceeds the frame limit or lacks its final newline",
        ));
    }
    frame.pop();
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    Ok(Some(frame))
}

fn decode_frame(server_id: &str, frame: Vec<u8>) -> Result<Value, McpRuntimeError> {
    let value: Value = serde_json::from_slice(&frame).map_err(|error| {
        McpRuntimeError::new(
            "mcp_response_json_invalid",
            format!("MCP Server {server_id} 回复不是 JSON：{error}"),
        )
    })?;
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(McpRuntimeError::new(
            "mcp_response_invalid",
            format!("MCP Server {server_id} 回复缺少 JSON-RPC 版本。"),
        ));
    }
    Ok(value)
}

fn public_tool_name(server_id: &str, remote_name: &str) -> Result<String, McpRuntimeError> {
    let server = normalized_name(server_id);
    let remote = normalized_name(remote_name);
    let name = format!("mcp.{server}.{remote}");
    if remote.is_empty() || name.len() > 128 {
        return Err(McpRuntimeError::new(
            "mcp_tool_name_invalid",
            format!("MCP 工具名称无法映射：{remote_name}"),
        ));
    }
    Ok(name)
}

fn normalized_name(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                Some(character)
            } else if character == '/' || character.is_whitespace() {
                Some('_')
            } else {
                None
            }
        })
        .collect()
}

fn split_args(value: &str) -> Result<Vec<String>, McpRuntimeError> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped || quote.is_some() {
        return Err(McpRuntimeError::new(
            "mcp_server_args_invalid",
            "MCP Server args 中的引号或转义未闭合。",
        ));
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn default_input_schema() -> Value {
    json!({ "type": "object" })
}

fn default_server_name() -> String {
    "MCP Server".to_string()
}

fn default_transport() -> String {
    "stdio".to_string()
}

const fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(std::path::PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = crate::utils::new_runtime_ref("mcp-io-test").unwrap();
            let path = std::env::temp_dir().join(id.replace(':', "-"));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn server(&self, behavior: &str) -> McpClient {
            let script = self.0.join("server.py");
            std::fs::write(&script, format!("import json,os,sys,time,subprocess\nfrom pathlib import Path\nfor line in sys.stdin:\n    request=json.loads(line)\n    if request['method']=='initialize':\n        print(json.dumps({{'jsonrpc':'2.0','id':request['id'],'result':{{}}}}),flush=True)\n    else:\n{behavior}\n")).unwrap();
            McpClient::start(&serde_json::from_value(json!({
                "id":"io-test", "name":"I/O test", "transport":"stdio",
                "command":"python3", "args":format!("{} {}", script.display(), self.0.display()),
                "enabled":true
            })).unwrap(), None).unwrap()
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn chrome_workspace_selects_only_the_current_session_private_directory() {
        use crate::conversation_catalog::{ConversationCatalog, ConversationWorkspaceRecord};
        let directory = TestDirectory::new();
        let private = directory.0.join("private output");
        std::fs::create_dir(&private).unwrap();
        let record = |id: &str, owner: Option<&str>, session_workdir: bool, root: &Path| {
            ConversationWorkspaceRecord {
                workspace_id: id.into(),
                display_name: id.into(),
                canonical_root: root.to_string_lossy().into_owned(),
                owner_session_id: owner.map(str::to_owned),
                session_workdir,
                created_at: "2026-10-14T00:00:00Z".into(),
            }
        };
        let mut catalog = ConversationCatalog {
            workspaces: vec![
                record("project", None, false, &directory.0),
                record("input", Some("session:one"), false, &directory.0),
                record("other-private", Some("session:two"), true, &directory.0),
                record("private", Some("session:one"), true, &private.join(".")),
            ],
            ..Default::default()
        };
        assert_eq!(
            session_workdir_for_run(&catalog, "session:one").unwrap(),
            Some(private.canonicalize().unwrap())
        );
        assert!(session_workdir_for_run(&catalog, "session:missing")
            .unwrap()
            .is_none());
        catalog.workspaces.pop();
        assert!(session_workdir_for_run(&catalog, "session:one")
            .unwrap()
            .is_none());
        let file = directory.0.join("file.txt");
        std::fs::write(&file, "not a directory").unwrap();
        catalog
            .workspaces
            .push(record("invalid-private", Some("session:one"), true, &file));
        assert_eq!(
            session_workdir_for_run(&catalog, "session:one")
                .unwrap_err()
                .code,
            "mcp_session_workdir_invalid"
        );
    }

    #[test]
    fn chrome_workspace_binds_process_root_cwd_and_late_activation_to_the_run() {
        let directory = TestDirectory::new();
        let first_root = directory.0.join("first private directory");
        let second_root = directory.0.join("second private directory");
        std::fs::create_dir(&first_root).unwrap();
        std::fs::create_dir(&second_root).unwrap();
        let script = directory.0.join("workspace-server.py");
        std::fs::write(&script, r#"import json,os,sys
from pathlib import Path
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    method=request['method']
    if method=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'workspace','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':'capture','description':'write relative output','inputSchema':{'type':'object'}}]}
    else:
        Path(request['params']['arguments']['filePath']).write_text('captured')
        receipt={'pid':os.getpid(),'cwd':os.getcwd(),'args':sys.argv[1:]}
        result={'content':[{'type':'text','text':json.dumps(receipt)}],'isError':False}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#).unwrap();
        let settings = json!({"mcp.servers":serde_json::to_string(&json!([{
            "id":"chrome-workspace", "name":"Chrome workspace", "transport":"stdio",
            "command":"python3", "args":script, "enabled":true
        }])).unwrap()});
        let mut sources = available_server_sources(&settings).unwrap();
        let source = sources
            .iter_mut()
            .find(|source| source.setting.id == "chrome-workspace")
            .unwrap();
        source.descriptor.uri = "plugin://chrome-devtools@builtin".into();
        let sources = vec![source.clone()];
        let selected = BTreeMap::from([(
            "plugin://chrome-devtools@builtin".into(),
            "instance:chrome:first".into(),
        )]);
        let error = McpRuntime::from_selected_sources(&sources, &selected, None)
            .err()
            .unwrap();
        assert_eq!(error.code, "mcp_session_workdir_missing");

        // Initial run preparation may select no tools; later activation must keep its cwd.
        let empty = McpRuntime::from_selected_sources(
            &sources,
            &BTreeMap::new(),
            Some(first_root.canonicalize().unwrap()),
        )
        .unwrap();
        let first = empty.extend_selected_sources(&sources, &selected).unwrap();
        let later = first.extend_selected_sources(&sources, &selected).unwrap();
        let other = McpRuntime::from_selected_sources(
            &sources,
            &selected,
            Some(second_root.canonicalize().unwrap()),
        )
        .unwrap();
        let call = |runtime: &McpRuntime, file: &str| {
            let context = KernelToolExecutionContext {
                output_directory: None,
                workspace_root: None,
                workspace_id: None,
                private_resolved_targets: vec![],
                workspace_write_targets: None,
                file_access: Default::default(),
                cancellation: Default::default(),
                progress: Default::default(),
            };
            let result = runtime
                .tools()
                .next()
                .unwrap()
                .call(json!({"filePath":file}), &context)
                .unwrap();
            assert!(result.failure.is_none());
            serde_json::from_str::<Value>(result.output["content"][0]["text"].as_str().unwrap())
                .unwrap()
        };
        let one = call(&first, "first.png");
        let two = call(&other, "second.png");
        first.shutdown().unwrap();
        let again = call(&later, "later.png");
        assert_eq!(one["pid"], again["pid"]);
        assert_ne!(one["pid"], two["pid"]);
        for (receipt, root) in [
            (&one, &first_root),
            (&again, &first_root),
            (&two, &second_root),
        ] {
            let root = root.canonicalize().unwrap();
            assert_eq!(receipt["cwd"], json!(root));
            assert_eq!(receipt["args"], json!(["--workspace", root]));
        }
        assert_eq!(
            std::fs::read_to_string(first_root.join("first.png")).unwrap(),
            "captured"
        );
        assert!(first_root.join("later.png").is_file());
        assert!(second_root.join("second.png").is_file());
        assert!(!first_root.join("second.png").exists());
        assert!(!second_root.join("first.png").exists());
        empty.shutdown().unwrap();
        later.shutdown().unwrap();
        other.shutdown().unwrap();
    }

    #[cfg(unix)]
    fn bounded_worker_result<T>(
        receiver: Receiver<T>,
        worker: JoinHandle<()>,
        owned_group: u32,
    ) -> T {
        let result = receiver.recv_timeout(Duration::from_secs(5));
        if result.is_err() {
            // The failed check still owns this fixture's group; unblock its pipes before unwinding.
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{owned_group}")])
                .status();
        }
        worker.join().unwrap();
        result.expect("owned process and pipe workers must finish within five seconds")
    }

    #[test]
    fn startup_failure_preserves_mcp_stderr_and_exit_status() {
        let directory = TestDirectory::new();
        let script = directory.0.join("missing_config.py");
        std::fs::write(&script, "import sys\nsys.stderr.write('Required config is missing: settings.json\\n')\nsys.exit(7)\n").unwrap();
        let error = McpClient::start(
            &serde_json::from_value(json!({
                "id":"missing-config", "command":"python3", "args":script.to_string_lossy(),
                "enabled":true
            }))
            .unwrap(),
            None,
        )
        .unwrap_err();
        assert!(matches!(
            error.code,
            "mcp_server_ended" | "mcp_server_write_failed"
        ));
        assert!(
            error
                .message
                .contains("Required config is missing: settings.json"),
            "{}",
            error.message
        );
        assert!(
            error.message.contains("exit status: 7"),
            "{}",
            error.message
        );
    }

    #[test]
    fn failed_mcp_call_keeps_a_bounded_diagnostic_tail() {
        let directory = TestDirectory::new();
        let client = directory.server("        if request['method']=='tools/call':\n            sys.stderr.write('discarded-prefix' + 'x' * 20000 + '\\nModuleNotFoundError: example_dependency\\n')\n            sys.stderr.flush()\n            sys.exit(7)");
        let error = client
            .call_tool("example", json!({}), None, &Default::default())
            .unwrap_err();
        assert_eq!(error.code, "mcp_server_ended");
        assert!(error
            .message
            .contains("ModuleNotFoundError: example_dependency"));
        assert!(!error.message.contains("discarded-prefix"));
        assert!(error.message.len() < MAX_MCP_STDERR_BYTES + 512);
        assert!(client.process.lock().unwrap().stopped);
        client.shutdown().unwrap();
    }

    #[test]
    fn repeated_tool_list_cursor_fails_before_another_page() {
        let directory = TestDirectory::new();
        // The fixture terminates after three pages even without the regression fix.
        let client = directory.server(
            "        if request['method']=='tools/list':\n            page=request['id']-1\n            Path(sys.argv[1], 'pages').write_text(str(page))\n            result={'tools':[]}\n            if page<3: result['nextCursor']='repeated'\n            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)",
        );
        let error = client.list_tools().unwrap_err();
        assert_eq!(error.code, "mcp_tools_invalid");
        assert!(error.message.contains("repeated pagination cursor"));
        assert_eq!(
            std::fs::read_to_string(directory.0.join("pages")).unwrap(),
            "2"
        );
        client.shutdown().unwrap();
    }

    #[test]
    fn tool_list_accepts_a_new_cursor_after_an_empty_page() {
        let directory = TestDirectory::new();
        let client = directory.server(
            "        if request['method']=='tools/list':\n            if 'cursor' not in request['params']: result={'tools':[],'nextCursor':'next'}\n            else:\n                assert request['params']['cursor']=='next'\n                result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}\n            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)",
        );
        let tools = client.list_tools().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        client.shutdown().unwrap();
    }

    #[test]
    fn oversized_frame_is_rejected_before_reading_the_entire_source() {
        let mut source = std::io::Cursor::new(vec![b'x'; MAX_MCP_FRAME_BYTES + 1024]);
        let error = read_frame(&mut source).unwrap_err();
        assert!(error.to_string().contains("frame limit"));
        assert!(
            source.position() < source.get_ref().len() as u64,
            "oversized frames must be rejected before consuming the entire source"
        );
        assert_eq!(
            read_frame(&mut std::io::Cursor::new(b"{}\n")).unwrap(),
            Some(b"{}".to_vec())
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_interrupts_a_blocked_mcp_stdin_write() {
        let directory = TestDirectory::new();
        let client = directory.server("        if request['method']=='notifications/initialized':\n            Path(sys.argv[1], 'ready').write_text('ready')\n            time.sleep(60)");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !directory.0.join("ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(directory.0.join("ready").exists());
        let owned_group = client.process.lock().unwrap().owned.child.id();
        let cancellation = KernelCancellationToken::default();
        let call_cancellation = cancellation.clone();
        let caller = client.clone();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = caller.call_tool(
                "blocked",
                json!({"text":"x".repeat(1024 * 1024)}),
                None,
                &call_cancellation,
            );
            let _ = send.send(result);
        });
        assert!(matches!(
            receive.recv_timeout(Duration::from_millis(100)),
            Err(RecvTimeoutError::Timeout)
        ));
        cancellation.cancel();
        let result = bounded_worker_result(receive, worker, owned_group);
        assert_eq!(result.unwrap_err().code, "mcp_tool_cancelled");
        client.shutdown().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn mcp_shutdown_reclaims_pipe_holders_after_the_launcher_exits() {
        let directory = TestDirectory::new();
        let client = directory.server("        if request['method']=='tools/call':\n            child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'childPid':child.pid}}),flush=True)\n            break");
        let owned_group = client.process.lock().unwrap().owned.child.id();
        let result = client
            .call_tool("spawn", json!({}), None, &Default::default())
            .unwrap();
        assert!(result.output["childPid"].as_u64().is_some());
        let stopper = client.clone();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = send.send(stopper.shutdown());
        });
        bounded_worker_result(receive, worker, owned_group).unwrap();
        client.shutdown().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cli_completion_reclaims_pipe_holders_after_the_launcher_exits() {
        let directory = TestDirectory::new();
        let pid_path = directory.0.join("pid");
        let cli = CliClient {
            command: "python3".into(),
            args: vec!["-c".into(), "import json,os,sys,subprocess; from pathlib import Path; json.load(sys.stdin); Path(sys.argv[1]).write_text(str(os.getpid())); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(json.dumps({'childPid':child.pid}),flush=True)".into(), pid_path.to_string_lossy().into()],
            entry: None,
        };
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let context = KernelToolExecutionContext {
                output_directory: None,
                workspace_root: None,
                workspace_id: None,
                private_resolved_targets: vec![],
                workspace_write_targets: None,
                file_access: Default::default(),
                cancellation: Default::default(),
                progress: Default::default(),
            };
            let _ = send.send(cli.call("spawn", json!({}), None, &context));
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let owned_group = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
        let result = bounded_worker_result(receive, worker, owned_group).unwrap();
        assert!(result.failure.is_none());
        assert!(result.output["childPid"].as_u64().is_some());
    }

    #[test]
    fn multiple_tools_share_the_instance_until_the_last_runtime_view_releases() {
        struct Directory(std::path::PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = Directory(
            std::env::temp_dir().join(format!("deepcode-mcp-views-{}-{stamp}", std::process::id())),
        );
        std::fs::create_dir(&root.0).unwrap();
        let script = root.0.join("server.py");
        std::fs::write(&script, r#"import json,os,sys
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    method=request['method']
    if method=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'views','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':name,'description':name,'inputSchema':{'type':'object'}} for name in ['first','second']]}
    else:
        result={'content':[{'type':'text','text':str(os.getpid())+':'+request['params']['name']}],'isError':False}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#).unwrap();
        let settings = json!({"mcp.servers":serde_json::to_string(&json!([{
            "id":"views", "name":"Views", "transport":"stdio", "command":"python3", "args":script, "enabled":true
        }])).unwrap()});
        let sources = available_server_sources(&settings).unwrap();
        let selected = BTreeMap::from([(mcp_plugin_uri("views"), "instance:views".into())]);
        let first = McpRuntime::from_selected_sources(&sources, &selected, None).unwrap();
        let second = first.extend_selected_sources(&sources, &selected).unwrap();
        let context = || KernelToolExecutionContext {
            output_directory: None,
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: vec![],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: KernelCancellationToken::default(),
            progress: Default::default(),
        };
        let call = |runtime: &McpRuntime, name: &str| {
            runtime
                .tools()
                .find(|tool| tool.remote_name == name)
                .unwrap()
                .call(json!({}), &context())
        };
        let one = call(&first, "first").unwrap();
        let two = call(&second, "second").unwrap();
        assert!(one.failure.is_none() && two.failure.is_none());
        let one = one.output["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        let two = two.output["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(one.ends_with(":first") && two.ends_with(":second"));
        assert_eq!(
            one.split(':').next(),
            two.split(':').next(),
            "both tools execute in the same server process"
        );
        first.shutdown().unwrap();
        assert!(call(&second, "first").unwrap().failure.is_none());
        second.shutdown().unwrap();
        for name in ["first", "second"] {
            assert_eq!(call(&second, name).unwrap_err().code, "mcp_server_stopped");
        }
        second.shutdown().unwrap();
    }

    #[test]
    fn cli_generations_execute_pinned_entries_without_a_server() {
        struct Directory(std::path::PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = Directory(std::env::temp_dir().join(format!(
            "deepcode-cli-plugin-{}-{stamp}",
            std::process::id()
        )));
        std::fs::create_dir(&root.0).unwrap();
        let args = json!([
            "",
            "two words",
            "single'quote",
            "double\"quote",
            "back\\slash",
            ""
        ]);
        std::fs::write(root.0.join("deepcode-tool.json"),serde_json::to_vec(&json!({"id":"sample","name":"Sample","description":"Report implementation","command":"python3","entry":"main.py","args":args,"tools":[{"name":"version","description":"Read implementation","inputSchema":{"type":"object"}}]})).unwrap()).unwrap();
        let write = |version: &str| {
            std::fs::write(root.0.join("main.py"),format!("import json,sys\njson.load(sys.stdin)\njson.dump({{\"version\":\"{version}\",\"args\":sys.argv[1:]}},sys.stdout)\n")).unwrap()
        };
        write("first");
        let settings = json!({"plugins.sources":serde_json::to_string(&json!([{"id":"sample","path":root.0,"enabled":true}])).unwrap()});
        let selected = |instance: &str| {
            BTreeMap::from([("plugin://sample@cli".to_string(), instance.to_string())])
        };
        let first = McpRuntime::from_selected_sources(
            &available_server_sources(&settings).unwrap(),
            &selected("instance:first"),
            None,
        )
        .unwrap();
        write("second");
        let second = first
            .extend_selected_sources(
                &available_server_sources(&settings).unwrap(),
                &selected("instance:second"),
            )
            .unwrap();
        let context = |attempt: &str| KernelToolExecutionContext {
            output_directory: Some(root.0.join(attempt)),
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: vec![],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: KernelCancellationToken::default(),
            progress: Default::default(),
        };
        let old = first
            .tools()
            .next()
            .unwrap()
            .call(json!({}), &context("old"))
            .unwrap();
        let new = second
            .tools()
            .next()
            .unwrap()
            .call(json!({}), &context("new"))
            .unwrap();
        assert!(old.failure.is_none() && new.failure.is_none());
        assert_eq!(old.output["version"], "first");
        assert_eq!(new.output["version"], "second");
        assert_eq!(old.output["args"], args);
        assert_eq!(new.output["args"], args);
        assert!(matches!(
            second.tools().next().unwrap().instance.client,
            ToolClient::Cli(_)
        ));
    }

    #[test]
    fn structured_tool_failure_preserves_provider_error() {
        let result = decode_tool_call_result(
            "read",
            json!({
                "content": [{ "type": "text", "text": "failure" }],
                "structuredContent": {
                    "error": {
                        "code": "pdf_extract_failed",
                        "message": "invalid PDF"
                    }
                },
                "isError": true
            }),
        )
        .expect("valid MCP tool failure");
        let failure = result.failure.expect("provider failure");
        assert_eq!(failure.code, "pdf_extract_failed");
        assert_eq!(failure.message, "invalid PDF");
        assert_eq!(result.output["isError"], true);
        let image_failure = decode_tool_call_result(
            "capture",
            json!({"isError":true,"content":[
            {"type":"text","text":"Window no longer exists"},
            {"type":"image","data":"pixel-bytes","mimeType":"image/png"}]}),
        )
        .unwrap();
        let message = image_failure.failure.unwrap().message;
        assert!(message.contains("Window no longer exists"));
        assert!(!message.contains("pixel-bytes"));
    }

    #[test]
    fn cancelled_tool_call_stops_and_reclaims_the_stdio_server() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/skill-mcp-smoke/mcp/mcp-text-tools/server.py")
            .canonicalize()
            .expect("fixture server");
        let settings = json!({
            "mcp.autoLoad": true,
            "mcp.servers": serde_json::to_string(&json!([{
                "id": "fixture.mcp.cancelled",
                "name": "Fixture MCP Cancellation",
                "transport": "stdio",
                "command": "python3",
                "args": script.to_string_lossy(),
                "enabled": true,
            }])).expect("settings"),
        });
        let runtime = McpRuntime::from_selected_sources(
            &available_server_sources(&settings).unwrap(),
            &BTreeMap::from([(
                mcp_plugin_uri("fixture.mcp.cancelled"),
                "plugin-instance:test:cancelled".to_string(),
            )]),
            None,
        )
        .expect("start selected MCP runtime");
        let tool = runtime.tools().next().expect("mapped tool");
        let cancellation = KernelCancellationToken::default();
        cancellation.cancel();
        let context = KernelToolExecutionContext {
            output_directory: None,
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: Vec::new(),
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation,
            progress: Default::default(),
        };

        let error = tool
            .call(json!({ "text": "DeepCode" }), &context)
            .expect_err("cancelled MCP call must fail after process cleanup");
        assert_eq!(error.code, "mcp_tool_cancelled");
        runtime
            .shutdown()
            .expect("cancelled runtime is already reclaimed");
    }
}
