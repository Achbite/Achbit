//! Host-owned artifact installation. Settings remain the only installed selection.
use crate::prelude::*;
use crate::{ApiResponse, AppState, ReadyState};
use achbit_host_connection::plugin_artifact::{copy_plugin, prepare_plugin};

mod marketplace;

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub(crate) enum InstallInput {
    Local(InstallRequest),
    Marketplace { marketplace: marketplace::Selection },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallRequest {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) replace_path: Option<String>,
}

pub(crate) async fn install(
    ReadyState(state): ReadyState,
    Json(input): Json<InstallInput>,
) -> Json<ApiResponse> {
    let (request, downloaded) = match input {
        InstallInput::Local(request) => (request, None),
        InstallInput::Marketplace { marketplace } => match marketplace::download(marketplace).await
        {
            Ok(package) => {
                let Some(path) = package.path.to_str() else {
                    return ApiResponse::error("plugin_install_failed", "Plugin path is not UTF-8");
                };
                (
                    InstallRequest {
                        path: path.into(),
                        replace_path: None,
                    },
                    Some(package),
                )
            }
            Err(error) => return ApiResponse::error("plugin_install_failed", error),
        },
    };
    match tokio::task::spawn_blocking(move || {
        let _transition = match state.local_agent.runtime_transition() {
            Ok(guard) => guard,
            Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
        };
        install_locked(&state, request, None, downloaded.as_ref())
    })
    .await
    {
        Ok(result) => result,
        Err(error) => ApiResponse::error("plugin_install_failed", error.to_string()),
    }
}

pub(crate) fn install_locked(
    state: &AppState,
    request: InstallRequest,
    registered_key: Option<&str>,
    downloaded: Option<&marketplace::Download>,
) -> Json<ApiResponse> {
    let (settings, data) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.user_settings.clone(),
            gui.paths.directories.data_dir.clone(),
        )
    };
    let result = (|| -> Result<_, String> {
        let prepared = prepare_plugin(&request.path)?;
        let candidate = &prepared.inspection;
        if let Some(package) = downloaded {
            package.verify_manifest(candidate)?;
        }
        let kind = candidate["kind"].as_str().ok_or("Plugin kind missing")?;
        let key = settings_key(kind)?;
        if registered_key.is_some_and(|registered| key != registered) {
            return Err("The update must have the same plugin kind and id".into());
        }
        let id = candidate["id"].as_str().ok_or("Plugin ID missing")?;
        let mut sources = source_list(&settings, key)?;
        let replacement = match &request.replace_path {
            Some(path) => {
                let index = sources
                    .iter()
                    .position(|source| source["path"].as_str() == Some(path.as_str()))
                    .ok_or("The plugin to update is no longer installed")?;
                if installed_plugin_id(kind, &sources[index])? != id {
                    return Err("The update must have the same plugin kind and id".into());
                }
                Some(index)
            }
            None => {
                if sources.iter().any(|source| {
                    installed_plugin_id(kind, source).is_ok_and(|installed| installed == id)
                }) {
                    return Err("Plugin is already installed; use Update".into());
                }
                None
            }
        };
        let packages = data.join("plugins/packages");
        fs::create_dir_all(&packages).map_err(|e| e.to_string())?;
        let directory = packages.join(installation_id()?);
        let skill_mount_id = if key == "skills.mounts" && replacement.is_none() {
            Some(installation_id()?)
        } else {
            None
        };
        // Skill discovery uses the artifact's leaf directory in its logical URI.
        // Keep that leaf across updates; only the enclosing installation changes.
        let source_path = FsPath::new(
            replacement
                .map(|index| sources[index]["path"].as_str().unwrap())
                .unwrap_or(candidate["path"].as_str().ok_or("Plugin path missing")?),
        );
        let source_root = if key == "skills.mounts" {
            source_path.parent().ok_or("Skill parent missing")?
        } else {
            source_path
        };
        let leaf = source_root
            .file_name()
            .ok_or("Plugin directory name missing")?;
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let installed = match copy_plugin(candidate, &directory.join(leaf)) {
            Ok(installed) => installed,
            Err(error) => {
                if let Err(cleanup) = fs::remove_dir_all(&directory) {
                    return Err(format!(
                        "{error}; incomplete installation cleanup: {cleanup}"
                    ));
                }
                return Err(error);
            }
        };
        let source = match replacement {
            Some(index) => {
                let mut source = sources[index].clone();
                source["path"] = installed["path"].clone();
                source
            }
            None => {
                let mut source = json!({"path":installed["path"],"enabled":true});
                if key != "workbench.uiPlugins" {
                    source["id"] = if key == "skills.mounts" {
                        json!(skill_mount_id.expect("new Skill mount ID prepared"))
                    } else {
                        installed["id"].clone()
                    };
                }
                source
            }
        };
        if let Some(index) = replacement {
            sources[index] = source;
        } else {
            sources.push(source);
        }
        Ok((key, directory, installed, sources))
    })();
    let (key, directory, installed, sources) = match result {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("plugin_install_failed", error),
    };
    // The existing settings owner stops replaced services before persisting the new
    // path, then activates the new instance with its unchanged state directory.
    let mut response = crate::settings_api::apply_user_settings_patch_locked(
        &state,
        json!({"patches":{(key):serde_json::to_string(&sources).expect("plugin sources serialize")}}),
    );
    if response.0.ok {
        if let Some(data) = response.0.data.as_mut() {
            let enabled = sources
                .iter()
                .find(|source| source["path"] == installed["path"])
                .is_some_and(|source| source["enabled"] == true);
            data["application"] = crate::plugin_management::application(state, &installed, enabled);
            data["plugin"] = installed;
        }
    } else if let Err(error) = fs::remove_dir_all(directory) {
        let original = response.0.message.take().unwrap_or_default();
        response.0.message = Some(format!("{original}; uninstalled artifact cleanup: {error}"));
    }
    response
}

fn installed_plugin_id(kind: &str, source: &Value) -> Result<String, String> {
    if matches!(kind, "cli" | "service") {
        return source["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Registered plugin ID missing".into());
    }
    let plugin = crate::plugin_management::inspect_registration(kind, source);
    if let Some(error) = plugin["error"].as_str() {
        // A failed Skill's displayed ID locates its mount, not its artifact.
        if kind == "guidance" || plugin["id"].is_null() {
            return Err(error.into());
        }
    }
    plugin["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Plugin ID missing".into())
}

fn settings_key(kind: &str) -> Result<&'static str, String> {
    match kind {
        "service" => Ok("plugins.services"),
        "cli" => Ok("plugins.sources"),
        "ui" => Ok("workbench.uiPlugins"),
        "guidance" => Ok("skills.mounts"),
        _ => Err("Unsupported plugin artifact".into()),
    }
}

pub(crate) fn source_list(settings: &Value, key: &str) -> Result<Vec<Value>, String> {
    let text = settings.get(key).map_or(Ok("[]"), |value| {
        value
            .as_str()
            .ok_or("Plugin sources must be a JSON array string")
    })?;
    let list: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if list
        .iter()
        .any(|source| source["path"].as_str().is_none() || source["enabled"].as_bool().is_none())
    {
        return Err(format!("Invalid plugin sources: {key}"));
    }
    Ok(list)
}

fn installation_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
