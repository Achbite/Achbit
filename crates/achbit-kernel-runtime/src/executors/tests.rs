use super::*;

pub(super) fn invocation(id: impl Into<String>, tool: &str, input: Value) -> KernelToolInvocation {
    // Execution mode/scope are prepared Kernel facts, not Provider input.
    let input: KernelCanonicalInvocation = if matches!(tool, "bash" | "powershell") {
        serde_json::from_value(serde_json::json!({"toolId": tool, "arguments": input})).unwrap()
    } else {
        KernelToolRegistry::default()
            .canonicalize(tool, input)
            .unwrap()
    };
    input.validate().unwrap();
    KernelToolInvocation {
        id: id.into(),
        input,
    }
}

#[cfg(unix)]
fn shell_executor() -> ConfiguredShellExecutor {
    ConfiguredShellExecutor {
        sandbox_backends: Default::default(),
        temporary_root: None,
        program: Some(
            crate::shell_environment::discover("bash").expect("fixture Bash environment"),
        ),
        execution_path: Some(
            crate::shell_environment::resolved_agent_shell_path()
                .unwrap()
                .into_string()
                .unwrap(),
        ),
    }
}

#[cfg(unix)]
#[test]
fn shell_progress_precedes_completion_and_keeps_full_archive() {
    let workspace = TempWorkspace::new("shell-progress");
    let mut context = context_with_target(&workspace.0, ".");
    let cancel = context.cancellation.clone();
    let (send, receive) = std::sync::mpsc::channel();
    context.progress = KernelProgressSink::new(move |event| {
        let _ = send.send(event);
    });
    let task = std::thread::spawn(move || {
        shell_executor().invoke(invocation("progress", "bash", serde_json::json!({"command":"printf 'before'; printf 'diagnostic' >&2; while [ ! -f finish ]; do sleep 0.05; done", "workspaceMode":"read", "executionScope":"host", "timeout":15})), context)
    });
    let started = receive.recv_timeout(std::time::Duration::from_secs(5));
    if !matches!(started, Ok(KernelToolProgress::Started { .. })) {
        cancel.cancel();
        let result = task.join();
        panic!("missing started: {started:?}, {result:?}");
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    while stdout.is_empty() || stderr.is_empty() {
        match receive.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(KernelToolProgress::Output {
                stream,
                offset,
                bytes,
            }) => {
                let output = if stream == "stdout" {
                    &mut stdout
                } else {
                    &mut stderr
                };
                assert_eq!(offset, output.len() as u64);
                output.extend(bytes);
            }
            other => {
                cancel.cancel();
                let _ = task.join();
                panic!("missing output: {other:?}");
            }
        }
    }
    assert!(
        !task.is_finished(),
        "output must arrive while the command is running"
    );
    fs::write(workspace.0.join("finish"), "release").unwrap();
    let result = task.join().unwrap().unwrap();
    assert_eq!(stdout, b"before");
    assert_eq!(stderr, b"diagnostic");
    for (stream, expected) in [("stdout", stdout), ("stderr", stderr)] {
        let path = result.output["fullOutput"][stream]["path"]
            .as_str()
            .expect("complete archive reference");
        assert_eq!(fs::read(path).unwrap(), expected);
    }
}

#[test]
fn workspace_shell_routes_through_registered_backend_and_never_falls_back() {
    use crate::workspace_sandbox::{
        SandboxBackend, SandboxBackendRegistry, SandboxProcessRequest, SandboxStatus,
    };
    struct Backend(Arc<std::sync::atomic::AtomicUsize>);
    impl SandboxBackend for Backend {
        fn id(&self) -> &str {
            "test-isolation"
        }
        fn probe(&self) -> SandboxStatus {
            SandboxStatus {
                backend: self.id().into(),
                available: true,
                reason: None,
            }
        }
        fn execute(
            &self,
            request: SandboxProcessRequest<'_>,
        ) -> KernelResult<KernelToolExecutionResult> {
            assert_eq!(
                request.context.file_access.sandbox_backend.as_deref(),
                Some(self.id())
            );
            assert!(request.context.cancellation.is_cancelled());
            self.0.fetch_add(1, AtomicOrdering::SeqCst);
            Err(KernelError::Structured {
                code: "fixture_cancelled",
                stage: "execution",
                message: "cancelled".into(),
                details: serde_json::json!({}),
            })
        }
    }
    let workspace = TempWorkspace::new("registered-sandbox");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let executor = ConfiguredShellExecutor {
        program: None,
        execution_path: None,
        temporary_root: None,
        sandbox_backends: Arc::new(
            SandboxBackendRegistry::new(vec![Box::new(Backend(calls.clone()))]).unwrap(),
        ),
    };
    let mut context = context_with_target(&workspace.0, ".");
    context.file_access.sandbox_backend = Some("test-isolation".into());
    context.cancellation.cancel();
    let shell = || {
        invocation(
            "registered",
            "bash",
            serde_json::json!({"command":"echo must-not-run","workspaceMode":"read","executionScope":"workspace","timeout":1}),
        )
    };
    assert!(matches!(
        executor.invoke(shell(), context.clone()),
        Err(KernelError::Structured {
            code: "fixture_cancelled",
            ..
        })
    ));
    context.file_access.sandbox_backend = Some("missing".into());
    assert!(matches!(
        executor.invoke(shell(), context),
        Err(KernelError::Structured {
            code: "sandbox_backend_unavailable",
            ..
        })
    ));
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
}

