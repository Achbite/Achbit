//! Host-owned artifact installation. Settings remain the only installed selection.
use crate::prelude::*;
use crate::{ApiResponse, AppState, ReadyState};
use achbit_host_connection::plugin_artifact::{copy_plugin, inspect_plugin, prepare_plugin};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallRequest {
    path: String,
    #[serde(default)]
    replace_path: Option<String>,
}

pub(crate) async fn install(ReadyState(state): ReadyState, Json(request): Json<InstallRequest>) -> Json<ApiResponse> {
    match tokio::task::spawn_blocking(move || install_owned(state, request)).await {
        Ok(result) => result,
        Err(error) => ApiResponse::error("plugin_install_failed", error.to_string()),
    }
}

fn install_owned(state: AppState, request: InstallRequest) -> Json<ApiResponse> {
    let _transition = match state.local_agent.runtime_transition() {
        Ok(guard) => guard,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let (settings, data) = {
        let gui = state.gui.lock().expect("gui state lock");
        (gui.user_settings.clone(), gui.paths.directories.data_dir.clone())
    };
    let result = (|| -> Result<_, String> {
        let prepared = prepare_plugin(&request.path)?;
        let candidate = &prepared.inspection;
        let key = settings_key(candidate)?;
        let mut sources = source_list(&settings, key)?;
        let replacement = match &request.replace_path {
            Some(path) => {
                let index = sources.iter().position(|source| source["path"].as_str() == Some(path.as_str()))
                    .ok_or("The plugin to update is no longer installed")?;
                let installed = inspect_plugin(path)?;
                if candidate["kind"] != installed["kind"] || candidate["id"] != installed["id"] {
                    return Err("The update must have the same plugin kind and id".into());
                }
                Some(index)
            }
            None => {
                for source in &sources {
                    let same_id = matches!(key, "plugins.services" | "plugins.sources") && source["id"] == candidate["id"];
                    let same_artifact = source["path"].as_str().and_then(|path| inspect_plugin(path).ok())
                        .is_some_and(|installed| installed["kind"] == candidate["kind"] && installed["id"] == candidate["id"]);
                    if same_id || same_artifact { return Err("Plugin is already installed; use Update".into()); }
                }
                None
            }
        };
        let packages = data.join("plugins/packages");
        fs::create_dir_all(&packages).map_err(|e| e.to_string())?;
        let directory = packages.join(installation_id()?);
        let skill_mount_id = if key == "skills.mounts" && replacement.is_none() { Some(installation_id()?) } else { None };
        // Skill discovery uses the artifact's leaf directory in its logical URI.
        // Keep that leaf across updates; only the enclosing installation changes.
        let source_path = FsPath::new(replacement.map(|index| sources[index]["path"].as_str().unwrap())
            .unwrap_or(candidate["path"].as_str().ok_or("Plugin path missing")?));
        let source_root = if key == "skills.mounts" { source_path.parent().ok_or("Skill parent missing")? } else { source_path };
        let leaf = source_root.file_name().ok_or("Plugin directory name missing")?;
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let installed = match copy_plugin(candidate, &directory.join(leaf)) {
            Ok(installed) => installed,
            Err(error) => {
                if let Err(cleanup) = fs::remove_dir_all(&directory) {
                    return Err(format!("{error}; incomplete installation cleanup: {cleanup}"));
                }
                return Err(error);
            }
        };
        let source = match replacement {
            Some(index) => { let mut source = sources[index].clone(); source["path"] = installed["path"].clone(); source },
            None => {
                let mut source = json!({"path":installed["path"],"enabled":true});
                if key != "workbench.uiPlugins" {
                    source["id"] = if key == "skills.mounts" { json!(skill_mount_id.expect("new Skill mount ID prepared")) } else { installed["id"].clone() };
                }
                source
            }
        };
        if let Some(index) = replacement { sources[index] = source; } else { sources.push(source); }
        Ok((key, directory, installed, sources))
    })();
    let (key, directory, installed, sources) = match result {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("plugin_install_failed", error),
    };
    // The existing settings owner stops replaced services before persisting the new
    // path, then activates the new instance with its unchanged state directory.
    let mut response = crate::settings_api::apply_user_settings_patch_locked(&state,
        json!({"patches":{(key):serde_json::to_string(&sources).expect("plugin sources serialize")}}));
    if response.0.ok {
        if let Some(data) = response.0.data.as_mut() { data["plugin"] = installed; }
    } else if let Err(error) = fs::remove_dir_all(directory) {
        let original = response.0.message.take().unwrap_or_default();
        response.0.message = Some(format!("{original}; uninstalled artifact cleanup: {error}"));
    }
    response
}

fn settings_key(candidate: &Value) -> Result<&'static str, String> {
    match candidate["kind"].as_str() {
        Some("service") => Ok("plugins.services"), Some("cli") => Ok("plugins.sources"),
        Some("ui") => Ok("workbench.uiPlugins"), Some("guidance") => Ok("skills.mounts"),
        _ => Err("Unsupported plugin artifact".into()),
    }
}

fn source_list(settings: &Value, key: &str) -> Result<Vec<Value>, String> {
    let text = settings.get(key).map_or(Ok("[]"), |value| value.as_str().ok_or("Plugin sources must be a JSON array string"))?;
    let list: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if list.iter().any(|source| source["path"].as_str().is_none() || source["enabled"].as_bool().is_none()) {
        return Err(format!("Invalid plugin sources: {key}"));
    }
    Ok(list)
}

fn installation_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

