import type { NewSessionEvent, ProviderAttemptFact, ProviderAttemptTiming, ProviderTextSegmentTiming, ProviderEvent, ProviderRequest } from '@achbit/protocol';
import { errorFact, ProviderCompletedFailure, ProviderReportedFailure } from './loopFailure.js';
import type { AgentLoopDeps } from './loop.js';

export const PROVIDER_MAX_ATTEMPTS = 5;

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One logical generation, fresh accumulators per send, one shared journal. */
export async function withProviderAttempts<T>(
  request: ProviderRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  consume: (attempt: ProviderRequest, onCompleted: () => void, onEvent: (event: ProviderEvent) => void) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason;
    const providerAttemptId = deps.nextId('provider-attempt');
    const started = performance.now();
    const timing: ProviderAttemptTiming = { clockDomain: `provider-attempt:${providerAttemptId}`, startedAt: new Date().toISOString() };
    const segments = new Map<string, { mono: number; fact: ProviderTextSegmentTiming }>();
    const endSegments = (outcome: 'completed' | 'interrupted') => {
      for (const segment of segments.values()) if (!segment.fact.endedAt) {
        segment.fact.endedAt = new Date().toISOString(); segment.fact.durationMs = performance.now() - segment.mono; segment.fact.outcome = outcome;
      }
    };
    const onEvent = (event: ProviderEvent) => {
      const messageText = event.type === 'output.item.completed' && event.data.item.type === 'message' && Array.isArray(event.data.item.content)
        ? event.data.item.content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : undefined;
      const text = event.type === 'text.delta' ? event.data.text : event.type === 'assistant.message' ? event.data.content : messageText;
      const kind = text?.trim() ? 'text' : event.type === 'tool.call' || event.type === 'tool.call.delta' ? 'tool'
        : event.type === 'reasoning.delta' && event.data.text ? 'reasoning' : undefined;
      if (!kind) return;
      const wall = new Date().toISOString(), elapsed = performance.now() - started;
      if (!timing.firstContentAt) { timing.firstContentAt = wall; timing.firstContentMs = elapsed; timing.firstContentKind = kind; }
      if (kind === 'text') {
        if (!timing.firstTextAt) { timing.firstTextAt = wall; timing.firstTextMs = elapsed; }
        const outputIndex = event.type === 'text.delta' || event.type === 'output.item.completed' ? event.data.outputIndex : undefined;
        const key = `${providerAttemptId}:${outputIndex ?? 'aggregate'}`;
        let segment = segments.get(key);
        if (!segment) {
          segment = { mono: performance.now(), fact: { outputItemId: key, ...(outputIndex === undefined ? {} : { outputIndex }), startedAt: wall, characters: 0 } };
          segments.set(key, segment);
        }
        segment.fact.characters = event.type === 'text.delta' ? segment.fact.characters + text!.length : text!.length;
        if (event.type === 'output.item.completed' || event.type === 'assistant.message') {
          segment.fact.endedAt = wall; segment.fact.durationMs = performance.now() - segment.mono; segment.fact.outcome = 'completed';
        }
      }
    };
    const finish = (outcome: 'completed' | 'interrupted') => {
      endSegments(outcome); timing.completedAt = new Date().toISOString(); timing.durationMs = performance.now() - started;
      if (segments.size) timing.textSegments = [...segments.values()].map(segment => ({ ...segment.fact }));
    };
    const base = { providerRequestId: request.requestId, providerAttemptId, attempt, purpose: request.purpose };
    const record = (phase: ProviderAttemptFact['phase'], extra: Partial<ProviderAttemptFact> = {}) => deps.commit({
      type: 'provider.attempt.updated', sessionId: request.sessionId, runId: request.runId,
      payload: { ...base, phase, timing: { ...timing }, ...extra },
    } satisfies NewSessionEvent);
    await record('started');
    deps.updateAssistantDraft(null);
    deps.resetReasoning?.();
    let completed = false;
    const classifyFailure = (error: unknown) => completed && !(signal.aborted && error === signal.reason)
      ? new ProviderCompletedFailure(error) : error;
    let result: T;
    try {
      result = await consume({ ...request, providerAttemptId, attempt }, () => { completed = true; }, onEvent);
    } catch (error) {
      finish('interrupted');
      const failure = errorFact(error);
      try { await record('failed', { error: failure }); }
      catch (recordError) { throw classifyFailure(new AggregateError([error, recordError], failure.message)); }
      deps.updateAssistantDraft(null);
      deps.resetReasoning?.();
      if (completed || signal.aborted) throw classifyFailure(error);
      const diagnostic = failure.diagnostics;
      if (!(error instanceof ProviderReportedFailure) || diagnostic?.source !== 'providerTransport'
        || diagnostic.category !== 'network' || !diagnostic.retryable || attempt === PROVIDER_MAX_ATTEMPTS) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      await record('retryWaiting', { error: failure, retryAt: String(Date.now() + delay) });
      await waitForRetry(delay, signal);
      continue;
    }
    // Persistence failures after a successful generation must never resend it.
    finish('completed');
    try { await record('completed'); }
    catch (error) { throw classifyFailure(error); }
    return result;
  }
  throw new Error('provider_attempt_budget_invalid');
}
