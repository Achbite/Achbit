use super::*;
#[cfg(windows)]
mod windows_workspace;
use crate::shell_environment::{prepare_script_arguments, ShellProgram};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(windows)]
use super::windows_job;
#[cfg(unix)]
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(100);
const BASH_OUTPUT_LIMIT_BYTES: usize = 50 * 1024;
const BASH_OUTPUT_LIMIT_LINES: usize = 2000;
const BASH_TERMINAL_COLS: u16 = 120;
const BASH_TERMINAL_ROWS: u16 = 30;
const AGENT_SHELL_PATH_SOURCE: &str = "preparedRunEnvironment";
const AGENT_SHELL_RESOURCE_WRITE_SCOPE: &str = "authorizedResources";
const AGENT_SHELL_HOST_WRITE_SCOPE: &str = "hostUser";
static NEXT_PROCESS_SCOPE_ID: AtomicU64 = AtomicU64::new(1);
const AGENT_SHELL_ENV_ALLOWLIST: &[&str] = &[
    "AR",
    "CARGO_HOME",
    "CARGO_TARGET_DIR",
    "CC",
    "CPATH",
    "CPLUS_INCLUDE_PATH",
    "CXX",
    "DEVELOPER_DIR",
    "GOPATH",
    "GOROOT",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LIBRARY_PATH",
    "LOGNAME",
    "MACOSX_DEPLOYMENT_TARGET",
    "NPM_CONFIG_CACHE",
    "NVM_DIR",
    "PATH",
    "PKG_CONFIG_PATH",
    "PNPM_HOME",
    "PYENV_ROOT",
    "RUSTC_WRAPPER",
    "RUSTFLAGS",
    "RUSTUP_HOME",
    "SDKROOT",
    "SHELL",
    "USER",
    "VIRTUAL_ENV",
    "VOLTA_HOME",
    "PYTHONUTF8",
    // Proxy and certificate configuration, used when the Shell has network access.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    // Windows system locations and machine facts that ordinary tools read.
    "windir",
    "SystemDrive",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "ProgramData",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PSModulePath",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
];

pub(super) struct ConfiguredShellExecutor {
    pub program: Option<ShellProgram>,
    pub execution_path: Option<String>,
    pub temporary_root: Option<PathBuf>,
    pub sandbox_backends: std::sync::Arc<crate::workspace_sandbox::SandboxBackendRegistry>,
}

impl KernelToolExecutor for ConfiguredShellExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let workspace = match &invocation.input {
            KernelCanonicalInvocation::ProcessShell {
                execution_scope, ..
            }
            | KernelCanonicalInvocation::ProcessPowerShell {
                execution_scope, ..
            } => execution_scope.as_str() == "workspace",
            _ => false,
        };
        if workspace {
            let backend = self.sandbox_backends.resolve(
                context
                    .file_access
                    .sandbox_backend
                    .as_deref()
                    .unwrap_or("platform-default"),
            )?;
            return backend.execute(crate::workspace_sandbox::SandboxProcessRequest {
                invocation,
                context,
                shell: self.program.as_ref(),
                execution_path: self.execution_path.as_deref(),
                temporary_root: self.temporary_root.as_deref(),
            });
        }
        invoke_shell(
            invocation,
            context,
            self.program.as_ref(),
            self.execution_path.as_deref(),
            self.temporary_root.as_deref(),
        )
    }
}

pub(crate) fn invoke_workspace_shell(
    request: crate::workspace_sandbox::SandboxProcessRequest<'_>,
) -> KernelResult<KernelToolExecutionResult> {
    match &request.invocation.input {
        KernelCanonicalInvocation::ProcessShell {
            execution_scope, ..
        }
        | KernelCanonicalInvocation::ProcessPowerShell {
            execution_scope, ..
        } if execution_scope.as_str() == "workspace" => {}
        _ => {
            return Err(KernelError::InvalidCommand(
                "Sandbox backend requires an admitted workspace Shell".into(),
            ))
        }
    }
    let mut result = invoke_shell(
        request.invocation,
        request.context,
        request.shell,
        request.execution_path,
        request.temporary_root,
    )?;
    result.output["sandboxBackend"] =
        serde_json::json!(crate::workspace_sandbox::native_backend_id());
    Ok(result)
}

fn invoke_shell(
    invocation: KernelToolInvocation,
    context: KernelToolExecutionContext,
    selected: Option<&ShellProgram>,
    execution_path: Option<&str>,
    temporary_root: Option<&Path>,
) -> KernelResult<KernelToolExecutionResult> {
    let process_scope_id = new_process_scope_id();
    let mut temporary = AgentShellTempDir::create(temporary_root, &process_scope_id)?;
    let result = invoke_shell_in_temp(
        invocation,
        context,
        selected,
        execution_path,
        &process_scope_id,
        temporary.path(),
    );
    finish_shell_execution(result, temporary.cleanup())
}

fn invoke_shell_in_temp(
    invocation: KernelToolInvocation,
    context: KernelToolExecutionContext,
    selected: Option<&ShellProgram>,
    execution_path: Option<&str>,
    process_scope_id: &str,
    temporary: &Path,
) -> KernelResult<KernelToolExecutionResult> {
    let execution_path = execution_path
        .ok_or_else(|| KernelError::InvalidCommand("Prepared execution PATH is missing".into()))?;
    let tool_name = invocation.input.tool_id().as_str();
    let (command_text, workspace_mode, execution_scope, timeout_seconds, terminal_stdin) =
        match invocation.input {
            KernelCanonicalInvocation::ProcessShell {
                command,
                workspace_mode,
                execution_scope,
                timeout,
                terminal,
                ..
            }
            | KernelCanonicalInvocation::ProcessPowerShell {
                command,
                workspace_mode,
                execution_scope,
                timeout,
                terminal,
                ..
            } => (
                command,
                workspace_mode.as_str().to_owned(),
                execution_scope.as_str().to_owned(),
                timeout.map(u64::from),
                terminal.map(|value| value.stdin),
            ),
            _ => {
                return Err(KernelError::InvalidCommand(
                    "Shell invocation required".into(),
                ))
            }
        };
    let write_scope = shell_write_scope(&execution_scope);
    let workspace_id = workspace_id(&context)?.to_string();
    let workspace_root = canonical_process_workspace_root(&context)?;
    let cwd = prepared_process_cwd(&context, &workspace_root)?;
    let shell = match selected {
        Some(program) if program.tool == tool_name => program.clone(),
        Some(_) => {
            return Err(KernelError::InvalidCommand(
                "Shell does not match the prepared execution environment".into(),
            ))
        }
        None => {
            return Err(KernelError::InvalidCommand(
                "Prepared shell is missing".into(),
            ))
        }
    };
    if !shell.executable.is_file() {
        return Err(KernelError::Structured {
                code: if tool_name == "powershell" { "powershell_unavailable" } else { "bash_unavailable" },
                stage: "execution",
                message: format!("The selected {} executable is unavailable: {}. Update Execution environment settings or install the selected shell, then refresh the environment.", shell.dialect, shell.executable.display()),
                details: serde_json::json!({ "toolId": tool_name }),
            });
    }
    let bash_program = shell.executable.clone();

    if let Some(terminal_stdin) = terminal_stdin
        .as_ref()
        .filter(|_| !(cfg!(windows) && execution_scope == "workspace"))
    {
        return invoke_terminal_shell(
            invocation.id,
            command_text,
            workspace_mode,
            execution_scope,
            terminal_stdin.clone(),
            timeout_seconds,
            workspace_id,
            workspace_root,
            cwd,
            shell,
            execution_path,
            context,
            process_scope_id,
            temporary,
        );
    }

    let terminal = terminal_stdin.is_some();
    let arguments = prepare_script_arguments(&shell, &command_text, temporary)?;
    let prepared_command = prepare_shell_command(
        &arguments,
        &shell,
        &workspace_root,
        &workspace_mode,
        &execution_scope,
        context.workspace_write_targets.as_deref(),
        temporary,
        process_scope_id,
        terminal_stdin.as_deref(),
        &context.file_access,
    )?;
    (|| {
        let mut process = Command::new(&prepared_command.program);
        process.args(&prepared_command.arguments);
        #[cfg(unix)]
        process.process_group(0);
        let environment = agent_shell_environment(
            &bash_program,
            &execution_scope,
            terminal,
            execution_path,
            &workspace_root,
            temporary,
            &context.file_access,
        )?;
        if environment.clear {
            process.env_clear();
        }
        process.envs(environment.values).current_dir(&cwd);
        #[cfg(windows)]
        let mut result = if execution_scope == "workspace" {
            windows_workspace::execute(
                invocation.id,
                process,
                timeout_seconds,
                tool_name,
                &context,
                &workspace_root,
                &workspace_mode,
                temporary,
                terminal_stdin.as_deref(),
            )?
        } else {
            execute_cli_command(
                invocation.id,
                process,
                timeout_seconds,
                tool_name,
                &context,
                None,
            )?
        };
        #[cfg(not(windows))]
        let mut result = execute_cli_command(
            invocation.id,
            process,
            timeout_seconds,
            tool_name,
            &context,
            (execution_scope == "workspace").then_some(process_scope_id),
        )?;
        let metadata = serde_json::json!({
            "workspaceId": workspace_id,
            "command": command_text,
            "cwd": ".",
            "paths": shell_paths(&workspace_root, &execution_scope, &context, temporary),
            "workspaceMode": workspace_mode,
            "executionScope": execution_scope,
            "terminal": terminal,
            "environment": {
                "executionTarget": { "kind": "native" },
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "shell": bash_program.to_string_lossy(),
                "interactive": terminal,
                "executionScope": execution_scope,
                "terminal": terminal,
                "pathSource": AGENT_SHELL_PATH_SOURCE,
                "writeScope": write_scope,
                "homeWritable": true,
                "networkAccess": execution_scope == "host" || context.file_access.network_access
            }
        });
        result
            .output
            .as_object_mut()
            .expect("process output")
            .extend(metadata.as_object().expect("process metadata").clone());
        Ok(result)
    })()
}

