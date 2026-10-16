use deepcode_kernel_client::{
    is_terminal_run_status, ActivityProjection, ApprovalProjection, ExecutionPlanStep,
    InteractionProjection, PlanOperation, ProjectionMessage, SessionProjection,
    SessionTimelineItem, TodoListProjection, ToolOutputProjection,
};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// Output-local bookkeeping; Session remains the owner of ordering and state.
#[derive(Default)]
pub(crate) struct CliRenderState {
    items: HashSet<String>,
    plans: HashMap<(String, u64), String>,
    activities: HashMap<String, ActivityProjection>,
    todo: Option<TodoListProjection>,
    text: HashMap<String, String>,
    active_stream: Option<String>,
    line_open: bool,
    plan_preview: Option<(String, String)>,
    summarized_runs: HashSet<String>,
    queued_inputs: HashMap<String, String>,
    retry_attempt: Option<String>,
}

impl CliRenderState {
    pub(crate) fn after(projection: &SessionProjection) -> Self {
        Self {
            items: projection
                .timeline
                .iter()
                .map(|item| item.timeline_id().to_owned())
                .collect(),
            plans: projection
                .plans
                .iter()
                .map(|plan| ((plan.plan_id.clone(), plan.revision), plan.status.clone()))
                .collect(),
            activities: projection
                .activities
                .iter()
                .map(|activity| (activity.activity_id.clone(), activity.clone()))
                .collect(),
            todo: projection.todo_list.clone(),
            queued_inputs: projection
                .queued_inputs
                .iter()
                .map(|input| (input.message_id.clone(), input.status.clone()))
                .collect(),
            ..Self::default()
        }
    }

    pub(crate) fn render(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        if let Some(attempt) = projection
            .provider_attempts
            .last()
            .filter(|attempt| attempt.phase == "retryWaiting")
        {
            if self.retry_attempt.as_ref() != Some(&attempt.provider_attempt_id) {
                self.finish_text(out)?;
                writeln!(
                    out,
                    "请求未完成，等待同一请求的第 {} 次发送。",
                    attempt.attempt + 1
                )?;
                self.retry_attempt = Some(attempt.provider_attempt_id.clone());
            }
        }
        for input in &projection.queued_inputs {
            if self.queued_inputs.get(&input.message_id) != Some(&input.status) {
                self.finish_text(out)?;
                let status = if input.status == "queued" {
                    "已排队"
                } else {
                    "未执行"
                };
                writeln!(out, "{status}: {}", input.text)?;
                for reference in &input.filesystem_references {
                    writeln!(out, "  附件：{}", reference.display_name)?;
                }
                self.queued_inputs
                    .insert(input.message_id.clone(), input.status.clone());
            }
        }
        // Finish a streamed block before any newly observed status can interrupt it.
        if let Some(active) = self.active_stream.clone() {
            let committed = projection.timeline.iter().find_map(|item| {
                let (stream, content) = committed_text(projection, item)?;
                (stream == Some(active.as_str())).then_some(content)
            });
            if let Some(content) = committed {
                self.write_text(out, &active, content)?;
                self.finish_text(out)?;
            } else if projection.assistant_draft.as_ref().is_some_and(|draft| {
                draft
                    .blocks
                    .iter()
                    .any(|block| block.text().is_some_and(|(id, _)| id == active))
            }) {
                self.render_draft(out, projection)?;
                let boundary = projection.run.as_ref().is_some_and(|run| {
                    run.status == "waiting" || is_terminal_run_status(&run.status)
                });
                if self.active_stream.is_some() && !boundary {
                    return out.flush();
                }
                self.finish_text(out)?;
            } else {
                self.finish_text(out)?;
            }
        }

        // timelineId is stable; sequence is a fact version, not a display cursor.
        for item in &projection.timeline {
            match item {
                SessionTimelineItem::Message {
                    message_id,
                    stream_id,
                    ..
                } => {
                    if self.items.contains(item.timeline_id()) {
                        continue;
                    }
                    let message = projection
                        .messages
                        .iter()
                        .find(|message| message.message_id == *message_id)
                        .expect("validated Session timeline message reference");
                    if let Some(stream) = stream_id {
                        self.write_text(out, stream, message.display_text())?;
                        self.finish_text(out)?;
                    } else {
                        writeln!(out, "{}: {}", message.role, message.display_text())?;
                    }
                    render_attachments(out, message)?;
                    render_source_references(out, message.source_references.as_ref())?;
                }
                SessionTimelineItem::Narrative {
                    narrative_id,
                    stream_id,
                    ..
                } => {
                    if self.items.contains(item.timeline_id()) {
                        continue;
                    }
                    let narrative = projection
                        .narratives
                        .iter()
                        .find(|value| value.narrative_id == *narrative_id)
                        .expect("validated Session timeline narrative reference");
                    self.write_text(out, stream_id, narrative.display_text())?;
                    self.finish_text(out)?;
                    render_source_references(out, narrative.source_references.as_ref())?;
                }
                SessionTimelineItem::Plan {
                    plan_id, revision, ..
                } => {
                    let plan = projection
                        .plans
                        .iter()
                        .find(|plan| plan.plan_id == *plan_id && plan.revision == *revision)
                        .expect("validated Session timeline plan reference");
                    let key = (plan.plan_id.clone(), plan.revision);
                    match self.plans.get(&key) {
                        None => render_plan_document(
                            out,
                            plan.revision,
                            &plan.status,
                            &plan.title,
                            &plan.summary,
                            &plan.steps,
                            &plan.mutation_manifest,
                        )?,
                        Some(status) if status != &plan.status => writeln!(
                            out,
                            "Plan 状态 · revision {} · {}",
                            plan.revision, plan.status
                        )?,
                        Some(_) => {}
                    }
                    self.plans.insert(key, plan.status.clone());
                }
                SessionTimelineItem::ToolGroup { activity_ids, .. } => {
                    for id in activity_ids {
                        let activity = projection
                            .activities
                            .iter()
                            .find(|activity| activity.activity_id == *id)
                            .expect("validated Session timeline activity reference");
                        if self.activities.get(id) != Some(activity) {
                            let previous = self.activities.get(id);
                            if let Some(previous) = previous.filter(|previous| {
                                activity.kind == "tool"
                                    && activity.status == "active"
                                    && previous.status == "active"
                                    && previous.started_at == activity.started_at
                                    && previous.sequence == activity.sequence
                                    && previous.tool == activity.tool
                                    && previous.label == activity.label
                            }) {
                                if let Some(output) = activity.live_output.as_ref() {
                                    render_live_tool_output(
                                        out,
                                        output,
                                        previous.live_output.as_ref(),
                                    )?;
                                }
                            } else {
                                render_tool_activity(out, projection, activity)?;
                            }
                            self.activities.insert(id.clone(), activity.clone());
                        }
                    }
                }
            }
            self.items.insert(item.timeline_id().to_owned());
        }
        if self.todo.as_ref() != projection.todo_list.as_ref() {
            render_todo(out, projection)?;
            self.todo = projection.todo_list.clone();
        }
        self.render_draft(out, projection)?;
        out.flush()
    }

