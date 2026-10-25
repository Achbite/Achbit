use achbit_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree_checked, OwnedHostProcess,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "deepcode.local-agent";
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_STDERR_RECEIPT_BYTES: usize = 16 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
// Kernel cancellation can spend 30 seconds completing physical cleanup before
// Session can settle the run and acknowledge shutdown.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone)]
pub(crate) struct SessionServiceError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) details: Option<Value>,
}

impl SessionServiceError {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct SessionServiceProcess {
    process: Arc<Mutex<OwnedSessionService>>,
    next_request: Arc<AtomicU64>,
}

impl std::fmt::Debug for SessionServiceProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SessionServiceProcess")
    }
}

impl SessionServiceProcess {
    pub(crate) fn spawn(api_base: &str, service_token: &str) -> Result<Self, SessionServiceError> {
        let bridge = resolve_bridge()?;
        let node = resolve_node()?;
        let mut command = Command::new(node);
        command
            .arg(bridge)
            .env("DEEPCODE_LOCAL_AGENT_API_BASE", api_base)
            .env("DEEPCODE_LOCAL_AGENT_TOKEN", service_token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = spawn_owned_host_process(&mut command).map_err(|error| {
            SessionServiceError::new(
                "session_service_spawn_failed",
                format!("启动 Node Session Service 失败：{error}"),
            )
        })?;
        Self::from_process(child)
    }

    fn from_process(child: OwnedHostProcess) -> Result<Self, SessionServiceError> {
        let mut starting = ChildStartupGuard::new(child);
        let mut stdin = starting.child_mut().stdin.take().ok_or_else(|| {
            SessionServiceError::new(
                "session_service_pipe_failed",
                "Node Session Service 缺少标准输入管道。",
            )
        })?;
        let stdout = starting.child_mut().stdout.take().ok_or_else(|| {
            SessionServiceError::new(
                "session_service_pipe_failed",
                "Node Session Service 缺少标准输出管道。",
            )
        })?;
        let stderr_receipt = Arc::new(Mutex::new(Vec::new()));
        let stderr_reader = starting.child_mut().stderr.take().map(|mut stderr| {
            let receipt = Arc::clone(&stderr_receipt);
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 8192];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    append_stderr_receipt(&receipt, &buffer[..read]);
                }
            })
        });
        let responses = Arc::new(Mutex::new(PendingResponses::default()));
        let reader_responses = Arc::clone(&responses);
        let stdout_reader = std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                let encoded = read_response(&mut stdout);
                #[cfg(feature = "debug-control")]
                if encoded.as_ref().is_ok_and(|value| {
                    value.get("type").and_then(Value::as_str) == Some("debug.observation")
                }) {
                    if let Ok(mut pending) = reader_responses.lock() {
                        pending.deliver_debug_observation(encoded.expect("decoded observation"));
                    }
                    continue;
                }
                let response = encoded.and_then(decode_response);
                let Ok(mut pending) = reader_responses.lock() else {
                    break;
                };
                if pending.terminal_error.is_some() {
                    break;
                }
                match response {
                    Ok((request_id, result)) => match pending.requests.remove(&request_id) {
                        Some(sender) => {
                            let _ = sender.send(SessionReply::Response(result));
                        }
                        None => {
                            pending.fail(SessionServiceError::new(
                                "session_service_response_identity_mismatch",
                                "Session Service 回复没有对应的待处理请求。",
                            ));
                            break;
                        }
                    },
                    Err(error) => {
                        pending.fail(error);
                        break;
                    }
                }
            }
        });
        let (writer, writes) = mpsc::channel::<Vec<u8>>();
        let writer_responses = Arc::clone(&responses);
        let stdin_writer = std::thread::spawn(move || {
            while let Ok(encoded) = writes.recv() {
                let Ok(pending) = writer_responses.lock() else {
                    break;
                };
                if pending.terminal_error.is_some() {
                    break;
                }
                drop(pending);
                if let Err(error) = stdin.write_all(&encoded).and_then(|_| stdin.flush()) {
                    if let Ok(mut pending) = writer_responses.lock() {
                        pending.fail(SessionServiceError::new(
                            "session_service_request_write_failed",
                            format!("写入 Session Service 请求失败：{error}"),
                        ));
                    }
                    break;
                }
            }
        });
        let service = Self {
            process: Arc::new(Mutex::new(OwnedSessionService {
                owned: starting.commit(),
                writer: Some(writer),
                stdin_writer: Some(stdin_writer),
                responses,
                stdout_reader: Some(stdout_reader),
                stderr_receipt,
                stderr_reader,
                stopped: false,
                closing: false,
            })),
            next_request: Arc::new(AtomicU64::new(1)),
        };
        let ready = service.request_with_timeout("health", json!({}), STARTUP_TIMEOUT)?;
        if ready.get("state").and_then(Value::as_str) != Some("ready") {
            return Err(service
                .process
                .lock()
                .map_err(|_| transport_lock_error())?
                .fail_and_stop(SessionServiceError::new(
                    "session_service_not_ready",
                    "Session Service 启动握手没有返回 ready。",
                )));
        }
        Ok(service)
    }

    pub(crate) fn request(
        &self,
        operation: &str,
        data: Value,
    ) -> Result<Value, SessionServiceError> {
        self.request_with_timeout(operation, data, REQUEST_TIMEOUT)
    }

    /// Register before submitting a task. The stdout reader delivers events without polling.
    #[cfg(feature = "debug-control")]
    pub(crate) fn debug_subscribe(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        input_budget_tokens: Option<u64>,
    ) -> Result<(String, tokio::sync::mpsc::Receiver<Value>), SessionServiceError> {
        let id = format!(
            "observation:{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = tokio::sync::mpsc::channel(8);
        let responses = Arc::clone(
            &self
                .process
                .lock()
                .map_err(|_| transport_lock_error())?
                .responses,
        );
        responses.lock().map_err(|_| transport_lock_error())?.debug_observers.insert(id.clone(), DebugObserver {
            sender: Some(sender), status: json!({"subscriptionId":id,"status":"active","coverage":"complete","lastDeliveredSequence":0}),
        });
        let mut data = json!({"subscriptionId":id,"sessionId":session_id});
        if let Some(run_id) = run_id {
            data["runId"] = json!(run_id);
        }
        if let Some(budget) = input_budget_tokens {
            data["inputBudgetTokens"] = json!(budget);
        }
        if let Err(error) = self.request("debug.subscribe", data) {
            responses
                .lock()
                .map_err(|_| transport_lock_error())?
                .debug_observers
                .remove(&id);
            return Err(error);
        }
        Ok((id, receiver))
    }

    #[cfg(feature = "debug-control")]
    pub(crate) fn debug_unsubscribe(&self, id: &str) -> Result<Value, SessionServiceError> {
        let reply = self.request("debug.unsubscribe", json!({"subscriptionId":id}));
        let responses = Arc::clone(
            &self
                .process
                .lock()
                .map_err(|_| transport_lock_error())?
                .responses,
        );
        if let Some(observer) = responses
            .lock()
            .map_err(|_| transport_lock_error())?
            .debug_observers
            .get_mut(id)
        {
            observer.sender = None;
            if observer.status["status"] != "failed" {
                observer.status["status"] = json!("closed");
            }
        }
        reply
    }

    #[cfg(feature = "debug-control")]
    pub(crate) fn debug_observation_status(&self, id: &str) -> Result<Value, SessionServiceError> {
        let responses = Arc::clone(
            &self
                .process
                .lock()
                .map_err(|_| transport_lock_error())?
                .responses,
        );
        let transport = responses
            .lock()
            .map_err(|_| transport_lock_error())?
            .debug_observers
            .get(id)
            .map(|o| o.status.clone());
        if transport
            .as_ref()
            .is_some_and(|value| value["status"] == "failed")
        {
            return Ok(transport.expect("present"));
        }
        let mut status = self.request("debug.observationStatus", json!({"subscriptionId":id}))?;
        if let Some(transport) = transport {
            status["transport"] = transport;
        }
        Ok(status)
    }

    fn request_with_timeout(
        &self,
        operation: &str,
        data: Value,
        timeout: Duration,
    ) -> Result<Value, SessionServiceError> {
        let deadline = Instant::now() + timeout;
        let request_id = format!("host:{}", self.next_request.fetch_add(1, Ordering::Relaxed));
        let receiver = self
            .process
            .lock()
            .map_err(|_| transport_lock_error())?
            .begin_request(&request_id, operation, data)?;
        self.receive_response(receiver, deadline.saturating_duration_since(Instant::now()))
    }

    fn receive_response(
        &self,
        receiver: mpsc::Receiver<SessionReply>,
        timeout: Duration,
    ) -> Result<Value, SessionServiceError> {
        match receiver.recv_timeout(timeout) {
            Ok(SessionReply::Response(result)) => result,
            Ok(SessionReply::TransportFailure(error)) => Err(self
                .process
                .lock()
                .map_err(|_| transport_lock_error())?
                .fail_and_stop(error)),
            Err(error) => {
                let failure = match error {
                    mpsc::RecvTimeoutError::Timeout => SessionServiceError::new(
                        "session_service_response_timeout",
                        "Session Service 在本地 transport 截止时间内没有回复。",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => SessionServiceError::new(
                        "session_service_response_reader_failed",
                        "Session Service 回复读取线程异常结束。",
                    ),
                };
                Err(self
                    .process
                    .lock()
                    .map_err(|_| transport_lock_error())?
                    .fail_and_stop(failure))
            }
        }
    }

    pub(crate) fn check_ready(&self) -> Result<(), SessionServiceError> {
        let mut process = self.process.lock().map_err(|_| transport_lock_error())?;
        process.ensure_running()
    }

    pub(crate) fn shutdown(&self) -> Result<(), SessionServiceError> {
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let receiver = {
            let mut process = self.process.lock().map_err(|_| transport_lock_error())?;
            if process.stopped {
                return Ok(());
            }
            let receiver = process.begin_request("host:shutdown", "shutdown", json!({}))?;
            process.closing = true;
            receiver
        };
        let result =
            self.receive_response(receiver, deadline.saturating_duration_since(Instant::now()));
        let mut process = self.process.lock().map_err(|_| transport_lock_error())?;
        match (result, process.finish_shutdown()) {
            (result, Ok(())) => result.map(|_| ()),
            (Ok(_), Err(cleanup)) => Err(cleanup),
            (Err(mut original), Err(cleanup)) => {
                original
                    .message
                    .push_str(&format!(" 清理失败：{}", cleanup.message));
                Err(original)
            }
        }
    }
}

fn transport_lock_error() -> SessionServiceError {
    SessionServiceError::new(
        "session_service_lock_failed",
        "Session Service transport 锁已损坏。",
    )
}

enum SessionReply {
    Response(Result<Value, SessionServiceError>),
    TransportFailure(SessionServiceError),
}

#[derive(Default)]
struct PendingResponses {
    requests: HashMap<String, mpsc::Sender<SessionReply>>,
    terminal_error: Option<SessionServiceError>,
    #[cfg(feature = "debug-control")]
    debug_observers: HashMap<String, DebugObserver>,
}

#[cfg(feature = "debug-control")]
struct DebugObserver {
    sender: Option<tokio::sync::mpsc::Sender<Value>>,
    status: Value,
}

impl PendingResponses {
    #[cfg(feature = "debug-control")]
    fn deliver_debug_observation(&mut self, value: Value) {
        let Some(id) = value.get("subscriptionId").and_then(Value::as_str) else {
            return;
        };
        let Some(observer) = self.debug_observers.get_mut(id) else {
            return;
        };
        let Some(sender) = observer.sender.as_ref() else {
            return;
        };
        let sequence = value.get("sequence").and_then(Value::as_u64);
        if value["protocolVersion"] != PROTOCOL_VERSION || sequence.is_none() {
            observer.status["status"] = json!("failed");
            observer.status["coverage"] = json!("partial");
            observer.status["error"] = json!({"code":"observation_frame_invalid","message":"Observation frame identity is invalid."});
            observer.sender = None;
            return;
        }
        let terminal = matches!(
            value.get("status").and_then(Value::as_str),
            Some("settled" | "failed")
        );
        let terminal_status = value["status"].clone();
        let terminal_error = value["error"].clone();
        match sender.try_send(value) {
            Ok(()) => {
                observer.status["lastDeliveredSequence"] = json!(sequence);
                if terminal {
                    observer.status["status"] = terminal_status;
                    observer.sender = None;
                    if !terminal_error.is_null() {
                        observer.status["error"] = terminal_error;
                        observer.status["coverage"] = json!("partial");
                    }
                }
            }
            Err(error) => {
                observer.status["status"] = json!("failed");
                observer.status["coverage"] = json!("partial");
                observer.status["error"] = json!({"code":"observation_receiver_unavailable","message":error.to_string(),
                    "missingRange":{"fromObservationSequence":sequence,"through":"unknown"},"notificationDelivered":false});
                observer.sender = None;
            }
        }
    }
    fn fail(&mut self, error: SessionServiceError) -> SessionServiceError {
        let error = self.terminal_error.get_or_insert(error).clone();
        #[cfg(feature = "debug-control")]
        for observer in self.debug_observers.values_mut() {
            if observer.sender.take().is_some() {
                observer.status["status"] = json!("failed");
                observer.status["coverage"] = json!("partial");
                observer.status["error"] = json!({"code":error.code,"message":error.message,"missingRange":{"through":"unknown"},"notificationDelivered":false});
            }
        }
        for (_, sender) in self.requests.drain() {
            let _ = sender.send(SessionReply::TransportFailure(error.clone()));
        }
        error
    }
}

struct ChildStartupGuard {
    child: Option<OwnedHostProcess>,
}

impl ChildStartupGuard {
    fn new(child: OwnedHostProcess) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self
            .child
            .as_mut()
            .expect("starting child is present")
            .child
    }

    fn commit(mut self) -> OwnedHostProcess {
        self.child.take().expect("starting child is present")
    }
}

