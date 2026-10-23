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

pub(crate) fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
        "action":{"type":"string","enum":["start","wait","status","cancel"]},
        "tool":{"type":"string","enum":["bash","powershell","container"],"description":"For start: an available execution tool. Container jobs accept exec only."},
        "input":{"type":"object","description":"For start: the chosen tool's exact input, excluding workspace and workspaceId; select workspace on this process call. Include any permission request. Omit timeout for no runtime limit."},
        "jobId":{"type":"string","description":"For wait/status/cancel: the jobId returned by start."},
        "waitSeconds":{"type":"integer","minimum":1,"maximum":4294967295u64,"description":"For wait only: return the current status after this many seconds without stopping the job. Omit to wait until it ends."}
    }})
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
                && value.input.as_ref().unwrap()["action"] != "exec"
            {
                return Err(
                    "Container jobs accept exec only; create the test container first.".into(),
                );
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
}

struct Entry {
    snapshot: Value,
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
    pub fn start<F>(&self, mut snapshot: Value, execute: F) -> Result<Value, String>
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
        let cancellation = KernelCancellationToken::default();
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
            .name("deepcode-process".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    execute(cancellation, progress)
                }))
                .unwrap_or_else(|_| Err("Managed process executor panicked".into()));
                let mut entries = jobs.0.entries.lock().expect("process registry");
                let entry = entries.get_mut(&job_id).expect("registered process");
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
                entry.snapshot["sessionId"] == session && entry.snapshot["runId"] == run
            }) {
                let id = entry.snapshot["jobId"].as_str().unwrap();
                let revision = entry.snapshot["revision"].as_u64().unwrap();
                let active = entry.snapshot["status"] == "active";
                let due = entry.published.is_none_or(|at| at.elapsed() >= INTERVAL);
                if !revisions.contains_key(id)
                    || !active && revisions.get(id) != Some(&revision)
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
