use super::*;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct UnusedReader;
impl crate::local_agent_product_tools::SessionReadPort for UnusedReader {
    fn read(&self, _: Value) -> Result<Value, crate::session_service::SessionServiceError> {
        panic!("runtime preparation must not read Session through its product tool");
    }
}

struct Fixture {
    root: PathBuf,
    gui: Arc<Mutex<GuiState>>,
    runtime: LocalAgentRuntime,
    listener: TcpListener,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(
            crate::new_runtime_ref("prepare-gate-test")
                .unwrap()
                .replace(':', "-"),
        );
        let mut gui = GuiState::open_at(&root).unwrap();
        let mut profiles = crate::model_connections::document(&gui).unwrap();
        profiles["connections"][0]["credentialRef"] = json!("local-secret:deepseek-api");
        crate::model_connections::store(
            &mut gui,
            profiles,
            Some(json!({"deepseek-api":"fixture-key"})),
        )
        .unwrap();
        let gui = Arc::new(Mutex::new(gui));
        let runtime = {
            let captured = gui.lock().unwrap();
            LocalAgentRuntime::open(
                &captured.paths.session_store_path,
                &captured.paths.tool_record_store_path,
                Arc::new(crate::local_agent_kernel::HostWorkspaceResolver::new(
                    gui.clone(),
                )),
                &captured.user_settings,
            )
            .unwrap()
        };
        runtime
            .journal
            .create_session("session:parent", "Parent", &json!([]), None, None)
            .unwrap();
        let context = json!({"capabilities":{"messaging":true,"continuation":false,"delegation":false},
            "ownerSessionId":"session:parent", "parentSessionId":"session:parent",
            "parentRunId":"run:parent", "parentCallId":"call:spawn"});
        runtime
            .journal
            .create_session("session:child", "Child", &json!([]), None, Some(&context))
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let script = root.join("gated-mcp.py");
        std::fs::write(&script, r#"import json,socket,sys
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    if request['method']=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'prepare-gate','version':'1'}}
    elif request['method']=='tools/list':
        with socket.create_connection(('127.0.0.1',int(sys.argv[1]))) as gate:
            permit=gate.recv(1)
        if permit==b'E':
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32000,'message':'fixture list failed'}}),flush=True)
            continue
        result={'tools':[]}
    else: result={}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#).unwrap();
        gui.lock().unwrap().user_settings["mcp.servers"] = json!(serde_json::to_string(&json!([{
            "id":"prepare-gate", "name":"Prepare gate", "transport":"stdio", "command":"python3",
            "args":format!("{} {}", script.display(), listener.local_addr().unwrap().port()), "enabled":true
        }])).unwrap());
        // Match the settings API: registrations publish to both GUI configuration
        // and the immediate settings projection before a run captures them.
        runtime
            .publish_runtime_settings(
                &json!({
                    "mcp.servers": gui.lock().unwrap().user_settings["mcp.servers"],
                }),
                || Ok(()),
            )
            .unwrap();
        Self {
            root,
            gui,
            runtime,
            listener,
        }
    }
    fn project(&self, workspace_id: &str, name: &str) -> PathBuf {
        let root = self.root.join(name);
        std::fs::create_dir_all(&root).unwrap();
        let root =
            achbit_kernel_runtime::file_access::process_visible_path(&root.canonicalize().unwrap());
        self.gui
            .lock()
            .unwrap()
            .conversation_catalog
            .workspaces
            .push(crate::conversation_catalog::ConversationWorkspaceRecord {
                workspace_id: workspace_id.into(),
                display_name: name.into(),
                canonical_root: root.to_string_lossy().into_owned(),
                owner_session_id: None,
                session_workdir: false,
                created_at: crate::now_text(),
            });
        root
    }
    fn request(session: &str, selected: bool) -> PrepareRunRuntimeRequest {
        serde_json::from_value(json!({"sessionId":format!("session:{session}"), "runId":format!("run:{session}"),
            "pluginSelections": if selected {json!([{"selectionId":"selection:gate","uri":"plugin://prepare-gate@mcp","label":"Prepare gate"}])} else {json!([])} })).unwrap()
    }
    fn prepare(&self, session: &str, selected: bool) -> Result<Value, RunPreparationError> {
        self.runtime.prepare_run_runtime(
            &self.gui,
            Arc::new(UnusedReader),
            Self::request(session, selected),
        )
    }
    fn pending_prepare(&self) -> std::thread::JoinHandle<Result<Value, RunPreparationError>> {
        let runtime = self.runtime.clone();
        let gui = self.gui.clone();
        std::thread::spawn(move || {
            runtime.prepare_run_runtime(&gui, Arc::new(UnusedReader), Self::request("parent", true))
        })
    }
    fn gate(
        &self,
        preparing: &std::thread::JoinHandle<Result<Value, RunPreparationError>>,
    ) -> TcpStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        !preparing.is_finished(),
                        "preparation failed before reaching MCP tools/list gate"
                    );
                    assert!(
                        Instant::now() < deadline,
                        "MCP tools/list did not enter gate"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("MCP gate accept: {error}"),
            }
        }
    }
    fn release(
        runtime: &LocalAgentRuntime,
        session: &str,
        view: &Value,
    ) -> Result<Value, RunPreparationError> {
        runtime.release_run_runtime(ReleaseToolCatalogRequest::new(
            &format!("session:{session}"),
            &format!("run:{session}"),
            view["kernelCatalogSnapshotRef"].as_str().unwrap(),
        ))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.runtime.shutdown_plugins();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn slow_mcp_prepare_does_not_block_child_retire_and_release() {
    let fixture = Fixture::new();
    let child = fixture.prepare("child", false).unwrap();
    let preparing = fixture.pending_prepare();
    let mut gate = fixture.gate(&preparing);
    let (sender, receiver) = mpsc::channel();
    let runtime = fixture.runtime.clone();
    let releasing = std::thread::spawn(move || {
        let retired = runtime.retire_tool_views(RetireToolViewsRequest {
            session_id: "session:child".into(),
            run_id: "run:child".into(),
            keep_kernel_catalog_snapshot_ref: child["kernelCatalogSnapshotRef"]
                .as_str()
                .unwrap()
                .into(),
        });
        let released = Fixture::release(&runtime, "child", &child);
        sender.send((retired, released)).unwrap();
    });
    let completed_before_gate = receiver.recv_timeout(Duration::from_secs(2));
    let gui_available_before_gate = fixture.gui.try_lock().is_ok();
    assert!(
        !preparing.is_finished(),
        "dependent prepare must still wait for the catalog response"
    );
    gate.write_all(b"Y").unwrap();
    let parent = preparing.join().unwrap().unwrap();
    Fixture::release(&fixture.runtime, "parent", &parent).unwrap();
    releasing.join().unwrap();
    let (retired, released) = completed_before_gate
        .expect("independent child retire/release waited for the parent's MCP tools/list response");
    retired.unwrap();
    released.unwrap();
    assert!(
        gui_available_before_gate,
        "external MCP wait held the GUI catalog lock"
    );
}

#[test]
fn same_run_release_drains_admitted_mcp_prepare() {
    let fixture = Fixture::new();
    let original = fixture.prepare("parent", false).unwrap();
    let preparing = fixture.pending_prepare();
    let mut gate = fixture.gate(&preparing);
    let (sender, receiver) = mpsc::channel();
    let runtime = fixture.runtime.clone();
    let releasing = std::thread::spawn(move || {
        sender
            .send(Fixture::release(&runtime, "parent", &original))
            .unwrap()
    });
    let early = receiver.recv_timeout(Duration::from_millis(100));
    gate.write_all(b"Y").unwrap();
    let prepared = preparing.join().unwrap().unwrap();
    let released = receiver.recv_timeout(Duration::from_secs(5));
    releasing.join().unwrap();
    assert!(
        matches!(early, Err(mpsc::RecvTimeoutError::Timeout)),
        "release acknowledged while admitted preparation still owned resources"
    );
    released.unwrap().unwrap();
    assert!(fixture.runtime.prepared_runs.lock().unwrap().is_empty());
    assert!(fixture
        .runtime
        .provider_runtimes
        .resolve(
            "session:parent",
            "run:parent",
            prepared["provider"]["providerRuntimeRef"].as_str().unwrap(),
            prepared["provider"]["profileId"].as_str().unwrap(),
            None
        )
        .is_err());
}

#[test]
fn failed_mcp_prepare_preserves_prior_view_for_release() {
    let fixture = Fixture::new();
    let original = fixture.prepare("parent", false).unwrap();
    let preparing = fixture.pending_prepare();
    fixture.gate(&preparing).write_all(b"E").unwrap();
    let error = preparing.join().unwrap().unwrap_err();
    assert_eq!(error.code, "mcp_request_failed");
    assert!(error.message.contains("fixture list failed"));
    let mut restore = Fixture::request("parent", false);
    restore.restore_environment = true;
    let restored = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), restore)
        .unwrap();
    assert_eq!(restored, original);
    Fixture::release(&fixture.runtime, "parent", &original).unwrap();
}

