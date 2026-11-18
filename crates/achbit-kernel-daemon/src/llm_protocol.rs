//! Wire capabilities belong to the captured Provider route, not to the Session context strategy.
use crate::llm_transport::{ProviderTransportError, ResolvedLlmProfile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThinkingPolicies {
    gemini_chat_efforts: std::collections::BTreeMap<String, Vec<String>>,
    anthropic_adaptive: Vec<ThinkingPolicy>,
    anthropic_manual: Vec<ThinkingPolicy>,
    ollama_efforts: Vec<String>,
    ollama_always_thinking: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThinkingPolicy {
    prefix: String,
    efforts: Vec<String>,
    disable: DisableThinking,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DisableThinking {
    Always,
    ThroughHigh,
    Never,
}

fn thinking_policies() -> &'static ThinkingPolicies {
    static POLICIES: std::sync::LazyLock<ThinkingPolicies> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../userspace/protocol/src/modelThinkingPolicies.json"
        ))
        .expect("bundled model thinking policies")
    });
    &POLICIES
}

pub(crate) fn gemini_chat_efforts(profile: &ResolvedLlmProfile) -> Option<&'static [String]> {
    if profile.kind != "openaiCompatible" || profile.connection.adapter_id != "gemini" {
        return None;
    }
    thinking_policies()
        .gemini_chat_efforts
        .get(&profile.model)
        .map(Vec::as_slice)
}

fn cannot_disable(rule: &ThinkingPolicy, effort: Option<&str>) -> bool {
    rule.disable == DisableThinking::Never
        || rule.disable == DisableThinking::ThroughHigh && matches!(effort, Some("xhigh" | "max"))
}

pub(crate) fn qwen4_chat_efforts(profile: &ResolvedLlmProfile) -> Option<&'static [&'static str]> {
    (profile.connection.adapter_id == "dashscope"
        && profile.kind == "openaiCompatible"
        && profile.model == "qwen4-max")
        .then_some(&["low", "high", "xhigh"])
}

pub(crate) fn thinking_required(profile: &ResolvedLlmProfile) -> bool {
    if gemini_chat_efforts(profile).is_some() {
        return true;
    }
    let rules = thinking_policies();
    if profile.kind == "ollama" {
        return rules
            .ollama_always_thinking
            .iter()
            .any(|model| profile.model.split(':').next() == Some(model.as_str()));
    }
    profile.kind == "anthropic"
        && profile.provider_flavor.as_deref() != Some("deepseek")
        && rules
            .anthropic_adaptive
            .iter()
            .find(|rule| profile.model.starts_with(&rule.prefix))
            .is_some_and(|rule| cannot_disable(rule, profile.reasoning_effort.as_deref()))
}

pub(crate) struct AnthropicControls {
    pub(crate) thinking: Option<Value>,
    pub(crate) effort: Option<String>,
}

pub(crate) fn anthropic_controls(
    profile: &ResolvedLlmProfile,
    max_tokens: u32,
) -> Result<AnthropicControls, ProviderTransportError> {
    let enabled = profile.thinking.as_deref() == Some("enabled");
    let disabled = profile.thinking.as_deref() == Some("disabled");
    let vendor = profile.provider_flavor.as_deref() == Some("deepseek");
    let adaptive_vendor = matches!(
        profile.connection.adapter_id.as_str(),
        "minimax"
            | "minimax-cn"
            | "minimax-coding"
            | "minimax-coding-cn"
            | "kimi-coding"
            | "kimi-coding-global"
    );
    let rules = thinking_policies();
    let adaptive = rules
        .anthropic_adaptive
        .iter()
        .find(|rule| profile.model.starts_with(&rule.prefix));
    let manual = rules
        .anthropic_manual
        .iter()
        .find(|rule| profile.model.starts_with(&rule.prefix));
    if !vendor && !adaptive_vendor {
        if let Some(rule) = adaptive.or(manual) {
            if profile
                .reasoning_effort
                .as_ref()
                .is_some_and(|effort| !rule.efforts.contains(effort))
            {
                return Err(ProviderTransportError::message(
                    "provider_reasoning_effort_unsupported",
                    "当前模型不支持所选 reasoning effort；配置没有被自动降档。",
                ));
            }
            if disabled && cannot_disable(rule, profile.reasoning_effort.as_deref()) {
                return Err(ProviderTransportError::message(
                    "provider_thinking_disable_unsupported",
                    "当前模型和 effort 不支持关闭 thinking。",
                ));
            }
        }
    }
    let thinking = if disabled {
        Some(json!({"type":"disabled"}))
    } else if !enabled {
        None
    } else if vendor {
        Some(json!({"type":"enabled"}))
    } else if adaptive_vendor || adaptive.is_some() {
        Some(json!({"type":"adaptive"}))
    } else {
        if max_tokens <= 1024 {
            return Err(ProviderTransportError::message(
                "provider_thinking_budget_invalid",
                "手动 thinking 至少需要 1024 tokens，且预算必须小于 max_tokens。",
            ));
        }
        Some(
            json!({"type":"enabled","budget_tokens":(max_tokens / 2).max(1024).min(max_tokens - 1)}),
        )
    };
    Ok(AnthropicControls {
        thinking,
        effort: profile.reasoning_effort.clone(),
    })
}

