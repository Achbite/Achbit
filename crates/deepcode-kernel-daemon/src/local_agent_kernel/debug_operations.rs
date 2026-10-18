//! Debug-only invocation owner. This owns a tool operation, never a Session or
//! Agent Loop. Preparation, permissions, mutation locks and executors are shared.
use super::*;
use tokio::sync::{Notify, Semaphore};

pub(crate) type DebugPermissionReader =
    Arc<dyn Fn() -> Result<LocalAgentPermissionPolicy, LocalAgentKernelError> + Send + Sync>;

#[derive(Default)]
pub(crate) struct DebugOperations {
    controls: Mutex<HashMap<String, Arc<DebugControl>>>,
    initializing: Mutex<()>,
    active: Mutex<HashMap<String, Arc<DebugOperation>>>,
}
struct DebugControl {
    id: String,
    workspace: PathBuf,
    workspace_id: String,
    generation: Arc<KernelGeneration>,
    permission_reader: DebugPermissionReader,
    slots: Arc<Semaphore>,
}
struct DebugOperation {
    id: String,
    call_id: String,
    attempt_id: String,
    tool: String,
    input: Value,
    owner: Arc<DebugControl>,
    accepted: Instant,
    control: AttemptControl,
    changed: Notify,
    cancelled: Notify,
    record: Mutex<Value>,
    approval_started: Mutex<Option<Instant>>,
}

fn failure(code: &'static str, message: impl Into<String>) -> LocalAgentKernelError {
    LocalAgentKernelError::new(code, message)
}
fn lock_error() -> LocalAgentKernelError {
    failure(
        "debug_operation_lock_failed",
        "Debug operation state lock poisoned",
    )
}
fn terminal(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "inputRejected" | "denied" | "cancelled" | "indeterminate"
    )
}

pub(super) fn initialize_store(connection: &Connection) -> Result<(), LocalAgentKernelError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS debug_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        control_id TEXT NOT NULL,
        call_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL UNIQUE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS debug_operations_control ON debug_operations(control_id, accepted_at);")
        .map_err(|e| failure("debug_operation_schema_failed", e.to_string()))
}

