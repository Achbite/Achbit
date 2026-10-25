use crate::prelude::*;
use crate::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelConnection {
    pub id: String,
    pub name: String,
    pub adapter_id: String,
    pub billing_mode: String,
    pub base_url: String,
    pub credential_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}

impl ModelConnection {
    pub(crate) fn validate(&self) -> Result<(), String> {
        for value in [&self.id, &self.name, &self.adapter_id] {
            if value.is_empty() || value.trim() != value {
                return Err("连接标识和名称不能为空。".into());
            }
        }
        if !matches!(self.billing_mode.as_str(), "metered" | "subscription")
            || !matches!(self.credential_kind.as_str(), "apiKey" | "oauth" | "none")
        {
            return Err("连接的计费或认证类型无效。".into());
        }
        let url = reqwest::Url::parse(&self.base_url).map_err(|e| e.to_string())?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("连接地址必须是 HTTP 或 HTTPS 地址。".into());
        }
        if self
            .credential_ref
            .as_deref()
            .is_some_and(|r| local_secret_ref_key(r).is_none())
        {
            return Err("连接凭据引用无效。".into());
        }
        let adapters = adapter_descriptors();
        let descriptor = adapters
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == self.adapter_id)
            .ok_or("服务扩展未注册。")?;
        if !descriptor["billingModes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mode| mode == &self.billing_mode)
            || !descriptor["authMethods"]
                .as_array()
                .unwrap()
                .iter()
                .any(|method| match self.credential_kind.as_str() {
                    "oauth" => method == "browser" || method == "deviceCode",
                    kind => method == kind,
                })
        {
            return Err("认证或计费方式与服务扩展不匹配。".into());
        }
        if self.adapter_id == "openai-codex"
            && self.base_url != descriptor["defaultBaseUrl"].as_str().unwrap()
        {
            return Err("订阅连接必须使用该服务的授权端点。".into());
        }
        Ok(())
    }
}

/// Split the current profile document once, preserving every model and credential identity.
/// Connections are never inferred by grouping URLs or account names.
pub(crate) fn separate_connection_fields(
    document: &mut Value,
    secrets_path: &FsPath,
) -> Result<(), String> {
    if document.get("connections").is_some() {
        return Ok(());
    }
    let previous_secrets = read_optional_json_file(secrets_path)?;
    let profiles = document
        .get_mut("profiles")
        .and_then(Value::as_array_mut)
        .ok_or("profiles 必须是数组。")?;
    let mut connections = Vec::new();
    for profile in profiles {
        let p = profile.as_object_mut().ok_or("模型配置必须是对象。")?;
        let id = p
            .get("id")
            .and_then(Value::as_str)
            .ok_or("模型缺少 ID。")?
            .to_owned();
        let kind = p
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("模型缺少协议。")?;
        let flavor = p
            .get("providerFlavor")
            .and_then(Value::as_str)
            .unwrap_or("openai");
        let adapter = if kind == "ollama" {
            "ollama"
        } else if kind == "anthropic" && flavor == "openai" {
            "custom"
        } else {
            flavor
        }
        .to_owned();
        let default_url = match (kind, flavor) {
            ("ollama", _) => "http://127.0.0.1:11434",
            ("anthropic", "deepseek") => "https://api.deepseek.com/anthropic",
            ("anthropic", _) => "https://api.anthropic.com",
            (_, "deepseek") => "https://api.deepseek.com",
            (_, "zhipu") => "https://open.bigmodel.cn/api/paas/v4",
            (_, "moonshot") => "https://api.moonshot.ai/v1",
            _ => "https://api.openai.com/v1",
        };
        let connection_id = format!("connection:{id}");
        let connection = ModelConnection {
            id: connection_id.clone(),
            name: p
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned(),
            adapter_id: adapter,
            billing_mode: "metered".into(),
            base_url: p
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or(default_url)
                .to_owned(),
            credential_kind: if kind == "ollama" { "none" } else { "apiKey" }.into(),
            credential_ref: p
                .get("secretRef")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    previous_secrets
                        .as_ref()
                        .and_then(|v| v.get(&id))
                        .and_then(Value::as_str)
                        .map(|_| format!("local-secret:{id}"))
                }),
        };
        p.remove("baseUrl");
        p.remove("secretRef");
        p.insert("connectionId".into(), json!(connection_id));
        connections.push(serde_json::to_value(connection).map_err(|e| e.to_string())?);
    }
    document["connections"] = json!(connections);
    Ok(())
}

