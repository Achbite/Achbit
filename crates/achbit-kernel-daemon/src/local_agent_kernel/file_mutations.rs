use super::*;

/// Only stable call identity and resolved targets survive preparation. Permissions
/// and file contents are obtained again when the execution owner starts the call.
pub(super) struct PreparedFileCall {
    request: LocalToolExecutionRequest,
    targets: Vec<PathBuf>,
}

impl PreparedFileCall {
    fn matches(&self, request: &LocalToolExecutionRequest, targets: &[PathBuf]) -> bool {
        self.request.session_id == request.session_id
            && self.request.run_id == request.run_id
            && self.request.attempt_id == request.attempt_id
            && self.request.extension_generation_ref == request.extension_generation_ref
            && self.request.kernel_catalog_snapshot_ref == request.kernel_catalog_snapshot_ref
            && self.request.tool_binding_ref == request.tool_binding_ref
            && self.request.tool_name == request.tool_name
            && self.request.input == request.input
            && self.request.workspace_bindings == request.workspace_bindings
            && self.targets == targets
    }
}

pub(super) fn conflicting_targets(left: &[PathBuf], right: &[PathBuf]) -> bool {
    left.iter().any(|left| {
        right
            .iter()
            .any(|right| left.starts_with(right) || right.starts_with(left))
    })
}

#[derive(Default)]
pub(super) struct FileMutationLocks {
    held: Mutex<HashMap<String, Vec<PathBuf>>>,
    changed: Condvar,
}

pub(super) struct FileMutationGuard<'a> {
    locks: &'a FileMutationLocks,
    call_id: String,
}

impl FileMutationLocks {
    pub(super) fn acquire(
        &self,
        call_id: &str,
        targets: Vec<PathBuf>,
        cancellation: &KernelCancellationToken,
    ) -> Result<Option<FileMutationGuard<'_>>, LocalAgentKernelError> {
        let mut held = self.held.lock().map_err(|_| {
            LocalAgentKernelError::new("file_mutation_lock_failed", "文件目标锁已损坏。")
        })?;
        loop {
            if cancellation.is_cancelled() {
                return Ok(None);
            }
            if !held
                .values()
                .any(|other| conflicting_targets(&targets, other))
            {
                held.insert(call_id.to_owned(), targets);
                return Ok(Some(FileMutationGuard {
                    locks: self,
                    call_id: call_id.to_owned(),
                }));
            }
            // Cancellation does not own this condition variable. Bound the wait
            // so a cancelled waiter can finish while the other owner still runs.
            held = self
                .changed
                .wait_timeout(held, Duration::from_millis(20))
                .map_err(|_| {
                    LocalAgentKernelError::new("file_mutation_lock_failed", "文件目标锁已损坏。")
                })?
                .0;
        }
    }
}

impl Drop for FileMutationGuard<'_> {
    fn drop(&mut self) {
        self.locks
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.call_id);
        self.locks.changed.notify_all();
    }
}

impl PreparedEffect {
    pub(super) fn file_mutation_targets(&self) -> Option<Vec<PathBuf>> {
        matches!(
            &self.input,
            PreparedToolInput::Builtin(
                KernelCanonicalInvocation::FsWrite { .. }
                    | KernelCanonicalInvocation::FsEdit { .. }
                    | KernelCanonicalInvocation::FsDelete(_)
            )
        )
        .then(|| {
            self.private_resolved_targets
                .iter()
                .map(PathBuf::from)
                .collect()
        })
    }
}

