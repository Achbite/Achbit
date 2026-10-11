//! GUI Host ownership of the independently signed native executor.
//! The connection lifetime owns the process; no Session state or tool policy lives here.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

struct Connection {
    stream: BufReader<TcpStream>,
    executable_modified: SystemTime,
    failure: Option<String>,
}

impl Connection {
    fn stop(&mut self) -> Result<(), String> {
        self.stream
            .get_mut()
            .shutdown(Shutdown::Write)
            .map_err(|e| e.to_string())?;
        self.stream
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        // A failed call may still have a response in flight. Drain it only to
        // await owner-channel closure, never turn it into a successful tool result.
        let mut bytes = [0; 8192];
        loop {
            match self.stream.read(&mut bytes) {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(error) => return Err(format!("computer_component_shutdown_failed: {error}")),
            }
        }
    }
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
        if let Some(mut connection) = self
            .connection
            .lock()
            .map_err(|_| "computer_component_state_unavailable")?
            .take()
        {
            connection.stop()?;
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
        if handshake["token"] != self.token || !handshake["pid"].is_u64() {
            return Err("computer_component_handshake_invalid".into());
        }
        Ok(Connection {
            stream: reader,
            executable_modified: modified,
            failure: None,
        })
    }

    pub fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        let modified = std::fs::metadata(self.executable())
            .and_then(|m| m.modified())
            .map_err(|e| format!("computer_component_unavailable: {e}"))?;
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "computer_component_state_unavailable")?;
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
