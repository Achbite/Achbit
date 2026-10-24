use crate::llm_transport::ResolvedLlmProfile;
use crate::DaemonSecretProvider;
use achbit_kernel_runtime::executors::{
    CloudWebSearchConfig, CloudWebSearchProvider, KernelExecutorConfig,
};

/// Select once per run; never infer search support from the chat protocol or
/// model name. Explicit search service settings retain their existing meaning.
pub(crate) fn bind_cloud_search(
    config: &mut KernelExecutorConfig,
    secrets: &mut DaemonSecretProvider,
    profile: &ResolvedLlmProfile,
    profile_id: &str,
) {
    if !config.web_search_endpoint_template.is_empty()
        || !config.web_search_auth_secret_ref.is_empty()
    {
        return;
    }
    let Some(key) = profile.api_key.as_ref().filter(|key| !key.is_empty()) else {
        return;
    };
    let Some(cloud) = cloud_search_config(profile) else {
        return;
    };
    let secret_key = format!("run-search:{profile_id}");
    secrets.values.insert(secret_key.clone(), key.clone());
    config.web_search_auth_secret_ref = format!("local-secret:{secret_key}");
    config.cloud_web_search = Some(cloud);
}

fn cloud_search_config(profile: &ResolvedLlmProfile) -> Option<CloudWebSearchConfig> {
    let base = reqwest::Url::parse(profile.base_url.as_deref()?).ok()?;
    if base.scheme() != "https" || base.port_or_known_default() != Some(443) {
        return None;
    }
    let path = base.path().trim_end_matches('/');
    let (provider, endpoint) = match (profile.provider_flavor.as_deref(), base.host_str()?, path) {
        (Some("deepseek"), "api.deepseek.com", "" | "/v1" | "/anthropic" | "/anthropic/v1") => (
            CloudWebSearchProvider::DeepSeek,
            "https://api.deepseek.com/v1/tools/search".into(),
        ),
        (Some("zhipu"), "open.bigmodel.cn", "/api/paas/v4") => (
            CloudWebSearchProvider::Glm,
            "https://open.bigmodel.cn/api/paas/v4/web_search".into(),
        ),
        (Some("moonshot"), host @ ("api.moonshot.cn" | "api.moonshot.ai"), "/v1")
            if profile.kind == "openaiCompatible" =>
        {
            (
                CloudWebSearchProvider::Kimi,
                format!("https://{host}/v1/formulas/moonshot/web-search:latest/fibers"),
            )
        }
        // Coding-plan credentials and custom gateways have distinct endpoints
        // and entitlements; do not redirect their keys to a general API.
        _ => return None,
    };
    Some(CloudWebSearchConfig { provider, endpoint })
}

#[cfg(test)]
mod tests {
    use super::*;
    use achbit_kernel_runtime::executors::SecretProvider;
    use std::collections::HashMap;

    fn profile(flavor: &str, base: &str) -> ResolvedLlmProfile {
        ResolvedLlmProfile {
            connection: crate::model_connections::ModelConnection {
                id: "connection:test".into(),
                name: "Test".into(),
                adapter_id: "openai".into(),
                billing_mode: "metered".into(),
                base_url: "https://api.openai.com/v1".into(),
                credential_kind: "apiKey".into(),
                credential_ref: None,
            },
            account_id: None,
            image_input: false,
            kind: "openaiCompatible".into(),
            provider_flavor: Some(flavor.into()),
            base_url: Some(base.into()),
            model: "model-name-may-change".into(),
            context_window_tokens: Some(1000000),
            max_output_tokens: Some(32768),
            temperature: None,
            reasoning_effort: None,
            thinking: None,
            hosted_web_search: None,
            api_key: Some("test-key".into()),
        }
    }

    #[test]
    fn openai_and_codex_do_not_bind_deepseek_search_or_copy_credentials() {
        for (adapter, base, credential_kind) in [
            ("openai", "https://api.openai.com/v1", "apiKey"),
            (
                "openai-codex",
                "https://chatgpt.com/backend-api/codex",
                "oauth",
            ),
        ] {
            let mut selected = profile("openai", base);
            selected.connection.adapter_id = adapter.into();
            selected.connection.base_url = base.into();
            selected.connection.credential_kind = credential_kind.into();
            selected.connection.billing_mode = if credential_kind == "oauth" {
                "subscription"
            } else {
                "metered"
            }
            .into();
            selected.kind = "responses".into();
            selected.model = "gpt-6-astra".into();
            selected.hosted_web_search = Some("web_search".into());
            if credential_kind == "oauth" {
                selected.api_key = None;
                selected.account_id = Some("account:codex-test".into());
            }
            assert!(cloud_search_config(&selected).is_none());
            let mut config = KernelExecutorConfig::default();
            let existing_secrets = HashMap::from([(
                "configured-deepseek".to_string(),
                "deepseek-test-key".to_string(),
            )]);
            let mut secrets = DaemonSecretProvider {
                values: existing_secrets.clone(),
            };
            bind_cloud_search(&mut config, &mut secrets, &selected, "selected-gpt");
            assert!(config.cloud_web_search.is_none());
            assert!(config.web_search_auth_secret_ref.is_empty());
            assert_eq!(secrets.values, existing_secrets);
        }
    }

    #[test]
    fn search_binding_uses_provider_endpoints_not_model_aliases() {
        for (flavor, base, provider) in [
            (
                "deepseek",
                "https://api.deepseek.com",
                CloudWebSearchProvider::DeepSeek,
            ),
            (
                "deepseek",
                "https://api.deepseek.com/anthropic/v1",
                CloudWebSearchProvider::DeepSeek,
            ),
            (
                "zhipu",
                "https://open.bigmodel.cn/api/paas/v4",
                CloudWebSearchProvider::Glm,
            ),
            (
                "moonshot",
                "https://api.moonshot.cn/v1",
                CloudWebSearchProvider::Kimi,
            ),
            (
                "moonshot",
                "https://api.moonshot.ai/v1",
                CloudWebSearchProvider::Kimi,
            ),
        ] {
            let mut config = KernelExecutorConfig::default();
            let mut secrets = DaemonSecretProvider {
                values: HashMap::new(),
            };
            bind_cloud_search(
                &mut config,
                &mut secrets,
                &profile(flavor, base),
                "selected",
            );
            let cloud = config.cloud_web_search.unwrap();
            assert_eq!(cloud.provider, provider);
            if provider == CloudWebSearchProvider::DeepSeek {
                assert_eq!(cloud.endpoint, "https://api.deepseek.com/v1/tools/search");
            }
            assert_eq!(
                secrets
                    .resolve(&config.web_search_auth_secret_ref)
                    .as_deref(),
                Some("test-key")
            );
        }
        assert!(cloud_search_config(&profile("deepseek", "https://gateway.example/v1")).is_none());
        assert!(cloud_search_config(&profile(
            "zhipu",
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ))
        .is_none());
        let mut config = KernelExecutorConfig {
            web_search_endpoint_template: "https://search.example?q={query}".into(),
            ..Default::default()
        };
        let mut secrets = DaemonSecretProvider {
            values: HashMap::new(),
        };
        bind_cloud_search(
            &mut config,
            &mut secrets,
            &profile("deepseek", "https://api.deepseek.com"),
            "selected",
        );
        assert!(config.cloud_web_search.is_none());
        assert!(secrets.values.is_empty());
    }
}
