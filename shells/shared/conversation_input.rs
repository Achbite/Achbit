//! Input decisions shared by the CLI and TUI; Session remains the command owner.
use crate::i18n::Language;
use achbit_kernel_client::{
    approval_response_command, focus_command, interaction_response_command,
    message_command_with_profile_and_plugins, plan_confirm_command, plan_revision_command,
    FilesystemReference, HttpKernelClient, InteractionProjection, PendingAgentDecision,
    PluginSelectionInput, SessionProjection,
};
use serde_json::json;

/// A leading space escapes commands; callers must pass the original input.
pub fn slash_command(text: &str) -> Option<(&str, &str)> {
    let command = text.strip_prefix('/')?;
    let (name, argument) = command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""));
    Some((name, argument.trim()))
}

/// Pending plugin selections apply to task input, not replies or Session settings.
pub fn consumes_plugin_selections(text: &str) -> bool {
    match slash_command(text) {
        Some((name, _))
            if name.eq_ignore_ascii_case("simloop") || name.eq_ignore_ascii_case("fullloop") =>
        {
            false
        }
        Some(("reply", _)) => false,
        Some(("permissions" | "revoke", argument)) => argument.is_empty(),
        _ => true,
    }
}

/// Replying from the parent keeps the original child decision identity and command owner.
pub async fn child_reply_projection(
    language: Language,
    client: &HttpKernelClient,
    projection: &SessionProjection,
    text: &str,
) -> Result<Option<SessionProjection>, String> {
    let Some(("reply", response)) = slash_command(text) else {
        return Ok(None);
    };
    let selector = approval_selector(response).map(|(id, _)| id);
    let decision = if let Some(id) = selector {
        if projection.human_approvals().any(|a| a.approval_id == id) {
            return Ok(None);
        }
        let mut routes = projection
            .pending_agent_decisions
            .iter()
            .flatten()
            .filter(|route| route.approval.as_ref().is_some_and(|a| a.approval_id == id));
        let Some(route) = routes.next() else {
            return Err(language.text("tui.noPendingReply").into());
        };
        if routes.next().is_some() {
            return Err(language.text("tui.chooseChildReply").into());
        }
        route
    } else {
        if projection.pending_plan.is_some()
            || projection.pending_interaction.is_some()
            || projection.human_approvals().next().is_some()
        {
            return Ok(None);
        }
        let mut children = projection.pending_decision_children();
        let Some(first) = children.next() else {
            return Ok(None);
        };
        if children.next().is_some() {
            return Err(language.text("tui.chooseChildReply").into());
        }
        first
    };
    let child = client
        .conversation_projection(&decision.agent_session_id)
        .await
        .map_err(|error| error.to_string())?;
    if !child_decisions_match(projection, decision, &child, selector.is_some()) {
        return Err(language.text("tui.childDecisionChanged").into());
    }
    Ok(Some(child))
}

/// Rendering and input must match Session's published route, not a child's first pending call.
/// For an explicit selection a change to an unrelated sibling need not invalidate the reply.
pub fn child_decisions_match(
    parent: &SessionProjection,
    decision: &PendingAgentDecision,
    child: &SessionProjection,
    explicit: bool,
) -> bool {
    if decision.agent_session_id != child.session_id
        || !child.run.as_ref().is_some_and(|r| {
            r.run_id == decision.run_id && matches!(r.status.as_str(), "running" | "waiting")
        })
    {
        return false;
    }
    if explicit {
        return decision.approval.as_ref().is_some_and(|r| {
            child
                .human_approvals()
                .any(|a| a.approval_id == r.approval_id && a.call_id == r.call_id)
        });
    }
    child
        .human_approvals()
        .map(|a| (&a.approval_id, &a.call_id))
        .eq(parent
            .pending_agent_decisions
            .iter()
            .flatten()
            .filter(|r| r.agent_session_id == child.session_id && r.run_id == decision.run_id)
            .filter_map(|d| d.approval.as_ref())
            .map(|a| (&a.approval_id, &a.call_id)))
        && child
            .pending_plan
            .as_ref()
            .map(|p| (&p.plan_id, p.revision))
            == decision.plan.as_ref().map(|p| (&p.plan_id, p.revision))
        && child
            .interactions
            .iter()
            .filter(|i| i.run_id == decision.run_id && i.status == "pending")
            .map(|i| &i.interaction_id)
            .eq(decision.interaction_ids.iter())
}