impl Drop for ChildStartupGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = terminate_owned_process_tree_checked(child);
        }
    }
}

struct OwnedSessionService {
    owned: OwnedHostProcess,
    writer: Option<mpsc::Sender<Vec<u8>>>,
    stdin_writer: Option<std::thread::JoinHandle<()>>,
    responses: Arc<Mutex<PendingResponses>>,
    stdout_reader: Option<std::thread::JoinHandle<()>>,
    stderr_receipt: Arc<Mutex<Vec<u8>>>,
    stderr_reader: Option<std::thread::JoinHandle<()>>,
    stopped: bool,
    closing: bool,
}

impl OwnedSessionService {
    fn begin_request(
        &mut self,
        request_id: &str,
        operation: &str,
        data: Value,
    ) -> Result<mpsc::Receiver<SessionReply>, SessionServiceError> {
        self.ensure_running()?;
        let mut encoded = serde_json::to_vec(&json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "operation": operation,
            "data": data,
        }))
        .map_err(|error| {
            SessionServiceError::new(
                "session_service_request_encode_failed",
                format!("编码 Session Service 请求失败：{error}"),
            )
        })?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(SessionServiceError::new(
                "session_service_request_too_large",
                "Session Service 请求超过本地 transport 上限。",
            ));
        }
        encoded.push(b'\n');
        let (sender, receiver) = mpsc::channel();
        {
            let mut responses = self.responses.lock().map_err(|_| transport_lock_error())?;
            if let Some(error) = responses.terminal_error.clone() {
                drop(responses);
                return Err(self.fail_and_stop(error));
            }
            responses.requests.insert(request_id.to_string(), sender);
        }
        if self
            .writer
            .as_ref()
            .is_none_or(|writer| writer.send(encoded).is_err())
        {
            return Err(self.fail_and_stop(SessionServiceError::new(
                "session_service_request_write_failed",
                "Session Service 输入写入线程已经结束。",
            )));
        }
        Ok(receiver)
    }

    fn ensure_running(&mut self) -> Result<(), SessionServiceError> {
        let terminal = self
            .responses
            .lock()
            .map_err(|_| transport_lock_error())?
            .terminal_error
            .clone();
        if self.stopped || self.closing {
            return Err(terminal.unwrap_or_else(|| {
                SessionServiceError::new("session_service_stopped", "Session Service 已停止。")
            }));
        }
        if let Some(error) = terminal {
            return Err(self.fail_and_stop(error));
        }
        match self.owned.child.try_wait() {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err(self.fail_and_stop(SessionServiceError::new(
                "session_service_unavailable",
                "Session Service 已退出。",
            ))),
            Err(error) => Err(self.fail_and_stop(process_wait_error(error))),
        }
    }

    fn join_io(&mut self) -> Result<(), SessionServiceError> {
        let mut failed = Vec::new();
        if let Some(writer) = self.stdin_writer.take() {
            if writer.join().is_err() {
                failed.push("stdin writer");
            }
        }
        if let Some(reader) = self.stdout_reader.take() {
            if reader.join().is_err() {
                failed.push("stdout reader");
            }
        }
        if let Some(reader) = self.stderr_reader.take() {
            if reader.join().is_err() {
                failed.push("stderr reader");
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(SessionServiceError::new(
                "session_service_io_thread_failed",
                format!("Session Service IO 线程异常结束：{}", failed.join(", ")),
            ))
        }
    }

    fn fail_and_stop(&mut self, error: SessionServiceError) -> SessionServiceError {
        let mut terminal = self
            .responses
            .lock()
            .map(|mut responses| responses.fail(error.clone()))
            .unwrap_or(error);
        if self.stopped {
            return terminal;
        }
        self.writer.take();
        self.closing = true;
        match terminate_owned_process_tree_checked(&mut self.owned) {
            Ok(()) => {
                self.stopped = true;
                if let Err(error) = self.join_io() {
                    terminal
                        .message
                        .push_str(&format!(" 清理失败：{}", error.message));
                }
            }
            Err(error) => terminal
                .message
                .push_str(&format!(" 清理 Session Service 进程失败：{error}")),
        }
        terminal.message = message_with_stderr(&terminal.message, &self.stderr_receipt);
        if let Ok(mut responses) = self.responses.lock() {
            responses.terminal_error = Some(terminal.clone());
        }
        terminal
    }

    fn finish_shutdown(&mut self) -> Result<(), SessionServiceError> {
        if self.stopped {
            return Ok(());
        }
        self.writer.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self
                .owned
                .child
                .try_wait()
                .map_err(process_wait_error)?
                .is_some()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        terminate_owned_process_tree_checked(&mut self.owned).map_err(|error| {
            SessionServiceError::new(
                "session_service_kill_failed",
                format!("终止未退出的 Session Service 失败：{error}"),
            )
        })?;
        self.stopped = true;
        self.join_io()
    }
}

