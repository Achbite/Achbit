#[path = "../../shared/conversation_input.rs"]
mod conversation_input;
// CLI retains its existing Chinese messages; TUI also uses the shared locale loader.
#[allow(dead_code)]
#[path = "../../shared/i18n.rs"]
mod i18n;
mod model_services;
mod render;
#[path = "../../shared/session_navigation.rs"]
mod session_navigation;

use deepcode_kernel_client::{
    cancel_command, is_terminal_run_status, plan_cancel_command, CreateConversationSessionRequest,
    FilesystemReference, FilesystemReferencePathInput, HttpKernelClient, KernelBootstrap,
    KernelBootstrapOptions, PluginCatalogItem, PluginCatalogProjection, PluginSelectionInput,
    SessionProjection,
};
use render::{
    render_action_required_if_any, render_projection, render_run_state, render_terminal_error,
    CliRenderState,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;
const EXIT_ACTION_REQUIRED: i32 = 5;
const EXIT_RUN_FAILED: i32 = 6;
const EXIT_RUN_INDETERMINATE: i32 = 7;
const EXIT_RUN_CANCELLED: i32 = 8;
const EXIT_INTERRUPTED: i32 = 130;
const POLL_INTERVAL: Duration = Duration::from_millis(150);
const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(600);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() {
    let args = match Args::parse(env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            print_help();
            std::process::exit(EXIT_BAD_ARGS);
        }
    };
    if matches!(args.command, Command::Help) {
        print_help();
        return;
    }
    let bootstrap = match KernelBootstrap::connect(
        KernelBootstrapOptions::new(args.api.clone())
            .auto_start(!args.no_auto_start_kernel && !matches!(args.command, Command::StopHost))
            .persistent(matches!(args.command, Command::StartHost)),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Daemon 不可用：{error}");
            std::process::exit(EXIT_DAEMON_UNAVAILABLE);
        }
    };
    let result = run(bootstrap.client(), args).await;
    drop(bootstrap);
    match result {
        Ok(Outcome::Done) => {}
        Ok(Outcome::ActionRequired) => std::process::exit(EXIT_ACTION_REQUIRED),
        Ok(Outcome::Failed) => std::process::exit(EXIT_RUN_FAILED),
        Ok(Outcome::Indeterminate) => std::process::exit(EXIT_RUN_INDETERMINATE),
        Ok(Outcome::Cancelled) => std::process::exit(EXIT_RUN_CANCELLED),
        Ok(Outcome::Interrupted) => std::process::exit(EXIT_INTERRUPTED),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(EXIT_DAEMON_UNAVAILABLE);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Help,
    Connections,
    AuthLogin {
        selector: String,
        device_code: bool,
    },
    AuthLogout {
        connection_id: String,
    },
    Quota {
        connection_id: String,
    },
    Usage {
        connection_id: Option<String>,
        days: u64,
    },
    Status,
    StopHost,
    StartHost,
    Diff {
        record_id: String,
        index: usize,
    },
    Ask(String),
    Chat,
    Sessions,
    Show,
    Read {
        query: Value,
    },
    CancelPlan,
    Cancel {
        run_id: String,
    },
    AttachDirectory {
        path: String,
    },
    DetachDirectory {
        workspace_id: String,
    },
    OpenResource {
        workspace_id: String,
        logical_path: String,
        start_byte: Option<u64>,
    },
}

#[derive(Debug, Clone)]
struct Args {
    api: Option<String>,
    no_auto_start_kernel: bool,
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    plain: bool,
    profile_id: Option<String>,
    plugins: Vec<String>,
    files: Vec<String>,
    directories: Vec<String>,
    command: Command,
}

