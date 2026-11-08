import type { ProviderRuntimeSnapshot, SessionEvent, ToolExecutionRecord } from '@achbit/protocol';

/** Native continuation is opt-in by resolved identity, never inferred from a protocol name. */
export function sameModelContext(previous: ProviderRuntimeSnapshot, next: ProviderRuntimeSnapshot): boolean {
  if (previous.profileId !== next.profileId || previous.apiSurface !== next.apiSurface) return false;
  if (previous.continuationKey || next.continuationKey) {
    return Boolean(previous.continuationKey && previous.continuationKey === next.continuationKey);
  }
  // An identical live binding is known; missing provenance across bindings is not.
  return previous.providerRuntimeRef === next.providerRuntimeRef
    && previous.thinking === next.thinking && previous.reasoningEffort === next.reasoningEffort;
}

export function modelContextStart(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'run.started' }> | undefined {
  return events.findLast((event): event is Extract<SessionEvent, { type: 'run.started' }> =>
    event.type === 'run.started' && event.payload.contextStart !== undefined);
}

/** Filter only model inputs. Business state and the canonical journal always remain complete. */
export function modelContextEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const boundary = modelContextStart(events)?.payload.contextStart?.historyThroughSequence;
  return boundary === undefined ? events : events.filter(event => event.sequence > boundary);
}

export function isHandoffRead(record: ToolExecutionRecord, sessionId: string, throughSequence: number): boolean {
  if (record.toolName !== 'session.read' || record.outcome !== 'completed'
    || record.input.sessionId !== sessionId || (record.input.view ?? 'summary') !== 'summary'
    || record.input.throughSequence !== throughSequence) return false;
  const output = record.output as Record<string, unknown> | null;
  return !!output && typeof output === 'object' && !Array.isArray(output)
    && output.sessionId === sessionId && output.revision === throughSequence
    && output.view === 'summary' && !!output.summary;
}
