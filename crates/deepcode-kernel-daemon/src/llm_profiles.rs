use crate::prelude::*;
use crate::read_optional_json_file;
use std::collections::HashSet;

pub(crate) const DEFAULT_PROFILES: &str =
    include_str!("../../../config/defaults/llm-profiles.json");

#[derive(Debug)]
pub(crate) enum LlmProfileStore {
    Ready(Value),
    InvalidDefault { value: Value, message: String },
    Unavailable(String),
}

impl LlmProfileStore {
    pub(crate) fn load_with_secrets(path: &FsPath, secrets_path: &FsPath) -> Self {
        let mut value = match read_optional_json_file(path) {
            Ok(Some(value)) => value,
            Ok(None) => match serde_json::from_str(DEFAULT_PROFILES) {
                Ok(value) => value,
                Err(error) => {
                    return Self::Unavailable(format!("内置 LLM 默认配置无法解析：{error}"))
                }
            },
            Err(error) => return Self::Unavailable(error),
        };
        if let Err(error) =
            crate::model_connections::separate_connection_fields(&mut value, secrets_path)
                .and_then(|()| validate_profile_document(&value))
        {
            return Self::Unavailable(format!("{}: {error}", path.display()));
        }
        match validate_default_profile(&value) {
            Ok(()) => Self::Ready(value),
            Err(error) => Self::InvalidDefault {
                value,
                message: format!("{}: {error}", path.display()),
            },
        }
    }

    pub(crate) fn usable(&self) -> Result<&Value, String> {
        match self {
            Self::Ready(value) => Ok(value),
            Self::InvalidDefault { message, .. } | Self::Unavailable(message) => {
                Err(message.clone())
            }
        }
    }

    pub(crate) fn select_default(
        &mut self,
        path: &PathBuf,
        profile_id: &str,
    ) -> Result<(), String> {
        let current = match self {
            Self::Ready(value) | Self::InvalidDefault { value, .. } => value,
            Self::Unavailable(error) => return Err(error.clone()),
        };
        if !current["profiles"]
            .as_array()
            .expect("validated profile list")
            .iter()
            .any(|profile| {
                profile["id"].as_str() == Some(profile_id)
                    && profile["enabled"].as_bool() == Some(true)
            })
        {
            return Err(format!("模型 Profile 不存在或未启用：{profile_id}"));
        }
        if current["defaultProfileId"].as_str() == Some(profile_id) {
            return Ok(());
        }
        let mut next = current.clone();
        next["defaultProfileId"] = json!(profile_id);
        crate::atomic_write_json(path, &next)?;
        *self = Self::Ready(next);
        Ok(())
    }

    pub(crate) fn settings_response(&self, path: &FsPath) -> Json<crate::ApiResponse> {
        let with_path = |value: &Value| {
            let mut value = value.clone();
            value["storePath"] = json!(path.to_string_lossy());
            value
        };
        match self {
            Self::Ready(value) => crate::ApiResponse::ok(with_path(value)),
            Self::InvalidDefault { value, message } => crate::ApiResponse::error_with_data(
                "invalid_llm_profile_store_schema",
                message,
                with_path(value),
            ),
            Self::Unavailable(message) => {
                crate::ApiResponse::error("invalid_llm_profile_store_schema", message)
            }
        }
    }
}

pub(crate) fn local_secret_ref_key(secret_ref: &str) -> Option<&str> {
    if secret_ref.trim() != secret_ref {
        return None;
    }
    let key = secret_ref.strip_prefix("local-secret:")?;
    (!key.is_empty() && key.trim() == key).then_some(key)
}

pub(crate) fn llm_profile_value_is_enabled(profile: &Value) -> bool {
    validate_llm_profile(profile).is_ok()
        && profile.get("enabled").and_then(Value::as_bool) == Some(true)
}