impl Drop for OwnedSessionService {
    fn drop(&mut self) {
        self.fail_and_stop(SessionServiceError::new(
            "session_service_stopped",
            "Session Service 已停止。",
        ));
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Vec<u8>, SessionServiceError> {
    let mut encoded = Vec::new();
    loop {
        let (consumed, terminated) = {
            let available = reader.fill_buf().map_err(|error| {
                SessionServiceError::new(
                    "session_service_response_read_failed",
                    format!("读取 Session Service 回复失败：{error}"),
                )
            })?;
            if available.is_empty() {
                return Err(SessionServiceError::new(
                    if encoded.is_empty() {
                        "session_service_response_missing"
                    } else {
                        "session_service_response_invalid"
                    },
                    if encoded.is_empty() {
                        "Session Service 未返回回复。"
                    } else {
                        "Session Service 回复未按本地行协议结束。"
                    },
                ));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            if encoded.len().saturating_add(consumed) > MAX_FRAME_BYTES + 1 {
                return Err(SessionServiceError::new(
                    "session_service_response_invalid",
                    "Session Service 回复超过本地 transport 上限。",
                ));
            }
            encoded.extend_from_slice(&available[..consumed]);
            (consumed, newline.is_some())
        };
        reader.consume(consumed);
        if terminated {
            break;
        }
    }
    encoded.pop();
    if encoded.last() == Some(&b'\r') {
        encoded.pop();
    }
    Ok(encoded)
}

fn read_response(reader: &mut impl BufRead) -> Result<Value, SessionServiceError> {
    let first = read_frame(reader)?;
    let first_value: Value = serde_json::from_slice(&first).map_err(|error| {
        SessionServiceError::new("session_service_response_invalid", error.to_string())
    })?;
    if first_value.get("type").and_then(Value::as_str) != Some("response.chunk") {
        return Ok(first_value);
    }
    let mut chunk = first_value;
    let mut response = Vec::new();
    let mut index = 0_u64;
    loop {
        let valid = chunk.as_object().is_some_and(|object| object.len() == 5)
            && chunk.get("protocolVersion").and_then(Value::as_str) == Some(PROTOCOL_VERSION)
            && chunk.get("type").and_then(Value::as_str) == Some("response.chunk")
            && chunk.get("index").and_then(Value::as_u64) == Some(index);
        let text = chunk.get("text").and_then(Value::as_str);
        let final_chunk = chunk.get("final").and_then(Value::as_bool);
        if !valid || text.is_none_or(str::is_empty) || final_chunk.is_none() {
            return Err(SessionServiceError::new(
                "session_service_response_invalid",
                "Session Service 回复分帧无效。",
            ));
        }
        response.extend_from_slice(text.expect("validated chunk text").as_bytes());
        if final_chunk == Some(true) {
            return decode_response_json(&response);
        }
        index += 1;
        chunk = serde_json::from_slice(&read_frame(reader)?).map_err(|error| {
            SessionServiceError::new("session_service_response_invalid", error.to_string())
        })?;
    }
}

fn append_stderr_receipt(receipt: &Arc<Mutex<Vec<u8>>>, chunk: &[u8]) {
    let Ok(mut buffer) = receipt.lock() else {
        return;
    };
    buffer.extend_from_slice(chunk);
    if buffer.len() > MAX_STDERR_RECEIPT_BYTES {
        let remove = buffer.len() - MAX_STDERR_RECEIPT_BYTES;
        buffer.drain(..remove);
    }
}

fn message_with_stderr(message: &str, receipt: &Arc<Mutex<Vec<u8>>>) -> String {
    let stderr = receipt
        .lock()
        .ok()
        .map(|value| String::from_utf8_lossy(&value).trim().to_string())
        .unwrap_or_default();
    if stderr.is_empty() {
        message.to_string()
    } else {
        format!("{message} Session stderr：{stderr}")
    }
}

fn decode_response_json(encoded: &[u8]) -> Result<Value, SessionServiceError> {
    serde_json::from_slice(encoded).map_err(|error| {
        SessionServiceError::new(
            "session_service_response_json_invalid",
            format!("Session Service 回复不是有效 JSON：{error}"),
        )
    })
}

fn decode_response(
    mut value: Value,
) -> Result<(String, Result<Value, SessionServiceError>), SessionServiceError> {
    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    if value.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION)
        || request_id.is_none()
    {
        return Err(SessionServiceError::new(
            "session_service_response_identity_mismatch",
            "Session Service 回复身份无效。",
        ));
    }
    let request_id = request_id.expect("validated requestId").to_string();
    let result = if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value
            .get_mut("data")
            .map(Value::take)
            .unwrap_or(Value::Null))
    } else {
        let error = value.get("error").and_then(Value::as_object);
        let mut failure = SessionServiceError::new(
            error
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("session_service_request_failed"),
            error
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Session Service 请求失败。"),
        );
        failure.details = error.and_then(|value| value.get("details")).cloned();
        Err(failure)
    };
    Ok((request_id, result))
}

