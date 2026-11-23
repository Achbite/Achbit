import { permissionSettings, type RunRuntimeSnapshot, type SessionEvent } from '@achbit/protocol';

// Only JSON.parse results enter this comparison. Preserve property order, all extension fields, -0,
// and the distinction between arrays and records. Unusual deep data simply stays independent.
function sameDecodedJson(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth >= 6) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameDecodedJson(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  if (keys.length !== other.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (k !== other[i] || !sameDecodedJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1)) return false;
  }
  return true;
}

export type JournalPermissions = Record<string, { revision: number; settings: RunRuntimeSnapshot['permissions'] }>;
export interface JournalPublication<T> { value: T; permissions: JournalPermissions; revision?: number }

export const READING_FACTS_V1 = 'application/vnd.achbit.reading-facts-v1+json-seq';
const recordObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The record separator cannot occur unescaped inside valid JSON, including legacy
// pretty-printed payloads. Keep only unfinished record bytes outside the decoded events.
export async function readJournalSequence(body: ReadableStream<Uint8Array> | null, projectionOnly = false, factsSessionId?: string): Promise<JournalPublication<SessionEvent[]>> {
  if (!body) throw new Error('journal_sequence_invalid: no body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events: SessionEvent[] = [];
  let previousMessages: unknown[] | undefined;
  let previousContextSequence: number | undefined;
  let permissions: JournalPermissions | undefined;
  let revision: number | undefined;
  let pieces: Uint8Array[] = [];
  let started = false;
  let exhausted = false;
  const finishRecord = () => {
    const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    pieces = [];
    if (permissions || bytes.at(-1) !== 10) throw new Error('unexpected or incomplete record');
    const wire: unknown = JSON.parse(decoder.decode(bytes));
    if (!recordObject(wire)) throw new Error('invalid record');
    let record = wire;
    if (factsSessionId && 'readingPrefix' in wire) {
      const { event, baseSequence, prefixCount } = wire;
      if (wire.readingPrefix !== 1 || Object.keys(wire).length !== 4 || !recordObject(event)
        || event.type !== 'context.composed' || event.sessionId !== factsSessionId || event.sequence !== events.length + 1
        || !recordObject(event.payload) || !Array.isArray(event.payload.messages) || !previousMessages
        || previousContextSequence === undefined || baseSequence !== previousContextSequence
        || typeof prefixCount !== 'number' || !Number.isSafeInteger(prefixCount) || prefixCount < 1
        || prefixCount > previousMessages.length) throw new Error('invalid reading facts prefix');
      // Private, read-only replay input: no shared reference ever escapes to ordinary journal readers.
      event.payload.messages = previousMessages.slice(0, prefixCount).concat(event.payload.messages);
      record = event;
    }
    if ('permissions' in record || 'count' in record) {
      if (!('count' in record) || record.count !== events.length || !('permissions' in record)
        || !record.permissions || typeof record.permissions !== 'object' || Array.isArray(record.permissions)) {
        throw new Error('invalid final publication');
      }
      const checked: JournalPermissions = Object.create(null);
      for (const [id, view] of Object.entries(record.permissions)) {
        if (!view || !Number.isSafeInteger(view.revision) || view.revision < 0
          || !view.settings || typeof view.settings !== 'object' || Array.isArray(view.settings)) {
          throw new Error('invalid permission publication');
        }
        checked[id] = { revision: view.revision, settings: permissionSettings(view.settings) };
      }
      if ('revision' in record) {
        if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
          throw new Error('invalid source revision');
        }
        revision = record.revision;
      }
      permissions = checked;
    } else {
      if (!('sessionId' in record) || !('type' in record)) throw new Error('invalid journal event');
      if (factsSessionId && record.type === 'context.composed') {
        const candidate = record.payload;
        previousMessages = record.sessionId === factsSessionId && recordObject(candidate) && Array.isArray(candidate.messages) ? candidate.messages : undefined;
        previousContextSequence = typeof record.sequence === 'number' ? record.sequence : undefined;
      } else if (projectionOnly && record.type === 'context.composed' && 'payload' in record && record.payload
        && typeof record.payload === 'object' && 'messages' in record.payload && Array.isArray(record.payload.messages)) {
        // A composed context often repeats the preceding request's message descriptors. These newly decoded
        // values are private to one synchronous projection; the public journal reader never shares them.
        const current = record.payload.messages;
        if (previousMessages) for (let i = 0, end = Math.min(current.length, previousMessages.length); i < end; i++) {
          if (sameDecodedJson(current[i], previousMessages[i])) current[i] = previousMessages[i];
        }
        previousMessages = current;
      }
      events.push(record as unknown as SessionEvent);
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { exhausted = true; break; }
      // Search separators with Buffer's native byte scan. A fetch chunk can be
      // a slice of a larger slab: borrow only that view, without copying it.
      const { buffer, byteOffset, byteLength } = chunk.value;
      // Buffer.indexOf clamps its starting offset to int32; a larger single
      // chunk must still be able to advance past every separator.
      const bytes = byteLength <= 0x7fff_ffff
        ? Buffer.from(buffer, byteOffset, byteLength) : new Uint8Array(buffer, byteOffset, byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const separator = bytes.indexOf(0x1e, offset);
        const end = separator < 0 ? bytes.length : separator;
        if (end > offset) {
          if (!started) throw new Error('missing record separator');
          pieces.push(bytes.subarray(offset, end));
        }
        if (separator < 0) break;
        if (started) finishRecord();
        started = true;
        offset = separator + 1;
      }
    }
    if (started) finishRecord();
    if (!permissions) throw new Error('missing final publication');
    return { value: events, permissions, ...(revision !== undefined ? { revision } : {}) };
  } catch (error) {
    const failure = new Error('journal_sequence_invalid: ' + (error instanceof Error ? error.message : String(error)), { cause: error });
    if (!exhausted) {
      try { await reader.cancel(); }
      catch (cleanup) { if (cleanup !== error) throw new AggregateError([failure, cleanup], failure.message); }
    }
    throw failure;
  } finally {
    reader.releaseLock();
  }
}
