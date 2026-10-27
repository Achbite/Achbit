import type { AssistantDraftProjection, SessionEvent, ToolExecutionProgress } from '@achbit/protocol';

/** Optional read-only runtime port. It must enqueue synchronously, never await consumers. */
export type SessionObservationInput = (
  | { kind: 'event'; sessionId: string; event: SessionEvent }
  | { kind: 'draft'; sessionId: string; draft: AssistantDraftProjection }
  | { kind: 'toolProgress'; sessionId: string; runId: string; callId: string; progress: ToolExecutionProgress }
) & { /** Canonical creation lineage supplied by SessionService, never inferred by the UI. */ parentSessionId?: string | null };
export interface SessionObservationSink {
  accept(input: SessionObservationInput): void;
  failed(sessionId: string, error: unknown): void;
}
