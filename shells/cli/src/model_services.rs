use super::*;
use achbit_kernel_client::{ModelConnection, ModelProfile};

pub async fn connections(client: &HttpKernelClient) -> Result<Outcome, String> {
    let catalog = client
        .model_connections()
        .await
        .map_err(|e| e.to_string())?;
    let profiles = client.model_profiles().await.map_err(|e| e.to_string())?;
    for c in catalog.connections {
        println!(
            "{}  {}  {}  {}",
            c.connection.id, c.connection.name, c.connection.billing_mode, c.auth_status
        );
        for p in profiles
            .profiles
            .iter()
            .filter(|p| p.connection_id == c.connection.id)
        {
            println!(
                "  {}  {}  {}{}",
                p.id,
                p.parameters.name,
                p.parameters.model,
                if p.parameters.enabled {
                    ""
                } else {
                    " [disabled]"
                }
            );
        }
    }
    Ok(Outcome::Done)
}

pub async fn login(
    client: &HttpKernelClient,
    selector: &str,
    device_code: bool,
) -> Result<Outcome, String> {
    let catalog = client
        .model_connections()
        .await
        .map_err(|e| e.to_string())?;
    let connection_id = if let Some(c) = catalog
        .connections
        .iter()
        .find(|c| c.connection.id == selector)
    {
        if c.connection.credential_kind != "oauth" {
            return Err(crate::language().text("cli.loginOauth").into());
        }
        c.connection.id.clone()
    } else {
        let adapter = catalog
            .adapters
            .iter()
            .find(|a| {
                a.id == selector
                    && a.auth_methods
                        .iter()
                        .any(|m| m == "browser" || m == "deviceCode")
            })
            .ok_or(crate::language().text("cli.loginTarget"))?;
        let connection = ModelConnection {
            id: new_id("connection"),
            name: adapter.name.clone(),
            adapter_id: adapter.id.clone(),
            billing_mode: "subscription".into(),
            base_url: adapter.default_base_url.clone(),
            credential_kind: "oauth".into(),
            credential_ref: None,
        };
        let profile = adapter.models.first().map(|m| ModelProfile {
            id: new_id("model"),
            connection_id: connection.id.clone(),
            parameters: m.clone(),
        });
        client
            .create_model_connection(&connection, profile.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        println!(
            "{}",
            crate::language().format("cli.connection", &[connection.id.to_string()])
        );
        if let Some(profile) = profile {
            println!(
                "{}",
                crate::language().format("cli.model", &[profile.id.to_string()])
            );
        }
        connection.id
    };
    let flow = client
        .start_model_auth(&connection_id, device_code)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(url) = &flow.verification_url {
        println!(
            "{}",
            crate::language().format("cli.openBrowser", &[url.to_string()])
        );
    }
    if let Some(code) = &flow.user_code {
        println!(
            "{}",
            crate::language().format("cli.deviceCode", &[code.to_string()])
        );
    }
    println!("{}", crate::language().text("cli.waitingAuth"));
    let operation = async {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let current = client
                .model_auth_status(&flow.id)
                .await
                .map_err(|e| e.to_string())?;
            match current.status.as_str() {
                "complete" => {
                    println!(
                        "{}",
                        crate::language().format("cli.loggedIn", &[connection_id.to_string()])
                    );
                    return Ok(Outcome::Done);
                }
                "failed" => {
                    return Err(current
                        .error
                        .unwrap_or_else(|| crate::language().text("cli.loginFailed").into()))
                }
                "cancelled" => return Ok(Outcome::Cancelled),
                "pending" => {}
                _ => return Err(crate::language().text("cli.authState").into()),
            }
        }
    };
    let result = tokio::select! { result = operation => result, _ = tokio::signal::ctrl_c() => Ok(Outcome::Interrupted) };
    if !matches!(result, Ok(Outcome::Done)) {
        client
            .cancel_model_auth(&flow.id)
            .await
            .map_err(|e| e.to_string())?;
    }
    result
}

