use crate::local_agent_mcp::{McpRuntime, McpTool, McpToolEffectScope};
use crate::local_agent_product_tools::ProductTools;
use achbit_first_party_tools::documents::{self, DocumentContext, DocumentInput};
use achbit_kernel_runtime::executors::{
    builtin_executors, web_search_availability, KernelExecutorConfig, KernelExecutorRegistry,
    KernelToolExecutionContext, KernelToolExecutionFailure, KernelToolExecutionOutcome,
    KernelToolExecutionResult, KernelToolInvocation, SecretProvider,
};
use achbit_kernel_tools::kernel_internal::{KernelCanonicalInvocation, KernelDeleteTarget};
use achbit_kernel_tools::{
    KernelToolCatalogError, KernelToolRegistry, ToolAvailability, ToolEffectClass, ToolEffectScope,
    ToolInputIssue,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub(crate) struct ToolCatalogError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) input_issues: Option<Vec<ToolInputIssue>>,
}

impl ToolCatalogError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_issues: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogEffectScope {
    LocalRead,
    WorkspaceRead,
    WorkspaceMutation,
    Process,
    Network,
    External,
}

#[derive(Clone)]
enum ToolExecutorBinding {
    Builtin {
        registry: Arc<KernelToolRegistry>,
        executors: Arc<KernelExecutorRegistry>,
    },
    Mcp(Box<McpTool>),
    Product(Arc<ProductTools>),
    Artifact,
    Process,
    Browser(Value),
    Desktop(crate::desktop_tools::DesktopRun),
    Unavailable,
    Container(Arc<crate::container_tools::Containers>),
    Document {
        python: Option<std::path::PathBuf>,
    },
}

struct PendingToolContribution {
    origin: &'static str,
    provider_ref: String,
    plugin_uri: Option<String>,
    plugin_instance_ref: Option<String>,
    contribution_ref: String,
    name: String,
    description: String,
    input_schema: Value,
    effect_class: Option<ToolEffectClass>,
    effect_scope: CatalogEffectScope,
    availability: ToolAvailability,
    availability_reason: Option<Value>,
    runtime_status: Option<Value>,
    logical_target: Option<String>,
    binding: ToolExecutorBinding,
}

type ExactDisposer = Box<dyn FnOnce() -> Result<(), ToolCatalogError> + Send>;

#[derive(Debug, Clone)]
pub(crate) enum PreparedToolInput {
    Builtin(KernelCanonicalInvocation),
    Document(DocumentInput),
    Process(crate::managed_processes::Input),
    Container {
        input: crate::container_tools::Input,
        target: Value,
    },
    Dynamic {
        arguments: Value,
        targets: Vec<String>,
    },
}

impl PreparedToolInput {
    pub(crate) fn arguments(&self) -> Value {
        match self {
            Self::Builtin(input) => input.executor_arguments(),
            Self::Process(input) => {
                json!({"action":input.action,"jobId":input.job_id,"waitSeconds":input.wait_seconds})
            }
            Self::Container { input, target } => json!({"request":input,"target":target}),
            Self::Document(input) => serde_json::to_value(input).expect("DocumentInput serializes"),
            Self::Dynamic { arguments, .. } => arguments.clone(),
        }
    }

    pub(crate) fn logical_targets(&self) -> Vec<String> {
        match self {
            Self::Builtin(input) => match input {
                KernelCanonicalInvocation::FsRead { path, .. }
                | KernelCanonicalInvocation::FsWrite { path, .. }
                | KernelCanonicalInvocation::FsEdit { path, .. }
                | KernelCanonicalInvocation::FsDelete(KernelDeleteTarget::File { path })
                | KernelCanonicalInvocation::FsDelete(KernelDeleteTarget::DirectoryTree { path }) =>
                {
                    vec![path.clone()]
                }
                KernelCanonicalInvocation::ProcessShell { .. }
                | KernelCanonicalInvocation::ProcessPowerShell { .. } => vec![".".into()],
                KernelCanonicalInvocation::WebFetch { url, .. } => vec![url.clone()],
                KernelCanonicalInvocation::WebSearch { .. } => Vec::new(),
            },
            Self::Process(_) => vec![],
            Self::Container { .. } => vec![".".into()],
            Self::Document(input) => vec![input.path.clone()],
            Self::Dynamic { targets, .. } => targets.clone(),
        }
    }
}

struct InstalledToolProvider {
    tools: Vec<PendingToolContribution>,
    dispose: ExactDisposer,
}

trait ToolProvider: Send {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError>;
}

struct ProductToolProvider(Arc<ProductTools>);

struct DocumentToolProvider {
    python: Option<std::path::PathBuf>,
}

impl ToolProvider for DocumentToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        Ok(InstalledToolProvider {
            tools: vec![PendingToolContribution {
                origin: "coreBuiltin",
                provider_ref: "deepcode:documents".into(),
                plugin_uri: None,
                plugin_instance_ref: None,
                contribution_ref: "deepcode:documents/document.render".into(),
                name: "document.render".into(),
                description: "Create a polished document artifact in the workspace. Write complete HTML or Markdown, or render self-contained HTML to PDF with WeasyPrint. Read achbit-documents via skill.read for templates and typography when needed. Output is a workspace mutation; the existing Plan and permission policy applies. PDF requires a configured Python environment with WeasyPrint. Source limit: 1 MiB; PDF limit: 32 MiB.".into(),
                input_schema: documents::input_schema(),
                effect_class: None,
                effect_scope: CatalogEffectScope::WorkspaceMutation,
                availability: ToolAvailability::Callable,
                availability_reason: None, runtime_status: None, logical_target: None,
                binding: ToolExecutorBinding::Document { python: self.python },
            }],
            dispose: Box::new(|| Ok(())),
        })
    }
}

