use crate::conversation_api::{
    projection_references_workspace, request_service, session_service_error, valid_id,
};
use crate::prelude::*;
use crate::ReadyState;
use crate::{ApiResponse, AppState};
use achbit_kernel_runtime::file_watch::FileWatch;
use axum::response::{sse::Event, IntoResponse, Response, Sse};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileGrantReference {
    authority_id: String,
    access: FileAccess,
    index: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum FileAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_grant: Option<FileGrantReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<ChangeReference>,
    pub logical_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangeReference {
    pub(crate) record_id: String,
    index: usize,
}

type ResourceError = Json<ApiResponse>;

fn managed_descendant_workdir(
    state: &AppState,
    session_id: &str,
    workspace: &crate::conversation_catalog::ConversationWorkspaceRecord,
) -> Result<bool, ResourceError> {
    if !workspace.session_workdir {
        return Ok(false);
    }
    let Some(owner) = workspace
        .owner_session_id
        .as_deref()
        .filter(|owner| *owner != session_id)
    else {
        return Ok(false);
    };
    state
        .local_agent
        .journal
        .is_descendant_session(session_id, owner)
        .map_err(|cause| ApiResponse::error(cause.code, cause.message))
}

pub(crate) async fn resource_projection(
    state: &AppState,
    session_id: &str,
    record_ids: &[String],
) -> Result<Value, ResourceError> {
    if !valid_id(session_id) {
        return Err(ApiResponse::error(
            "conversation_resource_identity_invalid",
            "资源身份无效。",
        ));
    }
    request_service(
        state.session_service.clone(),
        "resourceSnapshot",
        json!({"sessionId":session_id,"recordIds":record_ids}),
    )
    .await
    .map_err(session_service_error)
}

pub(crate) fn resolve_resource(
    state: &AppState,
    session_id: &str,
    projection: &Value,
    resource: &ResourceReference,
) -> Result<PathBuf, ResourceError> {
    if let Some(reference) = &resource.change {
        if resource.workspace_id.is_some()
            || resource.file_grant.is_some()
            || !resource.logical_path.is_empty()
        {
            return Err(ApiResponse::error(
                "conversation_resource_identity_invalid",
                "变更引用不能混合其他资源身份。",
            ));
        }
        let change = projection["activities"]
            .as_array()
            .and_then(|activities| {
                activities
                    .iter()
                    .find(|activity| activity["tool"]["recordId"] == reference.record_id)
            })
            .and_then(|activity| activity["tool"]["fileChanges"].get(reference.index))
            .ok_or_else(|| ApiResponse::error("file_change_not_found", "变更记录不存在。"))?;
        let path = change["path"].as_str().ok_or_else(|| {
            ApiResponse::error("file_change_path_invalid", "变更没有有效文件路径。")
        })?;
        if !std::path::Path::new(path).is_absolute() {
            return resolve_resource(
                state,
                session_id,
                projection,
                &ResourceReference {
                    workspace_id: change["workspaceId"].as_str().map(str::to_owned),
                    file_grant: None,
                    change: None,
                    logical_path: path.into(),
                },
            );
        }
        let target = std::path::Path::new(path).canonicalize().map_err(|error| {
            ApiResponse::error("conversation_resource_unavailable", error.to_string())
        })?;
        // A historical change identifies the file; current bindings still govern access.
        for entry in resource_roots(state, projection)? {
            let Ok(base) = resolve_resource(state, session_id, projection, &entry.resource) else {
                continue;
            };
            if target == base || (base.is_dir() && target.starts_with(&base)) {
                return Ok(target);
            }
        }
        return Err(ApiResponse::error(
            "conversation_resource_grant_unavailable",
            "该文件不在当前可访问范围内。",
        ));
    }
    let root = match (&resource.workspace_id, &resource.file_grant) {
        (Some(id), None) => {
            let gui = state.gui.lock().expect("gui state lock");
            if let Some(error) = &gui.conversation_catalog_error {
                return Err(ApiResponse::error(
                    "conversation_catalog_unavailable",
                    error,
                ));
            }
            if gui.conversation_catalog.session(session_id).is_none() {
                return Err(ApiResponse::error(
                    "conversation_session_not_found",
                    "对话不存在。",
                ));
            }
            let workspace = gui.conversation_catalog.workspace(id).ok_or_else(|| {
                ApiResponse::error("conversation_workspace_not_found", "工作目录不存在。")
            })?;
            if !projection_references_workspace(projection, id)
                && !managed_descendant_workdir(state, session_id, workspace)?
            {
                return Err(ApiResponse::error(
                    "conversation_resource_workspace_not_bound",
                    "资源不属于当前对话及后代 Agent 的托管目录。",
                ));
            }
            PathBuf::from(&workspace.canonical_root)
        }
        (None, Some(reference)) => {
            let grant = projection["shellAuthorizations"]
                .as_array()
                .and_then(|grants| {
                    grants.iter().find(|grant| {
                        grant["authorityId"] == reference.authority_id
                            && matches!(grant["scope"].as_str(), Some("runFiles" | "sessionFiles"))
                    })
                })
                .ok_or_else(|| {
                    ApiResponse::error(
                        "conversation_resource_grant_unavailable",
                        "该文件许可已失效。",
                    )
                })?;
            let access = match reference.access {
                FileAccess::Read => "read",
                FileAccess::Write => "write",
            };
            let path = grant["context"]["fileAccess"][access]
                .as_array()
                .and_then(|paths| paths.get(reference.index))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ApiResponse::error(
                        "conversation_resource_grant_invalid",
                        "文件许可中没有此资源。",
                    )
                })?;
            PathBuf::from(path)
        }
        _ => {
            return Err(ApiResponse::error(
                "conversation_resource_identity_invalid",
                "必须提供一个工作区或文件许可引用。",
            ))
        }
    };
    let root = root.canonicalize().map_err(|error| {
        ApiResponse::error("conversation_resource_unavailable", error.to_string())
    })?;
    if root.is_file() {
        if resource.logical_path.is_empty() {
            return Ok(root);
        }
        return Err(ApiResponse::error(
            "conversation_resource_not_directory",
            "单文件许可不包含所在目录。",
        ));
    }
    crate::host_inspection::resolve_workspace_read_path(&root, &resource.logical_path)
        .map_err(|error| ApiResponse::error(error.code, error.message))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceEntry {
    name: String,
    resource: ResourceReference,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub(crate) fn resource_entry(
    name: String,
    resource: ResourceReference,
    path: &std::path::Path,
) -> ResourceEntry {
    let (kind, error) = match path.metadata() {
        Ok(metadata) => (
            if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
            None,
        ),
        Err(error) => ("unavailable", Some(error.to_string())),
    };
    ResourceEntry {
        name,
        resource,
        kind,
        category: None,
        error,
    }
}

pub(crate) async fn conversation_resource_roots(
    ReadyState(state): ReadyState,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let projection = match resource_projection(&state, &session_id, &[]).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    match resource_roots(&state, &projection) {
        Ok(roots) => ApiResponse::ok(json!(roots)),
        Err(error) => error,
    }
}

fn resource_roots(
    state: &AppState,
    projection: &Value,
) -> Result<Vec<ResourceEntry>, ResourceError> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = &gui.conversation_catalog_error {
        return Err(ApiResponse::error(
            "conversation_catalog_unavailable",
            error,
        ));
    }
    let project = projection["sessionId"]
        .as_str()
        .and_then(|id| gui.conversation_catalog.session(id))
        .and_then(|session| session.project_id.as_deref())
        .and_then(|id| gui.conversation_catalog.project(id));
    let mut roots = Vec::new();
    for workspace in &gui.conversation_catalog.workspaces {
        let descendant = managed_descendant_workdir(
            state,
            projection["sessionId"].as_str().unwrap_or(""),
            workspace,
        )?;
        if !descendant && !projection_references_workspace(projection, &workspace.workspace_id) {
            continue;
        }
        let reference = ResourceReference {
            workspace_id: Some(workspace.workspace_id.clone()),
            file_grant: None,
            change: None,
            logical_path: String::new(),
        };
        let mut entry = resource_entry(
            workspace.display_name.clone(),
            reference,
            std::path::Path::new(&workspace.canonical_root),
        );
        entry.category = Some(if descendant {
            "agent"
        } else if workspace.session_workdir {
            "session"
        } else if workspace.owner_session_id.is_some() {
            "attachment"
        } else if project
            .is_none_or(|project| project.workspace_ids.contains(&workspace.workspace_id))
        {
            "project"
        } else {
            "reference"
        });
        if descendant {
            if let Some(session) = workspace
                .owner_session_id
                .as_deref()
                .and_then(|id| gui.conversation_catalog.session(id))
            {
                entry.name = session.title.clone();
            }
        }
        roots.push(entry);
    }
    for grant in projection["shellAuthorizations"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !matches!(grant["scope"].as_str(), Some("runFiles" | "sessionFiles")) {
            continue;
        }
        let Some(authority_id) = grant["authorityId"].as_str() else {
            continue;
        };
        for (access, key) in [(FileAccess::Read, "read"), (FileAccess::Write, "write")] {
            for (index, path) in grant["context"]["fileAccess"][key]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let Some(path) = path.as_str() else {
                    continue;
                };
                let path = std::path::Path::new(path);
                let reference = ResourceReference {
                    workspace_id: None,
                    file_grant: Some(FileGrantReference {
                        authority_id: authority_id.into(),
                        access: access.clone(),
                        index,
                    }),
                    change: None,
                    logical_path: String::new(),
                };
                let mut entry = resource_entry(
                    path.file_name()
                        .unwrap_or(path.as_os_str())
                        .to_string_lossy()
                        .into_owned(),
                    reference,
                    path,
                );
                entry.category = Some("resource");
                roots.push(entry);
            }
        }
    }
    Ok(roots)
}