    fn write_text(&mut self, out: &mut impl Write, stream: &str, content: &str) -> io::Result<()> {
        let previous = self.text.get(stream).map(String::as_str).unwrap_or("");
        let delta = content.strip_prefix(previous).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "CLI 已输出文本与 Session 流内容不一致。",
            )
        })?;
        if delta.is_empty() {
            return Ok(());
        }
        if self.active_stream.as_deref() != Some(stream) {
            self.finish_text(out)?;
        }
        // No splitting, trimming or reformatting of Markdown / Unicode deltas.
        let previous_len = self.text.get(stream).map_or(0, String::len);
        out.write_all(content[previous_len..].as_bytes())?;
        self.line_open = !content.ends_with('\n');
        self.active_stream = Some(stream.to_owned());
        self.text.insert(stream.to_owned(), content.to_owned());
        Ok(())
    }

    fn render_draft(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        let Some(draft) = projection.assistant_draft.as_ref() else {
            return Ok(());
        };
        for block in &draft.blocks {
            if let Some((stream, content)) = block.text() {
                // A committed block supersedes its draft even if both are visible
                // in the projection delivered during the handoff.
                if projection.timeline.iter().any(|item| {
                    committed_text(projection, item).is_some_and(|(id, _)| id == Some(stream))
                }) {
                    continue;
                }
                self.write_text(out, stream, content)?;
            }
        }
        if let Some(preview) = draft.plan_preview.as_ref() {
            let key = format!("{}:{}", draft.turn_id, preview.provider_call_id);
            let status = format!(
                "正在生成计划 · {} · {} 个步骤",
                preview.title,
                preview.steps.len()
            );
            if self.plan_preview.as_ref() != Some(&(key.clone(), status.clone())) {
                self.finish_text(out)?;
                writeln!(out, "{status}")?;
                self.plan_preview = Some((key, status));
            }
        }
        Ok(())
    }

    pub(crate) fn finish_text(&mut self, out: &mut impl Write) -> io::Result<()> {
        if self.line_open {
            writeln!(out)?;
        }
        self.line_open = false;
        self.active_stream = None;
        out.flush()
    }

    pub(crate) fn render_action_required(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        self.finish_text(out)?;
        if let Some(plan) = projection.pending_plan.as_ref() {
            let key = (plan.plan_id.clone(), plan.revision);
            if !self.plans.contains_key(&key) {
                render_plan_document(
                    out,
                    plan.revision,
                    &plan.status,
                    &plan.title,
                    &plan.summary,
                    &plan.steps,
                    &plan.mutation_manifest,
                )?;
                self.plans.insert(key, plan.status.clone());
            }
            writeln!(out, "输入 /reply 1 或 /reply 确认；输入 /reply <意见> 请求修订；普通消息继续排队；显式运行 `deepcode-cli cancel-plan --session {}` 取消。", projection.session_id)?;
        }
        if let Some(interaction) = projection.pending_interaction.as_ref() {
            render_interaction(out, interaction)?;
            writeln!(
                out,
                "继续：deepcode-cli ask --session {} \"/reply <response>\"",
                projection.session_id
            )?;
        }
        if let Some(approval) = projection.pending_approval.as_ref() {
            let reviewing = approval.is_model_reviewing(projection.run.as_ref());
            render_approval(out, approval, reviewing)?;
            if !reviewing {
                writeln!(out, "继续：使用上面的 /reply 选项。")?;
            }
        }
        out.flush()
    }

    pub(crate) fn finish_run(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        self.finish_text(out)?;
        if let Some(run) = projection
            .run
            .as_ref()
            .filter(|run| is_terminal_run_status(&run.status))
        {
            self.render_file_changes(out, projection, &run.run_id)?;
        }
        out.flush()
    }

    fn render_file_changes(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
        run_id: &str,
    ) -> io::Result<()> {
        if !self.summarized_runs.insert(run_id.to_owned()) {
            return Ok(());
        }
        let mut members = HashSet::new();
        for task in projection
            .agent_tasks
            .iter()
            .flatten()
            .filter(|task| task.parent_run_id == run_id)
        {
            if members.insert(&task.agent_session_id) {
                writeln!(
                    out,
                    "子代理 {} · deepcode-cli show --session {}",
                    task.display_name, task.agent_session_id
                )?;
            }
        }
        let changes = projection.file_changes_for_run(run_id);
        if !changes.is_empty() {
            writeln!(out, "本轮修改 · {run_id}")?;
            for (record, index, change) in changes {
                writeln!(
                    out,
                    "  {} {} · deepcode-cli diff --session {} {} {}",
                    change.kind, change.path, projection.session_id, record, index
                )?;
            }
        }
        Ok(())
    }
}

