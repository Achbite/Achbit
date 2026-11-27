//! Desktop-only selection adapter shared by the Editor and conversation shells.
//! A mixed selection returns the actual path kind; it does not read file contents.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(all(windows, feature = "debug-control"))]
mod debug_windows;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(all(windows, feature = "debug-control"))]
pub use debug_windows::{capture as debug_capture, command as debug_command};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOptions {
    #[serde(default)]
    // Only macOS uses this to select a mode; Linux/Windows keep the mixed picker.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    kind: Option<String>,
    title: String,
    select_label: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    cancel_label: String,
    default_path: Option<String>,
    #[serde(default)]
    filters: Vec<PathFilter>,
    #[serde(default)]
    multiple: bool,
}

#[cfg(all(feature = "debug-control", target_os = "macos"))]
pub use macos::debug_accessibility_command;
#[cfg(all(feature = "debug-control", target_os = "macos"))]
pub use macos::debug_capture;
#[cfg(all(feature = "debug-control", target_os = "macos"))]
pub use macos::debug_command;

#[derive(Deserialize)]
pub struct PathFilter {
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    name: String,
    extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSelection {
    path: String,
    kind: &'static str,
}

fn describe_selection(path: PathBuf) -> Result<PathSelection, String> {
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        return Err("native_path_selection_not_file_or_directory".into());
    };
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "native_path_selection_not_unicode")?;
    Ok(PathSelection { path, kind })
}

fn describe_paths(paths: Vec<PathBuf>) -> Result<Vec<PathSelection>, String> {
    let selections = paths
        .into_iter()
        .map(describe_selection)
        .collect::<Result<Vec<_>, _>>()?;
    if selections.is_empty() {
        return Err("native_dialog_selected_path_missing".into());
    }
    Ok(selections)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_dialog_returns_multiple_directory_references_in_selection_order() {
        let temp = tempfile::tempdir().unwrap();
        let paths = [temp.path().join("source.v2"), temp.path().join("资料 甲")];
        for path in &paths {
            std::fs::create_dir(path).unwrap();
        }
        let selected = describe_paths(paths.to_vec()).unwrap();
        assert_eq!(selected.len(), 2);
        for (item, path) in selected.iter().zip(&paths) {
            assert_eq!(item.kind, "directory");
            assert_eq!(std::path::Path::new(&item.path), path);
        }
    }
}

#[tauri::command]
pub async fn achbit_pick_path(
    window: tauri::Window,
    options: PathOptions,
) -> Result<Option<Vec<PathSelection>>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            #[cfg(windows)]
            let result = windows::pick(&parent, &options);
            #[cfg(target_os = "macos")]
            let result = macos::pick(&parent, &options);
            #[cfg(target_os = "linux")]
            let result = linux::pick(&parent, &options);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|error| error.to_string())??
            .map(describe_paths)
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}
