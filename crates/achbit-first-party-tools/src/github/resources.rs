use super::*;
use reqwest::Url;

#[derive(Debug, PartialEq)]
enum Resource {
    Repository,
    Issue(u64),
    Pull(u64),
}

fn invalid() -> ToolError {
    ToolError::new(
        "tool_input_invalid",
        "Use a github.com repository, issue or pull request URL",
    )
}

fn parse_link(input: &str) -> ToolResult<(String, Resource)> {
    let url = Url::parse(input).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("github.com" | "www.github.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let [owner, name, tail @ ..] = parts.as_slice() else {
        return Err(invalid());
    };
    let name = name.strip_suffix(".git").unwrap_or(name);
    for segment in [*owner, name] {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err(invalid());
        }
    }
    let number = |s: &str| s.parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(invalid);
    let kind = match tail {
        [] => Resource::Repository,
        ["issues", n] => Resource::Issue(number(n)?),
        ["pull", n] | ["pull", n, "files" | "commits"] => Resource::Pull(number(n)?),
        _ => return Err(invalid()),
    };
    Ok((format!("{owner}/{name}"), kind))
}

fn get(
    path: &str,
    page: Option<(u64, u64)>,
    token: Option<&str>,
) -> ToolResult<(Value, crate::HttpResponse)> {
    let mut url = Url::parse(&format!("{API_ROOT}{path}")).map_err(|_| invalid())?;
    if let Some((page, limit)) = page {
        url.query_pairs_mut()
            .append_pair("page", &page.to_string())
            .append_pair("per_page", &limit.to_string());
    }
    let response = http_get(url, 8 * 1024 * 1024, github_headers(token, false)?)?;
    let value = serde_json::from_str(response_text(&response)?).map_err(|e| {
        ToolError::new(
            "github_response_invalid",
            format!("Invalid GitHub JSON: {e}"),
        )
    })?;
    Ok((value, response))
}

fn project(source: &Value, keys: &[&str]) -> ToolResult<Value> {
    let obj = source
        .as_object()
        .ok_or_else(|| ToolError::new("github_response_invalid", "Expected a resource object"))?;
    let mut output = json!({});
    for key in keys {
        if let Some(value) = obj.get(*key) {
            output[*key] = value.clone();
        }
    }
    if let Some(login) = source.pointer("/user/login").and_then(Value::as_str) {
        output["author"] = json!(login);
    }
    Ok(output)
}

fn include_text(out: &mut Value, key: &str, text: &str, budget: usize) {
    let (body, truncated) = limit_text(text, budget);
    out[key] = json!(body);
    if truncated {
        out[format!("{key}Truncated")] = json!(true);
    }
}

fn overview(
    base: &str,
    kind: &Resource,
    token: Option<&str>,
    budget: usize,
) -> ToolResult<(Value, crate::HttpResponse)> {
    let path = match kind {
        Resource::Repository => base.to_owned(),
        Resource::Issue(n) => format!("{base}/issues/{n}"),
        Resource::Pull(n) => format!("{base}/pulls/{n}"),
    };
    let (record, response) = get(&path, None, token)?;
    if record["html_url"].as_str().is_none() {
        return Err(ToolError::new(
            "github_response_invalid",
            "Missing resource HTML URL",
        ));
    }
    let mut data = project(
        &record,
        &[
            "html_url",
            "full_name",
            "description",
            "default_branch",
            "private",
            "language",
            "number",
            "title",
            "state",
            "draft",
            "merged",
            "updated_at",
            "comments",
            "review_comments",
            "commits",
            "changed_files",
            "additions",
            "deletions",
        ],
    )?;
    if let Some(body) = record["body"].as_str() {
        include_text(&mut data, "body", body, budget);
    }
    if matches!(kind, Resource::Pull(_)) {
        if let Some(private) = record
            .pointer("/base/repo/private")
            .and_then(Value::as_bool)
        {
            data["repositoryPrivate"] = json!(private);
        }
        for branch in ["head", "base"] {
            data[branch] = project(&record[branch], &["label", "ref", "sha"])?;
        }
    }
    if matches!(kind, Resource::Repository) {
        match get(&format!("{base}/readme"), None, token) {
            Ok((readme, _)) => {
                let text = decode_file_content(&readme)?;
                include_text(&mut data, "readme", &text, budget);
                data["readmeUrl"] = readme["html_url"].clone();
            }
            Err(e) if e.http_status == Some(404) => data["readme"] = Value::Null,
            Err(e) => return Err(e),
        }
    }
    Ok((data, response))
}

