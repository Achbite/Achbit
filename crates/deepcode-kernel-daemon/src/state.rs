use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) local_agent: crate::local_agent_api::LocalAgentRuntime,
    pub(crate) session_service: crate::session_service::SessionServiceProcess,
    pub(crate) host_connection: crate::host_connection::HostConnection,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) host_services: HostServices,
    pub(crate) model_usage: Arc<crate::model_usage::UsageStore>,
    pub(crate) model_auth: Arc<crate::model_auth::AuthService>,
}

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) directories: deepcode_host_connection::UserDirectories,
    pub(crate) temporary_root: PathBuf,
    pub(crate) root_owner_lease_path: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) usage_store_path: PathBuf,
    pub(crate) catalog_store_path: PathBuf,
    pub(crate) session_store_path: PathBuf,
    pub(crate) tool_record_store_path: PathBuf,
    pub(crate) attachment_store_root: PathBuf,
    pub(crate) session_workdir_root: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    _config_root_lease: ConfigRootLease,
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: LlmProfileStore,
    pub(crate) conversation_catalog: crate::conversation_catalog::ConversationCatalog,
    pub(crate) conversation_catalog_error: Option<String>,
}

impl GuiState {
    #[cfg(test)]
    pub(crate) fn open_at(root: &FsPath) -> Result<Self, String> {
        Self::open_in(&deepcode_host_connection::UserDirectories::isolated(root))
    }

    pub(crate) fn open_in(
        directories: &deepcode_host_connection::UserDirectories,
    ) -> Result<Self, String> {
        directories.create().map_err(|error| error.to_string())?;
        let paths = HostPaths::in_directories(directories);
        let config_root_lease = ConfigRootLease::acquire(&paths.root_owner_lease_path)?;
        let preparation = crate::config_setup::prepare_locked(&paths)?;
        if let Some(backup) = preparation.backup_directory {
            eprintln!(
                "DeepCode 已清理冲突配置；原始文件及错误备份：{}",
                backup.display()
            );
        }
        let user_settings = match read_optional_json_file(&paths.settings_path)? {
            Some(value @ Value::Object(_)) => {
                validate_agent_runtime_settings(&value)?;
                let mut effective = default_user_settings();
                merge_object(&mut effective, &value);
                effective
            }
            Some(_) => return Err("本地用户设置文件必须是 JSON 对象。".to_string()),
            None => default_user_settings(),
        };
        let llm_profiles =
            LlmProfileStore::load_with_secrets(&paths.llm_profiles_path, &paths.llm_secrets_path);
        let (conversation_catalog, conversation_catalog_error) =
            match crate::conversation_catalog::ConversationCatalog::load(&paths.catalog_store_path)
            {
                Ok(catalog) => (catalog, None),
                Err(error) => (
                    crate::conversation_catalog::ConversationCatalog::default(),
                    Some(error),
                ),
            };
        Ok(Self {
            _config_root_lease: config_root_lease,
            paths,
            user_settings,
            llm_profiles,
            conversation_catalog,
            conversation_catalog_error,
        })
    }
}

impl HostPaths {
    #[cfg(test)]
    pub(crate) fn at(root: &FsPath) -> Self {
        Self::in_directories(&deepcode_host_connection::UserDirectories::isolated(root))
    }

    pub(crate) fn in_directories(directories: &deepcode_host_connection::UserDirectories) -> Self {
        let settings_dir = directories.config_dir.join("user/local/settings");
        let secrets_dir = directories.config_dir.join("user/local/secrets");
        let runtime_root = directories.data_dir.join("agent-runtime");
        Self {
            directories: directories.clone(),
            temporary_root: directories.temp_dir.clone(),
            root_owner_lease_path: runtime_root.join("root-owner.lock"),
            settings_path: settings_dir.join("user-settings.json"),
            llm_profiles_path: settings_dir.join("llm-profiles.json"),
            llm_secrets_path: secrets_dir.join("llm-secrets.json"),
            usage_store_path: runtime_root.join("provider-usage.sqlite3"),
            catalog_store_path: runtime_root.join("catalog.sqlite3"),
            session_store_path: runtime_root.join("session.sqlite3"),
            tool_record_store_path: runtime_root.join("tool-record.sqlite3"),
            attachment_store_root: runtime_root.join("attachments"),
            session_workdir_root: runtime_root.join("session-workdirs"),
        }
    }
}
