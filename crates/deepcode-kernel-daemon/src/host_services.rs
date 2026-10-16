use crate::prelude::*;
use deepcode_kernel_abi::{
    HostResultSource, HostUnsupportedWorkspaceField, HostWorkspaceFolder, HostWorkspaceOpened,
    HostWorkspaceSaved, HostWorkspaceSourceKind, HostWorkspaceSpec,
};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
struct HostWorkspaceRecord {
    id: String,
    name: String,
    source: HostWorkspaceSourceKind,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
    opened_at: String,
}

#[derive(Debug, Default)]
struct HostWorkspaceState {
    next_workspace_index: u64,
    current: Option<HostWorkspaceRecord>,
}

#[derive(Clone, Default)]
pub(crate) struct HostWorkspaceService {
    state: Arc<Mutex<HostWorkspaceState>>,
}

impl HostWorkspaceService {
    pub(crate) fn open(&self, path: String) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let resolved = resolve_workspace_root(&path)?;
        preflight_workspace_root_readable(&resolved.root)?;
        let mut state = self.lock_state()?;
        let workspace = opened_workspace(&mut state, resolved);
        let output = workspace_spec(&workspace);
        state.current = Some(workspace);
        Ok(workspace_result(HostWorkspaceOutput::Opened(
            HostWorkspaceOpened { workspace: output },
        )))
    }

    pub(crate) fn current(&self) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let state = self.lock_state()?;
        Ok(workspace_result(HostWorkspaceOutput::Current(
            HostWorkspaceCurrent {
                current: state.current.as_ref().map(workspace_spec),
                fallback_used: false,
                last_error: None,
            },
        )))
    }

    pub(crate) fn save(
        &self,
        file_name: Option<String>,
    ) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let current = self.lock_state()?.current.clone().ok_or_else(|| {
            host_service_error(
                "host_workspace_missing",
                "保存工作区前必须先打开一个工作区。",
            )
        })?;
        let file_name =
            normalize_workspace_file_name(file_name.as_deref().unwrap_or(current.name.as_str()))?;
        let workspace_file_path = current.root.join(file_name);
        let overwritten = workspace_file_path.exists();
        atomic_write_workspace_json(
            &workspace_file_path,
            &json!({
                "folders": [{ "path": "." }],
                "settings": current.settings
            }),
        )?;
        let resolved = resolve_workspace_root(&workspace_file_path.to_string_lossy())?;
        preflight_workspace_root_readable(&resolved.root)?;
        let mut state = self.lock_state()?;
        let reopened = opened_workspace(&mut state, resolved);
        let reopened_spec = workspace_spec(&reopened);
        state.current = Some(reopened);
        Ok(workspace_result(HostWorkspaceOutput::Saved(
            HostWorkspaceSaved {
                workspace_file_path: workspace_file_path.to_string_lossy().to_string(),
                workspace: reopened_spec,
                created: !overwritten,
                overwritten,
            },
        )))
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HostWorkspaceState>, KernelErrorEnvelope> {
        self.state.lock().map_err(|_| {
            host_service_error("host_workspace_unavailable", "Host 工作区状态锁已损坏。")
        })
    }
}

#[derive(Clone, Default)]
pub(crate) struct HostServices {
    pub(crate) workspace: HostWorkspaceService,
}

impl HostServices {
    pub(crate) fn new() -> Self {
        Self::default()
    }
}

struct ResolvedWorkspaceRoot {
    source: HostWorkspaceSourceKind,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
}

fn resolve_workspace_root(path: &str) -> Result<ResolvedWorkspaceRoot, KernelErrorEnvelope> {
    let source = PathBuf::from(path.trim());
    if source.is_dir() {
        let root = source.canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("无法规范化工作区 {path}：{error}"),
            )
        })?;
        return Ok(ResolvedWorkspaceRoot {
            source: HostWorkspaceSourceKind::Directory,
            source_path: None,
            original_folder_path: root.to_string_lossy().to_string(),
            folder_is_absolute: true,
            root,
            settings: json!({}),
            unsupported_fields: Vec::new(),
        });
    }
    if source.is_file() && source.extension().and_then(OsStr::to_str) == Some("code-workspace") {
        let text = fs::read_to_string(&source).map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("无法读取工作区文件 {path}：{error}"),
            )
        })?;
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            host_service_error(
                "host_workspace_invalid_file",
                format!("工作区文件不是有效 JSON：{error}"),
            )
        })?;
        let folder_path = value
            .get("folders")
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                host_service_error(
                    "host_workspace_invalid_file",
                    "工作区文件缺少 folders[0].path。",
                )
            })?;
        let source_path = source.canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("无法规范化工作区文件 {path}：{error}"),
            )
        })?;
        let base = source.parent().unwrap_or_else(|| Path::new("."));
        let root = base.join(folder_path).canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("无法规范化工作区目录 {folder_path}：{error}"),
            )
        })?;
        return Ok(ResolvedWorkspaceRoot {
            source: HostWorkspaceSourceKind::CodeWorkspace,
            source_path: Some(source_path),
            root,
            original_folder_path: folder_path.to_string(),
            folder_is_absolute: Path::new(folder_path).is_absolute(),
            settings: value.get("settings").cloned().unwrap_or_else(|| json!({})),
            unsupported_fields: unsupported_workspace_fields(&value),
        });
    }
    Err(host_service_error(
        "host_workspace_invalid_path",
        format!("{path} 不是目录或 .code-workspace 文件。"),
    ))
}

