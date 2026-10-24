import type { NewSessionEvent, RunTimingFact } from '@achbit/protocol';
import { randomUUID } from 'node:crypto';

/** Wall times identify facts; durations use only this Actor's monotonic clock. */
export class RunTiming {
  readonly clockDomain = `session:${randomUUID()}`;
  readonly runs = new Map<string, { fact: RunTimingFact; start?: number; first?: number }>();
  constructor(readonly sessionId: string) {}

  restore(values: readonly (RunTimingFact & { runId: string })[]): void {
    for (const { runId, ...fact } of values) if (!this.runs.has(runId)) this.runs.set(runId, { fact });
  }

  started(runId: string): NewSessionEvent | undefined {
    const entry = this.runs.get(runId);
    if (!entry || entry.fact.startedAt || entry.fact.settledAt) return;
    entry.fact.startedAt = new Date().toISOString();
    return this.event(runId, entry.fact);
  }

  response(runId: string, kind: 'text' | 'tool'): NewSessionEvent | undefined {
    const entry = this.runs.get(runId);
    if (!entry || entry.fact.settledAt || entry.fact.firstResponseAt && (kind !== 'text' || entry.fact.firstTextAt)) return;
    const wall = new Date().toISOString(), mono = performance.now();
    if (!entry.fact.firstResponseAt) {
      entry.fact.firstResponseAt = wall; entry.fact.firstResponseKind = kind; entry.first = mono;
      if (entry.start !== undefined) entry.fact.firstResponseMs = mono - entry.start;
    }
    if (kind === 'text' && !entry.fact.firstTextAt) {
      entry.fact.firstTextAt = wall;
      if (entry.start !== undefined) entry.fact.firstTextMs = mono - entry.start;
    }
    if (entry.start === undefined) entry.fact.coverage = 'partial';
    return this.event(runId, entry.fact);
  }

  decorate(events: readonly NewSessionEvent[]): NewSessionEvent[] {
    const result: NewSessionEvent[] = [];
    for (const event of events) {
      if (event.type === 'run.settled') {
        const entry = this.runs.get(event.runId);
        if (entry) {
          const mono = performance.now();
          entry.fact.settledAt = new Date().toISOString();
          if (entry.start !== undefined) entry.fact.totalMs = mono - entry.start;
          else entry.fact.coverage = 'partial';
          if (entry.first !== undefined) entry.fact.responseElapsedMs = mono - entry.first;
          result.push(this.event(event.runId, entry.fact));
        }
      }
      result.push(event);
      if (event.type === 'run.started') {
        const wall = new Date().toISOString();
        const fact: RunTimingFact = { clockDomain: this.clockDomain, acceptedAt: wall, coverage: 'complete' };
        this.runs.set(event.runId, { fact, start: performance.now() });
        result.push(this.event(event.runId, fact));
      }
      if (event.type === 'tool.requested' || event.type === 'plan.published' || event.type === 'interaction.requested'
        || event.type === 'agent.task.created' || event.type === 'agent.control.completed' || event.type === 'session.control.completed') {
        const timing = this.response(event.runId, 'tool');
        if (timing) result.push(timing);
      }
    }
    return result;
  }
  private event(runId: string, fact: RunTimingFact): NewSessionEvent {
    return { type: 'run.timing.updated', sessionId: this.sessionId, runId, payload: { ...fact } };
  }
}
