//! Explicit WSL transport for workspace tools. The Linux worker executes only
//! an admitted Kernel invocation; it owns no Session, Provider or journal.
use crate::executors::*;
use crate::shell_environment::ShellProgram;
use achbit_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WslExecution {
    pub distribution: String,
    pub worker: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkerRequest {
    Describe {
        settings: Value,
    },
    Execute {
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
        distribution: String,
        shell: ShellProgram,
        execution_path: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerFrame {
    Progress { progress: KernelToolProgress },
    Reply { reply: Value },
}

/// Both native and WSL executors deliver the same observation types. A worker
/// stream has one final reply; progress is forwarded while the worker is alive.
pub fn read_worker_frames(
    reader: impl BufRead,
    progress: KernelProgressSink,
) -> std::io::Result<Value> {
    let mut reply = None;
    for line in reader.lines() {
        let line = line?;
        let frame: WorkerFrame = serde_json::from_str(&line).map_err(std::io::Error::other)?;
        if reply.is_some() {
            return Err(std::io::Error::other("WSL frame after final reply"));
        }
        match frame {
            WorkerFrame::Progress { progress: event } => progress.emit(event),
            WorkerFrame::Reply { reply: value } => reply = Some(value),
        }
    }
    reply.ok_or_else(|| std::io::Error::other("WSL worker final reply missing"))
}

impl WslExecution {
    pub fn describe(&self, settings: &Value) -> KernelResult<Value> {
        self.request(
            &WorkerRequest::Describe {
                settings: settings.clone(),
            },
            &KernelCancellationToken::default(),
            Some(Duration::from_secs(15)),
            KernelProgressSink::default(),
        )
    }

    fn request(
        &self,
        request: &WorkerRequest,
        cancellation: &KernelCancellationToken,
        timeout: Option<Duration>,
        progress: KernelProgressSink,
    ) -> KernelResult<Value> {
        if !cfg!(windows) {
            return Err(failure("WSL project execution requires a Windows host."));
        }
        let launcher = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| failure("SystemRoot is unavailable."))?
            .join("System32/wsl.exe");
        let mut child = Command::new(launcher)
            .args([
                "--distribution",
                &self.distribution,
                "--exec",
                &self.worker,
                "--kernel-tool-worker",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| failure(&format!("Cannot start WSL Kernel worker: {error}")))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let output =
            std::thread::spawn(move || read_worker_frames(BufReader::new(stdout), progress));
        let errors = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        });
        let write = serde_json::to_writer(&mut stdin, request)
            .map_err(std::io::Error::other)
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush());
        let started = Instant::now();
        let mut cancelled_at = None;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(error);
                }
                Ok(None) => {}
            }
            if cancelled_at.is_none()
                && (write.is_err()
                    || cancellation.is_cancelled()
                    || timeout.is_some_and(|timeout| started.elapsed() > timeout))
            {
                let _ = stdin.write_all(b"{\"cancel\":true}\n");
                let _ = stdin.flush();
                cancelled_at = Some(Instant::now());
            }
            if cancelled_at.is_some_and(|time| time.elapsed() > Duration::from_secs(5)) {
                // Closing stdin also cancels the Linux worker's owned invocation.
                drop(stdin);
                let _ = child.kill();
                break child.wait();
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let reply = output
            .join()
            .map_err(|_| failure("WSL output reader failed."))?
            .map_err(|error| failure(&error.to_string()))?;
        let error_bytes = errors
            .join()
            .map_err(|_| failure("WSL error reader failed."))?
            .map_err(|error| failure(&error.to_string()))?;
        write.map_err(|error| {
            failure(&format!(
                "WSL request write failed: {error}; {}",
                String::from_utf8_lossy(&error_bytes)
            ))
        })?;
        let status = status.map_err(|error| failure(&error.to_string()))?;
        if !status.success() {
            return Err(failure(&format!(
                "WSL worker exited {status}: {}",
                String::from_utf8_lossy(&error_bytes)
            )));
        }
        Ok(reply)
    }
}

fn failure(message: &str) -> KernelError {
    KernelError::Structured {
        code: "wsl_environment_unavailable",
        stage: "execution",
        message: message.into(),
        details: json!({"toolId":"wsl"}),
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    #[test]
    fn worker_frames_forward_progress_before_final_reply() {
        let frames = [
            WorkerFrame::Progress {
                progress: KernelToolProgress::Started {
                    started_at: "123".into(),
                },
            },
            WorkerFrame::Progress {
                progress: KernelToolProgress::Output {
                    stream: "stdout".into(),
                    offset: 0,
                    bytes: vec![97],
                },
            },
            WorkerFrame::Reply {
                reply: json!({"outcome":"completed"}),
            },
        ];
        let input = frames
            .iter()
            .map(|frame| serde_json::to_string(frame).unwrap() + "\n")
            .collect::<String>();
        let (send, receive) = std::sync::mpsc::channel();
        let result = read_worker_frames(
            std::io::Cursor::new(input),
            KernelProgressSink::new(move |event| {
                send.send(event).unwrap();
            }),
        )
        .unwrap();
        assert!(matches!(
            receive.recv().unwrap(),
            KernelToolProgress::Started { .. }
        ));
        assert!(matches!(
            receive.recv().unwrap(),
            KernelToolProgress::Output { offset: 0, .. }
        ));
        assert_eq!(result["outcome"], "completed");
        assert!(read_worker_frames(std::io::Cursor::new(""), Default::default()).is_err());
    }
}

pub(crate) struct WslExecutor {
    pub target: WslExecution,
    pub shell: Option<ShellProgram>,
    pub execution_path: Option<String>,
}
impl KernelToolExecutor for WslExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let cancellation = context.cancellation.clone();
        let shell_call = matches!(invocation.input.tool_id().as_str(), "bash" | "powershell");
        let progress = context.progress.clone();
        let timeout = match &invocation.input {
            achbit_kernel_tools::kernel_internal::KernelCanonicalInvocation::ProcessShell { timeout, .. }
            | achbit_kernel_tools::kernel_internal::KernelCanonicalInvocation::ProcessPowerShell { timeout, .. } => timeout.map(|seconds| Duration::from_secs(u64::from(seconds) + 30)),
            _ => Some(Duration::from_secs(150)),
        };
        let shell = self
            .shell
            .clone()
            .ok_or_else(|| failure("The prepared WSL shell is missing."))?;
        let result = self.target.request(
            &WorkerRequest::Execute {
                invocation,
                context,
                distribution: self.target.distribution.clone(),
                shell,
                execution_path: self
                    .execution_path
                    .clone()
                    .ok_or_else(|| failure("The prepared WSL PATH is missing."))?,
            },
            &cancellation,
            timeout,
            progress,
        )?;
        let mut result: KernelToolExecutionResult = serde_json::from_value(result)
            .map_err(|error| failure(&format!("Invalid WSL tool result: {error}")))?;
        if shell_call {
            if let Some(environment) = result.output.get_mut("environment") {
                environment["executionTarget"] =
                    json!({"kind":"wsl", "distribution":self.target.distribution});
            }
        }
        Ok(result)
    }
}
