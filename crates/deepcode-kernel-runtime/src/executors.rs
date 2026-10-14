use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_tools::file_content::read_text_file_for_llm;
use deepcode_kernel_tools::kernel_internal::{
    KernelCanonicalInvocation, KernelDeleteTarget, KernelTextEdit, KernelToolKind,
};
use deepcode_kernel_tools::KernelToolRegistry;
use deepcode_kernel_tools::ToolAvailability;
pub(crate) use process::invoke_workspace_shell as execute_workspace_shell;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Default)]
pub struct KernelExecutorConfig {
    pub sandbox_backend: Option<String>,
    /// Trusted registration at Host startup; never supplied by a model or tool argument.
    pub sandbox_backends: Arc<crate::workspace_sandbox::SandboxBackendRegistry>,
    pub web_search_endpoint_template: String,
    pub web_search_auth_header_name: String,
    pub web_search_auth_secret_ref: String,
    pub cloud_web_search: Option<CloudWebSearchConfig>,
    pub shell_program: Option<crate::shell_environment::ShellProgram>,
    pub execution_path: Option<String>,
    pub temporary_root: Option<PathBuf>,
    /// Shared package cache of workspace Shells across Sessions.
    pub shell_cache_root: Option<PathBuf>,
    pub file_read_roots: Vec<PathBuf>,
    pub wsl: Option<crate::wsl_execution::WslExecution>,
}

/// Frozen, secret-free search transport selected when preparing a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWebSearchConfig {
    pub provider: CloudWebSearchProvider,
    pub endpoint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloudWebSearchProvider {
    DeepSeek,
    Glm,
    Kimi,
}

pub trait SecretProvider: Send + Sync {
    fn resolve(&self, secret_ref: &str) -> Option<String>;
}

#[derive(Debug, Default)]
pub struct EmptySecretProvider;

impl SecretProvider for EmptySecretProvider {
    fn resolve(&self, _secret_ref: &str) -> Option<String> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolInvocation {
    pub id: String,
    pub input: KernelCanonicalInvocation,
}

#[derive(Debug, Clone, Default)]
pub struct KernelCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl KernelCancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(AtomicOrdering::Acquire)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceWriteTarget {
    pub path: PathBuf,
    pub directory: bool,
}

/// Live execution observations. Output remains in the Kernel archive; these
/// bytes are transient delivery, not additional execution records.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KernelToolProgress {
    Started {
        started_at: String,
    },
    Output {
        stream: String,
        offset: u64,
        bytes: Vec<u8>,
    },
}

#[derive(Clone, Default)]
pub struct KernelProgressSink(Option<Arc<dyn Fn(KernelToolProgress) + Send + Sync>>);

impl std::fmt::Debug for KernelProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KernelProgressSink")
    }
}

