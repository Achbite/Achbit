use crate::i18n::Language;
use crate::renderer::Renderer;
use achbit_kernel_client::{
    cancel_command, is_terminal_run_status, plan_cancel_command, ConversationResourceReadResult,
    ConversationSessionSummary, CreateConversationSessionRequest, HttpKernelClient,
    PluginCatalogItem, PluginCatalogProjection, PluginSelectionInput, SessionProjection,
};
use crossterm::event::KeyCode;
use serde_json::json;
use std::cell::Cell;
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

fn agent_status_key(status: achbit_kernel_client::AgentTaskStatus) -> &'static str {
    use achbit_kernel_client::AgentTaskStatus::*;
    match status {
        Running => "agent.team.status.running",
        Completed => "agent.team.status.completed",
        Failed => "agent.team.status.failed",
        Cancelled => "agent.team.status.cancelled",
        Indeterminate => "agent.team.status.indeterminate",
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// Presentation metadata for the existing submit_line commands. Completion never executes them.
const COMMANDS: &[(&str, &str, bool)] = &[
    ("/help", "tui.command.help", false),
    ("/new", "tui.command.new", false),
    ("/sessions", "tui.command.sessions", false),
    ("/resume", "tui.command.resume", false),
    ("/model", "tui.command.model", false),
    ("/connection", "tui.command.model", false),
    ("/context", "tui.command.context", false),
    ("/font", "tui.command.font", false),
    ("/language", "tui.command.language", false),
    ("/tasks", "tui.command.tasks", false),
    ("/agents", "tui.command.agents", false),
    ("/agent", "tui.command.agent", true),
    ("/back", "tui.command.back", false),
    ("/focus", "tui.command.focus", true),
    ("/reply", "tui.command.reply", true),
    ("/attach", "tui.command.attach", true),
    ("/detach", "tui.command.detach", true),
    ("/open", "tui.command.open", true),
    ("/next", "tui.command.next", false),
    ("/diff", "tui.command.diff", true),
    ("/reasoning", "tui.command.reasoning", false),
    ("/reasoning-history", "tui.command.reasoningHistory", false),
    ("/tool", "tui.command.tool", true),
    ("/show", "tui.command.show", false),
    ("/error", "tui.command.error", false),
    ("/decision", "tui.command.decision", false),
    ("/permissions", "tui.command.permissions", true),
    ("/revoke", "tui.command.revoke", true),
    ("/cancel", "tui.command.cancel", false),
    ("/cancel-plan", "tui.command.cancelPlan", false),
    ("/close", "tui.command.close", false),
    ("/clear", "tui.command.clear", false),
    ("/quit", "tui.command.quit", false),
    ("/exit", "tui.command.quit", false),
];

pub struct CommandPickerEntry {
    pub command: &'static str,
    pub description: &'static str,
    pub highlighted: bool,
}

#[derive(Debug, Clone)]
pub struct TuiHostOptions {
    pub language: Language,
    pub workspace_path: Option<PathBuf>,
    pub session_id: Option<String>,
    pub plugin_uris: Vec<String>,
}

#[derive(Debug, Clone)]
struct PluginPickerState {
    trigger_start: usize,
    query: String,
    selected_index: usize,
}

#[derive(Debug, Clone)]
struct SelectedMention {
    uri: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
pub struct PluginPickerEntry {
    pub display_name: String,
    pub short_description: String,
    pub uri: String,
    pub highlighted: bool,
    pub already_selected: bool,
}

#[derive(Clone)]
struct ModelPicker {
    connection_id: Option<String>,
    selected: usize,
}

struct AgentReturnView {
    projection: SessionProjection,
    input: String,
    transcript_scroll: Option<usize>,
}

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    host: TuiHostOptions,
    projection: Option<SessionProjection>,
    input: String,
    input_failed: bool,
    command_picker: Option<usize>,
    recent_commands: VecDeque<&'static str>,
    initialized: bool,
    status: String,
    connection_error: Option<String>,
    next_message_profile_id: Option<String>,
    model_connections: Option<achbit_kernel_client::ModelConnections>,
    model_profiles: Vec<achbit_kernel_client::ModelProfile>,
    model_picker: Option<ModelPicker>,
    session_list: Option<Vec<ConversationSessionSummary>>,
    session_picker: Option<usize>,
    agent_picker: Option<usize>,
    agent_return_views: Vec<AgentReturnView>,
    plugin_catalog: Option<PluginCatalogProjection>,
    selected_plugins: Vec<PluginSelectionInput>,
    selected_mentions: Vec<SelectedMention>,
    plugin_picker: Option<PluginPickerState>,
    resource_preview: Option<ConversationResourceReadResult>,
    context_open: bool,
    tasks_open: bool,
    detail_preview: Option<String>,
    tool_detail: Option<(String, String)>,
    reasoning_enabled: bool,
    detail_scroll: Cell<u16>,
    detail_scroll_max: Cell<u16>,
    viewport_height: Cell<u16>,
    transcript_scroll: Cell<Option<usize>>,
    transcript_scroll_max: Cell<usize>,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer, host: TuiHostOptions) -> Self {
        let language = host.language;
        Self {
            status: language.format("tui.initializingApi", &[format!("{}", client.base_url())]),
            connection_error: None,
            client,
            renderer,
            host,
            projection: None,
            input: String::new(),
            input_failed: false,
            command_picker: None,
            recent_commands: VecDeque::new(),
            initialized: false,
            next_message_profile_id: None,
            model_connections: None,
            model_profiles: Vec::new(),
            model_picker: None,
            session_list: None,
            session_picker: None,
            agent_picker: None,
            agent_return_views: Vec::new(),
            plugin_catalog: None,
            selected_plugins: Vec::new(),
            selected_mentions: Vec::new(),
            plugin_picker: None,
            resource_preview: None,
            context_open: false,
            tasks_open: false,
            detail_preview: None,
            tool_detail: None,
            reasoning_enabled: false,
            detail_scroll: Cell::new(0),
            detail_scroll_max: Cell::new(0),
            viewport_height: Cell::new(1),
            transcript_scroll: Cell::new(None),
            transcript_scroll_max: Cell::new(0),
        }
    }

    pub async fn bootstrap(&mut self) -> Result<(), String> {
        if let Some(path) = self.host.workspace_path.as_mut() {
            *path = path.canonicalize().map_err(|error| {
                self.host
                    .language
                    .format("tui.workspaceUnavailable", &[error.to_string()])
            })?;
        }
        if self.host.session_id.is_some() {
            self.ensure_session().await?;
        }
        let catalog = self
            .client
            .conversation_plugin_catalog()
            .await
            .map_err(|error| {
                self.host
                    .language
                    .format("tui.pluginCatalogLoadFailed", &[error.to_string()])
            })?;
        self.selected_plugins =
            plugin_selections_from_uris(self.host.language, &catalog, &self.host.plugin_uris)?;
        self.plugin_catalog = Some(catalog);
        self.initialized = true;
        self.status = self.host.language.text("tui.ready").to_string();
        Ok(())
    }

    // Opening the shell is a local draft. Persist a Session only for an explicit
    // session action; the shared Session service remains its sole owner.
    async fn ensure_session(&mut self) -> Result<(), String> {
        if self.projection.is_some() {
            return Ok(());
        }
        let result = if let Some(session_id) = self.host.session_id.as_deref() {
            self.client.conversation_projection(session_id).await
        } else {
            self.client
                .create_conversation_session(&CreateConversationSessionRequest {
                    subagent_settings: None,
                    recipe: None,
                    session_id: None,
                    workspace_paths: self
                        .host
                        .workspace_path
                        .as_ref()
                        .map(|path| vec![path.to_string_lossy().to_string()]),
                    project_id: None,
                    profile_id: None,
                })
                .await
        };
        self.projection = Some(result.map_err(|error| {
            self.host
                .language
                .format("tui.sessionInitializationFailed", &[error.to_string()])
        })?);
        Ok(())
    }

    pub async fn poll(&mut self) {
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            return;
        };
        match self.client.conversation_projection(&session_id).await {
            Ok(projection) => {
                self.connection_error = None;
                self.projection = Some(projection);
            }
            Err(error) => {
                self.connection_error = Some(
                    self.host
                        .language
                        .format("tui.projectionRefreshFailed", &[format!("{}", error)]),
                )
            }
        }
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let input = line.trim();
        if input.is_empty() {
            return true;
        }
        self.input_failed = false;
        let command_input = if line.starts_with('/') { input } else { "" };
        self.record_command(command_input);
        self.tool_detail = None;
        self.transcript_scroll.set(None);
        match command_input {
            "/quit" | "/exit" => return false,
            "/sessions" | "/resume" => self.open_sessions().await,
            "/agents" => {
                self.agent_picker = Some(0);
            }
            "/back" => {
                self.back_from_agent();
                self.poll().await;
            }
            value if value.starts_with("/agent ") => {
                let selector = value.trim_start_matches("/agent ").trim();
                let entries = self.agent_entries();
                let selected = selector
                    .parse::<usize>()
                    .ok()
                    .and_then(|number| number.checked_sub(1))
                    .filter(|index| *index < entries.len())
                    .or_else(|| entries.iter().position(|(id, _, _)| id == selector));
                if let Some(index) = selected {
                    self.agent_picker = Some(index);
                    self.select_agent().await;
                } else {
                    self.input_failed = true;
                    self.status = self.host.language.text("tui.agentNotFound").into();
                }
            }
            "/new" => self.new_session(),
            value if value.starts_with("/resume ") => {
                self.resume_session(value.trim_start_matches("/resume ").trim())
                    .await
            }
            "/help" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll.set(0);
                self.detail_preview = Some(self.host.language.text("tui.commandHelp").into());
            }
            "/font" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll.set(0);
                self.detail_preview = Some(self.host.language.text("tui.font.help").into());
            }
            value if value.starts_with("/font ") => {
                let choice = value.trim_start_matches("/font ").trim();
                self.status =
                    match crate::fonts::apply(choice, self.host.language, &self.client).await {
                        Ok(()) => self
                            .host
                            .language
                            .format("tui.font.changed", &[choice.into()]),
                        Err(error) => {
                            self.input_failed = true;
                            self.host.language.format("tui.font.failed", &[error])
                        }
                    };
            }
            "/language" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll.set(0);
                self.detail_preview = Some(self.host.language.text("tui.language.help").into());
            }
            value if value.starts_with("/language ") => {
                self.change_language(value.trim_start_matches("/language ").trim())
                    .await;
            }
            "/show" => self.status = self.projection_label(),
            "/error" | "/decision" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll.set(0);
                if input == "/decision"
                    && self.projection.as_ref().is_some_and(|projection| {
                        projection.pending_plan.is_none()
                            && projection.pending_interaction.is_none()
                            && projection.pending_approval.is_none()
                            && projection
                                .pending_agent_decisions
                                .iter()
                                .flatten()
                                .next()
                                .is_some()
                    })
                {
                    let pending = &self
                        .projection
                        .as_ref()
                        .unwrap()
                        .pending_agent_decisions
                        .as_ref()
                        .unwrap()[0]
                        .agent_session_id;
                    self.agent_picker = self
                        .agent_entries()
                        .iter()
                        .position(|(id, _, _)| id == pending);
                    self.detail_preview = None;
                    return true;
                }
                self.detail_preview = Some(if input == "/error" {
                    crate::renderer::failure_details(self.host.language, self.projection.as_ref())
                } else {
                    crate::renderer::decision_details(self.host.language, self.projection.as_ref())
                });
            }
            "/clear" => {
                self.clear_input();
                self.status = self.host.language.text("tui.inputCleared").to_string();
            }
            "/context" => self.toggle_context(),
            "/tasks" => {
                self.tasks_open = !self.tasks_open;
                self.context_open = false;
                self.resource_preview = None;
                self.detail_preview = None;
                self.detail_scroll.set(0);
            }
            "/next" => self.next_resource().await,
            "/reasoning" => {
                self.reasoning_enabled = !self.reasoning_enabled;
                self.status = if self.reasoning_enabled {
                    self.host.language.text("tui.reasoningEnabled")
                } else {
                    self.host.language.text("tui.reasoningDisabled")
                }
                .into();
            }
            value if value.starts_with("/diff ") => self.read_detail(value, false).await,
            value if value.starts_with("/reasoning ") || value == "/reasoning-history" => {
                self.read_detail(value, true).await
            }
            "/close" => {
                self.agent_picker = None;
                self.back_from_agent();
                self.session_picker = None;
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_preview = None;
                self.status = self.host.language.text("tui.viewClosed").to_string();
            }
            value if value.starts_with("/tool ") => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll.set(0);
                let activity = value.trim_start_matches("/tool ").trim();
                self.tool_detail = self
                    .projection
                    .as_ref()
                    .map(|projection| (projection.session_id.clone(), activity.to_owned()));
                self.detail_preview = Some(crate::renderer::tool_details(
                    self.host.language,
                    self.projection.as_ref(),
                    activity,
                ));
            }
            "/cancel-plan" => self.cancel_plan().await,
            "/cancel" => self.cancel_run().await,
            value if value.starts_with("/open ") => self.open_resource(value).await,
            value if value.starts_with("/attach ") => {
                self.attach_directory(value.trim_start_matches("/attach ").trim())
                    .await
            }
            value if value.starts_with("/detach ") => {
                self.detach_directory(value.trim_start_matches("/detach ").trim())
                    .await
            }
            "/model" | "/connection" => {
                self.open_model_picker().await;
            }
            value if value.starts_with("/model ") => {
                self.open_model_picker().await;
                if self.model_picker.is_some() {
                    self.select_model(value.trim_start_matches("/model ").trim());
                }
            }
            _ if input.starts_with('@') => self.select_plugin_from_plain_input(input).await,
            _ => self.submit_contextual_input(line).await,
        }
        if self.input_failed && self.input.is_empty() {
            self.input = line.to_owned();
            self.sync_input_pickers();
        }
        true
    }

    async fn open_sessions(&mut self) {
        self.session_picker = None;
        self.session_list = None;
        match self.client.conversation_catalog().await {
            Ok(catalog) => {
                let sessions = crate::session_navigation::ordered_sessions(catalog);
                let selected = sessions
                    .iter()
                    .position(|session| {
                        self.projection
                            .as_ref()
                            .is_some_and(|projection| projection.session_id == session.id)
                    })
                    .unwrap_or(0);
                self.session_list = Some(sessions);
                self.model_picker = None;
                self.plugin_picker = None;
                self.session_picker = Some(selected);
                self.status = self.host.language.text("tui.sessionsHint").into();
            }
            Err(error) => {
                self.input_failed = true;
                self.status = error.to_string();
            }
        }
    }

    // A view change never submits a cancellation or copies authority to another Session.
    fn reset_session_view(&mut self) {
        self.agent_return_views.clear();
        self.agent_picker = None;
        self.clear_input();
        self.next_message_profile_id = None;
        self.model_picker = None;
        self.session_picker = None;
        self.connection_error = None;
        self.resource_preview = None;
        self.context_open = false;
        self.tasks_open = false;
        self.detail_preview = None;
        self.detail_scroll.set(0);
        self.transcript_scroll.set(None);
        self.transcript_scroll_max.set(0);
    }

    fn new_session(&mut self) {
        let background = crate::session_navigation::background_notice(
            self.host.language,
            self.projection.as_ref(),
        );
        self.reset_session_view();
        self.host.session_id = None;
        self.projection = None;
        self.status = self.host.language.text("tui.sessionNew").into();
        if let Some(notice) = background {
            self.status.push_str(&format!(" · {notice}"));
        }
    }

    async fn resume_session(&mut self, selector: &str) {
        let session_id = match crate::session_navigation::resolve_selector(
            self.host.language,
            selector,
            self.session_list.as_deref(),
        ) {
            Ok(id) => id,
            Err(error) => {
                self.input_failed = true;
                self.status = error;
                return;
            }
        };
        if self
            .projection
            .as_ref()
            .is_some_and(|projection| projection.session_id == session_id)
        {
            self.session_picker = None;
            self.status = self
                .host
                .language
                .format("tui.sessionOpened", &[session_id]);
            return;
        }
        match self.client.conversation_projection(&session_id).await {
            Ok(projection) => {
                let background = crate::session_navigation::background_notice(
                    self.host.language,
                    self.projection.as_ref(),
                );
                self.reset_session_view();
                self.host.session_id = Some(session_id.clone());
                self.projection = Some(projection);
                self.status = self
                    .host
                    .language
                    .format("tui.sessionOpened", &[session_id]);
                if let Some(notice) = background {
                    self.status.push_str(&format!(" · {notice}"));
                }
            }
            Err(error) => {
                self.input_failed = true;
                self.status = format!("{session_id}: {error}");
            }
        }
    }

    pub fn agent_picker_open(&self) -> bool {
        self.agent_picker.is_some()
    }
    pub fn close_agent_picker(&mut self) {
        self.agent_picker = None;
    }
    pub fn viewing_agent(&self) -> bool {
        !self.agent_return_views.is_empty()
    }
    pub fn agent_entries(&self) -> Vec<(String, String, bool)> {
        let Some(projection) = &self.projection else {
            return Vec::new();
        };
        let mut members = Vec::new();
        for child in projection.agent_children.iter().flatten() {
            members.push((
                child.agent_session_id.clone(),
                child.display_name.clone(),
                child.closed,
            ));
        }
        for task in projection.agent_tasks.iter().flatten() {
            if !members
                .iter()
                .any(|(id, _, _)| *id == task.agent_session_id)
            {
                members.push((
                    task.agent_session_id.clone(),
                    task.display_name.clone(),
                    false,
                ));
            }
        }
        for decision in projection.pending_agent_decisions.iter().flatten() {
            if !members
                .iter()
                .any(|(id, _, _)| *id == decision.agent_session_id)
            {
                members.push((
                    decision.agent_session_id.clone(),
                    decision.display_name.clone(),
                    false,
                ));
            }
        }
        members
            .into_iter()
            .enumerate()
            .map(|(index, (id, name, closed))| {
                let task = projection
                    .agent_tasks
                    .iter()
                    .flatten()
                    .rev()
                    .find(|task| task.agent_session_id == id);
                let status = if projection
                    .pending_agent_decisions
                    .iter()
                    .flatten()
                    .any(|decision| decision.agent_session_id == id)
                {
                    "agent.team.needsInput"
                } else {
                    task.map(|task| agent_status_key(task.status))
                        .unwrap_or("agent.team.status.idle")
                };
                let label = format!(
                    "{}. {} · {}{}",
                    index + 1,
                    name,
                    self.host.language.text(status),
                    if closed {
                        format!(" · {}", self.host.language.text("agent.team.closed"))
                    } else {
                        String::new()
                    }
                );
                (id, label, self.agent_picker == Some(index))
            })
            .collect()
    }
    pub fn agent_picker_move(&mut self, delta: isize) {
        let count = self.agent_entries().len();
        if let Some(selected) = self.agent_picker.as_mut().filter(|_| count > 0) {
            *selected = (*selected as isize + delta).rem_euclid(count as isize) as usize;
        }
    }
    pub async fn select_agent(&mut self) {
        let Some((id, label, _)) = self
            .agent_picker
            .and_then(|index| self.agent_entries().get(index).cloned())
        else {
            return;
        };
        match self.client.conversation_projection(&id).await {
            Ok(child) => {
                if let Some(projection) = self.projection.take() {
                    self.agent_return_views.push(AgentReturnView {
                        projection,
                        input: std::mem::take(&mut self.input),
                        transcript_scroll: self.transcript_scroll.get(),
                    });
                }
                self.projection = Some(child);
                self.agent_picker = None;
                self.command_picker = None;
                self.transcript_scroll.set(None);
                self.detail_preview = None;
                self.resource_preview = None;
                self.context_open = false;
                self.tasks_open = false;
                self.status = format!(
                    "{} · {}",
                    label,
                    self.host.language.text("tui.agentBackHint")
                );
            }
            Err(error) => {
                self.input_failed = true;
                self.status = error.to_string();
            }
        }
    }
    pub fn back_from_agent(&mut self) {
        if let Some(parent) = self.agent_return_views.pop() {
            self.projection = Some(parent.projection);
            self.input = parent.input;
            self.command_picker = None;
            self.transcript_scroll.set(parent.transcript_scroll);
            self.detail_preview = None;
            self.resource_preview = None;
            self.context_open = false;
            self.tasks_open = false;
            self.status = self.projection_label();
        }
    }
    pub fn agent_status(&self) -> String {
        let Some(projection) = &self.projection else {
            return String::new();
        };
        let mut counts = std::collections::BTreeMap::new();
        let mut seen = HashSet::new();
        for task in projection.agent_tasks.iter().flatten().rev() {
            if seen.insert(&task.agent_session_id)
                && task.status == achbit_kernel_client::AgentTaskStatus::Running
            {
                *counts
                    .entry(agent_status_key(task.status))
                    .or_insert(0usize) += 1;
            }
        }
        if counts.is_empty() {
            return String::new();
        }
        format!(
            "{} · {} · /agents",
            self.host.language.text("agent.team.title"),
            counts
                .into_iter()
                .map(|(status, count)| format!("{} {}", count, self.host.language.text(status)))
                .collect::<Vec<_>>()
                .join(" · ")
        )
    }

    pub fn session_picker_open(&self) -> bool {
        self.session_picker.is_some()
    }
    pub fn close_session_picker(&mut self) {
        self.session_picker = None;
    }
    pub fn session_picker_entries(&self) -> Vec<(String, bool)> {
        let current = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.as_str());
        self.session_list
            .iter()
            .flatten()
            .enumerate()
            .map(|(index, session)| {
                (
                    crate::session_navigation::session_label(index + 1, session, current),
                    self.session_picker == Some(index),
                )
            })
            .collect()
    }
    pub fn session_picker_move(&mut self, delta: isize) {
        let count = self.session_list.as_ref().map_or(0, Vec::len);
        if let Some(selected) = self.session_picker.as_mut().filter(|_| count > 0) {
            *selected = (*selected as isize + delta).rem_euclid(count as isize) as usize;
        }
    }
    pub async fn session_picker_select(&mut self) {
        if let Some(selected) = self.session_picker {
            self.resume_session(&(selected + 1).to_string()).await;
        }
    }

    async fn submit_contextual_input(&mut self, text: &str) {
        if let Err(error) = self.ensure_session().await {
            self.input_failed = true;
            self.status = error;
            return;
        }
        // Resolve the input against current facts, not the last display poll.
        if let Some(projection) = self.projection.as_ref() {
            match self
                .client
                .conversation_projection(&projection.session_id)
                .await
            {
                Ok(current) => self.projection = Some(current),
                Err(error) => {
                    self.input_failed = true;
                    self.status = error.to_string();
                    return;
                }
            }
        }
        let Some(projection) = self.projection.as_ref() else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        let child = match crate::conversation_input::child_reply_projection(
            self.host.language,
            &self.client,
            projection,
            text,
        )
        .await
        {
            Ok(child) => child,
            Err(error) => {
                self.input_failed = true;
                self.status = error;
                return;
            }
        };
        let target = child.as_ref().unwrap_or(projection);
        let session_id = target.session_id.clone();
        let command = match self.contextual_input_command(target, text) {
            Ok(command) => command,
            Err(error) => {
                self.input_failed = true;
                self.status = error;
                return;
            }
        };
        if self.viewing_agent() && command["type"] == "message.submit" {
            self.input_failed = true;
            self.status = self.host.language.text("tui.agentReadOnly").into();
            return;
        }
        let consumes_plugins = matches!(
            command["type"].as_str(),
            Some("message.submit" | "context.focus")
        );
        if self
            .submit_command(
                &session_id,
                command,
                self.host.language.text("tui.messageSubmitFailed"),
            )
            .await
            && consumes_plugins
        {
            self.clear_plugin_selections();
        }
    }

    fn contextual_input_command(
        &self,
        projection: &SessionProjection,
        text: &str,
    ) -> Result<serde_json::Value, String> {
        // TUI selections apply to the next message and remain selected during a reply.
        let is_reply = match crate::conversation_input::slash_command(text) {
            Some(("reply", _)) => true,
            Some(("permissions" | "revoke", argument)) => !argument.is_empty(),
            _ => false,
        };
        crate::conversation_input::contextual_input_command(
            self.host.language,
            projection,
            text,
            &new_id("command"),
            self.next_message_profile_id.as_deref(),
            &[],
            self.plugin_catalog
                .as_ref()
                .map_or("", |catalog| catalog.revision.as_str()),
            if is_reply {
                &[]
            } else {
                &self.selected_plugins
            },
        )
    }

    pub async fn cancel_plan(&mut self) {
        let Some(projection) = self.projection.as_ref() else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        let Some(plan) = projection.pending_plan.as_ref() else {
            self.clear_input();
            self.input_failed = true;
            self.status = self.host.language.text("tui.noPendingPlan").to_string();
            return;
        };
        let session_id = projection.session_id.clone();
        let command = plan_cancel_command(&session_id, &new_id("command"), plan);
        self.clear_input();
        self.submit_command(
            &session_id,
            command,
            self.host.language.text("tui.planCancelFailed"),
        )
        .await;
    }

    async fn open_model_picker(&mut self) {
        match tokio::try_join!(
            self.client.model_connections(),
            self.client.model_profiles()
        ) {
            Ok((connections, profiles)) => {
                self.model_connections = Some(connections);
                self.model_profiles = profiles.profiles;
                self.plugin_picker = None;
                self.model_picker = Some(ModelPicker {
                    connection_id: None,
                    selected: 0,
                });
                self.status = self.host.language.text("tui.connectionPickerHint").into();
            }
            Err(error) => {
                self.input_failed = true;
                self.model_picker = None;
                self.status = self
                    .host
                    .language
                    .format("tui.modelCatalogFailed", &[format!("{}", error)]);
            }
        }
    }

    fn select_model(&mut self, profile_id: &str) {
        let Some(profile) = self
            .model_profiles
            .iter()
            .find(|p| p.id == profile_id && p.parameters.enabled)
        else {
            self.input_failed = true;
            self.status = self.host.language.text("tui.modelUnavailable").into();
            return;
        };
        let connection_name = self
            .model_connections
            .as_ref()
            .and_then(|c| {
                c.connections
                    .iter()
                    .find(|c| c.connection.id == profile.connection_id)
            })
            .map(|c| c.connection.name.as_str())
            .unwrap_or(&profile.connection_id);
        self.next_message_profile_id = Some(profile_id.into());
        self.status = self.host.language.format(
            "tui.nextModel",
            &[
                format!("{}", connection_name),
                format!("{}", profile.parameters.name),
            ],
        );
        self.model_picker = None;
    }

    pub fn model_picker_open(&self) -> bool {
        self.model_picker.is_some()
    }
    pub fn model_picker_title(&self) -> &str {
        if self
            .model_picker
            .as_ref()
            .is_some_and(|p| p.connection_id.is_some())
        {
            self.host.language.text("tui.chooseModel")
        } else {
            self.host.language.text("tui.chooseConnection")
        }
    }
    pub fn model_picker_entries(&self) -> Vec<(String, String, bool)> {
        let Some(picker) = &self.model_picker else {
            return vec![];
        };
        let entries: Vec<(String, String)> = if let Some(id) = &picker.connection_id {
            self.model_profiles
                .iter()
                .filter(|p| &p.connection_id == id && p.parameters.enabled)
                .map(|p| {
                    (
                        p.id.clone(),
                        format!("{} · {}", p.parameters.name, p.parameters.model),
                    )
                })
                .collect()
        } else {
            self.model_connections
                .as_ref()
                .map(|catalog| {
                    catalog
                        .connections
                        .iter()
                        .map(|c| {
                            (
                                c.connection.id.clone(),
                                format!(
                                    "{} · {} · {}",
                                    c.connection.name,
                                    if c.connection.billing_mode == "subscription" {
                                        "Coding Plan"
                                    } else {
                                        "API"
                                    },
                                    match c.auth_status.as_str() {
                                        "ready" => self.host.language.text("tui.available"),
                                        "needsLogin" => self.host.language.text("tui.needsLogin"),
                                        _ => self.host.language.text("tui.notConfigured"),
                                    }
                                ),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        entries
            .into_iter()
            .enumerate()
            .map(|(i, (id, label))| (id, label, i == picker.selected))
            .collect()
    }
    pub fn model_picker_move(&mut self, delta: isize) {
        let count = self.model_picker_entries().len();
        if let Some(picker) = &mut self.model_picker {
            if count > 0 {
                picker.selected =
                    (picker.selected as isize + delta).rem_euclid(count as isize) as usize;
            }
        }
    }
    pub fn model_picker_select(&mut self) {
        let Some(picker) = self.model_picker.clone() else {
            return;
        };
        let Some((id, _, _)) = self.model_picker_entries().get(picker.selected).cloned() else {
            return;
        };
        if picker.connection_id.is_none() {
            self.model_picker = Some(ModelPicker {
                connection_id: Some(id),
                selected: 0,
            });
        } else {
            self.select_model(&id);
        }
    }
    pub fn model_picker_back(&mut self) {
        if self
            .model_picker
            .as_ref()
            .is_some_and(|p| p.connection_id.is_some())
        {
            self.model_picker = Some(ModelPicker {
                connection_id: None,
                selected: 0,
            });
        } else {
            self.model_picker = None;
        }
    }

    async fn cancel_run(&mut self) {
        let Some(projection) = self.projection.as_ref() else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        let Some(run) = projection.run.as_ref() else {
            self.input_failed = true;
            self.status = self.host.language.text("tui.noRun").to_string();
            return;
        };
        if is_terminal_run_status(&run.status) {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .format("tui.runEnded", &[format!("{}", run.run_id)]);
            return;
        }
        let session_id = projection.session_id.clone();
        let command = cancel_command(&session_id, &new_id("command"), &run.run_id);
        self.submit_command(
            &session_id,
            command,
            self.host.language.text("tui.cancelFailed"),
        )
        .await;
    }

    async fn next_resource(&mut self) {
        let Some(resource) = self.resource_preview.clone() else {
            return;
        };
        let Some(next) = resource.next_byte else {
            self.status = self.host.language.text("tui.resourceEnd").into();
            return;
        };
        let Some(projection) = &self.projection else {
            return;
        };
        match self
            .client
            .conversation_resource_read_range(
                &projection.session_id,
                &resource.workspace_id,
                &resource.logical_path,
                Some(next),
            )
            .await
        {
            Ok(resource) => {
                self.status = self.host.language.text("tui.resourceNext").into();
                self.detail_scroll.set(0);
                self.resource_preview = Some(resource);
            }
            Err(error) => {
                self.input_failed = true;
                self.status = error.to_string();
            }
        }
    }

    async fn read_detail(&mut self, command: &str, reasoning: bool) {
        if reasoning && !self.reasoning_enabled {
            self.input_failed = true;
            self.status = self.host.language.text("tui.reasoningEnableFirst").into();
            return;
        }
        let Some(projection) = &self.projection else {
            return;
        };
        let words: Vec<_> = command.split_whitespace().collect();
        let result: Result<String, String> = if reasoning {
            let offset = words.get(2).map(|value| value.parse::<u64>()).transpose();
            match offset {
                Err(_) => Err(self.host.language.text("tui.reasoningOffsetInvalid").into()),
                Ok(offset) => {
                    let query = if let Some(request) = words.get(1) {
                        json!({ "view": "reasoning", "providerRequestId": request, "offset": offset.unwrap_or(0) })
                    } else {
                        json!({ "view": "reasoning" })
                    };
                    self.client
                        .conversation_read(&projection.session_id, &query)
                        .await
                        .map(|value| {
                            serde_json::to_string_pretty(&value)
                                .unwrap_or_else(|error| error.to_string())
                        })
                        .map_err(|error| error.to_string())
                }
            }
        } else if words.len() == 3 {
            match words[2].parse::<usize>() {
                Ok(index) => self
                    .client
                    .conversation_change_read(&projection.session_id, words[1], index)
                    .await
                    .map(|change| change.unified_diff())
                    .map_err(|error| error.to_string()),
                Err(_) => Err(self.host.language.text("tui.diffIndexInvalid").into()),
            }
        } else {
            Err(self.host.language.text("tui.diffUsage").into())
        };
        match result {
            Ok(content) => {
                self.detail_scroll.set(0);
                self.detail_preview = Some(content);
                self.resource_preview = None;
                self.context_open = false;
                self.status = self.host.language.text("tui.detailStatus").into();
            }
            Err(error) => {
                self.input_failed = true;
                self.status = error;
            }
        }
    }

    async fn open_resource(&mut self, command: &str) {
        let mut parts = command.splitn(3, ' ');
        let _ = parts.next();
        let Some(workspace_id) = parts.next().filter(|value| !value.is_empty()) else {
            self.input_failed = true;
            self.status = self.host.language.text("tui.openUsage").to_string();
            return;
        };
        let Some(logical_path) = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            self.input_failed = true;
            self.status = self.host.language.text("tui.openUsage").to_string();
            return;
        };
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        match self
            .client
            .conversation_resource_read(&session_id, workspace_id, logical_path)
            .await
        {
            Ok(resource) => {
                self.context_open = false;
                self.status = self.host.language.format(
                    "tui.readOnlyResource",
                    &[
                        format!("{}", resource.logical_path),
                        format!("{}", resource.size_bytes),
                    ],
                );
                self.detail_preview = None;
                self.detail_scroll.set(0);
                self.resource_preview = Some(resource);
            }
            Err(error) => {
                self.input_failed = true;
                self.status = self
                    .host
                    .language
                    .format("tui.resourceReadFailed", &[format!("{}", error)])
            }
        }
    }

    async fn attach_directory(&mut self, path: &str) {
        if path.is_empty() {
            self.input_failed = true;
            self.status = self.host.language.text("tui.attachUsage").to_string();
            return;
        }
        if let Err(error) = self.ensure_session().await {
            self.input_failed = true;
            self.status = error;
            return;
        }
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        match self
            .client
            .attach_conversation_directory_index(&session_id, path)
            .await
        {
            Ok(projection) => {
                self.projection = Some(projection);
                self.status = self.host.language.text("tui.directoryAttached").to_string();
            }
            Err(error) => {
                self.input_failed = true;
                self.status = self
                    .host
                    .language
                    .format("tui.directoryAttachFailed", &[format!("{}", error)])
            }
        }
    }

    async fn detach_directory(&mut self, workspace_id: &str) {
        if workspace_id.is_empty() {
            self.input_failed = true;
            self.status = self.host.language.text("tui.detachUsage").to_string();
            return;
        }
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .text("tui.sessionNotInitialized")
                .to_string();
            return;
        };
        match self
            .client
            .detach_conversation_directory_index(&session_id, workspace_id)
            .await
        {
            Ok(projection) => {
                self.projection = Some(projection);
                self.status = self.host.language.text("tui.directoryDetached").to_string();
            }
            Err(error) => {
                self.input_failed = true;
                self.status = self
                    .host
                    .language
                    .format("tui.directoryDetachFailed", &[format!("{}", error)])
            }
        }
    }

    pub async fn interrupt(&mut self) {
        self.cancel_run().await;
    }

    async fn submit_command(
        &mut self,
        session_id: &str,
        command: serde_json::Value,
        failure_label: &str,
    ) -> bool {
        match self
            .client
            .submit_conversation_command(session_id, &command)
            .await
        {
            Ok(reply) if reply.status != "rejected" => {
                self.status = self.host.language.text("tui.commandAccepted").to_string();
                self.poll().await;
                true
            }
            Ok(reply) => {
                self.input_failed = true;
                let error = reply.error;
                let refresh_plugins = error.as_ref().is_some_and(|error| {
                    matches!(
                        error.code.as_str(),
                        "plugin_selection_stale" | "plugin_selection_unavailable"
                    )
                });
                self.status = error
                    .map(|error| format!("{}：{}", error.code, error.message))
                    .unwrap_or_else(|| self.host.language.text("tui.commandRejected").to_string());
                if refresh_plugins {
                    self.clear_plugin_selections();
                    if let Err(error) = self.refresh_plugin_catalog().await {
                        self.status = self.host.language.format(
                            "tui.pluginRefreshSecondary",
                            &[format!("{}", self.status), format!("{}", error)],
                        );
                    } else {
                        self.status
                            .push_str(self.host.language.text("tui.pluginRefreshed"));
                    }
                }
                false
            }
            Err(error) => {
                self.input_failed = true;
                self.status = format!("{failure_label}：{error}");
                false
            }
        }
    }

    pub fn action_required(&self) -> Option<String> {
        self.projection.as_ref().and_then(|projection| {
            if projection.pending_plan.is_some() {
                Some(self.host.language.text("tui.actionPlan").to_string())
            } else if projection.pending_interaction.is_some() {
                Some(self.host.language.text("tui.actionReply").to_string())
            } else if projection.pending_approval.is_some() {
                Some(self.host.language.text("tui.actionApproval").to_string())
            } else if projection
                .pending_agent_decisions
                .iter()
                .flatten()
                .next()
                .is_some()
            {
                Some(self.host.language.text("tui.agentDecisionHint").to_string())
            } else {
                None
            }
        })
    }

    async fn change_language(&mut self, choice: &str) {
        if Language::parse(choice).is_none() {
            self.input_failed = true;
            self.status = self
                .host
                .language
                .format("tui.languageInvalid", &[choice.into()]);
            return;
        }
        let result = self
            .client
            .patch_user_settings(&json!({ "workbench.language": choice }))
            .await
            .map_err(|error| error.to_string())
            .and_then(|settings| Language::from_settings(&settings));
        match result {
            Ok(language) => {
                self.host.language = language;
                self.detail_preview = None;
                self.detail_scroll.set(0);
                self.status = language.text("tui.language.changed").into();
            }
            Err(error) => {
                self.input_failed = true;
                self.status = self.host.language.format("tui.language.failed", &[error]);
            }
        }
    }

    pub fn language(&self) -> Language {
        self.host.language
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    pub fn projection(&self) -> Option<&SessionProjection> {
        self.projection.as_ref()
    }

    pub fn connection_error(&self) -> Option<&str> {
        self.connection_error.as_deref()
    }

    pub fn scroll_content(&mut self, down: bool) {
        self.scroll_lines(down, self.viewport_height.get().saturating_sub(1).max(1));
    }

    pub fn scroll_lines(&mut self, down: bool, lines: u16) {
        // An open picker owns navigation; do not scroll the obscured document.
        let delta = if down { 1 } else { -1 };
        if self.command_picker_open() {
            self.command_completion_key(if down { KeyCode::Down } else { KeyCode::Up });
            return;
        } else if self.plugin_picker_open() {
            self.plugin_picker_move(delta);
            return;
        } else if self.model_picker_open() {
            self.model_picker_move(delta);
            return;
        } else if self.session_picker_open() {
            self.session_picker_move(delta);
            return;
        } else if self.agent_picker_open() {
            self.agent_picker_move(delta);
            return;
        }
        if self.detail_preview.is_some()
            || self.resource_preview.is_some()
            || self.context_open
            || self.tasks_open
        {
            let current = self.detail_scroll.get();
            self.detail_scroll.set(if down {
                current
                    .saturating_add(lines)
                    .min(self.detail_scroll_max.get())
            } else {
                current.saturating_sub(lines)
            });
        } else {
            let maximum = self.transcript_scroll_max.get();
            let current = self.transcript_scroll.get().unwrap_or(maximum);
            let next = if down {
                current.saturating_add(usize::from(lines)).min(maximum)
            } else {
                current.saturating_sub(usize::from(lines))
            };
            self.transcript_scroll.set((next < maximum).then_some(next));
        }
    }

    pub fn transcript_offset(&self, maximum: usize) -> usize {
        self.transcript_scroll_max.set(maximum);
        match self.transcript_scroll.get() {
            Some(offset) => {
                let offset = offset.min(maximum);
                self.transcript_scroll.set(Some(offset));
                offset
            }
            None => maximum,
        }
    }

    pub fn tasks_open(&self) -> bool {
        self.tasks_open
    }
    pub fn set_viewport_height(&self, height: u16) {
        self.viewport_height.set(height);
    }

    pub fn detail_offset(&self, maximum: usize, height: u16) -> u16 {
        self.set_viewport_height(height);
        let maximum = maximum.min(usize::from(u16::MAX)) as u16;
        self.detail_scroll_max.set(maximum);
        let offset = self.detail_scroll.get().min(maximum);
        self.detail_scroll.set(offset);
        offset
    }

    pub fn initialized(&self) -> bool {
        self.initialized
    }
    pub fn detail_preview(&self) -> Option<std::borrow::Cow<'_, str>> {
        let text = self.detail_preview.as_deref()?;
        if let Some((session, activity)) = &self.tool_detail {
            if self
                .projection
                .as_ref()
                .is_some_and(|projection| &projection.session_id == session)
            {
                return Some(std::borrow::Cow::Owned(crate::renderer::tool_details(
                    self.host.language,
                    self.projection.as_ref(),
                    activity,
                )));
            }
        }
        Some(std::borrow::Cow::Borrowed(text))
    }

    pub fn reasoning_enabled(&self) -> bool {
        self.reasoning_enabled
    }

    pub fn resource_preview(&self) -> Option<&ConversationResourceReadResult> {
        self.resource_preview.as_ref()
    }

    pub fn context_open(&self) -> bool {
        self.context_open
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn status(&self) -> &str {
        self.connection_error.as_deref().unwrap_or(&self.status)
    }

    pub fn next_message_profile(&self) -> Option<&str> {
        self.next_message_profile_id.as_deref()
    }

    pub fn push_input(&mut self, value: char) {
        self.input.push(value);
        self.sync_input_pickers();
    }

    pub fn push_input_text(&mut self, value: &str) {
        self.input.push_str(value);
        self.sync_input_pickers();
    }

    pub fn backspace_input(&mut self) {
        if let Some(mention) = self
            .selected_mentions
            .iter()
            .find(|mention| mention.end == self.input.len())
            .cloned()
        {
            self.input.truncate(mention.start);
            self.selected_mentions
                .retain(|candidate| candidate.uri != mention.uri);
            self.selected_plugins
                .retain(|selection| selection.uri != mention.uri);
            self.sync_input_pickers();
            return;
        }
        // Remove one displayed grapheme, including combining marks and emoji sequences.
        let length = if self.input.ends_with('\n') {
            1
        } else {
            ratatui::text::Line::from(self.input.as_str())
                .styled_graphemes(ratatui::style::Style::default())
                .last()
                .map(|grapheme| grapheme.symbol.len())
                .unwrap_or(0)
        };
        self.input.truncate(self.input.len().saturating_sub(length));
        self.sync_input_pickers();
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.command_picker = None;
        self.clear_plugin_selections();
    }

    pub fn take_input(&mut self) -> String {
        self.command_picker = None;
        self.plugin_picker = None;
        self.selected_mentions.clear();
        std::mem::take(&mut self.input)
    }

    pub fn command_picker_open(&self) -> bool {
        self.command_picker.is_some()
            && !self.agent_picker_open()
            && !self.session_picker_open()
            && !self.model_picker_open()
            && !self.plugin_picker_open()
    }

    pub fn command_completion_key(&mut self, key: KeyCode) -> bool {
        if !self.command_picker_open() {
            return false;
        }
        let commands = self.matching_commands();
        let selected = self.command_picker.unwrap();
        match key {
            KeyCode::Esc => self.command_picker = None,
            KeyCode::Up | KeyCode::BackTab => {
                self.command_picker = Some((selected + commands.len() - 1) % commands.len());
            }
            KeyCode::Down => {
                self.command_picker = Some((selected + 1) % commands.len());
            }
            KeyCode::Tab | KeyCode::Enter => {
                let (command, _, takes_argument) = commands[selected];
                self.input = command.to_string();
                if takes_argument {
                    self.input.push(' ');
                }
                self.command_picker = None;
            }
            _ => return false,
        }
        true
    }

    pub fn command_picker_entries(&self, visible_count: usize) -> Vec<CommandPickerEntry> {
        if !self.command_picker_open() {
            return Vec::new();
        }
        let selected = self.command_picker.unwrap();
        let start = selected.saturating_sub(visible_count.saturating_sub(1));
        self.matching_commands()
            .into_iter()
            .enumerate()
            .skip(start)
            .take(visible_count)
            .map(|(index, (command, description, _))| CommandPickerEntry {
                command,
                description: self.host.language.text(description),
                highlighted: index == selected,
            })
            .collect()
    }

    fn matching_commands(&self) -> Vec<(&'static str, &'static str, bool)> {
        let query = self.input.as_str();
        if self.input.contains(['\n', '\r'])
            || !query.starts_with('/')
            || query.chars().any(char::is_whitespace)
        {
            return Vec::new();
        }
        let mut matches: Vec<_> = COMMANDS
            .iter()
            .copied()
            .filter(|(command, _, _)| command.starts_with(query))
            .collect();
        // A bounded local history combines frequency with recency; stable ties retain
        // the discoverable default order. Arguments and message contents are never stored.
        matches.sort_by_cached_key(|(command, _, _)| {
            std::cmp::Reverse(
                self.recent_commands
                    .iter()
                    .rev()
                    .enumerate()
                    .filter(|(_, used)| *used == command)
                    .map(|(age, _)| 32 - age)
                    .sum::<usize>(),
            )
        });
        matches
    }

    fn record_command(&mut self, input: &str) {
        let name = input.split_whitespace().next().unwrap_or("");
        if let Some((command, _, _)) = COMMANDS.iter().find(|(command, _, _)| *command == name) {
            if self.recent_commands.len() == 32 {
                self.recent_commands.pop_front();
            }
            self.recent_commands.push_back(command);
        }
    }

    fn sync_input_pickers(&mut self) {
        let commands = self.matching_commands();
        // A fully typed command keeps its existing Enter-to-execute behavior.
        self.command_picker = (!commands.is_empty()
            && !commands
                .iter()
                .any(|(command, _, _)| *command == self.input))
        .then_some(0);
        self.sync_plugin_picker_from_input();
    }

    pub fn plugin_picker_open(&self) -> bool {
        self.plugin_picker.is_some()
    }

    pub fn dismiss_plugin_picker(&mut self) {
        self.plugin_picker = None;
    }

    pub fn plugin_picker_move(&mut self, delta: isize) {
        let count = self.filtered_plugin_items().len();
        let Some(picker) = self.plugin_picker.as_mut() else {
            return;
        };
        if count == 0 {
            picker.selected_index = 0;
            return;
        }
        picker.selected_index = if delta.is_negative() {
            picker
                .selected_index
                .checked_sub(delta.unsigned_abs())
                .unwrap_or(count - 1)
        } else {
            (picker.selected_index + delta as usize) % count
        };
    }

    pub fn plugin_picker_select(&mut self) -> bool {
        let Some(picker) = self.plugin_picker.clone() else {
            return false;
        };
        let Some(plugin) = self
            .filtered_plugin_items()
            .get(picker.selected_index)
            .map(|plugin| (*plugin).clone())
        else {
            return false;
        };
        if let Some(error) = plugin_unavailable_reason(self.host.language, &plugin) {
            self.status = error;
            return true;
        }
        self.input.truncate(picker.trigger_start);
        if self
            .selected_plugins
            .iter()
            .any(|selection| selection.uri == plugin.uri)
        {
            self.plugin_picker = None;
            self.status = self.host.language.format(
                "tui.pluginAlreadySelected",
                &[format!("{}", plugin.display_name)],
            );
            return true;
        }
        let mention = format!("@{}", plugin.display_name);
        let start = self.input.len();
        self.input.push_str(&mention);
        let end = self.input.len();
        self.input.push(' ');
        self.selected_mentions.push(SelectedMention {
            uri: plugin.uri.clone(),
            start,
            end,
        });
        self.selected_plugins.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri,
            label: plugin.display_name.clone(),
        });
        self.plugin_picker = None;
        self.status = self
            .host
            .language
            .format("tui.pluginSelected", &[format!("{}", plugin.display_name)]);
        true
    }

    pub fn plugin_picker_entries(&self, visible_count: usize) -> Vec<PluginPickerEntry> {
        let selected_index = self
            .plugin_picker
            .as_ref()
            .map(|picker| picker.selected_index)
            .unwrap_or(0);
        let start = selected_index.saturating_sub(visible_count.saturating_sub(1));
        self.filtered_plugin_items()
            .into_iter()
            .enumerate()
            .skip(start)
            .take(visible_count)
            .map(|(index, plugin)| PluginPickerEntry {
                already_selected: self
                    .selected_plugins
                    .iter()
                    .any(|selection| selection.uri == plugin.uri),
                display_name: plugin.display_name.clone(),
                short_description: plugin_unavailable_reason(self.host.language, plugin)
                    .unwrap_or_else(|| plugin.short_description.clone()),
                uri: plugin.uri.clone(),
                highlighted: index == selected_index,
            })
            .collect()
    }

    pub fn plugin_picker_query(&self) -> Option<&str> {
        self.plugin_picker
            .as_ref()
            .map(|picker| picker.query.as_str())
    }

    pub fn selected_plugin_labels(&self) -> Vec<&str> {
        self.selected_plugins
            .iter()
            .map(|selection| selection.label.as_str())
            .collect()
    }

    pub fn is_run_pending(&self) -> bool {
        self.projection
            .as_ref()
            .and_then(|projection| projection.run.as_ref())
            .is_some_and(|run| matches!(run.status.as_str(), "running" | "releasing"))
    }

    fn sync_plugin_picker_from_input(&mut self) {
        let Some(trigger_start) = plugin_trigger(&self.input) else {
            self.plugin_picker = None;
            return;
        };
        let query = self.input[trigger_start + 1..].to_string();
        let selected_index = self
            .plugin_picker
            .as_ref()
            .filter(|picker| picker.trigger_start == trigger_start)
            .map(|picker| picker.selected_index)
            .unwrap_or(0);
        self.plugin_picker = Some(PluginPickerState {
            trigger_start,
            query,
            selected_index,
        });
        let count = self.filtered_plugin_items().len();
        if let Some(picker) = self.plugin_picker.as_mut() {
            picker.selected_index = picker.selected_index.min(count.saturating_sub(1));
        }
    }

    fn filtered_plugin_items(&self) -> Vec<&PluginCatalogItem> {
        let Some(catalog) = self.plugin_catalog.as_ref() else {
            return Vec::new();
        };
        let query = self
            .plugin_picker
            .as_ref()
            .map(|picker| picker.query.trim().to_lowercase())
            .unwrap_or_default();
        catalog
            .plugins
            .iter()
            .filter(|plugin| {
                query.is_empty()
                    || plugin.display_name.to_lowercase().contains(&query)
                    || plugin.short_description.to_lowercase().contains(&query)
                    || plugin.uri.to_lowercase().contains(&query)
            })
            .collect()
    }

    async fn select_plugin_from_plain_input(&mut self, value: &str) {
        let query = value.trim_start_matches('@').trim();
        if query.is_empty() {
            match self.refresh_plugin_catalog().await {
                Ok(()) => {
                    let labels = self
                        .plugin_catalog
                        .as_ref()
                        .map(|catalog| {
                            catalog
                                .plugins
                                .iter()
                                .map(|plugin| {
                                    plugin_unavailable_reason(self.host.language, plugin)
                                        .unwrap_or_else(|| {
                                            format!("{} ({})", plugin.display_name, plugin.uri)
                                        })
                                })
                                .collect::<Vec<_>>()
                                .join("；")
                        })
                        .unwrap_or_default();
                    self.status = if labels.is_empty() {
                        self.host.language.text("tui.noPlugins").to_string()
                    } else {
                        self.host
                            .language
                            .format("tui.pluginCatalog", &[format!("{}", labels)])
                    };
                }
                Err(error) => {
                    self.status = self
                        .host
                        .language
                        .format("tui.pluginRefreshFailed", &[format!("{}", error)])
                }
            }
            return;
        }
        let plugin = self.plugin_catalog.as_ref().and_then(|catalog| {
            catalog
                .plugins
                .iter()
                .find(|plugin| {
                    plugin.uri == query || plugin.display_name.eq_ignore_ascii_case(query)
                })
                .cloned()
        });
        let Some(plugin) = plugin else {
            self.status = self
                .host
                .language
                .format("tui.pluginNoMatch", &[format!("{}", query)]);
            return;
        };
        if let Some(error) = plugin_unavailable_reason(self.host.language, &plugin) {
            self.status = error;
            return;
        }
        if self
            .selected_plugins
            .iter()
            .any(|selection| selection.uri == plugin.uri)
        {
            self.status = self.host.language.format(
                "tui.pluginAlreadySelected",
                &[format!("{}", plugin.display_name)],
            );
            return;
        }
        self.selected_plugins.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri,
            label: plugin.display_name.clone(),
        });
        self.status = self
            .host
            .language
            .format("tui.pluginSelected", &[format!("{}", plugin.display_name)]);
    }

    async fn refresh_plugin_catalog(&mut self) -> Result<(), String> {
        let catalog = self
            .client
            .conversation_plugin_catalog()
            .await
            .map_err(|error| error.to_string())?;
        self.plugin_catalog = Some(catalog);
        Ok(())
    }

    fn clear_plugin_selections(&mut self) {
        self.selected_plugins.clear();
        self.selected_mentions.clear();
        self.plugin_picker = None;
    }

    fn projection_label(&self) -> String {
        self.projection
            .as_ref()
            .map(|projection| {
                self.host.language.format(
                    "tui.projectionLabel",
                    &[
                        format!("{}", projection.session_id),
                        format!("{}", projection.revision),
                        format!(
                            "{}",
                            projection.messages.len() + projection.narratives.len()
                        ),
                        format!(
                            "{}",
                            projection
                                .session_directory_indexes
                                .iter()
                                .map(|binding| format!(
                                    "{} ({})",
                                    binding.display_name, binding.workspace_id
                                ))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    ],
                )
            })
            .unwrap_or_else(|| {
                self.host
                    .language
                    .text("agent.session.newTitle")
                    .to_string()
            })
    }

    fn toggle_context(&mut self) {
        self.context_open = !self.context_open;
        self.tasks_open = false;
        self.detail_scroll.set(0);
        if self.context_open {
            self.resource_preview = None;
            self.status = self.host.language.text("tui.contextOpened").to_string();
        } else {
            self.status = self.host.language.text("tui.contextClosed").to_string();
        }
    }
}

fn plugin_selections_from_uris(
    language: Language,
    catalog: &PluginCatalogProjection,
    plugin_uris: &[String],
) -> Result<Vec<PluginSelectionInput>, String> {
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
            .ok_or_else(|| language.format("tui.pluginNotInCatalog", &[format!("{}", uri)]))?;
        if let Some(error) = plugin_unavailable_reason(language, plugin) {
            return Err(error);
        }
        selections.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri.clone(),
            label: plugin.display_name.clone(),
        });
    }
    Ok(selections)
}

