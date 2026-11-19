//! The Host independently resolves the exact public catalog selection before handing a ZIP to local installation.
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, path::PathBuf, time::Duration};
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    id: String,
    version: String,
    kind: String,
    manifest_id: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSources {
    index_url: String,
    contents_url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    kind: String,
    download_url: String,
    install: InstallMetadata,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMetadata {
    sha256: String,
    manifest_id: String,
}

pub(crate) struct Download {
    pub(super) path: PathBuf,
    _directory: tempfile::TempDir,
    artifact: Artifact,
}

impl Download {
    pub(super) fn verify_manifest(&self, inspection: &Value) -> Result<(), String> {
        if inspection["kind"] != self.artifact.kind
            || inspection["id"] != self.artifact.install.manifest_id
        {
            return Err(format!(
                "Downloaded ZIP declares {} / {}; expected {} / {}",
                inspection["kind"],
                inspection["id"],
                self.artifact.kind,
                self.artifact.install.manifest_id
            ));
        }
        Ok(())
    }
}

fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut causes = Vec::new();
    let mut current: Option<&dyn Error> = Some(&error);
    while let Some(cause) = current {
        let text = crate::provider_transport::safe_detail(&cause.to_string(), None);
        if causes.last() != Some(&text) {
            causes.push(text);
        }
        current = cause.source();
    }
    causes.join(": ")
}

fn select(catalog: Value, requested: &Selection) -> Result<Artifact, String> {
    if catalog["schemaVersion"] != 1 {
        return Err("Unsupported plugin directory format".into());
    }
    let entries = catalog["plugins"]
        .as_array()
        .ok_or("Plugin directory entries missing")?;
    let mut matches = entries.iter().filter(|entry| entry["id"] == requested.id);
    let entry = matches
        .next()
        .ok_or("Plugin is no longer in the marketplace. Refresh the directory.")?;
    if matches.next().is_some() {
        return Err("Duplicate plugin directory ID".into());
    }
    if entry["version"] != requested.version {
        return Err("Marketplace version changed. Refresh and review the current version.".into());
    }
    if !entry["install"].is_object() {
        return Err("This directory entry does not offer installation in Achbit".into());
    }
    let artifact: Artifact = serde_json::from_value(entry.clone())
        .map_err(|e| format!("Invalid marketplace installation: {e}"))?;
    if requested.sha256.len() != 64
        || !requested.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || !artifact
            .install
            .sha256
            .eq_ignore_ascii_case(&requested.sha256)
    {
        return Err(
            "Marketplace SHA-256 changed or is invalid. Refresh and review the current version."
                .into(),
        );
    }
    if artifact.kind != requested.kind || artifact.install.manifest_id != requested.manifest_id {
        return Err(
            "Marketplace plugin identity changed. Refresh and review the selected plugin.".into(),
        );
    }
    if artifact.install.manifest_id.trim().is_empty() {
        return Err("Marketplace manifestId is empty".into());
    }
    super::settings_key(&artifact.kind)?;
    Ok(artifact)
}

fn download_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("Invalid plugin download URL: {e}"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Plugin downloads require an HTTPS URL without credentials".into());
    }
    // A reviewed author URL is pinned by the verified digest; known mutable GitHub refs aren't releases.
    let path: Vec<_> = url.path_segments().into_iter().flatten().collect();
    let reference = match (url.host_str(), path.as_slice()) {
        (Some("github.com"), [_, _, "releases", "latest", ..]) => {
            return Err("Plugin download must identify a fixed version".into())
        }
        (Some("github.com"), [_, _, "raw" | "blob" | "archive", reference, ..])
        | (Some("raw.githubusercontent.com"), [_, _, reference, ..]) => Some(*reference),
        _ => None,
    };
    if matches!(reference, Some("HEAD" | "main" | "master"))
        || (reference == Some("refs") && path.contains(&"heads"))
    {
        return Err("Plugin download must identify a fixed version".into());
    }
    Ok(url)
}

#[derive(Debug)]
enum TransferError {
    Network(String),
    Invalid(String),
}

impl TransferError {
    fn detail(self) -> String {
        match self {
            Self::Network(message) | Self::Invalid(message) => message,
        }
    }
}

