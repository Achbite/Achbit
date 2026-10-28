//! Plugin management uses the same authenticated Host operations as Settings.
use crate::Outcome;
use achbit_kernel_client::HttpKernelClient;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginCommand {
    List(Option<String>),
    Capabilities,
    Guide(String),
    Template(String),
    Inspect(String),
    Install(String),
    Update { target: String, path: String },
    Enable(String),
    Disable(String),
    Remove(String),
}
impl PluginCommand {
    pub fn parse(words: &[&str]) -> Result<Self, String> {
        match words {
            [] | ["list"] | ["status"] => Ok(Self::List(None)),
            ["status", target] => Ok(Self::List(Some((*target).into()))),
            ["capabilities"] => Ok(Self::Capabilities),
            ["guide", topic @ ("plugins" | "ui")] => Ok(Self::Guide((*topic).into())),
            ["template", kind @ ("cli" | "service" | "ui" | "guidance")] => Ok(Self::Template((*kind).into())),
            ["inspect", path] => Ok(Self::Inspect(absolute_path(path)?)),
            ["install", path] => Ok(Self::Install(absolute_path(path)?)),
            ["update", target, path] => Ok(Self::Update { target:(*target).into(), path:absolute_path(path)? }),
            ["enable", target] => Ok(Self::Enable((*target).into())),
            ["disable", target] => Ok(Self::Disable((*target).into())),
            ["remove", target] => Ok(Self::Remove((*target).into())),
            _ => Err("plugins list/status [id|installed-path] | capabilities | guide plugins/ui | template cli/service/ui/guidance | inspect/install <path> | update <id|installed-path> <path> | enable/disable/remove <id|installed-path>".into()),
        }
    }
}
fn absolute_path(value: &str) -> Result<String, String> {
    let path = std::path::Path::new(value);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    }
    .to_string_lossy()
    .into_owned())
}
pub async fn run(client: &HttpKernelClient, command: PluginCommand) -> Result<Outcome, String> {
    let mut value = match command {
        PluginCommand::List(target) => {
            let mut inventory = client
                .installed_plugins()
                .await
                .map_err(|error| error.to_string())?;
            if let Some(target) = target {
                let items = inventory["plugins"]
                    .as_array()
                    .ok_or("Invalid plugin inventory")?;
                let matches: Vec<Value> = items
                    .iter()
                    .filter(|item| {
                        item["id"].as_str() == Some(&target)
                            || item["path"].as_str() == Some(&target)
                    })
                    .cloned()
                    .collect();
                if matches.len() != 1 {
                    return Err("Choose one plugin ID or installed path from plugins list.".into());
                }
                inventory["plugins"] = json!(matches);
            }
            inventory
        }
        PluginCommand::Capabilities => client
            .plugin_development(None)
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Guide(topic) => client
            .plugin_development(Some(&format!("guides/{topic}")))
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Template(kind) => client
            .plugin_development(Some(&format!("templates/{kind}")))
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Inspect(path) => client
            .inspect_plugin(&path)
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Install(path) => client
            .install_plugin(&path)
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Update { target, path } => client
            .manage_plugin(&json!({"action":"update","target":target,"path":path}))
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Enable(target) => client
            .manage_plugin(&json!({"action":"enable","target":target}))
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Disable(target) => client
            .manage_plugin(&json!({"action":"disable","target":target}))
            .await
            .map_err(|error| error.to_string())?,
        PluginCommand::Remove(target) => client
            .manage_plugin(&json!({"action":"remove","target":target}))
            .await
            .map_err(|error| error.to_string())?,
    };
    // The CLI returns the operation receipt, not the entire settings document.
    if let Some(object) = value.as_object_mut() {
        object.remove("settings");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
    );
    Ok(if value["application"]["status"] == "failed" {
        Outcome::Failed
    } else {
        Outcome::Done
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn management_commands_require_explicit_operations_and_update_target() {
        assert_eq!(
            PluginCommand::parse(&["enable", "sample"]).unwrap(),
            PluginCommand::Enable("sample".into())
        );
        assert!(PluginCommand::parse(&["update", "sample"]).is_err());
        assert!(PluginCommand::parse(&["remove"]).is_err());
        assert!(PluginCommand::parse(&["template", "unknown"]).is_err());
        assert_eq!(
            PluginCommand::parse(&["status", "/installed/plugin"]).unwrap(),
            PluginCommand::List(Some("/installed/plugin".into()))
        );
    }
}