fn resolve_bridge() -> Result<PathBuf, SessionServiceError> {
    runtime_file(
        "DEEPCODE_SESSION_BRIDGE",
        if cfg!(feature = "debug-control") {
            "session-core/dist/debug/sessionServiceBridge.js"
        } else {
            "session-core/dist/sessionServiceBridge.js"
        },
    )
}

fn resolve_node() -> Result<PathBuf, SessionServiceError> {
    runtime_file(
        "DEEPCODE_NODE",
        if cfg!(windows) {
            "node/bin/node.exe"
        } else {
            "node/bin/node"
        },
    )
}

fn runtime_file(environment: &str, relative: &str) -> Result<PathBuf, SessionServiceError> {
    if let Some(path) = environment_file(environment)? {
        return Ok(path);
    }
    let root = std::env::var_os("DEEPCODE_RUNTIME_DIR").ok_or_else(|| {
        SessionServiceError::new(
            "session_service_asset_root_unavailable",
            "Host 未设置 DEEPCODE_RUNTIME_DIR。",
        )
    })?;
    let path = PathBuf::from(root).join(relative);
    if !path.is_file() {
        return Err(SessionServiceError::new(
            "session_service_asset_missing",
            format!("运行资源不存在：{}", path.display()),
        ));
    }
    Ok(path)
}

