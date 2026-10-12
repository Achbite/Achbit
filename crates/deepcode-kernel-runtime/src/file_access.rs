use crate::executors::WorkspaceWriteTarget;
use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Resolved by Kernel admission; model requests are not execution grants.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAccessScope {
    #[serde(default)]
    pub network_access: bool,
    pub read: Vec<PathBuf>,
    pub write: Vec<WorkspaceWriteTarget>,
    pub read_only: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    /// Entries of `read` that only help programs start (PATH, toolchain homes,
    /// runtime roots). A platform that cannot grant one skips it instead of
    /// refusing the whole Shell; the skipped path is reported.
    #[serde(default)]
    pub best_effort_read: Vec<PathBuf>,
    /// Shared, writable tool cache for workspace Shells (npm, pip, cargo, ...).
    /// It is also one of `write`; this field only names it for the environment.
    #[serde(default)]
    pub cache: Option<PathBuf>,
}

impl FileAccessScope {
    pub fn workspace(root: &Path) -> KernelResult<Self> {
        let mut scope = Self {
            read: std::iter::once(root.to_path_buf())
                .chain(system_read_paths())
                .collect(),
            read_only: git_metadata(root)?,
            ..Self::default()
        };
        scope.read.extend(scope.read_only.clone());
        Ok(scope)
    }

    pub fn protects(&self, path: &Path) -> bool {
        self.read_only.iter().any(|root| path.starts_with(root))
    }

    /// Check that the admitted Kernel scope can be implemented with positive
    /// sandbox grants. This does not approve resources or inspect Shell scripts.
    pub(crate) fn validate_sandbox_write_roots<'a>(
        &self,
        writes: impl IntoIterator<Item = &'a Path>,
    ) -> KernelResult<()> {
        if self.read_only.is_empty() {
            return Ok(());
        }
        for path in writes {
            let path = resolve_path(path)?;
            for protected in &self.read_only {
                let protected = resolve_path(protected)?;
                let covers_protected = protected != path && protected.starts_with(&path);
                let unapproved_inside = path.starts_with(&protected)
                    && !self.write.iter().any(|grant| {
                        path == grant.path || (grant.directory && path.starts_with(&grant.path))
                    });
                if covers_protected || unapproved_inside {
                    return Err(KernelError::Structured {
                        code: "workspace_shell_write_scope_protected",
                        stage: "execution",
                        message: "The admitted write scope overlaps a protected path and cannot be enforced by the sandbox. Narrow the write scope to directories that do not contain protected subtrees.".into(),
                        details: serde_json::json!({"writePath": path, "protectedPath": protected}),
                    });
                }
            }
        }
        Ok(())
    }
}

/// The spelling of a canonical path handed to programs (environment, argv, cwd).
/// Windows canonical paths are verbatim (`\\?\C:\...`); shells and many tools
/// treat that as a UNC location, so pass the equivalent Win32 path instead.
/// Permission checks keep using the canonical path.
pub fn process_visible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(prefix)) = path.components().next() {
            let text = path.to_string_lossy();
            match prefix.kind() {
                Prefix::VerbatimDisk(_) => return PathBuf::from(&text[4..]),
                Prefix::VerbatimUNC(_, _) => return PathBuf::from(format!(r"\\{}", &text[8..])),
                _ => {}
            }
        }
    }
    path.to_path_buf()
}

pub fn resolve_path(path: &Path) -> KernelResult<PathBuf> {
    if !path.is_absolute() {
        return Err(KernelError::InvalidCommand(
            "File access requires an absolute path.".into(),
        ));
    }
    canonicalize_with_missing_tail(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            KernelError::InvalidCommand(format!("Cannot resolve {}", path.display()))
        } else {
            KernelError::Other(format!("Resolve {}: {error}", path.display()))
        }
    })
}

pub(crate) fn canonicalize_with_missing_tail(path: &Path) -> std::io::Result<PathBuf> {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut resolved) => {
                for part in tail.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(error);
                };
                tail.push(name.to_os_string());
                existing = parent;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn git_metadata(root: &Path) -> KernelResult<Vec<PathBuf>> {
    let entry = root.join(".git");
    if !entry.exists() {
        return Ok(Vec::new());
    }
    let mut paths = vec![entry.clone()];
    let git_dir = if entry.is_file() {
        let text = std::fs::read_to_string(&entry)
            .map_err(|error| KernelError::Other(format!("Read .git: {error}")))?;
        let path = text
            .trim()
            .strip_prefix("gitdir: ")
            .ok_or_else(|| KernelError::InvalidCommand("Invalid .git file.".into()))?;
        resolve_path(&root.join(path))?
    } else {
        entry
            .canonicalize()
            .map_err(|error| KernelError::Other(error.to_string()))?
    };
    paths.push(git_dir.clone());
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(path) => paths.push(resolve_path(&git_dir.join(path.trim()))?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(KernelError::Other(format!(
                "Read Git common directory: {error}"
            )))
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Platform files needed to start ordinary command-line tools, excluding user data.
pub fn system_read_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    return macos_system_read_paths();
    #[cfg(target_os = "linux")]
    let paths = [
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/alternatives",
        "/etc/ssl/certs",
        "/etc/ssl/openssl.cnf",
        "/etc/hosts",
        "/etc/resolv.conf",
        "/etc/services",
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
        "/etc/localtime",
    ];
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let paths: [&str; 0] = [];
    #[cfg(not(target_os = "macos"))]
    paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .collect()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_system_read_paths() -> Vec<PathBuf> {
    [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/Library/Developer",
        "/private/etc/passwd",
        "/private/etc/group",
        "/private/etc/gitconfig",
        "/private/etc/localtime",
        "/private/etc/ssl/cert.pem",
        "/private/etc/ssl/openssl.cnf",
        "/private/etc/hosts",
        "/private/etc/resolv.conf",
        "/private/etc/services",
        "/private/var/db/dyld",
        "/private/var/select",
        "/private/var/select/developer_dir",
        "/dev",
    ]
    .into_iter()
    .flat_map(|path| macos_path_spellings(Path::new(path)))
    // Missing system files are legitimate probes: return ENOENT rather than
    // rejecting the read before the tool can apply its normal missing-file logic.
    .collect()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_path_spellings(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    for (canonical, alias) in [
        ("/private/etc", "/etc"),
        ("/private/var", "/var"),
        ("/private/tmp", "/tmp"),
    ] {
        if let Ok(suffix) = path.strip_prefix(canonical) {
            paths.push(Path::new(alias).join(suffix));
        } else if let Ok(suffix) = path.strip_prefix(alias) {
            paths.push(Path::new(canonical).join(suffix));
        }
    }
    paths
}
