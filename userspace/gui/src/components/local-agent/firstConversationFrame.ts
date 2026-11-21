import { firstReadingAnchor } from './conversationAnchors';

/** Wait for visible rows and their formatted content, not individual image requests. */
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
    for (const part of row.querySelectorAll<HTMLElement>('[data-conversation-pending]')) {
      const bounds = part.getBoundingClientRect();
      if (bounds.width && bounds.bottom > top && bounds.top < bottom) return false;
    }
  }
  return true;
}
