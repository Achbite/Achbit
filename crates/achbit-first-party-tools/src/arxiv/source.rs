use crate::{http_get, now_millis, optional_string, HttpResponse, ToolError, ToolResult};
use fs2::FileExt;
use regex::Regex;
use reqwest::Url;
use serde_json::{Map, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

pub(super) fn identifier(value: &str) -> ToolResult<String> {
    let invalid = || {
        ToolError::new(
            "tool_input_invalid",
            "Use an arXiv ID or an official abstract, HTML or PDF link",
        )
    };
    let value = value.trim();
    let id = if value.contains("://") {
        let url = Url::parse(value).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || !matches!(
                url.host_str(),
                Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
            )
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(invalid());
        }
        let (kind, path) = url
            .path()
            .trim_matches('/')
            .split_once('/')
            .ok_or_else(invalid)?;
        if !matches!(kind, "abs" | "html" | "pdf") {
            return Err(invalid());
        }
        if kind == "pdf" {
            path.strip_suffix(".pdf").unwrap_or(path)
        } else {
            path
        }
        .to_string()
    } else {
        value
            .strip_prefix("arXiv:")
            .or_else(|| value.strip_prefix("arxiv:"))
            .unwrap_or(value)
            .to_string()
    };
    static ID: OnceLock<Regex> = OnceLock::new();
    if !ID
        .get_or_init(|| {
            Regex::new(r"^(?:[0-9]{4}\.[0-9]{4,5}|[a-zA-Z][a-zA-Z.-]*/[0-9]{7})(?:v[1-9][0-9]*)?$")
                .unwrap()
        })
        .is_match(&id)
    {
        return Err(invalid());
    }
    Ok(id)
}

pub(super) fn versioned(id: &str) -> bool {
    id.rsplit_once('v')
        .is_some_and(|(_, v)| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

pub(super) fn query_expression(
    obj: &Map<String, Value>,
    field: &str,
    value: &str,
) -> ToolResult<String> {
    let mut terms = vec![format!("({field}:{value})")];
    if let Some(author) = optional_string(obj, "author")? {
        if author.contains('"') {
            return Err(ToolError::new(
                "tool_input_invalid",
                "author must be a name without quotes",
            ));
        }
        terms.push(format!("au:\"{author}\""));
    }
    if let Some(cat) = optional_string(obj, "category")? {
        if !cat
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        {
            return Err(ToolError::new(
                "tool_input_invalid",
                "category must be a single arXiv category",
            ));
        }
        terms.push(format!("cat:{cat}"));
    }
    let date = |key: &str| -> ToolResult<Option<String>> {
        optional_string(obj, key)?
            .map(|s| {
                chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                    .map(|v| v.format("%Y%m%d").to_string())
                    .map_err(|_| {
                        ToolError::new(
                            "tool_input_invalid",
                            format!("{key} must be a valid YYYY-MM-DD date"),
                        )
                    })
            })
            .transpose()
    };
    let from = date("submittedFrom")?;
    let to = date("submittedTo")?;
    if from.is_some() || to.is_some() {
        let from = from.as_deref().unwrap_or("19910101");
        let to = to.as_deref().unwrap_or("99991231");
        if from > to {
            return Err(ToolError::new(
                "tool_input_invalid",
                "submittedFrom exceeds submittedTo",
            ));
        }
        terms.push(format!("submittedDate:[{from}0000 TO {to}2359]"));
    }
    if terms.len() == 1 {
        return Ok(format!("{field}:{value}"));
    }
    Ok(terms.join(" AND "))
}

fn ioe(e: std::io::Error) -> ToolError {
    ToolError::new("arxiv_rate_state_unavailable", e.to_string())
}

pub(super) fn atom_get(
    url: Url,
    max_bytes: usize,
    context: Option<&Value>,
) -> ToolResult<HttpResponse> {
    let root = match context
        .and_then(|v| v.pointer("/achbit/arxivRateDirectory"))
        .and_then(Value::as_str)
    {
        Some(dir) => PathBuf::from(dir),
        None => achbit_host_connection::UserDirectories::resolve()
            .map_err(ioe)?
            .cache_dir
            .join("arxiv"),
    };
    std::fs::create_dir_all(&root).map_err(ioe)?;
    let mut lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("atom.lock"))
        .map_err(ioe)?;
    FileExt::lock_exclusive(&lock).map_err(ioe)?;
    let mut stored = String::new();
    lock.read_to_string(&mut stored).map_err(ioe)?;
    if !stored.is_empty() {
        let last: u128 = stored.trim().parse().map_err(|_| {
            ToolError::new(
                "arxiv_rate_state_invalid",
                "Invalid last arXiv request time",
            )
        })?;
        let delay = 3000_u128.saturating_sub(now_millis()?.saturating_sub(last));
        std::thread::sleep(std::time::Duration::from_millis(delay as u64));
    }
    lock.seek(SeekFrom::Start(0)).map_err(ioe)?;
    let time = now_millis()?.to_string();
    lock.write_all(time.as_bytes()).map_err(ioe)?;
    lock.set_len(time.len() as u64).map_err(ioe)?;
    http_get(url, max_bytes, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_archive_and_version_in_real_link_shapes() {
        assert_eq!(
            identifier("https://arxiv.org/pdf/hep-th/9711200v3.pdf").unwrap(),
            "hep-th/9711200v3"
        );
        assert_eq!(identifier("arXiv:1706.03762v7").unwrap(), "1706.03762v7");
        assert!(identifier("https://example.org/abs/1706.03762v7").is_err());
    }
}
