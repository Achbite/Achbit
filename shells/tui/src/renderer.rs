use crate::app::TuiApp;
use crate::i18n::Language;
use deepcode_kernel_client::{
    ActivityProjection, AssistantDraftProjection, ContextCompositionProjection,
    ContextUsageProjection, ExecutionPlanStep, NarrativeProjection, PendingPlanProjection,
    PlanProjection, ProjectionMessage, SessionProjection, SessionTimelineItem,
    TokenUsageProjection,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    prelude::Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, Paragraph, Scrollbar, ScrollbarState, Wrap},
};
use std::{
    cell::RefCell,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Renderer {
    animation_started: Instant,
    transcript: RefCell<Option<TranscriptCache>>,
}

#[derive(Clone, PartialEq)]
struct TranscriptKey {
    language: Language,
    session: Option<(String, u64)>,
    draft: Option<AssistantDraftProjection>,
    live_output: Vec<(String, deepcode_kernel_client::ToolOutputProjection)>,
    reasoning: bool,
    width: u16,
    height: u16,
}

#[derive(Clone)]
struct TranscriptCache {
    key: TranscriptKey,
    text: Text<'static>,
}

impl Default for Renderer {
    fn default() -> Self {
        Self {
            animation_started: Instant::now(),
            transcript: RefCell::new(None),
        }
    }
}

pub(crate) fn working_indicator(app: &TuiApp, tick: usize) -> Option<String> {
    let language = app.language();
    if app.connection_error().is_some() {
        return None;
    }
    let projection = app.projection()?;
    let run = projection.run.as_ref()?;
    if !matches!(run.status.as_str(), "running" | "releasing") {
        return None;
    }
    let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let mut label = run_label(language, Some(projection));
    if run.status == "running" {
        if let Some(activity) = projection.activities.iter().rev().find(|activity| {
            activity.kind == "tool" && activity.status == "active" && activity.run_id == run.run_id
        }) {
            label.push_str(&format!(
                " · {}",
                activity
                    .tool
                    .as_ref()
                    .map(|tool| tool.operation.as_str())
                    .unwrap_or(&activity.label)
            ));
        }
    }
    Some(language.format(
        "tui.working",
        &[
            format!("{}", frames[tick % frames.len()]),
            format!("{}", label),
        ],
    ))
}

fn clipped(text: &str, width: u16) -> String {
    let text = text.replace(['\n', '\r', '\t'], " ");
    let source = Line::from(text.as_str());
    let limit = usize::from(width);
    if source.width() <= limit {
        return text;
    }
    if limit == 0 {
        return String::new();
    }
    let mut result = String::new();
    let mut used = 0;
    for grapheme in source.styled_graphemes(Style::default()) {
        let cells = Span::raw(grapheme.symbol).width();
        if used + cells >= limit {
            break;
        }
        result.push_str(grapheme.symbol);
        used += cells;
    }
    result.push('…');
    result
}

fn run_label(language: Language, projection: Option<&SessionProjection>) -> String {
    let Some(projection) = projection else {
        return language.text("tui.initializing").into();
    };
    let Some(run) = &projection.run else {
        return language.text("tui.ready").into();
    };
    if run.status == "running" {
        if projection
            .pending_approval
            .as_ref()
            .is_some_and(|approval| approval.is_model_reviewing(Some(run)))
        {
            return language.text("agent.permission.reviewing").into();
        }
        if let Some(attempt) = projection
            .provider_attempts
            .last()
            .filter(|item| item.run_id == run.run_id)
        {
            if attempt.phase == "retryWaiting" {
                return language.format("tui.retryWaiting", &[format!("{}", attempt.attempt + 1)]);
            }
            if attempt.phase == "started" && attempt.attempt > 1 {
                return language.format("tui.retryConnecting", &[format!("{}", attempt.attempt)]);
            }
        }
    }
    match run.status.as_str() {
        "running" => language.text("tui.running"),
        "waiting" => match run.waiting_reason.as_deref() {
            Some("approval") => language.text("tui.waitingApproval"),
            Some("plan") => language.text("tui.waitingPlan"),
            Some("userInput") => language.text("tui.waitingReply"),
            _ => language.text("tui.waiting"),
        },
        "releasing" => language.text("tui.releasing"),
        "releaseFailed" => language.text("tui.releaseFailed"),
        "completed" => language.text("tui.completed"),
        "failed" => language.text("tui.failedHint"),
        "cancelled" => language.text("tui.cancelled"),
        "indeterminate" => language.text("tui.indeterminateHint"),
        other => other,
    }
    .into()
}

fn approval_actions(
    language: Language,
    approval: &deepcode_kernel_client::ApprovalProjection,
) -> String {
    let mut actions = language.text("tui.authorizationActions").to_owned();
    for (scope, input) in deepcode_kernel_client::AUTHORIZATION_OPTIONS {
        if approval
            .preview
            .authorization_scopes
            .as_ref()
            .is_some_and(|scopes| scopes.iter().any(|value| value == scope))
        {
            actions.push_str(&format!(
                "\n/reply {input} {}",
                language.text(&format!("agent.permission.scope.{scope}"))
            ));
        }
    }
    actions
}

fn decision_lines(
    language: Language,
    projection: Option<&SessionProjection>,
) -> Vec<Line<'static>> {
    let Some(projection) = projection else {
        return vec![];
    };
    let (title, actions, summary) = if let Some(approval) = &projection.pending_approval {
        let reviewing = approval.is_model_reviewing(projection.run.as_ref());
        (
            language.text(if reviewing {
                "agent.permission.reviewing"
            } else {
                "tui.authorizationDetailsHint"
            }),
            if reviewing {
                String::new()
            } else {
                approval_actions(language, approval)
            },
            approval.preview.summary.clone(),
        )
    } else if let Some(interaction) = &projection.pending_interaction {
        (
            language.text("tui.replyDetailsHint"),
            language.text("tui.replyActions").to_owned(),
            interaction.prompt.clone(),
        )
    } else if let Some(plan) = &projection.pending_plan {
        (
            language.text("tui.planDetailsHint"),
            language.text("tui.planActions").to_owned(),
            plan.title.clone(),
        )
    } else {
        return vec![];
    };
    let mut lines = vec![Line::from(Span::styled(
        title,
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
    ))];
    lines.extend(actions.lines().map(|line| Line::from(line.to_owned())));
    lines.push(Line::from(summary));
    lines.push(Line::from(Span::styled(
        language.text("tui.inputQueuedHint"),
        Style::default().fg(Color::DarkGray),
    )));
    lines
}

pub(crate) fn decision_details(
    language: Language,
    projection: Option<&SessionProjection>,
) -> String {
    let Some(projection) = projection else {
        return language.text("tui.sessionNotInitialized").into();
    };
    if let Some(approval) = &projection.pending_approval {
        let reviewing = approval.is_model_reviewing(projection.run.as_ref());
        let mut text = language.format(
            if reviewing {
                "tui.authorizationReviewingDetails"
            } else {
                "tui.authorizationDetails"
            },
            &[format!("{}", approval.preview.summary)],
        );
        if let Some(operation) = &approval.preview.operation {
            text.push_str(&format!(
                "\n{}: {}",
                language.text("agent.tool.detail.operation"),
                operation.tool_name
            ));
            if let Some(root) = &operation.workspace_root {
                text.push_str(&format!(
                    "\n{}: {root}",
                    language.text("agent.tool.shell.cwd")
                ));
            }
            if let Some(scope) = &operation.execution_scope {
                text.push_str(&format!(
                    "\n{}: {scope}",
                    language.text("agent.approval.executionScope")
                ));
            }
            text.push_str(&format!(
                "\n{}: {}",
                language.text("agent.approval.arguments"),
                serde_json::to_string_pretty(&operation.arguments)
                    .expect("operation arguments serialize")
            ));
        }
        if let Some(reason) = approval
            .preview
            .review
            .as_ref()
            .and_then(|review| review["reason"].as_str())
        {
            text.push_str(&format!("\n{reason}"));
        }
        if let Some(files) = &approval.preview.file_access {
            for access in ["read", "write"] {
                for path in files[access].as_array().into_iter().flatten() {
                    text.push_str(&format!("\n{access}: {}", path.as_str().unwrap_or("")));
                }
            }
        }
        for target in &approval.preview.logical_targets {
            text.push_str(&format!("\n{target}"));
        }
        if approval.preview.authorization_scope.as_deref() == Some("sessionBrowser") {
            text.push_str(language.text("tui.browserAuthorizationScope"));
        }
        text.push('\n');
        if !reviewing {
            text.push_str(&approval_actions(language, approval));
        }
        return text;
    }
    if let Some(plan) = &projection.pending_plan {
        let mut text = String::new();
        render_plan_plain(language, &mut text, plan);
        return text;
    }
    if let Some(interaction) = &projection.pending_interaction {
        let mut text = language.format("tui.replyDetails", &[format!("{}", interaction.prompt)]);
        for (index, option) in interaction.options.iter().flatten().enumerate() {
            text.push_str(&format!("\n{}. {}", index + 1, option.label));
        }
        return text;
    }
    language.text("tui.noPendingDecision").into()
}

