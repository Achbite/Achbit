use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use deepcode_kernel_abi::{
    is_valid_host_instance_id, is_valid_host_shell_token, is_valid_host_ui_token,
    HOST_INSTANCE_ID_ENV, HOST_SHELL_TOKEN_ENV, HOST_SHELL_TOKEN_HEADER, HOST_UI_TOKEN_ENV,
    HOST_UI_TOKEN_HEADER,
};
use serde::Serialize;
use serde_json::Value;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

mod ui_plugins;

#[derive(Clone)]
struct AppState {
    daemon_base_url: String,
    client: reqwest::Client,
    host_ui_token: String,
    identity: HostProcessIdentity,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProcessIdentity {
    service: &'static str,
    instance_id: String,
    pid: u32,
    address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
    message: Option<String>,
}

impl ApiResponse {
    fn ok(data: Value) -> axum::Json<Self> {
        axum::Json(Self {
            ok: true,
            data: Some(data),
            error: None,
            message: None,
        })
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> axum::Json<Self> {
        axum::Json(Self {
            ok: false,
            data: None,
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(31245);
    let daemon_host =
        std::env::var("DEEPCODE_DAEMON_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let daemon_port = std::env::var("DEEPCODE_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(|| port.saturating_add(1));
    assert!(
        is_loopback_host(&host) && is_loopback_host(&daemon_host),
        "DeepCode Host proxy and daemon targets must both be loopback"
    );
    let daemon_base_url = format!("http://{daemon_host}:{daemon_port}");
    assert!(
        std::env::var("DEEPCODE_HOST_WEB_SPAWN_DAEMON").as_deref() == Ok("0"),
        "DeepCode Host proxy must be launched by the owning Host process with DEEPCODE_HOST_WEB_SPAWN_DAEMON=0"
    );
    let host_ui_token = required_local_token(HOST_UI_TOKEN_ENV, is_valid_host_ui_token);
    let daemon_host_token = required_local_token(HOST_SHELL_TOKEN_ENV, is_valid_host_shell_token);
    assert!(
        host_ui_token != daemon_host_token,
        "Host UI 与 daemon 必须使用不同的本地连接令牌"
    );
    let instance_id = required_instance_id();
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
    assert!(
        addr.ip().is_loopback(),
        "DeepCode Host private API requires a loopback listener"
    );

    let state = AppState {
        daemon_base_url,
        client: daemon_client(&daemon_host_token),
        host_ui_token,
        identity: HostProcessIdentity {
            service: "deepcode-host-web",
            instance_id,
            pid: std::process::id(),
            address: format!("http://{addr}"),
        },
    };

    let mut app = Router::new()
        .route("/", get(gui_index))
        .route("/index.html", get(gui_index))
        .route("/api/host/identity", get(proxy_identity))
        .route(
            "/api/host/plugins/inspect",
            axum::routing::post(ui_plugins::inspect),
        )
        .route(
            "/api/host/ui-plugins/watch",
            axum::routing::post(ui_plugins::watch),
        )
        .route("/api/health", get(proxy_health))
        .route("/api/*path", any(proxy_api))
        .route("/assets/*asset_path", get(gui_asset));

    if let Some(client_dist) = client_dist_dir() {
        let index_path = client_dist.join("index.html");
        app = app.fallback_service(
            ServeDir::new(client_dist.clone()).not_found_service(ServeFile::new(index_path)),
        );
        println!(
            "DeepCode dev Host GUI assets served from {}",
            client_dist.display()
        );
    }

    let app = app
        .with_state(state)
        .layer(localhost_cors_layer())
        .layer(axum::middleware::from_fn(trusted_local_origin_gate));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind deepcode dev host");
    println!("DeepCode dev Host listening on http://{addr}");
    println!(
        "DeepCode dev Host proxies /api/* to Kernel daemon at http://{daemon_host}:{daemon_port}"
    );
    // The owning GUI retains the pipe writer in Child.stdin. EOF also covers
    // owner termination, when its normal shutdown callbacks cannot run.
    let (owner_closed, closed) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let result = std::io::copy(
            &mut std::io::stdin().lock().take(u64::MAX),
            &mut std::io::sink(),
        );
        if let Err(error) = result {
            eprintln!("Host owner pipe failed: {error}");
        }
        let _ = owner_closed.send(());
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = closed.await;
        })
        .await
        .expect("serve deepcode dev host");
}

fn localhost_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &HeaderValue, _request: &Parts| trusted_cors_origin(origin),
        ))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::HeaderName::from_static(HOST_UI_TOKEN_HEADER),
        ])
}