#[test]
fn pending_mcp_prepare_keeps_request_snapshot_and_new_settings_publication() {
    let fixture = Fixture::new();
    {
        let mut gui = fixture.gui.lock().unwrap();
        gui.user_settings["agent.contextManagement.enabled"] = json!(false);
        gui.user_settings["editor.fontSize"] = json!(14);
    }
    fixture
        .runtime
        .publish_runtime_settings(&json!({"editor.fontSize":14}), || Ok(()))
        .unwrap();
    let preparing = fixture.pending_prepare();
    let mut gate = fixture.gate(&preparing);
    let (sender, receiver) = mpsc::channel();
    let runtime = fixture.runtime.clone();
    let gui = fixture.gui.clone();
    let updating = std::thread::spawn(move || {
        let _transition = runtime.runtime_transition().unwrap();
        let mut gui = gui.lock().unwrap();
        gui.user_settings["agent.contextManagement.enabled"] = json!(true);
        gui.user_settings["mcp.servers"] = json!("[]");
        runtime
            .publish_runtime_settings(&json!({"mcp.servers":"[]", "editor.fontSize":null}), || {
                Ok(())
            })
            .unwrap();
        sender.send(()).unwrap();
    });
    let published_before_gate = receiver.recv_timeout(Duration::from_secs(2));
    gate.write_all(b"Y").unwrap();
    let prepared = preparing.join().unwrap().unwrap();
    updating.join().unwrap();
    let active = fixture.runtime.active_runtime_settings().unwrap();
    Fixture::release(&fixture.runtime, "parent", &prepared).unwrap();
    published_before_gate.expect("settings publication waited for external MCP preparation");
    assert_eq!(
        prepared["contextManagement"]["enabled"], false,
        "request must retain captured context settings"
    );
    assert_eq!(
        prepared["selectedPlugins"]["plugins"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "request must retain captured plugin registration"
    );
    assert_eq!(
        active["mcp.servers"], "[]",
        "old preparation must not overwrite newly published registration settings"
    );
    assert!(
        active.get("editor.fontSize").is_none(),
        "old preparation must not restore deleted immediate settings"
    );
}

#[test]
fn project_instructions_prepare_freezes_same_run_and_reads_the_next_run() {
    let fixture = Fixture::new();
    let project = fixture.project("workspace:instructions", "project");
    let source = project.join("AGENTS.md");
    std::fs::write(&source, "Original project rules\n").unwrap();
    let mut request = Fixture::request("parent", false);
    request.workspace_binding_ids = vec!["workspace:instructions".into()];
    let original = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
        .unwrap();
    let original_source = original["projectInstructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"].as_str() == source.to_str())
        .unwrap();
    assert_eq!(original_source["text"], "Original project rules\n");

    // A real new MCP view must not reread instructions, even when the file is now invalid.
    std::fs::write(&source, [0xff]).unwrap();
    let preparing = fixture.pending_prepare();
    fixture.gate(&preparing).write_all(b"Y").unwrap();
    let refreshed = preparing.join().unwrap().unwrap();
    assert_ne!(
        refreshed["kernelCatalogSnapshotRef"],
        original["kernelCatalogSnapshotRef"]
    );
    assert_eq!(
        refreshed["projectInstructions"],
        original["projectInstructions"]
    );
    let mut restore = Fixture::request("parent", false);
    restore.restore_environment = true;
    let restored = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), restore)
        .unwrap();
    assert_eq!(
        restored["projectInstructions"],
        original["projectInstructions"]
    );
    Fixture::release(&fixture.runtime, "parent", &refreshed).unwrap();

    std::fs::write(&source, "Updated project rules\n").unwrap();
    let mut request = Fixture::request("parent", false);
    request.run_id = "run:next".into();
    request.workspace_binding_ids = vec!["workspace:instructions".into()];
    let next = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
        .unwrap();
    let next_source = next["projectInstructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"].as_str() == source.to_str())
        .unwrap();
    assert_eq!(next_source["text"], "Updated project rules\n");
    fixture
        .runtime
        .release_run_runtime(ReleaseToolCatalogRequest::new(
            "session:parent",
            "run:next",
            next["kernelCatalogSnapshotRef"].as_str().unwrap(),
        ))
        .unwrap();
}

