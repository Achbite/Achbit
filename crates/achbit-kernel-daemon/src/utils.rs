use crate::api_response::ApiResponse;
use crate::prelude::*;
use axum::extract::Request;
use axum::http::request::Parts;
use axum::http::HeaderValue;
use axum::middleware::Next;
use tower_http::cors::AllowOrigin;

pub(crate) fn localhost_cors_layer() -> CorsLayer {
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
            header::HeaderName::from_static(crate::host_connection::HOST_SHELL_TOKEN_HEADER),
        ])
}

pub(crate) async fn trusted_local_origin_gate(request: Request, next: Next) -> Response {
    if trusted_local_origin(request.headers()) {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        ApiResponse::error(
            "host_origin_forbidden",
            "DeepCode Host APIs accept only non-browser local clients, the same loopback application origin, or deepcode-gui://localhost",
        ),
    )
        .into_response()
}

fn trusted_local_origin(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    if origin == "deepcode-gui://localhost" {
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
    origin_token == request_token && is_loopback_origin_token(origin_token)
}

pub(crate) async fn trusted_host_connection_gate(
    axum::extract::State(token): axum::extract::State<crate::host_connection::HostConnection>,
    request: Request,
    next: Next,
) -> Response {
    if crate::host_connection::route_uses_specialized_transport(
        request.method(),
        request.uri().path(),
    ) || token.authorize(request.headers())
    {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        ApiResponse::error(
            "host_connection_required",
            "This Host API requires the process-private Host shell connection token",
        ),
    )
        .into_response()
}

fn trusted_cors_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if origin == "deepcode-gui://localhost" {
        return true;
    }
    origin
        .strip_prefix("http://")
        .map(is_loopback_origin_token)
        .unwrap_or(false)
}

fn is_loopback_origin_token(token: &str) -> bool {
    token == "localhost"
        || token.starts_with("localhost:")
        || token == "127.0.0.1"
        || token.starts_with("127.0.0.1:")
        || token == "[::1]"
        || token.starts_with("[::1]:")
}

pub(crate) struct DriveLocation {
    pub(crate) display: String,
    pub(crate) path: PathBuf,
}

pub(crate) fn platform_id() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

pub(crate) fn drive_locations() -> Vec<DriveLocation> {
    if !cfg!(windows) {
        return Vec::new();
    }
    ('A'..='Z')
        .filter_map(|letter| {
            let display = format!("{letter}:\\");
            let path = PathBuf::from(&display);
            path.exists().then_some(DriveLocation { display, path })
        })
        .collect()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub(crate) fn read_best_effort_json_file(path: &PathBuf) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn read_optional_json_file(path: &FsPath) -> Result<Option<Value>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("parse {}: {error}", path.display()))
}

pub(crate) fn atomic_write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|error| format!("open {}: {error}", tmp.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("write {}: {error}", tmp.display()))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| format!("rename {}: {error}", path.display()))
}

pub(crate) fn merge_object(target: &mut Value, patch: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(patch_object) = patch.as_object() else {
        return;
    };
    for (key, value) in patch_object {
        if value.is_null() {
            target_object.remove(key);
        } else {
            target_object.insert(key.clone(), value.clone());
        }
    }
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_json_distinguishes_absence_from_invalid_content() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-json-read-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let path = root.join("settings.json");
        assert_eq!(
            read_optional_json_file(&path).expect("missing is valid"),
            None
        );

        std::fs::create_dir_all(&root).expect("create owned temporary root");
        std::fs::write(&path, "{").expect("write invalid json");
        let error = read_optional_json_file(&path).expect_err("invalid JSON must fail");
        assert!(error.contains("parse"), "{error}");

        std::fs::write(&path, r#"{"value":1}"#).expect("write valid json");
        assert_eq!(
            read_optional_json_file(&path).expect("read valid json"),
            Some(json!({"value": 1}))
        );
        std::fs::remove_dir_all(root).expect("remove owned temporary root");
    }
}

pub(crate) fn now_text() -> String {
    now_millis().to_string()
}
pub(crate) fn new_runtime_ref(prefix: &str) -> Result<String, String> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|error| format!("Generate {prefix}: {error}"))?;
    let mut reference = format!("{prefix}:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut reference, "{byte:02x}").expect("String write");
    }
    Ok(reference)
}