async fn trusted_local_origin_gate(request: Request, next: Next) -> Response {
    if trusted_local_origin(request.headers()) {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        ApiResponse::error(
            "host_origin_forbidden",
            "DeepCode Host APIs accept only non-browser local clients, the same loopback application origin, or a trusted DeepCode desktop origin",
        ),
    )
        .into_response()
}

fn trusted_local_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    if trusted_desktop_origin(origin) {
        return true;
    }
    let Some(origin_token) = origin.strip_prefix("http://") else {
        return false;
    };
    let Some(request_token) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin_token == request_token && is_loopback_token(origin_token)
}

fn trusted_cors_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if trusted_desktop_origin(origin) {
        return true;
    }
    origin
        .strip_prefix("http://")
        .map(is_loopback_token)
        .unwrap_or(false)
}

fn trusted_desktop_origin(origin: &str) -> bool {
    if matches!(origin, "deepcode-gui://localhost") {
        return true;
    }
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let (host, port) = authority
        .split_once(':')
        .map_or((authority, None), |(host, port)| (host, Some(port)));
    if !matches!(host, "deepcode-gui.localhost") {
        return false;
    }
    port.is_none_or(|port| port.parse::<u16>().is_ok_and(|port| port > 0))
}

fn is_loopback_token(token: &str) -> bool {
    token == "localhost"
        || token.starts_with("localhost:")
        || token == "127.0.0.1"
        || token.starts_with("127.0.0.1:")
        || token == "[::1]"
        || token.starts_with("[::1]:")
}

fn client_dist_dir() -> Option<PathBuf> {
    let path = std::env::var_os("DEEPCODE_CLIENT_DIST").map(PathBuf::from)?;
    if path.join("index.html").is_file() {
        Some(path)
    } else {
        eprintln!(
            "DEEPCODE_CLIENT_DIST={} does not contain index.html; static GUI disabled",
            path.display()
        );
        None
    }
}

async fn gui_index() -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let index_path = client_dist.join("index.html");
    match tokio::fs::read(index_path).await {
        Ok(content) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            content,
        )
            .into_response(),
        Err(error) => {
            ApiResponse::error("gui_index_unavailable", error.to_string()).into_response()
        }
    }
}

