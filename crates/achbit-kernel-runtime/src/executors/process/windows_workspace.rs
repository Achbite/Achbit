//! Windows uses the same output/progress/error contract as the other platforms;
//! only process creation and termination are native LPAC operations.
use super::*;
use crate::workspace_sandbox::{unavailable, windows::Sandbox};

pub(super) fn execute(
    invocation_id: String,
    command: Command,
    timeout_seconds: Option<u64>,
    tool_name: &str,
    context: &KernelToolExecutionContext,
    root: &Path,
    mode: &str,
    temporary: &Path,
    terminal_input: Option<&str>,
) -> KernelResult<KernelToolExecutionResult> {
    let mut sandbox = Sandbox::prepare(
        root,
        mode,
        context.workspace_write_targets.as_deref(),
        temporary,
        Path::new(command.get_program()),
        &context.file_access,
    )
    .map_err(|error| unavailable(tool_name, error))?;
    let result = run(
        invocation_id,
        command,
        timeout_seconds,
        tool_name,
        context,
        terminal_input,
        &mut sandbox,
    );
    finish_shell_execution(result, sandbox.cleanup().map_err(KernelError::Other))
}

fn run(
    invocation_id: String,
    command: Command,
    timeout_seconds: Option<u64>,
    tool_name: &str,
    context: &KernelToolExecutionContext,
    terminal_input: Option<&str>,
    sandbox: &mut Sandbox,
) -> KernelResult<KernelToolExecutionResult> {
    let archive = ShellOutputArchive::create(context)?;
    let stdout_file = archive.open("stdout")?;
    let stderr_file = archive.open("stderr")?;
    let started = Instant::now();
    let terminal = terminal_input.is_some();
    let mut child = sandbox
        .spawn(&command, terminal)
        .map_err(|error| unavailable(tool_name, error))?;
    context.progress.started();
    let stop = Arc::new(AtomicBool::new(false));
    let stdout = spawn_output_reader(
        child.stdout.take().expect("LPAC stdout"),
        stdout_file,
        BASH_OUTPUT_LIMIT_BYTES,
        stop.clone(),
        context.progress.clone(),
        "stdout",
        terminal,
    );
    let stderr = child.stderr.take().map(|pipe| {
        spawn_output_reader(
            pipe,
            stderr_file,
            BASH_OUTPUT_LIMIT_BYTES,
            stop.clone(),
            context.progress.clone(),
            "stderr",
            false,
        )
    });
    let input = terminal_input.map(|text| {
        let text = text.replace("\r\n", "\n").replace('\n', "\r");
        let mut input = child.stdin.take().expect("LPAC stdin");
        thread::spawn(move || {
            input.write_all(text.as_bytes())?;
            input.flush()?;
            // Keep the input pipe alive until after process exit. Closing it
            // early would request ConPTY shutdown instead of merely sending EOF.
            Ok::<_, std::io::Error>(input)
        })
    });
    if !terminal {
        child.stdin.take();
    }
    let wait = wait(
        &child,
        timeout_seconds.map(Duration::from_secs),
        &context.cancellation,
    );
    if let Err(error) = child.stop().map_err(KernelError::Other) {
        return shell_cleanup_failure(wait, error);
    }
    child.close_console();
    stop.store(true, AtomicOrdering::Release);
    let input_result = match input {
        Some(input) => input
            .join()
            .map_err(|_| KernelError::Other("Shell input writer panicked".into()))
            .and_then(|result| {
                result
                    .map(|_| ())
                    .map_err(|error| KernelError::Other(format!("Write Shell input: {error}")))
            }),
        None => Ok(()),
    };
    let stdout = join_output_reader(stdout, "stdout");
    let stderr = match stderr {
        Some(reader) => join_output_reader(reader, "stderr"),
        None => Ok(CapturedOutput {
            bytes: Vec::new(),
            truncated: false,
        }),
    };
    let ((stdout, stderr), ()) =
        match combine_shell_results(combine_shell_results(stdout, stderr), input_result) {
            Ok(streams) => streams,
            Err(error) => return shell_cleanup_failure(wait, error),
        };
    let status = wait?;
    let mut result = complete_shell_output(
        invocation_id,
        tool_name,
        timeout_seconds,
        started,
        Some(status.0),
        status.1,
        status.2,
        archive,
        stdout,
        stderr,
    )?;
    if !sandbox.warnings().is_empty() {
        if let Some(output) = result.output.as_object_mut() {
            output.insert("sandboxWarnings".into(), sandbox.warnings().into());
        }
    }
    Ok(result)
}

