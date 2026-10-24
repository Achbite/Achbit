use crate::llm_transport::{valid_responses_hosted_search_item, LlmChatOutput, LlmToolCall};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderStreamKind {
    OpenAiCompatible,
    Responses,
    Anthropic,
    Ollama,
}

impl ProviderStreamKind {
    pub(crate) fn from_profile_kind(value: &str) -> Option<Self> {
        match value {
            "openaiCompatible" => Some(Self::OpenAiCompatible),
            "responses" => Some(Self::Responses),
            "anthropic" => Some(Self::Anthropic),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openaiCompatible",
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }

    pub(crate) fn terminal_signal(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "[DONE]",
            Self::Responses => "response.completed",
            Self::Anthropic => "message_stop",
            Self::Ollama => "done=true",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    reported_error: Option<Value>,
}

impl ProviderStreamError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reported_error: None,
        }
    }

    fn reported(code: &'static str, error: &Value) -> Self {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .filter(|message| !message.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string());
        Self {
            code,
            message,
            reported_error: Some(error.clone()),
        }
    }

    pub(crate) fn into_failure(self, secret: Option<&str>) -> Value {
        match self.reported_error {
            Some(error) => crate::provider_transport::upstream_failure(
                self.code,
                &self.message,
                &error,
                None,
                secret,
            ),
            None => {
                json!({"code":self.code, "message":crate::provider_transport::safe_detail(&self.message, secret)})
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderEmission {
    pub(crate) event: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderCompletion {
    pub(crate) provider_kind: ProviderStreamKind,
    pub(crate) finish_reason: Option<String>,
    pub(crate) usage: Option<ProviderUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_read_input_tokens: Option<u64>,
    pub(crate) cache_miss_input_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamResult {
    pub(crate) output: LlmChatOutput,
    pub(crate) completion: ProviderCompletion,
}

#[derive(Debug, Clone, Default)]
struct ToolBuffer {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    complete_arguments: Option<Value>,
    emitted_arguments: usize,
    thought_signature: Option<String>,
}

fn emit_tool_arguments(
    index: i64,
    buffer: &mut ToolBuffer,
    native: bool,
    emissions: &mut Vec<ProviderEmission>,
) {
    let (Some(id), Some(name)) = (&buffer.id, &buffer.name) else {
        return;
    };
    if buffer.emitted_arguments == buffer.arguments.len() {
        return;
    }
    let mut event = json!({ "type": "tool_call_delta", "callIndex": index,
        "callId": id, "name": name, "argumentsDelta": &buffer.arguments[buffer.emitted_arguments..] });
    if native {
        event["outputIndex"] = json!(index);
    }
    buffer.emitted_arguments = buffer.arguments.len();
    emissions.push(ProviderEmission { event });
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamAccumulator {
    kind: ProviderStreamKind,
    content: String,
    reasoning: String,
    reasoning_signature: String,
    tool_calls: BTreeMap<i64, ToolBuffer>,
    hosted_web_search_calls: Vec<Value>,
    responses_output_items: BTreeMap<i64, Value>,
    responses_emitted_output_indexes: BTreeSet<i64>,
    responses_text_by_index: BTreeMap<i64, String>,
    responses_reasoning_by_index: BTreeMap<i64, String>,
    finish_reason: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_miss_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    actual_model: Option<String>,
    service_tier: Option<String>,
    source_done: bool,
}

impl ProviderStreamAccumulator {
    pub(crate) fn new(kind: ProviderStreamKind) -> Self {
        Self {
            kind,
            content: String::new(),
            reasoning: String::new(),
            reasoning_signature: String::new(),
            tool_calls: BTreeMap::new(),
            hosted_web_search_calls: Vec::new(),
            responses_output_items: BTreeMap::new(),
            responses_emitted_output_indexes: BTreeSet::new(),
            responses_text_by_index: BTreeMap::new(),
            responses_reasoning_by_index: BTreeMap::new(),
            finish_reason: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
            cache_creation_input_tokens: None,
            actual_model: None,
            service_tier: None,
            source_done: false,
        }
    }

    pub(crate) fn source_done(&self) -> bool {
        self.source_done
    }

    pub(crate) fn ingest_payload(
        &mut self,
        payload: &[u8],
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        if self.source_done {
            return Err(ProviderStreamError::new(
                "provider_stream_data_after_terminal",
                "Provider 在完成标记后继续返回数据。",
            ));
        }
        let text = std::str::from_utf8(payload).map_err(|error| {
            ProviderStreamError::new(
                "provider_stream_utf8_invalid",
                format!("Provider 流不是 UTF-8：{error}"),
            )
        })?;
        match self.kind {
            ProviderStreamKind::OpenAiCompatible => self.ingest_openai(text),
            ProviderStreamKind::Responses => self.ingest_responses(text),
            ProviderStreamKind::Anthropic => self.ingest_anthropic(text),
            ProviderStreamKind::Ollama => self.ingest_ollama(text),
        }
    }

    fn usage_snapshot(&self) -> Result<Option<ProviderUsage>, ProviderStreamError> {
        Ok(match (self.input_tokens, self.output_tokens) {
            (Some(input_tokens), Some(output_tokens)) => Some(match self.kind {
                ProviderStreamKind::Anthropic => anthropic_usage(
                    input_tokens,
                    output_tokens,
                    self.cache_read_input_tokens,
                    self.cache_creation_input_tokens,
                )?,
                ProviderStreamKind::OpenAiCompatible | ProviderStreamKind::Responses => {
                    let cache = cache_usage_from_total(
                        input_tokens,
                        self.cache_read_input_tokens,
                        self.cache_miss_input_tokens,
                    )?;
                    ProviderUsage {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens: cache.map(|value| value.0),
                        cache_miss_input_tokens: cache.map(|value| value.1),
                    }
                }
                ProviderStreamKind::Ollama => ProviderUsage {
                    input_tokens,
                    output_tokens,
                    cache_read_input_tokens: None,
                    cache_miss_input_tokens: None,
                },
            }),
            _ => None,
        })
    }

    pub(crate) fn observed_usage(
        &self,
    ) -> Result<crate::model_usage::ObservedUsage, ProviderStreamError> {
        Ok(crate::model_usage::ObservedUsage {
            usage: self.usage_snapshot()?,
            model: self.actual_model.clone(),
            service_tier: self.service_tier.clone(),
            cache_write_tokens: self.cache_creation_input_tokens,
        })
    }

    fn observe_metadata(&mut self, value: &Value) -> Result<(), ProviderStreamError> {
        let response = value
            .get("response")
            .or_else(|| value.get("message"))
            .unwrap_or(value);
        if let Some(model) = response.get("model").and_then(Value::as_str) {
            self.actual_model = Some(model.into());
        }
        if let Some(tier) = response.get("service_tier").and_then(Value::as_str) {
            self.service_tier = Some(tier.into());
        }
        // This optional field is retained only when explicitly reported.
        set_token_count(
            &mut self.cache_creation_input_tokens,
            response.pointer("/usage/input_tokens_details/cache_creation_tokens"),
            "缓存写入 token",
        )?;
        Ok(())
    }

    pub(crate) fn finalize(self) -> Result<ProviderStreamResult, ProviderStreamError> {
        self.finalize_with_call_id_namespace(None)
    }

    pub(crate) fn finalize_for_request(
        self,
        request_id: &str,
    ) -> Result<ProviderStreamResult, ProviderStreamError> {
        self.finalize_with_call_id_namespace(Some(request_id))
    }

    fn finalize_with_call_id_namespace(
        self,
        request_id: Option<&str>,
    ) -> Result<ProviderStreamResult, ProviderStreamError> {
        let usage = self.usage_snapshot()?;
        if !self.source_done {
            return Err(ProviderStreamError::new(
                "provider_stream_native_terminal_missing",
                "Provider 流结束前没有完成标记。",
            ));
        }
        if matches!(self.finish_reason.as_deref(), Some("length" | "max_tokens")) {
            return Err(ProviderStreamError::new(
                "provider_output_truncated",
                format!(
                    "Provider 输出因 {} 截断，本轮工具未执行。",
                    self.finish_reason.as_deref().unwrap()
                ),
            ));
        }
        if !self.reasoning_signature.trim().is_empty() && self.reasoning.trim().is_empty() {
            return Err(ProviderStreamError::new(
                "provider_reasoning_signature_without_content",
                "Provider reasoning signature 缺少对应 reasoning content。",
            ));
        }
        if self.kind == ProviderStreamKind::Responses {
            for output_index in self.tool_calls.keys() {
                if self
                    .responses_output_items
                    .get(output_index)
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    != Some("function_call")
                {
                    return Err(ProviderStreamError::new(
                        "provider_response_item_terminal_missing",
                        format!(
                            "Responses output_index {output_index} 的工具参数缺少对应的原生 function_call 完成项。"
                        ),
                    ));
                }
            }
            for output_index in self.responses_text_by_index.keys() {
                if self
                    .responses_output_items
                    .get(output_index)
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    != Some("message")
                {
                    return Err(ProviderStreamError::new(
                        "provider_response_item_terminal_missing",
                        format!(
                            "Responses output_index {output_index} 的流式正文缺少对应的原生 message 完成项。"
                        ),
                    ));
                }
            }
            for output_index in self.responses_reasoning_by_index.keys() {
                if self
                    .responses_output_items
                    .get(output_index)
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    != Some("reasoning")
                {
                    return Err(ProviderStreamError::new(
                        "provider_response_item_terminal_missing",
                        format!(
                            "Responses output_index {output_index} 的流式 reasoning 缺少对应的原生 reasoning 完成项。"
                        ),
                    ));
                }
            }
        }
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        for (index, call) in self.tool_calls {
            // Session streaming already receives the original Responses items. Its
            // input admission owns argument parsing and correction; do not turn an
            // invalid argument string into a transport failure (or an empty object).
            // The aggregate probe still needs decoded LlmToolCall values.
            if self.kind == ProviderStreamKind::Responses && request_id.is_some() {
                continue;
            }
            let name = call.name.ok_or_else(|| {
                ProviderStreamError::new(
                    "provider_tool_call_name_missing",
                    format!("Provider 工具调用 {index} 缺少名称。"),
                )
            })?;
            let arguments = match call.complete_arguments {
                Some(value) if request_id.is_some() => Value::String(value.to_string()),
                None if request_id.is_some() => Value::String(call.arguments),
                Some(value) => value,
                None => serde_json::from_str(&call.arguments).map_err(|error| {
                    ProviderStreamError::new(
                        "provider_tool_call_arguments_invalid",
                        format!("Provider 工具调用 {index} 参数不是有效 JSON：{error}"),
                    )
                })?,
            };
            if request_id.is_none() && !arguments.is_object() {
                return Err(ProviderStreamError::new(
                    "provider_tool_call_arguments_invalid",
                    format!("Provider 工具调用 {index} 参数必须是 JSON 对象。"),
                ));
            }
            let id = match (call.id, request_id) {
                (Some(id), _) => id,
                (None, Some(request_id)) => format!("provider-tool:{request_id}:{index}"),
                (None, None) => format!("probe-tool:{index}"),
            };
            tool_calls.push(LlmToolCall {
                id,
                name,
                arguments,
                thought_signature: call.thought_signature,
            });
        }
        Ok(ProviderStreamResult {
            output: LlmChatOutput {
                content: self.content,
                reasoning: (!self.reasoning.trim().is_empty()).then_some(self.reasoning),
                reasoning_signature: (!self.reasoning_signature.trim().is_empty())
                    .then_some(self.reasoning_signature),
                tool_calls,
                hosted_web_search_calls: self.hosted_web_search_calls,
            },
            completion: ProviderCompletion {
                provider_kind: self.kind,
                finish_reason: self.finish_reason,
                usage,
            },
        })
    }

    fn ingest_openai(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        if payload.trim() == "[DONE]" {
            self.source_done = true;
            return Ok(Vec::new());
        }
        let value = parse_json(payload)?;
        self.observe_metadata(&value)?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(ProviderStreamError::reported("provider_error", error));
        }
        if let Some(usage) = value.get("usage") {
            set_token_count(
                &mut self.input_tokens,
                usage
                    .get("prompt_tokens")
                    .or_else(|| usage.get("input_tokens")),
                "输入 token",
            )?;
            set_token_count(
                &mut self.output_tokens,
                usage
                    .get("completion_tokens")
                    .or_else(|| usage.get("output_tokens")),
                "输出 token",
            )?;
            set_token_count(
                &mut self.cache_read_input_tokens,
                usage
                    .get("prompt_cache_hit_tokens")
                    .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
                    .or_else(|| usage.pointer("/input_tokens_details/cached_tokens")),
                "缓存读取输入 token",
            )?;
            set_token_count(
                &mut self.cache_miss_input_tokens,
                usage.get("prompt_cache_miss_tokens"),
                "缓存未命中输入 token",
            )?;
        }
        let mut emissions = Vec::new();
        for choice in value
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_owned());
            }
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.push_text(text, &mut emissions);
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                self.push_reasoning(reasoning, &mut emissions);
            }
            for call in delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let index = required_tool_call_index(call.get("index"), "OpenAI tool call")?;
                let buffer = self.tool_calls.entry(index).or_default();
                set_once(
                    &mut buffer.id,
                    call.get("id").and_then(Value::as_str),
                    "工具调用 ID",
                )?;
                if let Some(value) = call.pointer("/extra_content/google/thought_signature") {
                    let signature = value
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| {
                            ProviderStreamError::new(
                                "provider_thought_signature_invalid",
                                "Provider tool thought signature must be nonempty text.",
                            )
                        })?;
                    set_once(
                        &mut buffer.thought_signature,
                        Some(signature),
                        "thought signature",
                    )?;
                }
                let function = call.get("function").unwrap_or(&Value::Null);
                append_streamed_tool_name(
                    &mut buffer.name,
                    function.get("name").and_then(Value::as_str),
                );
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    buffer.arguments.push_str(arguments);
                }
                emit_tool_arguments(index, buffer, false, &mut emissions);
            }
        }
        Ok(emissions)
    }

    fn ingest_responses(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        let value = parse_json(payload)?;
        self.observe_metadata(&value)?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(ProviderStreamError::reported("provider_error", error));
        }
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut emissions = Vec::new();
        match event_type {
            "error" => return Err(ProviderStreamError::reported("provider_error", &value)),
            "response.output_text.delta" => {
                if let Some(text) = value.get("delta").and_then(Value::as_str) {
                    let index = required_output_index(
                        value.get("output_index"),
                        "Responses output text delta",
                    )?;
                    self.responses_text_by_index
                        .entry(index)
                        .or_default()
                        .push_str(text);
                    self.push_responses_text(index, text, &mut emissions);
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(text) = value.get("delta").and_then(Value::as_str) {
                    let index = required_output_index(
                        value.get("output_index"),
                        "Responses reasoning summary delta",
                    )?;
                    emissions.push(ProviderEmission {
                        event: json!({ "type": "reasoning_delta", "content": text,
                        "output_index": index, "kind": "summary" }),
                    });
                }
            }
            "response.reasoning_text.delta" => {
                if let Some(text) = value.get("delta").and_then(Value::as_str) {
                    let index = required_output_index(
                        value.get("output_index"),
                        "Responses reasoning text delta",
                    )?;
                    self.responses_reasoning_by_index
                        .entry(index)
                        .or_default()
                        .push_str(text);
                    self.push_responses_reasoning(index, text, &mut emissions);
                }
            }
            "response.output_item.added" => {
                if let Some(item) = value.get("item").filter(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call")
                }) {
                    let index = required_output_index(
                        value.get("output_index"),
                        "Responses function call",
                    )?;
                    let buffer = self.tool_calls.entry(index).or_default();
                    set_once(
                        &mut buffer.id,
                        item.get("call_id").and_then(Value::as_str),
                        "工具调用 ID",
                    )?;
                    set_once(
                        &mut buffer.name,
                        item.get("name").and_then(Value::as_str),
                        "工具名称",
                    )?;
                    emit_tool_arguments(index, buffer, true, &mut emissions);
                }
            }
            "response.function_call_arguments.delta" => {
                let index = required_output_index(
                    value.get("output_index"),
                    "Responses function arguments",
                )?;
                if self.responses_output_items.contains_key(&index) {
                    return Err(ProviderStreamError::new(
                        "provider_output_delta_after_completion",
                        "工具参数在完成后继续返回。",
                    ));
                }
                if let Some(text) = value.get("delta").and_then(Value::as_str) {
                    let buffer = self.tool_calls.entry(index).or_default();
                    buffer.arguments.push_str(text);
                    emit_tool_arguments(index, buffer, true, &mut emissions);
                }
            }
            "response.output_item.done" => {
                let index =
                    required_output_index(value.get("output_index"), "Responses output item")?;
                let item = value.get("item").ok_or_else(|| {
                    ProviderStreamError::new(
                        "provider_response_item_missing",
                        "Responses output item 完成事件缺少 item。",
                    )
                })?;
                if self.responses_output_items.contains_key(&index) {
                    return Err(ProviderStreamError::new(
                        "provider_response_item_duplicate",
                        "Responses output_index 重复。",
                    ));
                }
                match item.get("type").and_then(Value::as_str) {
                    Some("function_call") => {
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .filter(|call_id| !call_id.trim().is_empty())
                            .ok_or_else(|| {
                                ProviderStreamError::new(
                                    "provider_tool_call_invalid",
                                    "Responses function_call 缺少 call_id。",
                                )
                            })?;
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|name| !name.trim().is_empty())
                            .ok_or_else(|| {
                                ProviderStreamError::new(
                                    "provider_tool_call_invalid",
                                    "Responses function_call 缺少工具名称。",
                                )
                            })?;
                        let arguments =
                            item.get("arguments")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    ProviderStreamError::new(
                                        "provider_tool_call_invalid",
                                        "Responses function_call 缺少 arguments。",
                                    )
                                })?;
                        let buffer = self.tool_calls.entry(index).or_default();
                        set_once(&mut buffer.id, Some(call_id), "工具调用 ID")?;
                        set_once(&mut buffer.name, Some(name), "工具名称")?;
                        if !buffer.arguments.is_empty() && buffer.arguments != arguments {
                            return Err(ProviderStreamError::new(
                                "provider_tool_call_arguments_conflict",
                                "Responses 工具参数增量与完成内容不一致。",
                            ));
                        }
                        if buffer.arguments.is_empty() {
                            buffer.arguments.push_str(arguments);
                        }
                        emit_tool_arguments(index, buffer, true, &mut emissions);
                    }
                    Some("web_search_call") => {
                        if !valid_responses_hosted_search_item(item) {
                            return Err(ProviderStreamError::new(
                                "provider_hosted_search_item_invalid",
                                "Responses web_search_call 终态事实无效。",
                            ));
                        }
                        let id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .expect("validated hosted search id");
                        if self.hosted_web_search_calls.iter().any(|candidate| {
                            candidate.get("id").and_then(Value::as_str) == Some(id)
                        }) {
                            return Err(ProviderStreamError::new(
                                "provider_hosted_search_item_duplicate",
                                "Responses web_search_call id 重复。",
                            ));
                        }
                        self.hosted_web_search_calls.push(item.clone());
                    }
                    Some("message") => {
                        let text = responses_item_text(item, "output_text")?;
                        match self.responses_text_by_index.get(&index) {
                            Some(streamed) if streamed != &text => {
                                return Err(ProviderStreamError::new(
                                    "provider_response_item_text_mismatch",
                                    "Responses message item 与流式正文不一致。",
                                ));
                            }
                            Some(_) => {}
                            None => self.push_responses_text(index, &text, &mut emissions),
                        }
                    }
                    Some("reasoning") => {
                        let text = responses_item_text(item, "reasoning_text")?;
                        match self.responses_reasoning_by_index.get(&index) {
                            Some(streamed) if streamed != &text => {
                                return Err(ProviderStreamError::new(
                                    "provider_response_item_reasoning_mismatch",
                                    "Responses reasoning item 与流式内容不一致。",
                                ));
                            }
                            Some(_) => {}
                            None => self.push_responses_reasoning(index, &text, &mut emissions),
                        }
                    }
                    _ => {
                        return Err(ProviderStreamError::new(
                            "provider_response_item_type_unsupported",
                            "Responses 返回了当前合同未支持的 output item 类型。",
                        ));
                    }
                }
                self.responses_output_items.insert(index, item.clone());
                self.emit_contiguous_responses_output_items(&mut emissions);
            }
            "response.completed" => {
                let response = value.get("response").unwrap_or(&Value::Null);
                let usage = response.get("usage").unwrap_or(&Value::Null);
                set_token_count(
                    &mut self.input_tokens,
                    usage.get("input_tokens"),
                    "输入 token",
                )?;
                set_token_count(
                    &mut self.output_tokens,
                    usage.get("output_tokens"),
                    "输出 token",
                )?;
                set_token_count(
                    &mut self.cache_read_input_tokens,
                    usage.pointer("/input_tokens_details/cached_tokens"),
                    "缓存读取输入 token",
                )?;
                set_token_count(
                    &mut self.cache_creation_input_tokens,
                    usage.pointer("/input_tokens_details/cache_write_tokens"),
                    "缓存写入输入 token",
                )?;
                self.finish_reason = Some(if self.tool_calls.is_empty() {
                    "stop".to_string()
                } else {
                    "tool_calls".to_string()
                });
                self.emit_remaining_responses_output_items(&mut emissions);
                self.source_done = true;
            }
            "response.failed" | "response.incomplete" => {
                let error = value
                    .pointer("/response/error")
                    .filter(|error| !error.is_null());
                if let Some(error) = error {
                    return Err(ProviderStreamError::reported(
                        "provider_response_failed",
                        error,
                    ));
                }
                let reason = value
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or(event_type);
                return Err(ProviderStreamError::reported(
                    "provider_response_failed",
                    &json!({
                        "type": event_type, "message": format!("Responses 请求未完成：{reason}"),
                    }),
                ));
            }
            _ => {}
        }
        Ok(emissions)
    }

    fn ingest_anthropic(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        let value = parse_json(payload)?;
        self.observe_metadata(&value)?;
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut emissions = Vec::new();
        match event_type {
            "message_start" => {
                set_token_count(
                    &mut self.input_tokens,
                    value.pointer("/message/usage/input_tokens"),
                    "输入 token",
                )?;
                set_token_count(
                    &mut self.cache_read_input_tokens,
                    value.pointer("/message/usage/cache_read_input_tokens"),
                    "缓存读取输入 token",
                )?;
                set_token_count(
                    &mut self.cache_creation_input_tokens,
                    value.pointer("/message/usage/cache_creation_input_tokens"),
                    "缓存创建输入 token",
                )?;
            }
            "content_block_start" => {
                let index =
                    required_tool_call_index(value.get("index"), "Anthropic content block start")?;
                let block = value.get("content_block").unwrap_or(&Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("thinking") {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        self.push_reasoning(thinking, &mut emissions);
                    }
                    if let Some(signature) = block.get("signature").and_then(Value::as_str) {
                        self.reasoning_signature.push_str(signature);
                    }
                }
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let buffer = self.tool_calls.entry(index).or_default();
                    set_once(
                        &mut buffer.id,
                        block.get("id").and_then(Value::as_str),
                        "工具调用 ID",
                    )?;
                    set_once(
                        &mut buffer.name,
                        block.get("name").and_then(Value::as_str),
                        "工具名称",
                    )?;
                    if let Some(input) = block.get("input").filter(|value| {
                        !value.is_null()
                            && value.as_object().is_none_or(|object| !object.is_empty())
                    }) {
                        buffer.complete_arguments = Some(input.clone());
                    }
                }
            }
            "content_block_delta" => {
                let index =
                    required_tool_call_index(value.get("index"), "Anthropic content block delta")?;
                let delta = value.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.push_text(text, &mut emissions);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            self.push_reasoning(text, &mut emissions);
                        }
                    }
                    Some("signature_delta") => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            self.reasoning_signature.push_str(signature);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(text) = delta.get("partial_json").and_then(Value::as_str) {
                            let buffer = self.tool_calls.entry(index).or_default();
                            buffer.arguments.push_str(text);
                            emit_tool_arguments(index, buffer, false, &mut emissions);
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                self.finish_reason = value
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                set_token_count(
                    &mut self.output_tokens,
                    value.pointer("/usage/output_tokens"),
                    "输出 token",
                )?;
            }
            "message_stop" => self.source_done = true,
            "error" => {
                return Err(ProviderStreamError::reported(
                    "provider_error",
                    value.get("error").unwrap_or(&value),
                ));
            }
            _ => {}
        }
        Ok(emissions)
    }

    fn ingest_ollama(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        let value = parse_json(payload)?;
        self.observe_metadata(&value)?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(ProviderStreamError::reported("provider_error", error));
        }
        let mut emissions = Vec::new();
        let message = value.get("message").unwrap_or(&Value::Null);
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            self.push_text(text, &mut emissions);
        }
        if let Some(reasoning) = message.get("thinking").and_then(Value::as_str) {
            self.push_reasoning(reasoning, &mut emissions);
        }
        for (index, call) in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let function = call.get("function").unwrap_or(call);
            let buffer = self.tool_calls.entry(index as i64).or_default();
            set_once(
                &mut buffer.name,
                function.get("name").and_then(Value::as_str),
                "工具名称",
            )?;
            if let Some(arguments) = function.get("arguments") {
                buffer.complete_arguments = Some(arguments.clone());
            }
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            set_token_count(
                &mut self.input_tokens,
                value.get("prompt_eval_count"),
                "输入 token",
            )?;
            set_token_count(
                &mut self.output_tokens,
                value.get("eval_count"),
                "输出 token",
            )?;
            self.source_done = true;
            self.finish_reason = value
                .get("done_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Ok(emissions)
    }

    fn push_text(&mut self, text: &str, emissions: &mut Vec<ProviderEmission>) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        emissions.push(ProviderEmission {
            event: json!({ "type": "text_delta", "content": text }),
        });
    }

    fn push_reasoning(&mut self, text: &str, emissions: &mut Vec<ProviderEmission>) {
        if text.is_empty() {
            return;
        }
        self.reasoning.push_str(text);
        emissions.push(ProviderEmission {
            event: json!({ "type": "reasoning_delta", "content": text }),
        });
    }

    fn push_responses_text(
        &mut self,
        output_index: i64,
        text: &str,
        emissions: &mut Vec<ProviderEmission>,
    ) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        emissions.push(ProviderEmission {
            event: json!({
                "type": "text_delta",
                "output_index": output_index,
                "content": text,
            }),
        });
    }

    fn push_responses_reasoning(
        &mut self,
        output_index: i64,
        text: &str,
        emissions: &mut Vec<ProviderEmission>,
    ) {
        if text.is_empty() {
            return;
        }
        self.reasoning.push_str(text);
        emissions.push(ProviderEmission {
            event: json!({
                "type": "reasoning_delta",
                "output_index": output_index,
                "content": text,
            }),
        });
    }

    fn emit_contiguous_responses_output_items(&mut self, emissions: &mut Vec<ProviderEmission>) {
        let mut output_index = 0;
        while self
            .responses_emitted_output_indexes
            .contains(&output_index)
        {
            output_index += 1;
        }
        while let Some(item) = self.responses_output_items.get(&output_index) {
            emissions.push(ProviderEmission {
                event: json!({
                    "type": "output_item_completed",
                    "output_index": output_index,
                    "item": item,
                }),
            });
            self.responses_emitted_output_indexes.insert(output_index);
            output_index += 1;
        }
    }

    fn emit_remaining_responses_output_items(&mut self, emissions: &mut Vec<ProviderEmission>) {
        for (&output_index, item) in &self.responses_output_items {
            if self.responses_emitted_output_indexes.insert(output_index) {
                emissions.push(ProviderEmission {
                    event: json!({
                        "type": "output_item_completed",
                        "output_index": output_index,
                        "item": item,
                    }),
                });
            }
        }
    }
}