fn committed_text<'a>(
    projection: &'a SessionProjection,
    item: &'a SessionTimelineItem,
) -> Option<(Option<&'a str>, &'a str)> {
    match item {
        SessionTimelineItem::Message {
            message_id,
            stream_id,
            ..
        } => projection
            .messages
            .iter()
            .find(|message| message.message_id == *message_id)
            .map(|message| (stream_id.as_deref(), message.display_text())),
        SessionTimelineItem::Narrative {
            narrative_id,
            stream_id,
            ..
        } => projection
            .narratives
            .iter()
            .find(|narrative| narrative.narrative_id == *narrative_id)
            .map(|narrative| (Some(stream_id.as_str()), narrative.display_text())),
        _ => None,
    }
}

fn render_plan_document(
    out: &mut impl Write,
    revision: u64,
    status: &str,
    title: &str,
    summary: &str,
    steps: &[ExecutionPlanStep],
    operations: &[PlanOperation],
) -> io::Result<()> {
    writeln!(
        out,
        "Plan · revision {revision} · {status}\n{title}\n{summary}"
    )?;
    for (index, step) in steps.iter().enumerate() {
        writeln!(out, "{}. {}", index + 1, step.title)?;
        for line in step.details.lines() {
            writeln!(out, "   {line}")?;
        }
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                writeln!(out, "   验证：{item}")?;
            }
        }
    }
    if !operations.is_empty() {
        writeln!(out, "修改范围：")?;
        for operation in operations {
            write!(
                out,
                "  [{}] {}",
                operation.workspace_id, operation.operation
            )?;
            if let Some(target) = &operation.target {
                write!(out, " {target}")?;
            }
            if let Some(paths) = &operation.writable_paths {
                for target in paths {
                    write!(
                        out,
                        " · {}{}",
                        target.path,
                        if target.kind == "directory" { "/" } else { "" }
                    )?;
                }
            }
            writeln!(out)?;
        }
    }
    Ok(())
}

pub(crate) fn render_action_required_if_any(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    CliRenderState::default().render_action_required(out, projection)
}

pub(crate) fn render_projection(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    writeln!(
        out,
        "session={} revision={} run={}",
        projection.session_id,
        projection.revision,
        projection.run.as_ref().map_or_else(
            || "-".to_owned(),
            |run| format!("{}:{}", run.run_id, run.status)
        )
    )?;
    if !projection.session_directory_indexes.is_empty() {
        writeln!(out, "对话目录索引：")?;
        for binding in &projection.session_directory_indexes {
            writeln!(out, "  {} ({})", binding.display_name, binding.workspace_id)?;
        }
    }
    let mut state = CliRenderState::default();
    state.render(out, projection)?;
    state.finish_text(out)?;
    for activity in projection
        .activities
        .iter()
        .filter(|activity| activity.kind != "tool")
    {
        writeln!(
            out,
            "{} [{}]: {}",
            activity.kind, activity.status, activity.label
        )?;
    }
    for round in &projection.file_change_rounds {
        if projection
            .run
            .as_ref()
            .is_some_and(|run| run.run_id == round.run_id && !is_terminal_run_status(&run.status))
        {
            continue;
        }
        state.render_file_changes(out, projection, &round.run_id)?;
    }
    render_usage(out, projection)?;
    state.render_action_required(out, projection)?;
    render_terminal_error(out, projection)
}

pub(crate) fn render_tool_activity(
    out: &mut impl Write,
    projection: &SessionProjection,
    activity: &ActivityProjection,
) -> io::Result<()> {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    let status = activity
        .not_executed
        .as_ref()
        .map_or(activity.status.as_str(), |result| {
            if result.reason == "dependencyFailed" {
                "未执行：前序调用未成功"
            } else {
                "未执行：已取消"
            }
        });
    writeln!(out, "工具 {operation} [{status}]")?;
    if activity.status == "active" {
        if let Some(elapsed) = activity.started_at.as_ref().and_then(|started| {
            let started = started.parse::<u128>().ok()?;
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .checked_sub(started)
        }) {
            writeln!(out, "  已执行 {:.1}s", elapsed as f64 / 1_000.0)?;
        }
        if let Some(output) = activity.live_output.as_ref() {
            render_live_tool_output(out, output, None)?;
        }
    }
    if let Some(error) = &activity.interruption {
        writeln!(out, "  {}: {}", error.code, error.message)?;
    }
    if let Some(error) = &activity.input_rejection {
        writeln!(out, "  {}: {}", error.code, error.message)?;
        for issue in &error.issues {
            writeln!(out, "  {}: {}", issue.path, issue.message)?;
        }
    }
    if let Some(tool) = activity.tool.as_ref() {
        for error in tool.error.iter().chain(&tool.projection_error) {
            writeln!(out, "  {}: {}", error.code, error.message)?;
        }
        if let Some(process) = &tool.process {
            writeln!(out, "  $ {}", process.command)?;
            if activity.status != "active" {
                render_live_tool_output(out, &process.output, None)?;
            }
            if let Some(result) = &process.result {
                writeln!(
                    out,
                    "  exit={:?} · {} ms · timedOut={}",
                    result.exit_code, result.duration_ms, result.timed_out
                )?;
            }
        }
        if let Some(shell) = tool.shell.as_ref() {
            writeln!(out, "  $ {}", shell.command)?;
            writeln!(out, "  cwd: {}", shell.cwd)?;
            if let Some(result) = shell.result.as_ref() {
                writeln!(out,
                    "  environment: shell={} · interactive={} · pathSource={} · writeScope={} · homeWritable={}",
                    result.environment.shell,
                    result.environment.interactive,
                    result.environment.path_source,
                    result.environment.write_scope,
                    result.environment.home_writable,
                )?;
                let exit = result
                    .exit_code
                    .map_or_else(|| "signal/timeout".to_string(), |code| code.to_string());
                writeln!(
                    out,
                    "  exit: {exit} · {} ms · {} bytes{}{}",
                    result.duration_ms,
                    result.captured_bytes,
                    if result.timed_out {
                        " · timed out"
                    } else {
                        ""
                    },
                    if result.truncated {
                        " · truncated"
                    } else {
                        ""
                    },
                )?;
                print_tool_stream(out, "stdout", &result.stdout)?;
                print_tool_stream(out, "stderr", &result.stderr)?;
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                writeln!(
                    out,
                    "  {} {} -> deepcode-cli diff --session {} {} {}",
                    change.kind, change.path, projection.session_id, record, index
                )?;
            }
        }
        for resource in &tool.resources {
            match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => writeln!(
                    out,
                    "  {} -> deepcode-cli open-resource --session {} {} {:?}",
                    resource.label, projection.session_id, workspace_id, logical_path,
                )?,
                ("url", _, _, Some(uri)) => writeln!(out, "  {} -> {uri}", resource.label)?,
                _ => writeln!(out, "  {}", resource.label)?,
            }
        }
    }
    Ok(())
}