fn wait(
    child: &crate::workspace_sandbox::windows::Child,
    timeout: Option<Duration>,
    cancellation: &KernelCancellationToken,
) -> KernelResult<(i32, bool, bool)> {
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        if let Some(code) = child.poll().map_err(KernelError::Other)? {
            return Ok((code, false, false));
        }
        if cancellation.is_cancelled() {
            return Ok((1, false, true));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Ok((1, true, false));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(new_process_scope_id());
            for path in ["workspace/.git", "scratch", "home"] {
                fs::create_dir_all(root.join(path)).unwrap();
            }
            fs::write(root.join("workspace/README.txt"), "workspace-readable").unwrap();
            fs::write(root.join("workspace/.git/config"), "protected").unwrap();
            fs::write(root.join("private.txt"), "outside-private-data").unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn context(&self) -> KernelToolExecutionContext {
            let root = self.0.join("workspace");
            let mut files = crate::file_access::FileAccessScope::workspace(&root).unwrap();
            files.home = Some(self.0.join("home"));
            KernelToolExecutionContext {
                output_directory: Some(self.0.join(new_process_scope_id())),
                workspace_root: Some(root.to_string_lossy().into_owned()),
                workspace_id: Some("test".into()),
                private_resolved_targets: Vec::new(),
                workspace_write_targets: None,
                file_access: files,
                cancellation: Default::default(),
                progress: Default::default(),
            }
        }
        fn run(
            &self,
            script: &str,
            mode: &str,
            timeout: Option<u64>,
            context: &KernelToolExecutionContext,
        ) -> KernelToolExecutionResult {
            self.try_run(script, mode, timeout, context).unwrap()
        }
        fn try_run(
            &self,
            script: &str,
            mode: &str,
            timeout: Option<u64>,
            context: &KernelToolExecutionContext,
        ) -> KernelResult<KernelToolExecutionResult> {
            let mut context = context.clone();
            context.output_directory = Some(self.0.join(new_process_scope_id()));
            let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
            let mut command = Command::new(system.join("System32/cmd.exe"));
            command
                .args(["/d", "/c", script])
                .current_dir(self.0.join("workspace"))
                .env_clear()
                .env("SystemRoot", system)
                .env("LOCALAPPDATA", self.0.join("home"))
                .env("TEMP", self.0.join("scratch"))
                .env("TMP", self.0.join("scratch"));
            execute(
                "native-windows-test".into(),
                command,
                timeout,
                "powershell",
                &context,
                &self.0.join("workspace"),
                mode,
                &self.0.join("scratch"),
                None,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn windows_powershell_uses_and_cleans_the_kernel_scratch_directory() {
        let fixture = Fixture::new();
        let program = crate::shell_environment::discover("powershell").unwrap();
        let path = crate::shell_environment::resolved_agent_shell_path()
            .unwrap()
            .into_string()
            .unwrap();
        let command = r#"$ErrorActionPreference = 'Stop'
if ($env:TEMP -ne $env:TMPDIR -or $env:TMP -ne $env:TMPDIR) { throw 'TEMP scope changed during startup' }
$file = Join-Path $env:TEMP 'scratch-中文.txt'
[IO.File]::WriteAllText($file, 'scratch-中文')
Write-Output $env:TEMP
Get-Content -LiteralPath $file -Encoding UTF8
try {
    [IO.File]::WriteAllText((Join-Path $PWD 'blocked.txt'), 'unexpected')
    throw 'Project write was allowed'
} catch [UnauthorizedAccessException] { Write-Output 'project-write-denied' }
"#;
        let invocation = crate::executors::tests::invocation(
            "native-powershell-scratch-test",
            "powershell",
            serde_json::json!({"command": command, "workspaceMode": "read", "executionScope": "workspace", "timeout": 30}),
        );
        let mut context = fixture.context();
        context.private_resolved_targets = vec![context.workspace_root.clone().unwrap()];
        context
            .file_access
            .read
            .push(program.executable.parent().unwrap().to_path_buf());
        let result = invoke_shell(
            invocation,
            context,
            Some(&program),
            Some(&path),
            Some(&fixture.0.join("scratch")),
        )
        .unwrap();
        assert_eq!(result.output["success"], true, "{}", result.output);
        let stdout = result.output["stdout"].as_str().unwrap();
        let scratch = result.output["paths"]["scratch"].as_str().unwrap();
        assert!(stdout.contains(scratch), "{stdout}");
        assert!(stdout.contains("scratch-中文"), "{stdout}");
        assert!(stdout.contains("project-write-denied"), "{stdout}");
        assert!(
            !Path::new(scratch).exists(),
            "invocation scratch must be removed"
        );
        assert!(!fixture.0.join("workspace/blocked.txt").exists());
    }

    #[test]
    fn persistent_grants_serve_only_shells_admitted_to_that_path() {
        let fixture = Fixture::new();
        let shared = fixture.0.join("shared");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("data.txt"), "shared-data").unwrap();
        let admitted = || {
            let mut context = fixture.context();
            context.file_access.read.push(shared.clone());
            context
        };
        let visible = crate::file_access::process_visible_path(&shared.join("data.txt"));
        // The runner escapes inner quotes for argv, which cmd does not parse;
        // the fixture path contains no spaces.
        let script = format!("type {}", visible.display());
        for _ in 0..2 {
            // The second invocation reuses the ACE written by the first.
            let read = fixture.run(&script, "read", Some(10), &admitted());
            assert_eq!(read.output["success"], true, "{}", read.output);
            assert!(read.output["stdout"]
                .as_str()
                .unwrap()
                .contains("shared-data"));
        }
        let denied = fixture.run(&script, "read", Some(10), &fixture.context());
        assert_eq!(
            denied.output["success"], false,
            "a persistent ACE must not leak"
        );
        assert!(!denied.output["stdout"]
            .as_str()
            .unwrap()
            .contains("shared-data"));
        let mut writer = fixture.context();
        writer.file_access.write.push(WorkspaceWriteTarget {
            path: shared.clone(),
            directory: true,
        });
        let write = format!("echo changed>{}", visible.display());
        assert_eq!(
            fixture.run(&write, "read", Some(10), &writer).output["success"],
            true
        );
        // Read access to the same path does not include its write capability.
        let reader = fixture.run(
            &write.replace("changed", "again"),
            "read",
            Some(10),
            &admitted(),
        );
        assert_eq!(reader.output["success"], false);
        assert!(fs::read_to_string(shared.join("data.txt"))
            .unwrap()
            .contains("changed"));
    }

    #[test]
    fn an_ungrantable_startup_root_is_skipped_but_a_required_one_fails() {
        let fixture = Fixture::new();
        let locked = fixture.0.join("locked-tools");
        fs::create_dir_all(&locked).unwrap();
        // Explicit volume grants may survive /inheritance:r. Deny WRITE_DAC to
        // Everyone so even an elevated owner cannot add an ACE.
        let status = Command::new("icacls")
            .arg(&locked)
            .args([
                "/inheritance:r",
                "/grant:r",
                "*S-1-3-4:(OI)(CI)(RX)",
                "/deny",
                "*S-1-1-0:(WDAC)",
            ])
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stdout)
        );
        let mut context = fixture.context();
        context.file_access.read.push(locked.clone());
        context.file_access.best_effort_read.push(locked.clone());
        let skipped = fixture.run("echo started", "read", Some(10), &context);
        assert_eq!(skipped.output["success"], true, "{}", skipped.output);
        let warnings = skipped.output["sandboxWarnings"].to_string();
        assert!(warnings.contains("locked-tools"), "{warnings}");
        context.file_access.best_effort_read.clear();
        let failed = fixture.try_run("echo started", "read", Some(10), &context);
        assert!(failed.is_err(), "a required grant must not be skipped");
    }

    #[test]
    fn windows_lpac_enforces_admitted_files_and_preserves_exit_status() {
        let fixture = Fixture::new();
        // The fixture names cmd.exe with a forward slash ("System32/cmd.exe"),
        // which cmd itself would parse as switches unless the runner normalizes it.
        let read = fixture.run("type README.txt", "read", Some(10), &fixture.context());
        assert_eq!(read.output["success"], true, "{}", read.output);
        assert!(read.output["stdout"]
            .as_str()
            .unwrap()
            .contains("workspace-readable"));
        let denied = fixture.run("type ..\\private.txt", "read", Some(10), &fixture.context());
        assert_eq!(denied.output["success"], false);
        assert!(!denied.output["stdout"]
            .as_str()
            .unwrap()
            .contains("outside-private-data"));
        let denied = fixture.run(
            "echo unexpected>README.txt",
            "read",
            Some(10),
            &fixture.context(),
        );
        assert_eq!(denied.output["success"], false);
        assert_eq!(
            fs::read_to_string(fixture.0.join("workspace/README.txt")).unwrap(),
            "workspace-readable"
        );
        let mut context = fixture.context();
        context.workspace_write_targets = Some(vec![WorkspaceWriteTarget {
            path: fixture.0.join("workspace/output"),
            directory: true,
        }]);
        assert_eq!(
            fixture
                .run(
                    "echo generated>output\\result.txt",
                    "write",
                    Some(10),
                    &context
                )
                .output["success"],
            true
        );
        assert!(
            fs::read_to_string(fixture.0.join("workspace/output/result.txt"))
                .unwrap()
                .contains("generated")
        );
        // A scope that would write the ancestor of .git is refused before launch.
        let rejected = fixture
            .try_run(
                "echo unexpected>.git\\config",
                "write",
                Some(10),
                &fixture.context(),
            )
            .unwrap_err();
        assert!(rejected.to_string().contains("protected"), "{rejected}");
        assert_eq!(
            fixture
                .run("echo unexpected>.git\\config", "write", Some(10), &context)
                .output["success"],
            false
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("workspace/.git/config")).unwrap(),
            "protected"
        );
        // Prior output grants must not allow a later read-only Shell to write project files.
        let reader = fixture.run("echo late>README.txt", "read", Some(10), &fixture.context());
        assert_eq!(reader.output["success"], false, "{}", reader.output);
        let mut context = fixture.context();
        context.file_access.write.push(WorkspaceWriteTarget {
            path: fixture.0.join("workspace/.git/config"),
            directory: false,
        });
        assert_eq!(
            fixture
                .run("echo approved>.git\\config", "read", Some(10), &context)
                .output["success"],
            true
        );
        // The persistent exception ACE serves only Shells that carry its approval.
        let unapproved = fixture.run(
            "echo again>.git\\config",
            "read",
            Some(10),
            &fixture.context(),
        );
        assert_eq!(unapproved.output["success"], false, "{}", unapproved.output);
        // An explicit directory resource capability serves only the admitted Shell.
        let mut context = fixture.context();
        context.file_access.write.push(WorkspaceWriteTarget {
            path: fixture.0.join("workspace/.git"),
            directory: true,
        });
        let approved = fixture.run("echo hook>.git\\hook.txt", "read", Some(10), &context);
        assert_eq!(approved.output["success"], true, "{}", approved.output);
        let again = fixture.run(
            "echo hook>.git\\other.txt",
            "read",
            Some(10),
            &fixture.context(),
        );
        assert_eq!(again.output["success"], false, "{}", again.output);
        assert!(!fixture.0.join("workspace/.git/other.txt").exists());
        let nonzero = fixture.run("exit /b 7", "read", Some(10), &fixture.context());
        assert_eq!(nonzero.output["exitCode"], 7);
        assert_eq!(nonzero.error.unwrap().code, "powershell_exit_nonzero");
    }

    #[test]
    fn windows_lpac_timeout_and_cancellation_keep_their_failure_facts() {
        let fixture = Fixture::new();
        let timeout = fixture.run(
            "for /L %i in (0,0,1) do @rem wait",
            "read",
            Some(1),
            &fixture.context(),
        );
        assert_eq!(timeout.output["timedOut"], true);
        assert_eq!(timeout.error.unwrap().code, "powershell_timed_out");
        let mut context = fixture.context();
        let cancellation = context.cancellation.clone();
        context.progress = KernelProgressSink::new(move |progress| {
            if matches!(progress, KernelToolProgress::Started { .. }) {
                cancellation.cancel();
            }
        });
        let cancelled = fixture.run("for /L %i in (0,0,1) do @rem wait", "read", None, &context);
        assert_eq!(cancelled.output["timedOut"], false);
        assert_eq!(cancelled.error.unwrap().code, "tool_execution_cancelled");
    }
}
