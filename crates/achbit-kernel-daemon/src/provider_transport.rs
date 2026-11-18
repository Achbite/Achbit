use serde_json::{json, Value};
use std::error::Error;
use std::io::ErrorKind;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Routing state belongs to the existing run-bound Provider runtime, never the
/// shared HTTP pool. Clones within that runtime retain the first server token.
pub(crate) type CodexTurnState = Arc<OnceLock<reqwest::header::HeaderValue>>;

#[derive(Clone, Debug)]
pub(crate) struct CodexRequestContext {
    pub(crate) session_id: String,
    pub(crate) turn_state: CodexTurnState,
}

/// One connection pool per transport service. Session owns the retry budget.
#[derive(Clone)]
pub(crate) struct ProviderTransport {
    pub(crate) client: reqwest::Client,
}

impl ProviderTransport {
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                // Bound a silent connection, not the total time spent reasoning or streaming.
                // Session alone decides whether the resulting network failure is retried.
                .read_timeout(Duration::from_secs(300))
                .build()?,
        })
    }
}

pub(crate) fn safe_detail(message: &str, secret: Option<&str>) -> String {
    let message = match secret.filter(|value| !value.is_empty()) {
        Some(secret) => message.replace(secret, "[REDACTED]"),
        None => message.to_owned(),
    };
    let urls = regex::Regex::new(r#"https?://[^\s\"<>]+"#).expect("URL pattern");
    urls.replace_all(&message, |captures: &regex::Captures<'_>| {
        let Ok(mut url) = reqwest::Url::parse(&captures[0]) else {
            return "[URL]".to_string();
        };
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    })
    .chars()
    .filter(|c| *c != '\0')
    .take(4096)
    .collect()
}

