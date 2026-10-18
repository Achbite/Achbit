import { isSessionAuthorizationScope } from '@deepcode/protocol';
import type { ConversationSessionStatus, RunLifecycleEvent, SessionEvent } from '@deepcode/protocol';

/** Only the pending identities needed to apply run status transitions. */
export interface RunLifecycleState {
  run: ConversationSessionStatus['run'];
  pendingInteractions: readonly { interactionId: string; runId: string; mode?: 'wait' | 'continue' }[];
  pendingPlan: { planId: string; revision: number; runId: string; callId: string } | null;
  pendingApprovals: readonly { approvalId: string; runId: string; callId: string }[];
  pendingApproval: { approvalId: string; runId: string; callId: string } | null;
}

export function emptyRunLifecycle(): RunLifecycleState {
  return { run: null, pendingInteractions: [], pendingPlan: null, pendingApprovals: [], pendingApproval: null };
}

/** Shared by full Session replay and compact navigation reads. Payload admission
 * and execution validation remain at their existing owners. */
export function reduceRunLifecycle(previous: RunLifecycleState, event: RunLifecycleEvent): RunLifecycleState {
  const next = { ...previous };
  const resume = (runId: string) => {
    if (next.run?.runId !== runId) throw new Error('run_resume_identity_mismatch');
    next.run = { runId, status: 'running' };
  };
  const closeInputs = (runId: string) => {
    next.pendingInteractions = next.pendingInteractions.filter(item => item.runId !== runId);
    next.pendingApprovals = [];
    next.pendingApproval = null;
  };
  switch (event.type) {
    case 'run.started':
      next.run = { runId: event.runId, status: 'running' };
      break;
    case 'run.waiting':
      next.run = { runId: event.runId, status: 'waiting', waitingReason: event.payload.reason };
      break;
    case 'run.finishing':
      next.run = { runId: event.runId, status: 'releasing' };
      closeInputs(event.runId);
      break;
    case 'run.runtime.release_failed':
      next.run = { runId: event.runId, status: 'releaseFailed' };
      break;
    case 'run.runtime.released':
      next.run = { runId: event.runId, status: 'releasing' };
      break;
    case 'run.settled':
      next.run = { runId: event.runId, status: event.payload.outcome };
      closeInputs(event.runId);
      break;
    case 'session.permissions.updated':
      if (next.run?.status === 'waiting' && next.run.waitingReason === 'approval') resume(next.run.runId);
      break;
    case 'interaction.requested':
      next.pendingInteractions = [...next.pendingInteractions, {
        runId: event.runId, interactionId: event.payload.interactionId,
        ...(event.payload.mode ? { mode: event.payload.mode } : {}),
      }];
      break;
    case 'interaction.resolved':
      next.pendingInteractions = next.pendingInteractions.filter(item => (
        item.runId !== event.runId || item.interactionId !== event.payload.interactionId
      ));
      if (next.run?.status === 'waiting' && next.run.waitingReason === 'userInput'
        && !next.pendingInteractions.some(item => item.runId === event.runId && item.mode !== 'continue')) resume(event.runId);
      break;
    case 'plan.published':
      next.pendingPlan = { ...event.payload, runId: event.runId, callId: event.callId };
      break;
    case 'plan.review.requested':
      resume(event.runId);
      break;
    case 'plan.confirmed':
    case 'plan.revision.requested':
    case 'plan.cancelled':
      next.pendingPlan = null;
      resume(event.runId);
      break;
    case 'plan.invalidated':
      if (next.pendingPlan?.planId === event.payload.planId && next.pendingPlan.revision === event.payload.revision) {
        next.pendingPlan = null;
        resume(event.runId);
      }
      break;
    case 'approval.requested':
      next.pendingApprovals = [...next.pendingApprovals.filter(item => item.callId !== event.callId),
        { approvalId: event.payload.approvalId, runId: event.runId, callId: event.callId }];
      break;
    case 'approval.resolved':
      next.pendingApprovals = next.pendingApprovals.filter(item => item.approvalId !== event.payload.approvalId);
      // Session grants survive edits even when their original run is excluded.
      if (event.payload.decision !== 'allow'
        || !(event.payload.authorizationScope && isSessionAuthorizationScope(event.payload.authorizationScope))
        || next.run?.runId === event.runId) resume(event.runId);
      break;
    case 'tool.input-rejected':
    case 'tool.not-executed':
    case 'tool.completed':
      if (next.pendingApprovals.some(item => item.callId === event.callId)) {
        next.pendingApprovals = next.pendingApprovals.filter(item => item.callId !== event.callId);
        resume(event.runId);
      }
      break;
  }
  next.pendingApproval = next.pendingApprovals[0] ?? null;
  return next;
}

/** The in-process reducer/adapter selects the same fields as the journal SQL.
 * In particular run.started never copies its runtimeSnapshot. */
export function projectRunLifecycleEvent(event: SessionEvent): RunLifecycleEvent | null {
  const base = { sessionId: event.sessionId, sequence: event.sequence };
  switch (event.type) {
    case 'run.started':
    case 'run.finishing':
    case 'run.runtime.release_failed':
    case 'run.runtime.released':
      return { ...base, type: event.type, runId: event.runId, payload: {} };
    case 'run.waiting':
      return { ...base, type: event.type, runId: event.runId, payload: { reason: event.payload.reason } };
    case 'run.settled':
      return { ...base, type: event.type, runId: event.runId, payload: { outcome: event.payload.outcome } };
    case 'interaction.requested':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: {
        interactionId: event.payload.interactionId, ...(event.payload.mode ? { mode: event.payload.mode } : {}),
      } };
    case 'interaction.resolved':
      return { ...base, type: event.type, runId: event.runId, payload: { interactionId: event.payload.interactionId } };
    case 'plan.published':
    case 'plan.review.requested':
    case 'plan.confirmed':
    case 'plan.revision.requested':
    case 'plan.cancelled':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId,
        payload: { planId: event.payload.planId, revision: event.payload.revision } };
    case 'plan.invalidated':
      return { ...base, type: event.type, runId: event.runId,
        payload: { planId: event.payload.planId, revision: event.payload.revision } };
    case 'approval.requested':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: { approvalId: event.payload.approvalId } };
    case 'approval.resolved':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: {
        approvalId: event.payload.approvalId, decision: event.payload.decision, authorityId: event.payload.authorityId,
        ...(event.payload.authorizationScope ? { authorizationScope: event.payload.authorizationScope } : {}),
      } };
    case 'approval.revoked':
      return { ...base, type: event.type, runId: event.runId, payload: { authorityId: event.payload.authorityId } };
    case 'tool.input-rejected':
    case 'tool.not-executed':
    case 'tool.completed':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: {} };
    case 'session.permissions.updated':
      return { ...base, type: event.type, payload: {} };
    case 'conversation.revised':
      return { ...base, type: event.type, payload: {
        fromSequence: event.payload.fromSequence, throughSequence: event.payload.throughSequence,
      } };
    default:
      return null;
  }
}