pub(super) fn read(input: &Value, token: Option<&str>) -> ToolResult<Value> {
    let obj = input_object(input, &["url", "part", "page", "limit", "maxBytes"])?;
    let url = required_string(obj, "url")?;
    let (repo, kind) = parse_link(&url)?;
    let part = optional_string(obj, "part")?.unwrap_or_else(|| "overview".to_owned());
    let budget = optional_u64(obj, "maxBytes", 16_384, 1_024, 262_144)? as usize;
    let page = optional_u64(obj, "page", 1, 1, 10000)?;
    let limit = optional_u64(obj, "limit", 15, 1, 30)?;
    let base = format!("/repos/{repo}");
    let source = match kind {
        Resource::Repository => format!("https://github.com/{repo}"),
        Resource::Issue(n) => format!("https://github.com/{repo}/issues/{n}"),
        Resource::Pull(n) => format!("https://github.com/{repo}/pull/{n}"),
    };
    if part == "overview" {
        let (data, response) = overview(&base, &kind, token, budget)?;
        return Ok(
            json!({"backendId":"github","repository":repo,"sourceUrl":source,"resource":data,
            "retrievedAtMs":now_millis()?,"rateLimit":rate_limit(&response.headers)}),
        );
    }
    let path = match (&kind, part.as_str()) {
        (Resource::Repository, "files") => return super::read(&json!({"repository":repo}), token),
        (Resource::Issue(n) | Resource::Pull(n), "comments") => {
            format!("{base}/issues/{n}/comments")
        }
        (Resource::Pull(n), "files") => format!("{base}/pulls/{n}/files"),
        (Resource::Pull(n), "reviews") => format!("{base}/pulls/{n}/reviews"),
        (Resource::Pull(n), "reviewComments") => format!("{base}/pulls/{n}/comments"),
        _ => {
            return Err(ToolError::new(
                "tool_input_invalid",
                "This resource does not have the requested part",
            ))
        }
    };
    let (items, response) = get(&path, Some((page, limit)), token)?;
    let items = items.as_array().ok_or_else(|| {
        ToolError::new(
            "github_response_invalid",
            "Expected a paginated resource array",
        )
    })?;
    let mut entries = Vec::new();
    // Divide the page text budget between entries; callers can request smaller pages.
    let entry_budget = budget / items.len().max(1);
    for item in items {
        let mut entry = project(
            item,
            &[
                "id",
                "html_url",
                "filename",
                "previous_filename",
                "status",
                "state",
                "path",
                "line",
                "start_line",
                "commit_id",
                "sha",
                "additions",
                "deletions",
                "changes",
                "created_at",
                "submitted_at",
            ],
        )?;
        for key in ["body", "patch"] {
            if let Some(text) = item[key].as_str() {
                include_text(&mut entry, key, text, entry_budget);
            }
        }
        if part == "files" {
            entry["patchAvailable"] = json!(item["patch"].is_string());
        }
        entries.push(entry);
    }
    Ok(
        json!({"backendId":"github","repository":repo,"sourceUrl":source,"part":part,"entries":entries,
        "page":page,"nextPage":next_page(&response, page, 10000),"retrievedAtMs":now_millis()?,"rateLimit":rate_limit(&response.headers)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_only_supported_github_resources() {
        assert_eq!(
            parse_link("https://github.com/team/project/pull/14/files#diff-x").unwrap(),
            ("team/project".into(), Resource::Pull(14))
        );
        assert_eq!(
            parse_link("https://github.com/team/project/issues/7")
                .unwrap()
                .1,
            Resource::Issue(7)
        );
        assert!(parse_link("https://example.org/team/project").is_err());
        assert!(parse_link("https://github.com/team/project/pull/0").is_err());
        assert!(stable_download_url(Some(&json!(
            "https://raw.githubusercontent.com/team/file?token=private"
        )))
        .is_none());
    }
}
