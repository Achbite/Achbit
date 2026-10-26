//! Plugin artifact discovery and copying shared by Host installation and display consumers.
use serde::{Deserialize, Serialize};
use std::{io::Read, path::{Component, Path, PathBuf}};

const SLOTS: &[&str] = &[
    "workbench.layout",
    "navigation",
    "conversation.header",
    "activity.row",
    "activity.summary",
    "activity.detail",
    "composer.layout",
    "composer.model",
    "composer.attachments",
    "composer.actions",
    "task.panel",
    "artifact.panel",
    "reader.layout",
    "reader.toolbar",
    "reader.tree",
    "settings.navigation",
    "usage.widget",
    "message.plain",
    "message.markdown",
    "document.html",
    "document.markdown",
    "document.pdf",
    "theme",
    "settings.models.overview",
    "settings.connection.detail",
    "settings.usage.panel",
    "tool.result",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiPluginManifest {
    pub id: String,
    pub name: String,
    pub entry: String,
    pub slots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn read_utf8(path: &Path, limit: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() > limit {
        return Err(format!("{} exceeds {limit} bytes", path.display()));
    }
    String::from_utf8(bytes).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn read_ui_module(root: &Path) -> Result<(UiPluginManifest, String), String> {
    let manifest_path = root.join("achbit-ui.json");
    let manifest: UiPluginManifest = serde_json::from_str(&read_utf8(&manifest_path, 64 * 1024)?)
        .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
    if manifest.id.trim().is_empty()
        || manifest.name.trim().is_empty()
        || (manifest.slots.iter().any(|s| s == "tool.result")
            && manifest.tool_id.as_deref().is_none_or(str::is_empty))
        || manifest
            .capabilities
            .iter()
            .any(|c| !matches!(c.as_str(), "usage.read" | "quota.read" | "connection.auth"))
        || (manifest.capabilities.iter().any(|c| c == "connection.auth")
            && !manifest
                .slots
                .iter()
                .any(|s| s == "settings.connection.detail"))
        || manifest.slots.is_empty()
        || manifest
            .slots
            .iter()
            .any(|slot| !SLOTS.contains(&slot.as_str()))
        || manifest
            .slots
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != manifest.slots.len()
    {
        return Err(format!(
            "{}: id, name and unique supported slots are required",
            manifest_path.display()
        ));
    }
    let entry = Path::new(&manifest.entry);
    if manifest.entry.trim().is_empty()
        || entry
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "{}: entry must be a relative file inside the plugin folder",
            manifest_path.display()
        ));
    }
    let code = read_utf8(&root.join(entry), 4 * 1024 * 1024)?;
    if code.trim().is_empty() {
        return Err(format!("{}: module is empty", root.join(entry).display()));
    }
    Ok((manifest, code))
}

