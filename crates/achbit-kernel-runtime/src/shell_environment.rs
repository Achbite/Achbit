//! Shell discovery shared by runtime preparation and the process executor.
//! No command is translated or retried in a different shell.
use achbit_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod windows;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellProgram {
    pub tool: String,
    pub executable: PathBuf,
    pub dialect: String,
}

pub fn discover(tool: &str) -> KernelResult<ShellProgram> {
    let program = match tool {
        "powershell" => find_powershell7()
            .map(|p| (p, "powershell7"))
            .or_else(|| find_windows_powershell().map(|p| (p, "windowsPowerShell"))),
        "bash" if cfg!(windows) => git_bash().map(|p| (p, "bash")),
        "bash" => find_command("bash").map(|p| (p, "bash")),
        _ => None,
    };
    program
        .map(|(executable, dialect)| ShellProgram {
            tool: tool.into(),
            executable,
            dialect: dialect.into(),
        })
        .ok_or_else(|| KernelError::Structured {
            code: if tool == "powershell" {
                "powershell_unavailable"
            } else {
                "bash_unavailable"
            },
            stage: "execution",
            message: format!(
                "No {tool} executable is available in the selected native environment."
            ),
            details: serde_json::json!({"toolId": tool}),
        })
}

pub fn find_command(name: &str) -> Option<PathBuf> {
    command_candidates(name).find(|path| executable_file(path))
}

pub fn find_command_in(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    command_candidates_in(name, directories.iter()).find(|path| executable_file(path))
}

fn command_candidates(name: &str) -> impl Iterator<Item = PathBuf> + '_ {
    let directories = std::env::split_paths(
        std::env::var_os("PATH")
            .as_deref()
            .unwrap_or(OsStr::new("")),
    )
    .collect::<Vec<_>>();
    command_candidates_in(name, directories.into_iter())
}

fn command_candidates_in<'a>(
    name: &'a str,
    directories: impl Iterator<Item = impl AsRef<Path>> + 'a,
) -> impl Iterator<Item = PathBuf> + 'a {
    directories.flat_map(move |directory| {
        let directory = directory.as_ref();
        if cfg!(windows) {
            ["exe", "cmd", "bat", "com"]
                .into_iter()
                .map(|extension| directory.join(format!("{name}.{extension}")))
                .collect::<Vec<_>>()
        } else {
            vec![directory.join(name)]
        }
    })
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Prefer a regular PowerShell 7 installation (PATH or the MSI location) over the
/// Store package: Store PowerShell cannot start another Store PowerShell inside
/// the LPAC workspace sandbox (Windows error 87). The Store build remains a fallback.
pub fn find_powershell7() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = command_candidates("pwsh")
        .filter_map(|path| resolve_powershell_path(&path))
        .collect();
    let installed = || {
        if !cfg!(windows) {
            return None;
        }
        let path = PathBuf::from(std::env::var_os("ProgramFiles")?).join("PowerShell/7/pwsh.exe");
        executable_file(&path).then_some(path)
    };
    preferred_powershell7(candidates, installed)
}

fn preferred_powershell7(
    candidates: Vec<PathBuf>,
    installed: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    #[cfg(any(windows, test))]
    let regular = candidates
        .iter()
        .find(|path| !is_store_powershell_path(path))
        .cloned();
    #[cfg(not(any(windows, test)))]
    let regular = candidates.first().cloned();
    regular
        .or_else(installed)
        .or_else(|| candidates.into_iter().next())
}

