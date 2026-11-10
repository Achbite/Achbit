/** Success, information and warning notices; failures keep their own persistent owner. */
export type UiEventTone = 'info' | 'success' | 'warning';

export interface UiEvent {
  id: string;
  key: string;
  sessionId?: string;
  tone: UiEventTone;
  text: string;
  createdAt: number;
  ttlMs: number;
}

export interface UiEventInput {
  /** One fact, one key within its Session: republishing refreshes the notice. */
  key: string;
  text: string;
  tone?: UiEventTone;
  sessionId?: string;
  ttlMs?: number;
}

/** Notification-type UI matches the native completion reminder's eight-second window. */
export const UI_EVENT_TTL_MS = 8_000;
const MAX_VISIBLE = 3;

/**
 * One owner for notification-type UI: a notice is published once, stays scoped to
 * its Session, and leaves on its own. Failures, approvals and recovery panels stay
 * with the component that keeps an actionable state.
 */
export class UiEvents {
  private events: UiEvent[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  private readonly limit: number;
  constructor(limit: number = MAX_VISIBLE) { this.limit = limit; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Stable while unpublished, so React re-renders only on a real change. */
  snapshot = (): readonly UiEvent[] => this.events;
  publish(input: UiEventInput): UiEvent {
    const previous = this.events.find(event => event.key === input.key && event.sessionId === input.sessionId);
    const event: UiEvent = {
      id: previous?.id ?? `ui-event:${++this.sequence}`,
      key: input.key,
      sessionId: input.sessionId,
      tone: input.tone ?? 'info',
      text: input.text,
      createdAt: Date.now(),
      ttlMs: input.ttlMs ?? UI_EVENT_TTL_MS,
    };
    if (event.ttlMs <= 0) {
      if (previous) this.dismiss(previous.id);
      return event;
    }
    const scoped = [...this.events.filter(item => item.sessionId === event.sessionId && item.id !== event.id), event]
      .slice(-this.limit);
    this.stopTimer(event.id);
    this.timers.set(event.id, setTimeout(() => this.dismiss(event.id), event.ttlMs));
    this.commit([...this.events.filter(item => item.sessionId !== event.sessionId), ...scoped]);
    return event;
  }
  /** IDs are unique; producer keys require the same scope used when publishing. */
  dismiss(idOrKey: string, sessionId?: string): void {
    const target = this.events.find(event => event.id === idOrKey
      || (event.key === idOrKey && event.sessionId === sessionId));
    if (!target) return;
    this.commit(this.events.filter(event => event.id !== target.id));
  }
  clear(sessionId?: string): void {
    const next = sessionId === undefined ? [] : this.events.filter(event => event.sessionId !== sessionId);
    if (next.length !== this.events.length) this.commit(next);
  }
  private stopTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }
  private commit(next: UiEvent[]): void {
    this.events = next;
    // A notice dropped by the stack limit must not keep an expiry scheduled.
    for (const id of [...this.timers.keys()]) {
      if (!next.some(event => event.id === id)) this.stopTimer(id);
    }
    for (const listener of this.listeners) listener();
  }
}

export const uiEvents = new UiEvents();
