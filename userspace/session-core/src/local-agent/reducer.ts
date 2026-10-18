import { isAgentLifetimeEvent, reduceAgentLifetime, type AgentLifetime } from './agentLifecycle.js';
import { isManagedProcessSnapshot, isSessionAuthorizationScope, providerRuntimeForPurpose } from '@deepcode/protocol';
import { advanceDeliverables, compareDeliverables } from './deliverables.js';
import { advanceTodoList } from './todoState.js';
import { providerTextStreamId } from './streamIdentity.js';
import { activeConversationEvents } from './conversationHistory.js';
import { computerRequest, projectComputerActivity } from './computerActivity.js';
import { projectRunLifecycleEvent, reduceRunLifecycle } from './runLifecycle.js';
import { projectDraftSourceContent, projectSourceContent } from './sourceReferences.js';
import type {
  ActivityProjection,
  ManagedProcessSnapshot,
  AssistantDraftProjection,
  ArtifactProjection,
  DeliverableProjection,
  JsonObject,
  PendingPlanProjection,
  PlanProjection,
  ProviderOutputBlock,
  ProviderToolCallInput,
  RunSettlement,
  RunProjection,
  RunRuntimeSnapshot,
  PreparedRequestToolView,
  SessionEvent,
  SessionProjection,
  ShellExecutionEnvironmentProjection,
  ToolExecutionRecord,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_AGENT,
  SESSION_CONTROL_SESSION,
  SESSION_PROJECTION_VERSION, permissionSettings, validatePermissionPatches, isLocalAgentErrorValue,
} from '@deepcode/protocol';

export interface SessionState {
  subagentSettings?: SessionProjection['subagentSettings'];
  recipe?: SessionProjection['recipe'];
  agentContext?: SessionProjection['agentContext'];
  agentTasks: NonNullable<SessionProjection['agentTasks']>;
  agentChildren: NonNullable<SessionProjection['agentChildren']>;
  runTimings: Record<string, NonNullable<SessionProjection['runTimings']>[number]>;
  providerAttempts: Record<string, NonNullable<SessionProjection['providerAttempts']>[number]>;
  failureSnapshots: Record<string, NonNullable<SessionProjection['failureSnapshot']>>;
  permissionOverrides: SessionProjection['permissionOverrides'];
  publishedPermissions?: NonNullable<SessionProjection['effectivePermissions']>;
  shellAuthorizations: SessionProjection['shellAuthorizations'];
  modelSettings: SessionProjection['modelSettings'];
  sessionId: string;
  revision: number;
  display: SessionProjection['display'];
  creationWorkspaceBindings: WorkspaceBindingDisplay[];
  sessionDirectoryIndexes: WorkspaceBindingDisplay[];
  workspaceBindings: WorkspaceBindingDisplay[];
  messages: SessionProjection['messages'];
  queuedInputs: SessionProjection['queuedInputs'];
  acceptedInputs: Record<string, { messageId: string; replyToInteraction?: { interactionId: string; prompt: string } }>;
  narratives: SessionProjection['narratives'];
  interactions: SessionProjection['interactions'];
  pendingApprovals: NonNullable<SessionProjection['pendingApprovals']>;
  pendingApproval: SessionProjection['pendingApproval'];
  plans: SessionProjection['plans'];
  activePlanRef: SessionProjection['activePlanRef'];
  pendingPlan: SessionProjection['pendingPlan'];
  todoList: SessionProjection['todoList'];
  contextUsage: SessionProjection['contextUsage'];
  contextCompositions: SessionProjection['contextCompositions'];
  tokenUsage: SessionProjection['tokenUsage'];
  tokenUsageHistory: Record<string, SessionProjection['tokenUsageHistory'][number]>;
  runRuntimeSnapshots: Record<string, RunRuntimeSnapshot>;
  runToolViews: Record<string, PreparedRequestToolView>;
  pendingRunSettlements: Record<string, RunSettlement>;
  runRuntimeReleases: Record<
    string,
    Extract<SessionEvent, { type: 'run.runtime.released' }>['payload']
  >;
  providerTurns: Record<string, ProviderTurnState>;
  providerUsageRequestIds: Record<string, true>;
  providerCallFacts: Record<string, ProviderCallFactState>;
  run: SessionProjection['run'];
  activities: Record<string, ActivityProjection>;
  processes: Record<string, ManagedProcessSnapshot>;
  artifacts: Record<string, ArtifactProjection>;
  deliverables: Record<string, DeliverableProjection>;
  terminalError: SessionProjection['terminalError'];
}

export interface ProviderTurnState {
  runId: string;
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  providerRuntimeRef: string;
  outcome: 'completed' | 'failed' | 'indeterminate';
  orderedCallIds?: string[];
  reasoningContent?: string;
  reasoningSignature?: string;
  hostedWebSearchCalls?: Record<string, unknown>[];
  orderedOutputBlocks?: ProviderOutputBlock[];
  toolCallInputs?: ProviderToolCallInput[];
  error?: { code: string; message: string };
  sequence: number;
}

export interface ProviderCallFactState {
  runId: string;
  providerCallId: string;
  toolName: string;
  sequence: number;
}

export function emptySessionState(sessionId: string): SessionState {
  return {
    agentTasks: [], agentChildren: [],
    runTimings: {}, providerAttempts: {}, failureSnapshots: {},
    permissionOverrides: {}, shellAuthorizations: [],
    modelSettings: null,
    sessionId,
    revision: 0,
    display: { creationTitle: '新对话' },
    creationWorkspaceBindings: [],
    sessionDirectoryIndexes: [],
    workspaceBindings: [],
    messages: [],
    queuedInputs: [],
    acceptedInputs: {},
    narratives: [],
    interactions: [],
    pendingApprovals: [],
    pendingApproval: null,
    plans: [],
    activePlanRef: null,
    pendingPlan: null,
    todoList: null,
    contextUsage: null,
    contextCompositions: [],
    tokenUsage: {
      providerCallCount: 0,
      reportedCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheAvailable: false,
      cacheComplete: false,
      cacheHitRatio: null,
    },
    tokenUsageHistory: {},
    runRuntimeSnapshots: {},
    runToolViews: {},
    pendingRunSettlements: {},
    runRuntimeReleases: {},
    providerTurns: {},
    providerUsageRequestIds: {},
    providerCallFacts: {},
    run: null,
    activities: {},
    processes: {},
    artifacts: {},
    deliverables: {},
    terminalError: null,
  };
}

