use crate::file_access::canonicalize_with_missing_tail;
use achbit_kernel_abi::{KernelError, KernelResult};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone)]
pub struct WorkspaceBoundary {
    root: PathBuf,
}

impl WorkspaceBoundary {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn resolve_read(&self, relative_path: &str) -> KernelResult<PathBuf> {
        let target = self.lexical_target(relative_path)?;
        let canonical_root = self.canonical_root()?;
        let canonical_target = canonicalize_with_missing_tail(&target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                KernelError::InvalidCommand(format!(
                    "workspace target {} is unavailable: {error}",
                    target.display()
                ))
            } else {
                KernelError::Other(format!(
                    "resolve workspace target {}: {error}",
                    target.display()
                ))
            }
        })?;
        ensure_within_root(&canonical_root, &canonical_target, relative_path)?;
        Ok(canonical_target)
    }

    pub fn resolve_mutation(&self, relative_path: &str) -> KernelResult<PathBuf> {
        let target = self.lexical_target(relative_path)?;
        let canonical_root = self.canonical_root()?;
        let relative = target.strip_prefix(&self.root).map_err(|_| {
            KernelError::PermissionDenied(format!(
                "workspace mutation target escaped the workspace root: {relative_path}"
            ))
        })?;
        if !relative
            .components()
            .any(|component| matches!(component, Component::Normal(_)))
        {
            return Err(KernelError::PermissionDenied(
                "workspace root cannot be used as a mutation target".to_string(),
            ));
        }
        let mut current = canonical_root.clone();
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                continue;
            };
            current.push(segment);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(KernelError::PermissionDenied(format!(
                        "workspace mutation cannot traverse a symbolic link: {relative_path}"
                    )));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => {
                    return Err(KernelError::Other(format!(
                        "inspect workspace mutation target {relative_path}: {error}"
                    )));
                }
            }
        }
        ensure_within_root(&canonical_root, &current, relative_path)?;
        Ok(canonical_root.join(relative))
    }

    fn lexical_target(&self, relative_path: &str) -> KernelResult<PathBuf> {
        if relative_path.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "workspace path is required".to_string(),
            ));
        }
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
            || looks_like_windows_drive_path(relative_path)
        {
            return Err(KernelError::PermissionDenied(format!(
                "workspace syscall requires a workspace-relative path: {relative_path}"
            )));
        }
        Ok(self.root.join(relative))
    }

    fn canonical_root(&self) -> KernelResult<PathBuf> {
        self.root.canonicalize().map_err(|error| {
            KernelError::InvalidCommand(format!(
                "workspace root {} is unavailable: {error}",
                self.root.display()
            ))
        })
    }
}

fn ensure_within_root(root: &Path, target: &Path, relative_path: &str) -> KernelResult<()> {
    if target.starts_with(root) {
        return Ok(());
    }
    Err(KernelError::PermissionDenied(format!(
        "workspace syscall target resolves outside the workspace root: {relative_path}"
    )))
}

fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
        && (bytes[0] as char).is_ascii_alphabetic()
}
