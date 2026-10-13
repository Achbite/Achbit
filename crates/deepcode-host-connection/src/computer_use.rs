//! Shared Host ownership of the native desktop executor.
//! The connection lifetime owns the process; no Session state or tool policy lives here.
//! macOS launches an independently signed App through LaunchServices; Windows starts
//! the sibling executable inside a Host-owned Job Object.
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

/// Proof that the exact authenticated helper process has exited.
#[cfg(target_os = "macos")]
type ProcessExit = OwnedFd;
#[cfg(windows)]
type ProcessExit = crate::process::OwnedHostProcess;

struct Connection {
    stream: BufReader<TcpStream>,
    process_exit: ProcessExit,
    executable_modified: SystemTime,
    failure: Option<String>,
}

impl Connection {
    fn stop(&mut self) -> Result<(), String> {
        let result = self.stop_and_wait();
        if let Err(error) = &result {
            self.failure.get_or_insert_with(|| error.clone());
        }
        result
    }

    fn stop_and_wait(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        if let Err(error) = self.stream.get_mut().shutdown(Shutdown::Write) {
            if error.kind() != std::io::ErrorKind::NotConnected {
                return Err(format!("computer_component_shutdown_failed: {error}"));
            }
        }
        // A failed call may still have a response in flight. Drain it only to
        // await owner-channel closure, never turn it into a successful tool result.
        let mut bytes = [0; 8192];
        loop {
            self.stream
                .get_mut()
                .set_read_timeout(Some(
                    deadline
                        .checked_duration_since(Instant::now())
                        .ok_or("computer_component_shutdown_timeout")?,
                ))
                .map_err(|e| format!("computer_component_shutdown_failed: {e}"))?;
            match self.stream.read(&mut bytes) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => return Err(format!("computer_component_shutdown_failed: {error}")),
            }
        }
        self.wait_for_exit(deadline)
    }

    /// EOF confirms channel closure, not App exit: termination is dispatched
    /// asynchronously on the component's main thread. This watch was attached
    /// to the handshake process before any call, so PID reuse cannot replace it.
    #[cfg(target_os = "macos")]
    fn wait_for_exit(&mut self, deadline: Instant) -> Result<(), String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("computer_component_exit_timeout")?;
        let timeout = libc::timespec {
            tv_sec: remaining.as_secs() as _,
            tv_nsec: remaining.subsec_nanos() as _,
        };
        let mut event = std::mem::MaybeUninit::<libc::kevent>::uninit();
        match unsafe {
            libc::kevent(
                self.process_exit.as_raw_fd(),
                std::ptr::null(),
                0,
                event.as_mut_ptr(),
                1,
                &timeout,
            )
        } {
            1 => Ok(()),
            0 => Err("computer_component_exit_timeout".into()),
            _ => Err(format!(
                "computer_component_exit_wait_failed: {}",
                std::io::Error::last_os_error()
            )),
        }
    }

    /// The Host holds the helper's process handle. After channel closure no
    /// request is in flight, so an executor that does not exit is released.
    #[cfg(windows)]
    fn wait_for_exit(&mut self, deadline: Instant) -> Result<(), String> {
        while Instant::now() < deadline {
            if self.exited() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        crate::process::terminate_owned_process_tree_until(
            &mut self.process_exit,
            Instant::now() + Duration::from_secs(2),
        )
        .map_err(|error| format!("computer_component_exit_timeout: {error}"))
    }

    #[cfg(windows)]
    fn exited(&mut self) -> bool {
        matches!(self.process_exit.child.try_wait(), Ok(Some(_)))
    }
}