export function reduceSession(previous: SessionState, event: SessionEvent): SessionState {
  if (event.sessionId !== previous.sessionId) throw new Error('session_event_identity_mismatch');
  if (event.sequence !== previous.revision + 1) throw new Error('session_event_sequence_gap');

  const next: SessionState = { ...previous, revision: event.sequence };
  const lifecycleEvent = projectRunLifecycleEvent(event);
  const lifecycle = lifecycleEvent ? reduceRunLifecycle({
    run: previous.run ? { runId: previous.run.runId, status: previous.run.status,
      ...(previous.run.waitingReason ? { waitingReason: previous.run.waitingReason } : {}) } : null,
    pendingInteractions: previous.interactions.filter(item => item.status === 'pending'),
    pendingPlan: previous.pendingPlan,
    pendingApprovals: previous.pendingApprovals,
    pendingApproval: previous.pendingApproval,
  }, lifecycleEvent) : null;

  switch (event.type) {
    case 'provider.attempt.updated': {
      assertRunningRun(next, event.runId, 'provider_attempt_run_not_active');
      const fact = event.payload;
      const previousAttempt = next.providerAttempts[fact.providerAttemptId];
      const related = Object.values(next.providerAttempts).filter((item) => item.providerRequestId === fact.providerRequestId);
      if (!next.contextCompositions.some((item) => item.providerRequestId === fact.providerRequestId && item.runId === event.runId && item.purpose === fact.purpose)) throw new Error('provider_attempt_composition_missing');
      if (fact.phase === 'started') {
        if (previousAttempt || fact.attempt !== related.length + 1 || fact.attempt > 5
          || related.some((item) => !['retryWaiting'].includes(item.phase))) throw new Error('provider_attempt_start_invalid');
      } else if (!previousAttempt || previousAttempt.runId !== event.runId || previousAttempt.providerRequestId !== fact.providerRequestId
        || previousAttempt.attempt !== fact.attempt
        || (fact.phase === 'retryWaiting' ? previousAttempt.phase !== 'failed' : previousAttempt.phase !== 'started')) throw new Error('provider_attempt_transition_invalid');
      next.providerAttempts = { ...next.providerAttempts, [fact.providerAttemptId]: { ...structuredClone(fact), runId: event.runId, updatedAt: event.occurredAt } };
      break;
    }
    case 'run.timing.updated':
      assertCurrentRun(next, event.runId, 'run_timing_run_mismatch');
      next.runTimings = { ...next.runTimings, [event.runId]: { ...structuredClone(event.payload), runId: event.runId } };
      break;
    case 'run.failure.recorded':
      assertCurrentRun(next, event.runId, 'failure_snapshot_run_mismatch');
      if (event.payload.revision > previous.revision) throw new Error('failure_snapshot_revision_invalid');
      next.failureSnapshots = { ...next.failureSnapshots, [event.runId]: structuredClone(event.payload) };
      break;
    case 'input.queued':
      assertCurrentRun(next, event.runId, 'queued_input_run_not_current');
      if (!['running', 'waiting'].includes(next.run!.status)) throw new Error('queued_input_run_not_active');
      if (next.queuedInputs.some((input) => input.messageId === event.payload.messageId)) {
        throw new Error('queued_input_duplicate');
      }
      next.queuedInputs = [...next.queuedInputs, {
        ...event.payload,
        runId: event.runId,
        filesystemReferences: (event.payload.filesystemReferences ?? []).map((reference) => ({ ...reference })),
        pluginSelections: (event.payload.pluginSelections ?? []).map((selection) => ({ ...selection })),
        sequence: event.sequence,
        createdAt: event.occurredAt,
        status: 'queued',
      }];
      break;
    case 'run.host.rebound': {
      const binding = next.run?.hostBinding;
      if (next.run?.runId !== event.runId || next.run.status !== 'waiting'
        || binding?.hostInstanceId !== event.payload.previousBinding.hostInstanceId
        || binding?.windowLabel !== event.payload.previousBinding.windowLabel) throw new Error('host_rebind_state_invalid');
      next.run = { ...next.run, hostBinding: { ...event.payload.hostBinding } };
      next.runToolViews = { ...next.runToolViews, [event.runId]: structuredClone(event.payload.toolView) };
      break;
    }
    case 'run.tools.prepared':
      assertRunningRun(next, event.runId, 'run_tool_view_run_not_active');
      next.runToolViews = { ...next.runToolViews, [event.runId]: structuredClone(event.payload.toolView) };
      break;
    case 'input.accepted': {
      next.acceptedInputs = { ...next.acceptedInputs };
      const queued = next.queuedInputs.find(item => item.commandId === event.payload.commandId);
      const interaction = queued?.interactionId ? next.interactions.find(item => item.interactionId === queued.interactionId) : undefined;
      if (queued?.interactionId && (!interaction || interaction.status !== 'answered')) throw new Error('queued_interaction_response_missing');
      next.acceptedInputs[event.payload.commandId] = { messageId: event.payload.messageId,
        ...(interaction ? { replyToInteraction: { interactionId: interaction.interactionId, prompt: interaction.prompt } } : {}) };
      break;
    }
    case 'session.permissions.updated':
      validatePermissionPatches(event.payload.patches);
      next.permissionOverrides = { ...next.permissionOverrides, ...event.payload.patches };
      break;
    case 'approval.revoked':
      next.shellAuthorizations = next.shellAuthorizations.filter(grant => grant.authorityId !== event.payload.authorityId);
      break;
    case 'approval.reviewed': {
      if (!next.pendingApprovals.some(item => item.approvalId === event.payload.approvalId && item.callId === event.callId)) throw new Error('approval_review_request_missing');
      const review = { decision: event.payload.decision, reason: event.payload.reason };
      next.pendingApprovals = next.pendingApprovals.map(item => item.approvalId === event.payload.approvalId
        ? { ...item, preview: { ...item.preview, review } } : item);
      const activityId = approvalActivityId(event.payload.approvalId);
      next.activities = { ...next.activities, [activityId]: { ...next.activities[activityId], approvalReview: review } };
      break;
    }
    case 'session.model-settings.updated':
      next.modelSettings = { ...event.payload.settings };
      break;
    case 'session.subagent-settings.updated':
      next.subagentSettings = structuredClone(event.payload.settings);
      break;
    case 'session.created':
      if (event.payload.subagentSettings) next.subagentSettings = structuredClone(event.payload.subagentSettings);
      if (event.payload.recipe) next.recipe = structuredClone(event.payload.recipe);
      next.permissionOverrides = structuredClone(event.payload.recipe?.permissions ?? {});
      if (event.payload.agentContext) next.agentContext = structuredClone(event.payload.agentContext);
      next.modelSettings = event.payload.profileId
        ? { profileId: event.payload.profileId, reasoningEffortOverride: event.payload.recipe?.reasoningEffort ?? null } : null;
      next.display = { creationTitle: event.payload.displayTitle };
      next.creationWorkspaceBindings = event.payload.workspaceBindings.map((binding) => ({ ...binding }));
      next.sessionDirectoryIndexes = [];
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      break;
    case 'session.workspaces.updated': {
      next.creationWorkspaceBindings = structuredClone(event.payload.baseBindings);
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      if (JSON.stringify(next.workspaceBindings) !== JSON.stringify(event.payload.workspaceBindings)) throw new Error('session_workspace_bindings_mismatch');
      if (next.run && ['running', 'waiting'].includes(next.run.status)) {
        next.run = { ...next.run, workspaceBindings: structuredClone(next.workspaceBindings) };
      }
      break;
    }
    case 'session.directory-index.attached':
      next.sessionDirectoryIndexes = [...next.sessionDirectoryIndexes];
      if (next.workspaceBindings.some((binding) => (
        binding.workspaceId === event.payload.workspaceBinding.workspaceId
      ))) throw new Error('session_directory_index_duplicate');
      next.sessionDirectoryIndexes.push({ ...event.payload.workspaceBinding });
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      if (next.run && ['running', 'waiting'].includes(next.run.status)) {
        next.run = { ...next.run, workspaceBindings: structuredClone(next.workspaceBindings) };
      }
      break;
    case 'session.directory-index.detached': {
      const before = next.sessionDirectoryIndexes.length;
      next.sessionDirectoryIndexes = next.sessionDirectoryIndexes.filter((binding) => (
        binding.workspaceId !== event.payload.workspaceId
      ));
      if (next.sessionDirectoryIndexes.length === before) {
        throw new Error('session_directory_index_missing');
      }
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      if (next.run && ['running', 'waiting'].includes(next.run.status)) {
        next.run = { ...next.run, workspaceBindings: structuredClone(next.workspaceBindings) };
      }
      break;
    }
    case 'run.started':
      next.activities = { ...next.activities };
      next.tokenUsageHistory = { ...next.tokenUsageHistory };
      next.runRuntimeSnapshots = { ...next.runRuntimeSnapshots };
      {
        const inputMessage = next.messages.find((message) => (
          message.messageId === event.payload.inputMessageId && message.role === 'user'
        ));
        if (!inputMessage) throw new Error('run_input_message_missing');
        next.tokenUsageHistory[event.runId] = {
          runId: event.runId,
          inputMessageId: event.payload.inputMessageId,
          title: inputMessage.content.trim() ? inputMessage.content
            : inputMessage.filesystemReferences.map((reference) => reference.displayName).join(', '),
          sequence: event.sequence,
          startedAt: event.occurredAt,
          providerCallCount: 0,
          reportedCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheAvailable: false,
          cacheComplete: false,
          cacheHitRatio: null,
        };
        if (next.runRuntimeSnapshots[event.runId]) {
          throw new Error('run_runtime_snapshot_duplicate');
        }
        next.runRuntimeSnapshots[event.runId] = cloneRunRuntimeSnapshot(
          event.payload.runtimeSnapshot,
        );
      }
      next.run = {
        ...lifecycle!.run!,
        ...(event.payload.runtimeSnapshot.environment.hostBinding
          ? { hostBinding: structuredClone(event.payload.runtimeSnapshot.environment.hostBinding) as unknown as NonNullable<RunProjection['hostBinding']> } : {}),
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        profileId: event.payload.runtimeSnapshot.provider.profileId,
      };
      next.terminalError = null;
      next.activities[runActivityId(event.runId)] = {
        activityId: runActivityId(event.runId),
        kind: 'run',
        status: 'active',
        label: 'Agent run',
        runId: event.runId,
        sequence: event.sequence,
      };
      break;
    case 'message.committed':
      next.messages = [...next.messages];
      next.acceptedInputs = { ...next.acceptedInputs };
      {
        next.queuedInputs = next.queuedInputs.filter((input) => input.messageId !== event.payload.messageId);
        const acceptedInput = Object.entries(next.acceptedInputs).find(([, input]) => input.messageId === event.payload.messageId);
        const replyToInteraction = acceptedInput?.[1].replyToInteraction;
        if (replyToInteraction && event.payload.role !== 'user') throw new Error('interaction_response_role_invalid');
        if (acceptedInput) delete next.acceptedInputs[acceptedInput[0]];
        const common = {
          messageId: event.payload.messageId,
          content: event.payload.content,
          ...(event.payload.guidanceReferences?.length ? {guidanceReferences:structuredClone(event.payload.guidanceReferences)} : {}),
          filesystemReferences: (event.payload.filesystemReferences ?? []).map((reference) => ({
            ...reference,
          })),
          pluginSelections: (event.payload.pluginSelections ?? []).map((selection) => ({
            ...selection,
          })),
          feedback: null,
          sequence: event.sequence,
          createdAt: event.occurredAt,
          ...(replyToInteraction ? { replyToInteraction: { ...replyToInteraction } } : {}),
        };
        if (event.payload.role === 'assistant') {
          if (!event.runId) throw new Error('assistant_message_run_identity_missing');
          const turn = requiredProviderTurn(
            next,
            event.runId,
            event.payload.providerRequestId,
            'agent',
          );
          assertProviderMessageReference(
            turn,
            'finalMessage',
            event.payload.messageId,
            event.payload.content,
          );
          next.messages.push({
            ...common,
            role: 'assistant',
            runId: event.runId,
            providerRequestId: event.payload.providerRequestId,
          });
        } else {
          if (event.payload.role === 'user' && event.runId && event.payload.filesystemReferences?.length) {
            assertRunningRun(next, event.runId, 'input_resources_run_not_active');
          }
          next.messages.push({
            ...common,
            role: event.payload.role,
            ...(event.runId ? { runId: event.runId } : {}),
          });
        }
      }
      break;
    case 'message.feedback.updated': {
      next.messages = [...next.messages];
      const index = next.messages.findIndex((message) => message.messageId === event.payload.messageId);
      if (index < 0 || next.messages[index].role !== 'assistant') {
        throw new Error('message_feedback_target_missing');
      }
      next.messages[index] = { ...next.messages[index], feedback: event.payload.feedback };
      break;
    }
    case 'narrative.committed':
      next.narratives = [...next.narratives];
      assertProviderMessageReference(
        requiredProviderTurn(next, event.runId, event.payload.providerRequestId, 'agent'),
        'narrative',
        event.payload.narrativeId,
        event.payload.content,
      );
      next.narratives.push({
        narrativeId: event.payload.narrativeId,
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        content: event.payload.content,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'interaction.requested':
      next.activities = { ...next.activities };
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        SESSION_CONTROL_INTERACTION_REQUEST,
        event.sequence,
      );
      if (next.interactions.some(item => item.interactionId === event.payload.interactionId)) throw new Error('interaction_duplicate');
      next.interactions = [...next.interactions, {
        interactionId: event.payload.interactionId,
        runId: event.runId,
        callId: event.callId,
        kind: event.payload.kind,
        prompt: event.payload.prompt,
        allowFreeform: event.payload.allowFreeform,
        ...(event.payload.mode ? { mode: event.payload.mode } : {}),
        status: 'pending',
        ...(event.payload.options
          ? { options: event.payload.options.map((option) => ({ ...option })) }
          : {}),
        sequence: event.sequence,
        createdAt: event.occurredAt,
      }];
      next.activities[interactionActivityId(event.payload.interactionId)] = {
        activityId: interactionActivityId(event.payload.interactionId),
        kind: 'interaction',
        status: 'waiting',
        label: event.payload.prompt,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    case 'interaction.resolved': {
      const interaction = next.interactions.find(item => item.interactionId === event.payload.interactionId
        && item.runId === event.runId && item.status === 'pending');
      if (!interaction) throw new Error('interaction_request_missing');
      next.acceptedInputs = { ...next.acceptedInputs };
      const input = next.acceptedInputs[event.payload.commandId];
      const queued = next.queuedInputs.find(item => item.commandId === event.payload.commandId
        && item.interactionId === interaction.interactionId && item.text === event.payload.response);
      if (!input && !queued) throw new Error('interaction_response_input_missing');
      if (input) next.acceptedInputs[event.payload.commandId] = { ...input, replyToInteraction: {
        interactionId: interaction.interactionId, prompt: interaction.prompt,
      } };
      next.interactions = next.interactions.map(item => item === interaction
        ? { ...item, status: 'answered', response: event.payload.response } : item);
      settleActivity(next, interactionActivityId(event.payload.interactionId), 'completed');
      break;
    }
    case 'plan.published': {
      next.plans = [...next.plans];
      next.activities = { ...next.activities };
      if (findPlanIndex(next, event.payload.planId, event.payload.revision) >= 0) {
        throw new Error('plan_revision_duplicate');
      }
      const plan = projectPlan(event);
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        SESSION_CONTROL_PLAN_PUBLISH,
        event.sequence,
      );
      next.plans.push(plan);
      next.pendingPlan = { ...clonePlanProjection(plan), responseMode: 'confirmReviseOrCancel' };
      next.activities[planActivityId(event.payload.planId, event.payload.revision)] = {
        activityId: planActivityId(event.payload.planId, event.payload.revision),
        kind: 'plan',
        status: 'waiting',
        label: event.payload.title,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    }
    case 'plan.review.requested':
      updatePlan(next, event.payload.planId, event.payload.revision, plan => ({ ...plan,
        review: { status: 'reviewing', providerRequestId: event.payload.providerRequestId }, updatedAt: event.occurredAt }));
      break;
    case 'plan.reviewed':
      updatePlan(next, event.payload.planId, event.payload.revision, plan => ({ ...plan,
        review: { status: 'completed', providerRequestId: event.payload.providerRequestId,
          decision: event.payload.decision, reason: event.payload.reason,
          ...(event.payload.error ? { error: structuredClone(event.payload.error) } : {}) }, updatedAt: event.occurredAt }));
      break;
    case 'plan.confirmed':
      if (
        !next.pendingPlan
        || next.pendingPlan.planId !== event.payload.planId
        || next.pendingPlan.revision !== event.payload.revision
        || next.pendingPlan.runId !== event.runId
        || next.pendingPlan.callId !== event.callId
      ) throw new Error('plan_request_missing');
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'confirmed',
        confirmationSource: event.payload.source ?? 'user',
        decisionId: event.payload.decisionId,
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      next.activePlanRef = {
        planId: event.payload.planId,
        revision: event.payload.revision,
      };
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'completed',
      );
      break;
    case 'plan.revision.requested':
      assertPendingPlan(next, event);
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'revisionRequested',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'completed',
      );
      break;
    case 'plan.cancelled':
      assertPendingPlan(next, event);
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'cancelled',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'cancelled',
      );
      break;
    case 'plan.superseded':
      if (!['confirmed', 'revisionRequested'].includes(
        planFor(next, event.payload.planId, event.payload.revision).status,
      )) throw new Error('plan_supersede_state_invalid');
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'superseded',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      break;
    case 'plan.invalidated':
      if (!['published', 'confirmed', 'revisionRequested'].includes(
        planFor(next, event.payload.planId, event.payload.revision).status,
      )) throw new Error('plan_invalidation_state_invalid');
      {
        updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
          ...plan,
          status: 'invalidated',
          sequence: event.sequence,
          updatedAt: event.occurredAt,
        }));
        if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
        if (samePlanRef(next.pendingPlan, event.payload)) next.pendingPlan = null;
        settleActivity(
          next,
          planActivityId(event.payload.planId, event.payload.revision),
          'failed',
        );
      }
      break;
    case 'artifacts.presented': {
      assertRunningRun(next, event.runId, 'artifact_presentation_run_not_active');
      recordProviderCallFact(next, event.callId, event.runId, event.payload.providerCallId, 'artifact.present', event.sequence);
      next.deliverables = advanceDeliverables(next, event);
      break;
    }
    case 'todo.updated': {
      assertRunningRun(next, event.runId, 'todo_run_not_active');
      if (Boolean(event.callId) !== Boolean(event.payload.providerCallId)) throw new Error('todo_call_identity_invalid');
      if (event.callId && event.payload.providerCallId) {
        recordProviderCallFact(next, event.callId, event.runId, event.payload.providerCallId, 'todo.update', event.sequence);
      }
      next.todoList = advanceTodoList(next.todoList, event);
      break;
    }
    case 'tool.requested': {
      next.activities = { ...next.activities };
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        event.payload.toolName,
        event.sequence,
      );
      next.activities[toolActivityId(event.callId)] = {
        activityId: toolActivityId(event.callId),
        kind: 'tool',
        status: 'requested',
        label: event.payload.toolName,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      const computer = computerRequest(event.payload.toolName, event.payload.input);
      if (computer) next.activities[toolActivityId(event.callId)].tool = {
        operation: event.payload.toolName, resources: [], computer,
      };
      break;
    }
    case 'tool.started': {
      next.activities = { ...next.activities };
      const activity = next.activities[toolActivityId(event.callId)];
      if (!activity || activity.status !== 'requested') throw new Error('tool_started_without_request');
      next.activities[activity.activityId] = { ...activity, status: 'active', startedAt: event.payload.startedAt };
      break;
    }
    case 'approval.requested': {
      const previousApproval = next.pendingApprovals.find(item => item.callId === event.callId);
      if (previousApproval) settleActivity(next, approvalActivityId(previousApproval.approvalId), 'cancelled');
      next.activities = { ...next.activities };
      const approval = {
        approvalId: event.payload.approvalId,
        runId: event.runId,
        callId: event.callId,
        preview: {
          ...event.payload.preview,
          summary: event.payload.preview.summary,
          effects: [...event.payload.preview.effects],
          logicalTargets: [...event.payload.preview.logicalTargets],
        },
        sequence: event.sequence,
        createdAt: event.occurredAt,
      };
      next.pendingApprovals = [...next.pendingApprovals.filter(item => item.callId !== event.callId), approval];
      next.activities[approvalActivityId(event.payload.approvalId)] = {
        activityId: approvalActivityId(event.payload.approvalId),
        kind: 'approval',
        status: 'waiting',
        label: event.payload.preview.summary,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    }
    case 'approval.resolved': {
      const approval = next.pendingApprovals.find(item => item.callId === event.callId);
      if (
        !approval
        || approval.approvalId !== event.payload.approvalId
        || approval.callId !== event.callId
        || approval.runId !== event.runId
      ) throw new Error('approval_request_missing');
      if (event.payload.decision === 'allow' && event.payload.authorizationScope && approval.preview.authorizationContext) {
        next.shellAuthorizations = [...next.shellAuthorizations, { authorityId: event.payload.authorityId,
          runId: event.runId, scope: event.payload.authorizationScope, summary: approval.preview.summary,
          context: structuredClone(approval.preview.authorizationContext) }];
      }
      next.pendingApprovals = next.pendingApprovals.filter(item => item.callId !== event.callId);
      settleActivity(next, approvalActivityId(event.payload.approvalId), event.payload.decision === 'allow' ? 'completed' : 'denied');
      break;
    }
    case 'tool.input-rejected': {
      const approval = next.pendingApprovals.find(item => item.callId === event.callId);
      if (approval) settleActivity(next, approvalActivityId(approval.approvalId), 'cancelled');
      next.pendingApprovals = next.pendingApprovals.filter(item => item.callId !== event.callId);
      settleActivity(next, toolActivityId(event.callId), 'rejected');
      next.activities[toolActivityId(event.callId)] = {
        ...next.activities[toolActivityId(event.callId)],
        inputRejection: structuredClone(event.payload.rejection.error),
      };
      delete next.activities[toolActivityId(event.callId)].tool;
      break;
    }
    case 'process.updated': {
      next.processes = { ...next.processes, [event.payload.job.jobId]: structuredClone(event.payload.job) };
      projectProcess(next, event.payload.job);
      break;
    }
    case 'tool.completed': {
      const approval = next.pendingApprovals.find(item => item.callId === event.callId);
      if (approval) settleActivity(next, approvalActivityId(approval.approvalId), 'completed');
      next.pendingApprovals = next.pendingApprovals.filter(item => item.callId !== event.callId);
      settleActivity(
        next,
        toolActivityId(event.callId),
        event.payload.record.outcome,
      );
      const { tool, artifacts } = projectToolRecord(event.payload.record, next.activities);
      next.activities[toolActivityId(event.callId)] = {
        ...next.activities[toolActivityId(event.callId)],
        tool,
      };
      const record = event.payload.record;
      if (record.preparedEffect.providerRef === 'deepcode:processes' && record.input.action === 'start'
        && record.outcome === 'completed' && isRecord(record.output)) {
        const initial = record.output.job;
        if (isManagedProcessSnapshot(initial) && initial.callId === event.callId && initial.runId === event.runId
          && initial.sessionId === event.sessionId && !next.processes[initial.jobId]) {
          next.processes = { ...next.processes, [initial.jobId]: structuredClone(initial) };
        }
      }
      const job = Object.values(next.processes).find(job => job.callId === event.callId);
      if (job) projectProcess(next, job);
      next.artifacts = { ...next.artifacts };
      for (const artifact of artifacts) {
        next.artifacts[artifact.artifactId] = artifact;
      }
      break;
    }
    case 'tool.not-executed': {
      const approval = next.pendingApprovals.find(item => item.callId === event.callId);
      if (approval) settleActivity(next, approvalActivityId(approval.approvalId), 'cancelled');
      settleActivity(next, toolActivityId(event.callId), event.payload.reason === 'cancelled' ? 'cancelled' : 'rejected');
      next.activities[toolActivityId(event.callId)] = { ...next.activities[toolActivityId(event.callId)],
        notExecuted: { reason: event.payload.reason, ...(event.payload.predecessorCallId ? { predecessorCallId: event.payload.predecessorCallId } : {}) } };
      next.pendingApprovals = next.pendingApprovals.filter(item => item.callId !== event.callId);
      break;
    }
    case 'tool.interrupted':
      if (!next.runRuntimeReleases[event.runId]
        || !['requested', 'active'].includes(next.activities[toolActivityId(event.callId)]?.status ?? '')) {
        throw new Error('tool_interruption_state_invalid');
      }
      settleActivity(next, toolActivityId(event.callId), 'indeterminate');
      next.activities[toolActivityId(event.callId)] = {
        ...next.activities[toolActivityId(event.callId)],
        interruption: { ...event.payload.error },
      };
      break;
    case 'agent.task.created':
      assertRunningRun(next, event.runId, 'agent_task_run_not_active');
      Object.assign(next, reduceAgentLifetime(next, event));
      recordAgentActivity(next, event, 'started');
      break;
    case 'agent.task.started':
    case 'agent.task.completed':
    case 'agent.closed':
      Object.assign(next, reduceAgentLifetime(next, event));
      if (event.type === 'agent.task.completed') recordAgentActivity(next, event, 'completed');
      break;
    case 'agent.control.completed':
    case 'session.control.completed':
      assertRunningRun(next, event.runId, 'agent_control_run_not_active');
      recordProviderCallFact(next, event.callId, event.runId, event.payload.providerCallId,
        event.type === 'agent.control.completed' ? SESSION_CONTROL_AGENT : SESSION_CONTROL_SESSION, event.sequence);
      break;
    case 'wake.scheduled':
    case 'wake.cancelled':
    case 'wake.triggered':
      if (next.run?.runId !== event.runId || !['running', 'waiting'].includes(next.run.status)) throw new Error('wake_run_not_active');
      break;
    case 'agent.message.received':
      if (next.run?.runId !== event.runId || !['running', 'waiting'].includes(next.run.status)) throw new Error('agent_message_run_not_active');
      recordAgentMessageActivity(next, event);
      break;
    case 'session.plugins.activated':
      assertRunningRun(next, event.runId, 'plugin_activation_run_not_active');
      recordProviderCallFact(next, event.callId, event.runId, event.payload.providerCallId,
        SESSION_CONTROL_PLUGIN_ACTIVATE, event.sequence);
      break;
    case 'session.control.rejected':
      next.activities = { ...next.activities };
      assertRunningRun(next, event.runId, 'session_control_rejection_run_not_active');
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        event.payload.toolName,
        event.sequence,
      );
      if (event.payload.error.code !== 'plan_revision_unchanged') {
        next.activities[toolActivityId(event.callId)] = {
          activityId: toolActivityId(event.callId),
          kind: 'tool',
          status: 'rejected',
          label: event.payload.toolName,
          runId: event.runId,
          callId: event.callId,
          sequence: event.sequence,
          inputRejection: {
            ...event.payload.error,
            issues: [{ path: '$', rule: 'session_control_schema', message: event.payload.error.message }],
          },
        };
      }
      break;
    case 'context.compaction.requested':
      assertRunningRun(next, event.runId, 'context_compaction_run_not_active');
      break;
    case 'context.compacted':
      assertRunningRun(next, event.runId, 'context_compaction_run_not_active');
      requiredProviderTurn(
        next,
        event.runId,
        event.payload.providerRequestId,
        'contextCompaction',
      );
      break;
    case 'context.composed':
      next.contextCompositions = [...next.contextCompositions];
      assertRunningRun(next, event.runId, 'provider_request_run_not_active');
      if (next.contextCompositions.some((receipt) => (
        receipt.providerRequestId === event.payload.providerRequestId
      ))) throw new Error('provider_request_receipt_duplicate');
      validateContextPartitions(event.payload.partitions);
      next.contextCompositions.push({
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        ...(event.payload.kernelCatalogSnapshotRef ? { kernelCatalogSnapshotRef: event.payload.kernelCatalogSnapshotRef } : {}),
        purpose: event.payload.purpose,
        responseConstraint: event.payload.responseConstraint,
        dynamicInstructionBytes: event.payload.dynamicInstructionBytes,
        messages: event.payload.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => ({ ...block })),
          filesystemReferences: message.filesystemReferences.map((reference) => ({
            ...reference,
          })),
        })),
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        tools: event.payload.tools.map((tool) => ({ ...tool })),
        partitions: event.payload.partitions.map((partition) => ({ ...partition })),
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'provider.turn.settled': {
      next.activities = { ...next.activities };
      next.providerTurns = { ...next.providerTurns };
      next.tokenUsageHistory = { ...next.tokenUsageHistory };
      assertRunningRun(next, event.runId, 'provider_turn_run_not_active');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (event.payload.providerRuntimeRef !== providerRuntimeForPurpose(runtime, event.payload.purpose).providerRuntimeRef) {
        throw new Error('provider_turn_runtime_identity_mismatch');
      }
      const receipt = next.contextCompositions.find((candidate) => (
        candidate.runId === event.runId
        && candidate.providerRequestId === event.payload.providerRequestId
      ));
      if (!receipt || receipt.purpose !== event.payload.purpose) {
        throw new Error('provider_turn_composition_missing');
      }
      if (next.providerTurns[event.payload.providerRequestId]) {
        throw new Error('provider_turn_completion_duplicate');
      }
      const currentTurnCallFacts = Object.entries(next.providerCallFacts)
        .filter(([, fact]) => (
          fact.runId === event.runId
          && fact.sequence > receipt.sequence
          && fact.sequence < event.sequence
        ))
        .sort((left, right) => left[1].sequence - right[1].sequence);
      const currentTurnCallIds = currentTurnCallFacts.map(([callId]) => callId);
      const settlement = event.payload;
      if (settlement.outcome === 'completed') {
        if (new Set(settlement.orderedCallIds).size !== settlement.orderedCallIds.length) {
          throw new Error('provider_turn_call_order_invalid');
        }
        if (
          currentTurnCallIds.length !== settlement.orderedCallIds.length
          || currentTurnCallIds.some((callId, index) => (
            callId !== settlement.orderedCallIds[index]
          ))
        ) {
          throw new Error('provider_turn_call_order_mismatch');
        }
        if (settlement.toolCallInputs) {
          const accepted = settlement.toolCallInputs.filter((call) => !call.error);
          if (settlement.orderedOutputBlocks || accepted.length !== currentTurnCallFacts.length
            || accepted.some((call, index) => {
              const fact = currentTurnCallFacts[index];
              return !fact || fact[0] !== call.callId || fact[1].providerCallId !== call.providerCallId
                || fact[1].toolName !== call.toolName;
            })) throw new Error('provider_turn_call_identity_mismatch');
        }
        if (settlement.orderedOutputBlocks !== undefined) {
          validateOrderedProviderOutputBlocks(
            settlement.orderedOutputBlocks,
            settlement.orderedCallIds,
          );
          const orderedToolCalls = settlement.orderedOutputBlocks.filter((block) => (
            block.kind === 'toolCall'
          ));
          if (orderedToolCalls.some((block, index) => {
            const fact = currentTurnCallFacts[index];
            return !fact
              || fact[0] !== block.callId
              || fact[1].providerCallId !== block.providerCallId
              || fact[1].toolName !== block.toolName;
          })) {
            throw new Error('provider_turn_call_identity_mismatch');
          }
          if (settlement.purpose !== 'agent') {
            throw new Error('provider_output_blocks_purpose_invalid');
          }
          if (
            settlement.orderedOutputBlocks.some((block) => block.kind === 'providerHosted')
            && runtime.webSearch.owner !== 'providerHosted'
          ) {
            throw new Error('provider_hosted_search_owner_mismatch');
          }
        }
      } else if (currentTurnCallIds.length > 0) {
        throw new Error('provider_turn_terminal_call_facts_invalid');
      }
      next.providerTurns[event.payload.providerRequestId] = {
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        purpose: event.payload.purpose,
        providerRuntimeRef: event.payload.providerRuntimeRef,
        outcome: event.payload.outcome,
        ...(event.payload.outcome === 'completed'
          ? {
              orderedCallIds: [...event.payload.orderedCallIds],
              ...(event.payload.toolCallInputs ? { toolCallInputs: structuredClone(event.payload.toolCallInputs) } : {}),
              ...(event.payload.reasoningContent !== undefined
                ? { reasoningContent: event.payload.reasoningContent }
                : {}),
              ...(event.payload.reasoningSignature !== undefined
                ? { reasoningSignature: event.payload.reasoningSignature }
                : {}),
              ...(event.payload.hostedWebSearchCalls !== undefined
                ? {
                    hostedWebSearchCalls: event.payload.hostedWebSearchCalls
                      .map((item) => structuredClone(item)),
                  }
                : {}),
              ...(event.payload.orderedOutputBlocks !== undefined
                ? {
                    orderedOutputBlocks: event.payload.orderedOutputBlocks.map((block) => ({
                      ...block,
                      item: structuredClone(block.item),
                    })),
                  }
                : {}),
            }
          : { error: { ...event.payload.error } }),
        sequence: event.sequence,
      };
      if (settlement.outcome === 'completed') {
        for (const call of settlement.toolCallInputs ?? []) {
          if (!call.error) continue;
          if (next.providerCallFacts[call.callId] || next.activities[toolActivityId(call.callId)]) {
            throw new Error('provider_turn_rejected_call_identity_duplicate');
          }
          next.activities[toolActivityId(call.callId)] = {
            activityId: toolActivityId(call.callId), kind: 'tool', status: 'rejected',
            label: call.toolName, runId: event.runId, callId: call.callId, sequence: event.sequence,
            inputRejection: structuredClone(call.error),
          };
        }
        for (const block of settlement.orderedOutputBlocks ?? []) {
          if (block.kind === 'toolCallRejected') {
            if (next.providerCallFacts[block.callId] || next.activities[toolActivityId(block.callId)]) {
              throw new Error('provider_turn_rejected_call_identity_duplicate');
            }
            next.activities[toolActivityId(block.callId)] = {
              activityId: toolActivityId(block.callId),
              kind: 'tool',
              status: 'rejected',
              label: block.toolName,
              runId: event.runId,
              callId: block.callId,
              sequence: event.sequence,
              inputRejection: structuredClone(block.error),
            };
          }
          if (block.kind !== 'providerHosted') continue;
          const status = block.item.status;
          const action = block.item.action;
          if (
            status !== 'completed' && status !== 'failed'
            || action !== undefined && !isRecord(action)
          ) throw new Error('provider_hosted_search_item_invalid');
          next.activities[block.activityId] = {
            activityId: block.activityId,
            kind: 'providerHosted',
            status,
            label: 'web.search',
            runId: event.runId,
            sequence: event.sequence,
            providerHosted: {
              providerToolType: block.providerToolType,
              providerCallId: block.providerCallId,
              ...(action === undefined ? {} : { action: structuredClone(action) }),
            },
          };
        }
      }
      next.tokenUsage = withProviderCompletion(next.tokenUsage);
      const runUsage = next.tokenUsageHistory[event.runId];
      if (!runUsage) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = withProviderCompletion(runUsage);
      // Auxiliary calls retain their own receipts and billing totals.
      if (settlement.purpose === 'agent') next.contextUsage = null;
      break;
    }
    case 'context.updated': {
      next.contextCompositions = [...next.contextCompositions];
      next.providerUsageRequestIds = { ...next.providerUsageRequestIds };
      next.tokenUsageHistory = { ...next.tokenUsageHistory };
      assertRunningRun(next, event.runId, 'provider_usage_run_not_active');
      const providerRequestId = event.payload.providerRequestId;
      const turn = requiredProviderTurn(next, event.runId, providerRequestId);
      const provider = providerRuntimeForPurpose(requiredRunRuntimeSnapshot(next, event.runId), turn.purpose);
      if (
        event.payload.providerRuntimeRef !== provider.providerRuntimeRef
        || event.payload.contextWindowTokens !== provider.contextWindowTokens
      ) {
        throw new Error('provider_usage_runtime_identity_mismatch');
      }
      const cacheReadPresent = event.payload.cacheReadInputTokens !== undefined;
      const cacheMissPresent = event.payload.cacheMissInputTokens !== undefined;
      if (
        cacheReadPresent !== cacheMissPresent
        || cacheReadPresent
          && addTokenCount(
            event.payload.cacheReadInputTokens!,
            event.payload.cacheMissInputTokens!,
          ) !== event.payload.inputTokens
      ) {
        throw new Error('provider_usage_cache_invalid');
      }
      if (next.providerUsageRequestIds[providerRequestId]) {
        throw new Error('provider_usage_duplicate');
      }
      const receiptIndex = next.contextCompositions.findIndex((receipt) => (
        receipt.runId === event.runId
        && receipt.providerRequestId === providerRequestId
      ));
      if (receiptIndex < 0) throw new Error('provider_request_receipt_missing');
      next.providerUsageRequestIds[providerRequestId] = true;
      const receipt = next.contextCompositions[receiptIndex];
      next.contextCompositions[receiptIndex] = {
        ...receipt,
        partitions: estimatePartitionTokens(receipt.partitions, event.payload.inputTokens),
      };
      if (turn.purpose === 'agent') next.contextUsage = {
        ...event.payload,
        providerRequestId,
        runId: event.runId,
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      };
      next.tokenUsage = withProviderUsage(next.tokenUsage, event.payload);
      const runUsage = next.tokenUsageHistory[event.runId];
      if (!runUsage) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = withProviderUsage(runUsage, event.payload);
      break;
    }
    case 'run.waiting':
      assertCurrentRun(next, event.runId, 'run_workspace_snapshot_missing');
      break;
    case 'run.finishing':
      next.pendingRunSettlements = { ...next.pendingRunSettlements };
      assertCurrentRun(next, event.runId, 'run_finishing_identity_mismatch');
      if (
        next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['running', 'waiting'].includes(next.run!.status)
      ) throw new Error('run_finishing_state_invalid');
      if (event.payload.outcome === 'completed' && next.interactions.some(item => item.runId === event.runId && item.status === 'pending')) {
        throw new Error('run_finishing_unanswered_interaction');
      }
      next.pendingRunSettlements[event.runId] = cloneRunSettlement(event.payload);
      next.activePlanRef = null;
      closeInteractions(next, event.runId);
      next.pendingApprovals = [];
      next.pendingApproval = null;
      break;
    case 'run.runtime.release_failed': {
      assertCurrentRun(next, event.runId, 'run_runtime_release_failure_identity_mismatch');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (
        !next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['releasing', 'releaseFailed'].includes(next.run!.status)
        || event.payload.runRuntimeSnapshotRef !== runtime.runRuntimeSnapshotRef
        || event.payload.extensionGenerationRef !== runtime.extensionGenerationRef
        || event.payload.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef
        || event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef
      ) throw new Error('run_runtime_release_failure_state_invalid');
      next.terminalError = { ...event.payload.error };
      break;
    }
    case 'run.runtime.released': {
      next.runRuntimeReleases = { ...next.runRuntimeReleases };
      assertCurrentRun(next, event.runId, 'run_runtime_release_identity_mismatch');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (
        !next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['releasing', 'releaseFailed'].includes(next.run!.status)
        || event.payload.runRuntimeSnapshotRef !== runtime.runRuntimeSnapshotRef
        || event.payload.extensionGenerationRef !== runtime.extensionGenerationRef
        || event.payload.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef
        || event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef
        || new Set(event.payload.pluginInstanceRefs).size !== event.payload.pluginInstanceRefs.length
        || event.payload.pluginInstanceRefs.some((pluginInstanceRef) => (
          !(next.runToolViews[event.runId] ?? runtime).selectedPlugins.plugins.some((plugin) => (
            plugin.pluginInstanceRef === pluginInstanceRef
          ))
        ))
      ) throw new Error('run_runtime_release_receipt_invalid');
      next.runRuntimeReleases[event.runId] = {
        ...event.payload,
        pluginInstanceRefs: [...event.payload.pluginInstanceRefs],
      };
      next.terminalError = null;
      break;
    }
    case 'run.settled':
      assertCurrentRun(next, event.runId, 'run_workspace_snapshot_missing');
      next.shellAuthorizations = next.shellAuthorizations.filter(grant => grant.runId !== event.runId || isSessionAuthorizationScope(grant.scope));
      next.tokenUsageHistory = { ...next.tokenUsageHistory };
      next.pendingRunSettlements = { ...next.pendingRunSettlements };
      // Session admission enforces tool closure for new settlements. Replaying
      // stored failures must preserve unfinished calls, not hide the entire run.
      if (
        !next.pendingRunSettlements[event.runId]
        || !next.runRuntimeReleases[event.runId]
        || !sameRunSettlement(next.pendingRunSettlements[event.runId], event.payload)
      ) throw new Error('run_settlement_release_receipt_missing');
      if (!next.tokenUsageHistory[event.runId]) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = {
        ...next.tokenUsageHistory[event.runId],
        completedAt: event.occurredAt,
        outcome: event.payload.outcome,
      };
      closeInteractions(next, event.runId);
      next.pendingApprovals = [];
      next.pendingApproval = null;
      settleActivity(next, runActivityId(event.runId), event.payload.outcome);
      next.terminalError = event.payload.outcome === 'failed'
        || event.payload.outcome === 'indeterminate'
        ? { ...event.payload.error }
        : null;
      delete next.pendingRunSettlements[event.runId];
      break;
  }
  if (lifecycle?.run && next.run) {
    const { waitingReason: _waitingReason, ...run } = next.run;
    next.run = { ...run, ...lifecycle.run };
  }
  if (next.run) {
    const provider = requiredRunRuntimeSnapshot(next, next.run.runId).provider;
    // Lifecycle transitions preserve the explicitly selected GUI target.
    const binding = event.type === 'run.started' || event.type === 'run.host.rebound'
      ? next.run.hostBinding : previous.run?.hostBinding;
    next.run = {
      ...next.run,
      ...(binding ? { hostBinding: { ...binding } } : {}),
      ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
      ...(provider.thinking ? { thinking: provider.thinking } : {}),
    };
  }
  next.pendingApproval = next.pendingApprovals[0] ?? null;
  return next;
}

