use crate::i18n::Language;
use deepcode_kernel_client::{
    is_terminal_run_status, ConversationCatalog, ConversationSessionSummary, SessionProjection,
};

pub fn ordered_sessions(mut catalog: ConversationCatalog) -> Vec<ConversationSessionSummary> {
    catalog.sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    catalog.sessions
}

// Numbers refer only to the last displayed snapshot, never to a freshly reordered catalog.
pub fn resolve_selector(
    language: Language,
    selector: &str,
    sessions: Option<&[ConversationSessionSummary]>,
) -> Result<String, String> {
    if selector.starts_with("session:")
        && selector.len() > "session:".len()
        && !selector
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Ok(selector.into());
    }
    if let Ok(number) = selector.parse::<usize>() {
        let sessions =
            sessions.ok_or_else(|| language.text("tui.sessionsListFirst").to_string())?;
        if let Some(session) = number.checked_sub(1).and_then(|index| sessions.get(index)) {
            return Ok(session.id.clone());
        }
    }
    Err(language.format("tui.sessionSelectionInvalid", &[selector.to_string()]))
}

pub fn session_label(
    number: usize,
    session: &ConversationSessionSummary,
    current: Option<&str>,
) -> String {
    let title = session
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let directories = session
        .workspace_bindings
        .iter()
        .map(|binding| {
            binding
                .display_name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{} {number}. {title} · {} · {} · {directories}",
        if current == Some(session.id.as_str()) {
            "*"
        } else {
            " "
        },
        session.id,
        session.updated_at
    )
}

pub fn background_notice(
    language: Language,
    projection: Option<&SessionProjection>,
) -> Option<String> {
    projection
        .filter(|projection| {
            projection
                .run
                .as_ref()
                .is_some_and(|run| !is_terminal_run_status(&run.status))
        })
        .map(|projection| {
            language.format("tui.sessionBackground", &[projection.session_id.clone()])
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selectors_keep_the_displayed_order_and_require_a_snapshot_for_numbers() {
        let catalog: ConversationCatalog = serde_json::from_value(json!({"projects":[], "sessions":[
            {"id":"session:old", "title":"Old", "workspaceBindings":[], "createdAt":"1", "updatedAt":"1"},
            {"id":"session:new", "title":"New", "workspaceBindings":[], "createdAt":"2", "updatedAt":"2"}
        ]})).unwrap();
        let sessions = ordered_sessions(catalog);
        assert_eq!(
            resolve_selector(Language::ZhCn, "1", Some(&sessions)).unwrap(),
            "session:new"
        );
        assert_eq!(
            resolve_selector(Language::ZhCn, "session:unknown", None).unwrap(),
            "session:unknown"
        );
        for selector in ["0", "3", "bad", "session:", "session:with space"] {
            assert!(resolve_selector(Language::ZhCn, selector, Some(&sessions)).is_err());
        }
        assert!(resolve_selector(Language::ZhCn, "1", None).is_err());
    }
}
