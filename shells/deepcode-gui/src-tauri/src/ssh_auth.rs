//! OpenSSH asks this GUI for authentication. Secrets stay in the native host,
//! the isolated login view, and the system credential store; never in Session.
use super::*;
use deepcode_host_connection::ssh::{SshAskpassRequest, SshAuthentication, SshTarget};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};

const SERVICE: &str = "com.achbite.deepcode.ssh";
pub(super) const SCHEME: &str = "deepcode-ssh-auth";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptContext {
    id: String,
    endpoint: String,
    prompt: String,
    confirm: bool,
    can_save: bool,
    error: Option<String>,
}

struct PendingPrompt {
    context: PromptContext,
    reply: Sender<Option<PromptReply>>,
}

#[derive(Deserialize)]
pub(super) struct PromptReply {
    value: String,
    save: bool,
}

#[derive(Default)]
pub(super) struct AuthUi {
    pending: Mutex<Option<PendingPrompt>>,
    attempt: Mutex<Option<Arc<AtomicBool>>>,
}

impl AuthUi {
    pub(super) fn cancel(&self) {
        if let Some(cancelled) = self.attempt.lock().unwrap().as_ref() {
            cancelled.store(true, Ordering::Release);
        }
        self.close_prompt();
    }

    pub(super) fn close_prompt(&self) {
        if let Some(pending) = self.pending.lock().unwrap().take() {
            if let Some(cancelled) = self.attempt.lock().unwrap().as_ref() {
                cancelled.store(true, Ordering::Release);
            }
            let _ = pending.reply.send(None);
        }
    }
}

pub(super) fn page() -> Response<Vec<u8>> {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(include_bytes!("ssh_auth.html").to_vec())
        .unwrap()
}

#[tauri::command]
pub(super) fn deepcode_ssh_auth_context(
    state: State<'_, AuthUi>,
) -> Result<serde_json::Value, String> {
    let pending = state.pending.lock().unwrap();
    let context = &pending.as_ref().ok_or("SSH prompt has closed")?.context;
    let labels = |pack: &str| {
        let pack: serde_json::Value = serde_json::from_str(pack).unwrap();
        pack["messages"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| {
                key.strip_prefix("deepcodeGui.ssh.login.")
                    .map(|name| (name.to_string(), value.clone()))
            })
            .collect::<serde_json::Map<_, _>>()
    };
    Ok(serde_json::json!({"context": context, "labels": {
        "zh": labels(include_str!("../../../../config/i18n/zh-CN.json")),
        "en": labels(include_str!("../../../../config/i18n/en-US.json"))
    }}))
}

#[tauri::command]
pub(super) fn deepcode_ssh_auth_respond(
    app: tauri::AppHandle,
    state: State<'_, AuthUi>,
    id: String,
    reply: Option<PromptReply>,
) -> Result<(), String> {
    let mut pending = state.pending.lock().unwrap();
    let prompt = pending.as_ref().ok_or("SSH prompt has closed")?;
    if prompt.context.id != id {
        return Err("SSH prompt changed".into());
    }
    if let Some(reply) = &reply {
        if reply.value.len() > 4096 || reply.value.contains(['\n', '\r', '\0']) {
            return Err("Invalid SSH response".into());
        }
    } else if let Some(cancelled) = state.attempt.lock().unwrap().as_ref() {
        cancelled.store(true, Ordering::Release);
    }
    // Remove pending before closing: Destroyed must not cancel an accepted answer.
    let prompt = pending.take().unwrap();
    drop(pending);
    if let Some(window) = app.get_webview_window("ssh-auth") {
        let _ = window.destroy();
    }
    prompt
        .reply
        .send(reply)
        .map_err(|_| "SSH prompt has closed".to_string())
}

struct Credential {
    value: String,
    save: bool,
}