fn finish_shell_execution(
    result: KernelResult<KernelToolExecutionResult>,
    cleanup: KernelResult<()>,
) -> KernelResult<KernelToolExecutionResult> {
    match (result, cleanup) {
        (Ok(result), Err(cleanup)) => {
            let message = match &result.error {
                Some(primary) => format!(
                    "[{}]: {}; cleanup failed: {cleanup}",
                    primary.code, primary.message
                ),
                None => format!("Shell completed, but cleanup failed: {cleanup}"),
            };
            Err(KernelError::Structured {
                code: "shell_cleanup_failed",
                stage: "execution",
                message,
                details: serde_json::json!({ "executionResult": result }),
            })
        }
        (result, cleanup) => combine_shell_results(result, cleanup).map(|(result, ())| result),
    }
}

fn shell_cleanup_failure<S: std::fmt::Debug>(
    wait: KernelResult<(S, bool, bool)>,
    cleanup: KernelError,
) -> KernelResult<KernelToolExecutionResult> {
    match wait {
        Err(primary) => combine_shell_results(Err(primary), Err::<(), _>(cleanup)).map(|(value, ())| value),
        Ok((status, timed_out, cancelled)) => Err(KernelError::Structured {
            code: "shell_cleanup_failed",
            stage: "execution",
            message: format!("Shell exit status {status:?} (timedOut={timed_out}, cancelled={cancelled}); resource cleanup failed: {cleanup}"),
            details: serde_json::json!({ "exitStatus": format!("{status:?}"), "timedOut": timed_out }),
        }),
    }
}

#[allow(clippy::too_many_arguments)]
fn invoke_terminal_shell(
    invocation_id: String,
    command_text: String,
    workspace_mode: String,
    execution_scope: String,
    terminal_stdin: String,
    timeout_seconds: Option<u64>,
    workspace_id: String,
    workspace_root: PathBuf,
    cwd: PathBuf,
    shell: ShellProgram,
    execution_path: &str,
    context: KernelToolExecutionContext,
    process_scope_id: &str,
    temporary: &Path,
) -> KernelResult<KernelToolExecutionResult> {
    let tool_name = shell.tool.clone();
    let bash_program = shell.executable.clone();
    let write_scope = shell_write_scope(&execution_scope);

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: BASH_TERMINAL_ROWS,
            cols: BASH_TERMINAL_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| KernelError::Other(format!("open bash pty: {error}")))?;
    let arguments = prepare_script_arguments(&shell, &command_text, temporary)?;
    let prepared_command = prepare_shell_command(
        &arguments,
        &shell,
        &workspace_root,
        &workspace_mode,
        &execution_scope,
        context.workspace_write_targets.as_deref(),
        temporary,
        process_scope_id,
        Some(&terminal_stdin),
        &context.file_access,
    )?;
    (|| {
        let mut command = CommandBuilder::new(&prepared_command.program);
        command.args(&prepared_command.arguments);
        let environment = agent_shell_environment(
            &bash_program,
            &execution_scope,
            true,
            execution_path,
            &workspace_root,
            temporary,
            &context.file_access,
        )?;
        if environment.clear {
            command.env_clear();
        }
        for (key, value) in environment.values {
            command.env(key, value);
        }
        command.cwd(&cwd);

        let archive = ShellOutputArchive::create(&context)?;
        let stdout_file = archive.open("stdout")?;
        #[cfg(unix)]
        if let Some(fd) = pty.master.as_raw_fd() {
            set_raw_fd_nonblocking(fd, "pty")?;
        }
        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|error| KernelError::Other(format!("clone bash pty reader: {error}")))?;
        let mut writer = pty
            .master
            .take_writer()
            .map_err(|error| KernelError::Other(format!("open bash pty writer: {error}")))?;
        let spawned_child = pty.slave.spawn_command(command).map_err(|error| {
            KernelError::Other(format!("spawn bash pty in {}: {error}", cwd.display()))
        })?;
        context.progress.started();
        let mut spawned_child = spawned_child;
        #[cfg(windows)]
        let process_job = match spawned_child
            .process_id()
            .map(windows_job::ProcessJob::attach)
        {
            Some(Ok(job)) => job,
            result => {
                let error = result.and_then(Result::err).unwrap_or_else(|| {
                    KernelError::Other("Shell PTY process identity is unavailable".into())
                });
                return combine_shell_results(
                    Err(error),
                    terminate_untracked_pty_child(&mut *spawned_child),
                )
                .map(|(result, ())| result);
            }
        };
        #[cfg(unix)]
        let Some(process_id) = spawned_child.process_id() else {
            return combine_shell_results(
                Err(KernelError::Other(
                    "bash pty child process identity is unavailable".to_string(),
                )),
                terminate_untracked_pty_child(&mut *spawned_child),
            )
            .map(|(result, ())| result);
        };
        #[cfg(unix)]
        let mut child = PtyChildGuard::new(spawned_child, process_id);
        #[cfg(not(unix))]
        let mut child = PtyChildGuard::new(spawned_child);
        #[cfg(target_os = "macos")]
        let mut process_scope_guard = (execution_scope == "workspace")
            .then(|| ProcessScopeGuard::new(process_id, process_scope_id.to_owned()));
        drop(pty.slave);

        let stop_capture = Arc::new(AtomicBool::new(false));
        let stdout_reader = spawn_output_reader(
            reader,
            stdout_file,
            BASH_OUTPUT_LIMIT_BYTES,
            Arc::clone(&stop_capture),
            context.progress.clone(),
            "stdout",
            true,
        );
        let write_result = writer
            .write_all(terminal_stdin.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| KernelError::Other(format!("write bash pty stdin: {error}")));
        drop(writer);
        let started = Instant::now();
        let wait_result = write_result.and_then(|()| {
            wait_for_bounded_pty_child(
                &mut child,
                timeout_seconds.map(Duration::from_secs),
                &context.cancellation,
            )
        });
        let process_cleanup = child.terminate_and_wait().map(|_| ());
        #[cfg(windows)]
        let process_cleanup =
            combine_shell_results(process_cleanup, process_job.terminate()).map(|_| ());
        #[cfg(target_os = "macos")]
        let process_cleanup = combine_shell_results(
            process_cleanup,
            match process_scope_guard.as_mut() {
                Some(guard) => guard.terminate(),
                None => Ok(()),
            },
        )
        .map(|_| ());
        stop_capture.store(true, AtomicOrdering::Release);
        if let Err(cleanup) = process_cleanup {
            return shell_cleanup_failure(wait_result, cleanup);
        }

        drop(pty.master);
        let stdout_result = join_output_reader(stdout_reader, "pty");

        let mut stdout = match stdout_result {
            Ok(stdout) => stdout,
            Err(error) => return shell_cleanup_failure(wait_result, error),
        };
        let (status, timed_out, cancelled) = wait_result?;
        stdout.truncated |= retain_tail_lines(&mut stdout.bytes, BASH_OUTPUT_LIMIT_LINES);
        trim_utf8_prefix(&mut stdout.bytes);

        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let exit_code = i32::try_from(status.exit_code())
            .ok()
            .filter(|_| !timed_out && !cancelled);
        let success = !timed_out && !cancelled && status.success();
        let mut output = serde_json::json!({
            "workspaceId": workspace_id,
            "command": command_text,
            "cwd": ".",
            "paths": shell_paths(&workspace_root, &execution_scope, &context, temporary),
            "workspaceMode": workspace_mode,
            "executionScope": execution_scope,
            "terminal": true,
            "stdout": String::from_utf8_lossy(&stdout.bytes),
            "stderr": "",
            "exitCode": exit_code,
            "success": success,
            "timedOut": timed_out,
            "truncated": stdout.truncated,
            "capturedBytes": stdout.bytes.len(),
            "durationMs": duration_ms,
            "environment": {
                "shell": bash_program.to_string_lossy(),
                "interactive": true,
                "executionScope": execution_scope,
                "terminal": true,
                "pathSource": AGENT_SHELL_PATH_SOURCE,
                "writeScope": write_scope,
                "homeWritable": true,
                "networkAccess": execution_scope == "host" || context.file_access.network_access
            }
        });
        archive.finish(&mut output)?;
        if cancelled {
            Ok(known_failure(
                invocation_id,
                output,
                "tool_execution_cancelled",
                format!("{tool_name} was cancelled"),
            ))
        } else if success {
            Ok(ok(invocation_id, output))
        } else if timed_out {
            Ok(known_failure(
                invocation_id,
                output,
                if tool_name == "powershell" {
                    "powershell_timed_out"
                } else {
                    "bash_timed_out"
                },
                format!(
                    "{tool_name} command exceeded its {}-second timeout.",
                    timeout_seconds.expect("timed out with a deadline")
                ),
            ))
        } else {
            Ok(known_failure(
                invocation_id,
                output,
                if tool_name == "powershell" {
                    "powershell_exit_nonzero"
                } else {
                    "bash_exit_nonzero"
                },
                match exit_code {
                    Some(code) => format!("{tool_name} command exited with status {code}."),
                    None => "Bash command terminated without an exit status.".to_string(),
                },
            ))
        }
    })()
}

