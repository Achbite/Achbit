use crate::command_denylist::CommandDenylist;
#[cfg(feature = "debug-control")]
pub(crate) mod debug_operations;
mod file_mutations;
mod file_permissions;
use crate::local_agent_mcp::McpRuntime;
use crate::local_agent_store::{LocalAgentJournal, LocalAgentStoreError};
use crate::local_agent_tool_catalog::{
    CatalogEffectScope, CatalogRetirement, PhysicalAttemptLease, PreparedCatalogBinding,
    PreparedToolInput, ToolCatalogError, ToolCatalogSnapshot,
};
use achbit_kernel_runtime::executors::{
    resolved_network_target, KernelCancellationToken, KernelExecutorConfig,
    KernelToolExecutionContext, KernelToolExecutionOutcome, KernelToolExecutionResult,
    SecretProvider,
};
use achbit_kernel_runtime::file_access::FileAccessScope;
use achbit_kernel_runtime::workspace_boundary::WorkspaceBoundary;
use achbit_kernel_tools::kernel_internal::{
    KernelCanonicalInvocation, KernelDeleteTarget, KernelExecutionScope, KernelWorkspaceMode,
};
use achbit_kernel_tools::{ToolAvailability, ToolInputIssue};
use file_mutations::{FileMutationLocks, PreparedFileCall};
use file_permissions::RequestedFiles;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const KERNEL_REQUEST_VERSION: &str = "achbit.kernel-request";
const KERNEL_REPLY_VERSION: &str = "achbit.kernel-reply";
const TOOL_RECORD_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/tool-record.sql");
const TOOL_RECORD_STORE_VERSION: u32 = 1;
const ATTEMPT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanAdmissionRequest {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) mutation_manifest: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalAgentKernelError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    input_issues: Option<Vec<ToolInputIssue>>,
}

impl LocalAgentKernelError {
    fn input(path: &str, rule: &str, message: &str, expected: Option<Value>) -> Self {
        Self {
            code: "tool_input_invalid",
            message: message.into(),
            input_issues: Some(vec![ToolInputIssue::new(path, rule, message, expected)]),
        }
    }
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_issues: None,
        }
    }
}

impl From<LocalAgentStoreError> for LocalAgentKernelError {
    fn from(value: LocalAgentStoreError) -> Self {
        Self::new(value.code, value.message)
    }
}

#[derive(Clone)]
pub(crate) enum WorkspaceAccess {
    Project,
    SessionInput(String),
    SessionWorkdir(String),
}

impl WorkspaceAccess {
    fn owner_session_id(&self) -> Option<&str> {
        match self {
            Self::Project => None,
            Self::SessionInput(owner) | Self::SessionWorkdir(owner) => Some(owner),
        }
    }

    fn read_only(&self) -> bool {
        matches!(self, Self::SessionInput(_))
    }
}

pub(crate) struct ResolvedWorkspace {
    pub root: String,
    pub access: WorkspaceAccess,
}

