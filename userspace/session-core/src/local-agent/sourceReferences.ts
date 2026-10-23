import type { JsonObject, SourceReferences } from '@achbit/protocol';

const citationPrefix = '\uE200cite\uE202';

/** Hold an opaque citation and its suffix until the final item supplies annotations.
 * This keeps append-only terminals and GUI streaming on the same display text. */
export function projectDraftSourceContent(content: string): { displayContent?: string } {
  for (let start = content.indexOf('\uE200'); start >= 0; start = content.indexOf('\uE200', start + 1)) {
    const suffix = content.slice(start);
    if (suffix.startsWith(citationPrefix) || citationPrefix.startsWith(suffix)) {
      return { displayContent: content.slice(0, start) };
    }
  }
  return {};
}

/** Derive display text and sources from the retained Provider item. The source
 * list on a search action is not an ID-to-URL map and cannot resolve these spans. */
export function projectSourceContent(content: string, item?: JsonObject): {
  displayContent?: string; sourceReferences?: SourceReferences;
} {
  const citations: SourceReferences['citations'] = [];
  let unresolved = false;
  let offset = 0;
  const spans: Array<{ start: number; end: number; url: string; title: string }> = [];
  const parts = Array.isArray(item?.content) ? item.content : [{ type: 'output_text', text: content }];
  for (const value of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'output_text') continue;
    if (typeof value.text !== 'string') continue;
    const annotations = Array.isArray(value.annotations) ? value.annotations : [];
    // Responses offsets count Unicode characters; JS substring positions use UTF-16.
    const characterOffsets = [0];
    if (annotations.length) for (const character of value.text) {
      characterOffsets.push(characterOffsets[characterOffsets.length - 1]! + character.length);
    }
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) || annotation.type !== 'url_citation') continue;
      const { url, title, start_index: start, end_index: end } = annotation;
      if (typeof url !== 'string' || typeof title !== 'string' || !title.trim()
        || typeof start !== 'number' || typeof end !== 'number'
        || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end >= characterOffsets.length) {
        unresolved = true;
        continue;
      }
      try {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('citation_url_invalid');
      } catch {
        unresolved = true;
        continue;
      }
      if (!citations.some(source => source.url === url)) citations.push({ url, title });
      spans.push({ start: offset + characterOffsets[start]!, end: offset + characterOffsets[end]!, url, title });
    }
    offset += value.text.length;
  }
  const displayContent = content.replace(/\uE200cite\uE202[^\uE201]*(?:\uE201|$)|\uE200(?:c(?:i(?:t(?:e)?)?)?)?$/gu, (marker, start: number) => {
    const sources = spans.filter(span => span.start <= start && span.end >= start + marker.length);
    if (!marker.endsWith('\uE201') || !sources.length) {
      unresolved = true;
      return '[?]';
    }
    return [...new Map(sources.map(source => [source.url, source])).values()]
      .map(source => `[${source.title.trim().replace(/\s+/gu, ' ').replace(/[\\`*_[\]<>]/gu, '\\$&')}](<${new URL(source.url).href.replace(/</gu, '%3C').replace(/>/gu, '%3E')}>)`)
      .join(' ');
  });
  return {
    ...(displayContent !== content ? { displayContent } : {}),
    ...(citations.length || unresolved ? { sourceReferences: { citations, unresolved } } : {}),
  };
}
