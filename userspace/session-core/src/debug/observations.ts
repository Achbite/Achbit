import { providerTextStreamId } from '../local-agent/streamIdentity.js';
import { LOCAL_AGENT_PROTOCOL_VERSION } from '@deepcode/protocol';
import type { SessionEvent, SessionProjection, AssistantDraftProjection } from '@deepcode/protocol';
import type { SessionObservationInput, SessionObservationSink } from '../local-agent/observation.js';

type Item = Record<string, unknown>;
type Subscription = {
  id: string; sessionId: string; runId?: string; budget: number; sequence: number; lastSentSequence: number; lastEventSequence: number;
  phase: 'active' | 'closed' | 'failed'; pending: Item[]; pendingBytes: number; oldestAt?: number;
  currentRequest?: string; currentTextKey?: string; committedStreams: Map<string, string>;
  firstTextSent: boolean; textTimer?: ReturnType<typeof setTimeout>;
  ageTimer?: ReturnType<typeof setTimeout>; ranges: Map<string, number>; attempts: Map<string, string>;
  calls: Map<string, { attemptId: string; groupId?: string; requestEventSequence: number }>; failure?: Item; lastActivityAt?: string;
  childDecisionSequences: Map<string, number>;
};
type TaskRoute = { taskId: string; agentSessionId: string; parentRunId: string; childRunId?: string };
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

/** Debug-only derivation from original facts. The queue owns deliveries, never execution. */
export class DebugObservations implements SessionObservationSink {
  readonly subscriptions = new Map<string, Subscription>();
  private outgoing: Array<{ subscription: Subscription; value: Item; bytes: number }> = [];
  private outgoingBytes = 0;
  private sending = false;
  private taskOwners = new Map<string, { revision: number; tasks: Map<string, TaskRoute> }>();
  constructor(readonly send: (frame: unknown) => Promise<void>, readonly now = () => Date.now()) {}

