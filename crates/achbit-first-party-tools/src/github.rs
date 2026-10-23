use crate::{
    http_get, input_object, limit_text, now_millis, optional_string, optional_u64, required_string,
    response_text, ToolError, ToolResult,
};
use base64::Engine as _;
use reqwest::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};
use serde_json::{json, Value};

const API_ROOT: &str = "https://api.github.com";
const API_VERSION: &str = "2026-03-10";
const MAX_CONTENTS_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn call(name: &str, input: &Value) -> ToolResult<Value> {
    match name {
        "search" => search(input),
        "read" => read(input),
        _ => Err(ToolError::new(
            "tool_not_found",
            format!("GitHub plugin does not provide {name}"),
        )),
    }
}

fn search(input: &Value) -> ToolResult<Value> {
    let object = input_object(input, &["query", "kind", "page", "limit"])?;
    let query = required_string(object, "query")?;
    let kind = optional_string(object, "kind")?.unwrap_or_else(|| "repositories".to_string());
    let endpoint = match kind.as_str() {
        "repositories" | "code" | "issues" => kind.as_str(),
        _ => {
            return Err(ToolError::new(
                "tool_input_invalid",
                "kind must be repositories, code, or issues",
            ))
        }
    };
    let page = optional_u64(object, "page", 1, 1, 100)?;
    let limit = optional_u64(object, "limit", 10, 1, 30)?;
    let mut url = reqwest::Url::parse(&format!("{API_ROOT}/search/{endpoint}"))
        .map_err(|error| ToolError::new("github_url_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("page", &page.to_string())
        .append_pair("per_page", &limit.to_string());
    let response = http_get(url, 2 * 1024 * 1024, github_headers(kind == "code")?)?;
    let body: Value = serde_json::from_str(response_text(&response)?)
        .map_err(|error| ToolError::new("github_response_invalid", error.to_string()))?;
    let items = body.get("items").and_then(Value::as_array).ok_or_else(|| {
        ToolError::new("github_response_invalid", "search response requires items")
    })?;
    let results = items
        .iter()
        .take(limit as usize)
        .map(|item| search_result(&kind, item))
        .collect::<ToolResult<Vec<_>>>()?;
    let total_count = body
        .get("total_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ToolError::new(
                "github_response_invalid",
                "search response requires total_count",
            )
        })?;
    let incomplete = body
        .get("incomplete_results")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            ToolError::new(
                "github_response_invalid",
                "search response requires incomplete_results",
            )
        })?;
    let has_more = page < 100 && page.saturating_mul(limit) < total_count;
    Ok(json!({
        "backendId": "github",
        "query": query,
        "kind": kind,
        "page": page,
        "nextPage": has_more.then_some(page + 1),
        "totalCount": total_count,
        "incomplete": incomplete,
        "results": results,
        "retrievedAtMs": now_millis()?,
        "sourceUrl": response.final_url,
        "rateLimit": rate_limit(&response.headers)
    }))
}

