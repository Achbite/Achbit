//! SSH carries the existing Host UI API. It owns no Session or execution state.
use crate::loopback_http::request_loopback_json_until;
use crate::process::{spawn_owned_host_process, terminate_owned_process_tree, OwnedHostProcess};
use crate::startup;
use base64::Engine;
use deepcode_kernel_abi::{is_valid_host_ui_token, HostProcessIdentity, HOST_UI_TOKEN_HEADER};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub const GUI_ATTACH_SCHEMA: &str = "deepcode.gui-attach.v1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshRemoteShell {
    #[default]
    Posix,
    Windows,
}

impl std::str::FromStr for SshRemoteShell {
    type Err = io::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "posix" => Ok(Self::Posix),
            "windows" => Ok(Self::Windows),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Remote shell must be posix or windows",
            )),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTarget {
    pub destination: String,
    pub port: Option<u16>,
    pub identity_file: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
    pub cli_path: String,
    pub user_root: Option<String>,
    #[serde(default)]
    pub remote_shell: SshRemoteShell,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshResolvedTarget {
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<String>,
    pub endpoint: String,
}

/// The GUI owns the prompt and credential lifetime. SSH only knows an askpass
/// endpoint and a per-attempt token, never a password in argv or its environment.
pub struct SshAuthentication {
    pub helper: PathBuf,
    pub address: SocketAddr,
    pub token: String,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Serialize, Deserialize)]
pub struct SshAskpassRequest {
    pub token: String,
    pub prompt: String,
    pub hint: String,
    pub phase: String,
}

/// Invoked by OpenSSH through the CLI executable, without starting another GUI
/// application instance or bootstrapping a local Host.
pub fn run_askpass_helper() -> io::Result<()> {
    let address: SocketAddr = std::env::var("DEEPCODE_SSH_ASKPASS_ADDRESS")
        .map_err(io::Error::other)?
        .parse()
        .map_err(io::Error::other)?;
    if !address.ip().is_loopback() {
        return Err(io::Error::other("SSH prompt endpoint must be local"));
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(
        &mut stream,
        &SshAskpassRequest {
            token: std::env::var("DEEPCODE_SSH_ASKPASS_TOKEN").map_err(io::Error::other)?,
            phase: std::env::var("DEEPCODE_SSH_ASKPASS_PHASE").map_err(io::Error::other)?,
            prompt: std::env::args()
                .nth(1)
                .ok_or_else(|| io::Error::other("Missing SSH prompt"))?,
            hint: std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default(),
        },
    )?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream.take(16385)).read_line(&mut line)?;
    let answer: Option<String> = serde_json::from_str(&line)?;
    let answer = answer.ok_or_else(|| {
        io::Error::new(io::ErrorKind::Interrupted, "SSH authentication cancelled")
    })?;
    writeln!(io::stdout().lock(), "{answer}")
}

impl SshAuthentication {
    fn configure(&self, command: &mut Command, phase: &str) {
        command
            .env("SSH_ASKPASS", &self.helper)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DEEPCODE_SSH_ASKPASS", "1")
            .env("DEEPCODE_SSH_ASKPASS_ADDRESS", self.address.to_string())
            .env("DEEPCODE_SSH_ASKPASS_TOKEN", &self.token)
            .env("DEEPCODE_SSH_ASKPASS_PHASE", phase);
    }

    fn check(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "SSH authentication cancelled",
            ));
        }
        Ok(())
    }
}

