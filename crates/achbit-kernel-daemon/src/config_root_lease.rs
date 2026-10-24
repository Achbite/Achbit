use rusqlite::{Connection, ErrorCode};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct ConfigRootLease {
    _connection: Connection,
    _path: PathBuf,
}

impl ConfigRootLease {
    pub(crate) fn acquire(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("open config-root lease {}: {error}", path.display()))?;
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(|error| format!("configure config-root lease {}: {error}", path.display()))?;
        connection
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;")
            .map_err(|error| match error.sqlite_error_code() {
                Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => format!(
                    "config_root_already_owned: another DeepCode daemon already owns {}",
                    path.display()
                ),
                _ => format!("acquire config-root lease {}: {error}", path.display()),
            })?;
        Ok(Self {
            _connection: connection,
            _path: path.to_path_buf(),
        })
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self._path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn config_root_has_one_live_owner_and_releases_on_drop() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-config-root-lease-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        let path = root.join("data/agent-runtime/root-owner.lock");
        let first = ConfigRootLease::acquire(&path).expect("first owner");
        assert_eq!(first.path(), path.as_path());

        let second = ConfigRootLease::acquire(&path).expect_err("second owner must fail");
        assert!(second.contains("config_root_already_owned"), "{second}");

        drop(first);
        let replacement = ConfigRootLease::acquire(&path).expect("replacement owner");
        drop(replacement);
        std::fs::remove_dir_all(&root).expect("remove owned temporary root");
    }
}
