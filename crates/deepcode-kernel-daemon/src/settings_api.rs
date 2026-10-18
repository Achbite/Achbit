use crate::prelude::*;
use crate::*;

pub(crate) async fn workspace_sandbox_setup(State(state): State<AppState>) -> Json<ApiResponse> {
    #[cfg(windows)]
    {
        let result = tokio::task::spawn_blocking(
            deepcode_kernel_runtime::workspace_sandbox::windows::request_setup,
        )
        .await;
        deepcode_kernel_runtime::workspace_sandbox::invalidate_probe();
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return ApiResponse::error("workspace_sandbox_setup_failed", error),
            Err(error) => {
                return ApiResponse::error("workspace_sandbox_setup_failed", error.to_string())
            }
        }
        let revision = state.gui.lock().expect("gui state lock").user_settings
            ["agent.environmentRevision"]
            .as_u64()
            .unwrap_or(0)
            + 1;
        user_settings_patch(
            State(state),
            Json(json!({"patches":{"agent.environmentRevision": revision}})),
        )
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        ApiResponse::error(
            "workspace_sandbox_setup_not_applicable",
            "Windows sandbox initialization is available on Windows hosts.",
        )
    }
}

fn setting_activates_at_next_run(key: &str) -> bool {
    // These are defaults read once when Session creates a new conversation.
    if key.starts_with("agent.subagents.") {
        return false;
    }
    key.starts_with("skills.")
        || key.starts_with("mcp.")
        || key.starts_with("plugins.")
        || key.starts_with("agent.web.search.")
        || key.starts_with("agent.documents.")
        || key == "agent.systemPrompt"
        || key.starts_with("agent.approvalReview.")
        || key.starts_with("agent.permissions.")
        || key.starts_with("agent.windows.")
        || key == "agent.environmentRevision"
        || key == "agent.projectEnvironments"
}

pub(crate) async fn user_settings_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let _transition = match state.local_agent.runtime_transition() {
        Ok(guard) => guard,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let runtime_settings = match state.local_agent.active_runtime_settings() {
        Ok(settings) => settings,
        Err(error) => {
            return ApiResponse::error("active_runtime_settings_unavailable", error);
        }
    };
    let gui = state.gui.lock().expect("gui state lock");
    let environment = match crate::session_environment::prepare(&gui.user_settings, None, false) {
        Ok(value) => value,
        Err(message) => return ApiResponse::error("session_environment_invalid", message),
    };
    ApiResponse::ok(json!({
        "environment": environment,
        "settings": gui.user_settings,
        "runtimeSettings": runtime_settings,
        "overriddenKeys": [],
        "storePath": gui.paths.settings_path.to_string_lossy()
    }))
}

pub(crate) async fn user_settings_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    match tokio::task::spawn_blocking(move || apply_user_settings_patch(state, body)).await {
        Ok(response) => response,
        Err(error) => ApiResponse::error("user_settings_update_failed", error.to_string()),
    }
}