pub(crate) fn failure_details(
    language: Language,
    projection: Option<&SessionProjection>,
) -> String {
    let Some(projection) = projection else {
        return language.text("tui.sessionNotInitialized").into();
    };
    let error = projection.terminal_error.as_ref().or_else(|| {
        projection
            .failure_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.error)
    });
    let Some(error) = error else {
        return language.text("tui.noFailure").into();
    };
    let mut text = format!("{}: {}\n", error.code, error.message);
    if let Some(details) = &error.diagnostics {
        text.push_str(&language.format(
            "tui.diagnosticOrigin",
            &[
                format!("{}", details.source),
                format!("{}", details.phase),
                format!("{}", details.category),
            ],
        ));
        for cause in &details.causes {
            text.push_str(&format!(
                "\n{}{}",
                cause.message,
                cause
                    .os_code
                    .map(|code| format!(" [OS {code}]"))
                    .unwrap_or_default()
            ));
        }
        if let Some(path) = &details.archive_path {
            text.push_str(&language.format("tui.requestArchive", &[format!("{}", path)]));
        }
        for secondary in &details.secondary {
            text.push_str(&language.format(
                "tui.secondaryError",
                &[
                    format!("{}", secondary.code),
                    format!("{}", secondary.message),
                ],
            ));
        }
    }
    if let Some(snapshot) = &projection.failure_snapshot {
        text.push_str(&language.format(
            "tui.failureSnapshot",
            &[
                format!("{}", snapshot.revision),
                format!("{}", snapshot.phase),
                format!("{}", snapshot.provider_attempt_ids.len()),
                format!("{}", snapshot.tool_record_ids.len()),
                format!("{}", snapshot.pending_call_ids.len()),
            ],
        ));
        if let Some(request) = &snapshot.provider_request_id {
            text.push_str(&language.format("tui.requestId", &[format!("{}", request)]));
        }
    }
    text
}

fn activity_summary(language: Language, activity: &ActivityProjection) -> String {
    if activity.kind == "tool" {
        let operation = activity
            .tool
            .as_ref()
            .map(|tool| tool.operation.as_str())
            .unwrap_or(&activity.label);
        language.format(
            "tui.toolSummary",
            &[
                operation.to_owned(),
                status_label(language, &activity.status).to_owned(),
            ],
        )
    } else {
        format!(
            "{} {} [{}]",
            kind_label(language, &activity.kind),
            activity.label,
            status_label(language, &activity.status),
        )
    }
}

fn push_activity_summary(
    language: Language,
    lines: &mut Vec<Line<'_>>,
    activity: &ActivityProjection,
) {
    lines.push(Line::from(Span::styled(
        activity_summary(language, activity),
        Style::default().fg(activity_color(&activity.status)),
    )));
    for error in tool_error_lines(activity) {
        lines.push(Line::from(Span::styled(
            error,
            Style::default().fg(Color::Red),
        )));
    }
    if activity.status == "active" {
        if let Some(output) = &activity.live_output {
            for line in output
                .stdout
                .lines()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(Color::DarkGray),
                )));
            }
            if let Some(line) = output.stderr.lines().last() {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(Color::Yellow),
                )));
            }
        }
    }
    lines.push(Line::from(Span::styled(
        language.format(
            "tui.toolDetailsHint",
            &[format!("{}", activity.activity_id)],
        ),
        Style::default().fg(Color::DarkGray),
    )));
}

pub(crate) fn tool_details(
    language: Language,
    projection: Option<&SessionProjection>,
    activity_id: &str,
) -> String {
    let Some(activity) = projection.and_then(|p| {
        p.activities
            .iter()
            .find(|activity| activity.activity_id == activity_id)
    }) else {
        return language.format("tui.toolMissing", &[format!("{}", activity_id)]);
    };
    let mut text = String::new();
    render_activity_plain(language, &mut text, activity);
    text
}

fn multiline_text(lines: Vec<Line<'_>>) -> Text<'static> {
    let mut result = Vec::new();
    for line in lines {
        let mut current = Line::default().style(line.style);
        for span in line.spans {
            for (index, part) in span.content.split('\n').enumerate() {
                if index > 0 {
                    result.push(current);
                    current = Line::default().style(line.style);
                }
                current
                    .spans
                    .push(Span::styled(part.to_string(), span.style));
            }
        }
        result.push(current);
    }
    Text::from(result)
}

/// Hard-wrap the editor by terminal cells, retaining a final cursor cell.
fn input_lines(input: &str, width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let mut lines = Vec::new();
    let text = format!("{input} ");
    for part in text.split('\n') {
        let source = Line::from(part);
        let mut current = String::new();
        let mut column = 0;
        for grapheme in source.styled_graphemes(Style::default()) {
            let cells = Span::raw(grapheme.symbol).width();
            if column + cells > width && !current.is_empty() {
                lines.push(Line::from(current));
                current = String::new();
                column = 0;
            }
            current.push_str(grapheme.symbol);
            column += cells;
        }
        lines.push(Line::from(current));
    }
    lines
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::app::TuiHostOptions;
    use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig};
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn tool_progress_is_visible_before_the_terminal_snapshot() {
        let mut activity: ActivityProjection = serde_json::from_value(serde_json::json!({
            "activityId":"tool:live", "kind":"tool", "status":"active", "label":"bash",
            "runId":"run:test", "callId":"call:live", "sequence":1, "startedAt":"1",
            "liveOutput":{"stdout":"执行中\n", "stderr":"诊断\n", "stdoutBytes":10, "stderrBytes":7, "truncated":true}
        })).unwrap();
        let mut plain = String::new();
        render_activity_plain(Language::ZhCn, &mut plain, &activity);
        let mut lines = Vec::new();
        push_activity_summary(Language::ZhCn, &mut lines, &activity);
        let styled = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        for output in [&plain, &styled] {
            assert!(output.contains("[执行中]"));
            assert!(output.contains("执行中"));
            assert!(output.contains("诊断"));
        }
        assert!(styled.contains("/tool tool:live"));
        assert!(plain.contains("stdout 10 bytes · stderr 7 bytes"));
        assert!(plain.contains("仅保留最新片段"));
        assert!(plain.contains("已执行"));
        activity.status = "completed".into();
        activity.live_output = None;
        let mut terminal = String::new();
        render_activity_plain(Language::ZhCn, &mut terminal, &activity);
        assert!(terminal.contains("[已完成]"));
        assert!(!terminal.contains("执行中"));
        assert!(!terminal.contains("实时输出"));
        assert!(!terminal.contains("已执行"));
    }

    #[test]
    fn plain_and_terminal_tools_keep_original_error_details() {
        for (status, fields, expected) in [
            (
                "failed",
                serde_json::json!({"tool":{"operation":"fs.read", "resources":[], "error":{"code":"fs_read_failed", "message":"原始读取错误"}}}),
                "fs_read_failed: 原始读取错误",
            ),
            (
                "completed",
                serde_json::json!({"tool":{"operation":"bash", "resources":[], "projectionError":{"code":"bash_projection_environment_invalid", "message":"原始记录保留"}}}),
                "bash_projection_environment_invalid: 原始记录保留",
            ),
            (
                "indeterminate",
                serde_json::json!({"interruption":{"code":"result_unknown", "message":"原始传输错误"}}),
                "result_unknown: 原始传输错误",
            ),
            (
                "rejected",
                serde_json::json!({"inputRejection":{"code":"workspace_target_invalid", "message":"Not a directory",
                    "diagnostics":{"source":"kernel", "phase":"prepare", "category":"input", "retryable":false, "causes":[]},
                    "issues":[{"path":"$.path", "rule":"path", "message":"invalid path"}]}}),
                "workspace_target_invalid: Not a directory",
            ),
        ] {
            let mut value = serde_json::json!({"activityId":"tool:error", "kind":"tool", "status":status,
                "label":"fs.read", "runId":"run:test", "callId":"call:error", "sequence":1});
            value
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            let activity: ActivityProjection = serde_json::from_value(value).unwrap();
            let mut plain = String::new();
            render_activity_plain(Language::ZhCn, &mut plain, &activity);
            let mut lines = Vec::new();
            push_activity_summary(Language::ZhCn, &mut lines, &activity);
            assert!(plain.contains(expected));
            assert!(lines.iter().any(|line| line.to_string().contains(expected)));
        }
        let input = serde_json::from_value(serde_json::json!({"commandId":"command:q", "messageId":"message:q", "runId":"run:q",
            "text":"保留原文🙂", "filesystemReferences":[], "pluginSelections":[], "sequence":1, "createdAt":"now", "status":"notApplied"})).unwrap();
        assert_eq!(
            queued_input_lines(Language::ZhCn, &input),
            vec!["未执行: 保留原文🙂"]
        );
    }

    #[test]
    fn single_column_layout_keeps_long_input_cursor_inside_editor() {
        let client = HttpKernelClient::new(
            KernelClientConfig::new("http://127.0.0.1:1")
                .with_host_shell_token(format!("dchost_{}", "01".repeat(32))),
        )
        .unwrap();
        let mut app = TuiApp::new(
            client,
            Renderer::default(),
            TuiHostOptions {
                language: Language::ZhCn,
                workspace_path: None,
                session_id: None,
                plugin_uris: vec![],
            },
        );
        app.push_input_text(&format!("{}\n最后一行", "中文输入 e\u{301} ".repeat(100)));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| app.renderer().draw(frame, &app))
            .unwrap();
        let contents = format!("{:?}", terminal.backend().buffer());
        assert!(contents.contains("DeepCode"));
        assert!(contents.contains("最后一行"));
        assert!(!contents.contains("本对话暂无任务"));
        let cursor = terminal.get_cursor_position().unwrap();
        assert!(
            cursor.x < 79 && cursor.y >= 17 && cursor.y < 21,
            "{cursor:?}"
        );
    }

    #[test]
    fn transcript_preserves_newlines_and_scrolls_wrapped_rows() {
        let paragraph =
            Paragraph::new(Text::raw("abcdefghijklmnop\n最终正文")).wrap(Wrap { trim: false });
        assert_eq!(paragraph.line_count(8), 3);
        let mut terminal = Terminal::new(TestBackend::new(8, 1)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(paragraph.clone().scroll((2, 0)), frame.area()))
            .unwrap();
        assert!(format!("{:?}", terminal.backend().buffer()).contains("最终正文"));
        let short = Paragraph::new(Text::raw("短行\n\n第二段\n末行"));
        assert_eq!(
            short.line_count(80),
            4,
            "explicit newlines must survive even when no wrapping is needed"
        );
        terminal
            .draw(|frame| frame.render_widget(short.clone().scroll((2, 0)), frame.area()))
            .unwrap();
        assert!(format!("{:?}", terminal.backend().buffer()).contains("第二段"));
    }
}