fn cache_usage_from_total(
    input_tokens: u64,
    cache_read_input_tokens: Option<u64>,
    cache_miss_input_tokens: Option<u64>,
) -> Result<Option<(u64, u64)>, ProviderStreamError> {
    let result = match (cache_read_input_tokens, cache_miss_input_tokens) {
        (None, None) => return Ok(None),
        (Some(read), None) if read <= input_tokens => (read, input_tokens - read),
        (None, Some(miss)) if miss <= input_tokens => (input_tokens - miss, miss),
        (Some(read), Some(miss))
            if read
                .checked_add(miss)
                .is_some_and(|sum| sum == input_tokens) =>
        {
            (read, miss)
        }
        _ => {
            return Err(ProviderStreamError::new(
                "provider_usage_invalid",
                "Provider 缓存 token 必须完整划分输入 token 总量。",
            ));
        }
    };
    Ok(Some(result))
}

fn anthropic_usage(
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
) -> Result<ProviderUsage, ProviderStreamError> {
    let Some(cache_read_input_tokens) = cache_read_input_tokens else {
        return Ok(ProviderUsage {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
        });
    };
    let Some(cache_creation_input_tokens) = cache_creation_input_tokens else {
        return Ok(ProviderUsage {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
        });
    };
    let cache_miss_input_tokens = input_tokens
        .checked_add(cache_creation_input_tokens)
        .ok_or_else(|| {
            ProviderStreamError::new("provider_usage_invalid", "Provider 输入 token 溢出。")
        })?;
    let total_input_tokens = cache_miss_input_tokens
        .checked_add(cache_read_input_tokens)
        .ok_or_else(|| {
            ProviderStreamError::new("provider_usage_invalid", "Provider 输入 token 溢出。")
        })?;
    Ok(ProviderUsage {
        input_tokens: total_input_tokens,
        output_tokens,
        cache_read_input_tokens: Some(cache_read_input_tokens),
        cache_miss_input_tokens: Some(cache_miss_input_tokens),
    })
}