impl ToolProvider for ProductToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let mut tools: Vec<_> = ProductTools::definitions()
            .into_iter()
            .map(
                |(name, description, input_schema)| PendingToolContribution {
                    origin: "coreBuiltin",
                    provider_ref: "deepcode:product".into(),
                    plugin_uri: None,
                    plugin_instance_ref: None,
                    contribution_ref: format!("deepcode:product/{name}"),
                    name: name.into(),
                    description,
                    input_schema,
                    effect_class: Some(ToolEffectClass::Read),
                    effect_scope: CatalogEffectScope::LocalRead,
                    availability: ToolAvailability::Callable,
                    availability_reason: None,
                    runtime_status: None,
                    logical_target: None,
                    binding: ToolExecutorBinding::Product(Arc::clone(&self.0)),
                },
            )
            .collect();
        for (name, field, description, scope) in [
            ("artifact.prepare", "path", "Archive a workspace file as an immutable resource version. Re-prepare after modifying it; its logical identity stays stable.", CatalogEffectScope::WorkspaceRead),
            ("artifact.preview", "url", "Register an HTTP(S) live preview reference without fetching or verifying it. Call after updating the preview to record its latest presentation version.", CatalogEffectScope::LocalRead),
        ] {
            tools.push(PendingToolContribution {
                origin: "coreBuiltin", provider_ref: "deepcode:resources".into(), plugin_uri: None, plugin_instance_ref: None,
                contribution_ref: format!("deepcode:resources/{name}"), name: name.into(),
                description: format!("{description} This does not add it to user outputs. Use artifact.present for requested results or review materials. Temporary scripts, logs and observation images stay intermediate unless explicitly presented."),
                input_schema: crate::artifact_resources::schema(field), effect_class: Some(ToolEffectClass::Read),
                effect_scope: scope, availability: ToolAvailability::Callable, availability_reason: None, runtime_status: None, logical_target: None, binding: ToolExecutorBinding::Artifact,
            });
        }
        if let Some(instance) = self.0.computer_use_instance.as_ref() {
            let browser_status = self
                .0
                .browser_binding
                .as_ref()
                .map(crate::browser_tools::host_status);
            let desktop_status = self.0.desktop.as_ref().map(|run| run.status());
            for (name, description, input_schema) in crate::browser_tools::definitions() {
                let (available, runtime_status, binding) = if name == "computer.control" {
                    let available = desktop_status
                        .as_ref()
                        .ok_or("No desktop executor is attached to this Host.")
                        .and_then(|status| {
                            status
                                .as_ref()
                                .map(|_| ())
                                .map_err(|error| error.message.as_str())
                        });
                    (
                        available,
                        desktop_status
                            .as_ref()
                            .and_then(|status| status.as_ref().ok())
                            .cloned(),
                        self.0
                            .desktop
                            .clone()
                            .map(ToolExecutorBinding::Desktop)
                            .unwrap_or(ToolExecutorBinding::Unavailable),
                    )
                } else {
                    let available = browser_status
                        .as_ref()
                        .ok_or("This run has no GUI window for embedded browser tools.")
                        .and_then(|status| status.as_ref().map_err(String::as_str))
                        .and_then(|status| status.check_tool(name));
                    (
                        available,
                        None,
                        self.0
                            .browser_binding
                            .clone()
                            .map(ToolExecutorBinding::Browser)
                            .unwrap_or(ToolExecutorBinding::Unavailable),
                    )
                };
                tools.push(PendingToolContribution {
                    origin: "extension",
                    provider_ref: "deepcode:computer-use".into(),
                    plugin_uri: Some("plugin://computer-use@builtin".into()),
                    plugin_instance_ref: Some(instance.clone()),
                    contribution_ref: format!("deepcode:computer-use/{name}"),
                    name: name.into(), description: description.into(), input_schema,
                    effect_class: None,
                    effect_scope: match name {
                        "browser.open" => CatalogEffectScope::WorkspaceRead,
                        "browser.capture" => CatalogEffectScope::WorkspaceMutation,
                        _ => CatalogEffectScope::External,
                    },
                    availability: if available.is_ok() { ToolAvailability::Callable } else { ToolAvailability::Blocked },
                    availability_reason: available.err().map(|message| json!({
                        "code": if name == "computer.control" { "desktop_executor_unavailable" } else { "gui_browser_unavailable" },
                        "message": message,
                    })),
                    runtime_status, logical_target: None, binding,
                });
            }
        }
        if let Some(instance) = &self.0.process_instance {
            tools.push(PendingToolContribution {
                origin: "extension", provider_ref: "deepcode:processes".into(), plugin_uri: Some("plugin://processes@builtin".into()),
                plugin_instance_ref: Some(instance.clone()), contribution_ref: format!("{instance}/process"),
                name: "process".into(), description: "Manage long-running commands in this run. start returns a jobId after normal Kernel approval; use wait when later work depends on the result, status for inspection, or cancel to stop that job. Status changes arrive automatically. Container jobs require the containers plugin. Existing permissions and explicit timeouts still apply.".into(),
                input_schema: crate::managed_processes::schema(), effect_class: None, effect_scope: CatalogEffectScope::Process,
                availability: ToolAvailability::Callable, availability_reason: None, runtime_status: None, logical_target: None, binding: ToolExecutorBinding::Process,
            });
        }
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(|| Ok(())),
        })
    }
}

struct ContainerToolProvider {
    instance: String,
    adapter: Arc<crate::container_tools::Containers>,
}
impl ContainerToolProvider {
    fn new(instance: &str, path: &str) -> Result<Self, ToolCatalogError> {
        Ok(Self {
            instance: instance.into(),
            adapter: Arc::new(
                crate::container_tools::Containers::new(path)
                    .map_err(|e| ToolCatalogError::new("container_plugin_unavailable", e))?,
            ),
        })
    }
}
impl ToolProvider for ContainerToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let adapter = self.adapter.clone();
        Ok(InstalledToolProvider { tools:vec![PendingToolContribution {
            origin:"extension" , provider_ref:"deepcode:containers".into(), plugin_uri:Some("plugin://containers@builtin".into()),
            plugin_instance_ref:Some(self.instance.clone()), contribution_ref:format!("{}/container",self.instance),
            name:"container".into(), description:"Run Shell commands in an approved Docker container, inspect it, or create an independent temporary test container. Creation mounts the selected project read-only at /project and writable session test files at /work. Approval can cover this task or conversation; temporary containers are cleaned at task end. Existing containers keep their mounts and network. Linux images need sh and setsid.".into(),
            input_schema:crate::container_tools::input_schema(), effect_class:None,effect_scope:CatalogEffectScope::Process,
            availability:ToolAvailability::Callable,availability_reason:None,runtime_status:None,logical_target:None,binding:ToolExecutorBinding::Container(self.adapter),
        }], dispose:Box::new(move || adapter.dispose().map_err(|e| ToolCatalogError::new("container_cleanup_failed",e))) })
    }
}

struct BuiltinToolProvider {
    registry: Arc<KernelToolRegistry>,
    executors: Arc<KernelExecutorRegistry>,
    web_search_availability: ToolAvailability,
    shell_tool: String,
}

impl BuiltinToolProvider {
    fn prepare(
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        enable_web_search: bool,
    ) -> Result<Self, ToolCatalogError> {
        let web_search_availability = if enable_web_search {
            web_search_availability(&executor_config)
        } else {
            ToolAvailability::Blocked
        };
        let shell_tool = executor_config
            .shell_program
            .as_ref()
            .map(|shell| shell.tool.clone())
            .unwrap_or_else(|| if cfg!(windows) { "powershell" } else { "bash" }.into());
        let registry = Arc::new(KernelToolRegistry::new());
        let executors = Arc::new(KernelExecutorRegistry::from_executors(builtin_executors(
            registry.as_ref(),
            executor_config,
            secret_provider,
        )));
        Ok(Self {
            registry,
            executors,
            web_search_availability,
            shell_tool,
        })
    }
}