impl Renderer {
    pub fn draw(&self, frame: &mut Frame<'_>, app: &TuiApp) {
        let language = app.language();
        let area = frame.area().inner(Margin::new(1, 0));
        let input_height = input_lines(app.input(), area.width.saturating_sub(4))
            .len()
            .clamp(1, 4) as u16
            + 2;
        let decision = decision_lines(language, app.projection());
        let working = working_indicator(
            app,
            (self.animation_started.elapsed().as_millis() / 150) as usize,
        );
        let decision_height = if decision.is_empty() {
            0
        } else {
            (decision.len() as u16 + 2).min(if area.height < 20 { 4 } else { 6 })
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(if area.height < 18 { 1 } else { 2 }),
                Constraint::Min(1),
                Constraint::Length(decision_height),
                Constraint::Length(u16::from(working.is_some())),
                Constraint::Length(input_height),
                Constraint::Length(2),
            ])
            .split(area);
        self.draw_header(frame, rows[0], app);
        if app.context_open() {
            self.draw_context(frame, rows[1], app);
        } else if app.resource_preview().is_some() || app.detail_preview().is_some() {
            self.draw_resource(frame, rows[1], app);
        } else if app.tasks_open() {
            self.draw_todo(frame, rows[1], app);
        } else {
            self.draw_projection(frame, rows[1], app);
        }
        if !decision.is_empty() {
            frame.render_widget(
                Paragraph::new(multiline_text(decision))
                    .block(
                        Block::default()
                            .borders(Borders::LEFT)
                            .border_style(Style::default().fg(Color::Yellow)),
                    )
                    .wrap(Wrap { trim: false }),
                rows[2],
            );
        }
        if let Some(working) = working {
            frame.render_widget(
                Paragraph::new(clipped(&working, rows[3].width))
                    .style(Style::default().fg(Color::Cyan)),
                rows[3],
            );
        }
        self.draw_input(frame, rows[4], app);
        if app.plugin_picker_open() {
            self.draw_plugin_picker(frame, rows[1], app);
        }
        if app.model_picker_open() {
            self.draw_model_picker(frame, rows[1], app);
        }
        if app.session_picker_open() {
            self.draw_session_picker(frame, rows[1], app);
        }
        self.draw_footer(frame, rows[5], app);
    }

    pub fn render_plain(&self, app: &TuiApp) -> String {
        let language = app.language();
        let mut output = String::from("DeepCode TUI\n");
        output.push_str("────────────────────────────────────────\n");
        if let Some(projection) = app.projection() {
            output.push_str(&language.format(
                "tui.sessionIdentity",
                &[
                    projection.session_id.clone(),
                    projection.revision.to_string(),
                ],
            ));
            for binding in &projection.session_directory_indexes {
                output.push_str(&language.format(
                    "tui.directoryIndex",
                    &[
                        format!("{}", binding.display_name),
                        format!("{}", binding.workspace_id),
                    ],
                ));
            }
            if app.context_open() {
                render_context_plain(language, &mut output, projection);
            }
            let items = timeline_items(projection);
            let last_by_run: std::collections::HashMap<_, _> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.run_id().map(|run| (run.to_string(), index)))
                .collect();
            for (index, item) in items.into_iter().enumerate() {
                let last_run = item
                    .run_id()
                    .filter(|run| last_by_run.get(*run) == Some(&index))
                    .map(str::to_string);
                match item {
                    TimelineItem::Message { value: message, .. } => {
                        output.push_str(&format!(
                            "{}: {}\n",
                            kind_label(language, &message.role),
                            message.display_text()
                        ));
                        output.push_str(&source_references(
                            language,
                            message.source_references.as_ref(),
                        ));
                        if !message.filesystem_references.is_empty() {
                            output.push_str(&language.format(
                                "tui.filesystemReferences",
                                &[format!("{}", message
                                    .filesystem_references
                                    .iter()
                                    .map(|reference| reference.display_name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", "))],
                            ));
                        }
                    }
                    TimelineItem::Narrative {
                        value: narrative, ..
                    } => {
                        output.push_str(&format!("{}\n", narrative.display_text()));
                        output.push_str(&source_references(
                            language,
                            narrative.source_references.as_ref(),
                        ));
                    }
                    TimelineItem::Plan { value: plan, .. } => {
                        render_timeline_plan_plain(language, &mut output, plan);
                    }
                    TimelineItem::ToolGroup { activities, .. } => {
                        for activity in activities {
                            render_activity_plain(language, &mut output, activity);
                        }
                    }
                }
                if let Some(run) = last_run {
                    for line in round_change_lines(language, projection, &run) {
                        output.push_str(&line);
                        output.push('\n');
                    }
                }
            }
            if let Some(draft) = projection.assistant_draft.as_ref() {
                if let Some(preview) = draft.plan_preview.as_ref() {
                    output.push_str(&language.format(
                        "tui.generatingPlan",
                        &[format!("{}", preview.title), format!("{}", preview.summary)],
                    ));
                    for (index, title) in preview.steps.iter().enumerate() {
                        output.push_str(&format!("{}. {title}\n", index + 1));
                    }
                    output.push_str(language.text("tui.confirmWhenGenerated"));
                }
                for block in &draft.blocks {
                    if let Some((_, content)) = block.text() {
                        output.push_str(content);
                        output.push_str("▋\n");
                    }
                }
            }
            for input in &projection.queued_inputs {
                for line in queued_input_lines(language, input) {
                    output.push_str(&line);
                    output.push('\n');
                }
            }
            if let Some(plan) = projection.pending_plan.as_ref() {
                render_plan_plain(language, &mut output, plan);
            }
            if let Some(interaction) = projection.pending_interaction.as_ref() {
                output.push_str(
                    &language.format("tui.replyRequired", &[format!("{}", interaction.prompt)]),
                );
                if let Some(options) = interaction.options.as_ref() {
                    for (index, option) in options.iter().enumerate() {
                        output.push_str(&format!("  {}. {}\n", index + 1, option.label));
                    }
                }
            }
            if projection.pending_approval.is_some() {
                output.push_str(&decision_details(language, Some(projection)));
                output.push('\n');
            }
            render_todo_plain(language, &mut output, projection);
            if !app.context_open() {
                output.push_str(&language.format(
                    "tui.cacheHitPlain",
                    &[format!("{}", cache_hit_label(projection))],
                ));
            }
            output.push_str(&format!("{}\n", run_label(language, Some(projection))));
            if projection.terminal_error.is_some() {
                output.push_str(&failure_details(language, Some(projection)));
                output.push('\n');
            }
        } else {
            output.push_str(language.text("agent.session.newTitle"));
            output.push('\n');
        }
        let selected_plugins = app.selected_plugin_labels();
        if !selected_plugins.is_empty() {
            output.push_str(&language.format(
                "tui.nextPlugins",
                &[format!("{}", selected_plugins.join(", "))],
            ));
        }
        if app.session_picker_open() {
            output.push_str(&format!("{}\n", app.language().text("tui.sessionsTitle")));
            let entries = app.session_picker_entries();
            if entries.is_empty() {
                output.push_str(app.language().text("tui.sessionsEmpty"));
                output.push('\n');
            }
            for (label, _) in entries {
                output.push_str(&label);
                output.push('\n');
            }
            output.push_str(app.language().text("tui.sessionsHint"));
            output.push('\n');
        }
        if app.model_picker_open() {
            output.push_str(&format!("{}：\n", app.model_picker_title()));
            for (id, label, selected) in app.model_picker_entries() {
                output.push_str(&format!(
                    "{} {label} ({id})\n",
                    if selected { ">" } else { " " }
                ));
            }
        }
        if app.plugin_picker_open() {
            output.push_str(language.text("tui.pluginCandidates"));
            for entry in app.plugin_picker_entries(8) {
                output.push_str(&format!(
                    "  {} {} · {} ({})\n",
                    if entry.highlighted { ">" } else { " " },
                    entry.display_name,
                    entry.short_description,
                    entry.uri,
                ));
            }
        }
        output.push_str("────────────────────────────────────────\n");
        if let Some(detail) = app.detail_preview() {
            output.push_str(detail);
            output.push('\n');
        }
        if let Some(resource) = app.resource_preview() {
            output.push_str(&resource.content);
            if resource.truncated {
                output.push_str(language.text("tui.partialResource"));
            }
        }
        if app.reasoning_enabled() {
            if let Some(draft) = app
                .projection()
                .and_then(|projection| projection.assistant_draft.as_ref())
            {
                output.push_str(
                    &language.format("tui.readReasoning", &[format!("{}", draft.turn_id)]),
                );
            }
        }
        output.push_str(app.status());
        output.push('\n');
        output
    }

    fn draw_header(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let projection = app.projection();
        let model = projection
            .and_then(|p| {
                p.run
                    .as_ref()
                    .map(|run| run.profile_id.as_str())
                    .or_else(|| {
                        p.model_settings
                            .as_ref()
                            .map(|settings| settings.profile_id.as_str())
                    })
            })
            .unwrap_or("");
        let effort = projection.and_then(|p| {
            p.run
                .as_ref()
                .and_then(|run| run.reasoning_effort.as_deref())
                .or_else(|| {
                    p.model_settings
                        .as_ref()
                        .and_then(|settings| settings.reasoning_effort_override.as_deref())
                })
        });
        let model = format!(
            "{model}{}",
            effort
                .map(|value| format!(" · {}", reasoning_effort_label(language, value)))
                .unwrap_or_default()
        );
        let status = run_label(language, projection);
        let left = format!("DeepCode  ·  {status}");
        let available = area
            .width
            .saturating_sub(Line::from(left.as_str()).width() as u16 + 2);
        let right = clipped(&model, available);
        let gap = usize::from(area.width)
            .saturating_sub(Line::from(left.as_str()).width() + Line::from(right.as_str()).width());
        let workspace = projection
            .map(|p| {
                p.session_directory_indexes
                    .iter()
                    .map(|binding| binding.display_name.as_str())
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .unwrap_or_default();
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(vec![
                    Span::styled(
                        left,
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" ".repeat(gap)),
                    Span::raw(right),
                ]),
                Line::from(Span::styled(
                    clipped(&workspace, area.width),
                    Style::default().fg(Color::DarkGray),
                )),
            ]),
            area,
        );
    }

    fn draw_footer(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let mut metrics = Vec::new();
        if let Some(projection) = app.projection() {
            if let Some(usage) = projection.context_usage.as_ref() {
                metrics.push(language.format(
                    "tui.contextMetric",
                    &[format!(
                        "{}",
                        percent_label(
                            usage.input_tokens.saturating_add(usage.output_tokens),
                            usage.context_window_tokens
                        )
                    )],
                ));
            }
            metrics.push(language.format(
                "tui.tokenMetrics",
                &[
                    format!("{}", format_number(projection.token_usage.input_tokens)),
                    format!("{}", format_number(projection.token_usage.output_tokens)),
                ],
            ));
            if projection.token_usage.cache_available {
                metrics.push(language.format(
                    "tui.cacheHit",
                    &[format!("{}", cache_hit_label(projection))],
                ));
            }
        }
        let metrics = metrics.join(" · ");
        let hint = if area.width >= 84 {
            language.text("tui.footerHint")
        } else {
            "  /help"
        };
        let metrics = clipped(&format!("{metrics}{hint}"), area.width);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(metrics),
                Line::from(clipped(app.status(), area.width)),
            ])
            .style(Style::default().fg(Color::DarkGray)),
            area,
        );
    }

    fn draw_todo(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let mut lines = Vec::new();
        if let Some(todo) = app
            .projection()
            .and_then(|projection| projection.todo_list.as_ref())
        {
            if todo.items.is_empty() {
                lines.push(Line::from(Span::styled(
                    language.text("tui.noTasks"),
                    Style::default().fg(Color::DarkGray),
                )));
            } else {
                for item in &todo.items {
                    let (marker, color) = match item.status.as_str() {
                        "completed" => ("✓", Color::Green),
                        "inProgress" => ("●", Color::Cyan),
                        "blocked" => ("!", Color::Yellow),
                        _ => ("○", Color::DarkGray),
                    };
                    lines.push(Line::from(vec![
                        Span::styled(format!("{marker} "), Style::default().fg(color)),
                        Span::raw(format!(
                            "{} · {}",
                            item.text,
                            language.text(match item.status.as_str() {
                                "completed" => "deepcodeGui.tasks.status.completed",
                                "inProgress" => "deepcodeGui.tasks.status.inProgress",
                                "blocked" => "deepcodeGui.tasks.status.blocked",
                                _ => "deepcodeGui.tasks.status.pending",
                            })
                        )),
                    ]));
                }
            }
        } else {
            lines.push(Line::from(Span::styled(
                language.text("tui.noConversationTasks"),
                Style::default().fg(Color::DarkGray),
            )));
        }
        if let Some(projection) = app.projection() {
            if let Some(note) = todo_note(language, projection) {
                lines.push(Line::from(note));
            }
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .scroll((app.detail_scroll(), 0))
                .block(
                    Block::default()
                        .borders(Borders::TOP)
                        .title(language.text("tui.tasksTitle")),
                ),
            area,
        );
    }

    fn draw_resource(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        if let Some(detail) = app.detail_preview() {
            frame.render_widget(
                Paragraph::new(detail)
                    .scroll((app.detail_scroll(), 0))
                    .wrap(Wrap { trim: false })
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title(language.text("tui.detailsTitle")),
                    ),
                area,
            );
            return;
        }
        let Some(resource) = app.resource_preview() else {
            return;
        };
        frame.render_widget(
            Paragraph::new(resource.content.as_str())
                .scroll((app.detail_scroll(), 0))
                .wrap(Wrap { trim: false })
                .block(Block::default().borders(Borders::ALL).title(
                    language.format("tui.readOnlyTitle", &[format!("{}", resource.logical_path)]),
                )),
            area,
        );
    }

    fn draw_context(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let width = usize::from(area.width.saturating_sub(4)).max(1);
        frame.render_widget(
            Paragraph::new(context_lines(language, app.projection(), width))
                .wrap(Wrap { trim: false })
                .scroll((app.detail_scroll(), 0))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(language.text("tui.contextTitle")),
                ),
            area,
        );
    }

    fn draw_projection(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let body = Rect {
            width: area.width.saturating_sub(1),
            ..area
        };
        let key = TranscriptKey {
            language: app.language(),
            session: app
                .projection()
                .map(|projection| (projection.session_id.clone(), projection.revision)),
            // Drafts and tool output are live overlays; they need not advance journal revision.
            draft: app
                .projection()
                .and_then(|projection| projection.assistant_draft.clone()),
            live_output: app
                .projection()
                .into_iter()
                .flat_map(|projection| &projection.activities)
                .filter_map(|activity| {
                    activity
                        .live_output
                        .clone()
                        .map(|output| (activity.activity_id.clone(), output))
                })
                .collect(),
            reasoning: app.reasoning_enabled(),
            width: body.width,
            height: body.height,
        };
        let mut cache = self.transcript.borrow_mut();
        if cache.as_ref().is_none_or(|cache| cache.key != key) {
            *cache = Some(TranscriptCache {
                key,
                text: self.transcript_text(body, app),
            });
        }
        let paragraph =
            Paragraph::new(cache.as_ref().unwrap().text.clone()).wrap(Wrap { trim: false });
        let height = paragraph.line_count(body.width);
        let maximum = height.saturating_sub(usize::from(body.height));
        let offset = app.transcript_offset(maximum);
        frame.render_widget(
            paragraph.scroll((offset.min(u16::MAX as usize) as u16, 0)),
            body,
        );
        if maximum > 0 {
            frame.render_stateful_widget(
                Scrollbar::default()
                    .begin_symbol(None)
                    .end_symbol(None)
                    .track_symbol(Some("│"))
                    .thumb_symbol("┃")
                    .track_style(Style::default().fg(Color::DarkGray))
                    .thumb_style(Style::default().fg(Color::Gray)),
                area,
                &mut ScrollbarState::new(maximum + 1).position(offset),
            );
        }
    }

    fn transcript_text(&self, area: Rect, app: &TuiApp) -> Text<'static> {
        let language = app.language();
        let mut lines = Vec::new();
        if let Some(projection) = app.projection() {
            let items = timeline_items(projection);
            let last_by_run: std::collections::HashMap<_, _> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.run_id().map(|run| (run.to_string(), index)))
                .collect();
            for (index, item) in items.into_iter().enumerate() {
                let last_run = item
                    .run_id()
                    .filter(|run| last_by_run.get(*run) == Some(&index))
                    .map(str::to_string);
                match item {
                    TimelineItem::Message { value: message, .. } => {
                        let color = if message.role == "user" {
                            Color::Blue
                        } else if message.role == "assistant" {
                            Color::Reset
                        } else {
                            Color::DarkGray
                        };
                        let role = kind_label(language, &message.role);
                        lines.push(Line::from(Span::styled(
                            role.to_string(),
                            Style::default().fg(color).add_modifier(Modifier::BOLD),
                        )));
                        if message.role == "assistant" {
                            lines.extend(crate::markdown::render(
                                message.display_text(),
                                area.width,
                                Style::default(),
                            ));
                        } else {
                            lines.extend(Text::raw(message.display_text().to_owned()).lines);
                        }
                        lines.extend(crate::markdown::render(
                            &source_references(language, message.source_references.as_ref()),
                            area.width,
                            Style::default(),
                        ));
                        if !message.filesystem_references.is_empty() {
                            lines.push(Line::from(Span::styled(
                                language.format(
                                    "tui.filesystemReferencesInline",
                                    &[format!(
                                        "{}",
                                        message
                                            .filesystem_references
                                            .iter()
                                            .map(|reference| reference.display_name.as_str())
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    )],
                                ),
                                Style::default().fg(Color::DarkGray),
                            )));
                        }
                    }
                    TimelineItem::Narrative {
                        value: narrative, ..
                    } => {
                        lines.extend(crate::markdown::render(
                            narrative.display_text(),
                            area.width,
                            Style::default().fg(Color::Gray),
                        ));
                        lines.extend(crate::markdown::render(
                            &source_references(language, narrative.source_references.as_ref()),
                            area.width,
                            Style::default(),
                        ));
                    }
                    TimelineItem::Plan { value: plan, .. } => {
                        push_timeline_plan_lines(language, &mut lines, plan);
                    }
                    TimelineItem::ToolGroup { activities, .. } => {
                        for activity in activities {
                            push_activity_summary(language, &mut lines, activity);
                        }
                    }
                }
                if let Some(run) = last_run {
                    lines.extend(
                        round_change_lines(language, projection, &run)
                            .into_iter()
                            .map(Line::from),
                    );
                }
                lines.push(Line::from(""));
            }
            for input in &projection.queued_inputs {
                lines.extend(
                    queued_input_lines(language, input)
                        .into_iter()
                        .flat_map(|line| Text::raw(line).lines),
                );
            }
            if app.reasoning_enabled() {
                if let Some(draft) = projection.assistant_draft.as_ref() {
                    lines.push(Line::from(
                        language.format("tui.reasoningDetails", &[format!("{}", draft.turn_id)]),
                    ));
                }
            }
            if let Some(draft) = projection.assistant_draft.as_ref() {
                if let Some(preview) = draft.plan_preview.as_ref() {
                    lines.push(Line::from(language.format(
                        "tui.generatingPlanInline",
                        &[format!("{}", preview.title)],
                    )));
                    lines.extend(Text::raw(preview.summary.clone()).lines);
                    for (index, title) in preview.steps.iter().enumerate() {
                        lines.push(Line::from(format!("{}. {title}", index + 1)));
                    }
                    lines.push(Line::from(language.text("tui.confirmWhenGeneratedInline")));
                }
                for block in &draft.blocks {
                    if let Some((_, content)) = block.text() {
                        lines.extend(crate::markdown::render(
                            content,
                            area.width,
                            Style::default(),
                        ));
                        lines.push(Line::from(Span::styled(
                            "▋",
                            Style::default().fg(Color::Cyan),
                        )));
                        lines.push(Line::from(""));
                    }
                }
            }
        }
        if let Some(error) = app.projection().and_then(|p| p.terminal_error.as_ref()) {
            lines.push(Line::from(Span::styled(
                format!("{}: {}", error.code, error.message),
                Style::default().fg(Color::Red),
            )));
            lines.push(Line::from(Span::styled(
                language.text("tui.failureDetailsHint"),
                Style::default().fg(Color::DarkGray),
            )));
        }
        if lines.is_empty() {
            let logo = if area.width >= 62 && area.height >= 14 {
                vec![
                    r"  ____                  ____          _",
                    r" |  _ \  ___  ___ _ __ / ___|___   __| | ___",
                    r" | | | |/ _ \/ _ \ '_ \ |   / _ \ / _` |/ _ \",
                    r" | |_| |  __/  __/ |_) | |__| (_) | (_| |  __/",
                    r" |____/ \___|\___| .__/ \____\___/ \__,_|\___|",
                    r"                |_|",
                ]
            } else {
                vec!["", "  DeepCode", ""]
            };
            lines.extend(
                logo.into_iter()
                    .map(|line| Line::from(Span::styled(line, Style::default().fg(Color::Cyan)))),
            );
            lines.push(Line::from(""));
            lines.push(Line::from(language.text("tui.welcome")));
            lines.push(Line::from(Span::styled(
                language.text("tui.welcomeHint"),
                Style::default().fg(Color::DarkGray),
            )));
        }
        multiline_text(lines)
    }

    fn draw_input(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let selected_plugins = app.selected_plugin_labels();
        let mut title = language.text("tui.inputTitle").to_string();
        if let Some(profile) = app.next_message_profile() {
            title.push_str(&language.format("tui.nextProfile", &[format!("{}", profile)]));
        }
        if selected_plugins.is_empty() {
            title.push_str(language.text("tui.inputPluginHint"));
        } else {
            title.push_str(&language.format(
                "tui.inputSelectedPlugins",
                &[format!("{}", selected_plugins.join(", "))],
            ));
        }
        let title = clipped(&title, area.width.saturating_sub(2));
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .title(title)
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = block.inner(area).inner(Margin::new(1, 0));
        frame.render_widget(block, area);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let lines = input_lines(app.input(), inner.width);
        let column = lines
            .last()
            .map(|line| line.width().saturating_sub(1))
            .unwrap_or(0) as u16;
        let start = lines.len().saturating_sub(usize::from(inner.height));
        let row = lines.len().saturating_sub(start + 1) as u16;
        frame.render_widget(
            Paragraph::new(lines.into_iter().skip(start).collect::<Vec<_>>()),
            inner,
        );
        frame.set_cursor_position((inner.x + column.min(inner.width - 1), inner.y + row));
    }

    fn draw_session_picker(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let entries = app.session_picker_entries();
        let visible = usize::from(area.height.saturating_sub(2)).max(1);
        let selected = entries
            .iter()
            .position(|(_, selected)| *selected)
            .unwrap_or(0);
        let start = selected.saturating_sub(visible - 1);
        let mut lines: Vec<Line<'_>> = entries
            .iter()
            .skip(start)
            .take(visible)
            .map(|(label, selected)| {
                Line::from(Span::styled(
                    format!("{} {label}", if *selected { ">" } else { " " }),
                    Style::default().fg(if *selected { Color::Cyan } else { Color::Reset }),
                ))
            })
            .collect();
        if lines.is_empty() {
            lines.push(Line::from(app.language().text("tui.sessionsEmpty")));
        }
        frame.render_widget(Clear, area);
        frame.render_widget(
            Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(format!(
                " {} · ↑/↓ · Enter · Esc ",
                app.language().text("tui.sessionsTitle")
            ))),
            area,
        );
    }

    fn draw_model_picker(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let language = app.language();
        let entries = app.model_picker_entries();
        let mut lines: Vec<Line<'_>> = entries
            .iter()
            .map(|(_, label, selected)| {
                Line::from(Span::styled(
                    format!("{} {label}", if *selected { ">" } else { " " }),
                    Style::default().fg(if *selected { Color::Cyan } else { Color::Reset }),
                ))
            })
            .collect();
        if lines.is_empty() {
            lines.push(Line::from(language.text("tui.noEnabledModels")));
        }
        let selected = entries
            .iter()
            .position(|(_, _, selected)| *selected)
            .unwrap_or(0);
        let scroll = selected.saturating_sub(area.height.saturating_sub(4) as usize);
        frame.render_widget(Clear, area);
        frame.render_widget(
            Paragraph::new(lines).scroll((scroll as u16, 0)).block(
                Block::default().borders(Borders::ALL).title(format!(
                    " {} · ↑/↓ · Enter · Esc ",
                    app.model_picker_title()
                )),
            ),
            area,
        );
    }

    fn draw_plugin_picker(&self, frame: &mut Frame<'_>, anchor: Rect, app: &TuiApp) {
        let language = app.language();
        if anchor.height == 0 || anchor.width == 0 {
            return;
        }
        let borders = if anchor.height > 2 {
            Borders::ALL
        } else {
            Borders::NONE
        };
        let inner_height = anchor
            .height
            .saturating_sub(if anchor.height > 2 { 2 } else { 0 });
        let entry_height = if inner_height >= 2 { 2 } else { 1 };
        let entries = app.plugin_picker_entries(usize::from(inner_height / entry_height).min(8));
        let content_height = entries
            .len()
            .saturating_mul(usize::from(entry_height))
            .max(1);
        let height =
            u16::try_from(content_height.saturating_add(if anchor.height > 2 { 2 } else { 0 }))
                .unwrap_or(anchor.height)
                .min(anchor.height.max(1));
        let area = Rect {
            x: anchor.x,
            y: anchor
                .y
                .saturating_add(anchor.height.saturating_sub(height)),
            width: anchor.width,
            height,
        };
        let mut lines = Vec::new();
        if entries.is_empty() {
            lines.push(Line::from(Span::styled(
                language.text("tui.noMatchingPlugins"),
                Style::default().fg(Color::DarkGray),
            )));
        } else {
            for entry in entries {
                let marker = if entry.highlighted { ">" } else { " " };
                let selected = if entry.already_selected {
                    language.text("tui.pluginSelectedMarker")
                } else {
                    ""
                };
                let style = if entry.highlighted {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Reset)
                };
                let width = area
                    .width
                    .saturating_sub(if borders == Borders::ALL { 2 } else { 0 });
                lines.push(Line::from(Span::styled(
                    clipped(&format!("{marker} {}{selected}", entry.display_name), width),
                    style,
                )));
                if entry_height == 2 {
                    lines.push(Line::from(Span::styled(
                        clipped(
                            &format!("  {} · {}", entry.short_description, entry.uri),
                            width,
                        ),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
            }
        }
        let title = app
            .plugin_picker_query()
            .filter(|query| !query.is_empty())
            .map(|query| language.format("tui.pluginPickerQueryTitle", &[format!("{}", query)]))
            .unwrap_or_else(|| language.text("tui.pluginPickerTitle").to_string());
        frame.render_widget(Clear, area);
        frame.render_widget(
            Paragraph::new(lines).block(Block::default().borders(borders).title(title)),
            area,
        );
    }
}

const CONTEXT_PARTITIONS: [(&str, &str); 7] = [
    ("instructions", "tui.partition.instructions"),
    ("sessionControls", "tui.partition.sessionControls"),
    ("tools", "tui.partition.tools"),
    ("workspaceBindings", "tui.partition.workspaceBindings"),
    ("contextProviders", "tui.partition.contextProviders"),
    ("journalMessages", "tui.partition.journalMessages"),
    ("filesystemReferences", "tui.partition.filesystemReferences"),
];

fn context_lines(
    language: Language,
    projection: Option<&SessionProjection>,
    bar_width: usize,
) -> Vec<Line<'static>> {
    let Some(projection) = projection else {
        return vec![Line::from(Span::styled(
            language.text("tui.contextUnavailable"),
            Style::default().fg(Color::DarkGray),
        ))];
    };
    let mut lines = Vec::new();
    if let Some(usage) = projection.context_usage.as_ref() {
        let used = usage.input_tokens.saturating_add(usage.output_tokens);
        lines.push(Line::from(vec![
            Span::styled(
                language.text("tui.contextPrefix"),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!(
                "{} / {} Token · {}",
                format_number(used),
                format_number(usage.context_window_tokens),
                percent_label(used, usage.context_window_tokens),
            )),
        ]));
        lines.push(context_usage_bar(usage, bar_width));
        lines.push(context_usage_legend(language, usage));
    } else {
        lines.push(Line::from(Span::styled(
            language.text("tui.contextUnavailable"),
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(
            language.text("tui.cacheHitTitle"),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(cache_detail_label(language, &projection.token_usage)),
    ]));
    let (detail, ratio) = last_request_cache_summary(language, projection.context_usage.as_ref());
    lines.push(Line::from(vec![
        Span::styled(
            language.text("tui.lastRequestCacheTitle"),
            Style::default().fg(Color::Cyan),
        ),
        Span::raw(detail),
    ]));
    lines.push(cache_bar(ratio, bar_width));

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        language.text("tui.requestTitle"),
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )));
    let Some(receipt) = current_context_receipt(projection) else {
        lines.push(Line::from(Span::styled(
            "N/A",
            Style::default().fg(Color::DarkGray),
        )));
        return lines;
    };
    let metrics = context_partition_metrics(receipt);
    for ((kind, label), metric) in CONTEXT_PARTITIONS.iter().zip(metrics) {
        let label = language.text(label);
        let token_label = partition_token_label(metric);
        lines.push(Line::from(vec![
            Span::styled("▪ ", Style::default().fg(partition_color(kind))),
            Span::raw(language.format(
                "tui.partitionMetric",
                &[format!("{}", label), format!("{}", metric.item_count)],
            )),
            if metric.estimated_input_tokens.is_some() {
                Span::raw(token_label)
            } else {
                Span::styled(token_label, Style::default().fg(Color::DarkGray))
            },
        ]));
    }
    lines
}

