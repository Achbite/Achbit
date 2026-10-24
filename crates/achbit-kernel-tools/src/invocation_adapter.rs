use crate::invocation_types::{
    KernelCanonicalInvocation, KernelDeleteTarget, KernelExecutionScope, KernelTerminalInput,
    KernelToolKind, KernelWorkspaceMode,
};
use crate::types::{ToolInputIssue, ToolValidationError};
use serde::{de::value::MapDeserializer, Deserialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum InvocationNormalizationError {
    #[error("arguments for `{tool_id}` do not match the canonical input descriptor: {source}")]
    InvalidArguments {
        tool_id: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error(transparent)]
    Validation(#[from] ToolValidationError),
}

pub fn canonicalize_invocation(
    tool_id: KernelToolKind,
    arguments: &Value,
) -> Result<KernelCanonicalInvocation, InvocationNormalizationError> {
    let invalid = |source| InvocationNormalizationError::InvalidArguments {
        tool_id: tool_id.as_str(),
        source,
    };
    let mut invocation = if matches!(
        tool_id,
        KernelToolKind::ProcessShell | KernelToolKind::ProcessPowerShell
    ) {
        // Model input contains business arguments; Kernel fills execution authority later.
        let ShellInput {
            command,
            timeout,
            terminal,
            request_host_permission,
        } = ShellInput::deserialize(arguments).map_err(invalid)?;
        match tool_id {
            KernelToolKind::ProcessShell => KernelCanonicalInvocation::ProcessShell {
                command,
                timeout,
                terminal,
                request_host_permission,
                workspace_mode: KernelWorkspaceMode::Read,
                execution_scope: KernelExecutionScope::Workspace,
            },
            _ => KernelCanonicalInvocation::ProcessPowerShell {
                command,
                timeout,
                terminal,
                request_host_permission,
                workspace_mode: KernelWorkspaceMode::Read,
                execution_scope: KernelExecutionScope::Workspace,
            },
        }
    } else {
        let kind = Value::String(tool_id.as_str().into());
        let fields = [("toolId", &kind), ("arguments", arguments)];
        let deserializer = MapDeserializer::<_, serde_json::Error>::new(fields.into_iter());
        KernelCanonicalInvocation::deserialize(deserializer).map_err(invalid)?
    };
    normalize_invocation(&mut invocation)?;
    Ok(invocation)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellInput {
    command: String,
    timeout: Option<u32>,
    terminal: Option<KernelTerminalInput>,
    request_host_permission: Option<String>,
}

fn normalize_invocation(
    invocation: &mut KernelCanonicalInvocation,
) -> Result<(), InvocationNormalizationError> {
    match invocation {
        KernelCanonicalInvocation::FsRead { path, .. }
        | KernelCanonicalInvocation::FsWrite { path, .. }
        | KernelCanonicalInvocation::FsEdit { path, .. } => {
            *path = normalize_file_path(path)?;
        }
        KernelCanonicalInvocation::FsDelete(target) => {
            let path = match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    path
                }
            };
            *path = normalize_file_path(path)?;
        }
        _ => {}
    }
    invocation.validate()?;
    Ok(())
}

fn normalize_file_path(value: &str) -> Result<String, InvocationNormalizationError> {
    if std::path::Path::new(value).is_absolute() && !value.contains('\0') {
        return Ok(value.to_owned());
    }
    normalize_workspace_path(value, false)
}

pub fn normalize_workspace_path(
    value: &str,
    allow_dot: bool,
) -> Result<String, InvocationNormalizationError> {
    let invalid_path = || {
        ToolValidationError::InvalidValue {
        field: "path",
        reason: "must be a workspace-relative path without empty segments, parent traversal or NUL bytes",
    }.into()
    };
    if value.trim().is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err(invalid_path());
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == ".." {
            return Err(invalid_path());
        }
        if part != "." {
            parts.push(part.to_owned());
        }
    }
    let normalized = if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    };
    if normalized == "." && !allow_dot {
        return Err(invalid_path());
    }
    Ok(normalized)
}