impl Args {
    fn parse(values: Vec<String>) -> Result<Self, String> {
        let mut api = None;
        let mut no_auto_start_kernel = false;
        let mut workspace = None;
        let mut session_id = None;
        let mut plain = false;
        let mut profile_id = None;
        let mut plugins = Vec::new();
        let mut files = Vec::new();
        let mut directories = Vec::new();
        let mut read_query = serde_json::Map::new();
        let mut positional = Vec::new();
        let mut index = 0;
        while index < values.len() {
            match values[index].as_str() {
                "--api" => {
                    index += 1;
                    api = Some(required_arg(&values, index, "--api")?.to_string());
                }
                "--model" => {
                    index += 1;
                    profile_id = Some(required_arg(&values, index, "--model")?.to_owned());
                }
                "--no-auto-start-kernel" => no_auto_start_kernel = true,
                "--workspace" | "-C" => {
                    index += 1;
                    workspace = Some(PathBuf::from(required_arg(&values, index, "--workspace")?));
                }
                "--session" => {
                    index += 1;
                    session_id = Some(required_arg(&values, index, "--session")?.to_string());
                }
                "--view" | "--record" | "--request" | "--before" | "--limit" | "--offset" => {
                    let option = values[index].clone();
                    index += 1;
                    let value = required_arg(&values, index, &option)?;
                    let field = match option.as_str() {
                        "--view" => "view",
                        "--record" => "recordId",
                        "--request" => "providerRequestId",
                        "--before" => "before",
                        "--offset" => "offset",
                        _ => "limit",
                    };
                    let value = if matches!(field, "before" | "limit" | "offset") {
                        let number = value
                            .parse::<u64>()
                            .map_err(|_| format!("{option} 需要正整数。"))?;
                        if (number == 0 && field != "offset")
                            || (field == "limit" && number > 50)
                            || number > 9_007_199_254_740_991
                        {
                            return Err(format!("{option} 超出有效范围。"));
                        }
                        json!(number)
                    } else {
                        json!(value)
                    };
                    read_query.insert(field.into(), value);
                }
                "--plain" => plain = true,
                "--plugin" => {
                    index += 1;
                    plugins.push(required_arg(&values, index, "--plugin")?.to_string());
                }
                "--file" => {
                    index += 1;
                    files.push(required_arg(&values, index, "--file")?.to_string());
                }
                "--directory" => {
                    index += 1;
                    directories.push(required_arg(&values, index, "--directory")?.to_string());
                }
                "--help" | "-h" => positional.push("help".to_string()),
                value if value.starts_with('-') => return Err(format!("未知选项：{value}")),
                _ => positional.push(values[index].clone()),
            }
            index += 1;
        }
        if session_id.is_some() && workspace.is_some() {
            return Err(
                "--session 指向已有 creation snapshot，不能同时使用 -C/--workspace。".to_string(),
            );
        }
        let command = match positional.first().map(String::as_str) {
            None => Command::Chat,
            Some("help") => Command::Help,
            Some("status") => Command::Status,
            Some("connections" | "models") if positional.len()==1 => Command::Connections,
            Some("auth") => match positional.get(1).map(String::as_str) {
                Some("status") if positional.len()==2 => Command::Connections,
                Some("login") if (3..=4).contains(&positional.len()) => {
                    let method=positional.get(3).map(String::as_str).unwrap_or("browser");
                    if !matches!(method,"browser"|"device") { return Err("登录方式为 browser 或 device。".into()); }
                    Command::AuthLogin { selector:positional[2].clone(),device_code:method=="device" }
                }
                Some("logout") if positional.len()==3 => Command::AuthLogout { connection_id:positional[2].clone() },
                _ => return Err("用法：auth login <connection-id|openai-codex> [browser|device] / auth status / auth logout <connection-id>".into()),
            },
            Some("quota") if positional.len()==2 => Command::Quota { connection_id:positional[1].clone() },
            Some("usage") if positional.len()<=3 => {
                let days:u64=positional.get(2).map(|v|v.parse()).transpose().map_err(|_|"统计天数无效。")?.unwrap_or(30);
                if !(1..=366).contains(&days) { return Err("统计天数必须在 1 至 366 之间。".into()); }
                Command::Usage { connection_id:positional.get(1).filter(|v|v.as_str()!="all").cloned(),days }
            },
            Some("stop-host") if positional.len() == 1 => Command::StopHost,
            Some("start-host") if positional.len() == 1 => Command::StartHost,
            Some("diff") if positional.len() == 3 => Command::Diff {
                record_id: positional[1].clone(),
                index: positional[2]
                    .parse()
                    .map_err(|_| "diff index must be a nonnegative integer")?,
            },
            Some("sessions") if positional.len() == 1 && session_id.is_none() && workspace.is_none() => Command::Sessions,
            Some("new") if positional.len() == 1 && session_id.is_none() => Command::Chat,
            Some("resume") if positional.len() == 2 && session_id.is_none() && workspace.is_none() => {
                session_id = Some(session_navigation::resolve_selector(i18n::Language::ZhCn, &positional[1], None)?);
                Command::Chat
            }
            Some("sessions" | "new" | "resume") => return Err("用法：sessions | new [-C <workspace>] | resume <完整 session: ID>；不可同时指定 --session。".into()),
            Some("chat") => Command::Chat,
            Some("show") => Command::Show,
            Some("read") => {
                if positional.len() != 1 || session_id.is_none() {
                    return Err("用法：read --session <id> [--view summary|messages|tools|plans|context|reasoning] [--before <sequence>] [--limit 1..50]".into());
                }
                Command::Read {
                    query: Value::Object(read_query.clone()),
                }
            }
            Some("ask") => {
                let text = positional[1..].join(" ");
                if text.trim().is_empty() {
                    return Err("ask 需要非空输入。".to_string());
                }
                Command::Ask(text)
            }
            Some("cancel-plan") => {
                if positional.len() != 1 {
                    return Err("用法：cancel-plan --session <id>".to_string());
                }
                Command::CancelPlan
            }
            Some("cancel") => {
                if positional.len() != 2 {
                    return Err("用法：cancel --session <id> <run-id>".to_string());
                }
                Command::Cancel {
                    run_id: positional[1].clone(),
                }
            }
            Some("attach-directory") => {
                if positional.len() != 2 {
                    return Err("用法：attach-directory --session <id> <path>".to_string());
                }
                Command::AttachDirectory {
                    path: positional[1].clone(),
                }
            }
            Some("detach-directory") => {
                if positional.len() != 2 {
                    return Err("用法：detach-directory --session <id> <workspace-id>".to_string());
                }
                Command::DetachDirectory {
                    workspace_id: positional[1].clone(),
                }
            }
            Some("open-resource") => {
                if positional.len() != 3 && positional.len() != 4 {
                    return Err(
                        "用法：open-resource --session <id> <workspace-id> <logical-path>"
                            .to_string(),
                    );
                }
                Command::OpenResource {
                    workspace_id: positional[1].clone(),
                    logical_path: positional[2].clone(),
                    start_byte: positional
                        .get(3)
                        .map(|value| value.parse::<u64>().map_err(|_| "invalid startByte"))
                        .transpose()?,
                }
            }
            Some(other) => return Err(format!("未知命令：{other}")),
        };
        if !read_query.is_empty() && !matches!(command, Command::Read { .. }) {
            return Err("--view/--record/--request/--before/--limit 仅用于 read。".into());
        }
        Ok(Self {
            api,
            no_auto_start_kernel,
            workspace,
            session_id,
            plain,
            profile_id,
            plugins,
            files,
            directories,
            command,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Done,
    ActionRequired,
    Failed,
    Indeterminate,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone)]
struct PluginBinding {
    catalog_revision: String,
    selections: Vec<PluginSelectionInput>,
}

async fn resolve_plugin_selections(
    client: &HttpKernelClient,
    plugin_uris: &[String],
    filesystem_references: &[FilesystemReference],
) -> Result<Option<PluginBinding>, String> {
    if plugin_uris.is_empty() && filesystem_references.is_empty() {
        return Ok(None);
    }
    let catalog = client
        .conversation_plugin_catalog()
        .await
        .map_err(|error| error.to_string())?;
    let mut effective_uris = plugin_uris.to_vec();
    for reference in filesystem_references {
        if reference.kind != "file" {
            continue;
        }
        let Some(media_type) = reference.media_type.as_deref() else {
            return Err("文件引用缺少 mediaType。".to_string());
        };
        let matches = catalog
            .plugins
            .iter()
            .filter(|plugin| {
                plugin
                    .activation_media_types
                    .iter()
                    .any(|candidate| candidate == media_type)
            })
            .collect::<Vec<_>>();
        if media_type == "application/pdf" && matches.len() != 1 {
            return Err("plugin_selection_unavailable:application/pdf".to_string());
        }
        if let [plugin] = matches.as_slice() {
            effective_uris.push(plugin.uri.clone());
        }
    }
    if effective_uris.is_empty() {
        return Ok(None);
    }
    plugin_binding_from_catalog(catalog, &effective_uris).map(Some)
}

async fn resolve_cli_filesystem_references(
    client: &HttpKernelClient,
    session_id: &str,
    files: &[String],
    directories: &[String],
) -> Result<Vec<FilesystemReference>, String> {
    if files.len() + directories.len() > 8 {
        return Err("单次 ask 最多附加八个文件系统引用。".to_string());
    }
    let references = files
        .iter()
        .map(|path| FilesystemReferencePathInput {
            path: path.clone(),
            kind: "file".to_string(),
        })
        .chain(directories.iter().map(|path| FilesystemReferencePathInput {
            path: path.clone(),
            kind: "directory".to_string(),
        }))
        .collect::<Vec<_>>();
    if references.is_empty() {
        return Ok(Vec::new());
    }
    client
        .resolve_conversation_filesystem_references(session_id, references)
        .await
        .map_err(|error| error.to_string())
}

fn plugin_binding_from_catalog(
    catalog: PluginCatalogProjection,
    plugin_uris: &[String],
) -> Result<PluginBinding, String> {
    let mut seen = HashSet::new();
    let mut selections = Vec::with_capacity(plugin_uris.len());
    for uri in plugin_uris {
        if !seen.insert(uri.as_str()) {
            continue;
        }
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.uri == *uri)
            .ok_or_else(|| format!("插件不在当前目录中或不可用：{uri}"))?;
        if let Some(error) = plugin_unavailable_reason(plugin) {
            return Err(error);
        }
        selections.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri.clone(),
            label: plugin.display_name.clone(),
        });
    }
    Ok(PluginBinding {
        catalog_revision: catalog.revision,
        selections,
    })
}

