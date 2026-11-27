import { DELEGATED_APPROVAL_PRESET } from '@achbit/protocol';
import type { JsonObject, NewSessionEvent, RunSettlement, SessionEvent, UserSettings } from '@achbit/protocol';
import { LoopFailure } from './loopFailure.js';

export type CapacityResource = 'concurrentTasks' | 'openMembers' | 'callsThisRun';
type Need = { resource: CapacityResource; used: number; limit: number; requested: number };
export type CapacityQuote = { ownerSessionId: string; ownerRunId: string; needs: Need[] };
export type CapacityGrant = { sessionId: string; runId: string; callId: string; quote: CapacityQuote; source: 'user' | 'agent' };
export type CapacityCall = Extract<SessionEvent, { type: 'agent.control.completed' }>;
export type CapacityTicket = { approvalId: string; afterSequence: number; quote: CapacityQuote; reviewRequestId?: string };
export type CapacityReservation = Extract<SessionEvent, { type: 'agent.task.created' }>;
// This key crosses the parent reservation and child input journals. Recovery reads it; it never resubmits it.
export const capacityInputId = (taskId: string) => `agent-input:${taskId}`;
export class CapacityStartUnknown extends LoopFailure {
  constructor(readonly taskId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super('agent_capacity_start_indeterminate', `Cannot verify child startup for ${taskId}: ${detail}. The assignment was not repeated.`);
    this.cause = cause;
  }
}
export type CapacitySettlement = Extract<SessionEvent, { type: 'agent.capacity.settled' }>;

export const delegatedCapacity = (permissions: UserSettings) => Object.entries(DELEGATED_APPROVAL_PRESET)
  .every(([key,value]) => permissions[key] === value);

export class CapacityNeeded extends Error {
  constructor(readonly quote: CapacityQuote, readonly delegated: boolean) { super('agent_capacity_review_required'); }
}

export function capacityNeeds(usage: Record<CapacityResource, [number, number, number]>): Need[] {
  return (Object.entries(usage) as [CapacityResource, [number, number, number]][]).flatMap(([resource,[used,limit,count]]) =>
    count && used + count > limit ? [{ resource, used, limit, requested: used + count }] : []);
}

export function coversCapacity(approved: CapacityQuote, current: CapacityQuote): boolean {
  return approved.ownerSessionId === current.ownerSessionId && approved.ownerRunId === current.ownerRunId
    && current.needs.every(need => approved.needs.some(old => old.resource === need.resource && old.limit === need.limit && old.requested >= need.requested));
}

export function capacityTicket(result: JsonObject): CapacityTicket | undefined {
  if (result.status !== 'capacityRequested') return;
  const value = result.capacity as CapacityQuote | undefined;
  if (result.executed !== false || typeof result.approvalId !== 'string' || !result.approvalId
    || result.reviewRequestId !== undefined && (typeof result.reviewRequestId !== 'string' || !result.reviewRequestId)
    || !Number.isSafeInteger(result.afterSequence) || Number(result.afterSequence) < 0
    || typeof value?.ownerSessionId !== 'string' || !value.ownerSessionId || typeof value.ownerRunId !== 'string' || !value.ownerRunId
    || !Array.isArray(value.needs) || !value.needs.length || value.needs.length > 3
    || !value.needs.every(n => n && ['concurrentTasks', 'openMembers', 'callsThisRun'].includes(n.resource)
      && Number.isSafeInteger(n.used) && Number.isSafeInteger(n.limit) && n.limit > 0 && n.used >= n.limit
      && Number.isSafeInteger(n.requested) && n.requested === n.used + 1)
    || new Set(value.needs.map(n => n.resource)).size !== value.needs.length) {
    throw new LoopFailure('agent_capacity_ticket_invalid', 'Invalid recorded subagent capacity request.');
  }
  return { approvalId: result.approvalId, quote: value, afterSequence: Number(result.afterSequence),
    ...(typeof result.reviewRequestId === 'string' ? { reviewRequestId: result.reviewRequestId } : {}) };
}

/** Called only after child cleanup is confirmed. Close deferred calls before another run can replay them. */
export function terminalCapacityEvents(events: readonly SessionEvent[], runId: string, settlement: RunSettlement): NewSessionEvent[] {
  const closed = new Set(events.flatMap(e => e.type === 'agent.capacity.settled' && e.runId === runId ? [e.callId] : []));
  return events.flatMap((call): NewSessionEvent[] => {
    if (call.type !== 'agent.control.completed' || call.runId !== runId || closed.has(call.callId)) return [];
    const ticket = capacityTicket(call.payload.result);
    if (!ticket) return [];
    const created = events.find(e => e.type === 'agent.task.created' && e.runId === runId && e.callId === call.callId);
    const task = created?.type === 'agent.task.created' ? created.payload : undefined;
    const decision = events.find(e => e.type === 'approval.resolved' && e.runId === runId && e.callId === call.callId
      && e.payload.approvalId === ticket.approvalId);
    const result: JsonObject = task && events.some(e => e.type === 'agent.task.started' && e.runId === runId && e.payload.taskId === task.taskId)
      ? { taskId: task.taskId, agentId: task.agentSessionId }
      : decision?.type === 'approval.resolved' && decision.payload.decision === 'deny'
        ? { status: 'denied', executed: false, reason: decision.payload.reason ?? 'Capacity denied.' }
        : { status: settlement.outcome === 'cancelled' ? 'cancelled' : 'notStarted', executed: false };
    return [{ type: 'agent.capacity.settled', sessionId: call.sessionId, runId, callId: call.callId,
      payload: { approvalId: ticket.approvalId, result } }];
  });
}

/** Join the two durable halves of a deferred control at its first model-view boundary. */
export function settledCapacityCall(event: CapacityCall, settled: CapacitySettlement): CapacityCall {
  const ticket = capacityTicket(event.payload.result);
  if (!ticket || ticket.approvalId !== settled.payload.approvalId || event.sessionId !== settled.sessionId || event.runId !== settled.runId || event.callId !== settled.callId) {
    throw new LoopFailure('agent_capacity_identity_mismatch', 'Capacity result belongs to another dispatch.');
  }
  const result = settled.payload.result;
  return { ...event, sequence: settled.sequence, payload: { ...event.payload, result: {
    ...result, ...(result.executed !== false && typeof result.taskId === 'string' && event.payload.operation.delivery === 'wait'
      ? {wait:{afterSequence:ticket.afterSequence}} : {}),
  } } };
}