pub(crate) async fn conversation_resource_list(
    ReadyState(state): ReadyState,
    Path(session_id): Path<String>,
    Json(resource): Json<ResourceReference>,
) -> Json<ApiResponse> {
    let records: Vec<String> = resource
        .change
        .iter()
        .map(|change| change.record_id.clone())
        .collect();
    let projection = match resource_projection(&state, &session_id, &records).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    let directory = match resolve_resource(&state, &session_id, &projection, &resource) {
        Ok(value) => value,
        Err(error) => return error,
    };
    match directory_entries(&directory, &resource) {
        Ok(entries) => ApiResponse::ok(json!(entries)),
        Err(error) => ApiResponse::error("conversation_directory_read_failed", error.to_string()),
    }
}

pub(crate) fn directory_entries(
    directory: &std::path::Path,
    resource: &ResourceReference,
) -> Result<Vec<ResourceEntry>, std::io::Error> {
    let entries = fs::read_dir(directory)?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let mut child = resource.clone();
        child.logical_path = if resource.logical_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", resource.logical_path)
        };
        result.push(resource_entry(name, child, &entry.path()));
    }
    result.sort_by_key(|entry| (entry.kind != "directory", entry.name.to_lowercase()));
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WatchResourcesRequest {
    resources: Vec<ResourceReference>,
}