pub(crate) trait WorkspaceResolverPort: Send + Sync {
    fn resolve(&self, workspace_id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError>;
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceResolver {
    gui: Arc<Mutex<crate::GuiState>>,
}

impl HostWorkspaceResolver {
    pub(crate) fn new(gui: Arc<Mutex<crate::GuiState>>) -> Self {
        Self { gui }
    }
}

impl WorkspaceResolverPort for HostWorkspaceResolver {
    fn resolve(&self, workspace_id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
        validate_id("workspaceId", workspace_id)?;
        let gui = self.gui.lock().map_err(|_| {
            LocalAgentKernelError::new(
                "workspace_catalog_lock_failed",
                "Workspace Catalog 锁已损坏。",
            )
        })?;
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return Err(LocalAgentKernelError::new(
                "workspace_catalog_unavailable",
                error,
            ));
        }
        gui.conversation_catalog
            .workspace(workspace_id)
            .map(|workspace| ResolvedWorkspace {
                root: workspace.canonical_root.clone(),
                access: match &workspace.owner_session_id {
                    Some(owner) if workspace.session_workdir => {
                        WorkspaceAccess::SessionWorkdir(owner.clone())
                    }
                    Some(owner) => WorkspaceAccess::SessionInput(owner.clone()),
                    None => WorkspaceAccess::Project,
                },
            })
            .ok_or_else(|| {
                LocalAgentKernelError::new(
                    "workspace_not_found",
                    format!("Workspace 不存在：{workspace_id}"),
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionMode {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellApprovalMode {
    Ask,
    Review,
    Allow,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellCommandRule {
    decision: String,
    context: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceMutationMode {
    Plan,
    Review,
    Allow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedEffectScope {
    LocalRead,
    WorkspaceRead,
    WorkspaceMutation,
    Process,
    Network,
    External,
}

/// The Kernel applies user policy to prepared tools. Shell capabilities are
/// selected here, never from model-supplied permission switches.
#[derive(Debug, Clone)]
pub(crate) struct LocalAgentPermissionPolicy {
    pub(crate) constraints: crate::local_agent_recipe::PolicyConstraints,
    workspace_mutation: WorkspaceMutationMode,
    shell: ShellApprovalMode,
    shell_full_access: bool,
    command_rules: Vec<ShellCommandRule>,
    pub(crate) settings: Value,
    network: PermissionMode,
    external: PermissionMode,
    command_denylist: CommandDenylist,
}

impl LocalAgentPermissionPolicy {
    pub(crate) fn from_settings(settings: &Value) -> Result<Self, LocalAgentKernelError> {
        let shell = match settings.get("agent.permissions.shell") {
            None => ShellApprovalMode::Ask,
            Some(value) => match value.as_str() {
                Some("ask") => ShellApprovalMode::Ask,
                Some("review") => ShellApprovalMode::Review,
                Some("allow") => ShellApprovalMode::Allow,
                _ => {
                    return Err(LocalAgentKernelError::new(
                        "agent_permission_setting_invalid",
                        "Shell 审批必须是 ask、review 或 allow。",
                    ))
                }
            },
        };
        let shell_full_access = match settings.get("agent.permissions.shellAccess") {
            None => false,
            Some(value) => match value.as_str() {
                Some("workspace") => false,
                Some("full") => true,
                _ => {
                    return Err(LocalAgentKernelError::new(
                        "agent_permission_setting_invalid",
                        "Shell 范围必须是 workspace 或 full。",
                    ))
                }
            },
        };
        let encoded = settings
            .get("agent.permissions.commandRules")
            .map(|value| {
                value.as_str().ok_or_else(|| {
                    LocalAgentKernelError::new(
                        "agent_permission_setting_invalid",
                        "命令规则必须是 JSON 字符串。",
                    )
                })
            })
            .transpose()?
            .unwrap_or("[]");
        if let Some(roots) = settings.get("agent.permissions.runtimeReadRoots") {
            let valid = roots.as_array().is_some_and(|roots| {
                roots.iter().all(|root| {
                    root.as_str()
                        .is_some_and(|path| Path::new(path).is_absolute())
                })
            });
            if !valid {
                return Err(LocalAgentKernelError::new(
                    "runtime_read_roots_invalid",
                    "运行依赖目录必须是绝对路径数组。",
                ));
            }
        }
        let command_rules: Vec<ShellCommandRule> =
            serde_json::from_str(encoded).map_err(|error| {
                LocalAgentKernelError::new(
                    "agent_permission_setting_invalid",
                    format!("命令规则无效：{error}"),
                )
            })?;
        if command_rules.len() > 256
            || command_rules.iter().any(|rule| {
                rule.context["command"]
                    .as_str()
                    .is_none_or(|command| command.trim().is_empty() || command.len() > 16384)
                    || rule.context["workspaceId"]
                        .as_str()
                        .is_none_or(str::is_empty)
                    || !rule.context["environment"].is_object()
                    || !matches!(rule.decision.as_str(), "allow" | "ask" | "deny")
            })
        {
            return Err(LocalAgentKernelError::new(
                "agent_permission_setting_invalid",
                "命令规则的命令、环境或决定无效。",
            ));
        }
        Ok(Self {
            constraints: Default::default(),
            shell,
            shell_full_access,
            command_rules,
            settings: settings.clone(),
            workspace_mutation: workspace_mutation_mode(settings)?,
            network: permission_mode(
                settings,
                "agent.permissions.networkRead",
                PermissionMode::Allow,
            )?,
            external: permission_mode(settings, "agent.permissions.external", PermissionMode::Ask)?,
            command_denylist: CommandDenylist::from_settings(settings).map_err(|message| {
                LocalAgentKernelError::new("agent_permission_setting_invalid", message)
            })?,
        })
    }

    fn with_constraints(
        mut self,
        constraints: crate::local_agent_recipe::PolicyConstraints,
    ) -> Self {
        self.constraints = constraints;
        self
    }

    fn mode(&self, scope: PreparedEffectScope) -> Option<PermissionMode> {
        match scope {
            PreparedEffectScope::Network => Some(self.network),
            PreparedEffectScope::External => Some(self.external),
            PreparedEffectScope::LocalRead
            | PreparedEffectScope::WorkspaceRead
            | PreparedEffectScope::WorkspaceMutation
            | PreparedEffectScope::Process => None,
        }
    }

    pub(crate) fn network_mode(&self) -> PermissionMode {
        self.network
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalToolExecutionRequest {
    schema_version: String,
    #[serde(rename = "type")]
    request_type: String,
    request_id: String,
    session_id: String,
    run_id: String,
    extension_generation_ref: String,
    kernel_catalog_snapshot_ref: String,
    tool_binding_ref: String,
    pub(crate) call_id: String,
    pub(crate) attempt_id: String,
    tool_name: String,
    input: Value,
    workspace_bindings: Vec<String>,
    #[serde(default)]
    plan_authorities: Vec<Value>,
    non_workspace_authority: Option<NonWorkspaceAuthority>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalToolPreparationRequest {
    pub(crate) requests: Vec<LocalToolExecutionRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareToolCatalogRequest {
    session_id: String,
    run_id: String,
    extension_generation_ref: String,
}

impl PrepareToolCatalogRequest {
    pub(crate) fn new(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        extension_generation_ref: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.into(),
            extension_generation_ref: extension_generation_ref.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseToolCatalogRequest {
    session_id: String,
    run_id: String,
    kernel_catalog_snapshot_ref: String,
}

impl ReleaseToolCatalogRequest {
    pub(crate) fn new(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        kernel_catalog_snapshot_ref: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.into(),
            kernel_catalog_snapshot_ref: kernel_catalog_snapshot_ref.into(),
        }
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn kernel_catalog_snapshot_ref(&self) -> &str {
        &self.kernel_catalog_snapshot_ref
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NonWorkspaceAuthority {
    authority_id: String,
    decision: String,
}

#[derive(Clone)]
pub(crate) struct LocalAgentKernel {
    output_root: PathBuf,
    clock: Arc<KernelClock>,
    measurements: Arc<Mutex<HashMap<String, Value>>>,
    #[cfg(feature = "debug-control")]
    debug: Arc<debug_operations::DebugOperations>,
    records: LocalToolRecordStore,
    journal: LocalAgentJournal,
    resolver: Arc<dyn WorkspaceResolverPort>,
    generations: Arc<Mutex<KernelGenerationState>>,
    active: Arc<Mutex<HashMap<String, ActiveCall>>>,
    file_mutations: Arc<FileMutationLocks>,
    prepared_file_calls: Arc<Mutex<HashMap<String, PreparedFileCall>>>,
    pub(crate) jobs: crate::managed_processes::Jobs,
    pub(crate) desktop: Arc<crate::desktop_tools::DesktopHost>,
}

struct KernelClock {
    origin: Instant,
    domain: String,
}

#[derive(Clone)]
pub(crate) struct PreparedKernelGeneration {
    generation: Arc<KernelGeneration>,
}

struct KernelGeneration {
    catalog: Arc<ToolCatalogSnapshot>,
    executor_config: KernelExecutorConfig,
    permissions: LocalAgentPermissionPolicy,
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct RunCatalogKey {
    session_id: String,
    run_id: String,
    snapshot_ref: String,
}

struct KernelGenerationState {
    run_bindings: HashMap<RunCatalogKey, Arc<KernelGeneration>>,
    released_run_bindings: HashMap<RunCatalogKey, ReleasedRunBinding>,
}

struct ReleasedRunBinding {
    retirement: Option<CatalogRetirement>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum ActivePhase {
    #[default]
    Prepared,
    Executing,
}

#[derive(Clone)]
struct ActiveCall {
    request: LocalToolExecutionRequest,
    control: AttemptControl,
}

#[derive(Default)]
struct AttemptCompletion {
    phase: ActivePhase,
    cancel_phase: Option<ActivePhase>,
    outcome_claimed: bool,
    complete: bool,
}

#[derive(Clone, Default)]
struct AttemptControl {
    cancellation: KernelCancellationToken,
    completion: Arc<(Mutex<AttemptCompletion>, Condvar)>,
}

impl AttemptControl {
    fn cancellation(&self) -> KernelCancellationToken {
        self.cancellation.clone()
    }

    fn start_execution(&self) -> bool {
        let (state, _) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.cancel_phase.is_some() || state.outcome_claimed || state.complete {
            return false;
        }
        state.phase = ActivePhase::Executing;
        true
    }

    fn request_cancel(&self) {
        let (state, _) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.outcome_claimed || state.complete {
            return;
        }
        let phase = state.phase;
        state.cancel_phase.get_or_insert(phase);
        self.cancellation.cancel();
    }

    fn claim_outcome(&self) -> Option<ActivePhase> {
        let (state, _) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.outcome_claimed = true;
        state.cancel_phase
    }

    fn finish(&self) {
        let (state, complete) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.complete = true;
        complete.notify_all();
    }

    fn completed_before_execution(&self) -> bool {
        let (state, _) = self.completion.as_ref();
        let state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.complete && state.phase == ActivePhase::Prepared
    }

    fn wait_complete(&self, timeout: Duration) -> bool {
        let (state, complete) = self.completion.as_ref();
        let state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.complete {
            return true;
        }
        let (state, _) = complete
            .wait_timeout_while(state, timeout, |state| !state.complete)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.complete
    }
}

impl LocalAgentKernel {
    pub(crate) fn open(
        record_path: &Path,
        journal: LocalAgentJournal,
        resolver: Arc<dyn WorkspaceResolverPort>,
    ) -> Result<Self, LocalAgentKernelError> {
        Ok(Self {
            records: LocalToolRecordStore::open(record_path)?,
            output_root: record_path.with_extension("outputs"),
            clock: Arc::new(KernelClock {
                origin: Instant::now(),
                domain: random_id("kernel-clock")?,
            }),
            measurements: Arc::default(),
            #[cfg(feature = "debug-control")]
            debug: Arc::default(),
            journal,
            resolver,
            generations: Arc::new(Mutex::new(KernelGenerationState {
                run_bindings: HashMap::new(),
                released_run_bindings: HashMap::new(),
            })),
            active: Arc::new(Mutex::new(HashMap::new())),
            file_mutations: Arc::default(),
            prepared_file_calls: Arc::default(),
            jobs: Default::default(),
            desktop: Arc::new(crate::desktop_tools::DesktopHost::unbound()),
        })
    }

    pub(crate) fn prepare_generation(
        extension_generation_ref: &str,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        mcp: McpRuntime,
        permissions: LocalAgentPermissionPolicy,
        selection: &crate::local_agent_recipe::ToolSelection,
        enable_web_search: bool,
        product: Arc<crate::local_agent_product_tools::ProductTools>,
    ) -> Result<PreparedKernelGeneration, LocalAgentKernelError> {
        let catalog = ToolCatalogSnapshot::prepare(
            extension_generation_ref,
            executor_config.clone(),
            secret_provider,
            mcp,
            enable_web_search,
            product,
            selection,
        )
        .map_err(catalog_error)?;
        Ok(PreparedKernelGeneration {
            generation: Arc::new(KernelGeneration {
                catalog,
                executor_config,
                permissions,
            }),
        })
    }

    pub(crate) fn bind_run_catalog(
        &self,
        request: PrepareToolCatalogRequest,
        prepared: PreparedKernelGeneration,
    ) -> Result<Value, LocalAgentKernelError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
            (
                "extensionGenerationRef",
                request.extension_generation_ref.as_str(),
            ),
        ] {
            validate_id(field, value)?;
        }
        let generation = prepared.generation;
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
            snapshot_ref: generation.catalog.snapshot_ref().to_string(),
        };
        {
            let mut state = self.lock_generations()?;
            if state.released_run_bindings.contains_key(&key) {
                return Err(LocalAgentKernelError::new(
                    "tool_catalog_run_already_released",
                    "当前 run 的 catalog lease 已经释放，不能重新获取。",
                ));
            }
            if let Some(existing) = state.run_bindings.get(&key) {
                if existing.catalog.extension_generation_ref() != request.extension_generation_ref
                    || existing.catalog.snapshot_ref() != generation.catalog.snapshot_ref()
                {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_run_identity_conflict",
                        "当前 run 已固定到其他 ExtensionGenerationRef 或 catalog snapshot。",
                    ));
                }
            } else {
                if generation.catalog.extension_generation_ref() != request.extension_generation_ref
                {
                    return Err(LocalAgentKernelError::new(
                        "extension_generation_identity_conflict",
                        "Prepared generation 与请求的 ExtensionGenerationRef 不一致。",
                    ));
                }
                state.run_bindings.insert(key, Arc::clone(&generation));
            }
        }
        Ok(catalog_prepare_reply(&request, &generation.catalog))
    }

    /// Session calls only after old logical requests and approvals have settled.
    /// Physical attempts/jobs retain their existing lease; this never cancels them.
    pub(crate) fn retire_tool_views(
        &self,
        session_id: &str,
        run_id: &str,
        keep_catalog_ref: &str,
    ) -> Result<(), LocalAgentKernelError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        validate_id("keepKernelCatalogSnapshotRef", keep_catalog_ref)?;
        let mut state = self.lock_generations()?;
        let keep = RunCatalogKey {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            snapshot_ref: keep_catalog_ref.to_owned(),
        };
        if !state.run_bindings.contains_key(&keep) {
            return Err(LocalAgentKernelError::new(
                "tool_catalog_keep_binding_missing",
                "当前请求保留的工具视图不存在或已退役。",
            ));
        }
        let keys: Vec<_> = state
            .run_bindings
            .keys()
            .filter(|key| key.session_id == session_id && key.run_id == run_id && **key != keep)
            .cloned()
            .collect();
        for key in keys {
            let generation = state
                .run_bindings
                .remove(&key)
                .expect("selected binding exists");
            let still_pinned = state
                .run_bindings
                .values()
                .any(|candidate| Arc::ptr_eq(candidate, &generation));
            let retirement = (!still_pinned).then(|| generation.catalog.retirement());
            state
                .released_run_bindings
                .insert(key, ReleasedRunBinding { retirement });
        }
        let mut errors = Vec::new();
        for (key, released) in &state.released_run_bindings {
            if key.session_id == session_id && key.run_id == run_id {
                if let Some(retirement) = &released.retirement {
                    if let Err(error) = retirement.retire() {
                        errors.push(format!("{}: {}", error.code, error.message));
                    }
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(LocalAgentKernelError::new(
                "tool_view_retire_failed",
                errors.join("；"),
            ))
        }
    }

    pub(crate) fn release_catalog(
        &self,
        request: ReleaseToolCatalogRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
            (
                "kernelCatalogSnapshotRef",
                request.kernel_catalog_snapshot_ref.as_str(),
            ),
        ] {
            validate_id(field, value)?;
        }
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
            snapshot_ref: request.kernel_catalog_snapshot_ref.clone(),
        };
        {
            let state = self.lock_generations()?;
            if !state.run_bindings.contains_key(&key)
                && !state.released_run_bindings.contains_key(&key)
            {
                return Err(LocalAgentKernelError::new(
                    "tool_catalog_run_binding_not_found",
                    "当前 run 的物理 catalog 绑定已丢失，无法确认旧实例已经释放。",
                ));
            }
        }
        // Final run cleanup still drains jobs even when the requested initial view retired earlier.
        self.cancel_and_drain_attempts(Some((&request.session_id, &request.run_id)))?;
        self.release_prepared_file_calls(Some((&request.session_id, &request.run_id)))?;
        self.jobs
            .release_run(&request.session_id, &request.run_id)
            .map_err(|e| LocalAgentKernelError::new("managed_process_cleanup_failed", e))?;
        self.desktop
            .release_run(&request.session_id, &request.run_id)
            .map_err(|e| LocalAgentKernelError::new("computer_sharing_cleanup_failed", e))?;
        let mut state = self.lock_generations()?;
        let already_released = state.released_run_bindings.contains_key(&key);
        if let Some(generation) = state.run_bindings.remove(&key) {
            let still_pinned = state
                .run_bindings
                .values()
                .any(|candidate| Arc::ptr_eq(candidate, &generation));
            let retirement = (!still_pinned).then(|| generation.catalog.retirement());
            state
                .released_run_bindings
                .insert(key.clone(), ReleasedRunBinding { retirement });
        }
        if let Some(retirement) = &state
            .released_run_bindings
            .get(&key)
            .expect("validated run binding exists")
            .retirement
        {
            retirement.finish().map_err(catalog_error)?;
        }
        Ok(catalog_release_reply(&request, already_released))
    }

    #[cfg(test)]
    pub(crate) fn execute(
        &self,
        request: LocalToolExecutionRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        self.execute_with_progress(request, Default::default())
    }

    pub(crate) fn execute_with_progress(
        &self,
        request: LocalToolExecutionRequest,
        progress: achbit_kernel_runtime::executors::KernelProgressSink,
    ) -> Result<Value, LocalAgentKernelError> {
        let accepted = Instant::now();
        validate_request(&request)?;
        self.validate_session_snapshot(&request)?;
        if let Some(record) = self.records.read(&request.call_id)? {
            validate_record_replay(&record, &request)?;
            return Ok(execution_reply(&request, &record));
        }

        let prepared = match self.prepare_tool(&request) {
            Ok(prepared) => prepared,
            Err(error) if error.input_issues.is_some() => {
                return Ok(input_rejection_reply(&request, error));
            }
            Err(error) => return Err(error),
        };
        if let Some(targets) = prepared.file_mutation_targets() {
            self.validate_prepared_file_call(&request, &targets)?;
        }
        let admission = self.admit(&request, &prepared)?;
        match admission {
            Admission::ApprovalRequired => approval_reply(self, &request, &prepared),
            Admission::Denied { authority, error } => {
                let now = crate::now_text();
                let record = tool_record(
                    &request,
                    &prepared,
                    authority,
                    &now,
                    &now,
                    "denied",
                    None,
                    Some(error),
                )?;
                self.records.insert(&record)?;
                Ok(execution_reply(&request, &record))
            }
            Admission::Allowed(authority) => {
                let started_at = crate::now_text();
                let control = AttemptControl::default();
                {
                    let mut active = self.lock_active()?;
                    if active.contains_key(&request.call_id) {
                        return Err(LocalAgentKernelError::new(
                            "tool_call_in_progress",
                            "相同 callId 的工具调用仍在执行。",
                        ));
                    }
                    active.insert(
                        request.call_id.clone(),
                        ActiveCall {
                            request: request.clone(),
                            control: control.clone(),
                        },
                    );
                }

                let final_result = (|| {
                    let mut prepared = prepared;
                    let mut authority = authority;
                    let targets = prepared.file_mutation_targets();
                    let _file_guard = targets
                        .as_ref()
                        .map(|targets| {
                            self.file_mutations.acquire(
                                &request.call_id,
                                targets.clone(),
                                &control.cancellation(),
                            )
                        })
                        .transpose()?
                        .flatten();
                    if _file_guard.is_some() {
                        // Preparation fixes target identity, never an authorization.
                        // Refresh only after ownership of the complete read/modify/write
                        // interval is available, including change snapshots.
                        let fresh = match self.prepare_tool(&request) {
                            Ok(fresh) => fresh,
                            Err(error) if error.input_issues.is_some() => {
                                return Ok(input_rejection_reply(&request, error));
                            }
                            Err(error) => return Err(error),
                        };
                        if fresh.file_mutation_targets() != targets {
                            return Err(LocalAgentKernelError::new(
                                "file_preparation_changed",
                                "等待文件目标锁期间真实目标发生变化。",
                            ));
                        }
                        self.validate_prepared_file_call(&request, targets.as_ref().unwrap())?;
                        prepared = fresh;
                        match self.admit(&request, &prepared)? {
                            Admission::Allowed(fresh_authority) => authority = fresh_authority,
                            Admission::ApprovalRequired => {
                                if control.claim_outcome().is_none() {
                                    return approval_reply(self, &request, &prepared);
                                }
                            }
                            Admission::Denied {
                                authority: denied_authority,
                                error,
                            } => {
                                if control.claim_outcome().is_none() {
                                    let now = crate::now_text();
                                    let record = tool_record(
                                        &request,
                                        &prepared,
                                        denied_authority,
                                        &started_at,
                                        &now,
                                        "denied",
                                        None,
                                        Some(error),
                                    )?;
                                    self.records.insert(&record)?;
                                    return Ok(execution_reply(&request, &record));
                                }
                            }
                        }
                    }
                    let start_execution = control.start_execution();
                    let result = start_execution.then(|| {
                    if !is_shell_tool(&prepared.operation)
                        && !matches!(&prepared.input, PreparedToolInput::Container { input, .. } if input.action != "inspect")
                    {
                        progress.started();
                    }
                    self.execute_prepared(
                        &prepared,
                        &request,
                        &authority,
                        control.cancellation(),
                        progress,
                    )
                });
                    let cancel_phase = control.claim_outcome();
                    let completed_at = crate::now_text();
                    let record_result = match (cancel_phase, result) {
                        (Some(ActivePhase::Prepared), _) => tool_record(
                            &request,
                            &prepared,
                            authority,
                            &started_at,
                            &completed_at,
                            "cancelled",
                            None,
                            None,
                        ),
                        (Some(ActivePhase::Executing), Some(Ok(result)))
                            if is_confirmed_workspace_shell_cancellation(&prepared, &result) =>
                        {
                            tool_record(
                                &request,
                                &prepared,
                                authority,
                                &started_at,
                                &completed_at,
                                "cancelled",
                                Some(result.output),
                                None,
                            )
                        }
                        (Some(ActivePhase::Executing), result) => {
                            let output = result
                                .as_ref()
                                .and_then(|value| value.as_ref().ok())
                                .map(|value| value.output.clone());
                            let failure = match result {
                                Some(Err(message)) => Some(message),
                                Some(Ok(result)) => result
                                    .error
                                    .map(|error| format!("{}: {}", error.code, error.message)),
                                None => None,
                            };
                            let mut message =
                                "取消发生时工具 effect 已进入执行边界，结果无法确定。".to_string();
                            if let Some(failure) = failure {
                                message.push_str(&format!(" 原始执行失败：{failure}"));
                            }
                            tool_record(
                                &request,
                                &prepared,
                                authority,
                                &started_at,
                                &completed_at,
                                "indeterminate",
                                output,
                                Some(json!({
                                    "code": "tool_effect_outcome_unknown",
                                    "message": message,
                                })),
                            )
                        }
                        (None, Some(Ok(result))) => tool_record_from_execution_result(
                            &request,
                            &prepared,
                            authority,
                            &started_at,
                            &completed_at,
                            result,
                        ),
                        (None, Some(Err(message))) => tool_record(
                            &request,
                            &prepared,
                            authority,
                            &started_at,
                            &completed_at,
                            "failed",
                            None,
                            Some(json!({
                                "code": "tool_execution_failed",
                                "message": message,
                            })),
                        ),
                        (None, None) => Err(LocalAgentKernelError::new(
                            "tool_call_state_lost",
                            "工具调用在进入执行前丢失了确定状态。",
                        )),
                    };
                    record_result.and_then(|mut record| {
                        record["timing"] = json!({"owner":"kernel", "source":"sessionRun", "clockDomain":self.clock.domain,
                            "acceptToResultUs":accepted.elapsed().as_micros(),
                            "executor":self.take_execution_timing(&request.attempt_id)?,
                            "resultStore":{"coverage":"notMeasured"}});
                        self.records.insert(&record)?;
                        Ok(execution_reply(&request, &record))
                    })
                })();
                let remove_result = self
                    .lock_active()
                    .map(|mut active| active.remove(&request.call_id));
                control.finish();
                remove_result?;
                final_result
            }
        }
    }

    pub(crate) fn cancel(
        &self,
        call_id: &str,
        attempt_id: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        validate_id("callId", call_id)?;
        validate_id("attemptId", attempt_id)?;
        if let Some(record) = self.records.read(call_id)? {
            if record.get("attemptId").and_then(Value::as_str) != Some(attempt_id) {
                return Err(LocalAgentKernelError::new(
                    "tool_call_identity_conflict",
                    "callId 已绑定到其他 attemptId。",
                ));
            }
            if let Some(job_id) = record["output"]["job"]["jobId"].as_str() {
                self.jobs
                    .control(
                        required_record_string(&record, "sessionId")?,
                        required_record_string(&record, "runId")?,
                        job_id,
                        "cancel",
                        None,
                        &KernelCancellationToken::default(),
                    )
                    .map_err(|message| {
                        LocalAgentKernelError::new("managed_process_cancel_failed", message)
                    })?;
            }
            let outcome = required_record_string(&record, "outcome")?.to_string();
            return Ok(cancel_reply(call_id, attempt_id, &outcome, Some(record)));
        }
        let active = self.lock_active()?.get(call_id).cloned();
        let Some(active) = active else {
            if let Some(record) = self.records.read(call_id)? {
                if record.get("attemptId").and_then(Value::as_str) != Some(attempt_id) {
                    return Err(LocalAgentKernelError::new(
                        "tool_call_identity_conflict",
                        "callId 已绑定到其他 attemptId。",
                    ));
                }
                if let Some(job_id) = record["output"]["job"]["jobId"].as_str() {
                    self.jobs
                        .control(
                            required_record_string(&record, "sessionId")?,
                            required_record_string(&record, "runId")?,
                            job_id,
                            "cancel",
                            None,
                            &KernelCancellationToken::default(),
                        )
                        .map_err(|message| {
                            LocalAgentKernelError::new("managed_process_cancel_failed", message)
                        })?;
                }
                let outcome = required_record_string(&record, "outcome")?.to_string();
                return Ok(cancel_reply(call_id, attempt_id, &outcome, Some(record)));
            }
            return Ok(cancel_reply(call_id, attempt_id, "notFound", None));
        };
        if active.request.attempt_id != attempt_id {
            return Err(LocalAgentKernelError::new(
                "tool_call_identity_conflict",
                "callId 已绑定到其他 attemptId。",
            ));
        }
        active.control.request_cancel();
        if !active.control.wait_complete(ATTEMPT_CLEANUP_TIMEOUT) {
            return Err(LocalAgentKernelError::new(
                "tool_cancel_cleanup_timeout",
                "工具取消后物理资源未在限定时间内完成回收。",
            ));
        }
        let record = match self.records.read(call_id)? {
            Some(record) => record,
            None if active.control.completed_before_execution() => {
                return Ok(cancel_reply(call_id, attempt_id, "notFound", None));
            }
            None => {
                return Err(LocalAgentKernelError::new(
                    "tool_call_state_lost",
                    "工具执行 owner 完成清理后没有写入唯一终态记录。",
                ))
            }
        };
        validate_record_replay(&record, &active.request)?;
        let outcome = required_record_string(&record, "outcome")?.to_string();
        Ok(cancel_reply(call_id, attempt_id, &outcome, Some(record)))
    }

    pub(crate) fn read_record(
        &self,
        call_id: &str,
    ) -> Result<Option<Value>, LocalAgentKernelError> {
        validate_id("callId", call_id)?;
        self.records.read(call_id)
    }

    pub(crate) fn shutdown_plugins(&self) -> Result<(), LocalAgentKernelError> {
        #[cfg(feature = "debug-control")]
        self.shutdown_debug_operations()?;
        self.cancel_and_drain_attempts(None)?;
        self.release_prepared_file_calls(None)?;
        self.jobs
            .shutdown()
            .map_err(|e| LocalAgentKernelError::new("managed_process_cleanup_failed", e))?;
        let (generations, runs) = {
            let state = self.lock_generations()?;
            let mut generations = Vec::new();
            for generation in state.run_bindings.values() {
                if !generations
                    .iter()
                    .any(|candidate| Arc::ptr_eq(candidate, generation))
                {
                    generations.push(Arc::clone(generation));
                }
            }
            let runs: std::collections::HashSet<_> = state
                .run_bindings
                .keys()
                .map(|key| (key.session_id.clone(), key.run_id.clone()))
                .collect();
            (generations, runs)
        };
        let mut errors = Vec::new();
        for (session_id, run_id) in runs {
            if let Err(error) = self.desktop.release_run(&session_id, &run_id) {
                errors.push(format!("computer_sharing_cleanup_failed: {error}"));
            }
        }
        if let Err(error) = self.desktop.stop() {
            errors.push(format!("computer_host_cleanup_failed: {error}"));
        }
        if let Err(error) = dispose_generations(generations) {
            errors.push(format!("{}: {}", error.code, error.message));
        }
        let state = self.lock_generations()?;
        for released in state.released_run_bindings.values() {
            if let Some(retirement) = &released.retirement {
                if let Err(error) = retirement.finish() {
                    errors.push(format!("{}: {}", error.code, error.message));
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(LocalAgentKernelError::new(
                "tool_provider_dispose_failed",
                errors.join("；"),
            ))
        }
    }

    fn cancel_and_drain_attempts(
        &self,
        target_run: Option<(&str, &str)>,
    ) -> Result<(), LocalAgentKernelError> {
        let matches_target = |call: &ActiveCall| {
            target_run.map_or(true, |(session_id, run_id)| {
                call.request.session_id == session_id && call.request.run_id == run_id
            })
        };
        let attempts = {
            let active = self.lock_active()?;
            active
                .values()
                .filter(|call| matches_target(call))
                .map(|call| call.control.clone())
                .collect::<Vec<_>>()
        };
        for control in &attempts {
            control.request_cancel();
        }
        let deadline = Instant::now() + ATTEMPT_CLEANUP_TIMEOUT;
        for control in attempts {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || !control.wait_complete(remaining) {
                return Err(LocalAgentKernelError::new(
                    "tool_runtime_cleanup_timeout",
                    "Kernel attempt 资源未在限定时间内完成回收。",
                ));
            }
        }
        if self
            .lock_active()?
            .values()
            .any(|call| matches_target(call))
        {
            return Err(LocalAgentKernelError::new(
                "tool_runtime_cleanup_incomplete",
                "Kernel attempt 完成清理后仍保留 active call。",
            ));
        }
        Ok(())
    }

    fn validate_session_snapshot(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<(), LocalAgentKernelError> {
        if !self.journal.has_workspace_binding_view(
            &request.session_id,
            &request.run_id,
            &request.workspace_bindings,
        )? {
            return Err(LocalAgentKernelError::new(
                "session_workspace_snapshot_mismatch",
                "Kernel 请求的 workspaceBindings 不属于当前 run 已提交的资源视图。",
            ));
        }
        Ok(())
    }

    fn prepare_tool(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<PreparedEffect, LocalAgentKernelError> {
        self.prepare_tool_internal(request, true)
    }

    fn prepare_tool_target(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<PreparedEffect, LocalAgentKernelError> {
        self.prepare_tool_internal(request, false)
    }

    fn prepare_tool_internal(
        &self,
        request: &LocalToolExecutionRequest,
        include_permissions: bool,
    ) -> Result<PreparedEffect, LocalAgentKernelError> {
        let generation = self.bound_generation(request)?;
        let binding = generation
            .catalog
            .binding(&request.tool_binding_ref, &request.tool_name)
            .map_err(catalog_error)?;
        if binding.availability() == ToolAvailability::Blocked {
            return Err(LocalAgentKernelError::new(
                "tool_blocked",
                format!("Kernel 工具 {} 当前被阻止，不能执行。", request.tool_name),
            ));
        }
        if binding.is_process() {
            let input = crate::managed_processes::parse(request.input.clone())
                .map_err(|message| LocalAgentKernelError::input("$", "shape", &message, None))?;
            if input.action == "start" {
                let mut inner = request.clone();
                inner.tool_name = input.tool.expect("validated start tool");
                inner.tool_binding_ref = generation
                    .catalog
                    .binding_for_name(&inner.tool_name)
                    .map_err(catalog_error)?
                    .binding_ref()
                    .to_owned();
                inner.input = input.input.expect("validated start input");
                if inner.input.get("workspaceId").is_some()
                    || inner.input.get("workspace").is_some()
                {
                    return Err(LocalAgentKernelError::input(
                        "$.input",
                        "workspace",
                        "Select workspace on the process call, not inside input.",
                        None,
                    ));
                }
                if let Some(workspace_id) = input.workspace_id {
                    inner.input["workspaceId"] = json!(workspace_id);
                }
                let mut prepared = self.prepare_tool_internal(&inner, include_permissions)?;
                prepared.source_binding = Some(binding);
                return Ok(prepared);
            }
        }
        let permissions = self.journal.effective_permissions(&request.session_id)?;
        let mut prepared = prepare_effect_target(
            &request.tool_name,
            &request.input,
            &request.workspace_bindings,
            generation,
            binding,
            permissions.as_ref().clone(),
            |id| self.resolve_owned_workspace(&request.session_id, id),
            |root| self.workspace_policy(request, root),
        )?;
        if !include_permissions {
            return Ok(prepared);
        }
        self.prepare_process_permissions(request, &mut prepared)?;
        self.prepare_file_permissions(request, &mut prepared)?;
        prepared.file_access.sandbox_backend =
            prepared.generation.executor_config.sandbox_backend.clone();
        if let PreparedToolInput::Container { input, target } = &mut prepared.input {
            *target = prepared
                .binding
                .container_adapter()
                .expect("container binding")
                .prepare(
                    input,
                    prepared
                        .workspace_root
                        .as_deref()
                        .expect("container workspace"),
                    prepared.file_access.home.as_deref().and_then(Path::parent),
                )
                .map_err(|message| {
                    LocalAgentKernelError::input("$.container", "containerTarget", &message, None)
                })?;
            prepared.canonical_invocation["arguments"] = prepared.input.arguments();
        }

        if is_shell_tool(&prepared.operation) && !prepared.is_host_process() {
            for scope in ["runNetwork", "sessionNetwork"] {
                if let Some(authority) =
                    self.execution_authority(request, scope, &prepared.file_environment())?
                {
                    prepared.network_authority = Some(authority);
                    break;
                }
            }
            prepared.file_access.network_access =
                prepared.network_authority.is_some() || prepared.network_request.is_some();
        }
        Ok(prepared)
    }

    fn resolve_owned_workspace(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
        let resolved = self.resolver.resolve(workspace_id)?;
        if resolved
            .access
            .owner_session_id()
            .is_some_and(|owner| owner != session_id)
        {
            return Err(LocalAgentKernelError::input(
                "$.workspaceId",
                "workspaceOwner",
                "该托管目录不属于当前会话。",
                None,
            ));
        }
        Ok(resolved)
    }

    /// A resource handle supplies an address. Recorded Run bindings, including
    /// admitted directory additions, identify the project whose policy applies.
    /// A later binding cannot add a new address to an already captured call.
    fn workspace_policy(
        &self,
        request: &LocalToolExecutionRequest,
        selected_root: &Path,
    ) -> Result<Option<WorkspacePolicy>, LocalAgentKernelError> {
        let mut policy: Option<WorkspacePolicy> = None;
        for id in self
            .journal
            .run_workspace_binding_ids(&request.session_id, &request.run_id)?
        {
            if !request.workspace_bindings.contains(&id) {
                continue;
            }
            let binding = self.resolver.resolve(&id)?;
            if binding.access.read_only() {
                continue;
            }
            let root = std::fs::canonicalize(&binding.root).map_err(|error| {
                LocalAgentKernelError::new("workspace_root_unavailable", error.to_string())
            })?;
            if selected_root.starts_with(&root)
                && policy.as_ref().is_none_or(|current| {
                    root.components().count() > current.root.components().count()
                })
            {
                policy = Some(WorkspacePolicy {
                    id,
                    root,
                    access: binding.access,
                });
            }
        }
        Ok(policy)
    }

    fn prepare_process_permissions(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &mut PreparedEffect,
    ) -> Result<(), LocalAgentKernelError> {
        if !is_shell_tool(&prepared.operation) {
            return Ok(());
        }
        let access = prepared
            .workspace_access
            .as_ref()
            .expect("prepared process workspace");
        let host_requested =
            prepared.canonical_invocation["arguments"]["requestHostPermission"].is_string();
        if access.read_only() && host_requested {
            return Err(LocalAgentKernelError::input(
                "$.requestHostPermission", "readOnlyInput",
                "Input snapshots only support sandboxed reads. Use the session working directory for editable copies or a Host permission request.", None,
            ));
        }
        let (plan_authority, _) = self.workspace_plan_authority(request, prepared)?;
        // Select capabilities from committed authorization, never from script text.
        let mode = if !access.read_only()
            && (host_requested
                || prepared.permissions.shell_full_access
                || prepared.workspace_policy.as_ref().is_some_and(|policy| {
                    matches!(policy.access, WorkspaceAccess::SessionWorkdir(_))
                })
                || plan_authority.is_some())
        {
            KernelWorkspaceMode::Write
        } else {
            KernelWorkspaceMode::Read
        };
        let scope =
            if host_requested || (!access.read_only() && prepared.permissions.shell_full_access) {
                KernelExecutionScope::Host
            } else {
                KernelExecutionScope::Workspace
            };
        let PreparedToolInput::Builtin(invocation) = &mut prepared.input else {
            return Err(LocalAgentKernelError::new(
                "process_binding_invalid",
                "Shell binding is not a Kernel process tool.",
            ));
        };
        match invocation {
            KernelCanonicalInvocation::ProcessShell {
                workspace_mode,
                execution_scope,
                ..
            }
            | KernelCanonicalInvocation::ProcessPowerShell {
                workspace_mode,
                execution_scope,
                ..
            } => {
                *workspace_mode = mode;
                *execution_scope = scope;
            }
            _ => {
                return Err(LocalAgentKernelError::new(
                    "process_binding_invalid",
                    "Shell binding has no process invocation.",
                ))
            }
        }
        prepared.process_workspace_mode = Some(mode.as_str().into());
        prepared.process_execution_scope = Some(scope.as_str().into());
        prepared.canonical_invocation["arguments"] = prepared.input.arguments();
        Ok(())
    }

    fn admit(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Admission, LocalAgentKernelError> {
        if self
            .journal
            .run_is_settled(&request.session_id, &request.run_id)?
        {
            return Ok(Admission::denied(
                "run_already_settled",
                "当前 run 已 settled，所有 authority 均已失效。",
            ));
        }
        if let Some(denied) = policy_denial(prepared) {
            return Ok(denied);
        }
        if let PreparedToolInput::Container { input, target } = &prepared.input {
            if input.action == "inspect" {
                return Ok(Admission::Allowed(
                    json!({"decision":"allow","source":"containerInspection"}),
                ));
            }
            if let Some(decision) = self.admit_call_authority(request, prepared)? {
                return Ok(decision);
            }
            if prepared
                .binding
                .container_adapter()
                .expect("container binding")
                .owns(target)
            {
                return Ok(Admission::Allowed(
                    json!({"decision":"allow","source":"containerCreation","containerId":target["id"]}),
                ));
            }
            if input.action == "exec" {
                for scope in ["runContainer", "sessionContainer"] {
                    if let Some(authority) = self.execution_authority(request, scope, target)? {
                        return Ok(Admission::Allowed(authority));
                    }
                }
            }
            if prepared.permissions.shell == ShellApprovalMode::Allow {
                return Ok(Admission::Allowed(
                    json!({"decision":"allow","source":"userSetting","authorityId":"agent.permissions.shell"}),
                ));
            }
            return Ok(Admission::ApprovalRequired);
        }
        // Project scope is independent of a concrete execution approval.
        let workspace_authority = if !is_shell_tool(&prepared.operation)
            && (prepared.scope == PreparedEffectScope::WorkspaceMutation
                || (prepared.scope == PreparedEffectScope::Process
                    && prepared.process_workspace_mode.as_deref() == Some("write")))
        {
            match self.admit_workspace_mutation(request, prepared)? {
                Admission::Allowed(authority) => Some(authority),
                other => return Ok(other),
            }
        } else {
            None
        };
        if prepared.file_authority_required && !prepared.is_host_process() {
            match self.admit_call_authority(request, prepared)? {
                Some(Admission::Allowed(_)) => {}
                Some(other) => return Ok(other),
                None => return Ok(Admission::ApprovalRequired),
            }
        }
        if prepared.is_host_process()
            && !is_shell_tool(&prepared.operation)
            && prepared.permissions.external == PermissionMode::Deny
        {
            return self.admit_non_workspace(request, prepared, PreparedEffectScope::External);
        }
        if is_shell_tool(&prepared.operation) {
            return self.admit_shell(request, prepared);
        }
        if matches!(
            prepared.scope,
            PreparedEffectScope::Network | PreparedEffectScope::External
        ) && prepared.permissions.mode(prepared.scope) == Some(PermissionMode::Deny)
        {
            return self.admit_non_workspace(request, prepared, prepared.scope);
        }
        if let Some(decision) = self.admit_call_authority(request, prepared)? {
            return Ok(decision);
        }
        if prepared.binding.is_internal_preview() {
            return Ok(Admission::Allowed(
                json!({"decision":"allow","source":"internalPreview"}),
            ));
        }
        match prepared.scope {
            PreparedEffectScope::LocalRead => Ok(Admission::Allowed(
                json!({"decision":"allow", "source":"localRead"}),
            )),
            PreparedEffectScope::WorkspaceRead => {
                let workspace_id = prepared
                    .workspace_id
                    .as_deref()
                    .expect("prepared workspace");
                Ok(Admission::Allowed(json!({
                    "decision": "allow",
                    "source": "workspaceBinding",
                    "workspaceId": workspace_id,
                })))
            }
            PreparedEffectScope::Process => {
                if prepared.process_workspace_mode.as_deref() == Some("write") {
                    let workspace_authority = workspace_authority.expect("workspace admission");
                    if prepared.process_execution_scope.as_deref() != Some("host") {
                        return Ok(Admission::Allowed(workspace_authority));
                    }
                    return match self.admit_non_workspace(
                        request,
                        prepared,
                        PreparedEffectScope::External,
                    )? {
                        Admission::Allowed(external_authority) => Ok(Admission::Allowed(json!({
                            "decision": "allow", "source": "composite",
                            "workspaceAuthority": workspace_authority,
                            "externalAuthority": external_authority,
                        }))),
                        other => Ok(other),
                    };
                }
                Ok(Admission::Allowed(json!({
                    "decision": "allow", "source": "workspaceBinding",
                    "workspaceId": prepared.workspace_id,
                })))
            }
            PreparedEffectScope::WorkspaceMutation => Ok(Admission::Allowed(
                workspace_authority.expect("workspace admission"),
            )),
            PreparedEffectScope::Network | PreparedEffectScope::External => {
                self.admit_non_workspace(request, prepared, prepared.scope)
            }
        }
    }

    fn execution_authority(
        &self,
        request: &LocalToolExecutionRequest,
        scope: &str,
        context: &Value,
    ) -> Result<Option<Value>, LocalAgentKernelError> {
        Ok(self.journal.execution_authority(
            &request.session_id,
            &request.run_id,
            scope,
            context,
        )?)
    }

    fn admit_shell(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Admission, LocalAgentKernelError> {
        if !prepared.is_host_process()
            && prepared.file_access.network_access
            && prepared.permissions.network == PermissionMode::Deny
        {
            return Ok(Admission::denied(
                "network_denied",
                "当前权限设置禁止网络访问。",
            ));
        }
        let rule = prepared.command_rule();
        if rule == Some("deny") {
            return Ok(Admission::denied(
                "command_rule_denied",
                "用户命令规则阻止了此操作。",
            ));
        }
        let workspace = if prepared.process_workspace_mode.as_deref() == Some("write") {
            match self.admit_workspace_mutation(request, prepared)? {
                Admission::Allowed(authority) => authority,
                // A concrete Host request can be authorized before a project Plan exists.
                // It gains no workspace authority, and cannot extend an existing Plan.
                _ if prepared.is_host_process()
                    && !self.workspace_plan_authority(request, prepared)?.1 =>
                {
                    Value::Null
                }
                denied => return Ok(denied),
            }
        } else {
            json!({"decision":"allow","source":"workspaceBinding","workspaceId":prepared.workspace_id})
        };
        if let Some(decision) = self.admit_call_authority(request, prepared)? {
            return Ok(match decision {
                Admission::Allowed(authority) => Admission::Allowed(
                    json!({"decision":"allow","source":"composite","workspaceAuthority":workspace,"externalAuthority":authority}),
                ),
                other => other,
            });
        }
        if rule == Some("ask") {
            return Ok(Admission::ApprovalRequired);
        }
        let context = prepared.authorization_context().expect("shell context");
        for scope in [
            "runCommand",
            "sessionCommand",
            "runHostShell",
            "sessionHostShell",
        ] {
            if matches!(scope, "runHostShell" | "sessionHostShell") && !prepared.is_host_process() {
                continue;
            }
            let binding = if matches!(scope, "runHostShell" | "sessionHostShell") {
                prepared
                    .host_shell_authorization_context()
                    .expect("host context")
            } else {
                context.clone()
            };
            if let Some(authority) = self.execution_authority(request, scope, &binding)? {
                return Ok(Admission::Allowed(
                    json!({"decision":"allow","source":"composite","workspaceAuthority":workspace,"externalAuthority":authority}),
                ));
            }
        }
        if !prepared.is_host_process() {
            if prepared.network_request.is_some() && prepared.network_authority.is_none() {
                return Ok(Admission::ApprovalRequired);
            }
            return Ok(Admission::Allowed(match &prepared.network_authority {
                Some(network) => {
                    json!({"decision":"allow","source":"composite","workspaceAuthority":workspace,"networkAuthority":network})
                }
                None => workspace,
            }));
        }
        if rule == Some("allow")
            || (prepared.permissions.shell_full_access
                && prepared.permissions.shell == ShellApprovalMode::Allow)
        {
            return Ok(Admission::Allowed(
                json!({"decision":"allow","source":"composite","workspaceAuthority":workspace,
                "externalAuthority":{"decision":"allow","source":"userSetting","authorityId":if rule == Some("allow") { "user-setting:agent.permissions.commandRules" } else { "user-setting:agent.permissions.shell" }}}),
            ));
        }
        Ok(Admission::ApprovalRequired)
    }

    fn admit_call_authority(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Option<Admission>, LocalAgentKernelError> {
        if let Some(authority) = request.non_workspace_authority.as_ref() {
            if self
                .call_authority_invalidation(request, prepared)?
                .is_some()
            {
                return Ok(None);
            }
            let source = self
                .journal
                .approval_source(&request.session_id, &authority.authority_id)?;
            if authority.decision == "allow" {
                return Ok(Some(Admission::Allowed(json!({
                    "decision": "allow", "source": source, "authorityId": authority.authority_id,
                }))));
            }
            return Ok(Some(Admission::Denied {
                authority: json!({"decision":"deny","source":source,"authorityId":authority.authority_id}),
                error: json!({"code":"tool_effect_denied",
                    "message":if source == "agent" { "受委托的审查代理拒绝了本次操作。" } else { "用户拒绝了本次操作。" }}),
            }));
        }
        Ok(None)
    }

    // A failed revalidation is an explicit Kernel fact, not a new unexplained ask.
    fn call_authority_invalidation(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Option<&'static str>, LocalAgentKernelError> {
        if let Some(authority) = request.non_workspace_authority.as_ref() {
            validate_id("authorityId", &authority.authority_id)?;
            if !matches!(authority.decision.as_str(), "allow" | "deny")
                || !self.journal.non_workspace_authority_is_committed(
                    &request.session_id,
                    &request.run_id,
                    &request.call_id,
                    &authority.authority_id,
                    &authority.decision,
                )?
            {
                return Err(LocalAgentKernelError::new(
                    "non_workspace_authority_invalid",
                    "调用审批 authority 与当前 journal fact 不一致。",
                ));
            }
            if self.journal.authority_revoked(
                &request.session_id,
                &request.run_id,
                &authority.authority_id,
            )? {
                return Ok(Some("revoked"));
            }
            let source = self
                .journal
                .approval_source(&request.session_id, &authority.authority_id)?;
            if !self.journal.approval_matches_request(
                &request.session_id,
                &request.run_id,
                &request.call_id,
                &authority.authority_id,
                &request.tool_name,
                &request.input,
                prepared.authorization_context().as_ref(),
            )? {
                return Ok(Some("scopeChanged"));
            }
            if source == "agent"
                && (!prepared.agent_can_review()
                    || !self.journal.approval_has_review(
                        &request.session_id,
                        &authority.authority_id,
                        &authority.decision,
                    )?)
            {
                return Ok(Some("reviewUnavailable"));
            }
        }
        Ok(None)
    }

    fn admit_non_workspace(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
        scope: PreparedEffectScope,
    ) -> Result<Admission, LocalAgentKernelError> {
        let mode = prepared
            .permissions
            .mode(scope)
            .expect("non-workspace policy");
        match mode {
            PermissionMode::Allow => Ok(Admission::Allowed(json!({
                "decision": "allow",
                "source": "userSetting",
                "authorityId": permission_setting_id(scope),
            }))),
            PermissionMode::Ask => {
                if scope == PreparedEffectScope::Network {
                    for grant_scope in ["runNetwork", "sessionNetwork"] {
                        if let Some(authority) = self.journal.execution_authority(
                            &request.session_id,
                            &request.run_id,
                            grant_scope,
                            &json!({"kind":"networkTools"}),
                        )? {
                            return Ok(Admission::Allowed(authority));
                        }
                    }
                }
                if prepared.binding.is_browser_page() {
                    if let Some(authority_id) = self
                        .journal
                        .session_browser_authority(&request.session_id)?
                    {
                        return Ok(Admission::Allowed(json!({
                            "decision": "allow", "source": "user", "authorityId": authority_id,
                            "authorizationScope": "sessionBrowser",
                        })));
                    }
                }
                Ok(Admission::ApprovalRequired)
            }
            PermissionMode::Deny => Ok(Admission::Denied {
                authority: json!({
                    "decision": "deny",
                    "source": "userSetting",
                    "reason": "用户设置拒绝了该非 workspace effect。",
                }),
                error: json!({
                    "code": "tool_effect_denied_by_setting",
                    "message": "用户设置拒绝了该非 workspace effect。",
                }),
            }),
        }
    }

    fn admit_workspace_mutation(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Admission, LocalAgentKernelError> {
        if prepared.external_file_target() {
            return Ok(Admission::Allowed(
                json!({"decision":"allow","source":"fileResource"}),
            ));
        }
        if let Some(WorkspacePolicy {
            id,
            access: WorkspaceAccess::SessionWorkdir(owner),
            ..
        }) = &prepared.workspace_policy
        {
            return Ok(Admission::Allowed(json!({
                "decision": "allow", "source": "sessionWorkdir",
                "sessionId": owner, "workspaceId": id,
            })));
        }
        let (authority, has_confirmed_plan) = self.workspace_plan_authority(request, prepared)?;
        if let Some(authority) = authority {
            return Ok(Admission::Allowed(authority));
        }
        if !has_confirmed_plan
            && prepared.permissions.workspace_mutation == WorkspaceMutationMode::Allow
        {
            return Ok(Admission::Allowed(json!({
                "decision": "allow",
                "source": "userSetting",
                "authorityId": "user-setting:agent.permissions.workspaceMutation",
                "workspaceId": prepared.workspace_policy.as_ref().map(|policy| &policy.id),
            })));
        }
        Ok(Admission::Denied {
            authority: json!({"decision":"deny","source":"planScope"}),
            error: json!({"code":"plan_scope_required",
                "message":"操作未执行：目标未被已确认的 Plan 覆盖。请先发布或调整 Plan，说明必要性和新增目标；执行审批不能替代计划确认。"}),
        })
    }

    fn workspace_plan_authority(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<(Option<Value>, bool), LocalAgentKernelError> {
        let Some(policy) = &prepared.workspace_policy else {
            return Ok((None, false));
        };
        let mut scoped = prepared.clone();
        scoped.workspace_id = Some(policy.id.clone());
        scoped.logical_targets = prepared
            .private_resolved_targets
            .iter()
            .map(|target| {
                Path::new(target)
                    .strip_prefix(&policy.root)
                    .map(|path| {
                        if path.as_os_str().is_empty() {
                            ".".to_string()
                        } else {
                            path.to_string_lossy().replace('\\', "/")
                        }
                    })
                    .unwrap_or_else(|_| target.clone())
            })
            .collect();
        let prepared = &scoped;
        let committed = self.journal.active_plan_authorities(&request.session_id)?;
        let delegated = self
            .journal
            .delegated_plan_authorities(&request.session_id, &request.run_id)?;
        let mut has_confirmed_plan = false;
        for authority in committed.iter().flatten().chain(&delegated) {
            has_confirmed_plan |= self
                .plan_authority_in_workspace(authority, policy)?
                .is_some();
        }
        for authority in request.plan_authorities.iter().chain(&delegated) {
            let local = authority_matches_identity(
                authority,
                &request.session_id,
                &request.run_id,
                authority["workspaceId"].as_str(),
            ) && committed
                .as_ref()
                .is_some_and(|values| values.contains(authority));
            let inherited = delegated.contains(authority);
            if !local && !inherited {
                continue;
            }
            let Some(scoped_authority) = self.plan_authority_in_workspace(authority, policy)?
            else {
                continue;
            };
            if authority_covers(&scoped_authority, prepared) {
                let writable_paths: Vec<Value> = scoped_authority["coveredOperations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|operation| {
                        operation["operation"] == prepared.operation
                            && operation["workspaceId"].as_str() == prepared.workspace_id.as_deref()
                    })
                    .flat_map(|operation| {
                        operation["writablePaths"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .cloned()
                    })
                    .collect();
                return Ok((
                    Some(json!({
                        "decision": "allow",
                        "source": "plan",
                        "workspaceId": prepared.workspace_id,
                        "authorityId": authority.get("authorityId"),
                        "planId": authority.get("planId"),
                        "revision": authority.get("revision"),
                        "decisionId": authority.get("decisionId"),
                        "writablePaths": writable_paths,
                    })),
                    true,
                ));
            }
        }
        Ok((None, has_confirmed_plan))
    }

    fn plan_authority_in_workspace(
        &self,
        authority: &Value,
        policy: &WorkspacePolicy,
    ) -> Result<Option<Value>, LocalAgentKernelError> {
        let id = authority["workspaceId"].as_str().ok_or_else(|| {
            LocalAgentKernelError::new(
                "plan_workspace_missing",
                "Plan authority 缺少 workspaceId。",
            )
        })?;
        if id == policy.id {
            return Ok(Some(authority.clone()));
        }
        let address = self.resolver.resolve(id)?;
        let root = std::fs::canonicalize(address.root).map_err(|error| {
            LocalAgentKernelError::new("workspace_root_unavailable", error.to_string())
        })?;
        if !root.starts_with(&policy.root) || address.access.read_only() {
            return Ok(None);
        }
        let boundary = WorkspaceBoundary::new(root);
        let rebase = |value: &mut Value| -> Result<(), LocalAgentKernelError> {
            let path = value.as_str().ok_or_else(|| {
                LocalAgentKernelError::new("plan_target_invalid", "Plan target 必须是路径。")
            })?;
            let path = boundary.resolve_mutation(path).map_err(|error| {
                LocalAgentKernelError::new("plan_target_invalid", error.to_string())
            })?;
            let relative = path.strip_prefix(&policy.root).map_err(|error| {
                LocalAgentKernelError::new("plan_target_invalid", error.to_string())
            })?;
            *value = json!(if relative.as_os_str().is_empty() {
                ".".to_string()
            } else {
                relative.to_string_lossy().replace('\\', "/")
            });
            Ok(())
        };
        let mut scoped = authority.clone();
        scoped["workspaceId"] = json!(policy.id);
        for operation in scoped["coveredOperations"]
            .as_array_mut()
            .expect("validated authority")
        {
            operation["workspaceId"] = json!(policy.id);
            if let Some(target) = operation.get_mut("target") {
                rebase(target)?;
            }
            if let Some(paths) = operation
                .get_mut("writablePaths")
                .and_then(Value::as_array_mut)
            {
                for target in paths {
                    rebase(&mut target["path"])?;
                }
            }
        }
        Ok(Some(scoped))
    }

    /// The Kernel decides Plan admission from its published model. A Loop never
    /// determines automatic confirmation from its historical runtime snapshot.
    pub(crate) fn plan_admission(
        &self,
        request: PlanAdmissionRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        crate::local_agent_store::validate_plan_operations(&request.mutation_manifest)?;
        let bindings = self
            .journal
            .run_workspace_binding_ids(&request.session_id, &request.run_id)?;
        let mut workdirs = HashSet::new();
        let mut resolved = HashSet::new();
        let mut workspace_requests = Vec::new();
        for operation in request
            .mutation_manifest
            .as_array()
            .expect("validated manifest")
        {
            let id = operation["workspaceId"]
                .as_str()
                .expect("validated workspace");
            if !bindings.iter().any(|binding| binding == id) {
                if !self
                    .journal
                    .latest_workspace_addresses(&request.session_id, &request.run_id)?
                    .iter()
                    .any(|address| address == id)
                {
                    return Err(LocalAgentKernelError::new(
                        "plan_workspace_binding_invalid",
                        "Plan 引用了未知工作区。",
                    ));
                }
                let workspace = self.resolve_owned_workspace(&request.session_id, id)?;
                if !matches!(workspace.access, WorkspaceAccess::Project) {
                    return Err(LocalAgentKernelError::new(
                        "plan_workspace_binding_invalid",
                        "该资源不能加入项目工作区。",
                    ));
                }
                let root = std::fs::canonicalize(&workspace.root).map_err(|error| {
                    LocalAgentKernelError::new("workspace_root_unavailable", error.to_string())
                })?;
                if resolved.insert(id) {
                    workspace_requests.push(json!({"workspaceId":id,"rootPath":root}));
                }
                continue;
            }
            if resolved.insert(id)
                && matches!(
                    self.resolve_owned_workspace(&request.session_id, id)?
                        .access,
                    WorkspaceAccess::SessionWorkdir(_)
                )
            {
                workdirs.insert(id);
            }
        }
        let authorities = self
            .journal
            .delegated_plan_authorities(&request.session_id, &request.run_id)?;
        if !workspace_requests.is_empty() {
            if !authorities.is_empty() {
                return Err(LocalAgentKernelError::new(
                    "plan_workspace_binding_invalid",
                    "新增目录超出继承的计划范围，请先由父任务取得授权。",
                ));
            }
            return Ok(
                json!({"source":"user","authorities":[],"workspaceRequests":workspace_requests}),
            );
        }
        // An inherited Plan remains the scope ceiling even when the permission
        // mode permits automatic confirmation. Keep its original grant identity.
        let manifest = request
            .mutation_manifest
            .as_array()
            .expect("validated manifest");
        if !manifest.is_empty()
            && manifest.iter().all(|operation| {
                workdirs.contains(
                    operation["workspaceId"]
                        .as_str()
                        .expect("validated workspace"),
                )
            })
        {
            // This is existing directory access, not a new Plan grant. Shell
            // execution still goes through its independent effect admission.
            return Ok(json!({"source":"sessionWorkdir", "authorities":[]}));
        }
        if authorities.is_empty()
            && self
                .journal
                .effective_permissions(&request.session_id)?
                .workspace_mutation
                == WorkspaceMutationMode::Allow
        {
            return Ok(json!({"source":"agent", "authorities":[]}));
        }
        if authorities.is_empty()
            && self
                .journal
                .effective_permissions(&request.session_id)?
                .workspace_mutation
                == WorkspaceMutationMode::Review
        {
            return Ok(json!({"source":"review","authorities":[]}));
        }
        let mut covered = Vec::new();
        for operation in request
            .mutation_manifest
            .as_array()
            .expect("validated manifest")
        {
            if workdirs.contains(
                operation["workspaceId"]
                    .as_str()
                    .expect("validated workspace"),
            ) {
                continue;
            }
            let Some(authority) = authorities.iter().find(|authority| {
                authority["workspaceId"] == operation["workspaceId"]
                    && authority["coveredOperations"]
                        .as_array()
                        .is_some_and(|operations| {
                            operations
                                .iter()
                                .any(|scope| plan_operation_covers(scope, operation))
                        })
            }) else {
                return Ok(json!({"source":"user", "authorities":[]}));
            };
            if !covered.contains(authority) {
                covered.push(authority.clone());
            }
        }
        Ok(json!({"source":if covered.is_empty() {"user"} else {"parent"}, "authorities":covered}))
    }

    fn execute_prepared(
        &self,
        prepared: &PreparedEffect,
        request: &LocalToolExecutionRequest,
        authority: &Value,
        cancellation: KernelCancellationToken,
        progress: achbit_kernel_runtime::executors::KernelProgressSink,
    ) -> Result<KernelToolExecutionResult, String> {
        let lease = prepared
            .binding
            .begin_attempt()
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        self.execute_with_lease(prepared, request, authority, cancellation, progress, lease)
    }

    fn execute_with_lease(
        &self,
        prepared: &PreparedEffect,
        request: &LocalToolExecutionRequest,
        authority: &Value,
        cancellation: KernelCancellationToken,
        progress: achbit_kernel_runtime::executors::KernelProgressSink,
        lease: PhysicalAttemptLease,
    ) -> Result<KernelToolExecutionResult, String> {
        if prepared.source_binding.is_some()
            || is_shell_tool(&prepared.operation)
            || matches!(&prepared.input, PreparedToolInput::Container { input, .. } if input.action != "inspect")
        {
            let kernel = self.clone();
            let mut inner = prepared.clone();
            inner.source_binding = None;
            let invocation_id = request.attempt_id.clone();
            let request = request.clone();
            let authority = authority.clone();
            // Transfer the already acquired lease; retirement cannot interrupt this owned job.
            let explicit_start = prepared.source_binding.is_some();
            let command = match &inner.input {
                PreparedToolInput::Builtin(
                    KernelCanonicalInvocation::ProcessShell { command, .. }
                    | KernelCanonicalInvocation::ProcessPowerShell { command, .. },
                ) => Some(command.clone()),
                PreparedToolInput::Container { input, .. } => {
                    Some(input.command.clone().unwrap_or_else(|| {
                        format!(
                            "container {} {}",
                            input.action,
                            input.image.as_deref().unwrap_or("")
                        )
                    }))
                }
                _ => None,
            }
            .ok_or("Managed command missing")?;
            let snapshot = json!({
                "jobId": random_id("job").map_err(|e| e.message)?,
                "sessionId": request.session_id, "runId": request.run_id, "callId": request.call_id,
                "toolName": inner.operation, "attemptId": invocation_id,
                "command": command,
                "targets": inner.logical_targets,
            });
            let execute = move |cancellation, progress| {
                kernel.execute_owned(&inner, &request, &authority, cancellation, progress, lease)
            };
            if !explicit_start {
                return self
                    .jobs
                    .foreground(snapshot, cancellation, progress, execute);
            }
            let job = self.jobs.start(snapshot, execute)?;
            return Ok(KernelToolExecutionResult {
                invocation_id,
                outcome: KernelToolExecutionOutcome::Completed,
                output: json!({ "job": job }),
                error: None,
            });
        }
        if let PreparedToolInput::Process(input) = &prepared.input {
            let job = self.jobs.control(
                &request.session_id,
                &request.run_id,
                input.job_id.as_deref().ok_or("jobId missing")?,
                if input.action == "wait" {
                    "status"
                } else {
                    &input.action
                },
                input.wait_seconds,
                &cancellation,
            )?;
            return Ok(KernelToolExecutionResult {
                invocation_id: request.attempt_id.clone(),
                outcome: KernelToolExecutionOutcome::Completed,
                output: if input.action == "wait" {
                    json!({ "job": job, "wait": {
                    "jobId": input.job_id, "timeoutSeconds": input.wait_seconds } })
                } else {
                    json!({ "job": job })
                },
                error: None,
            });
        }
        self.execute_owned(prepared, request, authority, cancellation, progress, lease)
    }

    fn execute_owned(
        &self,
        prepared: &PreparedEffect,
        request: &LocalToolExecutionRequest,
        authority: &Value,
        cancellation: KernelCancellationToken,
        progress: achbit_kernel_runtime::executors::KernelProgressSink,
        lease: PhysicalAttemptLease,
    ) -> Result<KernelToolExecutionResult, String> {
        let workspace_authority = if authority["source"] == "composite" {
            &authority["workspaceAuthority"]
        } else {
            authority
        };
        let workspace_write_targets = if is_shell_tool(&prepared.operation)
            && prepared.process_execution_scope.as_deref() == Some("workspace")
            && workspace_authority["source"] == "plan"
        {
            let root = prepared
                .workspace_policy
                .as_ref()
                .map(|policy| policy.root.as_path())
                .ok_or("workspace root missing")?;
            let boundary = WorkspaceBoundary::new(root);
            let paths = workspace_authority["writablePaths"]
                .as_array()
                .ok_or("Plan writablePaths missing")?;
            if paths.is_empty() {
                return Err("Plan writablePaths is empty".into());
            }
            Some(
                paths
                    .iter()
                    .map(|target| {
                        let path = target["path"]
                            .as_str()
                            .ok_or("Plan writable path missing")?;
                        let resolved = boundary.resolve_mutation(path).map_err(|error| error.to_string())?;
                        if target["kind"] != "directory" || resolved == std::fs::canonicalize(root).map_err(|e| e.to_string())? {
                            return Err("Shell writablePaths must name test/output directories, not project files or the workspace root".into());
                        }
                        Ok(achbit_kernel_runtime::executors::WorkspaceWriteTarget { path: resolved, directory: true })
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            )
        } else {
            None
        };
        let result = self.invoke_measured(
            prepared,
            &request.attempt_id,
            KernelToolExecutionContext {
                output_directory: Some(
                    self.session_output_directory(&request.session_id)
                        .join(output_directory_key(&request.attempt_id)),
                ),
                workspace_root: prepared.workspace_root.clone(),
                workspace_id: prepared.workspace_id.clone(),
                private_resolved_targets: prepared.private_resolved_targets.clone(),
                workspace_write_targets,
                file_access: prepared.execution_file_access(),
                cancellation,
                progress,
            },
        );
        drop(lease);
        result
    }

    fn invoke_measured(
        &self,
        prepared: &PreparedEffect,
        attempt_id: &str,
        context: KernelToolExecutionContext,
    ) -> Result<KernelToolExecutionResult, String> {
        let started_at = crate::now_text();
        let start_offset_us = self.clock.origin.elapsed().as_micros();
        let start = Instant::now();
        let result = prepared
            .binding
            .invoke(attempt_id, prepared.input.clone(), context)
            .map_err(|error| format!("{}: {}", error.code, error.message));
        let elapsed = start.elapsed();
        let timing = json!({
            "owner":"kernel", "phase":"executor", "clockDomain":self.clock.domain,
            "threadId":format!("{:?}", std::thread::current().id()),
            "startedAt":started_at, "completedAt":crate::now_text(),
            "startOffsetUs":start_offset_us, "endOffsetUs":start_offset_us + elapsed.as_micros(),
            "durationUs":elapsed.as_micros(), "coverage":"measured",
        });
        self.measurements
            .lock()
            .map_err(|_| "tool_timing_lock_failed".to_owned())?
            .insert(attempt_id.to_owned(), timing);
        result
    }

    fn take_execution_timing(&self, attempt_id: &str) -> Result<Value, LocalAgentKernelError> {
        Ok(self
            .measurements
            .lock()
            .map_err(|_| {
                LocalAgentKernelError::new("tool_timing_lock_failed", "Tool timing lock poisoned")
            })?
            .remove(attempt_id)
            .unwrap_or_else(|| json!({"phase":"executor","coverage":"notApplicable"})))
    }

    pub(crate) fn session_output_directory(&self, session_id: &str) -> PathBuf {
        self.output_root.join(output_directory_key(session_id))
    }

    pub(crate) fn delete_session_outputs(
        &self,
        session_id: &str,
    ) -> Result<(), LocalAgentKernelError> {
        match std::fs::remove_dir_all(self.session_output_directory(session_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(LocalAgentKernelError::new(
                "tool_output_cleanup_failed",
                error.to_string(),
            )),
        }
    }

    fn bound_generation(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<Arc<KernelGeneration>, LocalAgentKernelError> {
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
            snapshot_ref: request.kernel_catalog_snapshot_ref.clone(),
        };
        let state = self.lock_generations()?;
        let generation = state.run_bindings.get(&key).ok_or_else(|| {
            LocalAgentKernelError::new(
                "tool_catalog_run_binding_missing",
                "当前 run 尚未 prepare immutable Kernel catalog。",
            )
        })?;
        if generation.catalog.extension_generation_ref() != request.extension_generation_ref
            || generation.catalog.snapshot_ref() != request.kernel_catalog_snapshot_ref
        {
            return Err(LocalAgentKernelError::new(
                "tool_catalog_execution_identity_conflict",
                "工具请求的 generation/catalog identity 与当前 run lease 不一致。",
            ));
        }
        Ok(Arc::clone(generation))
    }

    fn lock_active(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, ActiveCall>>, LocalAgentKernelError> {
        self.active.lock().map_err(|_| {
            LocalAgentKernelError::new("tool_runtime_lock_failed", "Kernel 工具运行状态锁已损坏。")
        })
    }

    fn lock_generations(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, KernelGenerationState>, LocalAgentKernelError> {
        self.generations.lock().map_err(|_| {
            LocalAgentKernelError::new(
                "tool_catalog_generation_lock_failed",
                "Kernel catalog generation 状态锁已损坏。",
            )
        })
    }
}

/// Resolve the actual catalog binding and targets independently of the caller's
/// lifecycle. Session and direct operations supply their own proven scope.
fn prepare_effect_target(
    tool_name: &str,
    call_input: &Value,
    workspace_bindings: &[String],
    generation: Arc<KernelGeneration>,
    binding: PreparedCatalogBinding,
    permissions: LocalAgentPermissionPolicy,
    resolve_workspace: impl Fn(&str) -> Result<ResolvedWorkspace, LocalAgentKernelError>,
    resolve_policy: impl Fn(&Path) -> Result<Option<WorkspacePolicy>, LocalAgentKernelError>,
) -> Result<PreparedEffect, LocalAgentKernelError> {
    let scope = match binding.effect_scope(&call_input).map_err(catalog_error)? {
        CatalogEffectScope::LocalRead => PreparedEffectScope::LocalRead,
        CatalogEffectScope::WorkspaceRead => PreparedEffectScope::WorkspaceRead,
        CatalogEffectScope::WorkspaceMutation => PreparedEffectScope::WorkspaceMutation,
        CatalogEffectScope::Process => PreparedEffectScope::Process,
        CatalogEffectScope::Network => PreparedEffectScope::Network,
        CatalogEffectScope::External => PreparedEffectScope::External,
    };
    let mut tool_input = call_input.clone();
    let network_request = if is_shell_tool(&tool_name) {
        tool_input
            .as_object_mut()
            .and_then(|input| input.remove("requestNetworkPermission"))
            .map(|value| {
                value
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 1024)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        LocalAgentKernelError::input(
                            "$.requestNetworkPermission",
                            "reason",
                            "Provide a short reason for network access.",
                            None,
                        )
                    })
            })
            .transpose()?
    } else {
        None
    };
    let file_requests = if is_shell_tool(&tool_name)
        || matches!(tool_name, "fs.read" | "fs.write" | "fs.edit" | "fs.delete")
    {
        tool_input
            .as_object_mut()
            .and_then(|input| input.remove("requestFileAccess"))
            .map(serde_json::from_value::<RequestedFiles>)
            .transpose()
            .map_err(|error| {
                LocalAgentKernelError::input(
                    "$.requestFileAccess",
                    "fileAccess",
                    &error.to_string(),
                    None,
                )
            })?
            .unwrap_or_default()
    } else {
        RequestedFiles::default()
    };
    // Controls address the already admitted job; the Provider's default workspace selector is unused.
    if binding.is_process() {
        tool_input
            .as_object_mut()
            .expect("validated process input")
            .remove("workspaceId");
    }
    let workspace_id = match scope {
        PreparedEffectScope::WorkspaceRead
        | PreparedEffectScope::WorkspaceMutation
        | PreparedEffectScope::Process => Some(take_workspace_id(&mut tool_input)?),
        PreparedEffectScope::LocalRead
        | PreparedEffectScope::Network
        | PreparedEffectScope::External => {
            if tool_input.get("workspaceId").is_some() {
                return Err(LocalAgentKernelError::input(
                    "$.workspaceId",
                    "additionalProperties",
                    "非 workspace 工具不能携带 workspaceId。",
                    None,
                ));
            }
            None
        }
    };
    if let Some(workspace_id) = workspace_id.as_deref() {
        if !workspace_bindings.iter().any(|id| id == workspace_id) {
            let mut error = LocalAgentKernelError::input("$.workspaceId", "workspaceBinding",
                    "工具引用的 workspace 不在当前运行的目录集合中。请选择已绑定目录；需要其他位置时请向用户确认。", None);
            error.code = "workspace_not_bound";
            return Err(error);
        }
    }
    let input = binding.canonicalize(tool_input).map_err(catalog_error)?;
    let arguments = input.arguments();
    let mut workspace_access = None;
    let mut logical_targets = input.logical_targets();
    if matches!(
        scope,
        PreparedEffectScope::Network | PreparedEffectScope::External
    ) {
        if let Some(target) = binding.logical_target() {
            logical_targets.push(target.to_string());
        }
    }
    if let PreparedToolInput::Builtin(canonical) = &input {
        if let Some(target) = resolved_network_target(canonical, &generation.executor_config)
            .map_err(|error| LocalAgentKernelError::new("tool_target_invalid", error.to_string()))?
        {
            logical_targets.push(target);
            logical_targets.sort();
            logical_targets.dedup();
        }
    }
    let (workspace_root, private_resolved_targets) = match workspace_id.as_deref() {
        Some(workspace_id) => {
            let resolved = resolve_workspace(workspace_id)?;
            if resolved.access.read_only() && scope == PreparedEffectScope::WorkspaceMutation {
                let mut error = LocalAgentKernelError::input(
                        "$.workspaceId", "readOnlyInput",
                        "会话输入快照只读。可直接读取或在内部浏览器打开；编辑预览请使用已绑定的 Achbit 会话工作目录中的副本。",
                        None,
                    );
                error.code = "input_resource_read_only";
                return Err(error);
            }
            workspace_access = Some(resolved.access);
            let root = resolved.root;
            let canonical_root = std::fs::canonicalize(&root).map_err(|error| {
                LocalAgentKernelError::new(
                    "workspace_root_unavailable",
                    format!("Workspace root 不可用：{error}"),
                )
            })?;
            if !canonical_root.is_dir() {
                return Err(LocalAgentKernelError::new(
                    "workspace_root_invalid",
                    "Workspace root 不是目录。",
                ));
            }
            let boundary = WorkspaceBoundary::new(canonical_root.clone());
            let resolve_target = |target: &str| {
                if std::path::Path::new(target).is_absolute() {
                    achbit_kernel_runtime::file_access::resolve_path(std::path::Path::new(target))
                } else {
                    match scope {
                        PreparedEffectScope::WorkspaceRead | PreparedEffectScope::Process => {
                            boundary.resolve_read(target)
                        }
                        PreparedEffectScope::WorkspaceMutation => boundary.resolve_mutation(target),
                        PreparedEffectScope::LocalRead
                        | PreparedEffectScope::Network
                        | PreparedEffectScope::External => {
                            unreachable!("workspace target scope")
                        }
                    }
                }
            };
            let private = logical_targets
                .iter()
                .map(|target| {
                    resolve_target(target)
                        .map(|path| path.to_string_lossy().to_string())
                        .map_err(|error| {
                            let mut failure = LocalAgentKernelError::new(
                                "workspace_target_invalid",
                                error.to_string(),
                            );
                            // Target I/O failures belong to this invocation. Resolver,
                            // workspace-root and record-store failures keep their error path.
                            if matches!(error, achbit_kernel_abi::KernelError::Other(_)) {
                                failure.input_issues = Some(vec![ToolInputIssue::new(
                                    if arguments.get("path").is_some() {
                                        "$.path"
                                    } else {
                                        "$"
                                    },
                                    "workspaceTarget",
                                    &failure.message,
                                    None,
                                )]);
                            }
                            failure
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            (Some(canonical_root.to_string_lossy().to_string()), private)
        }
        None => (None, Vec::new()),
    };
    let delete_target_kind = match &input {
        PreparedToolInput::Builtin(KernelCanonicalInvocation::FsDelete(
            KernelDeleteTarget::File { .. },
        )) => Some("file".to_owned()),
        PreparedToolInput::Builtin(KernelCanonicalInvocation::FsDelete(
            KernelDeleteTarget::DirectoryTree { .. },
        )) => Some("directoryTree".to_owned()),
        _ => None,
    };
    let (process_workspace_mode, process_execution_scope) = match &input {
        PreparedToolInput::Builtin(
            KernelCanonicalInvocation::ProcessShell {
                workspace_mode,
                execution_scope,
                ..
            }
            | KernelCanonicalInvocation::ProcessPowerShell {
                workspace_mode,
                execution_scope,
                ..
            },
        ) => (
            Some(workspace_mode.as_str().to_owned()),
            Some(execution_scope.as_str().to_owned()),
        ),
        _ => (None, None),
    };
    let workspace_policy = workspace_root
        .as_deref()
        .map(|root| resolve_policy(Path::new(root)))
        .transpose()?
        .flatten();
    let prepared = PreparedEffect {
        permissions: permissions.with_constraints(generation.permissions.constraints),
        generation,
        binding,
        source_binding: None,
        scope,
        workspace_id,
        operation: tool_name.to_owned(),
        logical_targets,
        private_resolved_targets,
        canonical_invocation: json!({
            "toolName": tool_name,
            "arguments": arguments,
        }),
        input,
        workspace_root,
        workspace_access,
        workspace_policy,
        delete_target_kind,
        process_workspace_mode,
        process_execution_scope,
        file_requests,
        file_access: FileAccessScope::default(),
        file_authority_required: false,
        git_write_requested: false,
        network_request,
        network_authority: None,
    };
    Ok(prepared)
}

fn catalog_prepare_reply(
    request: &PrepareToolCatalogRequest,
    catalog: &ToolCatalogSnapshot,
) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.catalog.prepared",
        "sessionId": request.session_id,
        "runId": request.run_id,
        "extensionGenerationRef": catalog.extension_generation_ref(),
        "kernelCatalogSnapshotRef": catalog.snapshot_ref(),
        "tools": catalog.provider_view(),
    })
}

fn catalog_release_reply(request: &ReleaseToolCatalogRequest, already_released: bool) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.catalog.released",
        "sessionId": request.session_id,
        "runId": request.run_id,
        "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
        "released": true,
        "alreadyReleased": already_released,
    })
}

fn dispose_generations(
    generations: Vec<Arc<KernelGeneration>>,
) -> Result<(), LocalAgentKernelError> {
    let mut errors = Vec::new();
    for generation in generations {
        if let Err(error) = generation.catalog.dispose() {
            errors.push(format!("{}: {}", error.code, error.message));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(LocalAgentKernelError::new(
            "tool_provider_dispose_failed",
            errors.join("；"),
        ))
    }
}

fn catalog_error(error: ToolCatalogError) -> LocalAgentKernelError {
    let input_issues = error.input_issues.or_else(|| {
        (error.code == "tool_input_invalid")
            .then(|| vec![ToolInputIssue::new("$", "toolInput", &error.message, None)])
    });
    LocalAgentKernelError {
        code: error.code,
        message: error.message,
        input_issues,
    }
}

fn policy_denial(prepared: &PreparedEffect) -> Option<Admission> {
    let constraints = prepared.permissions.constraints;
    if (!constraints.allow_host_execution || !constraints.allow_external_tools)
        && prepared.binding.uses_external_runtime()
        || !constraints.allow_host_execution
            && (prepared.is_host_process()
                || matches!(prepared.input, PreparedToolInput::Container { .. }))
        || !constraints.allow_external_tools && prepared.scope == PreparedEffectScope::External
    {
        return Some(Admission::denied(
            "permission_policy_denied",
            "The selected Agent policy does not permit this execution route.",
        ));
    }
    let rules = &prepared.permissions.command_denylist;
    let denied = match &prepared.input {
        PreparedToolInput::Builtin(
            KernelCanonicalInvocation::ProcessShell {
                command, terminal, ..
            }
            | KernelCanonicalInvocation::ProcessPowerShell {
                command, terminal, ..
            },
        ) => rules.matching_rule(command).or_else(|| {
            terminal
                .as_ref()
                .and_then(|input| rules.matching_rule(&input.stdin))
        }),
        PreparedToolInput::Container { input, .. } => input
            .command
            .as_deref()
            .and_then(|command| rules.matching_rule(command)),
        _ if prepared.binding.is_browser_service() && prepared.is_host_process() => {
            let arguments = &prepared.canonical_invocation["arguments"];
            arguments["command"].as_str().and_then(|command| {
                arguments["args"].as_array().and_then(|args| {
                    let words = std::iter::once(Some(command.to_owned()))
                        .chain(args.iter().map(|value| value.as_str().map(str::to_owned)))
                        .collect::<Option<Vec<_>>>()?;
                    rules.matching_argv(&words)
                })
            })
        }
        _ => None,
    };
    if let Some(rule) = denied {
        return Some(Admission::Denied {
            authority: json!({"decision":"deny", "source":"userSetting",
                    "authorityId":crate::command_denylist::SETTING, "matchedRule":rule}),
            error: json!({"code":"command_denied_by_rule",
                    "message":format!("Command was not executed: blocked by command rule {rule:?}." )}),
        });
    }
    None
}

enum Admission {
    ApprovalRequired,
    Allowed(Value),
    Denied { authority: Value, error: Value },
}

impl Admission {
    fn denied(code: &str, message: &str) -> Self {
        Self::Denied {
            authority: json!({
                "decision": "deny",
                "source": "kernel",
                "reason": message,
            }),
            error: json!({ "code": code, "message": message }),
        }
    }
}

#[derive(Clone)]
struct WorkspacePolicy {
    id: String,
    root: PathBuf,
    access: WorkspaceAccess,
}

#[derive(Clone)]
struct PreparedEffect {
    permissions: LocalAgentPermissionPolicy,
    generation: Arc<KernelGeneration>,
    binding: PreparedCatalogBinding,
    // A managed start retains the plugin call identity while admitting the actual executor.
    source_binding: Option<PreparedCatalogBinding>,
    scope: PreparedEffectScope,
    workspace_id: Option<String>,
    operation: String,
    logical_targets: Vec<String>,
    private_resolved_targets: Vec<String>,
    canonical_invocation: Value,
    input: PreparedToolInput,
    workspace_root: Option<String>,
    workspace_access: Option<WorkspaceAccess>,
    workspace_policy: Option<WorkspacePolicy>,
    delete_target_kind: Option<String>,
    process_workspace_mode: Option<String>,
    process_execution_scope: Option<String>,
    file_requests: RequestedFiles,
    file_access: FileAccessScope,
    file_authority_required: bool,
    git_write_requested: bool,
    network_request: Option<String>,
    network_authority: Option<Value>,
}

impl PreparedEffect {
    fn agent_can_review(&self) -> bool {
        self.permissions.shell == ShellApprovalMode::Review
            && self.command_rule().is_none_or(|rule| rule == "allow")
    }

    fn is_host_process(&self) -> bool {
        self.process_execution_scope.as_deref() == Some("host")
            || (self.binding.is_browser_service()
                && self.canonical_invocation["arguments"]["action"] == "start")
    }

    fn projection(&self, request: &LocalToolExecutionRequest) -> Value {
        let binding = self.source_binding.as_ref().unwrap_or(&self.binding);
        let mut projection = json!({
            "callId": request.call_id,
            "attemptId": request.attempt_id,
            "sessionId": request.session_id,
            "runId": request.run_id,
            "extensionGenerationRef": binding.extension_generation_ref(),
            "kernelCatalogSnapshotRef": binding.snapshot_ref(),
            "toolBindingRef": binding.binding_ref(),
            "contributionRef": binding.contribution_ref(),
            "providerRef": binding.provider_ref(),
            "origin": binding.origin(),
            "toolName": request.tool_name,
            "operation": self.operation,
            "logicalTargets": self.logical_targets,
            "canonicalInvocation": self.canonical_invocation,
        });
        if let Some(workspace_id) = self.workspace_id.as_deref() {
            projection["workspaceId"] = json!(workspace_id);
        }
        if let Some(plugin_instance_ref) = binding.plugin_instance_ref() {
            projection["pluginInstanceRef"] = json!(plugin_instance_ref);
        }
        if let Some(workspace_mode) = self.process_workspace_mode.as_deref() {
            projection["processWorkspaceMode"] = json!(workspace_mode);
        }
        if let Some(execution_scope) = self.process_execution_scope.as_deref() {
            projection["processExecutionScope"] = json!(execution_scope);
        }
        projection
    }

    fn preview(&self, tool_name: &str) -> Value {
        let mut preview = json!({
            "summary": effect_summary(tool_name, &self.logical_targets, &self.canonical_invocation["arguments"]),
            "effects": process_effect_names(self),
            "logicalTargets": self.logical_targets,
            "operation": {
                "toolName": self.operation,
                "arguments": self.canonical_invocation["arguments"],
            },
        });
        if let Some(root) = &self.workspace_root {
            preview["operation"]["workspaceRoot"] = json!(root);
        }
        if let Some(scope) = &self.process_execution_scope {
            preview["operation"]["executionScope"] = json!(scope);
        }
        if self.binding.is_browser_page() {
            preview["authorizationScope"] = json!("sessionBrowser");
        }
        if self.is_host_process() {
            let reason = self.canonical_invocation["arguments"]["requestHostPermission"]
                .as_str()
                .map(|reason| format!("\n{reason}"))
                .unwrap_or_default();
            preview["summary"] = json!(format!(
                "以宿主用户权限{}{reason}",
                effect_summary(
                    tool_name,
                    &self.logical_targets,
                    &self.canonical_invocation["arguments"]
                )
            ));
        }
        // Preview and every grant consumer share this exact canonical binding.
        if let Some(context) = self.authorization_context() {
            preview["authorizationContext"] = context;
        }
        if is_shell_tool(&self.operation) {
            preview["authorizationScope"] = json!(if self.is_host_process() {
                "runHostShell"
            } else {
                "runCommand"
            });
            preview["authorizationScopes"] = if self.command_rule() == Some("ask") {
                json!([])
            } else if self.is_host_process() {
                json!([
                    "runCommand",
                    "sessionCommand",
                    "runHostShell",
                    "sessionHostShell"
                ])
            } else {
                json!(["runCommand", "sessionCommand"])
            };
        }
        if self.scope == PreparedEffectScope::Network
            || self.network_request.is_some() && !self.is_host_process()
        {
            preview["authorizationScope"] = json!("runNetwork");
            preview["authorizationScopes"] = json!(["runNetwork", "sessionNetwork"]);
            if let Some(reason) = &self.network_request {
                preview["summary"] = json!(format!(
                    "{}\nNetwork: {reason}",
                    preview["summary"].as_str().unwrap_or_default()
                ));
            }
        }
        if self.command_rule() == Some("ask") {
            preview["authorizationScopes"] = json!([]);
        }
        if let PreparedToolInput::Container { input, target } = &self.input {
            preview["summary"] = json!(format!(
                "{}\n{}",
                serde_json::to_string_pretty(input).expect("container input"),
                serde_json::to_string_pretty(target).expect("container target")
            ));
            if input.action == "exec" {
                preview["authorizationScope"] = json!("runContainer");
                preview["authorizationScopes"] = json!(["runContainer", "sessionContainer"]);
            }
        }
        if !self.file_requests.is_empty() {
            preview["authorizationScope"] = json!("runFiles");
            preview["fileAccess"] = self.file_requests.display();
            if let Some(reason) = &self.file_requests.reason {
                preview["summary"] = json!(format!(
                    "{}\n{reason}",
                    preview["summary"].as_str().unwrap_or_default()
                ));
            }
            preview["authorizationScopes"] = if self.git_write_requested || self.is_host_process() {
                json!([])
            } else {
                json!(["runFiles", "sessionFiles"])
            };
        }
        preview
    }

    fn command_authorization_context(&self) -> Option<Value> {
        if !is_shell_tool(&self.operation) {
            return None;
        }
        let args = &self.canonical_invocation["arguments"];
        let mut context = json!({
            "workspaceId":self.workspace_id, "workspaceRoot":self.workspace_root,
            "environment": {"shell":self.generation.executor_config.shell_program,
                "wsl":self.generation.executor_config.wsl, "executionPath":self.generation.executor_config.execution_path,
                "executionScope":self.process_execution_scope,
                "networkAccess":self.is_host_process() || self.file_access.network_access},
            "toolName":self.operation, "command":args["command"], "cwd":self.workspace_root,
            "terminal":args["terminal"], "workspaceMode":self.process_workspace_mode,
        });
        if let Some(backend) = &self.generation.executor_config.sandbox_backend {
            context["environment"]["sandboxBackend"] = json!(backend);
        }
        if !self.permissions.constraints.allow_host_execution
            || !self.permissions.constraints.allow_external_tools
        {
            context["environment"]["policyConstraints"] = json!(self.permissions.constraints);
        }
        Some(context)
    }

    fn command_rule(&self) -> Option<&str> {
        if !is_shell_tool(&self.operation) {
            return None;
        }
        let context = self.authorization_context()?;
        self.permissions
            .command_rules
            .iter()
            .filter(|rule| rule.context == context)
            .max_by_key(|rule| match rule.decision.as_str() {
                "deny" => 3,
                "ask" => 2,
                _ => 1,
            })
            .map(|rule| rule.decision.as_str())
    }

    fn host_shell_authorization_context(&self) -> Option<Value> {
        if !is_shell_tool(&self.operation)
            || self.process_execution_scope.as_deref() != Some("host")
        {
            return None;
        }
        let mut context = self.command_authorization_context()?;
        for key in ["command", "cwd", "terminal", "workspaceMode", "toolName"] {
            context.as_object_mut().expect("shell context").remove(key);
        }
        Some(context)
    }
}

#[derive(Clone)]
struct LocalToolRecordStore {
    connection: Arc<Mutex<Connection>>,
}

impl LocalToolRecordStore {
    fn open(path: &Path) -> Result<Self, LocalAgentKernelError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                LocalAgentKernelError::new(
                    "tool_record_directory_failed",
                    format!("创建 ToolRecord Store 目录失败：{error}"),
                )
            })?;
        }
        let existed = path.exists();
        let connection = Connection::open(path).map_err(|error| {
            LocalAgentKernelError::new(
                "tool_record_store_open_failed",
                format!("打开 ToolRecord Store 失败：{error}"),
            )
        })?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_pragma_failed", error.to_string())
            })?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_pragma_failed", error.to_string())
            })?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_version_failed", error.to_string())
            })?;
        match version {
            0 if !existed || sqlite_is_empty(&connection)? => {
                connection.execute_batch(TOOL_RECORD_SCHEMA).map_err(|error| {
                    LocalAgentKernelError::new(
                        "tool_record_schema_failed",
                        format!("创建 ToolRecord schema 失败：{error}"),
                    )
                })?;
                verify_tool_record_store(&connection)?;
                verify_tool_record_store_version(&connection)?;
            }
            TOOL_RECORD_STORE_VERSION => {
                verify_tool_record_store(&connection)?;
                verify_tool_record_store_version(&connection)?;
            }
            other => {
                return Err(LocalAgentKernelError::new(
                    "tool_record_store_version_unsupported",
                    format!("ToolRecord Store schema {other} 不受支持；当前只接受 schema {TOOL_RECORD_STORE_VERSION}。"),
                ))
            }
        }
        #[cfg(feature = "debug-control")]
        debug_operations::initialize_store(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn read(&self, call_id: &str) -> Result<Option<Value>, LocalAgentKernelError> {
        let connection = self.connection.lock().map_err(|_| {
            LocalAgentKernelError::new("tool_record_lock_failed", "ToolRecord Store 锁已损坏。")
        })?;
        let encoded = connection
            .query_row(
                "SELECT record_json FROM tool_records
                 WHERE call_id=?1 ORDER BY completed_at DESC, rowid DESC LIMIT 1",
                params![call_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_read_failed", error.to_string())
            })?;
        encoded
            .map(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| {
                    LocalAgentKernelError::new(
                        "tool_record_corrupt",
                        format!("ToolRecord JSON 损坏：{error}"),
                    )
                })
            })
            .transpose()
    }

    fn insert(&self, record: &Value) -> Result<(), LocalAgentKernelError> {
        let prepared = record
            .get("preparedEffect")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                LocalAgentKernelError::new(
                    "tool_record_invalid",
                    "ToolRecord 缺少 PreparedEffect。",
                )
            })?;
        let encoded = serde_json::to_string(record).map_err(|error| {
            LocalAgentKernelError::new("tool_record_encode_failed", error.to_string())
        })?;
        self.connection
            .lock()
            .map_err(|_| {
                LocalAgentKernelError::new("tool_record_lock_failed", "ToolRecord Store 锁已损坏。")
            })?
            .execute(
                "INSERT INTO tool_records(
                     record_id, session_id, run_id, call_id, attempt_id, tool_name,
                     workspace_id, operation, logical_targets_json, authority_id,
                     outcome, record_json, started_at, completed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    required_record_string(record, "recordId")?,
                    required_record_string(record, "sessionId")?,
                    required_record_string(record, "runId")?,
                    required_record_string(record, "callId")?,
                    required_record_string(record, "attemptId")?,
                    required_record_string(record, "toolName")?,
                    prepared.get("workspaceId").and_then(Value::as_str),
                    prepared.get("operation").and_then(Value::as_str),
                    serde_json::to_string(
                        prepared
                            .get("logicalTargets")
                            .unwrap_or(&Value::Array(Vec::new()))
                    )
                    .map_err(|error| LocalAgentKernelError::new(
                        "tool_record_encode_failed",
                        error.to_string(),
                    ))?,
                    record
                        .pointer("/authority/authorityId")
                        .and_then(Value::as_str),
                    required_record_string(record, "outcome")?,
                    encoded,
                    required_record_string(record, "startedAt")?,
                    required_record_string(record, "completedAt")?,
                ],
            )
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_append_failed", error.to_string())
            })?;
        Ok(())
    }
}

fn validate_request(request: &LocalToolExecutionRequest) -> Result<(), LocalAgentKernelError> {
    if request.schema_version != KERNEL_REQUEST_VERSION || request.request_type != "tool.execute" {
        return Err(LocalAgentKernelError::new(
            "kernel_request_version_invalid",
            "Kernel 请求协议版本或类型无效。",
        ));
    }
    for (field, value) in [
        ("requestId", request.request_id.as_str()),
        ("sessionId", request.session_id.as_str()),
        ("runId", request.run_id.as_str()),
        (
            "extensionGenerationRef",
            request.extension_generation_ref.as_str(),
        ),
        (
            "kernelCatalogSnapshotRef",
            request.kernel_catalog_snapshot_ref.as_str(),
        ),
        ("toolBindingRef", request.tool_binding_ref.as_str()),
        ("callId", request.call_id.as_str()),
        ("attemptId", request.attempt_id.as_str()),
        ("toolName", request.tool_name.as_str()),
    ] {
        validate_id(field, value)?;
    }
    if !request.input.is_object() {
        return Err(LocalAgentKernelError::new(
            "tool_input_invalid",
            "工具输入必须是 JSON 对象。",
        ));
    }
    let mut seen = HashSet::new();
    for workspace_id in &request.workspace_bindings {
        validate_id("workspaceId", workspace_id)?;
        if !seen.insert(workspace_id) {
            return Err(LocalAgentKernelError::new(
                "session_workspace_snapshot_invalid",
                "workspaceBindings 不能重复。",
            ));
        }
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<(), LocalAgentKernelError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(LocalAgentKernelError::new(
            "kernel_request_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

fn take_workspace_id(input: &mut Value) -> Result<String, LocalAgentKernelError> {
    let object = input.as_object_mut().ok_or_else(|| {
        LocalAgentKernelError::input("$", "type", "工具输入必须是对象。", Some(json!("object")))
    })?;
    let value = object.remove("workspaceId").ok_or_else(|| {
        LocalAgentKernelError::input(
            "$.workspaceId",
            "required",
            "Workspace 工具必须显式携带 workspaceId。",
            Some(json!("string")),
        )
    })?;
    let workspace_id = value.as_str().ok_or_else(|| {
        LocalAgentKernelError::input(
            "$.workspaceId",
            "type",
            "workspaceId 必须是字符串。",
            Some(json!("string")),
        )
    })?;
    validate_id("workspaceId", workspace_id)?;
    Ok(workspace_id.to_string())
}

fn authority_matches_identity(
    authority: &Value,
    session_id: &str,
    run_id: &str,
    workspace_id: Option<&str>,
) -> bool {
    let Some(object) = authority.as_object() else {
        return false;
    };
    let allowed = [
        "authorityId",
        "planId",
        "revision",
        "decisionId",
        "sessionId",
        "runId",
        "workspaceId",
        "coveredOperations",
    ];
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return false;
    }
    object.get("sessionId").and_then(Value::as_str) == Some(session_id)
        && object.get("runId").and_then(Value::as_str) == Some(run_id)
        && object.get("workspaceId").and_then(Value::as_str) == workspace_id
        && object.get("authorityId").and_then(Value::as_str).is_some()
        && object.get("planId").and_then(Value::as_str).is_some()
        && object
            .get("revision")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0)
        && object.get("decisionId").and_then(Value::as_str).is_some()
        && object
            .get("coveredOperations")
            .and_then(Value::as_array)
            .is_some()
}

fn authority_covers(authority: &Value, prepared: &PreparedEffect) -> bool {
    let mut operation = json!({"workspaceId":prepared.workspace_id,"operation":prepared.operation});
    if is_shell_tool(&prepared.operation) {
        // The process receives the authority's writable paths during preparation.
        // Execution details may vary; a delegated Plan must prove every requested path below.
        operation["writablePaths"] = json!([]);
    } else {
        if prepared.logical_targets.len() != 1 {
            return false;
        }
        operation["target"] = json!(prepared.logical_targets[0]);
        if let Some(kind) = &prepared.delete_target_kind {
            operation["targetKind"] = json!(kind);
        }
    }
    authority["coveredOperations"]
        .as_array()
        .is_some_and(|scopes| {
            scopes
                .iter()
                .any(|scope| plan_operation_covers(scope, &operation))
        })
}

/// Shared effect/Plan coverage: delegation can narrow a confirmed scope, never widen it.
fn plan_operation_covers(scope: &Value, operation: &Value) -> bool {
    if scope["workspaceId"] != operation["workspaceId"] {
        return false;
    }
    let Some(name) = operation["operation"].as_str() else {
        return false;
    };
    if is_shell_tool(name) {
        if scope["operation"] != operation["operation"] {
            return false;
        }
        let Some(paths) = scope["writablePaths"]
            .as_array()
            .filter(|paths| !paths.is_empty())
        else {
            return false;
        };
        return operation["writablePaths"]
            .as_array()
            .is_some_and(|requested| {
                requested.iter().all(|target| {
                    paths.iter().any(|allowed| {
                        let (Some(path), Some(boundary)) =
                            (target["path"].as_str(), allowed["path"].as_str())
                        else {
                            return false;
                        };
                        match allowed["kind"].as_str() {
                            Some("file") => target["kind"] == "file" && path == boundary,
                            Some("directory") => Path::new(path).starts_with(Path::new(boundary)),
                            _ => false,
                        }
                    })
                })
            });
    }
    let same_operation = scope["operation"] == operation["operation"]
        || matches!(
            name,
            "fs.write" | "fs.edit" | "document.render" | "browser.capture"
        ) && matches!(
            scope["operation"].as_str(),
            Some("fs.write" | "fs.edit" | "document.render" | "browser.capture")
        );
    if !same_operation {
        return false;
    }
    let (Some(target), Some(boundary)) = (operation["target"].as_str(), scope["target"].as_str())
    else {
        return false;
    };
    if name == "fs.delete" {
        return target == boundary
            && scope["targetKind"] == operation["targetKind"]
            && scope.as_object().is_some_and(|object| object.len() == 4);
    }
    match scope["targetKind"].as_str() {
        Some("directoryTree") => {
            scope.as_object().is_some_and(|object| object.len() == 4)
                && Path::new(target).starts_with(Path::new(boundary))
                && (target != boundary || operation["targetKind"] == "directoryTree")
        }
        Some("file") => {
            scope.as_object().is_some_and(|object| object.len() == 4)
                && operation["targetKind"] != "directoryTree"
                && target == boundary
        }
        None => {
            scope.as_object().is_some_and(|object| object.len() == 3)
                && operation["targetKind"] != "directoryTree"
                && target == boundary
        }
        _ => false,
    }
}

fn permission_mode(
    settings: &Value,
    key: &'static str,
    default: PermissionMode,
) -> Result<PermissionMode, LocalAgentKernelError> {
    let Some(value) = settings.get(key) else {
        return Ok(default);
    };
    match value.as_str() {
        Some("allow") => Ok(PermissionMode::Allow),
        Some("ask") => Ok(PermissionMode::Ask),
        Some("deny") => Ok(PermissionMode::Deny),
        _ => Err(LocalAgentKernelError::new(
            "agent_permission_setting_invalid",
            format!("{key} 必须是 allow、ask 或 deny。"),
        )),
    }
}

fn workspace_mutation_mode(
    settings: &Value,
) -> Result<WorkspaceMutationMode, LocalAgentKernelError> {
    match settings
        .get("agent.permissions.workspaceMutation")
        .and_then(Value::as_str)
        .unwrap_or("plan")
    {
        "plan" => Ok(WorkspaceMutationMode::Plan),
        "review" => Ok(WorkspaceMutationMode::Review),
        "allow" => Ok(WorkspaceMutationMode::Allow),
        _ => Err(LocalAgentKernelError::new(
            "agent_permission_setting_invalid",
            "agent.permissions.workspaceMutation 必须是 plan、review 或 allow。",
        )),
    }
}

fn permission_setting_id(scope: PreparedEffectScope) -> &'static str {
    match scope {
        PreparedEffectScope::Network => "user-setting:agent.permissions.networkRead",
        PreparedEffectScope::External => "user-setting:agent.permissions.external",
        PreparedEffectScope::LocalRead
        | PreparedEffectScope::WorkspaceRead
        | PreparedEffectScope::WorkspaceMutation
        | PreparedEffectScope::Process => {
            unreachable!("workspace effects are not setting-authorized")
        }
    }
}

fn effect_names(scope: PreparedEffectScope) -> Vec<&'static str> {
    match scope {
        PreparedEffectScope::LocalRead => vec!["localRead"],
        PreparedEffectScope::WorkspaceRead => vec!["workspaceRead"],
        PreparedEffectScope::WorkspaceMutation => vec!["workspaceMutation"],
        PreparedEffectScope::Process => vec!["process"],
        PreparedEffectScope::Network => vec!["network"],
        PreparedEffectScope::External => vec!["external"],
    }
}

fn process_effect_names(prepared: &PreparedEffect) -> Vec<&'static str> {
    if prepared.binding.is_browser_service() && prepared.is_host_process() {
        return vec!["process", "external"];
    }
    if prepared.scope != PreparedEffectScope::Process {
        return effect_names(prepared.scope);
    }
    let mut effects = vec!["process"];
    if prepared.process_workspace_mode.as_deref() == Some("write") {
        effects.push("workspaceMutation");
    }
    if prepared.process_execution_scope.as_deref() == Some("host") {
        effects.push("external");
    }
    effects
}

fn effect_summary(tool_name: &str, targets: &[String], canonical_arguments: &Value) -> String {
    if is_shell_tool(tool_name) {
        let command = canonical_arguments
            .get("command")
            .and_then(Value::as_str)
            .expect("canonical bash arguments include command");
        return format!("执行 {tool_name}：{command}");
    }
    if tool_name == "browser.service" && canonical_arguments["action"] == "start" {
        return format!(
            "启动服务：{} {}，目录 {}",
            canonical_arguments["command"],
            canonical_arguments["args"],
            canonical_arguments["directory"]
        );
    }
    if targets.is_empty() {
        format!("执行 {tool_name}")
    } else {
        format!("执行 {tool_name}：{}", targets.join(", "))
    }
}

fn tool_record_from_execution_result(
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
    authority: Value,
    started_at: &str,
    completed_at: &str,
    result: KernelToolExecutionResult,
) -> Result<Value, LocalAgentKernelError> {
    match result.outcome {
        KernelToolExecutionOutcome::Completed => {
            if result.error.is_some() {
                return Err(LocalAgentKernelError::new(
                    "tool_execution_result_invalid",
                    "Kernel completed result 不能携带 failure。",
                ));
            }
            tool_record(
                request,
                prepared,
                authority,
                started_at,
                completed_at,
                "completed",
                Some(result.output),
                None,
            )
        }
        KernelToolExecutionOutcome::Failed => {
            let error = result.error.ok_or_else(|| {
                LocalAgentKernelError::new(
                    "tool_execution_result_invalid",
                    "Kernel failed result 缺少 failure。",
                )
            })?;
            tool_record(
                request,
                prepared,
                authority,
                started_at,
                completed_at,
                "failed",
                Some(result.output),
                Some(json!({
                    "code": error.code,
                    "message": error.message,
                })),
            )
        }
    }
}

fn tool_record(
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
    authority: Value,
    started_at: &str,
    completed_at: &str,
    outcome: &str,
    output: Option<Value>,
    error: Option<Value>,
) -> Result<Value, LocalAgentKernelError> {
    let mut record = json!({
        "recordId": random_id("record")?,
        "sessionId": request.session_id,
        "runId": request.run_id,
        "extensionGenerationRef": request.extension_generation_ref,
        "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
        "toolBindingRef": request.tool_binding_ref,
        "callId": request.call_id,
        "attemptId": request.attempt_id,
        "toolName": request.tool_name,
        "input": request.input,
        "preparedEffect": prepared.projection(request),
        "authority": authority,
        "startedAt": started_at,
        "completedAt": completed_at,
        "outcome": outcome,
    });
    if let Some(output) = output {
        record["output"] = output;
    }
    if let Some(error) = error {
        record["error"] = error;
    }
    Ok(record)
}

fn input_rejection(request: &LocalToolExecutionRequest, error: LocalAgentKernelError) -> Value {
    json!({
        "sessionId": request.session_id,
        "runId": request.run_id,
        "extensionGenerationRef": request.extension_generation_ref,
        "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
        "toolBindingRef": request.tool_binding_ref,
        "callId": request.call_id,
        "attemptId": request.attempt_id,
        "toolName": request.tool_name,
        "input": request.input,
        "rejectedAt": crate::now_text(),
        "error": { "code": error.code, "message": error.message, "issues": error.input_issues }
    })
}

fn input_rejection_reply(
    request: &LocalToolExecutionRequest,
    error: LocalAgentKernelError,
) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.execution",
        "requestId": request.request_id,
        "callId": request.call_id,
        "status": "inputRejected",
        "rejection": input_rejection(request, error),
    })
}

fn approval_reply(
    kernel: &LocalAgentKernel,
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
) -> Result<Value, LocalAgentKernelError> {
    let mut preview = prepared.preview(&prepared.operation);
    if let Some(authority) = &request.non_workspace_authority {
        let reason = kernel
            .call_authority_invalidation(request, prepared)?
            .ok_or_else(|| {
                LocalAgentKernelError::new(
                    "approval_no_progress",
                    "已记录的授权仍有效，但同一操作再次要求审批；未重复审查或执行。",
                )
            })?;
        preview["revalidation"] = json!({"authorityId":authority.authority_id,"reason":reason});
    }
    let shell_mode = match prepared.permissions.shell {
        ShellApprovalMode::Ask => "ask",
        ShellApprovalMode::Review => "review",
        ShellApprovalMode::Allow => "allow",
    };
    let (subject, mode) = if is_shell_tool(&prepared.operation)
        || matches!(prepared.input, PreparedToolInput::Container { .. })
    {
        (
            if is_shell_tool(&prepared.operation) {
                "shell"
            } else {
                "container"
            },
            json!(shell_mode),
        )
    } else if prepared.file_authority_required {
        ("files", json!(shell_mode))
    } else if prepared.scope == PreparedEffectScope::Network {
        (
            "network",
            prepared.permissions.settings["agent.permissions.networkRead"].clone(),
        )
    } else {
        (
            "external",
            prepared.permissions.settings["agent.permissions.external"].clone(),
        )
    };
    preview["reviewPolicy"] = json!({"subject":subject,"mode":mode,
        "commandRule":prepared.command_rule(),"constraints":prepared.permissions.constraints,
        "reviewGrant":"thisCallOnly"});
    preview["approvalReviewer"] = json!(if prepared.agent_can_review() {
        "agent"
    } else {
        "user"
    });
    Ok(json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.execution",
        "requestId": request.request_id,
        "callId": request.call_id,
        "status": "approvalRequired",
        "approvalId": random_id("approval")?,
        "preview": preview,
    }))
}

fn execution_reply(request: &LocalToolExecutionRequest, record: &Value) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.execution",
        "requestId": request.request_id,
        "callId": request.call_id,
        "status": record.get("outcome").cloned().unwrap_or(Value::Null),
        "record": record,
    })
}

fn cancel_reply(call_id: &str, attempt_id: &str, status: &str, record: Option<Value>) -> Value {
    let mut reply = json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.cancelled",
        "requestId": format!("cancel:{call_id}"),
        "callId": call_id,
        "attemptId": attempt_id,
        "status": status,
    });
    if let Some(record) = record {
        reply["record"] = record;
    }
    reply
}

