//! Resolve installed Store PowerShell without invoking its application launcher.
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
use windows_sys::Win32::Storage::Packaging::Appx::{
    GetPackagePathByFullName, GetPackagesByPackageFamily,
};

pub(super) fn registered_powershell() -> Option<PathBuf> {
    let family: Vec<u16> = "Microsoft.PowerShell_8wekyb3d8bbwe\0"
        .encode_utf16()
        .collect();
    let (mut count, mut length) = (0, 0);
    if unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            null_mut(),
            &mut length,
            null_mut(),
        )
    } != ERROR_INSUFFICIENT_BUFFER
        || count == 0
    {
        return None;
    }
    let mut names = vec![null_mut(); count as usize];
    let mut storage = vec![0u16; length as usize];
    if unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            storage.as_mut_ptr(),
        )
    } != ERROR_SUCCESS
    {
        return None;
    }
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => "x86",
    };
    names
        .into_iter()
        .take(count as usize)
        .filter_map(|name| {
            let name_length = unsafe { (0..).take_while(|i| *name.add(*i) != 0).count() };
            let full_name =
                String::from_utf16(unsafe { std::slice::from_raw_parts(name, name_length) })
                    .ok()?;
            let fields: Vec<_> = full_name.split('_').collect();
            let version: Vec<u16> = fields
                .get(1)?
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            let mut path_length = 0;
            if unsafe { GetPackagePathByFullName(name, &mut path_length, null_mut()) }
                != ERROR_INSUFFICIENT_BUFFER
            {
                return None;
            }
            let mut path = vec![0u16; path_length as usize];
            if unsafe { GetPackagePathByFullName(name, &mut path_length, path.as_mut_ptr()) }
                != ERROR_SUCCESS
            {
                return None;
            }
            let executable = PathBuf::from(OsString::from_wide(
                path.strip_suffix(&[0]).unwrap_or(&path),
            ))
            .join("pwsh.exe");
            executable.is_file().then_some((
                (fields.get(2).copied() == Some(architecture), version),
                executable,
            ))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, executable)| executable)
}

/// Git for Windows launchers live in bin/cmd; their DLLs, helpers and system
/// configuration live beside those directories. Admit only a recognized Git
/// installation, never an arbitrary parent of a PATH entry.
pub(super) fn runtime_read_roots(executable: &std::path::Path) -> Vec<PathBuf> {
    let Some(name) = executable.file_name() else {
        return Vec::new();
    };
    if !name.eq_ignore_ascii_case("git.exe") && !name.eq_ignore_ascii_case("bash.exe") {
        return Vec::new();
    }
    for root in executable.ancestors().skip(1).take(3) {
        if root.join("cmd/git.exe").is_file()
            && root.join("usr/bin/bash.exe").is_file()
            && ["mingw64", "mingw32", "clangarm64"]
                .iter()
                .any(|prefix| root.join(prefix).join("bin/git.exe").is_file())
        {
            return vec![root.to_path_buf()];
        }
    }
    Vec::new()
}
