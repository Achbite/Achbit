//! Physical read adapter for an explicitly selected local file. It does not
//! attach a workspace or add anything to the conversation/model context.
use std::path::{Path, PathBuf};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectedFileFormat {
    Path,
}

fn canonical_file(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("file_read_path_invalid: absolute path required".into());
    }
    let target = path
        .canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if !target
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("file_read_not_regular: select a file".into());
    }
    Ok(target)
}

#[tauri::command]
pub async fn achbit_read_local_file(
    webview: tauri::Webview,
    path: String,
    format: Option<SelectedFileFormat>,
) -> Result<tauri::ipc::Response, String> {
    if webview.label() != "main" {
        return Err("Local file reading belongs to the primary application view.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        match format {
            Some(SelectedFileFormat::Path) => {
                let target = canonical_file(path)?;
                let json = serde_json::to_string(&target).map_err(|error| error.to_string())?;
                Ok(tauri::ipc::Response::new(json))
            }
            None => {
                achbit_host_connection::selected_file::read(path).map(tauri::ipc::Response::new)
            }
        }
    })
    .await
    .map_err(|error| format!("file_reader_failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_file_identity_resolves_to_the_same_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("笔记 #.md");
        std::fs::write(&file, b"").unwrap();
        let target = canonical_file(&file).unwrap();
        assert_eq!(
            canonical_file(&root.path().join(".").join("笔记 #.md")).unwrap(),
            target
        );
        #[cfg(unix)]
        {
            let alias = root.path().join("alias.md");
            std::os::unix::fs::symlink(&file, &alias).unwrap();
            assert_eq!(canonical_file(&alias).unwrap(), target);
        }
        assert!(canonical_file(root.path()).is_err());
        assert!(canonical_file(&root.path().join("missing")).is_err());
        assert!(canonical_file(Path::new("relative")).is_err());
    }
}
