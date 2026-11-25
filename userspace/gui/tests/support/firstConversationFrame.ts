// Historical frame acceptance criteria on synthetic geometry. This helper does not drive the GUI.
import { firstReadingAnchor } from '../../src/components/local-agent/conversationAnchors';

type Bounds = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
const overlaps = (a: DOMRect, b: Bounds) => a.height > 0 && a.width > 0 && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
const notProse = '[hidden],dialog,button,header,[role="status"],[role="alert"],[data-reading-image],[data-conversation-pending],[data-image-export-exclude],.conversation-table-toolbar,.katex-mathml,.conversation-markdown__pending-source';

// This path is used only while an on-screen image is unresolved. A paragraph's box
// can include a tall image or blank lines. Check text fragments, not its textContent.
function visibleText(text: Text, range: Range, clip: Bounds): boolean {
  const value = text.data, chunk = 256;
  const select = (a: number, b: number) => { range.setStart(text, a); range.setEnd(text, b); };
  // Long code/paragraphs may begin thousands of lines above the reading position.
  // Seek by vertical position, then inspect bounded line fragments, never one Range per glyph.
  let lo = 0, hi = Math.ceil(value.length / chunk);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    select(mid * chunk, Math.min(value.length, (mid + 1) * chunk));
    if (range.getBoundingClientRect().bottom <= clip.top) lo = mid + 1; else hi = mid;
  }
  for (let start = lo * chunk; start < value.length; start += chunk) {
    const end = Math.min(value.length, start + chunk);
    select(start, end);
    const box = range.getBoundingClientRect();
    if (box.top >= clip.bottom) break;
    if (!overlaps(box, clip)) continue;
    // Newlines and indentation in pre must not turn empty space into "readable" content.
    for (const match of value.slice(start, end).matchAll(/\S+/gu)) {
      select(start + match.index, start + match.index + match[0].length);
      if (Array.from(range.getClientRects()).some(rect => overlaps(rect, clip))) return true;
    }
  }
  return false;
}

function hasVisibleProse(row: HTMLElement, view: Bounds): boolean {
  const roots = row.querySelectorAll<HTMLElement>('.conversation-markdown, .conversation-plain');
  if (!roots.length) return false;
  const range = row.ownerDocument.createRange();
  const visit = (el: Element, clip: Bounds): boolean => {
    if (el.matches(notProse)) return false;
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    if (style.display !== 'contents' && !overlaps(box, clip)) return false;
    if (style.visibility !== 'visible' || style.opacity === '0') return false;
    const x = style.overflowX !== 'visible', y = style.overflowY !== 'visible';
    const inner = !x && !y ? clip : {left:x ? Math.max(clip.left,box.left) : clip.left, right:x ? Math.min(clip.right,box.right) : clip.right,
      top:y ? Math.max(clip.top,box.top) : clip.top, bottom:y ? Math.min(clip.bottom,box.bottom) : clip.bottom};
    // Empty table geometry, toolbars, alternate text and accessibility-only math aren't glyphs.
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3 ? visibleText(node as Text, range, inner) : node.nodeType === 1 && visit(node as Element, inner)) return true;
    }
    return false;
  };
  return Array.from(roots).some(el => visit(el, view));
}

/** A measured spacer permits scrolling; it is never a rendered part of the current screen. */
export function visibleReadingGap(body: HTMLElement): boolean {
  const bounds = body.getBoundingClientRect();
  return Array.from(body.querySelectorAll<HTMLElement>('[data-reading-gap], [data-opening-gap]'))
    .some(el => !el.hidden && overlaps(el.getBoundingClientRect(), bounds));
}

/** Unsettled formal content still holds the first frame. A slow image can prepare in
 * its own sized slot when the viewport (or the requested image-bearing row) has real prose. */
export function firstConversationFrameReady(body: HTMLElement, rows: HTMLElement[], wanted?: HTMLElement | null): boolean {
  const view = body.getBoundingClientRect();
  if (view.bottom <= view.top) return false;
  const first = firstReadingAnchor(rows, view.top);
  if (!first) return true;
  const start = rows.indexOf(first);
  let end = start, loading = false, wantedLoading: HTMLElement | undefined;
  let thumbnails: { row: HTMLElement; image: HTMLImageElement }[] | undefined;
  for (; end < rows.length; end++) {
    const row = rows[end]!, rect = row.getBoundingClientRect();
    if (rect.top >= view.bottom) break;
    if (rect.bottom <= view.top || rect.height === 0) continue;
    if (row.dataset.virtualRendered === 'false') return false;
    for (const part of row.querySelectorAll<HTMLElement>('[data-conversation-pending], [data-reading-image="loading"]')) {
      const bounds = part.getBoundingClientRect();
      if (!bounds.width || bounds.height === 0 || bounds.bottom <= view.top || bounds.top >= view.bottom || bounds.right <= view.left || bounds.left >= view.right) continue;
      if (part.dataset?.readingImage !== 'loading') return false;
      loading = true;
      if (wanted && (row === wanted || row.contains(wanted))) wantedLoading = row;
      const image = part.querySelector<HTMLImageElement>('.conversation-image-review__open > img');
      if (image?.loading === 'lazy') (thumbnails ??= []).push({ row, image });
    }
  }
  if (!loading) return true;
  if (wantedLoading) {
    if (hasVisibleProse(wantedLoading, view)) return true;
  } else {
    for (let i = start; i < end; i++) if (hasVisibleProse(rows[i]!, view)) return true;
  }
  // Keep optional visible images native-lazy. Promote only the thumbnails we must wait for.
  for (const { row, image } of thumbnails ?? []) if (!wantedLoading || row === wantedLoading) image.loading = 'eager';
  return false;
}
