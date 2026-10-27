//! Direct CLI execution, pinned to the prepared contribution and owned by one attempt.
use crate::local_agent_mcp::{McpRuntimeError, McpToolCallFailure, McpToolCallResult};
use achbit_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree_checked, OwnedHostProcess,
};
use achbit_kernel_runtime::executors::KernelToolExecutionContext;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub(crate) struct CliClient {
    pub command: String,
    pub args: Vec<String>,
    /// Local single-file bundle bytes are captured at preparation, before authorization waits.
    pub entry: Option<(String, Vec<u8>)>,
}
impl CliClient {
    pub(crate) fn call(
        &self,
        name: &str,
        arguments: Value,
        metadata: Option<Value>,
        context: &KernelToolExecutionContext,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        let fail = |code, message| McpRuntimeError::new(code, message);
        if context.cancellation.is_cancelled() {
            return Err(fail(
                "tool_cancelled",
                "CLI call cancelled before spawn".into(),
            ));
        }
        let mut metadata = metadata.unwrap_or_else(|| json!({}));
        if let Some(directory) = &context.output_directory {
            std::fs::create_dir_all(directory)
                .map_err(|error| fail("cli_archive_failed", error.to_string()))?;
            metadata["achbit"]["outputDirectory"] = json!(directory);
        }
        let mut command = Command::new(&self.command);
        if let Some((filename, bytes)) = &self.entry {
            let archive = context.output_directory.as_ref().ok_or_else(|| {
                fail(
                    "cli_archive_missing",
                    "CLI bundle requires an attempt archive".into(),
                )
            })?;
            std::fs::create_dir_all(archive)
                .map_err(|error| fail("cli_bundle_write_failed", error.to_string()))?;
            let path = archive.join(format!("plugin-{filename}"));
            std::fs::write(&path, bytes)
                .map_err(|error| fail("cli_bundle_write_failed", error.to_string()))?;
            command.arg(path);
        }
        command
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = &context.workspace_root {
            command.current_dir(directory);
        }
        let child = spawn_owned_host_process(&mut command)
            .map_err(|error| fail("cli_spawn_failed", format!("{}: {error}", self.command)))?;
        let mut owned = OwnedCli {
            process: child,
            stopped: false,
            workers: None,
        };
        let mut stdin = owned
            .process
            .child
            .stdin
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stdin is unavailable".into()))?;
        let stdout = owned
            .process
            .child
            .stdout
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stdout is unavailable".into()))?;
        let stderr = owned
            .process
            .child
            .stderr
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stderr is unavailable".into()))?;
        let output = std::thread::spawn(move || bounded_output(stdout, 4 * 1024 * 1024));
        let errors = std::thread::spawn(move || bounded_output(stderr, 64 * 1024));
        // Writing also runs on a pipe worker so cancellation can stop a non-reading process.
        let request = json!({"name":name,"arguments":arguments,"context":metadata});
        let input = std::thread::spawn(move || {
            serde_json::to_writer(&mut stdin, &request)
                .map_err(|error| error.to_string())
                .and_then(|_| stdin.flush().map_err(|error| error.to_string()))
        });
        owned.workers = Some(CliWorkers {
            input,
            output,
            errors,
        });
        let start = Instant::now();
        let status = loop {
            if context.cancellation.is_cancelled() {
                break Err(fail("tool_cancelled", "CLI call cancelled".into()));
            }
            if start.elapsed() >= Duration::from_secs(60) {
                break Err(fail("cli_timeout", "CLI call exceeded 60 seconds".into()));
            }
            match owned.process.child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => break Err(fail("cli_wait_failed", error.to_string())),
            }
        };
        if let Err(error) = owned.stop() {
            let mut original = match status {
                Err(error) => error,
                Ok(status) if !status.success() => fail(
                    "cli_process_failed",
                    format!("{} exited {status}", self.command),
                ),
                Ok(_) => fail(
                    "cli_cleanup_failed",
                    "CLI process tree cleanup failed".into(),
                ),
            };
            original
                .message
                .push_str(&format!("; cleanup failed: {error}"));
            return Err(original);
        }
        let CliWorkers {
            input,
            output,
            errors,
        } = owned
            .workers
            .take()
            .expect("CLI workers belong to this attempt");
        // Collect every worker before propagating a failure; none outlives this attempt.
        let input = input
            .join()
            .map_err(|_| fail("cli_input_failed", "CLI stdin worker failed".into()))
            .and_then(|result| result.map_err(|message| fail("cli_input_failed", message)));
        let output = output
            .join()
            .map_err(|_| fail("cli_output_failed", "CLI stdout worker failed".into()))
            .and_then(|result| result.map_err(|message| fail("cli_output_failed", message)));
        let errors = errors
            .join()
            .map_err(|_| fail("cli_output_failed", "CLI stderr worker failed".into()))
            .and_then(|result| result.map_err(|message| fail("cli_output_failed", message)));
        (|| {
            let status = status?;
            if !status.success() {
                let detail = match &errors {
                    Ok(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                    Err(error) => format!("stderr capture failed: {}", error.message),
                };
                return Err(fail(
                    "cli_process_failed",
                    format!("{} exited {status}: {detail}", self.command),
                ));
            }
            input?;
            let output = output?;
            errors?;
            let value: Value = serde_json::from_slice(&output).map_err(|error| {
                fail(
                    "cli_output_invalid",
                    format!("CLI must return one JSON result: {error}"),
                )
            })?;
            let failure = value
                .get("error")
                .filter(|error| !error.is_null())
                .map(|error| McpToolCallFailure {
                    code: error["code"]
                        .as_str()
                        .unwrap_or("cli_tool_failed")
                        .to_string(),
                    message: error["message"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| error.to_string()),
                });
            Ok(McpToolCallResult {
                output: value,
                failure,
            })
        })()
    }
}
fn bounded_output(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut overflow = false;
    loop {
        let size = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        let keep = size.min(limit.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        overflow |= keep < size;
    }
    if overflow {
        Err(format!("CLI output exceeds {limit} bytes"))
    } else {
        Ok(result)
    }
}
struct CliWorkers {
    input: std::thread::JoinHandle<Result<(), String>>,
    output: std::thread::JoinHandle<Result<Vec<u8>, String>>,
    errors: std::thread::JoinHandle<Result<Vec<u8>, String>>,
}

struct OwnedCli {
    process: OwnedHostProcess,
    stopped: bool,
    workers: Option<CliWorkers>,
}
impl OwnedCli {
    fn stop(&mut self) -> std::io::Result<()> {
        if self.stopped {
            return Ok(());
        }
        terminate_owned_process_tree_checked(&mut self.process)?;
        self.stopped = true;
        Ok(())
    }
}
impl Drop for OwnedCli {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("CLI process cleanup failed: {error}");
            return;
        }
        if let Some(workers) = self.workers.take() {
            for (stream, result) in [
                ("stdin", workers.input.join().map(|value| value.map(|_| ()))),
                (
                    "stdout",
                    workers.output.join().map(|value| value.map(|_| ())),
                ),
                (
                    "stderr",
                    workers.errors.join().map(|value| value.map(|_| ())),
                ),
            ] {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("CLI {stream} cleanup failed: {error}"),
                    Err(_) => eprintln!("CLI {stream} worker panicked during cleanup"),
                }
            }
        }
    }
}
