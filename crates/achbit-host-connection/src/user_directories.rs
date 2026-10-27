use serde::Serialize;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Writable user locations, independent of the installed program/resources.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectories {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub temp_dir: PathBuf,
    pub log_dir: PathBuf,
    #[serde(skip)]
    isolation_root: Option<PathBuf>,
}

impl UserDirectories {
    pub fn resolve() -> io::Result<Self> {
        // A directly launched Debug executable must not discover the stable Host.
        // Explicit roots still select a particular isolated test instance.
        #[cfg(feature = "debug-control")]
        if std::env::var_os("ACHBIT_USER_ROOT").is_none() {
            let root = debug_root_for(std::env::consts::OS, |key| std::env::var_os(key))?;
            return Ok(Self::isolated(&root));
        }
        let mut directories = resolve_for(
            std::env::consts::OS,
            |key| std::env::var_os(key),
            &std::env::temp_dir(),
        )?;
        if let Some(root) = &directories.isolation_root {
            if root.is_relative() {
                directories = Self::isolated(&std::env::current_dir()?.join(root));
            }
        }
        directories.log_dir = std::path::absolute(&directories.log_dir)?;
        Ok(directories)
    }

    /// Explicit development/test isolation covers every writable purpose.
    pub fn isolated(root: &Path) -> Self {
        Self {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            temp_dir: root.join("tmp"),
            log_dir: root.join("logs"),
            isolation_root: Some(root.to_path_buf()),
        }
    }

    pub fn create(&self) -> io::Result<()> {
        for path in [
            &self.config_dir,
            &self.data_dir,
            &self.cache_dir,
            &self.temp_dir,
            &self.log_dir,
        ] {
            std::fs::create_dir_all(path)?;
        }
        Ok(())
    }

    /// Preserve an explicit relative override when the child changes its cwd.
    pub fn configure_child(&self, command: &mut Command) {
        if let Some(root) = &self.isolation_root {
            command.env("ACHBIT_USER_ROOT", root);
        }
        command.env("ACHBIT_LOG_DIR", &self.log_dir);
    }
}

#[cfg(feature = "debug-control")]
fn debug_root_for(platform: &str, env: impl Fn(&str) -> Option<OsString>) -> io::Result<PathBuf> {
    let (key, suffix) = match platform {
        "windows" => ("LOCALAPPDATA", "Achbit-Debug"),
        "macos" => ("HOME", "Library/Application Support/Achbit-Debug"),
        _ => ("HOME", ".achbit-debug"),
    };
    let base = env(key).filter(|value| !value.is_empty()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("{key} is required for Debug user directories"),
        )
    })?;
    Ok(PathBuf::from(base).join(suffix))
}

