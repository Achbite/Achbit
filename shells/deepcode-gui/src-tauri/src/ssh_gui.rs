use super::*;
use deepcode_host_connection::ssh::{SshGuiConnection, SshTarget};
use std::hash::{Hash, Hasher};

const TARGET_ENV: &str = "DEEPCODE_GUI_SSH_TARGET";

pub(super) fn launch_target() -> std::io::Result<Option<SshTarget>> {
    if std::env::args().any(|arg| arg == "--local") {
        return Ok(None);
    }
    if let Ok(value) = std::env::var(TARGET_ENV) {
        let target: SshTarget = serde_json::from_str(&value).map_err(std::io::Error::other)?;
        target.validate()?;
        return Ok(Some(target));
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(index) = args.iter().position(|arg| arg == "--ssh") else {
        return Ok(None);
    };
    let destination = args
        .get(index + 1)
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| std::io::Error::other("--ssh requires user@host or an SSH config alias"))?
        .clone();
    let value = |name: &str| -> std::io::Result<Option<String>> {
        args.iter()
            .position(|arg| arg == name)
            .map(|index| {
                args.get(index + 1)
                    .filter(|value| !value.starts_with('-'))
                    .cloned()
                    .ok_or_else(|| std::io::Error::other(format!("{name} requires a value")))
            })
            .transpose()
    };
    let target = SshTarget {
        destination,
        port: value("--ssh-port")?
            .map(|port| port.parse())
            .transpose()
            .map_err(std::io::Error::other)?,
        identity_file: value("--ssh-identity")?.map(PathBuf::from),
        config_file: value("--ssh-config")?.map(PathBuf::from),
        cli_path: value("--remote-cli")?.unwrap_or_else(|| "deepcode-cli".into()),
        user_root: value("--remote-user-root")?,
        remote_shell: value("--remote-shell")?
            .map(|value| value.parse())
            .transpose()?
            .unwrap_or_default(),
    };
    target.validate()?;
    Ok(Some(target))
}

pub(super) fn webview_directory(target: &LaunchTarget) -> PathBuf {
    let root = runtime_locations().user.cache_dir.join("webview");
    match &target.ssh {
        None => root,
        Some(target) => {
            let mut key = std::collections::hash_map::DefaultHasher::new();
            // Browser preferences are scoped to the remote profile, never to a
            // transient tunnel port or to another machine's Session identifiers.
            target.destination.hash(&mut key);
            target.port.hash(&mut key);
            target.user_root.hash(&mut key);
            root.join(format!("ssh-{:016x}", key.finish()))
        }
    }
}

fn spawn_window(target: Option<&SshTarget>) -> Result<(), String> {
    let log = File::create(runtime_locations().user.log_dir.join(format!(
        "ssh-window-{}.log",
        startup_timestamp().replace(':', "-")
    )))
    .map_err(|error| error.to_string())?;
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    if let Some(target) = target {
        target.validate().map_err(|error| error.to_string())?;
        command.env(
            TARGET_ENV,
            serde_json::to_string(target).map_err(|error| error.to_string())?,
        );
    } else {
        command.env_remove(TARGET_ENV).arg("--local");
    }
    command
        .env_remove("DEEPCODE_GUI_SSH_RECEIPT")
        .env_remove("DEEPCODE_PORT")
        .env_remove("DEEPCODE_SHELL_CONNECT_ONLY")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log);
    deepcode_host_connection::process::spawn_independent_shell(&mut command)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(super) fn deepcode_connect_ssh(app: tauri::AppHandle, target: SshTarget) -> Result<(), String> {
    // Replace the current shell with a clean process/renderer for this target.
    // Its bootstrap and API origin remain immutable through every GUI refresh.
    spawn_window(Some(&target))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub(super) fn deepcode_open_local() -> Result<(), String> {
    spawn_window(None)
}

pub(super) fn connect(
    app: &tauri::AppHandle,
    ssh: &SshTarget,
    target: &LaunchTarget,
    tokens: &HostConnectionTokens,
    processes: &HostProcessGroup,
    status: &HostStartupStatusStore,
    attempt: &str,
) -> HostStartupStatusV1 {
    let log_path = runtime_locations()
        .user
        .log_dir
        .join(format!("ssh-{attempt}.log"));
    status.update(
        attempt,
        "starting",
        "ssh",
        "host_ssh_connecting",
        None,
        format!("Connecting to {}", ssh.destination),
        true,
        true,
        Some(log_path.display().to_string()),
    );
    let result = (|| {
        processes.reclaim_current(Instant::now() + Duration::from_secs(5))?;
        let authentication = ssh_auth::Broker::new(app, ssh)?;
        let connection = SshGuiConnection::connect(
            ssh,
            target.port.parse().map_err(std::io::Error::other)?,
            tokens.ui_token(),
            &log_path,
            Some(&authentication.authentication),
        )?;
        authentication.save_verified_credentials()?;
        let mut state = processes
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.shutting_down {
            return Err(std::io::Error::other(
                "SSH connection cancelled because the GUI closed",
            ));
        }
        state.ssh = Some(connection);
        Ok::<_, std::io::Error>(())
    })();
    let result = match result {
        Ok(()) => status.update(
            attempt,
            "ready",
            "ssh",
            "host_startup_ready",
            None,
            format!("Connected to {}", ssh.destination),
            true,
            true,
            Some(log_path.display().to_string()),
        ),
        Err(error) => status.update(
            attempt,
            "failed",
            "ssh",
            "host_ssh_connect_failed",
            None,
            error.to_string(),
            true,
            false,
            Some(log_path.display().to_string()),
        ),
    };
    write_startup_receipt(
        result.phase == "ready",
        &result.message,
        target.ssh_endpoint.as_deref(),
    );
    result
}

pub(super) fn write_startup_receipt(ok: bool, message: &str, endpoint: Option<&str>) {
    let Some(path) = std::env::var_os("DEEPCODE_GUI_SSH_RECEIPT").map(PathBuf::from) else {
        return;
    };
    if !path.is_file() {
        return;
    }
    let result = (|| -> std::io::Result<()> {
        let temporary = path.with_extension("pending");
        std::fs::write(
            &temporary,
            serde_json::to_vec(&serde_json::json!({
                "ok":ok, "state":if ok { "connected" } else { "failed" },
                "pid":std::process::id(), "endpoint":endpoint, "message":message
            }))?,
        )?;
        std::fs::rename(temporary, path)
    })();
    if let Err(error) = result {
        eprintln!("SSH connection receipt: {error}");
    }
}
