use super::*;
use encoding_rs::{DecoderResult, Encoding, UTF_8};
use std::sync::LazyLock;

pub(super) struct Page {
    pub content: String,
    pub format: &'static str,
    pub encoding: &'static str,
    pub truncated: bool,
}

fn page_error(code: &'static str, message: &str) -> KernelError {
    KernelError::Structured {
        code,
        stage: "execution",
        message: message.into(),
        details: json!({}),
    }
}

pub(super) fn decode_text(
    bytes: &[u8],
    content_type: Option<&str>,
    truncated: bool,
) -> KernelResult<(String, &'static str)> {
    let charset = content_type.and_then(|value| {
        value.split(';').skip(1).find_map(|part| {
            let (name, value) = part.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("charset")
                .then(|| value.trim().trim_matches(['\'', '"']).to_string())
        })
    });
    // HTML's ASCII-compatible encoding declaration is restricted to the initial
    // 1024 bytes; this scan only discovers the charset, it does not parse HTML.
    static META: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?is)<meta\s+[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]+)"#)
            .expect("constant charset pattern")
    });
    let declared = charset.or_else(|| {
        let is_html = content_type.is_none_or(|value| value.to_ascii_lowercase().contains("html"));
        if !is_html {
            return None;
        }
        let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
        META.captures(&prefix).map(|m| m[1].to_string())
    });
    let (encoding, skip) = if let Some(bom) = Encoding::for_bom(bytes) {
        bom
    } else if let Some(label) = declared {
        (
            Encoding::for_label(label.as_bytes()).ok_or_else(|| {
                page_error(
                    "web_fetch_encoding_unsupported",
                    &format!("Unsupported page charset: {label}"),
                )
            })?,
            0,
        )
    } else {
        (UTF_8, 0)
    };
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(bytes.len())
        .ok_or_else(|| {
            page_error(
                "web_fetch_decode_failed",
                "Page text exceeds decoder capacity",
            )
        })?;
    let mut text = String::with_capacity(capacity);
    let (result, _) =
        decoder.decode_to_string_without_replacement(&bytes[skip..], &mut text, !truncated);
    if result != DecoderResult::InputEmpty || text.contains('\0') {
        return Err(page_error(
            "web_fetch_decode_failed",
            &format!("Response is not valid {} text", encoding.name()),
        ));
    }
    Ok((text, encoding.name()))
}

pub(super) fn extract(
    bytes: &[u8],
    content_type: Option<&str>,
    max_bytes: usize,
    source_truncated: bool,
) -> KernelResult<Page> {
    let mime = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime.is_empty()
        && !mime.starts_with("text/")
        && !matches!(
            mime.as_str(),
            "application/xhtml+xml" | "application/json" | "application/xml"
        )
        && !mime.ends_with("+json")
        && !mime.ends_with("+xml")
    {
        return Err(page_error(
            "web_fetch_content_unsupported",
            &format!("web.fetch requires a text page, received {mime}"),
        ));
    }
    let (text, encoding) = decode_text(bytes, content_type, source_truncated)?;
    let is_html = matches!(mime.as_str(), "text/html" | "application/xhtml+xml")
        || (mime.is_empty() && {
            let start = text
                .trim_start()
                .chars()
                .take(64)
                .collect::<String>()
                .to_ascii_lowercase();
            start.starts_with("<!doctype html") || start.starts_with("<html")
        });
    let (mut content, format) = if is_html {
        let converter = htmd::HtmlToMarkdown::builder()
            .skip_tags(vec![
                "head", "script", "style", "noscript", "svg", "nav", "form", "iframe",
            ])
            .build();
        (
            converter
                .convert(&text)
                .map_err(|error| page_error("web_fetch_html_failed", &error.to_string()))?,
            "markdown",
        )
    } else {
        (
            text,
            if mime == "text/markdown" {
                "markdown"
            } else {
                "text"
            },
        )
    };
    let truncated = content.len() > max_bytes;
    truncate_text(&mut content, max_bytes);
    Ok(Page {
        content,
        format,
        encoding,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_budget_is_spent_on_markdown_instead_of_scripts() {
        let html = format!("<html><head><style>{}</style></head><body><nav>menu noise</nav><h1>标题</h1><p>中文正文 <a href='https://example.com/docs'>文档</a></p><pre><code>let n = 1;</code></pre><table><tr><th>名称</th></tr><tr><td>数据</td></tr></table></body></html>", "x".repeat(8000));
        let page = extract(
            html.as_bytes(),
            Some("text/html; charset=utf-8"),
            1024,
            false,
        )
        .unwrap();
        assert_eq!(page.format, "markdown");
        assert!(page.content.contains("# 标题"));
        assert!(page.content.contains("[文档](https://example.com/docs)"));
        assert!(page.content.contains("let n = 1;"));
        assert!(page.content.contains("数据"));
        assert!(!page.content.contains("menu noise"));
        assert!(!page.content.contains("xxxx"));
        assert!(!page.truncated);
    }

    #[test]
    fn declared_chinese_encoding_and_utf8_bounds_do_not_produce_replacement_characters() {
        let html = "<meta charset='gb2312'><p>中文正文</p>";
        let (bytes, _, errors) = encoding_rs::GBK.encode(html);
        assert!(!errors);
        let page = extract(&bytes, Some("text/html"), 7, false).unwrap();
        assert_eq!(page.encoding, "GBK");
        assert_eq!(page.content, "中文");
        assert!(page.truncated);
        assert_eq!(
            decode_text(&[0xe4, 0xb8, 0xad, 0xe6], None, true)
                .unwrap()
                .0,
            "中"
        );
        assert!(decode_text(&[0xff], Some("text/plain; charset=utf-8"), false).is_err());
        assert!(decode_text(b"abc", Some("text/plain; charset=unknown"), false).is_err());
    }
}
