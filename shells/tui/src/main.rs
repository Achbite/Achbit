mod app;
#[path = "../../shared/conversation_input.rs"]
mod conversation_input;
#[path = "../../shared/i18n.rs"]
mod i18n;
use i18n::Language;
mod markdown;
mod renderer;
#[path = "../../shared/session_navigation.rs"]
mod session_navigation;

use app::{TuiApp, TuiHostOptions};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event as CrosstermEvent, KeyCode,
        KeyEventKind, KeyModifiers, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use deepcode_kernel_client::{KernelBootstrap, KernelBootstrapOptions};
use renderer::Renderer;
use std::{
    env,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    time::Duration,
};

const EXIT_ACTION_REQUIRED: i32 = 5;

#[tokio::main]
async fn main() {
    let values: Vec<String> = env::args().skip(1).collect();
    // Language used before connecting only affects startup diagnostics.
    let mut language = startup_language(&values);
    let args = match Args::parse(values) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            print_help(language);
            std::process::exit(2);
        }
    };
    if args.help {
        print_help(language);
        return;
    }
    let bootstrap = match KernelBootstrap::connect(
        KernelBootstrapOptions::new(args.api).auto_start(!args.no_auto_start_kernel),
    )
    .await
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!(
                "{}",
                language.format("tui.connectionFailed", &[error.to_string()])
            );
            std::process::exit(1);
        }
    };
    language = match language_for_app(bootstrap.client(), args.language).await {
        Ok(language) => language,
        Err(error) => {
            eprintln!("{}", language.format("tui.settingsReadFailed", &[error]));
            std::process::exit(1);
        }
    };
    let mut app = TuiApp::new(
        bootstrap.client().clone(),
        Renderer::default(),
        TuiHostOptions {
            language,
            workspace_path: args.workspace,
            session_id: args.session_id,
            plugin_uris: args.plugins,
        },
    );
    let interactive = !args.smoke && io::stdin().is_terminal() && io::stdout().is_terminal();
    if !interactive {
        if let Err(error) = app.bootstrap().await {
            eprintln!("{}", language.format("tui.initializationFailed", &[error]));
            std::process::exit(1);
        }
    }

    if args.smoke {
        print!("{}", app.renderer().render_plain(&app));
        return;
    }

    let result = if interactive {
        run_terminal(app).await.map(|_| None)
    } else {
        run_plain(app).await
    };
    match result {
        Ok(Some(message)) => {
            eprintln!("{message}");
            std::process::exit(EXIT_ACTION_REQUIRED);
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("{}", language.format("tui.failed", &[error.to_string()]));
            std::process::exit(1);
        }
    }
}

fn startup_language(values: &[String]) -> Language {
    values
        .windows(2)
        .filter(|pair| pair[0] == "--language")
        .filter_map(|pair| Language::parse(&pair[1]))
        .last()
        .unwrap_or_default()
}

async fn language_for_app(
    client: &deepcode_kernel_client::HttpKernelClient,
    explicit: Option<Language>,
) -> Result<Language, String> {
    if let Some(language) = explicit {
        return Ok(language);
    }
    let settings = client
        .user_settings()
        .await
        .map_err(|error| error.to_string())?;
    Language::from_settings(&settings)
}

struct Args {
    language: Option<Language>,
    api: Option<String>,
    help: bool,
    smoke: bool,
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    plugins: Vec<String>,
    no_auto_start_kernel: bool,
}

impl Args {
    fn parse(values: Vec<String>) -> Result<Self, String> {
        let language = startup_language(&values);
        let mut parsed = Self {
            language: None,
            api: None,
            help: false,
            smoke: false,
            workspace: None,
            session_id: None,
            plugins: Vec::new(),
            no_auto_start_kernel: false,
        };
        let mut index = 0;
        while index < values.len() {
            match values[index].as_str() {
                "--help" | "-h" => parsed.help = true,
                "--smoke" => parsed.smoke = true,
                "--language" => {
                    index += 1;
                    let value = required_arg(language, &values, index, "--language")?;
                    parsed.language = Some(Language::parse(value).ok_or_else(|| {
                        language.format("tui.languageInvalid", &[value.to_string()])
                    })?);
                }
                "--api" => {
                    index += 1;
                    parsed.api = Some(required_arg(language, &values, index, "--api")?.to_string());
                }
                "--no-auto-start-kernel" => parsed.no_auto_start_kernel = true,
                "--workspace" | "-C" => {
                    index += 1;
                    parsed.workspace = Some(PathBuf::from(required_arg(
                        language,
                        &values,
                        index,
                        "--workspace",
                    )?));
                }
                "--session" => {
                    index += 1;
                    parsed.session_id =
                        Some(required_arg(language, &values, index, "--session")?.to_string());
                }
                "--plugin" => {
                    index += 1;
                    parsed
                        .plugins
                        .push(required_arg(language, &values, index, "--plugin")?.to_string());
                }
                value => return Err(language.format("tui.unknownOption", &[value.to_string()])),
            }
            index += 1;
        }
        if parsed.session_id.is_some() && parsed.workspace.is_some() {
            return Err(language.text("tui.sessionWorkspaceConflict").to_string());
        }
        Ok(parsed)
    }
}