/// Toolchain homes located under the user's real home directory. Workspace Shells
/// redirect HOME/USERPROFILE to the Session home, so tools such as rustup proxies
/// would no longer find them. These are passed through read-only on every platform.
pub fn toolchain_homes() -> Vec<(&'static str, PathBuf)> {
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut candidates: Vec<(&'static str, Option<PathBuf>)> = vec![
        (
            "RUSTUP_HOME",
            home.as_ref().map(|home| home.join(".rustup")),
        ),
        ("PYENV_ROOT", home.as_ref().map(|home| home.join(".pyenv"))),
        (
            "VOLTA_HOME",
            if cfg!(windows) {
                local.as_ref().map(|local| local.join("Volta"))
            } else {
                home.as_ref().map(|home| home.join(".volta"))
            },
        ),
    ];
    if cfg!(windows) {
        candidates.push(("SCOOP", home.as_ref().map(|home| home.join("scoop"))));
        // pyenv-win reads PYENV rather than PYENV_ROOT.
        candidates.push((
            "PYENV",
            home.as_ref()
                .map(|home| home.join(".pyenv").join("pyenv-win")),
        ));
    }
    candidates
        .into_iter()
        .filter_map(|(name, default)| {
            let path = std::env::var_os(name).map(PathBuf::from).or(default)?;
            let path = path.canonicalize().ok().filter(|path| path.is_dir())?;
            Some((name, path))
        })
        .collect()
}

/// Resolve a Store alias to the registered image before freezing the environment.
fn resolve_powershell_path(path: &Path) -> Option<PathBuf> {
    if !executable_file(path)
        || (cfg!(windows)
            && !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")))
    {
        return None;
    }
    #[cfg(windows)]
    if is_store_powershell_path(path)
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"))
    {
        // A Windows PowerShell request must not resolve to PowerShell 7.
        return path
            .file_name()
            .filter(|name| name.eq_ignore_ascii_case("pwsh.exe"))
            .and_then(|_| windows::registered_powershell());
    }
    Some(path.to_path_buf())
}

#[cfg(any(windows, test))]
fn is_store_powershell_path(path: &Path) -> bool {
    path.as_os_str()
        .to_string_lossy()
        .split(['\\', '/'])
        .skip_while(|part| !part.eq_ignore_ascii_case("WindowsApps"))
        .nth(1)
        .is_some_and(|part| {
            part.eq_ignore_ascii_case("pwsh.exe")
                || part.eq_ignore_ascii_case("powershell.exe")
                || part
                    .to_ascii_lowercase()
                    .starts_with("microsoft.powershell")
        })
}

#[cfg(windows)]
pub fn windows_runtime_read_roots(executable: &Path) -> Vec<PathBuf> {
    windows::runtime_read_roots(executable)
}

pub fn find_windows_powershell() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    command_candidates("powershell")
        .find_map(|path| resolve_powershell_path(&path))
        .or_else(|| {
            let path = PathBuf::from(std::env::var_os("SystemRoot")?)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            executable_file(&path).then_some(path)
        })
}

fn git_bash() -> Option<PathBuf> {
    // Only a Git installation is eligible. System32/bash.exe belongs to WSL
    // and must never silently select a different filesystem/toolchain.
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(variable) else {
            continue;
        };
        for suffix in ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"] {
            let path = PathBuf::from(&base).join(suffix);
            if executable_file(&path) {
                return Some(path);
            }
        }
    }
    let git = find_command("git")?;
    let installation = git.parent()?.parent()?;
    ["bin/bash.exe", "usr/bin/bash.exe"]
        .iter()
        .map(|p| installation.join(p))
        .find(|p| executable_file(p))
}