pub(crate) fn ollama_thinking(
    profile: &ResolvedLlmProfile,
) -> Result<Value, ProviderTransportError> {
    let rules = thinking_policies();
    if profile.thinking.as_deref() == Some("disabled") {
        if rules
            .ollama_always_thinking
            .iter()
            .any(|model| profile.model.split(':').next() == Some(model.as_str()))
        {
            return Err(ProviderTransportError::message(
                "provider_thinking_disable_unsupported",
                "该模型始终使用 thinking；false 只会映射到低强度，不能当作关闭。",
            ));
        }
        return Ok(json!(false));
    }
    if let Some(effort) = &profile.reasoning_effort {
        if !rules
            .ollama_always_thinking
            .iter()
            .any(|model| profile.model.split(':').next() == Some(model.as_str()))
            || !rules.ollama_efforts.contains(effort)
        {
            return Err(ProviderTransportError::message(
                "provider_reasoning_effort_unsupported",
                "当前 Ollama 模型没有声明所选 thinking 等级；未改为布尔值或自动降档。",
            ));
        }
        return Ok(json!(effort));
    }
    // Preserve the existing no-selection boolean default; explicit levels are never discarded.
    Ok(json!(profile.thinking.as_deref() == Some("enabled")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) enum NativeReplaySurface {
    #[serde(rename = "anthropicMessages")]
    AnthropicMessages,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderNativeReplay {
    pub(crate) api_surface: NativeReplaySurface,
    pub(crate) content: Vec<Value>,
}

impl ProviderNativeReplay {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.content.is_empty() {
            return Err("provider_native_replay_empty".into());
        }
        for block in &self.content {
            let valid = match block.get("type").and_then(Value::as_str) {
                Some("text") => block.get("text").is_some_and(Value::is_string),
                Some("thinking") => {
                    block.get("thinking").is_some_and(Value::is_string)
                        && block.get("signature").is_none_or(Value::is_string)
                }
                Some("redacted_thinking") => block
                    .get("data")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()),
                Some("tool_use") => {
                    ["id", "name"].iter().all(|key| {
                        block
                            .get(key)
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.is_empty())
                    }) && block.get("input").is_some_and(Value::is_object)
                }
                _ => false,
            };
            if !valid {
                return Err("provider_native_replay_block_invalid".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ResponsesPolicy {
    pub(crate) codex: bool,
    pub(crate) instruction_role: &'static str,
    pub(crate) stateless_metadata: bool,
}

impl ResponsesPolicy {
    pub(crate) fn resolve(profile: &ResolvedLlmProfile) -> Self {
        let codex = profile.connection.adapter_id == "openai-codex";
        let deepseek = !codex
            && (profile.connection.adapter_id == "deepseek"
                || profile.provider_flavor.as_deref() == Some("deepseek"));
        Self {
            codex,
            // DeepSeek Pro treats developer as user; system retains instruction authority on both models.
            instruction_role: if deepseek { "system" } else { "developer" },
            // DeepSeek is already stateless and ignores store/cache/include/summary request options.
            stateless_metadata: !deepseek,
        }
    }
}
