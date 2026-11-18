use super::{lookup, source};
use crate::{http_get, limit_text, now_millis, optional_u64, response_text, ToolError, ToolResult};
use fs2::FileExt;
use htmd::{Element, HtmlToMarkdown};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize)]
struct Block {
    label: String,
    text: String,
}

#[derive(Serialize, Deserialize)]
struct Paper {
    id: String,
    format: String,
    source_url: String,
    blocks: Vec<Block>,
}

fn cache_error(e: impl std::fmt::Display) -> ToolError {
    ToolError::new("arxiv_cache_unavailable", e.to_string())
}

// Only the article is evidence. Abstract and error pages may also return HTTP 200.
fn html_blocks(html: &str) -> ToolResult<Option<Vec<Block>>> {
    let article = Arc::new(Mutex::new(None));
    let captured = article.clone();
    let converter = HtmlToMarkdown::builder()
        .skip_tags(vec![
            "head", "script", "style", "nav", "footer", "noscript", "form", "svg", "iframe",
        ])
        .add_handler(vec!["article"], move |e: Element| {
            if e.attrs.iter().any(|a| {
                a.name.local.as_ref() == "class"
                    && a.value
                        .split_ascii_whitespace()
                        .any(|v| v == "ltx_document")
            }) {
                *captured.lock().expect("HTML article") = Some(e.content.to_owned());
            }
            None
        })
        .add_handler(vec!["math"], |e: Element| {
            e.attrs
                .iter()
                .find(|a| a.name.local.as_ref() == "alttext")
                .map(|a| format!(" {d}{}{d} ", a.value, d = '$'))
                .or_else(|| Some(e.content.to_owned()))
        })
        .build();
    converter
        .convert(html)
        .map_err(|e| ToolError::new("arxiv_html_invalid", e.to_string()))?;
    let Some(text): Option<String> = article.lock().expect("HTML article").take() else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let mut blocks = Vec::new();
    let mut current = Block {
        label: "Article".into(),
        text: String::new(),
    };
    for line in text.lines() {
        let heading = line.trim_start_matches('#');
        if line.starts_with('#') && heading.starts_with(' ') {
            if !current.text.trim().is_empty() {
                blocks.push(current);
            }
            current = Block {
                label: heading.trim().to_owned(),
                text: String::new(),
            };
        }
        current.text.push_str(line);
        current.text.push('\n');
    }
    if !current.text.trim().is_empty() {
        blocks.push(current);
    }
    Ok(Some(blocks))
}

fn fetch(id: &str) -> ToolResult<Paper> {
    let html = format!("https://arxiv.org/html/{id}");
    let url =
        |s: &str| Url::parse(s).map_err(|e| ToolError::new("arxiv_url_invalid", format!("{e}")));
    match http_get(url(&html)?, 16 * 1024 * 1024, Vec::new()) {
        Ok(reply) => {
            if let Some(blocks) = html_blocks(response_text(&reply)?)? {
                return Ok(Paper {
                    id: id.to_string(),
                    format: "html".into(),
                    source_url: html,
                    blocks,
                });
            }
        }
        Err(e) if matches!(e.http_status, Some(404 | 410)) => {}
        Err(e) => return Err(e),
    }
    let pdf = format!("https://arxiv.org/pdf/{id}");
    let reply = http_get(url(&pdf)?, 16 * 1024 * 1024, Vec::new())?;
    if !reply.body.starts_with(b"%PDF-") {
        return Err(ToolError::new(
            "arxiv_pdf_invalid",
            "arXiv returned a non-PDF response",
        ));
    }
    let (_, pages) = crate::pdf::extract_pages(&reply.body, 0..usize::MAX)
        .map_err(|message| ToolError::new("arxiv_pdf_extract_failed", message))?;
    if pages.iter().all(|page| page.trim().is_empty()) {
        return Err(ToolError::new(
            "arxiv_pdf_needs_ocr",
            format!("No readable text layer in {pdf}"),
        ));
    }
    Ok(Paper {
        id: id.to_string(),
        format: "pdf".into(),
        source_url: pdf,
        blocks: pages
            .into_iter()
            .enumerate()
            .map(|(i, text)| Block {
                label: format!("Page {}", i + 1),
                text,
            })
            .collect(),
    })
}