pub(super) struct Broker {
    pub authentication: SshAuthentication,
    app: tauri::AppHandle,
    finished: Arc<AtomicBool>,
    credentials: Arc<Mutex<HashMap<String, Credential>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Broker {
    pub(super) fn new(app: &tauri::AppHandle, target: &SshTarget) -> io::Result<Self> {
        let resolved = target.resolve()?;
        let endpoint = format!("{}@{}", resolved.user, resolved.endpoint);
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|error| io::Error::other(error.to_string()))?;
        let token: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
        let cancelled = Arc::new(AtomicBool::new(false));
        *app.state::<AuthUi>().attempt.lock().unwrap() = Some(cancelled.clone());
        let authentication = SshAuthentication {
            helper: std::env::current_exe()?
                .parent()
                .ok_or_else(|| io::Error::other("GUI directory unavailable"))?
                .join(if cfg!(windows) {
                    "deepcode-cli.exe"
                } else {
                    "deepcode-cli"
                }),
            address: listener.local_addr()?,
            token: token.clone(),
            cancelled: cancelled.clone(),
        };
        let finished = Arc::new(AtomicBool::new(false));
        let credentials = Arc::new(Mutex::new(HashMap::<String, Credential>::new()));
        let (done, cache, handle) = (finished.clone(), credentials.clone(), app.clone());
        let worker = std::thread::spawn(move || {
            let mut tried = HashSet::new();
            while !done.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let answer = (|| -> io::Result<Option<String>> {
                            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                            stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                            let mut line = String::new();
                            BufReader::new((&stream).take(32769)).read_line(&mut line)?;
                            if line.len() > 32768 {
                                return Err(io::Error::other("SSH prompt too large"));
                            }
                            let request: SshAskpassRequest = serde_json::from_str(&line)?;
                            if request.token != token {
                                return Err(io::Error::other("Invalid SSH prompt token"));
                            }
                            let confirm =
                                request.hint == "confirm" || request.prompt.contains("yes/no");
                            // Only reusable passwords/passphrases can be saved, never an OTP or host approval.
                            let lower = request.prompt.to_lowercase();
                            let can_save = !confirm
                                && (lower.contains("password") || lower.contains("passphrase"));
                            let account = serde_json::to_string(&(&endpoint, &request.prompt))?;
                            let first = tried.insert((request.phase, account.clone()));
                            let mut error = None;
                            if can_save && first {
                                if let Some(value) = cache.lock().unwrap().get(&account) {
                                    return Ok(Some(value.value.clone()));
                                }
                                match keyring::Entry::new(SERVICE, &account)
                                    .and_then(|entry| entry.get_password())
                                {
                                    Ok(value) => return Ok(Some(value)),
                                    Err(keyring::Error::NoEntry) => {}
                                    Err(reason) => error = Some(reason.to_string()),
                                }
                            }
                            if !first {
                                error = Some("authentication_rejected".into());
                            }
                            let context = PromptContext {
                                id: startup_attempt_id(),
                                endpoint: endpoint.clone(),
                                prompt: request.prompt,
                                confirm,
                                can_save,
                                error,
                            };
                            let reply = show_prompt(&handle, context, &cancelled)?;
                            if let Some(reply) = reply {
                                if can_save {
                                    cache.lock().unwrap().insert(
                                        account,
                                        Credential {
                                            value: reply.value.clone(),
                                            save: reply.save,
                                        },
                                    );
                                }
                                Ok(Some(reply.value))
                            } else {
                                Ok(None)
                            }
                        })();
                        // Do not include secret values in any diagnostic output.
                        match answer {
                            Ok(answer) => {
                                let _ = serde_json::to_writer(&mut stream, &answer);
                                let _ = stream.write_all(b"\n");
                            }
                            Err(error) => eprintln!("SSH prompt: {error}"),
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(30))
                    }
                    Err(error) => {
                        eprintln!("SSH prompt listener: {error}");
                        break;
                    }
                }
            }
        });
        Ok(Self {
            authentication,
            app: app.clone(),
            finished,
            credentials,
            worker: Some(worker),
        })
    }

    pub(super) fn save_verified_credentials(&self) -> io::Result<()> {
        // Called only after the real SSH GUI handshake and tunnel have succeeded.
        for (account, credential) in self.credentials.lock().unwrap().iter() {
            if credential.save {
                keyring::Entry::new(SERVICE, account)
                    .and_then(|entry| entry.set_password(&credential.value))
                    .map_err(|error| {
                        io::Error::other(format!("Could not save SSH credential: {error}"))
                    })?;
            }
        }
        Ok(())
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        self.app.state::<AuthUi>().cancel();
        if let Some(window) = self.app.get_webview_window("ssh-auth") {
            let _ = window.destroy();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn show_prompt(
    app: &tauri::AppHandle,
    context: PromptContext,
    cancelled: &AtomicBool,
) -> io::Result<Option<PromptReply>> {
    let (send, receive) = mpsc::channel();
    *app.state::<AuthUi>().pending.lock().unwrap() = Some(PendingPrompt {
        context,
        reply: send,
    });
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(
            &handle,
            "ssh-auth",
            WebviewUrl::CustomProtocol(format!("{SCHEME}://localhost/").parse().unwrap()),
        )
        .title("DeepCode · SSH")
        .inner_size(500.0, 400.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .build();
        match result {
            Ok(window) => {
                let _ = window.set_focus();
            }
            Err(error) => {
                eprintln!("SSH login window: {error}");
                handle.state::<AuthUi>().cancel();
            }
        }
    })
    .map_err(io::Error::other)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Ok(None);
        }
        match receive.recv_timeout(Duration::from_millis(100)) {
            Ok(reply) => return Ok(reply),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => return Err(io::Error::other(error)),
        }
    }
}