fn context_usage_bar(usage: &ContextUsageProjection, width: usize) -> Line<'static> {
    let total = usage.context_window_tokens;
    if total == 0 {
        return Line::from(Span::styled("N/A", Style::default().fg(Color::DarkGray)));
    }
    let input = usage.input_tokens.min(total);
    let output = usage.output_tokens.min(total.saturating_sub(input));
    let free = total.saturating_sub(input.saturating_add(output));
    let (input_width, output_width, free_width) = segment_widths(input, output, free, width);
    Line::from(vec![
        Span::styled("█".repeat(input_width), Style::default().fg(Color::Green)),
        Span::styled("█".repeat(output_width), Style::default().fg(Color::Yellow)),
        Span::styled("░".repeat(free_width), Style::default().fg(Color::DarkGray)),
    ])
}

fn context_usage_legend(language: Language, usage: &ContextUsageProjection) -> Line<'static> {
    let used = usage.input_tokens.saturating_add(usage.output_tokens);
    let free = usage.context_window_tokens.saturating_sub(used);
    Line::from(vec![
        Span::styled(
            language.text("tui.usageInput"),
            Style::default().fg(Color::Green),
        ),
        Span::raw(format_number(usage.input_tokens)),
        Span::styled(
            language.text("tui.usageOutput"),
            Style::default().fg(Color::Yellow),
        ),
        Span::raw(format_number(usage.output_tokens)),
        Span::styled(
            language.text("tui.usageFree"),
            Style::default().fg(Color::DarkGray),
        ),
        Span::raw(format_number(free)),
    ])
}

