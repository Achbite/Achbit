//! Input decisions shared by the CLI and TUI; Session remains the command owner.
use crate::i18n::Language;
use achbit_kernel_client::{
    approval_response_command, focus_command, interaction_response_command,
    message_command_with_profile_and_plugins, plan_confirm_command, plan_revision_command,
    FilesystemReference, HttpKernelClient, InteractionProjection, PluginSelectionInput,
    SessionProjection,
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

/// Replying from the parent keeps the original child decision identity and command owner.
pub async fn child_reply_projection(
    language: Language,
    client: &HttpKernelClient,
    projection: &SessionProjection,
    text: &str,
) -> Result<Option<SessionProjection>, String> {
    if !matches!(slash_command(text), Some(("reply", _)))
        || projection.pending_plan.is_some()
        || projection.pending_interaction.is_some()
        || projection.pending_approval.is_some()
    {
        return Ok(None);
    }
    let decisions = projection.pending_agent_decisions.as_deref().unwrap_or(&[]);
    let decision = match decisions {
        [] => return Ok(None),
        [decision] => decision,
        _ => return Err(language.text("tui.chooseChildReply").into()),
    };
    let child = client
        .conversation_projection(&decision.agent_session_id)
        .await
        .map_err(|error| error.to_string())?;
    let plan = child
        .pending_plan
        .as_ref()
        .map(|plan| (plan.plan_id.as_str(), plan.revision));
    let approval = child
        .pending_approval
        .as_ref()
        .map(|approval| (approval.approval_id.as_str(), approval.call_id.as_str()));
    let interactions: Vec<_> = child
        .interactions
        .iter()
        .filter(|interaction| interaction.status == "pending")
        .map(|interaction| interaction.interaction_id.as_str())
        .collect();
    if child.session_id != decision.agent_session_id
        || child.run.as_ref().map(|run| run.run_id.as_str()) != Some(decision.run_id.as_str())
        || plan
            != decision
                .plan
                .as_ref()
                .map(|plan| (plan.plan_id.as_str(), plan.revision))
        || approval
            != decision
                .approval
                .as_ref()
                .map(|approval| (approval.approval_id.as_str(), approval.call_id.as_str()))
        || interactions
            != decision
                .interaction_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
    {
        return Err(language.text("tui.childDecisionChanged").into());
    }
    Ok(Some(child))
}

pub fn contextual_input_command(
    language: Language,
    projection: &SessionProjection,
    text: &str,
    command_id: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    catalog_revision: &str,
    selections: &[PluginSelectionInput],
) -> Result<serde_json::Value, String> {
    let original_text = text;
    let text = text.trim();
    if text.is_empty() {
        return Err(language.text("tui.emptyInput").to_string());
    }
    let command = slash_command(original_text);
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
            .ok_or("No active grant with this authority ID")?;
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
        if let Some(approval) = projection.pending_approval.as_ref() {
            let decision = approval_decision_for_input(language, response)?;
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
            catalog_revision,
            selections,
        ));
    }
    let mut command = message_command_with_profile_and_plugins(
        &projection.session_id,
        command_id,
        original_text,
        profile_id,
        filesystem_references,
        catalog_revision,
        selections,
    );
    if let Some(run) = projection
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
                "catalog:test",
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
                    "",
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
            "",
            &[],
        )
        .unwrap();
        assert_eq!(command["type"], "context.focus");
        assert_eq!(command["task"], "检查\n目录");
    }
}