pub async fn usage(
    client: &HttpKernelClient,
    id: Option<&str>,
    days: u64,
    session_id: Option<&str>,
) -> Result<Outcome, String> {
    // CLI's explicit UTC calendar range; GUI supplies its local IANA timezone.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let to = (now / 86_400_000 + 1) * 86_400_000;
    let result = client
        .model_usage(&json!({"from":to-days*86_400_000,"to":to,"timeZone":"UTC",
        "granularity":if days==1 {"hour"} else {"day"},"connectionId":id,"sessionId":session_id}))
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(Outcome::Done)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigCommand {
    Plugins(crate::plugins::PluginCommand),
    Instance,
    Services,
    Connections,
    ConnectionSet {
        input: String,
        key_file: Option<String>,
    },
    ConnectionRemove(String),
    Profiles,
    ProfileSet {
        input: String,
    },
    ProfileRemove(String),
    Default(String),
    Probe(String),
}

impl ConfigCommand {
    pub fn parse(
        args: &[String],
        input: Option<String>,
        key_file: Option<String>,
    ) -> Result<Option<Self>, String> {
        let words: Vec<_> = args.iter().map(String::as_str).collect();
        let command = match words.as_slice() {
            ["plugins", rest @ ..] => {
                Some(Self::Plugins(crate::plugins::PluginCommand::parse(rest)?))
            }
            ["instance"] => Some(Self::Instance),
            ["services"] => Some(Self::Services),
            ["connections", "list"] => Some(Self::Connections),
            ["connections", "set"] => Some(Self::ConnectionSet {
                input: input
                    .clone()
                    .ok_or(crate::language().text("cli.connectionInput"))?,
                key_file: key_file.clone(),
            }),
            ["connections", "remove", id] => Some(Self::ConnectionRemove((*id).into())),
            ["models", "list"] => Some(Self::Profiles),
            ["models", "set"] => Some(Self::ProfileSet {
                input: input
                    .clone()
                    .ok_or(crate::language().text("cli.modelInput"))?,
            }),
            ["models", "remove", id] => Some(Self::ProfileRemove((*id).into())),
            ["models", "default", id] => Some(Self::Default((*id).into())),
            ["models", "probe", id] => Some(Self::Probe((*id).into())),
            _ => None,
        };
        if input.is_some()
            && !matches!(
                command,
                Some(Self::ConnectionSet { .. } | Self::ProfileSet { .. })
            )
        {
            return Err(crate::language().text("cli.inputOption").into());
        }
        if key_file.is_some() && !matches!(command, Some(Self::ConnectionSet { .. })) {
            return Err(crate::language().text("cli.apiKeyOption").into());
        }
        if input.as_deref() == Some("-") && key_file.as_deref() == Some("-") {
            return Err(crate::language().text("cli.stdinConflict").into());
        }
        Ok(command)
    }
}

fn read_config_input(path: &str) -> Result<String, String> {
    if path == "-" {
        use std::io::Read;
        if io::stdin().is_terminal() {
            return Err(crate::language().text("cli.pipeInput").into());
        }
        let mut text = String::new();
        io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        Ok(text)
    } else {
        std::fs::read_to_string(path).map_err(|e| {
            crate::language().format("cli.readInput", &[path.to_string(), e.to_string()])
        })
    }
}

fn read_config_json(path: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(&read_config_input(path)?)
        .map_err(|e| crate::language().format("cli.invalidConfigJson", &[e.to_string()]))?;
    if !value.is_object() {
        return Err(crate::language().text("cli.configObject").into());
    }
    Ok(value)
}

pub async fn configure(
    client: &HttpKernelClient,
    command: ConfigCommand,
) -> Result<Outcome, String> {
    if let ConfigCommand::Plugins(command) = command {
        return crate::plugins::run(client, command).await;
    }
    let probe = matches!(command, ConfigCommand::Probe(_));
    let edit = matches!(
        command,
        ConfigCommand::ConnectionSet { .. }
            | ConfigCommand::ConnectionRemove(_)
            | ConfigCommand::ProfileSet { .. }
            | ConfigCommand::ProfileRemove(_)
            | ConfigCommand::Default(_)
    );
    let result = match command {
        ConfigCommand::Plugins(_) => unreachable!("handled above"),
        ConfigCommand::Instance => client.host_instance().await.map(|mut value| {
            value["apiUrl"] = json!(client.base_url());
            value
        }),
        ConfigCommand::Services => client.plugin_services().await,
        ConfigCommand::Connections => client.model_connections_document().await,
        ConfigCommand::Profiles => client.model_profiles_document().await,
        ConfigCommand::ConnectionSet { input, key_file } => {
            let mut body = read_config_json(&input)?;
            if body.get("apiKey").is_some() {
                return Err(crate::language().text("cli.keyOption").into());
            }
            if let Some(path) = key_file {
                let key = read_config_input(&path)?;
                let key = key.trim();
                if key.is_empty() {
                    return Err(crate::language().text("cli.emptyKey").into());
                }
                body["apiKey"] = json!(key);
            }
            client.update_model_connection(&body).await
        }
        ConfigCommand::ConnectionRemove(id) => {
            client
                .update_model_connection(&json!({"removeConnectionId":id}))
                .await
        }
        ConfigCommand::ProfileSet { input } => {
            client
                .update_model_profile(&json!({"profile":read_config_json(&input)?}))
                .await
        }
        ConfigCommand::ProfileRemove(id) => {
            client
                .update_model_profile(&json!({"removeProfileId":id}))
                .await
        }
        ConfigCommand::Default(id) => {
            client
                .update_model_profile(&json!({"defaultProfileId":id}))
                .await
        }
        ConfigCommand::Probe(id) => client.probe_model_profile(&id).await,
    }
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    if edit {
        eprintln!("{}", crate::language().text("cli.configSaved"));
    }
    Ok(if probe && result["ok"] != true {
        Outcome::Failed
    } else {
        Outcome::Done
    })
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn configuration_arguments_keep_secret_input_and_operation_scope_explicit() {
        let args = |words: &[&str]| words.iter().map(|s| (*s).into()).collect::<Vec<String>>();
        assert_eq!(
            ConfigCommand::parse(&args(&["models", "probe", "local"]), None, None).unwrap(),
            Some(ConfigCommand::Probe("local".into()))
        );
        assert!(ConfigCommand::parse(&args(&["connections", "set"]), None, None).is_err());
        assert!(ConfigCommand::parse(
            &args(&["connections", "set"]),
            Some("-".into()),
            Some("-".into())
        )
        .is_err());
        assert!(
            ConfigCommand::parse(&args(&["models", "list"]), None, Some("key".into())).is_err()
        );
        assert!(ConfigCommand::parse(
            &args(&["ask", "hello"]),
            Some("connection.json".into()),
            None
        )
        .is_err());
        assert_eq!(
            ConfigCommand::parse(
                &args(&["connections", "set"]),
                Some("connection.json".into()),
                Some("-".into())
            )
            .unwrap(),
            Some(ConfigCommand::ConnectionSet {
                input: "connection.json".into(),
                key_file: Some("-".into())
            })
        );
    }
}