fn load(id: &str, dir: Option<&Path>) -> ToolResult<Paper> {
    let Some(dir) = dir else { return fetch(id) };
    let key = id.replace('/', "_");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(format!("{key}.lock")))
        .map_err(cache_error)?;
    FileExt::lock_exclusive(&lock).map_err(cache_error)?;
    let path = dir.join(format!("{key}.json"));
    match std::fs::File::open(&path) {
        Ok(file) => return serde_json::from_reader(file).map_err(cache_error),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(cache_error(e)),
    }
    let paper = fetch(id)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(cache_error)?;
    serde_json::to_writer(&mut tmp, &paper).map_err(cache_error)?;
    tmp.persist(path).map_err(cache_error)?;
    Ok(paper)
}

fn excerpt(paper: &Paper, obj: &Map<String, Value>) -> ToolResult<Value> {
    let (key, other) = if paper.format == "pdf" {
        ("page", "section")
    } else {
        ("section", "page")
    };
    if obj.contains_key(other) {
        return Err(ToolError::new(
            "tool_input_invalid",
            format!("Use {key} for the {} source", paper.format),
        ));
    }
    let index = optional_u64(obj, key, 1, 1, paper.blocks.len() as u64)? as usize - 1;
    let block = &paper.blocks[index];
    let offset = optional_u64(obj, "offset", 0, 0, block.text.len() as u64)? as usize;
    let remainder = block.text.get(offset..).ok_or_else(|| {
        ToolError::new(
            "tool_input_invalid",
            "Offset must be a UTF-8 character boundary",
        )
    })?;
    let budget = optional_u64(obj, "maxBytes", 24_576, 1_024, 131_072)? as usize;
    let (content, partial) = limit_text(remainder, budget);
    let next = if partial {
        Some((index, offset + content.len()))
    } else if index + 1 < paper.blocks.len() {
        Some((index + 1, 0))
    } else {
        None
    };
    let next =
        next.map(|(i, offset)| json!({"id":paper.id,"view":"fullText",(key):i+1,"offset":offset}));
    let mut result = json!({"backendId":"arxiv","view":"fullText","arxivId":paper.id,"format":paper.format,
        "sourceUrl":paper.source_url,"location":block.label,(key):index+1, "offset":offset,"text":content,
        "textAvailable":!block.text.trim().is_empty(),"totalParts":paper.blocks.len(),"next":next,"retrievedAtMs":now_millis()?});
    if index == 0 && offset == 0 && key == "section" {
        result["sections"] = json!(paper
            .blocks
            .iter()
            .enumerate()
            .map(|(i, b)| json!({"section":i+1,"title":b.label}))
            .collect::<Vec<_>>());
    }
    Ok(result)
}

pub(super) fn read(
    id: &str,
    obj: &Map<String, Value>,
    context: Option<&Value>,
) -> ToolResult<Value> {
    let pinned = if source::versioned(id) {
        id.to_string()
    } else {
        let (record, _) = lookup(id, context)?;
        record["arxivId"]
            .as_str()
            .filter(|v| source::versioned(v))
            .ok_or_else(|| {
                ToolError::new(
                    "arxiv_version_missing",
                    "arXiv did not identify the paper version",
                )
            })?
            .to_string()
    };
    let cache = context
        .and_then(|v| v.pointer("/achbit/arxivPaperCache"))
        .and_then(Value::as_str)
        .map(Path::new);
    excerpt(&load(&pinned, cache)?, obj)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_the_article_and_pins_continuations_inside_a_long_section() {
        let text = "量".repeat(900);
        let html = format!("<nav>menu</nav><article class='ltx_document'><h2>Methods</h2><p>{text}</p><math alttext='x+y'>wrong</math><h2>Results</h2>last</article>");
        let blocks = html_blocks(&html).unwrap().unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].text.contains("x+y"));
        assert!(!blocks[0].text.contains("menu"));
        let paper = Paper {
            id: "1706.03762v7".into(),
            format: "html".into(),
            source_url: "https://arxiv.org/html/1706.03762v7".into(),
            blocks,
        };
        let first = excerpt(&paper, json!({"maxBytes":1024}).as_object().unwrap()).unwrap();
        assert_eq!(first["next"]["section"], 1);
        let more = excerpt(&paper, first["next"].as_object().unwrap()).unwrap();
        assert_eq!(
            format!(
                "{}{}",
                first["text"].as_str().unwrap(),
                more["text"].as_str().unwrap()
            ),
            paper.blocks[0].text
        );
        assert_eq!(more["next"]["section"], 2);
        assert!(html_blocks("<h1>Abstract only</h1>").unwrap().is_none());
    }
}
