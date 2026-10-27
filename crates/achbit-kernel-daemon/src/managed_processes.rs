//! Run-owned processes. The Session consumes snapshots; this module never calls a model.
use achbit_kernel_runtime::executors::{
    KernelCancellationToken, KernelProgressSink, KernelToolExecutionResult, KernelToolProgress,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub action: String,
    pub workspace_id: Option<String>,
    pub tool: Option<String>,
    pub input: Option<Value>,
    pub job_id: Option<String>,
    pub wait_seconds: Option<u32>,
}

pub(crate) fn schema(targets: &[&str]) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
        "action":{"type":"string","enum":["start","wait","status","cancel"]},
        "tool":{"type":"string","enum":targets,"description":"For start: the execution tool. Container jobs accept create or exec."},
        "input":{"type":"object","description":"For start: the chosen tool's exact input, excluding workspace and workspaceId; select workspace on this process call. Include any permission request. Omit timeout for no runtime limit."},
        "jobId":{"type":"string","description":"For wait/status/cancel: the jobId returned by start."},
        "waitSeconds":{"type":"integer","minimum":1,"maximum":4294967295u64,"description":"Optional explicit dependency-wait deadline, without stopping the job. Normally omit; completion resumes the task."}
    }});
    if targets.is_empty() {
        schema["properties"]["action"]["enum"] = json!(["wait", "status", "cancel"]);
        let properties = schema["properties"].as_object_mut().expect("object schema");
        properties.remove("tool");
        properties.remove("input");
    }
    schema
}

