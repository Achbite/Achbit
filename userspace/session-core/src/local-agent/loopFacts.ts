import { permissionSettings } from '@achbit/protocol';
import type {
  SessionEvent, NewSessionEvent, RunRuntimeSnapshot, RunSettlement, LocalAgentError,
} from '@achbit/protocol';
import type { ProviderControlRejection, LoopSnapshot, ProviderTurnCompletion, LoopResult } from './loopTypes.js';
import { recoverSession } from './reducer.js';
import type { SessionState } from './reducer.js';
import { LoopFailure, errorFact } from './loopFailure.js';
import { activeConversationEvents } from './conversationHistory.js';
import { requestResourceBindings } from './workspaceBindings.js';
import { SessionControlError } from './sessionControls.js';

export function latestAgentEvidenceSequence(events: readonly SessionEvent[], runId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.type === 'agent.task.completed' || event.type === 'agent.message.received' || event.type === 'wake.triggered') && event.runId === runId) {
      return event.sequence;
    }
  }
  return 0;
}

export function controlRejectionFact(
  sessionId: string,
  runId: string,
  rejection: ProviderControlRejection,
): NewSessionEvent {
  return {
    type: 'session.control.rejected', sessionId, runId, callId: rejection.callId,
    payload: {
      providerCallId: rejection.providerCallId,
      toolName: rejection.toolName,
      input: { ...rejection.input },
      error: { ...rejection.error },
    },
  };
}

export function hasSettlement(events: readonly SessionEvent[], runId: string): boolean {
  return events.some((event) => event.type === 'run.settled' && event.runId === runId);
}

export function uncompletedProviderComposition(
  snapshot: LoopSnapshot,
  runId: string,
): SessionState['contextCompositions'][number] | null {
  return snapshot.state.contextCompositions.find((receipt) => (
    receipt.runId === runId
    && snapshot.state.providerTurns[receipt.providerRequestId] === undefined
  )) ?? null;
}

export function runRuntimeSnapshot(snapshot: LoopSnapshot, runId: string): RunRuntimeSnapshot {
  const runtime = snapshot.state.runRuntimeSnapshots[runId];
  if (!runtime) throw new LoopFailure('run_runtime_snapshot_missing', '当前 run 缺少运行时快照。');
  const view = { ...runtime, ...snapshot.state.runToolViews[runId] };
  if (snapshot.state.run?.runId === runId && snapshot.state.run.hostBinding) {
    view.environment = { ...view.environment, hostBinding: { ...snapshot.state.run.hostBinding } };
  }
  const sessionPermissions = snapshot.state.publishedPermissions ?? permissionSettings({ ...runtime.permissions, ...snapshot.state.permissionOverrides });
  const permissions = runtime.planMode === 'manual' ? { ...sessionPermissions, 'agent.permissions.workspaceMutation': 'plan' } : sessionPermissions;
  return { ...view, permissions };
}

export function providerTurnSettledEvent(
  sessionId: string,
  runId: string,
  completion: ProviderTurnCompletion,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: completion.providerRequestId,
      purpose: completion.purpose,
      providerRuntimeRef: completion.providerRuntimeRef,
      outcome: 'completed',
      orderedCallIds: [...completion.orderedCallIds],
      ...(completion.reasoningContent !== undefined
        ? { reasoningContent: completion.reasoningContent }
        : {}),
      ...(completion.reasoningSignature !== undefined
        ? { reasoningSignature: completion.reasoningSignature }
        : {}),
      ...(completion.hostedWebSearchCalls !== undefined
        ? {
            hostedWebSearchCalls: completion.hostedWebSearchCalls
              .map((item) => structuredClone(item)),
          }
        : {}),
      ...(completion.toolCallInputs ? { toolCallInputs: structuredClone(completion.toolCallInputs) } : {}),
      ...(completion.orderedOutputBlocks !== undefined
        ? {
            orderedOutputBlocks: completion.orderedOutputBlocks.map((block) => ({
              ...block,
              item: structuredClone(block.item),
            })),
          }
        : {}),
    },
  };
}

export function providerTurnTerminalEvent(
  sessionId: string,
  runId: string,
  composition: SessionState['contextCompositions'][number],
  providerRuntimeRef: string,
  settlement: Extract<RunSettlement, { outcome: 'failed' | 'indeterminate' | 'cancelled' }>,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: composition.providerRequestId,
      purpose: composition.purpose,
      providerRuntimeRef,
      ...settlement,
      ...('error' in settlement ? { error: { ...settlement.error } } : {}),
    },
  };
}

export function orderedProviderCallFacts(
  completion: ProviderTurnCompletion,
  facts: readonly NewSessionEvent[],
): NewSessionEvent[] {
  const byCallId = new Map<string, NewSessionEvent>();
  for (const fact of facts) {
    if (!('callId' in fact) || !fact.callId || byCallId.has(fact.callId)) {
      throw new LoopFailure(
        'provider_turn_call_fact_invalid',
        'Provider turn 的调用事实缺少或重复 LogicalCallId。',
      );
    }
    byCallId.set(fact.callId, fact);
  }
  if (
    byCallId.size !== completion.orderedCallIds.length
    || completion.orderedCallIds.some((callId) => !byCallId.has(callId))
  ) {
    throw new LoopFailure(
      'provider_turn_call_fact_mismatch',
      'Provider turn 完成事实与本 turn 的调用事实集合不一致。',
    );
  }
  return completion.orderedCallIds.map((callId) => byCallId.get(callId)!);
}

export function settlementResult(events: readonly SessionEvent[], runId: string): LoopResult {
  const event = events.findLast(
    (candidate): candidate is Extract<SessionEvent, { type: 'run.settled' }> => (
      candidate.type === 'run.settled' && candidate.runId === runId
    ),
  );
  if (!event) throw new Error('run_settlement_missing');
  return { status: 'settled', runId, outcome: event.payload.outcome };
}

export function finishingResult(runId: string, settlement: RunSettlement): LoopResult {
  return {
    status: 'finishing',
    runId,
    settlement: settlement.outcome === 'completed'
      ? { ...settlement }
      : settlement.outcome === 'failed' || settlement.outcome === 'indeterminate'
        ? { outcome: settlement.outcome, error: { ...settlement.error } }
        : { outcome: 'cancelled' },
  };
}

export function loopSnapshot(sessionId: string, events: readonly SessionEvent[]): LoopSnapshot {
  return { journalEvents: [...events], events: activeConversationEvents(events), state: recoverSession(sessionId, events) };
}

export function preparingRequestedPlan(snapshot: LoopSnapshot, runId: string): boolean {
  return snapshot.state.runRuntimeSnapshots[runId]?.planMode === 'manual' && !snapshot.state.activePlanRef;
}

export function runWorkspaceContext(snapshot: LoopSnapshot, runId: string) {
  const run = snapshot.state.run;
  if (!run || run.runId !== runId) {
    throw new LoopFailure('run_workspace_snapshot_missing', '当前 run 缺少已记录的工作区绑定。');
  }
  return { directoryBindings: run.workspaceBindings,
    workspaceBindings: requestResourceBindings(run.workspaceBindings, snapshot.events) };
}

export function positiveOrZeroInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('run_cancelled');
}

export function localAgentError(error: unknown): LocalAgentError {
  if (error instanceof LoopFailure) return errorFact(error);
  if (error instanceof SessionControlError) return { code: error.code, message: error.message };
  return errorFact(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