pub fn approval_reply_prefix(
    approval: &achbit_kernel_client::ApprovalProjection,
    multiple: bool,
) -> String {
    if multiple {
        format!("/reply --approval {}", approval.approval_id)
    } else {
        "/reply".into()
    }
}

/// None preserves the ordinary /reply text for a Plan, question or a single approval.
fn approval_selector(response: &str) -> Option<(&str, &str)> {
    let mut words = response.splitn(2, char::is_whitespace);
    if words.next()? != "--approval" {
        return None;
    }
    let rest = words.next().unwrap_or("").trim();
    let (id, decision) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    Some((id, decision.trim()))
}

/// Bind a reply to the decision shown before the interactive client refreshed.
pub fn check_reply_refresh(
    language: Language,
    before: &SessionProjection,
    after: &SessionProjection,
    text: &str,
) -> Result<(), String> {
    let Some(("reply", response)) = slash_command(text) else {
        return Ok(());
    };
    #[derive(PartialEq)]
    enum Target<'a> {
        Approval(&'a str, &'a str, &'a str, &'a str),
        Plan(&'a str, &'a str, &'a str, u64),
        Question(&'a str, &'a str, &'a str),
    }
    fn identities<'a>(p: &'a SessionProjection, selected: Option<&str>) -> Vec<Target<'a>> {
        let mut targets: Vec<_> = p
            .human_approvals()
            .filter(|a| selected.is_none_or(|id| id == a.approval_id))
            .map(|a| Target::Approval(&p.session_id, &a.run_id, &a.call_id, &a.approval_id))
            .collect();
        if !targets.is_empty() {
            return targets;
        }
        if selected.is_none() {
            if let Some(plan) = &p.pending_plan {
                return vec![Target::Plan(
                    &p.session_id,
                    &plan.run_id,
                    &plan.plan_id,
                    plan.revision,
                )];
            }
            if let Some(question) = &p.pending_interaction {
                return vec![Target::Question(
                    &p.session_id,
                    &question.run_id,
                    &question.interaction_id,
                )];
            }
        }
        for route in p.pending_agent_decisions.iter().flatten() {
            let session = route.agent_session_id.as_str();
            let run = route.run_id.as_str();
            if let Some(a) = &route.approval {
                if selected.is_none_or(|id| id == a.approval_id) {
                    targets.push(Target::Approval(session, run, &a.call_id, &a.approval_id));
                }
            }
            if selected.is_none() {
                if let Some(plan) = &route.plan {
                    targets.push(Target::Plan(session, run, &plan.plan_id, plan.revision));
                }
                targets.extend(
                    route
                        .interaction_ids
                        .iter()
                        .map(|id| Target::Question(session, run, id)),
                );
            }
        }
        targets
    }
    let id = approval_selector(response).map(|(id, _)| id);
    if identities(before, id) != identities(after, id) {
        return Err(language.text("tui.childDecisionChanged").into());
    }
    Ok(())
}

