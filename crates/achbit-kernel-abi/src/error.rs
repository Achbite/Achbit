use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelErrorEnvelope {
    pub code: String,
    pub message: String,
    pub message_key: Option<String>,
    pub args: Option<Value>,
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("invalid command: {0}")]
    InvalidCommand(String),
    #[error("workspace binding is required")]
    MissingWorkspaceBinding,
    #[error("workspace access denied: {0}")]
    WorkspaceAccessDenied(String),
    #[error("workspace root unreadable: {0}")]
    WorkspaceRootUnreadable(String),
    #[error("attachment access denied: {0}")]
    AttachmentAccessDenied(String),
    #[error("pending permission is unavailable: {0}")]
    PendingPermissionUnavailable(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("{message}")]
    Structured {
        code: &'static str,
        stage: &'static str,
        message: String,
        details: Value,
    },
    #[error("kernel error: {0}")]
    Other(String),
}

pub type KernelResult<T> = Result<T, KernelError>;

impl From<&KernelError> for KernelErrorEnvelope {
    fn from(value: &KernelError) -> Self {
        let code = match value {
            KernelError::InvalidCommand(_) => "invalid_command",
            KernelError::MissingWorkspaceBinding => "workspace_binding_required",
            KernelError::WorkspaceAccessDenied(_) => "workspace_access_denied",
            KernelError::WorkspaceRootUnreadable(_) => "workspace_root_unreadable",
            KernelError::AttachmentAccessDenied(_) => "attachment_access_denied",
            KernelError::PendingPermissionUnavailable(_) => "pending_permission_unavailable",
            KernelError::PermissionDenied(_) => "permission_denied",
            KernelError::Structured { code, .. } => code,
            KernelError::Other(_) => "kernel_error",
        };
        let args = match value {
            KernelError::Structured { stage, details, .. } => Some(serde_json::json!({
                "stage": stage,
                "details": details,
            })),
            _ => None,
        };
        Self {
            code: code.to_string(),
            message: value.to_string(),
            message_key: None,
            args,
        }
    }
}
