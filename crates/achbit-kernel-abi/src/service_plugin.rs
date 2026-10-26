use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const SERVICE_PLUGIN_PROTOCOL: &str = "achbit.service-plugin.v1";
pub const SERVICE_PLUGIN_MANIFEST: &str = "achbit-service.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServicePluginManifest {
    pub schema: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub debug_only: bool,
}

impl ServicePluginManifest {
    /// Inspection and activation share the same manifest and entry contract.
    pub fn read(root: &Path) -> Result<(Self, PathBuf), String> {
        let path = root.join(SERVICE_PLUGIN_MANIFEST);
        let metadata = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if metadata.len() > 64 * 1024 {
            return Err("Service plugin manifest exceeds 64 KiB".into());
        }
        let value: Self = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if value.schema != SERVICE_PLUGIN_PROTOCOL
            || !valid_service_plugin_id(&value.id)
            || value.name.trim().is_empty()
            || value.description.trim().is_empty()
        {
            return Err("Invalid service plugin schema, id, name or description".into());
        }
        let relative = Path::new(&value.entry);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("Service plugin entry must be a relative file inside its folder".into());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let entry = root
            .join(relative)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !entry.starts_with(&root) || !entry.is_file() {
            return Err("Service plugin entry must be a file inside its folder".into());
        }
        Ok((value, entry))
    }
}

pub fn valid_service_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