async fn gui_asset(State(_state): State<AppState>, uri: Uri) -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let relative = uri.path().trim_start_matches('/');
    let relative_path = Path::new(relative);
    if relative_path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(client_dist) = tokio::fs::canonicalize(client_dist).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(path) = tokio::fs::canonicalize(client_dist.join(relative_path)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !path.starts_with(&client_dist) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(content) => {
            let content_type = if path.extension().and_then(|value| value.to_str()) == Some("js") {
                "application/javascript"
            } else if path.extension().and_then(|value| value.to_str()) == Some("css") {
                "text/css"
            } else {
                "application/octet-stream"
            };
            ([(header::CONTENT_TYPE, content_type)], content).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn proxy_health(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_connection_rejected();
    }
    match state
        .client
        .get(format!("{}/api/health", state.daemon_base_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => proxy_response(response).await,
        Err(error) => proxy_request_error("kernel_daemon_unavailable", &error),
    }
}

async fn proxy_identity(State(state): State<AppState>) -> axum::Json<ApiResponse> {
    ApiResponse::ok(
        serde_json::to_value(&state.identity).expect("Host proxy identity must serialize"),
    )
}

async fn proxy_api(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_connection_rejected();
    }
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/api/health");
    if !host_proxy_path_allowed(method.as_str(), uri.path()) {
        return (
            StatusCode::NOT_FOUND,
            ApiResponse::error(
                "host_proxy_route_forbidden",
                "This transport is not exposed through the Host UI proxy",
            ),
        )
            .into_response();
    }
    let url = format!("{}{}", state.daemon_base_url, path_and_query);
    let body_limit = if uri.path().contains("/input-resources/") {
        32 * 1024 * 1024
    } else {
        16 * 1024 * 1024
    };
    let body_bytes = match axum::body::to_bytes(body, body_limit).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return ApiResponse::error(
                "proxy_body_read_failed",
                format!(
                    "请求读取失败（单次限额 {} MiB）：{error}",
                    body_limit / 1024 / 1024
                ),
            )
            .into_response();
        }
    };
    let reqwest_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut request = state.client.request(reqwest_method, url).body(body_bytes);
    if let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    // Bound connection/headers separately: an SSE subscription lives until its owner closes it.
    match tokio::time::timeout(Duration::from_secs(60), request.send()).await {
        Ok(Ok(response)) => proxy_response(response).await,
        Ok(Err(error)) => proxy_request_error("kernel_daemon_proxy_failed", &error),
        Err(error) => {
            ApiResponse::error("kernel_daemon_proxy_timeout", error.to_string()).into_response()
        }
    }
}

fn proxy_request_error(code: &str, error: &reqwest::Error) -> Response {
    let mut message = error.to_string();
    let mut cause = std::error::Error::source(error);
    while let Some(source) = cause {
        message.push_str(": ");
        message.push_str(&source.to_string());
        cause = source.source();
    }
    ApiResponse::error(code, message).into_response()
}