fn validate_record_replay(
    record: &Value,
    request: &LocalToolExecutionRequest,
) -> Result<(), LocalAgentKernelError> {
    let exact = [
        ("sessionId", request.session_id.as_str()),
        ("runId", request.run_id.as_str()),
        (
            "extensionGenerationRef",
            request.extension_generation_ref.as_str(),
        ),
        (
            "kernelCatalogSnapshotRef",
            request.kernel_catalog_snapshot_ref.as_str(),
        ),
        ("toolBindingRef", request.tool_binding_ref.as_str()),
        ("callId", request.call_id.as_str()),
        ("attemptId", request.attempt_id.as_str()),
        ("toolName", request.tool_name.as_str()),
    ]
    .into_iter()
    .all(|(field, expected)| record.get(field).and_then(Value::as_str) == Some(expected));
    if !exact || record.get("input") != Some(&request.input) {
        return Err(LocalAgentKernelError::new(
            "tool_call_identity_conflict",
            "callId 已绑定到其他工具调用。",
        ));
    }
    Ok(())
}

fn required_record_string<'a>(
    record: &'a Value,
    field: &str,
) -> Result<&'a str, LocalAgentKernelError> {
    record.get(field).and_then(Value::as_str).ok_or_else(|| {
        LocalAgentKernelError::new("tool_record_invalid", format!("ToolRecord 缺少 {field}。"))
    })
}

