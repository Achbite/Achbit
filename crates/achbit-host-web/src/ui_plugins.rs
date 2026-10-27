//! Local display modules belong to the Host, independently of Agent/tool activation.
use crate::{host_connection_rejected, ApiResponse, AppState};
use achbit_host_connection::plugin_artifact::{
    inspect_plugin as inspect_path, read_ui_module as read_module, UiPluginManifest as Manifest,
};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[derive(Clone, Deserialize)]
pub(crate) struct Source {
    path: String,
    enabled: bool,
}

#[derive(Deserialize)]
pub(crate) struct WatchRequest {
    sources: Vec<Source>,
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
