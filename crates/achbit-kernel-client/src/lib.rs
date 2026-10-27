use achbit_kernel_abi::{
    is_valid_host_shell_token, HOST_SHELL_TOKEN_ENV, HOST_SHELL_TOKEN_HEADER,
    HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;
use thiserror::Error;

mod bootstrap;
mod conversation;
mod model_services;
pub use model_services::*;

use conversation::invalid_filesystem_references;

pub use bootstrap::{DaemonStatus, KernelBootstrap, KernelBootstrapGuard, KernelBootstrapOptions};
pub use conversation::{
    approval_response_command, approval_scope_for_input, cancel_command,
    directory_index_attach_command, directory_index_detach_command, focus_command,
    interaction_response_command, is_terminal_run_status, message_command,
    message_command_with_profile, message_command_with_profile_and_plugins, plan_cancel_command,
    plan_confirm_command, plan_revision_command, ActivityProjection, AgentSettings,
    AgentTaskStatus, ApprovalProjection, ArtifactProjection, AssistantDraftBlockProjection,
    AssistantDraftProjection, AttachConversationDirectoryIndexRequest, CommandReply,
    ContextCompositionItem, ContextCompositionMessage, ContextCompositionMessageBlock,
    ContextCompositionPartitionProjection, ContextCompositionProjection, ContextCompositionTool,
    ContextUsageProjection, ConversationCatalog, ConversationError, ConversationProject,
    ConversationResourceReadRequest, ConversationResourceReadResult, ConversationSessionSummary,
    CreateConversationSessionRequest, DeliverableProjection, EffectOperation, EffectPreview,
    ExecutionPlanStep, FileChangeContent, FilesystemReference, FilesystemReferencePathInput,
    InteractionOption, InteractionProjection, NarrativeProjection, PendingAgentApproval,
    PendingAgentDecision, PendingPlanProjection, PlanOperation, PlanPreviewProjection,
    PlanProjection, PlanRef, PlanWritePath, PluginCatalogItem, PluginCatalogProjection,
    PluginSelectionInput, ProjectionMessage, QueuedInputProjection,
    ResolveConversationFilesystemReferencesRequest, RunProjection, SessionDisplayProjection,
    SessionProjection, SessionTimelineItem, SourceCitation, SourceReferences, TodoItem,
    TodoListProjection, TokenUsageProjection, TokenUsageRoundProjection, ToolOutputProjection,
    WorkspaceBindingDisplay, AUTHORIZATION_OPTIONS, CONVERSATION_COMMAND_VERSION,
    SESSION_PROJECTION_VERSION,
};

#[derive(Debug, Error)]
pub enum KernelClientError {
    #[error("daemon request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("daemon returned error: {0}")]
    Api(String),
    #[error("daemon response decode failed: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("Host shell local connection token is required")]
    HostConnectionTokenMissing,
    #[error("Host shell local connection token has an invalid format")]
    HostConnectionTokenInvalid,
    #[error("daemon at {base_url} rejected the Host shell local connection token")]
    HostConnectionRejected { base_url: String },
    #[error("daemon at {base_url} is unavailable: {reason}")]
    DaemonUnavailable { base_url: String, reason: String },
    #[error("kernel bootstrap failed: {0}")]
    Bootstrap(String),
}

pub type KernelClientResult<T> = Result<T, KernelClientError>;

#[derive(Clone)]
struct HostShellToken(String);

impl fmt::Debug for HostShellToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostShellToken([REDACTED])")
    }
}