fn shell_paths(
    workspace_root: &Path,
    execution_scope: &str,
    context: &KernelToolExecutionContext,
    temporary: &Path,
) -> serde_json::Value {
    use crate::file_access::process_visible_path as visible;
    let home = if execution_scope == "workspace" {
        Some(
            context
                .file_access
                .home
                .as_deref()
                .unwrap_or(temporary)
                .to_path_buf(),
        )
    } else {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
    };
    serde_json::json!({
        "workspace": visible(workspace_root),
        "home": home.as_deref().map(visible),
        "scratch": visible(temporary),
        "cache": (execution_scope == "workspace").then_some(context.file_access.cache.as_deref()).flatten().map(visible),
    })
}

struct AgentShellEnvironment {
    /// Workspace Shells start from the allowlist instead of the Host environment.
    clear: bool,
    values: Vec<(OsString, OsString)>,
}

/// The single environment of every Shell launch path (pipes, PTY and Windows
/// LPAC) on every platform. Paths use the spelling programs understand.
fn agent_shell_environment(
    bash_program: &Path,
    execution_scope: &str,
    terminal: bool,
    execution_path: &str,
    workspace_root: &Path,
    temporary: &Path,
    files: &crate::file_access::FileAccessScope,
) -> KernelResult<AgentShellEnvironment> {
    use crate::file_access::process_visible_path as visible;
    let workspace = execution_scope == "workspace";
    let mut values: Vec<(OsString, OsString)> = Vec::new();
    let mut set = |key: &str, value: OsString| {
        // Windows environment names are case-insensitive; Unix names are not.
        values.retain(|(existing, _)| {
            if cfg!(windows) {
                !existing.eq_ignore_ascii_case(key)
            } else {
                existing != key
            }
        });
        values.push((key.into(), value));
    };
    if workspace {
        for key in AGENT_SHELL_ENV_ALLOWLIST
            .iter()
            .filter(|key| **key != "PATH")
        {
            if let Some(value) = std::env::var_os(key) {
                set(key, value);
            }
        }
    }
    set("PATH", execution_path.into());
    set(
        "TERM",
        if terminal { "xterm-256color" } else { "dumb" }.into(),
    );
    set("SHELL", bash_program.into());
    set("NO_COLOR", "1".into());
    set("CLICOLOR", "0".into());
    set("DEEPCODE_AGENT_SHELL", "1".into());
    set("DEEPCODE_WORKSPACE_ROOT", visible(workspace_root).into());
    for key in ["TMPDIR", "TMP", "TEMP"] {
        set(key, visible(temporary).into());
    }
    // A tool command has no person at a prompt: fail instead of waiting for one.
    set("GIT_TERMINAL_PROMPT", "0".into());
    set("GCM_INTERACTIVE", "never".into());
    // UTF-8 output on every platform, including Windows ANSI code pages.
    if std::env::var_os("PYTHONUTF8").is_none() {
        set("PYTHONUTF8", "1".into());
    }
    if workspace {
        let home = files.home.as_deref().unwrap_or(temporary);
        fs::create_dir_all(home)
            .map_err(|error| KernelError::Other(format!("Create Agent home: {error}")))?;
        set("HOME", visible(home).into());
        set("XDG_CONFIG_HOME", visible(&home.join("config")).into());
        set("GIT_OPTIONAL_LOCKS", "0".into());
        #[cfg(windows)]
        {
            for (key, directory) in [
                ("APPDATA", home.join("AppData").join("Roaming")),
                ("LOCALAPPDATA", home.join("AppData").join("Local")),
            ] {
                fs::create_dir_all(&directory).map_err(|error| {
                    KernelError::Other(format!("Create Agent application data: {error}"))
                })?;
                set(key, visible(&directory).into());
            }
            set("USERPROFILE", visible(home).into());
        }
        match files.cache.as_deref() {
            Some(cache) => {
                for (key, value) in shared_cache_environment(cache)? {
                    set(key, visible(&value).into());
                }
            }
            None => set("XDG_CACHE_HOME", visible(&home.join("cache")).into()),
        }
        for (key, path) in crate::shell_environment::toolchain_homes() {
            set(key, visible(&path).into());
        }
    }
    Ok(AgentShellEnvironment {
        clear: workspace,
        values,
    })
}

/// Package caches shared by workspace Shells of every Session. Cargo receives
/// the user's registry configuration (mirrors), never credentials.
fn shared_cache_environment(cache: &Path) -> KernelResult<Vec<(&'static str, PathBuf)>> {
    let entries = [
        ("XDG_CACHE_HOME", cache.join("xdg")),
        ("NPM_CONFIG_CACHE", cache.join("npm")),
        ("YARN_CACHE_FOLDER", cache.join("yarn")),
        ("PIP_CACHE_DIR", cache.join("pip")),
        ("GOMODCACHE", cache.join("go").join("mod")),
        ("GOCACHE", cache.join("go").join("build")),
        ("NUGET_PACKAGES", cache.join("nuget")),
        ("CARGO_HOME", cache.join("cargo")),
    ];
    for (_, directory) in &entries {
        fs::create_dir_all(directory).map_err(|error| {
            KernelError::Other(format!(
                "Create shared Shell cache {}: {error}",
                directory.display()
            ))
        })?;
    }
    let user_cargo = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".cargo"))
        });
    if let Some(user_cargo) = user_cargo {
        for name in ["config.toml", "config"] {
            let (source, target) = (user_cargo.join(name), cache.join("cargo").join(name));
            let newer = |path: &Path| {
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            };
            if source.is_file() && newer(&source) > newer(&target) {
                // Best effort: an unreadable user configuration leaves cargo defaults.
                let _ = fs::copy(&source, &target);
            }
        }
    }
    Ok(entries.into_iter().collect())
}

fn shell_write_scope(execution_scope: &str) -> &'static str {
    if execution_scope == "host" {
        AGENT_SHELL_HOST_WRITE_SCOPE
    } else {
        AGENT_SHELL_RESOURCE_WRITE_SCOPE
    }
}

fn terminate_untracked_pty_child(child: &mut dyn portable_pty::Child) -> KernelResult<()> {
    child
        .kill()
        .map_err(|error| KernelError::Other(format!("terminate bash pty child: {error}")))?;
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap bash pty child: {error}")))?;
    Ok(())
}

struct PtyChildGuard {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[cfg(unix)]
    process_id: u32,
    active: bool,
}

impl PtyChildGuard {
    #[cfg(unix)]
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>, process_id: u32) -> Self {
        Self {
            child,
            process_id,
            active: true,
        }
    }

    #[cfg(not(unix))]
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self {
            child,
            active: true,
        }
    }

    fn terminate_and_wait(&mut self) -> KernelResult<portable_pty::ExitStatus> {
        if !self.active {
            return self
                .child
                .wait()
                .map_err(|error| KernelError::Other(format!("reap bash pty child: {error}")));
        }
        #[cfg(unix)]
        {
            signal_process_group(self.process_id, UNIX_SIGTERM)?;
            let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
            loop {
                if let Some(status) = self.child.try_wait().map_err(|error| {
                    KernelError::Other(format!("poll bash pty termination: {error}"))
                })? {
                    terminate_remaining_process_group(self.process_id)?;
                    self.active = false;
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            signal_process_group(self.process_id, UNIX_SIGKILL)?;
        }
        #[cfg(not(unix))]
        if let Some(status) = self
            .child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll bash pty termination: {error}")))?
        {
            self.active = false;
            return Ok(status);
        }
        #[cfg(not(unix))]
        self.child
            .kill()
            .map_err(|error| KernelError::Other(format!("terminate bash pty child: {error}")))?;
        let status = self
            .child
            .wait()
            .map_err(|error| KernelError::Other(format!("reap bash pty child: {error}")))?;
        #[cfg(unix)]
        terminate_remaining_process_group(self.process_id)?;
        self.active = false;
        Ok(status)
    }
}

impl Drop for PtyChildGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = self.terminate_and_wait();
        }
    }
}

fn new_process_scope_id() -> String {
    let sequence = NEXT_PROCESS_SCOPE_ID.fetch_add(1, AtomicOrdering::Relaxed);
    let unix_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "com.deepcode.process-scope.{}.{unix_nanos}.{sequence}",
        std::process::id()
    )
}

struct AgentShellTempDir {
    path: PathBuf,
    active: bool,
}