async fn metadata_bytes(request: RequestBuilder) -> Result<Vec<u8>, TransferError> {
    let network = |error| TransferError::Network(describe(error));
    let mut response = request.send().await.map_err(network)?;
    if !response.status().is_success() {
        return Err(TransferError::Invalid(format!(
            "HTTP {}",
            response.status()
        )));
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if chunk.len() > crate::api_response::LARGE_JSON_BODY_LIMIT_BYTES - out.len() {
            return Err(TransferError::Invalid(
                "Marketplace metadata exceeds the Host JSON size limit".into(),
            ));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

async fn catalog(client: &Client, sources: &CatalogSources) -> Result<Value, String> {
    let raw = client
        .get(&sources.index_url)
        .timeout(Duration::from_secs(6));
    let bytes = match metadata_bytes(raw).await {
        Ok(bytes) => bytes,
        Err(TransferError::Invalid(message)) => {
            return Err(format!("Marketplace index: {message}"))
        }
        Err(TransferError::Network(first)) => metadata_bytes(
            client
                .get(&sources.contents_url)
                .header("Accept", "application/vnd.github.raw+json")
                .timeout(Duration::from_secs(10)),
        )
        .await
        .map_err(|second| {
            let second = second.detail();
            format!(
                "Marketplace index: raw.githubusercontent.com: {first}; api.github.com: {second}"
            )
        })?,
    };
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid marketplace index: {e}"))
}

fn github_release(url: &Url) -> Option<(String, String)> {
    let path: Vec<_> = url.path_segments()?.collect();
    let [owner, repo, "releases", "download", tag, asset] = path.as_slice() else {
        return None;
    };
    if url.host_str() != Some("github.com")
        || url.port().is_some()
        || [owner, repo, tag, asset].into_iter().any(|v| v.is_empty())
    {
        return None;
    }
    let releases = format!("https://api.github.com/repos/{owner}/{repo}/releases");
    Some((
        format!("{releases}/tags/{tag}"),
        format!("{releases}/assets"),
    ))
}

fn release_asset_id(release: &Value, url: &Url) -> Result<u64, &'static str> {
    release["assets"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["browser_download_url"] == url.as_str())
        })
        .and_then(|asset| asset["id"].as_u64())
        .ok_or("The release did not list the selected asset")
}

async fn acquire(client: &Client, artifact: &Artifact, url: &Url) -> Result<Download, String> {
    let first = match transfer(client.get(url.clone()), artifact, url).await {
        Ok(download) => return Ok(download),
        Err(TransferError::Invalid(error)) => return Err(error),
        Err(TransferError::Network(error)) => error,
    };
    let Some((tag_url, assets_url)) = github_release(url) else {
        return Err(first);
    };
    // The API must name the exact same public browser download. It can then stream or redirect the bytes.
    let result = async {
        let bytes = metadata_bytes(
            client
                .get(tag_url)
                .header("Accept", "application/vnd.github+json"),
        )
        .await
        .map_err(TransferError::detail)?;
        let release: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let id = release_asset_id(&release, url)?;
        transfer(
            client
                .get(format!("{assets_url}/{id}"))
                .header("Accept", "application/octet-stream"),
            artifact,
            url,
        )
        .await
        .map_err(TransferError::detail)
    }
    .await;
    result.map_err(|second| format!("Publisher download: {first}; GitHub release asset: {second}"))
}

async fn transfer(
    request: RequestBuilder,
    artifact: &Artifact,
    url: &Url,
) -> Result<Download, TransferError> {
    let response = request
        .send()
        .await
        .map_err(|e| TransferError::Network(describe(e)))?;
    if !response.status().is_success() {
        return Err(TransferError::Invalid(format!(
            "Plugin download HTTP {}",
            response.status()
        )));
    }
    stage(artifact, url, response).await
}

