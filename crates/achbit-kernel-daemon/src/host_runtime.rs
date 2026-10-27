use crate::prelude::*;
use crate::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[derive(Clone)]
pub(crate) struct ExecutionServices {
    pub(crate) local_agent: LocalAgentRuntime,
    pub(crate) session_service: SessionServiceProcess,
}

#[derive(Clone, Default)]
pub(crate) struct HostRuntime {
    result: Arc<OnceLock<Result<ExecutionServices, SessionServiceError>>>,
    completed: Arc<tokio::sync::Notify>,
    stopping: Arc<AtomicBool>,
    cleanup_failed: Arc<AtomicBool>,
}

impl HostRuntime {
    pub(crate) fn publish(&self, result: Result<ExecutionServices, SessionServiceError>) {
        assert!(
            self.result.set(result).is_ok(),
            "Host initialization is published once"
        );
        self.completed.notify_waiters();
    }
    pub(crate) fn current(&self) -> Option<Result<ExecutionServices, SessionServiceError>> {
        self.result.get().cloned()
    }
    pub(crate) async fn wait(&self) -> Result<ExecutionServices, SessionServiceError> {
        loop {
            let notified = self.completed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self.current() {
                return result;
            }
            notified.await;
        }
    }
    pub(crate) fn record_cleanup_failure(&self) {
        self.cleanup_failed.store(true, Ordering::SeqCst);
    }
    pub(crate) fn initialization_cleanup_complete(&self) -> bool {
        !self.cleanup_failed.load(Ordering::SeqCst)
    }
    pub(crate) fn stop_admission(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
    pub(crate) fn admit(&self, internal: bool) -> Result<ExecutionServices, SessionServiceError> {
        if !internal && self.stopping.load(Ordering::SeqCst) {
            return Err(SessionServiceError::new(
                "host_stopping",
                "Host is shutting down.",
            ));
        }
        self.current().unwrap_or_else(|| {
            Err(SessionServiceError::new(
                "host_runtime_starting",
                "Host execution services are still starting.",
            ))
        })
    }
}

/// This endpoint reports transport/catalog availability separately from execution.
/// /api/health retains its full execution-ready contract for CLI and other shells.
pub(crate) async fn readiness(State(host): State<HostState>) -> Json<ApiResponse> {
    let (kernel, session, error) = match host.execution.current() {
        None => ("starting", "starting", None),
        Some(Err(error)) => ("failed", "failed", Some(error)),
        Some(Ok(services)) => {
            match tokio::task::spawn_blocking(move || services.session_service.check_ready()).await
            {
                Ok(Ok(())) => ("ready", "ready", None),
                Ok(Err(error)) => ("ready", "failed", Some(error)),
                Err(error) => (
                    "ready",
                    "failed",
                    Some(SessionServiceError::new(
                        "session_service_health_failed",
                        error.to_string(),
                    )),
                ),
            }
        }
    };
    let data = json!({
        "service": "achbit-kernel-daemon", "version": env!("CARGO_PKG_VERSION"),
        "ok": true, "status": "ok", "catalog": "readable",
        "hostInstanceId": host_process_identity().instance_id,
        "hostPid": host_process_identity().pid,
        "kernel": kernel, "session": session,
        "runtimeError": error.as_ref().map(|error| json!({"code": error.code, "message": error.message})),
        "buildCommit": crate::kernel_api::build_commit(),
        "protocolVersion": "achbit.local-agent",
    });
    ApiResponse::ok(data)
}

/// The connected Host owns these paths; callers must not infer them from HOME.
pub(crate) async fn instance(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "hostInstanceId": host_process_identity().instance_id,
        "hostPid": host_process_identity().pid,
        "version": env!("CARGO_PKG_VERSION"),
        "buildCommit": crate::kernel_api::build_commit(),
        "directories": gui.paths.directories,
        "settingsPath": gui.paths.settings_path,
        "profilesPath": gui.paths.llm_profiles_path,
        "secretsPath": gui.paths.llm_secrets_path,
        "configurationAppliesTo": "nextRun"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn execution_gate_retains_pending_failure_and_shutdown_semantics() {
        let runtime = HostRuntime::default();
        assert_eq!(
            runtime.admit(false).err().unwrap().code,
            "host_runtime_starting"
        );
        let waiter = runtime.wait();
        tokio::pin!(waiter);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), waiter.as_mut())
                .await
                .is_err()
        );
        runtime.stop_admission();
        assert_eq!(runtime.admit(false).err().unwrap().code, "host_stopping");
        runtime.publish(Err(SessionServiceError::new(
            "permission_model_restore_failed",
            "original corrupt history",
        )));
        let error = waiter.await.err().unwrap();
        assert_eq!(error.code, "permission_model_restore_failed");
        assert_eq!(error.message, "original corrupt history");
        assert_eq!(
            runtime.admit(true).err().unwrap().code,
            "permission_model_restore_failed"
        );
    }
}
