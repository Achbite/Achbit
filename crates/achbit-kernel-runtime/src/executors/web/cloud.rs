use super::*;
use std::collections::HashSet;
use std::time::Duration;

const RESPONSE_LIMIT: usize = 1024 * 1024;

pub(super) fn invoke(
    query: &str,
    limit: usize,
    config: CloudWebSearchConfig,
    api_key: String,
    cancellation: &KernelCancellationToken,
    archive: &mut ExecutionArchive,
) -> KernelResult<Value> {
    validate_http_url(&config.endpoint)?;
    if config.provider == CloudWebSearchProvider::DeepSeek
        && (query.trim().is_empty() || query.chars().count() > 128)
    {
        return Err(KernelError::InvalidCommand(
            "DeepSeek search query must contain 1 to 128 Unicode characters".into(),
        ));
    }
    if config.provider == CloudWebSearchProvider::Glm && query.chars().count() > 70 {
        return Err(KernelError::InvalidCommand(
            "GLM search query must be at most 70 characters".into(),
        ));
    }
    let body = request_body(config.provider, query, limit);
    archive
        .record(
            "request.started",
            json!({ "method": "POST", "url": config.endpoint, "body": body }),
        )
        .map_err(archive_error)?;
    // Own and join the transport worker; cancellation drops the active request.
    std::thread::scope(|scope| {
        std::thread::Builder::new().name("achbit-cloud-search".into()).spawn_scoped(scope, || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
                .map_err(|error| KernelError::Other(error.to_string()))?;
            let bytes = runtime.block_on(async {
                tokio::select! {
                    result = request(&config, &api_key, &body, archive) => result,
                    _ = cancelled(cancellation) => Err(search_error("web_search_cancelled", "Search was cancelled")),
                }
            })?;
            let parsed: Value = serde_json::from_slice(&bytes)
                .map_err(|error| search_error("web_search_response_invalid", &error.to_string()))?;
            let mut output = parse_response(config.provider, &parsed, limit)?;
            output["query"] = search_query_metadata(query, None);
            output["sourceUrl"] = json!(config.endpoint);
            output["retrievedAtMs"] = json!(unix_millis());
            output["untrustedEvidence"] = json!(true);
            Ok(output)
        }).map_err(|error| KernelError::Other(format!("start search worker: {error}")))?
            .join().map_err(|_| KernelError::Other("search worker panicked".into()))?
    })
}

pub(super) async fn cancelled(cancellation: &KernelCancellationToken) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn request_body(provider: CloudWebSearchProvider, query: &str, limit: usize) -> Value {
    match provider {
        CloudWebSearchProvider::DeepSeek => json!({
            "query": query, "count": limit, "need_content": false,
        }),
        CloudWebSearchProvider::Glm => json!({
            "search_query": query, "search_engine": "search_std",
            "search_intent": false, "count": limit,
        }),
        CloudWebSearchProvider::Kimi => json!({
            "name": "web_search", "arguments": json!({ "query": query }).to_string(),
        }),
    }
}

async fn request(
    config: &CloudWebSearchConfig,
    key: &str,
    body: &Value,
    archive: &mut ExecutionArchive,
) -> KernelResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Achbit-Kernel/0.1")
        .build()
        .map_err(|error| KernelError::Other(error.to_string()))?;
    let mut response = client
        .post(&config.endpoint)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|error| search_error("web_search_request_failed", &error.to_string()))?;
    let status = response.status();
    archive.record("response.headers", json!({
        "statusCode": status.as_u16(),
        "contentType": response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
    })).map_err(archive_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| search_error("web_search_response_failed", &error.to_string()))?
    {
        archive
            .bytes("response.chunk", &chunk)
            .map_err(archive_error)?;
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(search_error(
                "web_search_response_too_large",
                "Search response exceeds 1 MiB",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes).replace(key, "[redacted]");
        let detail: String = detail.chars().take(512).collect();
        return Err(search_error(
            "web_search_provider_error",
            &format!("HTTP {}: {detail}", status.as_u16()),
        ));
    }
    Ok(bytes)
}

