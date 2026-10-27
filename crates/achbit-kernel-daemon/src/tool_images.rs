//! Turn explicit tool image content into Kernel-owned artifacts before journaling.
use achbit_kernel_runtime::executors::{
    KernelToolExecutionContext, KernelToolExecutionFailure, KernelToolExecutionOutcome,
    KernelToolExecutionResult,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Component};

pub(crate) fn archive_result_images(
    mut result: KernelToolExecutionResult,
    context: &KernelToolExecutionContext,
) -> KernelToolExecutionResult {
    if let Err(message) = archive_content_images(&mut result.output, &result.invocation_id, context)
    {
        remove_unarchived_pixels(&mut result.output);
        result.output["executionOutcome"] = json!(result.outcome);
        result.output["imageArchiveError"] =
            json!({"code":"tool_image_archive_failed","message":message});
        if let Some(original) = &result.error {
            result.output["executionError"] = json!(original);
        }
        result.outcome = KernelToolExecutionOutcome::Failed;
        result.error = Some(KernelToolExecutionFailure {
            code: "tool_image_archive_failed".into(),
            message,
        });
    }
    result
}

/// A failed archive must preserve the external execution result without
/// journaling inline pixels or references whose metadata was never committed.
fn remove_unarchived_pixels(output: &mut Value) {
    let archived: std::collections::HashSet<String> = output["artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|artifact| artifact["artifactId"].as_str().map(str::to_string))
        .collect();
    if let Some(content) = output["content"].as_array_mut() {
        for block in content {
            if block["type"] == "image"
                || block["type"] == "imageReference"
                    && !block["artifactId"]
                        .as_str()
                        .is_some_and(|id| archived.contains(id))
            {
                if let Some(object) = block.as_object_mut() {
                    object.remove("data");
                    object.remove("path");
                    object.remove("artifactId");
                    object.insert("type".into(), json!("imageUnavailable"));
                    object.insert("reason".into(), json!("tool_image_archive_failed"));
                }
            }
        }
    }
}

pub(crate) fn archive_content_images(
    output: &mut Value,
    invocation_id: &str,
    context: &KernelToolExecutionContext,
) -> Result<(), String> {
    let Some(content) = output.get_mut("content").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let mut artifacts = Vec::new();
    let mut model_images = Vec::new();
    for (index, block) in content.iter_mut().enumerate() {
        if block["type"] != "image" {
            continue;
        }
        let directory = context
            .output_directory
            .as_ref()
            .ok_or("Image archive unavailable")?;
        let media = block["mimeType"]
            .as_str()
            .ok_or("Tool image mimeType is required")?;
        let extension = match media {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err(format!("Unsupported tool image format: {media}")),
        };
        let purpose = match block.pointer("/_meta/achbit/purpose") {
            None => None,
            Some(value) if value == "observation" => Some("observation"),
            Some(_) => return Err("Tool image purpose must be observation when specified".into()),
        };
        let bytes = match (block.get("data"), block.get("path")) {
            (Some(Value::String(data)), None) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|error| format!("Invalid tool image base64: {error}"))?;
                let actual = crate::conversation_api::image_media_type(&bytes)?;
                if actual != media {
                    return Err("Tool image content does not match mimeType".into());
                }
                bytes
            }
            (None, Some(Value::String(path))) => {
                let relative = std::path::Path::new(path);
                if path.is_empty()
                    || !relative
                        .components()
                        .all(|part| matches!(part, Component::Normal(_)))
                {
                    return Err(
                        "CLI image path must be relative to this invocation's outputDirectory"
                            .into(),
                    );
                }
                let root = fs::canonicalize(directory).map_err(|error| error.to_string())?;
                let path =
                    fs::canonicalize(root.join(relative)).map_err(|error| error.to_string())?;
                if !path.starts_with(&root) {
                    return Err(
                        "CLI image path is outside this invocation's outputDirectory".into(),
                    );
                }
                let (actual, bytes) = crate::conversation_api::read_image_resource(&path)?;
                if actual != media {
                    return Err("CLI image content does not match mimeType".into());
                }
                bytes
            }
            _ => return Err("Tool image requires exactly one base64 data or CLI file path".into()),
        };
        let archive = directory.join("images");
        fs::create_dir_all(&archive).map_err(|error| error.to_string())?;
        let path = archive.join(format!("image-{index}.{extension}"));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|error| error.to_string())?;
        let id = format!("artifact:{invocation_id}:image:{index}");
        let label = format!("Image {}.{extension}", index + 1);
        artifacts.push(
            json!({"artifactId":id,"label":label,"uri":format!("artifact://{id}"),
            "contentRef":path,"contentType":media,"contentMode":"fixed"}),
        );
        let for_model = block
            .pointer("/annotations/audience")
            .and_then(Value::as_array)
            .is_none_or(|audience| audience.iter().any(|role| role == "assistant"));
        if for_model {
            let mut image = json!({"artifactId":id});
            if let Some(purpose) = purpose {
                image["purpose"] = json!(purpose);
            }
            model_images.push(image);
        }
        // Preserve annotations/metadata and order, but never journal inline pixel bytes.
        let mut reference = json!({"type":"imageReference","artifactId":id,"mimeType":media});
        for key in ["annotations", "_meta"] {
            if let Some(value) = block.get(key) {
                reference[key] = value.clone();
            }
        }
        *block = reference;
    }
    for (key, images) in [("artifacts", artifacts), ("modelImages", model_images)] {
        if images.is_empty() {
            continue;
        }
        let object = output
            .as_object_mut()
            .ok_or("Tool image result must be an object")?;
        object
            .entry(key)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("Tool {key} must be an array"))?
            .extend(images);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Archive(std::path::PathBuf);
    impl Archive {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(crate::utils::new_runtime_ref("tool-images").unwrap());
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn context(&self) -> KernelToolExecutionContext {
            KernelToolExecutionContext {
                output_directory: Some(self.0.clone()),
                workspace_root: None,
                workspace_id: None,
                private_resolved_targets: vec![],
                workspace_write_targets: None,
                file_access: Default::default(),
                cancellation: Default::default(),
                progress: Default::default(),
            }
        }
    }
    impl Drop for Archive {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

    #[test]
    fn archive_failure_preserves_execution_facts_and_marks_pixels_unavailable() {
        let archive = Archive::new();
        for (index, failed) in [false, true].into_iter().enumerate() {
            let mut context = archive.context();
            context.output_directory = Some(archive.0.join(index.to_string()));
            fs::create_dir_all(context.output_directory.as_ref().unwrap()).unwrap();
            let original = KernelToolExecutionResult {
                invocation_id: "call:partial".into(),
                outcome: if failed {
                    KernelToolExecutionOutcome::Failed
                } else {
                    KernelToolExecutionOutcome::Completed
                },
                error: failed.then(|| KernelToolExecutionFailure {
                    code: "remote_failed".into(),
                    message: "Original operation failure".into(),
                }),
                output: json!({"content":[{"type":"text","text":"Input was already dispatched"},
                    {"type":"image","data":PNG,"mimeType":"image/png"},
                    {"type":"image","data":"bad","mimeType":"image/png"}],"structuredContent":{"dispatched":true}}),
            };
            let result = archive_result_images(original, &context);
            assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
            assert_eq!(result.error.unwrap().code, "tool_image_archive_failed");
            assert_eq!(
                result.output["executionOutcome"],
                if failed { "failed" } else { "completed" }
            );
            assert_eq!(
                result.output["content"][0]["text"],
                "Input was already dispatched"
            );
            assert_eq!(result.output["structuredContent"]["dispatched"], true);
            assert_eq!(result.output["content"][1]["type"], "imageUnavailable");
            assert_eq!(result.output["content"][2]["type"], "imageUnavailable");
            assert!(!result.output.to_string().contains(PNG));
            assert!(result.output.get("modelImages").is_none());
            if failed {
                assert_eq!(result.output["executionError"]["code"], "remote_failed");
            }
        }
    }

    #[test]
    fn mcp_image_bytes_are_archived_once_and_replaced_by_references() {
        let archive = Archive::new();
        let mut output = json!({"content":[{"type":"text","text":"Captured application"},
            {"type":"image","data":PNG,"mimeType":"image/png","_meta":{"achbit":{"purpose":"observation"}}}],
            "structuredContent":{"app":"example"},"isError":false});
        archive_content_images(&mut output, "call:screen", &archive.context()).unwrap();
        assert_eq!(output["content"][0]["text"], "Captured application");
        assert_eq!(output["structuredContent"]["app"], "example");
        assert!(!output.to_string().contains(PNG));
        assert_eq!(
            output["content"][1]["artifactId"],
            output["modelImages"][0]["artifactId"]
        );
        assert_eq!(output["modelImages"][0]["purpose"], "observation");
        assert_eq!(output["artifacts"][0]["contentMode"], "fixed");
        let path = output["artifacts"][0]["contentRef"].as_str().unwrap();
        assert_eq!(
            fs::read(path).unwrap(),
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap()
        );
    }

    #[test]
    fn cli_images_are_snapshotted_and_user_only_images_are_not_model_inputs() {
        let archive = Archive::new();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .unwrap();
        let source = archive.0.join("screen.png");
        fs::write(&source, &bytes).unwrap();
        let mut output = json!({"content":[{"type":"image","path":"screen.png","mimeType":"image/png",
            "annotations":{"audience":["user"]}}], "error":{"code":"operation_failed","message":"Original error"}});
        archive_content_images(&mut output, "call:file", &archive.context()).unwrap();
        fs::write(source, b"later mutation").unwrap();
        assert_eq!(
            fs::read(output["artifacts"][0]["contentRef"].as_str().unwrap()).unwrap(),
            bytes
        );
        assert!(output.get("modelImages").is_none());
        assert_eq!(output["error"]["message"], "Original error");
        let mut plain = json!({"content":[{"type":"text","text":"git status"}],"isError":false});
        let original = plain.clone();
        archive_content_images(&mut plain, "call:plain", &archive.context()).unwrap();
        assert_eq!(plain, original);
    }

    #[test]
    fn cli_receives_the_attempt_directory_and_returns_an_archived_file_image() {
        let archive = Archive::new();
        let client = crate::local_agent_cli::CliClient {
            command: "python3".into(),
            args: vec![
                "-c".into(),
                format!(
                    r#"
import base64, json, pathlib, sys
request = json.load(sys.stdin)
directory = pathlib.Path(request['context']['achbit']['outputDirectory'])
(directory / 'screen.png').write_bytes(base64.b64decode('{PNG}'))
print(json.dumps({{'content':[{{'type':'image','path':'screen.png','mimeType':'image/png',
  '_meta':{{'achbit':{{'purpose':'observation'}}}}}}], 'metadata':request['context']['trace']}}))
"#
                ),
            ],
            entry: None,
        };
        let mut result = client
            .call(
                "capture",
                json!({}),
                Some(json!({"trace":"original-metadata"})),
                &archive.context(),
            )
            .unwrap();
        assert!(result.failure.is_none());
        archive_content_images(&mut result.output, "call:cli", &archive.context()).unwrap();
        assert_eq!(result.output["metadata"], "original-metadata");
        assert_eq!(result.output["modelImages"][0]["purpose"], "observation");
        assert!(std::path::Path::new(
            result.output["artifacts"][0]["contentRef"]
                .as_str()
                .unwrap()
        )
        .is_file());
        assert!(result.output["content"][0].get("path").is_none());
    }
}