fn cache_bar(cache_hit_ratio: Option<f64>, width: usize) -> Line<'static> {
    let Some(cache_hit_ratio) = cache_hit_ratio else {
        return Line::from(Span::styled("N/A", Style::default().fg(Color::DarkGray)));
    };
    let hit_width = (cache_hit_ratio * width as f64).round() as usize;
    let hit_width = hit_width.min(width);
    let miss_width = width.saturating_sub(hit_width);
    Line::from(vec![
        Span::styled("█".repeat(hit_width), Style::default().fg(Color::Green)),
        Span::styled("█".repeat(miss_width), Style::default().fg(Color::Yellow)),
    ])
}

fn segment_widths(input: u64, output: u64, free: u64, width: usize) -> (usize, usize, usize) {
    let total = input.saturating_add(output).saturating_add(free);
    if total == 0 {
        return (0, 0, width);
    }
    let input_width = scaled_width(input, total, width).min(width);
    let output_width = scaled_width(output, total, width).min(width.saturating_sub(input_width));
    let free_width = width.saturating_sub(input_width.saturating_add(output_width));
    (input_width, output_width, free_width)
}

fn scaled_width(value: u64, total: u64, width: usize) -> usize {
    if total == 0 || width == 0 {
        return 0;
    }
    let numerator = u128::from(value)
        .saturating_mul(width as u128)
        .saturating_add(u128::from(total / 2));
    usize::try_from(numerator / u128::from(total)).unwrap_or(width)
}