pub(crate) fn parse(raw: Value) -> Result<Input, String> {
    let value: Input = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if value.wait_seconds.is_some() && (value.action != "wait" || value.wait_seconds == Some(0)) {
        return Err("waitSeconds is a positive duration for wait only.".into());
    }
    match value.action.as_str() {
        "start"
            if matches!(
                value.tool.as_deref(),
                Some("bash" | "powershell" | "container")
            ) && value.input.as_ref().is_some_and(Value::is_object)
                && value.job_id.is_none() =>
        {
            if value.tool.as_deref() == Some("container")
                && !matches!(
                    value.input.as_ref().unwrap()["action"].as_str(),
                    Some("create" | "exec")
                )
            {
                return Err("Container jobs accept create or exec.".into());
            }
        }
        "wait" | "status" | "cancel"
            if value
                .job_id
                .as_ref()
                .is_some_and(|id| !id.trim().is_empty())
                && value.tool.is_none()
                && value.input.is_none() => {}
        _ => return Err("start requires tool and input; wait/status/cancel require jobId.".into()),
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadRequest {
    pub session_id: String,
    pub run_id: String,
    #[serde(default)]
    pub revisions: BTreeMap<String, u64>,
    #[serde(default)]
    pub wait_ms: u64,
    #[serde(default)]
    pub cancel: bool,
    pub cancel_job_id: Option<String>,
}

struct Entry {
    snapshot: Value,
    visible: bool,
    result: Option<Result<KernelToolExecutionResult, String>>,
    published: Option<Instant>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    cancellation: KernelCancellationToken,
    thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct Registry {
    entries: Mutex<BTreeMap<String, Entry>>,
    updated: Condvar,
    released: AtomicU64,
}

#[derive(Clone, Default)]
pub(crate) struct Jobs(Arc<Registry>);

impl Jobs {
    pub fn start<F>(&self, snapshot: Value, execute: F) -> Result<Value, String>
    where
        F: FnOnce(
                KernelCancellationToken,
                KernelProgressSink,
            ) -> Result<KernelToolExecutionResult, String>
            + Send
            + 'static,
    {
        self.start_inner(
            snapshot,
            true,
            KernelCancellationToken::default(),
            KernelProgressSink::default(),
            execute,
        )
    }

    fn start_inner<F>(
        &self,
        mut snapshot: Value,
        visible: bool,
        cancellation: KernelCancellationToken,
        foreground: KernelProgressSink,
        execute: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(
                KernelCancellationToken,
                KernelProgressSink,
            ) -> Result<KernelToolExecutionResult, String>
            + Send
            + 'static,
    {
        let id = snapshot["jobId"]
            .as_str()
            .ok_or("Job identity missing")?
            .to_owned();
        snapshot["revision"] = json!(1);
        snapshot["status"] = json!("active");
        snapshot["startedAt"] = json!(crate::now_text());
        snapshot["output"] =
            json!({"stdout":"","stderr":"","stdoutBytes":0,"stderrBytes":0,"truncated":false});
        let initial = snapshot.clone();
        let mut entries = self
            .0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?;
        if entries.contains_key(&id) {
            return Err("Job already started".into());
        }
        entries.insert(
            id.clone(),
            Entry {
                snapshot,
                visible,
                result: None,
                published: None,
                stdout: vec![],
                stderr: vec![],
                cancellation: cancellation.clone(),
                thread: None,
            },
        );
        let jobs = self.clone();
        let output_jobs = self.clone();
        let output_id = id.clone();
        let progress = KernelProgressSink::new(move |event| {
            // Forward live output only while this is still a foreground call.
            let visible = output_jobs
                .0
                .entries
                .lock()
                .expect("process registry")
                .get(&output_id)
                .is_none_or(|entry| entry.visible);
            if !visible {
                foreground.emit(event.clone());
            }
            let KernelToolProgress::Output { stream, bytes, .. } = event else {
                return;
            };
            let mut entries = output_jobs.0.entries.lock().expect("process registry");
            let Some(entry) = entries.get_mut(&output_id) else {
                return;
            };
            let target = if stream == "stdout" {
                &mut entry.stdout
            } else {
                &mut entry.stderr
            };
            target.extend_from_slice(&bytes);
            if target.len() > 32 * 1024 {
                target.drain(..target.len() - 32 * 1024);
                entry.snapshot["output"]["truncated"] = json!(true);
            }
            entry.snapshot["output"][&stream] = json!(String::from_utf8_lossy(target));
            let count = format!("{stream}Bytes");
            entry.snapshot["output"][&count] =
                json!(entry.snapshot["output"][&count].as_u64().unwrap_or(0) + bytes.len() as u64);
            entry.snapshot["lastOutputAt"] = json!(crate::now_text());
            entry.snapshot["revision"] = json!(entry.snapshot["revision"].as_u64().unwrap() + 1);
            // Output is sampled by Session every 30 seconds; only lifecycle changes wake it early.
        });
        let job_id = id.clone();
        let handle = std::thread::Builder::new()
            .name("achbit-process".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    execute(cancellation, progress)
                }))
                .unwrap_or_else(|_| Err("Managed process executor panicked".into()));
                let mut entries = jobs.0.entries.lock().expect("process registry");
                let entry = entries.get_mut(&job_id).expect("registered process");
                entry.result = Some(result.clone());
                entry.snapshot["completedAt"] = json!(crate::now_text());
                match result {
                    Ok(result) => {
                        entry.snapshot["status"] = json!(if result
                            .error
                            .as_ref()
                            .is_some_and(|error| error.code == "tool_execution_cancelled")
                        {
                            "cancelled"
                        } else if result.error.is_some() {
                            "failed"
                        } else {
                            "completed"
                        });
                        entry.snapshot["result"] = result.output;
                        if let Some(error) = result.error {
                            entry.snapshot["error"] =
                                json!({"code":error.code,"message":error.message});
                        }
                    }
                    Err(message) => {
                        entry.snapshot["status"] = json!("failed");
                        entry.snapshot["error"] =
                            json!({"code":"managed_process_failed","message":message});
                    }
                }
                entry.snapshot["revision"] =
                    json!(entry.snapshot["revision"].as_u64().unwrap() + 1);
                jobs.0.updated.notify_all();
            })
            .map_err(|error| {
                entries.remove(&id);
                error.to_string()
            })?;
        entries.get_mut(&id).unwrap().thread = Some(handle);
        self.0.updated.notify_all();
        Ok(initial)
    }

    pub fn foreground<F>(
        &self,
        snapshot: Value,
        cancellation: KernelCancellationToken,
        progress: KernelProgressSink,
        execute: F,
    ) -> Result<KernelToolExecutionResult, String>
    where
        F: FnOnce(
                KernelCancellationToken,
                KernelProgressSink,
            ) -> Result<KernelToolExecutionResult, String>
            + Send
            + 'static,
    {
        let invocation_id = snapshot["attemptId"]
            .as_str()
            .ok_or("Attempt identity missing")?
            .to_owned();
        let job = self.start_inner(snapshot, false, cancellation.clone(), progress, execute)?;
        let id = job["jobId"].as_str().ok_or("Job identity missing")?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut entries = self
            .0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?;
        loop {
            let entry = entries
                .get_mut(id)
                .ok_or("Managed foreground job missing")?;
            if let Some(result) = entry.result.clone() {
                let mut entry = entries.remove(id).expect("registered foreground job");
                drop(entries);
                if let Some(handle) = entry.thread.take() {
                    handle.join().map_err(|_| "Managed process thread failed")?;
                }
                return result;
            }
            if !cancellation.is_cancelled() && Instant::now() >= deadline {
                entry.visible = true;
                let job = entry.snapshot.clone();
                self.0.updated.notify_all();
                return Ok(KernelToolExecutionResult {
                    invocation_id,
                    outcome:
                        achbit_kernel_runtime::executors::KernelToolExecutionOutcome::Completed,
                    output: json!({"job":job}),
                    error: None,
                });
            }
            entries = self
                .0
                .updated
                .wait_timeout(entries, Duration::from_millis(100))
                .map_err(|_| "Process wait failed")?
                .0;
        }
    }

    pub fn snapshots(
        &self,
        session: &str,
        run: &str,
        revisions: &BTreeMap<String, u64>,
        wait_ms: u64,
    ) -> Result<Vec<Value>, String> {
        const INTERVAL: Duration = Duration::from_secs(30);
        let mut entries = self
            .0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?;
        let released = self.0.released.load(Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_millis(wait_ms.min(30_000));
        loop {
            let mut snapshots = Vec::new();
            for entry in entries.values_mut().filter(|entry| {
                entry.visible
                    && entry.snapshot["sessionId"] == session
                    && entry.snapshot["runId"] == run
            }) {
                let id = entry.snapshot["jobId"].as_str().unwrap();
                let revision = entry.snapshot["revision"].as_u64().unwrap();
                let active = entry.snapshot["status"] == "active";
                let due = entry.published.is_none_or(|at| at.elapsed() >= INTERVAL);
                if !revisions.contains_key(id)
                    || (!active || wait_ms == 0) && revisions.get(id) != Some(&revision)
                    || active && due
                {
                    if active && revisions.get(id) == Some(&revision) {
                        entry.snapshot["revision"] = json!(revision + 1);
                    }
                    entry.published = Some(Instant::now());
                    snapshots.push(entry.snapshot.clone());
                }
            }
            if !snapshots.is_empty()
                || Instant::now() >= deadline
                || self.0.released.load(Ordering::Relaxed) != released
            {
                return Ok(snapshots);
            }
            entries = self
                .0
                .updated
                .wait_timeout(entries, deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "Process wait failed")?
                .0;
        }
    }

    pub fn control(
        &self,
        session: &str,
        run: &str,
        id: &str,
        action: &str,
        wait_seconds: Option<u32>,
        cancellation: &KernelCancellationToken,
    ) -> Result<Value, String> {
        let mut entries = self
            .0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?;
        let deadline =
            wait_seconds.map(|seconds| Instant::now() + Duration::from_secs(seconds.into()));
        loop {
            let entry = entries
                .get(id)
                .filter(|entry| {
                    entry.snapshot["sessionId"] == session && entry.snapshot["runId"] == run
                })
                .ok_or("Job does not belong to this run")?;
            if action == "cancel" {
                entry.cancellation.cancel();
            }
            if action == "status"
                || entry.snapshot["status"] != "active"
                || deadline.is_some_and(|at| Instant::now() >= at)
            {
                return Ok(entry.snapshot.clone());
            }
            if cancellation.is_cancelled() {
                return Err("Process wait was cancelled".into());
            }
            entries = self
                .0
                .updated
                .wait_timeout(entries, Duration::from_millis(100))
                .map_err(|_| "Process wait failed")?
                .0;
        }
    }

    pub fn cancel_run(&self, session: &str, run: &str) -> Result<(), String> {
        let handles = {
            let mut entries = self
                .0
                .entries
                .lock()
                .map_err(|_| "Process registry lock failed")?;
            entries
                .values_mut()
                .filter(|entry| {
                    entry.snapshot["sessionId"] == session && entry.snapshot["runId"] == run
                })
                .filter_map(|entry| {
                    entry.cancellation.cancel();
                    entry.thread.take()
                })
                .collect::<Vec<_>>()
        };
        for handle in handles {
            handle.join().map_err(|_| "Managed process thread failed")?;
        }
        Ok(())
    }
    pub fn release_run(&self, session: &str, run: &str) -> Result<(), String> {
        self.cancel_run(session, run)?;
        self.0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?
            .retain(|_, entry| {
                entry.snapshot["sessionId"] != session || entry.snapshot["runId"] != run
            });
        self.0.released.fetch_add(1, Ordering::Relaxed);
        self.0.updated.notify_all();
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let owners = self
            .0
            .entries
            .lock()
            .map_err(|_| "Process registry lock failed")?
            .values()
            .map(|entry| {
                (
                    entry.snapshot["sessionId"].as_str().unwrap().to_owned(),
                    entry.snapshot["runId"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<std::collections::BTreeSet<_>>();
        for (session, run) in owners {
            self.release_run(&session, &run)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use achbit_kernel_runtime::executors::{
        KernelToolExecutionFailure, KernelToolExecutionOutcome,
    };
    fn snapshot() -> Value {
        json!({"jobId":"job:test", "sessionId":"session:test", "runId":"run:test",
        "callId":"call:test", "attemptId":"attempt:test", "toolName":"bash", "command":"command", "targets":[]})
    }
    fn result(error: Option<KernelToolExecutionFailure>) -> KernelToolExecutionResult {
        KernelToolExecutionResult {
            invocation_id: "attempt:test".into(),
            outcome: if error.is_some() {
                KernelToolExecutionOutcome::Failed
            } else {
                KernelToolExecutionOutcome::Completed
            },
            output: json!({"stdout":"preserved", "exitCode":0}),
            error,
        }
    }
    #[test]
    fn foreground_short_keeps_original_result_without_publishing_a_job() {
        let jobs = Jobs::default();
        let reply = jobs
            .foreground(
                snapshot(),
                Default::default(),
                Default::default(),
                |_, _| Ok(result(None)),
            )
            .unwrap();
        assert_eq!(reply, result(None));
        assert!(jobs
            .snapshots("session:test", "run:test", &Default::default(), 0)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn foreground_yields_the_same_execution_and_cancellation_reaps_it() {
        let jobs = Jobs::default();
        let count = Arc::new(AtomicU64::new(0));
        let executed = count.clone();
        let reply = jobs
            .foreground(
                snapshot(),
                Default::default(),
                Default::default(),
                move |cancel, _| {
                    executed.fetch_add(1, Ordering::SeqCst);
                    while !cancel.is_cancelled() {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Ok(result(Some(KernelToolExecutionFailure {
                        code: "tool_execution_cancelled".into(),
                        message: "cancelled".into(),
                    })))
                },
            )
            .unwrap();
        assert_eq!(reply.output["job"]["status"], "active");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let terminal = jobs
            .control(
                "session:test",
                "run:test",
                "job:test",
                "cancel",
                None,
                &Default::default(),
            )
            .unwrap();
        assert_eq!(terminal["status"], "cancelled");
        assert_eq!(terminal["result"]["stdout"], "preserved");
        jobs.release_run("session:test", "run:test").unwrap();
    }
    #[test]
    fn explicit_sync_reads_fresh_output_without_waking_the_background_feed() {
        let jobs = Jobs::default();
        let (send, receive) = std::sync::mpsc::channel();
        let (ready, received) = std::sync::mpsc::channel();
        jobs.start(snapshot(), move |cancel, progress| {
            receive.recv().unwrap();
            progress.emit(KernelToolProgress::Output {
                stream: "stdout".into(),
                bytes: b"progress".to_vec(),
                offset: 0,
            });
            ready.send(()).unwrap();
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(result(None))
        })
        .unwrap();
        let initial = jobs
            .snapshots("session:test", "run:test", &Default::default(), 0)
            .unwrap();
        let revisions =
            BTreeMap::from([("job:test".into(), initial[0]["revision"].as_u64().unwrap())]);
        send.send(()).unwrap();
        received.recv().unwrap();
        assert!(jobs
            .snapshots("session:test", "run:test", &revisions, 1)
            .unwrap()
            .is_empty());
        let fresh = jobs
            .snapshots("session:test", "run:test", &revisions, 0)
            .unwrap();
        assert_eq!(fresh[0]["output"]["stdout"], "progress");
        assert_eq!(fresh[0]["status"], "active");
        jobs.control(
            "session:test",
            "run:test",
            "job:test",
            "cancel",
            None,
            &Default::default(),
        )
        .unwrap();
        jobs.release_run("session:test", "run:test").unwrap();
    }
    #[test]
    fn container_preparation_can_be_managed() {
        assert!(parse(json!({"action":"start", "tool":"container", "input":{"action":"create", "image":"test"}})).is_ok());
        assert!(
            parse(json!({"action":"start", "tool":"container", "input":{"action":"inspect"}}))
                .is_err()
        );
    }
}