fn plugin_unavailable_reason(language: Language, plugin: &PluginCatalogItem) -> Option<String> {
    if plugin.available && plugin.enabled {
        return None;
    }
    Some(match &plugin.error {
        Some(error) => format!(
            "{}：{} ({})",
            plugin.display_name, error.message, error.code
        ),
        None => language.format(
            "tui.pluginUnavailable",
            &[format!("{}", plugin.display_name)],
        ),
    })
}

fn plugin_trigger(input: &str) -> Option<usize> {
    let start = input.rfind('@')?;
    if input[..start]
        .chars()
        .next_back()
        .is_some_and(|character| !character.is_whitespace())
    {
        return None;
    }
    let query = &input[start + 1..];
    (!query
        .chars()
        .any(|character| character.is_whitespace() || matches!(character, '@' | '/')))
    .then_some(start)
}

fn new_id(kind: &str) -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{kind}:{}:{clock:x}:{sequence:x}", std::process::id())
}

#[cfg(test)]
mod input_tests {
    use super::*;
    use crate::conversation_input::fixtures::{pending_decisions, waiting_projection};
    fn test_app() -> TuiApp {
        let client = HttpKernelClient::new(
            achbit_kernel_client::KernelClientConfig::new("http://127.0.0.1:1")
                .with_host_shell_token(format!("achost_{}", "01".repeat(32))),
        )
        .unwrap();
        TuiApp::new(
            client,
            Renderer::default(),
            TuiHostOptions {
                language: Language::ZhCn,
                workspace_path: None,
                session_id: None,
                plugin_uris: vec![],
            },
        )
    }