async fn run(client: &HttpKernelClient, args: Args) -> Result<Outcome, String> {
    if !args.plugins.is_empty() && !matches!(&args.command, Command::Ask(_) | Command::Chat) {
        return Err("--plugin 只适用于 ask 或 chat。".to_string());
    }
    if (!args.files.is_empty() || !args.directories.is_empty())
        && !matches!(&args.command, Command::Ask(_))
    {
        return Err("--file/--directory 只适用于单次 ask。".to_string());
    }
    match args.command {
        Command::Help => Ok(Outcome::Done),
        Command::Sessions => {
            let catalog = client
                .conversation_catalog()
                .await
                .map_err(|error| error.to_string())?;
            print_sessions(&session_navigation::ordered_sessions(catalog), None);
            Ok(Outcome::Done)
        }
        Command::Connections => model_services::connections(client).await,
        Command::AuthLogin {
            selector,
            device_code,
        } => model_services::login(client, &selector, device_code).await,
        Command::AuthLogout { connection_id } => {
            client
                .logout_model_connection(&connection_id)
                .await
                .map_err(|e| e.to_string())?;
            println!("已退出登录。{}　", connection_id);
            Ok(Outcome::Done)
        }
        Command::Quota { connection_id } => {
            let value = client
                .model_quota(&connection_id)
                .await
                .map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
            );
            Ok(Outcome::Done)
        }
        Command::Usage {
            connection_id,
            days,
        } => {
            model_services::usage(
                client,
                connection_id.as_deref(),
                days,
                args.session_id.as_deref(),
            )
            .await
        }
        Command::StartHost => {
            println!("共享 Host 已启动为常驻服务。");
            Ok(Outcome::Done)
        }
        Command::StopHost => {
            client
                .stop_host()
                .await
                .map_err(|error| error.to_string())?;
            println!("共享 Host 已接纳停止请求。");
            Ok(Outcome::Done)
        }
        Command::Diff { record_id, index } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let change = client
                .conversation_change_read(session_id, &record_id, index)
                .await
                .map_err(|error| error.to_string())?;
            print!("{}", change.unified_diff());
            Ok(Outcome::Done)
        }
        Command::Status => {
            let status = client
                .daemon_status()
                .await
                .map_err(|error| error.to_string())?;
            println!(
                "{}: {}",
                status.service,
                if status.ok { "ready" } else { "not ready" }
            );
            Ok(Outcome::Done)
        }
        Command::Ask(text) => {
            let projection = open_session(
                client,
                args.session_id.as_deref(),
                args.workspace.as_ref(),
                args.profile_id.as_deref(),
            )
            .await?;
            let filesystem_references = resolve_cli_filesystem_references(
                client,
                &projection.session_id,
                &args.files,
                &args.directories,
            )
            .await?;
            let plugin_binding =
                resolve_plugin_selections(client, &args.plugins, &filesystem_references).await?;
            if !args.plain {
                eprintln!("session: {}", projection.session_id);
            }
            submit_input_and_wait(
                client,
                &projection,
                &text,
                args.profile_id.as_deref(),
                &filesystem_references,
                plugin_binding.as_ref(),
                args.plain,
            )
            .await
        }
        Command::Chat => {
            run_chat(
                client,
                args.session_id.as_deref(),
                args.workspace.as_ref(),
                &args.plugins,
                args.profile_id.as_deref(),
            )
            .await
        }
        Command::Read { query } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let result = client
                .conversation_read(session_id, &query)
                .await
                .map_err(|error| error.to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
            Ok(Outcome::Done)
        }
        Command::Show => {
            let session_id = require_session(args.session_id.as_deref())?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            render_projection(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
            Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done))
        }
        Command::CancelPlan => {
            let session_id = require_session(args.session_id.as_deref())?;
            let before = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let plan = before
                .pending_plan
                .as_ref()
                .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
            let command = plan_cancel_command(session_id, &new_id("command"), plan);
            submit_checked(client, session_id, &command).await?;
            wait_for_projection(client, &before, args.plain).await
        }
        Command::Cancel { run_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let command = cancel_command(session_id, &new_id("command"), &run_id);
            submit_checked(client, session_id, &command).await?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            render_run_state(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
            Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done))
        }
        Command::AttachDirectory { path } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let before = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let projection = client
                .attach_conversation_directory_index(session_id, &path)
                .await
                .map_err(|error| error.to_string())?;
            let added = projection
                .session_directory_indexes
                .iter()
                .filter(|binding| {
                    before
                        .session_directory_indexes
                        .iter()
                        .all(|existing| existing.workspace_id != binding.workspace_id)
                })
                .collect::<Vec<_>>();
            if let [binding] = added.as_slice() {
                println!(
                    "已附加目录索引：{} ({})；从下一次 run 起生效。",
                    binding.display_name, binding.workspace_id
                );
            } else {
                println!("对话目录已更新，下次运行生效。");
            }
            Ok(Outcome::Done)
        }
        Command::DetachDirectory { workspace_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            client
                .detach_conversation_directory_index(session_id, &workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            println!("已移除目录索引 {workspace_id}；仅影响之后启动的 run。");
            Ok(Outcome::Done)
        }
        Command::OpenResource {
            workspace_id,
            logical_path,
            start_byte,
        } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let resource = client
                .conversation_resource_read_range(
                    session_id,
                    &workspace_id,
                    &logical_path,
                    start_byte,
                )
                .await
                .map_err(|error| error.to_string())?;
            if let Some(next) = resource.next_byte {
                eprintln!("部分内容；续读：deepcode-cli open-resource --session {session_id} {workspace_id} {logical_path:?} {next}");
            }
            print!("{}", resource.content);
            if !resource.content.ends_with('\n') {
                println!();
            }
            Ok(Outcome::Done)
        }
    }
}

