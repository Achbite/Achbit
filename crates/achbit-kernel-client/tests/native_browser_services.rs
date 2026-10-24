#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::AtomicU64,
    time::{Duration, Instant},
};

#[path = "../../../shells/shared/native_browser/services.rs"]
mod services;

static PAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

// The native module only needs these input adapters; process ownership stays in
// the same production services.rs used by the desktop shell.
fn string<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key]
        .as_str()
        .ok_or_else(|| format!("Missing string: {key}"))
}

fn page_url(input: &Value) -> Result<reqwest::Url, String> {
    reqwest::Url::parse(string(input, "url")?).map_err(|error| error.to_string())
}

struct OwnedFixture {
    services: HashMap<String, services::DevelopmentService>,
    root: PathBuf,
    process_group: Option<libc::pid_t>,
    previous_subreaper: libc::c_int,
}

impl OwnedFixture {
    fn new() -> Self {
        let mut previous_subreaper = 0;
        assert_eq!(
            unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut previous_subreaper) },
            0
        );
        assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
        let root = std::env::temp_dir().join(format!(
            "deepcode-native-service-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            services: HashMap::new(),
            root,
            process_group: None,
            previous_subreaper,
        }
    }
}

impl Drop for OwnedFixture {
    fn drop(&mut self) {
        self.services.clear();
        if let Some(group) = self.process_group {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
                while libc::waitpid(-group, std::ptr::null_mut(), 0) > 0 {}
            }
        }
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.previous_subreaper) };
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn exited_development_leader_releases_its_term_ignoring_descendant() {
    let mut fixture = OwnedFixture::new();
    let descendant_path = fixture.root.join("descendant.pid");
    let exit_path = fixture.root.join("exit-leader");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let script = r#"
import os, pathlib, signal, sys, time
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    path = pathlib.Path(sys.argv[1])
    pending = path.with_suffix('.pending')
    pending.write_text(str(os.getpid()))
    pending.replace(path)
    while True:
        time.sleep(1)
while not pathlib.Path(sys.argv[2]).exists():
    time.sleep(0.01)
os._exit(7)
"#;
    let started = services::execute(
        &mut fixture.services,
        fixture.root.join("logs"),
        Some("session:service-test"),
        &json!({"action":"serviceStart", "command":"python3", "directory":fixture.root,
            "url":format!("http://{address}"), "args":["-c", script, descendant_path, exit_path]}),
    )
    .unwrap();
    fixture.process_group = Some(started["pid"].as_i64().unwrap() as libc::pid_t);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !descendant_path.exists() {
        assert!(Instant::now() < deadline, "descendant did not initialize");
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid = std::fs::read_to_string(&descendant_path)
        .unwrap()
        .parse::<libc::pid_t>()
        .unwrap();
    std::fs::write(exit_path, "exit").unwrap();
    let status = loop {
        let status = services::execute(
            &mut fixture.services,
            fixture.root.join("logs"),
            Some("session:service-test"),
            &json!({"action":"serviceStatus", "serviceId":started["serviceId"]}),
        )
        .unwrap();
        if status["status"] == "exited" {
            break status;
        }
        assert!(Instant::now() < deadline, "leader did not exit");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status["exitCode"], 7);
    let mut descendant_status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut descendant_status, libc::WNOHANG) };
        if waited == pid {
            fixture.process_group = None;
            break;
        }
        assert_eq!(waited, 0, "owned descendant was not waitable");
        assert!(
            Instant::now() < deadline,
            "descendant outlived service cleanup"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(libc::WIFSIGNALED(descendant_status));
    assert_eq!(libc::WTERMSIG(descendant_status), libc::SIGKILL);
}