async fn stage(
    artifact: &Artifact,
    url: &Url,
    mut response: Response,
) -> Result<Download, TransferError> {
    let directory = tempfile::Builder::new()
        .prefix("achbit-market-")
        .tempdir()
        .map_err(|e| TransferError::Invalid(e.to_string()))?;
    let name = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .filter(|name| name.to_ascii_lowercase().ends_with(".zip") && !name.contains(['\\', ':']))
        .unwrap_or("plugin.zip");
    let path = directory.path().join(name);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| TransferError::Invalid(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut remaining: usize = 512 * 1024 * 1024;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| TransferError::Network(describe(e)))?
    {
        remaining = remaining
            .checked_sub(chunk.len())
            .ok_or_else(|| TransferError::Invalid("Plugin ZIP download exceeds 512 MiB".into()))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| TransferError::Invalid(format!("Write plugin download: {e}")))?;
        hash.update(&chunk);
    }
    file.flush()
        .await
        .map_err(|e| TransferError::Invalid(format!("Flush plugin download: {e}")))?;
    drop(file);
    let actual = format!("{:x}", hash.finalize());
    if !actual.eq_ignore_ascii_case(&artifact.install.sha256) {
        return Err(TransferError::Invalid(format!(
            "Downloaded plugin SHA-256 mismatch: expected {}, received {actual}",
            artifact.install.sha256
        )));
    }
    Ok(Download {
        path,
        _directory: directory,
        artifact: artifact.clone(),
    })
}

