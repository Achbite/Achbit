use achbit_kernel_abi::{
    HostBrowseEntry, HostBrowseEntryKind, HostBrowseResult, KernelErrorEnvelope,
};
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) fn host_browse(path: Option<&str>) -> Result<HostBrowseResult, KernelErrorEnvelope> {
    let path = path
        .map(PathBuf::from)
        .or_else(host_home_dir)
        .ok_or_else(|| {
            host_error(
                "host_browse_path_required",
                "Host browse requires a path when no home directory is available",
            )
        })?;
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                host_error(
                    "host_browse_invalid_path",
                    format!(
                        "{} is not a directory and has no parent directory",
                        path.display()
                    ),
                )
            })?
    };
    let target = target.canonicalize().map_err(|error| {
        host_error(
            "host_browse_unavailable",
            format!("canonicalize {}: {error}", target.display()),
        )
    })?;
    let mut entries = fs::read_dir(&target)
        .map_err(|error| {
            host_error(
                "host_browse_unavailable",
                format!("browse {}: {error}", target.display()),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| host_error("host_browse_unavailable", error.to_string()))?;
    entries.sort_by(compare_dir_entries);
    let entries = entries
        .into_iter()
        .take(500)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            Some(HostBrowseEntry {
                hidden: name.starts_with('.'),
                name,
                absolute_path: path.to_string_lossy().to_string(),
                kind: if file_type.is_dir() {
                    HostBrowseEntryKind::Directory
                } else {
                    HostBrowseEntryKind::File
                },
                is_code_workspace: path.extension().and_then(OsStr::to_str)
                    == Some("code-workspace"),
            })
        })
        .collect();
    Ok(HostBrowseResult {
        absolute_path: target.to_string_lossy().to_string(),
        parent_path: target
            .parent()
            .map(|path| path.to_string_lossy().to_string()),
        entries,
    })
}

fn host_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

pub(crate) fn resolve_workspace_read_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, KernelErrorEnvelope> {
    let relative = relative.trim();
    let relative = if relative.is_empty() { "." } else { relative };
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(host_error(
            "host_inspection_path_outside_workspace",
            "Host inspection paths must be workspace-relative and cannot contain '..'",
        ));
    }
    let target = root.join(path).canonicalize().map_err(|error| {
        host_error(
            if error.kind() == std::io::ErrorKind::NotFound {
                "host_inspection_path_not_found"
            } else {
                "host_inspection_path_unavailable"
            },
            format!("canonicalize {}: {error}", root.join(path).display()),
        )
    })?;
    if !target.starts_with(root) {
        return Err(host_error(
            "host_inspection_path_outside_workspace",
            format!(
                "{} resolves outside workspace {}",
                target.display(),
                root.display()
            ),
        ));
    }
    Ok(target)
}

fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
    let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    match (left_is_dir, right_is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => left
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.file_name().to_string_lossy().to_ascii_lowercase()),
    }
}

fn host_error(code: impl Into<String>, message: impl Into<String>) -> KernelErrorEnvelope {
    KernelErrorEnvelope {
        code: code.into(),
        message: message.into(),
        message_key: None,
        args: None,
    }
}