async fn open_session(
    client: &HttpKernelClient,
    session_id: Option<&str>,
    workspace: Option<&PathBuf>,
    profile_id: Option<&str>,
) -> Result<SessionProjection, String> {
    if let Some(session_id) = session_id {
        return client
            .conversation_projection(session_id)
            .await
            .map_err(|error| error.to_string());
    }
    let workspace_paths = match workspace {
        Some(path) => Some(vec![path
            .canonicalize()
            .map_err(|error| format!("工作区不可用 {}：{error}", path.display()))?
            .to_string_lossy()
            .to_string()]),
        None => None,
    };
    client
        .create_conversation_session(&CreateConversationSessionRequest {
            session_id: None,
            workspace_paths,
            project_id: None,
            profile_id: profile_id.map(str::to_owned),
        })
        .await
        .map_err(|error| error.to_string())
}

async fn submit_input_and_wait(
    client: &HttpKernelClient,
    before: &SessionProjection,
    text: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_binding: Option<&PluginBinding>,
    plain: bool,
) -> Result<Outcome, String> {
    let command = contextual_input_command(
        before,
        text,
        profile_id,
        filesystem_references,
        plugin_binding,
    )?;
    submit_checked(client, &before.session_id, &command).await?;
    if matches!(
        command["type"].as_str(),
        Some("session.permissions.set" | "approval.revoke")
    ) {
        println!("权限设置已更新。");
        return Ok(Outcome::Done);
    }
    wait_for_projection(client, before, plain).await
}

fn contextual_input_command(
    projection: &SessionProjection,
    text: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_binding: Option<&PluginBinding>,
) -> Result<serde_json::Value, String> {
    conversation_input::contextual_input_command(
        i18n::Language::ZhCn,
        projection,
        text,
        &new_id("command"),
        profile_id,
        filesystem_references,
        plugin_binding.map_or("", |binding| binding.catalog_revision.as_str()),
        plugin_binding.map_or(&[], |binding| binding.selections.as_slice()),
    )
}

async fn submit_checked(
    client: &HttpKernelClient,
    session_id: &str,
    command: &serde_json::Value,
) -> Result<(), String> {
    let reply = client
        .submit_conversation_command(session_id, command)
        .await
        .map_err(|error| error.to_string())?;
    if reply.status == "rejected" {
        let error = reply
            .error
            .map(|value| format!("{}: {}", value.code, value.message))
            .unwrap_or_else(|| "命令被拒绝。".to_string());
        return Err(error);
    }
    Ok(())
}

async fn wait_for_projection(
    client: &HttpKernelClient,
    before: &SessionProjection,
    plain: bool,
) -> Result<Outcome, String> {
    let timeout = env::var("DEEPCODE_CLI_RUN_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_RUN_TIMEOUT);
    let deadline = Instant::now() + timeout;
    let session_id = &before.session_id;
    let mut output = if plain {
        CliRenderState::default()
    } else {
        CliRenderState::after(before)
    };
    loop {
        if Instant::now() >= deadline {
            output
                .finish_text(&mut io::stdout().lock())
                .map_err(|error| error.to_string())?;
            return Err("等待 Agent 运行结束超时。".to_string());
        }
        let projection = match client.conversation_projection(session_id).await {
            Ok(projection) => projection,
            Err(error) => {
                output
                    .finish_text(&mut io::stdout().lock())
                    .map_err(|error| error.to_string())?;
                return Err(error.to_string());
            }
        };
        if !plain {
            output
                .render(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
        }
        if let Some(run) = projection.run.as_ref() {
            if run.status == "waiting" {
                output
                    .render_action_required(&mut io::stdout().lock(), &projection)
                    .map_err(|error| error.to_string())?;
                return Ok(Outcome::ActionRequired);
            }
            if is_terminal_run_status(&run.status) {
                if plain && run.status == "completed" {
                    render::render_final_message(
                        &mut io::stdout().lock(),
                        &projection,
                        before.messages.len(),
                    )
                    .map_err(|error| error.to_string())?;
                } else if !plain {
                    let mut stdout = io::stdout().lock();
                    output
                        .finish_run(&mut stdout, &projection)
                        .map_err(|error| error.to_string())?;
                    render_run_state(&mut stdout, &projection)
                        .map_err(|error| error.to_string())?;
                    stdout.flush().map_err(|error| error.to_string())?;
                }
                render_terminal_error(&mut io::stderr().lock(), &projection)
                    .map_err(|error| error.to_string())?;
                return Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done));
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.map_err(|error| error.to_string())?;
                output.finish_text(&mut io::stdout().lock()).map_err(|error| error.to_string())?;
                if let Some(run) = projection.run.as_ref() {
                    let command = cancel_command(session_id, &new_id("command"), &run.run_id);
                    submit_checked(client, session_id, &command).await?;
                    eprintln!("已请求取消 run {}", run.run_id);
                }
                return Ok(Outcome::Interrupted);
            }
        }
    }
}

fn print_sessions(
    sessions: &[deepcode_kernel_client::ConversationSessionSummary],
    current: Option<&str>,
) {
    let language = i18n::Language::ZhCn;
    println!("{}", language.text("tui.sessionsTitle"));
    if sessions.is_empty() {
        println!("{}", language.text("tui.sessionsEmpty"));
    }
    for (index, session) in sessions.iter().enumerate() {
        println!(
            "{}",
            session_navigation::session_label(index + 1, session, current)
        );
    }
    println!("{}", language.text("tui.sessionsHint"));
}

