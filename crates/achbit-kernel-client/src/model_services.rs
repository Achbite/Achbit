use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub id: String,
    pub name: String,
    pub adapter_id: String,
    pub billing_mode: String,
    pub base_url: String,
    pub credential_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    #[serde(flatten)]
    pub connection: ModelConnection,
    pub auth_status: String,
    pub account: Option<AccountSummary>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccountSummary {
    pub label: String,
    pub plan: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParameters {
    pub name: String,
    pub model: String,
    pub kind: String,
    pub provider_flavor: String,
    pub enabled: bool,
    pub context_window_tokens: Option<u64>,
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_web_search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub connection_id: String,
    #[serde(flatten)]
    pub parameters: ModelParameters,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfiles {
    pub profiles: Vec<ModelProfile>,
    pub default_profile_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterDescriptor {
    pub id: String,
    pub name: String,
    pub default_base_url: String,
    pub models: Vec<ModelParameters>,
    pub billing_modes: Vec<String>,
    pub auth_methods: Vec<String>,
    pub protocols: Vec<String>,
    pub pricing: bool,
    pub quota: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ModelConnections {
    pub connections: Vec<ConnectionSummary>,
    pub adapters: Vec<ProviderAdapterDescriptor>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAuthFlow {
    pub id: String,
    pub connection_id: String,
    pub status: String,
    pub method: String,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub expires_at: u64,
    pub error: Option<String>,
}
impl HttpKernelClient {
    async fn model_service<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        route: &str,
        body: Option<&Value>,
    ) -> KernelClientResult<T> {
        let mut request = self.http.request(method, self.url(route));
        if let Some(body) = body {
            request = request.json(body);
        }
        decode_api_data(request.send().await?.error_for_status()?.json().await?)
    }
    pub async fn model_connections(&self) -> KernelClientResult<ModelConnections> {
        self.model_service(reqwest::Method::GET, "/api/llm/connections", None)
            .await
    }
    pub async fn model_profiles(&self) -> KernelClientResult<ModelProfiles> {
        self.model_service(reqwest::Method::GET, "/api/llm/profiles", None)
            .await
    }
    pub async fn create_model_connection(
        &self,
        connection: &ModelConnection,
        profile: Option<&ModelProfile>,
    ) -> KernelClientResult<ModelConnections> {
        self.model_service(
            reqwest::Method::PATCH,
            "/api/llm/connections",
            Some(&json!({"connection":connection,"profile":profile})),
        )
        .await
    }
    pub async fn start_model_auth(
        &self,
        connection_id: &str,
        device_code: bool,
    ) -> KernelClientResult<ModelAuthFlow> {
        self.model_service(reqwest::Method::POST,"/api/llm/auth",Some(&json!({"connectionId":connection_id,"method":if device_code {"deviceCode"} else {"browser"}}))).await
    }
    pub async fn model_auth_status(&self, id: &str) -> KernelClientResult<ModelAuthFlow> {
        self.model_service(
            reqwest::Method::GET,
            &format!("/api/llm/auth/{}", model_segment(id)),
            None,
        )
        .await
    }
    pub async fn cancel_model_auth(&self, id: &str) -> KernelClientResult<ModelAuthFlow> {
        self.model_service(
            reqwest::Method::DELETE,
            &format!("/api/llm/auth/{}", model_segment(id)),
            None,
        )
        .await
    }
    pub async fn logout_model_connection(&self, id: &str) -> KernelClientResult<Value> {
        self.model_service(
            reqwest::Method::POST,
            &format!("/api/llm/connections/{}/logout", model_segment(id)),
            None,
        )
        .await
    }
    pub async fn model_quota(&self, id: &str) -> KernelClientResult<Value> {
        self.model_service(
            reqwest::Method::GET,
            &format!("/api/llm/connections/{}/quota", model_segment(id)),
            None,
        )
        .await
    }
    pub async fn model_usage(&self, query: &Value) -> KernelClientResult<Value> {
        self.model_service(reqwest::Method::POST, "/api/llm/usage", Some(query))
            .await
    }
}
fn model_segment(value: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/").expect("literal URL");
    url.path_segments_mut().expect("URL path").push(value);
    url.path().trim_start_matches('/').to_owned()
}
