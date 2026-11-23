import { firstReadingAnchor } from './conversationAnchors';

/** Only formal row content intersecting the restored viewport participates. Unrelated lazy
 * images (including the Reader or a closed dialog) do not gate the rest of the conversation. */
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
    for (const part of row.querySelectorAll<HTMLElement>('[data-conversation-pending], [data-reading-image="loading"]')) {
      const bounds = part.getBoundingClientRect();
      if (!bounds.width || bounds.bottom <= top || bounds.top >= bottom) continue;
      // A cold restore jumps directly into this page. Do not depend on a lazy-loading
      // heuristic for the one visible thumbnail, or request images outside the window.
      if (part.dataset?.readingImage === 'loading') {
        const image = part.querySelector<HTMLImageElement>('.conversation-image-review__open > img');
        if (image?.loading === 'lazy') image.loading = 'eager';
      }
      return false;
    }
  }
  return true;
}
