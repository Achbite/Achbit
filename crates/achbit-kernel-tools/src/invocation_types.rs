use crate::types::ToolValidationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_CANONICAL_INVOCATION_BYTES: usize = 1024 * 1024;
const MAX_ORDINARY_STRING_BYTES: usize = 16 * 1024;
pub const MAX_TERMINAL_STDIN_BYTES: usize = 64 * 1024;

fn empty_field(field: &'static str) -> ToolValidationError {
    ToolValidationError::EmptyField { field }
}

fn field_too_large(field: &'static str, maximum_bytes: usize) -> ToolValidationError {
    ToolValidationError::FieldTooLarge {
        field,
        maximum_bytes,
    }
}

fn invalid_value(field: &'static str, reason: &'static str) -> ToolValidationError {
    ToolValidationError::InvalidValue { field, reason }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum KernelToolKind {
    #[serde(rename = "fs.delete")]
    FsDelete,
    #[serde(rename = "fs.edit")]
    FsEdit,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "bash")]
    ProcessShell,
    #[serde(rename = "powershell")]
    ProcessPowerShell,
    #[serde(rename = "web.fetch")]
    WebFetch,
    #[serde(rename = "web.search")]
    WebSearch,
}

impl KernelToolKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FsDelete => "fs.delete",
            Self::FsEdit => "fs.edit",
            Self::FsRead => "fs.read",
            Self::FsWrite => "fs.write",
            Self::ProcessShell => "bash",
            Self::ProcessPowerShell => "powershell",
            Self::WebFetch => "web.fetch",
            Self::WebSearch => "web.search",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelWorkspaceMode {
    #[default]
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelExecutionScope {
    #[default]
    Workspace,
    Host,
}

impl KernelWorkspaceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

impl KernelExecutionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Host => "host",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelTerminalInput {
    pub stdin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelTextEdit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "targetKind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelDeleteTarget {
    File { path: String },
    DirectoryTree { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "toolId",
    content = "arguments",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelCanonicalInvocation {
    #[serde(rename = "fs.read")]
    FsRead {
        path: String,
        #[serde(default = "default_start_line")]
        start_line: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_byte: Option<u64>,
        #[serde(default = "default_max_lines")]
        max_lines: u32,
        #[serde(default = "default_read_bytes")]
        max_bytes: u32,
    },
    #[serde(rename = "fs.write")]
    FsWrite {
        path: String,
        content: String,
        executable: Option<bool>,
    },
    #[serde(rename = "fs.edit")]
    FsEdit {
        path: String,
        edits: Vec<KernelTextEdit>,
    },
    #[serde(rename = "fs.delete")]
    FsDelete(KernelDeleteTarget),
    #[serde(rename = "bash")]
    ProcessShell {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_host_permission: Option<String>,
        #[serde(default)]
        workspace_mode: KernelWorkspaceMode,
        #[serde(default)]
        execution_scope: KernelExecutionScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout: Option<u32>,
        terminal: Option<KernelTerminalInput>,
    },
    #[serde(rename = "powershell")]
    ProcessPowerShell {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_host_permission: Option<String>,
        #[serde(default)]
        workspace_mode: KernelWorkspaceMode,
        #[serde(default)]
        execution_scope: KernelExecutionScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout: Option<u32>,
        terminal: Option<KernelTerminalInput>,
    },
    #[serde(rename = "web.search")]
    WebSearch {
        query: String,
        #[serde(default = "default_search_limit")]
        limit: u32,
    },
    #[serde(rename = "web.fetch")]
    WebFetch {
        url: String,
        #[serde(default = "default_fetch_bytes")]
        max_bytes: u32,
    },
}

fn default_start_line() -> u32 {
    1
}
fn default_max_lines() -> u32 {
    2_000
}
fn default_read_bytes() -> u32 {
    262_144
}
fn default_search_limit() -> u32 {
    5
}
fn default_fetch_bytes() -> u32 {
    98_304
}

impl KernelCanonicalInvocation {
    pub fn tool_id(&self) -> KernelToolKind {
        match self {
            Self::FsRead { .. } => KernelToolKind::FsRead,
            Self::FsWrite { .. } => KernelToolKind::FsWrite,
            Self::FsEdit { .. } => KernelToolKind::FsEdit,
            Self::FsDelete(_) => KernelToolKind::FsDelete,
            Self::ProcessShell { .. } => KernelToolKind::ProcessShell,
            Self::ProcessPowerShell { .. } => KernelToolKind::ProcessPowerShell,
            Self::WebSearch { .. } => KernelToolKind::WebSearch,
            Self::WebFetch { .. } => KernelToolKind::WebFetch,
        }
    }

    pub fn validate(&self) -> Result<(), ToolValidationError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|_| invalid_value("canonicalInvocation", "must serialize"))?;
        if encoded.len() > MAX_CANONICAL_INVOCATION_BYTES {
            return Err(field_too_large(
                "canonicalInvocation",
                MAX_CANONICAL_INVOCATION_BYTES,
            ));
        }
        match self {
            Self::FsRead {
                path,
                start_line,
                start_byte,
                max_lines,
                max_bytes,
            } => {
                if start_byte.is_some_and(|value| value > 9_007_199_254_740_991) {
                    return Err(invalid_value("startByte", "must be a safe byte offset"));
                }
                validate_path(path, false)?;
                validate_u32("startLine", *start_line, 1, u32::MAX)?;
                validate_u32("maxLines", *max_lines, 1, 5_000)?;
                validate_u32("maxBytes", *max_bytes, 1_024, 1_048_576)?;
            }
            Self::FsWrite { path, .. } => validate_path(path, false)?,
            Self::FsEdit { path, edits } => {
                validate_path(path, false)?;
                if edits.is_empty() || edits.len() > 128 {
                    return Err(invalid_value(
                        "edits",
                        "must contain between 1 and 128 items",
                    ));
                }
                let mut old_texts = std::collections::HashSet::with_capacity(edits.len());
                for edit in edits {
                    validate_text("edits.oldText", &edit.old_text, false)?;
                    validate_text("edits.newText", &edit.new_text, true)?;
                    if !old_texts.insert(edit.old_text.as_str()) {
                        return Err(invalid_value("edits.oldText", "must be unique"));
                    }
                }
            }
            Self::FsDelete(target) => match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    validate_path(path, false)?
                }
            },
            Self::ProcessShell {
                command,
                request_host_permission,
                workspace_mode: _,
                execution_scope: _,
                timeout,
                terminal,
            }
            | Self::ProcessPowerShell {
                command,
                request_host_permission,
                workspace_mode: _,
                execution_scope: _,
                timeout,
                terminal,
            } => {
                validate_text("command", command, false)?;
                if let Some(reason) = request_host_permission {
                    validate_text("requestHostPermission", reason, false)?;
                    if reason.len() > 1024 {
                        return Err(field_too_large("requestHostPermission", 1024));
                    }
                }
                if let Some(timeout) = timeout {
                    validate_u32("timeout", *timeout, 1, u32::MAX)?;
                }
                if let Some(terminal) = terminal {
                    if terminal.stdin.len() > MAX_TERMINAL_STDIN_BYTES {
                        return Err(field_too_large("terminal.stdin", MAX_TERMINAL_STDIN_BYTES));
                    }
                }
            }
            Self::WebSearch { query, limit } => {
                validate_text("query", query, false)?;
                validate_u32("limit", *limit, 1, 10)?;
            }
            Self::WebFetch { url, max_bytes } => {
                validate_text("url", url, false)?;
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://"))
                    || url_has_user_info(url)
                {
                    return Err(invalid_value("url", "must be HTTP(S) without user-info"));
                }
                validate_u32("maxBytes", *max_bytes, 1_024, 262_144)?;
            }
        }
        Ok(())
    }

    pub fn executor_arguments(&self) -> Value {
        match self {
            Self::FsRead {
                path,
                start_line,
                start_byte,
                max_lines,
                max_bytes,
            } => {
                let mut value = json!({ "path": path, "startLine": start_line, "maxLines": max_lines, "maxBytes": max_bytes });
                if let Some(start_byte) = start_byte {
                    value["startByte"] = json!(start_byte);
                }
                value
            }
            Self::FsWrite {
                path,
                content,
                executable,
            } => {
                let mut value = json!({ "path": path, "content": content });
                if let Some(executable) = executable {
                    value["executable"] = json!(executable);
                }
                value
            }
            Self::FsEdit { path, edits } => json!({
                "path": path,
                "edits": edits,
            }),
            Self::FsDelete(KernelDeleteTarget::File { path }) => json!({
                "path": path,
                "targetKind": "file",
            }),
            Self::FsDelete(KernelDeleteTarget::DirectoryTree { path }) => json!({
                "path": path,
                "targetKind": "directoryTree",
            }),
            Self::ProcessShell {
                command,
                request_host_permission,
                workspace_mode,
                execution_scope,
                timeout,
                terminal,
            }
            | Self::ProcessPowerShell {
                command,
                request_host_permission,
                workspace_mode,
                execution_scope,
                timeout,
                terminal,
            } => {
                let mut value = json!({
                    "command": command,
                    "workspaceMode": workspace_mode,
                    "executionScope": execution_scope,
                });
                if let Some(timeout) = timeout {
                    value["timeout"] = json!(timeout);
                }
                if let Some(terminal) = terminal {
                    value["terminal"] = json!(terminal);
                }
                if let Some(reason) = request_host_permission {
                    value["requestHostPermission"] = json!(reason);
                }
                value
            }
            Self::WebSearch { query, limit } => json!({ "query": query, "limit": limit }),
            Self::WebFetch { url, max_bytes } => json!({ "url": url, "maxBytes": max_bytes }),
        }
    }
}

