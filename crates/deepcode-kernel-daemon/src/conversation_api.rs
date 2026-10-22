use crate::conversation_catalog::{
    automatic_conversation_title, canonical_folder_path, clean_title, workspace_display_name,
    ConversationCatalog, ConversationProjectRecord, ConversationSessionRecord,
    ConversationTitleSource, ConversationWorkspaceRecord, WorkspaceBindingDisplayRecord,
};
use crate::prelude::*;
use crate::{ApiResponse, AppState, GuiState, SessionServiceError, SessionServiceProcess};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path as StdPath;

const MAX_MESSAGE_FILESYSTEM_REFERENCES: usize = 8;
const MAX_REFERENCE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateConversationSessionRequest {
    session_id: Option<String>,
    workspace_paths: Option<Vec<String>>,
    project_id: Option<String>,
    profile_id: Option<String>,
    recipe: Option<Value>,
    subagent_settings: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateAgentSessionRequest {
    session_id: String,
    display_title: String,
    workspace_bindings: Vec<WorkspaceBindingDisplayRecord>,
    profile_id: String,
    agent_context: Value,
    recipe: Option<Value>,
    subagent_settings: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateConversationProjectRequest {
    title: String,
    #[serde(default)]
    workspace_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateConversationProjectRequest {
    title: Option<String>,
    workspace_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateConversationSessionRequest {
    title: Option<String>,
    /// Missing keeps the current classification; JSON null moves to the independent list.
    #[serde(default, deserialize_with = "deserialize_project_id_update")]
    project_id: Option<Option<String>>,
}

fn deserialize_project_id_update<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadConversationResourceRequest {
    workspace_id: Option<String>,
    file_grant: Option<crate::conversation_resources::FileGrantReference>,
    change: Option<crate::conversation_resources::ChangeReference>,
    logical_path: String,
    start_byte: Option<u64>,
    start_line: Option<u64>,
    format: Option<ResourceReadFormat>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResourceReadFormat {
    Text,
    Image,
    Document,
    Path,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachConversationDirectoryIndexRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveConversationFilesystemReferencesRequest {
    references: Vec<FilesystemReferencePathInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilesystemReferencePathInput {
    path: String,
    kind: String,
}

pub(crate) async fn conversation_read(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(mut body): Json<Value>,
) -> Json<ApiResponse> {
    let Some(query) = body.as_object_mut() else {
        return ApiResponse::error("conversation_read_invalid", "读取选项必须是对象。");
    };
    if query.contains_key("sessionId") {
        return ApiResponse::error("conversation_read_invalid", "sessionId 使用请求路径。");
    }
    query.insert("sessionId".into(), Value::String(session_id));
    match request_service(state.session_service.clone(), "read", body).await {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

fn visible_session_ids(
    catalog: &ConversationCatalog,
    journal: &crate::local_agent_store::LocalAgentJournal,
) -> Result<Vec<String>, crate::local_agent_store::LocalAgentStoreError> {
    let mut session_ids = Vec::new();
    for session in &catalog.sessions {
        if journal.agent_context(&session.id)?.is_none() {
            session_ids.push(session.id.clone());
        }
    }
    Ok(session_ids)
}

fn visible_catalog_response(
    gui: &GuiState,
    journal: &crate::local_agent_store::LocalAgentJournal,
    management: bool,
) -> Json<ApiResponse> {
    let visible = match visible_session_ids(&gui.conversation_catalog, journal) {
        Ok(ids) => ids.into_iter().collect::<HashSet<_>>(),
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let mut value = if management {
        gui.conversation_catalog.management_value()
    } else {
        gui.conversation_catalog.public_value()
    };
    value["sessions"]
        .as_array_mut()
        .expect("catalog sessions")
        .retain(|session| visible.contains(session["id"].as_str().expect("catalog session id")));
    ApiResponse::ok(value)
}

pub(crate) async fn conversation_catalog_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

pub(crate) async fn conversation_statuses_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let session_ids: Vec<String> = {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        match visible_session_ids(&gui.conversation_catalog, &state.local_agent.journal) {
            Ok(ids) => ids,
            Err(error) => return ApiResponse::error(error.code, error.message),
        }
    };
    match request_service(
        state.session_service.clone(),
        "statuses",
        json!({ "sessionIds": session_ids }),
    )
    .await
    {
        Ok(mut value) => {
            let gui = state.gui.lock().expect("gui state lock");
            if let Some(statuses) = value.as_array_mut() {
                for status in statuses {
                    if let Some(session) = status["sessionId"]
                        .as_str()
                        .and_then(|id| gui.conversation_catalog.session(id))
                    {
                        status["title"] = json!(session.title);
                    }
                }
            }
            ApiResponse::ok(value)
        }
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_skill_settings_get(
    State(state): State<AppState>,
) -> Json<ApiResponse> {
    let settings = state
        .gui
        .lock()
        .expect("gui state lock")
        .user_settings
        .clone();
    match crate::local_agent_plugins::skill_settings_projection(&settings) {
        Ok(projection) => ApiResponse::ok(projection),
        Err(error) => ApiResponse::error("skill_catalog_unavailable", error),
    }
}

pub(crate) async fn conversation_plugin_catalog_get(
    State(state): State<AppState>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    match crate::local_agent_plugins::plugin_catalog_projection(&gui.user_settings) {
        Ok(catalog) => ApiResponse::ok(catalog),
        Err(error) => ApiResponse::error("plugin_catalog_unavailable", error),
    }
}

pub(crate) async fn conversation_resource_read(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ReadConversationResourceRequest>,
) -> Response {
    let resource = crate::conversation_resources::ResourceReference {
        workspace_id: body.workspace_id.clone(),
        file_grant: body.file_grant.clone(),
        change: body.change.clone(),
        logical_path: body.logical_path.clone(),
    };
    let records: Vec<String> = resource
        .change
        .iter()
        .map(|change| change.record_id.clone())
        .collect();
    let projection =
        match crate::conversation_resources::resource_projection(&state, &session_id, &records)
            .await
        {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        };
    let target = match crate::conversation_resources::resolve_resource(
        &state,
        &session_id,
        &projection,
        &resource,
    ) {
        Ok(path) => path,
        Err(error) => return error.into_response(),
    };
    if matches!(body.format, Some(ResourceReadFormat::Path)) {
        let kind = if target.is_dir() {
            "directory"
        } else if target.is_file() {
            "file"
        } else {
            return ApiResponse::error("conversation_resource_not_found", "目标文件或目录不存在。")
                .into_response();
        };
        return ApiResponse::ok(json!({"path":target,"kind":kind})).into_response();
    }
    if matches!(body.format, Some(ResourceReadFormat::Document)) {
        if body.start_byte.is_some() {
            return ApiResponse::error(
                "conversation_document_range_invalid",
                "文档预览不接受文本游标。",
            )
            .into_response();
        }
        return match tokio::task::spawn_blocking(move || read_document_resource(&target)).await {
            Ok(Ok((media_type, bytes))) => {
                ([(axum::http::header::CONTENT_TYPE, media_type)], bytes).into_response()
            }
            Ok(Err(error)) => {
                ApiResponse::error("conversation_document_read_failed", error).into_response()
            }
            Err(error) => {
                ApiResponse::error("conversation_document_read_failed", error.to_string())
                    .into_response()
            }
        };
    }
    if matches!(body.format, Some(ResourceReadFormat::Image)) {
        if body.start_byte.is_some() {
            return ApiResponse::error(
                "conversation_image_range_invalid",
                "图片读取不接受文本游标。",
            )
            .into_response();
        }
        return match read_image_resource(&target) {
            Ok((media_type, bytes)) => {
                ([(axum::http::header::CONTENT_TYPE, media_type)], bytes).into_response()
            }
            Err(error) => {
                ApiResponse::error("conversation_image_read_failed", error).into_response()
            }
        };
    }
    match deepcode_kernel_tools::text_range::read_text_range(
        &target,
        body.start_line.unwrap_or(1),
        body.start_byte,
        2000,
        262144,
    ) {
        Ok(mut read) => {
            read["workspaceId"] = json!(body.workspace_id);
            if let Some(grant) = body.file_grant {
                read["fileGrant"] = json!(grant);
            }
            read["logicalPath"] = json!(body.logical_path);
            ApiResponse::ok(read)
        }
        Err(error) => ApiResponse::error("conversation_resource_read_failed", &error),
    }
    .into_response()
}

pub(crate) async fn conversation_artifact_read(
    State(state): State<AppState>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Response {
    let projection = match request_service(
        state.session_service.clone(),
        "resourceSnapshot",
        json!({"sessionId":session_id}),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error).into_response(),
    };
    let Some(artifact) = projection["artifacts"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["artifactId"] == artifact_id))
    else {
        return ApiResponse::error(
            "artifact_not_found",
            "This session does not contain the requested artifact.",
        )
        .into_response();
    };
    let Some(call_id) = artifact["callId"].as_str() else {
        return ApiResponse::error(
            "artifact_source_missing",
            "Artifact has no execution reference.",
        )
        .into_response();
    };
    let record = match state.local_agent.kernel.read_record(call_id) {
        Ok(Some(record)) => record,
        Ok(None) => {
            return ApiResponse::error(
                "artifact_record_missing",
                "Artifact execution record is missing.",
            )
            .into_response()
        }
        Err(error) => return ApiResponse::error(error.code, error.message).into_response(),
    };
    let source = record["output"]["artifacts"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["artifactId"] == artifact_id));
    let Some(source) = source.filter(|_| {
        record["sessionId"] == session_id && record["recordId"] == artifact["recordId"]
    }) else {
        return ApiResponse::error(
            "artifact_source_invalid",
            "Artifact execution ownership does not match.",
        )
        .into_response();
    };
    let (Some(path), Some(content_type)) = (
        source["contentRef"].as_str(),
        source["contentType"].as_str(),
    ) else {
        return ApiResponse::error(
            "artifact_content_unavailable",
            "This artifact has no archived content; its live target may be opened explicitly.",
        )
        .into_response();
    };
    let content_type = content_type.to_owned();
    let path = path.to_owned();
    match tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path).map_err(|error| format!("{path}: {error}"))?;
        let mut bytes = Vec::new();
        file.take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("artifact_preview_limit_exceeded: 32 MiB".into());
        }
        Ok::<_, String>(bytes)
    })
    .await
    {
        Ok(Ok(bytes)) => (
            [
                (axum::http::header::CONTENT_TYPE, content_type),
                (
                    axum::http::header::CACHE_CONTROL,
                    "private, immutable".into(),
                ),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(error)) => ApiResponse::error("artifact_read_failed", error).into_response(),
        Err(error) => ApiResponse::error("artifact_read_failed", error.to_string()).into_response(),
    }
}

fn read_document_resource(path: &StdPath) -> Result<(&'static str, Vec<u8>), String> {
    const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_type = match suffix.as_str() {
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        _ => return Err("文档预览支持 HTML、PDF 和 Markdown 文件。".into()),
    };
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("文档超过 32 MiB 读取限额。".into());
    }
    if suffix == "pdf" {
        if !bytes.starts_with(b"%PDF-") {
            return Err("当前文件不是 PDF 文档。".into());
        }
    } else {
        std::str::from_utf8(&bytes)
            .map_err(|error| format!("文档不是有效的 UTF-8 文本：{error}"))?;
    }
    Ok((media_type, bytes))
}

// Image presentation uses the same Session/workspace binding check as text.
// The byte cap applies while reading, including if the file grows concurrently.
pub(crate) fn read_image_resource(path: &StdPath) -> Result<(&'static str, Vec<u8>), String> {
    const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let media = image_media_type(&bytes)?;
    Ok((media, bytes))
}

pub(crate) fn image_media_type(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("图片超过 8 MiB 读取限额。".into());
    }
    let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("当前资源不是支持的 PNG、JPEG、GIF 或 WebP 图片。".into());
    };
    Ok(media)
}

pub(crate) fn resolve_provider_images(
    state: &AppState,
    session_id: &str,
    messages: &mut [crate::local_agent_api::LocalProviderMessage],
    image_input: bool,
) -> Result<(), String> {
    use base64::Engine;
    for message in messages {
        if !message.tool_images.is_empty() {
            if !image_input {
                return Err("当前模型未声明图片输入能力，请使用视觉模型查看工具截图。".into());
            }
            if message.role != "user" {
                return Err("工具截图必须作为当前视觉输入提供。".into());
            }
            for image in &message.tool_images {
                let record = state
                    .local_agent
                    .kernel
                    .read_record(&image.call_id)
                    .map_err(|error| error.message)?
                    .ok_or("工具记录不存在。")?;
                if record["sessionId"].as_str() != Some(session_id)
                    || record["outcome"] != "completed"
                {
                    return Err("截图必须来自当前会话已完成的工具记录。".into());
                }
                let id = &image.artifact_id;
                let declared = record["output"]["modelImages"]
                    .as_array()
                    .is_some_and(|images| images.iter().any(|image| image["artifactId"] == *id));
                if !declared {
                    return Err("工具未声明该视觉结果。".into());
                }
                let artifact = record["output"]["artifacts"]
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["artifactId"] == *id))
                    .ok_or("截图产物不存在。")?;
                if artifact["contentMode"] != "fixed" {
                    return Err("截图必须是固定归档产物。".into());
                }
                let path = artifact["contentRef"]
                    .as_str()
                    .ok_or("截图归档内容缺失。")?;
                let (media, bytes) = read_image_resource(StdPath::new(path))?;
                message
                    .image_data
                    .push(crate::local_agent_api::LocalProviderImage {
                        media_type: media.into(),
                        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    });
            }
        }
        for image in &message.images {
            if !image_input {
                return Err(
                    "当前模型未声明图片输入能力，请切换视觉模型或在模型设置中启用图片输入。".into(),
                );
            }
            let root = {
                let gui = state.gui.lock().expect("gui state lock");
                if let Some(error) = &gui.conversation_catalog_error {
                    return Err(error.clone());
                }
                let workspace = gui
                    .conversation_catalog
                    .workspace(&image.workspace_id)
                    .ok_or("图片附件目录不存在。")?;
                if workspace
                    .owner_session_id
                    .as_deref()
                    .is_some_and(|owner| owner != session_id)
                {
                    return Err("图片引用不属于当前会话。".into());
                }
                // Exact images explicitly supplied by the user are model inputs.
                // This does not grant tools access to the source file or its parent.
                workspace.canonical_root.clone()
            };
            let path = crate::host_inspection::resolve_workspace_read_path(
                StdPath::new(&root),
                &image.logical_path,
            )
            .map_err(|error| error.message)?;
            let (media, bytes) = read_image_resource(&path)?;
            if media != image.media_type {
                return Err("图片内容与附件格式不一致。".into());
            }
            message
                .image_data
                .push(crate::local_agent_api::LocalProviderImage {
                    media_type: media.into(),
                    base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                });
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadFileChangeRequest {
    record_id: String,
    index: usize,
}

pub(crate) async fn conversation_change_read(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ReadFileChangeRequest>,
) -> Json<ApiResponse> {
    let projection = match request_service(
        state.session_service,
        "resourceSnapshot",
        json!({ "sessionId": session_id, "recordIds": [&body.record_id] }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let change = projection["activities"]
        .as_array()
        .and_then(|activities| {
            activities.iter().find(|activity| {
                activity["tool"]["recordId"].as_str() == Some(body.record_id.as_str())
            })
        })
        .and_then(|activity| activity["tool"]["fileChanges"].as_array())
        .and_then(|changes| changes.get(body.index));
    let Some(change) = change else {
        return ApiResponse::error("file_change_not_found", "变更记录不存在。");
    };
    read_file_change_response(change)
}

fn read_file_change_response(change: &Value) -> Json<ApiResponse> {
    let read = |side: &Value| -> Result<Value, (&str, String)> {
        if side["exists"] == false {
            return Ok(Value::Null);
        }
        if let Some(error) = side["error"].as_str() {
            return Err(("file_change_content_unavailable", error.to_string()));
        }
        let path = side["contentRef"].as_str().ok_or((
            "file_change_content_unavailable",
            "file_change_content_missing".to_string(),
        ))?;
        deepcode_kernel_tools::file_content::read_text_file_for_llm(StdPath::new(path))
            .map(|read| json!(read.content))
            .map_err(|error| {
                if error.classification.binary {
                    (
                        "file_change_binary_content",
                        format!(
                            "{} 是二进制文件，不提供文本行数和逐行对比。",
                            change["path"].as_str().unwrap_or("文件")
                        ),
                    )
                } else {
                    ("file_change_content_unavailable", error.message)
                }
            })
    };
    match (read(&change["before"]), read(&change["after"])) {
        (Ok(before), Ok(after)) => ApiResponse::ok(
            json!({ "workspaceId": change["workspaceId"], "path": change["path"], "before": before, "after": after }),
        ),
        (Err((code, error)), _) | (_, Err((code, error))) => ApiResponse::error(code, &error),
    }
}

pub(crate) async fn conversation_filesystem_references_resolve(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ResolveConversationFilesystemReferencesRequest>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) {
        return ApiResponse::error("conversation_session_identity_invalid", "对话身份无效。");
    }
    if body.references.is_empty() || body.references.len() > MAX_MESSAGE_FILESYSTEM_REFERENCES {
        return ApiResponse::error(
            "conversation_filesystem_references_invalid",
            "单次消息必须附加一至八个文件系统引用。",
        );
    }
    let references = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        let mut workspaces = Vec::new();
        let references = match resolve_filesystem_references(
            &gui.conversation_catalog,
            &mut workspaces,
            &body.references,
            &crate::now_text(),
        ) {
            Ok(value) => value,
            Err((code, message)) => {
                return ApiResponse::error(code, message);
            }
        };
        if let Err(error) = persist_catalog_rows(&mut gui, workspaces, None, None) {
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
        references
    };
    ApiResponse::ok(json!(references))
}

pub(crate) async fn conversation_directory_index_attach(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AttachConversationDirectoryIndexRequest>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) {
        return ApiResponse::error("conversation_session_identity_invalid", "对话身份无效。");
    }
    let canonical_root = match canonical_folder_path(&body.path) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_directory_index_invalid", error),
    };
    let binding = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        let mut workspaces = Vec::new();
        let workspace_ids = match prepare_roots(
            &gui.conversation_catalog,
            &mut workspaces,
            vec![canonical_root],
            &crate::now_text(),
        ) {
            Ok(value) => value,
            Err(error) => return session_service_error(error),
        };
        let binding = binding_snapshot(&gui.conversation_catalog, &workspaces, &workspace_ids)
            .into_iter()
            .next()
            .expect("registered workspace has display binding");
        if let Err(error) = persist_catalog_rows(&mut gui, workspaces, None, None) {
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
        binding
    };
    let before = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if before
        .get("workspaceBindings")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|candidate| {
                candidate.get("workspaceId").and_then(Value::as_str)
                    == Some(binding.workspace_id.as_str())
            })
        })
    {
        return ApiResponse::ok(before);
    }
    let command_id = match random_id("command") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let reply = match request_service(
        state.session_service.clone(),
        "submit",
        json!({
            "command": {
                "schemaVersion": "deepcode.command.v3",
                "type": "session.directory-index.attach",
                "commandId": command_id,
                "sessionId": session_id,
                "workspaceBinding": {
                    "workspaceId": binding.workspace_id,
                    "displayName": binding.display_name,
                },
            }
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) == Some("rejected") {
        return ApiResponse::error(
            reply
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("session_directory_index_rejected"),
            reply
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("目录索引未被 Session 接受。"),
        );
    }
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_directory_index_detach(
    State(state): State<AppState>,
    Path((session_id, workspace_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) || !valid_id(&workspace_id) {
        return ApiResponse::error(
            "conversation_directory_index_identity_invalid",
            "目录索引身份无效。",
        );
    }
    let before = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if !before
        .get("sessionDirectoryIndexes")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("workspaceId").and_then(Value::as_str) == Some(&workspace_id)
            })
        })
    {
        return ApiResponse::error(
            "session_directory_index_not_attached",
            "该目录不是当前 Session 可移除的对话目录索引。",
        );
    }
    let command_id = match random_id("command") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let reply = match request_service(
        state.session_service.clone(),
        "submit",
        json!({
            "command": {
                "schemaVersion": "deepcode.command.v3",
                "type": "session.directory-index.detach",
                "commandId": command_id,
                "sessionId": session_id,
                "workspaceId": workspace_id,
            }
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) == Some("rejected") {
        return ApiResponse::error(
            reply
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("session_directory_index_rejected"),
            reply
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("目录索引未被 Session 接受。"),
        );
    }
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

/// This is the only catalog surface allowed to reveal canonical roots. It is
/// consumed by an explicit folder picker/project-management dialog, never by
/// an ordinary conversation projection.
pub(crate) async fn conversation_catalog_management_get(
    State(state): State<AppState>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    visible_catalog_response(&gui, &state.local_agent.journal, true)
}

pub(crate) async fn conversation_project_create(
    State(state): State<AppState>,
    Json(body): Json<CreateConversationProjectRequest>,
) -> Json<ApiResponse> {
    let title = match clean_title(&body.title) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_project_title_invalid", error),
    };
    let roots = match canonical_roots(&body.workspace_paths) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_project_workspace_invalid", error),
    };
    let id = match random_id("project") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    let mut workspaces = Vec::new();
    let workspace_ids = match prepare_roots(&gui.conversation_catalog, &mut workspaces, roots, &now)
    {
        Ok(value) => value,
        Err(error) => {
            return session_service_error(error);
        }
    };
    let project = ConversationProjectRecord {
        id,
        title,
        workspace_ids,
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(error) = persist_catalog_rows(&mut gui, workspaces, Some(project), None) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

pub(crate) async fn conversation_project_update(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<UpdateConversationProjectRequest>,
) -> Json<ApiResponse> {
    if body.title.is_none() && body.workspace_paths.is_none() {
        return ApiResponse::error(
            "conversation_project_update_empty",
            "项目更新至少需要 title 或 workspacePaths。",
        );
    }
    let title = match body.title.as_deref() {
        Some(value) => match clean_title(value) {
            Ok(value) => Some(value),
            Err(error) => return ApiResponse::error("conversation_project_title_invalid", error),
        },
        None => None,
    };
    let roots = match body.workspace_paths.as_deref() {
        Some(paths) => match canonical_roots(paths) {
            Ok(value) => Some(value),
            Err(error) => {
                return ApiResponse::error("conversation_project_workspace_invalid", error)
            }
        },
        None => None,
    };
    let sync_workspaces = roots.is_some();
    let now = crate::now_text();
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        let Some(mut project) = gui.conversation_catalog.project(&project_id).cloned() else {
            return ApiResponse::error("conversation_project_not_found", "项目不存在。");
        };
        let mut workspaces = Vec::new();
        if let Some(title) = title {
            project.title = title;
        }
        if let Some(roots) = roots {
            project.workspace_ids =
                match prepare_roots(&gui.conversation_catalog, &mut workspaces, roots, &now) {
                    Ok(value) => value,
                    Err(error) => {
                        return session_service_error(error);
                    }
                };
        }
        project.updated_at = now;
        if let Err(error) = persist_catalog_rows(&mut gui, workspaces, Some(project), None) {
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
    }
    if sync_workspaces {
        if let Err(error) = sync_project_workspaces(&state, &project_id, None).await {
            return session_service_error(error);
        }
    }
    let gui = state.gui.lock().expect("gui state lock");
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

/// Project metadata selects roots; each Session commits its own effective bindings.
async fn sync_project_workspaces(
    state: &AppState,
    project_id: &str,
    only_session: Option<&str>,
) -> Result<(), SessionServiceError> {
    let (bindings, sessions) = {
        let gui = state.gui.lock().expect("gui state lock");
        let bindings = gui
            .conversation_catalog
            .project_binding_snapshot(project_id)
            .map_err(|code| SessionServiceError::new(code, "项目不存在。"))?;
        let sessions = gui
            .conversation_catalog
            .sessions
            .iter()
            .filter(|session| {
                session.project_id.as_deref() == Some(project_id)
                    && only_session.is_none_or(|id| session.id == id)
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        (bindings, sessions)
    };
    for session_id in sessions {
        let reply = request_service(state.session_service.clone(), "submit", json!({"command":{
            "schemaVersion":"deepcode.command.v3", "type":"session.workspaces.set",
            "sessionId":session_id, "commandId":random_id("workspace-sync")?, "workspaceBindings":bindings,
        }})).await?;
        require_workspace_command(&reply)?;
        let mut gui = state.gui.lock().expect("gui state lock");
        let mut session = gui
            .conversation_catalog
            .session(&session_id)
            .cloned()
            .ok_or_else(|| {
                SessionServiceError::new("conversation_session_not_found", "同步期间会话已移除。")
            })?;
        if session.project_id.as_deref() != Some(project_id) {
            return Err(SessionServiceError::new(
                "project_workspace_sync_conflict",
                "同步期间会话所属项目已变化。",
            ));
        }
        session.workspace_bindings = bindings.clone();
        session.updated_at = crate::now_text();
        persist_catalog_rows(&mut gui, Vec::new(), None, Some(session)).map_err(|error| {
            SessionServiceError::new("conversation_catalog_write_failed", error)
        })?;
    }
    Ok(())
}

fn require_workspace_command(reply: &Value) -> Result<(), SessionServiceError> {
    if reply["status"] == "accepted" {
        return Ok(());
    }
    Err(SessionServiceError::new(
        reply["error"]["code"]
            .as_str()
            .unwrap_or("workspace_update_rejected"),
        reply["error"]["message"]
            .as_str()
            .unwrap_or("工作区修改未被接纳。"),
    ))
}

pub(crate) async fn conversation_project_delete(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<ApiResponse> {
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    if gui.conversation_catalog.project(&project_id).is_none() {
        return ApiResponse::error("conversation_project_not_found", "项目不存在。");
    }
    let path = gui.paths.catalog_store_path.clone();
    if let Err(error) = gui
        .conversation_catalog
        .remove_project(&path, &project_id, &now)
    {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

pub(crate) async fn conversation_session_create(
    State(state): State<AppState>,
    Json(mut body): Json<CreateConversationSessionRequest>,
) -> Json<ApiResponse> {
    let recipe = match body
        .recipe
        .as_ref()
        .map(crate::local_agent_recipe::AgentRecipe::decode)
        .transpose()
    {
        Ok(recipe) => recipe,
        Err(error) => return ApiResponse::error("agent_recipe_invalid", error),
    };
    if let Some(recipe) = &recipe {
        if body.profile_id.is_some()
            && recipe.profile_id.is_some()
            && body.profile_id != recipe.profile_id
        {
            return ApiResponse::error(
                "agent_recipe_model_conflict",
                "Model selection conflicts with the Agent recipe.",
            );
        }
        body.profile_id = body.profile_id.or_else(|| recipe.profile_id.clone());
    }
    let session_id = match body.session_id {
        Some(value) if valid_id(&value) => value,
        Some(_) => {
            return ApiResponse::error(
                "session_identity_invalid",
                "sessionId 不是有效本地会话标识。",
            )
        }
        None => match random_id("session") {
            Ok(value) => value,
            Err(error) => return session_service_error(error),
        },
    };
    if body.project_id.is_some() && body.workspace_paths.is_some() {
        return ApiResponse::error(
            "conversation_binding_source_conflict",
            "项目会话使用项目 binding 模板，不能同时提交 workspacePaths。",
        );
    }

    let now = crate::now_text();
    let (profile_id, bindings) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_some() {
            return ApiResponse::error("conversation_session_exists", "对话已经存在。");
        }
        let profile_id = match selected_profile_id(&gui, body.profile_id.as_deref()) {
            Ok(value) => value,
            Err((code, message)) => return ApiResponse::error(code, message),
        };
        let mut workspaces = Vec::new();
        let bindings = if let Some(project_id) = body.project_id.as_deref() {
            match gui
                .conversation_catalog
                .project_binding_snapshot(project_id)
            {
                Ok(value) => value,
                Err(code) => return ApiResponse::error(code, "项目不存在。"),
            }
        } else {
            let roots = match canonical_roots(body.workspace_paths.as_deref().unwrap_or(&[])) {
                Ok(value) => value,
                Err(error) => return ApiResponse::error("conversation_workspace_invalid", error),
            };
            let workspace_ids =
                match prepare_roots(&gui.conversation_catalog, &mut workspaces, roots, &now) {
                    Ok(value) => value,
                    Err(error) => {
                        return session_service_error(error);
                    }
                };
            let bindings = binding_snapshot(&gui.conversation_catalog, &workspaces, &workspace_ids);
            if let Err(error) = persist_catalog_rows(&mut gui, workspaces, None, None) {
                return ApiResponse::error("conversation_catalog_write_failed", error);
            }
            bindings
        };
        (profile_id, bindings)
    };

    create_registered_session(
        &state,
        ConversationSessionRecord {
            id: session_id,
            title: "新对话".into(),
            title_source: Some(crate::conversation_catalog::ConversationTitleSource::Initial),
            workspace_bindings: bindings,
            project_id: body.project_id,
            profile_id: Some(profile_id),
            created_at: now.clone(),
            updated_at: now,
        },
        None,
        recipe.map(|recipe| json!(recipe)),
        body.subagent_settings,
    )
    .await
}

/// Shared Host creation path. Session retains the journal; catalog records only presentation/bindings.
async fn create_registered_session(
    state: &AppState,
    session: ConversationSessionRecord,
    agent_context: Option<Value>,
    recipe: Option<Value>,
    subagent_settings: Option<Value>,
) -> Json<ApiResponse> {
    let session_id = session.id.clone();
    let mut creation = json!({
        "sessionId": session.id,
        "displayTitle": session.title,
        "workspaceBindings": session.workspace_bindings,
        "profileId": session.profile_id,
    });
    if let Some(recipe) = recipe {
        creation["recipe"] = recipe;
    }
    if let Some(context) = agent_context {
        creation["agentContext"] = context;
    }
    if let Some(settings) = subagent_settings {
        creation["subagentSettings"] = settings;
    }
    let projection =
        match request_service(state.session_service.clone(), "createSession", creation).await {
            Ok(value) => value,
            Err(error) => return session_service_error(error),
        };
    let persist_result: Result<(), (&'static str, String)> = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog.session(&session_id).is_some() {
            Err((
                "conversation_session_exists",
                "同一 sessionId 在创建期间被占用。".to_string(),
            ))
        } else if session
            .project_id
            .as_deref()
            .is_some_and(|project_id| gui.conversation_catalog.project(project_id).is_none())
        {
            Err((
                "conversation_project_changed_during_creation",
                "项目在 Session 创建期间已被删除。".to_string(),
            ))
        } else {
            persist_catalog_rows(&mut gui, Vec::new(), None, Some(session))
                .map_err(|error| ("conversation_catalog_write_failed", error))
        }
    };
    if let Err((code, error)) = persist_result {
        let rollback = request_service(
            state.session_service.clone(),
            "deleteSession",
            json!({ "sessionId": session_id, "unstartedOnly": true }),
        )
        .await;
        return session_creation_failure(code, error, rollback);
    }
    ApiResponse::ok(projection)
}

fn session_creation_failure(
    code: &'static str,
    mut message: String,
    rollback: Result<Value, SessionServiceError>,
) -> Json<ApiResponse> {
    if let Err(error) = rollback {
        message.push_str(&format!(
            " [deleteSession] {}: {}",
            error.code, error.message
        ));
    }
    ApiResponse::error(code, message)
}

pub(crate) async fn create_agent_session(
    state: AppState,
    body: CreateAgentSessionRequest,
) -> Json<ApiResponse> {
    if !valid_id(&body.session_id) {
        return ApiResponse::error(
            "session_identity_invalid",
            "sessionId 不是有效本地会话标识。",
        );
    }
    if let Err(error) =
        crate::local_agent_store::validate_agent_context(&body.agent_context, &body.session_id)
    {
        return ApiResponse::error(error.code, error.message);
    }
    let title = match clean_title(&body.display_title) {
        Ok(title) => title,
        Err(error) => return ApiResponse::error("conversation_session_title_invalid", error),
    };
    let parent_id = body.agent_context["parentSessionId"]
        .as_str()
        .expect("validated parent");
    let parent_run = body.agent_context["parentRunId"]
        .as_str()
        .expect("validated run");
    let parent_context = match state.local_agent.journal.agent_context(parent_id) {
        Ok(context) => context,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let owner_id = parent_context
        .as_ref()
        .map(|context| context["ownerSessionId"].as_str().expect("validated owner"))
        .unwrap_or(parent_id);
    if body.agent_context["ownerSessionId"] != owner_id {
        return ApiResponse::error(
            "agent_owner_mismatch",
            "子 Agent owner 必须沿父会话的已记录谱系继承。",
        );
    }
    let parent_bindings = match state
        .local_agent
        .journal
        .run_workspace_binding_ids(parent_id, parent_run)
    {
        Ok(bindings) => bindings,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let now = crate::now_text();
    let session = {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&body.session_id).is_some() {
            return ApiResponse::error("conversation_session_exists", "对话已经存在。");
        }
        if gui.conversation_catalog.session(parent_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "父会话不存在。");
        }
        let profile_id = match selected_profile_id(&gui, Some(&body.profile_id)) {
            Ok(profile) => profile,
            Err((code, message)) => return ApiResponse::error(code, message),
        };
        let mut seen = HashSet::new();
        let mut bindings = Vec::new();
        for binding in &body.workspace_bindings {
            let Some(workspace) = gui.conversation_catalog.workspace(&binding.workspace_id) else {
                return ApiResponse::error(
                    "agent_workspace_unavailable",
                    "父工作目录不在 Host catalog 中。",
                );
            };
            if !parent_bindings.contains(&binding.workspace_id)
                || workspace.display_name != binding.display_name
                || !seen.insert(&binding.workspace_id)
            {
                return ApiResponse::error(
                    "agent_workspace_mismatch",
                    "子 Agent 只能继承父 run 已绑定的目录，且身份与名称必须一致。",
                );
            }
            // Private file snapshots and scratch directories stay with their owning Session.
            if workspace.owner_session_id.is_none() {
                bindings.push(binding.clone());
            }
        }
        ConversationSessionRecord {
            id: body.session_id.clone(),
            title,
            title_source: Some(crate::conversation_catalog::ConversationTitleSource::Manual),
            workspace_bindings: bindings,
            project_id: None,
            profile_id: Some(profile_id),
            created_at: now.clone(),
            updated_at: now,
        }
    };
    let parent_recipe = match state.local_agent.journal.agent_recipe(parent_id) {
        Ok(recipe) => recipe,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let mut recipe = match body
        .recipe
        .as_ref()
        .map(crate::local_agent_recipe::AgentRecipe::decode)
        .transpose()
    {
        Ok(Some(recipe)) => recipe,
        Ok(None) => crate::local_agent_recipe::AgentRecipe {
            permission_policy: parent_recipe.permission_policy.clone(),
            workspace_sandbox: parent_recipe.workspace_sandbox.clone(),
            ..Default::default()
        },
        Err(error) => return ApiResponse::error("agent_recipe_invalid", error),
    };
    if let Err(error) = parent_recipe.validate_child(&recipe) {
        return ApiResponse::error("agent_policy_not_grantable", error);
    }
    let parent_permissions = match state
        .local_agent
        .journal
        .run_permission_settings(parent_id, parent_run)
    {
        Ok(permissions) => permissions,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    recipe.permissions = match crate::local_agent_recipe::inherit_permissions(
        &parent_permissions,
        recipe.permissions.as_ref(),
    ) {
        Ok(permissions) => Some(permissions),
        Err(error) => return ApiResponse::error("agent_permission_not_grantable", error),
    };
    let created = create_registered_session(
        &state,
        session,
        Some(body.agent_context),
        Some(json!(recipe)),
        body.subagent_settings,
    )
    .await;
    if !created.0.ok {
        return created;
    }
    let initialized = async {
        ensure_session_workdir(&state, &body.session_id).await?;
        request_service(
            state.session_service.clone(),
            "snapshot",
            json!({"sessionId":body.session_id}),
        )
        .await
    }
    .await;
    match initialized {
        Ok(projection) => ApiResponse::ok(projection),
        Err(mut error) => {
            let cleanup = delete_conversation_session(state, body.session_id, true).await;
            if !cleanup.0.ok {
                error.message.push_str(&format!(
                    " [deleteSession] {}: {}",
                    cleanup.0.error.expect("error response code"),
                    cleanup.0.message.expect("error response message")
                ));
            }
            session_service_error(error)
        }
    }
}

pub(crate) async fn conversation_session_update(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<UpdateConversationSessionRequest>,
) -> Json<ApiResponse> {
    if body.title.is_none() && body.project_id.is_none() {
        return ApiResponse::error(
            "conversation_session_update_empty",
            "会话更新至少需要 title 或 projectId。",
        );
    }
    let title = match body.title.as_deref() {
        Some(value) => match clean_title(value) {
            Ok(value) => Some(value),
            Err(error) => return ApiResponse::error("conversation_session_title_invalid", error),
        },
        None => None,
    };
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    let Some(mut session) = gui.conversation_catalog.session(&session_id).cloned() else {
        return ApiResponse::error("conversation_session_not_found", "对话不存在。");
    };
    let renamed = title.is_some();
    if let Some(title) = title {
        session.title = title;
        session.title_source = Some(ConversationTitleSource::Manual);
    }
    if let Some(project_id) = body.project_id.as_ref() {
        if project_id
            .as_deref()
            .is_some_and(|id| gui.conversation_catalog.project(id).is_none())
        {
            return ApiResponse::error("conversation_project_not_found", "项目不存在。");
        }
        session.project_id = project_id.clone();
    }
    session.updated_at = now;
    if let Err(error) = persist_catalog_rows(&mut gui, Vec::new(), None, Some(session)) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    if renamed {
        if let Some(task) = gui.conversation_title_tasks.remove(&session_id) {
            task.abort();
        }
    }
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

pub(crate) async fn conversation_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    delete_conversation_session(state, session_id, false).await
}

async fn delete_conversation_session(
    state: AppState,
    session_id: String,
    unstarted_only: bool,
) -> Json<ApiResponse> {
    {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        let Some(_) = gui.conversation_catalog.session(&session_id) else {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        };
    }
    let mut deletion = json!({ "sessionId": session_id });
    if unstarted_only {
        deletion["unstartedOnly"] = json!(true);
    }
    let (receipt, mut partial_error) =
        match request_service(state.session_service.clone(), "deleteSession", deletion).await {
            Ok(receipt) => (receipt, None),
            Err(error) if error.code == "session_delete_partial" => {
                (error.details.clone().unwrap_or(Value::Null), Some(error))
            }
            Err(error) => {
                if error.code == "session_delete_active_run" {
                    return ApiResponse::error("conversation_session_active", error.message);
                }
                if error.code == "session_not_found" {
                    return ApiResponse::error("conversation_session_not_found", error.message);
                }
                return session_service_error(error);
            }
        };
    let deleted_ids = match deletion_cleanup_ids(&receipt, &session_id, partial_error.is_some()) {
        Ok(ids) => ids,
        Err(message) => {
            if let Some(mut error) = partial_error {
                error
                    .message
                    .push_str(&format!(" [Host cleanup skipped] {message}"));
                return session_service_error(error);
            }
            return ApiResponse::error("conversation_delete_receipt_invalid", message);
        }
    };
    let mut cleanup_errors = Vec::new();
    let mut cleaned_ids = Vec::new();
    for deleted_id in &deleted_ids {
        let errors_before = cleanup_errors.len();
        let owned_roots = {
            let mut gui = state.gui.lock().expect("gui state lock");
            if let Some(task) = gui.conversation_title_tasks.remove(deleted_id) {
                task.abort();
            }
            let path = gui.paths.catalog_store_path.clone();
            if let Err(error) = gui.conversation_catalog.remove_session(&path, deleted_id) {
                cleanup_errors.push(format!("{deleted_id} [catalog] {error}"));
            }
            [
                session_attachment_root(&gui.paths.attachment_store_root, deleted_id),
                session_attachment_root(&gui.paths.session_workdir_root, deleted_id),
            ]
        };
        if let Err(error) = state.local_agent.kernel.delete_session_outputs(deleted_id) {
            cleanup_errors.push(format!(
                "{deleted_id} [outputs] {}: {}",
                error.code, error.message
            ));
        }
        for root in owned_roots {
            if let Err(error) = fs::remove_dir_all(&root) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    cleanup_errors.push(format!(
                        "{deleted_id} [private directory {}] {error}",
                        root.display()
                    ));
                }
            }
        }
        if errors_before == cleanup_errors.len() {
            cleaned_ids.push(deleted_id.clone());
        }
    }
    if let Some(error) = partial_error.take() {
        return partial_deletion_response(error, &cleaned_ids, &cleanup_errors);
    }
    if !cleanup_errors.is_empty() {
        return ApiResponse::error(
            "conversation_delete_cleanup_failed",
            format!(
                "deletedSessionIds={}; hostCleanedSessionIds={}; {}",
                json!(deleted_ids),
                json!(cleaned_ids),
                cleanup_errors.join("; "),
            ),
        );
    }
    let gui = state.gui.lock().expect("gui state lock");
    visible_catalog_response(&gui, &state.local_agent.journal, false)
}

fn deletion_cleanup_ids(
    receipt: &Value,
    session_id: &str,
    partial: bool,
) -> Result<Vec<String>, String> {
    let read_ids = |field: &str| -> Result<Vec<String>, String> {
        let values = receipt
            .get(field)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Session 删除回执缺少 {field}。"))?;
        let mut unique = HashSet::new();
        values
            .iter()
            .map(|value| {
                let id = value
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or_else(|| format!("Session 删除回执 {field} 包含无效标识。"))?;
                if !unique.insert(id) {
                    return Err(format!("Session 删除回执 {field} 包含重复标识。"));
                }
                Ok(id.to_string())
            })
            .collect()
    };
    let deleted = read_ids("deletedSessionIds")?;
    if partial {
        let remaining = read_ids("remainingSessionIds")?;
        if deleted.is_empty()
            || !remaining.iter().any(|id| id == session_id)
            || deleted.iter().any(|id| remaining.contains(id))
        {
            return Err("Session 部分删除回执未明确区分已删除和剩余会话。".into());
        }
    } else if receipt["deleted"] != true || !deleted.iter().any(|id| id == session_id) {
        return Err("Session 删除回执未确认请求会话已删除。".into());
    }
    Ok(deleted)
}

fn partial_deletion_response(
    mut error: SessionServiceError,
    cleaned_ids: &[String],
    cleanup_errors: &[String],
) -> Json<ApiResponse> {
    // Only called after validating the structured Session deletion receipt.
    let details = error.details.as_mut().expect("validated deletion details");
    details["hostCleanedSessionIds"] = json!(cleaned_ids);
    if !cleanup_errors.is_empty() {
        details["hostCleanupErrors"] = json!(cleanup_errors);
        error
            .message
            .push_str(&format!(" [Host cleanup] {}", cleanup_errors.join("; ")));
    }
    session_service_error(error)
}

const INPUT_FILE_THRESHOLD: usize = 32 * 1024;

fn save_input_resource(
    state: &AppState,
    session_id: &str,
    input_id: &str,
    content: &str,
) -> Result<Value, String> {
    let mut display_name: String = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("粘贴的文本")
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if display_name.is_empty() {
        display_name = "粘贴的文本".to_string();
    }
    save_input_bytes(
        state,
        session_id,
        input_id,
        content.as_bytes(),
        "user-input.txt",
        &display_name,
        "text/plain",
        true,
    )
}

fn save_input_image(
    state: &AppState,
    session_id: &str,
    input_id: &str,
    content: &[u8],
    declared_media: &str,
) -> Result<Value, String> {
    let media_type = image_media_type(content)?;
    if media_type != declared_media {
        return Err("input_resource_media_type_mismatch".into());
    }
    let name = match media_type {
        "image/png" => "clipboard.png",
        "image/jpeg" => "clipboard.jpg",
        "image/gif" => "clipboard.gif",
        "image/webp" => "clipboard.webp",
        _ => unreachable!("image_media_type validates the supported formats"),
    };
    save_input_bytes(
        state, session_id, input_id, content, name, name, media_type, false,
    )
}

fn save_input_bytes(
    state: &AppState,
    session_id: &str,
    input_id: &str,
    content: &[u8],
    logical_path: &str,
    display_name: &str,
    media_type: &str,
    pasted_text: bool,
) -> Result<Value, String> {
    if !valid_id(session_id) || !valid_id(input_id) {
        return Err("input_resource_identity_invalid".into());
    }
    if content.len() as u64 > MAX_REFERENCE_FILE_BYTES {
        return Err("input_resource_capacity_exceeded: single input limit is 32 MiB".into());
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = &gui.conversation_catalog_error {
        return Err(error.clone());
    }
    if gui.conversation_catalog.session(session_id).is_none() {
        return Err("conversation_session_not_found".into());
    }
    let key = json!([session_id, input_id]).to_string();
    let key_hash = deepcode_kernel_tools::hash_bytes(key.as_bytes());
    let reference_id = format!("input-{key_hash}");
    let workspace_id = format!("input-workspace-{key_hash}");
    let root = session_attachment_root(&gui.paths.attachment_store_root, session_id)
        .join(reference_storage_segment(&reference_id));
    let target = root.join(logical_path);
    if target.exists() {
        let existing = fs::read(&target).map_err(|error| error.to_string())?;
        if existing != content {
            return Err("input_resource_identity_conflict".into());
        }
    } else {
        if root.exists() {
            return Err("input_resource_identity_conflict".into());
        }
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let result = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .and_then(|mut file| {
                file.write_all(content)?;
                file.sync_all()
            });
        if let Err(error) = result {
            cleanup_created_snapshot_roots(&[root]);
            return Err(error.to_string());
        }
    }
    if gui.conversation_catalog.workspace(&workspace_id).is_none() {
        let canonical_root = fs::canonicalize(&root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .to_string();
        let workspace = ConversationWorkspaceRecord {
            workspace_id: workspace_id.clone(),
            display_name: display_name.to_string(),
            canonical_root,
            owner_session_id: Some(session_id.to_string()),
            session_workdir: false,
            created_at: crate::now_text(),
        };
        if let Err(error) = persist_catalog_rows(&mut gui, vec![workspace], None, None) {
            cleanup_created_snapshot_roots(&[root]);
            return Err(error);
        }
    }
    let mut reference = json!({
        "referenceId": reference_id, "workspaceId": workspace_id, "logicalPath": logical_path,
        "displayName": display_name, "kind": "file", "mediaType": media_type, "byteLength": content.len(),
    });
    if pasted_text {
        reference["source"] = json!("pastedText");
    }
    Ok(json!({ "text": "", "reference": reference }))
}

pub(crate) async fn conversation_input_upload(
    State(state): State<AppState>,
    Path((session_id, input_id)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
    body: Result<axum::body::Bytes, axum::extract::rejection::BytesRejection>,
) -> Json<ApiResponse> {
    let body = match body {
        Ok(body) => body,
        Err(error) if error.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiResponse::error(
                "input_resource_capacity_exceeded",
                "单条输入超过 32 MiB 接纳限额；原文未被截断或提交。",
            );
        }
        Err(error) => {
            return ApiResponse::error("input_resource_body_read_failed", error.to_string())
        }
    };
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/plain")
        .split(';')
        .next()
        .unwrap_or("text/plain")
        .trim();
    let saved = if media_type.starts_with("image/") {
        save_input_image(&state, &session_id, &input_id, &body, media_type)
    } else {
        let content = match std::str::from_utf8(&body) {
            Ok(content) => content,
            Err(error) => {
                return ApiResponse::error("input_resource_invalid_utf8", &error.to_string())
            }
        };
        save_input_resource(&state, &session_id, &input_id, content)
    };
    match saved {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => ApiResponse::error("input_resource_save_failed", &error),
    }
}

pub(crate) async fn conversation_command_submit(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(mut command): Json<Value>,
) -> Json<ApiResponse> {
    if command.get("sessionId").and_then(Value::as_str) != Some(&session_id) {
        return ApiResponse::error("session_identity_mismatch", "命令 sessionId 与路径不一致。");
    }
    let input_field = match command["type"].as_str() {
        Some("message.submit") => Some("text"),
        Some("context.focus") => Some("task"),
        _ => None,
    };
    let title_input = input_field.map(|field| {
        command[field]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(8_000)
            .collect::<String>()
    });
    if let Some(field) = input_field {
        if command
            .get("filesystemReferences")
            .is_some_and(|value| !value.is_array())
        {
            return ApiResponse::error(
                "filesystem_reference_invalid",
                "filesystemReferences 必须是数组。",
            );
        }
        if let Some(content) = command[field]
            .as_str()
            .filter(|content| content.len() > INPUT_FILE_THRESHOLD)
        {
            let input_id = match command["commandId"].as_str() {
                Some(id) => id,
                None => return ApiResponse::error("command_identity_missing", "缺少 commandId。"),
            };
            let saved = match save_input_resource(&state, &session_id, input_id, content) {
                Ok(value) => value,
                Err(error) => return ApiResponse::error("input_resource_save_failed", &error),
            };
            command[field] = if field == "task" {
                json!("请依据本条消息的粘贴文本聚焦上下文。")
            } else {
                json!("")
            };
            let mut references = command["filesystemReferences"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            references.push(saved["reference"].clone());
            command["filesystemReferences"] = json!(references);
        }
    }
    if command.get("type").and_then(Value::as_str) == Some("session.directory-index.attach") {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if let Err((code, message)) = validate_directory_index_attach_command(
            &gui.conversation_catalog,
            &session_id,
            &command,
        ) {
            return ApiResponse::error(code, message);
        }
    }
    if matches!(
        command.get("type").and_then(Value::as_str),
        Some("message.submit" | "context.focus")
    ) {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if let Err((code, message)) =
            validate_message_filesystem_references(&gui.conversation_catalog, &session_id, &command)
        {
            return ApiResponse::error(code, message);
        }
        if let Err((code, message)) =
            validate_required_filesystem_plugins(&gui.user_settings, &command)
        {
            return ApiResponse::error(code, message);
        }
    }
    if input_field.is_some() {
        let project_id = {
            let gui = state.gui.lock().expect("gui state lock");
            gui.conversation_catalog
                .session(&session_id)
                .and_then(|session| session.project_id.clone())
        };
        if let Some(project_id) = project_id {
            if let Err(error) =
                sync_project_workspaces(&state, &project_id, Some(&session_id)).await
            {
                return session_service_error(error);
            }
        }
        if let Err(error) = ensure_session_workdir(&state, &session_id).await {
            return session_service_error(error);
        }
    }
    if command["type"] == "session.workspaces.set" {
        return ApiResponse::error(
            "project_workspace_management_required",
            "请通过项目工作区管理修改基础目录。",
        );
    }
    if command["type"] == "plan.respond" && command["response"]["kind"] == "confirm" {
        if let Err(error) = confirm_plan_workspaces(&state, &session_id, &command).await {
            return session_service_error(error);
        }
    }
    let reply = match request_service(
        state.session_service.clone(),
        "submit",
        json!({ "command": command.clone() }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) == Some("accepted") {
        let submitted_task = matches!(
            command["type"].as_str(),
            Some("message.submit" | "context.focus")
        );
        let chosen_profile = if submitted_task {
            match request_service(
                state.session_service.clone(),
                "snapshot",
                json!({"sessionId":session_id}),
            )
            .await
            {
                Ok(projection) => projection["modelSettings"]["profileId"]
                    .as_str()
                    .map(str::to_string),
                Err(error) => return session_service_error(error),
            }
        } else {
            None
        };
        if let (Some(text), Some(profile_id), Some(command_id)) = (
            title_input.as_deref(),
            chosen_profile.as_deref(),
            command["commandId"].as_str(),
        ) {
            if let Err(error) = schedule_conversation_title(
                &state,
                &session_id,
                command_id,
                profile_id,
                text,
                &command["filesystemReferences"],
            ) {
                eprintln!("[conversation-title] session={session_id} command={command_id} {error}");
            }
        }
        if let Some(profile_id) = chosen_profile.as_deref() {
            let result = (|| {
                let _transition = state.local_agent.runtime_transition()?;
                let mut gui = state.gui.lock().expect("gui state lock");
                let path = gui.paths.llm_profiles_path.clone();
                gui.llm_profiles.select_default(&path, profile_id)
            })();
            if let Err(error) = result {
                return ApiResponse::error_with_data(
                    "select_default_llm_profile_failed",
                    error,
                    reply,
                );
            }
        }
    }
    if reply.get("status").and_then(Value::as_str) != Some("rejected") {
        let automatic_title = command
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| matches!(*kind, "message.submit" | "context.focus"))
            .and_then(|kind| {
                command
                    .get(if kind == "message.submit" {
                        "text"
                    } else {
                        "task"
                    })
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .or_else(|| command["filesystemReferences"][0]["displayName"].as_str())
            })
            .map(automatic_conversation_title);
        let active_profile_id = command
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| matches!(*kind, "message.submit" | "context.focus"))
            .and_then(|_| command.get("profileId"))
            .and_then(Value::as_str);
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog_error.is_none() {
            if let Some(mut session) = gui.conversation_catalog.session(&session_id).cloned() {
                if session.title == "新对话"
                    && session.title_source == Some(ConversationTitleSource::Initial)
                {
                    if let Some(title) = automatic_title.filter(|title| !title.is_empty()) {
                        session.title = title;
                    }
                }
                if let Some(profile_id) = active_profile_id {
                    session.profile_id = Some(profile_id.into());
                }
                session.updated_at = crate::now_text();
                if let Err(error) = persist_catalog_rows(&mut gui, Vec::new(), None, Some(session))
                {
                    eprintln!("[conversation-catalog] {error}");
                }
            }
        }
    }
    ApiResponse::ok(reply)
}

/// Joining a directory is a user decision attached to this exact pending Plan.
async fn confirm_plan_workspaces(
    state: &AppState,
    session_id: &str,
    command: &Value,
) -> Result<(), SessionServiceError> {
    let projection = request_service(
        state.session_service.clone(),
        "snapshot",
        json!({"sessionId":session_id}),
    )
    .await?;
    let plan = &projection["pendingPlan"];
    // Ordinary confirmations and replay remain owned by Session's command admission.
    let Some(requests) = plan["workspaceRequests"]
        .as_array()
        .filter(|requests| !requests.is_empty())
    else {
        return Ok(());
    };
    if command["schemaVersion"] != "deepcode.command.v3"
        || !command["commandId"].as_str().is_some_and(valid_id)
    {
        return Err(SessionServiceError::new(
            "conversation_command_invalid",
            "计划确认命令无效。",
        ));
    }
    if plan["planId"] != command["planId"]
        || plan["revision"] != command["revision"]
        || plan["runId"] != command["runId"]
    {
        return Err(SessionServiceError::new(
            "plan_response_stale",
            "该计划已关闭或发生变化。",
        ));
    }
    let (project_id, mut roots, bindings) = {
        let gui = state.gui.lock().expect("gui state lock");
        let session = gui
            .conversation_catalog
            .session(session_id)
            .ok_or_else(|| {
                SessionServiceError::new("conversation_session_not_found", "会话不存在。")
            })?;
        let mut bindings = Vec::new();
        for request in requests {
            let workspace = request["workspaceId"]
                .as_str()
                .and_then(|id| gui.conversation_catalog.workspace(id))
                .filter(|workspace| {
                    workspace.owner_session_id.is_none()
                        && request["rootPath"] == workspace.canonical_root
                })
                .ok_or_else(|| {
                    SessionServiceError::new(
                        "plan_workspace_request_changed",
                        "待加入目录已变化，请重新提交计划。",
                    )
                })?;
            bindings.push((
                WorkspaceBindingDisplayRecord {
                    workspace_id: workspace.workspace_id.clone(),
                    display_name: workspace.display_name.clone(),
                },
                workspace.canonical_root.clone(),
            ));
        }
        let roots = if let Some(project_id) = &session.project_id {
            let project = gui
                .conversation_catalog
                .project(project_id)
                .ok_or_else(|| {
                    SessionServiceError::new("conversation_project_not_found", "项目不存在。")
                })?;
            project
                .workspace_ids
                .iter()
                .map(|id| {
                    gui.conversation_catalog
                        .workspace(id)
                        .map(|workspace| workspace.canonical_root.clone())
                        .ok_or_else(|| {
                            SessionServiceError::new(
                                "conversation_workspace_not_found",
                                "工作区目录不存在。",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        (session.project_id.clone(), roots, bindings)
    };
    if let Some(project_id) = project_id {
        for (_, root) in &bindings {
            if !roots.contains(root) {
                roots.push(root.clone());
            }
        }
        let response = conversation_project_update(
            State(state.clone()),
            Path(project_id),
            Json(UpdateConversationProjectRequest {
                title: None,
                workspace_paths: Some(roots),
            }),
        )
        .await
        .0;
        if !response.ok {
            return Err(SessionServiceError::new(
                response
                    .error
                    .unwrap_or_else(|| "project_workspace_update_failed".into()),
                response.message.unwrap_or_default(),
            ));
        }
    } else {
        for (binding, _) in bindings {
            if projection["workspaceBindings"]
                .as_array()
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["workspaceId"] == binding.workspace_id)
                })
            {
                continue;
            }
            let reply = request_service(state.session_service.clone(), "submit", json!({"command":{
                "schemaVersion":"deepcode.command.v3", "type":"session.directory-index.attach", "sessionId":session_id,
                "commandId":random_id("workspace-confirm")?, "workspaceBinding":binding,
            }})).await?;
            require_workspace_command(&reply)?;
        }
    }
    Ok(())
}

fn title_request_excerpt(text: &str, pasted_paths: &[PathBuf]) -> Result<String, String> {
    let mut excerpt: String = text.chars().take(8_000).collect();
    for path in pasted_paths {
        let remaining = 8_000usize.saturating_sub(excerpt.chars().count());
        if remaining <= 1 {
            break;
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .and_then(|file| file.take((remaining * 4) as u64).read_to_end(&mut bytes))
            .map_err(|error| format!("conversation_title_input_read_failed: {error}"))?;
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            // The bounded byte read can end between UTF-8 code points.
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()]).expect("validated UTF-8 prefix")
            }
            Err(error) => return Err(format!("conversation_title_input_invalid: {error}")),
        };
        excerpt.push('\n');
        excerpt.extend(text.chars().take(remaining - 1));
    }
    if excerpt.trim().is_empty() {
        return Err("conversation_title_input_empty".into());
    }
    Ok(format!(
        "First user message (excerpt, at most 8,000 characters):\n{excerpt}"
    ))
}

/// Title generation is Host metadata work; it never joins or advances the Session loop.
fn schedule_conversation_title(
    state: &AppState,
    session_id: &str,
    command_id: &str,
    profile_id: &str,
    text: &str,
    filesystem_references: &Value,
) -> Result<(), String> {
    if state
        .local_agent
        .journal
        .first_input_command_id(session_id)
        .map_err(|error| format!("{}: {}", error.code, error.message))?
        .as_deref()
        != Some(command_id)
    {
        return Ok(());
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if gui
        .conversation_catalog
        .session(session_id)
        .is_none_or(|session| session.title_source != Some(ConversationTitleSource::Initial))
        || gui.conversation_title_tasks.contains_key(session_id)
    {
        return Ok(());
    }
    // Only Host-owned pasted text is part of the submitted message. Other attachments
    // remain addresses, and are never silently opened by this auxiliary request.
    let pasted_paths = filesystem_references
        .as_array()
        .into_iter()
        .flatten()
        .filter(|reference| reference["source"] == "pastedText")
        .map(|reference| {
            let workspace = reference["workspaceId"]
                .as_str()
                .and_then(|id| gui.conversation_catalog.workspace(id))
                .filter(|workspace| workspace.owner_session_id.as_deref() == Some(session_id))
                .ok_or_else(|| "conversation_title_pasted_input_unavailable".to_string())?;
            Ok(PathBuf::from(&workspace.canonical_root).join("user-input.txt"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let text = if text.trim().is_empty() && pasted_paths.is_empty() {
        filesystem_references[0]["displayName"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    } else {
        text.to_string()
    };
    let mut profile = crate::resolve_llm_profile(&gui, Some(profile_id))?;
    let request_id = crate::new_runtime_ref("conversation-title")?;
    let state = state.clone();
    let session_id = session_id.to_string();
    let key = session_id.clone();
    let profile_id = profile_id.to_string();
    let task = tokio::spawn(async move {
        let result = async {
            let text =
                tokio::task::spawn_blocking(move || title_request_excerpt(&text, &pasted_paths))
                    .await
                    .map_err(|error| format!("conversation_title_input_failed: {error}"))??;
            crate::model_auth::authorize(&state, &mut profile)
                .await
                .map_err(|error| format!("provider_authentication_failed: {error}"))?;
            let mut usage = state
                .model_usage
                .begin(
                    &profile,
                    &json!({
                        "profileId": profile_id, "sessionId": session_id,
                        "requestId": request_id, "purpose": "conversationTitle",
                    }),
                )
                .map_err(|error| format!("usage_record_failed: {error}"))?;
            crate::llm_transport::generate_conversation_title(
                &state.local_agent.provider_transport.client,
                &profile,
                &session_id,
                &request_id,
                &text,
                &mut usage,
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.safe_message()))
        }
        .await;
        let mut gui = state.gui.lock().expect("gui state lock");
        match result {
            Ok(title) => {
                let path = gui.paths.catalog_store_path.clone();
                if let Err(error) =
                    gui.conversation_catalog
                        .set_generated_title(&path, &session_id, title)
                {
                    eprintln!("[conversation-title] session={session_id} request={request_id} conversation_catalog_write_failed: {error}");
                }
            }
            Err(error) => {
                eprintln!("[conversation-title] session={session_id} request={request_id} {error}")
            }
        }
        gui.conversation_title_tasks.remove(&session_id);
    });
    gui.conversation_title_tasks.insert(key, task);
    Ok(())
}

pub(crate) async fn shutdown_conversation_titles(state: &AppState) {
    let tasks: Vec<_> = state
        .gui
        .lock()
        .expect("gui state lock")
        .conversation_title_tasks
        .drain()
        .map(|(_, task)| task)
        .collect();
    for task in &tasks {
        task.abort();
    }
    for task in tasks {
        let _ = task.await;
    }
}

/// Register and bind the Host-owned working directory before the next run freezes
/// its workspace list. A directory-index event leaves any active run unchanged.
async fn ensure_session_workdir(
    state: &AppState,
    session_id: &str,
) -> Result<(), SessionServiceError> {
    let binding = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = &gui.conversation_catalog_error {
            return Err(SessionServiceError::new(
                "conversation_catalog_unavailable",
                error,
            ));
        }
        let (binding, workspace) = prepare_session_workdir(
            &gui.conversation_catalog,
            &gui.paths.session_workdir_root,
            session_id,
        )?;
        if let Some(workspace) = workspace {
            persist_catalog_rows(&mut gui, vec![workspace], None, None).map_err(|error| {
                SessionServiceError::new("conversation_catalog_write_failed", error)
            })?;
        }
        binding
    };
    let snapshot = request_service(
        state.session_service.clone(),
        "snapshot",
        json!({"sessionId":session_id}),
    )
    .await?;
    if snapshot["workspaceBindings"]
        .as_array()
        .is_some_and(|bindings| {
            bindings
                .iter()
                .any(|candidate| candidate["workspaceId"] == binding.workspace_id)
        })
    {
        return Ok(());
    }
    let reply = request_service(
        state.session_service.clone(),
        "submit",
        json!({"command":{
            "schemaVersion":"deepcode.command.v3", "type":"session.directory-index.attach",
            "commandId": random_id("command")?, "sessionId":session_id, "workspaceBinding":binding
        }}),
    )
    .await?;
    if reply["status"] != "accepted" {
        return Err(SessionServiceError::new(
            "session_workdir_attach_failed",
            reply.to_string(),
        ));
    }
    Ok(())
}

fn prepare_session_workdir(
    catalog: &ConversationCatalog,
    root: &FsPath,
    session_id: &str,
) -> Result<
    (
        WorkspaceBindingDisplayRecord,
        Option<ConversationWorkspaceRecord>,
    ),
    SessionServiceError,
> {
    if catalog.session(session_id).is_none() {
        return Err(SessionServiceError::new(
            "conversation_session_not_found",
            "对话不存在。",
        ));
    }
    if let Some(workspace) = catalog.workspaces.iter().find(|workspace| {
        workspace.session_workdir && workspace.owner_session_id.as_deref() == Some(session_id)
    }) {
        if !FsPath::new(&workspace.canonical_root).is_dir() {
            return Err(SessionServiceError::new(
                "session_workdir_unavailable",
                "会话工作目录不可用。",
            ));
        }
        return Ok((
            WorkspaceBindingDisplayRecord {
                workspace_id: workspace.workspace_id.clone(),
                display_name: workspace.display_name.clone(),
            },
            None,
        ));
    }
    let path = session_attachment_root(root, session_id);
    fs::create_dir_all(&path).map_err(|error| {
        SessionServiceError::new("session_workdir_create_failed", error.to_string())
    })?;
    let canonical_root = canonical_folder_path(&path.to_string_lossy())
        .map_err(|error| SessionServiceError::new("session_workdir_create_failed", error))?;
    let binding = WorkspaceBindingDisplayRecord {
        workspace_id: random_id("workspace")?,
        display_name: "会话工作目录（DeepCode 管理，跨轮保留）".into(),
    };
    let workspace = ConversationWorkspaceRecord {
        workspace_id: binding.workspace_id.clone(),
        display_name: binding.display_name.clone(),
        canonical_root,
        owner_session_id: Some(session_id.into()),
        session_workdir: true,
        created_at: crate::now_text(),
    };
    Ok((binding, Some(workspace)))
}

pub(crate) async fn conversation_projection_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(mut value) => match state
            .local_agent
            .journal
            .project_permissions(&session_id, &mut value)
        {
            Ok(()) => ApiResponse::ok(value),
            Err(error) => ApiResponse::error(error.code, error.message),
        },
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_context_composition_get(
    State(state): State<AppState>,
    Path((session_id, provider_request_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    match request_service(
        state.session_service,
        "contextComposition",
        json!({ "sessionId": session_id, "providerRequestId": provider_request_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn request_service(
    service: SessionServiceProcess,
    operation: &'static str,
    data: Value,
) -> Result<Value, SessionServiceError> {
    tokio::task::spawn_blocking(move || service.request(operation, data))
        .await
        .map_err(|error| {
            SessionServiceError::new(
                "session_service_join_failed",
                format!("Session Service 请求任务结束异常：{error}"),
            )
        })?
}

pub(crate) fn session_service_error(error: SessionServiceError) -> Json<ApiResponse> {
    match error.details {
        Some(details) => ApiResponse::error_with_data(error.code, error.message, details),
        None => ApiResponse::error(error.code, error.message),
    }
}

fn persist_catalog_rows(
    gui: &mut crate::GuiState,
    workspaces: Vec<ConversationWorkspaceRecord>,
    project: Option<ConversationProjectRecord>,
    session: Option<ConversationSessionRecord>,
) -> Result<(), String> {
    gui.conversation_catalog
        .write_rows(&gui.paths.catalog_store_path, workspaces, project, session)
}

fn canonical_roots(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > 32 {
        return Err("一个项目或 Session 最多绑定 32 个工作目录。".to_string());
    }
    let mut seen = HashSet::new();
    let mut roots = Vec::with_capacity(paths.len());
    for path in paths {
        let root = canonical_folder_path(path)?;
        if seen.insert(root.clone()) {
            roots.push(root);
        }
    }
    Ok(roots)
}

fn resolve_filesystem_references(
    catalog: &ConversationCatalog,
    workspaces: &mut Vec<ConversationWorkspaceRecord>,
    inputs: &[FilesystemReferencePathInput],
    now: &str,
) -> Result<Vec<Value>, (&'static str, String)> {
    let mut references = Vec::with_capacity(inputs.len());
    let mut seen_sources = HashSet::new();
    let mut total_file_bytes = 0u64;
    for input in inputs {
        match input.kind.as_str() {
            "directory" => {
                let canonical_root = canonical_folder_path(&input.path)
                    .map_err(|message| ("conversation_filesystem_reference_invalid", message))?;
                if !seen_sources.insert(format!("directory\0{canonical_root}")) {
                    return Err((
                        "conversation_filesystem_reference_duplicate",
                        "同一目录不能在一条消息中重复附加。".to_string(),
                    ));
                }
                let workspace_ids = prepare_roots(catalog, workspaces, vec![canonical_root], now)
                    .map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                let binding = binding_snapshot(catalog, workspaces, &workspace_ids)
                    .into_iter()
                    .next()
                    .ok_or((
                        "conversation_workspace_not_found",
                        "Host 未能登记目录引用。".to_string(),
                    ))?;
                let reference_id = random_id("filesystem-reference").map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                references.push(json!({
                    "referenceId": reference_id,
                    "workspaceId": binding.workspace_id,
                    "logicalPath": ".",
                    "displayName": binding.display_name,
                    "kind": "directory",
                }));
            }
            "file" => {
                let source = fs::canonicalize(&input.path).map_err(|error| {
                    (
                        "conversation_filesystem_reference_invalid",
                        format!("本地文件不可用：{error}"),
                    )
                })?;
                let metadata = source.metadata().map_err(|error| {
                    (
                        "conversation_filesystem_reference_invalid",
                        format!("读取本地文件元数据失败：{error}"),
                    )
                })?;
                if !metadata.is_file() {
                    return Err((
                        "conversation_filesystem_reference_invalid",
                        "文件引用必须指向普通文件。".to_string(),
                    ));
                }
                if metadata.len() > MAX_REFERENCE_FILE_BYTES {
                    return Err((
                        "conversation_filesystem_reference_too_large",
                        format!("单个文件引用不能超过 {} 字节。", MAX_REFERENCE_FILE_BYTES),
                    ));
                }
                total_file_bytes = total_file_bytes.checked_add(metadata.len()).ok_or((
                    "conversation_filesystem_reference_too_large",
                    "文件引用总大小溢出。".to_string(),
                ))?;
                if total_file_bytes > MAX_REFERENCE_TOTAL_BYTES {
                    return Err((
                        "conversation_filesystem_reference_too_large",
                        format!(
                            "单条消息的文件引用总计不能超过 {} 字节。",
                            MAX_REFERENCE_TOTAL_BYTES
                        ),
                    ));
                }
                let canonical_source = source.to_string_lossy().to_string();
                if !seen_sources.insert(format!("file\0{canonical_source}")) {
                    return Err((
                        "conversation_filesystem_reference_duplicate",
                        "同一文件不能在一条消息中重复附加。".to_string(),
                    ));
                }
                let file_name = source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.trim().is_empty())
                    .ok_or((
                        "conversation_filesystem_reference_invalid",
                        "文件名不是有效 UTF-8。".to_string(),
                    ))?
                    .to_string();
                let reference_id = random_id("filesystem-reference").map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                // Catalog roots locate objects. Only the Session's project bindings
                // grant the Kernel a default workspace scope.
                let parent = source.parent().ok_or((
                    "conversation_filesystem_reference_invalid",
                    "文件引用缺少父目录。".to_string(),
                ))?;
                let workspace_ids = prepare_roots(
                    catalog,
                    workspaces,
                    vec![parent.to_string_lossy().to_string()],
                    now,
                )
                .map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                let display_name = bounded_display_name(&file_name);
                let media_type = filesystem_reference_media_type(&source);
                references.push(json!({
                    "referenceId": reference_id,
                    "workspaceId": workspace_ids[0],
                    "logicalPath": file_name,
                    "displayName": display_name,
                    "kind": "file",
                    "mediaType": media_type,
                    "byteLength": metadata.len(),
                }));
            }
            _ => {
                return Err((
                    "conversation_filesystem_reference_kind_invalid",
                    "文件系统引用 kind 必须是 file 或 directory。".to_string(),
                ))
            }
        }
    }
    Ok(references)
}

fn cleanup_created_snapshot_roots(roots: &[PathBuf]) {
    for root in roots.iter().rev() {
        if let Err(error) = fs::remove_dir_all(root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[conversation-filesystem-reference-cleanup] {error}");
            }
        }
    }
}

fn session_attachment_root(root: &FsPath, session_id: &str) -> PathBuf {
    root.join(reference_storage_segment(session_id))
}

fn reference_storage_segment(value: &str) -> String {
    let hash = deepcode_kernel_tools::hash_bytes(value.as_bytes());
    if cfg!(windows) {
        hash.replace(':', "-")
    } else {
        // Retain existing on-disk paths on platforms that allow colons.
        hash
    }
}

fn bounded_display_name(value: &str) -> String {
    value.chars().take(120).collect()
}

fn filesystem_reference_media_type(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "md" | "mdx" => "text/markdown",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "xml" | "svg" => "application/xml",
        "txt" | "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" | "rs" | "py" | "java"
        | "go" | "sh" | "zsh" | "bash" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn prepare_roots(
    catalog: &ConversationCatalog,
    workspaces: &mut Vec<ConversationWorkspaceRecord>,
    roots: Vec<String>,
    now: &str,
) -> Result<Vec<String>, SessionServiceError> {
    let mut workspace_ids = Vec::with_capacity(roots.len());
    for root in roots {
        if let Some(workspace) = catalog.workspace_by_root(&root).or_else(|| {
            workspaces
                .iter()
                .find(|workspace| workspace.canonical_root == root)
        }) {
            workspace_ids.push(workspace.workspace_id.clone());
            continue;
        }
        let workspace_id = random_id("workspace")?;
        workspaces.push(ConversationWorkspaceRecord {
            workspace_id: workspace_id.clone(),
            display_name: workspace_display_name(&root),
            canonical_root: root,
            owner_session_id: None,
            session_workdir: false,
            created_at: now.to_string(),
        });
        workspace_ids.push(workspace_id);
    }
    Ok(workspace_ids)
}

fn binding_snapshot(
    catalog: &ConversationCatalog,
    workspaces: &[ConversationWorkspaceRecord],
    workspace_ids: &[String],
) -> Vec<WorkspaceBindingDisplayRecord> {
    workspace_ids
        .iter()
        .filter_map(|workspace_id| {
            catalog.workspace(workspace_id).or_else(|| {
                workspaces
                    .iter()
                    .find(|workspace| &workspace.workspace_id == workspace_id)
            })
        })
        .map(|workspace| WorkspaceBindingDisplayRecord {
            workspace_id: workspace.workspace_id.clone(),
            display_name: workspace.display_name.clone(),
        })
        .collect()
}

pub(crate) fn projection_references_workspace(projection: &Value, workspace_id: &str) -> bool {
    let bindings_contain = |value: Option<&Value>| {
        value.and_then(Value::as_array).is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("workspaceId").and_then(Value::as_str) == Some(workspace_id)
            })
        })
    };
    bindings_contain(projection.get("workspaceBindings"))
        || projection
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages
                    .iter()
                    .any(|message| bindings_contain(message.get("filesystemReferences")))
            })
}

fn validate_message_filesystem_references(
    catalog: &ConversationCatalog,
    session_id: &str,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    catalog
        .session(session_id)
        .ok_or(("conversation_session_not_found", "对话不存在。".to_string()))?;
    let Some(value) = command.get("filesystemReferences") else {
        return Ok(());
    };
    let references = value.as_array().ok_or((
        "conversation_filesystem_references_invalid",
        "filesystemReferences 必须是数组。".to_string(),
    ))?;
    if references.len() > MAX_MESSAGE_FILESYSTEM_REFERENCES {
        return Err((
            "conversation_filesystem_references_invalid",
            "单次消息最多附加八个文件系统引用。".to_string(),
        ));
    }
    let mut reference_ids = HashSet::new();
    let mut targets = HashSet::new();
    for reference in references {
        let object = reference.as_object().ok_or((
            "conversation_filesystem_reference_invalid",
            "文件系统引用必须是对象。".to_string(),
        ))?;
        let reference_id = reference
            .get("referenceId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 referenceId。".to_string(),
            ))?;
        let workspace_id = reference
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 workspaceId。".to_string(),
            ))?;
        let logical_path = reference
            .get("logicalPath")
            .and_then(Value::as_str)
            .filter(|value| valid_reference_logical_path(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 logicalPath。".to_string(),
            ))?;
        let display_name = reference
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少 displayName。".to_string(),
            ))?;
        let kind = reference.get("kind").and_then(Value::as_str).ok_or((
            "conversation_filesystem_reference_invalid",
            "文件系统引用缺少 kind。".to_string(),
        ))?;
        let workspace = catalog.workspace(workspace_id).ok_or((
            "conversation_filesystem_reference_not_found",
            "文件系统引用不在 Host workspace catalog 中。".to_string(),
        ))?;
        if !reference_ids.insert(reference_id)
            || !targets.insert(format!("{workspace_id}\0{logical_path}"))
        {
            return Err((
                "conversation_filesystem_reference_mismatch",
                "文件系统引用与 Host workspace catalog 不一致或重复。".to_string(),
            ));
        }
        let target = resolve_catalog_reference_path(workspace, logical_path)?;
        match kind {
            "directory" => {
                if object.len() != 5
                    || logical_path != "."
                    || workspace.display_name != display_name
                    || workspace.owner_session_id.is_some()
                    || !target.is_dir()
                {
                    return Err((
                        "conversation_filesystem_reference_mismatch",
                        "目录引用与 Host 登记事实不一致。".to_string(),
                    ));
                }
            }
            "file" => {
                let media_type = reference
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or((
                        "conversation_filesystem_reference_invalid",
                        "文件引用缺少 mediaType。".to_string(),
                    ))?;
                let byte_length = reference.get("byteLength").and_then(Value::as_u64).ok_or((
                    "conversation_filesystem_reference_invalid",
                    "文件引用缺少 byteLength。".to_string(),
                ))?;
                let metadata = target.metadata().map_err(|error| {
                    (
                        "conversation_filesystem_reference_unavailable",
                        format!("读取文件引用元数据失败：{error}"),
                    )
                })?;
                let pasted = reference.get("source").is_some();
                if (pasted && reference["source"] != "pastedText")
                    || object.len() != if pasted { 8 } else { 7 }
                    || logical_path == "."
                    || workspace
                        .owner_session_id
                        .as_deref()
                        .is_some_and(|owner| owner != session_id)
                    || (pasted
                        && (workspace.owner_session_id.as_deref() != Some(session_id)
                            || workspace.session_workdir))
                    || !metadata.is_file()
                    || (pasted && metadata.len() != byte_length)
                    || (pasted && workspace.display_name != display_name)
                    || (!pasted
                        && target
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(bounded_display_name)
                            .as_deref()
                            != Some(display_name))
                    || filesystem_reference_media_type(&target) != media_type
                {
                    return Err((
                        "conversation_filesystem_reference_mismatch",
                        "文件引用与 Host 登记对象不一致。".to_string(),
                    ));
                }
            }
            _ => {
                return Err((
                    "conversation_filesystem_reference_kind_invalid",
                    "文件系统引用 kind 必须是 file 或 directory。".to_string(),
                ))
            }
        }
    }
    Ok(())
}

fn valid_reference_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    if value == "." {
        return true;
    }
    !value.starts_with('/')
        && !value.ends_with('/')
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn resolve_catalog_reference_path(
    workspace: &ConversationWorkspaceRecord,
    logical_path: &str,
) -> Result<PathBuf, (&'static str, String)> {
    let canonical_root = fs::canonicalize(&workspace.canonical_root).map_err(|error| {
        (
            "conversation_filesystem_reference_unavailable",
            format!("Host workspace 根不可用：{error}"),
        )
    })?;
    let requested = if logical_path == "." {
        canonical_root.clone()
    } else {
        canonical_root.join(logical_path)
    };
    let canonical = fs::canonicalize(requested).map_err(|error| {
        (
            "conversation_filesystem_reference_unavailable",
            format!("Host 文件系统引用不可用：{error}"),
        )
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err((
            "conversation_filesystem_reference_escape",
            "文件系统引用逃逸 Host workspace 根。".to_string(),
        ));
    }
    Ok(canonical)
}

fn validate_required_filesystem_plugins(
    settings: &Value,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    let selected_uris = command
        .get("pluginSelections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|selection| selection.get("uri").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let Some(references) = command
        .get("filesystemReferences")
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    for media_type in references.iter().filter_map(|reference| {
        (reference.get("kind").and_then(Value::as_str) == Some("file"))
            .then(|| reference.get("mediaType").and_then(Value::as_str))
            .flatten()
    }) {
        let required_uri =
            crate::local_agent_plugins::plugin_uri_for_activation_media_type(settings, media_type)
                .map_err(|message| ("plugin_catalog_unavailable", message))?;
        if media_type == "application/pdf" && required_uri.is_none() {
            return Err((
                "plugin_selection_unavailable",
                "PDF 文件引用需要一个声明 application/pdf 激活类型的可用插件。".to_string(),
            ));
        }
        if let Some(uri) = required_uri {
            if !selected_uris.contains(uri.as_str()) {
                return Err((
                    "plugin_selection_required",
                    format!("文件类型 {media_type} 需要显式选择插件 {uri}。"),
                ));
            }
        }
    }
    Ok(())
}

fn validate_directory_index_attach_command(
    catalog: &ConversationCatalog,
    session_id: &str,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    catalog
        .session(session_id)
        .ok_or(("conversation_session_not_found", "对话不存在。".to_string()))?;
    let binding = command
        .get("workspaceBinding")
        .and_then(Value::as_object)
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令缺少 Host 登记的 workspaceBinding。".to_string(),
        ))?;
    let workspace_id = binding
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value))
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令 workspaceId 无效。".to_string(),
        ))?;
    let display_name = binding
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令 displayName 无效。".to_string(),
        ))?;
    let workspace = catalog.workspace(workspace_id).ok_or((
        "conversation_workspace_not_found",
        "目录索引尚未由 Host 登记。".to_string(),
    ))?;
    if workspace.display_name != display_name {
        return Err((
            "conversation_directory_index_binding_mismatch",
            "目录索引显示身份与 Host Catalog 不一致。".to_string(),
        ));
    }
    Ok(())
}

fn selected_profile_id(
    gui: &crate::GuiState,
    requested: Option<&str>,
) -> Result<String, (&'static str, String)> {
    let configured_profiles = gui
        .llm_profiles
        .usable()
        .map_err(|error| ("llm_profile_store_invalid", error))?;
    let profiles = configured_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .expect("validated LLM profile store");
    let selected = requested
        .or_else(|| {
            configured_profiles
                .get("defaultProfileId")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|profile| crate::llm_profile_value_is_enabled(profile))
                .and_then(|profile| profile.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or((
            "llm_profile_unavailable",
            "没有可用于新对话的模型 Profile。".to_string(),
        ))?;
    let enabled = profiles.iter().any(|profile| {
        profile.get("id").and_then(Value::as_str) == Some(selected)
            && crate::llm_profile_value_is_enabled(profile)
    });
    if !enabled {
        return Err((
            "llm_profile_unavailable",
            format!("模型 Profile 不存在或未启用：{selected}"),
        ));
    }
    Ok(selected.to_string())
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn random_id(prefix: &str) -> Result<String, SessionServiceError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|error| {
        SessionServiceError::new(
            "local_agent_entropy_failed",
            format!("生成本地标识失败：{error}"),
        )
    })?;
    let mut value = format!("{prefix}:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_deletion_cleans_only_confirmed_sessions_and_keeps_failure() {
        let details =
            json!({"deletedSessionIds":["session:child"],"remainingSessionIds":["session:owner"]});
        let ids = deletion_cleanup_ids(&details, "session:owner", true).unwrap();
        assert_eq!(ids, vec!["session:child"]);
        let success = json!({"deleted":true,"deletedSessionIds":["session:child","session:owner"]});
        assert_eq!(
            deletion_cleanup_ids(&success, "session:owner", false)
                .unwrap()
                .len(),
            2
        );
        assert!(deletion_cleanup_ids(&details, "session:owner", false).is_err());
        for malformed in [
            json!({"deletedSessionIds":["session:child","session:child"],"remainingSessionIds":["session:owner"]}),
            json!({"deletedSessionIds":["session:child"],"remainingSessionIds":["session:child","session:owner"]}),
            json!({"deletedSessionIds":[""],"remainingSessionIds":["session:owner"]}),
        ] {
            assert!(deletion_cleanup_ids(&malformed, "session:owner", true).is_err());
        }
        let mut error =
            SessionServiceError::new("session_delete_partial", "original journal failure");
        error.details = Some(details.clone());
        let Json(cleaned) = partial_deletion_response(error.clone(), &ids, &[]);
        assert!(!cleaned.ok);
        assert_eq!(cleaned.error.as_deref(), Some("session_delete_partial"));
        assert_eq!(cleaned.message.as_deref(), Some("original journal failure"));
        let data = cleaned.data.unwrap();
        assert_eq!(data["deletedSessionIds"], details["deletedSessionIds"]);
        assert_eq!(data["remainingSessionIds"], details["remainingSessionIds"]);
        assert_eq!(data["hostCleanedSessionIds"], json!(["session:child"]));
        let Json(failed_cleanup) =
            partial_deletion_response(error, &[], &["original directory failure".into()]);
        assert!(!failed_cleanup.ok);
        assert_eq!(
            failed_cleanup.error.as_deref(),
            Some("session_delete_partial")
        );
        let message = failed_cleanup.message.unwrap();
        assert!(message.starts_with("original journal failure"));
        assert!(message.contains("original directory failure"));
        assert_eq!(
            failed_cleanup.data.unwrap()["hostCleanupErrors"],
            json!(["original directory failure"])
        );
    }

    #[test]
    fn session_creation_failure_keeps_primary_and_failed_rollback_causes() {
        let code = "conversation_catalog_write_failed";
        let original = "original catalog write failure";
        let Json(rolled_back) = session_creation_failure(code, original.into(), Ok(json!({})));
        assert!(!rolled_back.ok);
        assert!(rolled_back.data.is_none());
        assert_eq!(rolled_back.error.as_deref(), Some(code));
        assert_eq!(rolled_back.message.as_deref(), Some(original));

        let Json(failed_rollback) = session_creation_failure(
            code,
            original.into(),
            Err(SessionServiceError::new(
                "session_service_response_timeout",
                "original delete failure",
            )),
        );
        assert!(!failed_rollback.ok);
        assert!(failed_rollback.data.is_none());
        assert_eq!(failed_rollback.error.as_deref(), Some(code));
        let message = failed_rollback.message.unwrap();
        assert!(message.starts_with(original));
        assert!(message.contains("session_service_response_timeout: original delete failure"));
    }

    #[test]
    fn session_project_update_distinguishes_omitted_null_and_project_id() {
        let rename: UpdateConversationSessionRequest =
            serde_json::from_value(json!({"title": "Renamed"})).unwrap();
        assert_eq!(rename.title.as_deref(), Some("Renamed"));
        assert_eq!(rename.project_id, None);

        let independent: UpdateConversationSessionRequest =
            serde_json::from_value(json!({"projectId": null})).unwrap();
        assert_eq!(independent.project_id, Some(None));

        let moved: UpdateConversationSessionRequest =
            serde_json::from_value(json!({"projectId": "project:destination"})).unwrap();
        assert_eq!(moved.project_id, Some(Some("project:destination".into())));
        assert!(serde_json::from_value::<UpdateConversationSessionRequest>(
            json!({"projectId": 42})
        )
        .is_err());
    }

    #[test]
    fn document_resource_preserves_full_text_and_rejects_invalid_pdf_bytes() {
        let tree = TemporaryTree::new("document-read");
        for (name, media, content) in [
            (
                "报告.html",
                "text/html; charset=utf-8",
                "<!doctype html><h1>报告</h1>",
            ),
            (
                "report.md",
                "text/markdown; charset=utf-8",
                "# Report\n\n中文内容",
            ),
        ] {
            let path = tree.0.join(name);
            std::fs::write(&path, content).unwrap();
            let (actual_media, bytes) = read_document_resource(&path).unwrap();
            assert_eq!(actual_media, media);
            assert_eq!(bytes, content.as_bytes());
        }
        let pdf = tree.0.join("invalid.pdf");
        std::fs::write(&pdf, b"not a PDF").unwrap();
        assert!(read_document_resource(&pdf).is_err());
        assert!(read_document_resource(&tree.0.join("missing.html")).is_err());
        let text = tree.0.join("invalid.md");
        std::fs::write(&text, [0xff, 0xfe]).unwrap();
        assert!(read_document_resource(&text).is_err());
    }

    struct TemporaryTree(PathBuf);

    impl TemporaryTree {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(
                random_id(label)
                    .expect("temporary tree identity")
                    .replace(':', "-"),
            );
            std::fs::create_dir_all(&path).expect("create temporary tree");
            Self(path)
        }
    }

    impl Drop for TemporaryTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn conversation_title_reads_bounded_pasted_text_and_keeps_input_errors() {
        let tree = TemporaryTree::new("title-input");
        let path = tree.0.join("user-input.txt");
        fs::write(
            &path,
            format!("数据库检索与分析方案：{}", "中文响应耗时".repeat(4_000)),
        )
        .unwrap();
        let request =
            title_request_excerpt("请分析下面的产品需求", std::slice::from_ref(&path)).unwrap();
        let excerpt = request.split_once('\n').unwrap().1;
        assert!(excerpt.starts_with("请分析下面的产品需求\n数据库检索与分析方案："));
        assert_eq!(excerpt.chars().count(), 8_000);
        fs::remove_file(&path).unwrap();
        assert!(title_request_excerpt("请分析", &[path])
            .unwrap_err()
            .starts_with("conversation_title_input_read_failed:"));
    }

    #[test]
    fn session_workdir_is_separate_stable_and_retains_contents_after_catalog_reopen() {
        let tree = TemporaryTree::new("session-workdir");
        let store = tree.0.join("catalog.sqlite3");
        let root = tree.0.join("working");
        let mut catalog = ConversationCatalog::load(&store).unwrap();
        catalog
            .write_rows(
                &store,
                vec![],
                None,
                Some(ConversationSessionRecord {
                    id: "session:working".into(),
                    title: "Preview".into(),
                    title_source: Some(
                        crate::conversation_catalog::ConversationTitleSource::Initial,
                    ),
                    workspace_bindings: vec![],
                    project_id: None,
                    profile_id: None,
                    created_at: "now".into(),
                    updated_at: "now".into(),
                }),
            )
            .unwrap();
        let (first, workspace) =
            prepare_session_workdir(&catalog, &root, "session:working").unwrap();
        let workspace = workspace.unwrap();
        let draft = FsPath::new(&workspace.canonical_root).join("preview.html");
        fs::write(&draft, "<h1>Edited draft</h1>").unwrap();
        catalog
            .write_rows(&store, vec![workspace], None, None)
            .unwrap();
        let mut reopened = ConversationCatalog::load(&store).unwrap();
        let (second, added) = prepare_session_workdir(&reopened, &root, "session:working").unwrap();
        assert_eq!(first, second);
        assert!(added.is_none());
        assert_eq!(fs::read_to_string(&draft).unwrap(), "<h1>Edited draft</h1>");
        assert!(
            reopened
                .workspace(&first.workspace_id)
                .unwrap()
                .session_workdir
        );
        assert_eq!(reopened.management_value()["workspaces"], json!([]));
        reopened.remove_session(&store, "session:working").unwrap();
        assert!(ConversationCatalog::load(&store)
            .unwrap()
            .workspace(&first.workspace_id)
            .is_none());
    }

    #[test]
    fn change_read_distinguishes_binary_deletions_text_and_missing_snapshots() {
        let tree = TemporaryTree::new("change-read");
        let binary = tree.0.join("binary-before");
        let text = tree.0.join("text-before");
        std::fs::write(&binary, b"\x7fELF\x00\x01").unwrap();
        std::fs::write(&text, "first\nsecond\n").unwrap();
        let mut change = json!({"workspaceId":"workspace:test", "path":"bin/demo", "before":{"exists":true,"contentRef":binary}, "after":{"exists":false}});
        let response = read_file_change_response(&change).0;
        assert_eq!(
            response.error.as_deref(),
            Some("file_change_binary_content")
        );
        assert!(response.message.unwrap().contains("bin/demo"));
        assert!(
            response.data.is_none(),
            "binary content is not an empty text diff"
        );
        change["before"]["contentRef"] = json!(text);
        let response = read_file_change_response(&change).0;
        assert!(response.ok);
        assert_eq!(response.data.unwrap()["before"], "first\nsecond\n");
        change["before"]["contentRef"] = json!(tree.0.join("missing"));
        assert_eq!(
            read_file_change_response(&change).0.error.as_deref(),
            Some("file_change_content_unavailable")
        );
    }

    fn catalog_fixture() -> ConversationCatalog {
        ConversationCatalog {
            workspaces: vec![ConversationWorkspaceRecord {
                workspace_id: "workspace:test".to_string(),
                display_name: "Test".to_string(),
                canonical_root: "/private/host/Test".to_string(),
                owner_session_id: None,
                session_workdir: false,
                created_at: "1".to_string(),
            }],
            projects: Vec::new(),
            sessions: vec![ConversationSessionRecord {
                id: "session:test".to_string(),
                title: "Test".to_string(),
                title_source: Some(crate::conversation_catalog::ConversationTitleSource::Initial),
                workspace_bindings: Vec::new(),
                project_id: None,
                profile_id: Some("profile:test".to_string()),
                created_at: "1".to_string(),
                updated_at: "1".to_string(),
            }],
        }
    }

    #[test]
    fn generic_attach_command_must_match_host_catalog_binding() {
        let catalog = catalog_fixture();
        let valid = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:test",
                "displayName": "Test",
            }
        });
        assert!(validate_directory_index_attach_command(&catalog, "session:test", &valid,).is_ok());

        let forged_name = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:test",
                "displayName": "Forged",
            }
        });
        assert_eq!(
            validate_directory_index_attach_command(&catalog, "session:test", &forged_name,)
                .expect_err("forged display rejected")
                .0,
            "conversation_directory_index_binding_mismatch"
        );

        let unknown = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:unknown",
                "displayName": "Unknown",
            }
        });
        assert_eq!(
            validate_directory_index_attach_command(&catalog, "session:test", &unknown)
                .expect_err("unknown workspace rejected")
                .0,
            "conversation_workspace_not_found"
        );
    }

    #[test]
    fn message_filesystem_references_must_match_host_catalog() {
        let root = std::env::temp_dir().join(
            random_id("deepcode-filesystem-reference-test")
                .expect("temporary reference identity")
                .replace(':', "-"),
        );
        std::fs::create_dir_all(&root).expect("create temporary reference directory");
        let mut catalog = catalog_fixture();
        catalog.workspaces[0].canonical_root = root.to_string_lossy().to_string();
        let command = json!({
            "filesystemReferences": [{
                "referenceId": "reference:test",
                "workspaceId": "workspace:test",
                "logicalPath": ".",
                "displayName": "Test",
                "kind": "directory",
            }]
        });
        assert!(validate_message_filesystem_references(&catalog, "session:test", &command).is_ok());

        let forged = json!({
            "filesystemReferences": [{
                "referenceId": "reference:test",
                "workspaceId": "workspace:test",
                "logicalPath": ".",
                "displayName": "Forged",
                "kind": "directory",
            }]
        });
        assert_eq!(
            validate_message_filesystem_references(&catalog, "session:test", &forged)
                .expect_err("forged reference rejected")
                .0,
            "conversation_filesystem_reference_mismatch"
        );

        let projection = json!({
            "workspaceBindings": [],
            "messages": [{
                "filesystemReferences": [{
                    "referenceId": "reference:test",
                    "workspaceId": "workspace:test",
                    "logicalPath": ".",
                    "displayName": "Test",
                    "kind": "directory",
                }]
            }]
        });
        assert!(projection_references_workspace(
            &projection,
            "workspace:test"
        ));
        assert!(!projection_references_workspace(
            &projection,
            "workspace:other"
        ));
        std::fs::remove_dir_all(root).expect("remove temporary reference directory");
    }

    #[test]
    fn file_reference_retains_original_target_and_catalog_identity() {
        let source_tree = TemporaryTree::new("deepcode-reference-source");
        let source = source_tree.0.join("fixture.pdf");
        std::fs::write(&source, b"%PDF fixture bytes").expect("write source fixture");
        let mut catalog = catalog_fixture();
        let inputs = vec![FilesystemReferencePathInput {
            path: source.to_string_lossy().to_string(),
            kind: "file".to_string(),
        }];
        let mut workspaces = Vec::new();
        let references = resolve_filesystem_references(&catalog, &mut workspaces, &inputs, "now")
            .expect("resolve original file reference");
        assert_eq!(references.len(), 1);
        let reference = &references[0];
        assert_eq!(reference["kind"], "file");
        assert_eq!(reference["logicalPath"], "fixture.pdf");
        assert_eq!(reference["mediaType"], "application/pdf");
        assert_eq!(reference["byteLength"], 18);
        let workspace_id = reference["workspaceId"]
            .as_str()
            .expect("workspace identity");
        let workspace = workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("resource address root");
        assert_eq!(workspace.owner_session_id, None);
        let referenced = PathBuf::from(&workspace.canonical_root).join("fixture.pdf");
        assert_eq!(referenced, source.canonicalize().unwrap());
        assert_eq!(
            std::fs::read(&referenced).expect("read original target"),
            b"%PDF fixture bytes"
        );

        std::fs::write(&source, b"changed source").expect("mutate source fixture");
        assert_eq!(
            std::fs::read(&referenced).expect("read changed original"),
            b"changed source"
        );
        catalog.workspaces.extend(workspaces);
        assert!(validate_message_filesystem_references(
            &catalog,
            "session:test",
            &json!({ "filesystemReferences": references.clone() }),
        )
        .is_ok());
        let mut additions = Vec::new();
        let again =
            resolve_filesystem_references(&catalog, &mut additions, &inputs, "later").unwrap();
        assert!(additions.is_empty());
        assert_eq!(again[0]["workspaceId"], references[0]["workspaceId"]);
        assert_ne!(again[0]["referenceId"], references[0]["referenceId"]);
    }

    #[test]
    fn pdf_reference_requires_the_declared_media_type_plugin_selection() {
        let settings = json!({});
        let required_uri = crate::local_agent_plugins::plugin_uri_for_activation_media_type(
            &settings,
            "application/pdf",
        )
        .expect("resolve activation owner")
        .expect("PDF activation owner");
        assert_eq!(required_uri, "plugin://pdf@first-party");
        let mut command = json!({
            "filesystemReferences": [{
                "referenceId": "reference:pdf",
                "workspaceId": "workspace:pdf",
                "logicalPath": "fixture.pdf",
                "displayName": "fixture.pdf",
                "kind": "file",
                "mediaType": "application/pdf",
                "byteLength": 18,
            }],
        });

        assert_eq!(
            validate_required_filesystem_plugins(&settings, &command)
                .expect_err("missing PDF plugin selection")
                .0,
            "plugin_selection_required"
        );
        command["pluginSelections"] = json!([{
            "selectionId": "selection:pdf",
            "uri": required_uri,
            "label": "PDF reader",
        }]);
        assert!(validate_required_filesystem_plugins(&settings, &command).is_ok());
    }
}
