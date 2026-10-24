mod arxiv;
pub mod documents;
mod github;
mod pdf;

use reqwest::blocking::Client;
use reqwest::header::{HeaderName, HeaderValue, USER_AGENT};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_HTTP_ERROR_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy)]
enum PluginKind {
    Github,
    Arxiv,
    Pdf,
}

impl PluginKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "github" => Ok(Self::Github),
            "arxiv" => Ok(Self::Arxiv),
            "pdf" => Ok(Self::Pdf),
            _ => Err(format!("unknown first-party plugin: {value}")),
        }
    }

    fn call(self, name: &str, arguments: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
        match self {
            Self::Github => github::call(name, arguments),
            Self::Arxiv => arxiv::call(name, arguments),
            Self::Pdf => pdf::call(name, arguments, metadata),
        }
    }
}

#[derive(Debug)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(crate) type ToolResult<T> = Result<T, ToolError>;

pub fn run_from_args(arguments: impl Iterator<Item = String>) -> Result<(), String> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.len() != 3 || arguments[0] != "--plugin" || arguments[2] != "--call" {
        return Err(
            "usage: achbit-first-party-provider --plugin <github|arxiv|pdf> --call".to_string(),
        );
    }
    let plugin = PluginKind::parse(&arguments[1])?;
    let request: Value = serde_json::from_reader(std::io::stdin().take(4 * 1024 * 1024))
        .map_err(|error| format!("decode CLI input: {error}"))?;
    let name = request["name"].as_str().ok_or("CLI input requires name")?;
    let output = match plugin.call(name, &request["arguments"], request.get("context")) {
        Ok(value) => value,
        Err(error) => json!({"error":{"code":error.code,"message":error.message}}),
    };
    serde_json::to_writer(std::io::stdout(), &output).map_err(|error| error.to_string())
}

pub(crate) fn input_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> ToolResult<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| ToolError::new("tool_input_invalid", "tool input must be an object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ToolError::new(
            "tool_input_invalid",
            format!("unsupported tool input field: {field}"),
        ));
    }
    Ok(object)
}

pub(crate) fn required_string(object: &Map<String, Value>, field: &str) -> ToolResult<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ToolError::new("tool_input_invalid", format!("{field} is required")))
}

pub(crate) fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> ToolResult<Option<String>> {
    match object.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| ToolError::new("tool_input_invalid", format!("{field} must be text"))),
    }
}

pub(crate) fn optional_u64(
    object: &Map<String, Value>,
    field: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> ToolResult<u64> {
    let value = match object.get(field) {
        None => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            ToolError::new("tool_input_invalid", format!("{field} must be an integer"))
        })?,
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(ToolError::new(
            "tool_input_invalid",
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(value)
}

pub(crate) struct HttpResponse {
    pub(crate) body: Vec<u8>,
    pub(crate) final_url: String,
    pub(crate) headers: BTreeMap<String, String>,
}

pub(crate) fn http_get(
    url: reqwest::Url,
    max_bytes: usize,
    headers: Vec<(HeaderName, HeaderValue)>,
) -> ToolResult<HttpResponse> {
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| ToolError::new("network_client_failed", error.to_string()))?;
    let mut request = client
        .get(url)
        .header(USER_AGENT, "DeepCode-first-party-tools/0.5");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .map_err(|error| ToolError::new("network_request_failed", error.to_string()))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    let read_limit = if status.is_success() {
        max_bytes
    } else {
        MAX_HTTP_ERROR_BYTES
    };
    let mut body = Vec::new();
    response
        .take(read_limit.saturating_add(1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| ToolError::new("network_response_read_failed", error.to_string()))?;
    if !status.is_success() {
        body.truncate(read_limit);
        let detail = String::from_utf8_lossy(&body);
        return Err(ToolError::new(
            "network_response_failed",
            format!("HTTP {} from {final_url}: {detail}", status.as_u16()),
        ));
    }
    if body.len() > max_bytes {
        return Err(ToolError::new(
            "network_response_too_large",
            format!("response from {final_url} exceeds {max_bytes} bytes"),
        ));
    }
    Ok(HttpResponse {
        body,
        final_url,
        headers: response_headers,
    })
}

pub(crate) fn response_text(response: &HttpResponse) -> ToolResult<&str> {
    std::str::from_utf8(&response.body)
        .map_err(|error| ToolError::new("network_response_encoding_invalid", error.to_string()))
}

pub(crate) fn now_millis() -> ToolResult<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| ToolError::new("system_clock_invalid", error.to_string()))
}

pub(crate) fn limit_text(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}