impl SshTarget {
    pub fn validate(&self) -> io::Result<()> {
        if self.destination.is_empty()
            || self.destination.starts_with('-')
            || self
                .destination
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || self.port == Some(0)
            || self.cli_path.is_empty()
            || self.cli_path.contains('\0')
            || self
                .user_root
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.contains('\0'))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid SSH connection target",
            ));
        }
        Ok(())
    }

    fn command(&self, interactive: bool) -> Command {
        let mut command = Command::new("ssh");
        command.args([
            "-T",
            "-o",
            if interactive {
                "BatchMode=no"
            } else {
                "BatchMode=yes"
            },
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ExitOnForwardFailure=yes",
        ]);
        if let Some(port) = self.port {
            command.arg("-p").arg(port.to_string());
        }
        if let Some(path) = &self.identity_file {
            command.arg("-i").arg(path);
        }
        if let Some(path) = &self.config_file {
            command.arg("-F").arg(path);
        }
        command
    }

    fn remote_command(&self) -> String {
        if self.remote_shell == SshRemoteShell::Windows {
            // The encoded script is a single safe word through both cmd.exe and
            // PowerShell, including paths with Unicode, %, $, quotes and spaces.
            let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
            let root = self
                .user_root
                .as_ref()
                .map(|root| format!("$env:DEEPCODE_USER_ROOT={};", literal(root)))
                .unwrap_or_default();
            // Inherit the SSH pipes directly. A PowerShell native pipeline can
            // transcode the JSON handshake or consume the child's stdin.
            let script = format!(
                "$ErrorActionPreference='Stop';{root}\
                 $p=[System.Diagnostics.Process]::new();\
                 $p.StartInfo.UseShellExecute=$false;\
                 $p.StartInfo.FileName={};\
                 $p.StartInfo.Arguments='gui-attach';\
                 [void]$p.Start();$p.WaitForExit();exit $p.ExitCode",
                literal(&self.cli_path)
            );
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            return format!(
                "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
        }
        let root = self
            .user_root
            .as_ref()
            .map(|root| format!("env {} ", quote(&format!("DEEPCODE_USER_ROOT={root}"))))
            .unwrap_or_default();
        format!("exec {root}{} gui-attach", quote(&self.cli_path))
    }

    /// Ask OpenSSH for the effective destination, including Host aliases and ports.
    pub fn endpoint_label(&self) -> io::Result<String> {
        Ok(self.resolve()?.endpoint)
    }

    pub fn resolve(&self) -> io::Result<SshResolvedTarget> {
        self.validate()?;
        let output = self
            .command(false)
            .arg("-G")
            .arg(&self.destination)
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        let config = String::from_utf8_lossy(&output.stdout);
        let value = |key: &str| {
            config
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .map(str::to_owned)
                .ok_or_else(|| io::Error::other(format!("OpenSSH did not report {key}")))
        };
        Ok(SshResolvedTarget {
            hostname: value("hostname ")?,
            port: value("port ")?.parse().map_err(io::Error::other)?,
            user: value("user ")?,
            identity_files: config
                .lines()
                .filter_map(|line| line.strip_prefix("identityfile ").map(str::to_owned))
                .collect(),
            endpoint: endpoint_label_from_config(&config)?,
        })
    }
}

