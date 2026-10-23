use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve overrides before a Host child changes its working directory.
pub fn configured_path(name: &str) -> io::Result<Option<PathBuf>> {
    std::env::var_os(name)
        .map(|value| resolve_override(name, value))
        .transpose()
}

fn resolve_override(name: &str, value: OsString) -> io::Result<PathBuf> {
    if value.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name} must not be empty"),
        ));
    }
    std::path::absolute(value)
}

/// Packaged resources are independent of the writable user data directory.
pub fn runtime_root(executable_dir: &Path) -> io::Result<PathBuf> {
    if let Some(path) = configured_path("DEEPCODE_RUNTIME_DIR")? {
        return Ok(path);
    }
    let root = if cfg!(target_os = "macos") && executable_dir.ends_with("Contents/MacOS") {
        executable_dir
            .parent()
            .expect("bundle Contents")
            .join("Resources")
    } else {
        executable_dir.to_path_buf()
    };
    std::path::absolute(root)
}

pub fn configure_runtime_child(command: &mut Command, resources: &Path) -> io::Result<()> {
    command.env("DEEPCODE_RUNTIME_DIR", resources);
    for name in ["DEEPCODE_NODE", "DEEPCODE_SESSION_BRIDGE"] {
        if let Some(path) = configured_path(name)? {
            command.env(name, path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_overrides_keep_the_parent_location_when_the_child_moves() {
        let path = resolve_override("DEEPCODE_RUNTIME_DIR", "bin/中文 runtime".into()).unwrap();
        let parent = std::env::current_dir().unwrap();
        assert_eq!(path, parent.join("bin/中文 runtime"));
        assert_eq!(parent.join("different-child-directory").join(&path), path);
        assert_eq!(
            resolve_override("DEEPCODE_CLIENT_DIST", OsString::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