fn current_context_receipt(
    projection: &SessionProjection,
) -> Option<&ContextCompositionProjection> {
    if let Some(usage) = projection.context_usage.as_ref() {
        return projection
            .context_compositions
            .iter()
            .rev()
            .find(|receipt| {
                receipt.purpose == "agent"
                    && receipt.provider_request_id == usage.provider_request_id
            });
    }
    projection
        .context_compositions
        .iter()
        .rev()
        .find(|receipt| receipt.purpose == "agent")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ContextPartitionMetric {
    item_count: u64,
    estimated_input_tokens: Option<u64>,
}

fn context_partition_metrics(
    receipt: &ContextCompositionProjection,
) -> [ContextPartitionMetric; 7] {
    let mut metrics = [ContextPartitionMetric::default(); 7];
    for partition in &receipt.partitions {
        if let Some(index) = partition_index(&partition.kind) {
            metrics[index] = ContextPartitionMetric {
                item_count: partition.item_count,
                estimated_input_tokens: (partition.token_source.as_deref()
                    == Some("sessionEstimated"))
                .then_some(partition.estimated_input_tokens)
                .flatten(),
            };
        }
    }
    metrics
}

fn partition_token_label(metric: ContextPartitionMetric) -> String {
    metric
        .estimated_input_tokens
        .map(|tokens| format!("≈{} Token", format_number(tokens)))
        .unwrap_or_else(|| "N/A Token".to_string())
}

fn partition_index(kind: &str) -> Option<usize> {
    CONTEXT_PARTITIONS
        .iter()
        .position(|(candidate, _)| *candidate == kind)
}

fn partition_color(label: &str) -> Color {
    match label {
        "tools" | "filesystemReferences" => Color::Yellow,
        "workspaceBindings" => Color::Blue,
        "contextProviders" | "journalMessages" => Color::Green,
        _ => Color::DarkGray,
    }
}

fn percent_label(value: u64, total: u64) -> String {
    if total == 0 {
        return "N/A".to_string();
    }
    format!("{:.1}%", value as f64 * 100.0 / total as f64)
}

fn format_number(value: u64) -> String {
    let digits = value.to_string();
    let mut output = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            output.push(',');
        }
        output.push(digit);
    }
    output
}

fn render_context_plain(language: Language, output: &mut String, projection: &SessionProjection) {
    if let Some(usage) = projection.context_usage.as_ref() {
        let used = usage.input_tokens.saturating_add(usage.output_tokens);
        output.push_str(&language.format(
            "tui.contextPlain",
            &[
                format!("{}", format_number(used)),
                format!("{}", format_number(usage.context_window_tokens)),
                format!("{}", percent_label(used, usage.context_window_tokens)),
            ],
        ));
        output.push_str(&plain_usage_bar(usage, 40));
        output.push('\n');
    } else {
        output.push_str(language.text("tui.contextUnavailablePlain"));
    }
    output.push_str(&language.format(
        "tui.cacheHitPlain",
        &[format!(
            "{}",
            cache_detail_label(language, &projection.token_usage)
        )],
    ));
    let (detail, _) = last_request_cache_summary(language, projection.context_usage.as_ref());
    output.push_str(&language.format("tui.lastRequestCache", &[format!("{}", detail)]));
    output.push_str(language.text("tui.requestPlain"));
    if let Some(receipt) = current_context_receipt(projection) {
        let metrics = context_partition_metrics(receipt);
        for ((_, label), metric) in CONTEXT_PARTITIONS.iter().zip(metrics) {
            let label = language.text(label);
            output.push_str(&language.format(
                "tui.partitionMetricPlain",
                &[
                    format!("{}", label),
                    format!("{}", metric.item_count),
                    format!("{}", partition_token_label(metric)),
                ],
            ));
        }
    } else {
        output.push_str("  N/A\n");
    }
}

