use super::*;
use crate::execution_archive::ExecutionArchive;
use serde_json::json;

mod cloud;
mod page;

const BRAVE_WEB_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_AUTH_HEADER: &str = "X-Subscription-Token";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebSearchBackend {
    Brave,
    ConfiguredEndpoint,
}

fn web_search_backend(config: &KernelExecutorConfig) -> WebSearchBackend {
    if config.web_search_endpoint_template.trim().is_empty() {
        WebSearchBackend::Brave
    } else {
        WebSearchBackend::ConfiguredEndpoint
    }
}

pub(super) fn web_search_availability(config: &KernelExecutorConfig) -> ToolAvailability {
    if config.cloud_web_search.is_some() {
        return if config.web_search_auth_secret_ref.is_empty() {
            ToolAvailability::Blocked
        } else {
            ToolAvailability::Callable
        };
    }
    match web_search_backend(config) {
        WebSearchBackend::Brave if config.web_search_auth_secret_ref.trim().is_empty() => {
            ToolAvailability::Blocked
        }
        WebSearchBackend::Brave | WebSearchBackend::ConfiguredEndpoint => {
            ToolAvailability::Callable
        }
    }
}

pub(super) fn web_search_target_url(
    config: &KernelExecutorConfig,
    query: &str,
    limit: u64,
) -> KernelResult<String> {
    let query = query.trim();
    if query.is_empty() {
        return Err(KernelError::InvalidCommand(
            "web.search query is required".to_string(),
        ));
    }
    let limit = limit.clamp(1, 10);
    if let Some(cloud) = &config.cloud_web_search {
        return Ok(cloud.endpoint.clone());
    }
    match web_search_backend(config) {
        WebSearchBackend::Brave => Ok(format!(
            "{BRAVE_WEB_SEARCH_ENDPOINT}?q={}&count={limit}&result_filter=web&text_decorations=false",
            percent_encode(query)
        )),
        WebSearchBackend::ConfiguredEndpoint => {
            let endpoint = config.web_search_endpoint_template.as_str();
            if !endpoint.contains("{query}") {
                return Err(KernelError::InvalidCommand(
                    "web.search endpoint template requires {query}".to_string(),
                ));
            }
            Ok(endpoint
                .replace("{query}", &percent_encode(query))
                .replace("{limit}", &limit.to_string()))
        }
    }
}

pub(super) struct WebSearchExecutor {
    pub(super) config: KernelExecutorConfig,
    pub(super) secret_provider: Arc<dyn SecretProvider>,
}
pub(super) struct WebFetchExecutor;

impl KernelToolExecutor for WebSearchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let KernelCanonicalInvocation::WebSearch { query, limit } = &invocation.input else {
            return Err(KernelError::InvalidCommand(
                "web.search invocation required".into(),
            ));
        };
        let limit = *limit as usize;
        run_archived_web_tool(&invocation, &context, |archive| {
            if let Some(config) = &self.config.cloud_web_search {
                let key = self
                    .secret_provider
                    .resolve(&self.config.web_search_auth_secret_ref)
                    .ok_or_else(|| {
                        KernelError::PermissionDenied("web.search credential is unavailable".into())
                    })?;
                return cloud::invoke(
                    &query,
                    limit,
                    config.clone(),
                    key,
                    &context.cancellation,
                    archive,
                );
            }
            let backend = web_search_backend(&self.config);
            let url = web_search_target_url(&self.config, &query, limit as u64)?;
            validate_http_url(&url)?;
            let auth_header =
                web_search_auth_header(&self.config, self.secret_provider.as_ref(), backend)?;
            let headers = auth_header.into_iter().collect();
            let response = http_get_complete_with_headers(
                &url,
                96 * 1024,
                headers,
                archive,
                &context.cancellation,
            )?;
            let body = page::decode_text(
                &response.bytes,
                response.content_type.as_deref(),
                response.truncated,
            )?
            .0;
            let parsed = serde_json::from_str::<Value>(&body).map_err(|error| {
                KernelError::InvalidCommand(format!(
                    "web.search response is not valid JSON: {error}"
                ))
            })?;
            let (provider, query, results) = match backend {
                WebSearchBackend::Brave => {
                    let (query, results) = parse_brave_search_results(&parsed, &query, limit)?;
                    ("brave-search", query, results)
                }
                WebSearchBackend::ConfiguredEndpoint => (
                    "configured-endpoint",
                    search_query_metadata(&query, None),
                    validate_search_results(&parsed, limit)?,
                ),
            };
            Ok(json!({
                "query": query, "provider": provider, "results": results,
                "untrustedEvidence": true, "sourceUrl": url, "finalUrl": response.final_url,
                "retrievedAtMs": unix_millis(), "truncated": response.truncated,
            }))
        })
    }
}

