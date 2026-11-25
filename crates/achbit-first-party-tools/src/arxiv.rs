use crate::{
    input_object, now_millis, optional_string, optional_u64, required_string, response_text,
    ToolError, ToolResult,
};
use serde_json::{json, Value};

mod full_text;
mod source;
const API_ROOT: &str = "https://export.arxiv.org/api/query";
const MAX_START: u64 = 10_000;

pub(crate) fn call(name: &str, input: &Value, context: Option<&Value>) -> ToolResult<Value> {
    match name {
        "search" => search(input, context),
        "read" => read(input, context),
        _ => Err(ToolError::new(
            "tool_not_found",
            format!("arXiv plugin does not provide {name}"),
        )),
    }
}

fn search(input: &Value, context: Option<&Value>) -> ToolResult<Value> {
    let object = input_object(
        input,
        &[
            "query",
            "field",
            "start",
            "limit",
            "sortBy",
            "sortOrder",
            "author",
            "category",
            "submittedFrom",
            "submittedTo",
        ],
    )?;
    let query = required_string(object, "query")?;
    let field = optional_string(object, "field")?.unwrap_or_else(|| "all".to_string());
    let field = match field.as_str() {
        "all" => "all",
        "title" => "ti",
        "author" => "au",
        "abstract" => "abs",
        "category" => "cat",
        "id" => "id",
        _ => {
            return Err(ToolError::new(
                "tool_input_invalid",
                "unsupported arXiv field",
            ))
        }
    };
    let start = optional_u64(object, "start", 0, 0, MAX_START)?;
    let limit = optional_u64(object, "limit", 10, 1, 30)?;
    let sort_by = optional_string(object, "sortBy")?.unwrap_or_else(|| "relevance".to_string());
    if !matches!(
        sort_by.as_str(),
        "relevance" | "lastUpdatedDate" | "submittedDate"
    ) {
        return Err(ToolError::new(
            "tool_input_invalid",
            "unsupported arXiv sortBy",
        ));
    }
    let sort_order =
        optional_string(object, "sortOrder")?.unwrap_or_else(|| "descending".to_string());
    if !matches!(sort_order.as_str(), "ascending" | "descending") {
        return Err(ToolError::new(
            "tool_input_invalid",
            "unsupported arXiv sortOrder",
        ));
    }
    let mut url = reqwest::Url::parse(API_ROOT)
        .map_err(|error| ToolError::new("arxiv_url_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair(
            "search_query",
            &source::query_expression(object, field, &query)?,
        )
        .append_pair("start", &start.to_string())
        .append_pair("max_results", &limit.to_string())
        .append_pair("sortBy", &sort_by)
        .append_pair("sortOrder", &sort_order);
    let response = source::atom_get(url, 512 * 1024, context)?;
    search_page(&response, &query, start)
}

fn search_page(response: &crate::HttpResponse, query: &str, start: u64) -> ToolResult<Value> {
    let feed = parse_feed(response_text(response)?)?;
    let next = start + feed.entries.len() as u64;
    let has_more = next > start && next <= MAX_START && next < feed.total_results;
    Ok(json!({
        "backendId": "arxiv",
        "query": query,
        "start": start,
        "nextStart": has_more.then_some(next),
        "totalCount": feed.total_results,
        "results": feed.entries,
        "retrievedAtMs": now_millis()?,
        "sourceUrl": response.final_url
    }))
}

fn read(input: &Value, context: Option<&Value>) -> ToolResult<Value> {
    let object = input_object(
        input,
        &["id", "view", "section", "page", "offset", "maxBytes"],
    )?;
    let id = source::identifier(&required_string(object, "id")?)?;
    let view = optional_string(object, "view")?.unwrap_or_else(|| "metadata".into());
    if view == "fullText" {
        return full_text::read(&id, object, context);
    }
    if view != "metadata"
        || ["section", "page", "offset", "maxBytes"]
            .iter()
            .any(|key| object.contains_key(*key))
    {
        return Err(ToolError::new(
            "tool_input_invalid",
            "Section, page, offset and byte limit apply to fullText reads",
        ));
    }
    let (paper, source_url) = lookup(&id, context)?;
    Ok(
        json!({"backendId":"arxiv","paper":paper,"retrievedAtMs":now_millis()?,"sourceUrl":source_url}),
    )
}

fn lookup(id: &str, context: Option<&Value>) -> ToolResult<(Value, String)> {
    let mut url = reqwest::Url::parse(API_ROOT)
        .map_err(|error| ToolError::new("arxiv_url_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("id_list", id)
        .append_pair("max_results", "1");
    let response = source::atom_get(url, 256 * 1024, context)?;
    let mut feed = parse_feed(response_text(&response)?)?;
    let paper = feed.entries.pop().ok_or_else(|| {
        ToolError::new(
            "arxiv_paper_not_found",
            "arXiv did not return the requested paper",
        )
    })?;
    let found = paper["arxivId"]
        .as_str()
        .ok_or_else(|| ToolError::new("arxiv_response_invalid", "Missing paper identifier"))?;
    if found != id
        && (source::versioned(id)
            || !found.strip_prefix(id).is_some_and(|tail| {
                tail.starts_with('v') && tail[1..].bytes().all(|c| c.is_ascii_digit())
            }))
    {
        return Err(ToolError::new(
            "arxiv_response_invalid",
            format!("Requested {id}, arXiv returned {found}"),
        ));
    }
    Ok((paper, response.final_url))
}

struct ArxivFeed {
    total_results: u64,
    entries: Vec<Value>,
}

fn parse_feed(body: &str) -> ToolResult<ArxivFeed> {
    let document = roxmltree::Document::parse(body)
        .map_err(|error| ToolError::new("arxiv_response_invalid", error.to_string()))?;
    let total_results = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "totalResults")
        .and_then(|node| node.text())
        .ok_or_else(|| ToolError::new("arxiv_response_invalid", "feed requires totalResults"))?
        .trim()
        .parse::<u64>()
        .map_err(|error| ToolError::new("arxiv_response_invalid", error.to_string()))?;
    let entries = document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "entry")
        .map(entry)
        .collect::<ToolResult<Vec<_>>>()?;
    Ok(ArxivFeed {
        total_results,
        entries,
    })
}

fn entry(entry: roxmltree::Node<'_, '_>) -> ToolResult<Value> {
    let id_url = child_text(entry, "id")
        .ok_or_else(|| ToolError::new("arxiv_response_invalid", "entry requires id"))?;
    let arxiv_id = source::identifier(&id_url)
        .map_err(|e| ToolError::new("arxiv_response_invalid", e.message))?;
    let authors = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "author")
        .filter_map(|author| child_text(author, "name"))
        .collect::<Vec<_>>();
    let categories = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "category")
        .filter_map(|node| node.attribute("term").map(str::to_string))
        .collect::<Vec<_>>();
    let primary_category = entry
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "primary_category")
        .and_then(|node| node.attribute("term"))
        .map(str::to_string)
        .or_else(|| categories.first().cloned());
    let pdf_url = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "link")
        .find(|node| {
            node.attribute("title") == Some("pdf")
                || node.attribute("type") == Some("application/pdf")
        })
        .and_then(|node| node.attribute("href"))
        .map(str::to_string);
    let title = child_text(entry, "title")
        .ok_or_else(|| ToolError::new("arxiv_response_invalid", "entry requires title"))?;
    Ok(json!({
        "sourceId": format!("arxiv:{arxiv_id}"),
        "backendId": "arxiv",
        "arxivId": arxiv_id,
        "title": normalize_atom_text(&title),
        "url": id_url,
        "pdfUrl": pdf_url,
        "summary": child_text(entry, "summary").map(|value| normalize_atom_text(&value)),
        "authors": authors,
        "publishedAt": child_text(entry, "published"),
        "updatedAt": child_text(entry, "updated"),
        "primaryCategory": primary_category,
        "categories": categories,
        "doi": child_text(entry, "doi")
    }))
}