async fn run_chat(
    client: &HttpKernelClient,
    session_id: Option<&str>,
    workspace: Option<&PathBuf>,
    initial_plugin_uris: &[String],
    initial_profile_id: Option<&str>,
) -> Result<Outcome, String> {
    if !io::stdin().is_terminal() {
        return Err("chat 需要交互式终端；非交互调用请使用 ask。".to_string());
    }
    let mut projection = open_session(client, session_id, workspace, initial_profile_id).await?;
    let mut plugin_catalog = client
        .conversation_plugin_catalog()
        .await
        .map_err(|error| error.to_string())?;
    let mut selected_plugins = if initial_plugin_uris.is_empty() {
        Vec::new()
    } else {
        plugin_binding_from_catalog(plugin_catalog.clone(), initial_plugin_uris)?.selections
    };
    println!("session: {}", projection.session_id);
    render_projection(&mut io::stdout().lock(), &projection).map_err(|error| error.to_string())?;
    println!("/sessions 列出会话；/resume <序号或完整 ID> 进入；/new 沿用启动目录新建；切换不会取消后台任务。");
    println!("普通文本随时发送，运行中按序排队；/reply <答复> 回应交互或修订 Plan，/reply 1 确认 Plan 或允许 effect，/reply 2 拒绝 effect；@ 显示插件，@<名称或 URI> 选择插件；/focus <task> 启动聚焦上下文；/attach <path> 与 /detach <workspace-id> 管理对话目录索引；/cancel-plan；/model <profile> 设置下一次 run 的模型；/cancel；/quit。");
    render_action_required_if_any(&mut io::stdout().lock(), &projection)
        .map_err(|error| error.to_string())?;
    let mut input_lines = chat_input_lines()?;
    let mut refresh = tokio::time::interval(POLL_INTERVAL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut output = CliRenderState::after(&projection);
    let mut rendered_revision = projection.revision;
    let mut session_list: Option<Vec<deepcode_kernel_client::ConversationSessionSummary>> = None;
    let mut next_message_profile_id: Option<String> = initial_profile_id.map(str::to_owned);
    let mut prompt_needed = true;
    loop {
        if prompt_needed {
            print!("deepcode> ");
            io::stdout().flush().map_err(|error| error.to_string())?;
            prompt_needed = false;
        }
        let line = tokio::select! {
            line = input_lines.recv() => line,
            _ = refresh.tick() => {
                let updated = refresh_projection(client, &projection.session_id).await?;
                output.render(&mut io::stdout().lock(), &updated).map_err(|error| error.to_string())?;
                if updated.revision != rendered_revision {
                    if updated.run.as_ref().is_some_and(|run| is_terminal_run_status(&run.status)) {
                        output.finish_run(&mut io::stdout().lock(), &updated).map_err(|error| error.to_string())?;
                        render_run_state(&mut io::stdout().lock(), &updated).map_err(|error| error.to_string())?;
                        render_terminal_error(&mut io::stderr().lock(), &updated).map_err(|error| error.to_string())?;
                    } else {
                        output.render_action_required(&mut io::stdout().lock(), &updated).map_err(|error| error.to_string())?;
                    }
                }
                rendered_revision = updated.revision;
                projection = updated;
                continue;
            }
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.map_err(|error| error.to_string())?;
                if let Some(run) = projection.run.as_ref().filter(|run| !is_terminal_run_status(&run.status)) {
                    submit_checked(client, &projection.session_id, &cancel_command(&projection.session_id, &new_id("command"), &run.run_id)).await?;
                }
                output.finish_text(&mut io::stdout().lock()).map_err(|error| error.to_string())?;
                return Ok(Outcome::Interrupted);
            }
        };
        let Some(line) = line else {
            return Ok(
                if projection.pending_plan.is_some()
                    || projection.pending_interaction.is_some()
                    || projection
                        .pending_approval
                        .as_ref()
                        .is_some_and(|approval| {
                            !approval.is_model_reviewing(projection.run.as_ref())
                        })
                {
                    Outcome::ActionRequired
                } else {
                    Outcome::Done
                },
            );
        };
        let line = line.map_err(|error| error.to_string())?;
        prompt_needed = true;
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        match input {
            "/quit" | "/exit" => return Ok(Outcome::Done),
            "/sessions" | "/resume" => {
                session_list = None;
                match client.conversation_catalog().await {
                    Ok(catalog) => {
                        let sessions = session_navigation::ordered_sessions(catalog);
                        print_sessions(&sessions, Some(&projection.session_id));
                        session_list = Some(sessions);
                    }
                    Err(error) => eprintln!("{error}"),
                }
            }
            value if value == "/new" || value.starts_with("/resume ") => {
                let target = if value == "/new" {
                    None
                } else {
                    match session_navigation::resolve_selector(
                        i18n::Language::ZhCn,
                        value.trim_start_matches("/resume ").trim(),
                        session_list.as_deref(),
                    ) {
                        Ok(id) => Some(id),
                        Err(error) => {
                            eprintln!("{error}");
                            continue;
                        }
                    }
                };
                if target.as_deref() == Some(projection.session_id.as_str()) {
                    continue;
                }
                match open_session(
                    client,
                    target.as_deref(),
                    if target.is_none() { workspace } else { None },
                    None,
                )
                .await
                {
                    Ok(next) => {
                        output
                            .finish_text(&mut io::stdout().lock())
                            .map_err(|error| error.to_string())?;
                        if let Some(notice) = session_navigation::background_notice(
                            i18n::Language::ZhCn,
                            Some(&projection),
                        ) {
                            println!("{notice}");
                        }
                        projection = next;
                        selected_plugins.clear();
                        next_message_profile_id = None;
                        output = CliRenderState::after(&projection);
                        rendered_revision = projection.revision;
                        println!("session: {}", projection.session_id);
                        render_projection(&mut io::stdout().lock(), &projection)
                            .map_err(|error| error.to_string())?;
                    }
                    Err(error) => eprintln!("{}: {error}", target.as_deref().unwrap_or("/new")),
                }
            }
            "/show" => render_projection(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?,
            "/cancel-plan" => {
                let plan = projection
                    .pending_plan
                    .as_ref()
                    .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
                let command = plan_cancel_command(&projection.session_id, &new_id("command"), plan);
                submit_checked(client, &projection.session_id, &command).await?;
                projection = refresh_projection(client, &projection.session_id).await?;
            }
            "/cancel" => {
                if let Some(run) = projection
                    .run
                    .as_ref()
                    .filter(|run| !is_terminal_run_status(&run.status))
                {
                    let command =
                        cancel_command(&projection.session_id, &new_id("command"), &run.run_id);
                    submit_checked(client, &projection.session_id, &command).await?;
                    projection = refresh_projection(client, &projection.session_id).await?;
                    render_run_state(&mut io::stdout().lock(), &projection)
                        .map_err(|error| error.to_string())?;
                }
            }
            "/model" | "/connections" => {
                model_services::connections(client).await?;
            }
            value if value.starts_with("/model ") => {
                let profile_id = value.trim_start_matches("/model ").trim();
                if profile_id.is_empty() {
                    println!("用法：/model <profile>");
                    continue;
                }
                next_message_profile_id = Some(profile_id.to_string());
                println!("后续普通消息将提交模型 Profile {profile_id}；当前 run 不变。");
            }
            value if value.starts_with("/attach ") => {
                let path = value.trim_start_matches("/attach ").trim();
                if path.is_empty() {
                    println!("用法：/attach <path>");
                    continue;
                }
                projection = client
                    .attach_conversation_directory_index(&projection.session_id, path)
                    .await
                    .map_err(|error| error.to_string())?;
                println!("目录索引已附加；从下一次 run 起使用当前有效目录集合。");
            }
            value if value.starts_with("/detach ") => {
                let workspace_id = value.trim_start_matches("/detach ").trim();
                if workspace_id.is_empty() {
                    println!("用法：/detach <workspace-id>");
                    continue;
                }
                projection = client
                    .detach_conversation_directory_index(&projection.session_id, workspace_id)
                    .await
                    .map_err(|error| error.to_string())?;
                println!("目录已移除，下次运行生效。");
            }
            value if value.starts_with('@') => {
                let query = value.trim_start_matches('@').trim();
                if query.is_empty() {
                    plugin_catalog = client
                        .conversation_plugin_catalog()
                        .await
                        .map_err(|error| error.to_string())?;
                    print_plugin_catalog(&plugin_catalog, &selected_plugins, "");
                    continue;
                }
                let exact = plugin_catalog.plugins.iter().find(|plugin| {
                    plugin.uri == query || plugin.display_name.eq_ignore_ascii_case(query)
                });
                if let Some(plugin) = exact {
                    if let Some(error) = plugin_unavailable_reason(plugin) {
                        println!("{error}");
                        continue;
                    }
                    if selected_plugins
                        .iter()
                        .any(|selection| selection.uri == plugin.uri)
                    {
                        println!("插件已为下一次请求选择：{}", plugin.display_name);
                    } else {
                        selected_plugins.push(PluginSelectionInput {
                            selection_id: new_id("plugin-selection"),
                            uri: plugin.uri.clone(),
                            label: plugin.display_name.clone(),
                        });
                        println!("已为下一次请求选择插件：{}", plugin.display_name);
                    }
                } else {
                    print_plugin_catalog(&plugin_catalog, &selected_plugins, query);
                }
            }
            text if !text.starts_with('/')
                || text == "/focus"
                || text.starts_with("/focus ")
                || text == "/reply"
                || text.starts_with("/reply ")
                || text.starts_with("/permissions ")
                || text.starts_with("/revoke ") =>
            {
                let consumes_plugins = !text.starts_with("/reply")
                    && !text.starts_with("/permissions ")
                    && !text.starts_with("/revoke ");
                let plugin_binding = if selected_plugins.is_empty() || !consumes_plugins {
                    None
                } else {
                    Some(PluginBinding {
                        catalog_revision: plugin_catalog.revision.clone(),
                        selections: selected_plugins.clone(),
                    })
                };
                let command = match contextual_input_command(
                    &projection,
                    line.trim_end_matches(['\r', '\n']),
                    next_message_profile_id.as_deref(),
                    &[],
                    plugin_binding.as_ref(),
                ) {
                    Ok(command) => command,
                    Err(error) => {
                        eprintln!("{error}");
                        continue;
                    }
                };
                if let Err(error) = submit_checked(client, &projection.session_id, &command).await {
                    eprintln!("{error}");
                    continue;
                }
                if consumes_plugins {
                    selected_plugins.clear();
                }
                projection = refresh_projection(client, &projection.session_id).await?;
            }
            value if value.starts_with('/') => println!("未知命令：{value}"),
            _ => unreachable!("all non-slash input is handled above"),
        }
    }
}

fn chat_input_lines() -> Result<tokio::sync::mpsc::Receiver<io::Result<String>>, String> {
    let (sender, receiver) = tokio::sync::mpsc::channel(16);
    // The chat process owns this blocking reader; process exit releases stdin.
    std::thread::Builder::new()
        .name("chat-stdin".into())
        .spawn(move || loop {
            let mut line = String::new();
            match io::stdin().read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if sender.blocking_send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(receiver)
}

fn plugin_unavailable_reason(plugin: &PluginCatalogItem) -> Option<String> {
    if plugin.available && plugin.enabled {
        return None;
    }
    Some(match &plugin.error {
        Some(error) => format!(
            "{}：{} ({})",
            plugin.display_name, error.message, error.code
        ),
        None => format!("插件不可用：{}", plugin.display_name),
    })
}

fn print_plugin_catalog(
    catalog: &PluginCatalogProjection,
    selected: &[PluginSelectionInput],
    query: &str,
) {
    let query = query.to_lowercase();
    let matches = catalog.plugins.iter().filter(|plugin| {
        (query.is_empty() && plugin.discovery == "default")
            || (!query.is_empty()
                && (plugin.display_name.to_lowercase().contains(&query)
                    || plugin.uri.to_lowercase().contains(&query)
                    || plugin.short_description.to_lowercase().contains(&query)))
    });
    let mut found = false;
    for plugin in matches {
        found = true;
        let marker = if selected.iter().any(|selection| selection.uri == plugin.uri) {
            "*"
        } else {
            " "
        };
        println!(
            "{marker} {}\n    {}\n    {}",
            plugin.display_name, plugin.uri, plugin.short_description
        );
        if let Some(error) = plugin_unavailable_reason(plugin) {
            println!("    {error}");
        }
    }
    if !found {
        println!("没有匹配的可用插件。");
    } else {
        println!("输入 @<完整名称或 plugin:// URI> 为下一次请求选择插件。");
    }
}

async fn refresh_projection(
    client: &HttpKernelClient,
    session_id: &str,
) -> Result<SessionProjection, String> {
    client
        .conversation_projection(session_id)
        .await
        .map_err(|error| error.to_string())
}

fn outcome_for_projection(projection: &SessionProjection) -> Option<Outcome> {
    outcome_for_status(&projection.run.as_ref()?.status)
}

fn outcome_for_status(status: &str) -> Option<Outcome> {
    match status {
        "failed" | "releaseFailed" => Some(Outcome::Failed),
        "indeterminate" => Some(Outcome::Indeterminate),
        "completed" => Some(Outcome::Done),
        "cancelled" => Some(Outcome::Cancelled),
        "waiting" => Some(Outcome::ActionRequired),
        _ => None,
    }
}

fn require_session(session_id: Option<&str>) -> Result<&str, String> {
    session_id.ok_or_else(|| "该命令需要 --session <id>。".to_string())
}

fn required_arg<'a>(values: &'a [String], index: usize, option: &str) -> Result<&'a str, String> {
    values
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("{option} 缺少参数。"))
}