impl ToolProvider for BuiltinToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let tools = self
            .registry
            .descriptors()
            .map(|descriptor| PendingToolContribution {
                origin: "coreBuiltin",
                provider_ref: "tool-provider:core-builtin".to_string(),
                plugin_uri: None,
                plugin_instance_ref: None,
                contribution_ref: format!("tool-contribution:builtin:{}", descriptor.name),
                name: descriptor.name.clone(),
                description: descriptor.description.clone(),
                input_schema: descriptor.input_schema.clone(),
                effect_class: Some(descriptor.effect_class),
                effect_scope: match descriptor.effect_scope {
                    ToolEffectScope::WorkspaceRead => CatalogEffectScope::WorkspaceRead,
                    ToolEffectScope::WorkspaceWrite => CatalogEffectScope::WorkspaceMutation,
                    ToolEffectScope::NetworkRead => CatalogEffectScope::Network,
                    ToolEffectScope::Process => CatalogEffectScope::Process,
                },
                availability: if descriptor.name == "web.search" {
                    self.web_search_availability
                } else if matches!(descriptor.name.as_str(), "bash" | "powershell")
                    && descriptor.name != self.shell_tool
                {
                    ToolAvailability::Blocked
                } else {
                    descriptor.availability
                },
                availability_reason: None,
                runtime_status: None,
                logical_target: None,
                binding: ToolExecutorBinding::Builtin {
                    registry: Arc::clone(&self.registry),
                    executors: Arc::clone(&self.executors),
                },
            })
            .collect();
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(|| Ok(())),
        })
    }
}

struct McpToolProvider {
    runtime: McpRuntime,
}

impl McpToolProvider {
    fn prepare(runtime: McpRuntime) -> Result<Self, ToolCatalogError> {
        Ok(Self { runtime })
    }
}

impl ToolProvider for McpToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let tools = self
            .runtime
            .tools()
            .map(|tool| PendingToolContribution {
                origin: "extension",
                provider_ref: tool.provider_ref.clone(),
                plugin_uri: Some(tool.plugin_uri.clone()),
                plugin_instance_ref: Some(tool.plugin_instance_ref.clone()),
                contribution_ref: tool.contribution_ref.clone(),
                name: tool.public_name.clone(),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
                effect_class: None,
                effect_scope: match tool.effect_scope {
                    McpToolEffectScope::WorkspaceRead => CatalogEffectScope::WorkspaceRead,
                    McpToolEffectScope::Network => CatalogEffectScope::Network,
                    McpToolEffectScope::External => CatalogEffectScope::External,
                },
                availability: ToolAvailability::Callable,
                availability_reason: None,
                runtime_status: None,
                logical_target: Some(tool.target.clone()),
                binding: ToolExecutorBinding::Mcp(Box::new(tool.clone())),
            })
            .collect();
        let runtime = self.runtime.clone();
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(move || {
                runtime
                    .shutdown()
                    .map_err(|error| ToolCatalogError::new(error.code, error.message))
            }),
        })
    }
}

struct CatalogResources {
    state: Mutex<CatalogResourceState>,
}

struct CatalogResourceState {
    disposers: Vec<ExactDisposer>,
    active_attempts: usize,
    retired: bool,
    disposal: Option<Result<(), ToolCatalogError>>,
}

