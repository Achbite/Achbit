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
            // No HTTP request was sent if the peer closed during TLS setup.
            retryable |= is_connect && phase == "send" && io.kind() == ErrorKind::UnexpectedEof;
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

/// A well-formed upstream failure is not a local protocol or network failure.
/// Session retains its existing network-only retry policy.
pub(crate) fn upstream_failure(
    code: &str,
    message: &str,
    error: &Value,
    retry_directive: Option<&str>,
    secret: Option<&str>,
) -> Value {
    let mut details = serde_json::Map::new();
    for (key, value) in [
        ("code", error.get("code").and_then(Value::as_str)),
        ("type", error.get("type").and_then(Value::as_str)),
        (
            "retryDirective",
            retry_directive.or_else(|| {
                error
                    .pointer("/headers/x-retry-metadata")
                    .and_then(Value::as_str)
            }),
        ),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            let value = safe_detail(value, secret);
            if !value.trim().is_empty() {
                details.insert(key.into(), json!(value));
            }
        }
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
                        ["code", "type", "retryDirective"].contains(&key.as_str()) && text(value)
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