fn random_id(prefix: &str) -> Result<String, LocalAgentKernelError> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| {
        LocalAgentKernelError::new("local_agent_entropy_failed", "无法生成本地记录标识。")
    })?;
    let mut value = format!("{prefix}:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn verify_tool_record_store(connection: &Connection) -> Result<(), LocalAgentKernelError> {
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tool_records')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_verify_failed", error.to_string())
        })?;
    if !present {
        return Err(LocalAgentKernelError::new(
            "tool_record_store_schema_incomplete",
            "ToolRecord Store 缺少 tool_records 表。",
        ));
    }
    Ok(())
}

fn verify_tool_record_store_version(connection: &Connection) -> Result<(), LocalAgentKernelError> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_version_failed", error.to_string())
        })?;
    if version != TOOL_RECORD_STORE_VERSION {
        return Err(LocalAgentKernelError::new(
            "tool_record_store_version_mismatch",
            format!(
                "ToolRecord Store schema {version} 不是当前 schema {TOOL_RECORD_STORE_VERSION}。"
            ),
        ));
    }
    Ok(())
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, LocalAgentKernelError> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_empty_check_failed", error.to_string())
        })
}

fn is_shell_tool(name: &str) -> bool {
    matches!(name, "bash" | "powershell")
}

fn is_confirmed_workspace_shell_cancellation(
    prepared: &PreparedEffect,
    result: &KernelToolExecutionResult,
) -> bool {
    // The Linux workspace executor returns this result only after process
    // reaping, output archival and temporary-directory cleanup have succeeded.
    // Other executors and cleanup errors retain the indeterminate outcome.
    cfg!(target_os = "linux")
        && prepared.source_binding.is_none()
        && matches!(
            &prepared.input,
            PreparedToolInput::Builtin(
                KernelCanonicalInvocation::ProcessShell {
                    execution_scope: KernelExecutionScope::Workspace,
                    ..
                } | KernelCanonicalInvocation::ProcessPowerShell {
                    execution_scope: KernelExecutionScope::Workspace,
                    ..
                }
            )
        )
        && result.outcome == KernelToolExecutionOutcome::Failed
        && result
            .error
            .as_ref()
            .is_some_and(|error| error.code == "tool_execution_cancelled")
}