fn apply_user_settings_patch(state: AppState, body: Value) -> Json<ApiResponse> {
    let _runtime_transition = match state.local_agent.runtime_transition() {
        Ok(transition) => transition,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let patches = body.get("patches").cloned().unwrap_or_else(|| json!({}));
    let Some(patch_object) = patches.as_object() else {
        return ApiResponse::error("invalid_user_settings", "设置补丁必须是 JSON 对象。");
    };
    let (next_settings, settings_path) = {
        let gui = state.gui.lock().expect("gui state lock");
        let mut next = gui.user_settings.clone();
        merge_object(&mut next, &patches);
        (next, gui.paths.settings_path.clone())
    };
    if let Err(message) = validate_agent_runtime_settings(&next_settings) {
        return ApiResponse::error("invalid_agent_runtime_settings", message);
    }
    if next_settings["agent.subagents.enabled"].as_bool() == Some(true)
        && [
            "agent.subagents.enabled",
            "agent.subagents.profileId",
            "agent.subagents.reasoningEffort",
        ]
        .iter()
        .any(|key| patch_object.contains_key(*key))
    {
        let profile_id = next_settings["agent.subagents.profileId"]
            .as_str()
            .unwrap_or("");
        let effort = next_settings["agent.subagents.reasoningEffort"]
            .as_str()
            .filter(|value| !value.is_empty());
        // An empty profile follows the owning Session's bound Run at delegation time.
        if !profile_id.is_empty() {
            let gui = state.gui.lock().expect("gui state lock");
            if let Err(message) =
                crate::local_agent_provider_runtime::ProviderRuntimeRegistry::prepare(
                    &gui,
                    Some(profile_id),
                    effort,
                )
            {
                return ApiResponse::error("subagent_profile_unavailable", message);
            }
        }
    }
    let changed_keys = patch_object.keys().cloned().collect::<Vec<_>>();
    let has_next_run_activation = changed_keys
        .iter()
        .any(|key| setting_activates_at_next_run(key));
    let immediate_patch = Value::Object(
        patch_object
            .iter()
            .filter(|(key, _)| !setting_activates_at_next_run(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    {
        let mut gui = match state.gui.lock() {
            Ok(gui) => gui,
            Err(_) => {
                return ApiResponse::error(
                    "settings_publication_lock_failed",
                    "Settings state lock is poisoned.",
                )
            }
        };
        if let Err(error) = state
            .local_agent
            .publish_runtime_settings(&immediate_patch, || {
                atomic_write_json(&settings_path, &next_settings)
            })
        {
            return ApiResponse::error("write_settings_failed", error);
        }
        gui.user_settings = next_settings.clone();
    }
    ApiResponse::ok(json!({
        "settings": next_settings,
        "changedKeys": changed_keys,
        "activation": if has_next_run_activation { "nextRun" } else { "immediate" }
    }))
}

pub(crate) async fn llm_profiles_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    gui.llm_profiles
        .settings_response(&gui.paths.llm_profiles_path)
}

pub(crate) async fn llm_profiles_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _transition = match state.local_agent.runtime_transition() {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let mut gui = state.gui.lock().expect("gui state lock");
    let result = (|| -> Result<Value, String> {
        let object = body.as_object().ok_or("模型更新必须是对象。")?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "profiles" | "profile" | "removeProfileId" | "defaultProfileId"
            )
        }) {
            return Err("模型更新包含未知字段。".into());
        }
        let path = gui.paths.llm_profiles_path.clone();
        if object.len() == 1 && object.contains_key("defaultProfileId") {
            gui.llm_profiles.select_default(
                &path,
                body["defaultProfileId"].as_str().ok_or("请选择模型。")?,
            )?;
        } else {
            let expanded = expand_profile_edit(&gui.llm_profiles, body)?;
            let mut next = crate::model_connections::document(&gui)?;
            next["profiles"] = expanded["profiles"].clone();
            next["defaultProfileId"] = expanded["defaultProfileId"].clone();
            crate::model_connections::store(&mut gui, next, None)?;
        }
        crate::model_connections::document(&gui)
    })();
    match result {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => ApiResponse::error("llm_profile_save_failed", error),
    }
}

pub(crate) async fn llm_probe(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let started = now_millis();
    let profile_id = body.get("profileId").and_then(Value::as_str);
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        resolve_llm_profile(&gui, profile_id)
    };
    let mut profile = match profile {
        Ok(profile) => profile,
        Err(error) => {
            return ApiResponse::ok(json!({
                "ok": false,
                "provider": "openaiCompatible",
                "error": error
            }))
        }
    };
    if let Err(error) = crate::model_auth::authorize(&state, &mut profile).await {
        return ApiResponse::error("provider_authentication_failed", error);
    }
    let mut usage_call = match state
        .model_usage
        .begin(&profile, &json!({"profileId":profile_id,"purpose":"probe"}))
    {
        Ok(call) => call,
        Err(error) => return ApiResponse::error("usage_record_failed", error),
    };
    match probe_llm_profile_stream(
        &state.local_agent.provider_transport.client,
        &profile,
        &mut usage_call,
    )
    .await
    {
        Ok(output) => ApiResponse::ok(json!({
            "ok": output.response_present,
            "provider": profile.kind,
            "model": profile.model,
            "latencyMs": now_millis().saturating_sub(started),
            "reasoningPresent": output.reasoning_present,
            "responsePresent": output.response_present,
            "nativeCompletion": {
                "providerKind": output.provider_kind,
                "terminalSignal": output.terminal_signal,
                "finishReason": output.finish_reason
            }
        })),
        Err(error) => {
            let mut result = json!({
                "ok": false,
                "provider": profile.kind,
                "model": profile.model,
                "latencyMs": now_millis().saturating_sub(started),
                "error": error.safe_message(),
                "errorCode": error.code
            });
            if let Some(http_status) = error.http_status {
                result["httpStatus"] = json!(http_status);
            }
            ApiResponse::ok(result)
        }
    }
}

