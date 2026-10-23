use super::*;

/// These copies belong to the tool attempt's Session output directory. Later
/// workspace edits cannot change the evidence for this invocation.
pub fn capture_side(
    target: &Path,
    context: &KernelToolExecutionContext,
    index: usize,
    side: &str,
) -> Value {
    if !target.exists() {
        return serde_json::json!({ "exists": false });
    }
    let Some(directory) = context.output_directory.as_ref() else {
        return serde_json::json!({ "exists": true, "error": "file_change_storage_unavailable" });
    };
    let destination = directory.join(format!("change-{index}-{side}"));
    match fs::create_dir_all(directory).and_then(|_| fs::copy(target, &destination)) {
        Ok(bytes) => {
            serde_json::json!({ "exists": true, "contentRef": destination, "sizeBytes": bytes })
        }
        Err(error) => serde_json::json!({ "exists": true, "error": error.to_string() }),
    }
}

pub fn change_fact(
    context: &KernelToolExecutionContext,
    path: &str,
    before: Value,
    after: Value,
) -> KernelResult<Value> {
    let kind = if before["exists"] == false {
        "create"
    } else if after["exists"] == false {
        "delete"
    } else {
        "modify"
    };
    Ok(
        serde_json::json!({ "workspaceId": workspace_id(context)?, "path": normalize_relative_path(path),
        "kind": kind, "before": before, "after": after }),
    )
}

pub(super) fn delete_tree(
    target: &Path,
    logical: &str,
    context: &KernelToolExecutionContext,
    changes: &mut Vec<Value>,
) -> KernelResult<()> {
    let mut entries = fs::read_dir(target)
        .map_err(|error| KernelError::Other(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(error.to_string()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let logical = format!("{logical}/{}", entry.file_name().to_string_lossy());
        let kind = entry
            .file_type()
            .map_err(|error| KernelError::Other(error.to_string()))?;
        if kind.is_dir() {
            delete_tree(&path, &logical, context, changes)?;
        } else {
            let before = if kind.is_symlink() {
                serde_json::json!({ "exists": true, "error": "symbolic_link_has_no_text_diff" })
            } else {
                capture_side(&path, context, changes.len(), "before")
            };
            fs::remove_file(&path).map_err(|error| KernelError::Other(error.to_string()))?;
            changes.push(change_fact(
                context,
                &logical,
                before,
                serde_json::json!({ "exists": false }),
            )?);
        }
    }
    fs::remove_dir(target).map_err(|error| KernelError::Other(error.to_string()))
}
