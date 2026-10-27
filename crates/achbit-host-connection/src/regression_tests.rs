use super::*;
use achbit_kernel_abi::{HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_PREFIX};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .join(format!(
                "achbit-host-regression-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("用户数据 with spaces");
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
    }
}

struct TestChild(Child);

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn connection(address: SocketAddr) -> LocalHostConnection {
    LocalHostConnection::new(
        HostProcessIdentity {
            service: KERNEL_DAEMON_SERVICE.into(),
            instance_id: format!("{HOST_INSTANCE_ID_PREFIX}{}", "03".repeat(32)),
            pid: std::process::id(),
            address: format!("http://{address}"),
        },
        format!("{HOST_SHELL_TOKEN_PREFIX}{}", "04".repeat(32)),
    )
    .unwrap()
}

#[test]
fn discovery_classifies_only_unreachable_connects_as_unavailable() {
    let root = TestRoot::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let record = connection(listener.local_addr().unwrap());
    let _publication = record.publish(&root.0).unwrap();
    for kind in [io::ErrorKind::ConnectionRefused, io::ErrorKind::TimedOut] {
        let found = LocalHostConnection::discover_with_connector(&root.0, |address, _| {
            assert_eq!(*address, listener.local_addr().unwrap());
            Err(io::Error::from(kind))
        })
        .unwrap();
        assert!(found.is_none());
        assert!(
            root.0.join(CONNECTION_FILE).is_file(),
            "discovery must not delete the record"
        );
    }
    let os_code = if cfg!(windows) { 5 } else { 13 };
    let error = LocalHostConnection::discover_with_connector(&root.0, |_, _| {
        Err(io::Error::from_raw_os_error(os_code))
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    let original = error
        .get_ref()
        .unwrap()
        .downcast_ref::<HostIoError>()
        .unwrap();
    assert_eq!(original.source.raw_os_error(), Some(os_code));
    assert!(error.to_string().contains("Connect to recorded Host"));
    assert!(error.to_string().contains("host-connection.json"));
    assert!(!error.to_string().contains(record.shell_token()));
}

#[test]
fn connected_identity_failures_are_not_treated_as_stale_records() {
    let root = TestRoot::new();
    for no_response in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let record = connection(listener.local_addr().unwrap());
        let publication = record.publish(&root.0).unwrap();
        let mut identity = record.identity.clone();
        identity.pid += 1;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            if no_response {
                // Keep the connection open until the discovery read times out.
                let _ = stream.read(&mut [0]);
            } else {
                let body = serde_json::json!({"ok": true, "data": identity}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let result = LocalHostConnection::discover(&root.0);
        server.join().unwrap();
        let error = result.unwrap_err();
        if no_response {
            assert!(matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ));
            assert!(error.to_string().contains("Read Host identity response"));
        } else {
            assert!(error
                .to_string()
                .contains("does not match the live process"));
        }
        drop(publication);
    }
}

#[test]
fn publication_replaces_old_records_without_removing_an_unowned_temporary_file() {
    let root = TestRoot::new();
    let record = connection("127.0.0.1:12345".parse().unwrap());
    let path = root.0.join(CONNECTION_FILE);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"previous connection record").unwrap();
    let publication = record.publish(&root.0).unwrap();
    let published = std::fs::read(&path).unwrap();
    let actual: LocalHostConnection = serde_json::from_slice(&published).unwrap();
    assert_eq!(actual.identity, record.identity);
    let temporary = path.with_extension(format!("{}.tmp", record.identity.instance_id));
    std::fs::write(&temporary, b"belongs to another attempt").unwrap();
    let error = record
        .publish(&root.0)
        .err()
        .expect("existing temporary file must fail");
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert!(error
        .to_string()
        .contains("Create Host connection temporary file"));
    assert!(!error.to_string().contains(record.shell_token()));
    assert_eq!(
        std::fs::read(&temporary).unwrap(),
        b"belongs to another attempt"
    );
    assert_eq!(std::fs::read(&path).unwrap(), published);
    drop(publication);
}

#[test]
fn port_lock_releases_immediately_when_its_process_is_killed() {
    const CHILD_ROOT: &str = "ACHBIT_TEST_PORT_LOCK_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let _guard = HostStartGuard::try_acquire_port(&root, "127.0.0.1", "12345")
            .unwrap()
            .unwrap();
        std::fs::write(root.join("ready"), b"locked").unwrap();
        loop {
            std::thread::park();
        }
    }
    let root = TestRoot::new();
    let marker = root.0.join("achbit-kernel-start-127-0-0-1-12345.lock");
    std::fs::write(&marker, b"pid=999999\n").unwrap();
    let mut child = TestChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "regression_tests::port_lock_releases_immediately_when_its_process_is_killed",
            ])
            .env(CHILD_ROOT, &root.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.0.join("ready").is_file() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "lock child exited before acquiring the lock"
        );
        assert!(Instant::now() < deadline, "lock child startup timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        HostStartGuard::try_acquire_port(&root.0, "127.0.0.1", "12345")
            .unwrap()
            .is_none()
    );
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let replacement = HostStartGuard::try_acquire_port(&root.0, "127.0.0.1", "12345").unwrap();
    assert!(
        replacement.is_some(),
        "a dead owner must not block a new startup"
    );
    drop(replacement);
    assert!(
        marker.is_file(),
        "lock ownership must not depend on deleting the marker"
    );
}

