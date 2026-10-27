//! One SSH connection owns this UI bridge; the shared Host owns Agent lifetime.
use achbit_host_connection::{
    configure_runtime_child, configured_path,
    loopback_http::request_loopback_json_until,
    process::{terminate_owned_process_tree, wait_for_child_exit, OwnedHostProcess},
    runtime_root,
    ssh::{GuiAttachReceipt, GuiAttachRequest, GUI_ATTACH_SCHEMA},
    startup, LocalHostConnection, UserDirectories,
};
use achbit_kernel_abi::{
    HostProcessIdentity, HOST_INSTANCE_ID_ENV, HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_ENV,
    HOST_UI_TOKEN_ENV, HOST_UI_TOKEN_HEADER,
};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct GuiProxy(OwnedHostProcess);
impl Drop for GuiProxy {
    fn drop(&mut self) {
        drop(self.0.child.stdin.take());
        if !wait_for_child_exit(&mut self.0, 40) {
            terminate_owned_process_tree(&mut self.0);
        }
    }
}

pub async fn serve() -> Result<(), String> {
    let request =
        GuiAttachRequest::read(std::io::stdin().lock()).map_err(|error| error.to_string())?;
    let directories = UserDirectories::resolve().map_err(|error| error.to_string())?;
    let connection = LocalHostConnection::discover(&directories.data_dir)
        .map_err(|error| error.to_string())?
        .ok_or("Shared Host is not available for GUI attachment")?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or("CLI executable directory is unavailable")?;
    let proxy_path = configured_path("ACHBIT_HOST_WEB_BIN")
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| {
            directory.join(if cfg!(windows) {
                "achbit-host-web.exe"
            } else {
                "achbit-host-web"
            })
        });
    if !proxy_path.is_file() {
        return Err(format!(
            "GUI bridge executable is missing: {}",
            proxy_path.display()
        ));
    }
    let resources = runtime_root(directory).map_err(|error| error.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let daemon_address = connection.address().map_err(|error| error.to_string())?;
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|error| error.to_string())?;
    let instance = format!(
        "{HOST_INSTANCE_ID_PREFIX}{}",
        entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let log_path = directories
        .log_dir
        .join(format!("gui-attach-{}.log", std::process::id()));
    let log = std::fs::File::create(&log_path).map_err(|error| error.to_string())?;
    let mut command = Command::new(proxy_path);
    directories.configure_child(&mut command);
    configure_runtime_child(&mut command, &resources).map_err(|error| error.to_string())?;
    command
        .env("ACHBIT_HOST", "127.0.0.1")
        .env("ACHBIT_PORT", port.to_string())
        .env("ACHBIT_DAEMON_HOST", daemon_address.ip().to_string())
        .env("ACHBIT_DAEMON_PORT", daemon_address.port().to_string())
        .env("ACHBIT_HOST_WEB_SPAWN_DAEMON", "0")
        .env(HOST_UI_TOKEN_ENV, &request.ui_token)
        .env(HOST_SHELL_TOKEN_ENV, connection.shell_token())
        .env(HOST_INSTANCE_ID_ENV, &instance)
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log);
    drop(listener);
    let deadline = Instant::now() + startup::STARTUP_BUDGET;
    let (process, identity) = startup::start_owned_ready(&mut command, deadline, |process, deadline| {
        let query = format!("GET /api/host/identity HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{HOST_UI_TOKEN_HEADER}: {}\r\nConnection: close\r\n\r\n", request.ui_token);
        let value = request_loopback_json_until::<serde_json::Value>("127.0.0.1", &port.to_string(), &query, deadline)?;
        let identity: HostProcessIdentity = serde_json::from_value(value["data"].clone()).map_err(std::io::Error::other)?;
        if value["ok"] != true || identity.instance_id != instance || identity.pid != process.child.id() || identity.service != "achbit-host-web" {
            return Err(std::io::Error::other("GUI bridge identity mismatch"));
        }
        Ok(identity)
    }).map_err(|error| format!("{error}; GUI bridge log: {}", log_path.display()))?;
    let mut proxy = GuiProxy(process);
    serde_json::to_writer(
        std::io::stdout().lock(),
        &GuiAttachReceipt {
            schema_version: GUI_ATTACH_SCHEMA.into(),
            proxy: identity,
            daemon: connection.identity,
        },
    )
    .map_err(|error| error.to_string())?;
    println!();
    std::io::stdout()
        .flush()
        .map_err(|error| error.to_string())?;
    let (closed, mut receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = std::io::copy(
            &mut std::io::stdin().lock().take(u64::MAX),
            &mut std::io::sink(),
        );
        let _ = closed.send(result);
    });
    loop {
        tokio::select! {
            result = &mut receiver => { result.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?; return Ok(()); }
            result = tokio::signal::ctrl_c() => { result.map_err(|error| error.to_string())?; return Ok(()); }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if let Some(status) = proxy.0.child.try_wait().map_err(|error| error.to_string())? {
                    return Err(format!("GUI bridge exited ({status}); log: {}", log_path.display()));
                }
            }
        }
    }
}
