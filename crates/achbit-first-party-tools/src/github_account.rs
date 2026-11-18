//! A connection pins a GitHub CLI account independently of gh's active account.
use crate::{ToolError, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub login: String,
    pub executable: PathBuf,
}

pub fn binding_path(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins").join("github-account.json")
}

pub fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 100
        && login
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

pub fn command(executable: &Path) -> Command {
    let mut cmd = Command::new(executable);
    for key in [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GH_DEBUG",
        "GH_FORCE_TTY",
        "GH_COLOR_LABELS",
        "CLICOLOR_FORCE",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("LC_ALL", "C")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    cmd
}

impl Account {
    pub fn token(&self) -> Result<String, String> {
        if !valid_login(&self.login) || !self.executable.is_absolute() {
            return Err("Invalid GitHub account connection".into());
        }
        let result = command(&self.executable)
            .args([
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                &self.login,
            ])
            .output()
            .map_err(|e| format!("Cannot start GitHub CLI: {e}"))?;
        if !result.status.success() {
            return Err(format!("GitHub CLI has no usable credential for @{}. Reconnect in GitHub plugin settings ({})", self.login, result.status));
        }
        let token =
            String::from_utf8(result.stdout).map_err(|_| "Invalid GitHub CLI credential")?;
        let token = token.trim();
        if token.is_empty()
            || token
                .bytes()
                .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        {
            return Err("Invalid GitHub CLI credential".into());
        }
        Ok(token.to_string())
    }
}

pub(crate) fn access_token(context: Option<&Value>) -> ToolResult<Option<String>> {
    if let Some(path) = context
        .and_then(|v| v.pointer("/achbit/githubAccountFile"))
        .and_then(Value::as_str)
    {
        match std::fs::read(path) {
            Ok(bytes) => {
                let account: Option<Account> = serde_json::from_slice(&bytes)
                    .map_err(|e| ToolError::new("github_account_invalid", e.to_string()))?;
                return account
                    .map(|a| a.token())
                    .transpose()
                    .map_err(|m| ToolError::new("github_auth_required", m));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(ToolError::new("github_account_unavailable", e.to_string())),
        }
    }
    Ok(std::env::var("ACHBIT_GITHUB_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty()))
}
