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
        Self::with_resolver(|gui| {
            Arc::new(crate::local_agent_kernel::HostWorkspaceResolver::new(gui))
        })
    }

    fn with_resolver(
        make_resolver: impl FnOnce(Arc<Mutex<GuiState>>) -> Arc<dyn WorkspaceResolverPort>,
    ) -> Self {
        let root = std::env::temp_dir().join(
            crate::new_runtime_ref("prepare-gate-test")
                .unwrap()
                .replace(':', "-"),
        );
        let mut gui = GuiState::open_at(&root).unwrap();
        let mut profiles = crate::llm_profiles::fixture_profiles();
        profiles["connections"][0]["credentialRef"] = json!("local-secret:fixture-key");
        crate::model_connections::store(
            &mut gui,
            profiles,
            Some(json!({"fixture-key":"fixture-key"})),
        )
        .unwrap();
        let gui = Arc::new(Mutex::new(gui));
        let runtime = {
            let captured = gui.lock().unwrap();
            LocalAgentRuntime::open(
                &captured.paths.session_store_path,
                &crate::local_agent_store::SessionCatalogReader::open(
                    &captured.paths.session_store_path,
                )
                .unwrap(),
                &captured.paths.tool_record_store_path,
                make_resolver(gui.clone()),
                &captured.user_settings,
                Arc::from(random_service_token().unwrap()),
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
fn archive_deletion_preserves_failed_desktop_release_until_the_owning_run_retries() {
    use crate::desktop_tools::{DesktopExecutor, DesktopHost};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Stream(AtomicUsize);
    impl DesktopExecutor for Stream {
        fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
            assert_eq!(binding["sessionId"], "session:parent");
            match input["action"].as_str().unwrap() {
                "computer:observe" => Ok(json!({"ok":true,"data":{}})),
                "computer:releaseRun" if self.0.fetch_add(1, Ordering::SeqCst) == 0 => {
                    Ok(json!({"ok":false,"message":"original stop failure"}))
                }
                "computer:releaseRun" => Ok(json!({"ok":true,"data":{"released":true}})),
                _ => panic!("unexpected desktop request {input}"),
            }
        }
        fn stop(&self) -> Result<(), String> {
            Ok(())
        }
    }
    let mut fixture = Fixture::new();
    let stream = Arc::new(Stream(AtomicUsize::new(0)));
    let desktop = DesktopHost::for_test("host:delete", stream.clone());
    fixture.runtime.kernel.desktop = desktop.clone();
    let view = fixture.prepare("parent", false).unwrap();
    let child_view = fixture.prepare("child", false).unwrap();
    let context = serde_json::from_value(json!({"output_directory": fixture.root, "workspace_root":null, "workspace_id":null,
        "private_resolved_targets":[], "workspace_write_targets":null, "file_access":{"read":[],"write":[],"readOnly":[],"home":null}})).unwrap();
    desktop
        .run("session:parent", "run:parent")
        .execute(json!({"action":"observe"}), &context, "call:observe")
        .unwrap();
    let failure = Fixture::release(&fixture.runtime, "parent", &view).unwrap_err();
    assert_eq!(failure.code, "computer_sharing_cleanup_failed");
    assert_eq!(failure.message, "original stop failure");
    let history = || {
        serde_json::to_value(
            fixture
                .runtime
                .journal
                .read_events_publication("session:parent", 0)
                .unwrap(),
        )
        .unwrap()
    };
    let before = history();
    let denied = fixture
        .runtime
        .delete_session_archive("session:parent")
        .unwrap_err();
    assert_eq!(denied.code, "session_delete_active_run");
    assert_eq!(history(), before);
    assert_eq!(
        stream.0.load(Ordering::SeqCst),
        1,
        "deletion never retries native cleanup"
    );
    Fixture::release(&fixture.runtime, "parent", &view).unwrap();
    fixture
        .runtime
        .delete_session_archive("session:parent")
        .unwrap();
    assert_eq!(stream.0.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .runtime
            .journal
            .read_events_publication("session:parent", 0)
            .err()
            .unwrap()
            .code,
        "session_not_found"
    );
    Fixture::release(&fixture.runtime, "child", &child_view).unwrap();
}

#[test]
fn archive_deletion_refuses_unpublished_preparation_but_not_an_unrelated_session() {
    let fixture = Fixture::new();
    let pending = fixture.pending_prepare();
    let mut gate = fixture.gate(&pending); // tools/list is waiting outside the registry locks.
    let denied = fixture.runtime.delete_session_archive("session:parent");
    let unrelated = fixture.runtime.delete_session_archive("session:child");
    gate.write_all(b"Y").unwrap();
    let prepared = pending.join().unwrap().unwrap();
    Fixture::release(&fixture.runtime, "parent", &prepared).unwrap();
    assert_eq!(denied.unwrap_err().code, "session_delete_active_run");
    unrelated.unwrap();
    fixture
        .runtime
        .delete_session_archive("session:parent")
        .unwrap();
    assert_eq!(
        fixture.prepare("parent", false).unwrap_err().code,
        "session_not_found"
    );
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

#[cfg(unix)]
#[test]
fn cached_view_survives_a_removed_command_but_still_checks_model_admission() {
    let mut f = Fixture::new();
    // Exercise the Darwin path resolver on an owned Unix filesystem, without changing PATH.
    #[cfg(not(target_os = "macos"))]
    {
        f.runtime.command_read_roots =
            Some(achbit_kernel_runtime::shell_environment::unix_runtime_read_roots);
    }
    let bundle = f.root.join("bundle");
    std::fs::create_dir(&bundle).unwrap();
    std::fs::write(bundle.join("SKILL.md"), "---\nname: Manual\ndescription: Explicit selection only\ndisable-model-invocation: true\n---\nmanual notes").unwrap();
    f.gui.lock().unwrap().user_settings["skills.mounts"] =
        json!(json!([{"id":"fixture", "enabled":true, "path":bundle}]).to_string());
    let optional = f.root.join("optional-command");
    std::fs::write(&optional, "fixture").unwrap();
    f.prepare("parent", false).unwrap();
    let key = PreparedRunKey {
        session_id: "session:parent".into(),
        run_id: "run:parent".into(),
    };
    // Supply a captured command belonging only to this fixture. Do not touch system commands.
    f.runtime
        .prepared_runs
        .lock()
        .unwrap()
        .get_mut(&key)
        .unwrap()[0]
        .response["environment"]["commandPaths"] = json!({"optional":optional});
    let prepare_manual = |model| {
        let mut request = Fixture::request("parent", false);
        request.plugin_selections = serde_json::from_value(json!([{"selectionId":"sel:manual", "uri":"plugin://fixture-bundle-1@skill", "label":"Manual"}])).unwrap();
        request.model_activation = model;
        f.runtime
            .prepare_run_runtime(&f.gui, Arc::new(UnusedReader), request)
    };
    let manual = prepare_manual(false).unwrap();
    assert!(f.runtime.prepared_runs.lock().unwrap()[&key]
        .last()
        .unwrap()
        .executor_config
        .file_read_roots
        .contains(&optional.canonicalize().unwrap()));
    std::fs::remove_file(optional).unwrap();
    assert_eq!(prepare_manual(false).unwrap(), manual);
    assert_eq!(
        prepare_manual(true).unwrap_err().code,
        "plugin_user_selection_required"
    );
    let rebuild = f.prepare("parent", false).unwrap_err();
    assert_eq!(rebuild.code, "host_command_path_failed");
    assert!(rebuild.message.contains("optional"));
    assert_eq!(f.runtime.prepared_runs.lock().unwrap()[&key].len(), 2);
    Fixture::release(&f.runtime, "parent", &manual).unwrap();
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
fn user_system_prompt_is_frozen_across_plugin_refresh_and_scoped_to_top_level_runs() {
    let fixture = Fixture::new();
    let set = |text: &str| {
        fixture.gui.lock().unwrap().user_settings["agent.systemPrompt"] = json!(text);
    };
    let prepare = |run_id: &str| {
        let mut request = Fixture::request("parent", false);
        request.run_id = run_id.into();
        fixture
            .runtime
            .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
            .unwrap()
    };
    let release = |view: &Value| {
        fixture
            .runtime
            .release_run_runtime(ReleaseToolCatalogRequest::new(
                view["sessionId"].as_str().unwrap(),
                view["runId"].as_str().unwrap(),
                view["kernelCatalogSnapshotRef"].as_str().unwrap(),
            ))
            .unwrap();
    };
    let original = "  User preference\n保持原文。\n";
    set(original);
    let initial = prepare("run:parent");
    assert_eq!(initial["userSystemPrompt"], original);
    let child = fixture.prepare("child", false).unwrap();
    assert!(child.get("userSystemPrompt").is_none());
    release(&child);

    set("Updated for the next task.");
    let mut request = Fixture::request("parent", false);
    request.refresh_plugins = true;
    request.plugin_selections = serde_json::from_value(json!([{
        "selectionId":"selected:docs", "uri":"plugin://documents@builtin", "label":"Documents"
    }]))
    .unwrap();
    let refreshed = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
        .unwrap();
    assert_ne!(
        initial["kernelCatalogSnapshotRef"],
        refreshed["kernelCatalogSnapshotRef"]
    );
    assert_eq!(refreshed["userSystemPrompt"], original);
    release(&refreshed);

    let next = prepare("run:next");
    assert_eq!(next["userSystemPrompt"], "Updated for the next task.");
    release(&next);
    for (run_id, text) in [("run:cleared", ""), ("run:blank", "  \n")] {
        set(text);
        let cleared = prepare(run_id);
        assert!(cleared.get("userSystemPrompt").is_none());
        release(&cleared);
    }
}

#[test]
fn project_instructions_prepare_freezes_same_run_and_reads_the_next_run() {
    let fixture = Fixture::new();
    let project = fixture.project("workspace:instructions", "project");
    let second = fixture.project("workspace:docs", "other-source");
    let reference = fixture.project("workspace:reference", "attached-repo");
    let scratch = fixture.project("workspace:scratch", "session-files");
    {
        let mut gui = fixture.gui.lock().unwrap();
        let managed = gui.conversation_catalog.workspaces.last_mut().unwrap();
        managed.owner_session_id = Some("session:parent".into());
        managed.session_workdir = true;
    }
    let source = project.join("AGENTS.md");
    std::fs::write(&source, "Original project rules\n").unwrap();
    std::fs::write(second.join("Agents.md"), "Second configured source").unwrap();
    std::fs::write(reference.join("AGENTS.md"), "Reference material only").unwrap();
    std::fs::write(scratch.join("AGENTS.md"), "Private session files").unwrap();
    let mut request = Fixture::request("parent", false);
    request.workspace_binding_ids = Some(
        [
            "workspace:instructions",
            "workspace:docs",
            "workspace:scratch",
            "workspace:reference",
        ]
        .map(String::from)
        .to_vec(),
    );
    request.project_instruction_binding_ids = ["workspace:instructions", "workspace:docs"]
        .map(String::from)
        .to_vec();
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
    let texts: Vec<_> = original["projectInstructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule["text"].as_str().unwrap())
        .collect();
    assert!(texts.contains(&"Second configured source"));
    assert!(
        !texts.contains(&"Reference material only") && !texts.contains(&"Private session files")
    );
    assert_eq!(
        original["environment"]["primaryWorkspaceDirectory"],
        json!({"workspaceId":"workspace:instructions", "path":project})
    );
    assert_eq!(
        original["environment"]["sessionWorkdirId"],
        "workspace:scratch"
    );

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
    request.workspace_binding_ids = Some(vec!["workspace:instructions".into()]);
    request.project_instruction_binding_ids = vec!["workspace:instructions".into()];
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

    // With no configured source, the managed default remains a real cwd, not a
    // source of project rules. Neither an attachment nor the old cwd takes over.
    let mut unconfigured = Fixture::request("parent", false);
    unconfigured.run_id = "run:unconfigured".into();
    unconfigured.environment = Some(next["environment"].clone());
    unconfigured.workspace_binding_ids = Some(vec![
        "workspace:scratch".into(),
        "workspace:reference".into(),
    ]);
    let view = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), unconfigured)
        .unwrap();
    assert_eq!(
        view["environment"]["primaryWorkspaceDirectory"],
        json!({"workspaceId":"workspace:scratch", "path":scratch})
    );
    assert_eq!(view["projectInstructions"], json!([]));
    fixture
        .runtime
        .release_run_runtime(ReleaseToolCatalogRequest::new(
            "session:parent",
            "run:unconfigured",
            view["kernelCatalogSnapshotRef"].as_str().unwrap(),
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
    request.workspace_binding_ids = Some(vec!["workspace:instructions".into()]);
    request.project_instruction_binding_ids = vec!["workspace:instructions".into()];
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
    retry.workspace_binding_ids = Some(vec!["workspace:instructions".into()]);
    retry.project_instruction_binding_ids = vec!["workspace:instructions".into()];
    let prepared = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), retry)
        .unwrap();
    Fixture::release(&fixture.runtime, "parent", &prepared).unwrap();
}

#[test]
fn project_preparation_waits_only_on_its_own_run() {
    struct Gate {
        resolver: crate::local_agent_kernel::HostWorkspaceResolver,
        entered: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl WorkspaceResolverPort for Gate {
        fn resolve(
            &self,
            id: &str,
        ) -> Result<crate::local_agent_kernel::ResolvedWorkspace, LocalAgentKernelError> {
            self.entered.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            self.resolver.resolve(id)
        }
    }
    let (entered, started) = mpsc::channel();
    let (resume, paused) = mpsc::channel();
    let f = Fixture::with_resolver(|gui| {
        Arc::new(Gate {
            resolver: crate::local_agent_kernel::HostWorkspaceResolver::new(gui),
            entered,
            resume: Mutex::new(paused),
        })
    });
    let child = f.prepare("child", false).unwrap();
    let root = f.project("workspace:gate", "project");
    std::fs::create_dir_all(root.join(".agents/skills")).unwrap();
    std::fs::write(
        root.join(".agents/skills/one.md"),
        "---\nname: one\ndescription: A fixture\n---\n",
    )
    .unwrap();
    let mut request = Fixture::request("parent", false);
    request.workspace_binding_ids = Some(vec!["workspace:gate".into()]);
    request.plugin_selections = serde_json::from_value(
        json!([{"uri":"plugin://one@project","label":"One","selectionId":"select:one"}]),
    )
    .unwrap();
    std::thread::scope(|scope| {
        let preparing = scope.spawn(|| {
            f.runtime
                .prepare_run_runtime(&f.gui, Arc::new(UnusedReader), request)
        });
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        let (done, released) = mpsc::channel();
        let runtime = &f.runtime;
        scope.spawn(move || {
            done.send(Fixture::release(runtime, "child", &child))
                .unwrap();
        });
        let receipt = released.recv_timeout(Duration::from_secs(2));
        let gui_available = f.gui.try_lock().is_ok();
        resume.send(()).unwrap();
        receipt
            .expect("independent release blocked on project preparation")
            .unwrap();
        assert!(gui_available);
        Fixture::release(&f.runtime, "parent", &preparing.join().unwrap().unwrap()).unwrap();
    });
}

#[test]
fn project_skills_resolve_from_run_bindings_and_survive_a_refresh() {
    let fixture = Fixture::new();
    let project = fixture.project("workspace:skills", "skills-project");
    let skill = project.join(".agents/skills/iteration/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(
        &skill,
        "---\nname: iteration\ndescription: Iterate this product.\n---\n\n# Iteration\n",
    )
    .unwrap();
    let selection = |value: Value| -> crate::local_agent_plugins::PluginSelectionInput {
        serde_json::from_value(value).unwrap()
    };
    let mut request = Fixture::request("parent", false);
    request.workspace_binding_ids = Some(vec!["workspace:skills".into()]);
    request.plugin_selections = vec![selection(json!({
        "selectionId": "selection:project-skill",
        "uri": "plugin://iteration@project",
        "label": "iteration"
    }))];
    let prepared = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
        .unwrap();
    let entry = prepared["selectedPlugins"]["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["uri"] == "plugin://iteration@project")
        .expect("project Skill is prepared");
    let entry_path = entry["skillEntryPath"].as_str().unwrap().to_string();
    assert!(
        std::path::Path::new(&entry_path).ends_with(".agents/skills/iteration/SKILL.md"),
        "{entry_path}"
    );

    // Activation prepares again without workspace bindings; the run keeps its captured
    // directories, so the selected project Skill stays resolvable in the same run.
    let mut refresh = Fixture::request("parent", false);
    refresh.refresh_plugins = true;
    refresh.plugin_selections = vec![selection(json!({
        "selectionId": "selection:project-skill",
        "uri": "plugin://iteration@project",
        "label": "iteration"
    }))];
    let refreshed = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), refresh)
        .unwrap();
    assert_eq!(
        refreshed["selectedPlugins"]["plugins"][0]["skillEntryPath"],
        json!(entry_path)
    );
    let mut remove = Fixture::request("parent", false);
    remove.workspace_binding_ids = Some(vec![]);
    remove.refresh_plugins = true;
    remove.plugin_selections = vec![selection(
        json!({"selectionId":"select:old", "uri":"plugin://iteration@project", "label":"Iteration"}),
    )];
    let removed = fixture
        .runtime
        .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), remove)
        .unwrap();
    let first_id = prepared["kernelCatalogSnapshotRef"].as_str().unwrap();
    let last_id = removed["kernelCatalogSnapshotRef"].as_str().unwrap();
    assert_ne!(first_id, last_id);
    assert_eq!(removed["selectedPlugins"]["plugins"], json!([]));
    fixture
        .runtime
        .retire_tool_views(RetireToolViewsRequest {
            session_id: "session:parent".into(),
            run_id: "run:parent".into(),
            keep_kernel_catalog_snapshot_ref: last_id.into(),
        })
        .unwrap();
    let lookup = |id: Option<&str>| {
        let mut request = Fixture::request("parent", false);
        request.restore_environment = true;
        request.restore_tool_view_ref = id.map(str::to_owned);
        fixture
            .runtime
            .prepare_run_runtime(&fixture.gui, Arc::new(UnusedReader), request)
    };
    assert_eq!(lookup(None).unwrap(), prepared);
    assert_eq!(lookup(Some(last_id)).unwrap(), removed);
    assert_eq!(
        lookup(Some(first_id)).unwrap_err().code,
        "provider_runtime_unavailable"
    );
    assert_eq!(
        lookup(Some("catalog:missing")).unwrap_err().code,
        "provider_runtime_unavailable"
    );
    Fixture::release(&fixture.runtime, "parent", &refreshed).unwrap();
}
