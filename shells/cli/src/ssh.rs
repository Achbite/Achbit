//! Local operator interface for an Agent assisting with SSH onboarding.
//! This path does not bootstrap a local Session or receive login secrets.
use deepcode_host_connection::{
    ssh::{SshGuiConnection, SshTarget},
    UserDirectories,
};
use deepcode_kernel_abi::{HOST_TOKEN_ENTROPY_BYTES, HOST_UI_TOKEN_PREFIX};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) const RECEIPT_ENV: &str = "DEEPCODE_GUI_SSH_RECEIPT";

struct Options {
    action: String,
    target: SshTarget,
    output: Option<PathBuf>,
    gui: Option<PathBuf>,
    wait: bool,
}

fn parse(args: &[String]) -> io::Result<Options> {
    let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidInput, message);
    let action = args
        .first()
        .ok_or_else(|| invalid("Expected configure, inspect, check or connect"))?
        .clone();
    if !["configure", "inspect", "check", "connect"].contains(&action.as_str()) {
        return Err(invalid("Expected configure, inspect, check or connect"));
    }
    let mut options = Options {
        action,
        target: SshTarget {
            destination: String::new(),
            port: None,
            identity_file: None,
            config_file: None,
            cli_path: "deepcode-cli".into(),
            user_root: None,
        },
        output: None,
        gui: None,
        wait: false,
    };
    let mut user = None;
    let mut values = args[1..].iter();
    while let Some(flag) = values.next() {
        if flag == "--wait" {
            options.wait = true;
            continue;
        }
        let value = values
            .next()
            .ok_or_else(|| invalid(&format!("{flag} requires a value")))?;
        match flag.as_str() {
            "--profile" => options.target = serde_json::from_slice(&fs::read(value)?)?,
            "--host" => options.target.destination = value.clone(),
            "--port" => {
                options.target.port = Some(value.parse().map_err(|_| invalid("Invalid SSH port"))?)
            }
            "--user" => user = Some(value.clone()),
            "--identity" => options.target.identity_file = Some(std::path::absolute(value)?),
            "--config" => options.target.config_file = Some(std::path::absolute(value)?),
            "--remote-cli" => options.target.cli_path = value.clone(),
            "--remote-user-root" => options.target.user_root = Some(value.clone()),
            "--output" => options.output = Some(std::path::absolute(value)?),
            "--gui" => options.gui = Some(std::path::absolute(value)?),
            _ => {
                return Err(invalid(&format!(
                    "Unknown SSH option: {flag}. Passwords are entered only in the GUI."
                )))
            }
        }
    }
    if let Some(user) = user {
        if user.is_empty() || user.contains('@') || options.target.destination.contains('@') {
            return Err(invalid(
                "--user requires one username and a host without user@",
            ));
        }
        options.target.destination = format!("{user}@{}", options.target.destination);
    }
    options.target.validate()?;
    if options.action == "configure" && options.output.is_none() {
        return Err(invalid("configure requires --output <new profile.json>"));
    }
    if options.action != "configure" && options.output.is_some() {
        return Err(invalid("--output belongs to configure"));
    }
    if options.action != "connect" && (options.wait || options.gui.is_some()) {
        return Err(invalid("--wait and --gui belong to connect"));
    }
    Ok(options)
}

pub(super) fn run(args: &[String]) -> i32 {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "help") {
        println!("{}", HELP);
        return 0;
    }
    match parse(args).and_then(execute) {
        Ok(result) => {
            println!("{result}");
            if result["ok"] == true {
                0
            } else {
                3
            }
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"error":error.to_string()}));
            if error.kind() == io::ErrorKind::InvalidInput {
                4
            } else {
                3
            }
        }
    }
}

fn execute(options: Options) -> io::Result<Value> {
    let resolved = options.target.resolve()?;
    match options.action.as_str() {
        "inspect" => Ok(json!({"ok":true,"target":options.target,"resolved":resolved})),
        "configure" => {
            let output = options.output.unwrap();
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)?;
            serde_json::to_writer_pretty(&mut file, &options.target)?;
            file.write_all(b"\n")?;
            Ok(json!({"ok":true,"profile":output,"target":options.target,"resolved":resolved}))
        }
        "check" => {
            let user = UserDirectories::resolve()?;
            user.create()?;
            let log = user.log_dir.join(format!("ssh-check-{}.log", unique_id()));
            let mut entropy = vec![0u8; HOST_TOKEN_ENTROPY_BYTES];
            getrandom::fill(&mut entropy).map_err(|error| io::Error::other(error.to_string()))?;
            let token = format!(
                "{HOST_UI_TOKEN_PREFIX}{}",
                entropy
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);
            let connection = SshGuiConnection::connect(&options.target, port, &token, &log, None)?;
            let result = json!({"ok":true,"state":"ready","resolved":resolved,"remoteHost":connection.receipt.daemon});
            drop(connection);
            Ok(result)
        }
        "connect" => connect_gui(options, resolved.endpoint),
        _ => unreachable!(),
    }
}