fn web_search_auth_header(
    config: &KernelExecutorConfig,
    secret_provider: &dyn SecretProvider,
    backend: WebSearchBackend,
) -> KernelResult<Option<(String, String)>> {
    let secret_ref = config.web_search_auth_secret_ref.trim();
    if backend == WebSearchBackend::Brave && secret_ref.is_empty() {
        return Err(KernelError::PermissionDenied(
            "web.search built-in Brave backend requires agent.web.search.authSecretRef".to_string(),
        ));
    }
    if secret_ref.is_empty() {
        return Ok(None);
    }
    let value = secret_provider.resolve(secret_ref).ok_or_else(|| {
        KernelError::PermissionDenied("web.search auth SecretRef could not be resolved".to_string())
    })?;
    let name = match backend {
        WebSearchBackend::Brave => BRAVE_AUTH_HEADER,
        WebSearchBackend::ConfiguredEndpoint => config.web_search_auth_header_name.as_str(),
    };
    Ok(Some((name.to_string(), value)))
}

impl KernelToolExecutor for WebFetchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        invoke_web_fetch(invocation, context)
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn archive_error(error: std::io::Error) -> KernelError {
    KernelError::Structured {
        code: "execution_archive_failed",
        stage: "execution",
        message: error.to_string(),
        details: json!({}),
    }
}

fn run_archived_web_tool(
    invocation: &KernelToolInvocation,
    context: &KernelToolExecutionContext,
    execute: impl FnOnce(&mut ExecutionArchive) -> KernelResult<Value>,
) -> KernelResult<KernelToolExecutionResult> {
    let mut archive = ExecutionArchive::open(
        context.output_directory.as_deref(),
        json!({
            "attemptId": invocation.id, "toolId": invocation.input.tool_id(), "input": invocation.input.executor_arguments(),
        }),
    )
    .map_err(archive_error)?;
    let (outcome, mut output, error) = match execute(&mut archive) {
        Ok(output) => (KernelToolExecutionOutcome::Completed, output, None),
        Err(error) => {
            let envelope = deepcode_kernel_abi::KernelErrorEnvelope::from(&error);
            (
                KernelToolExecutionOutcome::Failed,
                json!({"details": envelope.args}),
                Some(KernelToolExecutionFailure {
                    code: envelope.code,
                    message: envelope.message,
                }),
            )
        }
    };
    if let Some(path) = archive.path() {
        output["archive"] = json!({ "timelinePath": path });
    }
    archive
        .record(
            "tool.result",
            json!({"outcome": outcome, "output": output, "error": error}),
        )
        .map_err(archive_error)?;
    archive
        .finish(
            if error.is_some() {
                "failed"
            } else {
                "completed"
            },
            json!({}),
        )
        .map_err(archive_error)?;
    Ok(KernelToolExecutionResult {
        invocation_id: invocation.id.clone(),
        outcome,
        output,
        error,
    })
}

fn invoke_web_fetch(
    invocation: KernelToolInvocation,
    context: KernelToolExecutionContext,
) -> KernelResult<KernelToolExecutionResult> {
    let KernelCanonicalInvocation::WebFetch { url, max_bytes } = &invocation.input else {
        return Err(KernelError::InvalidCommand(
            "web.fetch invocation required".into(),
        ));
    };
    validate_http_url(&url)?;
    let max_bytes = *max_bytes as usize;
    run_archived_web_tool(&invocation, &context, |archive| {
        // HTML headers/scripts often exceed the requested excerpt size. Bound
        // the source separately, then spend maxBytes on extracted readable text.
        let response = http_get_complete_with_headers(
            &url,
            2 * 1024 * 1024,
            vec![],
            archive,
            &context.cancellation,
        )?;
        let page = page::extract(
            &response.bytes,
            response.content_type.as_deref(),
            max_bytes,
            response.truncated,
        )?;
        Ok(json!({
            "url": url, "content": page.content, "sizeBytes": page.content.len(),
            "contentType": response.content_type, "contentFormat": page.format,
            "encoding": page.encoding, "finalUrl": response.final_url,
            "statusCode": response.status_code, "retrievedAtMs": unix_millis(),
            "truncated": response.truncated || page.truncated,
            "sourceTruncated": response.truncated, "untrustedEvidence": true,
        }))
    })
}