function recordAgentActivity(state: SessionState,
  event: Extract<SessionEvent, { type: 'agent.task.created' | 'agent.task.completed' }>,
  phase: 'started' | 'completed'): void {
  const task = state.agentTasks.find(task => task.taskId === event.payload.taskId)!;
  const activityId = `agent:${task.taskId}:${phase}`;
  state.activities = {
    ...state.activities,
    [activityId]: {
      activityId, kind: 'agent', label: task.displayName, runId: event.runId,
      sequence: event.sequence, status: phase === 'started' ? 'completed' : task.result!.outcome,
      agent: { taskId: task.taskId, agentSessionId: task.agentSessionId, phase },
    },
  };
}

function recordAgentMessageActivity(state: SessionState,
  event: Extract<SessionEvent, { type: 'agent.message.received' }>): void {
  const child = state.agentChildren.find(child => child.agentSessionId === event.payload.sourceSessionId);
  if (!child) return; // Parent and peer messages are not child status notifications in this Session.
  const activityId = `agent:message:${event.sequence}`;
  state.activities = { ...state.activities, [activityId]: {
    activityId, kind: 'agent', label: child.displayName, runId: event.runId,
    sequence: event.sequence, status: 'completed',
    agent: { agentSessionId: child.agentSessionId, phase: 'updated' },
  } };
}


