//! Fault injection stays in this test executable; no desktop input or external app is used.
use super::*;
use std::os::windows::io::{AsHandle, AsRawHandle, AsRawSocket, FromRawHandle, OwnedHandle};
use std::process::Stdio;
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Networking::WinSock::{setsockopt, LINGER, SOL_SOCKET, SO_LINGER},
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

const FIXTURE_TEST: &str = "computer_use::cleanup_tests::subprocess_fixture";
const MODE: &str = "ACHBIT_COMPUTER_CLEANUP_TEST_MODE";
const ENDPOINT: &str = "ACHBIT_COMPUTER_CLEANUP_TEST_ENDPOINT";

fn fixture_command(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", FIXTURE_TEST, "--ignored", "--nocapture"])
        .env(MODE, mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[test]
#[ignore = "subprocess-only fault fixture; launched by the cleanup tests"]
fn subprocess_fixture() {
    let Ok(mode) = std::env::var(MODE) else {
        return;
    };
    if mode == "descendant" {
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }
    let endpoint = std::env::var(ENDPOINT).unwrap().parse().unwrap();
    let stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(5)).unwrap();
    let mut reader = BufReader::new(stream);
    writeln!(reader.get_mut(), "ready").unwrap();
    let mut go = String::new();
    reader.read_line(&mut go).unwrap();
    assert_eq!(go.trim(), "go"); // The parent has already assigned our Job Object.
    let descendant =
        (mode == "descendant-survives").then(|| fixture_command("descendant").spawn().unwrap());
    writeln!(
        reader.get_mut(),
        "{}",
        descendant.as_ref().map_or(0, |child| child.id())
    )
    .unwrap();
    if mode == "silent" {
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }
    let mut request = String::new();
    reader.read_line(&mut request).unwrap(); // A release request, or owner-channel EOF.
    if mode.starts_with("reset") {
        let linger = LINGER {
            l_onoff: 1,
            l_linger: 0,
        };
        assert_eq!(
            unsafe {
                setsockopt(
                    reader.get_ref().as_raw_socket() as _,
                    SOL_SOCKET,
                    SO_LINGER,
                    (&linger as *const LINGER).cast(),
                    std::mem::size_of::<LINGER>() as i32,
                )
            },
            0
        );
    }
    drop(reader);
    if mode == "reset-alive" {
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }
    // Child::drop does not kill: the test verifies that the Host's exact Job does.
    drop(descendant);
}

struct StartingChild(Option<crate::process::OwnedHostProcess>);
impl Drop for StartingChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = crate::process::terminate_owned_process_tree_until(
                child,
                Instant::now() + Duration::from_secs(2),
            );
        }
    }
}

struct Fixture {
    host: ComputerUseHost,
    process: OwnedHandle,
    descendant: Option<OwnedHandle>,
}
impl Fixture {
    fn new(mode: &str, failed: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let mut command = fixture_command(mode);
        command.env(ENDPOINT, endpoint.to_string());
        let mut child = StartingChild(Some(
            crate::process::spawn_owned_host_process(&mut command).unwrap(),
        ));
        let process = child
            .0
            .as_ref()
            .unwrap()
            .child
            .as_handle()
            .try_clone_to_owned()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    assert!(
                        child
                            .0
                            .as_mut()
                            .unwrap()
                            .child
                            .try_wait()
                            .unwrap()
                            .is_none(),
                        "fixture exited before connecting"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("fixture connect: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut ready = String::new();
        reader.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        writeln!(reader.get_mut(), "go").unwrap();
        let mut pid = String::new();
        reader.read_line(&mut pid).unwrap();
        let pid: u32 = pid.trim().parse().unwrap();
        let descendant = (pid != 0).then(|| {
            // The owned fixture reports its still-running child after the Job is attached.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!handle.is_null());
            unsafe { OwnedHandle::from_raw_handle(handle.cast()) }
        });
        let host = ComputerUseHost {
            app: std::env::current_exe().unwrap(),
            host: "host:cleanup".into(),
            token: "fixture".into(),
            connection: Mutex::new(Some(Connection {
                stream: reader,
                process_exit: child.0.take().unwrap(),
                executable_modified: SystemTime::now(),
                failure: failed.then(|| "original_tool_failure".into()),
            })),
            preview_endpoint: Mutex::new(Some(endpoint)),
        };
        Self {
            host,
            process,
            descendant,
        }
    }

    fn assert_reaped(&self) {
        for process in std::iter::once(&self.process).chain(self.descendant.iter()) {
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle() as HANDLE, 0) },
                WAIT_OBJECT_0,
                "an owned helper/descendant still runs after cleanup acknowledgement"
            );
        }
        assert!(self.host.connection.lock().unwrap().is_none());
        assert!(self.host.preview_endpoint.lock().unwrap().is_none());
    }

    fn release(&self) -> Result<Value, String> {
        self.host.call(
            &json!({"hostInstanceId":"host:cleanup","sessionId":"s","runId":"r"}),
            &json!({"action":"computer:releaseRun"}),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Even a regression/panic must not leave this fault-injection helper alive.
        if self.host.stop().is_err() {
            if let Some(connection) = self.host.connection.lock().unwrap().as_mut() {
                let _ = crate::process::terminate_owned_process_tree_until(
                    &mut connection.process_exit,
                    Instant::now() + Duration::from_secs(2),
                );
            }
        }
    }
}

