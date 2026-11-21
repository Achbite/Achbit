import { firstReadingAnchor } from './conversationAnchors';

/** Only unfinished layout in the opening viewport can hold the first frame.
 * Virtual placeholders outside it and explicitly hidden disclosures never do. */
export function firstConversationFrameReady(body: HTMLElement, rows: HTMLElement[]): boolean {
  const { top, bottom } = body.getBoundingClientRect();
  if (bottom <= top) return false;
  const first = firstReadingAnchor(rows, top);
  if (!first) return true;
  for (let n = rows.indexOf(first); n < rows.length; n++) {
    const row = rows[n]!;
    const rect = row.getBoundingClientRect();
    if (rect.top >= bottom) break;
    if (rect.bottom <= top || rect.height === 0) continue;
    if (row.dataset.virtualRendered === 'false') return false;
    for (const part of row.querySelectorAll<HTMLElement>('[data-conversation-pending], img[src]')) {
      const bounds = part.getBoundingClientRect();
      if (!bounds.width || bounds.bottom <= top || bounds.top >= bottom) continue;
      if (part.hasAttribute('data-conversation-pending')) return false;
      if (part instanceof HTMLImageElement && part.src && !part.complete) {
        // Only a genuinely visible image may be promoted from lazy loading.
        if (part.loading === 'lazy') part.loading = 'eager';
        return false;
      }
    }
  }
  return true;
}
