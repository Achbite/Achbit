import type { PlanPreviewProjection, ProviderEvent } from '@achbit/protocol';

const PREVIEW_INPUT_LIMIT = 64 * 1024;

/** A bounded display prefix. Final plan decoding never reads this buffer. */
export class PlanPreviewBuffer {
  private calls = new Map<number, { callId: string; text: string; truncated: boolean }>();
  constructor(private readonly wireName: string | undefined) {}

  append(data: Extract<ProviderEvent, { type: 'tool.call.delta' }>['data']): PlanPreviewProjection | undefined {
    if (!this.wireName || !this.wireName.startsWith(data.name)) return;
    const call = this.calls.get(data.callIndex) ?? { callId: data.callId, text: '', truncated: false };
    if (call.callId !== data.callId) throw new Error('provider_tool_call_identity_conflict');
    const available = PREVIEW_INPUT_LIMIT - call.text.length;
    call.text += data.argumentsDelta.slice(0, available);
    call.truncated ||= data.argumentsDelta.length > available;
    this.calls.set(data.callIndex, call);
    if (data.name !== this.wireName) return;
    const fields = readFields(call.text, 0);
    const steps: string[] = [];
    let stepsTruncated = false;
    let cursor = fields.stepsStart;
    if (cursor !== undefined) {
      while (steps.length < 12) {
        cursor = skipSpace(call.text, cursor);
        if (call.text[cursor] !== '{') break;
        const step = readFields(call.text, cursor);
        if (step.title) steps.push(step.title.slice(0, 256));
        const end = valueEnd(call.text, cursor);
        if (end === undefined) break;
        cursor = skipSpace(call.text, end);
        if (call.text[cursor] !== ',') break;
        cursor += 1;
        if (steps.length === 12) stepsTruncated = true;
      }
    }
    return {
      callIndex: data.callIndex, providerCallId: data.callId,
      ...(data.outputIndex === undefined ? {} : { outputIndex: data.outputIndex }),
      title: (fields.title ?? '').slice(0, 256), summary: (fields.summary ?? '').slice(0, 4096),
      steps, truncated: call.truncated || stepsTruncated || (fields.summary?.length ?? 0) > 4096 || (fields.title?.length ?? 0) > 256,
    };
  }
}

function skipSpace(text: string, start: number): number {
  while (start < text.length && /\s/u.test(text[start]!)) start += 1;
  return start;
}

/** Return only a complete JSON value boundary; never close an unfinished value. */
function valueEnd(text: string, start: number): number | undefined {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') { quoted = false; if (depth === 0) return i + 1; }
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') { if (--depth === 0) return i + 1; if (depth < 0) return i; }
    else if (depth === 0 && (c === ',' || /\s/u.test(c!))) return i;
  }
  return undefined;
}

function readFields(text: string, start: number): { title?: string; summary?: string; stepsStart?: number } {
  const fields: { title?: string; summary?: string; stepsStart?: number } = {};
  let cursor = skipSpace(text, start);
  if (text[cursor++] !== '{') return fields;
  while (cursor < text.length) {
    cursor = skipSpace(text, cursor);
    if (text[cursor] !== '"') break;
    const keyEnd = valueEnd(text, cursor);
    if (keyEnd === undefined) break;
    let key: string;
    try { key = JSON.parse(text.slice(cursor, keyEnd)) as string; } catch { break; }
    cursor = skipSpace(text, keyEnd);
    if (text[cursor++] !== ':') break;
    cursor = skipSpace(text, cursor);
    if (key === 'steps' && text[cursor] === '[') fields.stepsStart = cursor + 1;
    const end = valueEnd(text, cursor);
    if (end === undefined) break;
    try {
      const value: unknown = JSON.parse(text.slice(cursor, end));
      if ((key === 'title' || key === 'summary') && typeof value === 'string') fields[key] = value;
    } catch { break; }
    cursor = skipSpace(text, end);
    if (text[cursor++] !== ',') break;
  }
  return fields;
}
