use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
};

fn is_directory(path: &Path) -> Result<bool, String> {
    if !path.is_absolute() {
        return Err("A local absolute path is required.".into());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    if metadata.is_dir() {
        Ok(true)
    } else if metadata.is_file() {
        Ok(false)
    } else {
        Err("The target is not a file or directory.".into())
    }
}

fn editor_program() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = objc2_app_kit::NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&objc2_foundation::NSString::from_str(
                "com.microsoft.VSCode",
            ))
            .ok_or("Visual Studio Code was not found by macOS.")?;
        let path = bundle
            .to_file_path()
            .ok_or("Visual Studio Code has no local application path.")?;
        Ok(path.join("Contents/Resources/app/bin/code"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(PathBuf::from(if cfg!(windows) {
        "code.cmd"
    } else {
        "code"
    }))
}

fn editor_arguments(
    path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<Vec<OsString>, String> {
    let directory = is_directory(path)?;
    if line == Some(0) || column == Some(0) || (column.is_some() && line.is_none()) {
        return Err("File positions must use a positive line and column.".into());
    }
    if directory && line.is_some() {
        return Err("A folder does not have a file position.".into());
    }
    #[cfg(windows)]
    let path = dunce::simplified(path);
    if let Some(line) = line {
        let mut position = path.as_os_str().to_owned();
        position.push(format!(":{line}:{}", column.unwrap_or(1)));
        Ok(vec!["--goto".into(), position])
    } else {
        Ok(vec![path.as_os_str().to_owned()])
    }
}

fn run_command(mut command: Command, application: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("{application}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    Err(format!("{application}: {} {error}", output.status)
        .trim_end()
        .to_owned())
}

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
    tauri::async_runtime::spawn_blocking(move || {
        let args = editor_arguments(Path::new(&path), line, column)?;
        let mut command = Command::new(editor_program()?);
        command.args(args);
        run_command(command, "Open in VS Code")
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
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let directory = is_directory(&path)?;
        locate(&path, directory)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
fn locate(path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("/usr/bin/open");
        if !directory {
            command.arg("-R");
        }
        command.arg(path);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let command = {
        let mut command = Command::new("xdg-open");
        command.arg(if directory {
            path
        } else {
            path.parent().ok_or("The file has no parent directory")?
        });
        command
    };
    run_command(command, "File manager")
}

#[cfg(windows)]
fn locate(path: &Path, directory: bool) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteExW, SEE_MASK_FLAG_NO_UI,
        SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let target = HSTRING::from(dunce::simplified(path).as_os_str());
    // The desktop's existing Explorer may handle the request. The Shell API
    // reports the handoff directly, independently of any Explorer process exit.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("File manager: {error}"))?;
        let result = if directory {
            let mut request = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                lpVerb: w!("open"),
                lpFile: PCWSTR(target.as_ptr()),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            ShellExecuteExW(&mut request)
        } else {
            let mut item = std::ptr::null_mut();
            SHParseDisplayName(&target, None, &mut item, 0, None).and_then(|()| {
                let result = SHOpenFolderAndSelectItems(item, None, 0);
                CoTaskMemFree(Some(item.cast()));
                result
            })
        };
        CoUninitialize();
        result.map_err(|error| format!("File manager: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_accepts_directories_and_applies_positions_only_to_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("含 空格 #.txt");
        std::fs::write(&file, "first\nsecond\n").unwrap();
        let folder = editor_arguments(root.path(), None, None).unwrap();
        assert_eq!(
            Path::new(folder.last().unwrap()).canonicalize().unwrap(),
            root.path().canonicalize().unwrap()
        );
        let args = editor_arguments(&file, Some(2), Some(1)).unwrap();
        let target = args.last().unwrap().to_string_lossy();
        assert!(target.ends_with("含 空格 #.txt:2:1"));
        assert!(editor_arguments(root.path(), Some(2), None).is_err());
        assert!(editor_arguments(&file, Some(0), None).is_err());
        assert!(editor_arguments(&file, None, Some(1)).is_err());
        assert!(editor_arguments(&root.path().join("missing"), None, None).is_err());
    }
}
