import { decodeAgentCapabilities, isManagedProcessSnapshot } from '@deepcode/protocol';
import { isSessionAuthorizationScope } from '@deepcode/protocol';
import { permissionSettings } from '@deepcode/protocol';
import { SESSION_EVENT_VERSION } from '@deepcode/protocol';
import type { CommandReply, ConversationCommand, NewSessionEvent, SessionEvent } from '@deepcode/protocol';
import { loopSnapshot, pendingToolRequests, type LoopSnapshot } from './loop.js';
import { reduceSession } from './reducer.js';
import { admitModelView } from './modelView.js';
import { controlWait, pendingWakeups } from './sessionWake.js';

/** New writes are admitted here; replay preserves already-recorded failure facts. */
export function admitSessionEvents(
  current: LoopSnapshot,
  events: readonly NewSessionEvent[],
  command?: { input: ConversationCommand; reply: Omit<CommandReply, 'revision'> },
): void {
  if (command) admitCommandBatch(current, command.input, events, command.reply);
  let snapshot = current;
  for (const event of events) {
    admitEvent(snapshot, event);
    const candidate = {
      ...event, schemaVersion: SESSION_EVENT_VERSION,
      eventId: 'admission', sequence: snapshot.state.revision + 1,
      occurredAt: '1970-01-01T00:00:00.000Z',
    } as SessionEvent;
    const journalEvents = [...snapshot.journalEvents, candidate];
    snapshot = event.type === 'conversation.revised'
      ? loopSnapshot(current.state.sessionId, journalEvents)
      : { journalEvents, events: [...snapshot.events, candidate], state: reduceSession(snapshot.state, candidate) };
  }
}

function admitCommandBatch(current: LoopSnapshot, command: ConversationCommand, events: readonly NewSessionEvent[], reply: Omit<CommandReply, 'revision'>): void {
  if (reply.sessionId !== command.sessionId || reply.commandId !== command.commandId
    || events.some((event) => event.sessionId !== command.sessionId)) throw new Error('session_command_identity_mismatch');
  if (reply.status === 'rejected') {
    if (events.length) throw new Error('rejected_command_event_batch_invalid');
    return;
  }
  if (command.type === 'run.host.rebind') {
    const event = events[0];
    if (events.length !== 1 || event?.type !== 'run.host.rebound' || event.runId !== command.runId
      || event.payload.commandId !== command.commandId
      || event.payload.previousBinding.hostInstanceId !== command.expectedHostBinding.hostInstanceId
      || event.payload.previousBinding.windowLabel !== command.expectedHostBinding.windowLabel
      || event.payload.hostBinding.hostInstanceId !== command.hostBinding.hostInstanceId
      || event.payload.hostBinding.windowLabel !== command.hostBinding.windowLabel) throw new Error('host_rebind_command_event_invalid');
    return;
  }
  if (command.type !== 'plan.respond') return;
  const decisions = events.filter((event) => (event.type === 'plan.confirmed'
    || event.type === 'plan.revision.requested' || event.type === 'plan.cancelled')
    && event.payload.planId === command.planId && event.payload.revision === command.revision
    && event.payload.commandId === command.commandId);
  const todos = events.filter(event => event.type === 'todo.updated');
  const expected = { confirm: 'plan.confirmed', requestRevision: 'plan.revision.requested', cancel: 'plan.cancelled' } as const;
  if (decisions.length !== 1 || decisions[0].type !== expected[command.response.kind]
    || todos.length !== 0) throw new Error('plan_command_event_batch_invalid');
}