impl CatalogResources {
    fn new(disposers: Vec<ExactDisposer>) -> Self {
        Self {
            state: Mutex::new(CatalogResourceState {
                disposers,
                active_attempts: 0,
                retired: false,
                disposal: None,
            }),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, CatalogResourceState>, ToolCatalogError> {
        self.state.lock().map_err(|_| {
            ToolCatalogError::new(
                "tool_provider_disposer_lock_failed",
                "ToolProvider disposer 状态锁已损坏。",
            )
        })
    }

    fn acquire(&self) -> Result<(), ToolCatalogError> {
        let mut state = self.lock()?;
        if state.retired {
            return Err(ToolCatalogError::new(
                "tool_catalog_retired",
                "旧工具视图已退役，不能接纳新的物理调用。",
            ));
        }
        state.active_attempts += 1;
        Ok(())
    }

    fn release(&self) -> Result<(), ToolCatalogError> {
        let mut state = self.lock()?;
        debug_assert!(
            state.active_attempts > 0,
            "physical attempt lease underflow"
        );
        state.active_attempts -= 1;
        if state.retired && state.active_attempts == 0 {
            return Self::dispose_locked(&mut state);
        }
        Ok(())
    }

    fn retire(&self) -> Result<(), ToolCatalogError> {
        let mut state = self.lock()?;
        state.retired = true;
        if state.active_attempts == 0 {
            return Self::dispose_locked(&mut state);
        }
        Ok(())
    }

    fn dispose(&self) -> Result<(), ToolCatalogError> {
        let mut state = self.lock()?;
        if state.active_attempts != 0 {
            return Err(ToolCatalogError::new(
                "tool_catalog_generation_busy",
                "Kernel catalog generation 仍有物理 attempt lease。",
            ));
        }
        state.retired = true;
        Self::dispose_locked(&mut state)
    }

    fn dispose_locked(state: &mut CatalogResourceState) -> Result<(), ToolCatalogError> {
        if let Some(result) = &state.disposal {
            return result.clone();
        }
        let mut errors = Vec::new();
        for dispose in std::mem::take(&mut state.disposers).into_iter().rev() {
            if let Err(error) = dispose() {
                errors.push(error);
            }
        }
        let result = if errors.is_empty() {
            Ok(())
        } else {
            let message = errors
                .iter()
                .map(|error| format!("{}: {}", error.code, error.message))
                .collect::<Vec<_>>()
                .join("；");
            Err(ToolCatalogError::new(
                "tool_provider_dispose_failed",
                message,
            ))
        };
        state.disposal = Some(result.clone());
        result
    }
}

/** Retains only physical cleanup ownership/results, not the old catalog or execution bindings. */
#[derive(Clone)]
pub(crate) struct CatalogRetirement(Arc<CatalogResources>);

impl CatalogRetirement {
    pub(crate) fn retire(&self) -> Result<(), ToolCatalogError> {
        self.0.retire()
    }

    pub(crate) fn finish(&self) -> Result<(), ToolCatalogError> {
        self.0.dispose()
    }
}

impl Drop for CatalogResources {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}

struct CatalogToolEntry {
    origin: &'static str,
    provider_ref: String,
    plugin_uri: Option<String>,
    plugin_instance_ref: Option<String>,
    contribution_ref: String,
    binding_ref: String,
    name: String,
    description: String,
    input_schema: Value,
    effect_class: Option<ToolEffectClass>,
    effect_scope: CatalogEffectScope,
    availability: ToolAvailability,
    availability_reason: Option<Value>,
    runtime_status: Option<Value>,
    logical_target: Option<String>,
    binding: ToolExecutorBinding,
}

pub(crate) struct ToolCatalogSnapshot {
    extension_generation_ref: String,
    snapshot_ref: String,
    tools: BTreeMap<String, CatalogToolEntry>,
    bindings: BTreeMap<String, String>,
    resources: Arc<CatalogResources>,
}

impl ToolCatalogSnapshot {
    pub(crate) fn prepare(
        extension_generation_ref: &str,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        mcp: McpRuntime,
        enable_web_search: bool,
        product: Arc<ProductTools>,
    ) -> Result<Arc<Self>, ToolCatalogError> {
        validate_ref("extensionGenerationRef", extension_generation_ref)?;
        let container_provider = product
            .container_instance
            .as_ref()
            .map(|instance| {
                ContainerToolProvider::new(
                    instance,
                    executor_config.execution_path.as_deref().unwrap_or(""),
                )
            })
            .transpose()?;
        let mut providers: Vec<Box<dyn ToolProvider>> = vec![
            Box::new(BuiltinToolProvider::prepare(
                executor_config,
                secret_provider,
                enable_web_search,
            )?),
            Box::new(McpToolProvider::prepare(mcp)?),
            Box::new(DocumentToolProvider {
                python: product.document_python.clone(),
            }),
            Box::new(ProductToolProvider(product)),
        ];
        if let Some(provider) = container_provider {
            providers.push(Box::new(provider));
        }
        Self::from_providers(extension_generation_ref, providers)
    }

    fn from_providers(
        extension_generation_ref: &str,
        providers: Vec<Box<dyn ToolProvider>>,
    ) -> Result<Arc<Self>, ToolCatalogError> {
        let mut contributions = BTreeMap::new();
        let mut disposers = Vec::new();
        for provider in providers {
            let installed = match provider.install() {
                Ok(installed) => installed,
                Err(error) => {
                    return Err(rollback_installation(error, disposers));
                }
            };
            disposers.push(installed.dispose);
            for contribution in installed.tools {
                if contributions
                    .insert(contribution.name.clone(), contribution)
                    .is_some()
                {
                    return Err(rollback_installation(
                        ToolCatalogError::new(
                            "tool_catalog_name_conflict",
                            "多个 ToolProvider 注册了相同 canonical tool name。",
                        ),
                        disposers,
                    ));
                }
            }
        }

        let snapshot_ref = match crate::utils::new_runtime_ref("kernel-catalog") {
            Ok(reference) => reference,
            Err(message) => {
                return Err(rollback_installation(
                    ToolCatalogError::new("tool_catalog_identity_failed", message),
                    disposers,
                ));
            }
        };

        let mut tools = BTreeMap::new();
        let mut bindings = BTreeMap::new();
        for (_, contribution) in contributions {
            let binding_ref = format!("tool-binding:{}:{}", snapshot_ref, tools.len());
            bindings.insert(binding_ref.clone(), contribution.name.clone());
            tools.insert(
                contribution.name.clone(),
                CatalogToolEntry {
                    origin: contribution.origin,
                    provider_ref: contribution.provider_ref,
                    plugin_uri: contribution.plugin_uri,
                    plugin_instance_ref: contribution.plugin_instance_ref,
                    contribution_ref: contribution.contribution_ref,
                    binding_ref,
                    name: contribution.name,
                    description: contribution.description,
                    input_schema: contribution.input_schema,
                    effect_class: contribution.effect_class,
                    effect_scope: contribution.effect_scope,
                    availability: contribution.availability,
                    availability_reason: contribution.availability_reason,
                    runtime_status: contribution.runtime_status,
                    logical_target: contribution.logical_target,
                    binding: contribution.binding,
                },
            );
        }

        Ok(Arc::new(Self {
            extension_generation_ref: extension_generation_ref.to_string(),
            snapshot_ref,
            tools,
            bindings,
            resources: Arc::new(CatalogResources::new(disposers)),
        }))
    }

    pub(crate) fn extension_generation_ref(&self) -> &str {
        &self.extension_generation_ref
    }

    pub(crate) fn snapshot_ref(&self) -> &str {
        &self.snapshot_ref
    }

    pub(crate) fn provider_view(&self) -> Value {
        Value::Array(
            self.tools
                .values()
                .map(|tool| {
                    let mut view = json!({
                        "toolBindingRef": tool.binding_ref,
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                        "possibleEffects": possible_effects(tool.effect_class, tool.effect_scope),
                        "availability": availability_name(tool.availability),
                        "origin": tool.origin,
                    });
                    if let Some(reason) = &tool.availability_reason {
                        view["availabilityReason"] = reason.clone();
                    }
                    if let Some(status) = &tool.runtime_status {
                        view["runtimeStatus"] = status.clone();
                    }
                    if let Some(plugin_uri) = &tool.plugin_uri {
                        view["pluginUri"] = json!(plugin_uri);
                    }
                    view
                })
                .collect(),
        )
    }

    pub(crate) fn binding_for_name(
        self: &Arc<Self>,
        name: &str,
    ) -> Result<PreparedCatalogBinding, ToolCatalogError> {
        let entry = self.tools.get(name).ok_or_else(|| {
            ToolCatalogError::new(
                "tool_not_found",
                format!("Execution tool {name} is not activated"),
            )
        })?;
        self.binding(&entry.binding_ref, name)
    }

    pub(crate) fn binding(
        self: &Arc<Self>,
        binding_ref: &str,
        tool_name: &str,
    ) -> Result<PreparedCatalogBinding, ToolCatalogError> {
        let bound_name = self.bindings.get(binding_ref).ok_or_else(|| {
            ToolCatalogError::new(
                "tool_binding_not_found",
                "toolBindingRef 不属于当前 Kernel catalog snapshot。",
            )
        })?;
        if bound_name != tool_name {
            return Err(ToolCatalogError::new(
                "tool_binding_identity_mismatch",
                "toolBindingRef 与 canonical tool name 不一致。",
            ));
        }
        Ok(PreparedCatalogBinding {
            snapshot: Arc::clone(self),
            binding_ref: binding_ref.to_string(),
        })
    }

    pub(crate) fn retirement(&self) -> CatalogRetirement {
        CatalogRetirement(Arc::clone(&self.resources))
    }

    pub(crate) fn dispose(&self) -> Result<(), ToolCatalogError> {
        self.resources.dispose()
    }
}

#[derive(Clone)]
pub(crate) struct PreparedCatalogBinding {
    snapshot: Arc<ToolCatalogSnapshot>,
    binding_ref: String,
}

impl PreparedCatalogBinding {
    fn entry(&self) -> &CatalogToolEntry {
        let name = self
            .snapshot
            .bindings
            .get(&self.binding_ref)
            .expect("prepared binding belongs to snapshot");
        self.snapshot
            .tools
            .get(name)
            .expect("prepared binding names a catalog entry")
    }

    pub(crate) fn binding_ref(&self) -> &str {
        &self.binding_ref
    }

    pub(crate) fn extension_generation_ref(&self) -> &str {
        self.snapshot.extension_generation_ref()
    }

    pub(crate) fn snapshot_ref(&self) -> &str {
        self.snapshot.snapshot_ref()
    }

    pub(crate) fn contribution_ref(&self) -> &str {
        &self.entry().contribution_ref
    }

    pub(crate) fn origin(&self) -> &str {
        self.entry().origin
    }

    pub(crate) fn provider_ref(&self) -> &str {
        &self.entry().provider_ref
    }

    pub(crate) fn plugin_instance_ref(&self) -> Option<&str> {
        self.entry().plugin_instance_ref.as_deref()
    }

    pub(crate) fn tool_name(&self) -> &str {
        &self.entry().name
    }

    pub(crate) fn is_process(&self) -> bool {
        matches!(&self.entry().binding, ToolExecutorBinding::Process)
    }

    pub(crate) fn uses_external_runtime(&self) -> bool {
        matches!(&self.entry().binding, ToolExecutorBinding::Mcp(_))
    }

    pub(crate) fn container_adapter(&self) -> Option<&crate::container_tools::Containers> {
        match &self.entry().binding {
            ToolExecutorBinding::Container(adapter) => Some(adapter),
            _ => None,
        }
    }

    pub(crate) fn is_browser_page(&self) -> bool {
        matches!(&self.entry().binding, ToolExecutorBinding::Browser(_))
            && self.tool_name() == "browser.page"
    }

    pub(crate) fn is_browser_service(&self) -> bool {
        matches!(&self.entry().binding, ToolExecutorBinding::Browser(_))
            && self.tool_name() == "browser.service"
    }

    pub(crate) fn is_internal_preview(&self) -> bool {
        matches!(&self.entry().binding, ToolExecutorBinding::Browser(_))
            && matches!(
                self.tool_name(),
                "browser.open" | "browser.page" | "browser.observe"
            )
    }

    pub(crate) fn effect_scope(
        &self,
        input: &Value,
    ) -> Result<CatalogEffectScope, ToolCatalogError> {
        if self.is_process() {
            return Ok(CatalogEffectScope::LocalRead);
        }
        if let ToolExecutorBinding::Browser(host) = &self.entry().binding {
            let action = input["action"].as_str().unwrap_or("");
            let network = |url: &str| {
                if url.starts_with("http://") || url.starts_with("https://") {
                    CatalogEffectScope::Network
                } else {
                    CatalogEffectScope::LocalRead
                }
            };
            match (self.tool_name(), action) {
                (
                    "browser.page",
                    "openSelf" | "list" | "status" | "activate" | "close" | "refreshInterface",
                ) => return Ok(CatalogEffectScope::LocalRead),
                ("browser.page", "reload") => {
                    let page = crate::browser_tools::call(
                        host,
                        &json!({"action":"status","previewId":input["previewId"]}),
                    )
                    .map_err(|error| {
                        let message = error.message;
                        let input_issues = (message == "native_browser_page_closed"
                            || message.starts_with("native_browser_page_closed:"))
                        .then(|| {
                            vec![ToolInputIssue::new(
                                "$.previewId",
                                "pageClosed",
                                "The page is closed. List the current pages and select an open previewId.",
                                None,
                            )]
                        });
                        ToolCatalogError {
                            code: "native_browser_failed",
                            message,
                            input_issues,
                        }
                    })?;
                    let url = page["url"].as_str().ok_or_else(|| {
                        ToolCatalogError::new(
                            "native_browser_page_invalid",
                            "Browser status is missing its URL",
                        )
                    })?;
                    return Ok(network(url));
                }
                ("browser.page", "act")
                    if matches!(input["operation"].as_str(), Some("inspect" | "scroll")) =>
                {
                    return Ok(CatalogEffectScope::LocalRead)
                }
                ("browser.page", "open" | "navigate") => {
                    return Ok(input["url"]
                        .as_str()
                        .map(network)
                        .unwrap_or(CatalogEffectScope::LocalRead))
                }
                ("browser.service", "list" | "status" | "stop") => {
                    return Ok(CatalogEffectScope::LocalRead)
                }
                _ => {}
            }
        }
        Ok(self.entry().effect_scope)
    }

    pub(crate) fn availability(&self) -> ToolAvailability {
        self.entry().availability
    }

    pub(crate) fn logical_target(&self) -> Option<&str> {
        self.entry().logical_target.as_deref()
    }

    pub(crate) fn canonicalize(
        &self,
        raw_arguments: Value,
    ) -> Result<PreparedToolInput, ToolCatalogError> {
        match &self.entry().binding {
            ToolExecutorBinding::Artifact => {
                let targets = crate::artifact_resources::targets(self.tool_name(), &raw_arguments)
                    .map_err(|message| ToolCatalogError::new("tool_input_invalid", message))?;
                Ok(PreparedToolInput::Dynamic {
                    arguments: raw_arguments,
                    targets,
                })
            }
            ToolExecutorBinding::Process => crate::managed_processes::parse(raw_arguments)
                .map(PreparedToolInput::Process)
                .map_err(|message| ToolCatalogError::new("tool_input_invalid", message)),
            ToolExecutorBinding::Builtin { registry, .. } => registry
                .canonicalize(self.tool_name(), raw_arguments)
                .map(PreparedToolInput::Builtin)
                .map_err(|error| {
                    let message = error.to_string();
                    match error {
                        KernelToolCatalogError::InvalidArguments { issues, .. } => {
                            ToolCatalogError {
                                code: "tool_input_invalid",
                                message,
                                input_issues: Some(issues),
                            }
                        }
                        _ => ToolCatalogError::new("tool_catalog_invalid", message),
                    }
                }),
            ToolExecutorBinding::Mcp(tool) => {
                let targets = tool
                    .logical_targets(&raw_arguments)
                    .map_err(|error| ToolCatalogError::new(error.code, error.message))?;
                Ok(PreparedToolInput::Dynamic {
                    arguments: raw_arguments,
                    targets,
                })
            }
            ToolExecutorBinding::Browser(_) | ToolExecutorBinding::Desktop(_) => {
                let targets = browser_targets(self.tool_name(), &raw_arguments)?;
                Ok(PreparedToolInput::Dynamic {
                    arguments: raw_arguments,
                    targets,
                })
            }
            ToolExecutorBinding::Unavailable => Err(ToolCatalogError::new(
                "tool_blocked",
                "Execution dependency is unavailable.",
            )),
            ToolExecutorBinding::Container(_) => crate::container_tools::parse(raw_arguments)
                .map(|input| PreparedToolInput::Container {
                    input,
                    target: Value::Null,
                })
                .map_err(|message| ToolCatalogError {
                    code: "tool_input_invalid",
                    input_issues: Some(vec![ToolInputIssue::new(
                        "$",
                        "containerInput",
                        &message,
                        None,
                    )]),
                    message,
                }),
            ToolExecutorBinding::Document { .. } => documents::prepare(raw_arguments)
                .map(PreparedToolInput::Document)
                .map_err(|error| ToolCatalogError::new(error.code, error.message)),
            ToolExecutorBinding::Product(_) => {
                let targets = product_logical_targets(self.tool_name(), &raw_arguments)?;
                Ok(PreparedToolInput::Dynamic {
                    arguments: raw_arguments,
                    targets,
                })
            }
        }
    }

    pub(crate) fn invoke(
        &self,
        invocation_id: &str,
        input: PreparedToolInput,
        context: KernelToolExecutionContext,
    ) -> Result<KernelToolExecutionResult, ToolCatalogError> {
        match (&self.entry().binding, input) {
            (ToolExecutorBinding::Artifact, PreparedToolInput::Dynamic { arguments, .. }) => {
                let result =
                    crate::artifact_resources::prepare(invocation_id, &arguments, &context);
                Ok(match result {
                    Ok(output) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Completed,
                        output,
                        error: None,
                    },
                    Err(message) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: "artifact_prepare_failed".into(),
                            message,
                        }),
                    },
                })
            }