pub fn contextual_input_command(
    language: Language,
    projection: &SessionProjection,
    text: &str,
    command_id: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    selections: &[PluginSelectionInput],
) -> Result<serde_json::Value, String> {
    let original_text = text;
    let text = text.trim();
    if text.is_empty() {
        return Err(language.text("tui.emptyInput").to_string());
    }
    let command = slash_command(original_text);
    if let Some((name, argument)) = command.filter(|(name, _)| {
        name.eq_ignore_ascii_case("simloop") || name.eq_ignore_ascii_case("fullloop")
    }) {
        if !argument.is_empty() || !filesystem_references.is_empty() {
            return Err(language.text("tui.modeUsage").to_string());
        }
        return Ok(
            json!({"schemaVersion":"achbit.command.v3", "type":"session.mode.set",
            "sessionId":projection.session_id, "commandId":command_id,
            "mode": if name.eq_ignore_ascii_case("simloop") { "minimal" } else { "full" }}),
        );
    }
    if let Some(("permissions", patches)) = command.filter(|(_, argument)| !argument.is_empty()) {
        let patches: serde_json::Value =
            serde_json::from_str(patches).map_err(|error| error.to_string())?;
        return Ok(
            json!({"schemaVersion": "achbit.command.v3", "type":"session.permissions.set", "commandId":command_id, "sessionId":projection.session_id, "patches":patches}),
        );
    }
    if let Some(("revoke", authority)) = command.filter(|(_, argument)| !argument.is_empty()) {
        let grant = projection
            .shell_authorizations
            .iter()
            .find(|grant| grant.authority_id == authority.trim())
            .ok_or_else(|| language.text("tui.noActiveAuthority"))?;
        return Ok(
            json!({"schemaVersion":"achbit.command.v3", "type":"approval.revoke", "commandId":command_id, "sessionId":projection.session_id, "runId":grant.run_id, "authorityId":grant.authority_id}),
        );
    }
    if let Some(("reply", response)) = command {
        if response.is_empty() {
            return Err(language.text("tui.replyUsage").to_string());
        }
        if !selections.is_empty() || !filesystem_references.is_empty() {
            return Err(language.text("tui.replyReferencesUnsupported").to_string());
        }
        let selected = approval_selector(response);
        let mut approvals = projection
            .human_approvals()
            .filter(|a| selected.is_none_or(|(id, _)| a.approval_id == id));
        if let Some(approval) = approvals.next() {
            if approvals.next().is_some() {
                return Err(language.format(
                    "tui.chooseApprovalReply",
                    &[projection
                        .human_approvals()
                        .map(|a| a.approval_id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")],
                ));
            }
            let decision = approval_decision_for_input(
                language,
                selected.map_or(response, |(_, decision)| decision),
            )?;
            let scope = achbit_kernel_client::approval_scope_for_input(decision);
            if scope.is_some_and(|scope| {
                !approval
                    .preview
                    .authorization_scopes
                    .as_ref()
                    .is_some_and(|scopes| scopes.iter().any(|candidate| candidate == scope))
            }) {
                return Err(language.text("tui.runAuthorizationUnavailable").into());
            }
            return Ok(approval_response_command(
                &projection.session_id,
                command_id,
                approval,
                decision,
            ));
        }
        if selected.is_some() {
            return Err(language.text("tui.noPendingReply").into());
        }
        if let Some(plan) = projection.pending_plan.as_ref() {
            if is_plan_confirmation_input(response) {
                return Ok(plan_confirm_command(
                    &projection.session_id,
                    command_id,
                    plan,
                ));
            }
            return Ok(plan_revision_command(
                &projection.session_id,
                command_id,
                plan,
                response,
            ));
        }
        if let Some(interaction) = projection.pending_interaction.as_ref() {
            let response = interaction_response_for_input(interaction, response);
            return Ok(interaction_response_command(
                &projection.session_id,
                command_id,
                interaction,
                &response,
            ));
        }
        return Err(language.text("tui.noPendingReply").to_string());
    }
    let profile_id = if projection
        .run
        .as_ref()
        .is_some_and(|run| matches!(run.status.as_str(), "running" | "waiting"))
    {
        None
    } else {
        profile_id
    };
    if let Some(("focus", task)) = command {
        if task.is_empty() {
            return Err(language.text("tui.focusRequired").to_string());
        }
        return Ok(focus_command(
            &projection.session_id,
            command_id,
            task,
            profile_id,
            filesystem_references,
            selections,
        ));
    }
    let plan_task = command.and_then(|(name, task)| (name == "plan").then_some(task));
    if plan_task == Some("") {
        return Err(language.text("tui.planRequired").to_string());
    }
    let mut command = message_command_with_profile_and_plugins(
        &projection.session_id,
        command_id,
        plan_task.unwrap_or(original_text),
        profile_id,
        filesystem_references,
        selections,
    );
    if plan_task.is_some() {
        command["planMode"] = json!("manual");
    } else if let Some(run) = projection
        .run
        .as_ref()
        .filter(|run| matches!(run.status.as_str(), "running" | "waiting"))
    {
        command["runId"] = json!(run.run_id);
    }
    Ok(command)
}

fn approval_decision_for_input(language: Language, input: &str) -> Result<&'static str, String> {
    match input.trim().to_lowercase().as_str() {
        "1" | "allow" | "允许" | "同意" => Ok("allow"),
        "2" | "deny" | "拒绝" | "不同意" => Ok("deny"),
        "3" | "allow-run" | "本轮允许此命令" => Ok("allow-run"),
        "4" | "allow-host-run" | "本轮允许Host" => Ok("allow-host-run"),
        "5" | "allow-files-run" => Ok("allow-files-run"),
        "6" | "allow-files-session" => Ok("allow-files-session"),
        _ => achbit_kernel_client::AUTHORIZATION_OPTIONS
            .iter()
            .find(|(_, command)| *command == input.trim())
            .map(|(_, command)| *command)
            .ok_or_else(|| language.text("tui.approvalReplyRequired").to_string()),
    }
}

fn interaction_response_for_input(interaction: &InteractionProjection, input: &str) -> String {
    input
        .parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| interaction.options.as_ref()?.get(index))
        .map(|option| option.label.clone())
        .unwrap_or_else(|| input.to_string())
}