fn plain_usage_bar(usage: &ContextUsageProjection, width: usize) -> String {
    let total = usage.context_window_tokens;
    if total == 0 {
        return "[N/A]".to_string();
    }
    let input = usage.input_tokens.min(total);
    let output = usage.output_tokens.min(total.saturating_sub(input));
    let free = total.saturating_sub(input.saturating_add(output));
    let (input_width, output_width, free_width) = segment_widths(input, output, free, width);
    format!(
        "[{}{}{}]",
        "I".repeat(input_width),
        "O".repeat(output_width),
        "·".repeat(free_width),
    )
}

enum TimelineItem<'a> {
    Message {
        value: &'a ProjectionMessage,
    },
    Narrative {
        value: &'a NarrativeProjection,
    },
    Plan {
        value: &'a PlanProjection,
    },
    ToolGroup {
        activities: Vec<&'a ActivityProjection>,
    },
}

impl TimelineItem<'_> {
    fn run_id(&self) -> Option<&str> {
        match self {
            Self::Message { value } => value.run_id.as_deref(),
            Self::Narrative { value } => Some(&value.run_id),
            Self::Plan { value } => Some(&value.run_id),
            Self::ToolGroup { activities } => {
                activities.first().map(|activity| activity.run_id.as_str())
            }
        }
    }
}

fn round_change_lines(
    language: Language,
    projection: &SessionProjection,
    run_id: &str,
) -> Vec<String> {
    let changes = projection.file_changes_for_run(run_id);
    if changes.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![language.format("tui.roundChanges", &[format!("{}", run_id)])];
    lines.extend(changes.into_iter().map(|(record, index, change)| {
        format!(
            "  {} {} · /diff {} {}",
            change_kind_label(language, &change.kind),
            change.path,
            record,
            index
        )
    }));
    lines
}

fn timeline_items(projection: &SessionProjection) -> Vec<TimelineItem<'_>> {
    projection
        .timeline
        .iter()
        .map(|item| match item {
            SessionTimelineItem::Message { message_id, .. } => TimelineItem::Message {
                value: projection
                    .messages
                    .iter()
                    .find(|message| message.message_id == *message_id)
                    .expect("validated Session timeline message reference"),
            },
            SessionTimelineItem::Narrative { narrative_id, .. } => TimelineItem::Narrative {
                value: projection
                    .narratives
                    .iter()
                    .find(|narrative| narrative.narrative_id == *narrative_id)
                    .expect("validated Session timeline narrative reference"),
            },
            SessionTimelineItem::Plan {
                plan_id, revision, ..
            } => TimelineItem::Plan {
                value: projection
                    .plans
                    .iter()
                    .find(|plan| plan.plan_id == *plan_id && plan.revision == *revision)
                    .expect("validated Session timeline plan reference"),
            },
            SessionTimelineItem::ToolGroup { activity_ids, .. } => TimelineItem::ToolGroup {
                activities: activity_ids
                    .iter()
                    .map(|activity_id| {
                        projection
                            .activities
                            .iter()
                            .find(|activity| activity.activity_id == *activity_id)
                            .expect("validated Session timeline activity reference")
                    })
                    .collect(),
            },
        })
        .collect()
}

fn queued_input_lines(
    language: Language,
    input: &deepcode_kernel_client::QueuedInputProjection,
) -> Vec<String> {
    let status = if input.status == "queued" {
        language.text("tui.queued")
    } else {
        language.text("tui.notApplied")
    };
    let mut lines = vec![format!("{status}: {}", input.text)];
    lines.extend(input.filesystem_references.iter().map(|reference| {
        language.format("tui.attachment", &[format!("{}", reference.display_name)])
    }));
    lines
}

fn tool_error_lines(activity: &ActivityProjection) -> Vec<String> {
    let mut lines = Vec::new();
    for error in activity
        .interruption
        .iter()
        .chain(activity.tool.as_ref().and_then(|tool| tool.error.as_ref()))
        .chain(
            activity
                .tool
                .as_ref()
                .and_then(|tool| tool.projection_error.as_ref()),
        )
    {
        lines.push(format!("  {}: {}", error.code, error.message));
    }
    if let Some(error) = &activity.input_rejection {
        lines.push(format!("  {}: {}", error.code, error.message));
        lines.extend(
            error
                .issues
                .iter()
                .map(|issue| format!("  {}: {}", issue.path, issue.message)),
        );
    }
    lines
}

fn push_timeline_plan_lines(language: Language, lines: &mut Vec<Line<'_>>, plan: &PlanProjection) {
    lines.push(Line::from(Span::styled(
        language.format(
            "tui.planTitle",
            &[
                format!("{}", plan.revision),
                status_label(language, &plan.status).to_string(),
            ],
        ),
        Style::default().fg(Color::Cyan),
    )));
    lines.push(Line::from(Span::styled(
        plan.title.clone(),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    lines.extend(Text::raw(plan.summary.clone()).lines);
    for (index, step) in plan.steps.iter().enumerate() {
        lines.push(Line::from(format!("{}. {}", index + 1, step.title)));
        lines.push(Line::from(format!("   {}", step.details)));
    }
}

fn render_activity_plain(language: Language, output: &mut String, activity: &ActivityProjection) {
    output.push_str(&activity_summary(language, activity));
    output.push('\n');
    for error in tool_error_lines(activity) {
        output.push_str(&error);
        output.push('\n');
    }
    for detail in tool_progress_details(language, activity) {
        output.push_str(&detail);
        output.push('\n');
    }
    if let Some(live) = activity.live_output.as_ref() {
        push_tool_stream_plain(output, "stdout", &live.stdout);
        push_tool_stream_plain(output, "stderr", &live.stderr);
    }
    if let Some(tool) = activity.tool.as_ref() {
        if let Some(process) = &tool.process {
            output.push_str(&format!("  $ {}\n", process.command));
            if activity.status != "active" {
                push_tool_stream_plain(output, "stdout", &process.output.stdout);
                push_tool_stream_plain(output, "stderr", &process.output.stderr);
            }
            if let Some(result) = &process.result {
                output.push_str(&format!(
                    "  exit={:?} · {} ms · timedOut={}\n",
                    result.exit_code, result.duration_ms, result.timed_out
                ));
            }
        }
        if let Some(shell) = tool.shell.as_ref() {
            output.push_str(&format!("  $ {}\n", shell.command));
            output.push_str(&language.format("tui.cwd", &[format!("{}", shell.cwd)]));
            if let Some(result) = shell.result.as_ref() {
                output.push_str(&language.format(
                    "tui.shellEnvironment",
                    &[
                        format!("{}", result.environment.shell),
                        format!("{}", result.environment.interactive),
                        format!("{}", result.environment.path_source),
                        format!("{}", result.environment.write_scope),
                        format!("{}", result.environment.home_writable),
                    ],
                ));
                let exit = result.exit_code.map_or_else(
                    || language.text("tui.signalTimeout").to_string(),
                    |code| code.to_string(),
                );
                output.push_str(&language.format(
                    "tui.shellExit",
                    &[
                        format!("{}", exit),
                        format!("{}", result.duration_ms),
                        format!("{}", result.captured_bytes),
                        format!(
                            "{}",
                            if result.timed_out {
                                language.text("tui.timedOut")
                            } else {
                                ""
                            }
                        ),
                        format!(
                            "{}",
                            if result.truncated {
                                language.text("tui.truncated")
                            } else {
                                ""
                            }
                        ),
                    ],
                ));
                push_tool_stream_plain(output, "stdout", &result.stdout);
                push_tool_stream_plain(output, "stderr", &result.stderr);
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                output.push_str(&format!(
                    "  {} {} · /diff {} {}\n",
                    change_kind_label(language, &change.kind),
                    change.path,
                    record,
                    index
                ));
            }
        }
        for resource in &tool.resources {
            match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => {
                    output.push_str(&format!(
                        "  {} · /open {} {}\n",
                        resource.label, workspace_id, logical_path
                    ))
                }
                ("url", _, _, Some(uri)) => {
                    output.push_str(&format!("  {} · {uri}\n", resource.label));
                }
                _ => output.push_str(&format!("  {}\n", resource.label)),
            }
        }
    }
}

fn push_tool_stream_plain(output: &mut String, label: &str, stream: &str) {
    if stream.is_empty() {
        return;
    }
    output.push_str(&format!("  {label}:\n"));
    for line in stream.lines() {
        output.push_str(&format!("    {line}\n"));
    }
}

fn tool_progress_details(language: Language, activity: &ActivityProjection) -> Vec<String> {
    let mut lines = Vec::new();
    if activity.status == "active" {
        if let Some(elapsed) = activity.started_at.as_ref().and_then(|started| {
            let started = started.parse::<u128>().ok()?;
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .checked_sub(started)
        }) {
            lines.push(
                language.format("tui.elapsed", &[format!("{:.1}", elapsed as f64 / 1_000.0)]),
            );
        }
        if let Some(output) = activity.live_output.as_ref() {
            lines.push(language.format(
                "tui.liveOutput",
                &[
                    format!("{}", output.stdout_bytes),
                    format!("{}", output.stderr_bytes),
                    format!(
                        "{}",
                        if output.truncated {
                            language.text("tui.latestOutputOnly")
                        } else {
                            ""
                        }
                    ),
                ],
            ));
        }
    }
    lines
}

fn todo_note(language: Language, projection: &SessionProjection) -> Option<String> {
    let todo = projection.todo_list.as_ref()?;
    if todo.items.is_empty() {
        return None;
    }
    let remaining = todo
        .items
        .iter()
        .filter(|item| item.status != "completed")
        .count();
    let ended = projection
        .token_usage_history
        .iter()
        .any(|run| run.run_id == todo.run_id && run.outcome.is_some());
    (ended && remaining > 0)
        .then(|| language.format("tui.todoEndedRemaining", &[remaining.to_string()]))
}

fn render_todo_plain(language: Language, output: &mut String, projection: &SessionProjection) {
    let Some(todo) = projection.todo_list.as_ref() else {
        return;
    };
    output.push_str(language.text("tui.todoTitle"));
    if let Some(note) = todo_note(language, projection) {
        output.push_str(&format!("{note}\n"));
    }
    if todo.items.is_empty() {
        output.push_str(language.text("tui.empty"));
        return;
    }
    for item in &todo.items {
        let marker = match item.status.as_str() {
            "completed" => "[x]",
            "inProgress" => "[>]",
            "blocked" => "[!]",
            _ => "[ ]",
        };
        output.push_str(&format!(
            "  {marker} {} · {}\n",
            item.text,
            language.text(match item.status.as_str() {
                "completed" => "deepcodeGui.tasks.status.completed",
                "inProgress" => "deepcodeGui.tasks.status.inProgress",
                "blocked" => "deepcodeGui.tasks.status.blocked",
                _ => "deepcodeGui.tasks.status.pending",
            })
        ));
    }
}

fn activity_color(status: &str) -> Color {
    if status == "completed" {
        Color::Green
    } else if matches!(status, "failed" | "denied" | "indeterminate") {
        Color::Red
    } else {
        Color::Yellow
    }
}

fn cache_hit_label(projection: &SessionProjection) -> String {
    let usage = &projection.token_usage;
    if !usage.cache_available {
        return "--%".to_string();
    }
    usage
        .cache_hit_ratio
        .map(format_cache_percent)
        .unwrap_or_else(|| "--%".to_string())
}

fn format_cache_percent(ratio: f64) -> String {
    let rounded = (ratio * 100.0 * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

fn last_request_cache_summary(
    language: Language,
    usage: Option<&ContextUsageProjection>,
) -> (String, Option<f64>) {
    let Some(usage) = usage else {
        return ("N/A".into(), None);
    };
    let (Some(hit), Some(miss)) = (usage.cache_read_input_tokens, usage.cache_miss_input_tokens)
    else {
        return (
            language.format(
                "tui.cacheNotReported",
                &[format!("{}", format_number(usage.input_tokens))],
            ),
            None,
        );
    };
    let ratio = (usage.input_tokens > 0).then(|| hit as f64 / usage.input_tokens as f64);
    (
        language.format(
            "tui.cacheSummary",
            &[
                format!(
                    "{}",
                    ratio
                        .map(format_cache_percent)
                        .unwrap_or_else(|| "N/A".into())
                ),
                format!("{}", format_number(usage.input_tokens)),
                format!("{}", format_number(hit)),
                format!("{}", format_number(miss)),
            ],
        ),
        ratio,
    )
}

fn cache_detail_label(language: Language, usage: &TokenUsageProjection) -> String {
    if !usage.cache_available {
        return language.format(
            "tui.cacheReportsUnavailable",
            &[
                format!("{}", usage.reported_call_count),
                format!("{}", usage.provider_call_count),
                format!("{}", cache_coverage_label(language, usage)),
            ],
        );
    }
    language.format(
        "tui.cacheReports",
        &[
            format!(
                "{}",
                usage
                    .cache_hit_ratio
                    .map(format_cache_percent)
                    .unwrap_or_else(|| "N/A".to_string())
            ),
            format!("{}", format_number(usage.cache_read_input_tokens)),
            format!("{}", format_number(usage.cache_miss_input_tokens)),
            format!("{}", usage.reported_call_count),
            format!("{}", usage.provider_call_count),
            format!("{}", cache_coverage_label(language, usage)),
        ],
    )
}

fn cache_coverage_label(language: Language, usage: &TokenUsageProjection) -> &'static str {
    if usage.cache_complete {
        language.text("tui.cacheComplete")
    } else if usage.cache_available {
        language.text("tui.cachePartial")
    } else {
        language.text("tui.cacheUnavailable")
    }
}

fn render_plan_plain(language: Language, output: &mut String, plan: &PendingPlanProjection) {
    output.push_str(&language.format("tui.pendingPlanTitle", &[format!("{}", plan.revision)]));
    render_plan_body_plain(language, output, &plan.title, &plan.summary, &plan.steps);
    output.push_str(language.text("tui.planResponseHint"));
}

fn render_timeline_plan_plain(language: Language, output: &mut String, plan: &PlanProjection) {
    output.push_str(&language.format(
        "tui.planTitlePlain",
        &[
            format!("{}", plan.revision),
            status_label(language, &plan.status).to_string(),
        ],
    ));
    render_plan_body_plain(language, output, &plan.title, &plan.summary, &plan.steps);
}

fn render_plan_body_plain(
    language: Language,
    output: &mut String,
    title: &str,
    summary: &str,
    steps: &[ExecutionPlanStep],
) {
    output.push_str(&format!("{title}\n{summary}\n"));
    for (index, step) in steps.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", index + 1, step.title));
        output.push_str(&format!("   {}\n", step.details));
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                output.push_str(&language.format("tui.verification", &[format!("{}", item)]));
            }
        }
    }
}

