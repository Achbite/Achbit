//! Archive a file or register a live target. User delivery is a separate Session decision.
use achbit_kernel_runtime::executors::KernelToolExecutionContext;
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn schema(field: &str) -> Value {
    json!({"type":"object","additionalProperties":false,"required":[field],
        "properties":{field:{"type":"string","minLength":1}}})
}

pub(crate) fn targets(tool: &str, input: &Value) -> Result<Vec<String>, String> {
    let object = input.as_object().ok_or("Expected an object")?;
    if object.keys().any(|key| {
        key != if tool == "artifact.prepare" {
            "path"
        } else {
            "url"
        }
    }) {
        return Err("Only path or url is accepted".into());
    }
    match (object.get("path"), object.get("url")) {
        (Some(Value::String(path)), None) if !path.trim().is_empty() => Ok(vec![path.clone()]),
        (None, Some(Value::String(url))) => {
            let url = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("A valid HTTP(S) URL is required".into());
            }
            Ok(vec![])
        }
        _ => Err("Specify exactly one nonempty path or url".into()),
    }
}

pub(crate) fn prepare(
    invocation_id: &str,
    input: &Value,
    context: &KernelToolExecutionContext,
) -> Result<Value, String> {
    let artifact_id = format!("artifact:{invocation_id}");
    let now: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
    if let Some(url) = input["url"].as_str() {
        let canonical = reqwest::Url::parse(url)
            .map_err(|error| error.to_string())?
            .to_string();
        return Ok(
            json!({"artifacts":[{"artifactId":artifact_id,"label":canonical,"uri":canonical,
            "resourceKey":format!("url:{canonical}"),"contentType":"text/html","contentMode":"live"}],"referenceRegisteredAt":now.to_rfc3339(),"contentVerified":false}),
        );
    }
    let path = input["path"].as_str().ok_or("Missing path")?;
    let workspace = context
        .workspace_id
        .as_deref()
        .ok_or("Workspace binding is required")?;
    let [target] = context.private_resolved_targets.as_slice() else {
        return Err("Expected one prepared file target".into());
    };
    let target = Path::new(target);
    let canonical = std::fs::canonicalize(target).map_err(|error| error.to_string())?;
    let root = context
        .workspace_root
        .as_ref()
        .ok_or("Missing prepared workspace root")?;
    let canonical_root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let logical = canonical
        .strip_prefix(canonical_root)
        .map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Only files can be archived".into());
    }
    let directory = context
        .output_directory
        .as_ref()
        .ok_or("Artifact archive is unavailable")?;
    let filename = target.file_name().ok_or("Missing filename")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let archived = directory.join(filename);
    std::fs::copy(target, &archived).map_err(|error| error.to_string())?;
    let modified: chrono::DateTime<chrono::Utc> = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .into();
    let content_type = match target
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        "md" => "text/markdown",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        _ => "application/octet-stream",
    };
    Ok(
        json!({"artifacts":[{"artifactId":artifact_id,"label":filename.to_string_lossy(),
        "workspaceId":workspace,"logicalPath":path,"resourceKey":serde_json::to_string(&(workspace,logical)).map_err(|error|error.to_string())?,
        "uri":format!("artifact://{artifact_id}"),"contentRef":archived,"contentType":content_type,"contentMode":"fixed",
        "modifiedAt":modified.to_rfc3339()}]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_versions_archive_bytes_and_preserve_logical_identity() {
        let root =
            std::env::temp_dir().join(crate::utils::new_runtime_ref("artifact-resource").unwrap());
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("report.md");
        std::fs::write(&source, "first version").unwrap();
        let context = |name: &str| KernelToolExecutionContext {
            output_directory: Some(root.join(name)),
            workspace_root: Some(root.display().to_string()),
            workspace_id: Some("workspace:report".into()),
            private_resolved_targets: vec![source.display().to_string()],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: Default::default(),
            progress: Default::default(),
        };
        let first = prepare("one", &json!({"path":"report.md"}), &context("one")).unwrap();
        std::fs::write(&source, "second version").unwrap();
        let second = prepare("two", &json!({"path":"./report.md"}), &context("two")).unwrap();
        assert_ne!(
            first["artifacts"][0]["artifactId"],
            second["artifacts"][0]["artifactId"]
        );
        assert_eq!(
            first["artifacts"][0]["resourceKey"],
            second["artifacts"][0]["resourceKey"]
        );
        assert_eq!(
            std::fs::read_to_string(first["artifacts"][0]["contentRef"].as_str().unwrap()).unwrap(),
            "first version"
        );
        assert_eq!(
            std::fs::read_to_string(second["artifacts"][0]["contentRef"].as_str().unwrap())
                .unwrap(),
            "second version"
        );
        assert!(first.get("modelImages").is_none());
        assert!(targets("artifact.prepare", &json!({"url":"https://example.com"})).is_err());
        assert!(targets("artifact.preview", &json!({"path":"report.md"})).is_err());
        let preview = prepare(
            "live",
            &json!({"url":"https://example.com/demo"}),
            &context("unused"),
        )
        .unwrap();
        assert_eq!(preview["contentVerified"], false);
        assert_eq!(preview["artifacts"][0]["contentMode"], "live");
        assert!(
            preview["artifacts"][0].get("modifiedAt").is_none(),
            "registration cannot invent the website modification time"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
