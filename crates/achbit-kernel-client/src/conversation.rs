use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const CONVERSATION_COMMAND_VERSION: &str = "achbit.command.v3";
pub const SESSION_PROJECTION_VERSION: &str = "achbit.session-projection.v6";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationCatalog {
    pub projects: Vec<ConversationProject>,
    pub sessions: Vec<ConversationSessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationProject {
    pub id: String,
    pub title: String,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSessionSummary {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub profile_id: Option<String>,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub created_at: String,
    pub updated_at: String,
}

impl ConversationCatalog {
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = HashSet::new();
        if self.sessions.iter().any(|session| {
            session.id.trim().is_empty()
                || session.id.chars().any(char::is_whitespace)
                || !ids.insert(&session.id)
        }) {
            return Err("conversation catalog session identities are invalid".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationSessionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_settings: Option<AgentSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettings {
    pub enabled: bool,
    pub profile_id: String,
    pub reasoning_effort: String,
    pub max_concurrent: u64,
    pub max_calls_per_run: u64,
    pub max_members_per_session: u64,
    pub allow_member_analysis: bool,
    pub allow_full_configuration: bool,
    pub presets: String,
}

impl AgentSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_id.trim() != self.profile_id
            || self.profile_id.chars().any(char::is_control)
            || !matches!(
                self.reasoning_effort.as_str(),
                "" | "low" | "medium" | "high" | "xhigh" | "max"
            )
            || [
                self.max_concurrent,
                self.max_calls_per_run,
                self.max_members_per_session,
            ]
            .iter()
            .any(|value| *value == 0 || *value > 9_007_199_254_740_991)
            || !serde_json::from_str::<Value>(&self.presets).is_ok_and(|value| value.is_array())
        {
            return Err("subagent settings are invalid".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReply {
    pub schema_version: String,
    pub command_id: String,
    pub session_id: String,
    pub status: String,
    pub revision: u64,
    pub error: Option<ConversationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationError {
    pub code: String,
    pub message: String,
    pub diagnostics: Option<ErrorDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDiagnostics {
    pub source: String,
    pub phase: String,
    pub category: String,
    pub retryable: bool,
    pub causes: Vec<DiagnosticCause>,
    pub is_connect: Option<bool>,
    pub is_timeout: Option<bool>,
    pub is_body: Option<bool>,
    pub stop_reason: Option<String>,
    pub archive_path: Option<String>,
    pub provider_error: Option<ProviderErrorDetails>,
    #[serde(default)]
    pub secondary: Vec<DiagnosticSecondary>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderErrorDetails {
    pub code: Option<String>,
    pub r#type: Option<String>,
    pub retry_directive: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticCause {
    pub message: String,
    pub kind: Option<String>,
    pub os_code: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticSecondary {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptProjection {
    pub provider_request_id: String,
    pub provider_attempt_id: String,
    pub attempt: u8,
    pub purpose: String,
    pub phase: String,
    pub run_id: String,
    pub updated_at: String,
    pub error: Option<ConversationError>,
    pub retry_at: Option<String>,
    pub timing: Option<ProviderAttemptTiming>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptTiming {
    pub clock_domain: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<f64>,
    pub text_segments: Option<Vec<ProviderTextSegmentTiming>>,
    pub first_content_at: Option<String>,
    pub first_content_ms: Option<f64>,
    pub first_content_kind: Option<String>,
    pub first_text_at: Option<String>,
    pub first_text_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTextSegmentTiming {
    pub output_item_id: String,
    pub output_index: Option<u64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<f64>,
    pub characters: u64,
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTimingProjection {
    pub run_id: String,
    pub clock_domain: String,
    pub accepted_at: String,
    pub started_at: Option<String>,
    pub first_response_at: Option<String>,
    pub first_response_kind: Option<String>,
    pub first_response_ms: Option<f64>,
    pub first_text_at: Option<String>,
    pub first_text_ms: Option<f64>,
    pub settled_at: Option<String>,
    pub total_ms: Option<f64>,
    pub response_elapsed_ms: Option<f64>,
    pub coverage: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunFailureSnapshot {
    pub revision: u64,
    pub phase: String,
    pub error: ConversationError,
    pub provider_request_id: Option<String>,
    pub provider_attempt_ids: Vec<String>,
    pub last_message_id: Option<String>,
    pub tool_record_ids: Vec<String>,
    pub pending_call_ids: Vec<String>,
    pub queued_message_ids: Vec<String>,
    pub plan_ref: Option<PlanRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogProjection {
    pub revision: String,
    pub plugins: Vec<PluginCatalogItem>,
}

impl PluginCatalogProjection {
    pub fn validate(&self) -> Result<(), String> {
        if self.revision.is_empty() {
            return Err("plugin catalog revision is invalid".to_string());
        }
        let mut uris = HashSet::new();
        let mut activation_media_types = HashSet::new();
        if self.plugins.iter().any(|plugin| {
            !valid_plugin_uri(&plugin.uri)
                || plugin.display_name.trim().is_empty()
                || plugin.short_description.trim().is_empty()
                || plugin.activation_media_types.iter().any(|media_type| {
                    !valid_media_type(media_type)
                        || !activation_media_types.insert(media_type.as_str())
                })
                || !uris.insert(plugin.uri.as_str())
        }) {
            return Err("plugin catalog entries are invalid".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogItem {
    pub management: Option<Value>,
    pub source: String,
    pub category: String,
    pub contribution_kind: String,
    pub discovery: String,
    pub reference: Option<Value>,
    pub uri: String,
    pub display_name: String,
    pub short_description: String,
    pub icon_ref: Option<String>,
    pub activation_media_types: Vec<String>,
    pub enabled: bool,
    pub available: bool,
    pub error: Option<ConversationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSelectionInput {
    pub selection_id: String,
    pub uri: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProjection {
    #[serde(default)]
    pub recipe: Option<Value>,
    pub schema_version: String,
    pub session_id: String,
    pub revision: u64,
    pub display: SessionDisplayProjection,
    pub model_settings: Option<SessionModelSettings>,
    pub subagent_settings: Option<AgentSettings>,
    pub permission_overrides: Value,
    pub effective_permissions: Option<Value>,
    pub shell_authorizations: Vec<ShellAuthorizationProjection>,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub session_directory_indexes: Vec<WorkspaceBindingDisplay>,
    pub timeline: Vec<SessionTimelineItem>,
    pub messages: Vec<ProjectionMessage>,
    pub queued_inputs: Vec<QueuedInputProjection>,
    pub narratives: Vec<NarrativeProjection>,
    pub assistant_draft: Option<AssistantDraftProjection>,
    pub interactions: Vec<InteractionProjection>,
    pub pending_interaction: Option<InteractionProjection>,
    pub pending_approval: Option<ApprovalProjection>,
    pub pending_approvals: Option<Vec<ApprovalProjection>>,
    pub plans: Vec<PlanProjection>,
    pub active_plan_ref: Option<PlanRef>,
    pub pending_plan: Option<PendingPlanProjection>,
    pub todo_list: Option<TodoListProjection>,
    pub context_usage: Option<ContextUsageProjection>,
    pub context_compositions: Vec<ContextCompositionProjection>,
    pub token_usage: TokenUsageProjection,
    pub total_token_usage: TokenUsageProjection,
    pub token_usage_history: Vec<TokenUsageRoundProjection>,
    pub run: Option<RunProjection>,
    #[serde(default)]
    pub run_timings: Vec<RunTimingProjection>,
    pub activities: Vec<ActivityProjection>,
    #[serde(default)]
    pub file_change_rounds: Vec<FileChangeRound>,
    pub artifacts: Vec<ArtifactProjection>,
    pub deliverables: Vec<DeliverableProjection>,
    pub terminal_error: Option<ConversationError>,
    #[serde(default)]
    pub provider_attempts: Vec<ProviderAttemptProjection>,
    pub failure_snapshot: Option<RunFailureSnapshot>,
    pub agent_context: Option<AgentContext>,
    pub agent_tasks: Option<Vec<AgentTaskProjection>>,
    pub agent_children: Option<Vec<AgentChildProjection>>,
    pub pending_agent_decisions: Option<Vec<PendingAgentDecision>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingAgentDecision {
    pub agent_session_id: String,
    pub display_name: String,
    pub run_id: String,
    pub plan: Option<PlanRef>,
    pub interaction_ids: Vec<String>,
    pub approval: Option<PendingAgentApproval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingAgentApproval {
    pub approval_id: String,
    pub call_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCapabilities {
    pub messaging: AgentMessaging,
    pub continuation: bool,
    pub delegation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum AgentMessaging {
    Enabled(bool),
    Scope(AgentMessagingScope),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentMessagingScope {
    Parent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContext {
    pub capabilities: AgentCapabilities,
    pub configuration: Option<AgentConfiguration>,
    pub model: Option<AgentModelConfiguration>,
    pub owner_session_id: String,
    pub parent_session_id: String,
    pub parent_run_id: String,
    pub parent_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContributionSelection {
    pub id: String,
    pub parameters: Option<serde_json::Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfiguration {
    pub context: AgentContributionSelection,
    pub compaction: AgentContributionSelection,
    pub controls: AgentContributionSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelConfiguration {
    pub profile_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub thinking: Option<String>,
    pub parameters: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTaskDelivery {
    Wait,
    Async,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTaskOutcome {
    Completed,
    Failed,
    Cancelled,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTaskResult {
    pub outcome: AgentTaskOutcome,
    pub content: Option<String>,
    pub error: Option<ConversationError>,
    pub final_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTaskProjection {
    pub task_id: String,
    pub agent_session_id: String,
    pub capabilities: AgentCapabilities,
    pub display_name: String,
    pub text: String,
    pub delivery: AgentTaskDelivery,
    pub parent_run_id: String,
    pub child_run_id: Option<String>,
    pub status: AgentTaskStatus,
    pub result: Option<AgentTaskResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentChildProjection {
    pub agent_session_id: String,
    pub display_name: String,
    pub capabilities: AgentCapabilities,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInputProjection {
    pub interaction_id: Option<String>,
    pub guidance_references: Option<Vec<GuidanceReference>>,
    pub command_id: String,
    pub message_id: String,
    pub run_id: String,
    pub text: String,
    pub filesystem_references: Vec<FilesystemReference>,
    pub plugin_selections: Vec<PluginSelectionInput>,
    pub sequence: u64,
    pub created_at: String,
    pub status: String,
}

impl SessionProjection {
    pub fn file_changes_for_run(&self, run_id: &str) -> Vec<(&str, usize, &FileChangeProjection)> {
        self.file_change_rounds
            .iter()
            .filter(|round| round.run_id == run_id)
            .flat_map(|round| round.record_ids.iter())
            .flat_map(|record| {
                self.activities
                    .iter()
                    .filter_map(|activity| activity.tool.as_ref())
                    .filter(move |tool| tool.record_id.as_ref() == Some(record))
                    .flat_map(move |tool| {
                        tool.file_changes
                            .iter()
                            .enumerate()
                            .map(move |(index, change)| (record.as_str(), index, change))
                    })
            })
            .collect()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SESSION_PROJECTION_VERSION || self.session_id.is_empty() {
            return Err("shared Session projection identity is invalid".to_string());
        }
        if let Some(settings) = &self.subagent_settings {
            settings.validate()?;
        }
        if self.agent_context.as_ref().is_some_and(|context| {
            [
                &context.owner_session_id,
                &context.parent_session_id,
                &context.parent_run_id,
                &context.parent_call_id,
            ]
            .iter()
            .any(|id| id.is_empty())
        }) || self.agent_tasks.as_ref().is_some_and(|tasks| {
            tasks.iter().any(|task| {
                [&task.task_id, &task.agent_session_id, &task.parent_run_id]
                    .iter()
                    .any(|id| id.is_empty())
                    || task.display_name.trim().is_empty()
                    || task.text.trim().is_empty()
                    || task.child_run_id.as_ref().is_some_and(|id| id.is_empty())
                    || task
                        .result
                        .as_ref()
                        .and_then(|result| result.final_message_id.as_ref())
                        .is_some_and(|id| id.is_empty())
            })
        }) || self.agent_children.as_ref().is_some_and(|children| {
            children.iter().any(|child| {
                child.agent_session_id.is_empty() || child.display_name.trim().is_empty()
            })
        }) || self
            .pending_agent_decisions
            .iter()
            .flatten()
            .any(|decision| {
                decision.agent_session_id.is_empty()
                    || decision.display_name.trim().is_empty()
                    || decision.run_id.is_empty()
                    || decision.interaction_ids.iter().any(String::is_empty)
                    || decision
                        .plan
                        .as_ref()
                        .is_some_and(|plan| plan.plan_id.is_empty() || plan.revision == 0)
                    || decision.approval.as_ref().is_some_and(|approval| {
                        approval.approval_id.is_empty() || approval.call_id.is_empty()
                    })
                    || (decision.plan.is_none()
                        && decision.approval.is_none()
                        && decision.interaction_ids.is_empty())
            })
        {
            return Err("shared Agent projection is invalid".into());
        }
        if self.provider_attempts.iter().any(|attempt| {
            !(1..=5).contains(&attempt.attempt)
                || !matches!(
                    attempt.purpose.as_str(),
                    "agent" | "contextCompaction" | "approvalReview"
                )
                || !matches!(
                    attempt.phase.as_str(),
                    "started" | "completed" | "failed" | "retryWaiting"
                )
                || matches!(attempt.phase.as_str(), "failed" | "retryWaiting")
                    != attempt.error.is_some()
                || (attempt.phase == "retryWaiting") != attempt.retry_at.is_some()
                || attempt.timing.as_ref().is_some_and(|timing| {
                    timing.clock_domain.is_empty()
                        || timing.started_at.is_empty()
                        || invalid_durations(&[
                            timing.duration_ms,
                            timing.first_content_ms,
                            timing.first_text_ms,
                        ])
                        || timing
                            .first_content_kind
                            .as_deref()
                            .is_some_and(|kind| !matches!(kind, "text" | "tool" | "reasoning"))
                        || timing.text_segments.iter().flatten().any(|segment| {
                            segment.output_item_id.is_empty()
                                || segment.started_at.is_empty()
                                || invalid_durations(&[segment.duration_ms])
                                || segment.outcome.as_deref().is_some_and(|outcome| {
                                    !matches!(outcome, "completed" | "interrupted")
                                })
                        })
                })
        }) {
            return Err("shared Provider attempt projection is invalid".into());
        }
        if self.run_timings.iter().any(|timing| {
            timing.run_id.is_empty()
                || timing.clock_domain.is_empty()
                || timing.accepted_at.is_empty()
                || !matches!(timing.coverage.as_str(), "complete" | "partial")
                || timing
                    .first_response_kind
                    .as_deref()
                    .is_some_and(|kind| !matches!(kind, "text" | "tool"))
                || invalid_durations(&[
                    timing.first_response_ms,
                    timing.first_text_ms,
                    timing.total_ms,
                    timing.response_elapsed_ms,
                ])
        }) {
            return Err("shared run timing projection is invalid".into());
        }
        let mut workspace_ids = HashSet::new();
        if self.workspace_bindings.iter().any(|binding| {
            binding.workspace_id.is_empty()
                || binding.display_name.is_empty()
                || !workspace_ids.insert(binding.workspace_id.as_str())
        }) {
            return Err("shared Session projection workspace bindings are invalid".to_string());
        }
        let mut directory_index_ids = HashSet::new();
        if self.session_directory_indexes.iter().any(|binding| {
            binding.workspace_id.is_empty()
                || binding.display_name.is_empty()
                || !workspace_ids.contains(binding.workspace_id.as_str())
                || !directory_index_ids.insert(binding.workspace_id.as_str())
        }) {
            return Err("shared Session projection directory indexes are invalid".to_string());
        }
        if self.run.as_ref().is_some_and(|run| {
            let mut run_workspace_ids = HashSet::new();
            run.profile_id.is_empty()
                || run
                    .reasoning_effort
                    .as_deref()
                    .is_some_and(|effort| !is_reasoning_effort(effort))
                || run
                    .thinking
                    .as_deref()
                    .is_some_and(|thinking| !matches!(thinking, "enabled" | "disabled"))
                || !is_run_status(&run.status)
                || run.workspace_bindings.iter().any(|binding| {
                    binding.workspace_id.is_empty()
                        || binding.display_name.is_empty()
                        || !run_workspace_ids.insert(binding.workspace_id.as_str())
                })
        }) {
            return Err("shared Session projection has an invalid run status".to_string());
        }
        if self.model_settings.as_ref().is_some_and(|settings| {
            settings.profile_id.is_empty()
                || settings
                    .reasoning_effort_override
                    .as_deref()
                    .is_some_and(|effort| !is_reasoning_effort(effort))
        }) {
            return Err("shared Session projection has invalid model settings".to_string());
        }
        if self.run.as_ref().is_some_and(|run| {
            run.waiting_reason
                .as_deref()
                .is_some_and(|reason| !matches!(reason, "approval" | "userInput" | "plan"))
                || (run.waiting_reason.is_some() && run.status != "waiting")
        }) {
            return Err("shared Session projection has an invalid waiting reason".to_string());
        }
        if self.assistant_draft.as_ref().is_some_and(|draft| {
            draft.run_id.is_empty()
                || draft.turn_id.is_empty()
                || draft
                    .provider_attempt_id
                    .as_deref()
                    .is_some_and(str::is_empty)
                || draft.plan_preview.as_ref().is_some_and(|preview| {
                    preview.provider_call_id.is_empty()
                        || preview.title.encode_utf16().count() > 256
                        || preview.summary.encode_utf16().count() > 4096
                        || preview.steps.len() > 12
                        || preview
                            .steps
                            .iter()
                            .any(|title| title.encode_utf16().count() > 256)
                })
                || draft.activity.as_ref().is_some_and(|activity| {
                    !matches!(
                        activity.purpose.as_str(),
                        "agent" | "contextCompaction" | "approvalReview"
                    ) || !matches!(
                        activity.phase.as_str(),
                        "waitingResponse" | "reasoning" | "awaitingOutput" | "generatingOutput"
                    ) || activity.started_at.is_empty()
                        || activity
                            .last_content_at
                            .as_deref()
                            .is_some_and(str::is_empty)
                })
                || self
                    .run
                    .as_ref()
                    .is_none_or(|run| run.run_id != draft.run_id)
                || {
                    let mut stream_ids = HashSet::new();
                    draft.blocks.iter().enumerate().any(|(index, block)| {
                        block.invalid()
                            || block
                                .text()
                                .is_some_and(|(stream_id, _)| !stream_ids.insert(stream_id))
                            || block.output_index().is_none() && draft.blocks.len() != 1
                            || index > 0
                                && block.output_index() <= draft.blocks[index - 1].output_index()
                    })
                }
        }) {
            return Err("shared Session projection has an invalid assistant draft".to_string());
        }
        if self.messages.iter().any(|message| {
            message.message_id.is_empty()
                || !matches!(
                    message.role.as_str(),
                    "user" | "assistant" | "tool" | "system"
                )
                || message.sequence == 0
                || message.sequence > self.revision
                || message
                    .feedback
                    .as_deref()
                    .is_some_and(|feedback| !matches!(feedback, "up" | "down"))
                || message.feedback.is_some() && message.role != "assistant"
                || message.reply_to_interaction.as_ref().is_some_and(|reply| {
                    message.role != "user"
                        || reply.interaction_id.is_empty()
                        || reply.prompt.trim().is_empty()
                })
                || message.run_id.as_deref().is_some_and(str::is_empty)
                || message
                    .provider_request_id
                    .as_deref()
                    .is_some_and(str::is_empty)
                || if message.role == "assistant" {
                    message.run_id.is_none() || message.provider_request_id.is_none()
                } else {
                    message.provider_request_id.is_some()
                }
                || invalid_filesystem_references(&message.filesystem_references)
                || message.plugin_selections.iter().any(|selection| {
                    selection.selection_id.is_empty()
                        || !valid_plugin_uri(&selection.uri)
                        || selection.label.trim().is_empty()
                })
        }) {
            return Err("shared Session projection has invalid messages".to_string());
        }
        if self.queued_inputs.iter().any(|input| {
            input.command_id.is_empty()
                || input.message_id.is_empty()
                || input.run_id.is_empty()
                || input.sequence == 0
                || input.sequence > self.revision
                || input.created_at.is_empty()
                || !matches!(input.status.as_str(), "queued" | "notApplied")
                || invalid_filesystem_references(&input.filesystem_references)
                || input.plugin_selections.iter().any(|selection| {
                    selection.selection_id.is_empty()
                        || !valid_plugin_uri(&selection.uri)
                        || selection.label.trim().is_empty()
                })
        }) {
            return Err("shared Session projection has invalid queued inputs".to_string());
        }
        if self.narratives.iter().any(|narrative| {
            narrative.narrative_id.is_empty()
                || narrative.run_id.is_empty()
                || narrative.provider_request_id.is_empty()
                || narrative.sequence == 0
                || narrative.sequence > self.revision
                || narrative.created_at.is_empty()
        }) {
            return Err("shared Session projection has invalid narratives".to_string());
        }
        if self
            .interactions
            .iter()
            .chain(self.pending_interaction.iter())
            .any(|interaction| {
                !matches!(interaction.kind.as_str(), "question" | "confirmation")
                    || !matches!(
                        interaction.status.as_str(),
                        "pending" | "answered" | "closed"
                    )
                    || interaction
                        .mode
                        .as_deref()
                        .is_some_and(|mode| !matches!(mode, "wait" | "continue"))
                    || interaction.interaction_id.is_empty()
                    || interaction.run_id.is_empty()
                    || interaction.call_id.is_empty()
            })
        {
            return Err("shared Session projection has an invalid interaction".to_string());
        }
        if self
            .pending_approval
            .iter()
            .chain(self.pending_approvals.iter().flatten())
            .any(|approval| {
                approval.approval_id.is_empty()
                    || approval.call_id.is_empty()
                    || approval.run_id.is_empty()
                    || approval.preview.summary.is_empty()
                    || approval
                        .preview
                        .authorization_scope
                        .as_deref()
                        .is_some_and(|scope| {
                            scope != "sessionBrowser"
                                && !AUTHORIZATION_OPTIONS
                                    .iter()
                                    .any(|(candidate, _)| *candidate == scope)
                        })
            })
        {
            return Err("shared Session projection has an invalid approval".to_string());
        }
        let mut plan_revisions = HashSet::new();
        if self.plans.iter().any(|plan| {
            !valid_plan_projection(plan)
                || !plan_revisions.insert((plan.plan_id.as_str(), plan.revision))
        }) {
            return Err("shared Session projection has an invalid plan".to_string());
        }
        if self.active_plan_ref.as_ref().is_some_and(|active| {
            active.plan_id.is_empty()
                || active.revision == 0
                || self.plans.iter().all(|plan| {
                    plan.plan_id != active.plan_id
                        || plan.revision != active.revision
                        || plan.status != "confirmed"
                })
        }) {
            return Err("shared Session projection has an invalid active plan".to_string());
        }
        if self.pending_plan.as_ref().is_some_and(|plan| {
            !valid_pending_plan_projection(plan)
                || self.plans.iter().all(|published| {
                    published.plan_id != plan.plan_id
                        || published.revision != plan.revision
                        || published.status != "published"
                })
        }) {
            return Err("shared Session projection has an invalid pending plan".to_string());
        }
        if self.todo_list.as_ref().is_some_and(|todo_list| {
            todo_list.run_id.is_empty()
                || todo_list.revision == 0
                || todo_list.sequence == 0
                || todo_list.sequence > self.revision
                || todo_list.updated_at.is_empty()
                || todo_list.items.iter().any(|item| {
                    item.text.trim().is_empty()
                        || !matches!(
                            item.status.as_str(),
                            "pending" | "inProgress" | "completed" | "blocked"
                        )
                })
        }) {
            return Err("shared Session projection has an invalid todo list".to_string());
        }
        if self.context_usage.as_ref().is_some_and(|usage| {
            usage.provider_request_id.is_empty()
                || usage.provider_runtime_ref.is_empty()
                || usage.run_id.is_empty()
                || usage.sequence == 0
                || usage.sequence > self.revision
                || usage.updated_at.is_empty()
                || usage.context_window_tokens == 0
                || usage
                    .input_tokens
                    .checked_add(usage.output_tokens)
                    .is_none_or(|total| total > usage.context_window_tokens)
                || usage.cache_read_input_tokens.is_some()
                    != usage.cache_miss_input_tokens.is_some()
                || usage
                    .cache_read_input_tokens
                    .zip(usage.cache_miss_input_tokens)
                    .is_some_and(|(read, miss)| {
                        read.checked_add(miss)
                            .is_none_or(|sum| sum != usage.input_tokens)
                    })
        }) {
            return Err("shared Session projection has invalid context usage".to_string());
        }
        let mut provider_request_ids = HashSet::new();
        if self.context_compositions.iter().any(|receipt| {
            receipt.provider_request_id.is_empty()
                || receipt.run_id.is_empty()
                || !matches!(
                    receipt.purpose.as_str(),
                    "agent" | "contextCompaction" | "approvalReview"
                )
                || receipt.sequence == 0
                || receipt.sequence > self.revision
                || receipt.created_at.is_empty()
                || !provider_request_ids.insert(receipt.provider_request_id.as_str())
                || !matches!(
                    receipt.response_constraint.as_str(),
                    "normal" | "answerOnly"
                )
                || invalid_context_composition_shape(receipt)
        }) || self
            .context_compositions
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
        {
            return Err(
                "shared Session projection has invalid context composition receipts".to_string(),
            );
        }
        if self.context_usage.as_ref().is_some_and(|usage| {
            !self.context_compositions.iter().any(|receipt| {
                receipt.provider_request_id == usage.provider_request_id
                    && receipt.run_id == usage.run_id
                    && receipt.sequence < usage.sequence
            })
        }) {
            return Err(
                "shared Session projection context usage has no exact request receipt".to_string(),
            );
        }
        if [&self.token_usage, &self.total_token_usage]
            .iter()
            .any(|usage| {
                !valid_token_usage_fields(
                    usage.provider_call_count,
                    usage.reported_call_count,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_input_tokens,
                    usage.cache_miss_input_tokens,
                    usage.cache_available,
                    usage.cache_complete,
                    usage.cache_hit_ratio,
                )
            })
        {
            return Err("shared Session projection has invalid cumulative token usage".to_string());
        }
        let mut usage_run_ids = HashSet::new();
        if self.token_usage_history.iter().any(|round| {
            round.run_id.is_empty()
                || round.input_message_id.is_empty()
                || round.title.is_empty()
                || round.sequence == 0
                || round.sequence > self.revision
                || round.started_at.is_empty()
                || !usage_run_ids.insert(round.run_id.as_str())
                || round.completed_at.is_some() != round.outcome.is_some()
                || round.outcome.as_deref().is_some_and(|outcome| {
                    !matches!(
                        outcome,
                        "completed" | "failed" | "cancelled" | "indeterminate"
                    )
                })
                || !valid_token_usage_fields(
                    round.provider_call_count,
                    round.reported_call_count,
                    round.input_tokens,
                    round.output_tokens,
                    round.cache_read_input_tokens,
                    round.cache_miss_input_tokens,
                    round.cache_available,
                    round.cache_complete,
                    round.cache_hit_ratio,
                )
        }) || self
            .token_usage_history
            .windows(2)
            .any(|pair| pair[0].sequence < pair[1].sequence)
        {
            return Err("shared Session projection has invalid per-run token usage".to_string());
        }
        let mut activity_ids = HashSet::new();
        if self.activities.iter().any(|activity| {
            activity.activity_id.is_empty()
                || activity.label.is_empty()
                || activity.run_id.is_empty()
                || activity.sequence == 0
                || activity.sequence > self.revision
                || !activity_ids.insert(activity.activity_id.as_str())
                || !matches!(
                    activity.kind.as_str(),
                    "run"
                        | "tool"
                        | "providerHosted"
                        | "approval"
                        | "interaction"
                        | "agent"
                        | "plan"
                )
                || (activity.kind == "agent") != activity.agent.is_some()
                || activity.agent.as_ref().is_some_and(|agent| {
                    if agent.phase == "updated" {
                        agent.task_id.is_some()
                            || self
                                .agent_children
                                .iter()
                                .flatten()
                                .all(|child| child.agent_session_id != agent.agent_session_id)
                    } else {
                        !matches!(agent.phase.as_str(), "started" | "completed")
                            || self.agent_tasks.iter().flatten().all(|task| {
                                Some(&task.task_id) != agent.task_id.as_ref()
                                    || task.agent_session_id != agent.agent_session_id
                                    || task.parent_run_id != activity.run_id
                            })
                    }
                })
                || !matches!(
                    activity.status.as_str(),
                    "active"
                        | "requested"
                        | "waiting"
                        | "completed"
                        | "denied"
                        | "rejected"
                        | "failed"
                        | "cancelled"
                        | "indeterminate"
                )
                || activity.kind == "tool" && activity.call_id.as_deref().is_none_or(str::is_empty)
                || activity.started_at.as_ref().is_some_and(|started| {
                    activity.kind != "tool"
                        || started.is_empty()
                        || !started.bytes().all(|byte| byte.is_ascii_digit())
                        || started.parse::<u64>().is_err()
                })
                || activity.live_output.is_some()
                    && (activity.kind != "tool"
                        || activity.status != "active"
                        || activity.started_at.is_none())
                || activity.kind != "tool" && activity.tool.is_some()
                || (activity.kind == "tool"
                    && activity.status == "rejected"
                    && activity.not_executed.is_none())
                    != activity.input_rejection.is_some()
                || activity.status == "rejected" && activity.tool.is_some()
                || activity.not_executed.as_ref().is_some_and(|disposition| {
                    activity.kind != "tool"
                        || activity.tool.is_some()
                        || activity.started_at.is_some()
                        || activity.input_rejection.is_some()
                        || activity.interruption.is_some()
                        || match disposition.reason.as_str() {
                            "cancelled" => {
                                activity.status != "cancelled"
                                    || disposition.predecessor_call_id.is_some()
                            }
                            "approvalRequired" => {
                                activity.status != "rejected"
                                    || disposition.predecessor_call_id.is_some()
                            }
                            "dependencyFailed" | "dependencyPending" => {
                                activity.status != "rejected"
                                    || disposition
                                        .predecessor_call_id
                                        .as_deref()
                                        .is_none_or(str::is_empty)
                            }
                            _ => true,
                        }
                })
                || activity.interruption.as_ref().is_some_and(|error| {
                    activity.kind != "tool"
                        || activity.status != "indeterminate"
                        || activity.tool.is_some()
                        || error.code.is_empty()
                        || error.message.is_empty()
                })
                || activity.input_rejection.as_ref().is_some_and(|error| {
                    error.code.is_empty()
                        || error.message.is_empty()
                        || error.issues.is_empty()
                        || error.issues.iter().any(|issue| {
                            issue.path.is_empty()
                                || issue.rule.is_empty()
                                || issue.message.is_empty()
                        })
                })
                || activity.kind != "providerHosted" && activity.provider_hosted.is_some()
                || activity.kind == "providerHosted"
                    && activity.provider_hosted.as_ref().is_none_or(|hosted| {
                        hosted.provider_tool_type != "web_search"
                            || hosted.provider_call_id.is_empty()
                    })
                || activity.tool.as_ref().is_some_and(|tool| {
                    tool.operation.is_empty()
                        || tool
                            .error
                            .as_ref()
                            .is_some_and(|error| error.code.is_empty() || error.message.is_empty())
                        || tool
                            .projection_error
                            .as_ref()
                            .is_some_and(|error| error.code.is_empty() || error.message.is_empty())
                        || tool.shell.as_ref().is_some_and(|shell| {
                            !matches!(tool.operation.as_str(), "bash" | "powershell")
                                || shell.command.trim().is_empty()
                                || !is_normalized_logical_path(&shell.cwd)
                                || !matches!(shell.execution_scope.as_str(), "workspace" | "host")
                                || shell.result.as_ref().is_some_and(|result| {
                                    !valid_shell_execution_environment(&result.environment)
                                        || result.environment.execution_scope
                                            != shell.execution_scope
                                        || result.environment.terminal != shell.terminal
                                        || result.success
                                            && (result.timed_out || result.exit_code != Some(0))
                                })
                        })
                        || tool.process.as_ref().is_some_and(|process| {
                            process.job_id.is_empty()
                                || process.command.is_empty()
                                || tool.shell.is_some()
                        })
                        || tool.process.is_none()
                            && matches!(tool.operation.as_str(), "bash" | "powershell")
                            && (tool.shell.is_none() && tool.projection_error.is_none()
                                || tool.shell.as_ref().is_some_and(|shell| {
                                    match activity.status.as_str() {
                                        "completed" => shell.result.is_none(),
                                        "failed" | "indeterminate" => false,
                                        _ => shell.result.is_some(),
                                    }
                                }))
                        || tool.resources.iter().any(|resource| {
                            resource.label.is_empty()
                                || match resource.kind.as_str() {
                                    "workspacePath" => {
                                        resource
                                            .workspace_id
                                            .as_deref()
                                            .is_none_or(|workspace_id| workspace_id.is_empty())
                                            || resource.logical_path.as_deref().is_none_or(|path| {
                                                !is_normalized_logical_path(path)
                                            })
                                            || resource.uri.is_some()
                                    }
                                    "url" => {
                                        resource.workspace_id.is_some()
                                            || resource.logical_path.is_some()
                                            || resource.uri.as_deref().is_none_or(|uri| {
                                                !uri.starts_with("http://")
                                                    && !uri.starts_with("https://")
                                            })
                                    }
                                    "logicalTarget" => {
                                        resource.workspace_id.is_some()
                                            || resource.logical_path.is_some()
                                            || resource.uri.is_some()
                                    }
                                    _ => true,
                                }
                        })
                })
        }) {
            return Err("shared Session projection has invalid canonical activities".to_string());
        }
        let mut timeline_ids = HashSet::new();
        let mut timeline_message_ids = HashSet::new();
        let mut timeline_narrative_ids = HashSet::new();
        let mut timeline_plan_refs = HashSet::new();
        let mut timeline_activity_ids = HashSet::new();
        if self.timeline.iter().any(|item| {
            if item.timeline_id().is_empty()
                || item.sequence() == 0
                || item.sequence() > self.revision
                || !timeline_ids.insert(item.timeline_id())
            {
                return true;
            }
            match item {
                SessionTimelineItem::Message {
                    message_id,
                    stream_id,
                    ..
                } => {
                    !timeline_message_ids.insert(message_id.as_str())
                        || self.messages.iter().all(|message| {
                            message.message_id != *message_id
                                || !matches!(message.role.as_str(), "user" | "assistant")
                                || if message.role == "assistant" {
                                    stream_id.as_deref().is_none_or(str::is_empty)
                                } else {
                                    stream_id.is_some()
                                }
                        })
                }
                SessionTimelineItem::Narrative {
                    provider_request_id,
                    narrative_id,
                    stream_id,
                    ..
                } => {
                    provider_request_id.is_empty()
                        || stream_id.is_empty()
                        || !timeline_narrative_ids.insert(narrative_id.as_str())
                        || self.narratives.iter().all(|narrative| {
                            narrative.narrative_id != *narrative_id
                                || narrative.provider_request_id != *provider_request_id
                        })
                }
                SessionTimelineItem::Plan {
                    provider_request_id,
                    plan_id,
                    revision,
                    ..
                } => {
                    provider_request_id.is_empty()
                        || !timeline_plan_refs.insert((plan_id.as_str(), *revision))
                        || self
                            .plans
                            .iter()
                            .all(|plan| plan.plan_id != *plan_id || plan.revision != *revision)
                }
                SessionTimelineItem::ToolGroup {
                    provider_request_id,
                    activity_ids,
                    ..
                } => {
                    provider_request_id.as_deref().is_some_and(str::is_empty)
                        || (provider_request_id.is_none()
                            && activity_ids.iter().any(|id| {
                                !self.activities.iter().any(|activity| {
                                    activity.activity_id == *id && activity.kind == "agent"
                                })
                            }))
                        || activity_ids.is_empty()
                        || activity_ids.iter().any(|activity_id| {
                            !timeline_activity_ids.insert(activity_id.as_str())
                                || self.activities.iter().all(|activity| {
                                    activity.activity_id != *activity_id
                                        || !matches!(
                                            activity.kind.as_str(),
                                            "tool"
                                                | "providerHosted"
                                                | "approval"
                                                | "interaction"
                                                | "agent"
                                        )
                                })
                        })
                }
            }
        }) {
            return Err("shared Session projection has an invalid canonical timeline".to_string());
        }
        if timeline_message_ids.len()
            != self
                .messages
                .iter()
                .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
                .count()
            || timeline_narrative_ids.len() != self.narratives.len()
            || timeline_plan_refs.len() != self.plans.len()
            || timeline_activity_ids.len()
                != self
                    .activities
                    .iter()
                    .filter(|activity| {
                        matches!(
                            activity.kind.as_str(),
                            "tool" | "providerHosted" | "approval" | "interaction" | "agent"
                        )
                    })
                    .count()
        {
            return Err("shared Session projection canonical timeline is incomplete".to_string());
        }
        Ok(())
    }

    pub fn last_assistant_message(&self, after_message_count: usize) -> Option<&ProjectionMessage> {
        self.timeline.iter().rev().find_map(|item| match item {
            SessionTimelineItem::Message { message_id, .. } => self
                .messages
                .iter()
                .skip(after_message_count)
                .find(|message| message.role == "assistant" && message.message_id == *message_id),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionTimelineItem {
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "streamId")]
        stream_id: Option<String>,
        #[serde(rename = "outputIndex")]
        output_index: Option<u64>,
    },
    #[serde(rename = "narrative")]
    Narrative {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
        #[serde(rename = "narrativeId")]
        narrative_id: String,
        #[serde(rename = "streamId")]
        stream_id: String,
        #[serde(rename = "outputIndex")]
        output_index: Option<u64>,
    },
    #[serde(rename = "plan")]
    Plan {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        revision: u64,
    },
    #[serde(rename = "toolGroup")]
    ToolGroup {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: Option<String>,
        #[serde(rename = "activityIds")]
        activity_ids: Vec<String>,
    },
}

impl SessionTimelineItem {
    pub fn timeline_id(&self) -> &str {
        match self {
            Self::Message { timeline_id, .. }
            | Self::Narrative { timeline_id, .. }
            | Self::Plan { timeline_id, .. }
            | Self::ToolGroup { timeline_id, .. } => timeline_id,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::Message { sequence, .. }
            | Self::Narrative { sequence, .. }
            | Self::Plan { sequence, .. }
            | Self::ToolGroup { sequence, .. } => *sequence,
        }
    }
}

fn invalid_context_composition_shape(receipt: &ContextCompositionProjection) -> bool {
    invalid_context_messages(&receipt.messages)
        || invalid_context_items(&receipt.workspace_bindings)
        || invalid_context_tools(&receipt.tools)
        || invalid_context_partitions(&receipt.partitions)
}

fn invalid_context_partitions(partitions: &[ContextCompositionPartitionProjection]) -> bool {
    const ORDER: [&str; 7] = [
        "instructions",
        "sessionControls",
        "tools",
        "workspaceBindings",
        "contextProviders",
        "journalMessages",
        "filesystemReferences",
    ];
    if partitions.len() != ORDER.len()
        || partitions
            .iter()
            .zip(ORDER)
            .any(|(partition, kind)| partition.kind != kind)
        || partitions
            .iter()
            .all(|partition| partition.request_shape_units == 0)
    {
        return true;
    }
    let has_estimates = partitions[0].estimated_input_tokens.is_some();
    partitions.iter().any(|partition| {
        partition.estimated_input_tokens.is_some() != has_estimates
            || partition.token_source.is_some() != has_estimates
            || partition
                .token_source
                .as_deref()
                .is_some_and(|source| source != "sessionEstimated")
    })
}

fn invalid_context_messages(messages: &[ContextCompositionMessage]) -> bool {
    let mut contribution_ids = HashSet::new();
    let mut call_ids = HashSet::new();
    for (message_index, message) in messages.iter().enumerate() {
        if message.message_index != message_index as u64
            || message.contribution_id.is_empty()
            || !contribution_ids.insert(message.contribution_id.as_str())
            || !matches!(
                message.contribution_kind.as_str(),
                "instructions"
                    | "workspaceBindings"
                    | "sessionControls"
                    | "journalMessages"
                    | "contextProviders"
            )
            || message.label.is_empty()
            || !matches!(
                message.role.as_str(),
                "system" | "user" | "assistant" | "tool"
            )
            || invalid_context_items(&message.filesystem_references)
            || message.role != "user" && !message.filesystem_references.is_empty()
        {
            return true;
        }
        let mut result_count = 0usize;
        for (block_index, block) in message.blocks.iter().enumerate() {
            let invalid = match block {
                ContextCompositionMessageBlock::Text {
                    block_index: actual,
                } => *actual != block_index as u64 || message.role == "tool",
                ContextCompositionMessageBlock::Reasoning {
                    block_index: actual,
                } => *actual != block_index as u64 || message.role != "assistant",
                ContextCompositionMessageBlock::ToolCall {
                    block_index: actual,
                    call_id,
                    tool_name,
                } => {
                    *actual != block_index as u64
                        || message.role != "assistant"
                        || call_id.is_empty()
                        || tool_name.is_empty()
                        || !call_ids.insert(call_id.as_str())
                }
                ContextCompositionMessageBlock::ToolResult {
                    block_index: actual,
                    result_for_call_id,
                } => {
                    result_count += 1;
                    *actual != block_index as u64
                        || message.role != "tool"
                        || result_for_call_id.is_empty()
                        || !call_ids.contains(result_for_call_id.as_str())
                }
                ContextCompositionMessageBlock::HostedWebSearch {
                    block_index: actual,
                    provider_call_id,
                } => {
                    *actual != block_index as u64
                        || message.role != "assistant"
                        || provider_call_id.is_empty()
                }
            };
            if invalid {
                return true;
            }
        }
        if message.role == "tool" && (message.blocks.len() != 1 || result_count != 1) {
            return true;
        }
    }
    false
}

fn invalid_context_items(items: &[ContextCompositionItem]) -> bool {
    let mut item_ids = HashSet::new();
    items.iter().any(|item| {
        item.item_id.is_empty() || item.label.is_empty() || !item_ids.insert(item.item_id.as_str())
    })
}

pub(crate) fn invalid_filesystem_references(references: &[FilesystemReference]) -> bool {
    if references.len() > 8 {
        return true;
    }
    let mut reference_ids = HashSet::new();
    let mut targets = HashSet::new();
    references.iter().any(|reference| {
        reference.reference_id.is_empty()
            || reference.workspace_id.is_empty()
            || reference.display_name.is_empty()
            || !valid_logical_path(&reference.logical_path)
            || !reference_ids.insert(reference.reference_id.as_str())
            || !targets.insert((
                reference.workspace_id.as_str(),
                reference.logical_path.as_str(),
            ))
            || match reference.kind.as_str() {
                "directory" => {
                    reference.logical_path != "."
                        || reference.media_type.is_some()
                        || reference.byte_length.is_some()
                        || reference.source.is_some()
                }
                "file" => {
                    reference.logical_path == "."
                        || reference
                            .media_type
                            .as_deref()
                            .is_none_or(|media_type| !valid_media_type(media_type))
                        || reference.byte_length.is_none()
                        || reference
                            .source
                            .as_deref()
                            .is_some_and(|source| source != "pastedText")
                }
                _ => true,
            }
    })
}

fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    value == "."
        || !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn invalid_context_tools(tools: &[ContextCompositionTool]) -> bool {
    let mut item_ids = HashSet::new();
    let mut canonical_names = HashSet::new();
    let mut wire_names = HashSet::new();
    tools.iter().any(|tool| {
        tool.item_id.is_empty()
            || tool.label.is_empty()
            || tool.canonical_name.is_empty()
            || tool.wire_name.is_empty()
            || tool.item_id != tool.canonical_name
            || tool.label != tool.wire_name
            || !item_ids.insert(tool.item_id.as_str())
            || !canonical_names.insert(tool.canonical_name.as_str())
            || !wire_names.insert(tool.wire_name.as_str())
            || !matches!(
                tool.origin.as_str(),
                "coreBuiltin" | "extension" | "sessionControl" | "providerHosted"
            )
            || tool.availability != "callable"
            || if tool.origin == "extension" {
                tool.plugin_uri
                    .as_deref()
                    .is_none_or(|uri| !valid_plugin_uri(uri))
            } else {
                tool.plugin_uri.is_some()
            }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDisplayProjection {
    pub creation_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBindingDisplay {
    pub workspace_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionMessage {
    pub guidance_references: Option<Vec<GuidanceReference>>,
    pub message_id: String,
    pub run_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub role: String,
    pub content: String,
    pub display_content: Option<String>,
    pub source_references: Option<SourceReferences>,
    pub filesystem_references: Vec<FilesystemReference>,
    pub plugin_selections: Vec<PluginSelectionInput>,
    pub feedback: Option<String>,
    pub sequence: u64,
    pub created_at: String,
    pub reply_to_interaction: Option<InteractionReplyContext>,
}

impl ProjectionMessage {
    pub fn display_text(&self) -> &str {
        self.display_content.as_deref().unwrap_or(&self.content)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionReplyContext {
    pub interaction_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuidanceReference {
    pub reference_id: String,
    pub uri: String,
    pub label: String,
    pub tool_name: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemReference {
    pub reference_id: String,
    pub workspace_id: String,
    pub logical_path: String,
    pub display_name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl<'de> Deserialize<'de> for FilesystemReference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        enum WireReference {
            File {
                reference_id: String,
                workspace_id: String,
                logical_path: String,
                display_name: String,
                media_type: String,
                byte_length: u64,
                source: Option<String>,
            },
            Directory {
                reference_id: String,
                workspace_id: String,
                logical_path: String,
                display_name: String,
            },
        }

        Ok(match WireReference::deserialize(deserializer)? {
            WireReference::File {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                media_type,
                byte_length,
                source,
            } => Self {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                kind: "file".to_string(),
                media_type: Some(media_type),
                byte_length: Some(byte_length),
                source,
            },
            WireReference::Directory {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
            } => Self {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                kind: "directory".to_string(),
                media_type: None,
                byte_length: None,
                source: None,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjection {
    pub narrative_id: String,
    pub run_id: String,
    pub provider_request_id: String,
    pub content: String,
    pub display_content: Option<String>,
    pub source_references: Option<SourceReferences>,
    pub sequence: u64,
    pub created_at: String,
}

impl NarrativeProjection {
    pub fn display_text(&self) -> &str {
        self.display_content.as_deref().unwrap_or(&self.content)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReferences {
    pub citations: Vec<SourceCitation>,
    pub unresolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCitation {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDraftProjection {
    pub run_id: String,
    pub turn_id: String,
    pub provider_attempt_id: Option<String>,
    pub blocks: Vec<AssistantDraftBlockProjection>,
    pub activity: Option<ProviderActivityProjection>,
    pub plan_preview: Option<PlanPreviewProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanPreviewProjection {
    pub call_index: u64,
    pub provider_call_id: String,
    pub output_index: Option<u64>,
    pub title: String,
    pub summary: String,
    pub steps: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderActivityProjection {
    pub purpose: String,
    pub phase: String,
    pub started_at: String,
    pub last_content_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelSettings {
    pub profile_id: String,
    pub reasoning_effort_override: Option<String>,
}

fn is_reasoning_effort(value: &str) -> bool {
    matches!(value, "low" | "medium" | "high" | "xhigh" | "max")
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssistantDraftBlockProjection {
    #[serde(rename = "narrative")]
    Narrative {
        #[serde(rename = "outputIndex")]
        output_index: Option<u64>,
        #[serde(rename = "streamId")]
        stream_id: String,
        content: String,
        #[serde(rename = "displayContent")]
        display_content: Option<String>,
    },
    #[serde(rename = "finalMessage")]
    FinalMessage {
        #[serde(rename = "outputIndex")]
        output_index: Option<u64>,
        #[serde(rename = "streamId")]
        stream_id: String,
        content: String,
        #[serde(rename = "displayContent")]
        display_content: Option<String>,
    },
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "outputIndex")]
        output_index: Option<u64>,
        #[serde(rename = "streamId")]
        stream_id: String,
        content: String,
        #[serde(rename = "displayContent")]
        display_content: Option<String>,
    },
    #[serde(rename = "providerHosted")]
    ProviderHosted {
        #[serde(rename = "outputIndex")]
        output_index: u64,
        #[serde(rename = "providerCallId")]
        provider_call_id: String,
        #[serde(rename = "providerToolType")]
        provider_tool_type: String,
        status: String,
        #[serde(default, deserialize_with = "deserialize_hosted_search_action")]
        action: Option<serde_json::Map<String, Value>>,
    },
}

impl AssistantDraftBlockProjection {
    fn output_index(&self) -> Option<u64> {
        match self {
            Self::Narrative { output_index, .. }
            | Self::FinalMessage { output_index, .. }
            | Self::Message { output_index, .. } => *output_index,
            Self::ProviderHosted { output_index, .. } => Some(*output_index),
        }
    }

    pub fn text(&self) -> Option<(&str, &str)> {
        match self {
            Self::Narrative {
                stream_id,
                content,
                display_content,
                ..
            }
            | Self::FinalMessage {
                stream_id,
                content,
                display_content,
                ..
            }
            | Self::Message {
                stream_id,
                content,
                display_content,
                ..
            } => Some((stream_id, display_content.as_deref().unwrap_or(content))),
            Self::ProviderHosted { .. } => None,
        }
    }

    fn invalid(&self) -> bool {
        match self {
            Self::Narrative {
                stream_id, content, ..
            }
            | Self::FinalMessage {
                stream_id, content, ..
            }
            | Self::Message {
                stream_id, content, ..
            } => stream_id.is_empty() || content.is_empty(),
            Self::ProviderHosted {
                provider_call_id,
                provider_tool_type,
                status,
                ..
            } => {
                provider_call_id.is_empty()
                    || provider_tool_type != "web_search"
                    || !matches!(status.as_str(), "completed" | "failed")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionProjection {
    pub mode: Option<String>,
    pub status: String,
    pub response: Option<String>,
    pub interaction_id: String,
    pub run_id: String,
    pub call_id: String,
    pub kind: String,
    pub prompt: String,
    pub options: Option<Vec<InteractionOption>>,
    pub allow_freeform: bool,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectOperation {
    pub tool_name: String,
    pub arguments: serde_json::Map<String, Value>,
    pub workspace_root: Option<String>,
    pub execution_scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPreview {
    pub operation: Option<EffectOperation>,
    pub summary: String,
    pub effects: Vec<String>,
    pub logical_targets: Vec<String>,
    pub authorization_scope: Option<String>,
    pub authorization_context: Option<Value>,
    pub authorization_scopes: Option<Vec<String>>,
    pub file_access: Option<Value>,
    pub approval_reviewer: Option<String>,
    pub review: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellAuthorizationProjection {
    pub authority_id: String,
    pub run_id: String,
    pub scope: String,
    pub summary: String,
    pub context: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProjection {
    pub approval_id: String,
    pub run_id: String,
    pub call_id: String,
    pub preview: EffectPreview,
    pub sequence: u64,
    pub created_at: String,
}

impl ApprovalProjection {
    pub fn is_model_reviewing(&self, run: Option<&RunProjection>) -> bool {
        self.preview.approval_reviewer.as_deref() == Some("agent")
            && run.is_some_and(|run| run.run_id == self.run_id && run.status == "running")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanOperation {
    pub workspace_id: String,
    pub operation: String,
    pub target: Option<String>,
    pub target_kind: Option<String>,
    pub command: Option<String>,
    pub terminal: Option<PlanTerminalInput>,
    pub writable_paths: Option<Vec<PlanWritePath>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanWritePath {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTerminalInput {
    pub stdin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPlanStep {
    pub step_id: String,
    pub title: String,
    pub details: String,
    pub verification: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanProjection {
    pub review: Option<PlanReviewProjection>,
    #[serde(default)]
    pub workspace_requests: Vec<PlanWorkspaceRequest>,
    pub plan_id: String,
    pub revision: u64,
    pub run_id: String,
    pub call_id: String,
    pub title: String,
    pub summary: String,
    pub steps: Vec<ExecutionPlanStep>,
    pub mutation_manifest: Vec<PlanOperation>,
    pub status: String,
    pub decision_id: Option<String>,
    pub confirmation_source: Option<String>,
    pub sequence: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRef {
    pub plan_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanWorkspaceRequest {
    pub workspace_id: String,
    pub root_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanReviewProjection {
    pub provider_request_id: String,
    pub status: String,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub error: Option<ConversationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPlanProjection {
    pub review: Option<PlanReviewProjection>,
    #[serde(default)]
    pub workspace_requests: Vec<PlanWorkspaceRequest>,
    pub plan_id: String,
    pub revision: u64,
    pub run_id: String,
    pub call_id: String,
    pub title: String,
    pub summary: String,
    pub steps: Vec<ExecutionPlanStep>,
    pub mutation_manifest: Vec<PlanOperation>,
    pub status: String,
    pub decision_id: Option<String>,
    pub confirmation_source: Option<String>,
    pub response_mode: String,
    pub sequence: u64,
    pub created_at: String,
    pub updated_at: String,
}

impl PendingPlanProjection {
    pub fn is_model_reviewing(&self, run: Option<&RunProjection>) -> bool {
        self.review
            .as_ref()
            .is_some_and(|review| review.status == "reviewing")
            && run.is_some_and(|run| run.status == "running")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoListProjection {
    pub run_id: String,
    pub revision: u64,
    pub items: Vec<TodoItem>,
    pub sequence: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoItem {
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextUsageProjection {
    pub provider_request_id: String,
    pub provider_runtime_ref: String,
    pub run_id: String,
    pub sequence: u64,
    pub updated_at: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub context_window_tokens: u64,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_miss_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageProjection {
    pub provider_call_count: u64,
    pub reported_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_available: bool,
    pub cache_complete: bool,
    pub cache_hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageRoundProjection {
    pub run_id: String,
    pub input_message_id: String,
    pub title: String,
    pub sequence: u64,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub outcome: Option<String>,
    pub provider_call_count: u64,
    pub reported_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_available: bool,
    pub cache_complete: bool,
    pub cache_hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionProjection {
    pub kernel_catalog_snapshot_ref: Option<String>,
    pub provider_request_id: String,
    pub purpose: String,
    pub run_id: String,
    pub response_constraint: String,
    pub dynamic_instruction_bytes: u64,
    pub messages: Vec<ContextCompositionMessage>,
    pub workspace_bindings: Vec<ContextCompositionItem>,
    pub tools: Vec<ContextCompositionTool>,
    pub partitions: Vec<ContextCompositionPartitionProjection>,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionPartitionProjection {
    pub kind: String,
    pub item_count: u64,
    pub request_shape_units: u64,
    pub estimated_input_tokens: Option<u64>,
    pub token_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionMessage {
    pub message_index: u64,
    pub contribution_id: String,
    pub contribution_kind: String,
    pub label: String,
    pub role: String,
    pub blocks: Vec<ContextCompositionMessageBlock>,
    pub filesystem_references: Vec<ContextCompositionItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextCompositionMessageBlock {
    Text {
        block_index: u64,
    },
    Reasoning {
        block_index: u64,
    },
    ToolCall {
        block_index: u64,
        call_id: String,
        tool_name: String,
    },
    ToolResult {
        block_index: u64,
        result_for_call_id: String,
    },
    HostedWebSearch {
        block_index: u64,
        provider_call_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionItem {
    pub item_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionTool {
    pub item_id: String,
    pub label: String,
    pub canonical_name: String,
    pub wire_name: String,
    pub origin: String,
    pub availability: String,
    pub plugin_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjection {
    pub run_id: String,
    pub host_binding: Option<HostWindowBinding>,
    pub profile_id: String,
    pub reasoning_effort: Option<String>,
    pub thinking: Option<String>,
    pub waiting_reason: Option<String>,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostWindowBinding {
    pub host_instance_id: String,
    pub window_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentActivityProjection {
    pub agent_session_id: String,
    pub task_id: Option<String>,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityProjection {
    pub activity_id: String,
    pub kind: String,
    pub status: String,
    pub label: String,
    pub run_id: String,
    pub call_id: Option<String>,
    pub sequence: u64,
    pub started_at: Option<String>,
    pub live_output: Option<ToolOutputProjection>,
    pub tool: Option<ToolActivityProjection>,
    pub input_rejection: Option<ToolInputRejectionProjection>,
    pub not_executed: Option<ToolNotExecutedProjection>,
    pub interruption: Option<ConversationError>,
    pub provider_hosted: Option<ProviderHostedActivityProjection>,
    pub agent: Option<AgentActivityProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolOutputProjection {
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolInputRejectionProjection {
    pub code: String,
    pub message: String,
    pub diagnostics: Option<ErrorDiagnostics>,
    pub issues: Vec<ToolInputIssueProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolNotExecutedProjection {
    pub reason: String,
    pub predecessor_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolInputIssueProjection {
    pub path: String,
    pub rule: String,
    pub message: String,
    pub expected: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHostedActivityProjection {
    pub provider_tool_type: String,
    pub provider_call_id: String,
    #[serde(default, deserialize_with = "deserialize_hosted_search_action")]
    pub action: Option<serde_json::Map<String, Value>>,
}

// Missing details are allowed; an explicitly supplied value must be an object.
fn deserialize_hosted_search_action<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Map<String, Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde_json::Map::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivityProjection {
    pub record_id: Option<String>,
    pub operation: String,
    pub error: Option<ConversationError>,
    pub projection_error: Option<ConversationError>,
    pub resources: Vec<ActivityResourceProjection>,
    pub shell: Option<ShellActivityProjection>,
    #[serde(default)]
    pub shell_intents: Vec<ShellCommandIntent>,
    pub process: Option<ProcessActivityProjection>,
    #[serde(default)]
    pub file_changes: Vec<FileChangeProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandIntent {
    pub kind: String,
    pub targets: Vec<String>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActivityProjection {
    pub job_id: String,
    pub command: String,
    pub output: ToolOutputProjection,
    pub result: Option<ProcessActivityResult>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActivityResult {
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    pub timed_out: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeProjection {
    pub workspace_id: String,
    pub path: String,
    pub kind: String,
    pub before: FileChangeSide,
    pub after: FileChangeSide,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSide {
    pub exists: bool,
    pub content_ref: Option<String>,
    pub size_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellActivityProjection {
    pub command: String,
    pub cwd: String,
    pub execution_scope: String,
    pub terminal: bool,
    pub result: Option<ShellActivityResultProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellActivityResultProjection {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i64>,
    pub success: bool,
    pub timed_out: bool,
    pub truncated: bool,
    pub captured_bytes: u64,
    pub duration_ms: u64,
    pub environment: ShellExecutionEnvironmentProjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellExecutionEnvironmentProjection {
    pub shell: String,
    pub interactive: bool,
    pub execution_scope: String,
    pub terminal: bool,
    pub path_source: String,
    pub write_scope: String,
    pub home_writable: bool,
    pub network_access: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityResourceProjection {
    pub kind: String,
    pub label: String,
    pub workspace_id: Option<String>,
    pub logical_path: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProjection {
    pub session_id: String,
    pub run_id: String,
    pub call_id: String,
    pub record_id: String,
    pub content_type: String,
    pub content_mode: String,
    pub created_at: String,
    pub modified_at: Option<String>,
    pub resource_key: Option<String>,
    pub source_page: Option<serde_json::Value>,
    pub artifact_id: String,
    pub label: String,
    pub workspace_id: Option<String>,
    pub logical_path: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableProjection {
    #[serde(flatten)]
    pub artifact: ArtifactProjection,
    pub delivery_id: String,
    pub presentation_run_id: String,
    pub presented_at: String,
    pub updated_at: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResourceReadRequest<'a> {
    pub workspace_id: &'a str,
    pub logical_path: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachConversationDirectoryIndexRequest<'a> {
    pub path: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemReferencePathInput {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConversationFilesystemReferencesRequest {
    pub references: Vec<FilesystemReferencePathInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResourceReadResult {
    pub workspace_id: String,
    pub logical_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub start_line: u64,
    pub end_line: u64,
    pub next_byte: Option<u64>,
    #[serde(default)]
    pub truncated: bool,
}

pub fn message_command(session_id: &str, command_id: &str, text: &str) -> Value {
    message_command_with_profile(session_id, command_id, text, None)
}

pub fn directory_index_attach_command(
    session_id: &str,
    command_id: &str,
    binding: &WorkspaceBindingDisplay,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "session.directory-index.attach",
        "commandId": command_id,
        "sessionId": session_id,
        "workspaceBinding": binding,
    })
}

pub fn directory_index_detach_command(
    session_id: &str,
    command_id: &str,
    workspace_id: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "session.directory-index.detach",
        "commandId": command_id,
        "sessionId": session_id,
        "workspaceId": workspace_id,
    })
}

pub fn message_command_with_profile(
    session_id: &str,
    command_id: &str,
    text: &str,
    profile_id: Option<&str>,
) -> Value {
    let mut command = json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "message.submit",
        "commandId": command_id,
        "sessionId": session_id,
        "text": text,
    });
    if let Some(profile_id) = profile_id {
        command["profileId"] = json!(profile_id);
    }
    command
}

pub fn message_command_with_profile_and_plugins(
    session_id: &str,
    command_id: &str,
    text: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_selections: &[PluginSelectionInput],
) -> Value {
    let mut command = message_command_with_profile(session_id, command_id, text, profile_id);
    if !filesystem_references.is_empty() {
        command["filesystemReferences"] = json!(filesystem_references);
    }
    if !plugin_selections.is_empty() {
        command["pluginSelections"] = json!(plugin_selections);
    }
    command
}

pub fn focus_command(
    session_id: &str,
    command_id: &str,
    task: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_selections: &[PluginSelectionInput],
) -> Value {
    let mut command = json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "context.focus",
        "commandId": command_id,
        "sessionId": session_id,
        "task": task,
    });
    if let Some(profile_id) = profile_id {
        command["profileId"] = json!(profile_id);
    }
    if !filesystem_references.is_empty() {
        command["filesystemReferences"] = json!(filesystem_references);
    }
    if !plugin_selections.is_empty() {
        command["pluginSelections"] = json!(plugin_selections);
    }
    command
}

pub fn cancel_command(session_id: &str, command_id: &str, run_id: &str) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "run.cancel",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": run_id,
    })
}

pub fn interaction_response_command(
    session_id: &str,
    command_id: &str,
    interaction: &InteractionProjection,
    response: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "interaction.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": interaction.run_id,
        "interactionId": interaction.interaction_id,
        "response": response,
    })
}

/// Shells display only scopes offered by the shared Kernel preview.
pub const AUTHORIZATION_OPTIONS: &[(&str, &str)] = &[
    ("runCommand", "allow-run"),
    ("sessionCommand", "allow-session"),
    ("runHostShell", "allow-host-run"),
    ("sessionHostShell", "allow-host-session"),
    ("runNetwork", "allow-network-run"),
    ("sessionNetwork", "allow-network-session"),
    ("runContainer", "allow-container-run"),
    ("sessionContainer", "allow-container-session"),
    ("runFiles", "allow-files-run"),
    ("sessionFiles", "allow-files-session"),
];

pub fn approval_scope_for_input(decision: &str) -> Option<&'static str> {
    AUTHORIZATION_OPTIONS
        .iter()
        .find(|(_, input)| *input == decision)
        .map(|(scope, _)| *scope)
}

pub fn approval_response_command(
    session_id: &str,
    command_id: &str,
    approval: &ApprovalProjection,
    decision: &str,
) -> Value {
    let mut command = json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "approval.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": approval.run_id,
        "callId": approval.call_id,
        "approvalId": approval.approval_id,
        "decision": if approval_scope_for_input(decision).is_some() { "allow" } else { decision },
    });
    if let Some(scope) = approval_scope_for_input(decision) {
        command["authorizationScope"] = json!(scope);
    }
    command
}

pub fn plan_confirm_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
) -> Value {
    plan_response_command(session_id, command_id, plan, json!({ "kind": "confirm" }))
}

pub fn plan_revision_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
    text: &str,
) -> Value {
    plan_response_command(
        session_id,
        command_id,
        plan,
        json!({
            "kind": "requestRevision",
            "text": text,
        }),
    )
}

pub fn plan_cancel_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
) -> Value {
    plan_response_command(session_id, command_id, plan, json!({ "kind": "cancel" }))
}

fn plan_response_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
    response: Value,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "plan.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": plan.run_id,
        "planId": plan.plan_id,
        "revision": plan.revision,
        "response": response,
    })
}

fn valid_plan_projection(plan: &PlanProjection) -> bool {
    valid_plan_review(plan.review.as_ref())
        && valid_workspace_requests(&plan.workspace_requests)
        && !plan.plan_id.is_empty()
        && plan.revision > 0
        && !plan.run_id.is_empty()
        && !plan.call_id.is_empty()
        && !plan.title.is_empty()
        && !plan.summary.is_empty()
        && !plan.steps.is_empty()
        && matches!(
            plan.status.as_str(),
            "published"
                | "revisionRequested"
                | "confirmed"
                | "superseded"
                | "cancelled"
                | "invalidated"
        )
        && plan.sequence > 0
        && !plan.created_at.is_empty()
        && !plan.updated_at.is_empty()
        && valid_plan_body(&plan.steps, &plan.mutation_manifest)
}

fn valid_pending_plan_projection(plan: &PendingPlanProjection) -> bool {
    valid_plan_review(plan.review.as_ref())
        && valid_workspace_requests(&plan.workspace_requests)
        && !plan.plan_id.is_empty()
        && plan.revision > 0
        && !plan.run_id.is_empty()
        && !plan.call_id.is_empty()
        && !plan.title.is_empty()
        && !plan.summary.is_empty()
        && plan.status == "published"
        && plan.response_mode == "confirmReviseOrCancel"
        && plan.decision_id.is_none()
        && plan.sequence > 0
        && !plan.created_at.is_empty()
        && !plan.updated_at.is_empty()
        && valid_plan_body(&plan.steps, &plan.mutation_manifest)
}

fn valid_plan_review(review: Option<&PlanReviewProjection>) -> bool {
    review.is_none_or(|review| {
        !review.provider_request_id.is_empty()
            && match review.status.as_str() {
                "reviewing" => {
                    review.decision.is_none() && review.reason.is_none() && review.error.is_none()
                }
                "completed" => {
                    matches!(review.decision.as_deref(), Some("allow" | "deny" | "ask"))
                        && review
                            .reason
                            .as_deref()
                            .is_some_and(|reason| !reason.trim().is_empty())
                }
                _ => false,
            }
    })
}

fn valid_workspace_requests(requests: &[PlanWorkspaceRequest]) -> bool {
    let mut ids = HashSet::new();
    requests.iter().all(|request| {
        !request.workspace_id.is_empty()
            && !request.root_path.is_empty()
            && ids.insert(&request.workspace_id)
    })
}

fn valid_plan_body(steps: &[ExecutionPlanStep], operations: &[PlanOperation]) -> bool {
    let mut step_ids = HashSet::new();
    !steps.is_empty()
        && steps.iter().all(|step| {
            !step.step_id.is_empty()
                && !step.title.is_empty()
                && !step.details.is_empty()
                && step_ids.insert(step.step_id.as_str())
                && step
                    .verification
                    .as_ref()
                    .is_none_or(|items| items.iter().all(|item| !item.trim().is_empty()))
        })
        && operations.iter().all(|operation| {
            !operation.workspace_id.is_empty()
                && match operation.operation.as_str() {
                    "fs.delete" => {
                        matches!(
                            operation.target_kind.as_deref(),
                            Some("file" | "directoryTree")
                        ) && operation
                            .target
                            .as_deref()
                            .is_some_and(|target| !target.is_empty())
                            && operation.command.is_none()
                            && operation.terminal.is_none()
                            && operation.writable_paths.is_none()
                    }
                    "fs.write" | "fs.edit" | "document.render" | "browser.capture" => {
                        operation
                            .target
                            .as_deref()
                            .is_some_and(|target| !target.is_empty())
                            && matches!(
                                operation.target_kind.as_deref(),
                                None | Some("file" | "directoryTree")
                            )
                            && operation.command.is_none()
                            && operation.terminal.is_none()
                            && operation.writable_paths.is_none()
                    }
                    "bash" | "powershell" => {
                        operation.target.is_none()
                            && operation.target_kind.is_none()
                            && operation
                                .command
                                .as_deref()
                                .is_none_or(|command| !command.is_empty())
                            && operation.writable_paths.as_ref().is_some_and(|paths| {
                                !paths.is_empty()
                                    && paths.iter().all(|target| {
                                        target.path != "."
                                            && is_normalized_logical_path(&target.path)
                                            && matches!(target.kind.as_str(), "file" | "directory")
                                    })
                            })
                            && operation
                                .terminal
                                .as_ref()
                                .is_none_or(|terminal| terminal.stdin.len() <= 65_536)
                    }
                    _ => false,
                }
        })
}

pub fn is_terminal_run_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "indeterminate" | "releaseFailed"
    )
}

fn is_run_status(status: &str) -> bool {
    matches!(
        status,
        "running"
            | "waiting"
            | "releasing"
            | "releaseFailed"
            | "completed"
            | "failed"
            | "cancelled"
            | "indeterminate"
    )
}

fn valid_plugin_uri(value: &str) -> bool {
    let Some(identity) = value.strip_prefix("plugin://") else {
        return false;
    };
    let Some((name, source)) = identity.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !source.is_empty()
        && !name.contains('@')
        && name.chars().chain(source.chars()).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && value.len() <= 128
        && kind.chars().chain(subtype.chars()).all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                )
        })
}

fn invalid_durations(values: &[Option<f64>]) -> bool {
    values
        .iter()
        .flatten()
        .any(|value| !value.is_finite() || *value < 0.0)
}

fn valid_token_usage_fields(
    provider_call_count: u64,
    reported_call_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_miss_input_tokens: u64,
    cache_available: bool,
    cache_complete: bool,
    cache_hit_ratio: Option<f64>,
) -> bool {
    let Some(cache_population) = cache_read_input_tokens.checked_add(cache_miss_input_tokens)
    else {
        return false;
    };
    if reported_call_count > provider_call_count
        || input_tokens.checked_add(output_tokens).is_none()
        || cache_population > input_tokens
        || cache_available != (reported_call_count > 0)
        || cache_complete != (provider_call_count > 0 && reported_call_count == provider_call_count)
    {
        return false;
    }
    match (cache_available && input_tokens > 0, cache_hit_ratio) {
        (false, None) => true,
        (false, Some(_)) | (true, None) => false,
        (true, Some(ratio)) => {
            let expected = cache_read_input_tokens as f64 / input_tokens as f64;
            ratio.is_finite()
                && (0.0..=1.0).contains(&ratio)
                && (ratio - expected).abs() <= f64::EPSILON * 8.0
        }
    }
}

fn valid_shell_execution_environment(environment: &ShellExecutionEnvironmentProjection) -> bool {
    !environment.shell.trim().is_empty()
        && matches!(environment.execution_scope.as_str(), "workspace" | "host")
        && environment.interactive == environment.terminal
        && !environment.path_source.trim().is_empty()
        && !environment.write_scope.trim().is_empty()
}

fn is_normalized_logical_path(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_subagent_settings_decode_complete_snapshots_and_reject_invalid_fields() {
        let settings = json!({"enabled":true,"profileId":"","reasoningEffort":"high",
            "maxConcurrent":4,"maxCallsPerRun":8,"maxMembersPerSession":12,
            "allowMemberAnalysis":true,"allowFullConfiguration":false,"presets":"[]"});
        let mut value = projection_value();
        value["subagentSettings"] = settings.clone();
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        assert_eq!(
            serde_json::to_value(projection.subagent_settings.unwrap()).unwrap(),
            settings
        );
        value["subagentSettings"]["maxConcurrent"] = json!(0);
        assert!(serde_json::from_value::<SessionProjection>(value.clone())
            .unwrap()
            .validate()
            .is_err());
        value["subagentSettings"] = settings;
        value["subagentSettings"]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<SessionProjection>(value).is_err());
        let missing: SessionProjection = serde_json::from_value(projection_value()).unwrap();
        assert!(missing.subagent_settings.is_none());
    }

    #[test]
    fn pending_child_decisions_preserve_the_original_session_and_references() {
        let mut value = projection_value();
        value["pendingAgentDecisions"] = json!([{
            "agentSessionId":"session:descendant", "displayName":"Writer", "runId":"run:child",
            "plan":{"planId":"plan:child","revision":2}, "interactionIds":["interaction:child"],
            "approval":{"approvalId":"approval:child","callId":"call:child"}
        }]);
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        let child = &projection.pending_agent_decisions.as_ref().unwrap()[0];
        assert_eq!(child.agent_session_id, "session:descendant");
        assert_eq!(child.plan.as_ref().unwrap().revision, 2);
        assert_eq!(child.approval.as_ref().unwrap().call_id, "call:child");
        value["pendingAgentDecisions"][0]["plan"]["revision"] = json!(0);
        assert!(serde_json::from_value::<SessionProjection>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn unified_agent_projection_preserves_explicit_capabilities() {
        let capabilities = json!({"messaging":true,"continuation":false,"delegation":false});
        let mut value = projection_value();
        value["agentContext"] = json!({
            "capabilities":capabilities,"ownerSessionId":"session:owner","parentSessionId":"session:parent",
            "parentRunId":"run:parent","parentCallId":"call:spawn",
            "configuration":{"context":{"id":"journal"},"compaction":{"id":"summary"},"controls":{"id":"standard","parameters":{"optionalTools":[]}}},
            "model":{"profileId":"profile:chosen","model":"chosen-model","reasoningEffort":"high","thinking":"enabled","parameters":{"adapterId":"openai","kind":"responses","providerFlavor":null,"contextWindowTokens":100000,"maxOutputTokens":4096,"imageInput":false,"temperature":null,"hostedWebSearch":null}}
        });
        value["agentTasks"] = json!([{
            "taskId":"task:child","agentSessionId":"session:child","capabilities":capabilities,
            "displayName":"Child","text":"Analyze","delivery":"async","parentRunId":"run:parent","status":"running"
        }]);
        value["agentChildren"] = json!([{
            "agentSessionId":"session:child","displayName":"Child","capabilities":capabilities,"closed":false
        }]);
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        let expected = AgentCapabilities {
            messaging: AgentMessaging::Enabled(true),
            continuation: false,
            delegation: false,
        };
        let context = projection.agent_context.unwrap();
        assert_eq!(context.capabilities, expected);
        assert_eq!(
            context.configuration.unwrap().controls.parameters.unwrap()["optionalTools"],
            json!([])
        );
        assert_eq!(context.model.unwrap().model, "chosen-model");
        assert_eq!(projection.agent_tasks.unwrap()[0].capabilities, expected);
        assert_eq!(projection.agent_children.unwrap()[0].capabilities, expected);
        let mut missing = value.clone();
        missing["agentChildren"][0]
            .as_object_mut()
            .unwrap()
            .remove("capabilities");
        assert!(serde_json::from_value::<SessionProjection>(missing).is_err());
        let mut invalid = value.clone();
        invalid["agentContext"]["capabilities"]["messaging"] = json!("true");
        assert!(serde_json::from_value::<SessionProjection>(invalid).is_err());
        value["agentTasks"][0]["role"] = json!("analysis");
        assert!(serde_json::from_value::<SessionProjection>(value).is_err());
    }

    #[test]
    fn member_message_activity_has_no_task_settlement() {
        let mut value = projection_value();
        value["agentChildren"] = json!([{
            "agentSessionId":"session:child","displayName":"Child","closed":false,
            "capabilities":{"messaging":true,"continuation":true,"delegation":false}
        }]);
        value["activities"].as_array_mut().unwrap().push(json!({
            "activityId":"agent:message:7","kind":"agent","status":"completed","label":"Child",
            "runId":"run:test","sequence":7,
            "agent":{"agentSessionId":"session:child","phase":"updated"}
        }));
        value["timeline"].as_array_mut().unwrap().insert(
            3,
            json!({
                "kind":"toolGroup","timelineId":"agent:message:7","sequence":7,
                "activityIds":["agent:message:7"]
            }),
        );
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        assert_eq!(
            projection.activities[1].agent.as_ref().unwrap().task_id,
            None
        );
        value["activities"][1]["agent"]["phase"] = json!("completed");
        assert!(serde_json::from_value::<SessionProjection>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn projection_preserves_unexecuted_dispositions_and_approval_collection() {
        for (status, disposition) in [
            ("rejected", json!({"reason":"approvalRequired"})),
            ("cancelled", json!({"reason":"cancelled"})),
            (
                "rejected",
                json!({"reason":"dependencyFailed","predecessorCallId":"call:earlier"}),
            ),
        ] {
            let mut value = projection_value();
            value["pendingApprovals"] = json!([]);
            value["activities"][0]
                .as_object_mut()
                .unwrap()
                .remove("tool");
            value["activities"][0]["status"] = json!(status);
            value["activities"][0]["notExecuted"] = disposition.clone();
            let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
            projection.validate().unwrap();
            assert_eq!(projection.pending_approvals.unwrap().len(), 0);
            assert_eq!(
                projection.activities[0]
                    .not_executed
                    .as_ref()
                    .unwrap()
                    .reason,
                disposition["reason"]
            );
            value["activities"][0]["startedAt"] = json!("1");
            assert!(serde_json::from_value::<SessionProjection>(value)
                .unwrap()
                .validate()
                .is_err());
        }
    }

    fn projection_value() -> Value {
        let mut value = json!({
            "schemaVersion": SESSION_PROJECTION_VERSION, "permissionOverrides":{}, "effectivePermissions":null, "shellAuthorizations":[],
            "sessionId": "session:test",
            "revision": 8,
            "display": { "creationTitle": "测试" },
            "workspaceBindings": [{
                "workspaceId": "workspace:test",
                "displayName": "Test"
            }],
            "sessionDirectoryIndexes": [],
            "messages": [
                {
                    "messageId": "message:input",
                    "role": "user",
                    "content": "分析项目",
                    "filesystemReferences": [],
                    "pluginSelections": [],
                    "feedback": null,
                    "sequence": 1,
                    "createdAt": "2026-08-25T00:00:00.000Z"
                },
                {
                    "messageId": "message:answer",
                    "runId": "run:test",
                    "providerRequestId": "provider-request:test",
                    "role": "assistant",
                    "content": "分析完成",
                    "filesystemReferences": [],
                    "pluginSelections": [],
                    "feedback": "up",
                    "sequence": 8,
                    "createdAt": "2026-08-25T00:00:07.000Z"
                }
            ],
            "narratives": [],
            "assistantDraft": null,
            "pendingInteraction": null,
            "pendingApproval": null,
            "plans": [{
                "planId": "plan:test",
                "revision": 1,
                "runId": "run:test",
                "callId": "call:plan",
                "title": "分析项目",
                "summary": "读取入口并形成结论。",
                "steps": [{
                    "stepId": "step:read",
                    "title": "读取入口",
                    "details": "读取 README。"
                }],
                "mutationManifest": [],
                "status": "confirmed",
                "decisionId": "decision:plan",
                "sequence": 2,
                "createdAt": "2026-08-25T00:00:01.000Z",
                "updatedAt": "2026-08-25T00:00:06.000Z"
            }],
            "activePlanRef": null,
            "pendingPlan": null,
            "todoList": {
                "runId": "run:test",
                "revision": 1,
                "items": [{
                    "text": "读取入口",
                    "status": "completed"
                }],
                "sequence": 3,
                "updatedAt": "2026-08-25T00:00:00.000Z"
            },
            "contextUsage": {
                "providerRequestId": "provider-request:test",
                "providerRuntimeRef": "provider-runtime:test",
                "runId": "run:test",
                "sequence": 5,
                "updatedAt": "2026-08-25T00:00:04.000Z",
                "inputTokens": 80,
                "outputTokens": 10,
                "contextWindowTokens": 1000,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30
            },
            "contextCompositions": [{
                "providerRequestId": "provider-request:test",
                "purpose": "agent",
                "runId": "run:test",
                "responseConstraint": "normal",
                "dynamicInstructionBytes": 128,
                "messages": [{
                    "messageIndex": 0,
                    "contributionId": "instruction:agent",
                    "contributionKind": "instructions",
                    "label": "achbit.coding-agent",
                    "role": "system",
                    "blocks": [{ "blockIndex": 0, "kind": "text" }],
                    "filesystemReferences": []
                }],
                "workspaceBindings": [{ "itemId": "workspace:test", "label": "Test" }],
                "tools": [{
                    "itemId": "fs.read",
                    "label": "fs_read",
                    "canonicalName": "fs.read",
                    "wireName": "fs_read",
                    "origin": "coreBuiltin",
                    "availability": "callable"
                }],
                "partitions": [
                    { "kind": "instructions", "itemCount": 1, "requestShapeUnits": 30,
                      "estimatedInputTokens": 30, "tokenSource": "sessionEstimated" },
                    { "kind": "sessionControls", "itemCount": 3, "requestShapeUnits": 20,
                      "estimatedInputTokens": 20, "tokenSource": "sessionEstimated" },
                    { "kind": "tools", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "workspaceBindings", "itemCount": 1, "requestShapeUnits": 8,
                      "estimatedInputTokens": 8, "tokenSource": "sessionEstimated" },
                    { "kind": "contextProviders", "itemCount": 0, "requestShapeUnits": 0,
                      "estimatedInputTokens": 0, "tokenSource": "sessionEstimated" },
                    { "kind": "journalMessages", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "filesystemReferences", "itemCount": 0, "requestShapeUnits": 2,
                      "estimatedInputTokens": 2, "tokenSource": "sessionEstimated" }
                ],
                "sequence": 4,
                "createdAt": "2026-08-25T00:00:03.000Z"
            }],
            "tokenUsage": {
                "providerCallCount": 1,
                "reportedCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheAvailable": true,
                "cacheComplete": true,
                "cacheHitRatio": 0.625
            },
            "tokenUsageHistory": [{
                "runId": "run:test",
                "inputMessageId": "message:input",
                "title": "分析项目",
                "sequence": 2,
                "startedAt": "2026-08-25T00:00:01.000Z",
                "completedAt": "2026-08-25T00:00:06.000Z",
                "outcome": "completed",
                "providerCallCount": 1,
                "reportedCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheAvailable": true,
                "cacheComplete": true,
                "cacheHitRatio": 0.625
            }],
            "run": {
                "runId": "run:test",
                "profileId": "profile:test",
                "status": "completed",
                "workspaceBindings": [{
                    "workspaceId": "workspace:test",
                    "displayName": "Test"
                }]
            },
            "activities": [{
                "activityId": "tool:read",
                "kind": "tool",
                "status": "completed",
                "label": "fs.read",
                "runId": "run:test",
                "callId": "call:read",
                "sequence": 6,
                "tool": {
                    "operation": "fs.read",
                    "resources": [{
                        "kind": "workspacePath",
                        "label": "README.md",
                        "workspaceId": "workspace:test",
                        "logicalPath": "README.md"
                    }]
                }
            }],
            "artifacts": [],
            "deliverables": [],
            "terminalError": null
        });
        value["totalTokenUsage"] = value["tokenUsage"].clone();
        value["interactions"] = json!([]);
        value["queuedInputs"] = json!([]);
        value["timeline"] = json!([
            {
                "kind": "message",
                "timelineId": "message:message:input",
                "sequence": 1,
                "messageId": "message:input"
            },
            {
                "kind": "plan",
                "timelineId": "provider-turn:provider-request:test:plan:call:plan",
                "sequence": 2,
                "providerRequestId": "provider-request:test",
                "planId": "plan:test",
                "revision": 1
            },
            {
                "kind": "toolGroup",
                "timelineId": "provider-turn:provider-request:test:tools",
                "sequence": 6,
                "providerRequestId": "provider-request:test",
                "activityIds": ["tool:read"]
            },
            {
                "kind": "message",
                "timelineId": "message:message:answer",
                "sequence": 8,
                "messageId": "message:answer",
                "streamId": "stream:answer"
            }
        ]);
        value
    }

    #[test]
    fn projection_preserves_session_provider_and_draft_timing_contract() {
        let mut value = projection_value();
        value["runTimings"] = json!([{
            "runId":"run:test", "clockDomain":"session:clock", "acceptedAt":"2026-10-17T00:00:00Z",
            "startedAt":"2026-10-17T00:00:00Z", "firstResponseAt":"2026-10-17T00:00:01Z",
            "firstResponseKind":"tool", "firstResponseMs":1000.25,
            "firstTextAt":"2026-10-17T00:00:02Z", "firstTextMs":2000.5,
            "settledAt":"2026-10-17T00:00:03Z", "totalMs":3000.75,
            "responseElapsedMs":2000.5, "coverage":"complete"
        }]);
        value["providerAttempts"] = json!([{
            "providerRequestId":"request:test", "providerAttemptId":"attempt:test", "attempt":1,
            "purpose":"agent", "phase":"completed", "runId":"run:test", "updatedAt":"2026-10-17T00:00:03Z",
            "timing":{
                "clockDomain":"provider:clock", "startedAt":"2026-10-17T00:00:00Z",
                "completedAt":"2026-10-17T00:00:03Z", "durationMs":3000.5,
                "firstContentAt":"2026-10-17T00:00:01Z", "firstContentMs":1000.25, "firstContentKind":"tool",
                "firstTextAt":"2026-10-17T00:00:02Z", "firstTextMs":2000.25,
                "textSegments":[{"outputItemId":"output:1", "outputIndex":1, "startedAt":"2026-10-17T00:00:02Z",
                    "endedAt":"2026-10-17T00:00:03Z", "durationMs":1000.25, "characters":12, "outcome":"completed"}]
            }
        }]);
        value["assistantDraft"] = json!({
            "runId":"run:test", "turnId":"turn:test", "providerAttemptId":"attempt:test", "blocks":[]
        });
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        assert_eq!(projection.run_timings[0].response_elapsed_ms, Some(2000.5));
        assert_eq!(
            projection.run_timings[0].first_response_kind.as_deref(),
            Some("tool")
        );
        let timing = projection.provider_attempts[0].timing.as_ref().unwrap();
        assert_eq!(timing.duration_ms, Some(3000.5));
        assert_eq!(
            timing.text_segments.as_ref().unwrap()[0].duration_ms,
            Some(1000.25)
        );
        assert_eq!(
            projection
                .assistant_draft
                .unwrap()
                .provider_attempt_id
                .as_deref(),
            Some("attempt:test")
        );
        let mut unknown = value.clone();
        unknown["providerAttempts"][0]["timing"]["inventedField"] = json!(1);
        assert!(serde_json::from_value::<SessionProjection>(unknown).is_err());
        value["runTimings"][0]["firstResponseMs"] = json!(-1);
        assert!(serde_json::from_value::<SessionProjection>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn validates_shared_identity_cache_and_activity_facts() {
        let projection: SessionProjection =
            serde_json::from_value(projection_value()).expect("projection decodes");
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(
            projection.messages[1].provider_request_id.as_deref(),
            Some("provider-request:test")
        );
        assert_eq!(projection.token_usage.cache_hit_ratio, Some(0.625));
        assert!(projection.token_usage.cache_complete);
        assert_eq!(
            projection.activities[0].call_id.as_deref(),
            Some("call:read")
        );
    }

    #[test]
    fn explicit_deliverables_decode_without_reclassifying_archived_resources() {
        let mut value = projection_value();
        let resource = json!({
            "sessionId":"session:test", "runId":"run:test", "callId":"call:prepare", "recordId":"record:prepare",
            "artifactId":"artifact:report", "label":"Report", "uri":"artifact://artifact:report",
            "contentType":"text/markdown", "contentMode":"fixed", "createdAt":"2026-10-09T01:00:00Z",
            "modifiedAt":"2026-10-09T00:59:00Z", "resourceKey":"file:report"
        });
        value["artifacts"] = json!([resource]);
        let mut delivery = resource.clone();
        delivery.as_object_mut().unwrap().extend(
            json!({
                "deliveryId":"delivery:report", "presentationRunId":"run:test", "sequence":9,
                "presentedAt":"2026-10-09T01:01:00Z", "updatedAt":"2026-10-09T00:59:00Z"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        value["deliverables"] = json!([delivery]);
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        projection.validate().unwrap();
        assert_eq!(projection.deliverables[0].artifact, projection.artifacts[0]);
        assert_eq!(projection.deliverables[0].delivery_id, "delivery:report");
        value["deliverables"] = json!([]);
        let unpresented: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(unpresented.artifacts.len(), 1);
        assert!(unpresented.deliverables.is_empty());
        value.as_object_mut().unwrap().remove("deliverables");
        assert!(serde_json::from_value::<SessionProjection>(value).is_err());
    }

    #[test]
    fn shell_plan_projection_uses_business_paths_without_model_authority() {
        for shell in ["bash", "powershell"] {
            let mut value = projection_value();
            value["plans"][0]["mutationManifest"] = json!([{
                "workspaceId": "workspace:test", "operation": shell,
                "writablePaths": [{"path":"build", "kind":"directory"}]
            }]);
            let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(projection.validate(), Ok(()));
            for paths in [
                Value::Null,
                json!([]),
                json!([{"path":"../outside", "kind":"file"}]),
            ] {
                let mut invalid = value.clone();
                invalid["plans"][0]["mutationManifest"][0]["writablePaths"] = paths;
                assert!(serde_json::from_value::<SessionProjection>(invalid)
                    .unwrap()
                    .validate()
                    .is_err());
            }
            for (field, authority) in [("workspaceMode", "write"), ("executionScope", "host")] {
                let mut invalid = value.clone();
                invalid["plans"][0]["mutationManifest"][0][field] = json!(authority);
                assert!(serde_json::from_value::<SessionProjection>(invalid).is_err());
            }
        }
    }

    #[test]
    fn queued_input_and_original_tool_error_are_shared_facts() {
        let mut value = projection_value();
        value["queuedInputs"] = json!([{
            "commandId":"command:queued", "messageId":"message:queued", "runId":"run:test",
            "text":"未执行的补充🙂", "filesystemReferences":[], "pluginSelections":[],
            "sequence":5, "createdAt":"now", "status":"notApplied"
        }]);
        value["activities"][0]["status"] = json!("failed");
        value["activities"][0]["tool"]["error"] =
            json!({"code":"fs_read_failed", "message":"original read error"});
        let projection: SessionProjection = serde_json::from_value(value).unwrap();
        projection.validate().unwrap();
        assert_eq!(projection.queued_inputs[0].status, "notApplied");
        assert_eq!(projection.queued_inputs[0].text, "未执行的补充🙂");
        let error = projection.activities[0]
            .tool
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .unwrap();
        assert_eq!(error.code, "fs_read_failed");
        assert_eq!(error.message, "original read error");
    }

    #[test]
    fn tool_progress_decodes_at_the_same_revision_and_settlement_removes_live_output() {
        let mut value = projection_value();
        value["activities"][0]["status"] = json!("active");
        value["activities"][0]["startedAt"] = json!("1789280000000");
        value["activities"][0]["liveOutput"] = json!({
            "stdout": "开始\n", "stderr": "", "stdoutBytes": 7, "stderrBytes": 0, "truncated": false
        });
        let active: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(active.validate(), Ok(()));
        assert_eq!(
            active.activities[0].started_at.as_deref(),
            Some("1789280000000")
        );
        assert_eq!(
            active.activities[0].live_output.as_ref().unwrap().stdout,
            "开始\n"
        );
        value["activities"][0]["liveOutput"]["stdout"] = json!("开始\n完成一项\n");
        value["activities"][0]["liveOutput"]["stdoutBytes"] = json!(20);
        let updated: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(active.revision, updated.revision);
        assert_ne!(active.activities[0], updated.activities[0]);
        assert_eq!(updated.validate(), Ok(()));
        value["activities"][0]["status"] = json!("completed");
        let invalid: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert!(
            invalid.validate().is_err(),
            "terminal facts must not retain transient output"
        );
        value["activities"][0]
            .as_object_mut()
            .unwrap()
            .remove("liveOutput");
        let terminal: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(terminal.validate(), Ok(()));
        assert!(terminal.activities[0].live_output.is_none());
        value["activities"][0]["startedAt"] = json!("unknown");
        let invalid: SessionProjection = serde_json::from_value(value).unwrap();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn validates_provider_hosted_context_tool() {
        let mut value = projection_value();
        value["contextCompositions"][0]["tools"][0] = json!({
            "itemId": "web.search",
            "label": "web_search",
            "canonicalName": "web.search",
            "wireName": "web_search",
            "origin": "providerHosted",
            "availability": "callable"
        });
        value["contextCompositions"][0]["messages"]
            .as_array_mut()
            .expect("context messages")
            .push(json!({
                "messageIndex": 1,
                "contributionId": "journal:hosted-answer",
                "contributionKind": "journalMessages",
                "label": "assistant message",
                "role": "assistant",
                "blocks": [{
                    "blockIndex": 0,
                    "kind": "hostedWebSearch",
                    "providerCallId": "ws_1"
                }],
                "filesystemReferences": []
            }));

        let projection: SessionProjection =
            serde_json::from_value(value).expect("provider-hosted tool projection decodes");
        assert_eq!(projection.validate(), Ok(()));
    }

    #[test]
    fn hosted_search_projection_preserves_optional_action() {
        let activity = json!({
            "providerToolType": "web_search", "providerCallId": "ws_optional",
        });
        let draft = json!({
            "kind": "providerHosted", "outputIndex": 0,
            "providerToolType": "web_search", "providerCallId": "ws_optional",
            "status": "completed",
        });
        let decoded: ProviderHostedActivityProjection =
            serde_json::from_value(activity.clone()).unwrap();
        assert!(decoded.action.is_none());
        let decoded: AssistantDraftBlockProjection = serde_json::from_value(draft.clone()).unwrap();
        assert!(!decoded.invalid());
        assert!(matches!(
            decoded,
            AssistantDraftBlockProjection::ProviderHosted { action: None, .. }
        ));
        for action in [
            json!({"type": "search"}),
            json!(null),
            json!("search"),
            json!([]),
        ] {
            let mut with_activity = activity.clone();
            with_activity["action"] = action.clone();
            let mut with_draft = draft.clone();
            with_draft["action"] = action.clone();
            let decoded = serde_json::from_value::<ProviderHostedActivityProjection>(with_activity);
            let decoded_draft = serde_json::from_value::<AssistantDraftBlockProjection>(with_draft);
            if action.is_object() {
                assert_eq!(decoded.unwrap().action.as_ref(), action.as_object());
                assert!(!decoded_draft.unwrap().invalid());
            } else {
                assert!(decoded.is_err());
                assert!(decoded_draft.is_err());
            }
        }
    }

    #[test]
    fn directory_reference_command_omits_file_only_metadata() {
        let reference = FilesystemReference {
            reference_id: "reference:directory".to_string(),
            workspace_id: "workspace:directory".to_string(),
            logical_path: ".".to_string(),
            display_name: "Fixture directory".to_string(),
            kind: "directory".to_string(),
            media_type: None,
            byte_length: None,
            source: None,
        };
        let command = message_command_with_profile_and_plugins(
            "session:test",
            "command:test",
            "Inspect directory",
            None,
            &[reference],
            &[],
        );
        let encoded = command["filesystemReferences"][0]
            .as_object()
            .expect("serialized directory reference");
        assert_eq!(encoded.len(), 5);
        assert!(!encoded.contains_key("mediaType"));
        assert!(!encoded.contains_key("byteLength"));
    }

    #[test]
    fn directory_reference_rejects_file_only_fields_even_when_null() {
        let result = serde_json::from_value::<FilesystemReference>(json!({
            "referenceId": "reference:directory",
            "workspaceId": "workspace:directory",
            "logicalPath": ".",
            "displayName": "Fixture directory",
            "kind": "directory",
            "mediaType": null,
            "byteLength": null,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn validates_canonical_shell_command_and_result_projection() {
        let mut value = projection_value();
        let mut unreadable = value.clone();
        unreadable["activities"][0]["tool"] = json!({
            "operation": "bash", "resources": [], "recordId": "record:original",
            "projectionError": {"code":"bash_projection_environment_invalid", "message":"Tool details are unavailable."}
        });
        let readable: SessionProjection = serde_json::from_value(unreadable.clone()).unwrap();
        assert_eq!(readable.validate(), Ok(()));
        assert_eq!(readable.activities[0].status, "completed");
        assert_eq!(
            readable.activities[0]
                .tool
                .as_ref()
                .unwrap()
                .projection_error
                .as_ref()
                .unwrap()
                .code,
            "bash_projection_environment_invalid"
        );
        unreadable["activities"][0]["tool"]
            .as_object_mut()
            .unwrap()
            .remove("projectionError");
        assert!(serde_json::from_value::<SessionProjection>(unreadable)
            .unwrap()
            .validate()
            .is_err());
        value["activities"][0]["label"] = json!("bash");
        value["activities"][0]["tool"] = json!({
            "operation": "bash",
            "resources": [{
                "kind": "workspacePath",
                "label": ".",
                "workspaceId": "workspace:test",
                "logicalPath": "."
            }],
            "shell": {
                "command": "make build",
                "cwd": ".",
                "executionScope": "workspace",
                "terminal": false,
                "result": {
                    "stdout": "built\n",
                    "stderr": "",
                    "exitCode": 0,
                    "success": true,
                    "timedOut": false,
                    "truncated": false,
                    "capturedBytes": 6,
                    "durationMs": 420,
                    "environment": {
                        "shell": "/bin/sh",
                        "interactive": false,
                        "executionScope": "workspace",
                        "terminal": false,
                        "pathSource": "hostPlusStandardDeveloperPaths",
                        "writeScope": "authorizedResources",
                        "homeWritable": true,
                        "networkAccess": false
                    }
                }
            }
        });
        let projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("shell projection decodes");
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(
            projection.activities[0]
                .tool
                .as_ref()
                .and_then(|tool| tool.shell.as_ref())
                .map(|shell| shell.command.as_str()),
            Some("make build")
        );

        for scope in [
            "workspaceAndKernelTemporary",
            "kernelTemporaryOnly",
            "recordedScope",
        ] {
            let mut recorded = value.clone();
            let environment =
                &mut recorded["activities"][0]["tool"]["shell"]["result"]["environment"];
            environment["writeScope"] = json!(scope);
            environment["homeWritable"] = json!(false);
            let projection: SessionProjection = serde_json::from_value(recorded).unwrap();
            assert_eq!(projection.validate(), Ok(()));
            let environment = &projection.activities[0]
                .tool
                .as_ref()
                .unwrap()
                .shell
                .as_ref()
                .unwrap()
                .result
                .as_ref()
                .unwrap()
                .environment;
            assert_eq!(environment.write_scope, scope);
            assert!(!environment.home_writable);
        }

        value["activities"][0]["tool"]["shell"]["result"]["environment"]["executionScope"] =
            json!("host");
        let read_projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("read shell projection decodes");
        assert!(
            read_projection.validate().is_err(),
            "Recorded environment must match the invocation execution scope"
        );

        value["activities"][0]["tool"]["shell"]["executionScope"] = json!("host");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["executionScope"] =
            json!("host");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["writeScope"] =
            json!("hostUser");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["homeWritable"] =
            json!(true);
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["networkAccess"] =
            json!(true);
        let host_projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("host shell projection decodes");
        assert_eq!(host_projection.validate(), Ok(()));

        value["activities"][0]["tool"]["shell"]["result"]["environment"]["writeScope"] = json!("");
        let invalid_projection: SessionProjection =
            serde_json::from_value(value).expect("invalid shell projection still decodes");
        assert!(invalid_projection.validate().is_err());
    }

    #[test]
    fn partial_cache_aggregate_uses_all_reported_input_tokens() {
        let mut value = projection_value();
        value["tokenUsage"]["providerCallCount"] = json!(2);
        value["tokenUsage"]["inputTokens"] = json!(130);
        value["tokenUsage"]["cacheComplete"] = json!(false);
        value["tokenUsage"]["cacheHitRatio"] = json!(50.0 / 130.0);
        let projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("partial cache projection decodes");
        assert_eq!(projection.validate(), Ok(()));

        value["tokenUsage"]["cacheHitRatio"] = json!(50.0 / 80.0);
        let reported_subset: SessionProjection =
            serde_json::from_value(value).expect("reported-subset ratio decodes");
        assert!(reported_subset.validate().is_err());
    }

    #[test]
    fn rejects_cache_aggregate_that_disagrees_with_counters() {
        let mut value = projection_value();
        value["tokenUsage"]["cacheHitRatio"] = json!(0.5);
        let projection: SessionProjection =
            serde_json::from_value(value).expect("projection decodes");
        assert!(projection.validate().is_err());
    }

    #[test]
    fn validates_descendant_total_usage_independently_of_own_usage() {
        let mut value = projection_value();
        value["totalTokenUsage"]["inputTokens"] = json!(180);
        value["totalTokenUsage"]["cacheReadInputTokens"] = json!(100);
        value["totalTokenUsage"]["cacheMissInputTokens"] = json!(80);
        value["totalTokenUsage"]["cacheHitRatio"] = json!(100.0 / 180.0);
        let projection: SessionProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(projection.token_usage.input_tokens, 80);
        value["totalTokenUsage"]["cacheHitRatio"] = json!(0.625);
        assert!(serde_json::from_value::<SessionProjection>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn rejects_context_usage_without_its_exact_request_receipt() {
        let mut value = projection_value();
        value["contextUsage"]["providerRequestId"] = json!("provider-request:other");
        let projection: SessionProjection =
            serde_json::from_value(value).expect("projection decodes");
        assert!(projection.validate().is_err());
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRound {
    pub run_id: String,
    pub record_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeContent {
    pub workspace_id: String,
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}
impl FileChangeContent {
    pub fn unified_diff(&self) -> String {
        let before: Vec<_> = self
            .before
            .as_deref()
            .unwrap_or("")
            .split_inclusive('\n')
            .collect();
        let after: Vec<_> = self
            .after
            .as_deref()
            .unwrap_or("")
            .split_inclusive('\n')
            .collect();
        let prefix = before
            .iter()
            .zip(&after)
            .take_while(|(a, b)| a == b)
            .count();
        let suffix = before[prefix..]
            .iter()
            .rev()
            .zip(after[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let start = prefix.saturating_sub(3);
        let old_end = (before.len() - suffix + 3).min(before.len());
        let new_end = (after.len() - suffix + 3).min(after.len());
        let mut output = format!(
            "--- {}\n+++ {}\n@@ -{},{} +{},{} @@\n",
            if self.before.is_some() {
                self.path.as_str()
            } else {
                "/dev/null"
            },
            if self.after.is_some() {
                self.path.as_str()
            } else {
                "/dev/null"
            },
            if old_end == start { 0 } else { start + 1 },
            old_end - start,
            if new_end == start { 0 } else { start + 1 },
            new_end - start
        );
        let mut line = |marker: char, text: &str| {
            output.push(marker);
            output.push_str(text);
            if !text.ends_with('\n') {
                output.push_str("\n\\ No newline at end of file\n");
            }
        };
        for value in &before[start..prefix] {
            line(' ', value);
        }
        for value in &before[prefix..before.len() - suffix] {
            line('-', value);
        }
        for value in &after[prefix..after.len() - suffix] {
            line('+', value);
        }
        for value in &before[before.len() - suffix..old_end] {
            line(' ', value);
        }
        output
    }
}

#[cfg(test)]
mod provider_diagnostic_tests {
    use super::*;
    #[test]
    fn upstream_service_details_reach_rust_shells() {
        let error: ConversationError = serde_json::from_value(json!({
            "code":"provider_error", "message":"Try again later.",
            "diagnostics":{"source":"providerTransport", "phase":"response",
                "category":"provider", "retryable":false, "causes":[],
                "providerError":{"code":"server_is_overloaded", "type":"service_unavailable_error",
                    "retryDirective":"NO_MORE_RETRY"}},
        }))
        .unwrap();
        let details = error.diagnostics.unwrap().provider_error.unwrap();
        assert_eq!(details.code.as_deref(), Some("server_is_overloaded"));
        assert_eq!(details.r#type.as_deref(), Some("service_unavailable_error"));
        assert_eq!(details.retry_directive.as_deref(), Some("NO_MORE_RETRY"));
    }

    #[test]
    fn optional_transport_details_preserve_old_errors_and_new_attempts() {
        let old: ConversationError = serde_json::from_value(
            serde_json::json!({"code":"provider_transport_failed","message":"Failed"}),
        )
        .unwrap();
        assert!(old.diagnostics.is_none());
        let attempt: ProviderAttemptProjection = serde_json::from_value(serde_json::json!({
            "providerRequestId":"request:1", "providerAttemptId":"attempt:1", "attempt":1,
            "purpose":"agent", "phase":"failed", "runId":"run:1", "updatedAt":"2026-09-16T00:00:00Z",
            "error":{"code":"provider_transport_failed","message":"Failed", "diagnostics":{
                "source":"providerTransport","phase":"send","category":"network","retryable":true,
                "isConnect":true,"causes":[{"message":"Connection reset","osCode":104,"kind":"ConnectionReset"}]
            }}
        })).unwrap();
        assert_eq!(
            attempt.error.unwrap().diagnostics.unwrap().causes[0].os_code,
            Some(104)
        );
    }
}
