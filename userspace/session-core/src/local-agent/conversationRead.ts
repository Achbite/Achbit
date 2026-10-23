import type {
  CommandJournalPort, ConversationReadQuery, ConversationReadResult, JsonObject, SessionEvent,
} from '@achbit/protocol';
import { reasoningReadItem } from './reasoningRead.js';
import { projectSession, recoverSession } from './reducer.js';
import { activeConversationEvents } from './conversationHistory.js';
import { imageCatalog, readImageReferences } from './visualContext.js';

const encoder = new TextEncoder();
const MAX_PAGE_BYTES = 48 * 1024;

export function decodeConversationReadQuery(value: unknown): ConversationReadQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('conversation_read_invalid');
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !['sessionId', 'view', 'before', 'limit', 'recordId', 'providerRequestId', 'offset', 'imageIds'].includes(key))
    || !identifier(query.sessionId)
    || (query.view !== undefined && (typeof query.view !== 'string' || !['summary', 'messages', 'tools', 'plans', 'context', 'reasoning', 'images'].includes(query.view)))
    || (query.imageIds !== undefined && (query.view !== 'images' || !Array.isArray(query.imageIds)
      || query.imageIds.some(id => !identifier(id))
      || new Set(query.imageIds).size !== query.imageIds.length || query.before !== undefined || query.limit !== undefined))
    || (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 1))
    || (query.limit !== undefined && (!Number.isInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 50))
    || (query.recordId !== undefined && (!identifier(query.recordId) || query.view !== 'tools'))
    || (query.providerRequestId !== undefined && (!identifier(query.providerRequestId) || !['context', 'reasoning'].includes(String(query.view))))
    || (query.offset !== undefined && (query.view !== 'reasoning' || !Number.isSafeInteger(query.offset) || Number(query.offset) < 0))) {
    throw new Error('conversation_read_invalid');
  }
  return query as unknown as ConversationReadQuery;
}

export async function readSessionEvents(journal: CommandJournalPort, sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of journal.read(sessionId)) {
    if (event.sessionId !== sessionId) throw new Error('session_event_identity_mismatch');
    if (event.sequence !== events.length + 1) throw new Error('session_event_sequence_gap');
    events.push(event);
  }
  if (!events.length) throw new Error('session_not_found');
  if (events[0].type !== 'session.created') throw new Error('session_creation_event_missing');
  return events;
}