pub(super) fn validate_http_url(url: &str) -> KernelResult<()> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| KernelError::InvalidCommand(format!("invalid HTTP URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(KernelError::PermissionDenied(
            "network tools only accept http/https URLs".to_string(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(KernelError::InvalidCommand(
            "HTTP URL requires a host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(KernelError::PermissionDenied(
            "network tools reject credential-bearing URLs".to_string(),
        ));
    }
    Ok(())
}

struct HttpGetComplete {
    bytes: Vec<u8>,
    final_url: String,
    content_type: Option<String>,
    status_code: u16,
    truncated: bool,
}

fn http_get_complete_with_headers(
    url: &str,
    max_bytes: usize,
    headers: Vec<(String, String)>,
    archive: &mut ExecutionArchive,
    cancellation: &KernelCancellationToken,
) -> KernelResult<HttpGetComplete> {
    std::thread::scope(|scope| {
        std::thread::Builder::new().name("deepcode-http".to_string())
            .spawn_scoped(scope, move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
                    .map_err(|error| KernelError::Other(error.to_string()))?;
                runtime.block_on(async {
                    tokio::select! {
                        result = http_get_complete_async(url, max_bytes, headers, archive) => result,
                        _ = cloud::cancelled(cancellation) => Err(KernelError::Other("web.fetch cancelled".into())),
                    }
                })
            })
            .map_err(|error| KernelError::Other(format!("start HTTP worker: {error}")))?
            .join().map_err(|_| KernelError::Other("HTTP worker panicked".into()))?
    })
}

async fn http_get_complete_async(
    url: &str,
    max_bytes: usize,
    request_headers: Vec<(String, String)>,
    archive: &mut ExecutionArchive,
) -> KernelResult<HttpGetComplete> {
    validate_http_url(url)?;
    archive
        .record("request.started", json!({"method": "GET", "url": url}))
        .map_err(archive_error)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("DeepCode-Kernel/0.1")
        .build()
        .map_err(|error| KernelError::Other(format!("create HTTP client: {error}")))?;
    let mut request = client.get(url);
    for (name, value) in request_headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            KernelError::InvalidCommand(format!("invalid HTTP header name: {error}"))
        })?;
        let value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| KernelError::InvalidCommand("invalid HTTP header value".into()))?;
        request = request.header(name, value);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| KernelError::Other(format!("HTTP GET {url}: {error}")))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    archive.record("response.headers", json!({
        "statusCode": status.as_u16(), "finalUrl": final_url, "contentType": content_type,
        "contentEncoding": response.headers().get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
        "bodyStage": "after HTTP content decoding",
    })).map_err(archive_error)?;
    let mut bytes = Vec::new();
    // Retain the bounded response even on HTTP failure for diagnosis.
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| KernelError::Other(format!("read HTTP body: {error}")))?
    {
        let retained = &chunk[..chunk.len().min(max_bytes + 1 - bytes.len())];
        archive
            .bytes("response.chunk", &chunk)
            .map_err(archive_error)?;
        bytes.extend_from_slice(retained);
        if bytes.len() > max_bytes {
            break;
        }
    }
    let truncated = bytes.len() > max_bytes;
    archive
        .record(
            "response.body.read",
            json!({ "bytes": bytes.len(), "truncated": truncated, "limitBytes": max_bytes }),
        )
        .map_err(archive_error)?;
    if !status.is_success() {
        return Err(KernelError::Other(format!(
            "HTTP GET {url} returned {}",
            status.as_u16()
        )));
    }
    bytes.truncate(max_bytes);
    Ok(HttpGetComplete {
        bytes,
        final_url,
        content_type,
        status_code: status.as_u16(),
        truncated,
    })
}

pub(super) fn truncate_text(text: &mut String, max_bytes: usize) {
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
}

