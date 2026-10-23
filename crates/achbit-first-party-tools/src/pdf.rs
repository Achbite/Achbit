use crate::{input_object, limit_text, optional_u64, required_string, ToolError, ToolResult};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::path::Path;

const MAX_PDF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 50;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;

pub(crate) fn call(name: &str, input: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
    if name != "read" {
        return Err(ToolError::new(
            "tool_not_found",
            format!("PDF plugin does not provide {name}"),
        ));
    }
    read(input, metadata)
}

fn read(input: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
    let object = input_object(input, &["path", "startPage", "endPage"])?;
    let logical_path = required_string(object, "path")?;
    let requested_start = optional_u64(object, "startPage", 1, 1, u64::MAX)? as usize;
    let requested_end = match object.get("endPage") {
        None => None,
        Some(_) => Some(optional_u64(object, "endPage", 1, 1, u64::MAX)? as usize),
    };
    if requested_end.is_some_and(|end| end < requested_start) {
        return Err(ToolError::new(
            "tool_input_invalid",
            "endPage must be greater than or equal to startPage",
        ));
    }
    let binding = metadata
        .and_then(|value| value.get("deepcode"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ToolError::new(
                "workspace_binding_required",
                "PDF reads require a Kernel-prepared workspace binding",
            )
        })?;
    let workspace_id = binding
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("workspace_binding_invalid", "workspaceId is missing"))?;
    let resolved_targets = binding
        .get("resolvedWorkspaceTargets")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ToolError::new(
                "workspace_binding_invalid",
                "resolved workspace targets are missing",
            )
        })?;
    if resolved_targets.len() != 1 {
        return Err(ToolError::new(
            "workspace_binding_invalid",
            "PDF reads require exactly one resolved workspace target",
        ));
    }
    let target = resolved_targets[0]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("workspace_binding_invalid", "resolved target is invalid"))?;
    let target = Path::new(target);
    let metadata = std::fs::metadata(target)
        .map_err(|error| ToolError::new("pdf_read_failed", format!("read metadata: {error}")))?;
    if !metadata.is_file() {
        return Err(ToolError::new(
            "pdf_target_invalid",
            "PDF target is not a file",
        ));
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(ToolError::new(
            "pdf_target_too_large",
            format!("PDF exceeds {MAX_PDF_BYTES} bytes"),
        ));
    }
    let pages = pdf_extract::extract_text_by_pages(target)
        .map_err(|error| ToolError::new("pdf_extract_failed", error.to_string()))?;
    if pages.is_empty() {
        return Err(ToolError::new(
            "pdf_page_range_invalid",
            "PDF contains no readable pages",
        ));
    }
    if requested_start > pages.len() {
        return Err(ToolError::new(
            "pdf_page_range_invalid",
            format!(
                "startPage {requested_start} exceeds PDF page count {}",
                pages.len()
            ),
        ));
    }
    let start = requested_start - 1;
    let requested_end = requested_end.unwrap_or(pages.len());
    let available_end = requested_end.min(pages.len());
    let end = available_end.min(start.saturating_add(MAX_PDF_PAGES));
    let mut joined = String::new();
    for (index, content) in pages[start..end].iter().enumerate() {
        write!(joined, "\n--- page {} ---\n{}", start + index + 1, content)
            .expect("writing to String cannot fail");
    }
    let (text, truncated_output) = limit_text(&joined, MAX_OUTPUT_BYTES);
    Ok(json!({
        "workspaceId": workspace_id,
        "path": logical_path,
        "adapter": "pdf_extract",
        "startPage": start + 1,
        "endPage": end,
        "totalPages": pages.len(),
        "text": text,
        "truncatedPages": end < available_end,
        "hasMorePages": end < pages.len(),
        "truncatedOutput": truncated_output,
        "sizeBytes": metadata.len()
    }))
}
