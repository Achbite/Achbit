use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Component, Path};

pub const TOOL_PLUGIN_MANIFEST: &str = "achbit-tool.json";

#[derive(Debug, Deserialize)]
pub struct ToolPluginManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub entry: String,
    pub tools: Vec<ToolPluginDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPluginDefinition {
    pub name: String,
    pub description: String,
    #[serde(default = "default_input_schema")]
    pub input_schema: Value,
}

pub struct ToolPluginArtifact {
    pub manifest: ToolPluginManifest,
    pub implementation: Value,
    pub entry_bytes: Vec<u8>,
}

impl ToolPluginManifest {
    /// Import inspection and runtime discovery use the same artifact contract.
    /// Reading a descriptor never runs the plugin entry.
    pub fn read(root: &Path) -> Result<ToolPluginArtifact, String> {
        let path = root.join(TOOL_PLUGIN_MANIFEST);
        let encoded = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if encoded.len() > 64 * 1024 {
            return Err("Tool plugin manifest exceeds 64 KiB".into());
        }
        let implementation: Value = serde_json::from_slice(&encoded).map_err(|e| e.to_string())?;
        let manifest: Self = serde_json::from_slice(&encoded).map_err(|e| e.to_string())?;
        if !valid_name(&manifest.id)
            || manifest.name.trim().is_empty()
            || manifest.description.trim().is_empty()
            || manifest.command.trim().is_empty()
            || manifest.tools.is_empty()
        {
            return Err("Plugin requires valid id, name, description, command and tools".into());
        }
        let entry = Path::new(&manifest.entry);
        if entry.components().count() != 1
            || !matches!(entry.components().next(), Some(Component::Normal(_)))
        {
            return Err("CLI entry must be a single-file bundle in the plugin folder".into());
        }
        let mut names = BTreeSet::new();
        for tool in &manifest.tools {
            if !valid_name(&tool.name)
                || !names.insert(&tool.name)
                || !tool.input_schema.is_object()
                || tool.description.is_empty()
            {
                return Err(
                    "Tools require unique names, descriptions and object inputSchema".into(),
                );
            }
        }
        let entry_bytes = std::fs::read(root.join(entry)).map_err(|e| e.to_string())?;
        if entry_bytes.is_empty() || entry_bytes.len() > 4 * 1024 * 1024 {
            return Err("CLI entry must be nonempty and no larger than 4 MiB".into());
        }
        Ok(ToolPluginArtifact {
            manifest,
            implementation,
            entry_bytes,
        })
    }
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn default_input_schema() -> Value {
    json!({"type": "object"})
}