    #[tokio::test]
    async fn open_tool_details_follow_live_output_without_a_new_revision() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.activities.push(serde_json::from_value(serde_json::json!({
            "activityId":"tool:live", "kind":"tool", "status":"active", "label":"bash",
            "runId":"run:test", "callId":"call:live", "sequence":1,
            "liveOutput":{"stdout":"first", "stderr":"", "stdoutBytes":5,"stderrBytes":0,"truncated":false}
        })).unwrap());
        app.projection = Some(projection);
        app.submit_line("/tool tool:live").await;
        assert!(app.detail_preview().unwrap().contains("first"));
        let current = app.projection.as_mut().unwrap();
        let revision = current.revision;
        current
            .activities
            .last_mut()
            .unwrap()
            .live_output
            .as_mut()
            .unwrap()
            .stdout = "second".into();
        assert!(app.detail_preview().unwrap().contains("second"));
        assert_eq!(app.projection.as_ref().unwrap().revision, revision);
        app.submit_line("/help").await;
        assert!(app.detail_preview().unwrap().contains("AC 命令"));
        assert!(!app.detail_preview().unwrap().contains("second"));
        app.submit_line("/close").await;
        assert!(app.detail_preview().is_none());
    }

    #[tokio::test]
    async fn language_command_saves_through_shared_settings_before_changing_the_view() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut app = test_app();
        app.projection = Some(waiting_projection("pendingPlan", serde_json::Value::Null));
        app.push_input_text("Keep this draft 原文");
        let projection = app.projection.clone();
        for (choice, accepted, expected) in [
            ("en-US", true, Language::EnUs),
            ("zh-CN", true, Language::ZhCn),
            ("en-US", false, Language::ZhCn),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            app.client = HttpKernelClient::new(
                achbit_kernel_client::KernelClientConfig::new(format!(
                    "http://{}",
                    listener.local_addr().unwrap()
                ))
                .with_host_shell_token(format!("achost_{}", "01".repeat(32))),
            )
            .unwrap();
            app.submit_line("/help").await;
            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                let (start, length) = loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        assert!(headers.starts_with("PATCH /api/user-settings HTTP/1.1"));
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
                let patch: serde_json::Value =
                    serde_json::from_slice(&request[start..start + length]).unwrap();
                assert_eq!(
                    patch,
                    json!({ "patches": { "workbench.language": choice } })
                );
                let response = if accepted {
                    json!({ "ok": true, "data": {
                        "settings": { "workbench.language": choice, "gui.colorTheme": "dark" },
                        "changedKeys": ["workbench.language"], "activation": "immediate"
                    } })
                } else {
                    json!({ "ok": false, "message": "settings write failed" })
                }
                .to_string();
                socket.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                ).as_bytes()).await.unwrap();
            };
            let command = format!("/language {choice}");
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::join!(server, app.submit_line(&command))
            })
            .await
            .expect("language setting request finishes");
            assert_eq!(app.language(), expected);
            assert_eq!(
                app.projection, projection,
                "language changes do not rewrite the conversation"
            );
            assert_eq!(app.input(), "Keep this draft 原文");
            if accepted {
                assert!(
                    app.detail_preview.is_none(),
                    "dismiss stale translated help"
                );
                assert_eq!(app.status, expected.text("tui.language.changed"));
                let screen = screen_rows(&app, 90, 24).join("\n");
                assert!(
                    screen.contains(expected.text("tui.language.changed")),
                    "{screen}"
                );
                app.submit_line("/help").await;
                assert_eq!(
                    app.detail_preview.as_deref(),
                    Some(expected.text("tui.commandHelp"))
                );
            } else {
                assert!(app.status.contains("settings write failed"));
                assert!(app.detail_preview.is_some());
            }
        }
    }

    #[tokio::test]
    async fn language_help_and_invalid_choices_do_not_submit_a_conversation() {
        let mut app = test_app();
        app.push_input_text("/lang");
        assert_eq!(app.command_picker_entries(7)[0].command, "/language");
        app.clear_input();
        app.submit_line("/language").await;
        let help = app.detail_preview.as_deref().unwrap();
        assert!(help.contains("/language en-US"));
        assert!(help.contains("/language zh-CN"));
        app.submit_line("/language fr-FR").await;
        assert_eq!(app.language(), Language::ZhCn);
        assert_eq!(
            app.status,
            Language::ZhCn.format("tui.languageInvalid", &["fr-FR".into()])
        );
        assert!(app.projection.is_none());
    }

    #[tokio::test]
    async fn command_completion_accepts_text_without_executing_or_consuming_plugins() {
        for key in [KeyCode::Tab, KeyCode::Enter] {
            let mut app = test_app();
            app.selected_plugins.push(PluginSelectionInput {
                selection_id: "selection:test".into(),
                uri: "plugin://test@builtin".into(),
                label: "Test plugin".into(),
            });
            app.push_input_text("/he");
            let entries = app.command_picker_entries(7);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].command, "/help");
            assert!(app.command_completion_key(key));
            assert_eq!(app.input(), "/help");
            assert!(app.detail_preview().is_none());
            assert!(app.projection().is_none());
            assert_eq!(app.selected_plugin_labels(), vec!["Test plugin"]);
            assert!(!app.command_picker_open());
            assert!(!app.command_completion_key(KeyCode::Enter));
            let input = app.take_input();
            assert!(app.submit_line(&input).await);
            assert!(app.detail_preview().unwrap().contains("AC 命令"));

            app.push_input_text("/att");
            assert!(app.command_completion_key(key));
            assert_eq!(app.input(), "/attach ");
            app.push_input_text("/tmp/项目");
            assert!(!app.command_picker_open());
            assert_eq!(app.take_input(), "/attach /tmp/项目");
        }
    }

    #[test]
    fn command_completion_dismisses_and_resets_with_the_draft() {
        let mut app = test_app();
        app.push_input('/');
        assert!(app.command_picker_open());
        assert!(app.command_completion_key(KeyCode::Esc));
        assert_eq!(app.input(), "/");
        assert!(!app.command_picker_open());
        app.push_input('h');
        assert!(app.command_picker_open());
        app.clear_input();
        assert!(!app.command_picker_open());
        assert_eq!(app.input(), "");
        app.push_input_text("/con");
        assert_eq!(app.take_input(), "/con");
        assert!(!app.command_picker_open());
        app.push_input_text("/ta");
        app.new_session();
        assert_eq!(app.input(), "");
        assert!(!app.command_picker_open());
    }

    #[tokio::test]
    async fn font_choices_are_local_ui_and_do_not_create_a_conversation() {
        let mut app = test_app();
        app.push_input_text("/fon");
        assert!(app.command_completion_key(KeyCode::Tab));
        assert_eq!(app.take_input(), "/font");
        assert!(app.submit_line("/font").await);
        assert!(app.detail_preview().unwrap().contains("/font compact-kai"));
        assert!(app.submit_line("/font unavailable").await);
        assert!(app.status().contains("unavailable"));
        assert_eq!(
            app.input(),
            "/font unavailable",
            "failed command stays editable"
        );
        assert!(app.projection().is_none());
    }

    #[test]
    fn command_completion_leaves_full_commands_text_and_existing_pickers_alone() {
        let mut app = test_app();
        for input in [
            "ordinary /he",
            " /he",
            "\t/he",
            "/help",
            "/model profile:test",
            "/he\n",
            "\n/he",
            "/unknown",
            "中文 /he",
            "@plugin",
        ] {
            app.clear_input();
            app.push_input_text(input);
            assert!(!app.command_picker_open(), "{input}");
            assert!(!app.command_completion_key(KeyCode::Tab), "{input}");
            assert!(!app.command_completion_key(KeyCode::Enter), "{input}");
            assert_eq!(app.input(), input);
        }
        app.clear_input();
        app.push_input_text("/help");
        app.backspace_input();
        assert!(app.command_picker_open());
        app.session_picker = Some(0);
        assert!(!app.command_completion_key(KeyCode::Enter));
        app.session_picker = None;
        app.model_picker = Some(ModelPicker {
            connection_id: None,
            selected: 0,
        });
        assert!(!app.command_completion_key(KeyCode::Tab));
        app.model_picker = None;
        app.agent_picker = Some(0);
        assert!(!app.command_completion_key(KeyCode::Down));
        app.agent_picker = None;
        assert!(app.command_completion_key(KeyCode::Tab));
        assert_eq!(app.input(), "/help");
    }

    #[test]
    fn command_completion_keeps_scrolled_selection_visible_in_both_languages() {
        use ratatui::{backend::TestBackend, Terminal};
        for language in [Language::ZhCn, Language::EnUs] {
            let mut app = test_app();
            app.host.language = language;
            app.push_input('/');
            assert!(app.command_completion_key(KeyCode::Up));
            assert_eq!(
                app.command_picker_entries(7).last().unwrap().command,
                "/exit"
            );
            for (width, height) in [(60, 24), (32, 12)] {
                let screen = screen_rows(&app, width, height).join("\n");
                assert!(screen.contains("> /exit"), "{screen}");
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal
                    .draw(|frame| app.renderer().draw(frame, &app))
                    .unwrap();
                let cursor = terminal.get_cursor_position().unwrap();
                assert!(
                    cursor.x < width && cursor.y >= height - 4 && cursor.y < height - 1,
                    "{cursor:?}"
                );
            }
            assert!(app.command_completion_key(KeyCode::Down));
            assert!(app.command_picker_entries(7)[0].highlighted);
            let agents_index = COMMANDS
                .iter()
                .position(|entry| entry.0 == "/agents")
                .unwrap();
            assert!(agents_index >= 7);
            for _ in 0..agents_index {
                app.command_completion_key(KeyCode::Down);
            }
            let entries = app.command_picker_entries(7);
            assert_eq!(entries.len(), 7);
            assert!(entries.last().unwrap().highlighted);
            assert_eq!(entries.last().unwrap().command, "/agents");
            assert_eq!(
                entries.last().unwrap().description,
                language.text("tui.command.agents")
            );
            let screen = screen_rows(&app, 90, 24).join("\n");
            assert!(
                screen.contains(language.text("tui.command.agents")),
                "{screen}"
            );
            assert!(
                screen.contains(language.text("tui.commandPickerHint")),
                "{screen}"
            );
            app.command_completion_key(KeyCode::BackTab);
            app.command_completion_key(KeyCode::Enter);
            assert_eq!(app.input(), "/tasks");
            app.clear_input();
            app.push_input_text("/con");
            let commands: Vec<_> = app
                .command_picker_entries(7)
                .into_iter()
                .map(|entry| entry.command)
                .collect();
            assert_eq!(commands, vec!["/connection", "/context"]);
            app.command_completion_key(KeyCode::Down);
            app.command_completion_key(KeyCode::Tab);
            assert_eq!(app.input(), "/context");
        }
    }
    #[tokio::test]
    async fn session_navigation_preserves_failed_targets_and_new_draft_is_isolated() {
        for (field, decision, _, _, _) in pending_decisions() {
            let mut app = test_app();
            app.host.workspace_path = Some(PathBuf::from("/startup"));
            app.host.session_id = Some("session:test".into());
            app.projection = Some(waiting_projection(field, decision));
            app.next_message_profile_id = Some("profile:old".into());
            app.push_input_text("draft");
            app.detail_preview = Some("old detail".into());
            let before = app.projection.clone();
            app.resume_session("session:missing").await;
            assert_eq!(app.projection, before);
            assert_eq!(app.input, "draft");
            assert!(app.status.contains("daemon request failed"));
            app.new_session();
            assert!(app.projection.is_none());
            assert!(app.host.session_id.is_none());
            assert_eq!(app.host.workspace_path, Some(PathBuf::from("/startup")));
            assert!(app.input.is_empty());
            assert!(app.next_message_profile_id.is_none());
            assert!(app.detail_preview.is_none());
            assert!(app.status.contains("仍在后台运行"));
        }
    }

    #[test]
    fn agent_list_uses_latest_task_and_back_restores_the_main_view() {
        let mut app = test_app();
        let (field, decision, _, _, _) = pending_decisions().into_iter().next().unwrap();
        let mut main = waiting_projection(field, decision);
        main.agent_children = Some(
            serde_json::from_value(json!([
                {"agentSessionId":"session:child","displayName":"Researcher","closed":false,
                    "capabilities":{"messaging":true,"continuation":true,"delegation":false}}
            ]))
            .unwrap(),
        );
        main.agent_tasks = Some(serde_json::from_value(json!([
            {"taskId":"task:one","agentSessionId":"session:child","displayName":"Researcher","text":"Inspect",
                "delivery":"async","parentRunId":"run:test","status":"completed",
                "capabilities":{"messaging":true,"continuation":true,"delegation":false}},
            {"taskId":"task:two","agentSessionId":"session:child","displayName":"Researcher","text":"Continue",
                "delivery":"async","parentRunId":"run:test","status":"running",
                "capabilities":{"messaging":true,"continuation":true,"delegation":false}}
        ])).unwrap());
        app.projection = Some(main.clone());
        app.agent_picker = Some(0);
        assert_eq!(app.agent_entries().len(), 1);
        assert!(app.agent_status().contains("1 运行中"));
        assert!(app.renderer().render_plain(&app).contains("Researcher"));
        app.agent_return_views.push(AgentReturnView {
            projection: main.clone(),
            input: "unfinished draft".into(),
            transcript_scroll: Some(7),
        });
        app.projection.as_mut().unwrap().session_id = "session:child".into();
        app.input = "child view".into();
        app.back_from_agent();
        assert_eq!(app.projection().unwrap().session_id, main.session_id);
        assert_eq!(app.input, "unfinished draft");
        assert_eq!(app.transcript_scroll.get(), Some(7));
        assert!(!app.viewing_agent());
        app.projection
            .as_mut()
            .unwrap()
            .agent_tasks
            .as_mut()
            .unwrap()[1]
            .status = achbit_kernel_client::AgentTaskStatus::Completed;
        assert!(app.agent_status().is_empty());
        assert_eq!(app.agent_entries().len(), 1);
    }

    #[tokio::test]
    async fn parent_decision_entry_opens_the_child_picker_without_rewriting_a_reply() {
        let mut app = test_app();
        let (field, decision, _, _, _) = pending_decisions().into_iter().next().unwrap();
        let mut parent = waiting_projection(field, decision);
        parent.pending_plan = None;
        parent.pending_interaction = None;
        parent.pending_approval = None;
        parent.pending_agent_decisions = Some(
            serde_json::from_value(json!([{
                "agentSessionId":"session:grandchild", "displayName":"Writer", "runId":"run:child",
                "plan":{"planId":"plan:child", "revision":2}, "interactionIds":[]
            }]))
            .unwrap(),
        );
        app.projection = Some(parent.clone());
        assert!(app.action_required().unwrap().contains("子代理等待确认"));
        assert_eq!(app.agent_entries()[0].0, "session:grandchild");
        assert!(app.agent_entries()[0]
            .1
            .contains(app.language().text("agent.team.needsInput")));
        assert!(app
            .renderer()
            .render_plain(&app)
            .contains("/agent session:grandchild"));
        app.submit_line("/decision").await;
        assert_eq!(app.agent_picker, Some(0));
        assert_eq!(
            app.projection,
            Some(parent),
            "navigation never fabricates a parent Plan"
        );
    }

    #[test]
    fn session_picker_wraps_and_plain_output_keeps_the_displayed_numbers() {
        let mut app = test_app();
        app.session_list = Some(
            (1..=12)
                .map(|number| {
                    serde_json::from_value(json!({
                        "id":format!("session:{number}"), "title":format!("Title {number}"),
                        "workspaceBindings":[], "createdAt":"1", "updatedAt":"1"
                    }))
                    .unwrap()
                })
                .collect(),
        );
        app.session_picker = Some(0);
        app.session_picker_move(-1);
        assert!(app.session_picker_entries()[11].1);
        assert!(app.renderer().render_plain(&app).contains("12. Title 12"));
        app.session_picker_move(1);
        assert!(app.session_picker_entries()[0].1);
        app.close_session_picker();
        assert!(!app.session_picker_open());
        assert_eq!(
            crate::session_navigation::resolve_selector(
                Language::ZhCn,
                "12",
                app.session_list.as_deref()
            )
            .unwrap(),
            "session:12"
        );
    }

    #[test]
    fn pending_plain_input_queues_while_explicit_reply_keeps_decision_semantics() {
        for (field, decision, command_type, response_field, expected) in pending_decisions() {
            let projection = waiting_projection(field, decision);
            let mut app = test_app();
            app.next_message_profile_id = Some("profile:next".into());
            let ordinary = app.contextual_input_command(&projection, "1").unwrap();
            assert_eq!(ordinary["type"], "message.submit");
            assert_eq!(ordinary["runId"], "run:test");
            assert_eq!(ordinary["text"], "1");
            assert!(ordinary.get("profileId").is_none());
            let reply = app
                .contextual_input_command(&projection, "/reply 1")
                .unwrap();
            assert_eq!(reply["type"], command_type);
            assert_eq!(reply[response_field], expected);
            if field == "pendingPlan" {
                let revision = app
                    .contextual_input_command(&projection, "/reply clarify scope")
                    .unwrap();
                assert_eq!(
                    revision["response"],
                    json!({"kind":"requestRevision","text":"clarify scope"})
                );
            }
        }
    }

    #[test]
    fn decision_dock_keeps_reply_visible_in_narrow_terminal_without_changing_facts() {
        use ratatui::{backend::TestBackend, Terminal};
        for (field, decision, _, _, _) in pending_decisions() {
            let mut app = test_app();
            app.projection = Some(waiting_projection(field, decision));
            app.next_message_profile_id = Some("profile:next".into());
            app.push_input_text("中文输入最后一行");
            let before = app.projection.clone();
            let mut terminal = Terminal::new(TestBackend::new(60, 22)).unwrap();
            terminal
                .draw(|frame| app.renderer().draw(frame, &app))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let text = buffer
                .content
                .chunks(60)
                .map(|row| {
                    let mut line = String::new();
                    let mut column = 0;
                    while column < row.len() {
                        let symbol = row[column].symbol();
                        line.push_str(symbol);
                        column += ratatui::text::Span::raw(symbol).width().max(1);
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(text.contains("/reply"), "{text}");
            assert!(text.contains("/decision"), "{text}");
            assert!(text.contains("中文输入最后一行"), "{text}");
            assert!(text.contains("profile:current"), "{text}");
            assert!(text.contains("下次 profile:next"), "{text}");
            let cursor = terminal.get_cursor_position().unwrap();
            assert!(cursor.x < 59 && cursor.y == 19, "{cursor:?}");
            assert_eq!(
                app.projection, before,
                "rendering must not mutate Session facts"
            );
        }
    }

    #[tokio::test]
    async fn detail_views_stop_at_the_rendered_bottom_and_reflow_after_resize() {
        for language in [Language::ZhCn, Language::EnUs] {
            let mut app = test_app();
            app.host.language = language;
            app.submit_line("/help").await;
            let top = screen_rows(&app, 60, 18);
            assert!(top
                .join("\n")
                .contains(language.text("tui.commandHelp").lines().next().unwrap()));
            app.scroll_lines(true, u16::MAX);
            let bottom = screen_rows(&app, 60, 18);
            assert!(bottom.join("\n").contains("/quit"));
            assert_ne!(top, bottom);
            for _ in 0..5 {
                app.scroll_content(true);
                assert_eq!(screen_rows(&app, 60, 18), bottom);
            }
            let resized = screen_rows(&app, 140, 26);
            assert!(resized.join("\n").contains("/quit"));
            app.scroll_content(true);
            assert_eq!(screen_rows(&app, 140, 26), resized);
            app.scroll_lines(false, u16::MAX);
            assert_eq!(screen_rows(&app, 60, 18), top);

            for command in ["/context", "/tasks", "/font"] {
                app.submit_line(command).await;
                let visible = screen_rows(&app, 140, 50);
                app.scroll_lines(true, u16::MAX);
                assert_eq!(screen_rows(&app, 140, 50), visible, "{command}");
            }
        }
    }

    #[test]
    fn detail_pages_overlap_by_one_visible_row_and_keep_file_truncation_visible() {
        let mut app = test_app();
        app.detail_preview = Some(
            (0..60)
                .map(|i| format!("row-{i:02} 中文内容"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let before = screen_rows(&app, 60, 18);
        let last = before
            .iter()
            .filter(|line| line.contains("row-"))
            .last()
            .unwrap()
            .clone();
        app.scroll_content(true);
        let after = screen_rows(&app, 60, 18);
        assert_eq!(
            after.iter().find(|line| line.contains("row-")).unwrap(),
            &last
        );
        app.detail_preview = None;
        app.resource_preview = Some(
            serde_json::from_value(json!({
                "workspaceId":"workspace:test", "logicalPath":"文本.txt", "content":"最后一行",
                "sizeBytes":99, "startLine":1, "endLine":1, "nextByte":50, "truncated":true
            }))
            .unwrap(),
        );
        let screen = screen_rows(&app, 60, 18).join("\n");
        assert!(screen.contains("最后一行"));
        assert!(screen.contains("/next"));
    }

    #[tokio::test]
    async fn completion_orders_recent_frequent_commands_but_completion_does_not_record_use() {
        let mut app = test_app();
        app.submit_line("/tasks").await;
        app.submit_line("/tasks").await;
        app.submit_line("/context").await;
        app.push_input('/');
        let names: Vec<_> = app
            .command_picker_entries(7)
            .into_iter()
            .map(|entry| entry.command)
            .collect();
        assert_eq!(&names[..3], &["/tasks", "/context", "/help"]);
        app.clear_input();
        app.push_input_text("/he");
        app.command_completion_key(KeyCode::Tab);
        app.clear_input();
        app.push_input('/');
        assert_eq!(app.command_picker_entries(7)[0].command, "/tasks");
        app.clear_input();
        app.push_input_text("/con");
        assert_eq!(app.command_picker_entries(7)[0].command, "/context");
        app.command_completion_key(KeyCode::Enter);
        assert_eq!(app.input(), "/context");
        assert!(app.context_open()); // completion did not execute /context again
        assert!(app.projection().is_none());
        let mut fresh = test_app();
        fresh.push_input('/');
        assert_eq!(fresh.command_picker_entries(7)[0].command, "/help");
    }

    #[test]
    fn picker_wheel_navigation_keeps_the_hidden_document_in_place() {
        let mut app = test_app();
        app.detail_preview = Some(
            (0..80)
                .map(|i| format!("line {i}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let before = screen_rows(&app, 60, 18);
        app.push_input('/');
        app.scroll_lines(true, 4);
        assert!(app.command_picker_entries(7)[1].highlighted);
        assert!(screen_rows(&app, 60, 18).join("\n").contains("> /new"));
        app.clear_input();
        assert_eq!(screen_rows(&app, 60, 18), before);
    }

    #[test]
    fn ready_draft_header_and_grapheme_deletion_match_the_visible_state() {
        let mut app = test_app();
        assert!(screen_rows(&app, 60, 18)[0].contains("初始化"));
        app.initialized = true;
        assert!(screen_rows(&app, 60, 18)[0].contains("就绪"));
        app.push_input_text("中文e\u{301}👩‍💻");
        app.backspace_input();
        assert_eq!(app.input(), "中文e\u{301}");
        app.backspace_input();
        assert_eq!(app.input(), "中文");
        app.push_input_text("\n中");
        app.backspace_input();
        app.backspace_input();
        assert_eq!(app.input(), "中文");
        assert!(app.projection().is_none());
    }

    #[test]
    fn footer_uses_one_row_and_prioritizes_status_in_both_languages() {
        for language in [Language::ZhCn, Language::EnUs] {
            let mut app = test_app();
            app.host.language = language;
            app.initialized = true;
            app.status = language.text("tui.ready").to_string();
            for width in [32, 100] {
                let rows = screen_rows(&app, width, 24);
                let footer = rows.last().unwrap();
                assert!(
                    footer.trim_start().starts_with(language.text("tui.ready")),
                    "{footer}"
                );
                assert_eq!(footer.matches("/help").count(), 1, "{footer}");
                assert!(rows[22].trim().is_empty(), "{:?}", rows[22]);
                app.status = "连接失败 connection failed".to_string();
                let rows = screen_rows(&app, width, 24);
                assert!(rows[23].contains("连接失败 connection"), "{:?}", rows[23]);
                app.status = language.text("tui.ready").to_string();
            }
        }
    }

    #[test]
    fn wheel_reading_stays_detached_until_reaching_latest() {
        let mut app = test_app();
        assert_eq!(app.transcript_offset(100), 100);
        app.scroll_lines(false, 4);
        assert_eq!(app.transcript_offset(120), 96);
        app.scroll_lines(true, 4);
        assert_eq!(app.transcript_offset(120), 100);
        app.scroll_lines(true, 24);
        assert_eq!(app.transcript_offset(140), 140);
    }

    fn screen_rows(app: &TuiApp, width: u16, height: u16) -> Vec<String> {
        use ratatui::{backend::TestBackend, text::Span, Terminal};
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| app.renderer().draw(frame, app))
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .chunks(width as usize)
            .map(|row| {
                let mut line = String::new();
                let mut column = 0;
                while column < row.len() {
                    let symbol = row[column].symbol();
                    line.push_str(symbol);
                    column += Span::raw(symbol).width().max(1);
                }
                line.trim_end().to_string()
            })
            .collect()
    }

    #[test]
    fn transcript_renders_user_lines_and_markdown_without_repeating_run_activities() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "completed".into();
        for (index, (role, content)) in [
            ("user", "第一行\n\n**原样保留**"),
            ("assistant", "## 能力\n\n- **读文件**\n- 跑测试\n\n完成"),
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("message:{index}");
            projection.messages.push(serde_json::from_value(json!({"messageId":id,"role":role,"content":content,"filesystemReferences":[],"pluginSelections":[],"sequence":index + 1,"createdAt":"now"})).unwrap());
            projection.timeline.push(serde_json::from_value(json!({"kind":"message","timelineId":format!("timeline:{index}"),"sequence":index + 1,"messageId":id})).unwrap());
        }
        projection.activities.push(serde_json::from_value(json!({"activityId":"run:test","kind":"run","status":"completed","label":"Agent run","runId":"run:test","sequence":1})).unwrap());
        app.projection = Some(projection);
        let before = app.projection.clone();
        for width in [60, 120] {
            let rows = screen_rows(&app, width, 30);
            let text = rows.join("\n");
            assert!(text.contains("已完成"), "{text}");
            assert!(text.contains("第一行\n\n **原样保留**"), "{text}");
            assert!(text.contains("能力\n\n • 读文件\n • 跑测试"), "{text}");
            assert!(!text.contains("**读文件**"));
            assert!(!text.contains("run [completed]"));
            assert!(!text.contains("⠋"));
        }
        assert_eq!(app.projection, before);
    }

    #[test]
    fn transcript_keeps_decisions_once_in_their_recorded_position() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "completed".into();
        for (id, role, content, sequence) in [
            ("request", "user", "检查项目", 1),
            ("followup", "user", "停止检查", 8),
            ("answer", "assistant", "已停止，没有修改文件", 10),
        ] {
            projection.messages.push(
                serde_json::from_value(json!({
                    "messageId":id,"role":role,"content":content,"filesystemReferences":[],
                    "pluginSelections":[],"sequence":sequence,"createdAt":"now"
                }))
                .unwrap(),
            );
        }
        for (id, kind, status, label, sequence) in [
            ("approval:read", "approval", "completed", "读取目录权限", 3),
            ("tool:read", "tool", "completed", "目录已读取", 2),
            ("approval:write", "approval", "denied", "修改目录权限", 5),
            (
                "question:scope",
                "interaction",
                "completed",
                "选择检查范围",
                6,
            ),
        ] {
            projection.activities.push(
                serde_json::from_value(json!({
                    "activityId":id,"kind":kind,"status":status,"label":label,
                    "runId":"run:test","callId":id,"sequence":sequence
                }))
                .unwrap(),
            );
        }
        projection.timeline = serde_json::from_value(json!([
            {"kind":"message","timelineId":"request","sequence":1,"messageId":"request"},
            {"kind":"toolGroup","timelineId":"read","sequence":3,"providerRequestId":"provider:read",
                "activityIds":["approval:read","tool:read"]},
            {"kind":"toolGroup","timelineId":"write","sequence":5,"providerRequestId":"provider:write",
                "activityIds":["approval:write","question:scope"]},
            {"kind":"message","timelineId":"followup","sequence":8,"messageId":"followup"},
            {"kind":"message","timelineId":"answer","sequence":10,"messageId":"answer"}
        ])).unwrap();
        app.projection = Some(projection);
        let before = app.projection.clone();
        let plain = app.renderer().render_plain(&app);
        for text in [plain, screen_rows(&app, 120, 40).join("\n")] {
            let labels = [
                "检查项目",
                "读取目录权限",
                "目录已读取",
                "修改目录权限",
                "选择检查范围",
                "停止检查",
                "已停止，没有修改文件",
            ];
            let mut previous = 0;
            for label in labels {
                assert_eq!(text.matches(label).count(), 1, "{label}: {text}");
                let position = text.find(label).unwrap();
                assert!(position >= previous, "{label}: {text}");
                previous = position;
            }
            assert!(text.contains("授权 读取目录权限 [已完成]"), "{text}");
            assert!(text.contains("授权 修改目录权限 [已拒绝]"), "{text}");
            assert!(text.contains("交互 选择检查范围 [已完成]"), "{text}");
            let final_reply = text.find("已停止，没有修改文件").unwrap();
            assert!(!text[final_reply..].contains("权限"), "{text}");
        }
        assert_eq!(app.projection, before);
    }

    #[test]
    fn spinner_follows_shared_status_and_stops_on_waiting_or_disconnect() {
        use crate::renderer::working_indicator;
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        app.projection = Some(projection);
        let before = app.projection.clone();
        assert!(working_indicator(&app, 0).unwrap().contains("⠋ 运行中"));
        assert!(working_indicator(&app, 1).unwrap().contains("⠙ 运行中"));
        assert!(screen_rows(&app, 60, 22)
            .join("\n")
            .contains("/cancel 停止"));
        assert_eq!(app.projection, before);
        for status in [
            "waiting",
            "completed",
            "failed",
            "cancelled",
            "indeterminate",
            "releaseFailed",
        ] {
            app.projection
                .as_mut()
                .unwrap()
                .run
                .as_mut()
                .unwrap()
                .status = status.into();
            assert!(working_indicator(&app, 0).is_none(), "{status}");
        }
        app.projection
            .as_mut()
            .unwrap()
            .run
            .as_mut()
            .unwrap()
            .status = "releasing".into();
        assert!(working_indicator(&app, 0).unwrap().contains("正在结束"));
        app.connection_error = Some("刷新共享投影失败".into());
        assert!(working_indicator(&app, 1).is_none());
    }

    #[test]
    fn streaming_markdown_updates_without_a_journal_revision_change() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        projection.assistant_draft = Some(serde_json::from_value(json!({"runId":"run:test","turnId":"request:test","blocks":[{"kind":"finalMessage","streamId":"stream:test","content":"## 草稿\n\n第一段"}]})).unwrap());
        app.projection = Some(projection);
        assert!(screen_rows(&app, 80, 24)
            .join("\n")
            .contains("草稿\n\n 第一段"));
        if let achbit_kernel_client::AssistantDraftBlockProjection::FinalMessage {
            content, ..
        } = &mut app
            .projection
            .as_mut()
            .unwrap()
            .assistant_draft
            .as_mut()
            .unwrap()
            .blocks[0]
        {
            content.push_str("\n\n- 第二段");
        }
        assert!(screen_rows(&app, 80, 24).join("\n").contains("• 第二段"));
    }

    #[test]
    fn retry_and_failure_details_use_shared_projection_facts() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        projection.provider_attempts.push(
            serde_json::from_value(json!({
                "providerRequestId":"request:test","providerAttemptId":"attempt:2","attempt":2,
                "purpose":"agent","phase":"retryWaiting","runId":"run:test","updatedAt":"now"
            }))
            .unwrap(),
        );
        app.projection = Some(projection);
        assert!(app
            .renderer()
            .render_plain(&app)
            .contains("等待第 3/5 次尝试"));
        let error = json!({"code":"provider_transport_failed","message":"原始连接失败", "diagnostics":{
            "source":"providerTransport","phase":"send","category":"network","retryable":true,
            "causes":[{"message":"Connection refused","osCode":61}]
        }});
        let projection = app.projection.as_mut().unwrap();
        projection.run.as_mut().unwrap().status = "failed".into();
        projection.terminal_error = Some(serde_json::from_value(error.clone()).unwrap());
        projection.failure_snapshot = Some(
            serde_json::from_value(json!({
                "revision":9,"phase":"send","error":error,"providerAttemptIds":["attempt:2"],
                "toolRecordIds":["record:done"],"pendingCallIds":[],"queuedMessageIds":[]
            }))
            .unwrap(),
        );
        let text = app.renderer().render_plain(&app);
        assert!(!text.contains("等待第 3/5 次尝试"));
        for fact in [
            "原始连接失败",
            "Connection refused",
            "OS 61",
            "revision 9",
            "工具记录 1",
        ] {
            assert!(text.contains(fact), "{text}");
        }
    }

    #[test]
    fn unavailable_plugin_selection_preserves_the_catalog_error() {
        let catalog: PluginCatalogProjection = serde_json::from_value(json!({"revision":"catalog:test", "plugins":[{
            "uri":"plugin://broken@mcp", "displayName":"Broken", "shortDescription":"Broken entry", "activationMediaTypes":[],
            "source":"mounted","category":"functional","contributionKind":"mcp","discovery":"default",
            "enabled":false,"available":false,"error":{"code":"plugin_manifest_invalid","message":"manifest parse failed"}
        }]})).unwrap();
        let error =
            plugin_selections_from_uris(Language::ZhCn, &catalog, &["plugin://broken@mcp".into()])
                .err()
                .unwrap();
        assert!(error.contains("plugin_manifest_invalid"));
        assert!(error.contains("manifest parse failed"));
    }

    #[test]
    fn plugin_picker_keeps_ninth_and_wrapped_selection_visible_and_selectable() {
        let mut app = test_app();
        app.plugin_catalog = Some(serde_json::from_value(json!({"revision":"catalog:test", "plugins":
            (1..=10).map(|index| json!({
                "uri":format!("plugin://item{index}@builtin"), "displayName":format!("Plugin {index:02}"),
                "shortDescription":"A long plugin description that must not push the selected item out of view".repeat(3),
                "activationMediaTypes":[],"source":"builtin","category":"functional",
                "contributionKind":"tool","discovery":"default","enabled":true,"available":true
            })).collect::<Vec<_>>()
        })).unwrap());
        app.push_input('@');
        for _ in 0..8 {
            app.plugin_picker_move(1);
        }
        for (delta, name) in [
            (0, "Plugin 09"),
            (1, "Plugin 10"),
            (1, "Plugin 01"),
            (-1, "Plugin 10"),
        ] {
            app.plugin_picker_move(delta);
            let entries = app.plugin_picker_entries(8);
            assert_eq!(entries.iter().filter(|entry| entry.highlighted).count(), 1);
            assert!(entries
                .iter()
                .any(|entry| entry.highlighted && entry.display_name == name));
            for height in [12, 24] {
                let text = screen_rows(&app, 60, height).join("\n");
                assert!(text.contains(&format!("> {name}")), "{height}: {text}");
            }
        }
        app.plugin_picker_move(-1);
        assert!(app.plugin_picker_select());
        assert_eq!(app.selected_plugins.len(), 1);
        assert_eq!(app.selected_plugins[0].uri, "plugin://item9@builtin");
        assert_eq!(app.input(), "@Plugin 09 ");
    }

    #[tokio::test]
    async fn bilingual_views_translate_shell_text_and_keep_original_content() {
        for (language, help, context, tasks, reply, error_label) in [
            (
                Language::ZhCn,
                "AC 命令",
                "上下文",
                "任务",
                "等待回答",
                "当前没有失败诊断",
            ),
            (
                Language::EnUs,
                "AC commands",
                "Context",
                "Tasks",
                "Awaiting reply",
                "No failure diagnostics",
            ),
        ] {
            let mut app = test_app();
            app.host.language = language;
            app.status = language.text("tui.ready").to_string();
            app.projection = Some(waiting_projection(
                "pendingInteraction",
                json!({
                    "interactionId":"interaction:test","runId":"run:test","callId":"call:test",
                    "status":"pending","kind":"question","prompt":"Provider 原文 {0}","options":[],"allowFreeform":true,
                    "sequence":1,"createdAt":"now"
                }),
            ));
            app.projection
                .as_mut()
                .unwrap()
                .run
                .as_mut()
                .unwrap()
                .waiting_reason = Some("userInput".into());
            app.push_input_text("用户 original input {0}");
            let screen = screen_rows(&app, 90, 24).join("\n");
            assert!(screen.contains(reply), "{screen}");
            assert!(screen.contains("Provider 原文 {0}"), "{screen}");
            assert!(screen.contains("用户 original input {0}"), "{screen}");
            app.submit_line("/help").await;
            assert!(app.detail_preview().unwrap().contains(help));
            app.submit_line("/error").await;
            assert!(app.detail_preview().unwrap().contains(error_label));
            app.submit_line("/context").await;
            assert!(screen_rows(&app, 90, 24).join("\n").contains(context));
            app.submit_line("/tasks").await;
            assert!(screen_rows(&app, 90, 24).join("\n").contains(tasks));
            let projection = app.projection().unwrap();
            let unknown = app.contextual_input_command(projection, "/bad").unwrap();
            assert_eq!(unknown["type"], "message.submit");
            assert_eq!(unknown["text"], "/bad");
            assert_eq!(
                projection.pending_interaction.as_ref().unwrap().prompt,
                "Provider 原文 {0}"
            );
        }
    }
}