pub(crate) fn document(gui: &GuiState) -> Result<Value, String> {
    match &gui.llm_profiles {
        LlmProfileStore::Ready(value) | LlmProfileStore::InvalidDefault { value, .. } => {
            Ok(value.clone())
        }
        LlmProfileStore::Unavailable(error) => Err(error.clone()),
    }
}

pub(crate) fn connections(gui: &GuiState) -> Result<Vec<ModelConnection>, String> {
    serde_json::from_value(document(gui)?["connections"].clone()).map_err(|e| e.to_string())
}

pub(crate) fn connection(gui: &GuiState, id: &str) -> Result<ModelConnection, String> {
    connections(gui)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在：{id}"))
}

pub(crate) fn secrets(gui: &GuiState) -> Result<Value, String> {
    match read_optional_json_file(&gui.paths.llm_secrets_path)? {
        Some(value) if llm_secret_store_is_current(&value) => Ok(value),
        Some(_) => Err("本地凭据存储格式无效。".into()),
        None => Ok(json!({})),
    }
}

pub(crate) fn read_secret(
    gui: &GuiState,
    connection: &ModelConnection,
) -> Result<Option<String>, String> {
    match connection.credential_ref.as_deref() {
        Some(reference) => {
            let key = local_secret_ref_key(reference).ok_or("凭据引用无效。")?;
            Ok(secrets(gui)?[key].as_str().map(str::to_owned))
        }
        None => Ok(None),
    }
}

pub(crate) fn store(
    gui: &mut GuiState,
    next: Value,
    next_secrets: Option<Value>,
) -> Result<(), String> {
    validate_llm_profile_store(&next)?;
    let previous_secrets = if next_secrets.is_some() {
        Some(secrets(gui)?)
    } else {
        None
    };
    if let Some(value) = &next_secrets {
        atomic_write_json(&gui.paths.llm_secrets_path, value)?;
    }
    if let Err(error) = atomic_write_json(&gui.paths.llm_profiles_path, &next) {
        if let Some(previous) = previous_secrets {
            atomic_write_json(&gui.paths.llm_secrets_path, &previous)
                .map_err(|rollback| format!("{error}; 凭据回滚失败：{rollback}"))?;
        }
        return Err(error);
    }
    gui.llm_profiles = LlmProfileStore::Ready(next);
    Ok(())
}