            (
                ToolExecutorBinding::Container(adapter),
                PreparedToolInput::Container { input, target },
            ) => adapter
                .invoke(invocation_id, &input, &target, &context)
                .map_err(|error| ToolCatalogError::new("container_execution_failed", error)),
            (
                ToolExecutorBinding::Browser(binding),
                PreparedToolInput::Dynamic {
                    arguments: input, ..
                },
            ) => {
                let result = crate::browser_tools::execute(
                    binding,
                    self.tool_name(),
                    input,
                    &context,
                    invocation_id,
                );
                Ok(crate::browser_tools::execution_result(
                    invocation_id,
                    result,
                ))
            }
            (ToolExecutorBinding::Desktop(run), PreparedToolInput::Dynamic { arguments, .. }) => {
                Ok(crate::browser_tools::execution_result(
                    invocation_id,
                    run.execute(arguments, &context, invocation_id),
                ))
            }
            (ToolExecutorBinding::Document { python }, PreparedToolInput::Document(input)) => {
                let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                    ToolCatalogError::new(
                        "workspace_binding_required",
                        "Document output requires a prepared workspace.",
                    )
                })?;
                let [target] = context.private_resolved_targets.as_slice() else {
                    return Err(ToolCatalogError::new(
                        "workspace_binding_invalid",
                        "Document output requires exactly one prepared destination.",
                    ));
                };
                let before = achbit_kernel_runtime::executors::capture_file_change_side(
                    std::path::Path::new(target),
                    &context,
                    0,
                    "before",
                );
                let result = documents::render(
                    &input,
                    DocumentContext {
                        invocation_id,
                        workspace_id,
                        target: std::path::Path::new(target),
                        python: python.as_deref(),
                        cancelled: &|| context.cancellation.is_cancelled(),
                    },
                );
                Ok(match result {
                    Ok(mut output) => {
                        let archived = context.output_directory.as_ref().ok_or_else(|| {
                            ToolCatalogError::new(
                                "artifact_storage_unavailable",
                                "Document archive is unavailable.",
                            )
                        })?;
                        let filename =
                            std::path::Path::new(target).file_name().ok_or_else(|| {
                                ToolCatalogError::new(
                                    "artifact_target_invalid",
                                    "Document filename is missing.",
                                )
                            })?;
                        let archived = archived.join(filename);
                        std::fs::create_dir_all(archived.parent().expect("artifact parent"))
                            .and_then(|_| std::fs::copy(target, &archived))
                            .map_err(|error| {
                                ToolCatalogError::new("artifact_archive_failed", error.to_string())
                            })?;
                        output["artifacts"][0]["contentRef"] = json!(archived);
                        output["artifacts"][0]["contentMode"] = json!("fixed");
                        output["artifacts"][0]["uri"] =
                            json!(format!("artifact://artifact:{invocation_id}"));
                        let after = json!({"exists":true,"contentRef":archived,"sizeBytes":output["sizeBytes"]});
                        output["fileChanges"] =
                            json!([achbit_kernel_runtime::executors::file_change_fact(
                                &context,
                                &input.path,
                                before,
                                after
                            )
                            .map_err(|error| ToolCatalogError::new(
                                "file_change_failed",
                                error.to_string()
                            ))?]);
                        KernelToolExecutionResult {
                            invocation_id: invocation_id.into(),
                            outcome: KernelToolExecutionOutcome::Completed,
                            output,
                            error: None,
                        }
                    }
                    Err(error) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: error.code.into(),
                            message: error.message,
                        }),
                    },
                })
            }
            (ToolExecutorBinding::Builtin { executors, .. }, PreparedToolInput::Builtin(input)) => {
                executors
                    .invoke(
                        KernelToolInvocation {
                            id: invocation_id.to_string(),
                            input,
                        },
                        context,
                    )
                    .or_else(|error| {
                        let (code, output) = match &error {
                            achbit_kernel_abi::KernelError::Structured {
                                code,
                                stage,
                                details,
                                ..
                            } => (
                                (*code).to_string(),
                                json!({"stage": stage, "details": details}),
                            ),
                            _ => ("tool_execution_failed".to_string(), Value::Null),
                        };
                        Ok(KernelToolExecutionResult {
                            invocation_id: invocation_id.to_string(),
                            outcome: KernelToolExecutionOutcome::Failed,
                            output,
                            error: Some(KernelToolExecutionFailure {
                                code,
                                message: error.to_string(),
                            }),
                        })
                    })
            }
            (
                ToolExecutorBinding::Product(product),
                PreparedToolInput::Dynamic {
                    arguments: input, ..
                },
            ) => {
                let result = product.call(self.tool_name(), input);
                Ok(match result {
                    Ok(output) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Completed,
                        output,
                        error: None,
                    },
                    Err(error) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: error.code,
                            message: error.message,
                        }),
                    },
                })
            }
            (
                ToolExecutorBinding::Mcp(tool),
                PreparedToolInput::Dynamic {
                    arguments: input, ..
                },
            ) => tool
                .call(input, &context)
                .map(|result| {
                    let error = result.failure.map(|failure| KernelToolExecutionFailure {
                        code: failure.code,
                        message: failure.message,
                    });
                    crate::tool_images::archive_result_images(
                        KernelToolExecutionResult {
                            invocation_id: invocation_id.into(),
                            outcome: if error.is_some() {
                                KernelToolExecutionOutcome::Failed
                            } else {
                                KernelToolExecutionOutcome::Completed
                            },
                            output: result.output,
                            error,
                        },
                        &context,
                    )
                })
                .map_err(|error| ToolCatalogError::new(error.code, error.message)),
            _ => Err(ToolCatalogError::new(
                "tool_binding_mismatch",
                "Prepared input does not match its executor binding.",
            )),
        }
    }

    pub(crate) fn begin_attempt(&self) -> Result<PhysicalAttemptLease, ToolCatalogError> {
        self.snapshot.resources.acquire()?;
        Ok(PhysicalAttemptLease {
            snapshot: Arc::clone(&self.snapshot),
        })
    }
}

