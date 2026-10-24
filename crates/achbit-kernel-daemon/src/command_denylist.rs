//! User-owned command rules. Matching is syntactic; this does not evaluate scripts.
use serde_json::Value;

pub(crate) const SETTING: &str = "agent.permissions.commandDenylist";
pub(crate) const DEFAULT_COMMANDS: &[&str] = &["rm -rf /"];

#[derive(Debug, Clone)]
pub(crate) struct CommandDenylist(Vec<CommandRule>);

#[derive(Debug, Clone)]
struct CommandRule {
    text: String,
    words: Vec<String>,
    root_removal: bool,
}

impl CommandDenylist {
    pub(crate) fn from_settings(settings: &Value) -> Result<Self, String> {
        let commands: Vec<&str> = match settings.get(SETTING) {
            None => DEFAULT_COMMANDS.to_vec(),
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| format!("{SETTING} must contain command strings."))
                })
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(format!("{SETTING} must be an array of command strings.")),
        };
        if commands.len() > 256 {
            return Err(format!("{SETTING} supports at most 256 commands."));
        }
        let rules = commands
            .into_iter()
            .map(|command| {
                let command = command.trim();
                if command.is_empty()
                    || command.len() > 16384
                    || command.chars().any(char::is_control)
                {
                    return Err(format!(
                        "{SETTING} requires one nonempty command per line (at most 16384 bytes)."
                    ));
                }
                if shell_command_segments(command).len() != 1 {
                    return Err(format!(
                        "{SETTING}: enter separate commands on separate lines."
                    ));
                }
                let words = shell_words(command);
                let index = shell_program_index(&words)
                    .ok_or_else(|| format!("{SETTING} requires a command name."))?;
                let words = words[index..].to_vec();
                let root_removal = executable_basename(&words[0]) == "rm"
                    && rm_recursively_forces_system_root(&words[1..]);
                Ok(CommandRule {
                    text: command.into(),
                    words,
                    root_removal,
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(Self(rules))
    }

    pub(crate) fn matching_rule(&self, command: &str) -> Option<&str> {
        self.match_at_depth(command, 0)
    }

    pub(crate) fn matching_argv(&self, words: &[String]) -> Option<&str> {
        self.match_words(words, 0)
    }

    fn match_at_depth(&self, command: &str, depth: usize) -> Option<&str> {
        shell_command_segments(command)
            .into_iter()
            .find_map(|segment| self.match_words(&shell_words(segment), depth))
    }

    fn match_words(&self, words: &[String], depth: usize) -> Option<&str> {
        let index = shell_program_index(words)?;
        let program = executable_basename(&words[index]);
        let arguments = &words[index + 1..];
        for rule in &self.0 {
            if executable_basename(&rule.words[0]) != program {
                continue;
            }
            if rule.root_removal {
                if rm_recursively_forces_system_root(arguments) {
                    return Some(&rule.text);
                }
            } else if arguments.starts_with(&rule.words[1..]) {
                return Some(&rule.text);
            }
        }
        if depth < 4 && matches!(program, "sh" | "bash" | "zsh" | "dash" | "ksh") {
            if let Some(nested) = arguments.windows(2).find_map(|pair| {
                (pair[0] == "-c" || pair[0].starts_with('-') && pair[0][1..].contains('c'))
                    .then_some(pair[1].as_str())
            }) {
                return self.match_at_depth(nested, depth + 1);
            }
        }
        None
    }
}

fn shell_command_segments(command: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if quote.is_none() && matches!(character, ';' | '\n' | '&' | '|') {
            segments.push(&command[start..index]);
            start = index + character.len_utf8();
        }
    }
    segments.push(&command[start..]);
    segments
}

fn shell_words(segment: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;
    for character in segment.chars() {
        if escaped {
            started = true;
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            started = true;
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if started {
                words.push(std::mem::take(&mut current));
                started = false;
            }
            continue;
        }
        started = true;
        current.push(character);
    }
    if escaped {
        current.push('\\');
    }
    if started || escaped {
        words.push(current);
    }
    words
}

fn shell_program_index(words: &[String]) -> Option<usize> {
    let mut index = 0usize;
    while index < words.len() {
        let word = executable_basename(&words[index]).to_ascii_lowercase();
        if is_environment_assignment(&words[index]) {
            index += 1;
            continue;
        }
        if matches!(word.as_str(), "command" | "builtin" | "exec") {
            index += 1;
            continue;
        }
        if word == "env" || word == "sudo" {
            index += 1;
            while index < words.len()
                && (words[index].starts_with('-') || is_environment_assignment(&words[index]))
            {
                index += 1;
            }
            continue;
        }
        return Some(index);
    }
    None
}

fn executable_basename(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(value)
}

fn is_environment_assignment(value: &str) -> bool {
    let Some((name, _)) = value.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit())
        })
}