fn parse_json(payload: &str) -> Result<Value, ProviderStreamError> {
    serde_json::from_str(payload).map_err(|error| {
        ProviderStreamError::new(
            "provider_stream_json_invalid",
            format!("Provider 流事件不是有效 JSON：{error}"),
        )
    })
}

fn required_tool_call_index(
    value: Option<&Value>,
    context: &str,
) -> Result<i64, ProviderStreamError> {
    value
        .and_then(Value::as_i64)
        .filter(|index| *index >= 0)
        .ok_or_else(|| {
            ProviderStreamError::new(
                "provider_tool_call_index_invalid",
                format!("{context} 缺少非负整数 index。"),
            )
        })
}

fn required_output_index(value: Option<&Value>, context: &str) -> Result<i64, ProviderStreamError> {
    value
        .and_then(Value::as_i64)
        .filter(|index| *index >= 0)
        .ok_or_else(|| {
            ProviderStreamError::new(
                "provider_response_output_index_invalid",
                format!("{context} 缺少非负整数 output_index。"),
            )
        })
}

fn responses_item_text(
    item: &Value,
    expected_part_type: &str,
) -> Result<String, ProviderStreamError> {
    let Some(parts) = item.get("content") else {
        return if expected_part_type == "reasoning_text" {
            Ok(String::new())
        } else {
            Err(ProviderStreamError::new(
                "provider_response_item_content_invalid",
                "Responses message item 缺少 content。",
            ))
        };
    };
    let parts = parts.as_array().ok_or_else(|| {
        ProviderStreamError::new(
            "provider_response_item_content_invalid",
            "Responses output item content 不是数组。",
        )
    })?;
    let mut text = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) != Some(expected_part_type) {
            continue;
        }
        let value = part.get("text").and_then(Value::as_str).ok_or_else(|| {
            ProviderStreamError::new(
                "provider_response_item_content_invalid",
                "Responses output item 文本 part 缺少 text。",
            )
        })?;
        text.push_str(value);
    }
    if expected_part_type == "output_text" && text.is_empty() {
        return Err(ProviderStreamError::new(
            "provider_response_item_content_invalid",
            "Responses message item 没有 output_text。",
        ));
    }
    Ok(text)
}

