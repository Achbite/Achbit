import { permissionSettings, type RunRuntimeSnapshot, type SessionEvent } from '@achbit/protocol';

export type JournalPermissions = Record<string, { revision: number; settings: RunRuntimeSnapshot['permissions'] }>;
export interface JournalPublication<T> { value: T; permissions: JournalPermissions; revision?: number }

// The record separator cannot occur unescaped inside valid JSON, including legacy
// pretty-printed payloads. Keep only unfinished record bytes outside the decoded events.
export async function readJournalSequence(body: ReadableStream<Uint8Array> | null): Promise<JournalPublication<SessionEvent[]>> {
  if (!body) throw new Error('journal_sequence_invalid: no body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events: SessionEvent[] = [];
  let permissions: JournalPermissions | undefined;
  let revision: number | undefined;
  let pieces: Uint8Array[] = [];
  let started = false;
  let exhausted = false;
  const finishRecord = () => {
    const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    pieces = [];
    if (permissions || bytes.at(-1) !== 10) throw new Error('unexpected or incomplete record');
    const record: unknown = JSON.parse(decoder.decode(bytes));
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('invalid record');
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
      events.push(record as SessionEvent);
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { exhausted = true; break; }
      const bytes = chunk.value;
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