pub(crate) struct PhysicalAttemptLease {
    snapshot: Arc<ToolCatalogSnapshot>,
}

impl Drop for PhysicalAttemptLease {
    fn drop(&mut self) {
        // release caches the original disposal result. The next retire or final run release
        // reports it without changing this attempt's canonical effect outcome.
        let _ = self.snapshot.resources.release();
    }
}

fn browser_targets(name: &str, input: &Value) -> Result<Vec<String>, ToolCatalogError> {
    let text = |key: &str| {
        input[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ToolCatalogError::new("tool_input_invalid", format!("{key} is required"))
            })
    };
    let object = input.as_object().ok_or_else(|| {
        ToolCatalogError::new("tool_input_invalid", "Browser arguments must be an object.")
    })?;
    if name == "browser.open" {
        if object.keys().any(|key| key != "path") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Only a workspace-relative path is accepted.",
            ));
        }
        return Ok(vec![text("path")?.into()]);
    }
    if name == "browser.observe" {
        if object.keys().any(|key| key != "previewId") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Only previewId is accepted.",
            ));
        }
        return Ok(vec![format!("browser:{}", text("previewId")?)]);
    }
    if name == "computer.control" {
        crate::browser_tools::validate_computer_input(input)
            .map_err(|error| ToolCatalogError::new("tool_input_invalid", error))?;
        return Ok(vec![format!(
            "computer:{}",
            input["app"].as_str().unwrap_or("desktop")
        )]);
    }
    if name == "browser.service" {
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "action" | "serviceId" | "directory" | "command" | "args" | "url"
            )
        }) {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported service argument.",
            ));
        }
        let action = text("action")?;
        if !matches!(action, "start" | "stop" | "list" | "status") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported service action.",
            ));
        }
        if action == "start" {
            text("command")?;
            text("directory")?;
            text("url")?;
            if !input["args"]
                .as_array()
                .is_some_and(|args| args.iter().all(Value::is_string))
            {
                return Err(ToolCatalogError::new(
                    "tool_input_invalid",
                    "args must be an array of strings.",
                ));
            }
        } else if action != "list" {
            text("serviceId")?;
        }
        return Ok(vec![format!(
            "browser:service:{}",
            input["serviceId"].as_str().unwrap_or(action)
        )]);
    }
    if name == "browser.capture" {
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "previewId" | "path"))
        {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported capture argument.",
            ));
        }
        text("previewId")?;
        let path = text("path")?;
        if !path.to_ascii_lowercase().ends_with(".png") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Screenshot path must end in .png.",
            ));
        }
        return Ok(vec![path.into()]);
    }
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "action"
                | "previewId"
                | "url"
                | "filePath"
                | "serviceId"
                | "operation"
                | "selector"
                | "text"
                | "x"
                | "y"
        )
    }) {
        return Err(ToolCatalogError::new(
            "tool_input_invalid",
            "Unsupported browser argument.",
        ));
    }
    let action = text("action")?;
    if !matches!(
        action,
        "open"
            | "openSelf"
            | "list"
            | "status"
            | "activate"
            | "navigate"
            | "reload"
            | "act"
            | "close"
            | "refreshInterface"
    ) {
        return Err(ToolCatalogError::new(
            "tool_input_invalid",
            "Unsupported browser action.",
        ));
    }
    if matches!(action, "open" | "navigate") && !input["serviceId"].is_string() {
        if input["filePath"].is_string() {
            text("filePath")?;
        } else {
            text("url")?;
        }
    }
    if !matches!(action, "open" | "openSelf" | "list" | "refreshInterface") {
        text("previewId")?;
    }
    if action == "act" {
        let operation = text("operation")?;
        if !matches!(operation, "inspect" | "click" | "type" | "scroll") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported browser operation.",
            ));
        }
        if operation == "type" || (operation == "click" && input["selector"].is_string()) {
            text("selector")?;
        }
        for axis in ["x", "y"] {
            let required = operation == "click" && !input["selector"].is_string();
            if (required || input.get(axis).is_some())
                && !input[axis].as_f64().is_some_and(|value| {
                    value.is_finite() && (operation != "click" || value >= 0.0)
                })
            {
                return Err(ToolCatalogError::new(
                    "tool_input_invalid",
                    format!("{axis} must be a finite viewport coordinate"),
                ));
            }
        }
        if operation == "type" && !input["text"].is_string() {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "text is required",
            ));
        }
    }
    Ok(vec![format!(
        "browser:{}",
        input["previewId"].as_str().unwrap_or("pages")
    )])
}