pub(crate) fn default_user_settings() -> Value {
    json!({
        "workbench.language": "zh-CN",
        "workbench.styleTokenOverrides": "{}",
        "workbench.uiPlugins": "[]",
        "agent.systemPrompt": "",
        "agent.approvalReview.profileId": "",
        "agent.approvalReview.reasoningEffort": "",
        "agent.subagents.enabled": false,
        "agent.subagents.profileId": "",
        "agent.subagents.reasoningEffort": "",
        "agent.subagents.maxConcurrent": 4,
        "agent.subagents.maxCallsPerRun": 16,
        "agent.subagents.maxMembersPerSession": 4,
        "agent.subagents.allowMemberAnalysis": true,
        "agent.subagents.allowFullConfiguration": true,
        "agent.subagents.presets": "[]",
        "agent.responseLanguage": "auto",
        "agent.windows.shell": "auto",
        "agent.windows.gitBashPath": "",
        "agent.environmentRevision": 0,
        "agent.projectEnvironments": "{}",
        "agent.permissions.workspaceMutation": "plan",
        "agent.permissions.engineeringDecisions": "ask",
        "agent.permissions.shell": "ask",
        "agent.permissions.shellAccess": "workspace",
        "agent.permissions.commandRules": "[]",
        "agent.permissions.runtimeReadRoots": [],
        "agent.permissions.networkRead": "allow",
        "agent.permissions.external": "ask",
        "agent.permissions.commandDenylist": crate::command_denylist::DEFAULT_COMMANDS,
        "agent.web.search.endpointTemplate": "",
        "agent.web.search.authHeaderName": "Authorization",
        "agent.web.search.authSecretRef": "",
        "agent.documents.pythonPath": "",
        "skills.autoLoad": true,
        "skills.mounts": "[]",
        "mcp.autoLoad": false,
        "mcp.servers": "[]",
        "plugins.sources": "[]",
        "plugins.disabled": "[]",
        "gui.colorTheme": "light",
        "gui.accentColor": "blue",
        "gui.navigationDensity": "comfortable",
        "gui.showContextRail": true,
        "gui.usageWidget.enabled": true,
        "gui.usageWidget.visibility": "summary",
        "gui.usageWidget.currency": "USD",
        "gui.showReasoning": false
    })
}

