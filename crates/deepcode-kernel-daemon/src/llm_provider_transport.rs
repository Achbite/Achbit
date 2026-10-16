use crate::local_agent_api::LocalProviderMessage;
use crate::prelude::*;
use crate::*;

pub(crate) fn anthropic_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: &[LocalProviderMessage],
    tools: &[LlmToolDefinition],
) -> Result<Value, ProviderTransportError> {
    let (system, chat_messages) = split_system_messages(messages);
    let chat_messages = anthropic_messages(chat_messages)?;
    let max_tokens = profile
        .max_output_tokens
        .expect("resolved Provider runtime has maxOutputTokens");
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "max_tokens": max_tokens,
        "stream": true,
    });
    if profile.provider_flavor.as_deref() == Some("deepseek") {
        if let Some(thinking) = &profile.thinking {
            body["thinking"] = json!({"type": thinking});
        }
        if let Some(effort) = &profile.reasoning_effort {
            body["output_config"] = json!({"effort": effort});
        }
    } else if profile.thinking.as_deref() == Some("enabled") {
        if max_tokens > 1024 {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": (max_tokens / 2).max(1024).min(max_tokens - 1),
            });
        }
    }
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema
            }))
            .collect::<Vec<_>>());
    }
    Ok(body)
}

fn anthropic_messages(
    messages: Vec<&LocalProviderMessage>,
) -> Result<Vec<Value>, ProviderTransportError> {
    let mut output = Vec::with_capacity(messages.len());
    for message in messages {
        match message.role.as_str() {
            "assistant" => output.push(anthropic_assistant_message(message)?),
            "tool" => append_anthropic_tool_result(&mut output, message),
            "user" if !message.image_data.is_empty() => {
                let mut content = vec![json!({"type":"text","text":message.content})];
                content.extend(message.image_data.iter().map(|image| json!({"type":"image", "source":{"type":"base64","media_type":image.media_type,"data":image.base64}})));
                output.push(json!({"role":"user","content":content}));
            }
            "user" => output.push(json!({
                "role": "user",
                "content": message.content
            })),
            _ => {
                return Err(ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Anthropic message role is invalid.",
                ))
            }
        }
    }
    Ok(output)
}

fn anthropic_assistant_message(
    message: &LocalProviderMessage,
) -> Result<Value, ProviderTransportError> {
    let mut content = Vec::new();
    if let Some(reasoning) = message
        .reasoning_content
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let mut block = json!({ "type": "thinking", "thinking": reasoning });
        if let Some(signature) = message
            .reasoning_signature
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            block["signature"] = json!(signature);
        }
        content.push(block);
    }
    let text = &message.content;
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for call in message.tool_calls.iter().flatten() {
        let input = match &call.input {
            Value::String(text) => serde_json::from_str(&text).map_err(|error| {
                ProviderTransportError::message(
                    "provider_tool_arguments_unrepresentable",
                    format!("Anthropic tool_use 要求 input 对象，原始参数无法编码：{error}"),
                )
            })?,
            value => value.clone(),
        };
        if !input.is_object() {
            return Err(ProviderTransportError::message(
                "provider_tool_arguments_unrepresentable",
                "Anthropic tool_use 要求 input 对象，原始参数不是对象。",
            ));
        }
        content.push(json!({
            "type": "tool_use",
            "id": call.provider_call_id,
            "name": call.name,
            "input": input
        }));
    }
    Ok(json!({ "role": "assistant", "content": content }))
}

fn append_anthropic_tool_result(messages: &mut Vec<Value>, message: &LocalProviderMessage) {
    let block = json!({
        "type": "tool_result",
        "tool_use_id": message.provider_call_id.as_deref()
            .expect("validated tool message has providerCallId"),
        "content": message.content
    });
    if let Some(content) = messages
        .last_mut()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get_mut("content"))
        .and_then(Value::as_array_mut)
        .filter(|content| {
            content
                .iter()
                .all(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
    {
        content.push(block);
        return;
    }
    messages.push(json!({ "role": "user", "content": [block] }));
}

pub(crate) fn ollama_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: &[LocalProviderMessage],
    tools: &[LlmToolDefinition],
) -> Result<Value, ProviderTransportError> {
    let mut tool_names = HashMap::new();
    let mut chat_messages = Vec::with_capacity(messages.len());
    for message in messages {
        let mut value = json!({"role": message.role, "content": message.content});
        if let Some(reasoning) = &message.reasoning_content {
            value["thinking"] = json!(reasoning);
        }
        if !message.image_data.is_empty() {
            value["images"] = json!(message
                .image_data
                .iter()
                .map(|image| &image.base64)
                .collect::<Vec<_>>());
        }
        let mut calls = Vec::new();
        for call in message.tool_calls.iter().flatten() {
            let arguments = match &call.input {
                Value::String(text) => serde_json::from_str(text).map_err(|error| {
                    ProviderTransportError::message(
                        "provider_tool_arguments_unrepresentable",
                        format!("Ollama tool_calls 要求 arguments 对象，原始参数无法编码：{error}"),
                    )
                })?,
                value => value.clone(),
            };
            if !arguments.is_object() {
                return Err(ProviderTransportError::message(
                    "provider_tool_arguments_unrepresentable",
                    "Ollama tool_calls 要求 arguments 对象，原始参数不是对象。",
                ));
            }
            calls.push(
                json!({"type":"function", "function":{"name":call.name,"arguments":arguments}}),
            );
            tool_names.insert(call.call_id.as_str(), call.name.as_str());
        }
        if !calls.is_empty() {
            value["tool_calls"] = json!(calls);
        }
        if message.role == "tool" {
            let name = message
                .tool_call_id
                .as_deref()
                .and_then(|id| tool_names.get(id))
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Ollama 工具结果缺少对应的 assistant 调用。",
                    )
                })?;
            value["tool_name"] = json!(name);
        }
        chat_messages.push(value);
    }
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "stream": true,
        "think": profile.thinking.as_deref() == Some("enabled"),
    });
    body["options"] = json!({
        "num_predict": profile
            .max_output_tokens
            .expect("resolved Provider runtime has maxOutputTokens")
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema
                }
            }))
            .collect::<Vec<_>>());
    }
    Ok(body)
}