fn connect_gui(options: Options, endpoint: String) -> io::Result<Value> {
    let gui = match options.gui {
        Some(path) => path,
        None => std::env::current_exe()?
            .parent()
            .ok_or_else(|| io::Error::other("CLI directory unavailable"))?
            .join(if cfg!(windows) {
                "DeepCode-GUI.exe"
            } else {
                "DeepCode-GUI"
            }),
    };
    if !gui.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "DeepCode-GUI not found beside CLI; pass --gui <local GUI executable>",
        ));
    }
    let user = UserDirectories::resolve()?;
    user.create()?;
    let id = unique_id();
    let log_path = user.log_dir.join(format!("ssh-window-{id}.log"));
    let log = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&log_path)?;
    let receipt = options
        .wait
        .then(|| user.temp_dir.join(format!("ssh-window-{id}.json")));
    if let Some(path) = &receipt {
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?
            .write_all(b"{\"state\":\"starting\"}")?;
    }
    let cleanup = ReceiptCleanup(receipt.clone());
    let mut command = Command::new(&gui);
    command
        .env(
            "DEEPCODE_GUI_SSH_TARGET",
            serde_json::to_string(&options.target)?,
        )
        .env_remove(RECEIPT_ENV)
        .env_remove("DEEPCODE_PORT")
        .env_remove("DEEPCODE_SHELL_CONNECT_ONLY")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(path) = &receipt {
        command.env(RECEIPT_ENV, path);
    }
    let mut child = deepcode_host_connection::process::spawn_independent_shell(&mut command)?;
    let pid = child.id();
    if let Some(path) = &receipt {
        let deadline = Instant::now() + Duration::from_secs(310);
        loop {
            let value: Value = serde_json::from_slice(&fs::read(path)?)?;
            if value["state"] != "starting" {
                return Ok(value);
            }
            if let Some(status) = child.try_wait()? {
                return Err(io::Error::other(format!(
                    "GUI exited before connecting ({status}); log: {}",
                    log_path.display()
                )));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "SSH connection is still awaiting the GUI; the window remains open",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    drop(cleanup);
    Ok(json!({"ok":true,"state":"window_started","pid":pid,"endpoint":endpoint,"log":log_path}))
}

struct ReceiptCleanup(Option<PathBuf>);
impl Drop for ReceiptCleanup {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn unique_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

const HELP: &str = r#"Agent SSH onboarding (run on the computer displaying the GUI):
  deepcode-cli ssh inspect --host <IP|alias> [--port <port>] [--user <name>]
  deepcode-cli ssh configure --host <IP|alias> [options] --output <new profile.json>
  deepcode-cli ssh check --profile <profile.json>
  deepcode-cli ssh connect --profile <profile.json> [--wait] [--gui <executable>]
All commands also accept --host instead of --profile and return JSON (except help).
Options: --identity <local key path>, --config <OpenSSH config>, --remote-cli <path>, --remote-user-root <path>.
inspect resolves local OpenSSH configuration; check verifies a real remote CLI/Host attachment using keys/ssh-agent, without a prompt.
connect opens a new remote GUI; --wait returns its actual connected/failed result while the human answers native login prompts.
configure writes connection metadata only and refuses to overwrite an existing file. There is no password argument or password field.
The GUI can save successfully verified passwords/passphrases in the operating system credential store. Existing SSH configuration remains usable.
Closing the window or disconnecting SSH never cancels the remote Agent. Use the existing explicit cancel action."#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_accepts_connection_parameters_and_rejects_secret_arguments() {
        let parse_args = |values: &[&str]| {
            parse(
                &values
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>(),
            )
        };
        let args = parse_args(&[
            "connect",
            "--host",
            "127.0.0.1",
            "--port",
            "8008",
            "--user",
            "dev",
            "--wait",
        ])
        .unwrap();
        assert_eq!(args.target.destination, "dev@127.0.0.1");
        assert_eq!(args.target.port, Some(8008));
        assert!(args.wait);
        assert!(parse_args(&["connect", "--host", "server", "--password", "secret"]).is_err());
        assert!(parse_args(&["connect", "--host", "server", "--port", "0"]).is_err());
        assert!(parse_args(&["configure", "--host", "server"]).is_err());
    }
}