impl AgentShellTempDir {
    fn create(root: Option<&Path>, process_scope_id: &str) -> KernelResult<Self> {
        let root = root
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&root).map_err(|error| {
            KernelError::Other(format!(
                "create shell temporary root {}: {error}",
                root.display()
            ))
        })?;
        let path = root.join(format!("deepcode-agent-shell-{process_scope_id}"));
        fs::create_dir(&path).map_err(|error| {
            KernelError::Other(format!(
                "create bash temporary directory {}: {error}",
                path.display()
            ))
        })?;
        let mut temporary = Self { path, active: true };
        let initialized = (|| {
            #[cfg(unix)]
            fs::set_permissions(&temporary.path, fs::Permissions::from_mode(0o700)).map_err(
                |error| {
                    KernelError::Other(format!(
                        "secure bash temporary directory {}: {error}",
                        temporary.path.display()
                    ))
                },
            )?;
            temporary.path = temporary.path.canonicalize().map_err(|error| {
                KernelError::Other(format!(
                    "canonicalize bash temporary directory {}: {error}",
                    temporary.path.display()
                ))
            })?;
            Ok(())
        })();
        if let Err(error) = initialized {
            return combine_shell_results(Err(error), temporary.cleanup()).map(|(value, ())| value);
        }
        Ok(temporary)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn cleanup(&mut self) -> KernelResult<()> {
        if !self.active {
            return Ok(());
        }
        fs::remove_dir_all(&self.path).map_err(|error| {
            KernelError::Other(format!(
                "remove bash temporary directory {}: {error}",
                self.path.display()
            ))
        })?;
        self.active = false;
        Ok(())
    }
}

impl Drop for AgentShellTempDir {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("{error}");
        }
    }
}

fn prepared_process_cwd(
    context: &KernelToolExecutionContext,
    root: &Path,
) -> KernelResult<PathBuf> {
    if context.private_resolved_targets.len() != 1 {
        return Err(KernelError::InvalidCommand(
            "bash requires exactly one PreparedEffect workspace root".to_string(),
        ));
    }
    let prepared = PathBuf::from(&context.private_resolved_targets[0]);
    let canonical_cwd = prepared.canonicalize().map_err(|error| {
        KernelError::InvalidCommand(format!("bash workspace root is unavailable: {error}"))
    })?;
    if canonical_cwd != root {
        return Err(KernelError::PermissionDenied(
            "bash PreparedEffect target does not match the bound workspace root".to_string(),
        ));
    }
    if !canonical_cwd.is_dir() {
        return Err(KernelError::InvalidCommand(
            "bash workspace root is not a directory".to_string(),
        ));
    }
    Ok(canonical_cwd)
}

fn canonical_process_workspace_root(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    workspace_root(context)?.canonicalize().map_err(|error| {
        KernelError::WorkspaceRootUnreadable(format!(
            "canonicalize process workspace root: {error}"
        ))
    })
}

struct PreparedShellCommand {
    program: PathBuf,
    arguments: Vec<OsString>,
}

