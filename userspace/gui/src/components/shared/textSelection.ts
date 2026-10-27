/** WebKit snaps blank-space clicks to nearby text, including outside a message.
 * Allow dragging from a text line's trailing space, but not unrelated chrome.
 */
export function preventBlankTextSelection(event: MouseEvent): void {
  if (event.button !== 0 || !(event.target instanceof Element)
    || event.target.closest('input, textarea, select, button, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"])')) return;
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
    const surface = node.parentElement?.closest(READING_SURFACES);
    const bounds = surface?.getBoundingClientRect();
    const style = node.parentElement && document.defaultView?.getComputedStyle(node.parentElement);
    for (const index of [offset, offset - 1]) {
      if (index < 0 || index >= text.length || /\s/u.test(text[index]!)) continue;
      const glyph = document.createRange();
      glyph.setStart(node, index); glyph.setEnd(node, index + 1);
      if ([...glyph.getClientRects()].some(rect => {
        if (event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom) return true;
        // A single press anywhere on this reading line can start a native drag.
        // Double-clicks in empty space must not select the nearest word/block.
        const leading = Math.max(2, ((Number.parseFloat(style?.lineHeight ?? '') || rect.height) - rect.height) / 2);
        return event.detail <= 1 && bounds && surface?.contains(event.target as Node)
          && event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= rect.top - leading && event.clientY <= rect.bottom + leading;
      })) return;
    }
  }
  event.preventDefault();
  // Cancelling blank-space selection also cancels the browser's focus transfer.
  // Release an editor when the user explicitly clicks outside it.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches(EDITABLE) && !active.contains(event.target)) {
    active.blur();
  }
  if (!event.shiftKey) document.getSelection()?.removeAllRanges();
}

const READING_SURFACES = '.conversation-markdown, .conversation-markdown-inline, .local-agent__message-text, .local-agent__user-text, pre, .textLayer, .ui-plugin-view, [data-selectable-text], [role="alert"]';
const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const CONTROLS = 'button, select, summary, [role="button"]';

/** WebKit can extend a native Range across user-select:none chrome. Keep a
 * reading selection in the surface where it started; editors own their selection. */
export function installTextSelectionBoundary(document: Document): () => void {
  let surface: Element | null = null;
  const highlightName = 'achbit-reading-selection';
  const clearPaint = () => {
    document.documentElement.removeAttribute('data-reading-selection');
    CSS.highlights?.delete(highlightName);
  };
  const begin = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(EDITABLE)) { surface = null; clearPaint(); return; }
    if (!event.shiftKey) surface = null;
    preventBlankTextSelection(event);
    if (!event.defaultPrevented && !event.target.closest(CONTROLS)) {
      surface ??= event.target.closest(READING_SURFACES);
    }
  };
  const contain = () => {
    const selection = document.getSelection();
    if (!surface?.isConnected || !selection?.rangeCount || selection.isCollapsed
      || !selection.anchorNode || !surface.contains(selection.anchorNode) || !selection.focusNode) return;
    if (surface.contains(selection.focusNode) && selection.focusNode.nodeType === Node.TEXT_NODE
      && !selection.focusNode.parentElement?.closest(CONTROLS)) return;
    const bounds = document.createRange();
    bounds.selectNodeContents(surface);
    const focus = document.createRange();
    focus.setStart(selection.focusNode, selection.focusOffset);
    focus.collapse(true);
    const before = focus.compareBoundaryPoints(Range.START_TO_START, bounds) < 0;
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent?.trim() && !node.parentElement?.closest(`${CONTROLS}, ${EDITABLE}`)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let endpoint = walker.nextNode();
    if (!before) {
      let next;
      while ((next = walker.nextNode())) endpoint = next;
    }
    if (endpoint) selection.extend(endpoint, before ? 0 : endpoint.textContent!.length);
  };
  const update = () => {
    contain();
    clearPaint();
    const selection = document.getSelection();
    if (typeof Highlight === 'undefined' || !CSS.highlights || !surface?.isConnected
      || !selection?.rangeCount || selection.isCollapsed || !selection.anchorNode
      || !surface.contains(selection.anchorNode) || selection.anchorNode.parentElement?.closest(EDITABLE)) return;
    // Keep the real Selection for copy/navigation. Paint only its text fragments,
    // so WebKit cannot fill block margins and the empty ends of wrapped lines.
    const selected = selection.getRangeAt(0);
    const fragments: Range[] = [];
    const addText = (node: Node) => {
      if (!node.textContent?.trim() || node.parentElement?.closest(`${CONTROLS}, ${EDITABLE}`)
        || !selected.intersectsNode(node)) return;
      const fragment = document.createRange();
      fragment.setStart(node, node === selected.startContainer ? selected.startOffset : 0);
      fragment.setEnd(node, node === selected.endContainer ? selected.endOffset : node.textContent.length);
      if (!fragment.collapsed) fragments.push(fragment);
    };
    const root = selected.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) addText(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) addText(node);
    }
    if (fragments.length) {
      CSS.highlights.set(highlightName, new Highlight(...fragments));
      document.documentElement.setAttribute('data-reading-selection', '');
    }
  };
  document.addEventListener('mousedown', begin, true);
  document.addEventListener('selectionchange', update);
  document.addEventListener('mouseup', update);
  return () => {
    document.removeEventListener('mousedown', begin, true);
    document.removeEventListener('selectionchange', update);
    document.removeEventListener('mouseup', update);
    clearPaint();
  };
}
