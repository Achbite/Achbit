use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffectClass {
    Read,
    Mutation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffectScope {
    WorkspaceRead,
    WorkspaceWrite,
    NetworkRead,
    Process,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolAvailability {
    Callable,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub effect_class: ToolEffectClass,
    pub effect_scope: ToolEffectScope,
    pub availability: ToolAvailability,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ToolValidationError {
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("{field} exceeds {maximum_bytes} bytes")]
    FieldTooLarge {
        field: &'static str,
        maximum_bytes: usize,
    },
    #[error("{field} {reason}")]
    InvalidValue {
        field: &'static str,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputIssue {
    pub path: String,
    pub rule: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
}

impl ToolInputIssue {
    pub fn new(
        path: impl Into<String>,
        rule: impl Into<String>,
        message: impl Into<String>,
        expected: Option<Value>,
    ) -> Self {
        Self {
            path: path.into(),
            rule: rule.into(),
            message: message.into(),
            expected,
        }
    }
}
