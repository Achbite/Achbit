//! Local display modules belong to the Host, independently of Agent/tool activation.
use crate::{host_connection_rejected, ApiResponse, AppState};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Component, Path},
    time::Duration,
};

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

#[derive(Clone, Deserialize)]
pub(crate) struct Source {
    path: String,
    enabled: bool,
}

#[derive(Deserialize)]
pub(crate) struct WatchRequest {
    sources: Vec<Source>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    id: String,
    name: String,
    entry: String,
    slots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adapter_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct PluginSource {
    path: String,
    enabled: bool,
    manifest: Option<Manifest>,
    source: Option<String>,
    error: Option<String>,
}

pub(crate) async fn watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WatchRequest>,
) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_connection_rejected();
    }
    if request.sources.len() > 32
        || request
            .sources
            .iter()
            .any(|source| source.path.trim().is_empty() || !Path::new(&source.path).is_absolute())
    {
        return (
            StatusCode::BAD_REQUEST,
            ApiResponse::error(
                "ui_plugin_sources_invalid",
                "Choose up to 32 UI plugin folders using absolute paths.",
            ),
        )
            .into_response();
    }
    // One connection owns the watch. Dropping the response stops all subsequent reads.
    // Compare actual source bytes; no build-version gate or secondary module cache.
    let stream = async_stream::stream! {
        let mut previous = None;
        loop {
            let sources = request.sources.clone();
            let current = match tokio::task::spawn_blocking(move || sources.iter().map(read_source).collect::<Vec<_>>()).await {
                Ok(current) => current,
                Err(error) => { yield Err::<String, std::io::Error>(std::io::Error::other(error)); break; }
            };
            if previous.as_ref() != Some(&current) {
                let line = serde_json::to_string(&current).expect("UI plugin sources serialize");
                yield Ok(format!("{line}\n"));
                previous = Some(current);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

fn read_source(source: &Source) -> PluginSource {
    let mut result = PluginSource {
        path: source.path.clone(),
        enabled: source.enabled,
        manifest: None,
        source: None,
        error: None,
    };
    if !source.enabled {
        return result;
    }
    match read_module(Path::new(&source.path)) {
        Ok((manifest, code)) => {
            result.manifest = Some(manifest);
            result.source = Some(code);
        }
        Err(error) => result.error = Some(error),
    }
    result
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

fn read_module(root: &Path) -> Result<(Manifest, String), String> {
    let manifest_path = root.join("achbit-ui.json");
    let manifest: Manifest = serde_json::from_str(&read_utf8(&manifest_path, 64 * 1024)?)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_changes_and_disabled_or_broken_plugins_are_independent() {
        let root = tempfile::tempdir().unwrap();
        let source = Source {
            path: root.path().to_string_lossy().into_owned(),
            enabled: true,
        };
        let disabled = read_source(&Source {
            path: root.path().join("missing").to_string_lossy().into_owned(),
            enabled: false,
        });
        assert!(disabled.error.is_none());
        assert!(disabled.source.is_none());
        std::fs::write(
            root.path().join("achbit-ui.json"),
            r#"{"id":"reading","name":"Reading","entry":"index.js","slots":["theme"]}"#,
        )
        .unwrap();
        std::fs::write(
            root.path().join("index.js"),
            "export default { apply(ctx) {} }",
        )
        .unwrap();
        let first = read_source(&source);
        assert!(first.error.is_none());
        std::fs::write(
            root.path().join("index.js"),
            "export default { apply(ctx) { ctx.addStyle('body {color:blue}'); } }",
        )
        .unwrap();
        let second = read_source(&source);
        assert_ne!(first, second);
        std::fs::remove_file(root.path().join("index.js")).unwrap();
        let missing = read_source(&source);
        assert!(missing.error.as_deref().unwrap().contains("index.js"));
        assert!(missing.source.is_none());
    }
}

#[derive(Deserialize)]
pub(crate) struct InspectRequest {
    path: String,
}

/// Reading a local manifest does not import code, enable a plugin or start a process.
pub(crate) async fn inspect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<InspectRequest>,
) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_connection_rejected();
    }
    match tokio::task::spawn_blocking(move || inspect_path(&request.path)).await {
        Ok(Ok(value)) => ApiResponse::ok(value).into_response(),
        Ok(Err(error)) => ApiResponse::error("plugin_inspect_failed", error).into_response(),
        Err(error) => {
            ApiResponse::error("plugin_inspect_failed", error.to_string()).into_response()
        }
    }
}
fn inspect_path(path: &str) -> Result<serde_json::Value, String> {
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
            json!({"kind":"service","path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description,"entry":manifest.entry,"debugOnly":manifest.debug_only}),
        );
    }
    if manifest_name == "achbit-ui.json" {
        let (manifest, _) = read_module(root)?;
        return Ok(
            json!({"kind":"ui","path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description.unwrap_or_else(||"自定阅读、正文或主题展示。".into()),"slots":manifest.slots}),
        );
    }
    if manifest_name == achbit_kernel_abi::TOOL_PLUGIN_MANIFEST {
        let artifact = achbit_kernel_abi::ToolPluginManifest::read(root)?;
        let manifest = artifact.manifest;
        return Ok(
            json!({"kind":"cli","path":root,"id":manifest.id,"name":manifest.name,"description":manifest.description,"command":manifest.command,"args":manifest.args,"entry":manifest.entry}),
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
    Ok(json!({"kind":"guidance","path":skill,"id":name,"name":name,"description":description}))
}

#[cfg(test)]
mod plugin_import_tests {
    #[test]
    fn service_manifest_inspection_never_runs_entry() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("entry.mjs"),
            "throw new Error('must not execute during import inspection')",
        )
        .unwrap();
        std::fs::write(root.path().join("achbit-service.json"), r#"{"schema":"achbit.service-plugin.v1","id":"sample","name":"Sample","description":"Import test","entry":"entry.mjs"}"#).unwrap();
        let value = super::inspect_path(root.path().to_str().unwrap()).unwrap();
        assert_eq!(value["kind"], "service");
        assert_eq!(value["id"], "sample");
        assert_eq!(value["entry"], "entry.mjs");
    }
    #[test]
    fn tool_import_and_runtime_discovery_share_artifact_validation() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join("entry.mjs");
        let path = root.path().join("achbit-tool.json");
        let valid = json!({"id":"contract-test","name":"Contract test","description":"Protocol test", "command":"node","entry":"entry.mjs","tools":[{"name":"inspect","description":"Read test input","inputSchema":{"type":"object"}}]});
        let write = |value: &serde_json::Value| {
            std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap()
        };
        std::fs::write(&entry, "throw new Error('inspection must not execute')").unwrap();
        write(&valid);
        assert_eq!(
            super::inspect_path(root.path().to_str().unwrap()).unwrap()["kind"],
            "cli"
        );
        assert_eq!(
            super::inspect_path(path.to_str().unwrap()).unwrap()["id"],
            "contract-test"
        );
        for invalid in [
            json!({"tools":[]}),
            json!({"entry":"nested/entry.mjs"}),
            json!({"id":"invalid/id"}),
            json!({"tools":[valid["tools"][0].clone(),valid["tools"][0].clone()]}),
            json!({"tools":[{"name":"inspect","description":"Protocol test","inputSchema":[]}]}),
        ] {
            let mut value = valid.clone();
            for (key, field) in invalid.as_object().unwrap() {
                value[key] = field.clone();
            }
            write(&value);
            let imported = super::inspect_path(root.path().to_str().unwrap()).unwrap_err();
            let discovered = achbit_kernel_abi::ToolPluginManifest::read(root.path())
                .err()
                .unwrap();
            assert_eq!(imported, discovered);
        }
        write(&valid);
        std::fs::remove_file(&entry).unwrap();
        assert!(super::inspect_path(path.to_str().unwrap()).is_err());
    }
}