fn parse_response(
    provider: CloudWebSearchProvider,
    response: &Value,
    limit: usize,
) -> KernelResult<Value> {
    if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
        return Err(search_error(
            "web_search_provider_error",
            &error.to_string(),
        ));
    }
    match provider {
        CloudWebSearchProvider::DeepSeek => parse_deepseek(response, limit),
        CloudWebSearchProvider::Glm => {
            let items = response
                .get("search_result")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    search_error(
                        "web_search_response_invalid",
                        "GLM response lacks search_result",
                    )
                })?;
            let results = items
                .iter()
                .take(limit)
                .map(|item| source(item, "link", "content", "publish_date", "glmSearch"))
                .collect::<KernelResult<Vec<_>>>()?;
            Ok(json!({ "provider": "glm-search", "results": results,
                "truncated": items.len() > limit, "responseId": response.get("id"), "usage": response.get("usage") }))
        }
        CloudWebSearchProvider::Kimi => {
            if response["status"] != "succeeded" {
                return Err(search_error(
                    "web_search_provider_error",
                    &format!("Kimi search fiber did not succeed: {}", response["status"]),
                ));
            }
            let content = response
                .pointer("/context/encrypted_output")
                .or_else(|| response.pointer("/context/output"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    search_error(
                        "web_search_response_invalid",
                        "Kimi search fiber lacks output",
                    )
                })?;
            // Formula output is opaque provider evidence, not a local sources
            // list. The Moonshot transport passes it back verbatim as tool content.
            Ok(
                json!({ "provider": "kimi-formula", "providerContent": content,
                "responseId": response.get("id"), "truncated": false }),
            )
        }
    }
}

fn parse_deepseek(response: &Value, limit: usize) -> KernelResult<Value> {
    let items = response["results"].as_array().ok_or_else(|| {
        search_error(
            "web_search_response_invalid",
            "DeepSeek response lacks results array",
        )
    })?;
    let mut results = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for (item_index, item) in items.iter().enumerate() {
        let parsed =
            source(item, "url", "snippet", "date", "deepseekSearch").and_then(|mut result| {
                // Keep the API's model-facing summary alongside its display snippet.
                result["summary"] = json!(optional_string(item, "summary")?);
                Ok(result)
            });
        let result = match parsed {
            Ok(result) => result,
            Err(error) => {
                issues.push(json!({ "itemIndex": item_index,
                    "code": "web_search_result_invalid", "url": item.get("url"), "message": error.to_string() }));
                continue;
            }
        };
        let url = result["url"].as_str().expect("validated source URL");
        if !seen.insert(url.to_string()) {
            continue;
        }
        results.push(result);
    }
    if results.is_empty() && !issues.is_empty() {
        return Err(KernelError::Structured {
            code: "web_search_response_invalid",
            stage: "execution",
            message: "Search returned no usable source entries".into(),
            details: json!({"resultIssues": issues}),
        });
    }
    let truncated = results.len() > limit;
    results.truncate(limit);
    Ok(
        json!({ "provider": "deepseek-search", "results": results, "truncated": truncated,
        "partial": !issues.is_empty(), "resultIssues": issues }),
    )
}

fn source(
    item: &Value,
    url_field: &str,
    snippet_field: &str,
    date_field: &str,
    backend: &str,
) -> KernelResult<Value> {
    let url = required_string(item, url_field)?;
    validate_http_url(&url)?;
    Ok(json!({ "sourceId": url, "url": url, "backendId": backend,
        "title": optional_string(item, "title")?, "snippet": optional_string(item, snippet_field)?,
        "publishedAt": optional_string(item, date_field)?, "untrustedEvidence": true, "truncated": false }))
}

