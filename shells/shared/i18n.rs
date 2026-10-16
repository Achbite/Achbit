//! Shell display strings share the same embedded language packs as the GUI.
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    ZhCn,
    EnUs,
}

impl Language {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "zh-CN" => Some(Self::ZhCn),
            "en-US" => Some(Self::EnUs),
            _ => None,
        }
    }

    pub fn from_settings(data: &Value) -> Result<Self, String> {
        let value = data
            .get("settings")
            .and_then(|settings| settings.get("workbench.language"))
            .and_then(Value::as_str)
            .ok_or_else(|| Self::default().text("tui.languageMissing").to_string())?;
        Self::parse(value)
            .ok_or_else(|| Self::default().format("tui.languageInvalid", &[value.to_string()]))
    }

    fn messages(self) -> &'static serde_json::Map<String, Value> {
        static ZH: OnceLock<Value> = OnceLock::new();
        static EN: OnceLock<Value> = OnceLock::new();
        let (cache, source) = match self {
            Self::ZhCn => (&ZH, include_str!("../../config/i18n/zh-CN.json")),
            Self::EnUs => (&EN, include_str!("../../config/i18n/en-US.json")),
        };
        cache
            .get_or_init(|| serde_json::from_str(source).expect("valid embedded language pack"))
            .get("messages")
            .and_then(Value::as_object)
            .expect("embedded language pack messages")
    }

    pub fn text(self, key: &str) -> &'static str {
        self.messages()
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("missing embedded translation: {self:?} {key}"))
    }

    /// Substitute the template once; braces inside user text remain untouched.
    pub fn format(self, key: &str, values: &[String]) -> String {
        let mut remaining = self.text(key);
        let mut output = String::new();
        while let Some(start) = remaining.find('{') {
            output.push_str(&remaining[..start]);
            let end = remaining[start..]
                .find('}')
                .expect("closed translation placeholder")
                + start;
            let index: usize = remaining[start + 1..end]
                .parse()
                .expect("numbered translation placeholder");
            output.push_str(values.get(index).expect("translation argument"));
            remaining = &remaining[end + 1..];
        }
        output.push_str(remaining);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn tui_packs_have_matching_keys_and_placeholders() {
        let keys = |language: Language| {
            language
                .messages()
                .keys()
                .filter(|key| key.starts_with("tui."))
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(keys(Language::ZhCn), keys(Language::EnUs));
        let placeholders = |text: &str| {
            text.split('{')
                .skip(1)
                .map(|part| {
                    part.split_once('}')
                        .expect("closed placeholder")
                        .0
                        .to_string()
                })
                .collect::<BTreeSet<_>>()
        };
        for key in keys(Language::ZhCn) {
            let expected = placeholders(Language::ZhCn.text(&key));
            assert_eq!(expected, placeholders(Language::EnUs.text(&key)), "{key}");
            let values: Vec<_> = (0..expected.len())
                .map(|index| format!("value{index}"))
                .collect();
            for language in [Language::ZhCn, Language::EnUs] {
                let rendered = language.format(&key, &values);
                assert!(!rendered.contains('{'), "{key}: {rendered}");
            }
        }
        for source in [
            include_str!("../tui/src/main.rs"),
            include_str!("../tui/src/app.rs"),
            include_str!("../tui/src/renderer.rs"),
            include_str!("../tui/src/fonts.rs"),
            include_str!("conversation_input.rs"),
        ] {
            for part in source.split("\"tui.").skip(1) {
                let key = format!("tui.{}", part.split('"').next().unwrap());
                for language in [Language::ZhCn, Language::EnUs] {
                    assert!(!language.text(&key).is_empty(), "{key}");
                }
            }
        }
    }

    #[test]
    fn settings_language_is_explicit_and_invalid_settings_are_not_defaulted() {
        for (value, expected) in [("zh-CN", Language::ZhCn), ("en-US", Language::EnUs)] {
            assert_eq!(
                Language::from_settings(
                    &serde_json::json!({"settings":{"workbench.language":value}})
                ),
                Ok(expected)
            );
        }
        for settings in [
            serde_json::json!({}),
            serde_json::json!({"settings":{"workbench.language":null}}),
            serde_json::json!({"settings":{"workbench.language":"fr-FR"}}),
        ] {
            assert!(Language::from_settings(&settings).is_err());
        }
    }

    #[test]
    fn interpolation_preserves_original_error_and_user_braces() {
        let original = "原始错误: {0} {path} provider_transport_failed";
        for language in [Language::ZhCn, Language::EnUs] {
            let message = language.format("tui.resourceReadFailed", &[original.to_string()]);
            assert!(message.ends_with(original), "{message}");
        }
    }
}