#[allow(clippy::too_many_arguments)]
fn prepare_shell_command(
    args: &[String],
    shell: &ShellProgram,
    workspace_root: &Path,
    workspace_mode: &str,
    execution_scope: &str,
    writable_targets: Option<&[WorkspaceWriteTarget]>,
    temp: &Path,
    scope: &str,
    terminal_stdin: Option<&str>,
    files: &crate::file_access::FileAccessScope,
) -> KernelResult<PreparedShellCommand> {
    if execution_scope == "host" {
        return Ok(PreparedShellCommand {
            program: shell.executable.clone(),
            arguments: args.iter().map(OsString::from).collect(),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let _ = terminal_stdin;
        let mut arguments = vec![
            OsString::from("-p"),
            macos_workspace_profile(
                workspace_root,
                temp,
                scope,
                workspace_mode,
                writable_targets,
                files,
                Some(&macos_user_temporary_directory()?),
            )?
            .into(),
            shell.executable.as_os_str().into(),
        ];
        arguments.extend(args.iter().map(OsString::from));
        Ok(PreparedShellCommand {
            program: "/usr/bin/sandbox-exec".into(),
            arguments,
        })
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (scope, terminal_stdin);
        let (program, arguments) = crate::workspace_sandbox::linux::command(
            shell,
            args,
            workspace_root,
            workspace_mode,
            writable_targets,
            temp,
            files,
        )?;
        Ok(PreparedShellCommand { program, arguments })
    }
    #[cfg(windows)]
    {
        let _ = (
            files,
            args,
            writable_targets,
            temp,
            scope,
            terminal_stdin,
            workspace_root,
            workspace_mode,
        );
        // This prepared command is consumed only by windows_workspace::execute;
        // it must never be spawned directly for the workspace scope.
        Ok(PreparedShellCommand {
            program: shell.executable.clone(),
            arguments: args.iter().map(OsString::from).collect(),
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (
            temp,
            scope,
            workspace_root,
            workspace_mode,
            writable_targets,
        );
        Err(crate::workspace_sandbox::unavailable(
            &shell.tool,
            "Workspace Shell is not implemented on this platform.",
        ))
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_workspace_profile(
    workspace_root: &Path,
    temporary_root: &Path,
    process_scope_id: &str,
    workspace_mode: &str,
    writable_targets: Option<&[WorkspaceWriteTarget]>,
    files: &crate::file_access::FileAccessScope,
    system_temporary: Option<&Path>,
) -> KernelResult<String> {
    crate::workspace_sandbox::validate_write_scope(
        workspace_root,
        workspace_mode,
        writable_targets,
        temporary_root,
        files,
    )?;
    let escaped_workspace = macos_sandbox_path(workspace_root, "workspace")?;
    let escaped_temporary = macos_sandbox_path(temporary_root, "temporary directory")?;
    if process_scope_id.is_empty()
        || !process_scope_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(KernelError::InvalidCommand(
            "bash scope identity is invalid".to_string(),
        ));
    }
    let workspace_write_rule = match workspace_mode {
        "read" => String::new(),
        "write" => match writable_targets {
            None => format!("\n(allow file-write* (subpath \"{escaped_workspace}\"))"),
            Some(targets) => {
                let mut rules = String::new();
                for target in targets {
                    let path = macos_sandbox_path(&target.path, "Plan write target")?;
                    let matcher = if target.directory {
                        "subpath"
                    } else {
                        "literal"
                    };
                    rules.push_str(&format!("\n(allow file-write* ({matcher} \"{path}\"))"));
                }
                rules
            }
        },
        _ => {
            return Err(KernelError::InvalidCommand(
                "bash workspaceMode must be read or write".to_string(),
            ))
        }
    };
    let mut rules = String::new();
    // Traversal may inspect ancestors, but grants no reads of their other children.
    let ancestors: std::collections::BTreeSet<_> = files
        .read
        .iter()
        .map(PathBuf::as_path)
        .chain(files.write.iter().map(|target| target.path.as_path()))
        .chain(std::iter::once(temporary_root))
        .flat_map(|path| path.ancestors().skip(1))
        .collect();
    for path in ancestors {
        let escaped = macos_sandbox_path(path, "resource ancestor")?;
        rules.push_str(&format!(
            "\n(allow file-read-metadata (literal \"{escaped}\"))"
        ));
    }
    for path in &files.read {
        let escaped = macos_sandbox_path(path, "read path")?;
        let matcher = if path.is_dir() { "subpath" } else { "literal" };
        rules.push_str(&format!("\n(allow file-read* ({matcher} \"{escaped}\"))"));
    }
    for target in &files.write {
        let escaped = macos_sandbox_path(&target.path, "write path")?;
        let matcher = if target.directory {
            "subpath"
        } else {
            "literal"
        };
        rules.push_str(&format!(
            "\n(allow file-read* file-write* ({matcher} \"{escaped}\"))"
        ));
    }
    for path in &files.read_only {
        let escaped = macos_sandbox_path(path, "read-only path")?;
        let matcher = if path.is_dir() { "subpath" } else { "literal" };
        let mut exceptions = String::new();
        for grant in files
            .write
            .iter()
            .filter(|grant| grant.path.starts_with(path))
        {
            let target = macos_sandbox_path(&grant.path, "approved write path")?;
            let kind = if grant.directory {
                "subpath"
            } else {
                "literal"
            };
            exceptions.push_str(&format!(" ({kind} \"{target}\")"));
        }
        let filter = if exceptions.is_empty() {
            format!("({matcher} \"{escaped}\")")
        } else {
            format!(
                "(require-all ({matcher} \"{escaped}\") (require-not (require-any{exceptions})))"
            )
        };
        rules.push_str(&format!("\n(deny file-write* {filter})"));
    }
    if let Some(directory) = system_temporary {
        // xcrun locates its cache through confstr, independently of TMPDIR.
        // It owns these shared toolchain cache files; other host scratch stays
        // inaccessible and is never cleaned up by an Agent command lifecycle.
        for path in crate::file_access::macos_path_spellings(directory) {
            for ancestor in path.ancestors() {
                let escaped = macos_sandbox_path(ancestor, "toolchain cache ancestor")?;
                rules.push_str(&format!(
                    "\n(allow file-read-metadata (literal \"{escaped}\"))"
                ));
            }
            let pattern = macos_xcrun_cache_pattern(&path)?;
            // SBPL regex literals preserve regex escapes; ordinary string
            // escaping would turn an escaped path character into a backslash.
            let escaped = pattern.replace('"', "\\\"");
            let cache = macos_sandbox_path(&path.join("xcrun_db"), "toolchain cache")?;
            rules.push_str(&format!(
                "\n(allow file-read* file-write* (literal \"{cache}\") (regex #\"{escaped}\"))"
            ));
        }
    }
    let base = include_str!("macos_workspace.sbpl").replace(
        "(deny network*)",
        if files.network_access {
            ""
        } else {
            "(deny network*)"
        },
    );
    Ok(format!(
        "{base}{workspace_write_rule}{rules}\n(allow file-read* file-write* (subpath \"{escaped_temporary}\"))\n(deny mach-lookup (global-name \"{process_scope_id}\"))"
    ))
}

#[cfg(target_os = "macos")]
fn macos_user_temporary_directory() -> KernelResult<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let size = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, std::ptr::null_mut(), 0) };
    if size == 0 {
        return Err(KernelError::Other(format!(
            "Read macOS user temporary directory: {}",
            std::io::Error::last_os_error()
        )));
    }
    let mut buffer = vec![0u8; size];
    let written = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buffer.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size || buffer.last() != Some(&0) {
        return Err(KernelError::Other(
            "macOS user temporary directory changed during lookup".into(),
        ));
    }
    let path = Path::new(std::ffi::OsStr::from_bytes(&buffer[..size - 1]));
    crate::file_access::resolve_path(path)
}

#[cfg(any(target_os = "macos", test))]
fn macos_xcrun_cache_pattern(directory: &Path) -> KernelResult<String> {
    macos_sandbox_path(directory, "toolchain cache directory")?;
    let directory = directory.to_str().expect("validated UTF-8 path");
    Ok(format!(
        "^{}/xcrun_db-[^/]+$",
        regex::escape(directory.trim_end_matches('/'))
    ))
}

#[cfg(any(target_os = "macos", test))]
fn macos_sandbox_path(path: &Path, label: &str) -> KernelResult<String> {
    let path = path.to_str().ok_or_else(|| {
        KernelError::InvalidCommand(format!("bash {label} path is not valid UTF-8"))
    })?;
    if path.chars().any(char::is_control) {
        return Err(KernelError::InvalidCommand(format!(
            "bash {label} path contains control characters"
        )));
    }
    Ok(path.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod plan_scope_tests {
    use super::*;

    #[test]
    fn workspace_shell_environment_is_shared_and_uses_program_visible_paths() {
        let root = std::env::temp_dir().join(new_process_scope_id());
        let (workspace, scratch, home, cache) = (
            root.join("workspace"),
            root.join("scratch"),
            root.join("home"),
            root.join("cache"),
        );
        for path in [&workspace, &scratch] {
            fs::create_dir_all(path).unwrap();
        }
        let canonical = |path: &Path| path.canonicalize().unwrap();
        let files = crate::file_access::FileAccessScope {
            home: Some(home.clone()),
            cache: Some(cache.clone()),
            ..Default::default()
        };
        let environment = agent_shell_environment(
            Path::new("shell"),
            "workspace",
            false,
            "bin",
            &canonical(&workspace),
            &canonical(&scratch),
            &files,
        )
        .unwrap();
        assert!(environment.clear);
        let value = |key: &str| {
            environment
                .values
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };
        for key in ["TEMP", "DEEPCODE_WORKSPACE_ROOT", "HOME"] {
            let path = value(key).unwrap();
            assert!(!path.starts_with(r"\\?\"), "{key}={path}");
        }
        assert_eq!(value("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(
            value("NPM_CONFIG_CACHE"),
            Some(cache.join("npm").to_string_lossy().into_owned())
        );
        assert_eq!(
            value("CARGO_HOME"),
            Some(cache.join("cargo").to_string_lossy().into_owned())
        );
        assert!(cache.join("pip").is_dir() && home.is_dir());
        let names: Vec<_> = environment
            .values
            .iter()
            .map(|(name, _)| name.to_string_lossy().to_lowercase())
            .collect();
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert!(
            cfg!(not(windows)) || unique.len() == names.len(),
            "duplicate Windows names: {names:?}"
        );
        let host = agent_shell_environment(
            Path::new("shell"),
            "host",
            false,
            "bin",
            &canonical(&workspace),
            &canonical(&scratch),
            &files,
        )
        .unwrap();
        assert!(!host.clear);
        assert!(!host
            .values
            .iter()
            .any(|(name, _)| name == "HOME" || name == "NPM_CONFIG_CACHE"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_accepts_an_exited_group_without_resignalling_a_reaped_child() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read ready; exit 7"])
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        #[cfg(target_os = "macos")]
        assert!(!macos_process_group_has_no_live_members(child.id() as i32));
        child.stdin.take().unwrap().write_all(b"ready\n").unwrap();
        // Observe exit without reaping so the group deterministically contains a zombie.
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        let signal_result = signal_process_group(child.id(), UNIX_SIGTERM);
        let result = terminate_child(&mut child);
        let _ = child.wait();
        assert_eq!(observed, 0);
        signal_result.unwrap();
        assert_eq!(result.unwrap().code(), Some(7));
    }

    #[test]
    fn terminated_processes_report_no_exit_code() {
        let root = std::env::temp_dir().join(new_process_scope_id());
        let context = KernelToolExecutionContext {
            output_directory: Some(root.clone()),
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: Vec::new(),
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: Default::default(),
            progress: Default::default(),
        };
        let archive = || {
            let mut context = context.clone();
            context.output_directory = Some(root.join(new_process_scope_id()));
            let archive = ShellOutputArchive::create(&context).unwrap();
            archive.open("stdout").unwrap();
            archive.open("stderr").unwrap();
            archive
        };
        let empty = || CapturedOutput {
            bytes: Vec::new(),
            truncated: false,
        };
        for (timed_out, cancelled) in [(true, false), (false, true)] {
            let result = complete_shell_output(
                "call".into(),
                "bash",
                Some(1),
                Instant::now(),
                Some(1),
                timed_out,
                cancelled,
                archive(),
                empty(),
                empty(),
            )
            .unwrap();
            assert!(result.output["exitCode"].is_null());
        }
        let exited = complete_shell_output(
            "call".into(),
            "bash",
            None,
            Instant::now(),
            Some(7),
            false,
            false,
            archive(),
            empty(),
            empty(),
        )
        .unwrap();
        assert_eq!(exited.output["exitCode"], 7);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_cleanup_preserves_primary_error_and_execution_result() {
        let primary = KernelError::Structured {
            code: "tool_execution_cancelled",
            stage: "execution",
            message: "original cancellation".into(),
            details: serde_json::json!({"invocationId": "call-1"}),
        };
        let error = finish_shell_execution(
            Err(primary),
            Err(KernelError::Other(
                "remove owned directory: permission denied".into(),
            )),
        )
        .unwrap_err();
        let KernelError::Structured {
            code,
            message,
            details,
            ..
        } = error
        else {
            panic!("structured primary error lost")
        };
        assert_eq!(code, "tool_execution_cancelled");
        assert!(message.starts_with("original cancellation"));
        assert!(message.contains("remove owned directory: permission denied"));
        assert_eq!(details["invocationId"], "call-1");

        let result = known_failure(
            "call-2".into(),
            serde_json::json!({"exitCode": 7, "stderr": "native failure"}),
            "bash_exit_nonzero",
            "status 7",
        );
        let error = finish_shell_execution(
            Ok(result),
            Err(KernelError::Other("revoke write grant".into())),
        )
        .unwrap_err();
        let KernelError::Structured {
            code,
            message,
            details,
            ..
        } = error
        else {
            panic!("execution result lost")
        };
        assert_eq!(code, "shell_cleanup_failed");
        assert!(message.contains("bash_exit_nonzero"));
        assert!(message.contains("revoke write grant"));
        assert_eq!(details["executionResult"]["output"]["exitCode"], 7);
        assert_eq!(
            details["executionResult"]["output"]["stderr"],
            "native failure"
        );
    }

    #[test]
    fn workspace_policy_grants_only_the_confirmed_plan_paths() {
        let root = Path::new("/fixture/workspace");
        let temporary = Path::new("/fixture/private-temp");
        let targets = [
            WorkspaceWriteTarget {
                path: root.join("src/main.cpp"),
                directory: false,
            },
            WorkspaceWriteTarget {
                path: root.join("build"),
                directory: true,
            },
        ];
        let policy = macos_workspace_profile(
            root,
            temporary,
            "scope-test",
            "write",
            Some(&targets),
            &crate::file_access::FileAccessScope::default(),
            None,
        )
        .unwrap();
        assert!(
            policy.contains("(allow file-write* (literal \"/fixture/workspace/src/main.cpp\"))")
        );
        assert!(policy.contains("(allow file-write* (subpath \"/fixture/workspace/build\"))"));
        assert!(!policy.contains("(allow file-write* (subpath \"/fixture/workspace\"))"));
        let read = macos_workspace_profile(
            root,
            temporary,
            "scope-test",
            "read",
            Some(&targets),
            &crate::file_access::FileAccessScope::default(),
            None,
        )
        .unwrap();
        assert!(
            !read.contains("/fixture/workspace"),
            "read mode cannot gain Plan write authority"
        );
        assert!(read.contains("(allow file-read* file-write* (subpath \"/fixture/private-temp\"))"));
        assert!(read.contains("(deny network*)"));
        assert!(read.contains("(deny file-read*)"));
        assert!(read.contains("(allow file-read-data (literal \"/\"))"));
        assert!(!read.contains("(allow file-read* (subpath \"/\"))"));
        assert!(!read.contains("(allow file-read-metadata)"));
        assert!(read.contains("(allow file-read-metadata (literal \"/fixture\"))"));
        assert!(
            !read.contains("USER_TEMP_DIR"),
            "shared host temp is not an Agent resource"
        );
    }

    #[test]
    fn macos_toolchain_dependencies_preserve_absent_probes_and_limit_cache_access() {
        let files = crate::file_access::FileAccessScope {
            read: crate::file_access::macos_system_read_paths(),
            ..Default::default()
        };
        let directory = Path::new("/private/var/folders/test/user/T");
        let policy = macos_workspace_profile(
            Path::new("/fixture/workspace"),
            Path::new("/fixture/private-temp"),
            "scope-test",
            "read",
            None,
            &files,
            Some(directory),
        )
        .unwrap();
        for path in [
            "/etc/gitconfig",
            "/private/etc/gitconfig",
            "/var/select/developer_dir",
            "/private/var/select/developer_dir",
        ] {
            assert!(policy.contains(&format!("(allow file-read* (literal \"{path}\"))")));
        }
        let matcher = regex::Regex::new(&macos_xcrun_cache_pattern(directory).unwrap()).unwrap();
        assert!(policy.contains("(literal \"/private/var/folders/test/user/T/xcrun_db\")"));
        assert!(matcher.is_match("/private/var/folders/test/user/T/xcrun_db-7rNZgfpy"));
        assert!(!matcher.is_match("/private/var/folders/test/user/T/other-file"));
        assert!(!matcher.is_match("/private/var/folders/test/user/T/nested/xcrun_db"));
        assert!(!matcher.is_match("/private/var/folders/test/user/T/xcrun_db-child/nested"));
        assert!(policy.contains("^/var/folders/test/user/T/xcrun_db"));
        assert!(!policy.contains(
            "(allow file-read* file-write* (subpath \"/private/var/folders/test/user/T\"))"
        ));
        assert!(policy.contains("(regex #\"^/private/tmp/sh-thd-[0-9]+$\")"));
        assert!(!policy.contains("(subpath \"/private/tmp\")"));
        assert!(!policy.contains("(subpath \"/tmp\")"));
    }
}

struct ShellOutputArchive {
    directory: PathBuf,
    retained: bool,
}

impl ShellOutputArchive {
    fn create(context: &KernelToolExecutionContext) -> KernelResult<Self> {
        let directory = context.output_directory.clone().ok_or_else(|| {
            KernelError::Other("bash output archive directory is missing".to_string())
        })?;
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent).map_err(output_archive_error)?;
        }
        fs::create_dir(&directory).map_err(output_archive_error)?;
        Ok(Self {
            directory,
            retained: false,
        })
    }

    fn open(&self, stream: &str) -> KernelResult<fs::File> {
        fs::File::create(self.directory.join(format!("{stream}.log"))).map_err(output_archive_error)
    }

    fn finish(mut self, output: &mut Value) -> KernelResult<()> {
        {
            let mut paths = serde_json::Map::new();
            for stream in ["stdout", "stderr"] {
                let path = self.directory.join(format!("{stream}.log"));
                match fs::metadata(&path) {
                    Ok(metadata) => {
                        paths.insert(
                            stream.to_string(),
                            serde_json::json!({
                                "path": path, "bytes": metadata.len(),
                            }),
                        );
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound && stream == "stderr" => {}
                    Err(error) => return Err(output_archive_error(error)),
                }
            }
            output["fullOutput"] = Value::Object(paths);
            self.retained = true;
        }
        Ok(())
    }
}

impl Drop for ShellOutputArchive {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn output_archive_error(error: std::io::Error) -> KernelError {
    KernelError::Other(format!("bash output archive: {error}"))
}

pub(super) struct CapturedOutput {
    pub(super) bytes: Vec<u8>,
    pub(super) truncated: bool,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    mut archive: fs::File,
    max_bytes: usize,
    stop: Arc<AtomicBool>,
    progress: KernelProgressSink,
    stream: &'static str,
    _pty: bool,
) -> thread::JoinHandle<std::io::Result<CapturedOutput>> {
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut truncated = false;
        let mut offset = 0_u64;
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if stop.load(AtomicOrdering::Acquire) {
                        break;
                    }
                    thread::sleep(PROCESS_POLL_INTERVAL);
                    continue;
                }
                #[cfg(windows)]
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => break,
                #[cfg(unix)]
                Err(error) if _pty && error.raw_os_error() == Some(libc::EIO) => break,
                Err(error) => return Err(error),
            };
            if read == 0 {
                break;
            }
            archive.write_all(&chunk[..read])?;
            progress.emit(KernelToolProgress::Output {
                stream: stream.into(),
                offset,
                bytes: chunk[..read].to_vec(),
            });
            offset += read as u64;
            truncated |= append_tail(&mut captured, &chunk[..read], max_bytes);
        }
        Ok(CapturedOutput {
            bytes: captured,
            truncated,
        })
    })
}

fn append_tail(target: &mut Vec<u8>, bytes: &[u8], max_bytes: usize) -> bool {
    if bytes.len() >= max_bytes {
        let truncated = !target.is_empty() || bytes.len() > max_bytes;
        target.clear();
        target.extend_from_slice(&bytes[bytes.len() - max_bytes..]);
        return truncated;
    }
    let overflow = target
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(max_bytes);
    if overflow > 0 {
        target.drain(..overflow);
    }
    target.extend_from_slice(bytes);
    overflow > 0
}

pub(super) fn bound_combined_output(
    stdout: &mut CapturedOutput,
    stderr: &mut CapturedOutput,
    max_bytes: usize,
) {
    if stdout.bytes.len().saturating_add(stderr.bytes.len()) <= max_bytes {
        return;
    }
    let half = max_bytes / 2;
    let mut stdout_keep = stdout.bytes.len().min(half);
    let mut stderr_keep = stderr.bytes.len().min(half);
    let mut remaining = max_bytes.saturating_sub(stdout_keep + stderr_keep);
    let stdout_extra = stdout
        .bytes
        .len()
        .saturating_sub(stdout_keep)
        .min(remaining);
    stdout_keep += stdout_extra;
    remaining -= stdout_extra;
    stderr_keep += stderr
        .bytes
        .len()
        .saturating_sub(stderr_keep)
        .min(remaining);
    stdout.truncated |= retain_tail(&mut stdout.bytes, stdout_keep);
    stderr.truncated |= retain_tail(&mut stderr.bytes, stderr_keep);
}

fn retain_tail(bytes: &mut Vec<u8>, keep: usize) -> bool {
    if bytes.len() <= keep {
        return false;
    }
    let remove = bytes.len() - keep;
    bytes.drain(..remove);
    true
}

fn line_count(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
}

fn retain_tail_lines(bytes: &mut Vec<u8>, keep: usize) -> bool {
    let count = line_count(bytes);
    if count <= keep {
        return false;
    }
    if keep == 0 {
        bytes.clear();
        return true;
    }
    let start = bytes
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .nth(count - keep - 1)
        .map(|(index, _)| index + 1)
        .expect("line boundary");
    bytes.drain(..start);
    true
}

fn trim_utf8_prefix(bytes: &mut Vec<u8>) {
    let count = bytes
        .iter()
        .take_while(|byte| **byte & 0xc0 == 0x80)
        .count();
    bytes.drain(..count);
}

fn bound_output_lines(stdout: &mut CapturedOutput, stderr: &mut CapturedOutput) {
    let stdout_lines = line_count(&stdout.bytes);
    let stderr_lines = line_count(&stderr.bytes);
    let stderr_keep = stderr_lines.min(BASH_OUTPUT_LIMIT_LINES / 2);
    let stdout_keep = stdout_lines.min(BASH_OUTPUT_LIMIT_LINES - stderr_keep);
    stdout.truncated |= retain_tail_lines(&mut stdout.bytes, stdout_keep);
    stderr.truncated |= retain_tail_lines(&mut stderr.bytes, BASH_OUTPUT_LIMIT_LINES - stdout_keep);
    trim_utf8_prefix(&mut stdout.bytes);
    trim_utf8_prefix(&mut stderr.bytes);
}

#[cfg(unix)]
fn set_pipe_nonblocking(reader: &impl AsRawFd, stream: &str) -> KernelResult<()> {
    set_raw_fd_nonblocking(reader.as_raw_fd(), stream)
}

#[cfg(unix)]
fn set_raw_fd_nonblocking(fd: std::os::fd::RawFd, stream: &str) -> KernelResult<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(KernelError::Other(format!(
            "read bash {stream} pipe flags: {}",
            std::io::Error::last_os_error()
        )));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(KernelError::Other(format!(
            "set bash {stream} pipe nonblocking: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_pipe_nonblocking(_reader: &impl Read, _stream: &str) -> KernelResult<()> {
    Ok(())
}

fn join_output_reader(
    reader: thread::JoinHandle<std::io::Result<CapturedOutput>>,
    stream: &str,
) -> KernelResult<CapturedOutput> {
    reader
        .join()
        .map_err(|_| KernelError::Other(format!("bash {stream} reader panicked")))?
        .map_err(|error| KernelError::Other(format!("read bash {stream}: {error}")))
}

pub(super) fn wait_for_bounded_child(
    child: &mut Child,
    timeout: Option<Duration>,
    cancellation: &KernelCancellationToken,
) -> KernelResult<(ExitStatus, bool, bool)> {
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll bash: {error}")))?
        {
            return Ok((status, false, false));
        }
        if cancellation.is_cancelled() {
            return terminate_child(child).map(|status| (status, false, true));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return terminate_child(child).map(|status| (status, true, false));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn wait_for_bounded_pty_child(
    child: &mut PtyChildGuard,
    timeout: Option<Duration>,
    cancellation: &KernelCancellationToken,
) -> KernelResult<(portable_pty::ExitStatus, bool, bool)> {
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        if let Some(status) = child
            .child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll bash pty: {error}")))?
        {
            return Ok((status, false, false));
        }
        if cancellation.is_cancelled() {
            return child
                .terminate_and_wait()
                .map(|status| (status, false, true));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return child
                .terminate_and_wait()
                .map(|status| (status, true, false));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn terminate_child(child: &mut Child) -> KernelResult<ExitStatus> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| KernelError::Other(format!("poll bash termination: {error}")))?
    {
        return Ok(status);
    }
    signal_process_group(child.id(), UNIX_SIGTERM)?;
    let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll timed-out bash: {error}")))?
        {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
    signal_process_group(child.id(), UNIX_SIGKILL)?;
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap timed-out bash: {error}")))
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) -> KernelResult<ExitStatus> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| KernelError::Other(format!("poll bash termination: {error}")))?
    {
        return Ok(status);
    }
    child
        .kill()
        .map_err(|error| KernelError::Other(format!("terminate bash: {error}")))?;
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap timed-out bash: {error}")))
}

#[cfg(unix)]
fn terminate_remaining_process_group(process_id: u32) -> KernelResult<()> {
    let hangup = signal_process_group(process_id, UNIX_SIGHUP);
    let terminate = signal_process_group(process_id, UNIX_SIGTERM);
    thread::sleep(Duration::from_millis(10));
    let kill = signal_process_group(process_id, UNIX_SIGKILL);
    combine_shell_results(combine_shell_results(hangup, terminate), kill).map(|_| ())
}

#[cfg(target_os = "macos")]
struct ProcessScopeGuard {
    process_id: u32,
    scope_id: String,
    active: bool,
}

#[cfg(target_os = "macos")]
impl ProcessScopeGuard {
    fn new(process_id: u32, scope_id: String) -> Self {
        Self {
            process_id,
            scope_id,
            active: true,
        }
    }

    fn terminate(&mut self) -> KernelResult<()> {
        let group = terminate_remaining_process_group(self.process_id);
        let result =
            combine_shell_results(group, terminate_process_scope(&self.scope_id)).map(|_| ());
        if result.is_ok() {
            self.active = false;
        }
        result
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProcessScopeGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = terminate_remaining_process_group(self.process_id);
            let _ = terminate_process_scope(&self.scope_id);
        }
    }
}

#[cfg(target_os = "macos")]
fn terminate_process_scope(scope_id: &str) -> KernelResult<()> {
    let scope = CString::new(scope_id)
        .map_err(|_| KernelError::Other("bash scope identity contains a NUL byte".to_string()))?;
    let control = CString::new(format!("{scope_id}.control")).map_err(|_| {
        KernelError::Other("bash scope control identity contains a NUL byte".to_string())
    })?;
    let mut remaining = macos_processes_in_scope(&scope, &control)?;
    if remaining.is_empty() {
        return Ok(());
    }

    // Freeze the kernel-inherited sandbox scope before termination. A process
    // that forks just before SIGSTOP passes the same scope to its child, so
    // repeated scans close that race even after a descendant creates a new
    // Unix session or clears its environment.
    for _ in 0..4 {
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGSTOP)?;
        thread::sleep(Duration::from_millis(2));
        let next = macos_processes_in_scope(&scope, &control)?;
        if next == remaining {
            break;
        }
        remaining = next;
        if remaining.is_empty() {
            return Ok(());
        }
    }

    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGTERM)?;
    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGCONT)?;
    let term_deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        remaining = macos_processes_in_scope(&scope, &control)?;
        if remaining.is_empty() {
            return Ok(());
        }
        if Instant::now() >= term_deadline {
            break;
        }
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGTERM)?;
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGCONT)?;
        thread::sleep(PROCESS_POLL_INTERVAL);
    }

    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGKILL)?;
    let kill_deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        remaining = macos_processes_in_scope(&scope, &control)?;
        if remaining.is_empty() {
            return Ok(());
        }
        if Instant::now() >= kill_deadline {
            return Err(KernelError::Other(format!(
                "bash could not terminate scoped descendant pids: {remaining:?}"
            )));
        }
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGKILL)?;
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(target_os = "macos")]
fn macos_processes_in_scope(scope: &CStr, control: &CStr) -> KernelResult<Vec<i32>> {
    let required = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if required < 0 {
        return Err(KernelError::Other(format!(
            "list bash scope processes: {}",
            std::io::Error::last_os_error()
        )));
    }
    let capacity = usize::try_from(required)
        .unwrap_or(0)
        .saturating_mul(2)
        .saturating_add(64)
        .max(64);
    let mut pids = vec![0_i32; capacity];
    let buffer_bytes = i32::try_from(pids.len().saturating_mul(std::mem::size_of::<i32>()))
        .map_err(|_| KernelError::Other("process list buffer exceeds i32".to_string()))?;
    let returned = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), buffer_bytes) };
    if returned < 0 {
        return Err(KernelError::Other(format!(
            "read bash scope process list: {}",
            std::io::Error::last_os_error()
        )));
    }
    pids.truncate(usize::try_from(returned).unwrap_or(0).min(pids.len()));
    let daemon_pid = i32::try_from(std::process::id()).unwrap_or(-1);
    let mut scoped = Vec::new();
    for pid in pids {
        if pid > 1 && pid != daemon_pid && macos_process_has_scope(pid, scope, control)? {
            scoped.push(pid);
        }
    }
    scoped.sort_unstable();
    scoped.dedup();
    Ok(scoped)
}

