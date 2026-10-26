//! ZIP preparation is shared by inspection and managed installation.
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;

pub(super) fn unpack(source: &Path) -> Result<(tempfile::TempDir, PathBuf), String> {
    let temporary = tempfile::Builder::new()
        .prefix("achbit-plugin-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let root = temporary
        .path()
        .join(source.file_stem().ok_or("ZIP filename missing")?);
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(fs::File::open(source).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot read plugin ZIP: {e}"))?;
    let mut remaining = MAX_UNPACKED_BYTES;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let path = entry
            .enclosed_name()
            .ok_or("ZIP contains a path outside the plugin")?;
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || entry.name().contains('\\')
        {
            return Err("ZIP entries must use relative paths inside the plugin".into());
        }
        // Finder metadata is not part of an artifact.
        if path.starts_with("__MACOSX") || path.file_name().is_some_and(|name| name == ".DS_Store")
        {
            continue;
        }
        if entry.is_symlink() {
            return Err("Plugin ZIP must contain files and directories, not symlinks".into());
        }
        let destination = root.join(path);
        if entry.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            continue;
        }
        if entry.size() > remaining {
            return Err("Plugin ZIP exceeds the 512 MiB unpacked limit".into());
        }
        fs::create_dir_all(destination.parent().ok_or("ZIP entry parent missing")?)
            .map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| format!("{}: {e}", destination.display()))?;
        let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut output)
            .map_err(|e| e.to_string())?;
        remaining = remaining
            .checked_sub(copied)
            .ok_or("Plugin ZIP exceeds the 512 MiB unpacked limit")?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode & 0o777))
                .map_err(|e| e.to_string())?;
        }
    }
    let has_manifest = [
        "achbit-ui.json",
        "achbit-tool.json",
        "achbit-service.json",
        "SKILL.md",
    ]
    .iter()
    .any(|name| root.join(name).is_file());
    let plugin_root = if has_manifest {
        root
    } else {
        let entries = fs::read_dir(&root)
            .map_err(|e| e.to_string())?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        match entries.as_slice() {
            [directory] if directory.is_dir() => directory.clone(),
            _ => {
                return Err(
                    "ZIP must contain one plugin, at its root or in one enclosing directory".into(),
                )
            }
        }
    };
    Ok((temporary, plugin_root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_artifact::{copy_plugin, inspect_plugin, prepare_plugin};
    use std::io::Write;

    fn zip_file(path: &Path, files: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, content) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn zip_preview_and_install_keep_one_artifact_without_archive_dependency() {
        let fixture = tempfile::tempdir().unwrap();
        for wrapped in [false, true] {
            let path = fixture
                .path()
                .join(if wrapped { "wrapped.zip" } else { "flat.zip" });
            let prefix = if wrapped { "sample/" } else { "" };
            let manifest = format!("{prefix}achbit-service.json");
            let entry = format!("{prefix}entry.mjs");
            let private = format!("{prefix}auth.json");
            zip_file(
                &path,
                &[
                    (
                        &manifest,
                        r#"{"schema":"achbit.service-plugin.v1","id":"sample","name":"Sample","description":"ZIP fixture","entry":"entry.mjs","files":["entry.mjs"]}"#,
                    ),
                    (&entry, "export const version = 1;"),
                    (&private, "not an installed runtime file"),
                    ("__MACOSX/._sample", "Finder metadata"),
                ],
            );
            let preview = inspect_plugin(path.to_str().unwrap()).unwrap();
            assert_eq!(preview["manifestPath"], path.to_str().unwrap());
            assert_eq!(preview["path"], path.to_str().unwrap());
            let prepared = prepare_plugin(path.to_str().unwrap()).unwrap();
            let extracted = PathBuf::from(prepared.inspection["path"].as_str().unwrap());
            let installed = copy_plugin(
                &prepared.inspection,
                &fixture.path().join(if wrapped {
                    "installed-wrapped"
                } else {
                    "installed-flat"
                }),
            )
            .unwrap();
            drop(prepared);
            assert!(!extracted.exists());
            fs::remove_file(path).unwrap();
            let root = Path::new(installed["path"].as_str().unwrap());
            assert_eq!(
                fs::read_to_string(root.join("entry.mjs")).unwrap(),
                "export const version = 1;"
            );
            assert!(!root.join("auth.json").exists());
            assert_eq!(
                inspect_plugin(root.to_str().unwrap()).unwrap()["id"],
                "sample"
            );
        }
    }

    #[test]
    fn zip_rejects_ambiguous_or_escaping_contents() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("bad.zip");
        zip_file(&path, &[("../escape", "invalid")]);
        assert!(prepare_plugin(path.to_str().unwrap()).is_err());
        assert!(!fixture.path().join("escape").exists());
        zip_file(
            &path,
            &[
                ("first/SKILL.md", "# First"),
                ("second/SKILL.md", "# Second"),
            ],
        );
        assert!(prepare_plugin(path.to_str().unwrap())
            .err()
            .unwrap()
            .contains("one plugin"));
        zip_file(&path, &[("SKILL.md", "# First"), ("achbit-ui.json", "{}")]);
        assert!(prepare_plugin(path.to_str().unwrap()).is_err());
    }
}