pub(crate) fn network_failure(error: reqwest::Error, phase: &str, secret: Option<&str>) -> Value {
    let is_connect = error.is_connect();
    let is_timeout = error.is_timeout();
    let is_body = error.is_body();
    let error = error.without_url();
    let mut causes = Vec::new();
    let mut retryable = is_timeout;
    let mut cause: Option<&(dyn Error + 'static)> = Some(&error);
    while let Some(current) = cause {
        let mut item = json!({"message": safe_detail(&current.to_string(), secret)});
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            item["kind"] = json!(format!("{:?}", io.kind()));
            if let Some(code) = io.raw_os_error() {
                item["osCode"] = json!(code);
            }
            retryable |= matches!(
                io.kind(),
                ErrorKind::ConnectionReset
                    | ErrorKind::ConnectionRefused
                    | ErrorKind::ConnectionAborted
                    | ErrorKind::TimedOut
                    | ErrorKind::NotConnected
                    | ErrorKind::BrokenPipe
                    | ErrorKind::NetworkUnreachable
                    | ErrorKind::HostUnreachable
                    | ErrorKind::Interrupted
                    | ErrorKind::WouldBlock
            );
            // A peer can close during TLS setup or before the HTTP body ends.
            // Session owns the retry budget and never resends a completed turn.
            retryable |=
                io.kind() == ErrorKind::UnexpectedEof && matches!(phase, "send" | "responseBody");
        }
        // HTTP header EOF is a typed Hyper error without an underlying io::Error.
        // Keep malformed HTTP and explicit upstream failures out of network retries.
        if let Some(http) = current.downcast_ref::<hyper::Error>() {
            retryable |= http.is_incomplete_message();
        }
        causes.push(item);
        if causes.len() == 16 {
            break;
        }
        // hyper-rustls wraps the handshake's io::Error in ErrorKind::Other.
        // io::Error::source skips that inner error's own kind; inspect get_ref
        // first so UnexpectedEof and other native causes are not lost.
        cause = current
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.get_ref().map(|inner| inner as &(dyn Error + 'static)))
            .or_else(|| current.source());
    }
    json!({
        "code": if phase == "send" { "provider_transport_failed" } else { "provider_stream_read_failed" },
        "message": if phase == "send" { "Provider 连接失败。" } else { "读取 Provider 流失败。" },
        "diagnostics": {"source":"providerTransport", "phase":phase,
            "category":if retryable {"network"} else {"transport"}, "retryable":retryable,
            "isConnect":is_connect, "isTimeout":is_timeout, "isBody":is_body, "causes":causes}
    })
}

/// Capture only retry-related headers, including those embedded in streamed errors.
#[derive(Default)]
pub(crate) struct RetryAdvice {
    directive: Option<String>,
    at: Option<u64>,
}

impl RetryAdvice {
    pub(crate) fn read<'a>(header: impl Fn(&str) -> Option<&'a str>) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now();
        let milliseconds = |date: SystemTime| {
            u64::try_from(
                date.duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            )
            .ok()
        };
        let after = |duration| now.checked_add(duration).and_then(milliseconds);
        let numeric = |text: &str| text.trim().parse::<u64>().ok();
        let standard = header("retry-after").and_then(|text| {
            numeric(text)
                .and_then(|seconds| after(Duration::from_secs(seconds)))
                .or_else(|| httpdate::parse_http_date(text).ok().and_then(milliseconds))
        });
        let millis = header("retry-after-ms")
            .and_then(numeric)
            .and_then(|ms| after(Duration::from_millis(ms)));
        Self {
            directive: header("x-retry-metadata")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            at: standard
                .max(millis)
                .filter(|ms| *ms <= 8_640_000_000_000_000),
        }
    }

    pub(crate) fn http(headers: &reqwest::header::HeaderMap) -> Self {
        Self::read(|key| headers.get(key).and_then(|value| value.to_str().ok()))
    }

    pub(crate) fn apply(&self, failure: &mut Value, secret: Option<&str>) {
        if failure
            .pointer("/diagnostics/category")
            .and_then(Value::as_str)
            != Some("provider")
        {
            return;
        }
        let detail = &mut failure["diagnostics"]["providerError"];
        if let Some(value) = &self.directive {
            if detail["retryDirective"].as_str() != Some("NO_MORE_RETRY") {
                detail["retryDirective"] = json!(safe_detail(value, secret));
            }
        }
        if let Some(at) = self.at {
            detail["retryAt"] = json!(at.max(detail["retryAt"].as_u64().unwrap_or(0)));
        }
        let status = detail["httpStatus"].as_u64();
        let has = |values: &[&str]| {
            ["code", "type", "status"]
                .iter()
                .filter_map(|key| detail[*key].as_str())
                .any(|code| values.iter().any(|value| code.eq_ignore_ascii_case(value)))
        };
        let permanent = matches!(status, Some(401 | 402 | 403))
            || has(&[
                "insufficient_quota",
                "insufficient_balance",
                "billing_hard_limit_reached",
                "payment_required",
                "credit_balance_exhausted",
                "organization_spend_limit_exceeded",
                "project_spend_limit_exceeded",
                "authentication_error",
                "invalid_api_key",
                "permission_denied",
                "response.incomplete",
            ]);
        let temporary = status == Some(429)
            || has(&[
                "rate_limit_exceeded",
                "rate_limit_error",
                "rate_limit",
                "resource_exhausted",
                "server_is_overloaded",
                "overloaded_error",
                "slow_down",
            ]);
        let retryable = temporary
            && !permanent
            && detail["retryAt"].is_u64()
            && detail["retryDirective"].as_str() != Some("NO_MORE_RETRY");
        failure["diagnostics"]["retryable"] = json!(retryable);
        if failure["diagnostics"]["providerError"].is_null() {
            failure["diagnostics"]
                .as_object_mut()
                .unwrap()
                .remove("providerError");
        }
    }
}

/// A well-formed upstream failure retains its own code and retry instructions.
pub(crate) fn upstream_failure(
    code: &str,
    message: &str,
    error: &Value,
    advice: Option<&RetryAdvice>,
    secret: Option<&str>,
) -> Value {
    let mut details = serde_json::Map::new();
    for (key, value) in [
        ("code", error.get("code").and_then(Value::as_str)),
        ("type", error.get("type").and_then(Value::as_str)),
        ("status", error.get("status").and_then(Value::as_str)),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            let value = safe_detail(value, secret);
            if !value.trim().is_empty() {
                details.insert(key.into(), json!(value));
            }
        }
    }
    if let Some(code) = error.get("code").and_then(Value::as_u64) {
        details.insert("code".into(), json!(code.to_string()));
    }
    let mut failure = json!({
        "code": code,
        "message": safe_detail(message, secret),
        "diagnostics": {"source":"providerTransport", "phase":"response",
            "category":"provider", "retryable":false, "causes":[]},
    });
    if !details.is_empty() {
        failure["diagnostics"]["providerError"] = Value::Object(details);
    }
    let headers = error.get("headers").and_then(Value::as_object);
    RetryAdvice::read(|key| {
        headers?
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))?
            .1
            .as_str()
    })
    .apply(&mut failure, secret);
    if let Some(advice) = advice {
        advice.apply(&mut failure, secret);
    }
    failure
}