impl KernelProgressSink {
    pub fn new(send: impl Fn(KernelToolProgress) + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(send)))
    }

    pub fn emit(&self, progress: KernelToolProgress) {
        if let Some(send) = &self.0 {
            send(progress);
        }
    }

    pub fn started(&self) {
        self.emit(KernelToolProgress::Started {
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KernelToolExecutionContext {
    /// Kernel-owned per-attempt archive. Retained output belongs to the Session.
    pub output_directory: Option<PathBuf>,
    pub workspace_root: Option<String>,
    pub workspace_id: Option<String>,
    pub private_resolved_targets: Vec<String>,
    /// None is an explicit unrestricted workspace-write grant; Some limits writes to Plan paths.
    pub workspace_write_targets: Option<Vec<WorkspaceWriteTarget>>,
    pub file_access: crate::file_access::FileAccessScope,
    #[serde(skip)]
    pub cancellation: KernelCancellationToken,
    #[serde(skip)]
    pub progress: KernelProgressSink,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelToolExecutionOutcome {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolExecutionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolExecutionResult {
    pub invocation_id: String,
    pub outcome: KernelToolExecutionOutcome,
    pub output: Value,
    pub error: Option<KernelToolExecutionFailure>,
}

pub trait KernelToolExecutor: Send + Sync {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult>;
}

#[derive(Default)]
pub struct KernelExecutorRegistry {
    executors: BTreeMap<&'static str, Box<dyn KernelToolExecutor>>,
}

impl KernelExecutorRegistry {
    pub fn from_executors(executors: Vec<(&'static str, Box<dyn KernelToolExecutor>)>) -> Self {
        let mut registry = Self::default();
        for (tool_id, executor) in executors {
            assert!(
                registry.executors.insert(tool_id, executor).is_none(),
                "duplicate executor binding for canonical tool {tool_id}"
            );
        }
        registry
    }

    pub fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let tool_id = invocation.input.tool_id().as_str();
        let executor = self.executors.get(tool_id).ok_or_else(|| {
            KernelError::PermissionDenied(format!(
                "Kernel tool {tool_id} has no executable binding"
            ))
        })?;
        if context.cancellation.is_cancelled() {
            return Err(KernelError::Structured {
                code: "tool_execution_cancelled",
                stage: "execution",
                message: format!("Kernel tool {tool_id} was cancelled before execution"),
                details: serde_json::json!({ "toolId": tool_id }),
            });
        }
        executor.invoke(invocation, context)
    }
}

pub fn builtin_executors(
    registry: &KernelToolRegistry,
    config: KernelExecutorConfig,
    secret_provider: Arc<dyn SecretProvider>,
) -> Vec<(&'static str, Box<dyn KernelToolExecutor>)> {
    registry
        .executor_bindings()
        .map(|(tool_id, binding)| {
            if let Some(wsl) = config
                .wsl
                .as_ref()
                .filter(|_| tool_id == "bash" || tool_id.starts_with("fs."))
            {
                return (
                    tool_id,
                    Box::new(crate::wsl_execution::WslExecutor {
                        target: wsl.clone(),
                        shell: config.shell_program.clone(),
                        execution_path: config.execution_path.clone(),
                    }) as Box<dyn KernelToolExecutor>,
                );
            }
            (
                tool_id,
                executor_for_binding(binding, config.clone(), Arc::clone(&secret_provider)),
            )
        })
        .collect()
}

pub fn web_search_availability(config: &KernelExecutorConfig) -> ToolAvailability {
    web::web_search_availability(config)
}

pub fn resolved_network_target(
    input: &KernelCanonicalInvocation,
    config: &KernelExecutorConfig,
) -> KernelResult<Option<String>> {
    match input {
        KernelCanonicalInvocation::WebSearch { query, limit } => {
            let target = web::web_search_target_url(config, query, u64::from(*limit))?;
            web::validate_http_url(&target)?;
            Ok(Some(target))
        }
        KernelCanonicalInvocation::WebFetch { url, .. } => {
            web::validate_http_url(url)?;
            Ok(Some(url.clone()))
        }
        _ => Ok(None),
    }
}

fn executor_for_binding(
    binding: KernelToolKind,
    config: KernelExecutorConfig,
    secret_provider: Arc<dyn SecretProvider>,
) -> Box<dyn KernelToolExecutor> {
    match binding {
        KernelToolKind::FsRead => Box::new(FsReadExecutor),
        KernelToolKind::FsWrite => Box::new(FsWriteExecutor),
        KernelToolKind::FsEdit => Box::new(FsEditExecutor),
        KernelToolKind::FsDelete => Box::new(FsDeleteExecutor),
        KernelToolKind::WebSearch => Box::new(WebSearchExecutor {
            config,
            secret_provider,
        }),
        KernelToolKind::WebFetch => Box::new(WebFetchExecutor),
        KernelToolKind::ProcessShell | KernelToolKind::ProcessPowerShell => {
            Box::new(process::ConfiguredShellExecutor {
                program: config.shell_program,
                execution_path: config.execution_path,
                temporary_root: config.temporary_root,
                sandbox_backends: config.sandbox_backends,
            })
        }
    }
}

#[path = "executors/file_changes.rs"]
mod file_changes;
pub use file_changes::{capture_side as capture_file_change_side, change_fact as file_change_fact};
#[path = "executors/fs.rs"]
mod filesystem;
mod process;
pub use process::execute_cli_command;
pub(crate) mod web;

use filesystem::*;
#[cfg(test)]
use process::*;
use web::*;

fn ok(invocation_id: String, output: Value) -> KernelToolExecutionResult {
    KernelToolExecutionResult {
        invocation_id,
        outcome: KernelToolExecutionOutcome::Completed,
        output,
        error: None,
    }
}

fn known_failure(
    invocation_id: String,
    output: Value,
    code: &str,
    message: impl Into<String>,
) -> KernelToolExecutionResult {
    KernelToolExecutionResult {
        invocation_id,
        outcome: KernelToolExecutionOutcome::Failed,
        output,
        error: Some(KernelToolExecutionFailure {
            code: code.to_string(),
            message: message.into(),
        }),
    }
}

// Both operations have already run. Keep the first failure as primary while
// retaining a later cleanup/reader failure in the same returned diagnostic.
pub(crate) fn combine_shell_results<T, U>(
    primary: KernelResult<T>,
    cleanup: KernelResult<U>,
) -> KernelResult<(T, U)> {
    match (primary, cleanup) {
        (Ok(value), Ok(cleaned)) => Ok((value, cleaned)),
        (Err(error), Ok(_)) | (Ok(_), Err(error)) => Err(error),
        (Err(mut error), Err(cleanup)) => {
            let cleanup = deepcode_kernel_abi::KernelErrorEnvelope::from(&cleanup);
            let suffix = format!("; cleanup failed [{}]: {}", cleanup.code, cleanup.message);
            match &mut error {
                KernelError::InvalidCommand(message)
                | KernelError::WorkspaceAccessDenied(message)
                | KernelError::WorkspaceRootUnreadable(message)
                | KernelError::AttachmentAccessDenied(message)
                | KernelError::PendingPermissionUnavailable(message)
                | KernelError::PermissionDenied(message)
                | KernelError::Structured { message, .. }
                | KernelError::Other(message) => message.push_str(&suffix),
                KernelError::MissingWorkspaceBinding => {
                    error = KernelError::Structured {
                        code: "workspace_binding_required",
                        stage: "execution",
                        message: format!("{error}{suffix}"),
                        details: Value::Null,
                    };
                }
            }
            Err(error)
        }
    }
}

#[derive(Debug)]
struct TextEditRange {
    start: usize,
    end: usize,
    new_text: String,
}

#[derive(Debug)]
struct AppliedTextEdits {
    updated: String,
    changed_ranges: Value,
    preview: Value,
}

fn apply_exact_text_edits(
    original: &str,
    edits: &[KernelTextEdit],
) -> KernelResult<AppliedTextEdits> {
    let mut ranges = Vec::with_capacity(edits.len());
    for (edit_index, edit) in edits.iter().enumerate() {
        let (start, end) = unique_match_range(original, &edit.old_text, edit_index)?;
        ranges.push(TextEditRange {
            start,
            end,
            new_text: edit.new_text.clone(),
        });
    }
    ranges.sort_by_key(|range| range.start);
    if ranges.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err(KernelError::Structured {
            code: "edit_ranges_overlap",
            stage: "execution",
            message: "fs.edit replacement ranges must not overlap".to_string(),
            details: serde_json::json!({ "classification": "overlapping_edits" }),
        });
    }

    let changed_ranges = Value::Array(
        ranges
            .iter()
            .map(|range| byte_range_json(range.start, range.end, range.new_text.len()))
            .collect(),
    );
    let mut updated = original.to_string();
    for range in ranges.iter().rev() {
        updated.replace_range(range.start..range.end, &range.new_text);
    }
    let preview = edit_preview(original, &updated, &ranges);
    Ok(AppliedTextEdits {
        updated,
        changed_ranges,
        preview,
    })
}

// Show actual before/after line context, including joins caused by a replaced
// newline. This bounded display result never changes matching or file content.
fn edit_preview(original: &str, updated: &str, ranges: &[TextEditRange]) -> Value {
    fn excerpt(text: &str, start: usize, end: usize, limit: usize) -> (String, bool, usize) {
        let line_start = text[..start].rfind('\n').map_or(0, |index| index + 1);
        let line_end = text[end..]
            .find('\n')
            .map_or(text.len(), |index| end + index + 1);
        let mut chars = text[line_start..line_end].chars();
        let content = chars.by_ref().take(limit).collect::<String>();
        let truncated = chars.next().is_some();
        let line = text[..line_start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1;
        (content, truncated, line)
    }
    let mut remaining = 4096;
    let mut hunks = Vec::new();
    let mut offset: isize = 0;
    let mut truncated = false;
    for range in ranges {
        if remaining < 2 {
            truncated = true;
            break;
        }
        let start = (range.start as isize + offset) as usize;
        let (before, before_cut, old_line) =
            excerpt(original, range.start, range.end, remaining / 2);
        let (after, after_cut, new_line) =
            excerpt(updated, start, start + range.new_text.len(), remaining / 2);
        remaining -= before.chars().count() + after.chars().count();
        truncated |= before_cut || after_cut;
        hunks.push(serde_json::json!({"oldStartLine":old_line, "newStartLine":new_line, "before":before, "after":after}));
        offset += range.new_text.len() as isize - (range.end - range.start) as isize;
    }
    serde_json::json!({"hunks":hunks, "truncated":truncated})
}

fn unique_match_range(
    haystack: &str,
    needle: &str,
    edit_index: usize,
) -> KernelResult<(usize, usize)> {
    if needle.is_empty() {
        return Err(KernelError::Structured {
            code: "patch_match_empty",
            stage: "execution",
            message: format!("fs.edit edits[{edit_index}] oldText must not be empty"),
            details: serde_json::json!({
                "classification": "invalid_patch_match",
                "editIndex": edit_index,
            }),
        });
    }
    let needle_lines = needle.lines().count();
    let mut matches = haystack.match_indices(needle);
    let Some((start, _)) = matches.next() else {
        return Err(KernelError::Structured {
            code: "patch_match_not_found",
            stage: "execution",
            message: format!(
                "fs.edit edits[{edit_index}] oldText was not found in the target file ({} bytes, {} lines)",
                needle.len(),
                needle_lines,
            ),
            details: serde_json::json!({
                "classification": "stale_or_mismatched_evidence",
                "editIndex": edit_index,
                "oldTextBytes": needle.len(),
                "oldTextLines": needle_lines,
            }),
        });
    };
    if matches.next().is_some() {
        return Err(KernelError::Structured {
            code: "patch_match_ambiguous",
            stage: "execution",
            message: format!(
                "fs.edit edits[{edit_index}] oldText matches the target file more than once; expected exactly one match"
            ),
            details: serde_json::json!({
                "classification": "ambiguous_patch_match",
                "editIndex": edit_index,
            }),
        });
    }
    Ok((start, start + needle.len()))
}

fn byte_range_json(start: usize, end: usize, replacement_bytes: usize) -> Value {
    serde_json::json!({
        "startByte": start,
        "endByte": end,
        "replacementBytes": replacement_bytes
    })
}

fn atomic_write_text(target: &Path, content: &str) -> KernelResult<()> {
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("patch target has no parent directory".to_string())
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("patch-target");
    let temp_path = parent.join(format!(".{file_name}.deepcode-patch-{stamp}.tmp"));
    let mut cleanup = TemporaryPathGuard::new(temp_path.clone());
    let original_permissions = fs::metadata(target)
        .map_err(|error| KernelError::Other(format!("inspect target permissions: {error}")))?
        .permissions();
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write patch temp: {error}")))?;
    fs::set_permissions(&temp_path, original_permissions)
        .map_err(|error| KernelError::Other(format!("preserve target permissions: {error}")))?;
    fs::rename(&temp_path, target)
        .map_err(|error| KernelError::Other(format!("commit patch: {error}")))?;
    cleanup.disarm();
    Ok(())
}

fn atomic_create_text(target: &Path, content: &str, executable: bool) -> KernelResult<()> {
    if executable && !cfg!(unix) {
        return Err(KernelError::Structured {
            code: "unsupported_file_attribute",
            stage: "tool.execute",
            message: "fs.write executable=true is not supported on native Windows".to_string(),
            details: serde_json::json!({
                "toolId": "fs.write",
                "attribute": "executable",
                "platform": std::env::consts::OS,
            }),
        });
    }
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("fs.write target has no parent directory".to_string())
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("write-target");
    let temp_path = parent.join(format!(".{file_name}.deepcode-write-{stamp}.tmp"));
    let mut cleanup = TemporaryPathGuard::new(temp_path.clone());
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write fs.write temp: {error}")))?;
    #[cfg(unix)]
    if executable {
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o755)).map_err(|error| {
            KernelError::Other(format!("set fs.write executable mode: {error}"))
        })?;
    }
    fs::hard_link(&temp_path, target)
        .map_err(|error| KernelError::Other(format!("commit fs.write create: {error}")))?;
    fs::remove_file(&temp_path)
        .map_err(|error| KernelError::Other(format!("remove fs.write temp: {error}")))?;
    cleanup.disarm();
    Ok(())
}

fn file_mode(path: &Path) -> KernelResult<Option<u32>> {
    let metadata = fs::metadata(path)
        .map_err(|error| KernelError::Other(format!("inspect file mode: {error}")))?;
    #[cfg(unix)]
    {
        Ok(Some(metadata.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Ok(None)
    }
}

struct TemporaryPathGuard {
    path: PathBuf,
    armed: bool,
}

impl TemporaryPathGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryPathGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn workspace_root(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    context
        .workspace_root
        .as_ref()
        .map(PathBuf::from)
        .ok_or(KernelError::MissingWorkspaceBinding)
}

fn workspace_id(context: &KernelToolExecutionContext) -> KernelResult<&str> {
    context
        .workspace_id
        .as_deref()
        .ok_or(KernelError::MissingWorkspaceBinding)
}

fn prepared_workspace_target(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    if context.private_resolved_targets.len() != 1 {
        return Err(KernelError::InvalidCommand(
            "workspace executor requires exactly one PreparedEffect target".to_string(),
        ));
    }
    let root = workspace_root(context)?;
    let target = PathBuf::from(&context.private_resolved_targets[0]);
    if !target.is_absolute()
        || (!target.starts_with(&root)
            && !context
                .file_access
                .read
                .iter()
                .any(|path| path == &target || (path.is_dir() && target.starts_with(path)))
            && !context.file_access.write.iter().any(|grant| {
                grant.path == target || (grant.directory && target.starts_with(&grant.path))
            }))
    {
        return Err(KernelError::PermissionDenied(
            "PreparedEffect target is outside the authorized file scope".to_string(),
        ));
    }
    Ok(target)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn required_string(value: &Value, key: &str) -> KernelResult<String> {
    get_string(value, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| KernelError::InvalidCommand(format!("{key} is required")))
}

fn normalize_relative_path(path: &str) -> String {
    if Path::new(path).is_absolute() {
        return path.to_owned();
    }
    let normalized = path
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests;

#[cfg(windows)]
pub(crate) mod windows_job;
#[cfg(windows)]
pub use windows_job::suppress_error_dialogs;