fn status_label<'a>(language: Language, status: &'a str) -> &'a str {
    let key = match status {
        "active" => "tui.status.active",
        "requested" => "tui.status.requested",
        "waiting" => "tui.status.waiting",
        "completed" => "tui.status.completed",
        "denied" => "tui.status.denied",
        "rejected" => "tui.status.rejected",
        "failed" => "tui.status.failed",
        "cancelled" => "tui.status.cancelled",
        "indeterminate" => "tui.status.indeterminate",
        "published" => "tui.status.published",
        "revisionRequested" => "tui.status.revisionRequested",
        "confirmed" => "tui.status.confirmed",
        "superseded" => "tui.status.superseded",
        "invalidated" => "tui.status.invalidated",
        _ => return status,
    };
    language.text(key)
}

fn kind_label<'a>(language: Language, kind: &'a str) -> &'a str {
    let key = match kind {
        "run" => "tui.kind.run",
        "tool" => "tui.kind.tool",
        "providerHosted" => "tui.kind.providerHosted",
        "approval" => "tui.kind.approval",
        "plan" => "tui.kind.plan",
        "interaction" => "tui.kind.interaction",
        "user" => "tui.kind.user",
        "assistant" => "tui.kind.assistant",
        "system" => "tui.kind.system",
        _ => return kind,
    };
    language.text(key)
}

fn change_kind_label<'a>(language: Language, kind: &'a str) -> &'a str {
    let key = match kind {
        "create" => "tui.change.created",
        "modify" => "tui.change.modified",
        "delete" => "tui.change.deleted",
        _ => return kind,
    };
    language.text(key)
}

fn reasoning_effort_label<'a>(language: Language, value: &'a str) -> &'a str {
    let key = match value {
        "low" => "tui.reasoning.low",
        "medium" => "tui.reasoning.medium",
        "high" => "tui.reasoning.high",
        "xhigh" => "tui.reasoning.xhigh",
        "max" => "tui.reasoning.max",
        _ => return value,
    };
    language.text(key)
}

fn source_references(
    language: Language,
    references: Option<&deepcode_kernel_client::SourceReferences>,
) -> String {
    let mut text = String::new();
    if let Some(references) = references {
        for citation in &references.citations {
            text.push_str(&format!(
                "- [{}](<{}>)\n",
                citation.title.replace('[', "\\[").replace(']', "\\]"),
                citation.url
            ));
        }
        if references.unresolved {
            text.push_str(language.text("agent.sources.unresolved"));
            text.push('\n');
        }
    }
    text
}

#[cfg(test)]
mod approval_presentation_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_review_and_user_decision_have_distinct_actions_and_exact_details() {
        let mut projection: SessionProjection = serde_json::from_value(json!({
            "schemaVersion":deepcode_kernel_client::SESSION_PROJECTION_VERSION,"sessionId":"session:test","revision":1,
            "display":{"creationTitle":"Review"},"workspaceBindings":[],"sessionDirectoryIndexes":[],"messages":[],"queuedInputs":[],
            "narratives":[],"timeline":[],"plans":[],"interactions":[],"contextCompositions":[],"tokenUsageHistory":[],"activities":[],"artifacts":[],"deliverables":[],
            "permissionOverrides":{},"effectivePermissions":null,"shellAuthorizations":[],
            "tokenUsage":{"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "run":{"runId":"run:test","profileId":"profile:test","workspaceBindings":[],"status":"running"},
            "pendingApproval":{"approvalId":"approval:test","runId":"run:test","callId":"call:test","sequence":2,"createdAt":"now",
                "preview":{"summary":"Inspect","effects":["process"],"logicalTargets":["."],"approvalReviewer":"agent",
                    "operation":{"toolName":"bash","arguments":{"command":"git status"},"workspaceRoot":"/project","executionScope":"workspace"},
                    "fileAccess":{"read":["/references"],"write":[]},"review":{"decision":"ask","reason":"Scope needs confirmation"}}}
        })).unwrap();
        let reviewing = decision_details(Language::ZhCn, Some(&projection));
        assert!(reviewing.contains("模型正在审查"));
        assert!(
            reviewing.contains("git status")
                && reviewing.contains("/project")
                && reviewing.contains("/references")
        );
        assert!(reviewing.contains("Scope needs confirmation"));
        assert!(!reviewing.contains("/reply"));
        projection.run.as_mut().unwrap().status = "waiting".into();
        let waiting = decision_details(Language::ZhCn, Some(&projection));
        assert!(waiting.contains("/reply"));
    }
}