fn read(input: &Value) -> ToolResult<Value> {
    let object = input_object(input, &["repository", "path", "ref", "maxBytes"])?;
    let repository = required_string(object, "repository")?;
    let mut repository_parts = repository.split('/');
    let owner = repository_parts.next().unwrap_or_default();
    let name = repository_parts.next().unwrap_or_default();
    if owner.is_empty() || name.is_empty() || repository_parts.next().is_some() {
        return Err(ToolError::new(
            "tool_input_invalid",
            "repository must use owner/name form",
        ));
    }
    let path = optional_string(object, "path")?.unwrap_or_else(|| ".".to_string());
    if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
        return Err(ToolError::new(
            "tool_input_invalid",
            "path must be repository-relative",
        ));
    }
    let reference = optional_string(object, "ref")?;
    let max_bytes = optional_u64(object, "maxBytes", 262_144, 1_024, 262_144)? as usize;
    let mut url = reqwest::Url::parse(API_ROOT)
        .map_err(|error| ToolError::new("github_url_invalid", error.to_string()))?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| {
            ToolError::new("github_url_invalid", "GitHub API root is not hierarchical")
        })?;
        segments.extend(["repos", owner, name, "contents"]);
        if path != "." {
            segments.extend(
                path.split('/')
                    .filter(|segment| !segment.is_empty() && *segment != "."),
            );
        }
    }
    if let Some(reference) = reference.as_deref() {
        url.query_pairs_mut().append_pair("ref", reference);
    }
    let response = http_get(url, MAX_CONTENTS_RESPONSE_BYTES, github_headers(false)?)?;
    let body: Value = serde_json::from_str(response_text(&response)?)
        .map_err(|error| ToolError::new("github_response_invalid", error.to_string()))?;
    let mut output = json!({
        "sourceId": format!("github:{repository}:{path}"),
        "backendId": "github",
        "repository": repository,
        "path": path,
        "ref": reference,
        "retrievedAtMs": now_millis()?,
        "sourceUrl": response.final_url,
        "rateLimit": rate_limit(&response.headers)
    });
    if let Some(entries) = body.as_array() {
        output["type"] = json!("directory");
        output["entries"] = Value::Array(
            entries
                .iter()
                .map(directory_entry)
                .collect::<ToolResult<Vec<_>>>()?,
        );
        return Ok(output);
    }
    let record = body.as_object().ok_or_else(|| {
        ToolError::new(
            "github_response_invalid",
            "contents response has an unsupported shape",
        )
    })?;
    let kind = record.get("type").and_then(Value::as_str).ok_or_else(|| {
        ToolError::new("github_response_invalid", "contents response requires type")
    })?;
    if kind != "file" {
        return Err(ToolError::new(
            "github_content_type_unsupported",
            format!("GitHub contents response type {kind} is not a directory or file"),
        ));
    }
    output["type"] = json!(kind);
    for (source, target) in [
        ("sha", "sha"),
        ("html_url", "htmlUrl"),
        ("download_url", "downloadUrl"),
    ] {
        if let Some(value) = record.get(source).and_then(Value::as_str) {
            output[target] = json!(value);
        }
    }
    if let Some(size) = record.get("size").and_then(Value::as_u64) {
        output["sizeBytes"] = json!(size);
    }
    if kind == "file" {
        if record.get("encoding").and_then(Value::as_str) != Some("base64") {
            return Err(ToolError::new(
                "github_content_encoding_unsupported",
                "GitHub file content is not base64 encoded",
            ));
        }
        let encoded = record
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::new("github_response_invalid", "file response requires content")
            })?;
        let compact = encoded
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(compact)
            .map_err(|error| ToolError::new("github_content_invalid", error.to_string()))?;
        let decoded = std::str::from_utf8(&decoded).map_err(|_| {
            ToolError::new(
                "github_content_not_utf8",
                "GitHub file is not UTF-8 text; use its download URL as a binary source",
            )
        })?;
        let (content, truncated) = limit_text(decoded, max_bytes);
        output["content"] = json!(content);
        output["truncated"] = json!(truncated);
    }
    Ok(output)
}

fn github_headers(authentication_required: bool) -> ToolResult<Vec<(HeaderName, HeaderValue)>> {
    let token = std::env::var("DEEPCODE_GITHUB_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if authentication_required && token.is_none() {
        return Err(ToolError::new(
            "github_code_search_auth_required",
            "GitHub code search requires DEEPCODE_GITHUB_TOKEN in the plugin process",
        ));
    }
    let mut headers = vec![
        (
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        ),
        (
            HeaderName::from_static("x-github-api-version"),
            HeaderValue::from_static(API_VERSION),
        ),
    ];
    if let Some(token) = token {
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|error| ToolError::new("github_auth_invalid", error.to_string()))?;
        headers.push((AUTHORIZATION, value));
    }
    Ok(headers)
}