#[test]
fn edit_preview_exposes_line_joins_without_changing_requested_text() {
    let original = "# script\necho ready\nif true; then\n  echo done\nfi\n";
    let patch = apply_exact_text_edits(
        original,
        &serde_json::from_value::<Vec<KernelTextEdit>>(serde_json::json!([
            {"oldText":"echo ready\n", "newText":"echo ready"},
            {"oldText":"echo done", "newText":"echo 完成"}
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        patch.updated,
        "# script\necho readyif true; then\n  echo 完成\nfi\n"
    );
    assert_eq!(
        patch.preview["hunks"][0]["before"],
        "echo ready\nif true; then\n"
    );
    assert_eq!(
        patch.preview["hunks"][0]["after"],
        "echo readyif true; then\n"
    );
    assert_eq!(patch.preview["hunks"][1]["newStartLine"], 3);
    assert_eq!(patch.preview["hunks"][1]["after"], "  echo 完成\n");
    assert_eq!(patch.preview["truncated"], false);
    let long = "字".repeat(5000);
    let patch = apply_exact_text_edits(
        &long,
        &serde_json::from_value::<Vec<KernelTextEdit>>(serde_json::json!([
            {"oldText":long, "newText":"replacement"}
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(patch.updated, "replacement");
    assert_eq!(patch.preview["truncated"], true);
    assert!(
        patch.preview["hunks"][0]["before"]
            .as_str()
            .unwrap()
            .chars()
            .count()
            <= 2048
    );
}

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "achbit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn context_with_target(root: &Path, relative_path: &str) -> KernelToolExecutionContext {
    let canonical_root = root.canonicalize().expect("canonical test workspace");
    KernelToolExecutionContext {
        output_directory: Some(canonical_root.join(format!(
                "kernel-output-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))),
        workspace_root: Some(canonical_root.to_string_lossy().to_string()),
        workspace_id: Some("workspace:test".to_string()),
        workspace_write_targets: None,
        file_access: crate::file_access::FileAccessScope::workspace(&canonical_root).unwrap(),
        private_resolved_targets: vec![canonical_root
            .join(relative_path)
            .to_string_lossy()
            .to_string()],
        cancellation: KernelCancellationToken::default(),
        progress: Default::default(),
    }
}

#[test]
fn builtin_registry_executes_a_prepared_file_read() {
    let workspace = TempWorkspace::new("registry-read");
    fs::write(workspace.0.join("README.md"), "Achbit\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));

    let result = registry
        .invoke(
            invocation(
                "invocation:read",
                "fs.read",
                serde_json::json!({ "path": "README.md" }),
            ),
            context_with_target(&workspace.0, "README.md"),
        )
        .expect("registered fs.read executes against the prepared target");

    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert_eq!(result.output["path"], "README.md");
    assert_eq!(result.output["content"], "Achbit\n");
}

#[test]
fn builtin_registry_rejects_a_cancelled_attempt_before_execution() {
    let workspace = TempWorkspace::new("registry-cancelled");
    fs::write(workspace.0.join("README.md"), "Achbit\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let context = context_with_target(&workspace.0, "README.md");
    context.cancellation.cancel();

    let error = registry
        .invoke(
            invocation(
                "invocation:cancelled-read",
                "fs.read",
                serde_json::json!({ "path": "README.md" }),
            ),
            context,
        )
        .expect_err("cancelled attempt must not enter the executor");
    assert!(matches!(
        error,
        KernelError::Structured {
            code: "tool_execution_cancelled",
            ..
        }
    ));
}

#[test]
fn fs_write_creates_missing_parent_directories_and_replaces_existing_files() {
    let workspace = TempWorkspace::new("write-parents");
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let relative = "src/generated/main.rs";

    let create = tool_registry
        .canonicalize(
            "fs.write",
            serde_json::json!({
                "path": relative,
                "content": "fn main() {}\n"
            }),
        )
        .expect("canonical write");
    let created = registry
        .invoke(
            KernelToolInvocation {
                id: "invocation:create-nested".to_string(),
                input: create,
            },
            context_with_target(&workspace.0, relative),
        )
        .expect("fs.write creates nested parents");
    assert_eq!(created.output["created"], true);
    assert_eq!(
        fs::read_to_string(workspace.0.join(relative)).unwrap(),
        "fn main() {}\n"
    );

    let replace = tool_registry
        .canonicalize(
            "fs.write",
            serde_json::json!({
                "path": relative,
                "content": "fn main() { println!(\"ready\"); }\n"
            }),
        )
        .expect("canonical replacement");
    let replaced = registry
        .invoke(
            KernelToolInvocation {
                id: "invocation:replace-existing".to_string(),
                input: replace,
            },
            context_with_target(&workspace.0, relative),
        )
        .expect("fs.write replaces existing file");
    assert_eq!(replaced.output["created"], false);
    assert_eq!(
        fs::read_to_string(workspace.0.join(relative)).unwrap(),
        "fn main() { println!(\"ready\"); }\n"
    );
}

#[test]
fn fs_edit_validates_every_range_before_the_atomic_write() {
    let workspace = TempWorkspace::new("exact-edit");
    let path = workspace.0.join("README.md");
    fs::write(&path, "alpha beta gamma\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));

    let overlapping = tool_registry
        .canonicalize(
            "fs.edit",
            serde_json::json!({
                "path": "README.md",
                "edits": [
                    { "oldText": "alpha beta", "newText": "first" },
                    { "oldText": "beta gamma", "newText": "second" }
                ]
            }),
        )
        .expect("canonical edit");
    let error = registry
        .invoke(
            KernelToolInvocation {
                id: "invocation:overlapping-edit".to_string(),
                input: overlapping,
            },
            context_with_target(&workspace.0, "README.md"),
        )
        .expect_err("overlapping edits must fail before writing");
    assert!(matches!(
        error,
        KernelError::Structured {
            code: "edit_ranges_overlap",
            ..
        }
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "alpha beta gamma\n");

    let exact = tool_registry
        .canonicalize(
            "fs.edit",
            serde_json::json!({
                "path": "README.md",
                "edits": [
                    { "oldText": "alpha", "newText": "first" },
                    { "oldText": "gamma", "newText": "third" }
                ]
            }),
        )
        .expect("canonical exact edit");
    registry
        .invoke(
            KernelToolInvocation {
                id: "invocation:exact-edit".to_string(),
                input: exact,
            },
            context_with_target(&workspace.0, "README.md"),
        )
        .expect("non-overlapping exact edits execute");
    assert_eq!(fs::read_to_string(path).unwrap(), "first beta third\n");
}

#[cfg(unix)]
#[test]
fn cancelled_child_is_reaped_before_wait_returns() {
    use std::os::unix::process::CommandExt as _;

    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("sleep 30").process_group(0);
    let mut child = command.spawn().expect("spawn cancellable process group");
    let cancellation = KernelCancellationToken::default();
    cancellation.cancel();

    let (_status, timed_out, cancelled) =
        wait_for_bounded_child(&mut child, None, &cancellation).expect("cancel and reap child");
    assert!(!timed_out);
    assert!(cancelled);
    assert!(child.try_wait().expect("poll reaped child").is_some());
}

#[cfg(target_os = "macos")]
#[test]
fn bash_executes_in_the_bound_workspace_and_reports_environment() {
    let workspace = TempWorkspace::new("bash-workspace");
    fs::create_dir_all(workspace.0.join("build")).unwrap();
    let result = shell_executor()
        .invoke(
            invocation("bash-workspace", "bash", serde_json::json!({
                    "command": "cd build && printf 'stdout-value' && printf 'generated' > generated.txt",
                    "workspaceMode": "write",
                    "executionScope": "workspace",
                    "timeout": 5
                })),
            context_with_target(&workspace.0, "."),
        )
        .expect("bash command executes in its bound workspace");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert_eq!(result.output["cwd"], ".");
    assert_eq!(result.output["workspaceMode"], "write");
    assert_eq!(result.output["executionScope"], "workspace");
    assert_eq!(result.output["terminal"], false);
    assert_eq!(result.output["exitCode"], 0, "{:?}", result.output);
    assert_eq!(result.output["success"], true, "{:?}", result.output);
    assert_eq!(
        result.output["stdout"], "stdout-value",
        "{:?}",
        result.output
    );
    assert_eq!(result.output["environment"]["shell"], "/bin/bash");
    assert_eq!(result.output["environment"]["interactive"], false);
    assert_eq!(result.output["environment"]["executionScope"], "workspace");
    assert_eq!(result.output["environment"]["terminal"], false);
    assert_eq!(
        result.output["environment"]["pathSource"],
        "preparedRunEnvironment"
    );
    assert_eq!(
        result.output["environment"]["writeScope"],
        "authorizedResources"
    );
    assert_eq!(result.output["environment"]["homeWritable"], true);
    assert_eq!(result.output["environment"]["networkAccess"], false);
    assert_eq!(
        fs::read_to_string(workspace.0.join("build/generated.txt")).unwrap(),
        "generated"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bash_cleans_its_owned_temporary_directory() {
    let workspace = TempWorkspace::new("bash-temporary");
    let result = shell_executor()
        .invoke(
            invocation(
                "bash-temporary",
                "bash",
                serde_json::json!({
                    "command": "printf '%s' \"$TMPDIR\"; printf temporary > \"$TMPDIR/owned.txt\"",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 5
                }),
            ),
            context_with_target(&workspace.0, "."),
        )
        .expect("process shell temporary directory is writable");

    assert_eq!(result.output["exitCode"], 0, "{:?}", result.output);
    assert_eq!(result.output["success"], true, "{:?}", result.output);
    assert_eq!(result.output["workspaceMode"], "read");
    assert_eq!(
        result.output["environment"]["writeScope"],
        "authorizedResources"
    );
    assert_eq!(result.output["environment"]["networkAccess"], false);
    let temporary = result.output["stdout"]
        .as_str()
        .expect("temporary directory is reported");
    assert!(temporary.contains("achbit-agent-shell-"));
    assert!(!Path::new(temporary).exists());
}

#[cfg(target_os = "macos")]
#[test]
fn bash_nonzero_exit_is_a_known_failure_with_structured_output() {
    let workspace = TempWorkspace::new("bash-nonzero");
    let result = shell_executor()
        .invoke(
            invocation(
                "bash-nonzero",
                "bash",
                serde_json::json!({
                    "command": "printf 'stdout-value'; printf 'stderr-value' >&2; exit 7",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 5
                }),
            ),
            context_with_target(&workspace.0, "."),
        )
        .expect("known Bash failure retains its execution result");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
    assert_eq!(result.output["exitCode"], 7);
    assert_eq!(result.output["success"], false);
    assert_eq!(result.output["stdout"], "stdout-value");
    assert_eq!(result.output["stderr"], "stderr-value");
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("bash_exit_nonzero")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bash_timeout_is_a_known_failure_and_releases_its_temporary_directory() {
    let workspace = TempWorkspace::new("bash-timeout");
    let result = shell_executor()
        .invoke(
            invocation(
                "bash-timeout",
                "bash",
                serde_json::json!({
                    "command": "printf '%s' \"$TMPDIR\"; sleep 2",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 1
                }),
            ),
            context_with_target(&workspace.0, "."),
        )
        .expect("timed-out Bash call retains its known execution result");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
    assert_eq!(result.output["success"], false);
    assert_eq!(result.output["timedOut"], true);
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("bash_timed_out")
    );
    let temporary = result.output["stdout"]
        .as_str()
        .expect("temporary directory is reported before timeout");
    assert!(temporary.contains("achbit-agent-shell-"));
    assert!(!Path::new(temporary).exists());
}

#[cfg(unix)]
#[test]
fn bash_host_scope_reports_the_host_execution_boundary() {
    let workspace = TempWorkspace::new("bash-host");
    let result = shell_executor()
        .invoke(
            invocation(
                "bash-host",
                "bash",
                serde_json::json!({
                    "command": "printf 'host-scope'",
                    "workspaceMode": "read",
                    "executionScope": "host",
                    "timeout": 5
                }),
            ),
            context_with_target(&workspace.0, "."),
        )
        .expect("host Bash executes from the bound workspace");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["stdout"], "host-scope");
    assert_eq!(result.output["executionScope"], "host");
    assert_eq!(result.output["terminal"], false);
    assert_eq!(result.output["environment"]["interactive"], false);
    assert_eq!(result.output["environment"]["executionScope"], "host");
    assert_eq!(result.output["environment"]["terminal"], false);
    assert_eq!(result.output["environment"]["writeScope"], "hostUser");
    assert_eq!(result.output["environment"]["homeWritable"], true);
    assert_eq!(result.output["environment"]["networkAccess"], true);
}

#[cfg(unix)]
#[test]
fn host_shell_pipe_and_pty_share_owned_temp_lifetime() {
    for (terminal, exit_code) in [(false, 0), (true, 7)] {
        let workspace = TempWorkspace::new("host-shell-owned-temp");
        let mut arguments = serde_json::json!({
            "command": format!("test \"$TMPDIR\" = \"$TMP\" && test \"$TMPDIR\" = \"$TEMP\" || exit 99; printf temporary > \"$TMPDIR/owned.txt\"; printf '%s' \"$TMPDIR\"; exit {exit_code}"),
            "workspaceMode": "read", "executionScope": "host", "timeout": 5
        });
        if terminal {
            arguments["terminal"] = serde_json::json!({"stdin": ""});
        }
        let result = shell_executor()
            .invoke(
                invocation("host-temp", "bash", arguments),
                context_with_target(&workspace.0, "."),
            )
            .unwrap();
        assert_eq!(result.output["exitCode"], exit_code);
        assert_eq!(result.output["terminal"], terminal);
        let temporary = result.output["stdout"].as_str().unwrap();
        assert!(temporary.contains("achbit-agent-shell-"), "{temporary}");
        assert!(!Path::new(temporary).exists());
        if exit_code != 0 {
            assert_eq!(result.error.unwrap().code, "bash_exit_nonzero");
        }
    }
}

#[cfg(unix)]
#[test]
fn host_shell_cancellation_releases_pipe_and_pty_temporary_directories() {
    for terminal in [false, true] {
        let workspace = TempWorkspace::new("host-shell-cancel-temp");
        let mut context = context_with_target(&workspace.0, ".");
        let cancellation = context.cancellation.clone();
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = captured.clone();
        context.progress = KernelProgressSink::new(move |event| {
            if let KernelToolProgress::Output { bytes, .. } = event {
                let mut captured = output.lock().unwrap();
                captured.extend(bytes);
                if captured.last() == Some(&b'\n')
                    && String::from_utf8_lossy(&captured).contains("achbit-agent-shell-")
                {
                    cancellation.cancel();
                }
            }
        });
        let mut arguments = serde_json::json!({
            "command": "printf temporary > \"$TMPDIR/owned.txt\"; printf '%s\\n' \"$TMPDIR\"; sleep 20",
            "workspaceMode": "read", "executionScope": "host", "timeout": 5
        });
        if terminal {
            arguments["terminal"] = serde_json::json!({"stdin": ""});
        }
        let result = shell_executor()
            .invoke(invocation("host-cancel", "bash", arguments), context)
            .unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
        assert_eq!(result.error.unwrap().code, "tool_execution_cancelled");
        assert_eq!(result.output["success"], false);
        let archive = result.output["fullOutput"]["stdout"]["path"]
            .as_str()
            .unwrap();
        assert!(fs::read_to_string(archive)
            .unwrap()
            .contains("achbit-agent-shell-"));
        let output = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        let temporary = output
            .lines()
            .find(|line| line.contains("achbit-agent-shell-"))
            .expect("owned directory emitted before cancellation");
        assert!(!Path::new(temporary).exists());
    }
}

#[cfg(unix)]
#[test]
fn bash_terminal_writes_exact_bounded_input_to_one_call_pty() {
    let workspace = TempWorkspace::new("bash-terminal");
    let result = shell_executor()
        .invoke(
            invocation("bash-terminal", "bash", serde_json::json!({
                    "command": "IFS= read -r value; if [ -t 0 ]; then tty=yes; else tty=no; fi; printf 'value=%s tty=%s\\n' \"$value\" \"$tty\"",
                    "workspaceMode": "read",
                    "executionScope": "host",
                    "timeout": 5,
                    "terminal": { "stdin": "ready\n" }
                })),
            context_with_target(&workspace.0, "."),
        )
        .expect("one-call PTY accepts exact input and exits");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["executionScope"], "host");
    assert_eq!(result.output["terminal"], true);
    assert_eq!(result.output["environment"]["interactive"], true);
    assert_eq!(result.output["environment"]["terminal"], true);
    assert!(
        result.output["stdout"]
            .as_str()
            .expect("PTY output")
            .contains("value=ready tty=yes"),
        "{:?}",
        result.output
    );
}

#[test]
fn bash_capture_keeps_bounded_stream_tails_deterministically() {
    let mut stdout = CapturedOutput {
        bytes: b"stdout".to_vec(),
        truncated: false,
    };
    let mut stderr = CapturedOutput {
        bytes: b"stderr".to_vec(),
        truncated: false,
    };

    bound_combined_output(&mut stdout, &mut stderr, 8);

    assert_eq!(stdout.bytes, b"dout");
    assert_eq!(stderr.bytes, b"derr");
    assert!(stdout.truncated);
    assert!(stderr.truncated);
}

#[cfg(unix)]
#[test]
fn bash_limits_preview_and_preserves_complete_output_for_bounded_reads() {
    for line in ["中文🙂", &format!("中文🙂{}", "x".repeat(80))] {
        let workspace = TempWorkspace::new("bash-output-archive");
        let command = format!("i=0; while [ $i -lt 4500 ]; do printf '{line}\\n'; i=$((i+1)); done; printf 'diagnostic\\n' >&2");
        let result = shell_executor().invoke(invocation("archive", "bash", serde_json::json!({
                "command": command, "workspaceMode": "read", "executionScope": "host", "timeout": 5,
            })), context_with_target(&workspace.0, ".")).unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
        assert_eq!(result.output["truncated"], true);
        let stdout = result.output["stdout"].as_str().unwrap();
        let stderr = result.output["stderr"].as_str().unwrap();
        assert!(stdout.len() + stderr.len() <= 50 * 1024);
        assert!(stdout.lines().count() + stderr.lines().count() <= 2000);
        assert!(!stdout.contains('\u{fffd}'));
        assert_eq!(stderr, "diagnostic\n");
        let full_path = result.output["fullOutput"]["stdout"]["path"]
            .as_str()
            .unwrap();
        let full = fs::read_to_string(full_path).unwrap();
        assert_eq!(full, format!("{line}\n").repeat(4500));
        assert_eq!(result.output["fullOutput"]["stdout"]["bytes"], full.len());
        assert_eq!(
            fs::read_to_string(
                result.output["fullOutput"]["stderr"]["path"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            stderr
        );
    }
}

#[test]
fn file_changes_retain_each_operations_before_and_after_and_deleted_tree_files() {
    let workspace = TempWorkspace::new("stable-changes");
    fs::create_dir_all(workspace.0.join("docs")).unwrap();
    fs::write(workspace.0.join("docs/readme.txt"), "before\n").unwrap();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &KernelToolRegistry::default(),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let invoke = |tool: &str, input: Value| {
        registry
            .invoke(
                invocation(format!("invocation:{tool}"), tool, input.clone()),
                context_with_target(&workspace.0, input["path"].as_str().unwrap()),
            )
            .unwrap()
    };
    let write = invoke(
        "fs.write",
        serde_json::json!({ "path": "docs/readme.txt", "content": "after\n" }),
    );
    let change = &write.output["fileChanges"][0];
    assert_eq!(change["kind"], "modify");
    assert_eq!(
        fs::read_to_string(change["before"]["contentRef"].as_str().unwrap()).unwrap(),
        "before\n"
    );
    let edit = invoke(
        "fs.edit",
        serde_json::json!({ "path": "docs/readme.txt", "edits": [{ "oldText": "after", "newText": "later" }] }),
    );
    assert_eq!(edit.output["fileChanges"][0]["kind"], "modify");
    let unchanged = invoke(
        "fs.write",
        serde_json::json!({ "path": "docs/readme.txt", "content": "later\n" }),
    );
    assert_eq!(unchanged.output["fileChanges"], serde_json::json!([]));
    fs::write(workspace.0.join("docs/empty.txt"), "").unwrap();
    let delete = invoke(
        "fs.delete",
        serde_json::json!({ "path": "docs", "targetKind": "directoryTree" }),
    );
    let deleted = delete.output["fileChanges"].as_array().unwrap();
    assert_eq!(deleted.len(), 2);
    assert!(deleted.iter().all(|change| change["kind"] == "delete"
        && change["before"]["exists"] == true
        && change["after"]["exists"] == false));
    assert_eq!(
        fs::read_to_string(change["after"]["contentRef"].as_str().unwrap()).unwrap(),
        "after\n"
    );
}

#[test]
fn fs_edit_rejections_name_the_failing_edit_index_and_shape() {
    let not_found = serde_json::json!([
        {"oldText": "alpha", "newText": "ALPHA"},
        {"oldText": "gamma", "newText": "GAMMA"},
    ]);
    let error = apply_exact_text_edits(
        "alpha beta",
        &serde_json::from_value::<Vec<KernelTextEdit>>(not_found).unwrap(),
    )
    .unwrap_err();
    let KernelError::Structured {
        code,
        message,
        details,
        ..
    } = error
    else {
        panic!("expected a structured patch rejection");
    };
    assert_eq!(code, "patch_match_not_found");
    assert!(message.contains("edits[1]"), "{message}");
    assert_eq!(details["editIndex"], 1);
    assert_eq!(details["oldTextBytes"], 5);

    let ambiguous = serde_json::json!([{"oldText": "dup", "newText": "x"}]);
    let error = apply_exact_text_edits(
        "dup dup",
        &serde_json::from_value::<Vec<KernelTextEdit>>(ambiguous).unwrap(),
    )
    .unwrap_err();
    let KernelError::Structured {
        code,
        message,
        details,
        ..
    } = error
    else {
        panic!("expected a structured patch rejection");
    };
    assert_eq!(code, "patch_match_ambiguous");
    assert!(message.contains("edits[0]"), "{message}");
    assert_eq!(details["editIndex"], 0);
}

#[test]
fn fs_read_distinguishes_missing_metadata_from_a_directory() {
    let workspace = TempWorkspace::new("read-failure-facts");
    fs::create_dir(workspace.0.join("directory")).unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    for (path, expected) in [
        ("missing", "fs_read_metadata_failed"),
        ("directory", "fs_read_not_file"),
    ] {
        let error = registry
            .invoke(
                invocation(
                    format!("invocation:{path}"),
                    "fs.read",
                    serde_json::json!({"path":path}),
                ),
                context_with_target(&workspace.0, path),
            )
            .unwrap_err();
        match error {
            KernelError::Structured { code, details, .. } => {
                assert_eq!(code, expected);
                if path == "missing" {
                    assert_eq!(details["ioKind"], "NotFound");
                    assert!(details["osCode"].is_number());
                }
            }
            error => panic!("unexpected read error: {error}"),
        }
    }
}

#[cfg(unix)]
#[test]
fn shell_deadline_and_cancellation_retain_logs_and_stop_execution() {
    for timed_out in [false, true] {
        let workspace = TempWorkspace::new("shell-stop-archive");
        let mut context = context_with_target(&workspace.0, ".");
        let cancel = context.cancellation.clone();
        let (send, receive) = std::sync::mpsc::channel();
        context.progress = KernelProgressSink::new(move |event| {
            if matches!(event, KernelToolProgress::Output { .. }) {
                let _ = send.send(());
            }
        });
        let mut input = serde_json::json!({"command":"printf started; trap '' TERM; sleep 30", "executionScope":"host"});
        if timed_out {
            input["timeout"] = serde_json::json!(1);
        }
        let started = std::time::Instant::now();
        let task = std::thread::spawn(move || {
            shell_executor().invoke(invocation("stop-archive", "bash", input), context)
        });
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("execution output");
        if !timed_out {
            cancel.cancel();
        }
        let result = task.join().unwrap().unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "termination must be bounded even if TERM is ignored"
        );
        assert_eq!(result.output["success"], false);
        assert_eq!(result.output["timedOut"], timed_out);
        assert_eq!(
            result.error.unwrap().code,
            if timed_out {
                "bash_timed_out"
            } else {
                "tool_execution_cancelled"
            }
        );
        assert_eq!(result.output["stdout"], "started");
        let path = result.output["fullOutput"]["stdout"]["path"]
            .as_str()
            .unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "started");
    }
}