#[cfg(test)]
mod attempt_control_tests {
    use super::*;

    pub(super) fn kernel_with_request(
        resolver: Arc<dyn WorkspaceResolverPort>,
        tool_name: &str,
        input: Value,
    ) -> (LocalAgentKernel, LocalToolExecutionRequest, Value) {
        kernel_with_product_tools(
            resolver,
            tool_name,
            input,
            crate::local_agent_product_tools::test_product_tools(),
        )
    }

    fn kernel_with_product_tools(
        resolver: Arc<dyn WorkspaceResolverPort>,
        tool_name: &str,
        input: Value,
        product: Arc<crate::local_agent_product_tools::ProductTools>,
    ) -> (LocalAgentKernel, LocalToolExecutionRequest, Value) {
        kernel_with_executor(
            resolver,
            tool_name,
            input,
            product,
            KernelExecutorConfig::default(),
        )
    }

    fn kernel_with_executor(
        resolver: Arc<dyn WorkspaceResolverPort>,
        tool_name: &str,
        input: Value,
        product: Arc<crate::local_agent_product_tools::ProductTools>,
        config: KernelExecutorConfig,
    ) -> (LocalAgentKernel, LocalToolExecutionRequest, Value) {
        let bindings = json!([{"workspaceId":"workspace:test", "displayName":"Fixture"}]);
        kernel_with_workspaces(resolver, tool_name, input, product, config, bindings)
    }

    fn kernel_with_workspaces(
        resolver: Arc<dyn WorkspaceResolverPort>,
        tool_name: &str,
        input: Value,
        product: Arc<crate::local_agent_product_tools::ProductTools>,
        config: KernelExecutorConfig,
        bindings: Value,
    ) -> (LocalAgentKernel, LocalToolExecutionRequest, Value) {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:reject", "Input rejection", &bindings, None, None)
            .unwrap();
        let mut kernel =
            LocalAgentKernel::open(Path::new(":memory:"), journal.clone(), resolver).unwrap();
        // An in-memory record store has no sibling directory; ":memory:.outputs" is
        // a relative path on Unix and an invalid file name on Windows.
        kernel.output_root =
            std::env::temp_dir().join(random_id("kernel-test-outputs").unwrap().replace(':', "-"));
        let generation = LocalAgentKernel::prepare_generation(
            "extension:test",
            config,
            Arc::new(achbit_kernel_runtime::executors::EmptySecretProvider),
            McpRuntime::default(),
            LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
            &Default::default(),
            false,
            product,
        )
        .unwrap();
        let catalog = kernel
            .bind_run_catalog(
                PrepareToolCatalogRequest::new("session:reject", "run:reject", "extension:test"),
                generation,
            )
            .unwrap();
        let tools = catalog["tools"].as_array().unwrap();
        let binding =
            tools.iter().find(|tool| tool["name"] == tool_name).unwrap()["toolBindingRef"].clone();
        let mut aliases: Vec<Value> = tools.iter().filter(|tool| tool["availability"] == "callable").map(|tool| json!({"canonicalName":tool["name"],"wireName":tool["name"].as_str().unwrap().replace('.', "_")})).collect();
        aliases.extend([
            json!({"canonicalName":"interaction.request","wireName":"interaction_request"}),
            json!({"canonicalName":"plan.publish","wireName":"plan_publish"}),
        ]);
        journal.append(&json!({
            "type":"run.started", "sessionId":"session:reject", "runId":"run:reject",
            "payload":{"inputMessageId":"message:reject", "workspaceBindings":bindings,
                "runtimeSnapshot":{
                    "agentCapabilities":{"messaging":true,"continuation":true,"delegation":true},
                    "permissions":crate::settings_api::permission_settings(&json!({})),
                    "contextManagement":{"enabled":false,"thresholdTokens":500_000},
                    "runRuntimeSnapshotRef":"runtime:test", "extensionGenerationRef":"extension:test",
                    "kernelCatalogSnapshotRef":catalog["kernelCatalogSnapshotRef"],
                    "provider":{"providerRuntimeRef":"provider:test", "profileId":"profile:test", "contextWindowTokens":4096, "maxOutputTokens":512, "apiSurface":"chatCompletions", "hostedWebSearch":"none"},
                    "webSearch":{"owner":"unavailable"}, "environment":{"os":"fixture","arch":"fixture","locale":null,"responseLanguage":null,"userShell":null,"executionTarget":{"kind":"native"},"shell":{"tool":"bash","executable":"bash","dialect":"bash"},"executionPath":"fixture-bin","shellAvailable":true,"workspaceShellSupported":true,"developerCommands":[]}, "instructions":[], "tools":tools,
                    "toolPromptContributions":[], "providerToolAliases":aliases,
                    "selectedPlugins":{"catalogRevision":"plugins:test","plugins":[]}
                }}
        })).unwrap();
        let request: LocalToolExecutionRequest = serde_json::from_value(json!({
            "schemaVersion":KERNEL_REQUEST_VERSION, "type":"tool.execute", "requestId":"request:reject", "sessionId":"session:reject", "runId":"run:reject",
            "extensionGenerationRef":"extension:test", "kernelCatalogSnapshotRef":catalog["kernelCatalogSnapshotRef"],
            "toolBindingRef":binding, "callId":"call:reject", "attemptId":"attempt:reject", "toolName":tool_name,
            "workspaceBindings":bindings.as_array().unwrap().iter().map(|binding| binding["workspaceId"].clone()).collect::<Vec<_>>(), "input":input
        })).unwrap();
        (kernel, request, catalog)
    }