fn search_result(kind: &str, item: &Value) -> ToolResult<Value> {
    let object = item.as_object().ok_or_else(|| {
        ToolError::new("github_response_invalid", "search item must be an object")
    })?;
    let source_url = item
        .get("html_url")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolError::new("github_response_invalid", "search item requires html_url")
        })?;
    let (title, repository, path, snippet, updated_at) = match kind {
        "repositories" => (
            response_required_string(object, "full_name")?,
            Some(response_required_string(object, "full_name")?),
            None,
            item.get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            item.get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        "code" => (
            response_required_string(object, "name")?,
            Some(
                item.get("repository")
                    .and_then(|value| value.get("full_name"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ToolError::new(
                            "github_response_invalid",
                            "code result requires repository.full_name",
                        )
                    })?
                    .to_string(),
            ),
            Some(response_required_string(object, "path")?),
            Some(response_required_string(object, "path")?),
            None,
        ),
        "issues" => (
            response_required_string(object, "title")?,
            Some(repository_from_api_url(&response_required_string(
                object,
                "repository_url",
            )?)?),
            None,
            item.get("body").and_then(Value::as_str).map(str::to_string),
            item.get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => {
            return Err(ToolError::new(
                "github_response_invalid",
                "unsupported result kind",
            ))
        }
    };
    let snippet = snippet.map(|value| limit_text(&value, 4_096).0.to_string());
    Ok(json!({
        "sourceId": source_url,
        "backendId": "github",
        "title": title,
        "url": source_url,
        "repository": repository,
        "path": path,
        "snippet": snippet,
        "updatedAt": updated_at
    }))
}

fn repository_from_api_url(url: &str) -> ToolResult<String> {
    let parts = url.trim_end_matches('/').split('/').collect::<Vec<_>>();
    if parts.len() < 2 || parts[parts.len() - 2].is_empty() || parts[parts.len() - 1].is_empty() {
        return Err(ToolError::new(
            "github_response_invalid",
            "issue result repository_url is invalid",
        ));
    }
    Ok(format!(
        "{}/{}",
        parts[parts.len() - 2],
        parts[parts.len() - 1]
    ))
}

fn directory_entry(item: &Value) -> ToolResult<Value> {
    let object = item.as_object().ok_or_else(|| {
        ToolError::new(
            "github_response_invalid",
            "directory entry must be an object",
        )
    })?;
    Ok(json!({
        "name": response_required_string(object, "name")?,
        "path": response_required_string(object, "path")?,
        "type": response_required_string(object, "type")?,
        "sizeBytes": object.get("size").and_then(Value::as_u64),
        "sha": object.get("sha").and_then(Value::as_str),
        "htmlUrl": object.get("html_url").and_then(Value::as_str),
        "downloadUrl": object.get("download_url").and_then(Value::as_str)
    }))
}

fn rate_limit(headers: &std::collections::BTreeMap<String, String>) -> Value {
    json!({
        "limit": header_u64(headers, "x-ratelimit-limit"),
        "remaining": header_u64(headers, "x-ratelimit-remaining"),
        "used": header_u64(headers, "x-ratelimit-used"),
        "resetAtEpochSeconds": header_u64(headers, "x-ratelimit-reset"),
        "resource": headers.get("x-ratelimit-resource")
    })
}

fn header_u64(headers: &std::collections::BTreeMap<String, String>, name: &str) -> Option<u64> {
    headers.get(name).and_then(|value| value.parse().ok())
}

fn response_required_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> ToolResult<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ToolError::new(
                "github_response_invalid",
                format!("GitHub response requires {field}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_search_result_requires_github_identity_fields() {
        let error = search_result(
            "repositories",
            &json!({ "html_url": "https://github.com/deepcode/project" }),
        )
        .expect_err("missing full_name must remain an upstream response error");
        assert_eq!(error.code, "github_response_invalid");
        assert!(error.message.contains("full_name"));
    }
}