fn child_text(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_atom_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_atom_record() {
        let feed = parse_feed(
            r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.00001v2</id><updated>2026-01-02T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title> A paper title </title><summary> Some abstract text. </summary><author><name>Ada</name></author><category term="cs.AI"/><link title="pdf" href="https://arxiv.org/pdf/2601.00001"/></entry></feed>"#,
        )
        .expect("parse feed");
        assert_eq!(feed.total_results, 1);
        assert_eq!(feed.entries[0]["arxivId"], "2601.00001v2");
        assert_eq!(feed.entries[0]["title"], "A paper title");
        assert_eq!(feed.entries[0]["authors"], json!(["Ada"]));
    }

    #[test]
    fn search_page_exposes_only_reachable_next_starts_and_the_real_total() {
        for (start, count, total, next) in [
            (9_998, 2, 12_345, Some(10_000)),
            (9_999, 2, 12_345, None),
            (10_000, 1, 12_345, None),
            (20, 2, 22, None),
            (20, 0, 50, None),
        ] {
            let entries: String = (0..count)
                .map(|i| format!("<entry><id>2401.{i:05}</id><title>Paper {i}</title></entry>"))
                .collect();
            let response = crate::HttpResponse {
                body: format!("<feed><totalResults>{total}</totalResults>{entries}</feed>")
                    .into_bytes(),
                final_url: API_ROOT.into(),
                headers: Default::default(),
            };
            let page = search_page(&response, "dynamics", start).unwrap();
            assert_eq!(page["totalCount"], total);
            assert_eq!(page["results"].as_array().unwrap().len(), count);
            assert_eq!(
                page["nextStart"],
                json!(next),
                "start={start}, count={count}"
            );
        }
        let error = search(&json!({"query":"dynamics", "start":10_001}), None).unwrap_err();
        assert_eq!(error.code, "tool_input_invalid");
    }

    #[test]
    fn feed_without_total_results_is_rejected() {
        let error =
            parse_feed(r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"/>"#)
                .err()
                .expect("missing totalResults must remain an upstream response error");
        assert_eq!(error.code, "arxiv_response_invalid");
        assert!(error.message.contains("totalResults"));
    }
}