fn rm_recursively_forces_system_root(arguments: &[String]) -> bool {
    let mut recursive = false;
    let mut force = false;
    let mut targets = Vec::new();
    let mut options_finished = false;
    for argument in arguments {
        if !options_finished && argument == "--" {
            options_finished = true;
            continue;
        }
        if !options_finished && argument.starts_with("--") {
            recursive |= argument == "--recursive";
            force |= argument == "--force";
            continue;
        }
        if !options_finished && argument.starts_with('-') && argument != "-" {
            recursive |= argument[1..].chars().any(|flag| matches!(flag, 'r' | 'R'));
            force |= argument[1..].chars().any(|flag| flag == 'f');
            continue;
        }
        targets.push(argument.as_str());
    }
    recursive && force && targets.into_iter().any(is_system_root_target)
}

fn is_system_root_target(target: &str) -> bool {
    let mut normalized = target.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    let lower = normalized.to_ascii_lowercase();
    matches!(lower.as_str(), "/" | "/*" | "/.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_blocks_root_removal_without_blocking_regular_commands() {
        let rules = CommandDenylist::from_settings(&json!({})).unwrap();
        for command in [
            "rm -rf /",
            "sudo /bin/rm -fr --no-preserve-root /",
            "rm --recursive --force /*",
            "pwd; rm -r -f /.",
            "bash -c 'rm -rf /'",
        ] {
            assert_eq!(rules.matching_rule(command), Some("rm -rf /"), "{command}");
        }
        for command in [
            "rm -rf build",
            "rm -rf /tmp/deepcode-owned",
            "rm -rf /System",
            "echo 'rm -rf /'",
            "printf '%s' 'before; rm -rf /'",
            "mkfs.ext4 /dev/example",
            "diskutil eraseDisk example",
            "format C:",
        ] {
            assert_eq!(rules.matching_rule(command), None, "{command}");
        }
    }

    #[test]
    fn user_rules_match_command_argument_prefixes() {
        let rules =
            CommandDenylist::from_settings(&json!({SETTING: ["git reset --hard", "mkfs.ext4"]}))
                .unwrap();
        assert_eq!(
            rules.matching_rule("git reset --hard HEAD"),
            Some("git reset --hard")
        );
        assert_eq!(
            rules.matching_rule("/usr/sbin/mkfs.ext4 /dev/example"),
            Some("mkfs.ext4")
        );
        assert_eq!(rules.matching_rule("git status"), None);
        assert_eq!(rules.matching_rule("echo mkfs.ext4"), None);
        assert_eq!(rules.matching_rule("rm -rf /"), None);
    }

    #[test]
    fn explicit_empty_list_disables_rules() {
        let rules = CommandDenylist::from_settings(&json!({SETTING: []})).unwrap();
        assert_eq!(rules.matching_rule("rm -rf /"), None);
    }

    #[test]
    fn rules_and_commands_preserve_wrapper_and_empty_argument_semantics() {
        let rules = CommandDenylist::from_settings(&json!({SETTING: [
            "sudo git reset --hard", "git commit -m \"\"",
        ]}))
        .unwrap();
        assert_eq!(
            rules.matching_rule("sudo git reset --hard HEAD"),
            Some("sudo git reset --hard")
        );
        assert_eq!(
            rules.matching_rule("git commit -m ''"),
            Some("git commit -m \"\"")
        );
        assert_eq!(rules.matching_rule("git commit -m message"), None);
    }

    #[test]
    fn invalid_rules_are_configuration_errors() {
        for value in [
            json!("rm -rf /"),
            json!([1]),
            json!([""]),
            json!(["rm\npwd"]),
            json!(["pwd; ls"]),
        ] {
            assert!(CommandDenylist::from_settings(&json!({SETTING:value})).is_err());
        }
    }
}
