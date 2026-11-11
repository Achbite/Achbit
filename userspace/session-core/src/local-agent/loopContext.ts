import type { LoopSnapshot, AgentLoopDeps } from './loopTypes.js';
import type { RunRuntimeSnapshot, ContextCompositionReceipt, NewSessionEvent } from '@achbit/protocol';
import type { SessionCapabilities } from './plugins.js';
import { modelContextEvents } from './modelContext.js';
import { LoopFailure } from './loopFailure.js';
import { estimateContextInput } from './contextBudget.js';
import { scheduledContextCompaction, automaticCompactionCutoff } from './compaction.js';
import type { ContextCompactionRequestEvent } from './compaction.js';
import { runInputMessageEvent } from './contextComposer.js';
import { acquireCapabilities, releaseCapabilities } from './loopCapabilities.js';
import { runRuntimeSnapshot, runWorkspaceContext, throwIfAborted, providerTurnSettledEvent } from './loopFacts.js';
import { stageForRequest } from './sessionCapabilities.js';
import { consumeTextProvider } from './loopProvider.js';

export function prepareTurnBudget(
  snapshot: LoopSnapshot, runId: string, runtime: RunRuntimeSnapshot, receipt: ContextCompositionReceipt,
  capabilities: SessionCapabilities, nextId: (kind: string) => string,
): Extract<NewSessionEvent, { type: 'context.compaction.requested' }> | null {
  const compaction = capabilities.compaction;
  snapshot = { ...snapshot, events: modelContextEvents(snapshot.events) };
  const budget = Math.min(capabilities.context.windowTokens(runtime), runtime.provider.contextWindowTokens);
  if (!Number.isSafeInteger(budget) || budget <= runtime.provider.maxOutputTokens) {
    throw new LoopFailure('context_budget_invalid', '上下文预算必须为正整数，并为模型输出保留空间。');
  }
  // Handoff has no replayable history to compact, but its new user input and
  // reader schema still consume the same Provider input/output budget.
  if (compaction && snapshot.state.contextHandoff?.status !== 'reading') {
    const boundary = boundaryCompactionEvent(snapshot, runId, runtime, receipt, capabilities, 'nextRun', nextId);
    if (boundary) return boundary;
    const cutoff = compaction.pressureCutoff(snapshot, runId, receipt, runtime, budget);
    if (cutoff !== null) return { type: 'context.compaction.requested', sessionId: snapshot.state.sessionId, runId,
      payload: { compactionId: nextId('compaction'), providerRequestId: nextId('provider-request'), trigger: 'pressure', coveredThroughSequence: cutoff } };
  }
  const estimateInput = compaction?.estimateInput ?? estimateContextInput;
  if (estimateInput(snapshot, receipt, runtime) + runtime.provider.maxOutputTokens >= budget) {
    throw new LoopFailure('context_input_budget_exceeded', compaction
      ? '当前输入与工具定义加上输出预留已达到上下文预算；没有可继续压缩的历史。原始输入与资源保持完整。'
      : '当前输入与工具定义加上输出预留已达到上下文预算；当前组合未启用压缩。原始输入与资源保持完整。');
  }
  return null;
}

export function boundaryCompactionEvent(
  snapshot: LoopSnapshot, runId: string, runtime: RunRuntimeSnapshot, receipt: ContextCompositionReceipt,
  capabilities: SessionCapabilities, boundary: 'nextRun' | 'idle', nextId: (kind: string) => string,
): Extract<NewSessionEvent, { type: 'context.compaction.requested' }> | null {
  if (!capabilities.compaction || snapshot.state.contextHandoff?.status === 'reading') return null;
  snapshot = { ...snapshot, events: modelContextEvents(snapshot.events) };
  const scheduled = scheduledContextCompaction(snapshot.events);
  const input = runInputMessageEvent(snapshot.events, runId);
  if (!input) return null;
  const firstRequest = !snapshot.state.contextCompositions.some(item => item.runId === runId && item.purpose === 'agent');
  const cutoff = scheduled
    ? boundary === 'nextRun' && scheduled.sequence < input.sequence ? input.sequence - 1 : snapshot.state.revision
    : boundary === 'idle' || firstRequest
      ? automaticCompactionCutoff(snapshot, runId, receipt, runtime, capabilities.compaction.settings(runtime), boundary) : null;
  if (cutoff === null) return null;
  const focus = scheduled ? scheduled.payload.focus : boundary === 'nextRun' ? input.payload.content : undefined;
  return { type: 'context.compaction.requested', sessionId: snapshot.state.sessionId, runId,
    payload: { compactionId: scheduled?.payload.compactionId ?? nextId('compaction'),
      providerRequestId: nextId('provider-request'), trigger: scheduled ? 'agent' : 'automatic',
      coveredThroughSequence: cutoff, ...(focus ? { focus } : {}) } };
}

export async function performContextCompaction(
  snapshot: LoopSnapshot,
  requestEvent: ContextCompactionRequestEvent,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  const lease = acquireCapabilities(deps);
  let requestFailure: { error: unknown } | undefined;
  try {
    const cutoff = requestEvent.payload.coveredThroughSequence;
    const runtime = runRuntimeSnapshot(snapshot, runId);
    if (!lease.implementation.compaction) throw new LoopFailure('compaction_unavailable', 'This session has no context compaction component.');
    const prepared = await lease.implementation.compaction.prepare({
      toolStage: stageForRequest(lease.implementation, runtime, snapshot.state),
      toolGuidance: deps.composition.toolGuidance,
      sessionId: snapshot.state.sessionId,
      runId,
      runtime,
      ...runWorkspaceContext(snapshot, runId),
      events: modelContextEvents(snapshot.events),
      requestEvent,
    }, signal);
    throwIfAborted(signal);
    await commit({
      type: 'context.composed',
      sessionId: snapshot.state.sessionId,
      runId,
      payload: prepared.receipt,
    });
    const compacted = await consumeTextProvider(prepared.request, deps, signal);
    const facts: NewSessionEvent[] = [providerTurnSettledEvent(
      snapshot.state.sessionId,
      runId,
      compacted.completion,
    )];
    if (compacted.contextUsage) {
      facts.push({
        type: 'context.updated',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: compacted.contextUsage,
      });
    }
    facts.push({
      type: 'context.compacted',
      sessionId: snapshot.state.sessionId,
      runId,
      payload: {
        compactionId: requestEvent.payload.compactionId,
        providerRequestId: requestEvent.payload.providerRequestId,
        trigger: requestEvent.payload.trigger,
        coveredThroughSequence: cutoff,
        summary: compacted.summary,
      },
    });
    await commit(facts);
  } catch (error) {
    requestFailure = { error };
    throw error;
  } finally {
    await releaseCapabilities(lease, requestFailure);
  }
}