fn new_id(kind: &str) -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{kind}:{}:{clock:x}:{sequence:x}", std::process::id())
}

fn print_help() {
    println!("模型服务：connections | auth login <connection-id|openai-codex> [browser|device] | auth status | auth logout <id> | quota <id> | usage [connection-id|all] [days=30]\nask/chat 支持 --model <profile-id>；usage 使用 UTC 日界线。");
    println!(
        r#"DeepCode 本地编码 Agent

用法：
  deepcode-cli ask [-C <workspace>] [--session <id>] [--file <path>]... [--directory <path>]... [--plugin <plugin://uri>]... [--plain] <message-or-response>
  deepcode-cli chat [-C <workspace>] [--session <id>] [--plugin <plugin://uri>]...
  deepcode-cli sessions
  deepcode-cli new [-C <workspace>]
  deepcode-cli resume <完整 session: ID>
  deepcode-cli show --session <id>
  deepcode-cli read --session <id> [--view summary|messages|tools|plans|context|reasoning] [--before <sequence>] [--limit 1..50] [--record <id>] [--request <id>]
  deepcode-cli cancel-plan --session <id>
  deepcode-cli cancel --session <id> <run-id>
  deepcode-cli attach-directory --session <id> <path>
  deepcode-cli detach-directory --session <id> <workspace-id>
  deepcode-cli open-resource --session <id> <workspace-id> <logical-path>
  deepcode-cli diff --session <id> <record-id> <file-index>
  deepcode-cli start-host
  deepcode-cli stop-host
  deepcode-cli status

使用 -C/--workspace 为新对话指定工作目录；已有对话通过 attach-directory/detach-directory 管理目录。
chat 内 /sessions 列表，/resume <序号或完整 ID> 进入，/new 沿用启动目录新建；切换不会取消原会话或复制权限。序号仅对应本进程最后显示的列表。
chat 普通文本随时发送，运行中按序排队；/reply 1 确认计划，/reply <说明> 修改计划或回答问题，/reply 1/2 允许/拒绝操作；cancel-plan 取消计划。
权限请求提供时，/reply 3 本轮允许相同命令，/reply 4 本轮允许 Host Shell。/permissions <JSON> 修改当前任务权限；/revoke <authority-id> 撤销本轮授权。
文件与目录引用只在 ask 中显式选择；--file 与 --directory 均可重复。图片以视觉内容发送给支持图片的模型，其他文件保留只读引用。
ask/chat 支持重复使用 --plugin 指定插件；Agent 也可按任务发现并加载已启用插件。PDF 文件需要已配置且支持 PDF 的 Skill。chat 使用 @ 选择下一次请求的插件，/focus <task> 开始任务。"#,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation_input::fixtures::{pending_decisions, waiting_projection};

    #[test]
    fn session_commands_parse_without_rebinding_existing_workspaces() {
        let parse =
            |args: &[&str]| Args::parse(args.iter().map(|value| value.to_string()).collect());
        assert_eq!(parse(&["sessions"]).unwrap().command, Command::Sessions);
        let new = parse(&["new", "-C", "/project"]).unwrap();
        assert_eq!(new.command, Command::Chat);
        assert!(new.session_id.is_none());
        assert_eq!(
            parse(&["resume", "session:known"])
                .unwrap()
                .session_id
                .as_deref(),
            Some("session:known")
        );
        for args in [
            &["resume", "1"][..],
            &["resume", "session:x", "-C", "/other"],
            &["new", "--session", "session:x"],
            &["sessions", "--session", "session:x"],
        ] {
            assert!(parse(args).is_err());
        }
    }

    #[tokio::test]
    async fn long_focus_upload_preserves_the_task_and_existing_references() {
        use deepcode_kernel_client::KernelClientConfig;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = HttpKernelClient::new(
            KernelClientConfig::new(format!("http://{}", listener.local_addr().unwrap()))
                .with_host_shell_token(format!("dchost_{}", "01".repeat(32))),
        )
        .unwrap();
        let task = "完整保留中文任务🙂\n".repeat(2000);
        assert!(task.len() > 32 * 1024);
        let existing = json!({
            "referenceId":"reference:existing", "workspaceId":"workspace:existing",
            "logicalPath":"notes.txt", "displayName":"notes.txt", "kind":"file",
            "mediaType":"text/plain", "byteLength":12,
        });
        let uploaded = json!({
            "referenceId":"reference:uploaded", "workspaceId":"workspace:uploaded",
            "logicalPath":"user-input.txt", "displayName":"完整任务", "kind":"file",
            "mediaType":"text/plain", "byteLength":task.len(), "source":"pastedText",
        });
        let mut command = deepcode_kernel_client::focus_command(
            "session:focus",
            "command:focus",
            &task,
            None,
            &[],
            "",
            &[],
        );
        command["filesystemReferences"] = json!([existing.clone()]);
        let server = async {
            for operation in ["input-resources/command:focus", "commands"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                let (start, length) = loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        assert!(headers.starts_with(&format!(
                            "POST /api/conversation/sessions/session:focus/{operation} HTTP/1.1"
                        )));
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while request.len() < start + length {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let body = &request[start..start + length];
                let response = if operation != "commands" {
                    assert_eq!(body, task.as_bytes(), "upload keeps the complete original task");
                    json!({"ok":true, "data":{"text":"", "reference":uploaded}})
                } else {
                    let submitted: Value = serde_json::from_slice(body).unwrap();
                    assert_eq!(submitted["type"], "context.focus");
                    assert_eq!(submitted["commandId"], "command:focus");
                    assert_eq!(submitted["sessionId"], "session:focus");
                    assert_eq!(submitted["filesystemReferences"], json!([existing, uploaded]));
                    let accepted = submitted["task"].as_str().is_some_and(|task| !task.trim().is_empty());
                    json!({"ok":true, "data":{
                        "schemaVersion":"deepcode.command-reply.v3", "commandId":"command:focus",
                        "sessionId":"session:focus", "revision":1,
                        "status":if accepted { "accepted" } else { "rejected" },
                        "error":if accepted { Value::Null } else {
                            json!({"code":"conversation_command_invalid", "message":"Focus task must not be empty."})
                        },
                    }})
                }.to_string();
                socket.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len(),
                ).as_bytes()).await.unwrap();
            }
        };
        let (_, reply) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(
                server,
                client.submit_conversation_command("session:focus", &command)
            )
        })
        .await
        .expect("owned upload and command exchange finishes");
        let reply = reply.unwrap();
        assert_eq!(reply.status, "accepted");
        assert!(reply.error.is_none());
    }

    #[test]
    fn pending_plain_input_queues_while_explicit_reply_keeps_decision_semantics() {
        for (field, decision, command_type, response_field, expected) in pending_decisions() {
            let projection = waiting_projection(field, decision);
            let ordinary =
                contextual_input_command(&projection, "1", Some("profile:next"), &[], None)
                    .unwrap();
            assert_eq!(ordinary["type"], "message.submit");
            assert_eq!(ordinary["runId"], "run:test");
            assert_eq!(ordinary["text"], "1");
            assert!(ordinary.get("profileId").is_none());
            let reply = contextual_input_command(&projection, "/reply 1", None, &[], None).unwrap();
            assert_eq!(reply["type"], command_type);
            assert_eq!(reply[response_field], expected);
            if field == "pendingPlan" {
                let revision =
                    contextual_input_command(&projection, "/reply clarify scope", None, &[], None)
                        .unwrap();
                assert_eq!(
                    revision["response"],
                    json!({"kind":"requestRevision","text":"clarify scope"})
                );
            }
        }
    }

    #[test]
    fn unavailable_plugin_selection_preserves_the_catalog_error() {
        let catalog: PluginCatalogProjection = serde_json::from_value(json!({"revision":"catalog:test", "plugins":[{
            "source":"mounted","category":"functional","contributionKind":"mcp","discovery":"default",
            "uri":"plugin://broken@mcp", "displayName":"Broken", "shortDescription":"Broken entry", "activationMediaTypes":[],
            "enabled":false,"available":false,"error":{"code":"plugin_manifest_invalid","message":"manifest parse failed"}
        }]})).unwrap();
        let error = plugin_binding_from_catalog(catalog, &["plugin://broken@mcp".into()])
            .err()
            .unwrap();
        assert!(error.contains("plugin_manifest_invalid"));
        assert!(error.contains("manifest parse failed"));
    }

    #[test]
    fn explicit_host_commands_parse_without_starting_a_conversation() {
        assert_eq!(
            Args::parse(vec!["start-host".into()]).unwrap().command,
            Command::StartHost
        );
        assert_eq!(
            Args::parse(vec!["stop-host".into()]).unwrap().command,
            Command::StopHost
        );
    }

    #[test]
    fn ask_parser_keeps_explicit_workspace_and_message() {
        let args = Args::parse(vec![
            "ask".into(),
            "-C".into(),
            "/tmp/project".into(),
            "解释".into(),
            "代码".into(),
        ])
        .expect("ask parses");
        assert_eq!(args.workspace, Some(PathBuf::from("/tmp/project")));
        assert_eq!(args.command, Command::Ask("解释 代码".to_string()));
    }

    #[test]
    fn ask_parser_keeps_repeatable_filesystem_references() {
        let args = Args::parse(vec![
            "ask".into(),
            "--file".into(),
            "/tmp/report.pdf".into(),
            "--file".into(),
            "/tmp/notes.txt".into(),
            "--directory".into(),
            "/tmp/project".into(),
            "检查引用".into(),
        ])
        .expect("ask references parse");
        assert_eq!(args.files, ["/tmp/report.pdf", "/tmp/notes.txt"]);
        assert_eq!(args.directories, ["/tmp/project"]);
        assert_eq!(args.command, Command::Ask("检查引用".to_string()));
    }

    #[test]
    fn no_workspace_is_implicit() {
        let args = Args::parse(vec!["ask".into(), "解释".into()]).expect("ask parses");
        assert_eq!(args.workspace, None);
    }

    #[test]
    fn existing_session_rejects_workspace_rebinding() {
        assert!(Args::parse(vec![
            "ask".into(),
            "--session".into(),
            "s".into(),
            "-C".into(),
            "/tmp/project".into(),
            "继续".into(),
        ])
        .is_err());
    }

    #[test]
    fn direct_tool_commands_are_not_exposed() {
        assert!(Args::parse(vec!["tools".into(), "run".into(), "fs.write".into()]).is_err());
    }

    #[test]
    fn open_resource_parser_keeps_workspace_identity_and_logical_path() {
        let args = Args::parse(vec![
            "open-resource".into(),
            "--session".into(),
            "session:test".into(),
            "workspace:test".into(),
            "docs/设计 说明.md".into(),
        ])
        .expect("open-resource parses");
        assert_eq!(args.session_id.as_deref(), Some("session:test"));
        assert_eq!(
            args.command,
            Command::OpenResource {
                workspace_id: "workspace:test".to_string(),
                logical_path: "docs/设计 说明.md".to_string(),
                start_byte: None,
            }
        );
    }

    #[test]
    fn failed_indeterminate_and_cancelled_are_distinct_nonzero_cli_outcomes() {
        assert_eq!(outcome_for_status("failed"), Some(Outcome::Failed));
        assert_eq!(outcome_for_status("releaseFailed"), Some(Outcome::Failed));
        assert_eq!(
            outcome_for_status("indeterminate"),
            Some(Outcome::Indeterminate)
        );
        assert_eq!(outcome_for_status("cancelled"), Some(Outcome::Cancelled));
        assert_ne!(EXIT_RUN_FAILED, 0);
        assert_ne!(EXIT_RUN_INDETERMINATE, 0);
        assert_ne!(EXIT_RUN_CANCELLED, 0);
        assert_ne!(EXIT_RUN_FAILED, EXIT_RUN_INDETERMINATE);
        assert_ne!(EXIT_RUN_FAILED, EXIT_RUN_CANCELLED);
        assert_ne!(EXIT_RUN_INDETERMINATE, EXIT_RUN_CANCELLED);
    }
}