impl LocalAgentKernel {
    pub(crate) fn prepare_file_calls(
        &self,
        request: LocalToolPreparationRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        let mut seen = HashSet::new();
        let mut prepared = Vec::<PreparedFileCall>::new();
        let mut resolved = Vec::<(String, Vec<PathBuf>)>::new();
        let mut calls = Vec::new();
        for request in request.requests {
            validate_request(&request)?;
            self.validate_session_snapshot(&request)?;
            if !seen.insert(request.call_id.clone()) {
                return Err(LocalAgentKernelError::new(
                    "tool_call_identity_conflict",
                    "文件准备请求不能重复 callId。",
                ));
            }
            if !matches!(request.tool_name.as_str(), "fs.write" | "fs.edit") {
                return Err(LocalAgentKernelError::new(
                    "file_preparation_tool_invalid",
                    "文件并行准备仅接受 fs.write 和 fs.edit。",
                ));
            }
            let effect = match self.prepare_tool_target(&request) {
                Ok(effect) => effect,
                Err(error) if error.input_issues.is_some() => {
                    let targets = self.rejected_file_targets(&request);
                    let conflicts: Vec<_> = resolved
                        .iter()
                        .filter(|(_, earlier)| conflicting_targets(earlier, &targets))
                        .map(|(call_id, _)| call_id.as_str())
                        .collect();
                    calls.push(json!({
                        "callId": request.call_id,
                        "conflictsWith": conflicts,
                        "rejection": input_rejection(&request, error),
                    }));
                    resolved.push((request.call_id, targets));
                    continue;
                }
                Err(error) => return Err(error),
            };
            let targets = effect.file_mutation_targets().ok_or_else(|| {
                LocalAgentKernelError::new(
                    "file_preparation_binding_invalid",
                    "文件工具绑定没有对应的 Kernel 文件修改执行器。",
                )
            })?;
            self.validate_prepared_file_call(&request, &targets)?;
            let conflicts: Vec<_> = resolved
                .iter()
                .filter(|(_, earlier)| conflicting_targets(earlier, &targets))
                .map(|(call_id, _)| call_id.as_str())
                .collect();
            calls.push(json!({ "callId": request.call_id, "conflictsWith": conflicts }));
            resolved.push((request.call_id.clone(), targets.clone()));
            prepared.push(PreparedFileCall { request, targets });
        }
        let mut bound = self.prepared_file_calls.lock().map_err(|_| {
            LocalAgentKernelError::new("file_preparation_lock_failed", "文件调用准备状态锁已损坏。")
        })?;
        // Validate again under the write lock so concurrent preparation cannot
        // replace the identity or target fixed by the first request.
        for call in &prepared {
            if bound
                .get(&call.request.call_id)
                .is_some_and(|old| !old.matches(&call.request, &call.targets))
            {
                return Err(prepared_call_changed());
            }
        }
        for call in prepared {
            bound.insert(call.request.call_id.clone(), call);
        }
        Ok(json!({ "calls": calls }))
    }

    // A malformed edit can still identify a valid target. Preserve that dependency
    // so its later same-target call cannot run after the predecessor was rejected.
    // This never repairs the input or makes an otherwise rejected call executable.
    fn rejected_file_targets(&self, request: &LocalToolExecutionRequest) -> Vec<PathBuf> {
        let resolve = || {
            let workspace_id = request.input.get("workspaceId")?.as_str()?;
            if !request
                .workspace_bindings
                .iter()
                .any(|id| id == workspace_id)
            {
                return None;
            }
            let path = request.input.get("path")?.as_str()?;
            let workspace = self.resolver.resolve(workspace_id).ok()?;
            if workspace
                .access
                .owner_session_id()
                .is_some_and(|owner| owner != request.session_id)
            {
                return None;
            }
            if Path::new(path).is_absolute() {
                achbit_kernel_runtime::file_access::resolve_path(Path::new(path)).ok()
            } else {
                WorkspaceBoundary::new(std::fs::canonicalize(workspace.root).ok()?)
                    .resolve_mutation(path)
                    .ok()
            }
        };
        resolve().into_iter().collect()
    }

    pub(super) fn validate_prepared_file_call(
        &self,
        request: &LocalToolExecutionRequest,
        targets: &[PathBuf],
    ) -> Result<(), LocalAgentKernelError> {
        let bound = self.prepared_file_calls.lock().map_err(|_| {
            LocalAgentKernelError::new("file_preparation_lock_failed", "文件调用准备状态锁已损坏。")
        })?;
        if bound
            .get(&request.call_id)
            .is_some_and(|old| !old.matches(request, targets))
        {
            return Err(prepared_call_changed());
        }
        Ok(())
    }

