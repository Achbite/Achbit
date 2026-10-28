//! Shared GUI/CLI management over the existing installation, settings and runtime owners.
use crate::prelude::*;
use crate::{ApiResponse, AppState, ReadyState};
use achbit_host_connection::plugin_artifact::{inspect_plugin, prepare_plugin};

const SOURCES: &[(&str, &str)] = &[
    ("cli", "plugins.sources"),
    ("service", "plugins.services"),
    ("ui", "workbench.uiPlugins"),
    ("guidance", "skills.mounts"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectRequest {
    path: String,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ManageRequest {
    Enable { target: String },
    Disable { target: String },
    Remove { target: String },
    Update { target: String, path: String },
}

pub(crate) async fn inspect(
    ReadyState(_state): ReadyState,
    Json(request): Json<InspectRequest>,
) -> Json<ApiResponse> {
    match tokio::task::spawn_blocking(move || {
        prepare_plugin(&request.path).map(|prepared| prepared.inspection.clone())
    })
    .await
    {
        Ok(Ok(value)) => ApiResponse::ok(value),
        Ok(Err(error)) => ApiResponse::error("plugin_inspect_failed", error),
        Err(error) => ApiResponse::error("plugin_inspect_failed", error.to_string()),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UiRuntimeEntry {
    path: String,
    status: UiRuntimeStatus,
    error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum UiRuntimeStatus {
    Disabled,
    Loading,
    Active,
    Error,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UiRuntimeReport {
    client_id: String,
    plugins: Vec<UiRuntimeEntry>,
}

pub(crate) async fn report_ui(
    ReadyState(state): ReadyState,
    Json(report): Json<UiRuntimeReport>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let Some(entries) = gui.ui_plugin_clients.get_mut(&report.client_id) else {
        return ApiResponse::error(
            "plugin_client_disconnected",
            "The reporting window has no live settings connection.",
        );
    };
    *entries = Some(report.plugins);
    ApiResponse::ok(json!({"accepted":true}))
}

/// The stream, rather than a timestamp or polling loop, owns the client projection.
pub(crate) struct UiRuntimeLease {
    pub(crate) gui: Arc<Mutex<crate::state::GuiState>>,
    pub(crate) client_id: String,
}
impl Drop for UiRuntimeLease {
    fn drop(&mut self) {
        if let Ok(mut gui) = self.gui.lock() {
            gui.ui_plugin_clients.remove(&self.client_id);
        }
    }
}

/// Saved registration plus independently observed runtime state. UI execution belongs to its window.
pub(crate) fn application(state: &AppState, plugin: &Value, enabled: bool) -> Value {
    if plugin["kind"] == "ui" {
        let gui = state.gui.lock().expect("gui state lock");
        let clients: Vec<_> = gui.ui_plugin_clients.iter().map(|(client_id, entries)| {
            match entries.as_ref().and_then(|entries| entries.iter().find(|entry| plugin["path"] == entry.path)) {
                Some(entry) => json!({"clientId":client_id,"status":entry.status,"error":entry.error}),
                None => json!({"clientId":client_id,"status":if entries.is_some() && !enabled { "disabled" } else { "pending" },"error":null}),
            }
        }).collect();
        let failed = clients.iter().find(|client| client["status"] == "error");
        let status = if failed.is_some() {
            "failed"
        } else if !clients.is_empty() && clients.iter().all(|client| client["status"] == "active") {
            "active"
        } else if !clients.is_empty() && clients.iter().all(|client| client["status"] == "disabled")
        {
            "disabled"
        } else {
            "client-pending"
        };
        return json!({"status":status,"scope":"windowModule","error":failed.map(|client| client["error"].clone()),"clients":clients});
    }
    if !enabled {
        return json!({"status":"disabled","withdrawsAt":"nextRequest"});
    }
    match plugin["kind"].as_str() {
        Some("service") => {
            let gui = state.gui.lock().expect("gui state lock");
            match crate::service_plugins::sources(&gui.user_settings) {
                Ok(sources) => {
                    let snapshot = gui
                        .service_plugins
                        .snapshot(&sources, &gui.paths.directories.data_dir);
                    match snapshot["services"]
                        .as_array()
                        .and_then(|items| items.iter().find(|item| item["path"] == plugin["path"]))
                    {
                        Some(service) => {
                            json!({"status":service["status"],"error":service["error"],
                            "baseUrl":service["baseUrl"],"pageUrl":service["pageUrl"],"stateDirectory":service["stateDirectory"],
                            "logPath":gui.paths.directories.data_dir.join("service-plugins").join(plugin["id"].as_str().unwrap_or("")).join("runtime.log")})
                        }
                        None => json!({"status":"stopped"}),
                    }
                }
                Err(error) => json!({"status":"failed","error":error}),
            }
        }
        _ => json!({"status":"available","activatesAt":"nextRequest",
            "nextStep":"Discover with plugin.search and activate the returned URI in this run. Installed does not mean selected for the task."}),
    }
}

fn registrations(settings: &Value) -> Result<Vec<(String, Value)>, String> {
    let mut items = Vec::new();
    for (kind, key) in SOURCES {
        for source in crate::plugin_installation::source_list(settings, key)? {
            let path = source["path"].as_str().ok_or("Plugin path missing")?;
            let mut metadata = inspect_plugin(path).unwrap_or_else(|error| {
                json!({
                    "kind":kind,"id":source["id"],"path":path,"error":error
                })
            });
            metadata["enabled"] = source["enabled"].clone();
            items.push(((*key).into(), metadata));
        }
    }
    Ok(items)
}

pub(crate) fn inventory_owned(state: &AppState) -> Result<Value, String> {
    let settings = state
        .gui
        .lock()
        .expect("gui state lock")
        .user_settings
        .clone();
    let mut plugins = Vec::new();
    for (_, mut plugin) in registrations(&settings)? {
        plugin["application"] = if plugin.get("error").is_some() {
            json!({"status":"failed","error":plugin["error"]})
        } else {
            application(state, &plugin, plugin["enabled"] == true)
        };
        plugins.push(plugin);
    }
    Ok(json!({"plugins":plugins}))
}

pub(crate) async fn inventory(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    match tokio::task::spawn_blocking(move || {
        let _transition = state.local_agent.runtime_transition()?;
        inventory_owned(&state)
    })
    .await
    {
        Ok(Ok(value)) => ApiResponse::ok(value),
        Ok(Err(error)) => ApiResponse::error("plugin_inventory_failed", error),
        Err(error) => ApiResponse::error("plugin_inventory_failed", error.to_string()),
    }
}

pub(crate) async fn manage(
    ReadyState(state): ReadyState,
    Json(request): Json<ManageRequest>,
) -> Json<ApiResponse> {
    match tokio::task::spawn_blocking(move || manage_owned(&state, request)).await {
        Ok(result) => result,
        Err(error) => ApiResponse::error("plugin_management_failed", error.to_string()),
    }
}

fn manage_owned(state: &AppState, request: ManageRequest) -> Json<ApiResponse> {
    let _transition = match state.local_agent.runtime_transition() {
        Ok(guard) => guard,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let settings = state
        .gui
        .lock()
        .expect("gui state lock")
        .user_settings
        .clone();
    let target = match &request {
        ManageRequest::Enable { target }
        | ManageRequest::Disable { target }
        | ManageRequest::Remove { target }
        | ManageRequest::Update { target, .. } => target,
    };
    let entries = match registrations(&settings) {
        Ok(entries) => entries,
        Err(error) => return ApiResponse::error("plugin_inventory_failed", error),
    };
    let matches: Vec<_> = entries
        .into_iter()
        .filter(|(_, plugin)| {
            plugin["path"].as_str() == Some(target) || plugin["id"].as_str() == Some(target)
        })
        .collect();
    if matches.len() != 1 {
        return ApiResponse::error(
            "plugin_target_invalid",
            "Choose one installed plugin ID or exact path from plugins list.",
        );
    }
    let (key, mut plugin) = matches.into_iter().next().unwrap();
    let path = plugin["path"].as_str().expect("registered path").to_owned();
    if let ManageRequest::Update {
        path: candidate, ..
    } = request
    {
        return crate::plugin_installation::install_locked(
            state,
            crate::plugin_installation::InstallRequest {
                path: candidate,
                replace_path: Some(path),
            },
        );
    }
    let mut sources = match crate::plugin_installation::source_list(&settings, &key) {
        Ok(sources) => sources,
        Err(error) => return ApiResponse::error("plugin_inventory_failed", error),
    };
    let index = sources
        .iter()
        .position(|source| source["path"] == path)
        .expect("registered source");
    let removed = matches!(request, ManageRequest::Remove { .. });
    let enabled = matches!(request, ManageRequest::Enable { .. });
    if removed {
        sources.remove(index);
    } else {
        sources[index]["enabled"] = json!(enabled);
    }
    let mut response = crate::settings_api::apply_user_settings_patch_locked(
        state,
        json!({"patches":{(key):serde_json::to_string(&sources).expect("sources serialize")}}),
    );
    if response.0.ok {
        plugin["enabled"] = json!(enabled);
        if let Some(data) = response.0.data.as_mut() {
            data["plugin"] = plugin.clone();
            data["registration"] = if removed {
                json!({"status":"removed","dataPreserved":true})
            } else {
                json!({"status":"saved"})
            };
            data["application"] = application(state, &plugin, enabled);
        }
    }
    response
}

#[derive(Deserialize)]
pub(crate) struct DevelopmentQuery {
    resource: Option<String>,
}
pub(crate) async fn capabilities(
    ReadyState(_state): ReadyState,
    Query(query): Query<DevelopmentQuery>,
) -> Json<ApiResponse> {
    let mut document = json!({
        "kinds":[
            {"kind":"cli","manifest":"achbit-tool.json","lifetime":"one process per tool call","activation":"nextRequest, then plugin.activate"},
            {"kind":"service","manifest":"achbit-service.json","lifetime":"Host-owned process","activation":"enable starts; disable/update/remove stops"},
            {"kind":"ui","manifest":"achbit-ui.json","lifetime":"window-owned module and disposers","activation":"connected window applies the installed copy"},
            {"kind":"guidance","manifest":"SKILL.md","lifetime":"task guidance","activation":"nextRequest discovery; read through skill.read"}
        ],
        "uiSlots":achbit_host_connection::plugin_artifact::ui_plugin_slots(),
        "guides": {"plugins":include_str!("../../../docs/plugins/README.md"),"ui":include_str!("../../../docs/product/ui-plugins.md")},
        "templates": {
            "cli": {"achbit-tool.json":include_str!("../../../examples/plugins/cli-text/achbit-tool.json"),"main.py":include_str!("../../../examples/plugins/cli-text/main.py")},
            "ui": {"achbit-ui.json":include_str!("../../../examples/plugins/ui-theme/achbit-ui.json"),"index.js":include_str!("../../../examples/plugins/ui-theme/index.js")},
            "service": {"achbit-service.json":include_str!("../../../examples/plugins/local-service/achbit-service.json"),"entry.mjs":include_str!("../../../examples/plugins/local-service/entry.mjs")},
            "guidance": {"SKILL.md":"---\nname: example-guidance\ndescription: Explain when to use this guidance.\n---\n\n# Example guidance\n\nDescribe the supported workflow and link relative resources.\n"}
        }
    });
    if let Some(resource) = query.resource {
        if let Some(value) = document.pointer(&format!("/{resource}")) {
            return ApiResponse::ok(json!({"resource":resource,"content":value}));
        }
        return ApiResponse::error(
            "plugin_resource_unknown",
            "Use plugins capabilities to list development resources.",
        );
    }
    document["guides"] = json!(["plugins", "ui"]);
    document["templates"] = json!(["cli", "service", "ui", "guidance"]);
    ApiResponse::ok(document)
}
