use super::*;
use crate::shell_environment::ShellProgram;
use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BASE_ARGS: [&str; 13] = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
];

fn executable() -> Option<PathBuf> {
    // The distribution carries the helper beside the Kernel; development uses
    // the installed helper from the container image.
    let bundled = std::env::current_exe().ok()?.parent()?.join("bwrap");
    if bundled.is_file() {
        return Some(bundled);
    }
    crate::shell_environment::find_command("bwrap")
}

pub(super) fn probe() -> SandboxStatus {
    let result = (|| {
        let helper = executable().ok_or("Bubblewrap is not installed. Install bubblewrap in this Linux environment, then refresh the environment.".to_string())?;
        let mut child = Command::new(helper)
            .args(BASE_ARGS)
            .args(["--", "/bin/true"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Bubblewrap capability check timed out.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("Bubblewrap cannot create the required namespaces: {}. Use WSL2 or a Linux environment that permits user namespaces; refresh after changing the environment.", String::from_utf8_lossy(&output.stderr).trim()))
        }
    })();
    SandboxStatus::observed("bubblewrap", result)
}

pub(crate) fn command(
    shell: &ShellProgram,
    args: &[String],
    root: &Path,
    mode: &str,
    targets: Option<&[crate::executors::WorkspaceWriteTarget]>,
    temp: &Path,
    files: &crate::file_access::FileAccessScope,
) -> KernelResult<(PathBuf, Vec<OsString>)> {
    validate_write_scope(root, mode, targets, temp, files)?;
    let helper = executable().ok_or_else(|| unavailable(&shell.tool, "Install bubblewrap in the selected Linux/WSL2 environment and refresh its environment snapshot."))?;
    let filter = temp.join("network-filter.bpf");
    // No external sockets, including WSL's native-process bridge. Local anonymous
    // socket pairs remain available to runtimes. This implements the existing offline workspace policy.
    let instructions: [(u16, u8, u8, u32); 5] = [
        (0x20, 0, 0, 0), // load seccomp_data.nr
        (0x15, 2, 0, libc::SYS_socket as u32),
        (0x15, 1, 0, libc::SYS_connect as u32),
        (0x06, 0, 0, 0x7fff0000), // SECCOMP_RET_ALLOW
        (
            0x06,
            0,
            0,
            if files.network_access {
                0x7fff0000
            } else {
                0x00050000 | libc::EPERM as u32
            },
        ),
    ];
    let mut bytes = Vec::new();
    for (code, jt, jf, value) in instructions {
        bytes.extend_from_slice(&code.to_ne_bytes());
        bytes.extend([jt, jf]);
        bytes.extend_from_slice(&value.to_ne_bytes());
    }
    std::fs::write(&filter, bytes)
        .map_err(|error| KernelError::Other(format!("Write Shell network policy: {error}")))?;
    // A fixed launcher opens the policy FD for both pipe and PTY execution. User
    // scripts are separate arguments and never interpolated into this wrapper.
    let mut command: Vec<OsString> = [
        "-c",
        "exec 3<\"$1\"; shift; exec \"$@\"",
        "deepcode-workspace",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    command.push(filter.into_os_string());
    command.push(helper.into_os_string());
    command.extend(
        BASE_ARGS[..6]
            .iter()
            .filter(|arg| !files.network_access || **arg != "--unshare-net")
            .map(OsString::from),
    );
    let mut readable = files.read.clone();
    readable.sort();
    readable.dedup();
    for path in readable {
        command.extend([
            OsString::from("--ro-bind"),
            path.clone().into(),
            path.into(),
        ]);
    }
    command.extend(
        ["--dev", "/dev", "--proc", "/proc"]
            .into_iter()
            .map(OsString::from),
    );
    command.push("--bind".into());
    command.push(temp.into());
    command.push(temp.into());
    let mut writable = writable_paths(root, mode, targets)?;
    writable.extend(writable_paths(root, "write", Some(&files.write))?);
    writable.sort();
    writable.dedup();
    for target in writable {
        command.push("--bind".into());
        command.push(target.clone().into());
        command.push(target.into());
    }
    for path in &files.read_only {
        command.extend([
            OsString::from("--ro-bind"),
            path.clone().into(),
            path.into(),
        ]);
    }
    for target in files
        .write
        .iter()
        .filter(|target| files.protects(&target.path))
    {
        command.extend([
            OsString::from("--bind"),
            target.path.clone().into(),
            target.path.clone().into(),
        ]);
    }
    // Synthetic ancestors must not accept writes that disappear with the
    // sandbox. This non-recursive remount preserves the explicit writable binds.
    command.extend(["--remount-ro", "/"].into_iter().map(OsString::from));
    command.extend(["--seccomp", "3", "--"].into_iter().map(OsString::from));
    command.push(shell.executable.as_os_str().into());
    command.extend(args.iter().map(OsString::from));
    Ok(("/bin/sh".into(), command))
}