impl AppState {
    fn authorizes_host_request(&self, headers: &HeaderMap) -> bool {
        let Some(submitted) = headers
            .get(HOST_UI_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        constant_time_eq(submitted.as_bytes(), self.host_ui_token.as_bytes())
    }
}

fn host_proxy_path_allowed(method: &str, path: &str) -> bool {
    if method == Method::OPTIONS.as_str() {
        return true;
    }
    let segments = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        ("GET", ["api", "conversation", "sessions", _, "resources", "roots"])
        | ("POST", ["api", "conversation", "sessions", _, "resources", "list" | "watch"]) => true,

        ("GET", ["api", "health"])
        | ("GET", ["api", "workspaces", "current"])
        | ("GET", ["api", "workspaces", "default-path"])
        | ("POST", ["api", "workspaces", "open"])
        | ("POST", ["api", "workspaces", "save-file"])
        | ("PATCH", ["api", "workspaces", "current", "settings"])
        | ("GET", ["api", "fs", "initial-locations"])
        | ("GET", ["api", "fs", "browse"])
        | ("POST", ["api", "host", "inspect"])
        | ("POST", ["api", "host", "computer-preview"])
        | ("POST", ["api", "host", "computer-preview", "activate"])
        | ("GET", ["api", "user-settings"])
        | ("PATCH", ["api", "user-settings"])
        | ("POST", ["api", "user-settings", "workspace-sandbox"])
        | ("GET", ["api", "llm", "profiles"])
        | ("PATCH", ["api", "llm", "profiles"])
        | ("POST", ["api", "llm", "probe"])
        | ("GET", ["api", "llm", "connections"])
        | ("PATCH", ["api", "llm", "connections"])
        | ("POST", ["api", "llm", "usage"])
        | ("GET", ["api", "llm", "prices"])
        | ("POST", ["api", "llm", "auth"])
        | ("GET", ["api", "conversation", "catalog"])
        | ("GET", ["api", "conversation", "statuses"])
        | ("GET", ["api", "conversation", "plugins"])
        | ("GET", ["api", "conversation", "plugins", "skills"])
        | ("GET", ["api", "conversation", "catalog", "manage"])
        | ("POST", ["api", "conversation", "projects"])
        | ("POST", ["api", "conversation", "sessions"])
        | ("GET", ["api", "runtime", "shell"])
        | ("GET", ["api", "terminal", "capabilities"])
        | ("GET", ["api", "terminal", "warmup"])
        | ("POST", ["api", "terminal", "warmup"])
        | ("GET", ["api", "terminal", "sessions"])
        | ("POST", ["api", "terminal", "sessions"])
        | ("GET", ["api", "terminal", "events"])
        | ("GET", ["api", "browser", "runtime-status"])
        | ("POST", ["api", "browser", "open"])
        | ("POST", ["api", "browser", "reload"])
        | ("POST", ["api", "browser", "inspect-mode"]) => true,
        ("POST", ["api", "terminal", "sessions", _, "input"])
        | ("POST", ["api", "terminal", "sessions", _, "resize"])
        | ("POST", ["api", "terminal", "sessions", _, "restart"])
        | ("PATCH", ["api", "terminal", "sessions", _])
        | ("DELETE", ["api", "terminal", "sessions", _])
        | ("GET", ["api", "llm", "auth", _])
        | ("DELETE", ["api", "llm", "auth", _])
        | ("POST", ["api", "llm", "connections", _, "logout"])
        | ("GET", ["api", "llm", "connections", _, "quota"])
        | ("POST", ["api", "conversation", "sessions", _, "commands"])
        | ("PATCH", ["api", "conversation", "projects", _])
        | ("DELETE", ["api", "conversation", "projects", _])
        | ("PATCH", ["api", "conversation", "sessions", _])
        | ("DELETE", ["api", "conversation", "sessions", _])
        | ("POST", ["api", "conversation", "sessions", _, "directory-indexes"])
        | ("POST", ["api", "conversation", "sessions", _, "filesystem-references", "resolve"])
        | ("POST", ["api", "conversation", "sessions", _, "input-resources", _])
        | ("POST", ["api", "conversation", "sessions", _, "changes", "read"])
        | ("DELETE", ["api", "conversation", "sessions", _, "directory-indexes", _])
        | ("GET", ["api", "conversation", "sessions", _, "projection"])
        | ("GET", ["api", "conversation", "sessions", _, "context-compositions", _])
        | ("GET", ["api", "conversation", "sessions", _, "artifacts", _, "content"])
        | ("POST", ["api", "conversation", "sessions", _, "read"])
        | ("POST", ["api", "conversation", "sessions", _, "resources", "read"]) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn proxy_transport_error_preserves_the_underlying_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/health", listener.local_addr().unwrap());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (request, ()) = tokio::join!(
            client.get(&url).timeout(Duration::from_secs(2)).send(),
            async {
                let (stream, _) = listener.accept().await.unwrap();
                drop(stream);
            }
        );
        let error = request.unwrap_err();
        let original_cause = std::error::Error::source(&error)
            .expect("closed connection has an underlying cause")
            .to_string();
        assert!(!original_cause.is_empty());
        let response = proxy_request_error("kernel_daemon_proxy_failed", &error);
        let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "kernel_daemon_proxy_failed");
        let message = body["message"].as_str().unwrap();
        assert!(message.contains(&url));
        assert!(message.contains(&original_cause), "{message}");
        assert_ne!(message, error.to_string());
    }

    #[test]
    fn host_proxy_exposes_computer_preview_and_exact_target_activation() {
        for path in [
            "/api/host/computer-preview",
            "/api/host/computer-preview/activate",
        ] {
            assert!(host_proxy_path_allowed("POST", path), "{path}");
            assert!(!host_proxy_path_allowed("GET", path), "{path}");
        }
        assert!(!host_proxy_path_allowed(
            "POST",
            "/api/host/computer-preview/stop"
        ));
        assert!(!host_proxy_path_allowed(
            "POST",
            "/api/local-agent/kernel/execute"
        ));
    }

    #[test]
    fn host_proxy_exposes_only_the_exact_plugin_catalog_get_route() {
        assert!(host_proxy_path_allowed("GET", "/api/conversation/plugins"));
        assert!(!host_proxy_path_allowed(
            "POST",
            "/api/conversation/plugins"
        ));
        assert!(!host_proxy_path_allowed(
            "GET",
            "/api/conversation/plugins/extra"
        ));
    }

    #[test]
    fn host_proxy_exposes_skill_settings_to_the_plugins_page() {
        assert!(host_proxy_path_allowed(
            "GET",
            "/api/conversation/plugins/skills"
        ));
        assert!(!host_proxy_path_allowed(
            "POST",
            "/api/conversation/plugins/skills"
        ));
    }

    #[test]
    fn host_proxy_exposes_model_services_without_opening_internal_provider_routes() {
        for (method, path) in [
            ("GET", "/api/llm/connections"),
            ("PATCH", "/api/llm/connections"),
            ("POST", "/api/llm/usage"),
            ("GET", "/api/llm/prices"),
            ("POST", "/api/llm/auth"),
            ("GET", "/api/llm/auth/flow-1"),
            ("DELETE", "/api/llm/auth/flow-1"),
            ("POST", "/api/llm/connections/connection-1/logout"),
            ("GET", "/api/llm/connections/connection-1/quota"),
        ] {
            assert!(host_proxy_path_allowed(method, path), "{method} {path}");
        }
        assert!(!host_proxy_path_allowed("GET", "/api/llm/secrets"));
        assert!(!host_proxy_path_allowed(
            "POST",
            "/api/local-agent/provider"
        ));
    }
}