fn product_logical_targets(name: &str, input: &Value) -> Result<Vec<String>, ToolCatalogError> {
    if name == "plugin.search" {
        return Ok(vec!["plugin-catalog".into()]);
    }
    let field = if name == "session.read" {
        "sessionId"
    } else {
        "name"
    };
    let id = input
        .get(field)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            ToolCatalogError::new("tool_input_invalid", format!("{field} is required"))
        })?;
    Ok(vec![if name == "session.read" {
        id.to_string()
    } else {
        format!("skill:{id}")
    }])
}

fn possible_effects(
    effect_class: Option<ToolEffectClass>,
    scope: CatalogEffectScope,
) -> Vec<&'static str> {
    match scope {
        CatalogEffectScope::LocalRead => vec!["localRead"],
        CatalogEffectScope::WorkspaceRead => vec!["workspaceRead"],
        CatalogEffectScope::WorkspaceMutation => vec!["workspaceMutation"],
        CatalogEffectScope::Process => vec!["process", "workspaceMutation", "external"],
        CatalogEffectScope::Network => match effect_class {
            Some(ToolEffectClass::Mutation) => vec!["network", "external"],
            _ => vec!["network"],
        },
        CatalogEffectScope::External => vec!["external"],
    }
}

fn availability_name(availability: ToolAvailability) -> &'static str {
    match availability {
        ToolAvailability::Callable => "callable",
        ToolAvailability::Blocked => "blocked",
    }
}

fn rollback_installation(
    mut failure: ToolCatalogError,
    disposers: Vec<ExactDisposer>,
) -> ToolCatalogError {
    for dispose in disposers.into_iter().rev() {
        if let Err(error) = dispose() {
            failure.message.push_str(&format!(
                "；初始化回滚清理失败 {}: {}",
                error.code, error.message
            ));
        }
    }
    failure
}

