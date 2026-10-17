use crate::llm_transport::{resolve_llm_profile, ResolvedLlmProfile};
use crate::prelude::*;
use crate::GuiState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRuntimeSnapshot {
    pub(crate) provider_runtime_ref: String,
    pub(crate) profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_effort_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<String>,
    pub(crate) context_window_tokens: u64,
    pub(crate) max_output_tokens: u32,
    pub(crate) api_surface: &'static str,
    pub(crate) hosted_web_search: &'static str,
}

#[derive(Clone)]
pub(crate) struct ProviderRuntimeBinding {
    snapshot: ProviderRuntimeSnapshot,
    profile: ResolvedLlmProfile,
    codex_turn_state: crate::provider_transport::CodexTurnState,
}

impl ProviderRuntimeBinding {
    pub(crate) fn snapshot(&self) -> &ProviderRuntimeSnapshot {
        &self.snapshot
    }

    pub(crate) fn profile(&self) -> ResolvedLlmProfile {
        self.profile.clone()
    }

    pub(crate) fn codex_request_context(
        &self,
        session_id: &str,
    ) -> crate::provider_transport::CodexRequestContext {
        crate::provider_transport::CodexRequestContext {
            session_id: session_id.to_owned(),
            turn_state: self.codex_turn_state.clone(),
        }
    }