pub(crate) fn print_tool_stream(out: &mut impl Write, label: &str, output: &str) -> io::Result<()> {
    if output.is_empty() {
        return Ok(());
    }
    writeln!(out, "  {label}:")?;
    for line in output.lines() {
        writeln!(out, "    {line}")?;
    }
    Ok(())
}

fn render_live_tool_output(
    out: &mut impl Write,
    output: &ToolOutputProjection,
    previous: Option<&ToolOutputProjection>,
) -> io::Result<()> {
    writeln!(
        out,
        "  实时输出 · stdout {} bytes · stderr {} bytes{}",
        output.stdout_bytes,
        output.stderr_bytes,
        if output.truncated {
            " · 仅保留最新片段"
        } else {
            ""
        }
    )?;
    for (label, text, total, before) in [
        (
            "stdout",
            output.stdout.as_str(),
            output.stdout_bytes,
            previous.map(|value| (value.stdout.as_str(), value.stdout_bytes)),
        ),
        (
            "stderr",
            output.stderr.as_str(),
            output.stderr_bytes,
            previous.map(|value| (value.stderr.as_str(), value.stderr_bytes)),
        ),
    ] {
        // Raw-byte totals can include an unfinished UTF-8 character. Compare
        // decoded text rather than treating those totals as string offsets.
        if before.is_some_and(|(old, bytes)| output.truncated && old == text && bytes != total) {
            print_tool_stream(out, &format!("{label} 最新片段"), text)?;
        } else if let Some(delta) = text.strip_prefix(before.map_or("", |(text, _)| text)) {
            print_tool_stream(out, label, delta)?;
        } else {
            print_tool_stream(out, &format!("{label} 最新片段"), text)?;
        }
    }
    Ok(())
}

pub(crate) fn render_todo(out: &mut impl Write, projection: &SessionProjection) -> io::Result<()> {
    let Some(todo) = projection.todo_list.as_ref() else {
        return Ok(());
    };
    writeln!(out, "任务")?;
    if todo.items.is_empty() {
        writeln!(out, "  （空）")?;
        return Ok(());
    }
    for item in &todo.items {
        let marker = match item.status.as_str() {
            "completed" => "[x]",
            "inProgress" => "[>]",
            "blocked" => "[!]",
            _ => "[ ]",
        };
        writeln!(
            out,
            "  {marker} {} · {}",
            item.text,
            crate::i18n::Language::default().text(match item.status.as_str() {
                "completed" => "deepcodeGui.tasks.status.completed",
                "inProgress" => "deepcodeGui.tasks.status.inProgress",
                "blocked" => "deepcodeGui.tasks.status.blocked",
                _ => "deepcodeGui.tasks.status.pending",
            })
        )?;
    }
    Ok(())
}

pub(crate) fn render_usage(out: &mut impl Write, projection: &SessionProjection) -> io::Result<()> {
    let usage = &projection.token_usage;
    let cache = match (usage.cache_available, usage.cache_hit_ratio) {
        (true, Some(ratio)) => format!("{:.0}%", ratio * 100.0),
        _ => "--%".to_string(),
    };
    let coverage = if usage.cache_complete {
        "complete"
    } else if usage.cache_available {
        "partial"
    } else {
        "unavailable"
    };
    writeln!(out,
        "Provider 调用 {} · 输入 {} · 输出 {} · 缓存命中 {} · 缓存读取 {} · 缓存未命中 {} · 缓存报告 {}/{} ({})",
        usage.provider_call_count,
        usage.input_tokens,
        usage.output_tokens,
        cache,
        usage.cache_read_input_tokens,
        usage.cache_miss_input_tokens,
        usage.reported_call_count,
        usage.provider_call_count,
        coverage,
    )?;
    Ok(())
}

