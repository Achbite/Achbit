//! A dedicated classic console: Windows Terminal intentionally ignores the
//! console font API. Ordinary terminals remain owned by their user.
use serde_json::Value;
use std::{
    ffi::OsStr,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::PathBuf,
    process::ExitStatus,
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    Graphics::Gdi::{AddFontResourceExW, RemoveFontResourceExW},
    System::{Console::*, Threading::*},
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{SendNotifyMessageW, HWND_BROADCAST, WM_FONTCHANGE},
    },
};

const WINDOW_ENV: &str = "DEEPCODE_TUI_OWNED_CONSOLE";
static LOADED_FONTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

pub fn is_owned() -> bool {
    if std::env::var_os(WINDOW_ENV).is_none() {
        return false;
    }
    let mut processes = [0u32; 2];
    // An inherited marker alone must not authorize changing another console.
    unsafe {
        !GetConsoleWindow().is_null()
            && GetConsoleProcessList(processes.as_mut_ptr(), 2) == 1
            && processes[0] == std::process::id()
    }
}

pub fn launch(arguments: &[String]) -> io::Result<ExitStatus> {
    let system = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::other("SystemRoot is unavailable"))?;
    let host = PathBuf::from(system).join("System32/conhost.exe");
    let executable = std::env::current_exe()?;
    let mut command_line = Vec::new();
    for argument in [host.as_os_str(), OsStr::new("--"), executable.as_os_str()]
        .into_iter()
        .chain(arguments.iter().map(OsStr::new))
    {
        if !command_line.is_empty() {
            command_line.push(b' ' as u16);
        }
        command_line.extend(quoted_argument(argument)?);
    }
    command_line.push(0);
    let mut entries: Vec<_> = std::env::vars_os()
        .filter(|(name, _)| {
            !name.eq_ignore_ascii_case(OsStr::new(WINDOW_ENV))
                && !name.eq_ignore_ascii_case(OsStr::new("DEEPCODE_TUI_READY_FILE"))
        })
        .chain([(WINDOW_ENV.into(), "1".into())])
        .collect();
    entries.sort_by_key(|(name, _)| name.to_ascii_uppercase());
    let mut environment = Vec::new();
    for (name, value) in entries {
        environment.extend(name.encode_wide());
        environment.push(b'=' as u16);
        environment.extend(value.encode_wide());
        environment.push(0);
    }
    environment.push(0);
    // conhost treats inherited standard handles as ConPTY streams. Start its
    // GUI entrypoint with no handles so it creates a real, independent console.
    unsafe {
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..std::mem::zeroed()
        };
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessW(
            wide(host.as_os_str()).as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            std::ptr::null(),
            &startup,
            &mut process,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process_handle = OwnedHandle::from_raw_handle(process.hProcess);
        drop(OwnedHandle::from_raw_handle(process.hThread));
        if WaitForSingleObject(process_handle.as_raw_handle(), INFINITE) == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0;
        if GetExitCodeProcess(process_handle.as_raw_handle(), &mut code) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }
}

fn quoted_argument(argument: &OsStr) -> io::Result<Vec<u16>> {
    let mut quoted = vec![b'"' as u16];
    let mut slashes = 0;
    for character in argument.encode_wide() {
        if character == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Console argument contains NUL",
            ));
        }
        if character == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            b'\\' as u16,
            if character == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        quoted.push(character);
        slashes = 0;
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    quoted.push(b'"' as u16);
    Ok(quoted)
}