fn host_connection_rejected() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        ApiResponse::error(
            "host_connection_required",
            "This Host proxy requires its process-private Host UI connection token",
        ),
    )
        .into_response()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "::1" | "localhost")
}

fn required_local_token(environment_key: &str, validator: fn(&str) -> bool) -> String {
    let value =
        std::env::var(environment_key).unwrap_or_else(|_| panic!("{environment_key} is required"));
    assert!(validator(&value), "{environment_key} is malformed");
    value
}

fn required_instance_id() -> String {
    let instance_id = std::env::var(HOST_INSTANCE_ID_ENV)
        .unwrap_or_else(|_| panic!("{HOST_INSTANCE_ID_ENV} is required"));
    assert!(
        is_valid_host_instance_id(&instance_id),
        "{HOST_INSTANCE_ID_ENV} is malformed"
    );
    instance_id
}

fn daemon_client(host_shell_token: &str) -> reqwest::Client {
    let mut token_header = reqwest::header::HeaderValue::from_str(host_shell_token)
        .expect("validated Host shell token must be an HTTP header value");
    token_header.set_sensitive(true);
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        reqwest::header::HeaderName::from_static(HOST_SHELL_TOKEN_HEADER),
        token_header,
    );
    reqwest::Client::builder()
        .default_headers(default_headers)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("build private Host-to-Kernel client")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

async fn proxy_response(response: reqwest::Response) -> Response {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type_options = response
        .headers()
        .get("x-content-type-options")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if content_type
        .as_deref()
        .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        let mut builder = Response::builder().status(status);
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        if let Some(cache_control) = cache_control {
            builder = builder.header(header::CACHE_CONTROL, cache_control);
        }
        if let Some(content_type_options) = content_type_options {
            builder = builder.header("x-content-type-options", content_type_options);
        }
        return builder
            .body(Body::from_stream(response.bytes_stream()))
            .unwrap_or_else(|error| {
                ApiResponse::error("proxy_response_build_failed", error.to_string()).into_response()
            });
    }
    match tokio::time::timeout(Duration::from_secs(60), response.bytes()).await {
        Ok(Ok(bytes)) => {
            let mut builder = Response::builder().status(status);
            if let Some(content_type) = content_type {
                builder = builder.header(header::CONTENT_TYPE, content_type);
            }
            builder.body(Body::from(bytes)).unwrap_or_else(|error| {
                ApiResponse::error("proxy_response_build_failed", error.to_string()).into_response()
            })
        }
        Ok(Err(error)) => proxy_request_error("proxy_response_read_failed", &error),
        Err(error) => {
            ApiResponse::error("proxy_response_read_timeout", error.to_string()).into_response()
        }
    }
}