export function recoverSession(sessionId: string, events: readonly SessionEvent[]): SessionState {
  let agents: AgentLifetime = { agentTasks: [], agentChildren: [] };
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) throw new Error('session_event_identity_mismatch');
    if (event.sequence !== index + 1) throw new Error('session_event_sequence_gap');
    if (isAgentLifetimeEvent(event)) agents = reduceAgentLifetime(agents, event);
  }
  let state = emptySessionState(sessionId);
  // Archived child identities also label received messages during history-only replay.
  state.agentChildren = agents.agentChildren;
  const active = activeConversationEvents(events);
  for (const event of active) {
    // The lifetime stream above has already reduced these facts exactly once.
    if (isAgentLifetimeEvent(event)) {
      // Lifetime and visible history are different projections of the same fact.
      // Editing may hide an activity without deleting the archived child.
      if (event.type === 'agent.task.created' || event.type === 'agent.task.completed') {
        const activityState = { ...state, agentTasks: agents.agentTasks };
        recordAgentActivity(activityState, event, event.type === 'agent.task.created' ? 'started' : 'completed');
        state = { ...state, activities: activityState.activities };
      }
      continue;
    }
    // Only explicitly superseded journal ranges may create a gap in active history.
    state = reduceSession({ ...state, revision: event.sequence - 1 }, event);
  }
  // Editing changes model history, but cannot erase usage already incurred.
  const activeSequences = new Set(active.map((event) => event.sequence));
  for (const event of events) {
    if (activeSequences.has(event.sequence)) continue;
    if (event.type === 'provider.turn.settled') state.tokenUsage = withProviderCompletion(state.tokenUsage);
    if (event.type === 'context.updated') state.tokenUsage = withProviderUsage(state.tokenUsage, event.payload);
  }
  return { ...state, ...agents, revision: events.at(-1)?.sequence ?? 0 };
}

