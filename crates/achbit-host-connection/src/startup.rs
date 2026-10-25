//! Bounded readiness for processes owned by the existing shell startup owner.
use crate::process::{
    spawn_owned_host_process, terminate_owned_process_tree_until, OwnedHostProcess,
};
use std::io;
use std::process::Command;
use std::time::{Duration, Instant};

/// Opt-in startup diagnostics. Stage labels and process IDs only; never credentials.
/// Wall time aligns owned processes; elapsed time measures work in this process.
pub fn timing(stage: &'static str) {
    use std::io::Write;
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};
    static ENABLED: OnceLock<bool> = OnceLock::new();
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var("DEEPCODE_STARTUP_TIMING").as_deref() == Ok("1")) {
        return;
    }
    let elapsed = ORIGIN.get_or_init(Instant::now).elapsed().as_micros();
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    let _ = writeln!(std::io::stderr().lock(), "[startup-timing] {{\"stage\":\"{stage}\",\"pid\":{},\"atUs\":{wall},\"elapsedUs\":{elapsed}}}", std::process::id());
}

pub const STARTUP_BUDGET: Duration = Duration::from_secs(15);
const ATTEMPT_BUDGET: Duration = Duration::from_secs(6);
const PROBE_INTERVAL: Duration = Duration::from_millis(75);
const CLEANUP_RESERVE: Duration = Duration::from_millis(250);

pub fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Host startup deadline expired"))
}

pub fn pause(deadline: Instant) {
    if let Ok(left) = remaining(deadline) {
        std::thread::sleep(PROBE_INTERVAL.min(left));
    }
}

pub fn transport_pending(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::TimedOut
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    )
}

/// Only OS spawn errors that explicitly mean retry are transient. No child exists on these errors.
fn spawn_pending(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

/// Probe errors remain failures; only startup transport errors can wait/restart.
/// A successful return transfers the ready process to the caller. Nothing here replays work.
pub fn start_owned_ready<T>(
    command: &mut Command,
    deadline: Instant,
    mut probe: impl FnMut(&mut OwnedHostProcess, Instant) -> io::Result<T>,
) -> io::Result<(OwnedHostProcess, T)> {
    let mut first_error = None;
    for attempt in 0..2 {
        remaining(deadline).map_err(|error| startup_error(first_error.clone(), error, None))?;
        timing("child.spawn.begin");
        let mut process = match spawn_owned_host_process(command) {
            Ok(process) => process,
            Err(error) => {
                if attempt == 0 && spawn_pending(&error) && remaining(deadline).is_ok() {
                    first_error = Some(error.to_string());
                    pause(deadline);
                    continue;
                }
                return Err(startup_error(first_error, error, None));
            }
        };
        timing("child.spawn.return");
        // Leave a bounded interval to kill/reap the owned tree even on the last attempt.
        let attempt_deadline = (Instant::now() + ATTEMPT_BUDGET)
            .min(deadline.checked_sub(CLEANUP_RESERVE).unwrap_or(deadline));
        let mut pending_error = None;
        let (error, can_retry) = loop {
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    break (
                        io::Error::other(format!(
                            "owned Host process exited before readiness: {status}"
                        )),
                        false,
                    )
                }
                Err(error) => break (error, false),
                Ok(None) => {}
            }
            if let Err(error) = remaining(attempt_deadline) {
                let can_retry = pending_error.is_some();
                break (pending_error.unwrap_or(error), can_retry);
            }
            match probe(
                &mut process,
                attempt_deadline.min(Instant::now() + Duration::from_millis(500)),
            ) {
                Ok(ready) => return Ok((process, ready)),
                Err(error) if transport_pending(&error) => {
                    if first_error.is_none() {
                        first_error = Some(error.to_string());
                    }
                    pending_error = Some(error);
                }
                Err(error) => break (error, false),
            }
            pause(attempt_deadline);
        };
        let cleanup_error = terminate_owned_process_tree_until(&mut process, deadline).err();
        if cleanup_error.is_some() || !can_retry || attempt == 1 || remaining(deadline).is_err() {
            return Err(startup_error(first_error, error, cleanup_error));
        }
        if first_error.is_none() {
            first_error = Some(error.to_string());
        }
        pause(deadline);
    }
    unreachable!("two startup attempts always return")
}