#[cfg(target_os = "macos")]
fn watch_process_exit(pid: libc::pid_t) -> Result<OwnedFd, String> {
    let descriptor = unsafe { libc::kqueue() };
    if descriptor < 0 {
        return Err(format!(
            "computer_component_exit_watch_failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let queue = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let event = libc::kevent {
        ident: pid as _,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    if unsafe { libc::fcntl(queue.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &event,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
    {
        return Err(format!(
            "computer_component_exit_watch_failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(queue)
}

/// Packaged location relative to the shared Host: a sibling App bundle on macOS, a sibling
/// executable in the installation directory on Windows.
fn packaged_location(host_executable: &Path) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    return host_executable
        .parent()
        .and_then(|p| p.ancestors().nth(3))
        .map(|root| root.join("DeepCode Computer Use.app"))
        .ok_or_else(|| "computer_component_package_path_invalid".into());
    #[cfg(windows)]
    return host_executable
        .parent()
        .map(|directory| directory.join("DeepCode-Computer-Use.exe"))
        .ok_or_else(|| "computer_component_package_path_invalid".into());
}

pub struct ComputerUseHost {
    /// macOS: the App bundle. Windows: the executable itself.
    app: PathBuf,
    host: String,
    token: String,
    connection: Mutex<Option<Connection>>,
}

impl ComputerUseHost {
    pub fn new(host: String, token: String) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let app =
            match crate::configured_path("DEEPCODE_COMPUTER_APP").map_err(|e| e.to_string())? {
                Some(path) => path,
                None => packaged_location(&executable)?,
            };
        Ok(Self {
            app,
            host,
            token,
            connection: Mutex::new(None),
        })
    }

    fn executable(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        return self.app.join("Contents/MacOS/DeepCode-Computer-Use");
        #[cfg(windows)]
        return self.app.clone();
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "computer_component_state_unavailable")?;
        if let Some(connection) = slot.as_mut() {
            connection.stop()?;
            *slot = None;
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn launch(&self, arguments: &[&str]) -> Result<(), String> {
        // LaunchServices gives this App its own macOS identity, instead of
        // inheriting the Host's permission responsibility as a directly spawned binary.
        let launched = Command::new("/usr/bin/open")
            .args(["-n", "-g", "-a"])
            .arg(&self.app)
            .arg("--args")
            .args(arguments)
            .output()
            .map_err(|e| e.to_string())?;
        if !launched.status.success() {
            return Err(format!(
                "computer_component_launch_failed: {}",
                String::from_utf8_lossy(&launched.stderr)
            ));
        }
        Ok(())
    }

    /// An update renames the mapped executable aside; once no helper of this Host
    /// runs, those retired images can be deleted. Another Host may still map one,
    /// in which case deletion fails and is retried at a later start.
    #[cfg(windows)]
    fn remove_retired_executables(&self) {
        let (Some(directory), Some(name)) = (self.app.parent(), self.app.file_name()) else {
            return;
        };
        let prefix = format!("{}.retired-", name.to_string_lossy());
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    #[cfg(windows)]
    fn launch(&self, arguments: &[&str]) -> Result<crate::process::OwnedHostProcess, String> {
        self.remove_retired_executables();
        let mut command = Command::new(self.executable());
        command.args(arguments).stdin(std::process::Stdio::null());
        let process = crate::process::spawn_owned_host_process(&mut command)
            .map_err(|error| format!("computer_component_launch_failed: {error}"))?;
        // The GUI may be the foreground app; let the helper focus an explicitly
        // observed window for foreground input. Failure only limits focus changes.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(
                process.child.id(),
            )
        };
        Ok(process)
    }

    fn start(&self, modified: SystemTime) -> Result<Connection, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        let arguments = [
            "--connect",
            address.as_str(),
            "--token",
            self.token.as_str(),
            "--host",
            self.host.as_str(),
        ];
        #[cfg(target_os = "macos")]
        self.launch(&arguments)?;
        #[cfg(windows)]
        let mut launched = self.launch(&arguments)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    #[cfg(windows)]
                    if let Ok(Some(status)) = launched.child.try_wait() {
                        return Err(format!(
                            "computer_component_exited_before_connecting: {status}"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(error) => return Err(format!("computer_component_connection_failed: {error}")),
            }
        };
        // Darwin may inherit the listener's nonblocking flag. The framed channel
        // uses blocking reads with deadlines, unlike the launch accept loop.
        stream
            .set_nonblocking(false)
            .map_err(|e| format!("computer_component_channel_setup_failed: {e}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream);
        let mut handshake = String::new();
        reader
            .read_line(&mut handshake)
            .map_err(|e| format!("computer_component_handshake_failed: {e}"))?;
        let handshake: Value = serde_json::from_str(&handshake).map_err(|e| e.to_string())?;
        if handshake["token"] != self.token.as_str() {
            return Err("computer_component_handshake_invalid".into());
        }
        #[cfg(target_os = "macos")]
        let process_exit = {
            let pid = handshake["pid"]
                .as_u64()
                .and_then(|value| libc::pid_t::try_from(value).ok())
                .filter(|pid| *pid > 0)
                .ok_or("computer_component_handshake_invalid")?;
            watch_process_exit(pid)?
        };
        // The connecting process must be the exact child this Host started.
        #[cfg(windows)]
        let process_exit = {
            if handshake["pid"].as_u64() != Some(u64::from(launched.child.id())) {
                return Err("computer_component_handshake_invalid".into());
            }
            launched
        };
        Ok(Connection {
            stream: reader,
            process_exit,
            executable_modified: modified,
            failure: None,
        })
    }

    pub fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "computer_component_state_unavailable")?;
        if input["action"] == "computer:releaseRun" {
            // Releasing an unused run must never launch a desktop executor.
            if slot.is_none() {
                return Ok(json!({"ok":true,"data":{"released":true}}));
            }
            if slot
                .as_ref()
                .is_some_and(|connection| connection.failure.is_some())
            {
                // A failed channel is not proof of release. Close the owned
                // executor and await its exact process before acknowledging it.
                slot.as_mut().expect("connected component").stop()?;
                *slot = None;
                return Ok(json!({"ok":true,"data":{"released":true}}));
            }
        }
        // Release belongs to the connected executor even if its on-disk package
        // changed. Never launch a replacement merely to release the old run.
        if input["action"] != "computer:releaseRun" {
            let modified = std::fs::metadata(self.executable())
                .and_then(|m| m.modified())
                .map_err(|e| format!("computer_component_unavailable: {e}"))?;
            // An explicit package replacement is observed only between calls. Retire
            // the old process before starting the replacement; never replay an input.
            if slot
                .as_ref()
                .is_some_and(|connection| connection.executable_modified != modified)
            {
                slot.as_mut().expect("checked component").stop()?;
                *slot = None;
            }
            // A failed helper whose exact process has exited has no input in flight,
            // so a new process is not a competing executor. The failed call itself is
            // never replayed; its error was already returned.
            #[cfg(windows)]
            if slot
                .as_mut()
                .is_some_and(|connection| connection.failure.is_some() && connection.exited())
            {
                *slot = None;
            }
            if slot.is_none() {
                *slot = Some(self.start(modified)?);
            }
        }
        let connection = slot.as_mut().expect("started component");
        Self::exchange(connection, binding, input)
    }

    fn exchange(
        connection: &mut Connection,
        binding: &Value,
        input: &Value,
    ) -> Result<Value, String> {
        if let Some(error) = &connection.failure {
            return Err(error.clone());
        }
        let result = (|| {
            writeln!(
                connection.stream.get_mut(),
                "{}",
                json!({"binding":binding,"input":input})
            )
            .map_err(|e| format!("computer_component_write_failed: {e}"))?;
            let mut response = String::new();
            if connection
                .stream
                .read_line(&mut response)
                .map_err(|e| format!("computer_component_read_failed: {e}"))?
                == 0
            {
                return Err("computer_component_disconnected".into());
            }
            serde_json::from_str(&response)
                .map_err(|e| format!("computer_component_response_invalid: {e}"))
        })();
        if let Err(error) = &result {
            // Keep this failed connection until explicit update or Host shutdown.
            // A timeout must not launch a second executor while input is in flight.
            connection.failure = Some(error.clone());
            let _ = connection.stream.get_mut().shutdown(Shutdown::Write);
        }
        result
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A stand-in helper: `cmd` connects nowhere, so the Host reports its exit.
    #[test]
    fn a_helper_that_exits_before_connecting_is_reported_not_awaited() {
        let host = ComputerUseHost {
            app: PathBuf::from(std::env::var_os("ComSpec").expect("ComSpec")),
            host: "host".into(),
            token: "token".into(),
            connection: Mutex::new(None),
        };
        let started = Instant::now();
        let error = host
            .call(&json!({}), &json!({"action":"computer:status"}))
            .unwrap_err();
        assert!(
            error.starts_with("computer_component_exited_before_connecting")
                || error.starts_with("computer_component_connection_failed"),
            "{error}"
        );
        assert!(started.elapsed() < Duration::from_secs(9), "{error}");
        assert!(host.connection.lock().unwrap().is_none());
    }

    /// Runs against a built helper when DEEPCODE_TEST_COMPUTER_USE_HELPER names it.
    #[test]
    fn host_owns_the_exact_helper_process_and_retires_it_on_stop() {
        let Some(helper) = std::env::var_os("DEEPCODE_TEST_COMPUTER_USE_HELPER") else {
            eprintln!("skipped: DEEPCODE_TEST_COMPUTER_USE_HELPER is not set");
            return;
        };
        let host = ComputerUseHost {
            app: PathBuf::from(helper),
            host: "host:test".into(),
            token: "token-test".into(),
            connection: Mutex::new(None),
        };
        assert!(host.executable().is_file());
        let binding = json!({"hostInstanceId":"host:test","sessionId":"s","runId":"r"});
        let status = host
            .call(&binding, &json!({"action":"computer:status"}))
            .unwrap();
        assert_eq!(status["ok"], true, "{status}");
        let pid = status["data"]["executor"]["pid"].as_u64().unwrap();
        assert_eq!(
            Some(pid),
            host.connection
                .lock()
                .unwrap()
                .as_ref()
                .map(|c| u64::from(c.process_exit.child.id()))
        );
        let rejected = host
            .call(
                &json!({"hostInstanceId":"other"}),
                &json!({"action":"computer:status"}),
            )
            .unwrap();
        assert_eq!(rejected["message"], "computer_host_binding_mismatch");
        for _ in 0..2 {
            let released = host
                .call(&binding, &json!({"action":"computer:releaseRun"}))
                .unwrap();
            assert_eq!(released["ok"], true, "{released}");
            assert_eq!(released["data"]["released"], true, "{released}");
        }
        let still_owned = host
            .call(&binding, &json!({"action":"computer:status"}))
            .unwrap();
        assert_eq!(
            still_owned["data"]["executor"]["pid"].as_u64(),
            Some(pid),
            "run cleanup keeps the same executor"
        );
        host.stop().unwrap();
        assert!(host.connection.lock().unwrap().is_none());
        let released = host
            .call(&binding, &json!({"action":"computer:releaseRun"}))
            .unwrap();
        assert_eq!(released["data"]["released"], true, "{released}");
        assert!(
            host.connection.lock().unwrap().is_none(),
            "cleanup must not launch a helper"
        );
        let again = host
            .call(&binding, &json!({"action":"computer:status"}))
            .unwrap();
        assert_ne!(again["data"]["executor"]["pid"].as_u64(), Some(pid));
        host.stop().unwrap();
    }

    /// The Windows update replaces a mapped executable by renaming it aside.
    #[test]
    fn replaced_helper_is_retired_between_calls_and_its_image_removed() {
        let Some(helper) = std::env::var_os("DEEPCODE_TEST_COMPUTER_USE_HELPER") else {
            eprintln!("skipped: DEEPCODE_TEST_COMPUTER_USE_HELPER is not set");
            return;
        };
        let directory =
            std::env::temp_dir().join(format!("deepcode-cu-update-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let installed = directory.join("DeepCode-Computer-Use.exe");
        std::fs::copy(&helper, &installed).unwrap();
        let host = ComputerUseHost {
            app: installed.clone(),
            host: "host:update".into(),
            token: "token-update".into(),
            connection: Mutex::new(None),
        };
        let binding = json!({"hostInstanceId":"host:update","sessionId":"s","runId":"r"});
        let status = |host: &ComputerUseHost| {
            host.call(&binding, &json!({"action":"computer:status"}))
                .unwrap()["data"]["executor"]["pid"]
                .as_u64()
                .unwrap()
        };
        let first = status(&host);
        let retired = directory.join("DeepCode-Computer-Use.exe.retired-1");
        std::fs::rename(&installed, &retired).expect("a running image can be renamed aside");
        std::fs::copy(&helper, &installed).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&installed)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        let second = status(&host);
        assert_ne!(
            first, second,
            "the replaced executable must be a new process"
        );
        assert!(
            !retired.exists(),
            "the retired image is removed after its process exits"
        );
        host.stop().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