#[cfg(target_os = "macos")]
fn macos_process_has_scope(pid: i32, scope: &CStr, control: &CStr) -> KernelResult<bool> {
    let filter_type = SANDBOX_FILTER_GLOBAL_NAME
        | unsafe { u32::try_from(DEEPCODE_SANDBOX_CHECK_NO_REPORT).unwrap_or(0) };
    let scope_denied = unsafe {
        deepcode_sandbox_check(
            pid,
            SANDBOX_MACH_LOOKUP_OPERATION.as_ptr().cast(),
            filter_type,
            scope.as_ptr(),
        )
    };
    if scope_denied < 0 {
        return Err(KernelError::Other(format!(
            "query bash scope for pid {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }
    if scope_denied == 0 {
        return Ok(false);
    }
    let control_allowed = unsafe {
        deepcode_sandbox_check(
            pid,
            SANDBOX_MACH_LOOKUP_OPERATION.as_ptr().cast(),
            filter_type,
            control.as_ptr(),
        )
    };
    if control_allowed < 0 {
        return Err(KernelError::Other(format!(
            "query bash scope control for pid {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }

    // macOS does not permit an already-sandboxed process to replace or stack
    // another profile: the new profile is ignored and its application fails.
    // Every surviving descendant therefore retains this exact one-rule delta.
    // The sibling control name distinguishes it from unrelated profiles that
    // deny arbitrary mach lookups; negative query results remain explicit errors.
    Ok(scope_membership_from_checks(scope_denied, control_allowed))
}

#[cfg(target_os = "macos")]
pub(super) fn scope_membership_from_checks(scope_denied: i32, control_allowed: i32) -> bool {
    scope_denied > 0 && control_allowed == 0
}

#[cfg(target_os = "macos")]
fn signal_scoped_processes(
    pids: &[i32],
    scope: &CStr,
    control: &CStr,
    signal: i32,
) -> KernelResult<()> {
    for pid in pids {
        // Recheck the immutable sandbox scope immediately before signalling so
        // PID reuse cannot target an unrelated process.
        if !macos_process_has_scope(*pid, scope, control)? {
            continue;
        }
        if unsafe { deepcode_process_kill(*pid, signal) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(KernelError::Other(format!(
                    "signal bash scoped pid {pid}: {error}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn signal_process_group(process_id: u32, signal: i32) -> KernelResult<()> {
    let process_group_id = i32::try_from(process_id)
        .map_err(|_| KernelError::Other(format!("bash process id exceeds i32: {process_id}")))?;
    if unsafe { deepcode_process_kill(-process_group_id, signal) } < 0 {
        let error = std::io::Error::last_os_error();
        // Darwin killpg can report EPERM when only zombies remain. Confirm
        // there is no live member; real denial or an unreadable group stays an error.
        #[cfg(target_os = "macos")]
        if error.raw_os_error() == Some(libc::EPERM)
            && macos_process_group_has_no_live_members(process_group_id)
        {
            return Ok(());
        }
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(KernelError::Other(format!(
                "signal bash process group {process_id}: {error}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_process_group_has_no_live_members(process_group_id: i32) -> bool {
    // libproc returns a PID count here, and returns zero both for an empty
    // group and some failures. Clear errno so absence is not inferred from failure.
    unsafe {
        *libc::__error() = 0;
    }
    let required = unsafe { libc::proc_listpgrppids(process_group_id, std::ptr::null_mut(), 0) };
    if required < 0 || (required == 0 && std::io::Error::last_os_error().raw_os_error() != Some(0))
    {
        return false;
    }
    let mut pids = vec![0_i32; required as usize + 32];
    let Ok(bytes) = i32::try_from(pids.len() * std::mem::size_of::<i32>()) else {
        return false;
    };
    unsafe {
        *libc::__error() = 0;
    }
    let count =
        unsafe { libc::proc_listpgrppids(process_group_id, pids.as_mut_ptr().cast(), bytes) };
    if count < 0
        || count as usize >= pids.len()
        || (count == 0 && std::io::Error::last_os_error().raw_os_error() != Some(0))
    {
        return false;
    }
    for pid in pids.into_iter().take(count as usize).filter(|pid| *pid > 0) {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read == size {
            let info = unsafe { info.assume_init() };
            if info.pbi_pgid == process_group_id as u32 && info.pbi_status != libc::SZOMB {
                return false;
            }
        } else if read != 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return false;
        }
    }
    true
}

#[cfg(unix)]
const UNIX_SIGHUP: i32 = 1;
#[cfg(unix)]
const UNIX_SIGKILL: i32 = 9;
#[cfg(target_os = "macos")]
const UNIX_SIGSTOP: i32 = 17;
#[cfg(unix)]
const UNIX_SIGTERM: i32 = 15;
#[cfg(target_os = "macos")]
const UNIX_SIGCONT: i32 = 19;
#[cfg(target_os = "macos")]
const SANDBOX_FILTER_GLOBAL_NAME: u32 = 2;
#[cfg(target_os = "macos")]
const SANDBOX_MACH_LOOKUP_OPERATION: &[u8] = b"mach-lookup\0";

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn deepcode_process_kill(process_id: i32, signal: i32) -> i32;
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    #[link_name = "SANDBOX_CHECK_NO_REPORT"]
    static DEEPCODE_SANDBOX_CHECK_NO_REPORT: i32;
    #[link_name = "sandbox_check"]
    fn deepcode_sandbox_check(
        process_id: i32,
        operation: *const libc::c_char,
        filter_type: u32,
        ...
    ) -> i32;
}

/// Execute an already prepared CLI command. Kernel admission belongs to its caller.
/// Plugins share the Shell runner's output, timeout and cancellation lifecycle.
pub fn execute_cli_command(
    invocation_id: String,
    mut process: Command,
    timeout_seconds: Option<u64>,
    tool_name: &str,
    context: &KernelToolExecutionContext,
    process_scope_id: Option<&str>,
) -> KernelResult<KernelToolExecutionResult> {
    #[cfg(not(target_os = "macos"))]
    let _ = process_scope_id;
    #[cfg(unix)]
    process.process_group(0);
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let archive = ShellOutputArchive::create(&context)?;
    let stdout_file = archive.open("stdout")?;
    let stderr_file = archive.open("stderr")?;
    // No instruction runs before the Job owns the process, so no descendant can
    // start outside it (the workspace LPAC runner follows the same order).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
    }
    let mut child = process.spawn().map_err(|error| {
        KernelError::Other(format!(
            "spawn {tool_name} in {}: {error}",
            process.get_program().to_string_lossy()
        ))
    })?;
    #[cfg(windows)]
    let process_job = match windows_job::ProcessJob::attach(child.id()).and_then(|job| {
        windows_job::resume_suspended(child.id())?;
        Ok(job)
    }) {
        Ok(job) => job,
        Err(error) => {
            return combine_shell_results(Err(error), terminate_child(&mut child))
                .map(|(result, _)| result);
        }
    };
    context.progress.started();
    #[cfg(unix)]
    let child_id = child.id();
    #[cfg(target_os = "macos")]
    let mut process_scope_guard =
        process_scope_id.map(|scope| ProcessScopeGuard::new(child_id, scope.to_owned()));
    #[allow(unused_mut)]
    let mut stop_process = |child: &mut Child| {
        let reaped = terminate_child(child).map(|_| ());
        #[cfg(windows)]
        let descendants = process_job.terminate();
        #[cfg(all(unix, not(target_os = "macos")))]
        let descendants = terminate_remaining_process_group(child_id);
        #[cfg(target_os = "macos")]
        let descendants = match process_scope_guard.as_mut() {
            Some(guard) => guard.terminate(),
            None => terminate_remaining_process_group(child_id),
        };
        #[cfg(not(any(unix, windows)))]
        let descendants = Ok(());
        combine_shell_results(reaped, descendants).map(|_| ())
    };
    let pipes = (|| {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| KernelError::Other("bash stdout pipe is unavailable".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| KernelError::Other("bash stderr pipe is unavailable".to_string()))?;
        set_pipe_nonblocking(&stdout, "stdout")?;
        set_pipe_nonblocking(&stderr, "stderr")?;
        Ok((stdout, stderr))
    })();
    let (stdout, stderr) = match pipes {
        Ok(pipes) => pipes,
        Err(error) => {
            return combine_shell_results(Err(error), stop_process(&mut child))
                .map(|(result, ())| result)
        }
    };
    let stop_capture = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_output_reader(
        stdout,
        stdout_file,
        BASH_OUTPUT_LIMIT_BYTES,
        Arc::clone(&stop_capture),
        context.progress.clone(),
        "stdout",
        false,
    );
    let stderr_reader = spawn_output_reader(
        stderr,
        stderr_file,
        BASH_OUTPUT_LIMIT_BYTES,
        Arc::clone(&stop_capture),
        context.progress.clone(),
        "stderr",
        false,
    );

    let wait_result = wait_for_bounded_child(
        &mut child,
        timeout_seconds.map(Duration::from_secs),
        &context.cancellation,
    );
    let process_cleanup = stop_process(&mut child);
    stop_capture.store(true, AtomicOrdering::Release);
    if let Err(cleanup) = process_cleanup {
        return shell_cleanup_failure(wait_result, cleanup);
    }

    let stdout_result = join_output_reader(stdout_reader, "stdout");
    let stderr_result = join_output_reader(stderr_reader, "stderr");

    let (stdout, stderr) = match combine_shell_results(stdout_result, stderr_result) {
        Ok(streams) => streams,
        Err(error) => return shell_cleanup_failure(wait_result, error),
    };
    let (status, timed_out, cancelled) = wait_result?;
    complete_shell_output(
        invocation_id,
        tool_name,
        timeout_seconds,
        started,
        status.code(),
        timed_out,
        cancelled,
        archive,
        stdout,
        stderr,
    )
}

fn complete_shell_output(
    invocation_id: String,
    tool_name: &str,
    timeout_seconds: Option<u64>,
    started: Instant,
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    archive: ShellOutputArchive,
    mut stdout: CapturedOutput,
    mut stderr: CapturedOutput,
) -> KernelResult<KernelToolExecutionResult> {
    bound_combined_output(&mut stdout, &mut stderr, BASH_OUTPUT_LIMIT_BYTES);
    bound_output_lines(&mut stdout, &mut stderr);
    // A process the Kernel terminated has no program exit status on any platform
    // (Windows would otherwise report the termination code 1).
    let exit_code = exit_code.filter(|_| !timed_out && !cancelled);
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let captured_bytes = stdout.bytes.len().saturating_add(stderr.bytes.len());
    let truncated = stdout.truncated || stderr.truncated;
    let success = !timed_out && !cancelled && exit_code == Some(0);

    let mut output = serde_json::json!({
        "stdout": String::from_utf8_lossy(&stdout.bytes),
        "stderr": String::from_utf8_lossy(&stderr.bytes),
        "exitCode": exit_code, "success": success, "timedOut": timed_out,
        "truncated": truncated, "capturedBytes": captured_bytes, "durationMs": duration_ms,
    });
    archive.finish(&mut output)?;
    if cancelled {
        Ok(known_failure(
            invocation_id,
            output,
            "tool_execution_cancelled",
            format!("{tool_name} was cancelled"),
        ))
    } else if success {
        Ok(ok(invocation_id, output))
    } else if timed_out {
        Ok(known_failure(
            invocation_id,
            output,
            match tool_name {
                "powershell" => "powershell_timed_out",
                "bash" => "bash_timed_out",
                _ => "process_timed_out",
            },
            format!(
                "{tool_name} command exceeded its {}-second timeout.",
                timeout_seconds.expect("timed out with a deadline")
            ),
        ))
    } else {
        Ok(known_failure(
            invocation_id,
            output,
            match tool_name {
                "powershell" => "powershell_exit_nonzero",
                "bash" => "bash_exit_nonzero",
                _ => "process_exit_nonzero",
            },
            match exit_code {
                Some(code) => format!("{tool_name} command exited with status {code}."),
                None => "Bash command terminated without an exit status.".to_string(),
            },
        ))
    }
}
