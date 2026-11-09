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
    } else if matches!(
        profile.connection.adapter_id.as_str(),
        "minimax"
            | "minimax-cn"
            | "minimax-coding"
            | "minimax-coding-cn"
            | "kimi-coding"
            | "kimi-coding-global"
    ) {
        if let Some(thinking) = &profile.thinking {
            body["thinking"] =
                json!({"type": if thinking == "enabled" { "adaptive" } else { thinking }});
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
    // The Anthropic adapter and explicit custom Anthropic protocol opt into its
    // cache contract. Other vendors sharing the wire format keep their own semantics.
    if profile.connection.adapter_id == "anthropic"
        || profile.connection.adapter_id == "custom"
            && matches!(profile.provider_flavor.as_deref(), None | Some("openai"))
    {
        apply_anthropic_cache_breakpoints(&mut body);
    }
    Ok(body)
}

fn apply_anthropic_cache_breakpoints(body: &mut Value) {
    if let Some(tool) = body
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .and_then(|tools| tools.last_mut())
    {
        tool["cache_control"] = json!({"type":"ephemeral"});
    }
    if let Some(system) = body.get_mut("system") {
        let text = system.as_str().expect("Anthropic system text");
        *system = json!([{"type":"text", "text":text, "cache_control":{"type":"ephemeral"}}]);
    }
    let messages = body["messages"]
        .as_array_mut()
        .expect("Anthropic message array");
    // Use the same content shape after a message stops being the final breakpoint.
    // Only cache metadata moves; already-sent text and tool identities stay intact.
    for message in messages
        .iter_mut()
        .filter(|message| message["role"] == "user")
    {
        if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
            message["content"] = json!([{"type":"text", "text":text}]);
        }
    }
    if let Some(content) = messages
        .last_mut()
        .filter(|message| message["role"] == "user")
        .and_then(|message| message["content"].as_array_mut())
        .and_then(|blocks| blocks.last_mut())
    {
        let cacheable = match content["type"].as_str() {
            Some("text") => content["text"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            Some("image" | "tool_result") => true,
            _ => false,
        };
        if cacheable {
            content["cache_control"] = json!({"type":"ephemeral"});
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(adapter: &str) -> ResolvedLlmProfile {
        ResolvedLlmProfile {
            connection: crate::model_connections::ModelConnection {
                id: "connection:cache-test".into(),
                name: "Cache test".into(),
                adapter_id: adapter.into(),
                billing_mode: "metered".into(),
                base_url: "https://api.anthropic.com".into(),
                credential_kind: "apiKey".into(),
                credential_ref: None,
            },
            account_id: None,
            kind: "anthropic".into(),
            provider_flavor: Some("openai".into()),
            base_url: None,
            model: "claude-sonnet-4-5".into(),
            image_input: true,
            file_input_media_types: vec![],
            context_window_tokens: Some(200_000),
            max_output_tokens: Some(4096),
            temperature: None,
            reasoning_effort: None,
            thinking: None,
            hosted_web_search: None,
            api_key: None,
        }
    }

    fn messages(value: Value) -> Vec<LocalProviderMessage> {
        serde_json::from_value(value).unwrap()
    }

    fn tools() -> Vec<LlmToolDefinition> {
        serde_json::from_value(json!([
            {"name":"read", "description":"Read a file.", "inputSchema":{"type":"object", "properties":{"path":{"type":"string"}}, "required":["path"]}},
            {"name":"write", "description":"Write a file.", "inputSchema":{"type":"object", "properties":{"path":{"type":"string"},"content":{"type":"string"}}, "required":["path","content"]}}
        ])).unwrap()
    }

    fn without_cache(mut value: Value) -> Value {
        match &mut value {
            Value::Object(fields) => {
                fields.remove("cache_control");
                for field in fields.values_mut() {
                    *field = without_cache(field.take());
                }
            }
            Value::Array(values) => {
                for value in values {
                    *value = without_cache(value.take());
                }
            }
            _ => {}
        }
        value
    }

    fn breakpoint_count(value: &Value) -> usize {
        match value {
            Value::Object(fields) => {
                usize::from(fields.contains_key("cache_control"))
                    + fields.values().map(breakpoint_count).sum::<usize>()
            }
            Value::Array(values) => values.iter().map(breakpoint_count).sum(),
            _ => 0,
        }
    }

    #[test]
    fn anthropic_cache_preserves_prefix_across_tool_result_continuations() {
        let profile = profile("anthropic");
        let mut history = messages(json!([
            {"role":"system","content":"Stable tools and policy."},
            {"role":"system","content":"Use exact original file content."},
            {"role":"user","content":"Read both files.\nKeep their whitespace."}
        ]));
        let first = anthropic_stream_request_body(&profile, &history, &tools()).unwrap();
        assert_eq!(breakpoint_count(&first), 3);
        assert_eq!(
            first["system"],
            json!([{"type":"text","text":"Stable tools and policy.\n\nUse exact original file content.","cache_control":{"type":"ephemeral"}}])
        );
        assert!(first["tools"][0].get("cache_control").is_none());
        assert_eq!(
            first["tools"][1]["cache_control"],
            json!({"type":"ephemeral"})
        );
        assert_eq!(
            first["messages"][0]["content"][0]["cache_control"],
            json!({"type":"ephemeral"})
        );

        history.extend(messages(json!([
            {"role":"assistant","content":"", "reasoningContent":"opaque thought", "reasoningSignature":"opaque signature", "toolCalls":[
                {"callId":"call:a","providerCallId":"toolu_a","name":"read","input":{"path":"a.txt"}},
                {"callId":"call:b","providerCallId":"toolu_b","name":"read","input":{"path":"b.txt"}}
            ]},
            {"role":"tool","content":"  alpha\n", "toolCallId":"call:a","providerCallId":"toolu_a"},
            {"role":"tool","content":"beta\n", "toolCallId":"call:b","providerCallId":"toolu_b"}
        ])));
        let second = anthropic_stream_request_body(&profile, &history, &tools()).unwrap();
        assert_eq!(breakpoint_count(&second), 3);
        assert_eq!(second["system"], first["system"]);
        assert_eq!(second["tools"], first["tools"]);
        assert_eq!(
            without_cache(second["messages"][0].clone()),
            without_cache(first["messages"][0].clone())
        );
        assert_eq!(
            second["messages"][1]["content"][0],
            json!({"type":"thinking","thinking":"opaque thought","signature":"opaque signature"})
        );
        assert_eq!(second["messages"][1]["content"][1]["id"], "toolu_a");
        assert_eq!(second["messages"][1]["content"][2]["id"], "toolu_b");
        assert_eq!(
            second["messages"][2]["content"],
            json!([
                {"type":"tool_result","tool_use_id":"toolu_a","content":"  alpha\n"},
                {"type":"tool_result","tool_use_id":"toolu_b","content":"beta\n","cache_control":{"type":"ephemeral"}}
            ])
        );

        history.extend(messages(json!([
            {"role":"assistant","content":"Both files were read."},
            {"role":"user","content":"Continue with the same files."}
        ])));
        let third = anthropic_stream_request_body(&profile, &history, &tools()).unwrap();
        assert_eq!(breakpoint_count(&third), 3);
        for (previous, current) in second["messages"]
            .as_array()
            .unwrap()
            .iter()
            .zip(third["messages"].as_array().unwrap())
        {
            assert_eq!(
                without_cache(previous.clone()),
                without_cache(current.clone())
            );
        }
        assert_eq!(
            third["messages"][4]["content"][0]["cache_control"],
            json!({"type":"ephemeral"})
        );
    }

    #[test]
    fn anthropic_cache_marks_images_but_not_empty_text_or_thinking() {
        let profile = profile("anthropic");
        let empty = anthropic_stream_request_body(
            &profile,
            &messages(json!([
                {"role":"system","content":""}, {"role":"user","content":""}
            ])),
            &[],
        )
        .unwrap();
        assert_eq!(breakpoint_count(&empty), 0);
        assert!(empty.get("system").is_none());
        assert!(empty.get("tools").is_none());
        assert_eq!(empty["messages"][0]["content"], "");
        let thinking = anthropic_stream_request_body(&profile, &messages(json!([
            {"role":"user","content":"Think."},
            {"role":"assistant","content":"","reasoningContent":"unchanged","reasoningSignature":"signed"}
        ])), &[]).unwrap();
        assert_eq!(breakpoint_count(&thinking), 0);
        assert_eq!(
            thinking["messages"][1]["content"],
            json!([{"type":"thinking","thinking":"unchanged","signature":"signed"}])
        );

        let mut image = messages(json!([{"role":"user","content":"Inspect."}]));
        image[0]
            .image_data
            .push(crate::local_agent_api::LocalProviderImage {
                media_type: "image/png".into(),
                base64: "aW1hZ2U=".into(),
            });
        let body = anthropic_stream_request_body(&profile, &image, &[]).unwrap();
        assert_eq!(breakpoint_count(&body), 1);
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="},"cache_control":{"type":"ephemeral"}})
        );
    }

    #[test]
    fn anthropic_cache_respects_adapter_and_custom_protocol_semantics() {
        let history = messages(
            json!([{"role":"system","content":"Stable."},{"role":"user","content":"Hello."}]),
        );
        for adapter in ["anthropic", "custom"] {
            let mut profile = profile(adapter);
            for flavor in [None, Some("openai")] {
                profile.provider_flavor = flavor.map(str::to_owned);
                let body = anthropic_stream_request_body(&profile, &history, &tools()).unwrap();
                assert_eq!(breakpoint_count(&body), 3, "{adapter} {flavor:?}");
            }
        }
        for adapter in ["deepseek", "kimi-coding", "minimax-coding"] {
            let body =
                anthropic_stream_request_body(&profile(adapter), &history, &tools()).unwrap();
            assert_eq!(breakpoint_count(&body), 0, "{adapter}");
            assert_eq!(body["system"], "Stable.");
            assert_eq!(body["messages"][0]["content"], "Hello.");
        }
        let mut custom = profile("custom");
        custom.provider_flavor = Some("deepseek".into());
        let body = anthropic_stream_request_body(&custom, &history, &tools()).unwrap();
        assert_eq!(breakpoint_count(&body), 0);
        assert_eq!(body["messages"][0]["content"], "Hello.");
    }

    #[test]
    fn anthropic_cache_does_not_mask_unrepresentable_tool_arguments() {
        let history = messages(json!([{"role":"assistant","content":"", "toolCalls":[
            {"callId":"call:bad","providerCallId":"toolu_bad","name":"read","input":"{broken"}
        ]}]));
        let error =
            anthropic_stream_request_body(&profile("anthropic"), &history, &tools()).unwrap_err();
        assert_eq!(error.code, "provider_tool_arguments_unrepresentable");
    }
}