pub fn inspect_plugin(path: &str) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let chosen = std::fs::canonicalize(path).map_err(|error| format!("{path}: {error}"))?;
    let root = if chosen.is_dir() {
        chosen.as_path()
    } else {
        chosen.parent().ok_or("Plugin parent missing")?
    };
    let manifest_name = if chosen.is_file() {
        chosen
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("插件文件名无法读取")?
    } else {
        let manifests = [
            "achbit-ui.json",
            "achbit-tool.json",
            "achbit-service.json",
            "SKILL.md",
        ]
        .into_iter()
        .filter(|name| root.join(name).is_file())
        .collect::<Vec<_>>();
        match manifests.as_slice() {
            [name] => *name,
            [] => return Err(format!("{}：没有找到插件清单", root.display())),
            _ => return Err("文件夹中有多份插件清单，请直接选择需要添加的清单文件。".into()),
        }
    };
    if manifest_name == achbit_kernel_abi::SERVICE_PLUGIN_MANIFEST {
        let (manifest, _) = achbit_kernel_abi::ServicePluginManifest::read(root)?;
        return Ok(
            json!({"kind":"service","manifestPath":root.join(manifest_name),"path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description,"entry":manifest.entry,"debugOnly":manifest.debug_only}),
        );
    }
    if manifest_name == "achbit-ui.json" {
        let (manifest, _) = read_ui_module(root)?;
        return Ok(
            json!({"kind":"ui","manifestPath":root.join(manifest_name),"path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description.unwrap_or_else(||"自定阅读、正文或主题展示。".into()),"slots":manifest.slots}),
        );
    }
    if manifest_name == achbit_kernel_abi::TOOL_PLUGIN_MANIFEST {
        let artifact = achbit_kernel_abi::ToolPluginManifest::read(root)?;
        let manifest = artifact.manifest;
        return Ok(
            json!({"kind":"cli","manifestPath":root.join(manifest_name),"path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description,"command":manifest.command,"args":manifest.args,"entry":manifest.entry}),
        );
    }
    if manifest_name != "SKILL.md" {
        return Err(
            "请选择 achbit-ui.json、achbit-tool.json、achbit-service.json 或 SKILL.md。".into(),
        );
    }
    let skill = if chosen.is_file() {
        chosen.clone()
    } else {
        root.join("SKILL.md")
    };
    let instructions = read_utf8(&skill, 512 * 1024)?;
    let field = |key: &str| {
        instructions
            .lines()
            .find_map(|line| line.trim().strip_prefix(&format!("{key}:")))
            .map(|line| line.trim().trim_matches(['\'', '"']).to_string())
    };
    let name = field("name")
        .or_else(|| {
            instructions
                .lines()
                .find_map(|line| line.strip_prefix("# ").map(str::to_owned))
        })
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let description = field("description").unwrap_or_else(|| "提供任务方法与指导资料。".into());
    Ok(json!({"kind":"guidance","manifestPath":skill,"path":skill,"id":name,"name":name,"description":description}))
}


/// Copy declared resources into a new Host-owned directory, without running install scripts.
/// Authors keep runtime state outside the distributable artifact.
pub fn copy_plugin(inspection: &serde_json::Value, destination: &Path) -> Result<serde_json::Value, String> {
    let manifest = Path::new(inspection["manifestPath"].as_str().ok_or("Plugin manifest path missing")?);
    let root = manifest.parent().ok_or("Plugin root missing")?.canonicalize().map_err(|e| e.to_string())?;
    let name = manifest.file_name().ok_or("Plugin manifest name missing")?;
    let parent = destination.parent().ok_or("Installation parent missing")?
        .canonicalize().map_err(|e| e.to_string())?;
    if parent.starts_with(&root) {
        return Err("Installation destination must be outside the source artifact".into());
    }
    std::fs::create_dir(destination).map_err(|e| format!("{}: {e}", destination.display()))?;
    let result = (|| {
        let files = if name == "SKILL.md" { None } else {
            let value: serde_json::Value = serde_json::from_str(&read_utf8(manifest, 64 * 1024)?).map_err(|e| e.to_string())?;
            value.get("files").map(|files| {
                let names: Vec<String> = serde_json::from_value(files.clone()).map_err(|e| format!("Invalid plugin files: {e}"))?;
                if names.is_empty() { return Err("Plugin files must not be empty".to_string()); }
                names.into_iter().map(|name| {
                    let path = PathBuf::from(name);
                    if path.as_os_str().is_empty() || path.components().any(|part| !matches!(part, Component::Normal(_))) {
                        return Err("Plugin files must be relative paths inside the artifact".into());
                    }
                    Ok(path)
                }).collect::<Result<Vec<_>, String>>()
            }).transpose()?
        };
        let entries = match files {
            Some(mut files) => { files.push(PathBuf::from(name)); files },
            None => std::fs::read_dir(&root).map_err(|e| e.to_string())?
                .map(|item| item.map(|item| PathBuf::from(item.file_name())).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?,
        };
        for entry in entries {
            copy_entry(&root, &root.join(&entry), &destination.join(entry), &mut Vec::new())?;
        }
        inspect_plugin(destination.join(name).to_str().ok_or("Installed path is not UTF-8")?)
    })();
    if result.is_err() {
        if let Err(cleanup) = std::fs::remove_dir_all(destination) {
            return Err(format!("{}; incomplete artifact cleanup: {cleanup}", result.unwrap_err()));
        }
    }
    result
}

fn copy_entry(root: &Path, source: &Path, destination: &Path, ancestors: &mut Vec<PathBuf>) -> Result<(), String> {
    let resolved = source.canonicalize().map_err(|e| format!("{}: {e}", source.display()))?;
    if !resolved.starts_with(root) { return Err(format!("Plugin resource leaves its artifact: {}", source.display())); }
    let metadata = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        if let Some(parent) = destination.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        std::fs::copy(resolved, destination).map_err(|e| format!("{}: {e}", destination.display()))?;
    } else if metadata.is_dir() {
        if ancestors.contains(&resolved) { return Err(format!("Plugin resource cycle: {}", source.display())); }
        ancestors.push(resolved.clone());
        std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        for item in std::fs::read_dir(&resolved).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            copy_entry(root, &item.path(), &destination.join(item.file_name()), ancestors)?;
        }
        ancestors.pop();
    } else {
        return Err(format!("Plugin resource is not a regular file or directory: {}", source.display()));
    }
    Ok(())
}

#[cfg(test)]
mod installation_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("achbit-artifact-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn source(&self) -> PathBuf {
            let root = self.0.join("download");
            std::fs::create_dir_all(root.join("public")).unwrap();
            std::fs::write(root.join("entry.mjs"), "export const version = 1;").unwrap();
            std::fs::write(root.join("public/index.html"), "plugin page").unwrap();
            std::fs::write(root.join("auth.json"), "private account fixture").unwrap();
            std::fs::write(root.join("achbit-service.json"), json!({
                "schema":"achbit.service-plugin.v1", "id":"fixture", "name":"Fixture", "description":"Installation fixture",
                "entry":"entry.mjs", "files":["entry.mjs", "public"]
            }).to_string()).unwrap();
            root
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn installation_and_update_keep_resources_without_source_or_account_dependency() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let state = fixture.0.join("service-state");
        std::fs::create_dir(&state).unwrap();
        std::fs::write(state.join("auth.json"), "saved login").unwrap();
        let inspected = inspect_plugin(source.to_str().unwrap()).unwrap();
        let first = copy_plugin(&inspected, &fixture.0.join("first")).unwrap();
        std::fs::write(source.join("entry.mjs"), "export const version = 2;").unwrap();
        let second = copy_plugin(&inspect_plugin(source.to_str().unwrap()).unwrap(), &fixture.0.join("second")).unwrap();
        std::fs::remove_dir_all(&source).unwrap();
        assert_eq!(first["id"], second["id"]);
        for installed in [&first, &second] {
            let root = Path::new(installed["path"].as_str().unwrap());
            assert_eq!(std::fs::read_to_string(root.join("public/index.html")).unwrap(), "plugin page");
            assert!(!root.join("auth.json").exists());
            assert!(inspect_plugin(installed["manifestPath"].as_str().unwrap()).is_ok());
        }
        assert!(std::fs::read_to_string(fixture.0.join("first/entry.mjs")).unwrap().contains("version = 1"));
        assert!(std::fs::read_to_string(fixture.0.join("second/entry.mjs")).unwrap().contains("version = 2"));
        assert_eq!(std::fs::read_to_string(state.join("auth.json")).unwrap(), "saved login");
    }

    #[test]
    fn incomplete_installation_preserves_source_and_cannot_copy_into_itself() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let inspected = inspect_plugin(source.to_str().unwrap()).unwrap();
        assert!(copy_plugin(&inspected, &source.join("nested-install")).is_err());
        assert!(!source.join("nested-install").exists());
        std::fs::remove_file(source.join("entry.mjs")).unwrap();
        let destination = fixture.0.join("incomplete");
        assert!(copy_plugin(&inspected, &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(std::fs::read_to_string(source.join("auth.json")).unwrap(), "private account fixture");
    }
}