#[test]
fn reset_after_failed_call_is_reaped_and_release_is_idempotent() {
    let fixture = Fixture::new("reset-exit", true);
    assert_eq!(fixture.release().unwrap()["data"]["released"], true);
    fixture.assert_reaped();
    assert_eq!(fixture.release().unwrap()["data"]["released"], true);
    fixture.host.stop().unwrap();
    fixture.assert_reaped();
}

#[test]
fn first_release_recovers_a_broken_channel_without_launching_a_replacement() {
    let fixture = Fixture::new("reset-exit", false);
    assert_eq!(fixture.release().unwrap()["data"]["released"], true);
    fixture.assert_reaped();
}

#[test]
fn already_exited_helper_is_confirmed_without_reusing_its_broken_socket() {
    let fixture = Fixture::new("silent", true);
    {
        let mut slot = fixture.host.connection.lock().unwrap();
        let child = &mut slot.as_mut().unwrap().process_exit.child;
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let started = Instant::now();
    fixture.release().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    fixture.assert_reaped();
}

#[test]
fn reset_with_a_live_helper_still_reclaims_the_owned_process() {
    let fixture = Fixture::new("reset-alive", true);
    let started = Instant::now();
    fixture.release().unwrap();
    assert!(started.elapsed() < Duration::from_secs(8));
    fixture.assert_reaped();
}

#[test]
fn silent_helper_cleanup_is_bounded_and_does_not_leave_a_process() {
    let fixture = Fixture::new("silent", true);
    let started = Instant::now();
    fixture.release().unwrap();
    assert!(started.elapsed() < Duration::from_secs(8));
    fixture.assert_reaped();
}

#[test]
fn descendants_do_not_survive_a_gracefully_exited_helper() {
    let fixture = Fixture::new("descendant-survives", true);
    assert_eq!(
        unsafe {
            WaitForSingleObject(
                fixture.descendant.as_ref().unwrap().as_raw_handle() as HANDLE,
                0,
            )
        },
        WAIT_TIMEOUT
    );
    fixture.release().unwrap();
    fixture.assert_reaped();
}

#[test]
#[ignore = "requires ACHBIT_TEST_COMPUTER_USE_HELPER from the built Debug package"]
fn packaged_helper_exit_during_a_run_is_reaped_without_replaying_the_call() {
    let helper = std::env::var_os("ACHBIT_TEST_COMPUTER_USE_HELPER").expect("built helper path");
    let host = ComputerUseHost {
        app: PathBuf::from(helper),
        host: "host:packaged-cleanup".into(),
        token: "fixture".into(),
        connection: Mutex::new(None),
        preview_endpoint: Mutex::new(None),
    };
    let binding = json!({"hostInstanceId":"host:packaged-cleanup","sessionId":"s","runId":"r"});
    assert_eq!(
        host.call(&binding, &json!({"action":"computer:status"}))
            .unwrap()["ok"],
        true
    );
    let proof = {
        let mut slot = host.connection.lock().unwrap();
        let child = &mut slot.as_mut().unwrap().process_exit.child;
        let proof = child.as_handle().try_clone_to_owned().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        proof
    };
    let original_error = host
        .call(&binding, &json!({"action":"computer:status"}))
        .unwrap_err();
    assert!(
        original_error.starts_with("computer_component_"),
        "{original_error}"
    );
    assert_eq!(
        host.call(&binding, &json!({"action":"computer:releaseRun"}))
            .unwrap()["data"]["released"],
        true
    );
    assert_eq!(
        unsafe { WaitForSingleObject(proof.as_raw_handle() as HANDLE, 0) },
        WAIT_OBJECT_0
    );
    assert!(host.connection.lock().unwrap().is_none());
    assert!(host.preview_endpoint.lock().unwrap().is_none());
    host.stop().unwrap();
}