fn endpoint_label_from_config(config: &str) -> io::Result<String> {
    let hostname = config
        .lines()
        .find_map(|line| line.strip_prefix("hostname "));
    let port = config.lines().find_map(|line| line.strip_prefix("port "));
    match (hostname, port) {
        (Some(hostname), Some(port)) => Ok(if hostname.contains(':') {
            format!("[{}]:{port}", hostname.trim_matches(['[', ']']))
        } else {
            format!("{hostname}:{port}")
        }),
        _ => Err(io::Error::other(
            "OpenSSH did not report its effective hostname and port",
        )),
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// The UI token belongs to this GUI connection. Supplying it on stdin keeps it out
// of process arguments and lets a reconnect retain the window's existing bootstrap.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuiAttachRequest {
    pub schema_version: String,
    pub ui_token: String,
}

impl GuiAttachRequest {
    pub fn read(reader: impl Read) -> io::Result<Self> {
        let mut line = String::new();
        BufReader::new(reader.take(4097)).read_line(&mut line)?;
        if line.len() > 4096 {
            return Err(io::Error::other("GUI attach request too large"));
        }
        let value: Self = serde_json::from_str(&line).map_err(io::Error::other)?;
        if value.schema_version != GUI_ATTACH_SCHEMA || !is_valid_host_ui_token(&value.ui_token) {
            return Err(io::Error::other("Invalid GUI attach request"));
        }
        Ok(value)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuiAttachReceipt {
    pub schema_version: String,
    pub proxy: HostProcessIdentity,
    pub daemon: HostProcessIdentity,
}

impl GuiAttachReceipt {
    pub fn proxy_address(&self) -> io::Result<SocketAddr> {
        if self.schema_version != GUI_ATTACH_SCHEMA || self.proxy.service != "deepcode-host-web" {
            return Err(io::Error::other("Unsupported GUI attach receipt"));
        }
        self.proxy
            .address
            .strip_prefix("http://")
            .and_then(|v| v.parse::<SocketAddr>().ok())
            .filter(|v| v.ip().is_loopback() && v.port() != 0)
            .ok_or_else(|| io::Error::other("Remote GUI service must publish its loopback address"))
    }
}

pub struct SshGuiConnection {
    bridge: Option<OwnedHostProcess>,
    tunnel: Option<OwnedHostProcess>,
    pub receipt: GuiAttachReceipt,
    log_path: PathBuf,
}

impl SshGuiConnection {
    pub fn connect(
        target: &SshTarget,
        local_port: u16,
        ui_token: &str,
        log_path: &Path,
        authentication: Option<&SshAuthentication>,
    ) -> io::Result<Self> {
        target.validate()?;
        if local_port == 0 || !is_valid_host_ui_token(ui_token) {
            return Err(io::Error::other("Invalid local GUI endpoint"));
        }
        // Network establishment retains OpenSSH's 10-second timeout. A bounded
        // larger overall budget gives the user time to answer native prompts.
        let deadline =
            Instant::now() + Duration::from_secs(if authentication.is_some() { 300 } else { 30 });
        let log = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(log_path)?;
        let mut command = target.command(authentication.is_some());
        if let Some(auth) = authentication {
            auth.configure(&mut command, "bridge");
        }
        command
            .arg(&target.destination)
            .arg(target.remote_command())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log.try_clone()?);
        let mut bridge = spawn_owned_host_process(&mut command)?;
        let handshake = (|| {
            let input = bridge
                .child
                .stdin
                .as_mut()
                .ok_or_else(|| io::Error::other("SSH stdin unavailable"))?;
            serde_json::to_writer(
                &mut *input,
                &GuiAttachRequest {
                    schema_version: GUI_ATTACH_SCHEMA.into(),
                    ui_token: ui_token.into(),
                },
            )?;
            input.write_all(b"\n")?;
            input.flush()?;
            let output = bridge
                .child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("SSH stdout unavailable"))?;
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(output.take(16385))
                    .read_line(&mut line)
                    .and_then(|_| {
                        if line.len() > 16384 {
                            return Err(io::Error::other("GUI attach receipt too large"));
                        }
                        serde_json::from_str::<GuiAttachReceipt>(&line).map_err(io::Error::other)
                    });
                let _ = send.send(result);
            });
            loop {
                if let Some(auth) = authentication {
                    auth.check()?;
                }
                match receive
                    .recv_timeout(startup::remaining(deadline)?.min(Duration::from_millis(100)))
                {
                    Ok(result) => {
                        if let Some(auth) = authentication {
                            auth.check()?;
                        }
                        return result;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(error) => {
                        return Err(io::Error::other(format!("SSH GUI handshake: {error}")))
                    }
                }
            }
        })();
        let receipt = match handshake {
            Ok(receipt) => receipt,
            Err(error) => {
                terminate_owned_process_tree(&mut bridge);
                return Err(with_log(error, log_path));
            }
        };
        let mut connection = Self {
            bridge: Some(bridge),
            tunnel: None,
            receipt,
            log_path: log_path.into(),
        };
        let result = (|| {
            let remote = connection.receipt.proxy_address()?;
            let mut command = target.command(authentication.is_some());
            if let Some(auth) = authentication {
                auth.configure(&mut command, "tunnel");
            }
            command
                .arg("-N")
                .arg("-L")
                .arg(format!("127.0.0.1:{local_port}:{remote}"))
                .arg(&target.destination)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log);
            connection.tunnel = Some(spawn_owned_host_process(&mut command)?);
            loop {
                if let Some(auth) = authentication {
                    auth.check()?;
                }
                connection.check()?;
                let request = format!("GET /api/host/identity HTTP/1.1\r\nHost: 127.0.0.1:{local_port}\r\n{HOST_UI_TOKEN_HEADER}: {ui_token}\r\nConnection: close\r\n\r\n");
                let response = request_loopback_json_until::<serde_json::Value>(
                    "127.0.0.1",
                    &local_port.to_string(),
                    &request,
                    deadline.min(Instant::now() + Duration::from_secs(2)),
                );
                match response {
                    Ok(response) => {
                        let actual: HostProcessIdentity =
                            serde_json::from_value(response["data"].clone())
                                .map_err(io::Error::other)?;
                        if response["ok"] != true || actual != connection.receipt.proxy {
                            return Err(io::Error::other(
                                "SSH forwarded GUI service identity differs from its receipt",
                            ));
                        }
                        return Ok(());
                    }
                    Err(error)
                        if startup::transport_pending(&error) && Instant::now() < deadline =>
                    {
                        startup::pause(deadline)
                    }
                    Err(error) => return Err(error),
                }
            }
        })();
        if let Err(error) = result {
            return Err(with_log(error, log_path));
        }
        Ok(connection)
    }

    pub fn check(&mut self) -> io::Result<()> {
        for process in [&mut self.bridge, &mut self.tunnel].into_iter().flatten() {
            if let Some(status) = process.child.try_wait()? {
                return Err(with_log(
                    io::Error::other(format!("SSH connection closed ({status})")),
                    &self.log_path,
                ));
            }
        }
        Ok(())
    }
}