#[test]
fn project_instructions_read_failure_releases_locks_before_creating_mcp_resources() {
    let fixture = Fixture::new();
    let project = fixture.project("workspace:instructions", "project");
    let source = project.join("AGENTS.md");
    std::fs::write(&source, [0xff]).unwrap();
    let marker = fixture.root.join("mcp-started");
    let script = fixture.root.join("gated-mcp.py");
    let original_script = std::fs::read_to_string(&script).unwrap();
    std::fs::write(
        &script,
        format!(
            "open({}, 'w').write('started')\n{}",
            serde_json::to_string(marker.to_str().unwrap()).unwrap(),
            original_script
        ),
    )
    .unwrap();
    let mut request = Fixture::request("parent", true);
    request.workspace_binding_ids = vec!["workspace:instructions".into()];
    let runtime = fixture.runtime.clone();
    let gui = fixture.gui.clone();
    let preparing = std::thread::spawn(move || {
        runtime.prepare_run_runtime(&gui, Arc::new(UnusedReader), request)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut opened_mcp = false;
    while !preparing.is_finished() {
        match fixture.listener.accept() {
            Ok((mut gate, _)) => {
                opened_mcp = true;
                gate.write_all(b"Y").unwrap();
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("MCP gate accept: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "instruction preparation did not terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let error = preparing.join().unwrap().unwrap_err();
    assert_eq!(error.code, "project_instructions_read_failed");
    assert!(
        error.message.contains(source.to_str().unwrap()),
        "{}",
        error.message
    );
    assert!(error.message.contains("UTF-8"), "{}", error.message);
    assert!(
        !opened_mcp && !marker.exists(),
        "read failure created an external MCP process"
    );
    assert!(fixture.gui.try_lock().is_ok());
    assert!(fixture.runtime.runtime_transition.try_lock().is_ok());
    assert!(fixture.runtime.prepared_runs.lock().unwrap().is_empty());
    let run_gate = fixture
        .runtime
        .run_transition(&PreparedRunKey {
            session_id: "session:parent".into(),
            run_id: "run:parent".into(),
        })
        .unwrap();
    assert!(run_gate.try_lock().is_ok());
    std::fs::write(&source, "Fixed rules").unwrap();
    let mut retry = Fixture::request("parent", false);
    retry.workspace_binding_ids = vec!["workspace:instructions".into()];
    let prepared = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), retry)
        .unwrap();
    Fixture::release(&fixture.runtime, "parent", &prepared).unwrap();
}
