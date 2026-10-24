import type { JsonObject, SessionEvent } from '@achbit/protocol';

const WINDOW = 8 * 1024;
type Part = { kind: 'text' | 'summary'; content: string };

// A display window, independent of the Provider replay data and journal.
export class LiveReasoning {
  reset(): void { this.requestId = ''; this.contents = { text: '', summary: '' }; this.total = 0; }
  private requestId = '';
  private runId = '';
  private contents = { text: '', summary: '' };
  private total = 0;
  append(requestId: string, runId: string, text: string, kind: 'text' | 'summary'): void {
    if (requestId !== this.requestId) {
      this.requestId = requestId; this.runId = runId; this.contents = { text: '', summary: '' }; this.total = 0;
    }
    this.total += text.length;
    this.contents[kind] = (this.contents[kind] + text).slice(-WINDOW / 2);
    if (/^[\uDC00-\uDFFF]/u.test(this.contents[kind])) this.contents[kind] = this.contents[kind].slice(1);
  }
  read(requestId: string): JsonObject {
    const matches = this.requestId === requestId;
    return { providerRequestId: requestId, runId: matches ? this.runId : null, live: true,
      parts: matches ? Object.entries(this.contents).filter(([, content]) => content).map(([kind, content]) => ({ kind, content })) : [],
      truncated: matches && this.total > this.contents.text.length + this.contents.summary.length, nextOffset: null };
  }
}

export function reasoningReadItem(
  event: Extract<SessionEvent, { type: 'provider.turn.settled' }>, offset: number | null,
): JsonObject {
  const parts: Part[] = [];
  if (event.payload.outcome === 'completed') {
    for (const block of event.payload.orderedOutputBlocks ?? []) {
      if (block.kind !== 'reasoning') continue;
      const content = block.item.content;
      if (Array.isArray(content)) for (const item of content) {
        if (item && typeof item === 'object' && !Array.isArray(item)
          && item.type === 'reasoning_text' && typeof item.text === 'string') {
          parts.push({ kind: 'text', content: item.text });
        }
      }
      const summary = block.item.summary;
      if (Array.isArray(summary)) for (const item of summary) {
        if (item && typeof item === 'object' && !Array.isArray(item)
          && item.type === 'summary_text' && typeof item.text === 'string') {
          parts.push({ kind: 'summary', content: item.text });
        }
      }
    }
    if (!parts.some((part) => part.kind === 'text') && event.payload.reasoningContent) {
      parts.push({ kind: 'text', content: event.payload.reasoningContent });
    }
  }
  const total = parts.reduce((sum, part) => sum + part.content.length, 0);
  let skip = offset ?? 0;
  let remaining = WINDOW;
  const page: Part[] = [];
  for (const part of parts) {
    if (skip >= part.content.length) { skip -= part.content.length; continue; }
    if (skip > 0 && /[\uDC00-\uDFFF]/u.test(part.content[skip])) throw new Error('reasoning_offset_not_utf16_boundary');
    let content = part.content.slice(skip, skip + remaining);
    if (/[\uD800-\uDBFF]$/u.test(content)) content = content.slice(0, -1);
    page.push({ kind: part.kind, content });
    remaining -= content.length;
    skip = 0;
    if (remaining <= 1) break;
  }
  const end = (offset ?? 0) + page.reduce((sum, part) => sum + part.content.length, 0);
  return { sequence: event.sequence, providerRequestId: event.payload.providerRequestId,
    runId: event.runId, kinds: [...new Set(parts.map((part) => part.kind))], live: false,
    ...(offset === null ? {} : { parts: page }),
    truncated: end < total, nextOffset: end < total ? end : null };
}