impl HostShellToken {
    fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    fn expose_to_transport(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct KernelClientConfig {
    pub base_url: String,
    host_shell_token: Option<HostShellToken>,
}

impl fmt::Debug for KernelClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelClientConfig")
            .field("base_url", &self.base_url)
            .field(
                "host_shell_token",
                &self.host_shell_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl KernelClientConfig {
    pub fn from_env() -> Self {
        if let Ok(base_url) = std::env::var("ACHBIT_API_URL") {
            return Self::new(base_url);
        }
        let host = std::env::var("ACHBIT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("ACHBIT_PORT").unwrap_or_else(|_| "31245".to_string());
        Self::new(format!("http://{host}:{port}"))
    }

    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            host_shell_token: std::env::var(HOST_SHELL_TOKEN_ENV)
                .ok()
                .map(HostShellToken::new),
        }
    }

    pub fn with_host_shell_token(mut self, token: impl Into<String>) -> Self {
        self.host_shell_token = Some(HostShellToken::new(token));
        self
    }

    pub(crate) fn has_host_shell_token(&self) -> bool {
        self.host_shell_token.is_some()
    }

    pub(crate) fn validate_host_shell_token(&self) -> KernelClientResult<()> {
        if self
            .host_shell_token
            .as_ref()
            .is_some_and(|token| !is_valid_host_shell_token(token.expose_to_transport()))
        {
            return Err(KernelClientError::HostConnectionTokenInvalid);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct HttpKernelClient {
    config: KernelClientConfig,
    http: reqwest::Client,
}

impl HttpKernelClient {
    pub fn new(mut config: KernelClientConfig) -> KernelClientResult<Self> {
        config.validate_host_shell_token()?;
        let token = config
            .host_shell_token
            .as_ref()
            .ok_or(KernelClientError::HostConnectionTokenMissing)?;
        let mut token_header = HeaderValue::from_str(token.expose_to_transport())
            .map_err(|_| KernelClientError::HostConnectionTokenInvalid)?;
        token_header.set_sensitive(true);
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            HeaderName::from_static(HOST_SHELL_TOKEN_HEADER),
            token_header,
        );
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .default_headers(default_headers)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        config.host_shell_token = None;
        Ok(Self { config, http })
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    pub async fn health(&self) -> KernelClientResult<DaemonStatus> {
        let value = self
            .http
            .get(self.url("/api/health"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_health(value)
    }

    pub async fn daemon_status(&self) -> KernelClientResult<DaemonStatus> {
        self.health().await
    }

    pub async fn user_settings(&self) -> KernelClientResult<Value> {
        let value = self
            .http
            .get(self.url("/api/user-settings"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
    }

    pub async fn patch_user_settings(&self, patches: &Value) -> KernelClientResult<Value> {
        let value = self
            .http
            .patch(self.url("/api/user-settings"))
            .json(&json!({ "patches": patches }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
    }

    pub async fn conversation_catalog(&self) -> KernelClientResult<ConversationCatalog> {
        let value = self
            .http
            .get(self.url("/api/conversation/catalog"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let catalog: ConversationCatalog = decode_api_data(value)?;
        catalog.validate().map_err(KernelClientError::Api)?;
        Ok(catalog)
    }

    pub async fn create_conversation_session(
        &self,
        request: &CreateConversationSessionRequest,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .post(self.url("/api/conversation/sessions"))
            .json(request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn conversation_plugin_catalog(&self) -> KernelClientResult<PluginCatalogProjection> {
        let value = self
            .http
            .get(self.url("/api/conversation/plugins"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let catalog: PluginCatalogProjection = decode_api_data(value)?;
        catalog
            .validate()
            .map_err(|message| KernelClientError::Api(message))?;
        Ok(catalog)
    }

    pub async fn submit_conversation_command(
        &self,
        session_id: &str,
        command: &Value,
    ) -> KernelClientResult<CommandReply> {
        let mut command = command.clone();
        let field = match command["type"].as_str() {
            Some("message.submit") => Some("text"),
            Some("context.focus") => Some("task"),
            _ => None,
        };
        if let Some(field) = field {
            if let Some(selections) = command["pluginSelections"]
                .as_array()
                .filter(|items| !items.is_empty())
            {
                let catalog = self.conversation_plugin_catalog().await?;
                let mut execution = Vec::new();
                let mut guidance = command["guidanceReferences"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for selection in selections {
                    let reference = catalog
                        .plugins
                        .iter()
                        .find(|item| Some(item.uri.as_str()) == selection["uri"].as_str())
                        .and_then(|item| item.reference.as_ref());
                    if let Some(reference) = reference {
                        guidance.push(json!({"referenceId":selection["selectionId"],"uri":selection["uri"],
                            "label":selection["label"],"toolName":reference["toolName"],"name":reference["name"]}));
                    } else {
                        execution.push(selection.clone());
                    }
                }
                command["pluginSelections"] = json!(execution);
                if !guidance.is_empty() {
                    command["guidanceReferences"] = json!(guidance);
                }
            }
            if command
                .get("filesystemReferences")
                .is_some_and(|value| !value.is_array())
            {
                return Err(KernelClientError::Api(
                    "filesystemReferences 必须是数组。".into(),
                ));
            }
            if let Some(text) = command[field]
                .as_str()
                .filter(|text| text.len() > 32 * 1024)
            {
                let id = command["commandId"]
                    .as_str()
                    .ok_or_else(|| KernelClientError::Api("command_identity_missing".into()))?;
                let value = self
                    .http
                    .post(self.url(&format!(
                        "/api/conversation/sessions/{session_id}/input-resources/{id}"
                    )))
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(text.to_string())
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await?;
                let saved: Value = decode_api_data(value)?;
                command[field] = if field == "task" {
                    json!("请依据本条消息的粘贴文本聚焦上下文。")
                } else {
                    saved["text"].clone()
                };
                let mut references = command["filesystemReferences"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                references.push(saved["reference"].clone());
                command["filesystemReferences"] = serde_json::json!(references);
            }
        }
        let value = self
            .http
            .post(self.url(&format!("/api/conversation/sessions/{session_id}/commands")))
            .json(&command)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    /// Read persisted facts without opening or recovering the target Session Actor.
    pub async fn conversation_read(
        &self,
        session_id: &str,
        query: &Value,
    ) -> KernelClientResult<Value> {
        let value = self
            .http
            .post(self.url(&format!("/api/conversation/sessions/{session_id}/read")))
            .json(query)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn conversation_projection(
        &self,
        session_id: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .get(self.url(&format!(
                "/api/conversation/sessions/{session_id}/projection"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn conversation_change_read(
        &self,
        session_id: &str,
        record_id: &str,
        index: usize,
    ) -> KernelClientResult<FileChangeContent> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/changes/read"
            )))
            .json(&serde_json::json!({ "recordId": record_id, "index": index }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn stop_host(&self) -> KernelClientResult<achbit_kernel_abi::HostShutdownReceipt> {
        let value = self
            .http
            .get(self.url("/api/host/identity"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let identity: achbit_kernel_abi::HostProcessIdentity = decode_api_data(value)?;
        let value = self
            .http
            .post(self.url("/api/host/shutdown"))
            .timeout(Duration::from_millis(HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS))
            .json(&achbit_kernel_abi::HostShutdownRequest {
                expected_identity: identity.clone(),
            })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let receipt: achbit_kernel_abi::HostShutdownReceipt = decode_api_data(value)?;
        if !receipt.confirms_shutdown_of(&identity) {
            return Err(KernelClientError::Api(
                "host_shutdown_identity_mismatch".into(),
            ));
        }
        Ok(receipt)
    }

    pub async fn conversation_resource_read(
        &self,
        session_id: &str,
        workspace_id: &str,
        logical_path: &str,
    ) -> KernelClientResult<ConversationResourceReadResult> {
        self.conversation_resource_read_range(session_id, workspace_id, logical_path, None)
            .await
    }

    pub async fn conversation_resource_read_range(
        &self,
        session_id: &str,
        workspace_id: &str,
        logical_path: &str,
        start_byte: Option<u64>,
    ) -> KernelClientResult<ConversationResourceReadResult> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/resources/read"
            )))
            .json(&serde_json::json!({ "workspaceId": workspace_id, "logicalPath": logical_path, "startByte": start_byte }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let result: ConversationResourceReadResult = decode_api_data(value)?;
        if result.workspace_id != workspace_id || result.logical_path != logical_path {
            return Err(KernelClientError::Api(
                "conversation resource identity mismatch".to_string(),
            ));
        }
        Ok(result)
    }

    pub async fn attach_conversation_directory_index(
        &self,
        session_id: &str,
        path: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/directory-indexes"
            )))
            .json(&AttachConversationDirectoryIndexRequest { path })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn resolve_conversation_filesystem_references(
        &self,
        session_id: &str,
        references: Vec<FilesystemReferencePathInput>,
    ) -> KernelClientResult<Vec<FilesystemReference>> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/filesystem-references/resolve"
            )))
            .json(&ResolveConversationFilesystemReferencesRequest { references })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let references: Vec<FilesystemReference> = decode_api_data(value)?;
        if invalid_filesystem_references(&references) {
            return Err(KernelClientError::Api(
                "conversation filesystem references are invalid".to_string(),
            ));
        }
        Ok(references)
    }

    pub async fn detach_conversation_directory_index(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .delete(self.url(&format!(
                "/api/conversation/sessions/{session_id}/directory-indexes/{workspace_id}"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }
}

fn decode_health(value: Value) -> KernelClientResult<DaemonStatus> {
    #[derive(Deserialize)]
    struct Health {
        service: String,
        ok: bool,
    }
    let data = api_data(value)?;
    let health = Health::deserialize(&data)?;
    Ok(DaemonStatus {
        service: health.service,
        ok: health.ok,
        raw: data,
    })
}

fn decode_projection(value: Value) -> KernelClientResult<SessionProjection> {
    let projection: SessionProjection = decode_api_data(value)?;
    projection.validate().map_err(KernelClientError::Api)?;
    Ok(projection)
}

fn api_data(value: Value) -> KernelClientResult<Value> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let code = value.get("error").and_then(Value::as_str);
        let message = value.get("message").and_then(Value::as_str);
        let detail = match (code, message) {
            (Some(code), Some(message)) if code != message => format!("{code}: {message}"),
            (_, Some(message)) => message.to_owned(),
            (Some(code), None) => code.to_owned(),
            (None, None) => "unknown daemon error".to_owned(),
        };
        return Err(KernelClientError::Api(detail));
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}

fn decode_api_data<T: DeserializeOwned>(value: Value) -> KernelClientResult<T> {
    Ok(serde_json::from_value(api_data(value)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_error_retains_code_and_original_message() {
        let code = "agent_plugin_isolation_required";
        let message =
            "The selected policy prohibits Host CLI/MCP processes. No plugin process was started.";
        let error = api_data(json!({"ok": false, "error": code, "message": message})).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("daemon returned error: {code}: {message}")
        );
        for envelope in [
            json!({"ok": false, "error": code}),
            json!({"ok": false, "message": code}),
            json!({"ok": false, "error": code, "message": code}),
        ] {
            assert_eq!(
                api_data(envelope).unwrap_err().to_string(),
                format!("daemon returned error: {code}")
            );
        }
    }

    #[test]
    fn health_requires_explicit_typed_status() {
        for data in [
            json!({"service": "achbit-kernel-daemon"}),
            json!({"service": "achbit-kernel-daemon", "ok": "true"}),
            json!({"ok": true}),
        ] {
            assert!(matches!(
                decode_health(json!({"ok": true, "data": data})),
                Err(KernelClientError::Decode(_))
            ));
        }
        for ok in [true, false] {
            let data = json!({"service": "achbit-kernel-daemon", "ok": ok, "pid": 42});
            let status = decode_health(json!({"ok": true, "data": data})).unwrap();
            assert_eq!(status.ok, ok);
            assert_eq!(status.service, "achbit-kernel-daemon");
            assert_eq!(status.raw, data);
        }
    }

    #[test]
    fn trims_base_url_slash() {
        let config = KernelClientConfig::new("http://127.0.0.1:31245/");
        assert_eq!(config.base_url, "http://127.0.0.1:31245");
    }

    #[test]
    fn host_shell_token_debug_output_is_redacted() {
        let token = format!("dchost_{}", "a".repeat(64));
        let config =
            KernelClientConfig::new("http://127.0.0.1:31245").with_host_shell_token(token.clone());
        let debug = format!("{config:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(&token));
    }

    #[test]
    fn host_shell_token_is_required_and_validated() {
        let missing = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_token: None,
        };
        assert!(matches!(
            HttpKernelClient::new(missing),
            Err(KernelClientError::HostConnectionTokenMissing)
        ));

        let invalid = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_token: Some(HostShellToken::new("short")),
        };
        assert!(matches!(
            HttpKernelClient::new(invalid),
            Err(KernelClientError::HostConnectionTokenInvalid)
        ));
    }
}
