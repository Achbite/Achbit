//! Replacement of a complete, already signature-verified macOS App archive.
use flate2::read::GzDecoder;
use std::{fs, io, path::Path};
use tempfile::TempDir;

#[derive(Debug)]
pub(super) struct InstallFailure {
    pub message: String,
    pub can_restart: bool,
}

impl From<io::Error> for InstallFailure {
    fn from(error: io::Error) -> Self {
        Self {
            message: format!("Application update failed before replacement: {error}"),
            can_restart: true,
        }
    }
}

pub(super) fn install(target: &Path, bytes: &[u8]) -> Result<(), InstallFailure> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("App has no parent directory"))?;
    // Staging and backup must share the installed App's filesystem for rename.
    // This also checks the writable-installation contract before touching the App.
    let transaction = tempfile::Builder::new()
        .prefix(".achbit-update-")
        .tempdir_in(parent)?;
    let unpacked = transaction.path().join("unpacked");
    fs::create_dir(&unpacked)?;
    tar::Archive::new(GzDecoder::new(bytes)).unpack(&unpacked)?;
    let mut entries = fs::read_dir(&unpacked)?;
    let staged = entries
        .next()
        .transpose()?
        .ok_or_else(|| io::Error::other("Update archive is empty"))?
        .path();
    if entries.next().transpose()?.is_some()
        || staged
            .extension()
            .is_none_or(|extension| extension != "app")
        || !staged.join("Contents/Info.plist").is_file()
        || !staged.join("Contents/MacOS/Achbit").is_file()
    {
        return Err(io::Error::other("Update archive must contain one complete Achbit App").into());
    }
    replace_bundle(target, &staged, transaction)
}

fn replace_bundle(
    target: &Path,
    staged: &Path,
    transaction: TempDir,
) -> Result<(), InstallFailure> {
    let backup = transaction.path().join("previous.app");
    fs::rename(target, &backup)?;
    if let Err(error) = fs::rename(staged, target) {
        return Err(restore_previous(target, &backup, transaction, error));
    }
    // Only successful installation (or successful restoration below) may drop the backup.
    Ok(())
}

fn restore_previous(
    target: &Path,
    backup: &Path,
    transaction: TempDir,
    error: io::Error,
) -> InstallFailure {
    match fs::rename(backup, target) {
        Ok(()) => InstallFailure {
            message: format!("Application update failed: {error}. Previous application restored."),
            can_restart: true,
        },
        Err(recovery_error) => {
            // Do not let TempDir delete the only remaining copy of the previous App.
            let retained = transaction.keep();
            InstallFailure {
                message: format!(
                    "Application update failed: {error}; restoring the previous application also failed: {recovery_error}. Previous application retained at {}. Restore it to {} before restarting Achbit.",
                    retained.join("previous.app").display(), target.display(),
                ),
                can_restart: false,
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn app(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        fs::write(path.join("Contents/Info.plist"), b"test bundle").unwrap();
        let executable = path.join("Contents/MacOS/Achbit");
        fs::write(&executable, contents).unwrap();
        fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn installs_complete_archive_preserving_modes_links_and_user_files() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Renamed Achbit.app");
        app(&target, b"previous");
        fs::write(target.join("obsolete"), b"retired").unwrap();
        fs::write(root.path().join("user-data"), b"keep").unwrap();
        let payload = tempfile::tempdir().unwrap();
        let source = payload.path().join("Achbit.app");
        app(&source, b"updated");
        symlink("MacOS/Achbit", source.join("Contents/launcher")).unwrap();
        let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        archive.follow_symlinks(false);
        archive.append_dir_all("Achbit.app", source).unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();

        install(&target, &bytes).unwrap();

        let executable = target.join("Contents/MacOS/Achbit");
        assert_eq!(fs::read(&executable).unwrap(), b"updated");
        assert_eq!(
            fs::metadata(executable).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::read_link(target.join("Contents/launcher")).unwrap(),
            Path::new("MacOS/Achbit")
        );
        assert!(!target.join("obsolete").exists());
        assert_eq!(fs::read(root.path().join("user-data")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn invalid_archive_leaves_installed_application_untouched() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Achbit.app");
        app(&target, b"previous");
        let failure = install(&target, b"not a tar.gz archive").unwrap_err();
        assert!(failure.can_restart);
        assert_eq!(
            fs::read(target.join("Contents/MacOS/Achbit")).unwrap(),
            b"previous"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_restores_the_previous_application() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Achbit.app");
        app(&target, b"previous");
        let transaction = tempfile::tempdir_in(root.path()).unwrap();
        let missing = transaction.path().join("missing.app");
        let failure = replace_bundle(&target, &missing, transaction).unwrap_err();
        assert!(failure.can_restart);
        assert!(failure.message.contains("Previous application restored"));
        assert_eq!(
            fs::read(target.join("Contents/MacOS/Achbit")).unwrap(),
            b"previous"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_restoration_retains_backup_and_errors_and_disallows_restart() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Achbit.app");
        app(&target, b"previous");
        let transaction = tempfile::tempdir_in(root.path()).unwrap();
        let backup = transaction.path().join("previous.app");
        fs::rename(&target, &backup).unwrap();
        // A nonempty destination prevents restoration; it must not be overwritten.
        fs::create_dir(&target).unwrap();
        fs::write(target.join("occupied"), b"keep").unwrap();
        let failure = restore_previous(
            &target,
            &backup,
            transaction,
            io::Error::other("new App move failed"),
        );
        assert!(!failure.can_restart);
        assert!(failure.message.contains("new App move failed"));
        assert!(failure
            .message
            .contains("restoring the previous application also failed"));
        assert!(failure.message.contains(&backup.display().to_string()));
        assert_eq!(
            fs::read(backup.join("Contents/MacOS/Achbit")).unwrap(),
            b"previous"
        );
        assert_eq!(fs::read(target.join("occupied")).unwrap(), b"keep");
    }
}