impl LocalAgentKernel {
    pub(crate) fn debug_catalog_guard(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ()>, LocalAgentKernelError> {
        self.debug.initializing.lock().map_err(|_| lock_error())
    }

    pub(crate) fn debug_has_control(
        &self,
        control_id: &str,
    ) -> Result<bool, LocalAgentKernelError> {
        Ok(self
            .debug
            .controls
            .lock()
            .map_err(|_| lock_error())?
            .contains_key(control_id))
    }

    pub(crate) fn debug_bind_control(
        &self,
        control_id: &str,
        workspace: &Path,
        generation: PreparedKernelGeneration,
        permission_reader: DebugPermissionReader,
    ) -> Result<Value, LocalAgentKernelError> {
        validate_id("controlId", control_id)?;
        let workspace = workspace
            .canonicalize()
            .map_err(|e| failure("workspace_root_unavailable", e.to_string()))?;
        if !workspace.is_dir() {
            return Err(failure(
                "workspace_root_invalid",
                "Debug workspace is not a directory",
            ));
        }
        let mut controls = self.debug.controls.lock().map_err(|_| lock_error())?;
        let active = self.debug.active.lock().map_err(|_| lock_error())?;
        if active.values().any(|op| op.owner.id == control_id) {
            generation
                .generation
                .catalog
                .dispose()
                .map_err(catalog_error)?;
            return Err(failure(
                "debug_control_busy",
                "Finish or cancel current operations before changing the component catalog",
            ));
        }
        if let Some(previous) = controls.remove(control_id) {
            previous
                .generation
                .catalog
                .retirement()
                .finish()
                .map_err(catalog_error)?;
        }
        let owner = Arc::new(DebugControl {
            id: control_id.into(),
            workspace,
            workspace_id: random_id("debug-workspace")?,
            generation: generation.generation,
            permission_reader,
            slots: Arc::new(Semaphore::new(4)),
        });
        let result = debug_catalog(&owner);
        controls.insert(control_id.into(), owner);
        Ok(result)
    }

    pub(crate) fn debug_catalog(&self, control_id: &str) -> Result<Value, LocalAgentKernelError> {
        Ok(debug_catalog(self.debug_control(control_id)?.as_ref()))
    }

    fn debug_control(&self, control_id: &str) -> Result<Arc<DebugControl>, LocalAgentKernelError> {
        self.debug
            .controls
            .lock()
            .map_err(|_| lock_error())?
            .get(control_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "debug_control_not_bound",
                    "Debug component context is not bound",
                )
            })
    }

    pub(crate) fn debug_call(
        &self,
        control_id: &str,
        tool: &str,
        input: Value,
    ) -> Result<Value, LocalAgentKernelError> {
        let controls = self.debug.controls.lock().map_err(|_| lock_error())?;
        let owner = controls.get(control_id).cloned().ok_or_else(|| {
            failure(
                "debug_control_not_bound",
                "Debug component context is not bound",
            )
        })?;
        let accepted = Instant::now();
        let id = random_id("debug-operation")?;
        let call_id = random_id("call")?;
        let attempt_id = random_id("attempt")?;
        let record = json!({"schemaVersion":"deepcode.debug-operation.v1", "source":"debugOperation",
            "operationId":id,"controlId":control_id,"callId":call_id,"attemptId":attempt_id,
            "toolName":tool,"input":input,"workspaceId":owner.workspace_id,"workspace":owner.workspace,
            "extensionGenerationRef":owner.generation.catalog.extension_generation_ref(),
            "kernelCatalogSnapshotRef":owner.generation.catalog.snapshot_ref(),
            "status":"accepted","version":1,"acceptedAt":crate::now_text(),
            "resourcesReleased":false,"modelUsage":{"coverage":"notApplicable","mainProviderRequests":0},
            "timing":{"owner":"kernel","clockDomain":self.clock.domain,"executor":{"coverage":"notApplicable"}}
        });
        self.debug_store(&record)?;
        let op = Arc::new(DebugOperation {
            id: id.clone(),
            call_id,
            attempt_id,
            tool: tool.into(),
            input,
            owner,
            accepted,
            control: AttemptControl::default(),
            changed: Notify::new(),
            cancelled: Notify::new(),
            record: Mutex::new(record.clone()),
            approval_started: Mutex::new(None),
        });
        self.debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .insert(id, op.clone());
        drop(controls);
        self.debug_schedule(op, None);
        Ok(record)
    }

    fn debug_schedule(&self, op: Arc<DebugOperation>, approval: Option<Value>) {
        let kernel = self.clone();
        let queued = Instant::now();
        tokio::spawn(async move {
            let slot = tokio::select! {
                slot = op.owner.slots.clone().acquire_owned() => slot.ok(),
                _ = op.cancelled.notified() => None,
            };
            let next = op.clone();
            let worker = kernel.clone();
            let result = tokio::task::spawn_blocking(move || {
                if slot.is_none() || next.control.cancellation().is_cancelled() {
                    return worker.debug_finish(&next, "cancelled", None, None);
                }
                let result = worker.debug_execute(&next, approval, queued.elapsed());
                drop(slot);
                result
            })
            .await;
            let error = match result {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(e) => Some(failure("debug_worker_failed", e.to_string())),
            };
            if let Some(error) = error {
                if let Err(store_error) = kernel.debug_finish(
                    &op,
                    "failed",
                    None,
                    Some(json!({"code":error.code,"message":error.message})),
                ) {
                    // Keep the original failure visible even when persistence itself failed.
                    if let Ok(mut record) = op.record.lock() {
                        record["status"] = json!("failed");
                        record["error"] = json!({"code":error.code,"message":error.message});
                        record["recordError"] =
                            json!({"code":store_error.code,"message":store_error.message});
                    }
                    op.changed.notify_waiters();
                }
            }
        });
    }

    fn debug_execute(
        &self,
        op: &Arc<DebugOperation>,
        approval: Option<Value>,
        queue_time: Duration,
    ) -> Result<(), LocalAgentKernelError> {
        self.debug_update(op, |record| {
            record["status"] = json!("preparing");
            record["timing"]["queueUs"] = json!(
                u128::from(record["timing"]["queueUs"].as_u64().unwrap_or(0))
                    + queue_time.as_micros()
            );
        })?;
        let prepared_start = Instant::now();
        let mut prepared = match self.debug_prepare(op) {
            Ok(prepared) => prepared,
            Err(error) => return self.debug_finish(
                op,
                if error.input_issues.is_some() {
                    "inputRejected"
                } else {
                    "failed"
                },
                None,
                Some(
                    json!({"code":error.code,"message":error.message,"issues":error.input_issues}),
                ),
            ),
        };
        let targets = prepared.file_mutation_targets();
        let _guard = targets
            .as_ref()
            .map(|targets| {
                self.file_mutations.acquire(
                    &op.call_id,
                    targets.clone(),
                    &op.control.cancellation(),
                )
            })
            .transpose()?
            .flatten();
        if op.control.cancellation().is_cancelled() {
            drop(_guard);
            return self.debug_finish(op, "cancelled", None, None);
        }
        if _guard.is_some() {
            prepared = self.debug_prepare(op)?;
            if prepared.file_mutation_targets() != targets {
                return Err(failure(
                    "file_preparation_changed",
                    "Resolved mutation target changed while acquiring its lock",
                ));
            }
        }
        let fingerprint = debug_effect(&prepared);
        self.debug_update(op, |record| {
            record["preparedEffect"] = fingerprint.clone();
            record["toolBindingRef"] = json!(prepared.binding.binding_ref());
            record["modelUsage"]["coverage"] = json!(if prepared.operation.starts_with("fs.") {
                "notApplicable"
            } else {
                "toolInternalUsageNotExposed"
            });
            record["timing"]["prepareUs"] = json!(prepared_start.elapsed().as_micros());
        })?;
        let approved = approval.as_ref().is_some_and(|value| value == &fingerprint);
        if approval.is_some() && !approved {
            drop(_guard);
            return self.debug_finish(op, "failed", None, Some(json!({"code":"operation_approval_target_changed","message":"Prepared operation or resolved targets changed; the original approval is not applicable"})));
        }
        match debug_admission(&prepared, approved) {
            Admission::Denied { authority, error } => {
                self.debug_update(op, |record| record["authority"] = authority)?;
                drop(_guard);
                return self.debug_finish(op, "denied", None, Some(error));
            }
            Admission::ApprovalRequired => {
                drop(_guard);
                let decision = random_id("debug-decision")?;
                *op.approval_started.lock().map_err(|_| lock_error())? = Some(Instant::now());
                self.debug_update(op, |record| {
                    record["status"] = json!("approvalRequired");
                    record["decision"] = json!({"decisionId":decision,"scope":"operation","effect":fingerprint,
                        "preview":debug_preview(&prepared,&op.tool),"requestedAt":crate::now_text(),"allowedDecisions":["allow","deny"]});
                })?;
                return Ok(());
            }
            Admission::Allowed(authority) => {
                self.debug_update(op, |record| record["authority"] = authority)?;
            }
        }
        let lease = prepared.binding.begin_attempt().map_err(catalog_error)?;
        if !op.control.start_execution() {
            drop(lease);
            drop(_guard);
            return self.debug_finish(op, "cancelled", None, None);
        }
        self.debug_update(op, |record| {
            record["status"] = json!("executing");
            record["startedAt"] = json!(crate::now_text());
        })?;
        let result = self.invoke_measured(
            &prepared,
            &op.attempt_id,
            KernelToolExecutionContext {
                output_directory: Some(self.debug_output_directory(&op.id)),
                workspace_root: prepared.workspace_root.clone(),
                workspace_id: prepared.workspace_id.clone(),
                private_resolved_targets: prepared.private_resolved_targets.clone(),
                workspace_write_targets: None,
                file_access: prepared.execution_file_access(),
                cancellation: op.control.cancellation(),
                progress: Default::default(),
            },
        );
        let cancel_phase = op.control.claim_outcome();
        drop(lease);
        drop(_guard);
        let executor = self.take_execution_timing(&op.attempt_id)?;
        self.debug_update(op, |record| record["timing"]["executor"] = executor)?;
        match (cancel_phase, result) {
            (Some(ActivePhase::Prepared), _) => self.debug_finish(op, "cancelled", None, None),
            (Some(ActivePhase::Executing), Ok(result))
                if is_confirmed_workspace_shell_cancellation(&prepared, &result) =>
            {
                self.debug_finish(op, "cancelled", Some(result.output), None)
            }
            (Some(ActivePhase::Executing), result) => {
                let output = result.as_ref().ok().map(|result| result.output.clone());
                let original = result.err();
                self.debug_finish(op,"indeterminate",output,Some(json!({"code":"tool_effect_outcome_unknown","message":"Cancellation reached an executing effect; completion could not be established","originalError":original})))
            }
            (None, Ok(result)) => {
                let status = if result.outcome == KernelToolExecutionOutcome::Completed {
                    "completed"
                } else {
                    "failed"
                };
                self.debug_finish(
                    op,
                    status,
                    Some(result.output),
                    result
                        .error
                        .map(|e| json!({"code":e.code,"message":e.message})),
                )
            }
            (None, Err(error)) => self.debug_finish(
                op,
                "failed",
                None,
                Some(json!({"code":"tool_execution_failed","message":error})),
            ),
        }
    }

    fn debug_prepare(&self, op: &DebugOperation) -> Result<PreparedEffect, LocalAgentKernelError> {
        let owner = &op.owner;
        let binding = owner
            .generation
            .catalog
            .binding_for_name(&op.tool)
            .map_err(catalog_error)?;
        if binding.availability() == ToolAvailability::Blocked {
            return Err(failure(
                "tool_blocked",
                "Tool is blocked in the selected catalog",
            ));
        }
        if let Some(reason) = context_requirement(&op.tool) {
            return Err(failure("tool_context_required", reason));
        }
        let mut input = op.input.clone();
        let scope = binding.effect_scope(&input).map_err(catalog_error)?;
        if matches!(
            scope,
            CatalogEffectScope::WorkspaceRead
                | CatalogEffectScope::WorkspaceMutation
                | CatalogEffectScope::Process
        ) {
            let object = input.as_object_mut().ok_or_else(|| {
                LocalAgentKernelError::input("$", "type", "Tool input must be an object", None)
            })?;
            if object
                .get("workspaceId")
                .is_some_and(|id| id.as_str() != Some(owner.workspace_id.as_str()))
            {
                return Err(failure(
                    "workspace_not_bound",
                    "The provided workspace is not the Debug control workspace",
                ));
            }
            object.insert("workspaceId".into(), json!(owner.workspace_id));
        }
        let permissions = (owner.permission_reader)()?;
        let mut prepared = prepare_effect_target(
            &op.tool,
            &input,
            &[owner.workspace_id.clone()],
            owner.generation.clone(),
            binding,
            permissions,
            |_| {
                Ok(ResolvedWorkspace {
                    root: owner.workspace.to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            },
            |root| {
                Ok(root.starts_with(&owner.workspace).then(|| WorkspacePolicy {
                    id: owner.workspace_id.clone(),
                    root: owner.workspace.clone(),
                    access: WorkspaceAccess::Project,
                }))
            },
        )?;
        if is_shell_tool(&prepared.operation) {
            let host = prepared.canonical_invocation["arguments"]["requestHostPermission"]
                .is_string()
                || prepared.permissions.shell_full_access;
            let mode = KernelWorkspaceMode::Write;
            let scope = if host {
                KernelExecutionScope::Host
            } else {
                KernelExecutionScope::Workspace
            };
            if let PreparedToolInput::Builtin(
                KernelCanonicalInvocation::ProcessShell {
                    workspace_mode,
                    execution_scope,
                    ..
                }
                | KernelCanonicalInvocation::ProcessPowerShell {
                    workspace_mode,
                    execution_scope,
                    ..
                },
            ) = &mut prepared.input
            {
                *workspace_mode = mode;
                *execution_scope = scope;
            }
            prepared.process_workspace_mode = Some(mode.as_str().into());
            prepared.process_execution_scope = Some(scope.as_str().into());
            prepared.canonical_invocation["arguments"] = prepared.input.arguments();
        }
        file_permissions::prepare_file_access(
            &mut prepared,
            vec![ResolvedWorkspace {
                root: owner.workspace.to_string_lossy().into(),
                access: WorkspaceAccess::Project,
            }],
            self.debug_output_directory(&op.id),
            Vec::new(),
        )?;
        prepared.file_access.sandbox_backend =
            prepared.generation.executor_config.sandbox_backend.clone();
        prepared.file_access.network_access = prepared.network_request.is_some();
        if let PreparedToolInput::Container { input, target } = &mut prepared.input {
            *target = prepared
                .binding
                .container_adapter()
                .expect("container binding")
                .prepare(
                    input,
                    prepared.workspace_root.as_deref().ok_or_else(|| {
                        failure("workspace_required", "Container requires a workspace")
                    })?,
                    None,
                )
                .map_err(|message| {
                    LocalAgentKernelError::input("$.container", "containerTarget", &message, None)
                })?;
            prepared.canonical_invocation["arguments"] = prepared.input.arguments();
        }
        Ok(prepared)
    }

    fn debug_output_directory(&self, operation: &str) -> PathBuf {
        self.output_root
            .join("debug-operations")
            .join(output_directory_key(operation))
    }

    fn debug_update(
        &self,
        op: &DebugOperation,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Value, LocalAgentKernelError> {
        let mut record = op.record.lock().map_err(|_| lock_error())?;
        let mut next = record.clone();
        mutate(&mut next);
        next["version"] = json!(record["version"].as_u64().unwrap_or(0) + 1);
        next["updatedAt"] = json!(crate::now_text());
        self.debug_store(&next)?;
        *record = next.clone();
        drop(record);
        op.changed.notify_waiters();
        Ok(next)
    }

    fn debug_finish(
        &self,
        op: &DebugOperation,
        status: &str,
        output: Option<Value>,
        error: Option<Value>,
    ) -> Result<(), LocalAgentKernelError> {
        // Publish terminal state and remove the live owner atomically. A reader
        // seeing resourcesReleased must be able to release its control at once.
        let mut active = self.debug.active.lock().map_err(|_| lock_error())?;
        let mut current = op.record.lock().map_err(|_| lock_error())?;
        let mut record = current.clone();
        record["status"] = json!(status);
        record["completedAt"] = json!(crate::now_text());
        record["resourcesReleased"] = json!(true);
        record["outputDirectory"] = json!(self.debug_output_directory(&op.id));
        record["timing"]["acceptToResultUs"] = json!(op.accepted.elapsed().as_micros());
        record["timing"]["resultStore"] = json!({"coverage":"notMeasured"});
        record["version"] = json!(record["version"].as_u64().unwrap_or(0) + 1);
        if let Some(output) = output {
            record["output"] = output;
        }
        if let Some(error) = error {
            record["error"] = error;
        }
        self.debug_store(&record)?;
        *current = record;
        active.remove(&op.id);
        op.control.finish();
        drop(current);
        drop(active);
        op.changed.notify_waiters();
        Ok(())
    }

    fn debug_store(&self, record: &Value) -> Result<(), LocalAgentKernelError> {
        self.records.connection.lock().map_err(|_| lock_error())?.execute(
            "INSERT INTO debug_operations(operation_id,control_id,call_id,attempt_id,tool_name,status,accepted_at,record_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json",
            params![record["operationId"].as_str(),record["controlId"].as_str(),record["callId"].as_str(),record["attemptId"].as_str(),record["toolName"].as_str(),record["status"].as_str(),record["acceptedAt"].as_str(),record.to_string()])
            .map_err(|e| failure("debug_operation_store_failed",e.to_string()))?;
        Ok(())
    }

    fn debug_read(&self, control: &str, id: &str) -> Result<Value, LocalAgentKernelError> {
        let record = self.debug_read_operation(id)?;
        if record["controlId"] != control {
            return Err(failure(
                "debug_operation_owner_mismatch",
                "Operation belongs to another control",
            ));
        }
        Ok(record)
    }

    fn debug_read_in_workspace(
        &self,
        workspace: &Path,
        id: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        let record = self.debug_read_operation(id)?;
        if !self.debug_record_in_workspace(&record, workspace)? {
            return Err(failure(
                "debug_operation_workspace_mismatch",
                "Operation belongs to another workspace",
            ));
        }
        Ok(record)
    }

    fn debug_read_operation(&self, id: &str) -> Result<Value, LocalAgentKernelError> {
        if let Some(op) = self
            .debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .get(id)
            .cloned()
        {
            return op
                .record
                .lock()
                .map_err(|_| lock_error())
                .map(|v| v.clone());
        }
        let encoded: Option<String> = self
            .records
            .connection
            .lock()
            .map_err(|_| lock_error())?
            .query_row(
                "SELECT record_json FROM debug_operations WHERE operation_id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| failure("debug_operation_read_failed", e.to_string()))?;
        serde_json::from_str(&encoded.ok_or_else(|| {
            failure(
                "debug_operation_not_found",
                "Debug operation not found in this Host",
            )
        })?)
        .map_err(|e| failure("debug_operation_record_invalid", e.to_string()))
    }

    pub(crate) async fn debug_inspect(
        &self,
        workspace: &Path,
        id: &str,
        wait_ms: u64,
    ) -> Result<Value, LocalAgentKernelError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms.min(180_000));
        loop {
            let op = self
                .debug
                .active
                .lock()
                .map_err(|_| lock_error())?
                .get(id)
                .cloned();
            let notification = op.as_ref().map(|op| op.changed.notified());
            tokio::pin!(notification);
            // `Notified::enable` registers the waiter before the status read.
            if let Some(notification) = notification.as_mut().as_pin_mut() {
                notification.enable();
            }
            let record = self.debug_read_in_workspace(workspace, id)?;
            if wait_ms == 0
                || terminal(record["status"].as_str().unwrap_or(""))
                || record["status"] == "approvalRequired"
                || op.is_none()
            {
                return Ok(record);
            }
            if let Some(notification) = notification.as_mut().as_pin_mut() {
                if tokio::time::timeout_at(deadline, notification)
                    .await
                    .is_err()
                {
                    let mut record = self.debug_read_in_workspace(workspace, id)?;
                    record["waitTimedOut"] = json!(true);
                    return Ok(record);
                }
            }
        }
    }

    pub(crate) fn debug_cancel(
        &self,
        control: &str,
        id: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        let record = self.debug_read(control, id)?;
        if terminal(record["status"].as_str().unwrap_or("")) {
            return Ok(record);
        }
        let op = self
            .debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "debug_operation_owner_unavailable",
                    "The execution owner is unavailable; outcome remains unknown",
                )
            })?;
        op.control.request_cancel();
        op.cancelled.notify_one();
        if record["status"] == "approvalRequired" {
            self.debug_finish(&op, "cancelled", None, None)?;
        }
        let mut record = self.debug_read(control, id)?;
        record["cancellationRequested"] = json!(true);
        Ok(record)
    }

    pub(crate) fn debug_respond(
        &self,
        control: &str,
        id: &str,
        decision_id: &str,
        decision: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        if !matches!(decision, "allow" | "deny") {
            return Err(failure(
                "debug_decision_invalid",
                "decision must be allow or deny",
            ));
        }
        let op = self
            .debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "debug_operation_not_waiting",
                    "Operation is not waiting for approval",
                )
            })?;
        let mut record = op.record.lock().map_err(|_| lock_error())?;
        if op.owner.id != control
            || record["status"] != "approvalRequired"
            || record["decision"]["decisionId"] != decision_id
        {
            return Err(failure(
                "debug_decision_identity_mismatch",
                "Decision is not the pending decision owned by this operation",
            ));
        }
        let approved_effect = record["decision"]["effect"].clone();
        record["decision"]["decision"] = json!(decision);
        record["decision"]["answeredAt"] = json!(crate::now_text());
        if let Some(start) = op.approval_started.lock().map_err(|_| lock_error())?.take() {
            record["timing"]["approvalWaitUs"] = json!(start.elapsed().as_micros());
        }
        record["status"] = json!("accepted");
        self.debug_store(&record)?;
        drop(record);
        if decision == "deny" {
            self.debug_finish(
                &op,
                "denied",
                None,
                Some(json!({"code":"operation_denied","message":"Operator denied this operation"})),
            )?;
        } else {
            self.debug_schedule(op, Some(approved_effect));
        }
        self.debug_read(control, id)
    }

    pub(crate) fn debug_release(
        &self,
        control: &str,
        id: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        let record = self.debug_read(control, id)?;
        if !terminal(record["status"].as_str().unwrap_or("")) {
            return Err(failure(
                "debug_operation_active",
                "Cancel or await the operation before releasing it",
            ));
        }
        Ok(record)
    }

    pub(super) fn shutdown_debug_operations(&self) -> Result<(), LocalAgentKernelError> {
        let operations: Vec<_> = self
            .debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .values()
            .cloned()
            .collect();
        for op in &operations {
            self.debug_cancel(&op.owner.id, &op.id)?;
        }
        for op in &operations {
            if !op.control.wait_complete(ATTEMPT_CLEANUP_TIMEOUT) {
                return Err(failure("debug_operation_cleanup_timeout","Debug execution owner did not release its resources within the cleanup deadline"));
            }
        }
        let controls: Vec<_> = self
            .debug
            .controls
            .lock()
            .map_err(|_| lock_error())?
            .keys()
            .cloned()
            .collect();
        for control in controls {
            self.debug_release_control(&control)?;
        }
        Ok(())
    }

    pub(crate) fn debug_release_control(&self, control: &str) -> Result<(), LocalAgentKernelError> {
        if self
            .debug
            .active
            .lock()
            .map_err(|_| lock_error())?
            .values()
            .any(|op| op.owner.id == control)
        {
            return Err(failure(
                "debug_control_busy",
                "Cannot release a control while operations are active",
            ));
        }
        if let Some(owner) = self
            .debug
            .controls
            .lock()
            .map_err(|_| lock_error())?
            .remove(control)
        {
            owner
                .generation
                .catalog
                .retirement()
                .finish()
                .map_err(catalog_error)?;
        }
        Ok(())
    }
}