pub(crate) fn adapter_descriptors() -> Value {
    let model = |name: &str, id: &str, kind: &str, flavor: &str, context: u64, output: u64| {
        json!({
            "name": name, "model": id, "kind": kind, "providerFlavor": flavor,
            "contextWindowTokens": context, "maxOutputTokens": output,
            "enabled": true,
            "imageInput": matches!(id, "gpt-6-astra" | "deepseek-flash")
        })
    };
    let mut astra = model(
        "GPT-6 Astra",
        "gpt-6-astra",
        "responses",
        "openai",
        1_050_000,
        128_000,
    );
    let custom_astra = astra.clone();
    astra["hostedWebSearch"] = json!("web_search");
    let mut deepseek = model(
        "DeepSeek Flash",
        "deepseek-flash",
        "responses",
        "deepseek",
        1_000_000,
        384_000,
    );
    deepseek["thinking"] = json!("enabled");
    deepseek["reasoningEffort"] = json!("max");
    let mut adapters = json!([
        {"id":"openai","name":"OpenAI","billingModes":["metered"],"authMethods":["apiKey"],"protocols":["responses","openaiCompatible"],"defaultBaseUrl":"https://api.openai.com/v1","models":[astra],"pricing":true,"quota":false,"source":"builtin"},
        {"id":"openai-codex","name":"OpenAI · Codex","billingModes":["subscription"],"authMethods":["browser","deviceCode"],"protocols":["responses"],"defaultBaseUrl":"https://chatgpt.com/backend-api/codex","models":[astra],"pricing":false,"quota":true,"source":"builtin"},
        {"id":"deepseek","name":"DeepSeek","billingModes":["metered"],"authMethods":["apiKey"],"protocols":["responses","openaiCompatible","anthropic"],"defaultBaseUrl":"https://api.deepseek.com","models":[deepseek],"pricing":true,"quota":false,"source":"builtin"},
        {"id":"zhipu","name":"GLM API","billingModes":["metered"],"authMethods":["apiKey"],"protocols":["openaiCompatible"],"defaultBaseUrl":"https://open.bigmodel.cn/api/paas/v4","models":[model("GLM 5.3","glm-5.3","openaiCompatible","zhipu",1_000_000,131_072)],"pricing":false,"quota":false,"source":"builtin"},
        {"id":"moonshot","name":"Kimi","billingModes":["metered"],"authMethods":["apiKey"],"protocols":["openaiCompatible"],"defaultBaseUrl":"https://api.moonshot.ai/v1","models":[model("Kimi K3","kimi-k3","openaiCompatible","moonshot",1_000_000,32768)],"pricing":false,"quota":false,"source":"builtin"},
        {"id":"custom","name":"自定义 API","billingModes":["metered"],"authMethods":["apiKey"],"protocols":["responses","openaiCompatible","anthropic"],"defaultBaseUrl":"https://api.openai.com/v1","models":[custom_astra],"pricing":false,"quota":false,"source":"builtin"},
        {"id":"ollama","name":"Ollama","billingModes":["metered"],"authMethods":["none"],"protocols":["ollama"],"defaultBaseUrl":"http://127.0.0.1:11434","models":[],"pricing":false,"quota":false,"source":"builtin"}
    ]);
    // Separate entries keep plan-specific keys and endpoints distinct from metered APIs.
    // Template budgets are editable starting values, not a claim about account limits.
    for (id, name, billing, url, protocol, flavor, model_id) in [
        (
            "anthropic",
            "Anthropic · Claude",
            "metered",
            "https://api.anthropic.com",
            "anthropic",
            "openai",
            "",
        ),
        (
            "gemini",
            "Google · Gemini",
            "metered",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "openaiCompatible",
            "openai",
            "gemini-3.8-flash",
        ),
        (
            "zai",
            "Z.ai API",
            "metered",
            "https://api.z.ai/api/paas/v4",
            "openaiCompatible",
            "zhipu",
            "glm-5.3",
        ),
        (
            "glm-coding",
            "GLM Coding Plan · CN",
            "subscription",
            "https://open.bigmodel.cn/api/coding/paas/v4",
            "openaiCompatible",
            "zhipu",
            "glm-5.3",
        ),
        (
            "zai-coding",
            "Z.ai Coding Plan · Global",
            "subscription",
            "https://api.z.ai/api/coding/paas/v4",
            "openaiCompatible",
            "zhipu",
            "glm-5.3",
        ),
        (
            "kimi-coding",
            "Kimi Code · CN",
            "subscription",
            "https://api.kimi.com/coding/v1",
            "openaiCompatible",
            "moonshot",
            "kimi-for-coding",
        ),
        (
            "kimi-coding-global",
            "Kimi Code · Global",
            "subscription",
            "https://api.kimi.ai/coding/v1",
            "openaiCompatible",
            "moonshot",
            "kimi-for-coding",
        ),
        (
            "minimax",
            "MiniMax API · Global",
            "metered",
            "https://api.minimax.io/anthropic",
            "anthropic",
            "openai",
            "MiniMax-M3.1-Flash",
        ),
        (
            "minimax-cn",
            "MiniMax API · CN",
            "metered",
            "https://api.minimax.cn/anthropic",
            "anthropic",
            "openai",
            "MiniMax-M3.1-Flash",
        ),
        (
            "minimax-coding",
            "MiniMax Coding Plan · Global",
            "subscription",
            "https://api.minimax.io/anthropic",
            "anthropic",
            "openai",
            "MiniMax-M3.1-Flash",
        ),
        (
            "minimax-coding-cn",
            "MiniMax Token Plan · CN",
            "subscription",
            "https://api.minimax.cn/anthropic",
            "anthropic",
            "openai",
            "MiniMax-M3.1-Flash",
        ),
        (
            "dashscope",
            "Alibaba Cloud · DashScope",
            "metered",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "openaiCompatible",
            "openai",
            "qwen3.7-plus",
        ),
        (
            "dashscope-coding",
            "Alibaba Cloud · Coding Plan",
            "subscription",
            "https://coding.dashscope.aliyuncs.com/v1",
            "openaiCompatible",
            "openai",
            "qwen3.7-plus",
        ),
        (
            "dashscope-token",
            "Alibaba Cloud · Token Plan",
            "subscription",
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "volcengine",
            "Volcengine · Ark API",
            "metered",
            "https://ark.cn-beijing.volces.com/api/v3",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "volcengine-coding",
            "Volcengine · Coding Plan",
            "subscription",
            "https://ark.cn-beijing.volces.com/api/coding/v3",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "openrouter",
            "OpenRouter",
            "metered",
            "https://openrouter.ai/api/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "xai",
            "xAI · Grok",
            "metered",
            "https://api.x.ai/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "mistral",
            "Mistral AI",
            "metered",
            "https://api.mistral.ai/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "groq",
            "Groq",
            "metered",
            "https://api.groq.com/openai/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
        (
            "siliconflow",
            "SiliconFlow",
            "metered",
            "https://api.siliconflow.cn/v1",
            "openaiCompatible",
            "openai",
            "",
        ),
    ] {
        let models = if model_id.is_empty() {
            Vec::new()
        } else {
            vec![model(model_id, model_id, protocol, flavor, 128_000, 16_000)]
        };
        adapters.as_array_mut().unwrap().push(json!({
            "id":id, "name":name, "billingModes":[billing], "authMethods":["apiKey"],
            "protocols":[protocol], "defaultBaseUrl":url, "models":models,
            "pricing":false, "quota":false, "source":"builtin"
        }));
    }
    adapters
}

pub(crate) fn summary(gui: &GuiState) -> Result<Value, String> {
    let values = connections(gui)?
        .iter()
        .map(|connection| {
            let mut value = serde_json::to_value(connection).map_err(|e| e.to_string())?;
            let secret = read_secret(gui, connection)?;
            if connection.credential_kind == "oauth" {
                let credential = secret
                    .as_deref()
                    .map(crate::model_auth::decode_credential)
                    .transpose()?;
                value["authStatus"] = json!(if credential.is_some() {
                    "ready"
                } else {
                    "needsLogin"
                });
                if let Some(credential) = credential {
                    value["account"] = json!({"label": credential.label, "plan": credential.plan});
                }
            } else {
                value["authStatus"] = json!(if connection.credential_kind == "none"
                    || secret.is_some()
                    || (connection.credential_ref.is_none()
                        && std::env::var("DEEPCODE_LLM_API_KEY")
                            .is_ok_and(|key| !key.trim().is_empty()))
                {
                    "ready"
                } else {
                    "unconfigured"
                });
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({"connections": values, "adapters": adapter_descriptors()}))
}

pub(crate) async fn get(ReadyState(state): ReadyState) -> Json<ApiResponse> {
    match summary(&state.gui.lock().expect("gui state")) {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => ApiResponse::error("connections_read_failed", error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Edit {
    connection: Option<ModelConnection>,
    #[serde(default, deserialize_with = "present_value")]
    api_key: Option<Value>,
    profile: Option<Value>,
    remove_connection_id: Option<String>,
    order: Option<Vec<String>>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

pub(crate) async fn patch(
    ReadyState(state): ReadyState,
    Json(edit): Json<Edit>,
) -> Json<ApiResponse> {
    let removed = edit.remove_connection_id.clone();
    let result = {
        let _transition = match state.local_agent.runtime_transition() {
            Ok(value) => value,
            Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
        };
        let mut gui = state.gui.lock().expect("gui state");
        apply_edit(&mut gui, edit).and_then(|()| summary(&gui))
    };
    match result {
        Ok(value) => {
            if let Some(id) = removed {
                state.model_auth.cancel_connection(&id).await;
            }
            ApiResponse::ok(value)
        }
        Err(error) => ApiResponse::error("connection_save_failed", error),
    }
}

fn apply_edit(gui: &mut GuiState, edit: Edit) -> Result<(), String> {
    if [
        edit.connection.is_some(),
        edit.remove_connection_id.is_some(),
        edit.order.is_some(),
    ]
    .iter()
    .filter(|b| **b)
    .count()
        != 1
    {
        return Err("每次只能执行一种连接操作。".into());
    }
    let mut next = document(gui)?;
    let mut list = connections(gui)?;
    let mut credentials = secrets(gui)?;
    let original_credentials = credentials.clone();
    if let Some(mut item) = edit.connection {
        item.validate()?;
        if let Some(previous) = list.iter().find(|c| c.id == item.id) {
            if previous.adapter_id != item.adapter_id
                || previous.credential_kind != item.credential_kind
            {
                return Err("请为不同服务或认证方式新建连接。".into());
            }
            item.credential_ref = previous.credential_ref.clone();
        } else {
            item.credential_ref = None;
        }
        if let Some(key) = edit.api_key {
            if item.credential_kind != "apiKey" {
                return Err("此连接不使用 API Key。".into());
            }
            let old_key = item
                .credential_ref
                .as_deref()
                .and_then(local_secret_ref_key)
                .map(str::to_owned);
            if let Some(old) = old_key.as_deref() {
                if !list.iter().any(|c| {
                    c.id != item.id
                        && c.credential_ref.as_deref().and_then(local_secret_ref_key) == Some(old)
                }) {
                    credentials.as_object_mut().unwrap().remove(old);
                }
            }
            let key_id = item.id.clone();
            if key.is_null() {
                credentials.as_object_mut().unwrap().remove(&key_id);
                item.credential_ref = None;
            } else {
                let key = key
                    .as_str()
                    .filter(|key| !key.trim().is_empty())
                    .ok_or("API Key 不能为空。")?;
                credentials[&key_id] = json!(key);
                item.credential_ref = Some(format!("local-secret:{key_id}"));
            }
        }
        if let Some(profile) = edit.profile {
            validate_llm_profile(&profile)?;
            if profile["connectionId"] != item.id {
                return Err("模型引用的连接不匹配。".into());
            }
            let profiles = next["profiles"].as_array_mut().unwrap();
            if profiles.iter().any(|p| p["id"] == profile["id"]) {
                return Err("模型 ID 已存在。".into());
            }
            profiles.push(profile);
        }
        if let Some(current) = list.iter_mut().find(|c| c.id == item.id) {
            *current = item;
        } else {
            list.push(item);
        }
    } else if let Some(id) = edit.remove_connection_id {
        if next["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["connectionId"] == id)
        {
            return Err("请先移除此连接下的模型。".into());
        }
        let item = list.iter().find(|c| c.id == id).ok_or("连接不存在。")?;
        if let Some(key) = item
            .credential_ref
            .as_deref()
            .and_then(local_secret_ref_key)
        {
            if !list.iter().any(|c| {
                c.id != id
                    && c.credential_ref.as_deref().and_then(local_secret_ref_key) == Some(key)
            }) {
                credentials.as_object_mut().unwrap().remove(key);
            }
        }
        list.retain(|c| c.id != id);
    } else if let Some(order) = edit.order {
        let mut remaining: HashMap<_, _> = list.into_iter().map(|c| (c.id.clone(), c)).collect();
        list = order
            .iter()
            .map(|id| {
                remaining
                    .remove(id)
                    .ok_or_else(|| "连接顺序包含缺失或重复 ID。".into())
            })
            .collect::<Result<_, String>>()?;
        if !remaining.is_empty() {
            return Err("连接顺序必须包含全部连接。".into());
        }
    }
    next["connections"] = serde_json::to_value(list).map_err(|e| e.to_string())?;
    store(
        gui,
        next,
        (credentials != original_credentials).then_some(credentials),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supported_templates_enable_native_search_without_overwriting_saved_choices() {
        let descriptors = adapter_descriptors();
        for adapter in descriptors.as_array().unwrap() {
            for model in adapter["models"].as_array().unwrap() {
                if matches!(adapter["id"].as_str().unwrap(), "openai" | "openai-codex") {
                    assert_eq!(model["hostedWebSearch"], "web_search");
                    assert_eq!(model["kind"], "responses");
                } else {
                    assert!(model.get("hostedWebSearch").is_none());
                }
                if adapter["id"] == "deepseek" {
                    assert_eq!(model["model"], "deepseek-flash");
                    assert_eq!(model["thinking"], "enabled");
                    assert_eq!(model["reasoningEffort"], "max");
                    assert_eq!(model["imageInput"], true);
                }
            }
        }
        let root = std::env::temp_dir().join(
            crate::new_runtime_ref("search-choice-test")
                .unwrap()
                .replace(':', "-"),
        );
        let mut gui = GuiState::open_at(&root).unwrap();
        let initial = document(&gui).unwrap();
        let flash = &initial["profiles"][0];
        assert_eq!(flash["model"], "deepseek-flash");
        assert!(flash.get("hostedWebSearch").is_none());
        assert_eq!(flash["reasoningEffort"], "max");
        assert_eq!(flash["imageInput"], true);
        let edit: Edit = serde_json::from_value(json!({"connection":{
            "id":"search", "name":"Search", "adapterId":"openai", "billingMode":"metered",
            "baseUrl":"https://api.openai.com/v1", "credentialKind":"apiKey"}}))
        .unwrap();
        apply_edit(&mut gui, edit).unwrap();
        let mut saved = document(&gui).unwrap();
        for model in saved["profiles"].as_array_mut().unwrap() {
            model.as_object_mut().unwrap().remove("hostedWebSearch");
        }
        store(&mut gui, saved.clone(), None).unwrap();
        drop(gui);
        let reopened = GuiState::open_at(&root).unwrap();
        assert_eq!(document(&reopened).unwrap()["profiles"], saved["profiles"]);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plan_keys_and_oauth_are_validated_by_adapter_auth_capabilities() {
        let adapters = adapter_descriptors();
        for adapter in adapters.as_array().unwrap() {
            let mut connection = ModelConnection {
                id: "plan-test".into(),
                name: "Plan".into(),
                adapter_id: adapter["id"].as_str().unwrap().into(),
                billing_mode: adapter["billingModes"][0].as_str().unwrap().into(),
                base_url: adapter["defaultBaseUrl"].as_str().unwrap().into(),
                credential_kind: match adapter["authMethods"][0].as_str().unwrap() {
                    "browser" | "deviceCode" => "oauth",
                    method => method,
                }
                .into(),
                credential_ref: None,
            };
            connection.validate().unwrap();
            let actual_kind = connection.credential_kind.clone();
            for wrong_kind in ["apiKey", "oauth", "none"] {
                if wrong_kind != actual_kind {
                    connection.credential_kind = wrong_kind.into();
                    assert!(
                        connection.validate().is_err(),
                        "{} accepted {}",
                        connection.adapter_id,
                        wrong_kind
                    );
                }
            }
        }
        let find = |id: &str| {
            adapters
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"] == id)
                .unwrap()
        };
        for (api, plan) in [
            ("zhipu", "glm-coding"),
            ("zai", "zai-coding"),
            ("dashscope", "dashscope-coding"),
            ("volcengine", "volcengine-coding"),
        ] {
            assert_ne!(find(api)["defaultBaseUrl"], find(plan)["defaultBaseUrl"]);
            assert_eq!(find(plan)["authMethods"], json!(["apiKey"]));
            assert_eq!(find(plan)["quota"], false);
        }
    }

    #[test]
    fn changing_one_connection_keeps_other_credentials_and_models() {
        let root = std::env::temp_dir().join(
            crate::new_runtime_ref("connection-test")
                .unwrap()
                .replace(':', "-"),
        );
        let mut gui = GuiState::open_at(&root).unwrap();
        for id in ["a", "b"] {
            let edit:Edit=serde_json::from_value(json!({"connection":{"id":id,"name":id,"adapterId":"openai","billingMode":"metered","baseUrl":"https://api.openai.com/v1","credentialKind":"apiKey"},"apiKey":format!("key-{id}")})).unwrap();
            apply_edit(&mut gui, edit).unwrap();
        }
        let before = document(&gui).unwrap()["profiles"].clone();
        let mut a = connection(&gui, "a").unwrap();
        a.name = "Renamed".into();
        apply_edit(
            &mut gui,
            serde_json::from_value(json!({"connection":a,"apiKey":"replaced-a"})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_secret(&gui, &connection(&gui, "a").unwrap())
                .unwrap()
                .as_deref(),
            Some("replaced-a")
        );
        assert_eq!(
            read_secret(&gui, &connection(&gui, "b").unwrap())
                .unwrap()
                .as_deref(),
            Some("key-b")
        );
        assert_eq!(document(&gui).unwrap()["profiles"], before);
        apply_edit(
            &mut gui,
            serde_json::from_value(json!({"connection":a,"apiKey":null})).unwrap(),
        )
        .unwrap();
        assert!(read_secret(&gui, &connection(&gui, "a").unwrap())
            .unwrap()
            .is_none());
        assert_eq!(
            read_secret(&gui, &connection(&gui, "b").unwrap())
                .unwrap()
                .as_deref(),
            Some("key-b")
        );
        drop(gui);
        fs::remove_dir_all(root).unwrap();
    }
}