pub(crate) fn validate_agent_runtime_settings(settings: &Value) -> Result<(), String> {
    if let Some(presets) = settings.get("agent.subagents.presets") {
        let valid = presets
            .as_str()
            .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok());
        if valid.as_ref().is_none_or(|value| !value.is_array()) {
            return Err("子代理预设必须是 JSON 数组。".into());
        }
    }
    for key in [
        "agent.subagents.enabled",
        "agent.subagents.allowMemberAnalysis",
        "agent.subagents.allowFullConfiguration",
    ] {
        if settings.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(format!("{key} 必须是布尔值。"));
        }
    }
    for key in [
        "agent.subagents.maxConcurrent",
        "agent.subagents.maxCallsPerRun",
        "agent.subagents.maxMembersPerSession",
    ] {
        if settings.get(key).is_some_and(|value| {
            value
                .as_u64()
                .is_none_or(|number| number == 0 || number > 9_007_199_254_740_991)
        }) {
            return Err(format!("{key} 必须是可精确表示的正整数。"));
        }
    }
    if settings
        .get("agent.subagents.profileId")
        .is_some_and(|value| {
            value.as_str().is_none_or(|id| {
                id.trim() != id || id.len() > 128 || id.chars().any(char::is_control)
            })
        })
    {
        return Err("agent.subagents.profileId 必须是有效模型 ID 或空字符串。".into());
    }
    if settings
        .get("agent.subagents.reasoningEffort")
        .is_some_and(|value| {
            !matches!(
                value.as_str(),
                Some("" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        })
    {
        return Err("子代理推理强度必须是 low、medium、high、xhigh、max 或空字符串。".into());
    }
    if settings
        .get("gui.usageWidget.currency")
        .is_some_and(|value| !matches!(value.as_str(), Some("USD" | "CNY")))
    {
        return Err("gui.usageWidget.currency 必须是 USD 或 CNY。".into());
    }
    if settings
        .get("agent.approvalReview.profileId")
        .is_some_and(|value| {
            value.as_str().is_none_or(|id| {
                id.trim() != id || id.len() > 128 || id.chars().any(char::is_control)
            })
        })
    {
        return Err("agent.approvalReview.profileId 必须是有效模型 ID 或空字符串。".into());
    }
    if settings
        .get("agent.approvalReview.reasoningEffort")
        .is_some_and(|value| {
            !matches!(
                value.as_str(),
                Some("" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        })
    {
        return Err("审批推理强度必须是 low、medium、high、xhigh、max 或空字符串。".into());
    }
    crate::local_agent_kernel::LocalAgentPermissionPolicy::from_settings(settings)
        .map_err(|error| error.message)?;
    if settings
        .get("agent.documents.pythonPath")
        .is_some_and(|value| !value.is_string())
    {
        return Err("agent.documents.pythonPath 必须是字符串。".into());
    }
    crate::session_environment::response_language_setting(settings)?;
    crate::session_environment::validate_settings(settings)?;
    if let Some(object) = settings.as_object() {
        for key in object
            .keys()
            .filter(|key| key.starts_with("agent.permissions."))
        {
            if !matches!(
                key.as_str(),
                "agent.permissions.workspaceMutation"
                    | "agent.permissions.engineeringDecisions"
                    | "agent.permissions.networkRead"
                    | "agent.permissions.external"
                    | "agent.permissions.commandDenylist"
                    | "agent.permissions.shell"
                    | "agent.permissions.shellAccess"
                    | "agent.permissions.commandRules"
                    | "agent.permissions.runtimeReadRoots"
            ) {
                return Err(format!("{key} 不是当前 Agent Runtime 权限设置。"));
            }
        }
    }
    if let Some(prompt) = settings.get("agent.systemPrompt") {
        let prompt = prompt
            .as_str()
            .ok_or_else(|| "agent.systemPrompt 必须是字符串。".to_string())?;
        if prompt.len() > 64 * 1024 {
            return Err("agent.systemPrompt 超过 65536 字节上限。".to_string());
        }
    }
    if let Some(value) = settings.get("agent.permissions.workspaceMutation") {
        if !matches!(value.as_str(), Some("plan" | "review" | "allow")) {
            return Err(
                "agent.permissions.workspaceMutation 必须是 plan、review 或 allow。".to_string(),
            );
        }
    }
    if let Some(value) = settings.get("agent.permissions.engineeringDecisions") {
        if !matches!(value.as_str(), Some("ask" | "delegate")) {
            return Err(
                "agent.permissions.engineeringDecisions 必须是 ask 或 delegate。".to_string(),
            );
        }
    }
    for key in [
        "agent.web.search.endpointTemplate",
        "agent.web.search.authHeaderName",
        "agent.web.search.authSecretRef",
    ] {
        if settings.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("{key} 必须是字符串。"));
        }
    }
    Ok(())
}

/// The persisted run receives the same permission defaults as Kernel admission.
pub(crate) fn permission_settings(settings: &Value) -> Value {
    let defaults = default_user_settings();
    Value::Object(
        defaults
            .as_object()
            .expect("settings defaults")
            .iter()
            .filter(|(key, _)| key.starts_with("agent.permissions."))
            .map(|(key, default)| (key.clone(), settings.get(key).unwrap_or(default).clone()))
            .collect(),
    )
}