fn environment_file(name: &str) -> Result<Option<PathBuf>, SessionServiceError> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_file() {
        return Err(SessionServiceError::new(
            "session_service_configured_path_invalid",
            format!("{name} 指定的文件不存在：{}", path.display()),
        ));
    }
    Ok(Some(path))
}

fn process_wait_error(error: std::io::Error) -> SessionServiceError {
    SessionServiceError::new(
        "session_service_wait_failed",
        format!("检查 Session Service 状态失败：{error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[cfg(feature = "debug-control")]
    #[test]
    fn active_observations_share_ipc_without_becoming_request_replies() {
        let child = spawn_owned_host_process(Command::new("node").arg("-e").arg(r#"
const input = require('node:readline').createInterface({ input: process.stdin });
function reply(request, data) { process.stdout.write(JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId: request.requestId, ok: true, data }) + '\n'); }
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'health') reply(request, { state: 'ready' });
  else if (request.operation === 'debug.subscribe') {
    reply(request, { status: 'active' });
    setImmediate(() => process.stdout.write(JSON.stringify({ protocolVersion: 'deepcode.local-agent', type: 'debug.observation', subscriptionId: request.data.subscriptionId, sequence: 1, status: 'active', items: [{kind:'text',text:'First response.'}] }) + '\n'));
  } else if (request.operation === 'debug.unsubscribe') reply(request, { status: 'closed' });
  else if (request.operation === 'shutdown') { reply(request, {}); input.close(); process.stdin.destroy(); }
});
"#).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())).unwrap();
        let service = SessionServiceProcess::from_process(child).unwrap();
        let (id, mut receiver) = service
            .debug_subscribe("session:test", None, Some(4096))
            .unwrap();
        let observed = receiver
            .blocking_recv()
            .expect("unsolicited pushed observation");
        assert_eq!(observed["items"][0]["text"], "First response.");
        assert_eq!(
            service.request("health", json!({})).unwrap()["state"],
            "ready"
        );
        service.debug_unsubscribe(&id).unwrap();
        assert!(receiver.blocking_recv().is_none());
        service.shutdown().unwrap();
    }

    #[cfg(feature = "debug-control")]
    #[test]
    fn slow_observation_consumers_fail_only_their_subscription() {
        let mut pending = PendingResponses::default();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        pending.debug_observers.insert(
            "sub".into(),
            DebugObserver {
                sender: Some(sender),
                status: json!({"status":"active"}),
            },
        );
        for sequence in 1..=2 {
            pending.deliver_debug_observation(json!({"protocolVersion":PROTOCOL_VERSION,"type":"debug.observation","subscriptionId":"sub","sequence":sequence}));
        }
        assert!(pending.terminal_error.is_none());
        let status = &pending.debug_observers["sub"].status;
        assert_eq!(status["status"], "failed");
        assert_eq!(
            status["error"]["missingRange"]["fromObservationSequence"],
            2
        );
        assert_eq!(receiver.blocking_recv().unwrap()["sequence"], 1);
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn partial_deletion_response_preserves_original_error_and_structured_details() {
        let details =
            json!({"deletedSessionIds":["session:child"],"remainingSessionIds":["session:owner"]});
        let (_, result) = decode_response(json!({
            "protocolVersion":PROTOCOL_VERSION,"requestId":"request:delete","ok":false,
            "error":{"code":"session_delete_partial","message":"session_delete_partial: original journal failure","details":details}
        })).unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "session_delete_partial");
        assert_eq!(
            error.message,
            "session_delete_partial: original journal failure"
        );
        assert_eq!(error.details, Some(details));
    }

    #[test]
    fn session_eof_keeps_stderr_for_the_failed_and_later_requests() {
        let child = spawn_owned_host_process(Command::new("node")
            .arg("-e")
            .arg(r#"
const input = require('node:readline').createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'health') {
    process.stdout.write(JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId: request.requestId, ok: true, data: { state: 'ready' } }) + '\n');
  } else {
    process.stderr.write('session-exit-diagnostic\n', () => process.exit(7));
  }
});
"#)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            ).expect("spawn test service");
        let service = SessionServiceProcess::from_process(child).unwrap();
        let failure = service
            .request_with_timeout("snapshot", json!({}), Duration::from_secs(3))
            .unwrap_err();
        assert_eq!(failure.code, "session_service_response_missing");
        assert!(failure.message.contains("session-exit-diagnostic"));
        let health_failure = service.check_ready().unwrap_err();
        assert_eq!(health_failure.code, failure.code);
        assert_eq!(health_failure.message, failure.message);
        let later = service.request("activity", json!({})).unwrap_err();
        assert_eq!(later.code, failure.code);
        assert_eq!(later.message, failure.message);
        service.shutdown().unwrap();
        let mut process = service.process.lock().unwrap();
        assert!(process.owned.child.try_wait().unwrap().is_some());
        assert!(process.stdin_writer.is_none());
        assert!(process.stdout_reader.is_none());
        assert!(process.stderr_reader.is_none());
    }

    #[test]
    fn requests_complete_independently_and_shutdown_releases_the_child() {
        let child = spawn_owned_host_process(Command::new("node")
            .arg("-e")
            .arg(r#"
const input = require('node:readline').createInterface({ input: process.stdin });
let slow;
function reply(request, data) {
  process.stdout.write(JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId: request.requestId, ok: true, data }) + '\n');
}
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'health') reply(request, { state: 'ready' });
  else if (request.operation === 'slow') slow = request;
  else if (request.operation === 'fast') { reply(request, { source: 'fast' }); reply(slow, { source: 'slow' }); }
  else if (request.operation === 'shutdown') { reply(request, {}); input.close(); process.stdin.destroy(); }
});
"#)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            ).expect("spawn test service");
        let service = SessionServiceProcess::from_process(child).unwrap();
        std::thread::scope(|scope| {
            let slow = scope
                .spawn(|| service.request_with_timeout("slow", json!({}), Duration::from_secs(5)));
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let process = service.process.lock().unwrap();
                let has_pending = !process.responses.lock().unwrap().requests.is_empty();
                drop(process);
                if has_pending {
                    break;
                }
                assert!(Instant::now() < deadline, "slow request was not admitted");
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                service
                    .request_with_timeout("fast", json!({}), Duration::from_secs(3))
                    .unwrap(),
                json!({"source": "fast"})
            );
            assert_eq!(slow.join().unwrap().unwrap(), json!({"source": "slow"}));
        });
        service.shutdown().unwrap();
        let mut process = service.process.lock().unwrap();
        assert!(process.owned.child.try_wait().unwrap().is_some());
        assert!(process.stdin_writer.is_none());
        assert!(process.stdout_reader.is_none());
        assert!(process.stderr_reader.is_none());
    }

    #[test]
    fn request_deadline_covers_blocked_stdin_and_joins_the_writer() {
        let child = spawn_owned_host_process(Command::new("node")
            .arg("-e")
            .arg(r#"
const input = require('node:readline').createInterface({ input: process.stdin });
input.once('line', line => {
  const request = JSON.parse(line);
  input.close();
  process.stdin.pause();
  process.stdout.write(JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId: request.requestId, ok: true, data: { state: 'ready' } }) + '\n');
  setInterval(() => {}, 1000);
});
"#)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()))
            .expect("spawn test service");
        let service = SessionServiceProcess::from_process(child).unwrap();
        let started = Instant::now();
        let failure = service
            .request_with_timeout(
                "snapshot",
                json!({"payload": "x".repeat(512 * 1024)}),
                Duration::from_millis(150),
            )
            .unwrap_err();
        assert_eq!(failure.code, "session_service_response_timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
        let mut process = service.process.lock().unwrap();
        assert!(process.stopped);
        assert!(process.owned.child.try_wait().unwrap().is_some());
        assert!(process.stdin_writer.is_none());
        assert!(process.stdout_reader.is_none());
        assert!(process.stderr_reader.is_none());
        drop(process);
        assert_eq!(
            service.request("activity", json!({})).unwrap_err().code,
            failure.code
        );
        service.shutdown().unwrap();
    }

    #[test]
    fn chunked_snapshot_preserves_unicode_and_next_response_boundary() {
        let expected = json!({"text": "中文🙂\n".repeat(180_000)});
        let encoded = json!({"protocolVersion": PROTOCOL_VERSION, "requestId": "large", "ok": true, "data": expected}).to_string();
        assert!(encoded.len() > MAX_FRAME_BYTES);
        let chars: Vec<char> = encoded.chars().collect();
        let chunks: Vec<_> = chars.chunks(64 * 1024).collect();
        let mut wire = String::new();
        for (index, chunk) in chunks.iter().enumerate() {
            wire.push_str(&json!({"protocolVersion": PROTOCOL_VERSION, "type": "response.chunk",
                "index": index, "final": index + 1 == chunks.len(), "text": chunk.iter().collect::<String>()}).to_string());
            wire.push('\n');
        }
        wire.push_str(&json!({"protocolVersion": PROTOCOL_VERSION, "requestId": "next", "ok": true, "data": {"ok": true}}).to_string());
        wire.push('\n');
        let mut reader = Cursor::new(wire);
        assert_eq!(
            decode_response(read_response(&mut reader).unwrap())
                .map(|(id, data)| (id, data.unwrap()))
                .unwrap(),
            ("large".to_string(), expected)
        );
        assert_eq!(
            decode_response(read_response(&mut reader).unwrap())
                .map(|(id, data)| (id, data.unwrap()))
                .unwrap(),
            ("next".to_string(), json!({"ok": true}))
        );
    }

    #[test]
    fn incomplete_or_out_of_order_chunks_remain_transport_errors() {
        let first = json!({"protocolVersion": PROTOCOL_VERSION, "type": "response.chunk", "index": 0, "final": false, "text": "{"});
        let wrong = json!({"protocolVersion": PROTOCOL_VERSION, "type": "response.chunk", "index": 2, "final": true, "text": "}"});
        assert!(read_response(&mut Cursor::new(format!("{first}\n"))).is_err());
        assert_eq!(
            read_response(&mut Cursor::new(format!("{first}\n{wrong}\n")))
                .unwrap_err()
                .code,
            "session_service_response_invalid"
        );
    }

    #[test]
    fn invalid_wire_and_reassembled_json_keep_distinct_diagnostics() {
        let error = read_response(&mut Cursor::new("{\n")).unwrap_err();
        assert_eq!(error.code, "session_service_response_invalid");
        let chunk = json!({"protocolVersion": PROTOCOL_VERSION, "type": "response.chunk",
            "index": 0, "final": true, "text": "{\"data\":"});
        let error = read_response(&mut Cursor::new(format!("{chunk}\n"))).unwrap_err();
        assert_eq!(error.code, "session_service_response_json_invalid");
        assert!(error
            .message
            .starts_with("Session Service 回复不是有效 JSON："));
        let value = read_response(&mut Cursor::new("null\n")).unwrap();
        assert_eq!(
            decode_response(value).unwrap_err().code,
            "session_service_response_identity_mismatch"
        );
    }

    #[test]
    fn local_frame_reader_decodes_one_session_service_response() {
        let encoded = format!(
            "{}\r\n",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": "request:test",
                "ok": true,
                "data": {"revision": 7}
            })
        );
        let mut reader = BufReader::new(Cursor::new(encoded.into_bytes()));

        let value = read_response(&mut reader).expect("read response frame");
        let (request_id, data) = decode_response(value).expect("decode response identity");
        assert_eq!(request_id, "request:test");
        let data = data.unwrap();

        assert_eq!(data["revision"], 7);
    }
}