fn resolve_for(
    platform: &str,
    environment: impl Fn(&str) -> Option<OsString>,
    system_temporary: &Path,
) -> io::Result<UserDirectories> {
    let value = |key: &str| {
        environment(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let required = |key: &str| {
        value(key).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{key} is required to locate Achbit user directories"),
            )
        })
    };
    if let Some(root) = environment("ACHBIT_USER_ROOT") {
        if root.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "ACHBIT_USER_ROOT must not be empty",
            ));
        }
        return Ok(UserDirectories::isolated(Path::new(&root)));
    }
    let (config_dir, data_dir, cache_dir, log_dir) = match platform {
        "macos" => {
            let library = required("HOME")?.join("Library");
            let support = library.join("Application Support/Achbit");
            (
                support.join("config"),
                support.join("data"),
                library.join("Caches/Achbit"),
                library.join("Logs/Achbit"),
            )
        }
        "windows" => {
            let roaming = required("APPDATA")?.join("Achbit");
            let local = required("LOCALAPPDATA")?.join("Achbit");
            (
                roaming.join("config"),
                local.join("Data"),
                local.join("Cache"),
                local.join("Logs"),
            )
        }
        _ => {
            let xdg = |key: &str, suffix: &str| -> io::Result<PathBuf> {
                match value(key) {
                    Some(path) => Ok(path),
                    None => Ok(required("HOME")?.join(suffix)),
                }
            };
            (
                xdg("XDG_CONFIG_HOME", ".config")?.join("Achbit"),
                xdg("XDG_DATA_HOME", ".local/share")?.join("Achbit"),
                xdg("XDG_CACHE_HOME", ".cache")?.join("Achbit"),
                xdg("XDG_STATE_HOME", ".local/state")?.join("Achbit/log"),
            )
        }
    };
    Ok(UserDirectories {
        config_dir,
        data_dir,
        cache_dir,
        temp_dir: system_temporary.join("Achbit"),
        log_dir: value("ACHBIT_LOG_DIR").unwrap_or(log_dir),
        isolation_root: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "debug-control")]
    #[test]
    fn debug_windows_root_does_not_require_home_or_share_normal_data() {
        let local = PathBuf::from("C:/Users/example/AppData/Local");
        let root = debug_root_for("windows", |key| {
            (key == "LOCALAPPDATA").then(|| local.clone().into_os_string())
        })
        .unwrap();
        assert_eq!(root, local.join("Achbit-Debug"));
        assert_ne!(root, local.join("Achbit"));
        assert!(debug_root_for("windows", |_| None).is_err());
        assert!(debug_root_for("windows", |_| Some(OsString::new())).is_err());
    }

    #[test]
    fn platform_locations_separate_persistent_discardable_and_roaming_data() {
        let environment = |key: &str| match key {
            "HOME" => Some("/Users/example".into()),
            "APPDATA" => Some("C:/Users/example/AppData/Roaming".into()),
            "LOCALAPPDATA" => Some("C:/Users/example/AppData/Local".into()),
            "XDG_CONFIG_HOME" => Some("/xdg/config".into()),
            "XDG_DATA_HOME" => Some("/xdg/data".into()),
            "XDG_CACHE_HOME" => Some("/xdg/cache".into()),
            "XDG_STATE_HOME" => Some("/xdg/state".into()),
            _ => None,
        };
        let temp = Path::new("/system/temp");
        let mac = resolve_for("macos", environment, temp).unwrap();
        assert_eq!(
            mac.config_dir,
            Path::new("/Users/example/Library/Application Support/Achbit/config")
        );
        assert_eq!(
            mac.data_dir,
            Path::new("/Users/example/Library/Application Support/Achbit/data")
        );
        assert_eq!(
            mac.cache_dir,
            Path::new("/Users/example/Library/Caches/Achbit")
        );
        assert_eq!(mac.log_dir, Path::new("/Users/example/Library/Logs/Achbit"));
        assert_eq!(mac.temp_dir, temp.join("Achbit"));
        let win = resolve_for("windows", environment, temp).unwrap();
        assert_eq!(
            win.config_dir,
            Path::new("C:/Users/example/AppData/Roaming/Achbit/config")
        );
        assert_eq!(
            win.data_dir,
            Path::new("C:/Users/example/AppData/Local/Achbit/Data")
        );
        assert_eq!(
            win.cache_dir,
            Path::new("C:/Users/example/AppData/Local/Achbit/Cache")
        );
        assert_eq!(
            win.log_dir,
            Path::new("C:/Users/example/AppData/Local/Achbit/Logs")
        );
        assert_eq!(win.temp_dir, temp.join("Achbit"));
        let linux = resolve_for("linux", environment, temp).unwrap();
        assert_eq!(linux.config_dir, Path::new("/xdg/config/Achbit"));
        assert_eq!(linux.data_dir, Path::new("/xdg/data/Achbit"));
        assert_eq!(linux.cache_dir, Path::new("/xdg/cache/Achbit"));
        assert_eq!(linux.log_dir, Path::new("/xdg/state/Achbit/log"));
        assert_eq!(linux.temp_dir, temp.join("Achbit"));
        let default_linux = resolve_for(
            "linux",
            |key| (key == "HOME").then(|| "/home/user".into()),
            temp,
        )
        .unwrap();
        assert_eq!(
            default_linux.config_dir,
            Path::new("/home/user/.config/Achbit")
        );
        assert_eq!(
            default_linux.data_dir,
            Path::new("/home/user/.local/share/Achbit")
        );
        assert_eq!(
            default_linux.cache_dir,
            Path::new("/home/user/.cache/Achbit")
        );
        assert_eq!(
            default_linux.log_dir,
            Path::new("/home/user/.local/state/Achbit/log")
        );
    }

    #[test]
    fn explicit_root_isolates_all_purposes_without_platform_environment() {
        let temp = Path::new("/system/temp");
        let root = Path::new("/explicit/Achbit");
        for platform in ["macos", "windows", "linux"] {
            let directories = resolve_for(
                platform,
                |key| (key == "ACHBIT_USER_ROOT").then(|| root.into()),
                temp,
            )
            .unwrap();
            assert_eq!(directories, UserDirectories::isolated(root));
            let mut command = Command::new("unused-test-command");
            directories.configure_child(&mut command);
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "ACHBIT_USER_ROOT" && value == Some(root.as_os_str())));
        }
        assert_eq!(
            resolve_for("windows", |_| None, temp).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            resolve_for(
                "macos",
                |key| (key == "ACHBIT_USER_ROOT").then(Default::default),
                temp
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