fn validate_ref(field: &str, value: &str) -> Result<(), ToolCatalogError> {
    if value.is_empty() || value.len() > 192 || value.chars().any(char::is_control) {
        return Err(ToolCatalogError::new(
            "tool_catalog_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use achbit_kernel_runtime::executors::EmptySecretProvider;

    struct DesktopStatus(bool);
    impl crate::desktop_tools::DesktopExecutor for DesktopStatus {
        fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
            assert_eq!(
                binding,
                &json!({"hostInstanceId":"desktop:test","sessionId":"session:test","runId":"run:test"})
            );
            assert_eq!(input, &json!({"action":"computer:status"}));
            if !self.0 {
                return Err("native helper unavailable".into());
            }
            Ok(
                json!({"ok":true,"data":{"platform":"native-test","permissions":{"accessibility":true}}}),
            )
        }
        fn stop(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn desktop_status(ready: bool) -> crate::desktop_tools::DesktopRun {
        crate::desktop_tools::DesktopHost::for_test("desktop:test", Arc::new(DesktopStatus(ready)))
            .run("session:test", "run:test")
    }

    #[tokio::test]
    async fn native_catalog_uses_independent_desktop_and_gui_capabilities() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};

        for (case, capture, computer) in [(1, false, true), (2, true, true), (3, true, false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let host_id = format!("dcinstance_{case:064x}");
            let token = format!("dchost_{case:064x}");
            let registration = json!({
                "hostInstanceId": host_id, "endpoint": address.to_string(),
                "callbackToken": token, "remove": false,
            });
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                // Registration and catalog installation each query the same Host.
                for _ in 0..2 {
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(Instant::now() < deadline, "Host request timed out");
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            Err(error) => panic!("Host accept: {error}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = String::new();
                    BufReader::new(&stream).read_line(&mut request).unwrap();
                    let request: Value = serde_json::from_str(&request).unwrap();
                    assert_eq!(request["input"]["action"], "hostStatus");
                    assert_eq!(request["token"], token);
                    writeln!(
                        stream,
                        "{}",
                        json!({"ok":true,"data":{
                            "binding":request["binding"], "ready":true,
                            "captureAvailable":capture,
                        }})
                    )
                    .unwrap();
                }
            });
            let registered = crate::browser_tools::register(axum::Json(
                serde_json::from_value(registration.clone()).unwrap(),
            ))
            .await;
            let mut product = crate::local_agent_product_tools::test_product_tools();
            let config = Arc::get_mut(&mut product).unwrap();
            config.browser_binding = Some(json!({"hostInstanceId":host_id,"windowLabel":"main"}));
            config.computer_use_instance = Some(format!("plugin-instance:computer-use-{case}"));
            config.desktop = Some(desktop_status(computer));
            let catalog = ToolCatalogSnapshot::from_providers(
                "extension-generation:browser-capabilities",
                vec![Box::new(ProductToolProvider(product))],
            );
            let mut removal = registration;
            removal["remove"] = json!(true);
            let removed = crate::browser_tools::register(axum::Json(
                serde_json::from_value(removal).unwrap(),
            ))
            .await;
            server.join().unwrap();
            assert_eq!(registered.0["ok"], true);
            assert_eq!(removed.0["ok"], true);
            let catalog = catalog.unwrap();
            let view = catalog.provider_view();
            for (name, expected) in [
                ("browser.open", true),
                ("browser.page", true),
                ("browser.service", true),
                ("browser.observe", capture),
                ("browser.capture", capture),
                ("computer.control", computer),
            ] {
                let tool = view
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tool| tool["name"] == name)
                    .unwrap();
                assert_eq!(
                    tool["availability"],
                    if expected { "callable" } else { "blocked" },
                    "{name}"
                );
                assert_eq!(
                    tool.get("availabilityReason").is_some(),
                    !expected,
                    "{name}"
                );
                if !expected {
                    assert!(!tool["availabilityReason"]["message"]
                        .as_str()
                        .unwrap()
                        .is_empty());
                }
                if name == "computer.control" && expected {
                    assert_eq!(tool["runtimeStatus"]["permissions"]["accessibility"], true);
                }
            }
            catalog.dispose().unwrap();
        }
    }

    #[test]
    fn desktop_without_gui_is_callable_and_embedded_browser_is_explicitly_blocked() {
        let mut product = crate::local_agent_product_tools::test_product_tools();
        let config = Arc::get_mut(&mut product).unwrap();
        config.computer_use_instance = Some("plugin-instance:computer-use".into());
        config.desktop = Some(desktop_status(true));
        let catalog = ToolCatalogSnapshot::from_providers(
            "extension-generation:desktop",
            vec![Box::new(ProductToolProvider(product))],
        )
        .unwrap();
        let view = catalog.provider_view();
        for tool in view
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool["pluginUri"] == "plugin://computer-use@builtin")
        {
            if tool["name"] == "computer.control" {
                assert_eq!(tool["availability"], "callable");
                assert_eq!(tool["runtimeStatus"]["platform"], "native-test");
            } else {
                assert_eq!(tool["availability"], "blocked");
                assert_eq!(
                    tool["availabilityReason"]["code"],
                    "gui_browser_unavailable"
                );
                assert_eq!(
                    tool["availabilityReason"]["message"],
                    "This run has no GUI window for embedded browser tools."
                );
            }
        }
        catalog.dispose().unwrap();
    }

    #[test]
    fn browser_targets_support_coordinates_and_guarded_interface_refresh() {
        for input in [
            json!({"action":"act","previewId":"preview-1","operation":"click","x":12,"y":20}),
            json!({"action":"act","previewId":"preview-1","operation":"click","selector":"#save"}),
            json!({"action":"act","previewId":"preview-1","operation":"scroll","selector":"#panel","y":-40}),
            json!({"action":"refreshInterface"}),
        ] {
            assert!(browser_targets("browser.page", &input).is_ok(), "{input}");
        }
        for input in [
            json!({"action":"act","previewId":"preview-1","operation":"click","x":12}),
            json!({"action":"act","previewId":"preview-1","operation":"click","x":-1,"y":20}),
            json!({"action":"act","previewId":"preview-1","operation":"type","text":"hello"}),
            json!({"action":"act","previewId":"preview-1","operation":"unknown"}),
        ] {
            assert!(browser_targets("browser.page", &input).is_err(), "{input}");
        }
    }

    #[test]
    fn default_builtin_provider_exposes_the_registered_basic_tools_and_blocks_web_search() {
        let provider = BuiltinToolProvider::prepare(
            KernelExecutorConfig::default(),
            Arc::new(EmptySecretProvider),
            true,
        )
        .expect("prepare builtin provider");
        let installed = Box::new(provider)
            .install()
            .expect("install builtin provider");
        let mut names = installed
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();

        assert_eq!(
            names,
            [
                "bash",
                "fs.delete",
                "fs.edit",
                "fs.read",
                "fs.write",
                "powershell",
                "web.fetch",
                "web.search",
            ]
        );
        for tool in &installed.tools {
            assert!(tool.input_schema["properties"].get("workspaceId").is_none());
        }
        assert_eq!(
            installed
                .tools
                .iter()
                .find(|tool| tool.name == "web.search")
                .expect("web.search contribution")
                .availability,
            ToolAvailability::Blocked
        );
        (installed.dispose)().expect("dispose builtin provider");
    }

    #[test]
    fn web_search_is_callable_with_brave_secret_ref_or_explicit_endpoint() {
        for executor_config in [
            KernelExecutorConfig {
                web_search_endpoint_template: String::new(),
                web_search_auth_header_name: "Authorization".to_string(),
                web_search_auth_secret_ref: "local-secret:brave".to_string(),
                ..Default::default()
            },
            KernelExecutorConfig {
                web_search_endpoint_template: "https://search.example/v1?q={query}&limit={limit}"
                    .to_string(),
                web_search_auth_header_name: "Authorization".to_string(),
                web_search_auth_secret_ref: String::new(),
                ..Default::default()
            },
        ] {
            let provider =
                BuiltinToolProvider::prepare(executor_config, Arc::new(EmptySecretProvider), true)
                    .expect("prepare builtin provider");
            let installed = Box::new(provider)
                .install()
                .expect("install builtin provider");
            assert_eq!(
                installed
                    .tools
                    .iter()
                    .find(|tool| tool.name == "web.search")
                    .expect("web.search contribution")
                    .availability,
                ToolAvailability::Callable
            );
            (installed.dispose)().expect("dispose builtin provider");
        }
    }

    #[test]
    fn run_owner_can_disable_kernel_search_before_catalog_snapshot_is_built() {
        let provider = BuiltinToolProvider::prepare(
            KernelExecutorConfig {
                web_search_endpoint_template: String::new(),
                web_search_auth_header_name: "X-Subscription-Token".to_string(),
                web_search_auth_secret_ref: "local-secret:brave".to_string(),
                ..Default::default()
            },
            Arc::new(EmptySecretProvider),
            false,
        )
        .expect("prepare builtin provider");
        let installed = Box::new(provider)
            .install()
            .expect("install builtin provider");

        assert_eq!(
            installed
                .tools
                .iter()
                .find(|tool| tool.name == "web.search")
                .expect("web.search contribution")
                .availability,
            ToolAvailability::Blocked
        );
        (installed.dispose)().expect("dispose builtin provider");
    }
}
