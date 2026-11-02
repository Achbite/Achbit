use super::file_changes::{capture_side, change_fact, delete_tree};
use super::*;

pub(super) struct FsReadExecutor;
pub(super) struct FsWriteExecutor;
pub(super) struct FsEditExecutor;
pub(super) struct FsDeleteExecutor;

impl KernelToolExecutor for FsReadExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let KernelCanonicalInvocation::FsRead {
            path,
            start_line,
            start_byte,
            max_lines,
            max_bytes,
        } = invocation.input
        else {
            return Err(KernelError::InvalidCommand(
                "fs.read invocation required".into(),
            ));
        };
        let target = prepared_workspace_target(&context)?;
        let metadata = std::fs::metadata(&target).map_err(|error| KernelError::Structured {
            code: "fs_read_metadata_failed", stage: "metadata", message: format!("Cannot inspect {path}: {error}"),
            details: serde_json::json!({"path":path,"ioKind":format!("{:?}",error.kind()),"osCode":error.raw_os_error()}),
        })?;
        if metadata.is_dir() {
            if start_byte.is_some() {
                return Err(KernelError::InvalidCommand(
                    "Use startLine for a directory. startByte applies to files.".into(),
                ));
            }
            let mut output = read_directory_page(&target, start_line, max_lines, max_bytes)?;
            output["workspaceId"] = serde_json::json!(workspace_id(&context)?);
            output["path"] = serde_json::json!(normalize_relative_path(&path));
            return Ok(ok(invocation.id, output));
        }
        if !metadata.is_file() {
            return Err(KernelError::Structured {
                code: "fs_read_not_file",
                stage: "metadata",
                message: format!("{path} is not a regular file"),
                details: serde_json::json!({"path":path}),
            });
        }
        let mut output = achbit_kernel_tools::text_range::read_text_range(
            &target,
            u64::from(start_line),
            start_byte,
            max_lines as usize,
            max_bytes as usize,
        )
        .map_err(KernelError::InvalidCommand)?;
        output["workspaceId"] = serde_json::json!(workspace_id(&context)?);
        output["path"] = serde_json::json!(normalize_relative_path(&path));
        Ok(ok(invocation.id, output))
    }
}

fn read_directory_page(path: &Path, start: u32, limit: u32, max_bytes: u32) -> KernelResult<Value> {
    let io_error = |error: std::io::Error| KernelError::Structured {
        code: "fs_read_directory_failed",
        stage: "read",
        message: format!("Cannot list {}: {error}", path.display()),
        details: serde_json::json!({"ioKind": format!("{:?}", error.kind()), "osCode": error.raw_os_error()}),
    };
    let mut children = fs::read_dir(path)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    children.sort_by_cached_key(|entry| entry.file_name());
    let offset = (start - 1) as usize;
    let mut entries = Vec::new();
    let mut bytes = 2; // JSON array brackets
    for entry in children.iter().skip(offset).take(limit as usize) {
        let file_type = entry.file_type().map_err(io_error)?;
        let kind = if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else {
            "other"
        };
        let item = serde_json::json!({"name": entry.file_name().to_string_lossy(), "kind": kind});
        let size = item.to_string().len() + usize::from(!entries.is_empty());
        if bytes + size > max_bytes as usize {
            if entries.is_empty() {
                return Err(KernelError::InvalidCommand(
                    "Directory entry exceeds maxBytes. Increase maxBytes.".into(),
                ));
            }
            break;
        }
        bytes += size;
        entries.push(item);
    }
    let end = offset + entries.len();
    let truncated = end < children.len();
    let mut page = serde_json::json!({"kind":"directory","startLine":start,"entries":entries,"truncated":truncated});
    if truncated {
        page["nextStartLine"] = serde_json::json!(end + 1);
    }
    Ok(page)
}

impl KernelToolExecutor for FsWriteExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let KernelCanonicalInvocation::FsWrite {
            path,
            content,
            executable,
        } = invocation.input
        else {
            return Err(KernelError::InvalidCommand(
                "fs.write invocation required".into(),
            ));
        };
        let target = prepared_workspace_target(&context)?;
        let existed = target.exists();
        if existed && !target.is_file() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.write target exists and is not a file: {path}"
            )));
        }
        let parent = target.parent().ok_or_else(|| {
            KernelError::InvalidCommand(format!("fs.write target has no parent: {path}"))
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| KernelError::Other(format!("create fs.write parent: {error}")))?;
        let content_changed = !existed || !file_matches_content(&target, content.as_bytes())?;
        let before = capture_side(&target, &context, 0, "before");
        let attributes = if existed {
            atomic_write_text(&target, &content)?;
            executable.map_or(Ok(()), |value| set_executable_state(&target, value))
        } else {
            atomic_create_text(&target, &content, executable.unwrap_or(false))?;
            Ok(())
        };
        let after = capture_side(&target, &context, 0, "after");
        let changes = if content_changed {
            vec![change_fact(&context, &path, before, after)?]
        } else {
            Vec::new()
        };
        let mode = attributes.and_then(|()| file_mode(&target));
        Ok(finish_file_mutation(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": changes,
                "created": !existed,
                "saved": true,
                "sizeBytes": content.len()
            }),
            mode,
        ))
    }
}