/// Windows has a short process command-line limit. User scripts are passed as a
/// UTF-8 BOM file so long scripts, Unicode and multiline quoting remain intact.
pub(crate) fn prepare_script_arguments(
    program: &ShellProgram,
    script: &str,
    temporary: &Path,
) -> KernelResult<Vec<String>> {
    if program.tool != "powershell" {
        return Ok(vec!["-c".into(), script.into()]);
    }
    use std::io::Write;
    let path = temporary.join("command.ps1");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| KernelError::Other(format!("create PowerShell script: {error}")))?;
    file.write_all(b"\xef\xbb\xbf[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n")
        // AppContainer startup rewrites TEMP/TMP after CreateProcess receives
        // the Kernel environment. TMPDIR retains the invocation scratch path.
        .and_then(|_| file.write_all(b"$env:TEMP = $env:TMPDIR\n$env:TMP = $env:TMPDIR\n"))
        .and_then(|_| file.write_all(script.as_bytes()))
        .map_err(|error| KernelError::Other(format!("write PowerShell script: {error}")))?;
    Ok(vec![
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        crate::file_access::process_visible_path(&path)
            .to_string_lossy()
            .into_owned(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_powershell7_is_preferred_over_the_store_package() {
        let store = PathBuf::from(
            r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6_x64__example\pwsh.exe",
        );
        let path_install = PathBuf::from(r"C:\tools\pwsh\pwsh.exe");
        let msi = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert_eq!(
            preferred_powershell7(vec![store.clone(), path_install.clone()], || Some(
                msi.clone()
            )),
            Some(path_install)
        );
        assert_eq!(
            preferred_powershell7(vec![store.clone()], || Some(msi.clone())),
            Some(msi)
        );
        assert_eq!(
            preferred_powershell7(vec![store.clone()], || None),
            Some(store)
        );
        assert_eq!(preferred_powershell7(Vec::new(), || None), None);
    }

    #[test]
    fn store_powershell_is_distinguished_from_portable_windows_apps_executables() {
        for path in [
            r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
            r"\\?\C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6_x64__example\pwsh.exe",
            r"C:/Program Files/WindowsApps/Microsoft.PowerShellPreview_7_x64__example/pwsh.exe",
        ] {
            assert!(is_store_powershell_path(Path::new(path)), "{path}");
        }
        for path in [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime\dependencies\native\powershell\pwsh.exe",
            r"C:\portable\NotWindowsApps\pwsh.exe",
        ] {
            assert!(!is_store_powershell_path(Path::new(path)), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn registered_store_powershell_matches_the_os_package_registration() {
        use std::os::windows::process::CommandExt;

        // The install precondition must not depend on the discovery being tested.
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let output = std::process::Command::new(
            system.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-AppxPackage -Name Microsoft.PowerShell | ForEach-Object { Join-Path $_.InstallLocation 'pwsh.exe' })",
        ])
        .output()
        .expect("query the current user's OS package registrations");
        assert!(
            output.status.success(),
            "OS package query failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let installed: Vec<PathBuf> =
            serde_json::from_slice(&output.stdout).expect("OS package paths must be JSON");
        let registered = windows::registered_powershell();
        if installed.is_empty() {
            assert!(registered.is_none());
            eprintln!("Not applicable: no Microsoft.PowerShell Store package is registered for this user.");
            return;
        }
        let registered = registered.expect("installed Store PowerShell must be discoverable");
        assert!(registered.is_file());
        let image = registered.canonicalize().unwrap();
        assert!(installed
            .iter()
            .any(|path| path.canonicalize().is_ok_and(|path| path == image)));
        let alias = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join("Microsoft/WindowsApps/pwsh.exe");
        assert_ne!(registered, alias);
        if alias.is_file() {
            assert_eq!(resolve_powershell_path(&alias), Some(registered));
        }
    }
    #[test]
    fn long_powershell_scripts_use_a_scoped_file_without_changing_user_text() {
        let program = ShellProgram {
            tool: "powershell".into(),
            executable: "pwsh.exe".into(),
            dialect: "powershell7".into(),
        };
        let script = "$p = 'C:\\资料 文件\\a.txt'\nWrite-Output \"$p `\"quoted`\"\"\nexit 7";
        let text = format!("{}\n{script}", "# A long script\n".repeat(5000));
        let temporary =
            std::env::temp_dir().join(format!("achbit-script-test-{}", std::process::id()));
        std::fs::create_dir(&temporary).unwrap();
        let arguments = prepare_script_arguments(&program, &text, &temporary).unwrap();
        let path = PathBuf::from(arguments.last().unwrap());
        assert_eq!(path.parent(), Some(temporary.as_path()));
        let contents = std::fs::read(&path).unwrap();
        assert!(contents.starts_with(b"\xef\xbb\xbf"));
        assert!(contents.ends_with(text.as_bytes()));
        assert!(arguments.iter().map(String::len).sum::<usize>() < 1024);
        assert_eq!(arguments[5], "-File");
        std::fs::remove_dir_all(&temporary).unwrap();
        assert!(!path.exists());
    }
}

pub fn resolved_agent_shell_path() -> KernelResult<OsString> {
    let host_path = std::env::var_os("PATH");
    resolved_agent_shell_path_from(host_path.as_deref())
}

pub fn resolved_agent_shell_path_from(host_path: Option<&OsStr>) -> KernelResult<OsString> {
    let mut configured_tool_paths = Vec::new();
    for key in ["PNPM_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path));
        }
    }
    for key in ["CARGO_HOME", "GOPATH", "JAVA_HOME", "VOLTA_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path).join("bin"));
        }
    }
    if let Some(path) = std::env::var_os("PYENV_ROOT") {
        let root = PathBuf::from(path);
        configured_tool_paths.push(root.join("shims"));
        configured_tool_paths.push(root.join("bin"));
    }
    compose_agent_shell_path(host_path, &configured_tool_paths)
}

/// Host startup/refresh probe. Tool invocations keep using the prepared PATH;
/// they do not source a user profile or change scope on failure.
#[cfg(unix)]
pub fn login_shell_path(shell: &Path) -> KernelResult<OsString> {
    use std::io::Read;
    use std::os::unix::{ffi::OsStringExt, process::CommandExt};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let failure = |message: String| {
        KernelError::InvalidCommand(format!("host_shell_environment_failed: {message}"))
    };
    let mut command = Command::new(shell);
    command
        .args(["-ilc", "/usr/bin/printf '\\0ACHBIT_HOST_PATH\\0' && /usr/bin/printenv PATH && /usr/bin/printf '\\0'"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    // An interactive login shell must not inherit the TUI's controlling terminal:
    // a background process group can be stopped before it reports PATH.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| failure(error.to_string()))?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped shell stdout");
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(64 * 1024)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => break Err(failure("login shell timed out after 5 seconds".into())),
            Err(error) => break Err(failure(error.to_string())),
        }
    };
    // Only the process group created by this probe is owned here.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    let output = reader
        .join()
        .map_err(|_| failure("PATH reader failed".into()))?
        .map_err(|error| failure(error.to_string()))?;
    let status = status?;
    if !status.success() {
        return Err(failure(format!("login shell exited with {status}")));
    }
    let marker = b"\0ACHBIT_HOST_PATH\0";
    let offset = output
        .windows(marker.len())
        .rposition(|part| part == marker)
        .ok_or_else(|| failure("login shell did not report PATH".into()))?
        + marker.len();
    let end = output[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| failure("login shell PATH output is incomplete".into()))?
        + offset;
    let path = output[offset..end]
        .strip_suffix(b"\n")
        .unwrap_or(&output[offset..end]);
    if path.is_empty() || output.len() == 64 * 1024 {
        return Err(failure(
            "login shell reported an empty, invalid or truncated PATH".into(),
        ));
    }
    Ok(OsString::from_vec(path.to_vec()))
}

pub(crate) fn compose_agent_shell_path(
    host_path: Option<&OsStr>,
    configured_tool_paths: &[PathBuf],
) -> KernelResult<OsString> {
    let mut paths = Vec::new();
    for path in configured_tool_paths {
        push_existing_unique_path(&mut paths, path.clone());
    }
    if let Some(host_path) = host_path {
        for path in std::env::split_paths(host_path) {
            push_unique_path(&mut paths, path);
        }
    }
    std::env::join_paths(paths)
        .map_err(|error| KernelError::InvalidCommand(format!("Invalid execution PATH: {error}")))
}

fn push_existing_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        push_unique_path(paths, path);
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}
