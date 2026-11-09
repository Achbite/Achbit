//! Optional installed logind client. No installation or sleep policy changes.
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
pub(super) struct Lease {
    child: Child,
    stdin: Option<ChildStdin>,
    group: Option<u32>,
    stderr: Option<tokio::task::JoinHandle<String>>,
}
impl Lease {
    pub(super) async fn acquire() -> Result<Self, String> {
        let mut command = Command::new("systemd-inhibit");
        command
            .args([
                "--what=idle",
                "--mode=block",
                "--who=Achbit",
                "--why=Achbit is executing a task",
                "/bin/sh",
                "-c",
                "printf 'achbit-power-ready\\n'; IFS= read -r release",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| format!("systemd-inhibit unavailable: {error}"))?;
        let group = child.id();
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or("systemd-inhibit stdout unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("systemd-inhibit stderr unavailable")?;
        let stderr = tokio::spawn(async move {
            let mut captured = Vec::new();
            let mut buffer = [0; 1024];
            while let Ok(size) = stderr.read(&mut buffer).await {
                if size == 0 {
                    break;
                }
                let remaining = 4096usize.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..size.min(remaining)]);
            }
            String::from_utf8_lossy(&captured).into_owned()
        });
        let mut lease = Self {
            child,
            stdin,
            group,
            stderr: Some(stderr),
        };
        let mut ready = String::new();
        let handshake = tokio::time::timeout(
            Duration::from_secs(3),
            BufReader::new(stdout).read_line(&mut ready),
        )
        .await;
        if matches!(handshake, Ok(Ok(_))) && ready == "achbit-power-ready\n" {
            return Ok(lease);
        }
        let reason = match handshake {
            Ok(Ok(_)) => format!("helper exited before inhibitor readiness: {ready:?}"),
            Ok(Err(error)) => format!("readiness pipe: {error}"),
            Err(_) => "inhibitor readiness timed out".into(),
        };
        let cleanup = lease.close().await;
        let diagnostic = lease.diagnostics().await;
        Err(format!(
            "systemd-inhibit: {reason}; {diagnostic}; cleanup={cleanup:?}"
        ))
    }
    fn signal_group(&self, signal: i32) -> Result<(), String> {
        if let Some(group) = self.group {
            if unsafe { kill(-(group as i32), signal) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(3) {
                    return Err(format!("inhibitor process group: {error}"));
                }
            }
        }
        Ok(())
    }
    async fn diagnostics(&mut self) -> String {
        match self.stderr.take() {
            Some(mut reader) => {
                match tokio::time::timeout(Duration::from_secs(1), &mut reader).await {
                    Ok(Ok(text)) => text,
                    Ok(Err(error)) => format!("stderr reader: {error}"),
                    Err(_) => {
                        reader.abort();
                        "stderr reader timed out".into()
                    }
                }
            }
            None => String::new(),
        }
    }
    async fn close(&mut self) -> Result<(), String> {
        self.stdin.take(); // EOF releases the lock holder, including on Host loss.
        if self.group.is_none() {
            return Ok(());
        }
        match tokio::time::timeout(Duration::from_millis(500), self.child.wait()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(format!("inhibitor wait: {error}")),
            Err(_) => {
                self.signal_group(9)?;
                tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                    .await
                    .map_err(|_| "inhibitor cleanup timed out")?
                    .map_err(|error| format!("inhibitor cleanup: {error}"))?;
            }
        }
        // A leader that exits unexpectedly must not leave its lock-holding child behind.
        self.signal_group(9)?;
        self.group = None;
        Ok(())
    }
}
impl super::Lease for Lease {
    async fn release(&mut self) -> Result<(), String> {
        self.close().await?;
        let _ = self.diagnostics().await;
        Ok(())
    }
    async fn failed(&mut self) -> String {
        let status = self.child.wait().await;
        let cleanup = self.close().await;
        let diagnostic = self.diagnostics().await;
        format!(
            "systemd-inhibit exited while required: {status:?}; {diagnostic}; cleanup={cleanup:?}"
        )
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.stdin.take();
        if let Err(error) = self.signal_group(9) {
            eprintln!("host_power_release_failed: {error}");
        }
        if let Some(reader) = self.stderr.take() {
            reader.abort();
        }
        // Child kill_on_drop also ensures Tokio reaps an aborted power worker's helper.
    }
}