    #[cfg(unix)]
    #[test]
    fn managed_shell_reuses_admission_and_can_be_waited_then_cancelled() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::temp_dir().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let product = Arc::try_unwrap(crate::local_agent_product_tools::test_product_tools())
            .ok()
            .unwrap();
        let config = KernelExecutorConfig {
            shell_program: Some(
                achbit_kernel_runtime::shell_environment::discover("bash").unwrap(),
            ),
            execution_path: Some(
                achbit_kernel_runtime::shell_environment::resolved_agent_shell_path()
                    .unwrap()
                    .into_string()
                    .unwrap(),
            ),
            ..Default::default()
        };
        let (mut kernel, request, _) = kernel_with_executor(
            Arc::new(Workspace),
            "process",
            json!({"workspaceId":"workspace:test", "action":"start", "tool":"bash",
                "input":{"command":"printf managed-ready; sleep 30", "requestHostPermission":"Run the test shell"}}),
            Arc::new(product),
            config,
        );
        let root = std::env::temp_dir().join(random_id("managed-test").unwrap());
        kernel.output_root = root.clone();
        assert_eq!(
            kernel.execute(request.clone()).unwrap()["status"],
            "approvalRequired"
        );
        assert!(kernel
            .jobs
            .snapshots(&request.session_id, &request.run_id, &Default::default(), 0)
            .unwrap()
            .is_empty());
        kernel.journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"command:allow","patches":{"agent.permissions.shell":"allow","agent.permissions.shellAccess":"full"}}})).unwrap();
        let started = kernel.execute(request.clone()).unwrap();
        assert_eq!(started["status"], "completed", "{started}");
        assert_eq!(started["record"]["preparedEffect"]["toolName"], "process");
        assert_eq!(started["record"]["preparedEffect"]["operation"], "bash");
        let job_id = started["record"]["output"]["job"]["jobId"]
            .as_str()
            .unwrap();
        let mut control = request.clone();
        control.call_id = "call:wait".into();
        control.attempt_id = "attempt:wait".into();
        control.input = json!({"action":"wait", "jobId":job_id, "waitSeconds":1});
        let waiting = kernel.execute(control.clone()).unwrap();
        assert_eq!(
            waiting["record"]["output"]["job"]["status"], "active",
            "{waiting}"
        );
        assert_eq!(waiting["record"]["output"]["wait"]["jobId"], job_id);
        let sampled = kernel
            .jobs
            .control(
                &request.session_id,
                &request.run_id,
                job_id,
                "wait",
                Some(1),
                &Default::default(),
            )
            .unwrap();
        assert_eq!(sampled["output"]["stdout"], "managed-ready");
        assert!(kernel
            .jobs
            .control(
                "session:other",
                &request.run_id,
                job_id,
                "cancel",
                None,
                &Default::default()
            )
            .is_err());
        control.call_id = "call:cancel".into();
        control.attempt_id = "attempt:cancel".into();
        control.input = json!({"action":"cancel", "jobId":job_id});
        let stopped = kernel.execute(control).unwrap();
        let job = &stopped["record"]["output"]["job"];
        assert_eq!(job["status"], "cancelled", "{stopped}");
        assert_eq!(job["result"]["success"], false);
        let output = job["result"]["fullOutput"]["stdout"]["path"]
            .as_str()
            .unwrap();
        assert_eq!(std::fs::read_to_string(output).unwrap(), "managed-ready");
        kernel
            .jobs
            .release_run(&request.session_id, &request.run_id)
            .unwrap();
        assert!(kernel
            .jobs
            .snapshots(&request.session_id, &request.run_id, &Default::default(), 0)
            .unwrap()
            .is_empty());
        kernel.shutdown_plugins().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_rules_precede_shell_permissions_without_spawning() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"rm -rf /"}),
        );
        let mut effect = kernel.prepare_tool(&request).unwrap();
        for policy in ["allow", "ask", "deny"] {
            effect.generation = Arc::new(KernelGeneration {
                catalog: effect.generation.catalog.clone(),
                executor_config: effect.generation.executor_config.clone(),
                permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                    "agent.permissions.external": policy,
                    "agent.permissions.workspaceMutation":"allow",
                }))
                .unwrap(),
            });
            effect.permissions = effect.generation.permissions.clone();
            assert!(matches!(kernel.admit(&request, &effect).unwrap(),
                Admission::Denied { authority, error }
                if authority["matchedRule"] == "rm -rf /"
                    && error["code"] == "command_denied_by_rule"
                    && error.as_object().unwrap().len() == 2));
        }
        effect.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.external":"allow",
                "agent.permissions.workspaceMutation":"allow",
                "agent.permissions.commandDenylist":[],
            }))
            .unwrap(),
        });
        effect.permissions = effect.generation.permissions.clone();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        assert!(kernel.records.read(&request.call_id).unwrap().is_none());
    }

    #[test]
    fn session_workdir_writes_remain_authorized_during_a_plan_and_check_owner() {
        struct Workdir {
            path: PathBuf,
            owner: String,
        }
        impl WorkspaceResolverPort for Workdir {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: self.path.to_string_lossy().into(),
                    access: WorkspaceAccess::SessionWorkdir(self.owner.clone()),
                })
            }
        }
        impl Drop for Workdir {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.path).unwrap();
            }
        }
        let path = std::env::temp_dir().join(random_id("session-draft").unwrap().replace(':', "-"));
        std::fs::create_dir(&path).unwrap();
        let root = Arc::new(Workdir {
            path,
            owner: "session:reject".into(),
        });
        let (mut kernel, mut request, _) = kernel_with_request(
            root.clone(),
            "fs.write",
            json!({"workspaceId":"workspace:test", "path":"preview.html", "content":"<button>First</button>"}),
        );
        kernel.output_root = root.path.join("tool-outputs");
        kernel.journal.append(&json!({"type":"plan.published", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
            "payload":{"providerCallId":"provider:plan", "planId":"plan:inspect", "revision":1, "title":"Inspect", "summary":"No project writes", "steps":[{"stepId":"step:check", "title":"Inspect", "details":"Inspect project", "verification":["Report findings"]}], "mutationManifest":[]}})).unwrap();
        kernel.journal.append(&json!({"type":"plan.confirmed", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
            "payload":{"planId":"plan:inspect", "revision":1, "commandId":"command:plan", "decisionId":"decision:plan", "authorities":[]}})).unwrap();
        let first = kernel.execute(request.clone()).unwrap();
        assert_eq!(first["record"]["outcome"], "completed");
        assert_eq!(first["record"]["authority"]["source"], "sessionWorkdir");
        request.call_id = "call:revise".into();
        request.attempt_id = "attempt:revise".into();
        request.input["content"] = json!("<button style=\"background:white\">First</button>");
        assert_eq!(
            kernel.execute(request).unwrap()["record"]["outcome"],
            "completed"
        );
        assert_eq!(
            std::fs::read_to_string(root.path.join("preview.html")).unwrap(),
            "<button style=\"background:white\">First</button>"
        );

        let path = std::env::temp_dir().join(random_id("other-draft").unwrap().replace(':', "-"));
        std::fs::create_dir(&path).unwrap();
        let other = Arc::new(Workdir {
            path,
            owner: "session:other".into(),
        });
        let (kernel, request, _) = kernel_with_request(
            other.clone(),
            "fs.write",
            json!({"workspaceId":"workspace:test", "path":"preview.html", "content":"not authorized"}),
        );
        let rejected = kernel.execute(request).unwrap();
        assert_eq!(rejected["status"], "inputRejected");
        assert!(!other.path.join("preview.html").exists());
    }

    #[test]
    fn workdir_plan_admission_preserves_shell_and_parent_scope() {
        struct Workspaces;
        impl WorkspaceResolverPort for Workspaces {
            fn resolve(&self, id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: match id {
                        "workspace:test" => {
                            WorkspaceAccess::SessionWorkdir("session:reject".into())
                        }
                        "workspace:other" => {
                            WorkspaceAccess::SessionWorkdir("session:other".into())
                        }
                        _ => WorkspaceAccess::Project,
                    },
                })
            }
        }
        let (kernel, request, _) = kernel_with_workspaces(
            Arc::new(Workspaces),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"printf approved", "requestHostPermission":"Inspect the host environment"}),
            crate::local_agent_product_tools::test_product_tools(),
            KernelExecutorConfig::default(),
            json!([{"workspaceId":"workspace:test","displayName":"Draft"},
                {"workspaceId":"workspace:project","displayName":"Project"},
                {"workspaceId":"workspace:other","displayName":"Other"}]),
        );
        let admission = |manifest| {
            kernel.plan_admission(PlanAdmissionRequest {
                session_id: request.session_id.clone(),
                run_id: request.run_id.clone(),
                mutation_manifest: manifest,
            })
        };
        let temp = json!([
            {"workspaceId":"workspace:test","operation":"fs.write","target":"draft.txt"},
            {"workspaceId":"workspace:test","operation":"bash","command":"printf approved",
                "writablePaths":[{"path":"drafts","kind":"directory"}]}]);
        assert_eq!(
            admission(temp.clone()).unwrap(),
            json!({"source":"sessionWorkdir","authorities":[]})
        );
        assert!(matches!(
            kernel
                .admit(&request, &kernel.prepare_tool(&request).unwrap())
                .unwrap(),
            Admission::ApprovalRequired
        ));
        assert_eq!(admission(json!([{"workspaceId":"workspace:other","operation":"fs.write","target":"draft.txt"}])).unwrap_err().code,
            "tool_input_invalid");
        assert_eq!(admission(json!([{"workspaceId":"workspace:unbound","operation":"fs.write","target":"draft.txt"}])).unwrap_err().code,
            "plan_workspace_binding_invalid");
        let project =
            json!({"workspaceId":"workspace:project","operation":"fs.write","target":"report.txt"});
        let mut mixed = temp.as_array().unwrap().clone();
        mixed.push(project.clone());
        assert_eq!(admission(json!(mixed)).unwrap()["source"], "user");
        let journal = &kernel.journal;
        journal
            .create_session("session:parent", "Parent", &json!([]), None, None)
            .unwrap();
        let runtime = journal
            .read_events(&request.session_id, 0)
            .unwrap()
            .into_iter()
            .find(|event| event["type"] == "run.started")
            .unwrap()["payload"]["runtimeSnapshot"]
            .clone();
        journal.append(&json!({"type":"run.started","sessionId":"session:parent","runId":"run:parent",
            "payload":{"inputMessageId":"message:parent","workspaceBindings":[{"workspaceId":"workspace:project","displayName":"Project"}],"runtimeSnapshot":runtime}})).unwrap();
        let authority = json!({"authorityId":"authority:project","planId":"plan:project","revision":1,
            "decisionId":"decision:project","sessionId":"session:parent","runId":"run:parent","workspaceId":"workspace:project","coveredOperations":[project]});
        journal.append(&json!({"type":"plan.published","sessionId":"session:parent","runId":"run:parent","callId":"call:plan",
            "payload":{"providerCallId":"provider:plan","planId":"plan:project","revision":1,"title":"Report","summary":"Write the report",
                "steps":[{"stepId":"write","title":"Write","details":"Write report.txt"}],"mutationManifest":[project]}})).unwrap();
        journal.append(&json!({"type":"plan.confirmed","sessionId":"session:parent","runId":"run:parent","callId":"call:plan",
            "payload":{"planId":"plan:project","revision":1,"commandId":"confirm:project","decisionId":"decision:project","source":"user","authorities":[authority]}})).unwrap();
        journal.append(&json!({"type":"agent.task.created","sessionId":"session:parent","runId":"run:parent","callId":"call:spawn",
            "payload":{"taskId":"task:child","agentSessionId":request.session_id,"capabilities":{"messaging":true,"continuation":true,"delegation":true},
                "createsAgent":false,"displayName":"Writer","text":"Write report","delivery":"async"}})).unwrap();
        journal.append(&json!({"type":"agent.task.started","sessionId":"session:parent","runId":"run:parent",
            "payload":{"taskId":"task:child","childRunId":request.run_id}})).unwrap();
        assert_eq!(
            admission(temp).unwrap(),
            json!({"source":"sessionWorkdir","authorities":[]})
        );
        assert_eq!(
            admission(json!(mixed)).unwrap(),
            json!({"source":"parent","authorities":[authority]})
        );
        mixed.last_mut().unwrap()["target"] = json!("outside.txt");
        assert_eq!(admission(json!(mixed)).unwrap()["source"], "user");
    }

    #[test]
    fn shell_approval_binds_actual_request_and_revocation_precedes_reuse() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::SessionWorkdir("session:reject".into()),
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test","command":"printf approved","requestHostPermission":"Use the selected environment"}),
        );
        let effect = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        request.non_workspace_authority = Some(NonWorkspaceAuthority {
            authority_id: "authority:invented".into(),
            decision: "allow".into(),
        });
        assert!(
            matches!(kernel.admit(&request, &effect), Err(error) if error.code == "non_workspace_authority_invalid")
        );
        request.non_workspace_authority = None;
        kernel.journal.append(&json!({"type":"tool.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"providerCallId":"provider:grant","attemptId":request.attempt_id,"toolName":"bash","input":request.input}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:grant","preview":effect.preview("bash")}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:grant","commandId":"command:grant","decision":"allow","source":"user","authorityId":"authority:grant","authorizationScope":"runCommand"}})).unwrap();
        request.non_workspace_authority = Some(NonWorkspaceAuthority {
            authority_id: "authority:grant".into(),
            decision: "allow".into(),
        });
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        let mut changed = request.clone();
        changed.input["command"] = json!("printf changed");
        let changed_effect = kernel.prepare_tool(&changed).unwrap();
        assert!(
            matches!(
                kernel.admit(&changed, &changed_effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "An approval never follows changed input, even with the same call ID"
        );
        changed = request.clone();
        changed.call_id = "call:repeat".into();
        changed.non_workspace_authority = None;
        assert!(
            matches!(
                kernel.admit(&changed, &effect).unwrap(),
                Admission::Allowed(_)
            ),
            "An explicit command grant can cover a later identical command in this run"
        );
        kernel.journal.append(&json!({"type":"approval.revoked","sessionId":request.session_id,"runId":request.run_id,
            "payload":{"commandId":"command:revoke","authorityId":"authority:grant"}})).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        assert!(matches!(
            kernel.admit(&changed, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:renewed","preview":effect.preview("bash")}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:renewed","commandId":"command:renewed","decision":"allow","source":"user","authorityId":"authority:renewed","authorizationScope":"runCommand"}})).unwrap();
        request
            .non_workspace_authority
            .as_mut()
            .unwrap()
            .authority_id = "authority:renewed".into();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        kernel
            .journal
            .append(
                &json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"command:policy","patches":{"agent.permissions.shell":"ask"}}}),
            )
            .unwrap();
        assert!(
            matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "A policy change invalidates an unconsumed call approval"
        );
        assert!(
            matches!(
                kernel.admit(&changed, &effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "The Kernel also stops reusing the grant without depending on a projection"
        );
    }

    #[test]
    fn host_network_approval_uses_one_binding_for_user_model_and_managed_calls() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::SessionWorkdir("session:reject".into()),
                })
            }
        }
        for (tool, source) in [("bash", "user"), ("bash", "agent"), ("process", "agent")] {
            let args = json!({"command":"printf authorized", "requestHostPermission":"Run the requested check",
                "requestNetworkPermission":"Network is already available to Host"});
            let mut input = if tool == "process" {
                json!({"action":"start","tool":"bash","input":args})
            } else {
                args
            };
            input["workspaceId"] = json!("workspace:test");
            let product = Arc::try_unwrap(crate::local_agent_product_tools::test_product_tools())
                .ok()
                .unwrap();
            let (kernel, mut request, _) =
                kernel_with_product_tools(Arc::new(Workspace), tool, input, Arc::new(product));
            kernel
                .journal
                .append(
                    &json!({"type":"session.permissions.updated","sessionId":request.session_id,
                "payload":{"commandId":"delegate","patches":{"agent.permissions.shell":"review"}}}),
                )
                .unwrap();
            let effect = kernel.prepare_tool(&request).unwrap();
            let preview = effect.preview(tool);
            assert_eq!(
                preview["authorizationContext"],
                effect.authorization_context().unwrap()
            );
            assert!(preview["authorizationContext"]
                .get("networkEnvironment")
                .is_none());
            assert_eq!(
                preview["authorizationContext"]["environment"]["networkAccess"],
                true
            );
            let mut without_network = request.clone();
            let args = if tool == "process" {
                &mut without_network.input["input"]
            } else {
                &mut without_network.input
            };
            args.as_object_mut()
                .unwrap()
                .remove("requestNetworkPermission");
            assert_eq!(
                effect.authorization_context(),
                kernel
                    .prepare_tool(&without_network)
                    .unwrap()
                    .authorization_context()
            );
            assert!(matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ));
            kernel.journal.append(&json!({"type":"tool.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"providerCallId":"provider:call","attemptId":request.attempt_id,"toolName":tool,"input":request.input}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":"approval:aligned","preview":approval_reply(&kernel, &request, &effect).unwrap()["preview"]}})).unwrap();
            if source == "agent" {
                kernel.journal.append(&json!({"type":"provider.turn.settled","sessionId":request.session_id,"runId":request.run_id,
                    "payload":{"providerRequestId":"provider:review","purpose":"approvalReview","providerRuntimeRef":"runtime:review","outcome":"completed","orderedCallIds":[]}})).unwrap();
                kernel.journal.append(&json!({"type":"approval.reviewed","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                    "payload":{"approvalId":"approval:aligned","providerRequestId":"provider:review","decision":"allow","reason":"Within the task."}})).unwrap();
            }
            kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":"approval:aligned","commandId":"decision:aligned","authorityId":"authority:aligned","decision":"allow","source":source}})).unwrap();
            request.non_workspace_authority = Some(NonWorkspaceAuthority {
                authority_id: "authority:aligned".into(),
                decision: "allow".into(),
            });
            assert!(matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::Allowed(_)
            ));
            assert_eq!(
                approval_reply(&kernel, &request, &effect).unwrap_err().code,
                "approval_no_progress"
            );
            kernel.journal.append(&json!({"type":"approval.revoked","sessionId":request.session_id,"runId":request.run_id,
                "payload":{"commandId":"revoke:aligned","authorityId":"authority:aligned"}})).unwrap();
            assert_eq!(
                approval_reply(&kernel, &request, &effect).unwrap()["preview"]["revalidation"]
                    ["reason"],
                "revoked"
            );
            // The original metadata is still retained; normalization never edits the request.
            let original_args = if tool == "process" {
                &request.input["input"]
            } else {
                &request.input
            };
            assert!(original_args["requestNetworkPermission"].is_string());
        }
    }

    #[test]
    fn model_approval_requires_explicit_current_delegation_and_a_review_fact() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::SessionWorkdir("session:reject".into()),
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test","command":"printf review","requestHostPermission":"Use the selected environment"}),
        );
        let mut effect = kernel.prepare_tool(&request).unwrap();
        kernel.journal.append(&json!({"type":"tool.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"providerCallId":"provider:review","attemptId":request.attempt_id,"toolName":"bash","input":request.input}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:review","preview":effect.preview("bash")}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:review","commandId":"decision:review","decision":"allow","source":"agent","authorityId":"authority:review","authorizationScope":"runHostShell"}})).unwrap();
        request.non_workspace_authority = Some(NonWorkspaceAuthority {
            authority_id: "authority:review".into(),
            decision: "allow".into(),
        });
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        effect.permissions = LocalAgentPermissionPolicy::from_settings(
            &json!({"agent.permissions.shell":"review","agent.permissions.shellAccess":"full"}),
        )
        .unwrap();
        assert!(
            matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "Delegation does not turn an unreviewed claim into authorization"
        );
        request.non_workspace_authority = None;
        request.call_id = "call:later".into();
        assert!(
            matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "The Agent cannot mint a reusable Host grant"
        );
        request.call_id = "call:reject".into();
        let environment = effect.file_environment();
        let user_files = json!({"read":["/tmp/user-approved.txt"]});
        for (source, files) in [
            ("agent", json!({"read":["/tmp/agent-approved.txt"]})),
            ("user", user_files.clone()),
        ] {
            let approval_id = format!("approval:{source}-files");
            kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":approval_id,"preview":{"authorizationScopes":["runFiles"],"authorizationContext":{"fileEnvironment":environment,"fileAccess":files}}}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":approval_id,"commandId":format!("decision:{source}-files"),"decision":"allow","source":source,"authorityId":format!("authority:{source}-files"),"authorizationScope":"runFiles"}})).unwrap();
        }
        assert_eq!(
            kernel
                .journal
                .file_authorizations(&request.session_id, &request.run_id, &environment)
                .unwrap(),
            vec![user_files],
            "Only a user-granted file scope can be reused"
        );
        kernel.journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"command:delegate","patches":{"agent.permissions.shell":"review","agent.permissions.shellAccess":"full"}}})).unwrap();
        let reply = kernel.execute(request.clone()).unwrap();
        assert_eq!(reply["status"], "approvalRequired");
        assert_eq!(reply["preview"]["approvalReviewer"], "agent");
        kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:valid-review","preview":reply["preview"]}})).unwrap();
        kernel.journal.append(&json!({"type":"provider.turn.settled","sessionId":request.session_id,"runId":request.run_id,
            "payload":{"providerRequestId":"provider:valid-review","purpose":"approvalReview","providerRuntimeRef":"runtime:review","outcome":"completed","orderedCallIds":[]}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.reviewed","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:valid-review","providerRequestId":"provider:valid-review","decision":"allow","reason":"The command fits the user delegation."}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:valid-review","commandId":"decision:valid-review","decision":"allow","source":"agent","authorityId":"authority:valid-review"}})).unwrap();
        request.non_workspace_authority = Some(NonWorkspaceAuthority {
            authority_id: "authority:valid-review".into(),
            decision: "allow".into(),
        });
        effect = kernel.prepare_tool(&request).unwrap();
        assert!(
            matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::Allowed(_)
            ),
            "The complete delegated review chain authorizes this exact call"
        );
        kernel.journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"command:stop-delegation","patches":{"agent.permissions.shell":"ask"}}})).unwrap();
        effect = kernel.prepare_tool(&request).unwrap();
        assert!(
            matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "Turning off delegation stops an unconsumed review approval"
        );
    }

    #[test]
    fn file_requests_cannot_replace_bound_project_write_authority() {
        struct Projects(PathBuf);
        impl WorkspaceResolverPort for Projects {
            fn resolve(&self, id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: self
                        .0
                        .join(if id == "workspace:test" {
                            "first"
                        } else {
                            "second"
                        })
                        .to_string_lossy()
                        .into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        impl Drop for Projects {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root =
            std::env::temp_dir().join(random_id("bound-projects").unwrap().replace(':', "-"));
        std::fs::create_dir_all(root.join("first")).unwrap();
        std::fs::create_dir_all(root.join("second")).unwrap();
        let projects = Arc::new(Projects(root));
        let (kernel, request, _) = kernel_with_workspaces(
            projects.clone(),
            "fs.write",
            json!({"workspaceId":"workspace:test", "path":projects.0.join("second/result.txt"), "content":"outside current Plan"}),
            crate::local_agent_product_tools::test_product_tools(),
            KernelExecutorConfig::default(),
            json!([{"workspaceId":"workspace:test","displayName":"First"}, {"workspaceId":"workspace:second","displayName":"Second"}]),
        );
        let error = kernel
            .prepare_tool(&request)
            .err()
            .expect("wrong workspace must be rejected");
        assert!(error.message.contains("another bound project"));
        assert!(!projects.0.join("second/result.txt").exists());
        let (kernel, request, _) = kernel_with_request(
            projects.clone(),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"printf unauthorized > result.txt",
                "requestFileAccess":{"write":[projects.0.join("first")]}}),
        );
        let error = kernel
            .prepare_tool(&request)
            .err()
            .expect("file grant must not replace Plan authority");
        assert!(error.message.contains("Plan writablePaths"));
        assert!(!projects.0.join("first/result.txt").exists());
        std::fs::create_dir(projects.0.join("first/.git")).unwrap();
        let (kernel, request, _) = kernel_with_request(
            projects.clone(),
            "fs.delete",
            json!({"workspaceId":"workspace:test", "path":projects.0.join("first"), "targetKind":"directoryTree"}),
        );
        let effect = kernel.prepare_tool(&request).unwrap();
        assert!(
            effect.git_write_requested,
            "Deleting the parent tree includes protected metadata"
        );
        assert!(effect.file_authority_required);
        assert_eq!(
            effect.preview("fs.delete")["authorizationScopes"],
            json!([])
        );
    }

    #[test]
    fn shell_uses_existing_workspace_authority_without_asking_for_write_access() {
        struct Workspace(WorkspaceAccess);
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: self.0.clone(),
                })
            }
        }
        for (access, expected_mode) in [
            (WorkspaceAccess::Project, "read"),
            (
                WorkspaceAccess::SessionWorkdir("session:reject".into()),
                "write",
            ),
        ] {
            let (kernel, request, _) = kernel_with_request(
                Arc::new(Workspace(access)),
                "bash",
                json!({"workspaceId":"workspace:test", "command":"pwd"}),
            );
            let effect = kernel.prepare_tool(&request).unwrap();
            assert_eq!(effect.process_execution_scope.as_deref(), Some("workspace"));
            assert_eq!(
                effect.process_workspace_mode.as_deref(),
                Some(expected_mode)
            );
            assert!(matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::Allowed(_)
            ));
        }
    }

    #[test]
    fn uncovered_project_effects_require_plan_scope_even_with_a_call_approval() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Workspace),
            "fs.write",
            json!({"workspaceId":"workspace:test", "path":"outside-plan.txt", "content":"new content"}),
        );
        let mut effect = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
                && error.as_object().unwrap().len() == 2
        ));
        effect.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.workspaceMutation":"allow", "agent.permissions.external":"allow",
            }))
            .unwrap(),
        });
        effect.permissions = effect.generation.permissions.clone();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        // A project Plan keeps its boundary even when request authorities are omitted.
        let authority = json!({"authorityId":"authority:plan", "planId":"plan:files", "revision":1,
            "decisionId":"decision:plan", "sessionId":request.session_id, "runId":request.run_id,
            "workspaceId":"workspace:test", "coveredOperations":[{"workspaceId":"workspace:test", "operation":"fs.write", "target":"planned.txt"}]});
        kernel.journal.append(&json!({"type":"plan.published", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
            "payload":{"providerCallId":"provider:plan", "planId":"plan:files", "revision":1, "title":"Write planned file", "summary":"Only planned.txt", "steps":[{"stepId":"step:check", "title":"Write", "details":"Write the file", "verification":["Read actual content"]}], "mutationManifest":authority["coveredOperations"]}})).unwrap();
        kernel.journal.append(&json!({"type":"plan.confirmed", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
            "payload":{"planId":"plan:files", "revision":1, "commandId":"command:plan", "decisionId":"decision:plan", "authorities":[authority]}})).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
        ));
        assert!(kernel.records.read(&request.call_id).unwrap().is_none());
        for decision in ["deny", "allow"] {
            request.call_id = format!("call:{decision}");
            kernel.journal.append(&json!({"type":"tool.requested", "sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"providerCallId":format!("provider:{decision}"), "attemptId":format!("attempt:{decision}"), "toolName":"fs.write", "input":request.input}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.requested", "sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":format!("approval:{decision}"), "preview":effect.preview("fs.write")}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.resolved", "sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":format!("approval:{decision}"), "commandId":format!("command:{decision}"), "authorityId":format!("authority:{decision}"), "decision":decision}})).unwrap();
            request.non_workspace_authority = Some(
                serde_json::from_value(json!({
                    "authorityId":format!("authority:{decision}"), "decision":decision,
                }))
                .unwrap(),
            );
            assert!(matches!(kernel.admit(&request, &effect).unwrap(),
                Admission::Denied { error, .. } if error["code"] == "plan_scope_required"));
        }
        request.call_id = "call:next-write".into();
        request.non_workspace_authority = None;
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
        ));
        assert_eq!(
            kernel
                .journal
                .active_plan_authorities(&request.session_id)
                .unwrap(),
            Some(vec![authority.clone()])
        );
        request.input["path"] = json!("planned.txt");
        request.plan_authorities = vec![authority];
        let covered = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &covered).unwrap(),
            Admission::Allowed(_)
        ));
        // This resolver maps both selectors to the same real project.
        request
            .workspace_bindings
            .push("workspace:other-project".into());
        request.input = json!({"workspaceId":"workspace:other-project", "path":"unplanned.txt", "content":"outside the Plan"});
        let aliased = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &aliased).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
        ));
    }

    #[test]
    fn added_directory_is_a_plan_target_without_implicitly_granting_write_authority() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(Workspace),
            "fs.write",
            json!({"workspaceId":"workspace:test","path":"result.txt","content":"result"}),
        );
        let manifest =
            json!([{"workspaceId":"workspace:added","operation":"fs.write","target":"result.txt"}]);
        let admission = || {
            kernel.plan_admission(PlanAdmissionRequest {
                session_id: request.session_id.clone(),
                run_id: request.run_id.clone(),
                mutation_manifest: manifest.clone(),
            })
        };
        assert_eq!(
            admission().unwrap_err().code,
            "plan_workspace_binding_invalid"
        );
        kernel.journal.append(&json!({"type":"session.directory-index.attached", "sessionId":request.session_id,
            "payload":{"commandId":"command:add", "workspaceBinding":{"workspaceId":"workspace:added","displayName":"Added"}}})).unwrap();
        assert_eq!(
            admission().unwrap(),
            json!({"source":"user","authorities":[]})
        );
        kernel
            .journal
            .append(
                &json!({"type":"session.directory-index.detached", "sessionId":request.session_id,
            "payload":{"commandId":"command:detach", "workspaceId":"workspace:added"}}),
            )
            .unwrap();
        assert_eq!(
            admission().unwrap_err().code,
            "plan_workspace_binding_invalid"
        );
    }

    #[test]
    fn plan_admission_uses_current_task_and_original_confirmation() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(Workspace),
            "fs.write",
            json!({"workspaceId":"workspace:test","path":"src/result.txt","content":"result"}),
        );
        let journal = &kernel.journal;
        let runtime = journal
            .read_events(&request.session_id, 0)
            .unwrap()
            .into_iter()
            .find(|event| event["type"] == "run.started")
            .unwrap()["payload"]["runtimeSnapshot"]
            .clone();
        let start = |session: &str, run: &str| {
            journal.append(&json!({"type":"run.started","sessionId":session,"runId":run,
                "payload":{"inputMessageId":format!("input:{run}"),"workspaceBindings":[{"workspaceId":"workspace:test","displayName":"Project"}],
                    "runtimeSnapshot":runtime}})).unwrap();
        };
        let plan = |session: &str, run: &str, target: &str| {
            let authority = json!({"authorityId":format!("authority:{run}"),"planId":format!("plan:{run}"),"revision":1,
                "decisionId":format!("decision:{run}"),"sessionId":session,"runId":run,"workspaceId":"workspace:test",
                "coveredOperations":[{"workspaceId":"workspace:test","operation":"fs.write","target":target,"targetKind":"directoryTree"}]});
            journal.append(&json!({"type":"plan.published","sessionId":session,"runId":run,"callId":format!("call:{run}"),
                "payload":{"providerCallId":format!("provider:{run}"),"planId":authority["planId"],"revision":1,"title":"Write results","summary":"Approved directory",
                    "steps":[{"stepId":"write","title":"Write","details":"Write results"}],"mutationManifest":authority["coveredOperations"]}})).unwrap();
            journal.append(&json!({"type":"plan.confirmed","sessionId":session,"runId":run,"callId":format!("call:{run}"),
                "payload":{"planId":authority["planId"],"revision":1,"commandId":format!("confirm:{run}"),"decisionId":authority["decisionId"],"source":"user","authorities":[authority]}})).unwrap();
            authority
        };
        let delegate = |parent: &str,
                        parent_run: &str,
                        child: &str,
                        child_run: &str,
                        task: &str| {
            journal.append(&json!({"type":"agent.task.created","sessionId":parent,"runId":parent_run,"callId":format!("delegate:{task}"),
                "payload":{"taskId":task,"agentSessionId":child,"capabilities":{"messaging":true,"continuation":true,"delegation":true},
                    "createsAgent":false,"displayName":"Worker","text":"Work within the approved scope","delivery":"async"}})).unwrap();
            journal
                .append(
                    &json!({"type":"agent.task.started","sessionId":parent,"runId":parent_run,
                "payload":{"taskId":task,"childRunId":child_run}}),
                )
                .unwrap();
        };
        let scope = |session: &str, run: &str, manifest: Value| {
            kernel
                .plan_admission(PlanAdmissionRequest {
                    session_id: session.into(),
                    run_id: run.into(),
                    mutation_manifest: manifest,
                })
                .unwrap()["authorities"]
                .clone()
        };
        journal
            .create_session("session:parent", "Parent", &json!([]), None, None)
            .unwrap();
        start("session:parent", "run:first");
        let first = plan("session:parent", "run:first", "src");
        let manifest = json!([{"workspaceId":"workspace:test","operation":"fs.edit","target":"src/result.txt"}]);
        assert_eq!(
            scope(&request.session_id, &request.run_id, manifest.clone()),
            json!([])
        );
        delegate(
            "session:parent",
            "run:first",
            &request.session_id,
            &request.run_id,
            "task:first",
        );
        assert_eq!(
            scope(&request.session_id, &request.run_id, manifest.clone()),
            json!([first])
        );
        journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"permissions:auto", "patches":{"agent.permissions.workspaceMutation":"allow"}}})).unwrap();
        let admission = |manifest| {
            kernel
                .plan_admission(PlanAdmissionRequest {
                    session_id: request.session_id.clone(),
                    run_id: request.run_id.clone(),
                    mutation_manifest: manifest,
                })
                .unwrap()
        };
        assert_eq!(admission(manifest.clone())["source"], "parent");
        let invented = json!({"type":"plan.confirmed", "sessionId":request.session_id, "runId":request.run_id,
            "callId":"call:invented", "payload":{"planId":"plan:invented", "revision":1,
                "commandId":"command:invented", "decisionId":"decision:invented", "source":"agent", "authorities":[{
                    "authorityId":"authority:invented", "planId":"plan:invented", "revision":1,
                    "decisionId":"decision:invented", "sessionId":request.session_id, "runId":request.run_id,
                    "workspaceId":"workspace:test", "coveredOperations":manifest}]}});
        let published = json!({"type":"plan.published", "sessionId":request.session_id, "runId":request.run_id,
            "callId":"call:invented", "payload":{"planId":"plan:invented", "revision":1,
                "providerCallId":"provider:invented", "title":"Independent authority", "summary":"Must keep parent identity",
                "steps":[{"stepId":"write", "title":"Write", "details":"Write results"}], "mutationManifest":manifest}});
        assert_eq!(
            journal
                .append_batch(&[published, invented])
                .unwrap_err()
                .code,
            "plan_delegation_missing"
        );
        assert_eq!(
            admission(
                json!([{"workspaceId":"workspace:test","operation":"fs.write","target":"outside/result.txt"}])
            )["source"],
            "user"
        );
        journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"permissions:plan", "patches":{"agent.permissions.workspaceMutation":"plan"}}})).unwrap();
        let effect = kernel.prepare_tool(&request).unwrap();
        assert!(
            matches!(kernel.admit(&request,&effect).unwrap(),Admission::Allowed(authority)
            if authority["authorityId"] == first["authorityId"])
        );
        let mut outside_request = request.clone();
        outside_request.input["path"] = json!("outside/result.txt");
        let outside = kernel.prepare_tool(&outside_request).unwrap();
        assert!(
            matches!(kernel.admit(&request,&outside).unwrap(),Admission::Denied {error,..}
            if error["code"] == "plan_scope_required")
        );
        assert_eq!(
            scope(
                &request.session_id,
                &request.run_id,
                json!([
            {"workspaceId":"workspace:test","operation":"fs.edit","target":"src/result.txt"},
            {"workspaceId":"workspace:test","operation":"fs.write","target":"outside/result.txt"}])
            ),
            json!([])
        );

        // Child acceptance preserves the original parent identity, not a second grant.
        let child_plan = plan(&request.session_id, &request.run_id, "src");
        journal.append(&json!({"type":"plan.confirmed","sessionId":request.session_id,"runId":request.run_id,"callId":format!("call:{}",request.run_id),
            "payload":{"planId":child_plan["planId"],"revision":1,"commandId":"accept:parent","decisionId":"decision:child-reference",
                "source":"parent","authorities":[first]}})).unwrap();
        journal.append(&json!({"type":"plan.revision.requested","sessionId":"session:parent","runId":"run:first","callId":"call:run:first",
            "payload":{"planId":first["planId"],"revision":1,"commandId":"revise:first","text":"Change the scope"}})).unwrap();
        let mut reference = request.clone();
        reference.plan_authorities = vec![first.clone()];
        assert!(
            matches!(kernel.admit(&reference,&effect).unwrap(),Admission::Denied {error,..}
            if error["code"] == "plan_scope_required")
        );

        // Continuing the same child resolves the new delegating run, never its creation run.
        journal.append(&json!({"type":"agent.task.completed","sessionId":"session:parent","runId":"run:first",
            "payload":{"taskId":"task:first","result":{"outcome":"completed"}}})).unwrap();
        journal.append(&json!({"type":"run.finishing","sessionId":"session:parent","runId":"run:first","payload":{"outcome":"completed","finalMessageId":"message:first"}})).unwrap();
        journal.append(&json!({"type":"run.finishing","sessionId":request.session_id,"runId":request.run_id,"payload":{"outcome":"completed","finalMessageId":"message:child"}})).unwrap();
        start("session:parent", "run:second");
        start(&request.session_id, "run:continued");
        let second = plan("session:parent", "run:second", "next");
        let next_manifest = json!([{"workspaceId":"workspace:test","operation":"fs.write","target":"next/result.txt"}]);
        assert_eq!(
            scope(&request.session_id, "run:continued", next_manifest.clone()),
            json!([])
        );
        delegate(
            "session:parent",
            "run:second",
            &request.session_id,
            "run:continued",
            "task:second",
        );
        assert_eq!(
            scope(&request.session_id, "run:continued", next_manifest.clone()),
            json!([second])
        );
        reference.run_id = "run:continued".into();
        assert!(
            matches!(kernel.admit(&reference,&effect).unwrap(),Admission::Denied {error,..}
            if error["code"] == "plan_scope_required")
        );
        outside_request.input["path"] = json!("next/result.txt");
        let outside = kernel.prepare_tool(&outside_request).unwrap();
        assert!(matches!(
            kernel.admit(&reference, &outside).unwrap(),
            Admission::Allowed(_)
        ));

        journal
            .create_session("session:nested", "Nested", &json!([]), None, None)
            .unwrap();
        start("session:nested", "run:nested");
        delegate(
            &request.session_id,
            "run:continued",
            "session:nested",
            "run:nested",
            "task:nested",
        );
        assert_eq!(
            scope("session:nested", "run:nested", next_manifest.clone()),
            json!([second])
        );
        journal.append(&json!({"type":"agent.task.completed","sessionId":"session:parent","runId":"run:second",
            "payload":{"taskId":"task:second","result":{"outcome":"completed"}}})).unwrap();
        assert_eq!(
            scope("session:nested", "run:nested", next_manifest),
            json!([])
        );
        kernel.shutdown_plugins().unwrap();
    }

    #[test]
    fn delegated_plan_manifest_can_narrow_but_not_extend_confirmed_paths() {
        let files = json!({"workspaceId":"workspace:test","operation":"fs.edit","target":"src","targetKind":"directoryTree"});
        assert!(plan_operation_covers(&files, &files));
        assert!(plan_operation_covers(
            &files,
            &json!({"workspaceId":"workspace:test","operation":"fs.write","target":"src/components","targetKind":"directoryTree"})
        ));
        assert!(!plan_operation_covers(
            &files,
            &json!({"workspaceId":"workspace:test","operation":"fs.write","target":"src-other","targetKind":"directoryTree"})
        ));
        let shell = json!({"workspaceId":"workspace:test","operation":"bash","writablePaths":[{"path":"build","kind":"directory"}]});
        assert!(plan_operation_covers(
            &shell,
            &json!({"workspaceId":"workspace:test","operation":"bash","writablePaths":[{"path":"build/report.txt","kind":"file"}]})
        ));
        assert!(!plan_operation_covers(
            &shell,
            &json!({"workspaceId":"workspace:test","operation":"bash","writablePaths":[{"path":"src/main.rs","kind":"file"}]})
        ));
        assert!(!plan_operation_covers(&files, &shell));
    }

    #[test]
    fn file_edit_permission_does_not_grant_shell_project_writes() {
        struct Project;
        impl WorkspaceResolverPort for Project {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(Project),
            "bash",
            json!({"workspaceId":"workspace:test","command":"printf x > source.cpp"}),
        );
        kernel.journal.append(&json!({"type":"session.permissions.updated","sessionId":request.session_id,
            "payload":{"commandId":"command:files-allowed","patches":{"agent.permissions.workspaceMutation":"allow"}}})).unwrap();
        let effect = kernel.prepare_tool(&request).unwrap();
        assert_eq!(effect.process_workspace_mode.as_deref(), Some("read"));
        assert_eq!(effect.process_execution_scope.as_deref(), Some("workspace"));
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        let mut metadata_request = request.clone();
        metadata_request.input["requestFileAccess"] = json!({"write":[std::env::current_dir().unwrap().join("source.cpp")],"reason":"edit source"});
        assert!(
            kernel.prepare_tool(&metadata_request).is_err(),
            "Shell cannot turn file-resource approval into a project edit grant"
        );
    }

    #[test]
    fn network_grants_reuse_the_environment_and_expire_at_the_requested_boundary() {
        struct Project;
        impl WorkspaceResolverPort for Project {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        for (scope, across_tasks) in [("runNetwork", false), ("sessionNetwork", true)] {
            let (kernel, mut request, _) = kernel_with_request(
                Arc::new(Project),
                "bash",
                json!({"workspaceId":"workspace:test","command":"curl https://example.test","requestNetworkPermission":"Fetch test dependencies"}),
            );
            let effect = kernel.prepare_tool(&request).unwrap();
            assert!(matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ));
            assert_eq!(effect.process_workspace_mode.as_deref(), Some("read"));
            let preview = effect.preview("bash");
            kernel.journal.append(&json!({"type":"tool.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"providerCallId":"provider:network","attemptId":request.attempt_id,"toolName":"bash","input":request.input}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":"approval:network","preview":preview}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
                "payload":{"approvalId":"approval:network","commandId":"command:network","authorityId":"authority:network","decision":"allow","source":"user","authorizationScope":scope}})).unwrap();
            request.input =
                json!({"workspaceId":"workspace:test","command":"wget https://another.test"});
            request.call_id = "call:second-network".into();
            let second = kernel.prepare_tool(&request).unwrap();
            assert!(second.file_access.network_access);
            assert_eq!(second.process_workspace_mode.as_deref(), Some("read"));
            assert!(matches!(
                kernel.admit(&request, &second).unwrap(),
                Admission::Allowed(_)
            ));
            request.run_id = "run:next".into();
            assert_eq!(
                kernel
                    .execution_authority(&request, scope, &second.file_environment())
                    .unwrap()
                    .is_some(),
                across_tasks
            );
            kernel.journal.append(&json!({"type":"approval.revoked","sessionId":request.session_id,"runId":"run:reject",
                "payload":{"commandId":"command:revoke-network","authorityId":"authority:network"}})).unwrap();
            assert!(kernel
                .execution_authority(&request, scope, &second.file_environment())
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn confirmed_shell_plan_bounds_workspace_execution_without_host_approval() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"printf result > build/result.txt"}),
        );
        let authority = json!({"authorityId":"authority:plan", "planId":"plan:shell", "revision":1,
            "decisionId":"decision:plan", "sessionId":request.session_id, "runId":request.run_id,
            "workspaceId":"workspace:test", "coveredOperations":[{"workspaceId":"workspace:test", "operation":"bash", "writablePaths":[{"path":"build", "kind":"directory"}]}]});
        kernel.journal.append(&json!({"type":"plan.published", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
            "payload":{"providerCallId":"provider:plan", "planId":"plan:shell", "revision":1, "title":"Build", "summary":"Write build output", "steps":[{"stepId":"step:build", "title":"Build", "details":"Generate output", "verification":["Read the result"]}], "mutationManifest":authority["coveredOperations"]}})).unwrap();
        kernel.journal.append(&json!({"type":"plan.confirmed", "sessionId":request.session_id, "runId":request.run_id,"callId":"call:plan",
            "payload":{"planId":"plan:shell", "revision":1, "commandId":"command:plan", "decisionId":"decision:plan", "authorities":[authority]}})).unwrap();
        request.plan_authorities = vec![authority];
        let mut effect = kernel.prepare_tool(&request).unwrap();
        effect.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.workspaceMutation":"allow", "agent.permissions.external":"allow",
            }))
            .unwrap(),
        });
        effect.permissions = effect.generation.permissions.clone();
        kernel
            .prepare_process_permissions(&request, &mut effect)
            .unwrap();
        assert_eq!(effect.process_execution_scope.as_deref(), Some("workspace"));
        assert!(
            matches!(kernel.admit(&request, &effect).unwrap(), Admission::Allowed(value)
            if value["source"] == "plan")
        );
        effect.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.workspaceMutation":"allow", "agent.permissions.external":"deny",
            }))
            .unwrap(),
        });
        effect.permissions = effect.generation.permissions.clone();
        kernel
            .prepare_process_permissions(&request, &mut effect)
            .unwrap();
        assert_eq!(effect.process_execution_scope.as_deref(), Some("workspace"));
        assert_eq!(effect.process_workspace_mode.as_deref(), Some("write"));
        assert!(
            matches!(kernel.admit(&request, &effect).unwrap(), Admission::Allowed(value)
            if value["source"] == "plan" && value["writablePaths"] == json!([{"path":"build", "kind":"directory"}]))
        );
        request.plan_authorities.clear();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
        ));
        request.plan_authorities = kernel
            .journal
            .active_plan_authorities(&request.session_id)
            .unwrap()
            .unwrap();
        request.input["requestHostPermission"] =
            json!("Access a resource outside the Plan sandbox");
        let reply = kernel.execute(request.clone()).unwrap();
        assert_eq!(reply["status"], "approvalRequired");
        assert!(reply["preview"]["summary"]
            .as_str()
            .unwrap()
            .contains("outside the Plan sandbox"));
        assert_eq!(
            reply["preview"]["authorizationScopes"],
            json!([
                "runCommand",
                "sessionCommand",
                "runHostShell",
                "sessionHostShell"
            ])
        );
        let mut host_effect = kernel.prepare_tool(&request).unwrap();
        host_effect.generation = Arc::new(KernelGeneration {
            catalog: host_effect.generation.catalog.clone(),
            executor_config: host_effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(
                &json!({"agent.permissions.external":"deny"}),
            )
            .unwrap(),
        });
        host_effect.permissions = host_effect.generation.permissions.clone();
        assert!(
            matches!(
                kernel.admit(&request, &host_effect).unwrap(),
                Admission::ApprovalRequired
            ),
            "Shell has its own policy, independent of other external tools"
        );
    }

    #[test]
    fn host_shell_grant_is_explicit_and_bound_to_run_workspace_and_environment() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test","command":"pwd", "requestHostPermission":"Read an explicitly requested Host resource"}),
        );
        let mut effect = kernel.prepare_tool(&request).unwrap();
        effect.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.workspaceMutation":"allow",
            }))
            .unwrap(),
        });
        effect.permissions = effect.generation.permissions.clone();
        let preview = effect.preview("bash");
        assert_eq!(preview["authorizationScope"], "runHostShell");
        let commit = |call: &str, scope: bool| {
            kernel.journal.append(&json!({"type":"tool.requested","sessionId":"session:reject","runId":"run:reject","callId":call,
                "payload":{"providerCallId":format!("provider:{call}"),"attemptId":format!("attempt:{call}"),"toolName":"bash","input":request.input}})).unwrap();
            kernel.journal.append(&json!({"type":"approval.requested","sessionId":"session:reject","runId":"run:reject","callId":call,
                "payload":{"approvalId":call,"preview":preview}})).unwrap();
            let mut payload =
                json!({"approvalId":call,"commandId":call,"authorityId":call,"decision":"allow"});
            if scope {
                payload["authorizationScope"] = json!("runHostShell");
            }
            kernel.journal.append(&json!({"type":"approval.resolved","sessionId":"session:reject","runId":"run:reject","callId":call,"payload":payload})).unwrap();
        };
        commit("call:once", false);
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        commit("call:run-grant", true);
        request.call_id = "call:later".into();
        assert!(
            matches!(kernel.admit(&request, &effect).unwrap(), Admission::Allowed(ref value)
            if value["externalAuthority"]["authorityId"] == "call:run-grant" && value["externalAuthority"]["authorizationScope"] == "runHostShell")
        );
        request.run_id = "run:other".into();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::ApprovalRequired
        ));
        request.run_id = "run:reject".into();
        let mut other = effect.clone();
        other.workspace_id = Some("workspace:other".into());
        assert!(matches!(
            kernel.admit(&request, &other).unwrap(),
            Admission::ApprovalRequired
        ));
        other = effect.clone();
        let mut config = other.generation.executor_config.clone();
        config.shell_program = Some(achbit_kernel_runtime::shell_environment::ShellProgram {
            tool: "bash".into(),
            executable: PathBuf::from("/different/bash"),
            dialect: "bash".into(),
        });
        other.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: config,
            permissions: effect.generation.permissions.clone(),
        });
        other.permissions = other.generation.permissions.clone();
        assert!(matches!(
            kernel.admit(&request, &other).unwrap(),
            Admission::ApprovalRequired
        ));
        other = effect.clone();
        let plan = json!({"authorityId":"authority:files-only", "planId":"plan:files-only", "revision":1,
            "decisionId":"decision:files-only", "sessionId":request.session_id, "runId":request.run_id,
            "workspaceId":"workspace:test", "coveredOperations":[{"workspaceId":"workspace:test", "operation":"fs.write", "target":"planned.txt"}]});
        kernel.journal.append(&json!({"type":"plan.published", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:files-plan",
            "payload":{"providerCallId":"provider:files-plan", "planId":"plan:files-only", "revision":1, "title":"Write a file", "summary":"No Shell effects", "steps":[{"stepId":"write", "title":"Write", "details":"Write planned.txt", "verification":["Read it"]}], "mutationManifest":plan["coveredOperations"]}})).unwrap();
        kernel.journal.append(&json!({"type":"plan.confirmed", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:files-plan",
            "payload":{"planId":"plan:files-only", "revision":1, "commandId":"command:files-plan", "decisionId":"decision:files-only", "authorities":[plan]}})).unwrap();
        other.generation = Arc::new(KernelGeneration {
            catalog: effect.generation.catalog.clone(),
            executor_config: effect.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
        });
        other.permissions = other.generation.permissions.clone();
        assert!(
            matches!(
                kernel.admit(&request, &other).unwrap(),
                Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
            ),
            "run Host grant never extends an existing Plan to an unapproved Shell operation"
        );
        other.process_workspace_mode = Some("write".into());
        other.process_execution_scope = Some("workspace".into());
        assert!(
            matches!(
                kernel.admit(&request, &other).unwrap(),
                Admission::Denied { error, .. } if error["code"] == "plan_scope_required"
            ),
            "Host grant does not authorize workspace sandbox write targets"
        );
        other = effect.clone();
        other.operation = "browser.service".into();
        other.scope = PreparedEffectScope::External;
        assert!(
            matches!(
                kernel.admit(&request, &other).unwrap(),
                Admission::ApprovalRequired
            ),
            "other tools cannot use the Shell grant"
        );
        kernel.journal.append(&json!({"type":"run.finishing","sessionId":"session:reject","runId":"run:reject","payload":{"outcome":"cancelled"}})).unwrap();
        kernel.journal.append(&json!({"type":"run.runtime.released","sessionId":"session:reject","runId":"run:reject",
            "payload":{"runRuntimeSnapshotRef":"runtime:test","extensionGenerationRef":"extension:test","kernelCatalogSnapshotRef":request.kernel_catalog_snapshot_ref,
                "providerRuntimeRef":"provider:test","pluginInstanceRefs":[],"alreadyReleased":false}})).unwrap();
        kernel.journal.append(&json!({"type":"run.settled","sessionId":"session:reject","runId":"run:reject","payload":{"outcome":"cancelled"}})).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Denied { .. }
        ));
    }

    #[test]
    fn internal_preview_is_allowed_and_external_control_respects_user_policy() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::{AtomicBool, Ordering};
        struct BrowserHost {
            registration: Value,
            stop: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<()>>,
        }
        impl Drop for BrowserHost {
            fn drop(&mut self) {
                let mut registration = self.registration.clone();
                registration["remove"] = json!(true);
                let _ = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(crate::browser_tools::register(axum::Json(
                        serde_json::from_value(registration).unwrap(),
                    )));
                self.stop.store(true, Ordering::SeqCst);
                let _ = TcpStream::connect(self.registration["endpoint"].as_str().unwrap());
                self.thread.take().unwrap().join().unwrap();
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let incoming = received.clone();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let message: Value = serde_json::from_str(&line).unwrap();
                let closed = message["input"]["previewId"] == "preview-closed";
                let page_status = message["input"]["action"] == "status";
                let host_status = message["input"]["action"] == "hostStatus";
                incoming.lock().unwrap().push(message);
                if closed {
                    stream.write_all(b"{\"ok\":false,\"message\":\"native_browser_page_closed: preview-closed\"}\n").unwrap();
                } else if host_status {
                    writeln!(
                        stream,
                        "{}",
                        json!({"ok":true,"data":{
                            "ready":true,"captureAvailable":true,
                        }})
                    )
                    .unwrap();
                } else if page_status {
                    stream
                        .write_all(
                            b"{\"ok\":true,\"data\":{\"url\":\"file:///tmp/preview.html\"}}\n",
                        )
                        .unwrap();
                } else {
                    stream.write_all(b"{\"ok\":true,\"data\":{}}\n").unwrap();
                }
            }
        });
        let host = BrowserHost {
            registration: json!({"hostInstanceId":format!("dcinstance_{}", "b".repeat(64)),
            "endpoint":endpoint,"callbackToken":format!("dchost_{}", "b".repeat(64)),"remove":false}),
            stop,
            thread: Some(thread),
        };
        let response = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::browser_tools::register(axum::Json(
                serde_json::from_value(host.registration.clone()).unwrap(),
            )));
        assert_eq!(response.0["ok"], true);
        struct NoWorkspace;
        impl WorkspaceResolverPort for NoWorkspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                panic!("page operations do not resolve a workspace");
            }
        }
        let mut product = crate::local_agent_product_tools::test_product_tools();
        Arc::get_mut(&mut product).unwrap().browser_binding = Some(
            json!({"hostInstanceId":host.registration["hostInstanceId"],"windowLabel":"main"}),
        );
        Arc::get_mut(&mut product).unwrap().computer_use_instance =
            Some("plugin-instance:computer-use".into());
        struct NativeStatus;
        impl crate::desktop_tools::DesktopExecutor for NativeStatus {
            fn call(&self, _: &Value, input: &Value) -> Result<Value, String> {
                assert_eq!(input["action"], "computer:status");
                Ok(json!({"ok":true,"data":{"platform":"native-test"}}))
            }
            fn stop(&self) -> Result<(), String> {
                Ok(())
            }
        }
        Arc::get_mut(&mut product).unwrap().desktop = Some(
            crate::desktop_tools::DesktopHost::for_test("host:test", Arc::new(NativeStatus))
                .run("session:test", "run:test"),
        );
        let (kernel, mut request, catalog) = kernel_with_product_tools(
            Arc::new(NoWorkspace),
            "browser.page",
            json!({"action":"act","previewId":"preview-1","operation":"click","selector":"#button"}),
            product.clone(),
        );
        let effect = kernel.prepare_tool(&request).unwrap();
        assert!(
            matches!(kernel.admit(&request, &effect).unwrap(), Admission::Allowed(ref value) if value["source"] == "internalPreview")
        );
        request.input = json!({"action":"activate","previewId":"preview-1"});
        let effect = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        let activation = kernel.execute(request.clone()).unwrap();
        assert_eq!(activation["record"]["outcome"], "completed");
        let activation = received.lock().unwrap().last().unwrap().clone();
        assert_eq!(activation["input"], request.input);
        let context: KernelToolExecutionContext = serde_json::from_value(json!({
            "output_directory": "/unused-capture-archive", "workspace_root":null, "workspace_id":null,
            "private_resolved_targets":[], "workspace_write_targets":null, "file_access":{"read":[],"write":[],"readOnly":[],"home":null},
        })).unwrap();
        let before = received.lock().unwrap().len();
        crate::browser_tools::execute(
            &activation["binding"],
            "browser.observe",
            json!({"previewId":"preview-1"}),
            &context,
            "observation:test",
        )
        .unwrap();
        let calls = received.lock().unwrap()[before..].to_vec();
        assert_eq!(
            calls
                .iter()
                .map(|call| call["input"]["action"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["act", "capture"]
        );
        assert!(calls
            .iter()
            .all(|call| call["input"]["previewId"] == "preview-1"
                && call["binding"] == activation["binding"]));
        let before = received.lock().unwrap().len();
        let error = crate::browser_tools::execute(
            &activation["binding"],
            "browser.observe",
            json!({"previewId":"preview-closed"}),
            &context,
            "observation:closed",
        )
        .unwrap_err();
        assert_eq!(error.message, "native_browser_page_closed: preview-closed");
        assert_eq!(
            received.lock().unwrap().len(),
            before + 1,
            "a closed page stops the operation without selecting another page"
        );
        let mut reload = request.clone();
        reload.request_id = "request:reload-closed".into();
        reload.call_id = "call:reload-closed".into();
        reload.attempt_id = "attempt:reload-closed".into();
        reload.input = json!({"action":"reload","previewId":"preview-closed"});
        let before = received.lock().unwrap().len();
        let rejected = kernel.execute(reload.clone()).unwrap();
        assert_eq!(rejected["status"], "inputRejected");
        assert_eq!(
            rejected["rejection"]["error"]["code"],
            "native_browser_failed"
        );
        assert_eq!(rejected["rejection"]["error"]["message"], error.message);
        assert_eq!(
            rejected["rejection"]["error"]["issues"][0]["path"],
            "$.previewId"
        );
        assert!(kernel.records.read(&reload.call_id).unwrap().is_none());
        let calls = received.lock().unwrap()[before..].to_vec();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["input"]["action"], "status");
        reload.request_id = "request:reload-open".into();
        reload.call_id = "call:reload-open".into();
        reload.attempt_id = "attempt:reload-open".into();
        reload.input["previewId"] = json!("preview-1");
        assert_eq!(kernel.execute(reload).unwrap()["status"], "completed");
        struct SnapshotRoot(PathBuf);
        impl WorkspaceResolverPort for SnapshotRoot {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: self.0.to_string_lossy().into(),
                    access: WorkspaceAccess::SessionInput("session:reject".into()),
                })
            }
        }
        impl Drop for SnapshotRoot {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(random_id("browser-input").unwrap().replace(':', "-"));
        std::fs::create_dir(&root).unwrap();
        let root = Arc::new(SnapshotRoot(root));
        std::fs::write(root.0.join("preview.html"), "<h1>Input</h1>").unwrap();
        let (file_kernel, file_request, _) = kernel_with_product_tools(
            root.clone(),
            "browser.open",
            json!({"workspaceId":"workspace:test", "path":"preview.html"}),
            product,
        );
        let opened = file_kernel.execute(file_request).unwrap();
        assert_eq!(opened["record"]["outcome"], "completed");
        let opened_path = std::fs::canonicalize(root.0.join("preview.html")).unwrap();
        assert!(received
            .lock()
            .unwrap()
            .iter()
            .any(|value| value["input"] == json!({"action":"open", "filePath":opened_path})));
        assert_eq!(
            std::fs::read_to_string(root.0.join("preview.html")).unwrap(),
            "<h1>Input</h1>"
        );
        request.tool_name = "browser.service".into();
        request.tool_binding_ref = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser.service")
            .unwrap()["toolBindingRef"]
            .as_str()
            .unwrap()
            .into();
        request.input = json!({"action":"start","directory":"/tmp","command":"node","args":[],"url":"http://127.0.0.1:3000"});
        let service = kernel.prepare_tool(&request).unwrap();
        let mut delegated_service = service.clone();
        delegated_service.permissions.shell = ShellApprovalMode::Review;
        assert!(delegated_service.agent_can_review());
        assert_eq!(
            service.preview("browser.service")["operation"]["arguments"]["command"],
            "node"
        );
        assert!(matches!(
            kernel.admit(&request, &service).unwrap(),
            Admission::ApprovalRequired
        ));
        let mut configured = service.clone();
        configured.generation = Arc::new(KernelGeneration {
            catalog: service.generation.catalog.clone(),
            executor_config: service.generation.executor_config.clone(),
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({
                "agent.permissions.external":"allow", "agent.permissions.workspaceMutation":"plan",
            }))
            .unwrap(),
        });
        assert!(matches!(
            kernel.admit(&request, &configured).unwrap(),
            Admission::ApprovalRequired
        ));
        assert!(configured.preview("browser.service")["summary"]
            .as_str()
            .unwrap()
            .contains("node"));
        request.input = json!({"action":"start", "directory":"/tmp", "command":"rm", "args":["-rf", "/"], "url":"http://127.0.0.1:3000"});
        let blocked = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(kernel.admit(&request, &blocked).unwrap(),
            Admission::Denied { error, .. } if error["code"] == "command_denied_by_rule"));
        request.input = json!({"action":"status", "serviceId":"development:owned"});
        let status = kernel.prepare_tool(&request).unwrap();
        assert!(matches!(
            kernel.admit(&request, &status).unwrap(),
            Admission::Allowed(_)
        ));
        request.tool_name = "computer.control".into();
        request.tool_binding_ref = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "computer.control")
            .unwrap()["toolBindingRef"]
            .as_str()
            .unwrap()
            .into();
        request.input = json!({"action":"listApps"});
        let computer = kernel.prepare_tool(&request).unwrap();
        let mut delegated_computer = computer.clone();
        delegated_computer.permissions.shell = ShellApprovalMode::Review;
        assert!(delegated_computer.agent_can_review());
        assert!(!computer.agent_can_review());
        assert!(matches!(
            kernel.admit(&request, &computer).unwrap(),
            Admission::ApprovalRequired
        ));
        for (setting, expects_denial) in [("allow", false), ("deny", true)] {
            let mut configured = computer.clone();
            configured.generation = Arc::new(KernelGeneration {
                catalog: computer.generation.catalog.clone(),
                executor_config: computer.generation.executor_config.clone(),
                permissions: LocalAgentPermissionPolicy::from_settings(
                    &json!({"agent.permissions.external":setting}),
                )
                .unwrap(),
            });
            configured.permissions = configured.generation.permissions.clone();
            assert!(matches!(
                (kernel.admit(&request, &configured).unwrap(), expects_denial),
                (Admission::Allowed(_), false) | (Admission::Denied { .. }, true)
            ));
        }
        kernel.journal.append(&json!({"type":"tool.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"providerCallId":"provider:computer","attemptId":request.attempt_id,"toolName":"computer.control","input":request.input}})).unwrap();
        let preview = computer.preview("computer.control");
        kernel.journal.append(&json!({"type":"approval.requested","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:computer","preview":preview}})).unwrap();
        kernel.journal.append(&json!({"type":"approval.resolved","sessionId":request.session_id,"runId":request.run_id,"callId":request.call_id,
            "payload":{"approvalId":"approval:computer","commandId":"command:computer","authorityId":"authority:computer","decision":"allow"}})).unwrap();
        request.non_workspace_authority = Some(
            serde_json::from_value(json!({"authorityId":"authority:computer","decision":"allow"}))
                .unwrap(),
        );
        assert!(
            matches!(kernel.admit(&request, &computer).unwrap(), Admission::Allowed(ref value) if value["source"] == "user")
        );
        request.non_workspace_authority = None;
        request.call_id = "call:next-computer".into();
        assert!(matches!(
            kernel.admit(&request, &computer).unwrap(),
            Admission::ApprovalRequired
        ));
    }

    #[test]
    fn input_snapshot_read_shell_is_allowed_and_mutation_is_a_call_rejection() {
        struct Snapshot;
        impl WorkspaceResolverPort for Snapshot {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::SessionInput("session:reject".into()),
                })
            }
        }
        let (kernel, mut request, _) = kernel_with_request(
            Arc::new(Snapshot),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"pwd; ls -l Cargo.toml"}),
        );
        let effect = kernel.prepare_tool(&request).unwrap();
        assert_eq!(effect.process_workspace_mode.as_deref(), Some("read"));
        assert_eq!(effect.process_execution_scope.as_deref(), Some("workspace"));
        assert!(matches!(
            kernel.admit(&request, &effect).unwrap(),
            Admission::Allowed(_)
        ));
        for (mode, scope) in [("write", "workspace"), ("read", "host")] {
            request.input = json!({"workspaceId":"workspace:test", "command":"pwd", "workspaceMode":mode, "executionScope":scope});
            let reply = kernel.execute(request.clone()).unwrap();
            assert_eq!(reply["status"], "inputRejected");
            assert_eq!(reply["rejection"]["error"]["code"], "tool_input_invalid");
            assert_eq!(reply["rejection"]["input"], request.input);
            assert!(kernel.records.read(&request.call_id).unwrap().is_none());
        }
    }

    #[test]
    fn invalid_bound_tool_input_returns_a_rejection_before_resolution_or_tool_record_creation() {
        struct UnexpectedResolver;
        impl WorkspaceResolverPort for UnexpectedResolver {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                panic!("input rejection must precede filesystem resolution")
            }
        }
        let (kernel, request, catalog) = kernel_with_request(
            Arc::new(UnexpectedResolver),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"pwd", "executionMode":"read"}),
        );
        let reply = kernel.execute(request.clone()).unwrap();
        assert_eq!(reply["status"], "inputRejected");
        assert_eq!(reply["rejection"]["input"], request.input);
        assert_eq!(reply["rejection"]["callId"], request.call_id);
        assert!(reply.get("record").is_none());
        assert!(reply["rejection"].get("preparedEffect").is_none());
        assert!(reply["rejection"]["error"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["path"] == "$.executionMode"
                && issue["rule"] == "additionalProperties"));
        assert!(kernel.records.read(&request.call_id).unwrap().is_none());
        let mut wrong_binding = request;
        wrong_binding.tool_binding_ref = "binding:unknown".into();
        assert!(kernel
            .execute(wrong_binding)
            .unwrap_err()
            .input_issues
            .is_none());
        kernel
            .release_catalog(ReleaseToolCatalogRequest::new(
                "session:reject",
                "run:reject",
                catalog["kernelCatalogSnapshotRef"].as_str().unwrap(),
            ))
            .unwrap();
    }

    #[test]
    fn target_io_rejection_allows_the_next_call_and_preserves_infrastructure_errors() {
        struct TestWorkspace(PathBuf);
        impl WorkspaceResolverPort for TestWorkspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: self.0.to_string_lossy().into_owned(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        impl Drop for TestWorkspace {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root =
            std::env::temp_dir().join(random_id("target-rejection").unwrap().replace(':', "-"));
        std::fs::create_dir(&root).unwrap();
        let workspace = Arc::new(TestWorkspace(root));
        std::fs::write(workspace.0.join("README.md"), "source text").unwrap();
        let missing_target = workspace.0.join("missing/nested/result.txt");
        let expected = workspace
            .0
            .canonicalize()
            .unwrap()
            .join("missing/nested/result.txt");
        assert_eq!(
            achbit_kernel_runtime::file_access::resolve_path(&missing_target).unwrap(),
            expected
        );
        assert_eq!(
            achbit_kernel_runtime::workspace_boundary::WorkspaceBoundary::new(&workspace.0)
                .resolve_read("missing/nested/result.txt")
                .unwrap(),
            expected
        );
        assert!(!workspace.0.join("missing").exists());
        let original_error = workspace
            .0
            .join("README.md/child")
            .canonicalize()
            .unwrap_err();
        let absolute_error =
            achbit_kernel_runtime::file_access::resolve_path(&workspace.0.join("README.md/child"))
                .unwrap_err();
        assert!(matches!(
            absolute_error,
            achbit_kernel_abi::KernelError::Other(_)
        ));
        assert!(absolute_error
            .to_string()
            .contains(&original_error.to_string()));
        let (kernel, request, _) = kernel_with_request(
            workspace.clone(),
            "fs.read",
            json!({"workspaceId":"workspace:test", "path":"README.md/child"}),
        );
        let reply = kernel.execute(request.clone()).unwrap();
        assert_eq!(reply["status"], "inputRejected");
        assert_eq!(
            reply["rejection"]["error"]["code"],
            "workspace_target_invalid"
        );
        assert_eq!(reply["rejection"]["error"]["issues"][0]["path"], "$.path");
        assert!(reply["rejection"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&original_error.to_string()));
        assert_eq!(reply["rejection"]["input"], request.input);
        assert!(kernel.records.read(&request.call_id).unwrap().is_none());

        let mut next = request.clone();
        next.call_id = "call:valid".into();
        next.attempt_id = "attempt:valid".into();
        next.input["path"] = json!("README.md");
        let completed = kernel.execute(next).unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["record"]["output"]["content"], "source text");

        let mut missing = request.clone();
        missing.call_id = "call:missing".into();
        missing.attempt_id = "attempt:missing".into();
        missing.input["path"] = json!("missing.txt");
        let failed = kernel.execute(missing).unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["record"]["outcome"], "failed");

        kernel
            .records
            .connection
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE tool_records")
            .unwrap();
        let store_error = kernel.execute(request).unwrap_err();
        assert_eq!(store_error.code, "tool_record_read_failed");
        assert!(store_error.input_issues.is_none());

        struct FailedResolver;
        impl WorkspaceResolverPort for FailedResolver {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Err(LocalAgentKernelError::new(
                    "workspace_catalog_unavailable",
                    "catalog read failed",
                ))
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(FailedResolver),
            "fs.read",
            json!({"workspaceId":"workspace:test", "path":"README.md"}),
        );
        let error = kernel.execute(request).unwrap_err();
        assert_eq!(error.code, "workspace_catalog_unavailable");
        assert_eq!(error.message, "catalog read failed");
        assert!(error.input_issues.is_none());
    }

    #[test]
    fn bash_effect_summary_preserves_the_complete_canonical_command() {
        let command = "docker image inspect cpp-dev:latest >/dev/null 2>&1 && {\n  docker build -t cpp-dev:latest .\n}";
        assert_eq!(
            effect_summary("bash", &[".".to_string()], &json!({ "command": command })),
            format!("执行 bash：{command}"),
        );
    }

    #[test]
    fn plan_scope_allows_execution_details_but_preserves_targets_and_boundaries() {
        let generation = LocalAgentKernel::prepare_generation(
            "extension:scope",
            KernelExecutorConfig::default(),
            Arc::new(achbit_kernel_runtime::executors::EmptySecretProvider),
            McpRuntime::default(),
            LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
            &Default::default(),
            false,
            crate::local_agent_product_tools::test_product_tools(),
        )
        .unwrap()
        .generation;
        let view = generation.catalog.provider_view();
        let tool = view
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "bash")
            .unwrap();
        let binding = generation
            .catalog
            .binding(tool["toolBindingRef"].as_str().unwrap(), "bash")
            .unwrap();
        let input = binding
            .canonicalize(
                json!({"command":"make shell", "terminal":{"stdin":"./build.sh\nexit\n"}}),
            )
            .unwrap();
        let mut effect = PreparedEffect {
            permissions: LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
            generation: Arc::clone(&generation),
            binding,
            source_binding: None,
            scope: PreparedEffectScope::Process,
            input,
            workspace_id: Some("workspace:scope".into()),
            operation: "bash".into(),
            logical_targets: vec![".".into()],
            private_resolved_targets: vec![],
            canonical_invocation: json!({"toolId":"bash", "arguments":{"command":"make shell", "executionScope":"host", "workspaceMode":"write", "terminal":{"stdin":"./build.sh\nexit\n"}}}),
            workspace_root: None,
            workspace_access: Some(WorkspaceAccess::Project),
            workspace_policy: None,
            delete_target_kind: None,
            process_workspace_mode: Some("write".into()),
            process_execution_scope: Some("host".into()),
            file_requests: RequestedFiles::default(),
            file_access: FileAccessScope::default(),
            file_authority_required: false,
            git_write_requested: false,
            network_request: None,
            network_authority: None,
        };
        let authority = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"bash", "command":"make build", "writablePaths":[{"path":"build", "kind":"directory"}]}]});
        assert!(authority_covers(&authority, &effect));
        let empty_paths = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"bash", "writablePaths":[]}]});
        assert!(!authority_covers(&empty_paths, &effect));
        effect.workspace_id = Some("workspace:other".into());
        assert!(!authority_covers(&authority, &effect));
        effect.workspace_id = Some("workspace:scope".into());
        effect.operation = "fs.write".into();
        effect.logical_targets = vec!["src/pool.hpp".into()];
        let file = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.edit", "target":"src/pool.hpp"}]});
        assert!(authority_covers(&file, &effect));
        effect.operation = "document.render".into();
        assert!(authority_covers(&file, &effect));
        effect.logical_targets = vec!["reports/output.pdf".into()];
        assert!(!authority_covers(&file, &effect));
        effect.operation = "fs.write".into();
        effect.logical_targets = vec!["src/other.hpp".into()];
        assert!(!authority_covers(&file, &effect));
        let directory = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.edit", "target":"src", "targetKind":"directoryTree"}]});
        assert!(authority_covers(&directory, &effect));
        effect.logical_targets = vec!["src/nested/new.hpp".into()];
        assert!(authority_covers(&directory, &effect));
        effect.operation = "fs.edit".into();
        assert!(authority_covers(&directory, &effect));
        effect.logical_targets = vec!["src-other/new.hpp".into()];
        assert!(!authority_covers(&directory, &effect));
        effect.logical_targets = vec!["src".into()];
        assert!(!authority_covers(&directory, &effect));
        effect.logical_targets = vec!["src/pool.hpp".into()];
        effect.operation = "fs.delete".into();
        effect.delete_target_kind = Some("file".into());
        assert!(!authority_covers(&file, &effect));
        assert!(!authority_covers(&directory, &effect));
        let deletion = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.delete", "target":"src/pool.hpp", "targetKind":"file"}]});
        assert!(authority_covers(&deletion, &effect));
        effect.delete_target_kind = Some("directoryTree".into());
        assert!(!authority_covers(&deletion, &effect));
        generation.catalog.dispose().unwrap();
    }

    #[test]
    fn first_cancel_phase_is_frozen_for_the_execution_owner() {
        let control = AttemptControl::default();
        control.request_cancel();
        assert!(!control.start_execution());
        control.request_cancel();

        assert!(control.cancellation.is_cancelled());
        assert_eq!(control.claim_outcome(), Some(ActivePhase::Prepared));
        control.finish();
        assert!(control.wait_complete(Duration::ZERO));
    }

    #[test]
    fn workspace_shell_cancel_receipt_preserves_output_and_cleanup_failures() {
        use achbit_kernel_runtime::workspace_sandbox::{
            native_backend_id, SandboxBackend, SandboxBackendRegistry, SandboxProcessRequest,
            SandboxStatus,
        };
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        // Exercise the real Kernel execution/record/cancel path at the trusted
        // backend boundary; physical process reaping has executor and GUI tests.
        struct CancelBackend(bool);
        impl SandboxBackend for CancelBackend {
            fn id(&self) -> &str {
                native_backend_id()
            }
            fn probe(&self) -> SandboxStatus {
                SandboxStatus {
                    backend: self.id().into(),
                    available: true,
                    reason: None,
                }
            }
            fn execute(
                &self,
                request: SandboxProcessRequest<'_>,
            ) -> achbit_kernel_abi::KernelResult<KernelToolExecutionResult> {
                let directory = request.context.output_directory.as_ref().unwrap();
                std::fs::create_dir_all(directory).unwrap();
                let archive = directory.join("stdout.txt");
                std::fs::write(&archive, "started").unwrap();
                request.context.progress.started();
                assert!(request.context.cancellation.is_cancelled());
                if self.0 {
                    return Err(achbit_kernel_abi::KernelError::Structured {
                        code: "shell_cleanup_failed",
                        stage: "execution",
                        message: "original cleanup failure".into(),
                        details: json!({}),
                    });
                }
                Ok(KernelToolExecutionResult {
                    invocation_id: request.invocation.id,
                    outcome: KernelToolExecutionOutcome::Failed,
                    output: json!({"stdout":"started", "success":false, "exitCode":null,
                        "fullOutput":{"stdout":{"path":archive}}}),
                    error: Some(
                        achbit_kernel_runtime::executors::KernelToolExecutionFailure {
                            code: "tool_execution_cancelled".into(),
                            message: "Shell stopped".into(),
                        },
                    ),
                })
            }
        }
        for cleanup_failed in [false, true] {
            let config = KernelExecutorConfig {
                sandbox_backends: Arc::new(
                    SandboxBackendRegistry::new(vec![Box::new(CancelBackend(cleanup_failed))])
                        .unwrap(),
                ),
                ..Default::default()
            };
            let (kernel, request, _) = kernel_with_executor(
                Arc::new(Workspace),
                "bash",
                json!({"workspaceId":"workspace:test", "command":"printf started; sleep 30"}),
                crate::local_agent_product_tools::test_product_tools(),
                config,
            );
            let kernel = Arc::new(kernel);
            let cancelling_kernel = Arc::clone(&kernel);
            let call_id = request.call_id.clone();
            let progress = achbit_kernel_runtime::executors::KernelProgressSink::new(move |_| {
                cancelling_kernel.lock_active().unwrap()[&call_id]
                    .control
                    .request_cancel();
            });
            let reply = kernel
                .execute_with_progress(request.clone(), progress)
                .unwrap();
            let expected = if cfg!(target_os = "linux") && !cleanup_failed {
                "cancelled"
            } else {
                "indeterminate"
            };
            assert_eq!(reply["status"], expected, "{reply}");
            let record = &reply["record"];
            assert_eq!(record["outcome"], expected);
            if cleanup_failed {
                assert!(record["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("shell_cleanup_failed: original cleanup failure"));
            } else {
                assert_eq!(record["output"]["stdout"], "started");
                assert_eq!(
                    std::fs::read_to_string(
                        record["output"]["fullOutput"]["stdout"]["path"]
                            .as_str()
                            .unwrap()
                    )
                    .unwrap(),
                    "started"
                );
                if expected == "cancelled" {
                    assert!(record.get("error").is_none());
                }
            }
            assert_eq!(
                kernel.records.read(&request.call_id).unwrap().as_ref(),
                Some(record)
            );
            for _ in 0..2 {
                let cancelled = kernel
                    .cancel(&request.call_id, &request.attempt_id)
                    .unwrap();
                assert_eq!(cancelled["status"], expected);
                assert_eq!(&cancelled["record"], record);
            }
            std::fs::remove_dir_all(&kernel.output_root).unwrap();
        }
    }

    #[test]
    fn confirmed_cancellation_is_limited_to_foreground_workspace_shells() {
        struct Workspace;
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: std::env::current_dir().unwrap().to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let (kernel, request, _) = kernel_with_request(
            Arc::new(Workspace),
            "bash",
            json!({"workspaceId":"workspace:test", "command":"pwd"}),
        );
        let mut prepared = kernel.prepare_tool(&request).unwrap();
        let mut result = KernelToolExecutionResult {
            invocation_id: "invocation:cancel".into(),
            outcome: KernelToolExecutionOutcome::Failed,
            output: json!({}),
            error: Some(
                achbit_kernel_runtime::executors::KernelToolExecutionFailure {
                    code: "tool_execution_cancelled".into(),
                    message: "Shell stopped".into(),
                },
            ),
        };
        assert_eq!(
            is_confirmed_workspace_shell_cancellation(&prepared, &result),
            cfg!(target_os = "linux")
        );
        result.error.as_mut().unwrap().code = "bash_timed_out".into();
        assert!(!is_confirmed_workspace_shell_cancellation(
            &prepared, &result
        ));
        result.error.as_mut().unwrap().code = "tool_execution_cancelled".into();
        result.outcome = KernelToolExecutionOutcome::Completed;
        assert!(!is_confirmed_workspace_shell_cancellation(
            &prepared, &result
        ));
        result.outcome = KernelToolExecutionOutcome::Failed;
        prepared.source_binding = Some(prepared.binding.clone());
        assert!(!is_confirmed_workspace_shell_cancellation(
            &prepared, &result
        ));
        prepared.source_binding = None;
        if let PreparedToolInput::Builtin(KernelCanonicalInvocation::ProcessShell {
            execution_scope,
            ..
        }) = &mut prepared.input
        {
            *execution_scope = KernelExecutionScope::Host;
        } else {
            panic!("expected builtin Shell");
        }
        assert!(!is_confirmed_workspace_shell_cancellation(
            &prepared, &result
        ));
        prepared.input = PreparedToolInput::Dynamic {
            arguments: json!({}),
            targets: vec![],
        };
        assert!(!is_confirmed_workspace_shell_cancellation(
            &prepared, &result
        ));
    }

    #[test]
    fn cancellation_after_outcome_claim_does_not_rewrite_the_result() {
        let control = AttemptControl::default();
        assert_eq!(control.claim_outcome(), None);
        control.request_cancel();

        assert!(!control.cancellation.is_cancelled());
        control.finish();
        assert!(control.wait_complete(Duration::ZERO));
    }

    #[test]
    fn cancellation_handle_observes_the_current_execution_phase() {
        let control = AttemptControl::default();
        let pending_cancellation = control.clone();
        assert!(control.start_execution());
        pending_cancellation.request_cancel();
        assert!(control.cancellation.is_cancelled());
        assert_eq!(control.claim_outcome(), Some(ActivePhase::Executing));
        control.finish();
        assert!(pending_cancellation.wait_complete(Duration::ZERO));
    }

    #[test]
    fn cancellation_during_execution_preserves_the_original_failure_in_the_record() {
        struct UnusedWorkspace;
        impl WorkspaceResolverPort for UnusedWorkspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                panic!("session.read has no workspace effect")
            }
        }
        struct FailedReader;
        impl crate::local_agent_product_tools::SessionReadPort for FailedReader {
            fn read(&self, _: Value) -> Result<Value, crate::session_service::SessionServiceError> {
                Err(crate::session_service::SessionServiceError::new(
                    "fixture_cleanup_failed",
                    "original cleanup failure",
                ))
            }
        }
        let product = Arc::new(crate::local_agent_product_tools::ProductTools::new(
            Arc::new(FailedReader),
        ));
        let (kernel, request, _) = kernel_with_product_tools(
            Arc::new(UnusedWorkspace),
            "session.read",
            json!({"sessionId":"session:reject"}),
            product,
        );
        let kernel = Arc::new(kernel);
        let cancelling_kernel = Arc::clone(&kernel);
        let call_id = request.call_id.clone();
        let progress = achbit_kernel_runtime::executors::KernelProgressSink::new(move |event| {
            if matches!(
                event,
                achbit_kernel_runtime::executors::KernelToolProgress::Started { .. }
            ) {
                cancelling_kernel.lock_active().unwrap()[&call_id]
                    .control
                    .request_cancel();
            }
        });
        let reply = kernel
            .execute_with_progress(request.clone(), progress)
            .unwrap();
        assert_eq!(reply["status"], "indeterminate");
        assert_eq!(reply["record"]["outcome"], "indeterminate");
        assert_eq!(
            reply["record"]["error"]["code"],
            "tool_effect_outcome_unknown"
        );
        assert!(reply["record"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fixture_cleanup_failed: original cleanup failure"));
        assert_eq!(
            kernel.records.read(&request.call_id).unwrap().unwrap(),
            reply["record"]
        );
    }
}

/// Storage names are portable; logical content hashes retain their original format.
pub(crate) fn output_directory_key(identity: &str) -> String {
    achbit_kernel_tools::hash_bytes(identity.as_bytes()).replace(':', "-")
}

#[cfg(test)]
mod output_directory_tests {
    #[test]
    fn output_names_are_portable_components() {
        let identity = "session:record/with/path";
        let component = super::output_directory_key(identity);
        assert!(!component.is_empty());
        assert!(!component
            .chars()
            .any(|character| r#"<>:\"/\|?*"#.contains(character)));
    }
}