fn set_once(
    slot: &mut Option<String>,
    value: Option<&str>,
    label: &str,
) -> Result<(), ProviderStreamError> {
    let Some(value) = value else {
        return Ok(());
    };
    if slot.as_deref().is_some_and(|existing| existing != value) {
        return Err(ProviderStreamError::new(
            "provider_tool_call_identity_conflict",
            format!("Provider 在同一响应中改变了{label}。"),
        ));
    }
    if slot.is_none() {
        *slot = Some(value.to_owned());
    }
    Ok(())
}

fn append_streamed_tool_name(slot: &mut Option<String>, value: Option<&str>) {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };
    let Some(existing) = slot.as_mut() else {
        *slot = Some(value.to_owned());
        return;
    };
    if existing == value {
        return;
    }
    if value.starts_with(existing.as_str()) {
        *existing = value.to_owned();
        return;
    }
    existing.push_str(value);
}

fn set_token_count(
    slot: &mut Option<u64>,
    value: Option<&Value>,
    label: &str,
) -> Result<(), ProviderStreamError> {
    let Some(value) = value else {
        return Ok(());
    };
    let value = value.as_u64().ok_or_else(|| {
        ProviderStreamError::new(
            "provider_usage_invalid",
            format!("Provider {label}计数不是非负整数。"),
        )
    })?;
    if slot.is_some_and(|existing| existing != value) {
        return Err(ProviderStreamError::new(
            "provider_usage_conflict",
            format!("Provider 在同一响应中改变了{label}计数。"),
        ));
    }
    *slot = Some(value);
    Ok(())
}