fn search_error(code: &'static str, message: &str) -> KernelError {
    KernelError::Structured {
        code,
        stage: "execution",
        message: message.into(),
        details: json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_search_request(socket: &mut tokio::net::TcpStream) -> (String, Value) {
        use tokio::io::AsyncReadExt;
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(socket.read_u8().await.unwrap());
        }
        let headers = String::from_utf8(headers).unwrap();
        let length: usize = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .unwrap()
            .1
            .trim()
            .parse()
            .unwrap();
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        (headers, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn deepseek_http_posts_raw_unicode_query_and_receives_search_results() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/tools/search", listener.local_addr().unwrap());
        let query = format!("{} site:example.com", "界".repeat(111));
        assert_eq!(query.chars().count(), 128);
        let sent_query = query.clone();
        let worker = tokio::task::spawn_blocking(move || {
            invoke(
                &sent_query,
                3,
                CloudWebSearchConfig {
                    provider: CloudWebSearchProvider::DeepSeek,
                    endpoint,
                },
                "test-only-key".into(),
                &KernelCancellationToken::default(),
                &mut ExecutionArchive::open(None, json!({})).unwrap(),
            )
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (headers, body) = read_search_request(&mut socket).await;
            assert!(headers.starts_with("POST /v1/tools/search HTTP/1.1\r\n"));
            let headers = headers.to_ascii_lowercase();
            assert!(headers.contains("\r\nauthorization: bearer test-only-key\r\n"));
            assert!(headers.contains("\r\ncontent-type: application/json\r\n"));
            assert!(!headers.contains("x-api-key:"));
            assert!(!headers.contains("anthropic-version:"));
            assert_eq!(body, json!({"query":query,"count":3,"need_content":false}));
            let response = json!({"results":[{"url":"https://example.com/docs","title":"Docs",
                "snippet":"Display excerpt","summary":"Model evidence","date":null}]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            let output = worker.await.unwrap().unwrap();
            assert_eq!(output["provider"], "deepseek-search");
            assert_eq!(output["query"]["original"], query);
            assert_eq!(output["results"][0]["summary"], "Model evidence");
            assert_eq!(output["partial"], false);
        }).await.unwrap();
    }

    #[tokio::test]
    async fn deepseek_cancellation_closes_the_in_flight_search_request() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/tools/search", listener.local_addr().unwrap());
        let cancellation = KernelCancellationToken::default();
        let worker_cancellation = cancellation.clone();
        let worker = tokio::task::spawn_blocking(move || {
            invoke(
                "release",
                5,
                CloudWebSearchConfig {
                    provider: CloudWebSearchProvider::DeepSeek,
                    endpoint,
                },
                "test-only-key".into(),
                &worker_cancellation,
                &mut ExecutionArchive::open(None, json!({})).unwrap(),
            )
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_search_request(&mut socket).await;
            cancellation.cancel();
            assert!(matches!(
                worker.await.unwrap(),
                Err(KernelError::Structured {
                    code: "web_search_cancelled",
                    ..
                })
            ));
            let mut remaining = Vec::new();
            assert_eq!(socket.read_to_end(&mut remaining).await.unwrap(), 0);
        })
        .await
        .unwrap();
    }

    #[test]
    fn deepseek_rejects_unsupported_query_lengths_without_truncation() {
        for query in [" ".into(), "界".repeat(129)] {
            let result = invoke(
                &query,
                5,
                CloudWebSearchConfig {
                    provider: CloudWebSearchProvider::DeepSeek,
                    endpoint: "http://127.0.0.1:1/v1/tools/search".into(),
                },
                "test-only-key".into(),
                &KernelCancellationToken::default(),
                &mut ExecutionArchive::open(None, json!({})).unwrap(),
            );
            assert!(
                matches!(result, Err(KernelError::InvalidCommand(message)) if message.contains("128 Unicode"))
            );
        }
    }

    #[test]
    fn cloud_requests_use_each_providers_actual_search_protocol() {
        let query = "发布信息";
        let deepseek = request_body(CloudWebSearchProvider::DeepSeek, query, 3);
        assert_eq!(
            deepseek,
            json!({"query": query, "count": 3, "need_content": false})
        );
        let glm = request_body(CloudWebSearchProvider::Glm, query, 3);
        assert_eq!(
            glm,
            json!({ "search_query": query, "search_engine": "search_std", "search_intent": false, "count": 3 })
        );
        let kimi = request_body(CloudWebSearchProvider::Kimi, query, 3);
        assert_eq!(kimi["name"], "web_search");
        assert_eq!(
            serde_json::from_str::<Value>(kimi["arguments"].as_str().unwrap()).unwrap(),
            json!({ "query": query })
        );
    }

    #[test]
    fn deepseek_requires_results_and_preserves_search_evidence_without_prose_scraping() {
        let raw = json!({ "results": [
            { "url": "https://example.com/a", "title": "A", "snippet": "excerpt",
              "summary": "Longer evidence for the model", "content": "", "date": "2026-10-17T00:00:00Z" },
            { "url": "https://example.com/a", "title": "A duplicate" },
            { "url": "https://example.com/b", "title": "B" }
        ] });
        let output = parse_response(CloudWebSearchProvider::DeepSeek, &raw, 1).unwrap();
        assert_eq!(output["results"].as_array().unwrap().len(), 1);
        assert_eq!(output["results"][0]["snippet"], "excerpt");
        assert_eq!(
            output["results"][0]["summary"],
            "Longer evidence for the model"
        );
        assert_eq!(output["results"][0]["publishedAt"], "2026-10-17T00:00:00Z");
        assert_eq!(output["results"][0]["sourceId"], "https://example.com/a");
        assert_eq!(output["truncated"], true);
        assert_eq!(output["partial"], false);
        let all = parse_response(CloudWebSearchProvider::DeepSeek, &raw, 5).unwrap();
        assert_eq!(all["results"].as_array().unwrap().len(), 2);
        assert_eq!(all["results"][1]["url"], "https://example.com/b");
        assert!(parse_response(
            CloudWebSearchProvider::DeepSeek,
            &json!({"text": "https://example.com"}),
            5
        )
        .is_err());
        assert!(
            parse_response(CloudWebSearchProvider::DeepSeek, &json!({"results": {}}), 5).is_err()
        );
        assert_eq!(
            parse_response(CloudWebSearchProvider::DeepSeek, &json!({"results": []}), 5).unwrap()
                ["results"],
            json!([])
        );
    }

    #[test]
    fn glm_sources_and_kimi_opaque_evidence_remain_distinct() {
        let glm = parse_response(CloudWebSearchProvider::Glm, &json!({"search_result": [
            {"title":"Release", "link":"https://example.com", "content":"Details", "publish_date":"2026-09-10"}
        ]}), 5).unwrap();
        assert_eq!(glm["results"][0]["snippet"], "Details");
        let encrypted = "----MOONSHOT ENCRYPTED BEGIN----test----MOONSHOT ENCRYPTED END----";
        let kimi = parse_response(CloudWebSearchProvider::Kimi, &json!({"status":"succeeded", "id":"fiber:1", "context":{"encrypted_output":encrypted}}), 5).unwrap();
        assert_eq!(kimi["providerContent"], encrypted);
        assert!(kimi.get("results").is_none());
        assert!(
            parse_response(CloudWebSearchProvider::Kimi, &json!({"status":"failed"}), 5).is_err()
        );
    }

    #[test]
    fn deepseek_keeps_usable_sources_and_exposes_bad_entries_without_inventing_urls() {
        let response = json!({"results": [
            {"url": "https://example.com/first", "title": "First"},
            {"url": "/relative", "title": "Invalid"},
            {"text": "https://example.com/not-a-source"},
            {"url": "https://example.com/last", "title": "Last"}
        ]});
        let output = parse_deepseek(&response, 5).unwrap();
        assert_eq!(output["results"].as_array().unwrap().len(), 2);
        assert_eq!(output["results"][1]["url"], "https://example.com/last");
        assert_eq!(output["partial"], true);
        assert_eq!(output["resultIssues"].as_array().unwrap().len(), 2);
        assert_eq!(output["resultIssues"][0]["url"], "/relative");
        assert!(parse_deepseek(&json!({"results": [{"url":"/relative"}]}), 5).is_err());
        assert!(parse_deepseek(
            &json!({"results": [{"url":"https://example.com", "summary":42}]}),
            5
        )
        .is_err());
    }

    #[test]
    fn deepseek_preserves_provider_errors_instead_of_returning_success_or_empty_results() {
        let error = json!({"type":"invalid_request_error", "code":"invalid_request_error",
            "message":"'count' must be between 1 and 50", "param":null});
        for results in [json!([]), json!([{"url":"https://example.com/docs"}])] {
            let response = json!({"error":error, "results":results});
            let failure =
                parse_response(CloudWebSearchProvider::DeepSeek, &response, 5).unwrap_err();
            match failure {
                KernelError::Structured { code, message, .. } => {
                    assert_eq!(code, "web_search_provider_error");
                    assert_eq!(serde_json::from_str::<Value>(&message).unwrap(), error);
                }
                other => panic!("expected the provider error, got {other:?}"),
            }
        }
    }
}
