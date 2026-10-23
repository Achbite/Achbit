//! Per-user installation preparation, also used by the first normal Host startup.
//! Conflicting configuration is backed up before replacement; secrets and runtime
//! stores are never reset here. This does not repair unreadable or malformed JSON.
use crate::prelude::*;
use crate::{atomic_write_json, read_optional_json_file, ConfigRootLease, HostPaths};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationReport {
    directories: achbit_host_connection::UserDirectories,
    pub(crate) backup_directory: Option<PathBuf>,
    changes: Vec<ConfigChange>,
}

#[derive(Debug, Serialize)]
struct ConfigChange {
    file: PathBuf,
    reason: String,
}

pub(crate) fn prepare(
    directories: &achbit_host_connection::UserDirectories,
) -> Result<PreparationReport, String> {
    directories.create().map_err(|error| error.to_string())?;
    let paths = HostPaths::in_directories(directories);
    let _lease = ConfigRootLease::acquire(&paths.root_owner_lease_path)?;
    prepare_locked(&paths)
}

/// The caller must hold this configuration root's exclusive owner lease.
pub(crate) fn prepare_locked(paths: &HostPaths) -> Result<PreparationReport, String> {
    let mut replacements = Vec::new();
    if let Some(mut settings @ Value::Object(_)) = read_optional_json_file(&paths.settings_path)? {
        let defaults = crate::default_user_settings();
        let obsolete = settings
            .as_object()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with("agent.permissions.") && defaults.get(*key).is_none())
            .cloned()
            .collect::<Vec<_>>();
        if !obsolete.is_empty() {
            let reason = crate::validate_agent_runtime_settings(&settings).unwrap_err();
            let object = settings.as_object_mut().unwrap();
            for key in obsolete {
                object.remove(&key);
            }
            for (key, value) in defaults.as_object().unwrap() {
                if key.starts_with("agent.permissions.") {
                    object.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
            // Do not erase a different invalid setting to force startup to succeed.
            crate::validate_agent_runtime_settings(&settings)?;
            replacements.push((paths.settings_path.clone(), reason, settings));
        }
    }

    // The normal loader retains JSON/read errors and invalid default selections as
    // model availability errors. Only a readable document with a conflicting schema
    // is replaced. Keep the loader's existing connection separation semantics.
    if let Ok(Some(mut profiles)) = read_optional_json_file(&paths.llm_profiles_path) {
        if crate::model_connections::separate_connection_fields(
            &mut profiles,
            &paths.llm_secrets_path,
        )
        .is_ok()
        {
            if let Err(reason) = crate::llm_profiles::validate_profile_document(&profiles) {
                let defaults: Value =
                    serde_json::from_str(crate::llm_profiles::DEFAULT_PROFILES)
                        .map_err(|error| format!("内置 LLM 默认配置无法解析：{error}"))?;
                crate::validate_llm_profile_store(&defaults)?;
                replacements.push((paths.llm_profiles_path.clone(), reason, defaults));
            }
        }
    }

    let mut report = PreparationReport {
        directories: paths.directories.clone(),
        backup_directory: None,
        changes: Vec::new(),
    };
    if replacements.is_empty() {
        return Ok(report);
    }
    let backup = paths
        .directories
        .data_dir
        .join("config-backups")
        .join(crate::new_runtime_ref("config-cleanup")?.replace(':', "-"));
    fs::create_dir_all(&backup).map_err(|error| format!("create {}: {error}", backup.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect {}: {error}", backup.display()))?;
    }
    report.backup_directory = Some(backup.clone());
    // Complete both backups and record the original errors before any replacement.
    for (path, reason, _) in &replacements {
        let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
        let destination = backup.join(path.file_name().expect("configuration filename"));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&destination)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|error| format!("backup {}: {error}", destination.display()))?;
        report.changes.push(ConfigChange {
            file: path.clone(),
            reason: reason.clone(),
        });
    }
    atomic_write_json(
        &backup.join("original-errors.json"),
        &serde_json::to_value(&report).map_err(|e| e.to_string())?,
    )?;
    for (path, _, replacement) in replacements {
        atomic_write_json(&path, &replacement)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(
                std::env::temp_dir().join(
                    crate::new_runtime_ref("config-setup-test")
                        .unwrap()
                        .replace(':', "-"),
                ),
            )
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn startup_applies_omitted_defaults_and_preserves_explicit_settings() {
        let root = TestRoot::new();
        let paths = HostPaths::at(&root.0);
        let settings = json!({"agent.subagents.enabled":true,"agent.subagents.maxConcurrent":2});
        atomic_write_json(&paths.settings_path, &settings).unwrap();
        let original = fs::read(&paths.settings_path).unwrap();
        {
            let gui = crate::GuiState::open_at(&root.0).unwrap();
            assert_eq!(
                gui.user_settings["agent.subagents.allowFullConfiguration"],
                true
            );
            assert_eq!(gui.user_settings["agent.subagents.presets"], "[]");
            assert_eq!(gui.user_settings["agent.subagents.enabled"], true);
            assert_eq!(gui.user_settings["agent.subagents.maxConcurrent"], 2);
        }
        assert_eq!(fs::read(&paths.settings_path).unwrap(), original);
        atomic_write_json(
            &paths.settings_path,
            &json!({"agent.subagents.allowFullConfiguration":false}),
        )
        .unwrap();
        assert_eq!(
            crate::GuiState::open_at(&root.0).unwrap().user_settings
                ["agent.subagents.allowFullConfiguration"],
            false
        );
        atomic_write_json(
            &paths.settings_path,
            &json!({"agent.subagents.allowFullConfiguration":"invalid"}),
        )
        .unwrap();
        assert!(crate::GuiState::open_at(&root.0).is_err());
    }

    #[test]
    fn normal_startup_cleans_conflicts_once_and_preserves_user_data() {
        let root = TestRoot::new();
        let paths = HostPaths::at(&root.0);
        let settings = json!({"agent.permissions.autonomyMode":"strict", "agent.permissions.processExec":"deny",
            "agent.permissions.external":"deny", "gui.colorTheme":"dark", "locale.language":"zh-CN"});
        let profiles = json!({"storePath":"previous location", "defaultProfileId":"old-model", "profiles":[{
            "id":"old-model", "name":"Saved model", "kind":"responses", "model":"user-model", "enabled":true,
            "secretRef":"local-secret:user-key"
        }]});
        atomic_write_json(&paths.settings_path, &settings).unwrap();
        atomic_write_json(&paths.llm_profiles_path, &profiles).unwrap();
        atomic_write_json(
            &paths.llm_secrets_path,
            &json!({"user-key":"fixture-secret"}),
        )
        .unwrap();
        fs::create_dir_all(paths.session_store_path.parent().unwrap()).unwrap();
        fs::write(&paths.session_store_path, b"untouched session store").unwrap();
        let old_settings = fs::read(&paths.settings_path).unwrap();
        let old_profiles = fs::read(&paths.llm_profiles_path).unwrap();
        let old_secrets = fs::read(&paths.llm_secrets_path).unwrap();
        {
            let gui = crate::GuiState::open_at(&root.0).unwrap();
            assert!(gui
                .user_settings
                .get("agent.permissions.autonomyMode")
                .is_none());
            assert!(gui
                .user_settings
                .get("agent.permissions.processExec")
                .is_none());
            assert_eq!(gui.user_settings["agent.permissions.external"], "deny");
            assert_eq!(
                gui.user_settings["agent.permissions.workspaceMutation"],
                "plan"
            );
            assert_eq!(gui.user_settings["gui.colorTheme"], "dark");
            assert_eq!(gui.user_settings["locale.language"], "zh-CN");
            let defaults: Value =
                serde_json::from_str(crate::llm_profiles::DEFAULT_PROFILES).unwrap();
            assert_eq!(gui.llm_profiles.usable().unwrap(), &defaults);
            assert!(prepare(&paths.directories)
                .unwrap_err()
                .contains("config_root_already_owned"));
        }
        let backups = fs::read_dir(paths.directories.data_dir.join("config-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert!(!backups[0]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .contains(':'));
        assert_eq!(
            fs::read(backups[0].join("user-settings.json")).unwrap(),
            old_settings
        );
        assert_eq!(
            fs::read(backups[0].join("llm-profiles.json")).unwrap(),
            old_profiles
        );
        let errors = read_optional_json_file(&backups[0].join("original-errors.json"))
            .unwrap()
            .unwrap();
        assert!(errors["changes"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("agent.permissions.autonomyMode"));
        assert!(errors["changes"][1]["reason"]
            .as_str()
            .unwrap()
            .contains("connections"));
        let prepared_settings = fs::read(&paths.settings_path).unwrap();
        let prepared_profiles = fs::read(&paths.llm_profiles_path).unwrap();
        assert!(prepare(&paths.directories).unwrap().changes.is_empty());
        assert_eq!(fs::read(&paths.settings_path).unwrap(), prepared_settings);
        assert_eq!(
            fs::read(&paths.llm_profiles_path).unwrap(),
            prepared_profiles
        );
        assert_eq!(
            fs::read_dir(paths.directories.data_dir.join("config-backups"))
                .unwrap()
                .count(),
            1
        );
        assert_eq!(fs::read(&paths.llm_secrets_path).unwrap(), old_secrets);
        assert_eq!(
            fs::read(&paths.session_store_path).unwrap(),
            b"untouched session store"
        );
    }

    #[test]
    fn installer_preparation_resets_missing_profile_fields_but_preserves_valid_settings() {
        let root = TestRoot::new();
        let paths = HostPaths::at(&root.0);
        let settings = crate::default_user_settings();
        atomic_write_json(&paths.settings_path, &settings).unwrap();
        let settings_bytes = fs::read(&paths.settings_path).unwrap();
        let mut profiles: Value =
            serde_json::from_str(crate::llm_profiles::DEFAULT_PROFILES).unwrap();
        profiles["profiles"][0]
            .as_object_mut()
            .unwrap()
            .remove("providerFlavor");
        atomic_write_json(&paths.llm_profiles_path, &profiles).unwrap();
        let report = prepare(&paths.directories).unwrap();
        assert_eq!(report.changes.len(), 1);
        assert!(report.changes[0].reason.contains("providerFlavor"));
        assert_eq!(fs::read(&paths.settings_path).unwrap(), settings_bytes);
        assert!(!paths.llm_secrets_path.exists());
        assert!(crate::GuiState::open_at(&root.0)
            .unwrap()
            .llm_profiles
            .usable()
            .is_ok());
    }
}