fn opened_workspace(
    state: &mut HostWorkspaceState,
    resolved: ResolvedWorkspaceRoot,
) -> HostWorkspaceRecord {
    state.next_workspace_index += 1;
    let name = resolved
        .source_path
        .as_ref()
        .or(Some(&resolved.root))
        .and_then(|path| path.file_stem().or_else(|| path.file_name()))
        .and_then(OsStr::to_str)
        .unwrap_or("workspace")
        .to_string();
    HostWorkspaceRecord {
        id: format!("ws-{}", state.next_workspace_index),
        name,
        source: resolved.source,
        source_path: resolved.source_path,
        root: resolved.root,
        original_folder_path: resolved.original_folder_path,
        folder_is_absolute: resolved.folder_is_absolute,
        settings: resolved.settings,
        unsupported_fields: resolved.unsupported_fields,
        opened_at: crate::now_millis().to_string(),
    }
}

fn workspace_spec(workspace: &HostWorkspaceRecord) -> HostWorkspaceSpec {
    let root_path = workspace.root.to_string_lossy().to_string();
    HostWorkspaceSpec {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        source: workspace.source,
        source_path: workspace
            .source_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        root_path: root_path.clone(),
        folders: vec![HostWorkspaceFolder {
            id: "wf-0".to_string(),
            name: workspace.name.clone(),
            path: root_path.clone(),
            absolute_path: root_path,
            original_path: workspace.original_folder_path.clone(),
            is_absolute: workspace.folder_is_absolute,
        }],
        unsupported_fields: workspace.unsupported_fields.clone(),
        opened_at: workspace.opened_at.clone(),
    }
}

fn workspace_result(output: HostWorkspaceOutput) -> HostWorkspaceResult {
    HostWorkspaceResult {
        source: HostResultSource::HostManagement,
        output,
    }
}

fn preflight_workspace_root_readable(root: &Path) -> Result<(), KernelErrorEnvelope> {
    fs::read_dir(root).map(|_| ()).map_err(|error| {
        host_service_error(
            "host_workspace_root_unreadable",
            format!("无法读取工作区目录 {}：{error}", root.display()),
        )
    })
}

fn normalize_workspace_file_name(name: &str) -> Result<String, KernelErrorEnvelope> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(host_service_error(
            "host_workspace_invalid_file_name",
            "工作区文件名不能为空，也不能包含路径分隔符。",
        ));
    }
    let sanitized = trimmed
        .chars()
        .map(|character| {
            if matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.ends_with(".code-workspace") {
        Ok(sanitized)
    } else {
        Ok(format!("{sanitized}.code-workspace"))
    }
}

fn atomic_write_workspace_json(path: &Path, value: &Value) -> Result<(), KernelErrorEnvelope> {
    let parent = path.parent().ok_or_else(|| {
        host_service_error("host_workspace_invalid_path", "工作区文件没有父目录。")
    })?;
    let content = serde_json::to_vec_pretty(value).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("无法编码工作区文件：{error}"),
        )
    })?;
    let temp_path = parent.join(format!(
        ".deepcode-workspace-{}-{}.tmp",
        std::process::id(),
        crate::now_millis()
    ));
    let mut temp_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| {
            host_service_error(
                "host_workspace_save_failed",
                format!("无法创建临时文件 {}：{error}", temp_path.display()),
            )
        })?;
    let cleanup = HostTemporaryPath::new(temp_path.clone());
    std::io::Write::write_all(&mut temp_file, &content).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("无法写入临时文件 {}：{error}", temp_path.display()),
        )
    })?;
    temp_file.sync_all().map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("无法同步临时文件 {}：{error}", temp_path.display()),
        )
    })?;
    drop(temp_file);
    fs::rename(&temp_path, path).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("无法保存工作区文件 {}：{error}", path.display()),
        )
    })?;
    cleanup.disarm();
    Ok(())
}

struct HostTemporaryPath {
    path: PathBuf,
    armed: bool,
}

impl HostTemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for HostTemporaryPath {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn unsupported_workspace_fields(value: &Value) -> Vec<HostUnsupportedWorkspaceField> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(key, _)| key.as_str() != "folders" && key.as_str() != "settings")
        .map(|(key, value)| HostUnsupportedWorkspaceField {
            key: key.clone(),
            kind: value_kind(value).to_string(),
        })
        .collect()
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn host_service_error(code: &str, message: impl Into<String>) -> KernelErrorEnvelope {
    KernelErrorEnvelope {
        code: code.to_string(),
        message: message.into(),
        message_key: None,
        args: None,
    }
}
