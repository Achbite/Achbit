use crate::i18n::Language;
use serde_json::Value;

/// The macOS launcher resolves legal omissions using the same protocol defaults
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

pub async fn apply(choice: &str, language: Language) -> Result<(), String> {
    if !matches!(
        choice,
        "follow" | "warm" | "warm-sans" | "compact-kai" | "compact" | "system"
    ) {
        return Err(language.format("tui.font.invalid", &[choice.into()]));
    }
    if !cfg!(target_os = "macos") || std::env::var_os("DEEPCODE_TUI_WINDOW_TTY").is_none() {
        return Err(language.text("tui.font.requiresWindow").into());
    }
    let resources = std::env::var_os("DEEPCODE_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| language.text("tui.font.requiresWindow").to_string())?;
    let choice = choice.to_string();
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
        assert!(apply("not-a-builtin", Language::EnUs)
            .await
            .unwrap_err()
            .contains("not-a-builtin"));
        if !cfg!(target_os = "macos") {
            assert_eq!(
                apply("compact", Language::EnUs).await.unwrap_err(),
                Language::EnUs.text("tui.font.requiresWindow")
            );
        }
    }
}