fn validate_path(value: &str, allow_dot: bool) -> Result<(), ToolValidationError> {
    validate_text("path", value, false)?;
    if std::path::Path::new(value).is_absolute() {
        return Ok(());
    }
    if value.contains('\\')
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == ".." || (part == "." && value != "."))
        || (!allow_dot && value == ".")
    {
        return Err(invalid_value(
            "path",
            "must be a normalized workspace-relative path",
        ));
    }
    Ok(())
}

fn validate_text(
    field: &'static str,
    value: &str,
    allow_empty: bool,
) -> Result<(), ToolValidationError> {
    if (!allow_empty && value.trim().is_empty()) || value.contains('\0') {
        return Err(empty_field(field));
    }
    if value.len() > MAX_ORDINARY_STRING_BYTES {
        return Err(field_too_large(field, MAX_ORDINARY_STRING_BYTES));
    }
    Ok(())
}

fn validate_u32(
    field: &'static str,
    value: u32,
    minimum: u32,
    maximum: u32,
) -> Result<(), ToolValidationError> {
    if !(minimum..=maximum).contains(&value) {
        return Err(invalid_value(field, "is outside the supported range"));
    }
    Ok(())
}

fn url_has_user_info(url: &str) -> bool {
    let Some(rest) = url.split_once("://").map(|(_, rest)| rest) else {
        return true;
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}