impl InvocationNormalizationError {
    pub(crate) fn input_issues(&self, schema: &Value, input: &Value) -> Vec<ToolInputIssue> {
        // Keep all descriptor issues on a rejected input; serde reports only its first error.
        let mut issues = Vec::new();
        describe_input_issues(schema, input, "$", &mut issues);
        if issues.is_empty() {
            let (field, rule, expected) = match self {
                Self::Validation(ToolValidationError::EmptyField { field }) => {
                    (*field, "nonEmptyText", None)
                }
                Self::Validation(ToolValidationError::FieldTooLarge {
                    field,
                    maximum_bytes,
                }) => (*field, "maxBytes", Some(Value::from(*maximum_bytes))),
                Self::Validation(ToolValidationError::InvalidValue { field, .. }) => {
                    (*field, "canonicalInput", None)
                }
                Self::InvalidArguments { .. } => ("", "canonicalInput", None),
            };
            let path = match field {
                "" | "canonicalInvocation" => "$".to_string(),
                "edits.oldText" | "edits.newText" => "$.edits".to_string(),
                field => format!("$.{field}"),
            };
            issues.push(ToolInputIssue::new(path, rule, self.to_string(), expected));
        }
        issues
    }
}

fn describe_input_issues(
    schema: &Value,
    input: &Value,
    path: &str,
    issues: &mut Vec<ToolInputIssue>,
) {
    let matches_type = match schema["type"].as_str() {
        Some("object") => input.is_object(),
        Some("array") => input.is_array(),
        Some("string") => input.is_string(),
        Some("boolean") => input.is_boolean(),
        Some("integer") => input.is_i64() || input.is_u64(),
        _ => true,
    };
    if !matches_type {
        issues.push(ToolInputIssue::new(
            path,
            "type",
            "Use the declared input type.",
            Some(schema["type"].clone()),
        ));
        return;
    }
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(input) {
            issues.push(ToolInputIssue::new(
                path,
                "enum",
                "Choose one of the allowed values.",
                Some(schema["enum"].clone()),
            ));
        }
    }
    if let Some(fields) = input.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for name in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(name) {
                    issues.push(ToolInputIssue::new(
                        format!("{path}.{name}"),
                        "required",
                        "Supply this required field.",
                        schema["properties"].get(name).cloned(),
                    ));
                }
            }
        }
        for (name, value) in fields {
            let child_path = format!("{path}.{name}");
            if let Some(child_schema) = schema["properties"].get(name) {
                describe_input_issues(child_schema, value, &child_path, issues);
            } else if schema["additionalProperties"] == false {
                issues.push(ToolInputIssue::new(
                    child_path,
                    "additionalProperties",
                    "Remove this undeclared field.",
                    None,
                ));
            }
        }
    }
    if let Some(items) = input.as_array() {
        for (index, value) in items.iter().enumerate() {
            describe_input_issues(&schema["items"], value, &format!("{path}[{index}]"), issues);
        }
    }
    for (rule, measured, below) in [
        ("minimum", input.as_f64(), true),
        ("maximum", input.as_f64(), false),
        (
            "minLength",
            input.as_str().map(|v| v.chars().count() as f64),
            true,
        ),
        (
            "maxLength",
            input.as_str().map(|v| v.chars().count() as f64),
            false,
        ),
        ("minItems", input.as_array().map(|v| v.len() as f64), true),
        ("maxItems", input.as_array().map(|v| v.len() as f64), false),
    ] {
        if let (Some(limit), Some(measured)) = (schema[rule].as_f64(), measured) {
            if (below && measured < limit) || (!below && measured > limit) {
                issues.push(ToolInputIssue::new(
                    path,
                    rule,
                    "Use a value within the declared bound.",
                    Some(schema[rule].clone()),
                ));
            }
        }
    }
}