  subscribe(input: { subscriptionId: string; sessionId: string; runId?: string; inputBudgetTokens?: number }): Item {
    if (!input.subscriptionId || !input.sessionId || this.subscriptions.has(input.subscriptionId)) throw new Error('observation_subscription_invalid');
    const budget = input.inputBudgetTokens ?? 100000;
    if (!Number.isSafeInteger(budget) || budget < 256) throw new Error('observation_input_budget_invalid');
    const subscription: Subscription = { id: input.subscriptionId, sessionId: input.sessionId, ...(input.runId ? { runId: input.runId } : {}),
      budget: Math.min(100000, budget), sequence: 0, lastSentSequence: 0, lastEventSequence: 0, phase: 'active', pending: [], pendingBytes: 0,
      firstTextSent: false, committedStreams: new Map(), ranges: new Map(), attempts: new Map(), calls: new Map(), childDecisionSequences: new Map() };
    this.subscriptions.set(subscription.id, subscription);
    return this.status(subscription.id);
  }
  status(id: string): Item {
    const s = this.subscriptions.get(id); if (!s) throw new Error('observation_subscription_not_found');
    return { subscriptionId: s.id, sessionId: s.sessionId, runId: s.runId, status: s.phase, lastObservationSequence: s.sequence, lastSentObservationSequence: s.lastSentSequence,
      lastEventSequence: s.lastEventSequence, lastActivityAt: s.lastActivityAt, pendingEstimatedTokens: Math.ceil(s.pendingBytes / 3),
      inputBudgetTokens: s.budget, coverage: s.failure ? 'partial' : 'complete', ...(s.failure ? { error: s.failure } : {}) };
  }
  close(id: string): Item {
    const s = this.subscriptions.get(id); if (!s) throw new Error('observation_subscription_not_found');
    if (s.phase === 'active') { this.flush(s, 'subscriptionClosed'); s.phase = 'closed'; this.clearTimers(s); }
    return this.status(id);
  }
  dispose(): void { for (const s of this.subscriptions.values()) { this.clearTimers(s); s.phase = 'closed'; } this.outgoing = []; this.outgoingBytes = 0; this.taskOwners.clear(); }
  seedTasks(snapshot: Pick<SessionProjection, 'sessionId' | 'revision' | 'agentTasks'>): void {
    if ((this.taskOwners.get(snapshot.sessionId)?.revision ?? -1) > snapshot.revision) return;
    this.taskOwners.set(snapshot.sessionId, { revision: snapshot.revision, tasks: new Map((snapshot.agentTasks ?? [])
      .filter(task => task.status === 'running' && task.childRunId).map(task => [task.taskId, { taskId: task.taskId,
        agentSessionId: task.agentSessionId, parentRunId: task.parentRunId, childRunId: task.childRunId }])) });
  }
  failed(sessionId: string, error: unknown): void {
    for (const s of this.subscriptions.values()) if (s.sessionId === sessionId && s.phase === 'active') this.fail(s, 'observation_capture_failed', String(error));
  }
  accept(input: SessionObservationInput): void {
    if (input.kind === 'event') {
      this.trackTasks(input.event);
      this.childDecision(input.event);
    }
    for (const s of this.subscriptions.values()) {
      if (s.phase !== 'active' || s.sessionId !== input.sessionId) continue;
      const runId = input.kind === 'event' ? ('runId' in input.event ? input.event.runId : undefined)
        : input.kind === 'draft' ? input.draft.runId : input.runId;
      if (s.runId && runId && s.runId !== runId) continue;
      try {
        s.lastActivityAt = new Date(this.now()).toISOString();
        if (input.kind === 'event') this.event(s, input.event);
        else if (input.kind === 'draft') this.draft(s, input.draft);
        else if (input.progress.type === 'output') {
          const call = s.calls.get(input.callId);
          const key = `tool:${input.callId}:${call?.attemptId ?? 'unknown'}:${input.progress.stream}`;
          const previous = s.ranges.get(key) ?? 0;
          const end = input.progress.offset + input.progress.bytes.length;
          if (end <= previous) continue;
          const begin = Math.max(input.progress.offset, previous);
          const bytes = input.progress.bytes.slice(begin - input.progress.offset);
          s.ranges.set(key, end);
          this.add(s, { kind: 'toolOutput', runId, callId: input.callId, ...call, stream: input.progress.stream,
            range: { unit: 'byte', start: begin, end }, bytes, ...(begin > previous ? { missingRange: { start: previous, end: begin } } : {}) });
        }
      } catch (error) { this.fail(s, 'observation_capture_failed', String(error)); }
    }
  }
  private trackTasks(event: SessionEvent): void {
    if (event.type !== 'agent.task.created' && event.type !== 'agent.task.started' && event.type !== 'agent.task.completed') return;
    const owner = this.taskOwners.get(event.sessionId) ?? { revision: 0, tasks: new Map<string, TaskRoute>() };
    if (event.sequence <= owner.revision) return;
    owner.revision = event.sequence;
    if (event.type === 'agent.task.created') owner.tasks.set(event.payload.taskId, { taskId: event.payload.taskId,
      agentSessionId: event.payload.agentSessionId, parentRunId: event.runId });
    else if (event.type === 'agent.task.started') {
      const task = owner.tasks.get(event.payload.taskId);
      if (task) task.childRunId = event.payload.childRunId;
    } else owner.tasks.delete(event.payload.taskId);
    this.taskOwners.set(event.sessionId, owner);
  }
  private childDecision(event: SessionEvent): void {
    if (event.type !== 'approval.requested' && event.type !== 'interaction.requested' && event.type !== 'plan.published') return;
    const visit = (childSessionId: string, childRunId: string, route: Item[], seen: Set<string>) => {
      for (const [parentSessionId, owner] of this.taskOwners) {
        if (seen.has(parentSessionId)) continue;
        for (const task of owner.tasks.values()) {
          if (task.agentSessionId !== childSessionId || task.childRunId !== childRunId) continue;
          const agentRoute = [...route, { ...task, parentSessionId, childRunId }];
          for (const s of this.subscriptions.values()) {
            if (s.phase !== 'active' || s.sessionId !== parentSessionId || s.runId && s.runId !== task.parentRunId
              || event.sequence <= (s.childDecisionSequences.get(event.sessionId) ?? 0)) continue;
            try {
              s.childDecisionSequences.set(event.sessionId, event.sequence);
              s.lastActivityAt = new Date(this.now()).toISOString();
              this.add(s, { kind: 'event', sourceSessionId: event.sessionId, agentRoute, eventId: event.eventId,
                eventSequence: event.sequence, eventType: event.type, occurredAt: event.occurredAt,
                runId: event.runId, callId: event.callId, payload: event.payload });
              this.flush(s, 'decisionRequired');
            } catch (error) { this.fail(s, 'observation_capture_failed', String(error)); }
          }
          visit(parentSessionId, task.parentRunId, agentRoute, new Set([...seen, parentSessionId]));
        }
      }
    };
    visit(event.sessionId, event.runId, [], new Set([event.sessionId]));
  }
  private draft(s: Subscription, draft: AssistantDraftProjection): void {
    if (draft.activity?.purpose && draft.activity.purpose !== 'agent') return;
    const attempt = draft.providerAttemptId ?? s.attempts.get(draft.turnId);
    for (const block of draft.blocks) {
      if (block.kind === 'providerHosted' || !block.content.trim()) continue;
      const key = `text:${attempt ?? 'unknown'}:${block.streamId}`;
      const previous = s.ranges.get(key) ?? 0;
      if (block.content.length <= previous) continue;
      s.ranges.set(key, block.content.length);
      this.text(s, { kind: 'text', runId: draft.runId, providerRequestId: draft.turnId, providerAttemptId: attempt,
        outputItemId: block.streamId, outputIndex: block.outputIndex, phase: 'draft',
        range: { unit: 'utf16', start: previous, end: block.content.length }, text: block.content.slice(previous) }, block.content.slice(previous));
    }
  }
  private event(s: Subscription, event: SessionEvent): void {
    if (event.sequence <= s.lastEventSequence) return;
    s.lastEventSequence = event.sequence;
    if (event.type === 'provider.attempt.updated') { s.attempts.set(event.payload.providerRequestId, event.payload.providerAttemptId); s.currentRequest = event.payload.providerRequestId; }
    if (event.type === 'tool.requested') {
      s.calls.set(event.callId, { attemptId: event.payload.attemptId, groupId: s.currentRequest, requestEventSequence: event.sequence });
    }
    const base = { kind: 'event', eventId: event.eventId, eventSequence: event.sequence, eventType: event.type,
      occurredAt: event.occurredAt, ...('runId' in event ? { runId: event.runId } : {}), ...('callId' in event ? { callId: event.callId } : {}) };
    if ((event.type === 'message.committed' && event.payload.role === 'assistant') || event.type === 'narrative.committed') {
      const requestId = 'providerRequestId' in event.payload ? event.payload.providerRequestId : '';
      const attempt = s.attempts.get(requestId);
      // streamIdentity uses request/output keys. A committed item references drafts instead of repeating their body.
      const identity = event.type === 'narrative.committed' ? event.payload.narrativeId : event.payload.messageId;
      const streamId = s.committedStreams.get(identity) ?? providerTextStreamId(s.sessionId, event.runId!, requestId);
      const seen = s.ranges.get(`text:${attempt ?? 'unknown'}:${streamId}`) ?? 0;
      if (seen && event.payload.content.length > seen) this.add(s, { kind: 'text', providerRequestId: requestId,
        providerAttemptId: attempt, outputItemId: streamId, phase: 'committed', range: { unit: 'utf16', start: seen, end: event.payload.content.length }, text: event.payload.content.slice(seen) });
      const payload = { ...event.payload, ...(seen ? { content: undefined, contentReference: { source: 'sessionJournal', eventSequence: event.sequence }, draftCommitted: true } : {}) };
      this.add(s, { ...base, payload });
      if (!seen && event.payload.content.trim()) this.flush(s, s.firstTextSent ? 'textAfterTools' : 'firstText');
      else if (s.textTimer) this.flush(s, s.firstTextSent ? 'textAfterTools' : 'firstText');
      s.firstTextSent = true;
      return;
    }
    // A settled turn also repeats its output text and hidden reasoning; journal references preserve provenance without exporting either again.
    if (event.type === 'provider.turn.settled') {
      for (const block of ('orderedOutputBlocks' in event.payload ? event.payload.orderedOutputBlocks ?? [] : [])) {
        if (block.kind === 'narrative') s.committedStreams.set(block.narrativeId, providerTextStreamId(s.sessionId, event.runId, event.payload.providerRequestId, block.outputIndex));
        if (block.kind === 'finalMessage') s.committedStreams.set(block.messageId, providerTextStreamId(s.sessionId, event.runId, event.payload.providerRequestId, block.outputIndex));
      }
      const payload: Record<string, unknown> = { ...event.payload };
      delete payload.reasoningContent; delete payload.reasoningSignature; delete payload.orderedOutputBlocks; delete payload.toolCallInputs;
      this.add(s, { ...base, payload, outputReference: { source: 'sessionJournal', eventSequence: event.sequence } });
    } else if (event.type === 'tool.completed') {
      const original = event.payload.record;
      const request = s.calls.get(event.callId);
      const record = request ? { ...original, input: undefined,
        inputReference: { source: 'sessionJournal', eventSequence: request.requestEventSequence, callId: event.callId },
        recordReference: { source: 'kernelToolRecord', recordId: original.recordId } } : original;
      const observed = [...s.ranges].filter(([key]) => key.startsWith(`tool:${event.callId}:${record.attemptId}:`));
      this.add(s, { ...base, payload: { record: observed.length ? { ...record, output: undefined,
        outputReference: { source: 'kernelToolRecord', recordId: record.recordId, streamedRanges: Object.fromEntries(observed) } } : record } });
    } else if (event.type !== 'context.composed') this.add(s, { ...base, payload: event.payload });
    if (event.type === 'approval.requested' || event.type === 'interaction.requested' || event.type === 'plan.published' || event.type === 'run.waiting') this.flush(s, 'decisionRequired');
    if (event.type === 'run.settled') { this.flush(s, 'runSettled'); s.phase = 'closed'; this.clearTimers(s); }
  }
  private text(s: Subscription, item: Item, text: string): void {
    this.add(s, item);
    const key = `${item.providerAttemptId}:${item.outputItemId}`;
    if (s.currentTextKey === key && !s.textTimer) return;
    s.currentTextKey = key;
    if (!s.textTimer) s.textTimer = setTimeout(() => { s.textTimer = undefined; this.flush(s, s.firstTextSent ? 'textAfterTools' : 'firstText'); s.firstTextSent = true; }, 1000);
    if (/[。！？.!?\n]\s*$/u.test(text)) { this.flush(s, s.firstTextSent ? 'textAfterTools' : 'firstText'); s.firstTextSent = true; }
  }
  private add(s: Subscription, item: Item): void {
    let bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > s.budget * 3 && (item.kind === 'text' || item.kind === 'toolOutput')) {
      const range = item.range as { unit: string; start: number; end: number };
      const content = item.kind === 'text' ? String(item.text) : item.bytes as number[];
      const chunkSize = Math.max(1, Math.floor((s.budget * 3 - 640) / 8));
      for (let offset = 0; offset < content.length;) {
        let end = Math.min(offset + chunkSize, content.length);
        if (typeof content === 'string' && end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1]!)) end++;
        const part = content.slice(offset, end);
        this.add(s, { ...item, range: { unit: range.unit, start: range.start + offset, end: range.start + end },
          ...(item.kind === 'text' ? { text: part } : { bytes: part }) });
        if (s.phase !== 'active') return;
        offset = end;
      }
      return;
    }
    // A single durable result can exceed the receiver's context. Deliver its real source reference; do not claim inline completeness.
    if (bytes > s.budget * 3 && item.kind === 'event') {
      item = { kind: 'eventReference', eventType: item.eventType, eventSequence: item.eventSequence, eventId: item.eventId,
        runId: item.runId, callId: item.callId, sourceSessionId: item.sourceSessionId, agentRoute: item.agentRoute,
        source: 'sessionJournal', contentDelivery: 'referenced', contentBytes: bytes };
      bytes = Buffer.byteLength(JSON.stringify(item));
    }
    if (s.pendingBytes + bytes > s.budget * 3 && s.pending.length) this.flush(s, 'inputBudget');
    if (bytes > MAX_QUEUE_BYTES || s.pendingBytes + bytes > MAX_QUEUE_BYTES) { this.fail(s, 'observation_capture_budget_exceeded', 'A live fragment exceeded the bounded capture capacity.'); return; }
    if (!s.pending.length) {
      s.oldestAt = this.now();
      s.ageTimer = setTimeout(() => this.flush(s, 'maxAge'), 180000);
    }
    s.pending.push(item); s.pendingBytes += bytes;
    if (s.pendingBytes >= s.budget * 3) this.flush(s, s.budget < 100000 ? 'inputBudget' : 'tokenBudget');
  }
  private flush(s: Subscription, reason: string): void {
    if (!s.pending.length || s.phase !== 'active') return;
    this.clearTimers(s);
    const value = { protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION, type: 'debug.observation', subscriptionId: s.id,
      observationId: `${s.id}:${++s.sequence}`, sequence: s.sequence, sessionId: s.sessionId, runId: s.runId,
      trigger: reason, createdAt: new Date(this.now()).toISOString(), lastEventSequence: s.lastEventSequence,
      heldMs: this.now() - (s.oldestAt ?? this.now()), estimatedTokens: Math.ceil(s.pendingBytes / 3), estimator: 'utf8-bytes/3',
      status: reason === 'runSettled' ? 'settled' : 'active', coverage: 'complete', items: s.pending };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    s.pending = []; s.pendingBytes = 0; s.oldestAt = undefined;
    if (this.outgoingBytes + bytes > MAX_QUEUE_BYTES) { this.fail(s, 'observation_receiver_backpressure', 'Observation delivery queue exceeded its bounded capacity.'); return; }
    this.outgoing.push({ subscription: s, value, bytes }); this.outgoingBytes += bytes;
    if (!this.sending) { this.sending = true; setImmediate(() => void this.pump()); }
  }
  private async pump(): Promise<void> {
    try {
      while (this.outgoing.length) {
        const next = this.outgoing.shift()!; this.outgoingBytes -= next.bytes;
        if (next.subscription.phase === 'failed' && next.value.status !== 'failed') continue;
        try { await this.send(next.value); next.subscription.lastSentSequence = next.value.sequence as number;
          if (next.value.status === 'failed' && next.subscription.failure) next.subscription.failure.notificationDelivered = true; }
        catch (error) { this.fail(next.subscription, 'observation_send_failed', String(error)); }
      }
    } finally { this.sending = false; }
  }
  private fail(s: Subscription, code: string, message: string): void {
    this.clearTimers(s); s.phase = 'failed';
    s.failure = { code, message, lastKnownEventSequence: s.lastEventSequence, lastQueuedObservationSequence: s.sequence,
      missingRange: { afterObservationSequence: s.lastSentSequence, through: 'unknown' }, notificationDelivered: false };
    s.pending = []; s.pendingBytes = 0;
    // A healthy connection can deliver a small terminal failure fact. Failed transport itself is never retried.
    const retained = this.outgoing.filter(item => item.subscription !== s);
    this.outgoing = retained; this.outgoingBytes = retained.reduce((total, item) => total + item.bytes, 0);
    if (code !== 'observation_send_failed') {
      const value = { protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION, type: 'debug.observation', subscriptionId: s.id,
        observationId: `${s.id}:${++s.sequence}`, sequence: s.sequence, sessionId: s.sessionId, status: 'failed', coverage: 'partial', error: s.failure, items: [] };
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (this.outgoingBytes + bytes <= MAX_QUEUE_BYTES) {
        this.outgoing.push({ subscription: s, value, bytes }); this.outgoingBytes += bytes;
        if (!this.sending) { this.sending = true; setImmediate(() => void this.pump()); }
      }
    }
  }
  private clearTimers(s: Subscription): void { clearTimeout(s.textTimer); clearTimeout(s.ageTimer); s.textTimer = undefined; s.ageTimer = undefined; }
}
