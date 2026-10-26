import { EventSourceParserStream } from 'eventsource-parser/stream';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

export type ConversationEvent =
  | { type: 'ready' }
  | { type: 'change'; sessionId: string }
  | { type: 'settled'; sessionId: string; runId: string; eventSequence: number;
      outcome: 'completed' | 'failed' | 'cancelled' | 'indeterminate' };
type EventStream = (signal: AbortSignal, receive: (event: ConversationEvent) => void) => Promise<void>;

/** One physical Host stream per window. Late subscribers get a read boundary, never old completions. */
export function createConversationEventSubscriptions(stream: EventStream) {
  type Subscriber = { receive(event: ConversationEvent): void; finish(error?: unknown): void };
  type Connection = { abort: AbortController; ready: boolean };
  const subscribers = new Set<Subscriber>();
  let connection: Connection | null = null;
  const deliver = (subscriber: Subscriber, event: ConversationEvent) => {
    try { subscriber.receive(event); } catch (error) { subscriber.finish(error); }
  };
  return (signal: AbortSignal, receive: (event: ConversationEvent) => void): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const subscriber: Subscriber = { receive, finish(error) {
        if (!subscribers.delete(subscriber)) return;
        signal.removeEventListener('abort', aborted);
        if (!subscribers.size) { connection?.abort.abort(); connection = null; }
        if (error === undefined) resolve(); else reject(error);
      } };
      const aborted = () => subscriber.finish();
      signal.addEventListener('abort', aborted, { once: true });
      subscribers.add(subscriber);
      if (connection) {
        if (connection.ready) deliver(subscriber, { type: 'ready' });
        return;
      }
      const current: Connection = { abort: new AbortController(), ready: false };
      connection = current;
      void stream(current.abort.signal, event => {
        if (connection !== current || current.abort.signal.aborted) return;
        if (event.type === 'ready') current.ready = true;
        for (const item of [...subscribers]) deliver(item, event);
      }).then(() => {
        if (!current.abort.signal.aborted) throw new Error('conversation_events_closed');
      }).catch(error => {
        if (connection !== current || current.abort.signal.aborted) return;
        for (const item of [...subscribers]) item.finish(error);
      });
    });
  };
}

export const watchConversationEvents = createConversationEventSubscriptions(readConversationEvents);

/** A Session (or the whole conversation view when null) stays subscribed while idle. */
export async function watchConversationChanges(sessionId: string | null, signal: AbortSignal,
  refresh: () => Promise<void>, watch = watchConversationEvents): Promise<void> {
  let dirty = false, reading = false;
  const read = async () => {
    if (reading || signal.aborted) return;
    reading = true;
    try {
      while (dirty && !signal.aborted) {
        dirty = false;
        await refresh();
      }
    } finally { reading = false; }
  };
  // The view owns read errors. This observer owns connection errors and cancellation.
  await watch(signal, event => {
    if (event.type === 'ready' || sessionId === null || event.sessionId === sessionId) {
      dirty = true;
      void read();
    }
  });
}

async function readConversationEvents(signal: AbortSignal, receive: (event: ConversationEvent) => void): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/conversation/events`, { signal,
    headers: { ...getHostConnectionHeaders(), Accept: 'text/event-stream' } });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    const detail = await response.text();
    let message = detail;
    try { const error = JSON.parse(detail) as { message?: string; error?: string }; message = error.message ?? error.error ?? detail; }
    catch { /* Preserve the original transport error. */ }
    throw new Error(message || `conversation_events_failed:HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
  let ready = false;
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) throw new Error('conversation_events_closed');
      const { event, data } = result.value;
      if (!event || !['ready', 'change', 'settled', 'error'].includes(event)) continue;
      const value: unknown = JSON.parse(data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('conversation_event_invalid');
      const fields = value as Record<string, unknown>;
      if (event === 'error') throw new Error(`${fields.code ?? 'conversation_events_failed'}: ${fields.message ?? 'Host event stream failed'}`);
      if (event === 'ready') { ready = true; receive({ type: 'ready' }); continue; }
      if (!ready || typeof fields.sessionId !== 'string' || !fields.sessionId) throw new Error('conversation_event_invalid');
      if (event === 'change') { receive({ type: 'change', sessionId: fields.sessionId }); continue; }
      if (typeof fields.runId !== 'string' || !fields.runId || !Number.isSafeInteger(fields.eventSequence)
        || Number(fields.eventSequence) < 1 || !['completed', 'failed', 'cancelled', 'indeterminate'].includes(String(fields.outcome))) {
        throw new Error('conversation_settlement_invalid');
      }
      receive({ type: 'settled', sessionId: fields.sessionId, runId: fields.runId,
        eventSequence: fields.eventSequence as number, outcome: fields.outcome as Extract<ConversationEvent, { type: 'settled' }>['outcome'] });
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