fn is_plan_confirmation_input(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "1" | "y" | "yes" | "confirm"
    ) || matches!(input.trim(), "确认" | "同意")
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub(crate) fn waiting_projection(
        field: &str,
        decision: serde_json::Value,
    ) -> SessionProjection {
        let mut value = json!({
            "schemaVersion": achbit_kernel_client::SESSION_PROJECTION_VERSION, "permissionOverrides":{}, "effectivePermissions":null, "shellAuthorizations":[],
            "sessionId":"session:test", "revision":1, "display":{"creationTitle":"input"},
            "workspaceBindings":[], "sessionDirectoryIndexes":[], "timeline":[], "messages":[],
            "queuedInputs":[], "narratives":[], "plans":[], "contextCompositions":[], "interactions":[],
            "tokenUsageHistory":[], "activities":[], "artifacts":[],"deliverables":[],
            "tokenUsage":{"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
              "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "totalTokenUsage": {"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
              "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "run":{"runId":"run:test","profileId":"profile:current","workspaceBindings":[],"status":"waiting"}
        });
        if field == "pendingInteraction" {
            value["interactions"] = json!([decision.clone()]);
        }
        value[field] = decision;
        serde_json::from_value(value).unwrap()
    }

    pub(crate) fn approval_projection(ids: &[&str]) -> SessionProjection {
        let approval = |id: &str| {
            json!({"approvalId":format!("approval:{id}"),"callId":format!("call:{id}"),"runId":"run:test",
            "preview":{"approvalReviewer":if id == "model" {"agent"} else {"user"},"summary":format!("Operation {id}"),"effects":[],"logicalTargets":[]},
            "sequence":2,"createdAt":"now"})
        };
        let mut p = waiting_projection("pendingApproval", approval(ids[0]));
        p.pending_approvals = Some(
            ids.iter()
                .map(|id| serde_json::from_value(approval(id)).unwrap())
                .collect(),
        );
        p
    }

    pub(crate) fn pending_decisions() -> [(
        &'static str,
        serde_json::Value,
        &'static str,
        &'static str,
        serde_json::Value,
    ); 3] {
        [
            (
                "pendingPlan",
                json!({"planId":"plan:test","revision":1,"runId":"run:test","callId":"call:plan",
                "title":"Plan","summary":"Review","steps":[],"mutationManifest":[],"status":"published",
                "responseMode":"confirmReviseOrCancel","sequence":1,"createdAt":"now","updatedAt":"now"}),
                "plan.respond",
                "response",
                json!({"kind":"confirm"}),
            ),
            (
                "pendingInteraction",
                json!({"interactionId":"interaction:test","runId":"run:test","callId":"call:question",
                "status":"pending","kind":"question","prompt":"Choose","options":[{"id":"a","label":"Option A"}],
                "allowFreeform":true,"sequence":1,"createdAt":"now"}),
                "interaction.respond",
                "response",
                json!("Option A"),
            ),
            (
                "pendingApproval",
                json!({"approvalId":"approval:test","runId":"run:test","callId":"call:effect",
                "preview":{"summary":"Write","effects":[],"logicalTargets":[]},"sequence":1,"createdAt":"now"}),
                "approval.respond",
                "decision",
                json!("allow"),
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use fixtures::approval_projection;

    fn reply(p: &SessionProjection, text: &str) -> Result<serde_json::Value, String> {
        contextual_input_command(Language::EnUs, p, text, "command:reply", None, &[], &[])
    }

    #[test]
    fn refreshed_reply_keeps_plan_revision_and_question_identity() {
        for (field, value, ..) in fixtures::pending_decisions().into_iter().take(2) {
            let shown = fixtures::waiting_projection(field, value);
            let mut changed = shown.clone();
            check_reply_refresh(Language::EnUs, &shown, &changed, "/reply 1").unwrap();
            if let Some(plan) = changed.pending_plan.as_mut() {
                plan.revision += 1;
            }
            if let Some(question) = changed.pending_interaction.as_mut() {
                question.interaction_id.push_str("-next");
            }
            assert!(check_reply_refresh(Language::EnUs, &shown, &changed, "/reply 1").is_err());
        }
    }

    #[test]
    fn terminal_approval_only_unambiguous_human_handoff_receives_reply() {
        let mut p = approval_projection(&["model", "human"]);
        for status in ["waiting", "running"] {
            p.run.as_mut().unwrap().status = status.into();
            let cmd = reply(&p, "/reply 2").unwrap();
            assert_eq!(
                (
                    &cmd["sessionId"],
                    &cmd["runId"],
                    &cmd["callId"],
                    &cmd["approvalId"]
                ),
                (
                    &json!("session:test"),
                    &json!("run:test"),
                    &json!("call:human"),
                    &json!("approval:human")
                )
            );
        }
        let p = approval_projection(&["model"]);
        assert!(
            reply(&p, "/reply 2").is_err(),
            "a stale run-level wait is not a human handoff"
        );
    }

    #[test]
    fn terminal_approval_multiple_human_items_require_the_displayed_id() {
        let p = approval_projection(&["model", "one", "two"]);
        assert!(reply(&p, "/reply 1").is_err());
        let cmd = reply(&p, "/reply --approval approval:two 2").unwrap();
        assert_eq!(cmd["approvalId"], "approval:two");
        assert_eq!(cmd["callId"], "call:two");
        assert_eq!(cmd["decision"], "deny");
        for stale in ["approval:old", "approval:model"] {
            assert!(reply(&p, &format!("/reply --approval {stale} 1")).is_err());
        }
    }

    #[test]
    fn terminal_approval_checks_child_routes_and_refresh_against_original_identities() {
        let child = approval_projection(&["model", "one", "two"]);
        let mut parent = fixtures::waiting_projection("pendingApproval", serde_json::Value::Null);
        parent.session_id = "session:parent".into();
        parent.pending_agent_decisions = Some(["one","two"].into_iter().map(|id| serde_json::from_value(json!({
            "agentSessionId":child.session_id, "displayName":"Worker", "runId":"run:test", "interactionIds":[],
            "approval":{"approvalId":format!("approval:{id}"),"callId":format!("call:{id}")}
        })).unwrap()).collect());
        let routes = parent.pending_agent_decisions.as_ref().unwrap();
        assert!(child_decisions_match(&parent, &routes[0], &child, false));
        assert!(child_decisions_match(&parent, &routes[1], &child, true));
        let fresh = approval_projection(&["model", "two", "new"]);
        assert!(!child_decisions_match(&parent, &routes[0], &fresh, false));
        assert!(!child_decisions_match(&parent, &routes[0], &fresh, true));
        assert!(child_decisions_match(&parent, &routes[1], &fresh, true));
        let mut later = parent.clone();
        later.pending_agent_decisions.as_mut().unwrap()[1]
            .approval
            .as_mut()
            .unwrap()
            .call_id = "call:replacement".into();
        assert!(!child_decisions_match(
            &later,
            &later.pending_agent_decisions.as_ref().unwrap()[1],
            &child,
            true
        ));
        assert!(check_reply_refresh(Language::EnUs, &parent, &later, "/reply 2").is_err());
        assert!(check_reply_refresh(
            Language::EnUs,
            &parent,
            &later,
            "/reply --approval approval:two 2"
        )
        .is_err());
        assert!(check_reply_refresh(
            Language::EnUs,
            &parent,
            &later,
            "/reply --approval approval:one 2"
        )
        .is_ok());
    }

    #[test]
    fn pending_plugins_follow_task_input_not_replies_or_session_settings() {
        for text in [
            "/SimLoop",
            "/FULLLOOP",
            "/simloop invalid",
            "/reply",
            "/reply 1",
            "/permissions {}",
            "/revoke authority:test",
        ] {
            assert!(!consumes_plugin_selections(text), "{text}");
        }
        for text in [
            "task",
            "/focus task",
            "/plan task",
            "/unknown",
            "/permissions",
            "/revoke",
            " /SimLoop",
            " /reply 1",
        ] {
            assert!(consumes_plugin_selections(text), "{text}");
        }
    }

    #[test]
    fn session_mode_commands_ignore_case_and_never_submit_task_text() {
        let projection = fixtures::waiting_projection("pendingPlan", serde_json::Value::Null);
        for (text, mode) in [
            ("/SimLoop", "minimal"),
            ("/SIMLOOP", "minimal"),
            ("/fUlLlOoP", "full"),
        ] {
            let command = contextual_input_command(
                Language::EnUs,
                &projection,
                text,
                "command:mode",
                None,
                &[],
                &[],
            )
            .unwrap();
            assert_eq!(command["type"], "session.mode.set");
            assert_eq!(command["mode"], mode);
            assert!(command.get("text").is_none());
            assert!(command.get("runId").is_none());
        }
        assert!(contextual_input_command(
            Language::EnUs,
            &projection,
            "/SimLoop task",
            "command:mode",
            None,
            &[],
            &[]
        )
        .is_err());
        let escaped = contextual_input_command(
            Language::EnUs,
            &projection,
            " /SimLoop",
            "command:mode",
            None,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(escaped["type"], "message.submit");
        assert_eq!(escaped["text"], " /SimLoop");
    }

    #[test]
    fn unclaimed_slash_text_preserves_body_references_and_plugins() {
        let projection = fixtures::waiting_projection("pendingPlan", serde_json::Value::Null);
        let references: Vec<FilesystemReference> = serde_json::from_value(json!([{
            "referenceId":"reference:directory", "workspaceId":"workspace:test",
            "logicalPath":".", "displayName":"workspace", "kind":"directory"
        }]))
        .unwrap();
        let selections = [PluginSelectionInput {
            selection_id: "selection:test".into(),
            uri: "plugin://web@builtin".into(),
            label: "Web".into(),
        }];
        for text in [
            "/Users/example/file.txt 请检查\n保留正文  ",
            "/tmp",
            "/api/v1",
            "/",
            "/unknown 请解释这个名字",
            "/focusdir",
            " /plan task",
            "/plan.md",
            "/reply-later",
            " /new",
            "\t/focus task",
            " /reply 1",
            " /permissions []",
            " /revoke authority:test",
        ] {
            let command = contextual_input_command(
                Language::EnUs,
                &projection,
                text,
                "command:test",
                None,
                &references,
                &selections,
            )
            .unwrap();
            assert_eq!(command["type"], "message.submit", "{text}");
            assert_eq!(command["text"], text);
            assert_eq!(command["runId"], "run:test");
            assert_eq!(
                command["filesystemReferences"],
                serde_json::to_value(&references).unwrap()
            );
            assert_eq!(
                command["pluginSelections"],
                serde_json::to_value(&selections).unwrap()
            );
        }
    }

    #[test]
    fn matched_context_commands_keep_success_and_failure_semantics() {
        let projection = fixtures::waiting_projection("pendingPlan", serde_json::Value::Null);
        for text in [
            "/focus",
            "/plan",
            "/reply",
            "/reply 1",
            "/permissions invalid",
            "/revoke missing",
        ] {
            assert!(
                contextual_input_command(
                    Language::EnUs,
                    &projection,
                    text,
                    "command:test",
                    None,
                    &[],
                    &[]
                )
                .is_err(),
                "{text} must not fall through to chat"
            );
        }
        let command = contextual_input_command(
            Language::EnUs,
            &projection,
            "/focus\t检查\n目录",
            "command:test",
            None,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(command["type"], "context.focus");
        assert_eq!(command["task"], "检查\n目录");
        let plan = contextual_input_command(
            Language::EnUs,
            &projection,
            "/plan 检查\n目录",
            "command:plan",
            None,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(plan["type"], "message.submit");
        assert_eq!(plan["text"], "检查\n目录");
        assert_eq!(plan["planMode"], "manual");
        assert!(plan.get("runId").is_none());
    }
}
