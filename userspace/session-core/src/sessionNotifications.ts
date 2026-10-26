import { LOCAL_AGENT_PROTOCOL_VERSION, type RunSettlement } from '@achbit/protocol';
import type { SessionObservationInput, SessionObservationSink } from './local-agent/observation.js';

export type SessionNotification =
  | { kind: 'change'; sessionId: string }
  | { kind: 'settled'; sessionId: string; runId: string; eventSequence: number; outcome: RunSettlement['outcome'] }
  | { kind: 'error'; code: string; message: string };

/** Live invalidations only. The existing Session projection remains the read authority. */
export class SessionNotifications implements SessionObservationSink {
  readonly #pending = new Map<string, SessionNotification>();
  #running = false;
  #closed = false;
  #failure?: unknown;
  #drain: Promise<void> = Promise.resolve();

  constructor(private readonly send: (frame: unknown) => Promise<void>) {}

  accept(input: SessionObservationInput): void {
    this.enqueue(`change:${input.sessionId}`, { kind: 'change', sessionId: input.sessionId });
    if (input.kind === 'event' && input.event.type === 'run.settled' && input.parentSessionId === null) {
      const event = input.event;
      this.enqueue(`settled:${input.sessionId}:${event.runId}`, { kind: 'settled', sessionId: input.sessionId,
        runId: event.runId, eventSequence: event.sequence, outcome: event.payload.outcome });
    }
  }

  failed(_sessionId: string, error: unknown): void {
    this.enqueue('error', { kind: 'error', code: 'session_observation_failed',
      message: error instanceof Error ? error.message : String(error) });
  }

  /** Stop producers after service disposal, then drain the accepted terminal notifications. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#drain;
    if (this.#failure) throw this.#failure;
  }

  private enqueue(key: string, notification: SessionNotification): void {
    if (this.#closed || this.#failure) return;
    this.#pending.set(key, notification);
    if (this.#running) return;
    this.#running = true;
    this.#drain = this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (this.#pending.size) {
        const [key, notification] = this.#pending.entries().next().value!;
        this.#pending.delete(key);
        await this.send({ protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION, type: 'session.notification', notification });
      }
    } catch (error) {
      this.#failure = error;
      this.#pending.clear();
    } finally { this.#running = false; }
  }
}