pub(super) fn validate_search_results(response: &Value, limit: usize) -> KernelResult<Vec<Value>> {
    let items = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            KernelError::InvalidCommand("web.search response requires results array".to_string())
        })?;
    items
        .iter()
        .take(limit)
        .map(|item| {
            let title = required_string(item, "title")?;
            let url = required_string(item, "url")?;
            validate_http_url(&url)?;
            let snippet = optional_string(item, "snippet")?;
            let published_at = optional_string(item, "publishedAt")?;
            Ok(serde_json::json!({
                "sourceId": url,
                "backendId": "configuredEndpoint",
                "title": title,
                "url": url,
                "snippet": snippet,
                "publishedAt": published_at,
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect()
}

pub(super) fn parse_brave_search_results(
    response: &Value,
    requested_query: &str,
    limit: usize,
) -> KernelResult<(Value, Vec<Value>)> {
    let root = response.as_object().ok_or_else(|| {
        KernelError::InvalidCommand("Brave Search response must be an object".to_string())
    })?;
    let backend_query = match root.get("query") {
        None | Some(Value::Null) => None,
        Some(Value::Object(query)) => Some(query),
        Some(_) => {
            return Err(KernelError::InvalidCommand(
                "Brave Search response query must be an object".to_string(),
            ))
        }
    };
    let original = backend_query
        .map(|query| optional_string_in_object(query, "original"))
        .transpose()?
        .flatten()
        .unwrap_or_else(|| requested_query.to_string());
    let altered = backend_query
        .map(|query| optional_string_in_object(query, "altered"))
        .transpose()?
        .flatten();
    let items = match root.get("web") {
        None | Some(Value::Null) => None,
        Some(Value::Object(web)) => Some(web.get("results").and_then(Value::as_array).ok_or_else(
            || {
                KernelError::InvalidCommand(
                    "Brave Search response web requires results array".to_string(),
                )
            },
        )?),
        Some(_) => {
            return Err(KernelError::InvalidCommand(
                "Brave Search response web must be an object".to_string(),
            ))
        }
    };
    let results = items
        .into_iter()
        .flatten()
        .take(limit)
        .map(|item| {
            let title = required_string(item, "title")?;
            let url = required_string(item, "url")?;
            validate_http_url(&url)?;
            let snippet = optional_string(item, "description")?;
            let language = optional_string(item, "language")?;
            let published_at = optional_string(item, "page_age")?;
            Ok(json!({
                "sourceId": url,
                "backendId": "braveWeb",
                "title": title,
                "url": url,
                "snippet": snippet,
                "language": language,
                "publishedAt": published_at,
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect::<KernelResult<Vec<_>>>()?;
    Ok((
        search_query_metadata(&original, altered.as_deref()),
        results,
    ))
}

fn search_query_metadata(original: &str, altered: Option<&str>) -> Value {
    let mut query =
        serde_json::Map::from_iter([("original".to_string(), Value::String(original.to_string()))]);
    if let Some(altered) = altered {
        query.insert("altered".to_string(), Value::String(altered.to_string()));
    }
    Value::Object(query)
}

fn optional_string(value: &Value, key: &str) -> KernelResult<Option<String>> {
    let object = value.as_object().ok_or_else(|| {
        KernelError::InvalidCommand(format!("web.search result requires object item for {key}"))
    })?;
    optional_string_in_object(object, key)
}

fn optional_string_in_object(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> KernelResult<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok((!value.trim().is_empty()).then(|| value.to_string())),
        Some(_) => Err(KernelError::InvalidCommand(format!(
            "web.search response field {key} must be a string"
        ))),
    }
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(*byte));
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executors::tests::invocation;

    fn serve_http_response(headers: &str, body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let headers = format!(
            "HTTP/1.1 200 OK\r\n{headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let n = socket.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
        });
        (url, worker)
    }

    fn archived_test_context(label: &str) -> KernelToolExecutionContext {
        KernelToolExecutionContext {
            output_directory: Some(std::env::temp_dir().join(format!(
                    "deepcode-web-{label}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ))),
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: vec![],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: KernelCancellationToken::default(),
            progress: Default::default(),
        }
    }

    #[test]
    fn gzip_fetch_returns_readable_markdown_and_a_complete_archive() {
        use base64::Engine;
        let compressed = base64::engine::general_purpose::STANDARD.decode("H4sIAAAAAAAC/7PJKMnNsbNJyk+ptLPJMLRzzs8tKEotLk5NUShITE+10QeK2RTYBaUmpiQm5aQqJOfnlaTmldjoF9jZ6EN06YONAADIIqKtSQAAAA==").unwrap();
        let (url, server) = serve_http_response(
            "Content-Type: text/html; charset=utf-8\r\nContent-Encoding: gzip",
            compressed,
        );
        let context = archived_test_context("gzip");
        let directory = context.output_directory.clone().unwrap();
        let result = invoke_web_fetch(
            invocation(
                "attempt:gzip",
                "web.fetch",
                json!({"url":url, "maxBytes":1024}),
            ),
            context,
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
        assert!(result.output["content"]
            .as_str()
            .unwrap()
            .contains("# Compressed page"));
        assert!(result.output["sizeBytes"].as_u64().unwrap() <= 1024);
        let lines: Vec<Value> = fs::read_to_string(directory.join("timeline.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(lines.iter().any(|line| line["type"] == "response.chunk"));
        assert_eq!(lines.last().unwrap()["data"]["outcome"], "completed");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_cloud_response_retains_original_payload_and_specific_error() {
        let response = json!({"results":[
            {"url":"/invalid","title":"Provider response"}
        ]});
        let raw = serde_json::to_vec(&response).unwrap();
        let (url, server) = serve_http_response("Content-Type: application/json", raw.clone());
        let context = archived_test_context("search-failure");
        let directory = context.output_directory.clone().unwrap();
        let invocation = invocation("attempt:bad-search", "web.search", json!({"query":"docs"}));
        let result = run_archived_web_tool(&invocation, &context, |archive| {
            cloud::invoke(
                "docs",
                5,
                CloudWebSearchConfig {
                    provider: CloudWebSearchProvider::DeepSeek,
                    endpoint: url,
                },
                "test-only-key".into(),
                &context.cancellation,
                archive,
            )
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
        assert_eq!(result.error.unwrap().code, "web_search_response_invalid");
        let log = fs::read_to_string(directory.join("timeline.jsonl")).unwrap();
        assert!(!log.contains("test-only-key"));
        let lines: Vec<Value> = log
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        use base64::Engine;
        let retained: Vec<u8> = lines
            .iter()
            .filter(|line| line["type"] == "response.chunk")
            .flat_map(|line| {
                base64::engine::general_purpose::STANDARD
                    .decode(line["data"]["base64"].as_str().unwrap())
                    .unwrap()
            })
            .collect();
        assert_eq!(retained, raw);
        assert_eq!(lines.last().unwrap()["data"]["outcome"], "failed");
        fs::remove_dir_all(directory).unwrap();
    }

    struct TestSecretProvider;

    impl SecretProvider for TestSecretProvider {
        fn resolve(&self, secret_ref: &str) -> Option<String> {
            (secret_ref == "local-secret:brave").then(|| "brave-token".to_string())
        }
    }

    fn config(endpoint: &str, header: &str, secret_ref: &str) -> KernelExecutorConfig {
        KernelExecutorConfig {
            web_search_endpoint_template: endpoint.to_string(),
            web_search_auth_header_name: header.to_string(),
            web_search_auth_secret_ref: secret_ref.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn web_fetch_rejects_non_http_urls_at_the_shared_http_boundary() {
        let error = invoke_web_fetch(
            // Exercise the HTTP boundary independently of input canonicalization.
            KernelToolInvocation {
                id: "invocation:fetch".into(),
                input: KernelCanonicalInvocation::WebFetch {
                    url: "ftp://example.invalid/document".into(),
                    max_bytes: 1_024,
                },
            },
            KernelToolExecutionContext {
                output_directory: None,
                workspace_root: None,
                workspace_id: None,
                private_resolved_targets: vec![],
                workspace_write_targets: None,
                file_access: Default::default(),
                cancellation: KernelCancellationToken::default(),
                progress: Default::default(),
            },
        )
        .expect_err("web.fetch must retain HTTP URL validation");
        assert!(matches!(
            error,
            KernelError::PermissionDenied(message)
                if message == "network tools only accept http/https URLs"
        ));
    }

    #[test]
    fn built_in_brave_target_and_custom_target_are_independent() {
        let built_in = config("", "Authorization", "local-secret:brave");
        assert_eq!(
            web_search_target_url(&built_in, "rust agent", 12).unwrap(),
            "https://api.search.brave.com/res/v1/web/search?q=rust+agent&count=10&result_filter=web&text_decorations=false"
        );

        let custom = config(
            "https://search.example/v1?q={query}&limit={limit}",
            "Authorization",
            "",
        );
        assert_eq!(
            web_search_target_url(&custom, "rust agent", 4).unwrap(),
            "https://search.example/v1?q=rust+agent&limit=4"
        );
    }

    #[test]
    fn brave_requires_a_resolvable_secret_and_uses_its_fixed_header() {
        let missing = config("", "Authorization", "");
        assert_eq!(web_search_availability(&missing), ToolAvailability::Blocked);
        assert!(
            web_search_auth_header(&missing, &TestSecretProvider, WebSearchBackend::Brave).is_err()
        );

        let configured = config("", "Authorization", "local-secret:brave");
        assert_eq!(
            web_search_availability(&configured),
            ToolAvailability::Callable
        );
        assert_eq!(
            web_search_auth_header(&configured, &TestSecretProvider, WebSearchBackend::Brave)
                .unwrap(),
            Some((BRAVE_AUTH_HEADER.to_string(), "brave-token".to_string()))
        );

        let unresolved = config("", "Authorization", "local-secret:unknown");
        assert!(
            web_search_auth_header(&unresolved, &TestSecretProvider, WebSearchBackend::Brave)
                .is_err()
        );
    }

    #[test]
    fn configured_endpoint_is_callable_without_auth_and_uses_configured_auth_when_present() {
        let anonymous = config("https://search.example/v1?q={query}", "Authorization", "");
        assert_eq!(
            web_search_availability(&anonymous),
            ToolAvailability::Callable
        );
        assert_eq!(
            web_search_auth_header(
                &anonymous,
                &TestSecretProvider,
                WebSearchBackend::ConfiguredEndpoint
            )
            .unwrap(),
            None
        );

        let authenticated = config(
            "https://search.example/v1?q={query}",
            "X-Search-Key",
            "local-secret:brave",
        );
        assert_eq!(
            web_search_auth_header(
                &authenticated,
                &TestSecretProvider,
                WebSearchBackend::ConfiguredEndpoint
            )
            .unwrap(),
            Some(("X-Search-Key".to_string(), "brave-token".to_string()))
        );
    }

    #[test]
    fn brave_response_maps_web_results_and_query_metadata_without_reranking() {
        let response = json!({
            "query": {"original": "rust agent", "altered": "rust agents"},
            "web": {
                "results": [
                    {
                        "title": "First",
                        "url": "https://example.com/first",
                        "description": "First result",
                        "language": "en",
                        "page_age": "2026-09-01T00:00:00Z"
                    },
                    {
                        "title": "Second",
                        "url": "https://example.com/second"
                    }
                ]
            }
        });
        let (query, results) = parse_brave_search_results(&response, "rust agent", 10).unwrap();

        assert_eq!(
            query,
            json!({"original": "rust agent", "altered": "rust agents"})
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["backendId"], "braveWeb");
        assert_eq!(results[0]["snippet"], "First result");
        assert_eq!(results[0]["language"], "en");
        assert_eq!(results[0]["publishedAt"], "2026-09-01T00:00:00Z");
        assert_eq!(results[1]["title"], "Second");
    }

    #[test]
    fn brave_no_web_section_is_a_valid_empty_result() {
        let (query, results) =
            parse_brave_search_results(&json!({"query": null}), "no matches", 5).unwrap();
        assert_eq!(query, json!({"original": "no matches"}));
        assert!(results.is_empty());
    }

    #[test]
    fn brave_response_rejects_malformed_required_and_optional_fields() {
        let missing_url = json!({
            "web": {"results": [{"title": "Missing URL"}]}
        });
        assert!(parse_brave_search_results(&missing_url, "query", 5).is_err());

        let invalid_language = json!({
            "web": {
                "results": [{
                    "title": "Result",
                    "url": "https://example.com",
                    "language": 42
                }]
            }
        });
        assert!(parse_brave_search_results(&invalid_language, "query", 5).is_err());
    }
}
