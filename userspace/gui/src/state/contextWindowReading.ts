import type { ContextCompositionProjection, ContextUsageProjection, SessionProjection } from '@achbit/protocol';

/** Display data only. Keep the matching breakdown, not the request's messages and tool catalog. */
export interface ContextWindowReading {
  usage: Omit<ContextUsageProjection, 'sequence' | 'updatedAt'>;
  receipt: Pick<ContextCompositionProjection, 'partitions' | 'sequence'> | null;
}

export interface CachedSessionView {
  projection: SessionProjection;
  contextWindowReading: ContextWindowReading | null;
}

/** Session's active transcript and actual model-context boundary, not the current task ID. */
export function reportedWindowRounds(projection: SessionProjection) {
  const boundary = projection.contextHandoff?.historyThroughSequence ?? 0;
  return projection.tokenUsageHistory.filter(round => round.sequence > boundary && round.reportedCallCount > 0);
}

export function sessionView(projection: SessionProjection, previous?: CachedSessionView): CachedSessionView {
  const usage = projection.contextUsage;
  if (usage) {
    const receipt = projection.contextCompositions.find(item => item.providerRequestId === usage.providerRequestId
      && item.runId === usage.runId && item.purpose === 'agent');
    return { projection, contextWindowReading: { usage, receipt: receipt ? { sequence: receipt.sequence, partitions: receipt.partitions } : null } };
  }
  // Keep the original capacity and breakdown together. A follow-up can have a new runId
  // and zero calls, while its predecessor still belongs to the same model context.
  const reading = previous?.projection.sessionId === projection.sessionId ? previous.contextWindowReading : null;
  const run = projection.run;
  const retain = reading && run && ((reading.usage.runId === run.runId && (run.status === 'running' || run.status === 'waiting'))
    || reportedWindowRounds(projection).some(round => round.runId === reading.usage.runId));
  return { projection, contextWindowReading: retain ? reading : null };
}