function sourceReferenceProjection(state: SessionState, content: string, requestId: string, referenceId: string) {
  const block = state.providerTurns[requestId]?.orderedOutputBlocks?.find(candidate => (
    candidate.kind === 'finalMessage' && candidate.messageId === referenceId
    || candidate.kind === 'narrative' && candidate.narrativeId === referenceId
  ));
  return projectSourceContent(content, block?.item);
}

export function projectSession(
  state: SessionState,
  assistantDraft: AssistantDraftProjection | null = null,
): SessionProjection {
  const rounds = new Map<string, string[]>();
  for (const activity of Object.values(state.activities).sort((left, right) => left.sequence - right.sequence)) {
    if (!activity.tool?.fileChanges?.length || !activity.tool.recordId) continue;
    const records = rounds.get(activity.runId) ?? [];
    records.push(activity.tool.recordId); rounds.set(activity.runId, records);
  }
  const draft = assistantDraft ? structuredClone(assistantDraft) : null;
  for (const block of draft?.blocks ?? []) {
    if (block.kind !== 'providerHosted') Object.assign(block, projectDraftSourceContent(block.content));
  }
  return {
    ...(state.subagentSettings ? { subagentSettings: structuredClone(state.subagentSettings) } : {}),
    ...(state.recipe ? { recipe: structuredClone(state.recipe) } : {}),
    ...(state.agentContext ? { agentContext: structuredClone(state.agentContext) } : {}),
    ...(state.agentTasks.length ? { agentTasks: structuredClone(state.agentTasks) } : {}),
    ...(state.agentChildren.length ? { agentChildren: structuredClone(state.agentChildren) } : {}),
    ...(Object.keys(state.runTimings).length ? { runTimings: Object.values(state.runTimings).map(value => structuredClone(value)) } : {}),
    ...(Object.keys(state.providerAttempts).length ? { providerAttempts: Object.values(state.providerAttempts)
      .filter((attempt) => attempt.runId === state.run?.runId).map((attempt) => structuredClone(attempt)) } : {}),
    ...(state.run && state.failureSnapshots[state.run.runId] ? { failureSnapshot: structuredClone(state.failureSnapshots[state.run.runId]) } : {}),
    permissionOverrides: structuredClone(state.permissionOverrides),
    effectivePermissions: state.run ? state.publishedPermissions ?? permissionSettings({ ...state.runRuntimeSnapshots[state.run.runId]?.permissions, ...state.permissionOverrides }) : null,
    shellAuthorizations: structuredClone(state.shellAuthorizations),
    schemaVersion: SESSION_PROJECTION_VERSION,
    ...(rounds.size ? { fileChangeRounds: [...rounds].map(([runId, recordIds]) => ({ runId, recordIds })) } : {}),
    sessionId: state.sessionId,
    revision: state.revision,
    display: { ...state.display },
    modelSettings: state.modelSettings ? { ...state.modelSettings } : null,
    workspaceBindings: state.workspaceBindings.map((binding) => ({ ...binding })),
    sessionDirectoryIndexes: state.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
    messages: state.messages.map((message) => ({
      ...message,
      ...(message.role === 'assistant' ? sourceReferenceProjection(state, message.content, message.providerRequestId, message.messageId) : {}),
      ...(message.replyToInteraction ? { replyToInteraction: { ...message.replyToInteraction } } : {}),
      filesystemReferences: message.filesystemReferences.map((reference) => ({ ...reference })),
      pluginSelections: message.pluginSelections.map((selection) => ({ ...selection })),
    })),
    queuedInputs: state.queuedInputs.map((input) => ({
      ...input,
      filesystemReferences: input.filesystemReferences.map((reference) => ({ ...reference })),
      pluginSelections: input.pluginSelections.map((selection) => ({ ...selection })),
      status: state.tokenUsageHistory[input.runId]?.outcome ? 'notApplied' : 'queued',
    })),
    narratives: state.narratives.map((narrative) => ({ ...narrative,
      ...sourceReferenceProjection(state, narrative.content, narrative.providerRequestId, narrative.narrativeId) })),
    timeline: projectTimeline(state),
    assistantDraft: draft,
    interactions: state.interactions.map(item => cloneInteraction(item)!),
    pendingInteraction: cloneInteraction(pendingInteraction(state)),
    pendingApprovals: state.pendingApprovals.map(item => cloneApproval(item)!),
    pendingApproval: cloneApproval(state.pendingApproval),
    plans: state.plans.map((plan) => clonePlanProjection(plan)),
    activePlanRef: state.activePlanRef ? { ...state.activePlanRef } : null,
    pendingPlan: state.pendingPlan ? clonePlanProjection(state.pendingPlan) : null,
    todoList: cloneTodoList(state.todoList),
    contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
    // Keep the latest Agent usage receipt and the pending call composition.
    contextCompositions: state.contextCompositions.filter((receipt, index) => (
      receipt.providerRequestId === state.contextUsage?.providerRequestId
      || index === state.contextCompositions.length - 1
    )).map(cloneContextComposition),
    tokenUsage: { ...state.tokenUsage },
    // SessionService adds descendants at the public snapshot boundary.
    totalTokenUsage: { ...state.tokenUsage },
    tokenUsageHistory: Object.values(state.tokenUsageHistory)
      .sort((left, right) => right.sequence - left.sequence)
      .map((usage) => ({ ...usage })),
    run: state.run ? cloneRun(state.run) : null,
    activities: Object.values(state.activities)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneActivity),
    artifacts: Object.values(state.artifacts).map((artifact) => ({ ...artifact })),
    deliverables: Object.values(state.deliverables).sort(compareDeliverables).map(item => ({ ...item })),
    terminalError: state.terminalError ? { ...state.terminalError } : null,
  };
}

function effectiveWorkspaceBindings(state: Pick<
  SessionState,
  'creationWorkspaceBindings' | 'sessionDirectoryIndexes'
>): WorkspaceBindingDisplay[] {
  return [...new Map([
    ...state.creationWorkspaceBindings,
    ...state.sessionDirectoryIndexes,
  ].map(binding => [binding.workspaceId, { ...binding }])).values()];
}

function cloneRun(run: NonNullable<SessionProjection['run']>): NonNullable<SessionProjection['run']> {
  return {
    ...run,
    ...(run.hostBinding ? { hostBinding: { ...run.hostBinding } } : {}),
    workspaceBindings: run.workspaceBindings.map((binding) => ({ ...binding })),
  };
}

function cloneRunRuntimeSnapshot(snapshot: RunRuntimeSnapshot): RunRuntimeSnapshot {
  const storedAliases = (snapshot as unknown as { providerToolAliases?: unknown })
    .providerToolAliases;
  const storedToolPromptContributions = (
    snapshot as unknown as { toolPromptContributions?: unknown }
  ).toolPromptContributions;
  if (!Array.isArray(storedAliases)) {
    throw new Error('run_runtime_provider_tool_aliases_missing');
  }
  if (!Array.isArray(storedToolPromptContributions)) {
    throw new Error('run_runtime_tool_prompt_contributions_missing');
  }
  const providerToolAliases = (storedAliases as RunRuntimeSnapshot['providerToolAliases'])
    .map((alias) => ({ ...alias }));
  const toolPromptContributions = (
    storedToolPromptContributions as RunRuntimeSnapshot['toolPromptContributions']
  ).map((contribution) => ({
    ...contribution,
    usageGuidelines: [...contribution.usageGuidelines],
  }));
  return {
    ...snapshot,
    ...(snapshot.agentCapabilities !== undefined ? { agentCapabilities: structuredClone(snapshot.agentCapabilities) } : {}),
    environment: structuredClone(snapshot.environment),
    provider: { ...snapshot.provider },
    ...(snapshot.approvalReviewer ? { approvalReviewer: { ...snapshot.approvalReviewer } } : {}),
    ...(snapshot.approvalReviewerError ? { approvalReviewerError: structuredClone(snapshot.approvalReviewerError) } : {}),
    webSearch: { ...snapshot.webSearch },
    instructions: snapshot.instructions.map((instruction) => ({ ...instruction })),
    tools: snapshot.tools.map((tool) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      possibleEffects: [...tool.possibleEffects],
    })),
    toolPromptContributions,
    providerToolAliases,
    selectedPlugins: {
      catalogRevision: snapshot.selectedPlugins.catalogRevision,
      plugins: snapshot.selectedPlugins.plugins.map((plugin) => ({
        ...plugin,
        capabilityRefs: [...plugin.capabilityRefs],
      })),
    },
  };
}