async fn run_terminal(mut app: TuiApp) -> io::Result<()> {
    let language = app.language();
    let _guard = TerminalGuard::enter()?;
    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    terminal.clear()?;
    // The existing initialization view is visible before selected history is read.
    terminal.draw(|frame| app.renderer().draw(frame, &app))?;
    let mut input_task = spawn_terminal_event_task();
    let initialization = {
        let initialize = app.bootstrap();
        tokio::pin!(initialize);
        loop {
            tokio::select! {
                result = &mut initialize => break result.map(|_| true).map_err(|error| {
                    io::Error::other(language.format("tui.initializationFailed", &[error]))
                }),
                result = &mut input_task => {
                    input_task = spawn_terminal_event_task();
                    match terminal_event_result(language, result) {
                        Ok(Some(CrosstermEvent::Key(key))) if key.kind == KeyEventKind::Press
                            && key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL) => break Ok(false),
                        Err(error) => break Err(error),
                        _ => {}
                    }
                }
            }
        }
    };
    if !matches!(initialization, Ok(true)) {
        let pump = terminal_event_result(language, input_task.await).map(|_| ());
        return initialization.map(|_| ()).and(pump);
    }
    let mut refresh = tokio::time::interval(Duration::from_millis(150));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let loop_result = async {
        loop {
            terminal.draw(|frame| app.renderer().draw(frame, &app))?;
            let event_task_result = tokio::select! {
                result = &mut input_task => Some(result),
                _ = refresh.tick() => {
                    tokio::select! {
                        result = &mut input_task => Some(result),
                        _ = app.poll() => None,
                    }
                }
            };
            let Some(event_task_result) = event_task_result else {
                continue;
            };
            input_task = spawn_terminal_event_task();
            let Some(next_event) = terminal_event_result(language, event_task_result)? else {
                continue;
            };
            let keep_running = match next_event {
                CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        app.interrupt().await;
                        false
                    }
                    KeyCode::Esc => {
                        if app.agent_picker_open() {
                            app.close_agent_picker();
                        } else if app.viewing_agent() {
                            app.back_from_agent();
                            app.poll().await;
                        } else if app.session_picker_open() {
                            app.close_session_picker();
                        } else if app.model_picker_open() {
                            app.model_picker_back();
                        } else if app.plugin_picker_open() {
                            app.dismiss_plugin_picker();
                        } else {
                            app.clear_input();
                        }
                        true
                    }
                    KeyCode::Backspace => {
                        app.backspace_input();
                        true
                    }
                    KeyCode::Enter => {
                        if app.agent_picker_open() {
                            app.select_agent().await;
                            true
                        } else if app.session_picker_open() {
                            app.session_picker_select().await;
                            true
                        } else if app.model_picker_open() {
                            app.model_picker_select();
                            true
                        } else if app.plugin_picker_open() && app.plugin_picker_select() {
                            true
                        } else {
                            let input = app.take_input();
                            app.submit_line(&input).await
                        }
                    }
                    KeyCode::Tab => {
                        if app.session_picker_open() {
                            app.session_picker_move(1);
                        } else if app.model_picker_open() {
                            app.model_picker_select();
                        } else if app.plugin_picker_open() {
                            app.plugin_picker_select();
                        } else {
                            app.push_input('\t');
                        }
                        true
                    }
                    KeyCode::Up if app.agent_picker_open() => {
                        app.agent_picker_move(-1);
                        true
                    }
                    KeyCode::Down if app.agent_picker_open() => {
                        app.agent_picker_move(1);
                        true
                    }
                    KeyCode::Up if app.session_picker_open() => {
                        app.session_picker_move(-1);
                        true
                    }
                    KeyCode::Down if app.session_picker_open() => {
                        app.session_picker_move(1);
                        true
                    }
                    KeyCode::Up if app.model_picker_open() => {
                        app.model_picker_move(-1);
                        true
                    }
                    KeyCode::Down if app.model_picker_open() => {
                        app.model_picker_move(1);
                        true
                    }
                    KeyCode::Up if app.plugin_picker_open() => {
                        app.plugin_picker_move(-1);
                        true
                    }
                    KeyCode::Down if app.plugin_picker_open() => {
                        app.plugin_picker_move(1);
                        true
                    }
                    KeyCode::PageDown => {
                        app.scroll_content(true);
                        true
                    }
                    KeyCode::PageUp => {
                        app.scroll_content(false);
                        true
                    }
                    KeyCode::Char(value) => {
                        app.push_input(value);
                        true
                    }
                    _ => true,
                },
                CrosstermEvent::Paste(text) => {
                    app.push_input_text(&text);
                    true
                }
                CrosstermEvent::Mouse(mouse) => {
                    match mouse.kind {
                        MouseEventKind::ScrollUp => app.scroll_lines(false, 4),
                        MouseEventKind::ScrollDown => app.scroll_lines(true, 4),
                        _ => {}
                    }
                    true
                }
                _ => true,
            };
            if !keep_running {
                break Ok(());
            }
        }
    }
    .await;
    let pump_result = terminal_event_result(language, input_task.await).map(|_| ());
    match loop_result {
        Err(error) => Err(error),
        Ok(()) => pump_result,
    }
}

