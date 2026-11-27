use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::{Error, Update, UpdaterExt};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

enum TlsPeer {
    Eof(usize),
    PlainHttp,
}

// Only the application runtime is mocked. The updater follows the HTTP redirect,
// negotiates TLS, parses the manifest and compares the version itself.
fn check_feed(
    peer: TlsPeer,
    version: &str,
    may_retry: impl Fn() -> bool,
) -> (tauri_plugin_updater::Result<Option<Update>>, [usize; 2]) {
    let (failures, reply): (usize, &[u8]) = match peer {
        TlsPeer::Eof(count) => (count, b""),
        TlsPeer::PlainHttp => (1, b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"),
    };
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = env!("CARGO_PKG_VERSION").parse().unwrap();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({"pubkey": "unused for a manifest check", "dangerousInsecureTransportProtocol": true}),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    tauri::async_runtime::block_on(async {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tls = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", http.local_addr().unwrap());
        let redirect = format!("HTTP/1.1 302 Found\r\nLocation: https://{}/latest.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", tls.local_addr().unwrap());
        let target = tauri_plugin_updater::target().unwrap();
        let body = json!({"version": version, "platforms": {(target): {
            "url": format!("{origin}/must-not-download"), "signature": "unused for a manifest check"
        }}})
        .to_string();
        let manifest = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let updater = app
            .updater_builder()
            .executable_path(std::env::current_exe().expect("test executable"))
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .endpoints(vec![format!("{origin}/latest.json").parse().unwrap()])
            .unwrap()
            .build()
            .unwrap();
        let counts = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
        let observed = counts.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = http.accept().await.unwrap();
                let mut lines = BufReader::new(&mut stream).lines();
                assert_eq!(
                    lines.next_line().await.unwrap().as_deref(),
                    Some("GET /latest.json HTTP/1.1")
                );
                while !lines.next_line().await.unwrap().unwrap().is_empty() {}
                let attempt = observed[0].fetch_add(1, Ordering::SeqCst);
                if attempt >= failures {
                    stream.write_all(manifest.as_bytes()).await.unwrap();
                    continue;
                }
                stream.write_all(redirect.as_bytes()).await.unwrap();
                drop(stream);
                let (mut peer, _) = tls.accept().await.unwrap();
                let mut header = [0; 5];
                peer.read_exact(&mut header).await.unwrap();
                assert_eq!(header[0], 22, "TLS handshake record");
                let mut hello = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
                peer.read_exact(&mut hello).await.unwrap();
                assert_eq!(hello.first(), Some(&1), "TLS ClientHello");
                observed[1].fetch_add(1, Ordering::SeqCst);
                // An empty reply closes before ServerHello; plaintext tests a protocol error instead.
                if !reply.is_empty() {
                    peer.write_all(reply).await.unwrap();
                    peer.shutdown().await.unwrap();
                }
            }
        });
        let checked =
            tokio::time::timeout(Duration::from_secs(15), super::check(&updater, may_retry)).await;
        server.abort();
        let stopped = server.await.unwrap_err();
        assert!(stopped.is_cancelled(), "loopback fixture failed: {stopped}");
        (
            checked.expect("bounded manifest check"),
            std::array::from_fn(|i| counts[i].load(Ordering::SeqCst)),
        )
    })
}

fn assert_connect_error(result: tauri_plugin_updater::Result<Option<Update>>, cause: &str) {
    let error = result.err().expect("a TLS failure must not mean current");
    assert!(
        matches!(&error, Error::Reqwest(request) if request.is_connect()),
        "{error:?}"
    );
    let detail = super::super::update_error("Check for updates", error);
    assert!(
        detail.starts_with("Check for updates") && detail.to_lowercase().contains(cause),
        "{detail}"
    );
}

#[test]
fn redirected_tls_eof_then_current_or_older_manifest_finishes_the_same_check() {
    for version in [env!("CARGO_PKG_VERSION"), "0.0.1"] {
        let (result, counts) = check_feed(TlsPeer::Eof(1), version, || true);
        assert!(
            result.unwrap().is_none(),
            "same or older version must not download"
        );
        assert_eq!(counts, [2, 1], "feed requests and TLS ClientHellos");
    }
}

#[test]
fn repeated_redirected_tls_eof_stops_after_three_attempts_with_the_real_error() {
    let (result, counts) = check_feed(TlsPeer::Eof(usize::MAX), env!("CARGO_PKG_VERSION"), || true);
    assert_connect_error(result, "tls handshake eof");
    assert_eq!(counts, [3, 3]);
}

#[test]
fn invalid_manifest_is_not_retried() {
    let (result, counts) = check_feed(TlsPeer::Eof(0), "not-a-version", || true);
    assert!(matches!(result, Err(Error::Serialization(_))));
    assert_eq!(counts, [1, 0]);
}

#[test]
fn disabled_auto_check_does_not_open_another_connection() {
    let (result, counts) = check_feed(TlsPeer::Eof(1), env!("CARGO_PKG_VERSION"), || false);
    assert_connect_error(result, "tls handshake eof");
    assert_eq!(counts, [1, 1]);
}

#[test]
fn non_tls_response_is_a_connect_error_but_is_not_retried() {
    let (result, counts) = check_feed(TlsPeer::PlainHttp, env!("CARGO_PKG_VERSION"), || true);
    assert_connect_error(
        result,
        "received corrupt message of type invalidcontenttype",
    );
    assert_eq!(counts, [1, 1]);
}

#[test]
fn retry_permission_is_rechecked_before_the_next_connection() {
    // First observation schedules a retry; the next observes that automatic checks are now off.
    let enabled = std::cell::Cell::new(true);
    let (result, counts) = check_feed(TlsPeer::Eof(1), env!("CARGO_PKG_VERSION"), || {
        enabled.replace(false)
    });
    assert_connect_error(result, "tls handshake eof");
    assert_eq!(counts, [1, 1]);
}