fn context_requirement(tool: &str) -> Option<&'static str> {
    match tool {
        "process" => Some("Managed process contribution requires its existing Session/run job owner; use shell for an independent direct process invocation"),
        "session.read" => Some("Session reading uses the Session query interface with an explicit existing Session identity"),
        name if name.starts_with("browser.") || name == "computer.control" => Some("This tool requires its registered GUI/desktop ownership; use the Debug GUI action interface"),
        _ => None,
    }
}
fn debug_catalog(owner: &DebugControl) -> Value {
    let mut tools = owner.generation.catalog.provider_view();
    if let Some(tools) = tools.as_array_mut() {
        for tool in tools {
            let reason = tool["name"].as_str().and_then(context_requirement);
            tool["directInvocation"] =
                json!({"supported":reason.is_none(),"requiredContext":reason});
        }
    }
    json!({"controlId":owner.id,"workspace":owner.workspace,"workspaceId":owner.workspace_id,
        "extensionGenerationRef":owner.generation.catalog.extension_generation_ref(),
        "kernelCatalogSnapshotRef":owner.generation.catalog.snapshot_ref(),"maxInFlight":4,"tools":tools})
}
fn debug_preview(prepared: &PreparedEffect, tool: &str) -> Value {
    let mut preview = prepared.preview(tool);
    preview["authorizationScope"] = json!("operation");
    preview
        .as_object_mut()
        .expect("prepared preview object")
        .remove("authorizationScopes");
    preview
}
fn debug_effect(prepared: &PreparedEffect) -> Value {
    json!({"toolName":prepared.operation,"toolBindingRef":prepared.binding.binding_ref(),
        "contributionRef":prepared.binding.contribution_ref(),"providerRef":prepared.binding.provider_ref(),
        "origin":prepared.binding.origin(),"pluginInstanceRef":prepared.binding.plugin_instance_ref(),
        "workspaceId":prepared.workspace_id,"workspaceRoot":prepared.workspace_root,
        "canonicalInvocation":prepared.canonical_invocation,"logicalTargets":prepared.logical_targets,
        "resolvedTargets":prepared.private_resolved_targets,"fileAccess":prepared.file_requests.display(),
        "processWorkspaceMode":prepared.process_workspace_mode,"processExecutionScope":prepared.process_execution_scope,
        "networkRequested":prepared.network_request})
}
fn debug_admission(prepared: &PreparedEffect, approved: bool) -> Admission {
    if let Some(denied) = policy_denial(prepared) {
        return denied;
    }
    if prepared.permissions.mode(prepared.scope) == Some(PermissionMode::Deny)
        || prepared.network_request.is_some()
            && prepared.permissions.network == PermissionMode::Deny
        || prepared.is_host_process() && prepared.permissions.external == PermissionMode::Deny
        || prepared.command_rule() == Some("deny")
    {
        return Admission::denied(
            "permission_policy_denied",
            "The effective Kernel permission policy denies this operation",
        );
    }
    if approved {
        return Admission::Allowed(json!({"decision":"allow","source":"debugOperationDecision"}));
    }
    let requires = prepared.file_authority_required
        || prepared.network_request.is_some()
        || (prepared.scope == PreparedEffectScope::WorkspaceMutation
            || is_shell_tool(&prepared.operation))
            && prepared.permissions.workspace_mutation == WorkspaceMutationMode::Plan
        || prepared.permissions.mode(prepared.scope) == Some(PermissionMode::Ask)
        || is_shell_tool(&prepared.operation)
            && (prepared.permissions.shell != ShellApprovalMode::Allow
                || prepared.command_rule() == Some("ask"))
        || prepared.is_host_process() && prepared.permissions.external != PermissionMode::Allow;
    if requires {
        Admission::ApprovalRequired
    } else {
        Admission::Allowed(json!({"decision":"allow","source":"debugWorkspacePolicy"}))
    }
}