pub(crate) fn secondary_failure(mut primary: Value, code: &str, message: String) -> Value {
    if !primary["diagnostics"].is_object() {
        primary["diagnostics"] = json!({"source":"providerTransport", "phase":"archive",
            "category":"storage", "retryable":false, "causes":[]});
    }
    // A failed receipt cannot authorize another request with an unrecorded attempt.
    primary["diagnostics"]["retryable"] = json!(false);
    if !primary["diagnostics"]["secondary"].is_array() {
        primary["diagnostics"]["secondary"] = json!([]);
    }
    primary["diagnostics"]["secondary"]
        .as_array_mut()
        .unwrap()
        .push(json!({"code":code,"message":message}));
    primary
}

pub(crate) fn valid_diagnostics(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let text = |value: &Value| {
        value
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && !s.contains('\0'))
    };
    object.keys().all(|key| {
        [
            "source",
            "phase",
            "category",
            "retryable",
            "causes",
            "isConnect",
            "isTimeout",
            "isBody",
            "stopReason",
            "archivePath",
            "providerError",
            "secondary",
        ]
        .contains(&key.as_str())
    }) && ["source", "phase", "category"]
        .iter()
        .all(|key| text(&value[key]))
        && value["retryable"].is_boolean()
        && ["isConnect", "isTimeout", "isBody"]
            .iter()
            .all(|key| value.get(key).is_none_or(Value::is_boolean))
        && ["stopReason", "archivePath"]
            .iter()
            .all(|key| value.get(key).is_none_or(text))
        && value.get("providerError").is_none_or(|details| {
            details.as_object().is_some_and(|details| {
                !details.is_empty()
                    && details.iter().all(|(key, value)| {
                        if key == "retryAt" {
                            value.as_u64().is_some_and(|ms| ms <= 8_640_000_000_000_000)
                        } else if key == "httpStatus" {
                            value
                                .as_u64()
                                .is_some_and(|status| (100..=599).contains(&status))
                        } else {
                            ["code", "type", "status", "retryDirective"].contains(&key.as_str())
                                && text(value)
                        }
                    })
            })
        })
        && value["causes"].as_array().is_some_and(|causes| {
            causes.len() <= 16
                && causes.iter().all(|cause| {
                    cause.as_object().is_some_and(|o| {
                        o.keys()
                            .all(|key| ["message", "kind", "osCode"].contains(&key.as_str()))
                    }) && text(&cause["message"])
                        && cause.get("kind").is_none_or(text)
                        && cause.get("osCode").is_none_or(Value::is_i64)
                })
        })
        && value.get("secondary").is_none_or(|items| {
            items.as_array().is_some_and(|items| {
                items.len() <= 16
                    && items.iter().all(|item| {
                        item.as_object().is_some_and(|o| o.len() == 2)
                            && text(&item["code"])
                            && text(&item["message"])
                    })
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stalled_provider_reads_time_out_in_the_transport() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for phase in ["send", "responseBody"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (received, request_received) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                if phase == "responseBody" {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n").await.unwrap();
                }
                received.send(()).unwrap();
                let _ = released.await;
            });
            let client = ProviderTransport::new().unwrap().client;
            let send = tokio::spawn(async move {
                client
                    .get(format!("http://{address}/responses"))
                    .send()
                    .await
            });
            request_received.await.unwrap();
            let error = if phase == "send" {
                tokio::time::pause();
                tokio::time::timeout(Duration::from_secs(301), send)
                    .await
                    .expect("response headers must have a transport-owned idle timeout")
                    .unwrap()
                    .unwrap_err()
            } else {
                let mut response = send.await.unwrap().unwrap();
                assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"x");
                tokio::time::pause();
                tokio::time::timeout(Duration::from_secs(301), response.chunk())
                    .await
                    .expect("response body must have a transport-owned idle timeout")
                    .unwrap_err()
            };
            tokio::time::resume();
            release.send(()).unwrap();
            peer.await.unwrap();
            let failure = network_failure(error, phase, None);
            assert!(valid_diagnostics(&failure["diagnostics"]));
            assert_eq!(failure["diagnostics"]["phase"], phase);
            assert_eq!(failure["diagnostics"]["isTimeout"], true);
            assert_eq!(failure["diagnostics"]["retryable"], true);
            assert_eq!(failure["diagnostics"]["category"], "network");
        }
    }

    #[tokio::test]
    async fn active_provider_reads_reset_idle_timeout_without_a_total_deadline() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (next, mut chunks) = tokio::sync::mpsc::channel::<()>(1);
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n").await.unwrap();
            while chunks.recv().await.is_some() {
                socket.write_all(b"1\r\nx\r\n").await.unwrap();
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let mut response = ProviderTransport::new()
            .unwrap()
            .client
            .get(format!("http://{address}/responses"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"x");
        for _ in 0..3 {
            tokio::time::pause();
            let mut read = Box::pin(response.chunk());
            // Start the idle timer before time advances while the peer withholds data.
            poll_fn(|cx| {
                assert!(read.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            tokio::time::advance(Duration::from_secs(180)).await;
            tokio::time::resume();
            next.send(()).await.unwrap();
            assert_eq!(read.await.unwrap().unwrap().as_ref(), b"x");
        }
        drop(next);
        assert!(response.chunk().await.unwrap().is_none());
        peer.await.unwrap();
    }

    #[test]
    fn retry_advice_handles_dates_delay_milliseconds_and_stop_directives() {
        let date = "Sun, 06 Nov 1994 08:49:37 GMT";
        let advice = RetryAdvice::read(|name| (name == "retry-after").then_some(date));
        assert_eq!(advice.at, Some(784111777000));
        let invalid = RetryAdvice::read(|_| Some("n/a"));
        assert_eq!(invalid.at, None);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut failure = upstream_failure(
            "provider_error",
            "slow down",
            &json!({
                "code":"rate_limit_exceeded","headers":{"Retry-After-Ms":"750"}
            }),
            None,
            None,
        );
        assert!(
            failure["diagnostics"]["providerError"]["retryAt"]
                .as_u64()
                .unwrap()
                >= now + 750
        );
        assert_eq!(failure["diagnostics"]["retryable"], true);
        RetryAdvice::read(|key| (key == "x-retry-metadata").then_some("NO_MORE_RETRY"))
            .apply(&mut failure, None);
        assert_eq!(failure["diagnostics"]["retryable"], false);
        assert!(valid_diagnostics(&failure["diagnostics"]));
        let quota = upstream_failure(
            "provider_error",
            "out of credit",
            &json!({"code":"insufficient_quota",
            "type":"rate_limit_error", "headers":{"Retry-After":"2"}}),
            None,
            None,
        );
        assert_eq!(quota["diagnostics"]["retryable"], false);
    }

    #[tokio::test]
    async fn chunked_body_eof_is_transient_but_invalid_framing_is_not() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (tail, retryable) in [
            (b"".as_slice(), true),
            (b"invalid-size\r\n".as_slice(), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let content = b"data: {\"type\":\"response.created\"}\n\n";
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                socket
                    .write_all(format!("{:x}\r\n", content.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(content).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
                socket.write_all(tail).await.unwrap();
                socket.shutdown().await.unwrap();
            });
            let transport = ProviderTransport::new().unwrap();
            let mut response = transport
                .client
                .get(format!("http://{address}/responses"))
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap();
            let mut received = Vec::new();
            let error = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => received.extend_from_slice(&chunk),
                    Ok(None) => panic!("an incomplete HTTP body must not complete successfully"),
                    Err(error) => break error,
                }
            };
            peer.await.unwrap();
            assert_eq!(received, content);
            let failure = network_failure(error, "responseBody", None);
            assert!(valid_diagnostics(&failure["diagnostics"]));
            assert_eq!(failure["code"], "provider_stream_read_failed");
            assert_eq!(failure["diagnostics"]["phase"], "responseBody");
            assert_eq!(failure["diagnostics"]["isConnect"], false);
            assert_eq!(failure["diagnostics"]["isTimeout"], false);
            assert_eq!(failure["diagnostics"]["retryable"], retryable, "{failure}");
            assert_eq!(
                failure["diagnostics"]["category"],
                if retryable { "network" } else { "transport" }
            );
            if retryable {
                assert!(
                    failure["diagnostics"]["causes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|cause| cause["kind"] == "UnexpectedEof"),
                    "{failure}"
                );
            }
        }
    }

    #[tokio::test]
    async fn response_header_eof_is_transient_but_invalid_http_is_not() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (reply, retryable) in [
            (b"".as_slice(), true),
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n".as_slice(),
                true,
            ),
            (b"invalid HTTP\r\n\r\n".as_slice(), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                socket.write_all(reply).await.unwrap();
                socket.shutdown().await.unwrap();
            });
            let error = ProviderTransport::new()
                .unwrap()
                .client
                .get(format!("http://{address}/responses"))
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap_err();
            peer.await.unwrap();
            let failure = network_failure(error, "send", None);
            assert!(valid_diagnostics(&failure["diagnostics"]));
            assert_eq!(failure["diagnostics"]["retryable"], retryable, "{failure}");
            assert_eq!(
                failure["diagnostics"]["category"],
                if retryable { "network" } else { "transport" }
            );
        }
    }

    #[tokio::test]
    async fn tls_handshake_eof_is_transient_but_invalid_tls_is_not() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (reply, retryable) in [
            (None, true),
            (Some(b"HTTP/1.1 200 OK\r\n\r\n".as_slice()), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut hello = [0; 4096];
                assert!(socket.read(&mut hello).await.unwrap() > 0);
                if let Some(reply) = reply {
                    socket.write_all(reply).await.unwrap();
                }
                socket.shutdown().await.unwrap();
            });
            let transport = ProviderTransport::new().unwrap();
            let error = transport
                .client
                .post(format!("https://{address}/responses"))
                .body("request must not reach HTTP")
                .send()
                .await
                .unwrap_err();
            peer.await.unwrap();
            let failure = network_failure(error, "send", None);
            assert!(valid_diagnostics(&failure["diagnostics"]));
            assert_eq!(failure["diagnostics"]["isConnect"], true);
            assert_eq!(failure["diagnostics"]["retryable"], retryable, "{failure}");
            if retryable {
                assert_eq!(failure["diagnostics"]["category"], "network");
                assert!(
                    failure["diagnostics"]["causes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|cause| cause["kind"] == "UnexpectedEof"),
                    "{failure}"
                );
            }
        }
    }

    #[tokio::test]
    async fn connection_refusal_keeps_native_cause_and_redacts_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let transport = ProviderTransport::new().unwrap();
        let error = transport
            .client
            .get(format!(
                "http://127.0.0.1:{port}/responses?key=secret-value"
            ))
            .send()
            .await
            .unwrap_err();
        let failure = network_failure(error, "send", Some("secret-value"));
        assert!(valid_diagnostics(&failure["diagnostics"]));
        assert_eq!(failure["diagnostics"]["retryable"], true);
        assert_eq!(failure["diagnostics"]["isConnect"], true);
        assert!(failure["diagnostics"]["causes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cause| cause["osCode"].is_number()));
        assert!(!failure.to_string().contains("secret-value"));
        let combined = secondary_failure(
            failure.clone(),
            "execution_archive_failed",
            "Disk unavailable".into(),
        );
        assert_eq!(combined["code"], failure["code"]);
        assert_eq!(combined["diagnostics"]["retryable"], false);
        assert_eq!(
            combined["diagnostics"]["secondary"][0]["code"],
            "execution_archive_failed"
        );
    }

    #[test]
    fn diagnostic_urls_exclude_userinfo_query_and_fragment() {
        let safe = safe_detail(
            "Failed https://name:password@example.com/v1?token=abcd#key secret",
            Some("secret"),
        );
        for credential in ["name", "password", "abcd", "#key", "secret"] {
            assert!(!safe.contains(credential));
        }
        assert!(safe.contains("example.com/v1"));
    }
}