function admitEvent(snapshot: LoopSnapshot, event: NewSessionEvent): void {
  const { state, events } = snapshot;
  if (event.sessionId !== state.sessionId) throw new Error('session_event_identity_mismatch');
  const runId = 'runId' in event ? event.runId : undefined;
  const pendingProvider = state.contextCompositions.some((receipt) => receipt.runId === runId
    && !state.providerTurns[receipt.providerRequestId]);
  const userInput = event.type === 'input.accepted' || event.type === 'message.committed' && event.payload.role !== 'assistant';
  const revokedGrant = event.type === 'approval.revoked'
    ? state.shellAuthorizations.find((grant) => grant.authorityId === event.payload.authorityId && grant.runId === event.runId)
    : undefined;
  if (event.type === 'approval.revoked' && !revokedGrant) throw new Error('approval_grant_missing');
  if (runId && event.type !== 'run.started' && !userInput && !(revokedGrant && isSessionAuthorizationScope(revokedGrant.scope))
    && (state.run?.runId !== runId || state.tokenUsageHistory[runId]?.outcome)) {
    throw new Error('session_event_run_not_active');
  }
  switch (event.type) {
    case 'agent.delegation.changed':
      if (typeof event.payload.enabled !== 'boolean' || state.agentDelegationEnabled === event.payload.enabled) throw new Error('agent_delegation_change_invalid');
      break;
    case 'session.created':
      if (state.revision !== 0) throw new Error('session_creation_duplicate');
      break;
    case 'run.started':
      decodeAgentCapabilities(event.payload.runtimeSnapshot.agentCapabilities);
      if (state.run && ['running', 'waiting', 'releasing', 'releaseFailed'].includes(state.run.status)) {
        throw new Error('session_run_already_active');
      }
      break;
    case 'conversation.revised': {
      const source = snapshot.journalEvents.find((item) => item.sequence === event.payload.fromSequence);
      if (event.payload.throughSequence !== state.revision || source?.type !== 'input.accepted'
        || source.payload.messageId !== event.payload.messageId) {
        throw new Error('conversation_revision_range_invalid');
      }
      break;
    }
    case 'message.committed':
      if (event.payload.role === 'user' && event.runId && event.payload.filesystemReferences?.length) {
        if (pendingProvider || pendingToolRequests(events, event.runId).length) throw new Error('input_resources_turn_active');
        if (event.payload.filesystemReferences.some(reference => reference.kind === 'directory'
          && !state.run?.workspaceBindings.some(binding => binding.workspaceId === reference.workspaceId))) {
          throw new Error('input_resources_directory_change');
        }
      }
    case 'narrative.committed':
      if ('providerRequestId' in event.payload) {
        const requestId = event.payload.providerRequestId;
        if (state.messages.some((message) => message.role === 'assistant' && message.runId === runId
          && message.providerRequestId === requestId)) throw new Error('provider_output_duplicate');
      }
      break;
    case 'interaction.requested':
      if (state.activities['interaction:' + event.payload.interactionId]) throw new Error('interaction_identity_duplicate');
      // Provider-origin calls must belong to the unfinished composition.
    case 'tool.requested':
    case 'plan.published':
    case 'session.control.rejected':
    case 'agent.control.completed':
    case 'session.control.completed':
      if (event.type === 'agent.control.completed' || event.type === 'session.control.completed') {
        const wait = controlWait(event.payload.result);
        if (wait) {
          const operation = event.payload.operation;
          const composition = events.findLast(item => item.type === 'context.composed' && item.runId === event.runId
            && item.payload.purpose === 'agent');
          if (composition?.type !== 'context.composed' || wait.afterSequence !== composition.payload.modelView?.throughSequence
            || operation.action !== 'wait' && !(event.type === 'agent.control.completed' && operation.action === 'spawn'
              && operation.delivery === 'wait' && typeof event.payload.result.taskId === 'string')
            || wait.deadline !== undefined && (event.type !== 'session.control.completed' || typeof operation.timeoutSeconds !== 'number')) {
            throw new Error('control_wait_identity_invalid');
          }
        }
      }
    case 'session.plugins.activated':
    case 'artifacts.presented':
      if (!pendingProvider) throw new Error('provider_turn_composition_missing');
      break;
    case 'todo.updated': {
      if (event.callId) {
        if (!pendingProvider) throw new Error('provider_turn_composition_missing');
      } else {
        const confirmed = events.at(-1);
        const plan = confirmed?.type === 'plan.confirmed' && state.plans.find(plan =>
          plan.planId === confirmed.payload.planId && plan.revision === confirmed.payload.revision);
        if (!plan || plan.runId !== runId || state.todoList?.runId === runId
          || event.payload.items.length !== plan.steps.length
          || event.payload.items.some((item, index) => item.text !== plan.steps[index].title || item.status !== 'pending')) {
          throw new Error('todo_initialization_invalid');
        }
      }
      break;
    }
    case 'plan.confirmed':
      if (event.payload.source === 'agent' && permissionSettings({ ...state.runRuntimeSnapshots[event.runId]?.permissions,
        ...state.permissionOverrides })['agent.permissions.workspaceMutation'] !== 'allow') throw new Error('plan_delegation_missing');
      if (event.payload.source === 'parent' && (!state.agentContext || !event.payload.authorities.length
        || event.payload.authorities.some(authority => authority.sessionId === state.sessionId))) throw new Error('parent_plan_reference_missing');
      break;
    case 'wake.scheduled':
      if (events.some(item => item.type === 'wake.scheduled' && item.payload.scheduleId === event.payload.scheduleId)
        || !Number.isSafeInteger(event.payload.dueAt) || event.payload.dueAt < 0 || !event.payload.text.trim()) throw new Error('schedule_invalid');
      break;
    case 'wake.cancelled':
    case 'wake.triggered': {
      const pending = pendingWakeups(events, event.runId).get(event.payload.scheduleId);
      if (!pending || event.type === 'wake.triggered' && event.payload.text !== pending.payload.text) throw new Error('schedule_not_pending');
      break;
    }
    case 'approval.resolved':
      if (event.payload.source === 'agent') {
        const permissions = permissionSettings({ ...state.runRuntimeSnapshots[event.runId]?.permissions, ...state.permissionOverrides });
        if (permissions['agent.permissions.shell'] !== 'review'
          || state.pendingApprovals.find(item => item.callId === event.callId)?.preview.approvalReviewer !== 'agent'
          || state.pendingApprovals.find(item => item.callId === event.callId)?.preview.review?.decision !== event.payload.decision
          || event.payload.authorizationScope !== undefined) throw new Error('approval_delegation_missing');
      }
      break;
    case 'plan.superseded':
      if (event.payload.planId === event.payload.supersededByPlanId
        && event.payload.revision === event.payload.supersededByRevision) throw new Error('plan_supersede_invalid');
      break;
    case 'plan.invalidated':
      if (state.activePlanRef?.planId !== event.payload.planId || state.activePlanRef.revision !== event.payload.revision) {
        throw new Error('plan_invalidation_inactive');
      }
      break;
    case 'context.compaction.requested':
      if (event.payload.coveredThroughSequence > state.revision) throw new Error('context_compaction_cutoff_invalid');
      if (events.some((item) => item.type === 'context.compaction.requested'
        && (item.payload.compactionId === event.payload.compactionId
          || item.payload.providerRequestId === event.payload.providerRequestId))) throw new Error('context_compaction_identity_duplicate');
      break;
    case 'context.compacted': {
      const request = events.find((item) => item.type === 'context.compaction.requested'
        && item.runId === runId && item.payload.compactionId === event.payload.compactionId);
      if (!request || request.type !== 'context.compaction.requested') throw new Error('context_compaction_request_missing');
      if (request.payload.providerRequestId !== event.payload.providerRequestId
        || request.payload.trigger !== event.payload.trigger
        || request.payload.coveredThroughSequence !== event.payload.coveredThroughSequence) throw new Error('context_compaction_completion_mismatch');
      if (events.some((item) => item.type === 'context.compacted'
        && item.payload.compactionId === event.payload.compactionId)) throw new Error('context_compaction_completion_invalid');
      break;
    }
    case 'run.tools.prepared':
      if (pendingProvider) throw new Error('provider_turn_still_active');
      break;
    case 'context.composed': {
      if (pendingProvider) throw new Error('provider_turn_still_active');
      admitModelView(event.payload, events);
      const compaction = events.some((item) => item.type === 'context.compaction.requested'
        && item.runId === runId && item.payload.providerRequestId === event.payload.providerRequestId);
      if (event.payload.purpose === 'approvalReview' && (!state.pendingApproval || event.payload.tools.length)) throw new Error('approval_review_context_invalid');
      if ((event.payload.purpose === 'contextCompaction') !== compaction) throw new Error('context_composition_purpose_mismatch');
      if (JSON.stringify(event.payload.workspaceBindings.map(binding => binding.itemId))
        !== JSON.stringify(state.run?.workspaceBindings.map(binding => binding.workspaceId))) {
        throw new Error('context_workspace_snapshot_mismatch');
      }
      const runtime = state.runRuntimeSnapshots[event.runId];
      const view = state.runToolViews[event.runId] ?? runtime;
      if (event.payload.kernelCatalogSnapshotRef && event.payload.kernelCatalogSnapshotRef !== view.kernelCatalogSnapshotRef) {
        throw new Error('tool_request_binding_missing');
      }
      const hosted = event.payload.tools.filter((tool) => tool.origin === 'providerHosted').length;
      if (hosted !== Number(event.payload.purpose !== 'approvalReview' && runtime.webSearch.owner === 'providerHosted')) {
        throw new Error('context_composition_search_owner_mismatch');
      }
      break;
    }
    case 'provider.turn.settled':
      if (event.payload.outcome === 'completed' && event.payload.hostedWebSearchCalls
        && state.runRuntimeSnapshots[event.runId].webSearch.owner !== 'providerHosted') throw new Error('provider_hosted_search_owner_mismatch');
      break;
    case 'run.finishing': {
      if (pendingProvider) throw new Error('run_finishing_state_invalid');
      const finalMessageId = 'finalMessageId' in event.payload ? event.payload.finalMessageId : undefined;
      if (finalMessageId
        && !state.messages.some((message) => message.role === 'assistant' && message.runId === runId
          && message.messageId === finalMessageId)) throw new Error('run_final_message_missing');
      break;
    }
    case 'run.runtime.released': {
      const view = state.runToolViews[event.runId] ?? state.runRuntimeSnapshots[event.runId];
      if (event.payload.pluginInstanceRefs.length !== view.selectedPlugins.plugins.length) throw new Error('run_runtime_release_plugin_mismatch');
      break;
    }
    case 'process.updated': {
      const job = event.payload.job;
      const request = events.find(item => item.type === 'tool.requested' && item.callId === event.callId && item.runId === event.runId);
      const previous = state.processes[job.jobId];
      if (!isManagedProcessSnapshot(job) || job.sessionId !== event.sessionId || job.runId !== event.runId
        || job.callId !== event.callId || request?.type !== 'tool.requested' || request.payload.toolName !== 'process'
        || previous && (previous.callId !== job.callId || previous.revision >= job.revision || previous.status !== 'active')) {
        throw new Error('managed_process_event_invalid');
      }
      break;
    }
    case 'tool.started':
    case 'tool.not-executed':
    case 'tool.interrupted': {
      const request = pendingToolRequests(events, event.runId).find((item) => item.callId === event.callId);
      if (!request || request.payload.attemptId !== event.payload.attemptId
        || event.type === 'tool.started' && state.runRuntimeReleases[event.runId]) throw new Error('tool_attempt_state_invalid');
      if (event.type === 'tool.not-executed') {
        if (state.activities[`tool:${event.callId}`]?.status !== 'requested') throw new Error('tool_not_executed_started');
        const predecessor = event.payload.predecessorCallId;
        if ((event.payload.reason === 'dependencyFailed') !== Boolean(predecessor)
          || predecessor && (!state.activities[`tool:${predecessor}`] || ['requested', 'active', 'completed'].includes(state.activities[`tool:${predecessor}`]!.status))) {
          throw new Error('tool_not_executed_dependency_invalid');
        }
      }
      break;
    }
    case 'run.settled':
      if (pendingToolRequests(events, event.runId).length) throw new Error('run_tool_result_missing');
      break;
  }
}