impl LocalAgentKernel {
    fn debug_query_workspace(
        &self,
        control: &str,
        query: &Value,
    ) -> Result<PathBuf, LocalAgentKernelError> {
        match query.get("workspace") {
            Some(Value::String(workspace)) if Path::new(workspace).is_absolute() => {
                Ok(PathBuf::from(workspace))
            }
            Some(_) => Err(failure(
                "debug_workspace_invalid",
                "Expected an absolute workspace directory",
            )),
            None => Ok(self.debug_control(control)?.workspace.clone()),
        }
    }

    fn debug_record_in_workspace(
        &self,
        record: &Value,
        workspace: &Path,
    ) -> Result<bool, LocalAgentKernelError> {
        if let Some(root) = record["workspace"].as_str() {
            return Ok(Path::new(root) == workspace);
        }
        // Session facts retain the run's immutable binding identities. Resolve those
        // through the existing resource owner, including its managed Session workdir.
        let session = required_record_string(record, "sessionId")?;
        let run = required_record_string(record, "runId")?;
        let bindings = self.journal.run_workspace_binding_ids(session, run)?;
        if bindings.is_empty() {
            return Ok(false);
        }
        for id in bindings {
            let bound = self.resolve_owned_workspace(session, &id)?;
            if Path::new(&bound.root) != workspace
                && bound.access.owner_session_id() != Some(session)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn debug_metrics(
        &self,
        control: &str,
        query: &Value,
    ) -> Result<Value, LocalAgentKernelError> {
        let workspace = self.debug_query_workspace(control, query)?;
        let bound = |name: &str| -> Result<Option<u64>, LocalAgentKernelError> {
            query
                .get(name)
                .map(|value| {
                    value.as_u64().ok_or_else(|| {
                        failure(
                            "tool_metrics_query_invalid",
                            format!("{name} must be an epoch millisecond integer"),
                        )
                    })
                })
                .transpose()
        };
        let from = bound("fromMs")?;
        let to = bound("toMs")?;
        if from.zip(to).is_some_and(|(from, to)| from >= to) {
            return Err(failure(
                "tool_metrics_query_invalid",
                "fromMs must be less than toMs",
            ));
        }
        if query
            .get("groupBy")
            .is_some_and(|value| value != &json!(["tool", "status"]) && value != "tool,status")
        {
            return Err(failure(
                "tool_metrics_grouping_unsupported",
                "Supported groupBy is [tool,status]",
            ));
        }
        let connection = self.records.connection.lock().map_err(|_| lock_error())?;
        let mut candidates = Vec::<Value>::new();
        for (sql, source) in [
            (
                "SELECT record_json FROM tool_records ORDER BY completed_at,rowid",
                "sessionRun",
            ),
            (
                "SELECT record_json FROM debug_operations ORDER BY accepted_at,rowid",
                "debugOperation",
            ),
        ] {
            let mut statement = connection
                .prepare(sql)
                .map_err(|e| failure("tool_metrics_query_failed", e.to_string()))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| failure("tool_metrics_query_failed", e.to_string()))?;
            for row in rows {
                let mut record: Value = serde_json::from_str(
                    &row.map_err(|e| failure("tool_metrics_query_failed", e.to_string()))?,
                )
                .map_err(|e| failure("tool_record_corrupt", e.to_string()))?;
                record["source"] = json!(source);
                if source == "sessionRun" {
                    record["status"] = record["outcome"].clone();
                }
                let matches = [
                    ("tool", "toolName"),
                    ("toolName", "toolName"),
                    ("operationId", "operationId"),
                    ("operation", "operationId"),
                    ("callId", "callId"),
                    ("attemptId", "attemptId"),
                    ("sessionId", "sessionId"),
                    ("session", "sessionId"),
                    ("runId", "runId"),
                    ("run", "runId"),
                    ("source", "source"),
                    ("status", "status"),
                ]
                .iter()
                .all(|(input, field)| query.get(*input).is_none_or(|v| v == &record[*field]))
                    && ["contributionRef", "pluginInstanceRef", "toolBindingRef"]
                        .iter()
                        .all(|field| {
                            query
                                .get(*field)
                                .is_none_or(|v| v == &record["preparedEffect"][*field])
                        });
                if !matches {
                    continue;
                }
                if from.is_some() || to.is_some() {
                    let field = if source == "debugOperation" {
                        "acceptedAt"
                    } else {
                        "startedAt"
                    };
                    let at = required_record_string(&record, field)?
                        .parse::<u64>()
                        .map_err(|e| failure("tool_record_timestamp_invalid", e.to_string()))?;
                    if from.is_some_and(|from| at < from) || to.is_some_and(|to| at >= to) {
                        continue;
                    }
                }
                candidates.push(record);
            }
        }
        // Resource resolution and active-owner access must not hold the record store lock.
        drop(connection);
        let mut records = Vec::new();
        for record in candidates {
            if self.debug_record_in_workspace(&record, &workspace)? {
                records.push(record);
            }
        }
        let matched = records.len();
        let offset = query["offset"].as_u64().unwrap_or(0) as usize;
        let limit = query["limit"].as_u64().unwrap_or(1000).clamp(1, 10000) as usize;
        let samples: Vec<Value> = records.into_iter().skip(offset).take(limit).collect();
        let active = self.debug.active.lock().map_err(|_| lock_error())?;
        let running: Vec<Value> = samples.iter()
            .filter(|record| !terminal(record["status"].as_str().unwrap_or("")))
            .map(|record| {
                let operation = record["operationId"].as_str().and_then(|id| active.get(id));
                json!({"operationId":record["operationId"],"callId":record["callId"],"status":record["status"],
                    "clockDomain":record["timing"]["clockDomain"],
                    "elapsedUs":operation.map(|op|op.accepted.elapsed().as_micros()),
                    "coverage":if operation.is_some(){"measuredActiveOperation"}else{"ownerNotActive"}})
            }).collect();
        drop(active);
        let mut groups = std::collections::BTreeMap::<String, Vec<&Value>>::new();
        for sample in &samples {
            let key = format!(
                "{}:{}",
                sample["toolName"].as_str().unwrap_or(""),
                sample["status"].as_str().unwrap_or("")
            );
            groups.entry(key).or_default().push(sample);
        }
        let aggregates:Vec<Value>=groups.into_values().map(|group|json!({"tool":group[0]["toolName"],"status":group[0]["status"],
            "sampleCount":group.len(),"executor":duration_summary(&group,"/timing/executor/durationUs"),
            "acceptToResult":duration_summary(&group,"/timing/acceptToResultUs")})).collect();
        let logical_calls = samples
            .iter()
            .filter_map(|r| r["callId"].as_str())
            .collect::<HashSet<_>>()
            .len();
        let executed = samples
            .iter()
            .filter(|r| {
                r.pointer("/timing/executor/coverage")
                    .is_some_and(|v| v == "measured")
            })
            .count();
        let mut read_edges = std::collections::BTreeMap::<String, Vec<(u64, i32)>>::new();
        for record in &samples {
            if record["toolName"] != "fs.read" {
                continue;
            }
            let span = &record["timing"]["executor"];
            if let (Some(clock), Some(start), Some(end)) = (
                span["clockDomain"].as_str(),
                span["startOffsetUs"].as_u64(),
                span["endOffsetUs"].as_u64(),
            ) {
                let edges = read_edges.entry(clock.into()).or_default();
                edges.push((start, 1));
                edges.push((end, -1));
            }
        }
        let concurrency:Vec<Value>=read_edges.into_iter().map(|(clock,mut edges)|{
            edges.sort();
            let wall_span = edges.last().unwrap().0 - edges.first().unwrap().0;
            let thread_time: i128 = edges.iter().map(|(at,delta)| -(*at as i128)*(*delta as i128)).sum();
            let executed_reads = edges.len()/2;
            let(mut active,mut peak)=(0,0);for (_,delta) in edges {active+=delta;peak=peak.max(active);}
            json!({"clockDomain":clock,"peakExecutingReads":peak,"threadTimeUs":thread_time,"wallSpanUs":wall_span,
                "executedReadCount":executed_reads,"coverage":"returnedSamples","intervals":"wholeExecutorSpansWithoutClipping"})
        }).collect();
        Ok(
            json!({"kind":"tool","owner":"kernel","workspace":workspace,"records":samples,"aggregates":aggregates,
            "groupBy":["tool","status"],"aggregateScope":"returnedSamples","running":running,
            "logicalCallCount":logical_calls,"executedAttemptCount":executed,"readConcurrency":concurrency,
            "range":{"matchedCount":matched,"offset":offset,"limit":limit,"returnedCount":samples.len(),
                "nextOffset":if offset+samples.len()<matched {Some(offset+samples.len())} else {None},
                "timeFilter":{"fromMs":from,"toMs":to,"bounds":"[fromMs,toMs)","debugOperationBasis":"acceptedAt","sessionRunBasis":"startedAt"}},
            "quantileMethod":"nearest-rank","coverage":"persistedKernelRecords","missingDurationsAreZero":false}),
        )
    }

    pub(crate) fn debug_result(
        &self,
        control: &str,
        params: &Value,
    ) -> Result<Value, LocalAgentKernelError> {
        let workspace = self.debug_query_workspace(control, params)?;
        let (record, output_root) =
            match (params["operationId"].as_str(), params["recordId"].as_str()) {
                (Some(operation), None) => (
                    self.debug_read_in_workspace(&workspace, operation)?,
                    self.debug_output_directory(operation),
                ),
                (None, Some(record_id)) => {
                    let encoded: Option<String> = self
                        .records
                        .connection
                        .lock()
                        .map_err(|_| lock_error())?
                        .query_row(
                            "SELECT record_json FROM tool_records WHERE record_id=?1",
                            params![record_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|e| failure("tool_record_read_failed", e.to_string()))?;
                    let record: Value = serde_json::from_str(&encoded.ok_or_else(|| {
                        failure(
                            "tool_record_not_found",
                            "ToolRecord is not present in this Debug Host",
                        )
                    })?)
                    .map_err(|e| failure("tool_record_corrupt", e.to_string()))?;
                    if !self.debug_record_in_workspace(&record, &workspace)? {
                        return Err(failure(
                            "debug_operation_workspace_mismatch",
                            "ToolRecord belongs to another workspace",
                        ));
                    }
                    let output_root = self
                        .session_output_directory(required_record_string(&record, "sessionId")?)
                        .join(output_directory_key(required_record_string(
                            &record,
                            "attemptId",
                        )?));
                    (record, output_root)
                }
                _ => {
                    return Err(failure(
                        "debug_result_identity_invalid",
                        "Provide exactly one operationId or recordId",
                    ))
                }
            };
        let Some(reference) = params["ref"].as_str() else {
            return Ok(record);
        };
        // Only references actually produced by this operation are accepted.
        if !contains_string(&record["output"], reference) {
            return Err(failure(
                "debug_result_reference_invalid",
                "Reference is not part of this operation's output",
            ));
        }
        let path = Path::new(reference)
            .canonicalize()
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?;
        let root = output_root
            .canonicalize()
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?;
        if !path.starts_with(root) || !path.is_file() {
            return Err(failure(
                "debug_result_reference_invalid",
                "Reference is not an operation-owned output file",
            ));
        }
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(path)
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?;
        let total = file
            .metadata()
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?
            .len();
        let offset = params["offset"].as_u64().unwrap_or(0);
        let limit = params["limit"]
            .as_u64()
            .unwrap_or(128 * 1024)
            .clamp(1, 1024 * 1024);
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?;
        let mut bytes = Vec::new();
        file.take(limit)
            .read_to_end(&mut bytes)
            .map_err(|e| failure("debug_result_read_failed", e.to_string()))?;
        use base64::Engine;
        Ok(
            json!({"operationId":record.get("operationId"),"recordId":record.get("recordId"),"ref":reference,"offset":offset,"length":bytes.len(),"totalBytes":total,
            "encoding":"base64","data":base64::engine::general_purpose::STANDARD.encode(&bytes),
            "nextOffset":if offset+(bytes.len() as u64)<total {Some(offset+bytes.len() as u64)}else{None}}),
        )
    }
}
fn contains_string(value: &Value, expected: &str) -> bool {
    match value {
        Value::String(s) => s == expected,
        Value::Array(a) => a.iter().any(|v| contains_string(v, expected)),
        Value::Object(o) => o.values().any(|v| contains_string(v, expected)),
        _ => false,
    }
}
fn duration_summary(records: &[&Value], pointer: &str) -> Value {
    let mut values: Vec<f64> = records
        .iter()
        .filter(|r| terminal(r["status"].as_str().unwrap_or("")))
        .filter_map(|r| r.pointer(pointer).and_then(Value::as_u64))
        .map(|us| us as f64 / 1000.0)
        .collect();
    values.sort_by(f64::total_cmp);
    let n = values.len();
    let quantile = |p: f64| {
        if n == 0 {
            None
        } else {
            Some(
                values[((n as f64 * p).ceil() as usize)
                    .saturating_sub(1)
                    .min(n - 1)],
            )
        }
    };
    let total: f64 = values.iter().sum();
    let running = records
        .iter()
        .filter(|r| !terminal(r["status"].as_str().unwrap_or("")))
        .count();
    json!({"unit":"ms","sampleCount":records.len(),"validDurationCount":n,"missingOrNotApplicableCount":records.len()-running-n,"runningCount":running,
        "total":total,"min":values.first(),"max":values.last(),"mean":if n==0{None}else{Some(total/n as f64)},"p50":quantile(0.5),"p95":quantile(0.95)})
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NoSessionWorkspace;
    impl WorkspaceResolverPort for NoSessionWorkspace {
        fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
            panic!("Direct operation must not resolve a fabricated Session workspace")
        }
    }
    struct Fixture {
        root: PathBuf,
        kernel: LocalAgentKernel,
        permission_settings: Arc<Mutex<Value>>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(random_id("debug-kernel-test").unwrap().replace(':', "-"));
            std::fs::create_dir_all(root.join("workspace")).unwrap();
            let journal = LocalAgentJournal::open(&root.join("session.db")).unwrap();
            let kernel = LocalAgentKernel::open(
                &root.join("tools.db"),
                journal,
                Arc::new(NoSessionWorkspace),
            )
            .unwrap();
            let generation = LocalAgentKernel::prepare_generation(
                "generation:direct-test",
                KernelExecutorConfig::default(),
                Arc::new(deepcode_kernel_runtime::executors::EmptySecretProvider),
                McpRuntime::default(),
                LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
                false,
                crate::local_agent_product_tools::test_product_tools(),
            )
            .unwrap();
            let permission_settings = Arc::new(Mutex::new(json!({})));
            kernel
                .debug_bind_control(
                    "control:test",
                    &root.join("workspace"),
                    generation,
                    Arc::new({
                        let settings = permission_settings.clone();
                        move || {
                            LocalAgentPermissionPolicy::from_settings(
                                &*settings.lock().map_err(|_| lock_error())?,
                            )
                        }
                    }),
                )
                .unwrap();
            Self {
                root,
                kernel,
                permission_settings,
            }
        }
        async fn call(&self, tool: &str, input: Value) -> Value {
            let accepted = self.kernel.debug_call("control:test", tool, input).unwrap();
            self.kernel
                .debug_inspect(
                    &self.root.join("workspace"),
                    accepted["operationId"].as_str().unwrap(),
                    30000,
                )
                .await
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.kernel.debug_release_control("control:test").unwrap();
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn independent_read_uses_real_executor_and_persists_after_release() {
        let f = Fixture::new();
        std::fs::write(f.root.join("workspace/read.txt"), "first\nsecond\n").unwrap();
        let result = f.call("fs.read", json!({"path":"read.txt"})).await;
        assert_eq!(result["status"], "completed", "{result}");
        assert_eq!(result["output"]["content"], "first\nsecond\n");
        assert!(result.get("sessionId").is_none());
        assert!(result.get("runId").is_none());
        assert_eq!(result["modelUsage"]["mainProviderRequests"], 0);
        assert_eq!(result["timing"]["executor"]["coverage"], "measured");
        assert!(result["timing"]["executor"]["durationUs"].as_u64().unwrap() > 0);
        assert_eq!(result["resourcesReleased"], true);
        let id = result["operationId"].as_str().unwrap();
        f.kernel.debug_release("control:test", id).unwrap();
        let metrics = f
            .kernel
            .debug_metrics("control:test", &json!({"operationId":id}))
            .unwrap();
        assert_eq!(metrics["logicalCallCount"], 1);
        assert_eq!(metrics["executedAttemptCount"], 1);
        assert_eq!(metrics["records"][0]["output"], result["output"]);
        let session = Connection::open(f.root.join("session.db")).unwrap();
        let count: i64 = session
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        f.kernel.debug_release_control("control:test").unwrap();
        let workspace = f.root.join("workspace");
        assert_eq!(
            f.kernel.debug_inspect(&workspace, id, 0).await.unwrap(),
            result
        );
        assert_eq!(
            f.kernel
                .debug_result(
                    "control:reattached",
                    &json!({"workspace":workspace,"operationId":id})
                )
                .unwrap(),
            result
        );
        assert_eq!(
            f.kernel
                .debug_metrics(
                    "control:reattached",
                    &json!({"workspace":workspace,"callId":result["callId"]})
                )
                .unwrap()["logicalCallCount"],
            1
        );
        assert_eq!(
            f.kernel
                .debug_inspect(&f.root, id, 0)
                .await
                .unwrap_err()
                .code,
            "debug_operation_workspace_mismatch"
        );
        assert_eq!(
            f.kernel
                .debug_cancel("control:reattached", id)
                .unwrap_err()
                .code,
            "debug_operation_owner_mismatch"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn metrics_filter_actual_identity_time_and_separate_active_elapsed() {
        let f = Fixture::new();
        std::fs::write(f.root.join("workspace/metric.txt"), "measured read").unwrap();
        let result = f.call("fs.read", json!({"path":"metric.txt"})).await;
        let at = result["acceptedAt"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let query = json!({"operationId":result["operationId"],"fromMs":at,"toMs":at+1,
            "contributionRef":result["preparedEffect"]["contributionRef"],
            "toolBindingRef":result["preparedEffect"]["toolBindingRef"],"groupBy":["tool","status"]});
        let metrics = f.kernel.debug_metrics("control:test", &query).unwrap();
        assert_eq!(metrics["range"]["matchedCount"], 1);
        assert_eq!(metrics["groupBy"], json!(["tool", "status"]));
        assert_eq!(
            metrics["readConcurrency"][0]["threadTimeUs"],
            result["timing"]["executor"]["durationUs"]
        );
        assert_eq!(
            metrics["readConcurrency"][0]["wallSpanUs"],
            result["timing"]["executor"]["durationUs"]
        );
        for (field, value) in [
            ("fromMs", json!(at + 1)),
            ("toMs", json!(at)),
            ("contributionRef", json!("contribution:other")),
            ("pluginInstanceRef", json!("plugin-instance:other")),
            ("toolBindingRef", json!("tool-binding:other")),
        ] {
            let mut unmatched = query.clone();
            unmatched
                .as_object_mut()
                .unwrap()
                .remove(if field == "fromMs" { "toMs" } else { "fromMs" });
            unmatched[field] = value;
            assert_eq!(
                f.kernel.debug_metrics("control:test", &unmatched).unwrap()["range"]
                    ["matchedCount"],
                0,
                "{field}"
            );
        }
        assert_eq!(
            f.kernel
                .debug_metrics("control:test", &json!({"groupBy":"plugin"}))
                .unwrap_err()
                .code,
            "tool_metrics_grouping_unsupported"
        );
        let pending = f
            .call(
                "fs.write",
                json!({"path":"pending.txt","content":"unapproved"}),
            )
            .await;
        let metrics = f
            .kernel
            .debug_metrics(
                "control:test",
                &json!({"operationId":pending["operationId"]}),
            )
            .unwrap();
        // Release test resources before assertions, including when an assertion fails.
        f.kernel
            .debug_cancel("control:test", pending["operationId"].as_str().unwrap())
            .unwrap();
        assert_eq!(metrics["running"][0]["coverage"], "measuredActiveOperation");
        assert!(metrics["running"][0]["elapsedUs"].as_u64().unwrap() > 0);
        assert_eq!(
            metrics["aggregates"][0]["acceptToResult"]["validDurationCount"],
            0
        );
        assert_eq!(
            metrics["aggregates"][0]["acceptToResult"]["runningCount"],
            1
        );
        assert_eq!(
            metrics["aggregates"][0]["acceptToResult"]["missingOrNotApplicableCount"],
            0
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_requires_exact_operation_decision_and_does_not_create_plan() {
        let f = Fixture::new();
        let pending = f
            .call(
                "fs.write",
                json!({"path":"approved.txt","content":"actual write"}),
            )
            .await;
        assert_eq!(pending["status"], "approvalRequired", "{pending}");
        assert!(!f.root.join("workspace/approved.txt").exists());
        let id = pending["operationId"].as_str().unwrap();
        let decision = pending["decision"]["decisionId"].as_str().unwrap();
        assert_eq!(
            f.kernel
                .debug_respond("control:test", id, "decision:other", "allow")
                .unwrap_err()
                .code,
            "debug_decision_identity_mismatch"
        );
        f.kernel
            .debug_respond("control:test", id, decision, "allow")
            .unwrap();
        let result = f
            .kernel
            .debug_inspect(&f.root.join("workspace"), id, 30000)
            .await
            .unwrap();
        assert_eq!(result["status"], "completed", "{result}");
        assert_eq!(
            std::fs::read_to_string(f.root.join("workspace/approved.txt")).unwrap(),
            "actual write"
        );
        assert_eq!(result["authority"]["source"], "debugOperationDecision");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejected_inputs_and_cancelled_approvals_remain_queryable() {
        let f = Fixture::new();
        let rejected = f.call("fs.read", json!({"paths":["a","b"]})).await;
        assert_eq!(rejected["status"], "inputRejected", "{rejected}");
        assert_eq!(rejected["timing"]["executor"]["coverage"], "notApplicable");
        let pending = f
            .call("fs.write", json!({"path":"no.txt","content":"no"}))
            .await;
        let cancelled = f
            .kernel
            .debug_cancel("control:test", pending["operationId"].as_str().unwrap())
            .unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert!(!f.root.join("workspace/no.txt").exists());
        assert_eq!(
            f.kernel.debug_metrics("control:test", &json!({})).unwrap()["range"]["matchedCount"],
            2
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn independent_reads_use_multiple_real_workers_with_overlapping_executor_spans() {
        let f = Fixture::new();
        let data = "a line of text to inspect\n".repeat(250_000);
        for index in 0..4 {
            std::fs::write(f.root.join(format!("workspace/{index}.txt")), &data).unwrap();
        }
        let calls: Vec<Value> = (0..4)
            .map(|index| {
                f.kernel
                    .debug_call(
                        "control:test",
                        "fs.read",
                        json!({"path":format!("{index}.txt"),"startLine":240000,"maxLines":1}),
                    )
                    .unwrap()
            })
            .collect();
        let mut threads = HashSet::new();
        for call in calls {
            let result = f
                .kernel
                .debug_inspect(
                    &f.root.join("workspace"),
                    call["operationId"].as_str().unwrap(),
                    30000,
                )
                .await
                .unwrap();
            assert_eq!(result["status"], "completed", "{result}");
            assert!(result["output"]["content"]
                .as_str()
                .unwrap()
                .contains("a line of text"));
            threads.insert(
                result["timing"]["executor"]["threadId"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert!(
            threads.len() > 1,
            "executor work must reach multiple actual threads"
        );
        let metrics = f
            .kernel
            .debug_metrics("control:test", &json!({"tool":"fs.read"}))
            .unwrap();
        assert!(
            metrics["readConcurrency"][0]["peakExecutingReads"]
                .as_u64()
                .unwrap()
                > 1,
            "{metrics}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pending_operation_observes_current_permission_publication() {
        let f = Fixture::new();
        let pending = f.call("bash", json!({"command":"printf permitted"})).await;
        assert_eq!(pending["status"], "approvalRequired", "{pending}");
        f.permission_settings.lock().unwrap()[crate::command_denylist::SETTING] = json!(["printf"]);
        let operation = pending["operationId"].as_str().unwrap();
        f.kernel
            .debug_respond(
                "control:test",
                operation,
                pending["decision"]["decisionId"].as_str().unwrap(),
                "allow",
            )
            .unwrap();
        let result = f
            .kernel
            .debug_inspect(&f.root.join("workspace"), operation, 30000)
            .await
            .unwrap();
        assert_eq!(result["status"], "denied", "{result}");
        assert_eq!(result["error"]["code"], "command_denied_by_rule");
        assert_eq!(result["timing"]["executor"]["coverage"], "notApplicable");
    }

    #[test]
    fn session_record_reference_returns_original_fact_without_arbitrary_file_access() {
        struct Workspace(PathBuf);
        impl WorkspaceResolverPort for Workspace {
            fn resolve(&self, _: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                Ok(ResolvedWorkspace {
                    root: self.0.to_string_lossy().into(),
                    access: WorkspaceAccess::Project,
                })
            }
        }
        let f = Fixture::new();
        std::fs::write(f.root.join("workspace/record.txt"), "record payload").unwrap();
        let (kernel, request, _) = super::super::attempt_control_tests::kernel_with_request(
            Arc::new(Workspace(f.root.join("workspace"))),
            "fs.read",
            json!({"workspaceId":"workspace:test","path":"record.txt"}),
        );
        let reply = kernel.execute(request).unwrap();
        let id = reply["record"]["recordId"].as_str().unwrap();
        let record = kernel
            .debug_result(
                "control:test",
                &json!({"recordId":id,"workspace":f.root.join("workspace")}),
            )
            .unwrap();
        assert_eq!(record, reply["record"]);
        assert_eq!(record["output"]["content"], "record payload");
        assert_eq!(
            kernel
                .debug_result(
                    "control:test",
                    &json!({"recordId":id,"workspace":f.root.join("workspace"),"ref":f.root.join("workspace/record.txt")})
                )
                .unwrap_err()
                .code,
            "debug_result_reference_invalid"
        );
        assert_eq!(
            kernel
                .debug_result(
                    "control:test",
                    &json!({"recordId":"record:absent","workspace":f.root.join("workspace")})
                )
                .unwrap_err()
                .code,
            "tool_record_not_found"
        );
        kernel.shutdown_plugins().unwrap();
        std::fs::remove_dir_all(&kernel.output_root).unwrap();
    }
}