impl Drop for SshGuiConnection {
    fn drop(&mut self) {
        if let Some(mut tunnel) = self.tunnel.take() {
            terminate_owned_process_tree(&mut tunnel);
        }
        if let Some(mut bridge) = self.bridge.take() {
            // EOF lets the remote CLI close only its UI proxy. No cancellation or
            // Host shutdown request is sent by a transport owner.
            drop(bridge.child.stdin.take());
            if !crate::process::wait_for_child_exit(&mut bridge, 40) {
                terminate_owned_process_tree(&mut bridge);
            }
        }
    }
}

fn with_log(error: io::Error, path: &Path) -> io::Error {
    let mut detail = String::new();
    if let Ok(file) = File::open(path) {
        let _ = file.take(16 * 1024).read_to_string(&mut detail);
    }
    io::Error::new(
        error.kind(),
        format!("{error}\n{}\nSSH log: {}", detail.trim(), path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_label_uses_effective_ssh_host_and_port() {
        assert_eq!(
            endpoint_label_from_config("host lab\nhostname 127.0.0.1\nport 8008\n").unwrap(),
            "127.0.0.1:8008"
        );
        assert_eq!(
            endpoint_label_from_config("hostname ::1\nport 2222\n").unwrap(),
            "[::1]:2222"
        );
        assert!(endpoint_label_from_config("hostname lab\n").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn remote_paths_are_literal_shell_words() {
        let target = SshTarget {
            destination: "dev@linux".into(),
            port: None,
            identity_file: None,
            config_file: None,
            cli_path: "/opt/Deep Code/it's-cli".into(),
            user_root: Some("/home/dev/user $(touch wrong)".into()),
            remote_shell: SshRemoteShell::Posix,
        };
        target.validate().unwrap();
        let mut shell = Command::new("sh");
        let script = format!(
            "set -- {} {}; printf '%s\\n%s' \"$1\" \"$2\"",
            quote(&target.cli_path),
            quote(target.user_root.as_ref().unwrap())
        );
        let output = shell.args(["-c", &script]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n{}", target.cli_path, target.user_root.unwrap())
        );
    }

    #[test]
    fn windows_remote_command_preserves_paths_without_outer_shell_expansion() {
        let mut target: SshTarget = serde_json::from_value(serde_json::json!({
            "destination":"dev@host", "cliPath":"deepcode-cli"
        }))
        .unwrap();
        assert_eq!(
            target.remote_shell,
            SshRemoteShell::Posix,
            "existing profiles stay compatible"
        );
        target.remote_shell = "windows".parse().unwrap();
        target.cli_path = "C:\\应用 & data\\it's %PATH% $cli.exe".into();
        target.user_root = Some("D:\\数据\\it's $(exit 1); %TEMP%".into());
        target.validate().unwrap();
        let command = target.remote_command();
        let encoded = command
            .strip_prefix("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ")
            .unwrap();
        assert!(!encoded
            .chars()
            .any(|c| c.is_whitespace() || "%$&;'".contains(c)));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let script = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(script.contains("$env:DEEPCODE_USER_ROOT='D:\\数据\\it''s $(exit 1); %TEMP%';"));
        assert!(script.contains("$p.StartInfo.FileName='C:\\应用 & data\\it''s %PATH% $cli.exe';"));
        assert!(script.contains("UseShellExecute=$false"));
        assert!(script.ends_with("$p.WaitForExit();exit $p.ExitCode"));
        assert!("unknown".parse::<SshRemoteShell>().is_err());
        assert_eq!(
            serde_json::to_value(target).unwrap()["remoteShell"],
            "windows"
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_remote_command_keeps_native_stdin_and_utf8_stdout() {
        use std::os::windows::process::CommandExt;
        let directory = std::env::temp_dir().join(format!(
            "deepcode ssh 中文 & it's %PATH% $cli-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("cli.exe");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        // FINDSTR consumes the fixed gui-attach argument as its search pattern,
        // and copies a matching input line without decoding or re-encoding it.
        std::fs::copy(system.join("System32/findstr.exe"), &executable).unwrap();
        let target = SshTarget {
            destination: "unused".into(),
            port: None,
            identity_file: None,
            config_file: None,
            cli_path: executable.to_string_lossy().into(),
            user_root: Some("D:\\用户\\it's $(exit 1); %TEMP%".into()),
            remote_shell: SshRemoteShell::Windows,
        };
        let input = "{\"gui-attach\":\"中文 café 😀\"}\n";
        for shell in ["cmd.exe", "powershell.exe"] {
            let mut command = Command::new(shell);
            if shell == "cmd.exe" {
                command.args(["/d", "/s", "/c"]);
            } else {
                command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
            }
            let mut child = command
                .arg(target.remote_command())
                .creation_flags(0x0800_0000)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8(output.stdout).unwrap().trim_end(),
                input.trim_end(),
                "{shell}"
            );
            assert!(
                output.stderr.is_empty(),
                "{shell}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::fs::remove_file(executable).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn attach_preserves_the_window_credential_without_logging_it() {
        let token = format!("dcui_{}", "12".repeat(32));
        let line = serde_json::to_vec(&GuiAttachRequest {
            schema_version: GUI_ATTACH_SCHEMA.into(),
            ui_token: token.clone(),
        })
        .unwrap();
        assert_eq!(
            GuiAttachRequest::read(line.as_slice()).unwrap().ui_token,
            token
        );
        assert!(
            GuiAttachRequest::read(br#"{"schemaVersion":"bad","uiToken":"bad"}"#.as_slice())
                .is_err()
        );
    }
}