fn startup_error(first: Option<String>, last: io::Error, cleanup: Option<io::Error>) -> io::Error {
    let mut message = match first {
        Some(first) => format!("first startup error: {first}; last startup error: {last}"),
        None => last.to_string(),
    };
    if let Some(cleanup) = cleanup {
        message.push_str(&format!("; owned tree cleanup failed: {cleanup}"));
    }
    io::Error::new(last.kind(), message)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn command() -> Command {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        command
    }

    fn process_gone(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == -1 }
    }

    #[test]
    fn startup_bound_listener_can_become_ready_without_restarting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let server = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(650));
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = [0; 1024];
                let _ = stream.read(&mut request);
                let _ =
                    stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}");
            }
        });
        let mut pids = Vec::new();
        let (mut process, value) = start_owned_ready(
            &mut command(),
            Instant::now() + Duration::from_secs(3),
            |process, deadline| {
                if !pids.contains(&process.child.id()) {
                    pids.push(process.child.id());
                }
                crate::loopback_http::request_loopback_json_until::<serde_json::Value>(
                    "127.0.0.1",
                    &port,
                    "GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
                    deadline,
                )
            },
        )
        .unwrap();
        terminate_owned_process_tree_until(&mut process, Instant::now() + Duration::from_secs(1))
            .unwrap();
        server.join().unwrap();
        assert_eq!(pids.len(), 1);
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn startup_retries_at_most_twice_after_checked_cleanup_and_keeps_errors() {
        let mut pids = Vec::new();
        let start = Instant::now();
        let error =
            start_owned_ready::<()>(&mut command(), start + STARTUP_BUDGET, |process, _| {
                let pid = process.child.id();
                if !pids.contains(&pid) {
                    if let Some(previous) = pids.last() {
                        assert!(
                            process_gone(*previous),
                            "previous tree must exit before another spawn"
                        );
                    }
                    pids.push(pid);
                }
                Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    if pids.len() == 1 {
                        "first transport failure"
                    } else {
                        "last transport failure"
                    },
                ))
            })
            .err()
            .unwrap();
        assert_eq!(pids.len(), 2);
        assert!(pids.into_iter().all(process_gone));
        assert!(error.to_string().contains("first transport failure"));
        assert!(error.to_string().contains("last transport failure"));
        assert!(start.elapsed() < STARTUP_BUDGET);
    }

    #[test]
    fn startup_second_launch_can_succeed_after_first_tree_is_reaped() {
        let mut first_pid = None;
        let (mut process, identity) = start_owned_ready(
            &mut command(),
            Instant::now() + STARTUP_BUDGET,
            |process, _| {
                let pid = process.child.id();
                let first = *first_pid.get_or_insert(pid);
                if pid == first {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionRefused,
                        "first process never served",
                    ));
                }
                assert!(
                    process_gone(first),
                    "first owned process must be reaped before probing the replacement"
                );
                Ok(format!("ready-identity-{pid}"))
            },
        )
        .unwrap();
        let ready_pid = process.child.id();
        terminate_owned_process_tree_until(&mut process, Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert_ne!(first_pid.unwrap(), ready_pid);
        assert_eq!(identity, format!("ready-identity-{ready_pid}"));
    }

    #[test]
    fn startup_protocol_error_is_not_retried_and_owned_process_is_reaped() {
        let mut pids = Vec::new();
        let error = start_owned_ready::<()>(
            &mut command(),
            Instant::now() + STARTUP_BUDGET,
            |process, _| {
                pids.push(process.child.id());
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "identity mismatch: original error",
                ))
            },
        )
        .err()
        .unwrap();
        assert_eq!(pids.len(), 1);
        assert!(process_gone(pids[0]));
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error
            .to_string()
            .contains("identity mismatch: original error"));
        assert!(!transport_pending(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "denied"
        )));
        assert!(!spawn_pending(&io::Error::new(
            io::ErrorKind::NotFound,
            "missing binary"
        )));
    }

    #[test]
    fn startup_unknown_exit_is_not_restarted() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 17"]);
        let mut pids = Vec::new();
        let error = start_owned_ready::<()>(
            &mut command,
            Instant::now() + STARTUP_BUDGET,
            |process, _| {
                pids.push(process.child.id());
                Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    "not serving",
                ))
            },
        )
        .err()
        .unwrap();
        assert!(pids.len() <= 1);
        assert!(error.to_string().contains("exit status: 17"));
    }
}