fn spawn_terminal_event_task() -> tokio::task::JoinHandle<io::Result<Option<CrosstermEvent>>> {
    tokio::task::spawn_blocking(|| {
        if event::poll(Duration::from_millis(150))? {
            event::read().map(Some)
        } else {
            Ok(None)
        }
    })
}

fn terminal_event_result(
    language: Language,
    result: Result<io::Result<Option<CrosstermEvent>>, tokio::task::JoinError>,
) -> io::Result<Option<CrosstermEvent>> {
    result.map_err(|error| {
        io::Error::other(language.format("tui.terminalEventFailed", &[error.to_string()]))
    })?
}

async fn run_plain(mut app: TuiApp) -> io::Result<Option<String>> {
    print!("{}", app.renderer().render_plain(&app));
    let (sender, mut lines) = tokio::sync::mpsc::channel(16);
    // This plain-shell process owns stdin; process exit releases a blocked reader.
    std::thread::Builder::new()
        .name("plain-stdin".into())
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
        })?;
    let mut refresh = tokio::time::interval(Duration::from_millis(150));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut input_closed = false;
    let mut prompt_needed = true;
    loop {
        if input_closed && !app.is_run_pending() {
            print!("{}", app.renderer().render_plain(&app));
            return Ok(app.action_required());
        }
        if prompt_needed && !input_closed {
            print!("DeepCode TUI> ");
            io::stdout().flush()?;
            prompt_needed = false;
        }
        tokio::select! {
            line = lines.recv(), if !input_closed => {
                let Some(line) = line else { input_closed = true; continue; };
                if !app.submit_line(line?.trim_end_matches(['\r', '\n'])).await {
                    return Ok(None);
                }
                print!("{}", app.renderer().render_plain(&app));
                prompt_needed = true;
            }
            _ = refresh.tick() => {
                let was_pending = app.is_run_pending();
                app.poll().await;
                if was_pending && !app.is_run_pending() {
                    print!("{}", app.renderer().render_plain(&app));
                }
            }
            interrupted = tokio::signal::ctrl_c() => {
                interrupted?;
                app.interrupt().await;
                return Ok(None);
            }
        }
    }
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture) {
            let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(error);
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

fn required_arg<'a>(
    language: Language,
    values: &'a [String],
    index: usize,
    option: &str,
) -> Result<&'a str, String> {
    values
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| language.format("tui.missingArgument", &[option.to_string()]))
}

fn print_help(language: Language) {
    println!("{}", language.text("tui.help"));
}

#[cfg(test)]
mod tests {
    use super::Args;

    #[test]
    fn repeatable_plugins_are_request_scoped_arguments() {
        let args = Args::parse(vec![
            "--plugin".into(),
            "plugin://github@builtin".into(),
            "--plugin".into(),
            "plugin://pdf@builtin".into(),
        ])
        .expect("plugins parse");
        assert_eq!(
            args.plugins,
            vec![
                "plugin://github@builtin".to_string(),
                "plugin://pdf@builtin".to_string()
            ]
        );
    }

    #[test]
    fn language_argument_selects_help_and_rejects_invalid_values() {
        use super::{startup_language, Language};
        for (locale, language, usage) in [
            ("zh-CN", Language::ZhCn, "用法："),
            ("en-US", Language::EnUs, "Usage:"),
        ] {
            let values = vec!["--help".into(), "--language".into(), locale.into()];
            assert_eq!(startup_language(&values), language);
            let args = Args::parse(values).unwrap();
            assert_eq!(args.language, Some(language));
            assert!(args.help);
            assert!(language.text("tui.help").contains(usage));
            assert!(language.text("tui.help").contains("--language zh-CN|en-US"));
        }
        assert_eq!(Args::parse(vec![]).unwrap().language, None);
        assert!(Args::parse(vec!["--language".into()]).is_err());
        assert!(Args::parse(vec!["--language".into(), "fr-FR".into()]).is_err());
        assert!(Args::parse(vec![
            "--language".into(),
            "en-US".into(),
            "--unknown".into()
        ])
        .err()
        .unwrap()
        .contains("Unknown option: --unknown"));
    }

    #[tokio::test]
    async fn explicit_language_bypasses_settings_but_read_failure_is_returned() {
        use super::{language_for_app, Language};
        use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig};
        let client = HttpKernelClient::new(
            KernelClientConfig::new("http://127.0.0.1:0")
                .with_host_shell_token(format!("dchost_{}", "01".repeat(32))),
        )
        .unwrap();
        assert_eq!(
            language_for_app(&client, Some(Language::EnUs)).await,
            Ok(Language::EnUs)
        );
        assert!(language_for_app(&client, None).await.is_err());
    }
}
