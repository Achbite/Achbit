use std::ffi::c_void;
use std::path::Path;
use std::ptr::null_mut;
#[cfg(test)]
use windows_sys::core::GUID;
use windows_sys::Win32::{Foundation::*, Security::Authorization::*};

pub(super) fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

/// Shells treat a verbatim DOS cwd as a UNC location and may start at C:\ instead.
/// Keep canonical paths for ACLs, but pass the equivalent Win32 path to processes.
pub(super) fn process_path(path: &Path) -> Vec<u16> {
    wide(crate::file_access::process_visible_path(path))
}
pub(super) fn error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}
pub(super) fn code(operation: &str, result: u32) -> Result<(), String> {
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "{operation}: {}",
            std::io::Error::from_raw_os_error(result as i32)
        ))
    }
}
pub(super) struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}
pub(super) struct Local(pub *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                LocalFree(self.0);
            }
        }
    }
}

pub(super) fn sid(value: &str) -> Result<Local, String> {
    let mut pointer = null_mut();
    if unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut pointer) } == 0 {
        return Err(error("Parse SID"));
    }
    Ok(Local(pointer))
}
#[cfg(test)]
pub(super) fn uuid() -> GUID {
    let mut guid: GUID = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::System::Rpc::UuidCreate(&mut guid);
    }
    guid
}
#[cfg(test)]
pub(super) fn random_text() -> String {
    let id = uuid();
    format!(
        "{:08x}{:04x}{:04x}{}",
        id.data1,
        id.data2,
        id.data3,
        id.data4
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>()
    )
}
/// Windows command-line encoding for native argv. User scripts remain files or
/// individual Bash arguments, rather than being reinterpreted by cmd.exe.
pub(super) fn quote(value: &str) -> String {
    // Leave simple switches unquoted, including cmd.exe's /d and /c used by
    // the capability probe. Quotes/backslashes still follow native argv rules.
    if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