pub(crate) fn render_attachments(
    out: &mut impl Write,
    message: &ProjectionMessage,
) -> io::Result<()> {
    if !message.filesystem_references.is_empty() {
        writeln!(
            out,
            "  文件系统引用：{}",
            message
                .filesystem_references
                .iter()
                .map(|reference| reference.display_name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )?;
    }
    Ok(())
}

pub(crate) fn render_final_message(
    out: &mut impl Write,
    projection: &SessionProjection,
    after_message_count: usize,
) -> io::Result<()> {
    if let Some(message) = projection.last_assistant_message(after_message_count) {
        writeln!(out, "{}", message.display_text())?;
        render_source_references(out, message.source_references.as_ref())?;
    }
    Ok(())
}

fn render_source_references(
    out: &mut impl Write,
    references: Option<&deepcode_kernel_client::SourceReferences>,
) -> io::Result<()> {
    if let Some(references) = references {
        for citation in &references.citations {
            writeln!(
                out,
                "- [{}](<{}>)",
                citation.title.replace('[', "\\[").replace(']', "\\]"),
                citation.url
            )?;
        }
        if references.unresolved {
            writeln!(out, "部分引用来源未返回，标为 [?] 的引用无法打开。")?;
        }
    }
    Ok(())
}

pub(crate) fn render_approval(
    out: &mut impl Write,
    approval: &ApprovalProjection,
    reviewing: bool,
) -> io::Result<()> {
    writeln!(
        out,
        "{}：{}",
        if reviewing {
            "模型正在审查执行权限"
        } else {
            "需要你批准"
        },
        approval.preview.summary
    )?;
    if let Some(operation) = &approval.preview.operation {
        writeln!(out, "操作：{}", operation.tool_name)?;
        if let Some(root) = &operation.workspace_root {
            writeln!(out, "工作目录：{root}")?;
        }
        if let Some(scope) = &operation.execution_scope {
            writeln!(out, "执行范围：{scope}")?;
        }
        writeln!(
            out,
            "参数：{}",
            serde_json::to_string_pretty(&operation.arguments)?
        )?;
    }
    if approval.preview.authorization_scope.as_deref() == Some("sessionBrowser") {
        writeln!(out, "允许后，当前对话内的浏览器页面操作无需重复确认。")?;
    }
    if let Some(review) = approval.preview.review.as_ref() {
        if let Some(reason) = review.get("reason").and_then(serde_json::Value::as_str) {
            writeln!(out, "审查结果：{reason}")?;
        }
    }
    if !reviewing {
        writeln!(out, "/reply 1 允许一次 · /reply 2 拒绝")?;
        for (scope, input) in deepcode_kernel_client::AUTHORIZATION_OPTIONS {
            if approval
                .preview
                .authorization_scopes
                .as_ref()
                .is_some_and(|scopes| scopes.iter().any(|value| value == scope))
            {
                writeln!(
                    out,
                    "/reply {input} {}",
                    crate::i18n::Language::ZhCn.text(&format!("agent.permission.scope.{scope}"))
                )?;
            }
        }
    }
    if let Some(files) = &approval.preview.file_access {
        for access in ["read", "write"] {
            if let Some(paths) = files[access].as_array() {
                for path in paths {
                    writeln!(out, "  {}: {}", access, path.as_str().unwrap_or(""))?;
                }
            }
        }
    }
    for target in &approval.preview.logical_targets {
        writeln!(out, "  - {target}")?;
    }
    Ok(())
}

pub(crate) fn render_interaction(
    out: &mut impl Write,
    interaction: &InteractionProjection,
) -> io::Result<()> {
    writeln!(out, "需要你回答：{}", interaction.prompt)?;
    if let Some(options) = interaction.options.as_ref() {
        for (index, option) in options.iter().enumerate() {
            match option.description.as_deref() {
                Some(description) => {
                    writeln!(out, "  {}. {}: {}", index + 1, option.label, description)?
                }
                None => writeln!(out, "  {}. {}", index + 1, option.label)?,
            }
        }
    }
    Ok(())
}

pub(crate) fn render_run_state(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    if let Some(run) = projection.run.as_ref() {
        writeln!(out, "run {}: {}", run.run_id, run.status)?;
        if deepcode_kernel_client::is_terminal_run_status(&run.status) {
            if let Some(todo) = projection
                .todo_list
                .as_ref()
                .filter(|todo| todo.run_id == run.run_id)
            {
                let remaining = todo
                    .items
                    .iter()
                    .filter(|item| item.status != "completed")
                    .count();
                if remaining > 0 {
                    writeln!(
                        out,
                        "{}",
                        crate::i18n::Language::default()
                            .format("tui.todoEndedRemaining", &[remaining.to_string()])
                    )?;
                }
            }
        }
        render_usage(out, projection)?;
    }
    Ok(())
}

pub(crate) fn render_terminal_error(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    if let Some(error) = projection.terminal_error.as_ref() {
        writeln!(out, "{}: {}", error.code, error.message)?;
        if let Some(details) = &error.diagnostics {
            writeln!(
                out,
                "  {} · {} · {}",
                details.source, details.phase, details.category
            )?;
            for cause in &details.causes {
                writeln!(
                    out,
                    "  {}{}",
                    cause.message,
                    cause
                        .os_code
                        .map(|code| format!(" [OS {code}]"))
                        .unwrap_or_default()
                )?;
            }
            for secondary in &details.secondary {
                writeln!(out, "  附加错误 {}: {}", secondary.code, secondary.message)?;
            }
        }
        if let Some(snapshot) = &projection.failure_snapshot {
            writeln!(
                out,
                "  已记录失败状态：revision {} · {} 次 Provider 发送",
                snapshot.revision,
                snapshot.provider_attempt_ids.len()
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn projection() -> SessionProjection {
        serde_json::from_value(json!({
            "schemaVersion": deepcode_kernel_client::SESSION_PROJECTION_VERSION, "permissionOverrides":{}, "effectivePermissions":null, "shellAuthorizations":[],
            "sessionId": "session:test", "revision": 1,
            "display": {"creationTitle":"CLI display"},
            "workspaceBindings": [], "sessionDirectoryIndexes": [],
            "timeline": [], "messages": [], "queuedInputs": [], "narratives": [], "plans": [], "interactions": [],
            "contextCompositions": [], "tokenUsageHistory": [], "activities": [], "artifacts": [], "deliverables": [],
            "tokenUsage": {"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
                "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "totalTokenUsage": {"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
                "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "run": {"runId":"run:test","profileId":"profile:test","workspaceBindings":[],"status":"running"}
        })).unwrap()
    }

    #[test]
    fn unexecuted_tools_report_the_explicit_reason() {
        for (status, disposition, expected) in [
            ("cancelled", json!({"reason":"cancelled"}), "未执行：已取消"),
            (
                "rejected",
                json!({"reason":"dependencyFailed","predecessorCallId":"call:earlier"}),
                "未执行：前序调用未成功",
            ),
        ] {
            let activity = serde_json::from_value(json!({"activityId":"tool:pending", "kind":"tool", "status":status,
                "label":"fs.write", "runId":"run:test", "callId":"call:pending", "sequence":1, "notExecuted":disposition})).unwrap();
            let mut output = Vec::new();
            render_tool_activity(&mut output, &projection(), &activity).unwrap();
            assert!(String::from_utf8(output).unwrap().contains(expected));
        }
    }

    #[test]
    fn approval_review_keeps_the_exact_operation_without_requesting_human_input() {
        let mut p = projection();
        let approval: ApprovalProjection = serde_json::from_value(json!({
            "approvalId":"approval:test", "runId":"run:test", "callId":"call:test", "sequence":2,"createdAt":"now",
            "preview":{"summary":"Inspect project", "effects":["process"],"logicalTargets":["."],"approvalReviewer":"agent",
                "operation":{"toolName":"bash","arguments":{"command":"git status"},"workspaceRoot":"/project","executionScope":"workspace"},
                "fileAccess":{"read":["/references"],"write":[]}, "review":{"decision":"ask","reason":"Please confirm the scope"}}
        })).unwrap();
        assert_eq!(
            approval.preview.operation.as_ref().unwrap().arguments["command"],
            "git status"
        );
        assert!(approval.is_model_reviewing(p.run.as_ref()));
        let mut out = Vec::new();
        render_approval(&mut out, &approval, true).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("模型正在审查执行权限"));
        assert!(
            text.contains("git status")
                && text.contains("/project")
                && text.contains("/references")
        );
        assert!(!text.contains("/reply") && !text.contains("需要你批准"));
        p.run.as_mut().unwrap().status = "waiting".into();
        assert!(!approval.is_model_reviewing(p.run.as_ref()));
        let mut out = Vec::new();
        render_approval(&mut out, &approval, false).unwrap();
        assert!(String::from_utf8(out).unwrap().contains("/reply 1"));
    }

    #[test]
    fn source_references_are_append_only_links_with_missing_source_notice() {
        let references = serde_json::from_value(json!({"citations":[{"url":"https://example.test/docs","title":"Reference"}],"unresolved":true})).unwrap();
        let mut out = b"Original text with source marker\n".to_vec();
        render_source_references(&mut out, Some(&references)).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("Original text with source marker\n"));
        assert!(text.contains("[Reference](<https://example.test/docs>)"));
        assert!(text.contains("部分引用来源未返回"));
        let mut projection = projection();
        projection.messages.push(serde_json::from_value(json!({"messageId":"message:sources", "role":"assistant", "content":"Original text with source marker", "sequence":1, "createdAt":"now", "filesystemReferences":[], "pluginSelections":[], "sourceReferences":{"citations":[{"url":"https://example.test/docs","title":"Reference"}],"unresolved":true}})).unwrap());
        projection.timeline.push(serde_json::from_value(json!({"kind":"message", "timelineId":"timeline:sources", "sequence":1, "messageId":"message:sources"})).unwrap());
        projection.messages.push(serde_json::from_value(json!({"messageId":"message:repaired", "role":"assistant", "content":"Earlier repaired answer", "sequence":3, "createdAt":"now", "filesystemReferences":[], "pluginSelections":[]})).unwrap());
        projection.timeline.insert(0, serde_json::from_value(json!({"kind":"message", "timelineId":"timeline:repaired", "sequence":0, "messageId":"message:repaired"})).unwrap());
        let mut plain = Vec::new();
        render_final_message(&mut plain, &projection, 0).unwrap();
        assert_eq!(String::from_utf8(plain).unwrap(), text);
    }

    fn plan(revision: u64, status: &str, sequence: u64) -> Value {
        json!({"planId":"plan:test","revision":revision,"runId":"run:test","callId":"call:plan",
            "title":format!("审核方案 {revision}"),"summary":"方案正文只输出一次",
            "steps":[{"stepId":"step:one","title":"执行并验证","details":"第一行\n第二行"}],
            "mutationManifest":[],"status":status,"sequence":sequence,"createdAt":"now","updatedAt":"now"})
    }

    fn add_plan(p: &mut SessionProjection, revision: u64, status: &str, sequence: u64) {
        p.plans
            .push(serde_json::from_value(plan(revision, status, sequence)).unwrap());
        p.timeline.push(serde_json::from_value(json!({"kind":"plan","timelineId":format!("plan:{revision}"),
            "sequence":sequence,"providerRequestId":"request:plan","planId":"plan:test","revision":revision})).unwrap());
    }

    fn narrative(p: &mut SessionProjection, id: &str, sequence: u64, content: &str) {
        p.narratives.push(
            serde_json::from_value(
                json!({"narrativeId":id,"runId":"run:test","providerRequestId":id,
            "content":content,"sequence":sequence,"createdAt":"now"}),
            )
            .unwrap(),
        );
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"narrative","timelineId":id,"sequence":sequence,
            "providerRequestId":id,"narrativeId":id,"streamId":id}),
            )
            .unwrap(),
        );
    }

    fn tool(p: &mut SessionProjection) {
        p.activities.push(serde_json::from_value(json!({"activityId":"tool:one","kind":"tool","status":"active",
            "label":"write","runId":"run:test","callId":"call:write","sequence":20,
            "tool":{"operation":"fs.write","recordId":"record:one","resources":[],"fileChanges":[{
                "workspaceId":"workspace:test","path":"result.txt","kind":"create",
                "before":{"exists":false},"after":{"exists":true,"contentRef":"content:one","sizeBytes":8}}]}})).unwrap());
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"toolGroup","timelineId":"tools:one","sequence":20,
            "providerRequestId":"request:write","activityIds":["tool:one"]}),
            )
            .unwrap(),
        );
        p.file_change_rounds.push(
            serde_json::from_value(json!({"runId":"run:test","recordIds":["record:one"]})).unwrap(),
        );
    }

    fn draft(p: &mut SessionProjection, content: &str) {
        p.assistant_draft = Some(serde_json::from_value(json!({"runId":"run:test","turnId":"turn:final",
            "blocks":[{"kind":"finalMessage","streamId":"stream:final","outputIndex":0,"content":content}]})).unwrap());
    }

    fn commit(p: &mut SessionProjection, content: &str) {
        p.messages.push(serde_json::from_value(json!({"messageId":"message:final","runId":"run:test",
            "role":"assistant","content":content,"filesystemReferences":[],"pluginSelections":[],"sequence":38,"createdAt":"now"})).unwrap());
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"message","timelineId":"message:final","sequence":38,
            "messageId":"message:final","streamId":"stream:final","outputIndex":0}),
            )
            .unwrap(),
        );
    }

    #[test]
    fn queued_input_changes_and_tool_errors_remain_visible() {
        let mut p = projection();
        p.queued_inputs.push(serde_json::from_value(json!({
            "commandId":"command:q", "messageId":"message:q", "runId":"run:test", "text":"补充🙂",
            "filesystemReferences":[], "pluginSelections":[], "sequence":1, "createdAt":"now", "status":"queued"
        })).unwrap());
        let mut state = CliRenderState::default();
        let mut out = Vec::new();
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        p.queued_inputs[0].status = "notApplied".into();
        state.render(&mut out, &p).unwrap();
        let activity = serde_json::from_value(json!({"activityId":"tool:error", "kind":"tool", "status":"failed",
            "label":"fs.read", "runId":"run:test", "callId":"call:error", "sequence":2,
            "tool":{"operation":"fs.read", "resources":[], "error":{"code":"fs_read_failed", "message":"original failure"},
                "projectionError":{"code":"tool_error_diagnostics_invalid", "message":"Original record retained."}}})).unwrap();
        render_tool_activity(&mut out, &p, &activity).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("已排队: 补充🙂").count(), 1);
        assert_eq!(text.matches("未执行: 补充🙂").count(), 1);
        assert!(text.contains("fs_read_failed: original failure"));
        assert!(text.contains("tool_error_diagnostics_invalid: Original record retained."));
    }

    #[test]
    fn item_identity_preserves_nonmonotonic_order_and_later_updates() {
        let mut p = projection();
        narrative(&mut p, "narrative:old", 15, "已看过的过程");
        add_plan(&mut p, 1, "published", 12);
        let mut state = CliRenderState::after(&p);
        let mut out = Vec::new();
        p.plans[0].status = "confirmed".into();
        p.plans[0].sequence = 17;
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        tool(&mut p);
        state.render(&mut out, &p).unwrap();
        p.activities[0].status = "completed".into();
        p.plans[0].status = "completed".into();
        p.plans[0].sequence = 34;
        state.render(&mut out, &p).unwrap();
        // This item becomes visible after a larger sequence has already rendered.
        narrative(&mut p, "narrative:late", 23, "后到的真实过程");
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains("已看过的过程"));
        assert!(!text.contains("方案正文只输出一次"));
        assert_eq!(text.matches("后到的真实过程").count(), 1);
        assert_eq!(
            text.matches("Plan 状态 · revision 1 · completed").count(),
            1
        );
        assert_eq!(text.matches("工具 fs.write [active]").count(), 1);
        assert_eq!(text.matches("工具 fs.write [completed]").count(), 1);
        assert!(!text.contains("本轮修改"));
    }

    #[test]
    fn live_tool_output_advances_without_a_revision_change_or_repeating_the_prefix() {
        let mut p = projection();
        p.activities.push(serde_json::from_value(json!({
            "activityId":"tool:live", "kind":"tool", "status":"active", "label":"bash",
            "runId":"run:test", "callId":"call:live", "sequence":1, "startedAt":"1789280000000",
            "liveOutput":{"stdout":"开始\n", "stderr":"", "stdoutBytes":7, "stderrBytes":0, "truncated":false}
        })).unwrap());
        p.timeline.push(
            serde_json::from_value(json!({"kind":"toolGroup", "timelineId":"tools:live",
            "sequence":1, "providerRequestId":"request:live", "activityIds":["tool:live"]}))
            .unwrap(),
        );
        let mut state = CliRenderState::default();
        let mut out = Vec::new();
        state.render(&mut out, &p).unwrap();
        let initial_length = out.len();
        state.render(&mut out, &p).unwrap();
        assert_eq!(out.len(), initial_length);
        let live = p.activities[0].live_output.as_mut().unwrap();
        live.stdout.push_str("下一步\n");
        live.stdout_bytes += 10;
        live.stderr = "警告\n".into();
        live.stderr_bytes = 7;
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert_eq!(p.revision, 1);
        assert_eq!(text.matches("工具 bash [active]").count(), 1);
        assert_eq!(text.matches("开始").count(), 1);
        assert_eq!(text.matches("下一步").count(), 1);
        assert_eq!(text.matches("警告").count(), 1);
        let live = p.activities[0].live_output.as_mut().unwrap();
        live.stdout = "保留的尾部\n".into();
        live.stdout_bytes = 100_000;
        live.truncated = true;
        state.render(&mut out, &p).unwrap();
        assert!(String::from_utf8(out.clone())
            .unwrap()
            .contains("stdout 最新片段"));
        let terminal_start = out.len();
        p.activities[0].status = "completed".into();
        p.activities[0].live_output = None;
        p.activities[0].tool = Some(serde_json::from_value(json!({
            "operation":"bash", "recordId":"record:live", "resources":[],
            "shell":{"command":"build", "cwd":".", "executionScope":"workspace", "terminal":false,
                "result":{"stdout":"正式结果\n", "stderr":"", "exitCode":0, "success":true,
                    "timedOut":false, "truncated":false, "capturedBytes":13, "durationMs":100,
                    "environment":{"shell":"/bin/bash", "interactive":false, "executionScope":"workspace",
                        "terminal":false, "pathSource":"hostPlusStandardDeveloperPaths",
                        "writeScope":"authorizedResources", "homeWritable":true, "networkAccess":false}}}
        })).unwrap());
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        let terminal = String::from_utf8(out[terminal_start..].to_vec()).unwrap();
        assert_eq!(terminal.matches("[completed]").count(), 1);
        assert!(!terminal.contains("实时输出"));
        assert!(!terminal.contains("保留的尾部"));
        assert_eq!(terminal.matches("正式结果").count(), 1);
    }

    #[test]
    fn pending_plan_document_has_one_owner_and_revisions_stay_reviewable() {
        let mut p = projection();
        add_plan(&mut p, 1, "published", 12);
        let mut pending = plan(1, "published", 12);
        pending["responseMode"] = json!("confirmReviseOrCancel");
        p.pending_plan = Some(serde_json::from_value(pending).unwrap());
        let mut state = CliRenderState::default();
        let mut out = Vec::new();
        state.render(&mut out, &p).unwrap();
        state.render_action_required(&mut out, &p).unwrap();
        p.pending_plan = None;
        p.plans[0].status = "revisionRequested".into();
        add_plan(&mut p, 2, "published", 30);
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("审核方案 1").count(), 1);
        assert_eq!(text.matches("审核方案 2").count(), 1);
        assert_eq!(text.matches("输入 /reply 1 或 /reply 确认").count(), 1);
        assert!(text.contains("   第一行\n   第二行"));
        assert!(text.contains("Plan 状态 · revision 1 · revisionRequested"));
    }

    #[test]
    fn citations_use_session_display_text_during_streaming_commit_and_plain_output() {
        let mut p = projection();
        let mut state = CliRenderState::after(&p);
        let mut out = Vec::new();
        let raw = "正文\u{e200}cite\u{e202}turn0search0\u{e201}结束";
        let display = "正文[来源](<https://example.test/docs>)结束";
        p.assistant_draft = Some(
            serde_json::from_value(json!({
                "runId":"run:test", "turnId":"turn:final", "blocks":[{
                    "kind":"finalMessage", "streamId":"stream:final", "outputIndex":0,
                    "content":raw, "displayContent":"正文"
                }]
            }))
            .unwrap(),
        );
        state.render(&mut out, &p).unwrap();
        assert_eq!(String::from_utf8(out.clone()).unwrap(), "正文");
        commit(&mut p, raw);
        p.messages.last_mut().unwrap().display_content = Some(display.into());
        state.render(&mut out, &p).unwrap();
        p.assistant_draft = None;
        state.render(&mut out, &p).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), format!("{display}\n"));
        let mut plain = Vec::new();
        render_final_message(&mut plain, &p, 0).unwrap();
        assert_eq!(String::from_utf8(plain).unwrap(), format!("{display}\n"));
        assert_eq!(p.messages.last().unwrap().content, raw);
    }

    #[test]
    fn streamed_markdown_is_contiguous_and_committed_tail_precedes_status() {
        let mut p = projection();
        add_plan(&mut p, 1, "confirmed", 17);
        let mut state = CliRenderState::after(&p);
        let mut out = Vec::new();
        let chunks = [
            "## 结果\n\n已",
            "完成。\n\n```cpp\nint n = 1;\n```\n\n不需要",
            "新的计划修订。",
        ];
        draft(&mut p, chunks[0]);
        state.render(&mut out, &p).unwrap();
        p.plans[0].status = "completed".into();
        p.plans[0].sequence = 34;
        let partial = chunks[..2].concat();
        draft(&mut p, &partial);
        state.render(&mut out, &p).unwrap();
        assert_eq!(String::from_utf8(out.clone()).unwrap(), partial);
        let complete = chunks.concat();
        commit(&mut p, &complete);
        // The committed text is authoritative even during a draft handoff.
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        p.assistant_draft = None;
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(
            text,
            format!("{complete}\nPlan 状态 · revision 1 · completed\n")
        );
    }

    #[test]
    fn changes_are_summarized_once_after_text_on_each_terminal_outcome() {
        for status in ["completed", "failed", "cancelled", "indeterminate"] {
            let mut p = projection();
            tool(&mut p);
            p.activities[0].status = "completed".into();
            let mut state = CliRenderState::default();
            let mut out = Vec::new();
            state.render(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            assert!(!String::from_utf8(out.clone()).unwrap().contains("本轮修改"));
            draft(&mut p, "已经写入文件，");
            state.render(&mut out, &p).unwrap();
            commit(&mut p, "已经写入文件，以下为实际结果。");
            p.assistant_draft = None;
            p.run.as_mut().unwrap().status = status.into();
            state.render(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            let text = String::from_utf8(out).unwrap();
            assert_eq!(text.matches("本轮修改").count(), 1);
            assert!(text.contains("已经写入文件，以下为实际结果。\n本轮修改"));
            assert!(text.contains("create result.txt · deepcode-cli diff"));
        }
    }
}