pub(crate) async fn conversation_resources_watch(
    ReadyState(state): ReadyState,
    Path(session_id): Path<String>,
    Json(body): Json<WatchResourcesRequest>,
) -> Response {
    let records: Vec<String> = body
        .resources
        .iter()
        .filter_map(|resource| resource.change.as_ref())
        .map(|change| change.record_id.clone())
        .collect();
    let projection = match resource_projection(&state, &session_id, &records).await {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let mut paths = Vec::new();
    let mut indices = Vec::new();
    let mut failures = Vec::new();
    for (index, resource) in body.resources.iter().enumerate() {
        match resolve_resource(&state, &session_id, &projection, resource) {
            Ok(path) => {
                paths.push(path);
                indices.push(index);
            }
            Err(error) => failures.push(json!({"indices":[index],"error":error.0})),
        }
    }
    let directories: Vec<bool> = paths.iter().map(|path| path.is_dir()).collect();
    let mut watch = match FileWatch::new(&paths) {
        Ok(watch) => watch,
        Err(error) => {
            return ApiResponse::error("conversation_resource_watch_failed", error).into_response()
        }
    };
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Event::default().event("ready").data(json!({"indices":indices}).to_string()));
        for failure in failures {
            yield Ok(Event::default().event("resourceError").data(failure.to_string()));
        }
        while let Some(change) = watch.next().await {
            let mut changes = vec![change];
            while let Ok(change) = watch.changes.try_recv() { changes.push(change); }
            let mut affected = std::collections::BTreeSet::new();
            let mut error = None;
            for change in changes {
                match change {
                    Ok(changed) => for (index, path) in paths.iter().enumerate() {
                        if changed.iter().any(|change| change == path || (directories[index] && change.parent() == Some(path.as_path()))) { affected.insert(indices[index]); }
                    },
                    Err(message) => { error = Some(message); break; }
                }
            }
            if let Some(error) = error {
                yield Ok(Event::default().event("error").data(json!({"message":error}).to_string()));
                break;
            }
            if !affected.is_empty() {
                // Notify only subscribed identities, never sibling names of a single-file grant.
                yield Ok(Event::default().event("change").data(json!({"indices":affected}).to_string()));
            }
        }
    };
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}
