//! User-facing account management for the bundled GitHub reader.
use crate::prelude::*;
use crate::*;
use achbit_first_party_tools::github_account::{self, Account};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::task::JoinHandle;

#[derive(Debug, Default)]
pub(crate) struct Login {
    generation: u64,
    task: Option<JoinHandle<()>>,
    code: Option<String>,
    error: Option<String>,
}

impl Login {
    fn cancel(&mut self) {
        self.generation += 1;
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.code = None;
        self.error = None;
    }
}

impl Drop for Login {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn path(gui: &GuiState) -> PathBuf {
    github_account::binding_path(&gui.paths.directories.config_dir)
}

fn status(gui: &GuiState) -> Json<ApiResponse> {
    let stored = match crate::read_optional_json_file(&path(gui)) {
        Ok(stored) => stored,
        Err(e) => return ApiResponse::error("github_account_unavailable", &e),
    };
    let account = match stored.as_ref().filter(|v| !v.is_null()) {
        Some(v) => match serde_json::from_value::<Account>(v.clone()) {
            Ok(a) => Some(a.login),
            Err(e) => return ApiResponse::error("github_account_invalid", &e.to_string()),
        },
        None => None,
    };
    let login = &gui.github_login;
    ApiResponse::ok(
        json!({"account":account, "pending":login.task.is_some(), "code":login.code, "error":login.error}),
    )
}

pub(crate) async fn get(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    status(&state.gui.lock().expect("gui state lock"))
}

pub(crate) async fn start(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    let (revision, requested_generation) = {
        let gui = state.gui.lock().expect("gui state lock");
        if gui.github_login.task.is_some() {
            return status(&gui);
        }
        (
            gui.user_settings["agent.environmentRevision"]
                .as_u64()
                .unwrap_or(0),
            gui.github_login.generation,
        )
    };
    let executable = tokio::task::spawn_blocking(move || {
        let path = crate::session_environment::host_execution_path(revision)?;
        let dirs = std::env::split_paths(&path).collect::<Vec<_>>();
        let executable = achbit_kernel_runtime::shell_environment::find_command_in("gh", &dirs)
            .ok_or_else(|| "Install GitHub CLI (gh) to connect an account.".to_string())?;
        std::path::absolute(executable).map_err(|error| error.to_string())
    })
    .await;
    let executable = match executable {
        Ok(Ok(path)) => path,
        Ok(Err(e)) => return ApiResponse::error("github_cli_unavailable", &e),
        Err(e) => return ApiResponse::error("github_cli_unavailable", &e.to_string()),
    };
    let mut gui = state.gui.lock().expect("gui state lock");
    if gui.github_login.generation == requested_generation && gui.github_login.task.is_none() {
        gui.github_login.cancel();
        let generation = gui.github_login.generation;
        let owner = Arc::downgrade(&state.gui);
        gui.github_login.task = Some(tokio::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(16 * 60),
                authenticate(&owner, generation, executable),
            )
            .await
            .map_err(|_| "GitHub authorization expired".to_string())
            .and_then(|v| v);
            if let Some(owner) = owner.upgrade() {
                let mut gui = owner.lock().expect("gui state lock");
                if gui.github_login.generation == generation {
                    let result = result
                        .and_then(|account| crate::atomic_write_json(&path(&gui), &json!(account)));
                    gui.github_login.error = result.err();
                    gui.github_login.task = None;
                    gui.github_login.code = None;
                }
            }
        }));
    }
    status(&gui)
}

async fn authenticate(
    owner: &Weak<Mutex<GuiState>>,
    generation: u64,
    executable: PathBuf,
) -> Result<Account, String> {
    let mut base = github_account::command(&executable);
    base.args([
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
    ])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());
    let mut child = tokio::process::Command::from(base)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or("GitHub CLI did not open its status stream")?;
    let mut lines = BufReader::new(stderr).lines();
    let mut account = None;
    let mut diagnostic = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if let Some((_, code)) = line.split_once("one-time code: ") {
            let code = code.trim();
            if code.len() == 9
                && code.as_bytes()[4] == b'-'
                && code
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| i == 4 || b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                if let Some(owner) = owner.upgrade() {
                    let mut gui = owner.lock().expect("gui state lock");
                    if gui.github_login.generation == generation {
                        gui.github_login.code = Some(code.to_owned());
                    }
                }
            }
        } else if let Some((_, user)) = line.split_once("Logged in as ") {
            if github_account::valid_login(user.trim()) {
                account = Some(user.trim().to_owned());
            }
        } else if !line.trim().is_empty() {
            diagnostic = line.chars().take(480).collect();
        }
    }
    let exit = child.wait().await.map_err(|e| e.to_string())?;
    if !exit.success() {
        return Err(format!("GitHub CLI {exit}. {diagnostic}"));
    }
    Ok(Account {
        executable,
        login: account.ok_or("GitHub CLI did not identify the signed-in account")?,
    })
}

pub(crate) async fn cancel(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.github_login.cancel();
    status(&gui)
}

pub(crate) async fn disconnect(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.github_login.cancel();
    match crate::atomic_write_json(&path(&gui), &Value::Null) {
        Ok(()) => status(&gui),
        Err(e) => ApiResponse::error("github_account_disconnect_failed", &e),
    }
}