pub(crate) fn sse_json_event(event: &str, value: Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_preserves_cache_write_usage_without_inventing_missing_values() {
        for writes in [None, Some(0), Some(12)] {
            let mut details = json!({"cached_tokens":18});
            if let Some(writes) = writes {
                details["cache_write_tokens"] = json!(writes);
            }
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
            parser
                .ingest_payload(
                    json!({"type":"response.completed","response":{"usage":{
                        "input_tokens":30,"output_tokens":6,"input_tokens_details":details,
                    }}})
                    .to_string()
                    .as_bytes(),
                )
                .unwrap();
            assert_eq!(parser.observed_usage().unwrap().cache_write_tokens, writes);
            let completed = parser.finalize().unwrap();
            assert_eq!(completed.completion.usage.unwrap().input_tokens, 30);
        }
    }

    #[test]
    fn upstream_stream_failures_preserve_details_without_becoming_protocol_errors() {
        let reported = json!({
            "code":"server_is_overloaded", "type":"service_unavailable_error",
            "message":"Our servers are currently overloaded. Please try again later.",
            "headers":{"x-retry-metadata":"NO_MORE_RETRY", "authorization":"not-public"},
        });
        for payload in [
            json!({"type":"error", "error":reported}),
            json!({"type":"response.failed", "response":{"error":reported}}),
        ] {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
            let failure = parser
                .ingest_payload(payload.to_string().as_bytes())
                .unwrap_err()
                .into_failure(None);
            assert_eq!(failure["message"], reported["message"]);
            assert_eq!(failure["diagnostics"]["category"], "provider");
            assert_eq!(failure["diagnostics"]["retryable"], false);
            assert_eq!(
                failure["diagnostics"]["providerError"],
                json!({
                    "code":"server_is_overloaded", "type":"service_unavailable_error",
                    "retryDirective":"NO_MORE_RETRY",
                })
            );
            assert!(crate::provider_transport::valid_diagnostics(
                &failure["diagnostics"]
            ));
            assert!(!failure.to_string().contains("not-public"));
        }
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let failure = parser
            .ingest_payload(br#"{"type":"error","code":"server_error","message":"Unavailable"}"#)
            .unwrap_err()
            .into_failure(None);
        assert_eq!(
            failure["diagnostics"]["providerError"]["code"],
            "server_error"
        );
        assert_eq!(failure["message"], "Unavailable");

        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let failure = parser.ingest_payload(br#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#)
            .unwrap_err().into_failure(None);
        assert_eq!(failure["diagnostics"]["category"], "provider");
        assert!(failure["message"]
            .as_str()
            .unwrap()
            .contains("max_output_tokens"));

        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let failure = parser
            .ingest_payload(b"invalid json")
            .unwrap_err()
            .into_failure(None);
        assert_eq!(failure["code"], "provider_stream_json_invalid");
        assert!(
            failure.get("diagnostics").is_none(),
            "transport owns local protocol diagnostics"
        );
    }

    #[test]
    fn truncated_chat_and_anthropic_turns_cannot_finalize_even_with_complete_tool_json() {
        for reason in ["length", "max_tokens"] {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
            parser.ingest_payload(json!({"choices":[{"delta":{"content":"unfinished", "tool_calls":[{"index":0,"id":"call-1","function":{"name":"fs_read","arguments":"{}"}}]},"finish_reason":reason}]}).to_string().as_bytes()).unwrap();
            parser.ingest_payload(b"[DONE]").unwrap();
            let error = parser
                .finalize_for_request("request:truncated")
                .unwrap_err();
            assert_eq!(error.code, "provider_output_truncated");
            assert!(error.message.contains(reason));
        }
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        parser
            .ingest_payload(br#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#)
            .unwrap();
        parser
            .ingest_payload(br#"{"type":"message_stop"}"#)
            .unwrap();
        assert_eq!(
            parser
                .finalize_for_request("request:anthropic")
                .unwrap_err()
                .code,
            "provider_output_truncated"
        );
    }

    #[test]
    fn aggregate_session_stream_preserves_raw_arguments_for_session_admission() {
        for arguments in ["{\"path\":", "", "[]", "{\"path\":\"probe.txt\"}"] {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
            parser.ingest_payload(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-raw","function":{"name":"fs_read","arguments":arguments}}]},"finish_reason":"tool_calls"}]}).to_string().as_bytes()).unwrap();
            parser.ingest_payload(b"[DONE]").unwrap();
            let output = parser.finalize_for_request("request:raw").unwrap().output;
            assert_eq!(output.tool_calls[0].arguments, arguments);
        }
    }

    #[test]
    fn responses_summary_stays_distinct_from_native_reasoning_text() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let emissions = parser.ingest_payload(br#"{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Display summary."}"#).unwrap();
        assert_eq!(emissions[0].event["kind"], "summary");
        assert_eq!(emissions[0].event["content"], "Display summary.");
        let item = json!({"type":"reasoning", "id":"reasoning:summary", "summary":[{"type":"summary_text","text":"Display summary."}]});
        parser
            .ingest_payload(
                json!({"type":"response.output_item.done","output_index":0,"item":item})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        parser
            .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
            .unwrap();
        let result = parser.finalize_for_request("request:summary").unwrap();
        assert!(result.output.reasoning.is_none());
    }

    #[test]
    fn openai_text_does_not_require_reasoning() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(br#"{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}"#)
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.content, "OK");
        assert!(result.output.reasoning.is_none());
    }

    #[test]
    fn openai_reasoning_is_emitted_incrementally_and_preserved() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        let first = parser
            .ingest_payload(br#"{"choices":[{"delta":{"reasoning_content":"inspect "}}]}"#)
            .unwrap();
        let second = parser
            .ingest_payload(
                br#"{"choices":[{"delta":{"reasoning_content":"workspace"},"finish_reason":"tool_calls"}]}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();

        assert_eq!(
            first[0].event,
            json!({ "type": "reasoning_delta", "content": "inspect " })
        );
        assert_eq!(
            second[0].event,
            json!({ "type": "reasoning_delta", "content": "workspace" })
        );
        assert_eq!(
            parser.finalize().unwrap().output.reasoning.as_deref(),
            Some("inspect workspace")
        );
    }

    #[test]
    fn openai_cache_usage_is_preserved_as_provider_fact() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(
                br#"{"choices":[],"usage":{"input_tokens":30,"output_tokens":6,"input_tokens_details":{"cached_tokens":18}}}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 30,
                output_tokens: 6,
                cache_read_input_tokens: Some(18),
                cache_miss_input_tokens: Some(12),
            })
        );
    }

    #[test]
    fn provider_cache_fields_must_partition_the_full_input() {
        assert_eq!(
            cache_usage_from_total(30, Some(18), None).unwrap(),
            Some((18, 12))
        );
        assert_eq!(
            cache_usage_from_total(30, None, Some(12)).unwrap(),
            Some((18, 12))
        );
        assert!(cache_usage_from_total(30, Some(18), Some(10)).is_err());
        assert!(cache_usage_from_total(30, Some(18), Some(14)).is_err());
    }

    #[test]
    fn provider_without_native_tool_ids_gets_request_scoped_call_identity() {
        fn call_id(request_id: &str) -> String {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Ollama);
            parser
                .ingest_payload(
                    br#"{"message":{"tool_calls":[{"function":{"name":"fs.list","arguments":{"path":"."}}}]},"done":true,"prompt_eval_count":1,"eval_count":1}"#,
                )
                .unwrap();
            parser
                .finalize_for_request(request_id)
                .unwrap()
                .output
                .tool_calls[0]
                .id
                .clone()
        }

        assert_eq!(call_id("request-a"), "provider-tool:request-a:0");
        assert_eq!(call_id("request-b"), "provider-tool:request-b:0");
        assert_ne!(call_id("request-a"), call_id("request-b"));
    }

    #[test]
    fn openai_tool_call_preserves_canonical_name_and_arguments() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(
                br#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"fs.read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.tool_calls[0].name, "fs.read");
        assert_eq!(result.output.tool_calls[0].arguments["path"], "README.md");
    }

    #[test]
    fn tool_argument_deltas_stream_before_completion_without_changing_final_input() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        let mut received = String::new();
        for fragment in ["{\"title\":\"", "Plan", "\",\"steps\":[]}"] {
            let events = parser.ingest_payload(json!({"choices":[{"delta":{"tool_calls":[{
                "index": 2, "id": "call-plan", "function": {"name":"plan_publish", "arguments":fragment}
            }]}}]}).to_string().as_bytes()).unwrap();
            assert!(!parser.source_done());
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].event["type"], "tool_call_delta");
            assert_eq!(events[0].event["callIndex"], 2);
            received.push_str(events[0].event["argumentsDelta"].as_str().unwrap());
        }
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.output.tool_calls[0].arguments,
            serde_json::from_str::<Value>(&received).unwrap()
        );
    }

    #[test]
    fn responses_tool_preview_preserves_native_index_and_rejects_conflicting_completion() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let input = json!({"title":"Preview"}).to_string();
        let mut item = json!({"type":"function_call", "id":"item-plan", "call_id":"call-plan", "name":"plan_publish", "arguments":""});
        parser
            .ingest_payload(
                json!({"type":"response.output_item.added", "output_index":3, "item":item})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let events = parser.ingest_payload(json!({"type":"response.function_call_arguments.delta", "output_index":3, "delta":input}).to_string().as_bytes()).unwrap();
        assert_eq!(events[0].event["outputIndex"], 3);
        assert_eq!(events[0].event["argumentsDelta"], input);
        let mut missing_completion = parser.clone();
        missing_completion
            .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
            .unwrap();
        assert_eq!(
            missing_completion
                .finalize_for_request("request:preview")
                .unwrap_err()
                .code,
            "provider_response_item_terminal_missing"
        );
        let mut conflicting = parser.clone();
        item["arguments"] = json!("{}");
        assert_eq!(
            conflicting
                .ingest_payload(
                    json!({"type":"response.output_item.done", "output_index":3, "item":item})
                        .to_string()
                        .as_bytes()
                )
                .unwrap_err()
                .code,
            "provider_tool_call_arguments_conflict"
        );
        item["arguments"] = json!(input);
        let done = parser
            .ingest_payload(
                json!({"type":"response.output_item.done", "output_index":3, "item":item})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        assert!(done
            .iter()
            .all(|event| event.event["type"] != "tool_call_delta"));
        parser
            .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
            .unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.tool_calls[0].arguments["title"], "Preview");
    }

    #[test]
    fn anthropic_input_json_delta_emits_tool_preview() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        parser.ingest_payload(br#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-plan","name":"plan_publish","input":{}}}"#).unwrap();
        let events = parser.ingest_payload(br#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"title\":\"Plan\"}"}}"#).unwrap();
        assert_eq!(events[0].event["argumentsDelta"], "{\"title\":\"Plan\"}");
        assert!(!parser.source_done());
        parser
            .ingest_payload(br#"{"type":"message_stop"}"#)
            .unwrap();
        assert_eq!(
            parser.finalize().unwrap().output.tool_calls[0].arguments["title"],
            "Plan"
        );
    }

    #[test]
    fn responses_hosted_search_is_preserved_with_text_and_cache_usage() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let text = parser
            .ingest_payload(br#"{"type":"response.output_text.delta","output_index":0,"delta":"Current result."}"#)
            .unwrap();
        let message_item = json!({
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "status": "completed",
            "content": [{ "type": "output_text", "text": "Current result.", "annotations": [] }],
        });
        let item = json!({
            "type": "web_search_call",
            "id": "ws_1",
            "status": "completed",
            "action": { "type": "search", "queries": ["current result"] },
        });
        let failed_item = json!({
            "type": "web_search_call",
            "id": "ws_2",
            "status": "failed",
            "action": { "type": "open_page", "url": "https://example.com/unavailable" },
        });
        let item_without_action = json!({
            "type": "web_search_call",
            "id": "ws_3",
            "status": "completed",
        });
        parser
            .ingest_payload(
                json!({
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": message_item.clone(),
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        parser
            .ingest_payload(
                json!({
                    "type": "response.output_item.done",
                    "output_index": 1,
                    "item": item.clone(),
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        parser
            .ingest_payload(
                json!({
                    "type": "response.output_item.done",
                    "output_index": 2,
                    "item": failed_item.clone(),
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        let emissions = parser
            .ingest_payload(
                json!({
                    "type": "response.output_item.done",
                    "output_index": 3,
                    "item": item_without_action.clone(),
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        assert!(emissions.iter().any(|emission| {
            emission.event["type"] == "output_item_completed"
                && emission.event["item"] == item_without_action
        }));
        parser
            .ingest_payload(
                br#"{"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":6,"input_tokens_details":{"cached_tokens":18}}}}"#,
            )
            .unwrap();
        let result = parser.finalize().unwrap();

        assert_eq!(
            text[0].event,
            json!({
                "type": "text_delta",
                "output_index": 0,
                "content": "Current result.",
            })
        );
        assert_eq!(result.output.content, "Current result.");
        assert_eq!(
            result.output.hosted_web_search_calls,
            vec![item.clone(), failed_item.clone(), item_without_action]
        );
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 30,
                output_tokens: 6,
                cache_read_input_tokens: Some(18),
                cache_miss_input_tokens: Some(12),
            })
        );
    }

    #[test]
    fn responses_session_stream_preserves_invalid_arguments_until_native_completion() {
        let item = json!({
            "type":"function_call", "call_id":"native:bad", "name":"fs_read",
            "arguments":"{\"path\":", "status":"completed"
        });
        let input = json!({"type":"response.output_item.done","output_index":0,"item":item});
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let emissions = parser.ingest_payload(input.to_string().as_bytes()).unwrap();
        assert_eq!(emissions.len(), 2);
        assert_eq!(emissions[0].event["type"], "tool_call_delta");
        assert_eq!(emissions[0].event["argumentsDelta"], item["arguments"]);
        assert_eq!(emissions[1].event["type"], "output_item_completed");
        assert_eq!(emissions[1].event["item"], item);
        parser.ingest_payload(br#"{"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":6}}}"#).unwrap();
        let result = parser.finalize_for_request("request:session").unwrap();
        assert!(
            result.output.tool_calls.is_empty(),
            "Session owns decoding native calls"
        );
        assert_eq!(result.completion.usage.unwrap().input_tokens, 30);

        let mut incomplete = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        incomplete
            .ingest_payload(input.to_string().as_bytes())
            .unwrap();
        assert_eq!(
            incomplete
                .finalize_for_request("request:interrupted")
                .unwrap_err()
                .code,
            "provider_stream_native_terminal_missing"
        );

        let mut probe = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        probe.ingest_payload(input.to_string().as_bytes()).unwrap();
        probe
            .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
            .unwrap();
        assert_eq!(
            probe.finalize().unwrap_err().code,
            "provider_tool_call_arguments_invalid"
        );
    }

    #[test]
    fn responses_function_call_requires_native_call_id() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let error = parser
            .ingest_payload(
                br#"{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","name":"fs_read","arguments":"{}"}}"#,
            )
            .expect_err("missing call_id must fail");

        assert_eq!(error.code, "provider_tool_call_invalid");
    }

    #[test]
    fn responses_streamed_content_requires_matching_native_output_item() {
        for payload in [
            br#"{"type":"response.output_text.delta","output_index":0,"delta":"partial"}"#
                .as_slice(),
            br#"{"type":"response.reasoning_text.delta","output_index":0,"delta":"partial"}"#
                .as_slice(),
        ] {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
            parser.ingest_payload(payload).unwrap();
            parser
                .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
                .unwrap();

            let error = parser
                .finalize()
                .expect_err("streamed content without a native completed item must fail");
            assert_eq!(error.code, "provider_response_item_terminal_missing");
        }
    }

    #[test]
    fn responses_output_items_are_emitted_in_native_output_index_order() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Responses);
        let items = [
            json!({
                "type": "message",
                "id": "msg_intro",
                "role": "assistant",
                "status": "completed",
                "content": [{ "type": "output_text", "text": "Searching." }],
            }),
            json!({
                "type": "web_search_call",
                "id": "ws_1",
                "status": "completed",
                "action": { "type": "search", "queries": ["current compiler release"] },
            }),
            json!({
                "type": "message",
                "id": "msg_final",
                "role": "assistant",
                "status": "completed",
                "content": [{ "type": "output_text", "text": "Found it." }],
            }),
        ];
        let mut completed_outputs = Vec::new();
        for output_index in [2, 0, 1] {
            let emissions = parser
                .ingest_payload(
                    json!({
                        "type": "response.output_item.done",
                        "output_index": output_index,
                        "item": items[output_index].clone(),
                    })
                    .to_string()
                    .as_bytes(),
                )
                .unwrap();
            completed_outputs.extend(emissions.iter().filter_map(|emission| {
                (emission.event.get("type").and_then(Value::as_str)
                    == Some("output_item_completed"))
                .then(|| {
                    Some((
                        emission.event.get("output_index")?.as_i64()?,
                        emission.event.get("item")?.clone(),
                    ))
                })
                .flatten()
            }));
        }
        let terminal_emissions = parser
            .ingest_payload(br#"{"type":"response.completed","response":{}}"#)
            .unwrap();
        completed_outputs.extend(terminal_emissions.iter().filter_map(|emission| {
            (emission.event.get("type").and_then(Value::as_str) == Some("output_item_completed"))
                .then(|| {
                    Some((
                        emission.event.get("output_index")?.as_i64()?,
                        emission.event.get("item")?.clone(),
                    ))
                })
                .flatten()
        }));

        parser.finalize().unwrap();
        assert_eq!(
            completed_outputs
                .iter()
                .map(|output| output.0)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            completed_outputs
                .iter()
                .map(|output| output.1.clone())
                .collect::<Vec<_>>(),
            items
        );
    }
}
