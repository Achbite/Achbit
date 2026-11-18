//! Shared value formats used by the Session journal and its Rust clients.

pub fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    value == "."
        || !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

pub fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && value.len() <= 128
        && kind.chars().chain(subtype.chars()).all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                )
        })
}

pub fn valid_plugin_uri(value: &str) -> bool {
    let Some(identity) = value.strip_prefix("plugin://") else {
        return false;
    };
    let Some((name, source)) = identity.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !source.is_empty()
        && !name.contains('@')
        && name.chars().chain(source.chars()).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}
