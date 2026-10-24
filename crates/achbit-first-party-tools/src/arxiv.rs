use crate::{
    http_get, input_object, now_millis, optional_string, optional_u64, required_string,
    response_text, ToolError, ToolResult,
};
use serde_json::{json, Value};

const API_ROOT: &str = "https://export.arxiv.org/api/query";

pub(crate) fn call(name: &str, input: &Value) -> ToolResult<Value> {
    match name {
        "search" => search(input),
        "read" => read(input),
        _ => Err(ToolError::new(
            "tool_not_found",
            format!("arXiv plugin does not provide {name}"),
        )),
    }
}

fn search(input: &Value) -> ToolResult<Value> {
    let object = input_object(
        input,
        &["query", "field", "start", "limit", "sortBy", "sortOrder"],
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
    let start = optional_u64(object, "start", 0, 0, 10_000)?;
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
        .append_pair("search_query", &format!("{field}:{query}"))
        .append_pair("start", &start.to_string())
        .append_pair("max_results", &limit.to_string())
        .append_pair("sortBy", &sort_by)
        .append_pair("sortOrder", &sort_order);
    let response = http_get(url, 512 * 1024, Vec::new())?;
    let feed = parse_feed(response_text(&response)?)?;
    let has_more = start.saturating_add(feed.entries.len() as u64) < feed.total_results;
    let next_start = start.saturating_add(feed.entries.len() as u64);
    Ok(json!({
        "backendId": "arxiv",
        "query": query,
        "start": start,
        "nextStart": has_more.then_some(next_start),
        "totalCount": feed.total_results,
        "results": feed.entries,
        "retrievedAtMs": now_millis()?,
        "sourceUrl": response.final_url
    }))
}

fn read(input: &Value) -> ToolResult<Value> {
    let object = input_object(input, &["id"])?;
    let id = required_string(object, "id")?;
    let mut url = reqwest::Url::parse(API_ROOT)
        .map_err(|error| ToolError::new("arxiv_url_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("id_list", &id)
        .append_pair("max_results", "1");
    let response = http_get(url, 256 * 1024, Vec::new())?;
    let mut feed = parse_feed(response_text(&response)?)?;
    let paper = feed.entries.pop().ok_or_else(|| {
        ToolError::new(
            "arxiv_paper_not_found",
            "arXiv did not return the requested paper",
        )
    })?;
    Ok(json!({
        "backendId": "arxiv",
        "paper": paper,
        "retrievedAtMs": now_millis()?,
        "sourceUrl": response.final_url
    }))
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
    let arxiv_id = id_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(id_url.as_str())
        .to_string();
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
    fn feed_without_total_results_is_rejected() {
        let error =
            parse_feed(r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"/>"#)
                .err()
                .expect("missing totalResults must remain an upstream response error");
        assert_eq!(error.code, "arxiv_response_invalid");
        assert!(error.message.contains("totalResults"));
    }
}