pub fn apply(font: &Value) -> Result<(), String> {
    if !is_owned() {
        return Err("Font changes require the dedicated Achbit console.".into());
    }
    // Legacy CJK code pages can force a system font even when SetCurrentConsoleFontEx
    // succeeds. Only our own UTF-8 console changes its output code page.
    if unsafe { SetConsoleOutputCP(65001) } == 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let name = font["name"].as_str().ok_or("Missing console font name")?;
    let face: Vec<u16> = name.encode_utf16().collect();
    if face.is_empty() || face.len() >= 32 || face.contains(&0) {
        return Err("Windows console font names must fit in 31 UTF-16 units.".into());
    }
    let size = font["size"]
        .as_i64()
        .filter(|size| (10..=18).contains(size))
        .ok_or("Invalid console font size")?;
    if let Some(path) = font["file"].as_str() {
        let path = PathBuf::from(path);
        let mut fonts = LOADED_FONTS
            .lock()
            .map_err(|_| "Console font state unavailable")?;
        if !fonts.contains(&path) {
            if unsafe { AddFontResourceExW(wide(path.as_os_str()).as_ptr(), 0, std::ptr::null()) }
                == 0
            {
                return Err(format!(
                    "Cannot load console font {}: {}",
                    path.display(),
                    io::Error::last_os_error()
                ));
            }
            fonts.push(path);
            unsafe {
                SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
            }
        }
    }
    unsafe {
        let output = GetStdHandle(STD_OUTPUT_HANDLE);
        if output.is_null() || output == INVALID_HANDLE_VALUE {
            return Err("Console output is unavailable".into());
        }
        let mut previous = CONSOLE_FONT_INFOEX {
            cbSize: std::mem::size_of::<CONSOLE_FONT_INFOEX>() as u32,
            ..std::mem::zeroed()
        };
        if GetCurrentConsoleFontEx(output, 0, &mut previous) == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let mut next = previous;
        next.FaceName.fill(0);
        next.FaceName[..face.len()].copy_from_slice(&face);
        next.FontFamily = 0x36; // FF_MODERN | TMPF_TRUETYPE | TMPF_VECTOR
        next.FontWeight = 400;
        let dpi = GetDpiForWindow(GetConsoleWindow()).max(96);
        next.dwFontSize = COORD {
            X: 0,
            Y: ((size * i64::from(dpi) + 48) / 96) as i16,
        };
        if SetCurrentConsoleFontEx(output, 0, &next) == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let mut actual = previous;
        if GetCurrentConsoleFontEx(output, 0, &mut actual) == 0 {
            let error = io::Error::last_os_error();
            SetCurrentConsoleFontEx(output, 0, &previous);
            return Err(error.to_string());
        }
        let actual_name = String::from_utf16_lossy(
            &actual.FaceName[..actual.FaceName.iter().position(|c| *c == 0).unwrap_or(32)],
        );
        if !actual_name.eq_ignore_ascii_case(name) {
            SetCurrentConsoleFontEx(output, 0, &previous);
            return Err(format!("Windows substituted {actual_name} for {name}. Choose an installed fixed-width console font."));
        }
    }
    Ok(())
}

pub fn finish(code: i32) {
    if code != 0 && is_owned() {
        eprintln!("Achbit TUI exited with code {code}. Press Enter to close this window.");
        let mut line = String::new();
        let _ = io::stdin().read_line(&mut line);
    }
    if let Ok(mut fonts) = LOADED_FONTS.lock() {
        for path in fonts.drain(..) {
            unsafe {
                RemoveFontResourceExW(wide(path.as_os_str()).as_ptr(), 0, std::ptr::null());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[ignore = "requires an interactive Windows desktop, DEEPCODE_TEST_TUI_FONTS and a new DEEPCODE_TEST_TUI_RESULT path"]
    fn dedicated_console_applies_bundled_fonts_and_releases_them() {
        let fonts =
            PathBuf::from(std::env::var_os("DEEPCODE_TEST_TUI_FONTS").expect("built TUI fonts"));
        let receipt = PathBuf::from(
            std::env::var_os("DEEPCODE_TEST_TUI_RESULT").expect("new test receipt path"),
        );
        if std::env::var_os(WINDOW_ENV).is_none() {
            assert!(
                !receipt.exists(),
                "a previous result is not acceptance evidence"
            );
            let status = launch(&[
                "--exact".into(),
                "windows_terminal::tests::dedicated_console_applies_bundled_fonts_and_releases_them".into(),
                "--ignored".into(), "--test-threads=1".into(),
            ]).unwrap();
            assert!(status.success());
            let result: Value =
                serde_json::from_slice(&std::fs::read(&receipt).expect("child receipt")).unwrap();
            assert_eq!(result["ok"], true, "{result}");
            return;
        }
        let outcome = (|| -> Result<Value, String> {
            if !is_owned() {
                return Err("console ownership was not established".into());
            }
            let mut applied = Vec::new();
            for (style, label) in [
                ("Reading", "Reading"),
                ("ReadingSans", "Reading Sans"),
                ("MonoKai", "Mono Kai"),
                ("Mono", "Mono"),
            ] {
                let name = format!("Achbit TUI {label} SC");
                apply(&json!({"name":name,"size":12,
                    "file":fonts.join(format!("AchbitQuietTerminal{style}SC-Regular.ttf")).to_string_lossy()}))?;
                applied.push(name);
            }
            apply(&json!({"name":"Consolas","size":12,"file":null}))?;
            Ok(json!({"ok":true,"fonts":applied,"systemFont":"Consolas"}))
        })();
        finish(0);
        let result = outcome.unwrap_or_else(|error| json!({"ok":false,"error":error}));
        assert!(LOADED_FONTS.lock().unwrap().is_empty());
        std::fs::write(receipt, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        assert_eq!(result["ok"], true, "{result}");
    }
}
