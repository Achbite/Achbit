/** WebKit may select a neighbouring paragraph on a multi-click in its blank box.
 * Suppress only that default selection; word selection, dragging and editing stay native.
 */
export function preventBlankTextSelection(event: MouseEvent): void {
  if (event.button !== 0 || event.detail < 2 || !(event.target instanceof Element)
    || event.target.closest('input, textarea, [contenteditable="true"]')) return;
  const document = event.target.ownerDocument as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range = !caret ? document.caretRangeFromPoint?.(event.clientX, event.clientY) : null;
  // Keep native behaviour when this engine has no point-to-caret API.
  if (!document.caretPositionFromPoint && !document.caretRangeFromPoint) return;
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset ?? 0;
  if (node?.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    for (const index of [offset, offset - 1]) {
      if (index < 0 || index >= text.length || /\s/u.test(text[index]!)) continue;
      const glyph = document.createRange();
      glyph.setStart(node, index); glyph.setEnd(node, index + 1);
      if ([...glyph.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom)) return;
    }
  }
  event.preventDefault();
}