    pub(super) fn release_prepared_file_calls(
        &self,
        target_run: Option<(&str, &str)>,
    ) -> Result<(), LocalAgentKernelError> {
        self.prepared_file_calls
            .lock()
            .map_err(|_| {
                LocalAgentKernelError::new(
                    "file_preparation_lock_failed",
                    "文件调用准备状态锁已损坏。",
                )
            })?
            .retain(|_, call| {
                target_run.is_some_and(|(session_id, run_id)| {
                    call.request.session_id != session_id || call.request.run_id != run_id
                })
            });
        Ok(())
    }
}

fn prepared_call_changed() -> LocalAgentKernelError {
    LocalAgentKernelError::new(
        "file_preparation_changed",
        "文件调用的绑定、输入或真实目标与准备时不一致。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    struct Workspace(PathBuf);

    impl WorkspaceResolverPort for Workspace {
        fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
            Ok(ResolvedWorkspace {
                root: self.0.to_string_lossy().into(),
                access: WorkspaceAccess::Project,
            })
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (
        Arc<Workspace>,
        LocalAgentKernel,
        LocalToolExecutionRequest,
        Value,
    ) {
        let workspace = Arc::new(Workspace(
            std::env::temp_dir().join(random_id("file-parallel-test").unwrap().replace(':', "-")),
        ));
        std::fs::create_dir_all(&workspace.0).unwrap();
        let (mut kernel, request, catalog) =
            super::super::attempt_control_tests::kernel_with_request(
                workspace.clone(),
                "fs.write",
                json!({"workspaceId":"workspace:test", "path":"note.txt", "content":"initial"}),
            );
        kernel.output_root = workspace.0.join("outputs");
        permission(&kernel, &request, "allow");
        (workspace, kernel, request, catalog)
    }

    fn permission(kernel: &LocalAgentKernel, request: &LocalToolExecutionRequest, mode: &str) {
        kernel
            .journal
            .append(&json!({
                "type":"session.permissions.updated", "sessionId":request.session_id,
                "payload":{"commandId":random_id("command").unwrap(),
                    "patches":{"agent.permissions.workspaceMutation":mode}}
            }))
            .unwrap();
    }

    fn call(
        base: &LocalToolExecutionRequest,
        catalog: &Value,
        suffix: &str,
        tool: &str,
        input: Value,
    ) -> LocalToolExecutionRequest {
        let mut call = base.clone();
        call.call_id = format!("call:{suffix}");
        call.attempt_id = format!("attempt:{suffix}");
        call.request_id = format!("request:{suffix}");
        call.tool_name = tool.into();
        call.tool_binding_ref = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == tool)
            .unwrap()["toolBindingRef"]
            .as_str()
            .unwrap()
            .into();
        call.input = input;
        call
    }

    fn wait_prepared(kernel: &LocalAgentKernel, call_id: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(active) = kernel.lock_active().unwrap().get(call_id) {
                assert_eq!(
                    active.control.completion.0.lock().unwrap().phase,
                    ActivePhase::Prepared
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "file waiter did not become active"
            );
            thread::yield_now();
        }
    }

    fn paused_execution(
        kernel: LocalAgentKernel,
        request: LocalToolExecutionRequest,
    ) -> (thread::JoinHandle<Value>, mpsc::Sender<()>) {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let handle = thread::spawn(move || {
            kernel
                .execute_with_progress(
                    request,
                    achbit_kernel_runtime::executors::KernelProgressSink::new(move |event| {
                        if matches!(
                            event,
                            achbit_kernel_runtime::executors::KernelToolProgress::Started { .. }
                        ) {
                            started_tx.send(()).unwrap();
                            release_rx
                                .lock()
                                .unwrap()
                                .recv_timeout(Duration::from_secs(10))
                                .unwrap();
                        }
                    }),
                )
                .unwrap()
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        (handle, release_tx)
    }

    #[test]
    fn file_preparation_keeps_target_dependencies_and_allows_write_then_edit() {
        let (workspace, kernel, first, catalog) = fixture();
        let edit = call(
            &first,
            &catalog,
            "edit",
            "fs.edit",
            json!({
                "workspaceId":"workspace:test", "path":workspace.0.join("note.txt"),
                "edits":[{"oldText":"initial","newText":"updated"}]
            }),
        );
        let independent = call(
            &first,
            &catalog,
            "other",
            "fs.write",
            json!({
                "workspaceId":"workspace:test", "path":"other.txt", "content":"other"
            }),
        );
        let mut invalid = edit.clone();
        invalid.call_id = "call:invalid".into();
        invalid.attempt_id = "attempt:invalid".into();
        invalid.input["edits"] = json!([]);
        let reply = kernel
            .prepare_file_calls(LocalToolPreparationRequest {
                requests: vec![
                    first.clone(),
                    invalid.clone(),
                    edit.clone(),
                    independent.clone(),
                ],
            })
            .unwrap();
        assert_eq!(reply["calls"][0]["conflictsWith"], json!([]));
        assert_eq!(reply["calls"][1]["rejection"]["callId"], invalid.call_id);
        assert_eq!(
            reply["calls"][2]["conflictsWith"],
            json!([first.call_id, invalid.call_id])
        );
        assert_eq!(reply["calls"][3]["conflictsWith"], json!([]));
        assert!(!workspace.0.join("note.txt").exists());
        assert!(!workspace.0.join("outputs").exists());
        let written = kernel.execute(first.clone()).unwrap();
        assert_eq!(written["status"], "completed", "{written}");
        let edited = kernel.execute(edit.clone()).unwrap();
        assert_eq!(edited["status"], "completed", "{edited}");
        assert_eq!(
            std::fs::read_to_string(workspace.0.join("note.txt")).unwrap(),
            "updated"
        );
        let mut changed = independent;
        changed.input["content"] = json!("changed after preparation");
        assert_eq!(
            kernel.execute(changed).unwrap_err().code,
            "file_preparation_changed"
        );
        kernel
            .release_catalog(ReleaseToolCatalogRequest::new(
                &first.session_id,
                &first.run_id,
                &first.kernel_catalog_snapshot_ref,
            ))
            .unwrap();
        assert!(kernel.prepared_file_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn file_execution_overlaps_independent_targets_and_serializes_cross_session_edits() {
        let (workspace, kernel, first, catalog) = fixture();
        // A second Session points to the same physical root and uses the same
        // Kernel service. Locks must not be keyed by Session/workspace handles.
        let second_session = "session:second";
        let second_run = "run:second";
        let started = kernel
            .journal
            .read_events(&first.session_id, 0)
            .unwrap()
            .into_iter()
            .find(|event| event["type"] == "run.started")
            .unwrap();
        kernel
            .journal
            .create_session(
                second_session,
                "Second",
                &started["payload"]["workspaceBindings"],
                None,
                None,
            )
            .unwrap();
        kernel
            .bind_run_catalog(
                PrepareToolCatalogRequest::new(
                    second_session,
                    second_run,
                    &first.extension_generation_ref,
                ),
                PreparedKernelGeneration {
                    generation: kernel.bound_generation(&first).unwrap(),
                },
            )
            .unwrap();
        kernel
            .journal
            .append(&json!({"type":"run.started", "sessionId":second_session,
            "runId":second_run, "payload":started["payload"]}))
            .unwrap();
        let mut edit = call(
            &first,
            &catalog,
            "second-edit",
            "fs.edit",
            json!({
                "workspaceId":"workspace:test", "path":"note.txt",
                "edits":[{"oldText":"initial","newText":"updated"}]
            }),
        );
        edit.session_id = second_session.into();
        edit.run_id = second_run.into();
        permission(&kernel, &edit, "allow");
        let independent = call(
            &first,
            &catalog,
            "independent",
            "fs.write",
            json!({
                "workspaceId":"workspace:test", "path":"other.txt", "content":"other"
            }),
        );
        let (writer, release) = paused_execution(kernel.clone(), first.clone());
        let worker_kernel = kernel.clone();
        let edit_id = edit.call_id.clone();
        let editor = thread::spawn(move || worker_kernel.execute(edit).unwrap());
        wait_prepared(&kernel, &edit_id);
        let independent_result = kernel.execute(independent).unwrap();
        assert_eq!(
            independent_result["status"], "completed",
            "{independent_result}"
        );
        assert!(
            !workspace.0.join("note.txt").exists(),
            "first target remains behind the held executor boundary"
        );
        release.send(()).unwrap();
        assert_eq!(writer.join().unwrap()["status"], "completed");
        let edited = editor.join().unwrap();
        assert_eq!(edited["status"], "completed", "{edited}");
        let before = edited["record"]["output"]["fileChanges"][0]["before"]["contentRef"]
            .as_str()
            .unwrap();
        assert_eq!(std::fs::read_to_string(before).unwrap(), "initial");
        assert_eq!(
            std::fs::read_to_string(workspace.0.join("note.txt")).unwrap(),
            "updated"
        );
        assert!(kernel.lock_active().unwrap().is_empty());
        kernel.shutdown_plugins().unwrap();
    }

    #[test]
    fn file_waiters_can_cancel_and_recheck_permissions_before_execution() {
        let (workspace, kernel, first, catalog) = fixture();
        let second = call(
            &first,
            &catalog,
            "cancelled-waiter",
            "fs.write",
            first.input.clone(),
        );
        let third = call(
            &first,
            &catalog,
            "permission-waiter",
            "fs.write",
            first.input.clone(),
        );
        let (writer, release) = paused_execution(kernel.clone(), first);
        let worker_kernel = kernel.clone();
        let second_call = second.clone();
        let cancelled = thread::spawn(move || worker_kernel.execute(second_call).unwrap());
        wait_prepared(&kernel, &second.call_id);
        let cancelled_reply = kernel.cancel(&second.call_id, &second.attempt_id).unwrap();
        assert_eq!(cancelled_reply["status"], "cancelled", "{cancelled_reply}");
        assert_eq!(cancelled.join().unwrap()["record"]["outcome"], "cancelled");
        let worker_kernel = kernel.clone();
        let third_call = third.clone();
        let denied = thread::spawn(move || worker_kernel.execute(third_call).unwrap());
        wait_prepared(&kernel, &third.call_id);
        permission(&kernel, &third, "plan");
        release.send(()).unwrap();
        assert_eq!(writer.join().unwrap()["status"], "completed");
        let denied = denied.join().unwrap();
        assert_eq!(denied["status"], "denied", "{denied}");
        assert_eq!(denied["record"]["error"]["code"], "plan_scope_required");
        assert_eq!(
            std::fs::read_to_string(workspace.0.join("note.txt")).unwrap(),
            "initial"
        );
        assert!(kernel.lock_active().unwrap().is_empty());
        kernel.shutdown_plugins().unwrap();
    }

    #[test]
    fn file_directory_delete_locks_children_and_release_drains_waiters() {
        let (workspace, kernel, first, catalog) = fixture();
        std::fs::create_dir_all(workspace.0.join("tree")).unwrap();
        std::fs::write(workspace.0.join("tree/note.txt"), "old").unwrap();
        let deletion = call(
            &first,
            &catalog,
            "delete-tree",
            "fs.delete",
            json!({
                "workspaceId":"workspace:test", "path":"tree", "targetKind":"directoryTree"
            }),
        );
        let child = call(
            &first,
            &catalog,
            "child-waiter",
            "fs.write",
            json!({
                "workspaceId":"workspace:test", "path":"tree/note.txt", "content":"new"
            }),
        );
        kernel
            .prepare_file_calls(LocalToolPreparationRequest {
                requests: vec![child.clone()],
            })
            .unwrap();
        let (deleter, release) = paused_execution(kernel.clone(), deletion);
        let worker_kernel = kernel.clone();
        let child_call = child.clone();
        let writer = thread::spawn(move || worker_kernel.execute(child_call).unwrap());
        wait_prepared(&kernel, &child.call_id);
        let worker_kernel = kernel.clone();
        let cleanup = thread::spawn(move || {
            worker_kernel
                .release_catalog(ReleaseToolCatalogRequest::new(
                    &child.session_id,
                    &child.run_id,
                    &child.kernel_catalog_snapshot_ref,
                ))
                .unwrap()
        });
        assert_eq!(writer.join().unwrap()["status"], "cancelled");
        release.send(()).unwrap();
        assert_eq!(deleter.join().unwrap()["status"], "indeterminate");
        cleanup.join().unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.0.join("tree/note.txt")).unwrap(),
            "old"
        );
        assert!(kernel.lock_active().unwrap().is_empty());
        assert!(kernel.prepared_file_calls.lock().unwrap().is_empty());
        assert!(kernel.file_mutations.held.lock().unwrap().is_empty());
    }
}