pub(super) async fn download(request: Selection) -> Result<Download, String> {
    let sources: CatalogSources = serde_json::from_str(include_str!(
        "../../../../userspace/protocol/src/pluginMarketplaceSources.json"
    ))
    .expect("built-in marketplace sources");
    let client = Client::builder()
        .https_only(true)
        .referer(false)
        .user_agent(concat!("Achbit/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(describe)?;
    let artifact = select(catalog(&client, &sources).await?, &request)?;
    let url = download_url(&artifact.download_url)?;
    acquire(&client, &artifact, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use achbit_host_connection::plugin_artifact::prepare_plugin;
    use serde_json::json;

    const ZIP: &[u8] = include_bytes!("../../../../examples/plugins/downloads/ui-theme-0.7.84.zip");

    fn selection() -> Selection {
        Selection {
            id: "display-id".into(),
            version: "1".into(),
            kind: "ui".into(),
            manifest_id: "example-theme".into(),
            sha256: format!("{:x}", Sha256::digest(ZIP)),
        }
    }

    fn listing(selection: &Selection) -> Value {
        json!({"schemaVersion":1,"plugins":[{"id":"display-id","version":"1","kind":"ui",
            "downloadUrl":"https://example.org/releases/v1/theme.zip",
            "install":{"sha256":selection.sha256,"manifestId":"example-theme"}}]})
    }

    #[test]
    fn install_request_accepts_local_or_market_selection_without_caller_url_or_replacement() {
        use super::super::InstallInput;
        assert!(serde_json::from_value::<InstallInput>(
            json!({"path":"/local", "replacePath":"/installed"})
        )
        .is_ok());
        let market = json!({"id":"one","version":"1","kind":"ui","manifestId":"one","sha256":"a".repeat(64)});
        assert!(serde_json::from_value::<InstallInput>(json!({"marketplace":market})).is_ok());
        assert!(serde_json::from_value::<InstallInput>(
            json!({"marketplace":market,"replacePath":"/local"})
        )
        .is_err());
        assert!(serde_json::from_value::<InstallInput>(
            json!({"marketplace":market,"path":"/local"})
        )
        .is_err());
        assert!(serde_json::from_value::<InstallInput>(json!({"marketplace":{"id":"one","version":"1","kind":"ui","manifestId":"one","sha256":"a".repeat(64),"downloadUrl":"https://example.org/other.zip"}})).is_err());
    }

    #[test]
    fn changed_selection_missing_install_and_ambiguous_entries_do_not_resolve() {
        let request = selection();
        for (field, value) in [
            ("version", json!("2")),
            ("kind", json!("guidance")),
            (
                "install",
                json!({"sha256":request.sha256,"manifestId":"corrected"}),
            ),
            ("install", Value::Null),
            (
                "install",
                json!({"sha256":"a".repeat(64),"manifestId":"example-theme"}),
            ),
        ] {
            let mut index = listing(&request);
            index["plugins"][0][field] = value;
            assert!(select(index, &request).is_err());
        }
        let mut index = listing(&request);
        let same = index["plugins"][0].clone();
        index["plugins"].as_array_mut().unwrap().push(same);
        assert!(select(index, &request).is_err());
        assert!(download_url("http://publisher.example/a.zip").is_err());
        assert!(download_url("https://github.com/a/b/releases/latest/download/theme.zip").is_err());
        assert!(download_url("https://u:p@publisher.example/pinned.zip").is_err());
    }

    #[tokio::test]
    async fn downloaded_zip_must_match_digest_kind_and_actual_manifest_before_installing() {
        let request = selection();
        let artifact = select(listing(&request), &request).unwrap();
        let url = download_url(&artifact.download_url).unwrap();
        let response = || Response::from(axum::http::Response::new(ZIP));
        let mut package = stage(&artifact, &url, response()).await.unwrap();
        let path = package.path.clone();
        let prepared = prepare_plugin(path.to_str().unwrap()).unwrap();
        package.verify_manifest(&prepared.inspection).unwrap();
        package.artifact.install.manifest_id = "display-id".into();
        assert!(package.verify_manifest(&prepared.inspection).is_err());
        package.artifact.install.manifest_id = "example-theme".into();
        package.artifact.kind = "guidance".into();
        assert!(package.verify_manifest(&prepared.inspection).is_err());
        drop(package);
        assert!(!path.exists());
        let mut wrong = select(listing(&request), &request).unwrap();
        wrong.install.sha256 = "0".repeat(64);
        assert!(stage(&wrong, &url, response())
            .await
            .err()
            .unwrap()
            .detail()
            .contains("SHA-256 mismatch"));
    }

    #[tokio::test]
    async fn interrupted_zip_body_is_a_transport_failure_but_untrusted_bytes_are_terminal() {
        let selected = selection();
        let artifact = select(listing(&selected), &selected).unwrap();
        let url = download_url(&artifact.download_url).unwrap();
        let body = reqwest::Body::wrap_stream(async_stream::stream! {
            yield Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"PK"));
            yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "interrupted fixture"));
        });
        let broken = Response::from(axum::http::Response::new(body));
        assert!(
            matches!(stage(&artifact,&url,broken).await,Err(TransferError::Network(message)) if message.contains("interrupted fixture"))
        );
        let bad = Response::from(axum::http::Response::new(b"bad".as_slice()));
        assert!(
            matches!(stage(&artifact,&url,bad).await,Err(TransferError::Invalid(message)) if message.contains("SHA-256 mismatch"))
        );
    }

    #[test]
    fn github_release_download_fallback_selects_only_the_exact_listed_asset() {
        let url = download_url("https://github.com/author/project/releases/download/v1/tool.zip")
            .unwrap();
        assert_eq!(
            github_release(&url).unwrap().0,
            "https://api.github.com/repos/author/project/releases/tags/v1"
        );
        assert!(github_release(
            &download_url("https://publisher.example/releases/download/v1/tool.zip").unwrap()
        )
        .is_none());
        let mut release = json!({"assets":[{"id":11,"browser_download_url":"https://github.com/author/project/releases/download/v2/tool.zip"}]});
        assert!(release_asset_id(&release, &url).is_err());
        release["assets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":12,"browser_download_url":url.as_str()}));
        assert_eq!(release_asset_id(&release, &url), Ok(12));
    }

    #[tokio::test]
    async fn unavailable_index_uses_anonymous_contents_request_for_the_reviewed_artifact() {
        use axum::{
            http::{HeaderMap, StatusCode},
            routing::get,
            Router,
        };
        let app = Router::new()
            .route("/raw", get(|| async { StatusCode::SERVICE_UNAVAILABLE }))
            .route(
                "/contents",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers["accept"], "application/vnd.github.raw+json");
                    assert!(headers.get("authorization").is_none());
                    axum::Json(listing(&selection()))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::builder().no_proxy().build().unwrap();
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unreachable = format!("http://{}", closed.local_addr().unwrap());
        let disconnect = tokio::spawn(async move {
            drop(closed.accept().await.unwrap());
        });
        let mut sources = CatalogSources {
            index_url: unreachable,
            contents_url: format!("{base}/contents"),
        };
        let recovered = catalog(&client, &sources).await.unwrap();
        assert_eq!(
            select(recovered, &selection()).unwrap().install.manifest_id,
            "example-theme"
        );
        disconnect.await.unwrap();
        sources.index_url = format!("{base}/raw");
        assert!(catalog(&client, &sources)
            .await
            .unwrap_err()
            .contains("503"));
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