function validateOrderedProviderOutputBlocks(
  blocks: readonly ProviderOutputBlock[],
  orderedCallIds: readonly string[],
): void {
  if (blocks.length === 0) throw new Error('provider_output_blocks_empty');
  const callIds: string[] = [];
  const allCallIds = new Set<string>();
  const referenceIds = new Set<string>();
  const providerCallIds = new Set<string>();
  let previousOutputIndex = -1;
  let finalMessageCount = 0;
  const addUnique = (values: Set<string>, value: string): boolean => {
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.outputIndex)
      || block.outputIndex < 0
      || block.outputIndex <= previousOutputIndex
      || !isRecord(block.item)
    ) throw new Error('provider_output_block_invalid');
    previousOutputIndex = block.outputIndex;
    switch (block.kind) {
      case 'reasoning':
        if (block.item.type !== 'reasoning') throw new Error('provider_output_block_invalid');
        break;
      case 'narrative':
        if (
          block.item.type !== 'message'
          || !addUnique(referenceIds, `narrative:${block.narrativeId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
      case 'finalMessage':
        finalMessageCount += 1;
        if (
          block.item.type !== 'message'
          || !addUnique(referenceIds, `message:${block.messageId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
      case 'toolCall':
      case 'toolCallRejected':
        if (
          block.item.type !== 'function_call'
          || block.item.call_id !== block.providerCallId
          || !block.callId || !block.providerCallId || !block.toolName
          || typeof block.item.name !== 'string' || !block.item.name
          || typeof block.item.arguments !== 'string'
          || !addUnique(allCallIds, block.callId)
          || !addUnique(providerCallIds, block.providerCallId)
        ) throw new Error('provider_output_block_invalid');
        if (block.kind === 'toolCall') callIds.push(block.callId);
        else if (!block.error.code || !block.error.message || !block.error.issues?.length
          || block.error.issues.some((issue) => !issue.path || !issue.rule || !issue.message)) {
          throw new Error('provider_output_rejection_invalid');
        }
        break;
      case 'providerHosted':
        if (
          block.providerToolType !== 'web_search'
          || block.item.type !== 'web_search_call'
          || block.item.id !== block.providerCallId
          || !addUnique(providerCallIds, block.providerCallId)
          || !addUnique(referenceIds, `activity:${block.activityId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
    }
  }
  const narratives = blocks.filter((block) => block.kind === 'narrative');
  const commentaryOnly = narratives.length > 0 && narratives.every((block) => block.item.phase === 'commentary');
  if (
    finalMessageCount > 1
    || callIds.length !== orderedCallIds.length
    || callIds.some((callId, index) => callId !== orderedCallIds[index])
    || allCallIds.size === 0 && finalMessageCount !== 1 && !commentaryOnly
    || allCallIds.size > 0 && finalMessageCount !== 0
  ) throw new Error('provider_output_block_normalization_invalid');
}

function assertProviderMessageReference(
  turn: ProviderTurnState,
  kind: 'narrative' | 'finalMessage',
  referenceId: string,
  content: string,
): void {
  if (!turn.orderedOutputBlocks) return;
  const matches = turn.orderedOutputBlocks.filter((block) => (
    block.kind === kind
    && (kind === 'narrative'
      ? block.kind === 'narrative' && block.narrativeId === referenceId
      : block.kind === 'finalMessage' && block.messageId === referenceId)
  ));
  if (
    matches.length !== 1
    || providerOutputMessageText(matches[0]!.item) !== content
  ) throw new Error('provider_output_message_reference_invalid');
}

function providerOutputMessageText(item: Record<string, unknown>): string {
  if (item.type !== 'message' || !Array.isArray(item.content)) {
    throw new Error('provider_output_message_item_invalid');
  }
  let text = '';
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== 'output_text') continue;
    if (typeof part.text !== 'string') throw new Error('provider_output_message_item_invalid');
    text += part.text;
  }
  if (!text.trim()) throw new Error('provider_output_message_item_invalid');
  return text;
}

function requiredRunRuntimeSnapshot(state: SessionState, runId: string): RunRuntimeSnapshot {
  const snapshot = state.runRuntimeSnapshots[runId];
  if (!snapshot) throw new Error('run_runtime_snapshot_missing');
  return snapshot;
}

function requiredProviderTurn(
  state: SessionState,
  runId: string,
  providerRequestId: string,
  purpose?: ProviderTurnState['purpose'],
): ProviderTurnState {
  const turn = state.providerTurns[providerRequestId];
  if (
    !turn
    || turn.outcome !== 'completed'
    || turn.runId !== runId
    || purpose !== undefined && turn.purpose !== purpose
  ) {
    throw new Error('provider_turn_completion_missing');
  }
  return turn;
}

function projectTimeline(state: SessionState): SessionProjection['timeline'] {
  const groups: Array<{
    sequence: number;
    items: SessionProjection['timeline'];
  }> = [];
  for (const message of state.messages) {
    if (message.role !== 'user') continue;
    groups.push({
      sequence: message.sequence,
      items: [{
        kind: 'message',
        timelineId: `message:${message.messageId}`,
        sequence: message.sequence,
        messageId: message.messageId,
      }],
    });
  }
  for (const activity of Object.values(state.activities)) {
    if (activity.kind !== 'agent') continue;
    groups.push({ sequence: activity.sequence, items: [{ kind: 'toolGroup',
      timelineId: activity.activityId, sequence: activity.sequence, activityIds: [activity.activityId] }] });
  }
  for (const turn of Object.values(state.providerTurns)) {
    if (turn.purpose !== 'agent' || turn.outcome !== 'completed') continue;
    const composition = state.contextCompositions.find((candidate) => (
      candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (!composition) throw new Error('provider_turn_composition_missing');
    if (turn.orderedOutputBlocks) {
      const items = projectOrderedProviderTurnTimeline(state, turn);
      if (items.length > 0) groups.push({ sequence: composition.sequence, items });
      continue;
    }
    const items: SessionProjection['timeline'] = [];
    const message = state.messages.find((candidate) => (
      candidate.role === 'assistant'
      && candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (message) {
      items.push({
        kind: 'message',
        timelineId: `message:${message.messageId}`,
        sequence: message.sequence,
        messageId: message.messageId,
        streamId: providerTextStreamId(state.sessionId, turn.runId, turn.providerRequestId),
      });
    }
    const narrative = state.narratives.find((candidate) => (
      candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (narrative) {
      items.push({
        kind: 'narrative',
        timelineId: `provider-turn:${turn.providerRequestId}:narrative`,
        sequence: narrative.sequence,
        providerRequestId: turn.providerRequestId,
        narrativeId: narrative.narrativeId,
        streamId: providerTextStreamId(state.sessionId, turn.runId, turn.providerRequestId),
      });
    }
    const orderedCallIds = turn.toolCallInputs?.map((call) => call.callId) ?? turn.orderedCallIds ?? [];
    for (const callId of orderedCallIds) {
      const plan = state.plans.find((candidate) => candidate.callId === callId);
      if (!plan) continue;
      items.push({
        kind: 'plan',
        timelineId: `provider-turn:${turn.providerRequestId}:plan:${callId}`,
        sequence: plan.sequence,
        providerRequestId: turn.providerRequestId,
        planId: plan.planId,
        revision: plan.revision,
      });
    }
    const toolActivities = orderedCallIds.flatMap((callId) => {
      const activity = Object.values(state.activities).find((candidate) => (
        (candidate.kind === 'tool' || candidate.kind === 'interaction') && candidate.callId === callId
      ));
      return activity ? [...approvalActivities(state, callId), activity] : [];
    });
    if (toolActivities.length > 0) {
      items.push({
        kind: 'toolGroup',
        timelineId: `provider-turn:${turn.providerRequestId}:tools`,
        sequence: Math.max(...toolActivities.map((activity) => activity.sequence)),
        providerRequestId: turn.providerRequestId,
        activityIds: toolActivities.map((activity) => activity.activityId),
      });
    }
    if (items.length > 0) groups.push({ sequence: composition.sequence, items });
  }
  return groups
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((group) => group.items);
}

function projectOrderedProviderTurnTimeline(
  state: SessionState,
  turn: ProviderTurnState,
): SessionProjection['timeline'] {
  const items: SessionProjection['timeline'] = [];
  let groupedActivities: ActivityProjection[] = [];
  let activityGroupIndex = 0;
  const flushActivities = (): void => {
    if (groupedActivities.length === 0) return;
    items.push({
      kind: 'toolGroup',
      timelineId: `provider-turn:${turn.providerRequestId}:activities:${activityGroupIndex}`,
      sequence: Math.max(...groupedActivities.map((activity) => activity.sequence)),
      providerRequestId: turn.providerRequestId,
      activityIds: groupedActivities.map((activity) => activity.activityId),
    });
    activityGroupIndex += 1;
    groupedActivities = [];
  };
  for (const block of turn.orderedOutputBlocks ?? []) {
    switch (block.kind) {
      case 'reasoning':
        break;
      case 'narrative': {
        flushActivities();
        const narrative = state.narratives.find((candidate) => (
          candidate.narrativeId === block.narrativeId
          && candidate.providerRequestId === turn.providerRequestId
        ));
        if (!narrative) throw new Error('provider_output_narrative_missing');
        items.push({
          kind: 'narrative',
          timelineId: `provider-turn:${turn.providerRequestId}:narrative:${block.outputIndex}`,
          sequence: narrative.sequence,
          providerRequestId: turn.providerRequestId,
          narrativeId: narrative.narrativeId,
          outputIndex: block.outputIndex,
          streamId: providerTextStreamId(
            state.sessionId, turn.runId, turn.providerRequestId, block.outputIndex,
          ),
        });
        break;
      }
      case 'finalMessage': {
        flushActivities();
        const message = state.messages.find((candidate) => (
          candidate.role === 'assistant'
          && candidate.messageId === block.messageId
          && candidate.providerRequestId === turn.providerRequestId
        ));
        if (!message) throw new Error('provider_output_final_message_missing');
        items.push({
          kind: 'message',
          timelineId: `message:${message.messageId}`,
          sequence: message.sequence,
          messageId: message.messageId,
          outputIndex: block.outputIndex,
          streamId: providerTextStreamId(
            state.sessionId, turn.runId, turn.providerRequestId, block.outputIndex,
          ),
        });
        break;
      }
      case 'providerHosted': {
        const activity = state.activities[block.activityId];
        if (!activity || activity.kind !== 'providerHosted') {
          throw new Error('provider_hosted_activity_missing');
        }
        groupedActivities.push(activity);
        break;
      }
      case 'toolCallRejected':
      case 'toolCall': {
        const plan = state.plans.find((candidate) => candidate.callId === block.callId);
        if (plan) {
          flushActivities();
          items.push({
            kind: 'plan',
            timelineId: `provider-turn:${turn.providerRequestId}:plan:${block.callId}`,
            sequence: plan.sequence,
            providerRequestId: turn.providerRequestId,
            planId: plan.planId,
            revision: plan.revision,
          });
          break;
        }
        const activity = Object.values(state.activities).find((candidate) => (
          (candidate.kind === 'tool' || candidate.kind === 'interaction') && candidate.callId === block.callId
        ));
        if (activity) groupedActivities.push(...approvalActivities(state, block.callId), activity);
        break;
      }
    }
  }
  flushActivities();
  return items;
}

function approvalActivities(state: SessionState, callId: string): ActivityProjection[] {
  return Object.values(state.activities)
    .filter((activity) => activity.kind === 'approval' && activity.callId === callId)
    .sort((left, right) => left.sequence - right.sequence);
}

function cloneApproval(
  approval: SessionProjection['pendingApproval'],
): SessionProjection['pendingApproval'] {
  if (!approval) return null;
  return {
    ...approval,
    preview: {
      ...approval.preview,
      summary: approval.preview.summary,
      effects: [...approval.preview.effects],
      logicalTargets: [...approval.preview.logicalTargets],
    },
  };
}

function cloneRunSettlement(settlement: RunSettlement): RunSettlement {
  if (settlement.outcome === 'completed') return { ...settlement };
  if (settlement.outcome === 'failed' || settlement.outcome === 'indeterminate') {
    return { outcome: settlement.outcome, error: { ...settlement.error } };
  }
  return { outcome: 'cancelled' };
}

function sameRunSettlement(left: RunSettlement, right: RunSettlement): boolean {
  if (left.outcome !== right.outcome) return false;
  if (left.outcome === 'completed' && right.outcome === 'completed') {
    return left.finalMessageId === right.finalMessageId;
  }
  if (
    (left.outcome === 'failed' || left.outcome === 'indeterminate')
    && (right.outcome === 'failed' || right.outcome === 'indeterminate')
  ) {
    return left.error.code === right.error.code && left.error.message === right.error.message;
  }
  return left.outcome === 'cancelled' && right.outcome === 'cancelled';
}

function projectPlan(
  event: Extract<SessionEvent, { type: 'plan.published' }>,
): PlanProjection & { status: 'published' } {
  return {
    planId: event.payload.planId,
    revision: event.payload.revision,
    runId: event.runId,
    callId: event.callId,
    title: event.payload.title,
    summary: event.payload.summary,
    steps: event.payload.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: event.payload.mutationManifest.map((operation) => ({ ...operation })),
    ...(event.payload.workspaceRequests?.length ? { workspaceRequests: structuredClone(event.payload.workspaceRequests) } : {}),
    status: 'published',
    sequence: event.sequence,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

export function pendingInteraction(state: SessionState): SessionProjection['pendingInteraction'] {
  const pending = state.interactions.filter(item => item.runId === state.run?.runId && item.status === 'pending');
  return pending.find(item => item.mode !== 'continue') ?? pending[0] ?? null;
}

function closeInteractions(state: SessionState, runId: string): void {
  state.interactions = state.interactions.map(item => item.runId === runId && item.status === 'pending'
    ? { ...item, status: 'closed' } : item);
  for (const item of state.interactions) {
    if (item.runId === runId && item.status === 'closed') settleActivity(state, interactionActivityId(item.interactionId), 'cancelled');
  }
}

function cloneInteraction(
  interaction: SessionProjection['pendingInteraction'],
): SessionProjection['pendingInteraction'] {
  if (!interaction) return null;
  return {
    ...interaction,
    ...(interaction.options
      ? { options: interaction.options.map((option) => ({ ...option })) }
      : {}),
  };
}

function clonePlanProjection<T extends PlanProjection | PendingPlanProjection>(plan: T): T;
function clonePlanProjection(plan: null): null;
function clonePlanProjection(
  plan: PlanProjection | PendingPlanProjection | null,
): PlanProjection | PendingPlanProjection | null {
  if (plan === null) return null;
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: plan.mutationManifest.map((operation) => ({ ...operation })),
    ...(plan.workspaceRequests ? { workspaceRequests: structuredClone(plan.workspaceRequests) } : {}),
    ...(plan.review ? { review: structuredClone(plan.review) } : {}),
  };
}

function findPlanIndex(state: SessionState, planId: string, revision: number): number {
  return state.plans.findIndex((plan) => plan.planId === planId && plan.revision === revision);
}

function planFor(state: SessionState, planId: string, revision: number): PlanProjection {
  const plan = state.plans[findPlanIndex(state, planId, revision)];
  if (!plan) throw new Error('plan_revision_missing');
  return plan;
}

function updatePlan(
  state: SessionState,
  planId: string,
  revision: number,
  update: (plan: PlanProjection) => PlanProjection,
): void {
  const index = findPlanIndex(state, planId, revision);
  if (index < 0) throw new Error('plan_revision_missing');
  state.plans = [...state.plans];
  state.plans[index] = update(planFor(state, planId, revision));
  if (state.plans[index].status === 'published' && samePlanRef(state.pendingPlan, { planId, revision })) {
    state.pendingPlan = { ...clonePlanProjection(state.plans[index]), status: 'published', responseMode: 'confirmReviseOrCancel' };
  }
}

function assertPendingPlan(
  state: SessionState,
  event: Extract<SessionEvent, { type: 'plan.revision.requested' | 'plan.cancelled' }>,
): void {
  if (
    !state.pendingPlan
    || state.pendingPlan.planId !== event.payload.planId
    || state.pendingPlan.revision !== event.payload.revision
    || state.pendingPlan.runId !== event.runId
    || state.pendingPlan.callId !== event.callId
  ) throw new Error('plan_request_missing');
}

function samePlanRef(
  reference: { planId: string; revision: number } | null,
  candidate: { planId: string; revision: number },
): boolean {
  return Boolean(
    reference
    && reference.planId === candidate.planId
    && reference.revision === candidate.revision
  );
}

function cloneTodoList(todoList: SessionProjection['todoList']): SessionProjection['todoList'] {
  if (!todoList) return null;
  return {
    ...todoList,
    items: todoList.items.map((item) => ({ ...item })),
  };
}

function cloneContextComposition(
  receipt: SessionProjection['contextCompositions'][number],
): SessionProjection['contextCompositions'][number] {
  return {
    ...receipt,
    messages: receipt.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) => ({ ...block })),
      filesystemReferences: message.filesystemReferences.map((reference) => ({ ...reference })),
    })),
    workspaceBindings: receipt.workspaceBindings.map((binding) => ({ ...binding })),
    tools: receipt.tools.map((tool) => ({ ...tool })),
    partitions: receipt.partitions.map((partition) => ({ ...partition })),
  };
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'filesystemReferences',
] as const;

function validateContextPartitions(
  partitions: Extract<SessionEvent, { type: 'context.composed' }>['payload']['partitions'],
): void {
  if (
    partitions.length !== CONTEXT_PARTITION_ORDER.length
    || partitions.some((partition, index) => (
      partition.kind !== CONTEXT_PARTITION_ORDER[index]
      || !Number.isSafeInteger(partition.itemCount)
      || partition.itemCount < 0
      || !Number.isSafeInteger(partition.requestShapeUnits)
      || partition.requestShapeUnits < 0
    ))
    || partitions.every((partition) => partition.requestShapeUnits === 0)
  ) throw new Error('context_partition_receipt_invalid');
}

function estimatePartitionTokens(
  partitions: NonNullable<SessionProjection['contextCompositions'][number]['partitions']>,
  inputTokens: number,
): NonNullable<SessionProjection['contextCompositions'][number]['partitions']> {
  validateContextPartitions(partitions);
  const totalUnits = partitions.reduce(
    (total, partition) => total + BigInt(partition.requestShapeUnits),
    0n,
  );
  const totalTokens = BigInt(inputTokens);
  const allocated = partitions.map((partition, index) => {
    const weighted = totalTokens * BigInt(partition.requestShapeUnits);
    return {
      index,
      tokens: weighted / totalUnits,
      remainder: weighted % totalUnits,
    };
  });
  let remaining = totalTokens - allocated.reduce((total, item) => total + item.tokens, 0n);
  for (const item of [...allocated].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  })) {
    if (remaining === 0n) break;
    item.tokens += 1n;
    remaining -= 1n;
  }
  return partitions.map((partition, index) => ({
    kind: partition.kind,
    itemCount: partition.itemCount,
    requestShapeUnits: partition.requestShapeUnits,
    estimatedInputTokens: Number(allocated[index].tokens),
    tokenSource: 'sessionEstimated',
  }));
}

function cloneActivity(activity: ActivityProjection): ActivityProjection {
  return {
    ...activity,
    ...(activity.approvalReview ? { approvalReview: { ...activity.approvalReview } } : {}),
    ...(activity.inputRejection ? { inputRejection: structuredClone(activity.inputRejection) } : {}),
    ...(activity.notExecuted ? { notExecuted: { ...activity.notExecuted } } : {}),
    ...(activity.interruption ? { interruption: { ...activity.interruption } } : {}),
    ...(activity.tool
      ? {
          tool: {
            ...activity.tool,
            ...(activity.tool.error ? { error: structuredClone(activity.tool.error) } : {}),
            resources: activity.tool.resources.map((resource) => ({ ...resource })),
            ...(activity.tool.fileChanges ? { fileChanges: structuredClone(activity.tool.fileChanges) } : {}),
            ...(activity.tool.shell
              ? {
                  shell: {
                    ...activity.tool.shell,
                    ...(activity.tool.shell.result
                      ? { result: { ...activity.tool.shell.result } }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(activity.providerHosted
      ? {
          providerHosted: {
            ...activity.providerHosted,
            ...(activity.providerHosted.action === undefined
              ? {} : { action: structuredClone(activity.providerHosted.action) }),
          },
        }
      : {}),
  };
}

function assertCurrentRun(state: SessionState, runId: string, code: string): void {
  if (!state.run || state.run.runId !== runId) throw new Error(code);
}

function recordProviderCallFact(
  state: SessionState,
  callId: string,
  runId: string,
  providerCallId: string,
  toolName: string,
  sequence: number,
): void {
  if (state.providerCallFacts[callId] !== undefined) throw new Error('provider_call_fact_duplicate');
  state.providerCallFacts = {
    ...state.providerCallFacts,
    [callId]: { runId, providerCallId, toolName, sequence },
  };
}

function assertRunningRun(state: SessionState, runId: string, code: string): void {
  if (!state.run || state.run.runId !== runId || state.run.status !== 'running') {
    throw new Error(code);
  }
}

function settleActivity(
  state: SessionState,
  activityId: string,
  status: ActivityProjection['status'],
): void {
  const activity = state.activities[activityId];
  if (!activity) throw new Error(`activity_source_missing:${activityId}`);
  state.activities = { ...state.activities, [activityId]: { ...activity, status } };
}

function projectProcess(state: SessionState, job: ManagedProcessSnapshot): void {
  const id = toolActivityId(job.callId);
  const previous = state.activities[id];
  if (!previous) throw new Error('managed_process_call_missing');
  const activity: ActivityProjection = { ...previous, status: job.status, startedAt: job.startedAt,
    tool: { recordId: previous.tool?.recordId, operation: job.toolName,
      resources: job.targets.map(label => ({kind: 'logicalTarget', label})),
      process: { jobId: job.jobId, command: job.command, output: structuredClone(job.output) },
      ...(job.error ? { error: structuredClone(job.error) } : {}) } };
  delete activity.liveOutput;
  if (job.status === 'active') activity.liveOutput = structuredClone(job.output);
  if (job.result != null) {
    const result = job.result;
    if (isRecord(result) && (result.exitCode === null || Number.isSafeInteger(result.exitCode))
      && isNaturalSafeInteger(result.durationMs) && typeof result.timedOut === 'boolean') {
      activity.tool!.process!.result = { exitCode: result.exitCode as number | null,
        durationMs: result.durationMs, timedOut: result.timedOut };
    } else {
      activity.tool!.projectionError = {code: 'process_result_projection_invalid', message: '进程结果详情无法显示；原始记录已保留。'};
    }
  }
  state.activities = { ...state.activities, [id]: activity };
}

class ToolDetailProjectionError extends Error {}

function projectToolRecord(record: ToolExecutionRecord, activities: SessionState['activities']): {
  tool: NonNullable<ActivityProjection['tool']>; artifacts: ArtifactProjection[];
} {
  const { preparedEffect } = record;
  const tool: NonNullable<ActivityProjection['tool']> = {
    recordId: record.recordId,
    operation: preparedEffect.operation,
    resources: [],
  };
  let artifacts: ArtifactProjection[] = [];
  try {
    if ('error' in record && record.error) {
      const { code, message, diagnostics } = record.error;
      const error = { code, message };
      if (!isLocalAgentErrorValue(error)) throw new ToolDetailProjectionError('tool_error_projection_invalid');
      tool.error = error;
      if (diagnostics !== undefined) {
        if (!isLocalAgentErrorValue({ ...error, diagnostics })) throw new ToolDetailProjectionError('tool_error_diagnostics_invalid');
        tool.error.diagnostics = structuredClone(diagnostics);
      }
    }
    if (!Array.isArray(preparedEffect.logicalTargets)) throw new ToolDetailProjectionError('tool_resource_projection_invalid');
    tool.resources = preparedEffect.logicalTargets.map((target) => {
      if (typeof target !== 'string' || !target.trim() || target.includes('\0')) {
        throw new ToolDetailProjectionError('tool_resource_projection_invalid');
      }
      const relativePath = target === '.' || Boolean(target) && !target.includes('\\') && !target.includes('\0')
        && !/^[a-z]:/iu.test(target) && target.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
      if (preparedEffect.workspaceId && relativePath) {
        return {
          kind: 'workspacePath' as const,
          label: target,
          workspaceId: preparedEffect.workspaceId,
          logicalPath: target,
        };
      }
      if (/^https?:\/\//iu.test(target)) {
        return { kind: 'url' as const, label: target, uri: target };
      }
      return { kind: 'logicalTarget' as const, label: target };
    });
    if (['bash', 'powershell'].includes(preparedEffect.operation)) tool.shell = projectShellActivity(record);
    Object.assign(tool, projectFileChanges(record));
    artifacts = artifactsFromRecord(record);
    const computer = projectComputerActivity(record, artifacts, activities);
    if (computer) tool.computer = computer;
  } catch (error) {
    if (!(error instanceof ToolDetailProjectionError)) throw error;
    tool.projectionError = { code: error.message, message: '工具详情无法显示；原始执行记录已保留。' };
  }
  return { tool, artifacts };
}

function projectShellActivity(
  record: ToolExecutionRecord,
): NonNullable<NonNullable<ActivityProjection['tool']>['shell']> {
  const canonicalArguments = record.preparedEffect.canonicalInvocation.arguments;
  if (!isRecord(canonicalArguments)) {
    throw new ToolDetailProjectionError('bash_projection_input_invalid');
  }
  const command = canonicalArguments.command;
  const cwd = '.';
  const workspaceMode = canonicalArguments.workspaceMode;
  const executionScope = canonicalArguments.executionScope;
  const terminal = canonicalArguments.terminal !== undefined;
  if (
    typeof command !== 'string'
    || !command.trim()
    || !matchesProcessWorkspaceMode(workspaceMode)
    || !matchesProcessExecutionScope(executionScope)
    || terminal && !isCanonicalTerminalInput(canonicalArguments.terminal)
  ) {
    throw new ToolDetailProjectionError('bash_projection_input_invalid');
  }
  const output = record.outcome === 'completed'
    ? record.output
    : record.outcome === 'failed' || record.outcome === 'indeterminate' || record.outcome === 'cancelled'
      ? record.output
      : undefined;
  // Kernel failures before a process result exists carry diagnostics (or null),
  // not stdout/exit status. Keep the failed record intact without inventing a
  // process result. Executed commands, including nonzero exits, still validate
  // and project their complete output below.
  if (record.outcome === 'failed' && (
    output == null
    || isRecord(output)
      && typeof output.stage === 'string'
      && Object.hasOwn(output, 'details')
      && Object.keys(output).every((key) => key === 'stage' || key === 'details')
  )) return { command, cwd, executionScope, terminal };
  if (output === undefined && record.outcome !== 'completed') return { command, cwd, executionScope, terminal };
  if (!isRecord(output)) throw new ToolDetailProjectionError('bash_projection_output_invalid');
  const {
    command: outputCommand,
    cwd: outputCwd,
    workspaceId: outputWorkspaceId,
    workspaceMode: outputWorkspaceMode,
    executionScope: outputExecutionScope,
    terminal: outputTerminal,
    stdout,
    stderr,
    exitCode,
    success,
    timedOut,
    truncated,
    capturedBytes,
    durationMs,
  } = output;
  if (
    outputCommand !== command
    || outputCwd !== cwd
    || outputWorkspaceId !== record.preparedEffect.workspaceId
    || outputWorkspaceMode !== workspaceMode
    || outputExecutionScope !== executionScope
    || outputTerminal !== terminal
    || typeof stdout !== 'string'
    || typeof stderr !== 'string'
    || !(exitCode === null || typeof exitCode === 'number' && Number.isSafeInteger(exitCode))
    || typeof success !== 'boolean'
    || success && (timedOut || exitCode !== 0)
    || typeof timedOut !== 'boolean'
    || typeof truncated !== 'boolean'
    || !isNaturalSafeInteger(capturedBytes)
    || !isNaturalSafeInteger(durationMs)
  ) {
    throw new ToolDetailProjectionError('bash_projection_output_invalid');
  }
  const environment = projectShellEnvironment(
    output.environment,
    executionScope,
    terminal,
  );
  return {
    command,
    cwd,
    executionScope,
    terminal,
    result: {
      stdout,
      stderr,
      exitCode,
      success,
      timedOut,
      truncated,
      capturedBytes,
      durationMs,
      environment,
    },
  };
}

function projectShellEnvironment(
  value: unknown,
  executionScope: 'workspace' | 'host',
  terminal: boolean,
): ShellExecutionEnvironmentProjection {
  if (!isRecord(value)) throw new ToolDetailProjectionError('bash_projection_environment_invalid');
  const {
    shell,
    interactive,
    executionScope: outputExecutionScope,
    terminal: outputTerminal,
    pathSource,
    writeScope,
    homeWritable,
    networkAccess,
  } = value;
  // History describes the environment at execution time. Current sandbox
  // policy applies to new calls, not to these recorded diagnostics.
  if (
    typeof shell !== 'string'
    || !shell.trim()
    || interactive !== terminal
    || outputExecutionScope !== executionScope
    || outputTerminal !== terminal
    || typeof pathSource !== 'string'
    || !pathSource.trim()
    || typeof writeScope !== 'string'
    || !writeScope.trim()
    || typeof homeWritable !== 'boolean'
    || typeof networkAccess !== 'boolean'
  ) {
    throw new ToolDetailProjectionError('bash_projection_environment_invalid');
  }
  return {
    shell,
    interactive,
    executionScope,
    terminal,
    pathSource,
    writeScope,
    homeWritable,
    networkAccess,
  };
}

function matchesProcessWorkspaceMode(value: unknown): value is 'read' | 'write' {
  return value === 'read' || value === 'write';
}

function matchesProcessExecutionScope(value: unknown): value is 'workspace' | 'host' {
  return value === 'workspace' || value === 'host';
}

function isCanonicalTerminalInput(value: unknown): value is { stdin: string } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.stdin === 'string'
    && new TextEncoder().encode(value.stdin).byteLength <= 65_536;
}

function artifactsFromRecord(record: ToolExecutionRecord): ArtifactProjection[] {
  if (!('output' in record) || !isRecord(record.output)) return [];
  const artifacts = record.output.artifacts;
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new ToolDetailProjectionError('tool_artifact_invalid');
  return artifacts.flatMap((candidate) => {
    if (!isRecord(candidate)) throw new ToolDetailProjectionError('tool_artifact_invalid');
    const { artifactId, label, workspaceId, logicalPath, uri, contentType, contentMode, sourcePage, modifiedAt, resourceKey } = candidate;
    if (typeof artifactId !== 'string' || !artifactId.trim() || typeof label !== 'string' || !label.trim()
      || typeof contentType !== 'string' || !contentType
      || !['fixed', 'live'].includes(String(contentMode))) throw new ToolDetailProjectionError('tool_artifact_invalid');
    if (
      workspaceId !== undefined && typeof workspaceId !== 'string'
      || logicalPath !== undefined && typeof logicalPath !== 'string'
      || uri !== undefined && typeof uri !== 'string'
      || logicalPath === undefined && uri === undefined
    ) throw new ToolDetailProjectionError('tool_artifact_resource_invalid');
    return [{
      artifactId,
      label,
      sessionId: record.sessionId,
      runId: record.runId,
      callId: record.callId,
      recordId: record.recordId,
      createdAt: record.completedAt,
      contentType,
      contentMode: contentMode as 'fixed' | 'live',
      ...(typeof modifiedAt === 'string' ? { modifiedAt } : {}),
      ...(typeof resourceKey === 'string' ? { resourceKey } : {}),
      ...(isRecord(sourcePage) ? { sourcePage: structuredClone(sourcePage) as JsonObject } : {}),
      ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
      ...(typeof logicalPath === 'string' ? { logicalPath } : {}),
      ...(typeof uri === 'string' ? { uri } : {}),
    }];
  });
}

function runActivityId(runId: string): string { return `run:${runId}`; }
function toolActivityId(callId: string): string { return `tool:${callId}`; }
function approvalActivityId(approvalId: string): string { return `approval:${approvalId}`; }
function interactionActivityId(interactionId: string): string { return `interaction:${interactionId}`; }
function planActivityId(planId: string, revision: number): string {
  return `plan:${planId}:${revision}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNaturalSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function withProviderCompletion<T extends SessionProjection['tokenUsage']>(usage: T): T {
  return recomputeCacheAggregate({
    ...usage,
    providerCallCount: addTokenCount(usage.providerCallCount, 1),
  });
}

function withProviderUsage<T extends SessionProjection['tokenUsage']>(
  usage: T,
  reported: Extract<SessionEvent, { type: 'context.updated' }>['payload'],
): T {
  const cacheReported = reported.cacheReadInputTokens !== undefined;
  return recomputeCacheAggregate({
    ...usage,
    reportedCallCount: addTokenCount(usage.reportedCallCount, cacheReported ? 1 : 0),
    inputTokens: addTokenCount(usage.inputTokens, reported.inputTokens),
    outputTokens: addTokenCount(usage.outputTokens, reported.outputTokens),
    cacheReadInputTokens: addTokenCount(
      usage.cacheReadInputTokens,
      reported.cacheReadInputTokens ?? 0,
    ),
    cacheMissInputTokens: addTokenCount(
      usage.cacheMissInputTokens,
      reported.cacheMissInputTokens ?? 0,
    ),
  });
}

export function combineTokenUsage(
  own: SessionProjection['tokenUsage'],
  descendant: SessionProjection['tokenUsage'],
): SessionProjection['tokenUsage'] {
  return recomputeCacheAggregate({
    ...own,
    providerCallCount: addTokenCount(own.providerCallCount, descendant.providerCallCount),
    reportedCallCount: addTokenCount(own.reportedCallCount, descendant.reportedCallCount),
    inputTokens: addTokenCount(own.inputTokens, descendant.inputTokens),
    outputTokens: addTokenCount(own.outputTokens, descendant.outputTokens),
    cacheReadInputTokens: addTokenCount(own.cacheReadInputTokens, descendant.cacheReadInputTokens),
    cacheMissInputTokens: addTokenCount(own.cacheMissInputTokens, descendant.cacheMissInputTokens),
  });
}

/** Replay compact receipts without loading child prompts, outputs or execution state. */
export function providerUsageFromEvents(read: import('@deepcode/protocol').ProviderUsageRead): SessionProjection['tokenUsage'] {
  let usage = emptySessionState(read.sessionId).tokenUsage;
  const completed = new Set<string>(), reported = new Set<string>();
  let previous = 0;
  for (const event of read.events) {
    if (event.sessionId !== read.sessionId) throw new Error('session_event_identity_mismatch');
    if (event.sequence <= previous || event.sequence > read.revision) throw new Error('provider_usage_sequence_invalid');
    previous = event.sequence;
    const requestId = event.payload.providerRequestId;
    if (event.type === 'provider.turn.settled') {
      if (completed.has(requestId)) throw new Error('provider_turn_completion_duplicate');
      completed.add(requestId);
      usage = withProviderCompletion(usage);
    } else {
      if (!completed.has(requestId)) throw new Error('provider_turn_missing');
      if (reported.has(requestId)) throw new Error('provider_usage_duplicate');
      reported.add(requestId);
      usage = withProviderUsage(usage, event.payload);
    }
  }
  return usage;
}

function recomputeCacheAggregate<T extends SessionProjection['tokenUsage']>(usage: T): T {
  const cacheAvailable = usage.reportedCallCount > 0;
  return {
    ...usage,
    cacheAvailable,
    cacheComplete: usage.providerCallCount > 0
      && usage.reportedCallCount === usage.providerCallCount,
    cacheHitRatio: cacheAvailable && usage.inputTokens > 0
      ? usage.cacheReadInputTokens / usage.inputTokens
      : null,
  };
}

function addTokenCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error('token_usage_overflow');
  return total;
}

function projectFileChanges(record: ToolExecutionRecord): Pick<NonNullable<ActivityProjection['tool']>, 'fileChanges'> {
  if (!('output' in record) || !record.output || typeof record.output !== 'object' || Array.isArray(record.output)) return {};
  const changes = (record.output as Record<string, unknown>).fileChanges;
  if (changes === undefined) return {};
  if (!Array.isArray(changes) || changes.some((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return true;
    return typeof change.workspaceId !== 'string' || !change.workspaceId.trim() || change.workspaceId !== record.preparedEffect.workspaceId
      || typeof change.path !== 'string' || !change.path.trim() || !['create', 'modify', 'delete'].includes(String(change.kind))
      || ![change.before, change.after].every((side) => side && typeof side === 'object' && !Array.isArray(side)
        && typeof side.exists === 'boolean'
        && (side.sizeBytes === undefined || isNaturalSafeInteger(side.sizeBytes))
        && (side.contentRef === undefined || typeof side.contentRef === 'string' && Boolean(side.contentRef.trim()))
        && (side.error === undefined || typeof side.error === 'string' && Boolean(side.error.trim()))
        && (!side.exists || typeof side.contentRef === 'string' || typeof side.error === 'string'))
      || (change.kind === 'create' && (change.before?.exists !== false || change.after?.exists !== true))
      || (change.kind === 'delete' && (change.before?.exists !== true || change.after?.exists !== false))
      || (change.kind === 'modify' && (change.before?.exists !== true || change.after?.exists !== true));
  })) throw new ToolDetailProjectionError('kernel_file_changes_invalid');
  return { fileChanges: changes.map(({ workspaceId, path, kind, before, after }) => ({
    workspaceId, path, kind,
    before: projectFileChangeSide(before), after: projectFileChangeSide(after),
  })) };
}

function projectFileChangeSide({ exists, contentRef, sizeBytes, error }: import('@deepcode/protocol').FileChangeSide) {
  return { exists, ...(contentRef === undefined ? {} : { contentRef }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }), ...(error === undefined ? {} : { error }) };
}
