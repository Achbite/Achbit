import type { SessionProjection } from '@achbit/protocol';

/** UI delivery order only. Execution and artifact facts remain in Session. */
export function conversationDisplay(
  projection: SessionProjection | null,
  liveRuns: ReadonlySet<string>,
  displayed: ReadonlyMap<string, string>,
) {
  const streams = new Map(projection?.timeline.flatMap((item) => item.kind === 'message'
    ? [[item.messageId, item.streamId] as const] : []) ?? []);
  const current = projection?.run;
  const terminal = Boolean(current && ['completed', 'failed', 'cancelled', 'indeterminate'].includes(current.status));
  const readiness = new Map<string, boolean>();
  for (const message of projection?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const streamId = streams.get(message.messageId);
    const caughtUp = !liveRuns.has(message.runId)
      || Boolean(streamId && displayed.get(streamId) === (message.displayContent ?? message.content));
    const ready = caughtUp && (message.runId !== current?.runId || (terminal && !projection?.assistantDraft));
    readiness.set(message.runId, ready && readiness.get(message.runId) !== false);
  }
  const displaySettledRunIds = new Set([...readiness].filter(([, ready]) => ready).map(([runId]) => runId));
  const artifacts = (projection?.deliverables ?? []).filter((artifact) => {
    if (artifact.presentationRunId === current?.runId && !terminal) return false;
    if (readiness.has(artifact.presentationRunId)) return displaySettledRunIds.has(artifact.presentationRunId);
    return artifact.presentationRunId !== current?.runId || current?.status !== 'completed';
  });
  return { displaySettledRunIds, artifacts };
}