    pub(crate) fn approval_reviewer(&self, effort: Option<&str>) -> Result<Self, String> {
        let mut binding = self.clone();
        binding.codex_turn_state = Default::default();
        if let Some(effort) = effort {
            binding.profile = with_reasoning_override(binding.profile, Some(effort))?;
            binding.snapshot.reasoning_effort = Some(effort.to_string());
            binding.snapshot.reasoning_effort_override = Some(effort.to_string());
        }
        binding.snapshot.provider_runtime_ref = crate::utils::new_runtime_ref("provider-runtime")?;
        binding.snapshot.hosted_web_search = "none";
        binding.profile.hosted_web_search = None;
        Ok(binding)
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProviderRuntimeRegistry {
    bindings: Arc<Mutex<HashMap<ProviderRunKey, ProviderRuntimeBinding>>>,
}

impl ProviderRuntimeRegistry {
    pub(crate) fn prepare(
        gui: &GuiState,
        profile_id: Option<&str>,
        reasoning_effort_override: Option<&str>,
    ) -> Result<ProviderRuntimeBinding, String> {
        capture_binding(gui, profile_id, reasoning_effort_override, None)
    }

    pub(crate) fn prepare_agent(
        gui: &GuiState,
        profile_id: Option<&str>,
        reasoning_effort_override: Option<&str>,
        model: Option<&Value>,
    ) -> Result<ProviderRuntimeBinding, String> {
        capture_binding(gui, profile_id, reasoning_effort_override, model)
    }

    pub(crate) fn bind(
        &self,
        session_id: &str,
        run_id: &str,
        binding: ProviderRuntimeBinding,
    ) -> Result<(), String> {
        let key = ProviderRunKey::new(session_id, run_id, &binding.snapshot.provider_runtime_ref);
        let mut bindings = self.lock()?;
        if let Some(existing) = bindings.get(&key) {
            if existing.snapshot.provider_runtime_ref != binding.snapshot.provider_runtime_ref
                || existing.snapshot.profile_id != binding.snapshot.profile_id
            {
                return Err("当前 run 已绑定其他 Provider runtime。".to_string());
            }
            return Ok(());
        }
        bindings.insert(key, binding);
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        session_id: &str,
        run_id: &str,
        provider_runtime_ref: &str,
        profile_id: &str,
        reasoning_effort_override: Option<&str>,
    ) -> Result<ProviderRuntimeBinding, String> {
        if provider_runtime_ref.trim() != provider_runtime_ref
            || provider_runtime_ref.is_empty()
            || profile_id.trim() != profile_id
            || profile_id.is_empty()
        {
            return Err("Provider runtime identity 无效。".to_string());
        }
        let key = ProviderRunKey::new(session_id, run_id, provider_runtime_ref);
        if let Some(binding) = self.lock()?.get(&key).cloned() {
            if binding.snapshot.provider_runtime_ref != provider_runtime_ref
                || binding.snapshot.profile_id != profile_id
                || binding.snapshot.reasoning_effort_override.as_deref()
                    != reasoning_effort_override
            {
                return Err("当前 run 的 Provider runtime identity 不一致。".to_string());
            }
            return Ok(binding);
        }

        Err("当前 run 的 Provider runtime 绑定已丢失；可读取历史并开始新的 run。".to_string())
    }

    pub(crate) fn release(&self, session_id: &str, run_id: &str) -> Result<(), String> {
        self.lock()?
            .retain(|key, _| key.session_id != session_id || key.run_id != run_id);
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        self.lock()?.clear();
        Ok(())
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<ProviderRunKey, ProviderRuntimeBinding>>, String>
    {
        self.bindings
            .lock()
            .map_err(|_| "Provider runtime registry 锁已损坏。".to_string())
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ProviderRunKey {
    session_id: String,
    run_id: String,
    provider_runtime_ref: String,
}

impl ProviderRunKey {
    fn new(session_id: &str, run_id: &str, provider_runtime_ref: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            provider_runtime_ref: provider_runtime_ref.to_string(),
        }
    }
}

fn capture_binding(
    gui: &GuiState,
    requested_profile_id: Option<&str>,
    reasoning_effort_override: Option<&str>,
    agent_model: Option<&Value>,
) -> Result<ProviderRuntimeBinding, String> {
    let profile_id = selected_profile_id(gui, requested_profile_id)?;
    let mut profile = resolve_llm_profile(gui, Some(&profile_id))?;
    if let Some(model) = agent_model {
        if model["profileId"] != profile_id {
            return Err("子代理模型必须沿用创建时的实例配置。".into());
        }
        profile.model = model["model"]
            .as_str()
            .ok_or("子代理缺少实例模型。")?
            .into();
        profile.thinking = model["thinking"].as_str().map(str::to_owned);
        profile.reasoning_effort = model["reasoningEffort"].as_str().map(str::to_owned);
        apply_instance_parameters(&mut profile, &model["parameters"])?;
    }
    let profile = with_reasoning_override(profile, reasoning_effort_override)?;
    let context_window_tokens = profile
        .context_window_tokens
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 contextWindowTokens。".to_string())?;
    let max_output_tokens = profile
        .max_output_tokens
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 maxOutputTokens。".to_string())?;
    if u64::from(max_output_tokens) >= context_window_tokens {
        return Err("LLM Profile 的 maxOutputTokens 必须小于 contextWindowTokens。".to_string());
    }

    let snapshot = ProviderRuntimeSnapshot {
        provider_runtime_ref: crate::utils::new_runtime_ref("provider-runtime")?,
        profile_id,
        reasoning_effort: profile.reasoning_effort.clone(),
        reasoning_effort_override: reasoning_effort_override.map(str::to_string),
        thinking: profile.thinking.clone(),
        context_window_tokens,
        max_output_tokens,
        api_surface: match profile.kind.as_str() {
            "openaiCompatible" => "chatCompletions",
            "responses" => "responses",
            "anthropic" => "anthropicMessages",
            "ollama" => "ollamaChat",
            _ => return Err("LLM Profile kind 无法映射到 Provider API surface。".to_string()),
        },
        hosted_web_search: match profile.hosted_web_search.as_deref() {
            Some("web_search") if profile.provider_flavor.as_deref() == Some("openai") => {
                "web_search"
            }
            // Flash Responses ignores this built-in tool. DeepSeek, GLM and
            // Kimi use the search API selected by the run's Kernel adapter.
            Some("web_search") => "none",
            None => "none",
            Some(_) => return Err("LLM Profile hostedWebSearch 无法映射。".to_string()),
        },
    };
    Ok(ProviderRuntimeBinding {
        snapshot,
        profile,
        codex_turn_state: Default::default(),
    })
}

fn selected_profile_id(gui: &GuiState, requested: Option<&str>) -> Result<String, String> {
    let configured_profiles = gui.llm_profiles.usable()?;
    let selected = requested.or_else(|| {
        configured_profiles
            .get("defaultProfileId")
            .and_then(Value::as_str)
    });
    let profile_id = selected.ok_or_else(|| "没有配置默认 LLM Profile。".to_string())?;
    if profile_id.is_empty() || profile_id.trim() != profile_id {
        return Err("LLM Profile id 无效。".to_string());
    }
    selected_profile(gui, profile_id)?;
    Ok(profile_id.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstanceModelParameters {
    adapter_id: String,
    kind: String,
    provider_flavor: Option<String>,
    context_window_tokens: u64,
    max_output_tokens: u32,
    image_input: bool,
    temperature: Option<f64>,
    hosted_web_search: Option<String>,
}

pub(crate) fn validate_instance_parameters(value: &Value) -> Result<(), String> {
    let parameters: InstanceModelParameters =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    if parameters.adapter_id.is_empty()
        || !matches!(
            parameters.kind.as_str(),
            "responses" | "openaiCompatible" | "anthropic" | "ollama"
        )
        || parameters.max_output_tokens == 0
        || parameters.context_window_tokens <= u64::from(parameters.max_output_tokens)
        || parameters
            .hosted_web_search
            .as_deref()
            .is_some_and(|value| value != "web_search")
    {
        return Err("子代理实例模型参数无效。".into());
    }
    Ok(())
}

fn apply_instance_parameters(
    profile: &mut ResolvedLlmProfile,
    value: &Value,
) -> Result<(), String> {
    validate_instance_parameters(value)?;
    let parameters: InstanceModelParameters =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    if profile.connection.adapter_id != parameters.adapter_id
        || profile.kind != parameters.kind
        || profile.provider_flavor != parameters.provider_flavor
    {
        return Err("子代理实例的模型服务类型已更改，原配置当前不可用。".into());
    }
    profile.context_window_tokens = Some(parameters.context_window_tokens);
    profile.max_output_tokens = Some(parameters.max_output_tokens);
    profile.image_input = parameters.image_input;
    profile.temperature = parameters.temperature;
    profile.hosted_web_search = parameters.hosted_web_search;
    Ok(())
}

fn with_reasoning_override(
    mut profile: ResolvedLlmProfile,
    effort: Option<&str>,
) -> Result<ResolvedLlmProfile, String> {
    if let Some(effort) = effort {
        if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
            return Err("对话推理强度无效。".to_string());
        }
        if profile.thinking.as_deref() == Some("disabled") {
            return Err("当前 Profile 已关闭推理，不能覆盖推理强度。".to_string());
        }
        profile.reasoning_effort = Some(effort.to_string());
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_profile() -> ResolvedLlmProfile {
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
            provider_flavor: Some("deepseek".into()),
            base_url: None,
            model: "fixture-model".into(),
            context_window_tokens: Some(4096),
            max_output_tokens: Some(512),
            temperature: None,
            reasoning_effort: Some("max".into()),
            thinking: Some("enabled".into()),
            hosted_web_search: None,
            api_key: None,
        }
    }

    #[test]
    fn dormant_instance_keeps_model_budget_and_capabilities_after_profile_edits() {
        let mut profile = configured_profile();
        profile.context_window_tokens = Some(900000);
        profile.max_output_tokens = Some(50000);
        profile.image_input = true;
        apply_instance_parameters(
            &mut profile,
            &json!({
            "adapterId":"openai","kind":"openaiCompatible","providerFlavor":"deepseek",
                "contextWindowTokens":4096,"maxOutputTokens":512,"imageInput":false,
                "temperature":0.5,"hostedWebSearch":null
            }),
        )
        .unwrap();
        assert_eq!(profile.context_window_tokens, Some(4096));
        assert_eq!(profile.max_output_tokens, Some(512));
        assert!(!profile.image_input);
        assert_eq!(profile.temperature, Some(0.5));
    }

    #[test]
    fn reviewer_binding_is_independent_and_released_with_its_run() {
        let profile = configured_profile();
        let main = ProviderRuntimeBinding {
            snapshot: ProviderRuntimeSnapshot {
                provider_runtime_ref: "provider-runtime:main".into(),
                profile_id: "profile:main".into(),
                reasoning_effort: profile.reasoning_effort.clone(),
                reasoning_effort_override: None,
                thinking: profile.thinking.clone(),
                context_window_tokens: 4096,
                max_output_tokens: 2048,
                api_surface: "responses",
                hosted_web_search: "web_search",
            },
            profile,
            codex_turn_state: Default::default(),
        };
        let reviewer = main.approval_reviewer(Some("low")).unwrap();
        let main_context = main.codex_request_context("session:model");
        main_context
            .turn_state
            .set(reqwest::header::HeaderValue::from_static("main-route"))
            .unwrap();
        assert!(reviewer
            .codex_request_context("session:model")
            .turn_state
            .get()
            .is_none());
        assert_ne!(
            reviewer.snapshot.provider_runtime_ref,
            main.snapshot.provider_runtime_ref
        );
        assert_eq!(
            reviewer.snapshot.max_output_tokens,
            main.snapshot.max_output_tokens
        );
        assert_eq!(
            reviewer.profile.max_output_tokens,
            main.profile.max_output_tokens
        );
        assert_eq!(reviewer.snapshot.hosted_web_search, "none");
        assert_eq!(reviewer.profile.hosted_web_search, None);
        assert_eq!(reviewer.profile.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(
            reviewer.snapshot.reasoning_effort_override.as_deref(),
            Some("low")
        );
        assert_eq!(main.profile.reasoning_effort.as_deref(), Some("max"));
        assert_eq!(
            main.approval_reviewer(None)
                .unwrap()
                .profile
                .reasoning_effort
                .as_deref(),
            Some("max")
        );
        assert_eq!(main.snapshot.max_output_tokens, 2048);
        let registry = ProviderRuntimeRegistry::default();
        registry
            .bind("session:model", "run:model", main.clone())
            .unwrap();
        registry
            .bind("session:model", "run:model", reviewer.clone())
            .unwrap();
        for binding in [&main, &reviewer] {
            assert!(registry
                .resolve(
                    "session:model",
                    "run:model",
                    &binding.snapshot.provider_runtime_ref,
                    &binding.snapshot.profile_id,
                    binding.snapshot.reasoning_effort_override.as_deref()
                )
                .is_ok());
        }
        let resumed = registry
            .resolve(
                "session:model",
                "run:model",
                "provider-runtime:main",
                "profile:main",
                None,
            )
            .unwrap();
        assert_eq!(
            resumed
                .codex_request_context("session:model")
                .turn_state
                .get(),
            main_context.turn_state.get()
        );
        assert!(registry
            .resolve(
                "session:model",
                "run:other",
                "provider-runtime:main",
                "profile:main",
                None
            )
            .is_err());
        registry.release("session:model", "run:model").unwrap();
        for binding in [&main, &reviewer] {
            assert!(registry
                .resolve(
                    "session:model",
                    "run:model",
                    &binding.snapshot.provider_runtime_ref,
                    &binding.snapshot.profile_id,
                    binding.snapshot.reasoning_effort_override.as_deref()
                )
                .is_err());
        }
    }

    #[test]
    fn session_override_reaches_the_provider_body_without_mutating_the_profile_or_enabling_thinking(
    ) {
        let configured = configured_profile();
        let effective = with_reasoning_override(configured.clone(), Some("low")).unwrap();
        let body = crate::llm_transport::openai_compatible_request_body(
            &effective,
            &[serde_json::from_value(json!({"role":"user","content":"Inspect source."})).unwrap()],
            &[],
            true,
        );
        assert_eq!(body["reasoning_effort"], "low");
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            let effective = with_reasoning_override(configured.clone(), Some(effort)).unwrap();
            assert_eq!(
                crate::llm_transport::openai_compatible_request_body(&effective, &[], &[], true)
                    ["reasoning_effort"],
                effort
            );
        }
        assert_eq!(configured.reasoning_effort.as_deref(), Some("max"));
        assert_eq!(
            with_reasoning_override(configured.clone(), None)
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("max")
        );
        assert!(with_reasoning_override(configured.clone(), Some("invalid")).is_err());
        let mut disabled = configured;
        disabled.thinking = Some("disabled".into());
        assert!(with_reasoning_override(disabled.clone(), Some("low")).is_err());
        assert_eq!(
            with_reasoning_override(disabled, None)
                .unwrap()
                .thinking
                .as_deref(),
            Some("disabled")
        );
    }
}

fn selected_profile<'a>(gui: &'a GuiState, profile_id: &str) -> Result<&'a Value, String> {
    gui.llm_profiles
        .usable()?
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
        .ok_or_else(|| format!("LLM Profile 不存在：{profile_id}"))
}