pub(crate) fn validate_llm_profile(profile: &Value) -> Result<(), String> {
    const FIELDS: &[&str] = &[
        "id",
        "name",
        "connectionId",
        "kind",
        "providerFlavor",
        "model",
        "contextWindowTokens",
        "maxOutputTokens",
        "temperature",
        "reasoningEffort",
        "thinking",
        "hostedWebSearch",
        "enabled",
        "imageInput",
    ];
    let profile = profile.as_object().ok_or("Profile 必须是 JSON 对象。")?;
    if let Some(field) = profile
        .keys()
        .find(|field| !FIELDS.contains(&field.as_str()))
    {
        return Err(format!("未知字段 {field}。"));
    }
    let text = |field: &str| {
        profile
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
    };
    for field in ["id", "name", "model", "connectionId"] {
        if !text(field) {
            return Err(format!("{field} 必须是无首尾空白的非空字符串。"));
        }
    }
    if !profile.get("enabled").is_some_and(Value::is_boolean) {
        return Err("enabled 必须是布尔值。".into());
    }
    if profile
        .get("imageInput")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("imageInput 必须是布尔值。".into());
    }
    if !matches!(
        profile.get("kind").and_then(Value::as_str),
        Some("openaiCompatible" | "responses" | "anthropic" | "ollama")
    ) {
        return Err("kind 必须是 openaiCompatible、responses、anthropic 或 ollama。".into());
    }
    if !matches!(
        profile.get("providerFlavor").and_then(Value::as_str),
        Some("openai" | "deepseek" | "zhipu" | "moonshot")
    ) {
        return Err("providerFlavor 必须是 openai、deepseek、zhipu 或 moonshot。".into());
    }
    for field in ["contextWindowTokens", "maxOutputTokens"] {
        if profile.get(field).is_some_and(|value| {
            !value
                .as_u64()
                .is_some_and(|number| number > 0 && number <= 1_000_000_000)
        }) {
            return Err(format!("{field} 必须是 1 到 1000000000 之间的整数。"));
        }
    }
    if profile
        .get("temperature")
        .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
    {
        return Err("temperature 必须是有限数值。".into());
    }
    if profile.get("reasoningEffort").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some("low" | "medium" | "high" | "xhigh" | "max")
        )
    }) {
        return Err("reasoningEffort 必须是 low、medium、high、xhigh 或 max。".into());
    }
    if profile
        .get("thinking")
        .is_some_and(|value| !matches!(value.as_str(), Some("enabled" | "disabled")))
    {
        return Err("thinking 必须是 enabled 或 disabled。".into());
    }
    if profile.get("hostedWebSearch").is_some_and(|value| {
        value.as_str() != Some("web_search")
            || profile.get("kind").and_then(Value::as_str) != Some("responses")
    }) {
        return Err("hostedWebSearch 仅支持 responses Profile 的 web_search。".into());
    }
    if let (Some(context), Some(output)) = (
        profile.get("contextWindowTokens").and_then(Value::as_u64),
        profile.get("maxOutputTokens").and_then(Value::as_u64),
    ) {
        if output >= context {
            return Err("maxOutputTokens 必须小于 contextWindowTokens。".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_profile_document(config: &Value) -> Result<(), String> {
    let config = config
        .as_object()
        .ok_or("LLM Profile 文件必须是 JSON 对象。")?;
    if config.len() != 3
        || config.keys().any(|field| {
            !matches!(
                field.as_str(),
                "profiles" | "defaultProfileId" | "connections"
            )
        })
    {
        return Err("LLM 配置必须包含 profiles、connections 和 defaultProfileId。".into());
    }
    let profiles = config
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or("profiles 必须是数组。")?;
    let connections: Vec<crate::model_connections::ModelConnection> = serde_json::from_value(
        config
            .get("connections")
            .cloned()
            .ok_or("connections 必須存在。")?,
    )
    .map_err(|error| error.to_string())?;
    let mut connection_ids = HashSet::new();
    for connection in &connections {
        connection.validate()?;
        if !connection_ids.insert(connection.id.as_str()) {
            return Err("连接 ID 重复。".into());
        }
    }
    let mut ids = HashSet::with_capacity(profiles.len());
    for (index, profile) in profiles.iter().enumerate() {
        validate_llm_profile(profile).map_err(|error| format!("profiles[{index}].{error}"))?;
        if !connection_ids.contains(profile["connectionId"].as_str().unwrap()) {
            return Err(format!("profiles[{index}] 引用的连接不存在。"));
        }
        let id = profile["id"].as_str().expect("validated profile id");
        if !ids.insert(id) {
            return Err(format!("profiles[{index}].id 重复：{id}"));
        }
    }
    if !matches!(config.get("defaultProfileId"), Some(Value::Null))
        && !config
            .get("defaultProfileId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.trim() == id)
    {
        return Err("defaultProfileId 必须是无首尾空白的非空字符串或 null。".into());
    }
    Ok(())
}

fn validate_default_profile(config: &Value) -> Result<(), String> {
    if let Some(id) = config["defaultProfileId"].as_str() {
        if !config["profiles"]
            .as_array()
            .expect("validated profile list")
            .iter()
            .any(|profile| profile["id"].as_str() == Some(id))
        {
            return Err(format!("defaultProfileId 指向不存在的 Profile：{id}"));
        }
    }
    Ok(())
}

pub(crate) fn validate_llm_profile_store(config: &Value) -> Result<(), String> {
    validate_profile_document(config)?;
    validate_default_profile(config)
}

/// Expand an explicit per-model edit against the current store, preserving other models.
pub(crate) fn expand_profile_edit(store: &LlmProfileStore, body: Value) -> Result<Value, String> {
    let operations = ["profiles", "profile", "removeProfileId"]
        .iter()
        .filter(|field| body.get(**field).is_some())
        .count();
    if operations != 1 {
        return Err("每次只能更新模型列表、保存一个模型或移除一个模型。".into());
    }
    if body.get("profiles").is_some() {
        return Ok(body);
    }
    let current = match store {
        LlmProfileStore::Ready(value) | LlmProfileStore::InvalidDefault { value, .. } => {
            Some(value)
        }
        LlmProfileStore::Unavailable(_) => None,
    };
    let mut profiles = current
        .and_then(|value| value["profiles"].as_array())
        .cloned()
        .unwrap_or_default();
    if let Some(profile) = body.get("profile") {
        validate_llm_profile(profile)?;
        if let Some(existing) = profiles.iter_mut().find(|item| item["id"] == profile["id"]) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
    } else {
        let id = body["removeProfileId"]
            .as_str()
            .ok_or("removeProfileId 必须是模型 ID。")?;
        let Some(index) = profiles
            .iter()
            .position(|profile| profile["id"].as_str() == Some(id))
        else {
            return Err(format!("模型 Profile 不存在：{id}"));
        };
        profiles.remove(index);
    }
    let mut default = body
        .get("defaultProfileId")
        .cloned()
        .or_else(|| current.map(|value| value["defaultProfileId"].clone()))
        .unwrap_or_else(|| {
            if body["profile"]["enabled"].as_bool() == Some(true) {
                body["profile"]["id"].clone()
            } else {
                Value::Null
            }
        });
    if body.get("removeProfileId").is_some_and(|id| id == &default) {
        default = Value::Null;
    }
    let expanded = json!({"profiles": profiles, "defaultProfileId": default});
    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ConfigRoot(PathBuf);

    impl ConfigRoot {
        fn new() -> Self {
            let mut entropy = [0_u8; 8];
            getrandom::fill(&mut entropy).unwrap();
            let path = std::env::temp_dir().join(format!(
                "deepcode-llm-config-{:016x}",
                u64::from_ne_bytes(entropy)
            ));
            fs::create_dir_all(path.join("config/user/local/settings")).unwrap();
            Self(path)
        }

        fn profile_path(&self) -> PathBuf {
            self.0.join("config/user/local/settings/llm-profiles.json")
        }
    }

    impl Drop for ConfigRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn last_selected_model_is_persisted_without_changing_profile_contents() {
        let root = ConfigRoot::new();
        let profiles = json!([
            {"id":"my-model-b", "name":"B", "kind":"responses", "providerFlavor":"openai", "model":"b-model", "enabled":true, "connectionId":"connection:shared"},
            {"id":"custom-c", "name":"C", "kind":"anthropic", "providerFlavor":"openai", "model":"c-model", "enabled":true, "connectionId":"connection:shared"}
        ]);
        let original = json!({"profiles":profiles, "defaultProfileId":"my-model-b", "connections":[{
            "id":"connection:shared","name":"API","adapterId":"custom","billingMode":"metered","baseUrl":"https://example.test","credentialKind":"apiKey"
        }]});
        fs::write(root.profile_path(), serde_json::to_vec(&original).unwrap()).unwrap();
        for id in ["custom-c", "my-model-b"] {
            let mut store = LlmProfileStore::load_with_secrets(
                &root.profile_path(),
                &root.0.join("secrets.json"),
            );
            store.select_default(&root.profile_path(), id).unwrap();
            let reloaded = LlmProfileStore::load_with_secrets(
                &root.profile_path(),
                &root.0.join("secrets.json"),
            );
            assert_eq!(reloaded.usable().unwrap()["defaultProfileId"], id);
            assert_eq!(reloaded.usable().unwrap()["profiles"], profiles);
        }
        let before = fs::read(root.profile_path()).unwrap();
        let mut store =
            LlmProfileStore::load_with_secrets(&root.profile_path(), &root.0.join("secrets.json"));
        assert!(store
            .select_default(&root.profile_path(), "unknown")
            .is_err());
        assert_eq!(fs::read(root.profile_path()).unwrap(), before);
    }

    #[test]
    fn saving_one_model_preserves_other_models_and_the_saved_default() {
        let a = json!({"id":"user-a", "name":"A", "kind":"responses", "providerFlavor":"openai", "model":"a", "enabled":true, "connectionId":"connection:a"});
        let b = json!({"id":"user-b", "name":"B", "kind":"anthropic", "providerFlavor":"openai", "model":"b", "enabled":true, "connectionId":"connection:b"});
        let original = json!({"profiles":[a,b], "defaultProfileId":"user-b"});
        let store = LlmProfileStore::Ready(original.clone());
        let mut edited = a.clone();
        edited["name"] = json!("Saved A");
        let expanded = expand_profile_edit(&store, json!({"profile":edited})).unwrap();
        assert_eq!(expanded["profiles"], json!([edited, b]));
        assert_eq!(expanded["defaultProfileId"], "user-b");
        assert_eq!(store.usable().unwrap(), &original);
        assert!(expand_profile_edit(&store, json!({"removeProfileId":"missing"})).is_err());
        let removed = expand_profile_edit(&store, json!({"removeProfileId":"user-a"})).unwrap();
        assert_eq!(
            removed,
            json!({"profiles":[b], "defaultProfileId":"user-b"})
        );
        let removed_default =
            expand_profile_edit(&store, json!({"removeProfileId":"user-b"})).unwrap();
        assert!(removed_default["defaultProfileId"].is_null());
        assert_eq!(removed_default["profiles"], json!([a]));
    }

    #[test]
    fn packaged_defaults_are_valid_and_are_the_missing_file_defaults() {
        let root = ConfigRoot::new();
        let defaults: Value = serde_json::from_str(DEFAULT_PROFILES).unwrap();
        validate_llm_profile_store(&defaults).unwrap();
        let id = defaults["defaultProfileId"].as_str().unwrap();
        assert!(defaults["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|profile| {
                profile["id"].as_str() == Some(id) && llm_profile_value_is_enabled(profile)
            }));
        let gui = crate::GuiState::open_at(&root.0).unwrap();
        assert_eq!(gui.llm_profiles.usable().unwrap(), &defaults);
        assert!(!root.profile_path().exists());
        let mut invalid = defaults;
        invalid["profiles"][0]["maxOutputTokens"] = json!("invalid");
        assert!(validate_llm_profile_store(&invalid)
            .unwrap_err()
            .contains("profiles[0].maxOutputTokens"));
        let mut missing_flavor: Value = serde_json::from_str(DEFAULT_PROFILES).unwrap();
        missing_flavor["profiles"][0]
            .as_object_mut()
            .unwrap()
            .remove("providerFlavor");
        assert!(validate_llm_profile_store(&missing_flavor)
            .unwrap_err()
            .contains("profiles[0].providerFlavor"));
    }

    #[test]
    fn invalid_default_keeps_history_and_editable_profiles_but_blocks_model_use() {
        let root = ConfigRoot::new();
        {
            let mut gui = crate::GuiState::open_at(&root.0).unwrap();
            gui.conversation_catalog
                .write_rows(
                    &gui.paths.catalog_store_path,
                    vec![],
                    None,
                    Some(crate::conversation_catalog::ConversationSessionRecord {
                        id: "session:existing".into(),
                        title: "Existing conversation".into(),
                        title_source: Some(
                            crate::conversation_catalog::ConversationTitleSource::Initial,
                        ),
                        workspace_bindings: vec![],
                        project_id: None,
                        profile_id: None,
                        created_at: "2026-09-14T00:00:00Z".into(),
                        updated_at: "2026-09-14T00:00:00Z".into(),
                    }),
                )
                .unwrap();
        }
        let mut config: Value = serde_json::from_str(DEFAULT_PROFILES).unwrap();
        config["defaultProfileId"] = json!("profile:missing");
        let original = serde_json::to_string(&config).unwrap();
        fs::write(root.profile_path(), &original).unwrap();
        let gui = crate::GuiState::open_at(&root.0).unwrap();
        assert!(gui.conversation_catalog_error.is_none());
        assert_eq!(gui.conversation_catalog.sessions[0].id, "session:existing");
        let error = gui.llm_profiles.usable().unwrap_err();
        assert!(error.contains("defaultProfileId"));
        assert!(error.contains("profile:missing"));
        assert!(error.contains(root.profile_path().to_str().unwrap()));
        assert_eq!(crate::resolve_llm_profile(&gui, None).unwrap_err(), error);
        assert_eq!(
            crate::resolve_llm_profile(&gui, config["profiles"][0]["id"].as_str()).unwrap_err(),
            error
        );
        let response = gui
            .llm_profiles
            .settings_response(&gui.paths.llm_profiles_path)
            .0;
        assert!(!response.ok);
        let mut editable = response.data.unwrap();
        editable.as_object_mut().unwrap().remove("storePath");
        assert_eq!(editable, config);
        assert_eq!(fs::read_to_string(root.profile_path()).unwrap(), original);
    }

    #[test]
    fn unreadable_profile_json_does_not_block_host_or_create_replacement_data() {
        let root = ConfigRoot::new();
        let original = "{\"profiles\":[";
        fs::write(root.profile_path(), original).unwrap();
        let gui = crate::GuiState::open_at(&root.0).unwrap();
        let error = gui.llm_profiles.usable().unwrap_err();
        assert!(error.contains("parse "));
        assert!(error.contains(root.profile_path().to_str().unwrap()));
        assert_eq!(crate::resolve_llm_profile(&gui, None).unwrap_err(), error);
        let response = gui
            .llm_profiles
            .settings_response(&gui.paths.llm_profiles_path)
            .0;
        assert!(!response.ok);
        assert!(response.data.is_none());
        assert_eq!(response.message.as_deref(), Some(error.as_str()));
        assert_eq!(fs::read_to_string(root.profile_path()).unwrap(), original);
    }
}