impl KernelToolExecutor for FsEditExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let KernelCanonicalInvocation::FsEdit { path, edits } = invocation.input else {
            return Err(KernelError::InvalidCommand(
                "fs.edit invocation required".into(),
            ));
        };
        let target = prepared_workspace_target(&context)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
        }
        let original = read_text_file_for_llm(&target)
            .map_err(|skip| {
                KernelError::InvalidCommand(format!(
                    "unsupported_file_content: {} ({})",
                    skip.message, skip.reason
                ))
            })?
            .content;
        let patch = apply_exact_text_edits(&original, &edits)?;
        let before = capture_side(&target, &context, 0, "before");
        atomic_write_text(&target, &patch.updated)?;
        let after = capture_side(&target, &context, 0, "after");
        let changes = if original == patch.updated {
            Vec::new()
        } else {
            vec![change_fact(&context, &path, before, after)?]
        };
        let mode = file_mode(&target);
        Ok(finish_file_mutation(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": changes,
                "patched": true,
                "oldContentBytes": original.len(),
                "newContentBytes": patch.updated.len(),
                "changedRanges": patch.changed_ranges,
                "editPreview": patch.preview,
                "editCount": edits.len()
            }),
            mode,
        ))
    }
}

impl KernelToolExecutor for FsDeleteExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let KernelCanonicalInvocation::FsDelete(delete) = invocation.input else {
            return Err(KernelError::InvalidCommand(
                "fs.delete invocation required".into(),
            ));
        };
        let (path, target_kind) = match delete {
            KernelDeleteTarget::File { path } => (path, "file"),
            KernelDeleteTarget::DirectoryTree { path } => (path, "directoryTree"),
        };
        let target = prepared_workspace_target(&context)?;
        if target.is_dir() {
            if target_kind != "directoryTree" {
                return Err(KernelError::PermissionDenied(
                    "fs.delete directory target requires targetKind=directoryTree".to_string(),
                ));
            }
            let mut changes = Vec::new();
            let result = delete_tree(&target, &path, &context, &mut changes);
            let output = serde_json::json!({ "workspaceId": workspace_id(&context)?, "path": normalize_relative_path(&path),
                "deleted": result.is_ok(), "kind": "directoryTree", "fileChanges": changes });
            return Ok(match result {
                Ok(()) => ok(invocation.id, output),
                Err(error) => KernelToolExecutionResult {
                    invocation_id: invocation.id,
                    outcome: KernelToolExecutionOutcome::Failed,
                    output,
                    error: Some(KernelToolExecutionFailure {
                        code: "file_delete_failed".into(),
                        message: error.to_string(),
                    }),
                },
            });
        }
        if target_kind == "directoryTree" {
            return Err(KernelError::PermissionDenied(
                "fs.delete targetKind=directoryTree requires an existing directory target"
                    .to_string(),
            ));
        }
        let before = capture_side(&target, &context, 0, "before");
        fs::remove_file(&target)
            .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": [change_fact(&context, &path, before, serde_json::json!({ "exists": false }))?],
                "deleted": true,
                "kind": "file"
            }),
        ))
    }
}

fn file_matches_content(target: &Path, content: &[u8]) -> KernelResult<bool> {
    let mut file = fs::File::open(target).map_err(|error| KernelError::Other(error.to_string()))?;
    if file
        .metadata()
        .map_err(|error| KernelError::Other(error.to_string()))?
        .len()
        != content.len() as u64
    {
        return Ok(false);
    }
    let mut buffer = [0_u8; 8192];
    for part in content.chunks(buffer.len()) {
        file.read_exact(&mut buffer[..part.len()])
            .map_err(|error| KernelError::Other(error.to_string()))?;
        if &buffer[..part.len()] != part {
            return Ok(false);
        }
    }
    Ok(true)
}

// Once content has changed, preserve the change facts even if a later attribute
// operation fails. The failed outcome remains distinct from the saved content.
fn finish_file_mutation(
    invocation_id: String,
    mut output: Value,
    mode: KernelResult<Option<u32>>,
) -> KernelToolExecutionResult {
    match mode {
        Ok(mode) => {
            output["mode"] = serde_json::json!(mode);
            output["executable"] = serde_json::json!(mode.is_some_and(|value| value & 0o111 != 0));
            ok(invocation_id, output)
        }
        Err(error) => KernelToolExecutionResult {
            invocation_id,
            outcome: KernelToolExecutionOutcome::Failed,
            output,
            error: Some(KernelToolExecutionFailure {
                code: "file_attributes_failed".into(),
                message: error.to_string(),
            }),
        },
    }
}

fn set_executable_state(_target: &Path, executable: bool) -> KernelResult<()> {
    #[cfg(unix)]
    {
        let metadata = fs::metadata(_target)
            .map_err(|error| KernelError::Other(format!("inspect fs.write mode: {error}")))?;
        let current = metadata.permissions().mode();
        let mode = if executable {
            current | 0o111
        } else {
            current & !0o111
        };
        fs::set_permissions(_target, fs::Permissions::from_mode(mode))
            .map_err(|error| KernelError::Other(format!("set fs.write mode: {error}")))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if executable {
            Err(KernelError::Structured {
                code: "unsupported_file_attribute",
                stage: "tool.execute",
                message: "fs.write executable=true is not supported on this platform".to_string(),
                details: serde_json::json!({
                    "toolId": "fs.write",
                    "attribute": "executable",
                    "platform": std::env::consts::OS,
                }),
            })
        } else {
            Ok(())
        }
    }
}
