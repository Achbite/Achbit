use std::{path::PathBuf, process::Command};

#[tauri::command]
pub async fn achbit_open_file(
    webview: tauri::Webview,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("File opening belongs to the primary application view.".into());
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err("The selected file does not exist.".into());
    }
    if line == Some(0) || column == Some(0) || (column.is_some() && line.is_none()) {
        return Err("File positions must use a positive line and column.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let file = tauri::Url::from_file_path(&path).map_err(|_| "Invalid file path")?;
            let suffix = line
                .map(|line| format!(":{line}:{}", column.unwrap_or(1)))
                .unwrap_or_default();
            let mut command = Command::new("/usr/bin/open");
            command.args([
                "-a",
                "Visual Studio Code",
                &format!("vscode://file{}{suffix}", file.path()),
            ]);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = {
            let mut command = Command::new(if cfg!(windows) { "code.cmd" } else { "code" });
            if let Some(line) = line {
                command.arg("--goto").arg(format!(
                    "{}:{line}:{}",
                    path.display(),
                    column.unwrap_or(1)
                ));
            } else {
                command.arg(path);
            }
            command
        };
        let output = command
            .output()
            .map_err(|error| format!("Open in VS Code: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Open in VS Code: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A user navigation action. This does not grant workspace access to the Agent.
#[tauri::command]
pub async fn achbit_locate_path(webview: tauri::Webview, path: String) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("File navigation belongs to the primary application view.".into());
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("A local absolute path is required.".into());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Cannot locate {}: {error}", path.display()))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("The target is not a file or directory.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/usr/bin/open");
            if metadata.is_file() {
                command.arg("-R");
            }
            command.arg(path);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("explorer.exe");
            if metadata.is_file() {
                command.arg(format!("/select,{}", path.display()));
            } else {
                command.arg(path);
            }
            command
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let mut command = {
            let mut command = Command::new("xdg-open");
            command.arg(if metadata.is_dir() {
                path.as_path()
            } else {
                path.parent().ok_or("The file has no parent directory")?
            });
            command
        };
        let output = command
            .output()
            .map_err(|error| format!("File manager: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "File manager: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
