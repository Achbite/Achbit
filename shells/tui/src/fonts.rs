use crate::i18n::Language;
use serde_json::Value;

/// Native window adapters resolve legal omissions using the same protocol defaults
/// as the GUI. Do not copy those defaults or persist a second TUI preference.
pub fn settings_for_window(data: &Value) -> Result<Value, String> {
    let settings = data
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| "user_settings response has no settings object".to_string())?;
    Ok(Value::Object(
        [
            "gui.fontFamily",
            "gui.terminalFontFamily",
            "gui.codeFontSize",
        ]
        .into_iter()
        .filter_map(|key| settings.get(key).map(|value| (key.into(), value.clone())))
        .collect(),
    ))
}

pub fn validate_choice(choice: &str, language: Language) -> Result<(), String> {
    if !matches!(
        choice,
        "follow" | "warm" | "warm-sans" | "compact-kai" | "compact" | "system"
    ) {
        return Err(language.format("tui.font.invalid", &[choice.into()]));
    }
    Ok(())
}

pub async fn apply(
    choice: &str,
    language: Language,
    _client: &deepcode_kernel_client::HttpKernelClient,
) -> Result<(), String> {
    validate_choice(choice, language)?;
    let owned = cfg!(target_os = "macos") && std::env::var_os("DEEPCODE_TUI_WINDOW_TTY").is_some();
    #[cfg(windows)]
    let owned = owned || crate::windows_terminal::is_owned();
    if !owned {
        return Err(language.text("tui.font.requiresWindow").into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let resources = deepcode_host_connection::runtime_root(
        executable
            .parent()
            .ok_or("TUI executable directory unavailable")?,
    )
    .map_err(|error| error.to_string())?;
    let choice = choice.to_string();
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let settings = settings_for_window(
            &_client
                .user_settings()
                .await
                .map_err(|error| error.to_string())?,
        )?;
        return tokio::task::spawn_blocking(move || {
            let mut child = Command::new(resources.join("node/bin/node.exe"))
                .arg(resources.join("tui/font-config.mjs"))
                .arg(choice)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| error.to_string())?;
            let write = child
                .stdin
                .take()
                .ok_or("Font helper input unavailable")?
                .write_all(settings.to_string().as_bytes());
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            write.map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            let font: Value =
                serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
            crate::windows_terminal::apply(&font)
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new(resources.join("node/bin/node"))
            .arg(resources.join("tui/window.mjs"))
            .args(["--apply-font", &choice])
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_settings_preserve_group_selection_and_legal_omissions() {
        assert_eq!(
            settings_for_window(&serde_json::json!({"settings": {
                "gui.fontFamily": "warm-sans", "gui.terminalFontFamily": "compact-kai",
                "gui.codeFontSize": 12, "workbench.language": "zh-CN"
            }}))
            .unwrap(),
            serde_json::json!({
                "gui.fontFamily": "warm-sans", "gui.terminalFontFamily": "compact-kai", "gui.codeFontSize": 12
            })
        );
        assert_eq!(
            settings_for_window(&serde_json::json!({"settings": {}})).unwrap(),
            serde_json::json!({})
        );
        assert!(settings_for_window(&serde_json::json!({})).is_err());
    }

    #[tokio::test]
    async fn unsupported_font_names_do_not_invoke_terminal_automation() {
        assert!(validate_choice("not-a-builtin", Language::EnUs)
            .unwrap_err()
            .contains("not-a-builtin"));
        if !cfg!(any(target_os = "macos", windows)) {
            let client = deepcode_kernel_client::HttpKernelClient::new(
                deepcode_kernel_client::KernelClientConfig::new("http://127.0.0.1:1")
                    .with_host_shell_token(format!("dchost_{}", "00".repeat(32))),
            )
            .unwrap();
            assert_eq!(
                apply("compact", Language::EnUs, &client).await.unwrap_err(),
                Language::EnUs.text("tui.font.requiresWindow")
            );
        }
    }
}