export async function readConversation(journal: CommandJournalPort, query: ConversationReadQuery): Promise<ConversationReadResult> {
  const journalEvents = await readSessionEvents(journal, query.sessionId);
  const events = activeConversationEvents(journalEvents);
  const view = query.view ?? 'summary';
  const result: ConversationReadResult = {
    sessionId: query.sessionId, revision: journalEvents.at(-1)!.sequence, view, items: [], nextBefore: null,
  };
  if (view === 'images') {
    const images = query.imageIds !== undefined ? readImageReferences(events, query.imageIds)
      : [...imageCatalog(events).values()].filter(image => image.sequence < (query.before ?? Infinity))
        .sort((left, right) => left.sequence - right.sequence);
    // Keep all images from the boundary event so a sequence cursor cannot skip its siblings.
    const boundary = images[Math.max(0, images.length - (query.limit ?? 10))]?.sequence;
    const selected = query.imageIds !== undefined ? images : images.filter(image => image.sequence >= boundary);
    result.items = selected.map(({ imageId, label, sequence }) => ({ imageId, label, sequence }));
    if (selected.length < images.length) result.nextBefore = selected[0].sequence;
    return result;
  }
  if (view === 'summary') {
    const state = recoverSession(query.sessionId, journalEvents);
    const lastUser = state.messages.findLast((message) => message.role === 'user');
    const lastMessageId = projectSession(state).timeline.findLast(item => item.kind === 'message' && state.messages.some(message => message.messageId === item.messageId && message.role === 'assistant'));
    const lastAssistant = lastMessageId?.kind === 'message' ? state.messages.find(message => message.messageId === lastMessageId.messageId) : undefined;
    result.summary = {
      title: state.display.creationTitle,
      // These are persisted facts, including running/indeterminate. Do not infer
      // a terminal status from whether this reader has a live Actor.
      run: state.run ? {
        runId: state.run.runId, status: state.run.status,
        waitingReason: state.run.waitingReason ?? null,
      } : null,
      lastUserMessage: lastUser ? textExcerpt(lastUser.content, 4000) : null,
      lastAssistantMessage: lastAssistant ? textExcerpt(lastAssistant.content, 4000) : null,
      todo: state.todoList ? textExcerpt(JSON.stringify(state.todoList), 6000) : null,
      plans: state.plans.slice(-3).map((plan) => ({ planId: plan.planId, revision: plan.revision, title: plan.title, status: plan.status })),
      error: state.terminalError ? { code: state.terminalError.code, message: textExcerpt(state.terminalError.message, 2000) } : null,
      tokenUsage: { ...state.tokenUsage },
    };
  }
  const candidates = events.filter((event) => {
    if (event.sequence >= (query.before ?? Infinity)) return false;
    switch (view) {
      case 'summary': return isToolHistory(event);
      case 'messages': return event.type === 'message.committed' || event.type === 'narrative.committed';
      case 'tools': return event.type === 'tool.completed'
        ? !query.recordId || event.payload.record.recordId === query.recordId
        : isToolHistory(event) && !query.recordId;
      case 'plans': return event.type.startsWith('plan.') || event.type.startsWith('todo.');
      case 'reasoning': return event.type === 'provider.turn.settled' && event.payload.outcome === 'completed'
        && (!query.providerRequestId || event.payload.providerRequestId === query.providerRequestId);
      case 'context': return (event.type === 'context.composed'
        || event.type === 'approval.reviewed' && !events.some(candidate => candidate.type === 'context.composed'
          && candidate.payload.providerRequestId === event.payload.providerRequestId))
        && (!query.providerRequestId || event.payload.providerRequestId === query.providerRequestId);
    }
  }).reverse();
  if (query.recordId && !candidates.length) throw new Error('tool_record_not_found');
  if (query.providerRequestId && !candidates.length) throw new Error(view === 'reasoning' ? 'reasoning_not_found' : 'context_composition_not_found');
  let size = encoder.encode(JSON.stringify(result)).byteLength;
  const limit = query.limit ?? (view === 'summary' ? 5 : 10);
  for (const event of candidates) {
    const item = view === 'reasoning' && event.type === 'provider.turn.settled'
      ? reasoningReadItem(event, query.providerRequestId ? query.offset ?? 0 : null)
      : readItem(event, view === 'summary', events, Boolean(query.providerRequestId));
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength;
    if (result.items.length >= limit || (result.items.length > 0 && size + itemBytes > MAX_PAGE_BYTES)) {
      result.nextBefore = Number(result.items.at(-1)!.sequence);
      break;
    }
    result.items.push(item);
    size += itemBytes;
  }
  // Pages cover newest events first; items within each page follow journal order.
  result.items.reverse();
  return result;
}

function rejectedProviderCalls(event: SessionEvent) {
  if (event.type !== 'provider.turn.settled' || event.payload.outcome !== 'completed') return [];
  return [
    ...(event.payload.toolCallInputs ?? []).filter(call => call.error),
    ...(event.payload.orderedOutputBlocks ?? []).flatMap(block => block.kind === 'toolCallRejected'
      ? [{ callId: block.callId, providerCallId: block.providerCallId, toolName: block.toolName,
        arguments: typeof block.item.arguments === 'string' ? block.item.arguments : JSON.stringify(block.item), error: block.error }] : []),
  ];
}

function isToolHistory(event: SessionEvent): boolean {
  return ['tool.completed', 'tool.not-executed', 'tool.input-rejected', 'session.control.rejected', 'approval.reviewed'].includes(event.type)
    || rejectedProviderCalls(event).length > 0;
}