#[test]
fn runtime_paths_survive_a_real_child_working_directory_change() {
    const MODE: &str = "ACHBIT_TEST_RUNTIME_PATH_MODE";
    const ROOT: &str = "ACHBIT_TEST_RUNTIME_PATH_ROOT";
    let mode = std::env::var(MODE).unwrap_or_default();
    if mode == "check" {
        for name in [
            "ACHBIT_RUNTIME_DIR",
            "ACHBIT_CLIENT_DIST",
            "ACHBIT_NODE",
            "ACHBIT_SESSION_BRIDGE",
            "ACHBIT_USER_ROOT",
            "ACHBIT_LOG_DIR",
        ] {
            assert!(
                PathBuf::from(std::env::var_os(name).unwrap()).is_absolute(),
                "{name}"
            );
        }
        let resources = runtime_root(Path::new("unused-default")).unwrap();
        assert_eq!(
            std::fs::read(resources.join("BUILDINFO.json")).unwrap(),
            b"runtime"
        );
        assert_eq!(
            std::fs::read(configured_path("ACHBIT_NODE").unwrap().unwrap()).unwrap(),
            b"node"
        );
        assert_eq!(
            std::fs::read(configured_path("ACHBIT_SESSION_BRIDGE").unwrap().unwrap()).unwrap(),
            b"bridge"
        );
        assert_eq!(
            std::fs::read(
                configured_path("ACHBIT_CLIENT_DIST")
                    .unwrap()
                    .unwrap()
                    .join("index.html")
            )
            .unwrap(),
            b"gui"
        );
        let expected = PathBuf::from(std::env::var_os(ROOT).unwrap()).join("用户 state");
        assert_eq!(
            UserDirectories::resolve().unwrap(),
            UserDirectories::isolated(&expected)
        );
        return;
    }
    if mode == "resolve" {
        let resources = runtime_root(Path::new("unused-default")).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "regression_tests::runtime_paths_survive_a_real_child_working_directory_change",
            ])
            .env(MODE, "check")
            .current_dir("child");
        configure_runtime_child(&mut command, &resources).unwrap();
        command.env(
            "ACHBIT_CLIENT_DIST",
            configured_path("ACHBIT_CLIENT_DIST").unwrap().unwrap(),
        );
        UserDirectories::resolve()
            .unwrap()
            .configure_child(&mut command);
        assert!(command.status().unwrap().success());
        return;
    }
    let root = TestRoot::new();
    let resources = root.0.join("运行 resources");
    std::fs::create_dir_all(root.0.join("child")).unwrap();
    std::fs::create_dir_all(&resources).unwrap();
    for (name, content) in [
        ("BUILDINFO.json", "runtime"),
        ("node.exe", "node"),
        ("bridge.js", "bridge"),
        ("index.html", "gui"),
    ] {
        std::fs::write(resources.join(name), content).unwrap();
    }
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "regression_tests::runtime_paths_survive_a_real_child_working_directory_change",
        ])
        .env(MODE, "resolve")
        .env(ROOT, &root.0)
        .current_dir(&root.0)
        .env("ACHBIT_RUNTIME_DIR", "运行 resources")
        .env("ACHBIT_CLIENT_DIST", "运行 resources")
        .env("ACHBIT_NODE", Path::new("运行 resources").join("node.exe"))
        .env(
            "ACHBIT_SESSION_BRIDGE",
            Path::new("运行 resources").join("bridge.js"),
        )
        .env("ACHBIT_USER_ROOT", "用户 state")
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(windows)]
#[test]
fn connection_publication_accepts_a_long_windows_user_directory() {
    use std::os::windows::ffi::OsStrExt;
    let root = TestRoot::new();
    let mut long_root = root.0.clone();
    while long_root.as_os_str().encode_wide().count() < 300 {
        long_root.push("long-user-directory");
    }
    let record = connection("127.0.0.1:12345".parse().unwrap());
    let publication = record.publish(&long_root).unwrap();
    let actual: LocalHostConnection =
        serde_json::from_slice(&std::fs::read(long_root.join(CONNECTION_FILE)).unwrap()).unwrap();
    assert_eq!(actual.identity, record.identity);
    drop(publication);
}
