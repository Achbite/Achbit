//! Platform implementations of the existing workspace Shell policy.
#[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
use deepcode_kernel_abi::KernelError;
#[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(windows)]
pub mod windows;
#[cfg(any(windows, test))]
mod windows_policy;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub backend: String,
    pub available: bool,
    pub reason: Option<String>,
}

impl SandboxStatus {
    pub(crate) fn observed(backend: &str, result: Result<(), String>) -> Self {
        Self {
            backend: backend.into(),
            available: result.is_ok(),
            reason: result.err(),
        }
    }
}

static PROBED: std::sync::Mutex<Option<(u64, SandboxStatus)>> = std::sync::Mutex::new(None);

/// The support check starts a real sandboxed process. Settings reads and new runs
/// reuse its result until the environment revision changes or setup runs again.
pub fn probe_for_revision(revision: u64) -> SandboxStatus {
    let mut probed = PROBED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached, status)) = probed.as_ref() {
        if *cached == revision {
            return status.clone();
        }
    }
    let status = probe();
    *probed = Some((revision, status.clone()));
    status
}

/// Forget the cached support check, e.g. after an explicit setup request.
pub fn invalidate_probe() {
    *PROBED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// Capture at an environment boundary, never per LLM/tool round.
pub fn probe() -> SandboxStatus {
    #[cfg(target_os = "linux")]
    {
        linux::probe()
    }
    #[cfg(windows)]
    {
        windows::probe()
    }
    #[cfg(target_os = "macos")]
    {
        SandboxStatus::observed(
            "sandbox-exec",
            if Path::new("/usr/bin/sandbox-exec").is_file() {
                Ok(())
            } else {
                Err("sandbox-exec is unavailable.".into())
            },
        )
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        SandboxStatus::observed(
            "unavailable",
            Err("Workspace Shell is not implemented on this platform.".into()),
        )
    }
}

#[cfg(any(target_os = "linux", windows))]
pub(crate) fn unavailable(tool: &str, message: impl Into<String>) -> KernelError {
    KernelError::Structured {
        code: if tool == "powershell" {
            "powershell_workspace_sandbox_unavailable"
        } else {
            "bash_workspace_sandbox_unavailable"
        },
        stage: "execution",
        message: message.into(),
        details: serde_json::json!({"toolId": tool}),
    }
}

/// All backends use positive write grants. A writable ancestor cannot exclude a
/// protected subtree on every platform; require a narrower scope before launch.
/// Explicit resource grants within a protected tree remain scoped exceptions.
#[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
pub(crate) fn validate_write_scope(
    root: &Path,
    mode: &str,
    targets: Option<&[crate::executors::WorkspaceWriteTarget]>,
    temporary: &Path,
    files: &crate::file_access::FileAccessScope,
) -> KernelResult<()> {
    let mut writes = vec![temporary];
    if mode == "write" {
        match targets {
            Some(targets) => writes.extend(targets.iter().map(|target| target.path.as_path())),
            None => writes.push(root),
        }
    }
    writes.extend(files.write.iter().map(|target| target.path.as_path()));
    writes.extend(files.home.as_deref());
    files.validate_sandbox_write_roots(writes)
}

/// Directory grants may create the authorized output directory. File grants do
/// not implicitly authorize creating or renaming entries in their parent.
#[cfg(any(target_os = "linux", windows, test))]
pub(crate) fn writable_paths(
    root: &Path,
    mode: &str,
    targets: Option<&[crate::executors::WorkspaceWriteTarget]>,
) -> KernelResult<Vec<PathBuf>> {
    if mode == "read" {
        return Ok(Vec::new());
    }
    let Some(targets) = targets else {
        return Ok(vec![root.to_path_buf()]);
    };
    targets.iter().map(|target| {
        if target.directory {
            std::fs::create_dir_all(&target.path).map_err(|error| KernelError::Other(format!("Create authorized Shell output directory: {error}")))?;
        } else if !target.path.is_file() {
            return Err(KernelError::Structured {
                code: "workspace_shell_write_target_unavailable", stage: "execution",
                message: "A file-level Shell grant requires an existing file. Use fs.write to create the file, or request its output directory for a generator/build command.".into(),
                details: serde_json::json!({"path": target.path}),
            });
        }
        target.path.canonicalize().map_err(|error| KernelError::Other(format!("Resolve Shell write target: {error}")))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executors::WorkspaceWriteTarget, file_access::FileAccessScope};

    #[test]
    fn every_sandbox_write_source_must_preserve_the_kernel_protected_scope() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("deepcode-scope-policy");
        let protected = root.join("workspace/.git");
        let workspace = root.join("workspace");
        let scratch = root.join("scratch");
        let files = FileAccessScope {
            read_only: vec![protected],
            ..Default::default()
        };
        let broad = WorkspaceWriteTarget {
            path: workspace.clone(),
            directory: true,
        };
        let verify = |files: &FileAccessScope,
                      mode,
                      targets: Option<&[WorkspaceWriteTarget]>,
                      temp: &Path| {
            let error = validate_write_scope(&workspace, mode, targets, temp, files).unwrap_err();
            assert!(matches!(
                error,
                KernelError::Structured {
                    code: "workspace_shell_write_scope_protected",
                    ..
                }
            ));
        };
        verify(&files, "write", None, &scratch);
        verify(
            &files,
            "write",
            Some(std::slice::from_ref(&broad)),
            &scratch,
        );
        let mut resource = files.clone();
        resource.write.push(broad);
        verify(&resource, "read", None, &scratch);
        let mut home = files.clone();
        home.home = Some(workspace.clone());
        verify(&home, "read", None, &scratch);
        verify(&files, "read", None, &workspace);
        let output = [WorkspaceWriteTarget {
            path: workspace.join("output"),
            directory: true,
        }];
        validate_write_scope(&workspace, "write", Some(&output), &scratch, &files).unwrap();
    }
}
