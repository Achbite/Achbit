import type { ConversationReadingRow, ConversationReadQuery, ConversationReadResult, SessionProjection } from '@achbit/protocol';

const MAX_BYTES = 256 * 1024;
const MAX_NAVIGATION = 4096;

export function requiresReadingProjection(sessionId: string, revision: number): ConversationReadResult {
  return { sessionId, revision, view: 'readingWindow', items: [], nextBefore: null, readingWindow: { kind: 'requiresProjection' } };
}

/** Select readable rows only from the actual, fully validated projection. */
export function selectReadingWindow(p: SessionProjection, query: ConversationReadQuery): ConversationReadResult {
  if (p.sessionId !== query.sessionId) throw new Error('session_event_identity_mismatch');
  if (p.revision !== query.throughSequence) throw new Error('conversation_read_revision_changed');
  const result = requiresReadingProjection(p.sessionId, p.revision);
  // A run's own activity is not a transcript row. Decisions, child ownership, failures and other
  // composed surfaces, on the other hand, cannot be presented by a standalone message window.
  if (p.run && p.run.status !== 'completed' || p.assistantDraft || p.terminalError || p.failureSnapshot || p.agentContext
    || p.agentChildren?.length || p.agentTasks?.length || p.pendingAgentDecisions?.length || p.pendingPlan
    || p.pendingApproval || p.pendingApprovals?.length || p.pendingInteraction || p.interactions.length || p.plans.length
    || p.queuedInputs.length || p.deliverables.length || p.artifacts.length || p.fileChangeRounds?.length) return result;
  const totalRows = p.timeline.length;
  if (!totalRows) {
    if (query.anchorKey !== undefined) throw new Error('conversation_read_anchor_not_found');
    return result;
  }
  if (p.timeline.some(item => item.kind !== 'message')) return result;
  const messages = new Map(p.messages.map(m => [m.messageId, m]));
  if (messages.size !== p.messages.length) return result;
  const navigation: { keys: string[]; labels: string[] } = { keys: [], labels: [] };
  const seen = new Set<string>(), timelineIds = new Set<string>(), messageIds = new Set<string>();
  const limit = query.limit ?? 12;
  let target = query.anchorKey === undefined ? totalRows - 1 : -1;
  for (const [index, item] of p.timeline.entries()) {
    if (item.kind !== 'message') return result;
    const message = messages.get(item.messageId);
    if (!message) throw new Error('conversation_timeline_message_missing');
    const key = item.streamId ?? message.messageId;
    if (message.replyToInteraction || !['user', 'assistant'].includes(message.role)
      || seen.has(key) || timelineIds.has(item.timelineId) || messageIds.has(message.messageId)) return result;
    seen.add(key); timelineIds.add(item.timelineId); messageIds.add(message.messageId);
    if (query.anchorKey === key) target = index;
    if (message.role === 'user') {
      if (navigation.keys.length >= MAX_NAVIGATION) return result;
      navigation.keys.push(key);
      navigation.labels.push((message.displayContent ?? message.content).trim().slice(0, 180)
        || message.filesystemReferences.map(ref => ref.displayName).join(', ').slice(0, 180));
    }
  }
  if (target < 0) throw new Error('conversation_read_anchor_not_found');
  const startIndex = Math.max(0, Math.min(totalRows - limit, target - Math.floor(limit / 2)));
  const rows: ConversationReadingRow[] = [];
  let minBytes = 0;
  for (const item of p.timeline.slice(startIndex, startIndex + limit)) {
    if (item.kind !== 'message') return result;
    const message = messages.get(item.messageId)!;
    // Avoid serializing jumbo bodies merely to reject them. Nested references remain covered by the final wire-size check.
    minBytes += message.content.length + (message.displayContent?.length ?? 0);
    if (minBytes > MAX_BYTES) return result;
    rows.push({ key: item.streamId ?? message.messageId, timelineId: item.timelineId, sequence: item.sequence,
      ...(item.streamId === undefined ? {} : { streamId: item.streamId }), message });
  }
  const ready: ConversationReadResult = { ...result, readingWindow: { kind: 'ready', anchorKey: rows[target - startIndex]!.key,
    startIndex, totalRows, rows, navigation } };
  return Buffer.byteLength(JSON.stringify(ready)) <= MAX_BYTES ? ready : result;
}