function readItem(event: SessionEvent, summary: boolean, events: readonly SessionEvent[], detail = false): JsonObject {
  const base = { sequence: event.sequence, eventId: event.eventId, type: event.type, runId: 'runId' in event ? event.runId ?? null : null };
  if (event.type === 'message.committed' || event.type === 'narrative.committed') {
    return { ...base, role: event.type === 'message.committed' ? event.payload.role : 'assistant', ...textExcerpt(event.payload.content, 12 * 1024) };
  }
  if (event.type === 'tool.not-executed') return { ...base, callId: event.callId, outcome: 'notExecuted', ...event.payload };
  if (event.type === 'session.control.rejected') return { ...base, callId: event.callId,
    providerCallId: event.payload.providerCallId, toolName: event.payload.toolName, outcome: 'rejected', executed: false,
    input: textExcerpt(JSON.stringify(event.payload.input), summary ? 600 : 4000),
    error: textExcerpt(JSON.stringify(event.payload.error), 4000) };
  if (event.type === 'provider.turn.settled') {
    const calls = rejectedProviderCalls(event).map(call => ({ ...call, outcome: 'rejected', executed: false }));
    // Keep a turn's siblings together: a sequence cursor must not skip same-event rejections.
    return { ...base, providerRequestId: event.payload.providerRequestId, providerOutcome: event.payload.outcome,
      rejectedCallCount: calls.length, rejectedCalls: textExcerpt(JSON.stringify(calls), summary ? 6000 : 12000) };
  }
  if (event.type === 'tool.input-rejected') {
    const rejection = event.payload.rejection;
    return { ...base, callId: event.callId, toolName: rejection.toolName, outcome: 'rejected', executed: false,
      input: textExcerpt(JSON.stringify(rejection.input), summary ? 600 : 4000),
      error: textExcerpt(JSON.stringify(rejection.error), 4000), rejectedAt: rejection.rejectedAt };
  }
  if (event.type === 'approval.reviewed') {
    const composed = events.some(candidate => candidate.type === 'context.composed'
      && candidate.payload.providerRequestId === event.payload.providerRequestId);
    const resolution = events.find(candidate => candidate.type === 'approval.resolved'
      && candidate.payload.approvalId === event.payload.approvalId);
    return { ...base, callId: event.callId, providerRequestId: event.payload.providerRequestId,
      contextPrepared: composed, review: { ...event.payload },
      resolution: resolution ? { sequence: resolution.sequence, ...resolution.payload } : null };
  }
  if (event.type === 'tool.completed') {
    const record = event.payload.record;
    return {
      ...base, recordId: record.recordId, toolName: record.toolName, outcome: record.outcome,
      input: textExcerpt(JSON.stringify(record.input), summary ? 600 : 4000),
      ...(summary ? {} : { output: textExcerpt(JSON.stringify('output' in record ? record.output : null), 12 * 1024) }),
      error: 'error' in record ? textExcerpt(JSON.stringify(record.error), 2000) : null,
    };
  }
  if (event.type === 'context.composed') {
    // Main-Agent bodies/native reasoning remain private to their existing views.
    // Exact review inputs are bounded evidence, available only for a named request.
    const { modelView: _modelView, ...withInput } = event.payload;
    const { reviewInput, ...receipt } = withInput as typeof withInput & { reviewInput?: { instructions: string; content: string } };
    const review = events.find(candidate => (candidate.type === 'approval.reviewed' || candidate.type === 'plan.reviewed')
      && candidate.payload.providerRequestId === receipt.providerRequestId);
    const resolution = review?.type === 'approval.reviewed'
      ? events.find(candidate => candidate.type === 'approval.resolved' && candidate.payload.approvalId === review.payload.approvalId)
      : undefined;
    const usage = events.find((candidate) => candidate.type === 'context.updated'
      && candidate.payload.providerRequestId === receipt.providerRequestId);
    return { ...base, providerRequestId: receipt.providerRequestId,
      data: textExcerpt(JSON.stringify(receipt), 20 * 1024),
      ...(detail && reviewInput ? { reviewInput } : {}),
      ...(detail && review ? { review: { sequence: review.sequence, ...review.payload } } : {}),
      ...(detail && resolution ? { resolution: { sequence: resolution.sequence, ...resolution.payload } } : {}),
      usage: usage ? textExcerpt(JSON.stringify(usage.payload), 4000) : null };
  }
  return { ...base, data: textExcerpt(JSON.stringify(event.payload), 12 * 1024) };
}

function textExcerpt(content: string, maxBytes: number): JsonObject {
  // Bound the serialized string, including JSON escaping, not only raw UTF-8.
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(JSON.stringify(content.slice(0, middle))).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < content.length && /[\uD800-\uDBFF]/u.test(content[low - 1])) low -= 1;
  return { content: content.slice(0, low), truncated: low < content.length, totalBytes: encoder.encode(content).byteLength };
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\s\u0000-\u001f]/u.test(value);
}
