import type { LoopSnapshot } from './loopTypes.js';

/** Run starts in a managed Session are assignments. Human interaction answers
 * are separate messages, even when they follow in the very same run. */
export function reviewInputs(snapshot: LoopSnapshot, runId: string, planRunId?: string) {
  const starts = snapshot.events.filter(event => event.type === 'run.started');
  const current = starts.findIndex(event => event.runId === runId);
  const selected = starts.filter((event, index) => event.runId === runId || event.runId === planRunId || index === current - 1);
  const inputs = new Set(selected.map(event => event.payload.inputMessageId));
  const runs = new Set([runId, ...selected.map(event => event.runId)]);
  return snapshot.events.flatMap(event => event.type === 'message.committed' && event.payload.role === 'user'
    && (inputs.has(event.payload.messageId) || event.runId !== undefined && runs.has(event.runId))
    ? [{ messageId: event.payload.messageId, content: event.payload.content,
      ...(snapshot.state.agentContext && inputs.has(event.payload.messageId) ? { source: 'delegatedTask' as const } : {}),
      filesystemReferences: event.payload.filesystemReferences }] : []);
}
