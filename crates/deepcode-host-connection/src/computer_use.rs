//! GUI Host ownership of the independently signed native executor.
//! The connection lifetime owns the process; no Session state or tool policy lives here.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

struct Connection {
    stream: BufReader<TcpStream>,
    process_exit: OwnedFd,
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
        // EOF confirms channel closure, not App exit: termination is dispatched
        // asynchronously on the component's main thread. This watch was attached
        // to the handshake process before any call, so PID reuse cannot replace it.
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
}

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

pub struct ComputerUseHost {
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
                None => executable
                    .parent()
                    .and_then(|p| p.ancestors().nth(3))
                    .ok_or("computer_component_package_path_invalid")?
                    .join("DeepCode Computer Use.app"),
            };
        Ok(Self {
            app,
            host,
            token,
            connection: Mutex::new(None),
        })
    }

    fn executable(&self) -> PathBuf {
        self.app.join("Contents/MacOS/DeepCode-Computer-Use")
    }

    pub fn available(&self) -> bool {
        self.executable().is_file()
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

    fn start(&self, modified: SystemTime) -> Result<Connection, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        // LaunchServices gives this App its own macOS identity, instead of
        // inheriting the GUI's permission responsibility as a directly spawned binary.
        let launched = Command::new("/usr/bin/open")
            .args(["-n", "-g", "-a"])
            .arg(&self.app)
            .args([
                "--args",
                "--connect",
                &listener
                    .local_addr()
                    .map_err(|e| e.to_string())?
                    .to_string(),
                "--token",
                &self.token,
                "--host",
                &self.host,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !launched.status.success() {
            return Err(format!(
                "computer_component_launch_failed: {}",
                String::from_utf8_lossy(&launched.stderr)
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
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
        let pid = handshake["pid"]
            .as_u64()
            .and_then(|value| libc::pid_t::try_from(value).ok())
            .filter(|pid| *pid > 0);
        if handshake["token"] != self.token || pid.is_none() {
            return Err("computer_component_handshake_invalid".into());
        }
        let process_exit = watch_process_exit(pid.expect("validated component PID"))?;
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
        if slot.is_none() {
            *slot = Some(self.start(modified)?);
        }
        let connection = slot.as_mut().expect("started component");
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
