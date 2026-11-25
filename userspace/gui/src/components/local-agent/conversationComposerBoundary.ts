// One owner computes overlap for each live viewport. A read during its first layout
// commit can use the same measurement as ResizeObserver, without a fixed reveal delay.
const boundaries = new WeakMap<HTMLElement, () => boolean>();

export function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  // The composer can commit into a detached UiRegion. A zero scrollHeight there is
  // not the natural size: keep the native rows until the real surface is measurable.
  if (textarea.style.height !== 'auto') textarea.style.height = 'auto';
  if (!textarea.isConnected || textarea.clientWidth === 0) return;
  const height = textarea.scrollHeight;
  if (height > textarea.clientHeight) textarea.style.height = `${height}px`;
}
export function syncConversationComposerBoundary(viewport: HTMLElement | null): boolean {
  return !viewport || (boundaries.get(viewport)?.() ?? true);
}

/** Only the unoccupied part of the composer row is available for reading. */
export function observeConversationComposerBoundary(shell: HTMLElement, viewport: HTMLElement | null, showingShellWait = false, childInline = false): () => void {
  // UiRegion commits the composer into a detached portal host before attaching it.
  // The conversation owner supplies its viewport; ancestor lookup here is too early.
  const surface = shell.querySelector<HTMLElement>(childInline ? '[data-agent-review="inline"]' : showingShellWait ? '.local-agent__shell-wait' : '.local-agent__composer');
  // A standalone composer or an entirely replaced region need not own a transcript.
  if (!viewport || !surface) return () => {};
  const property = '--conversation-composer-overlap';
  const dock = shell.querySelector<HTMLElement>(':scope > .conversation-change-dock');
  let dockList: HTMLElement | null = null;
  let connected = false;
  const update = () => {
    const ready = surface.isConnected !== false && viewport.isConnected !== false && viewport.clientHeight > 0;
    if (ready && !connected) {
      // Size restored drafts in the attached portal before revealing the reading target.
      // Waiting for textarea ResizeObserver would expose a different viewport for one frame.
      const input = surface.querySelector?.<HTMLTextAreaElement>(':scope > textarea');
      if (input) resizeComposerTextarea(input);
    }
    const nextList = dock?.querySelector<HTMLElement>('.conversation-change-list') ?? null;
    if (nextList !== dockList) {
      if (dockList) resize.unobserve(dockList);
      dockList = nextList;
      if (dockList) resize.observe(dockList);
    }
    let overlap = 0;
    if (ready) {
      const bottom = viewport.getBoundingClientRect().bottom;
      overlap = Math.max(0, surface.getBoundingClientRect().top - bottom);
      const reserve = (row: Element) => {
        const rect = row.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) overlap = Math.min(overlap, rect.top - bottom);
      };
      for (const row of shell.children) {
        if (row === dock && !dock.childElementCount) continue; // transparent spacer
        reserve(row);
      }
      if (dockList) reserve(dockList); // an open absolute list can extend above the grid row
    }
    const value = `${overlap}px`;
    if (viewport.style.getPropertyValue(property) !== value) viewport.style.setProperty(property, value);
    if (ready && !connected) { connected = true; viewport.dispatchEvent?.(new Event('achbit:conversation-boundary-ready')); }
    return ready;
  };
  boundaries.set(viewport, update);
  const resize = new ResizeObserver(update);
  resize.observe(viewport);
  resize.observe(shell);
  resize.observe(surface);
  // An empty dock and a populated one can have exactly the same outer dimensions.
  const children = new MutationObserver(update);
  children.observe(shell, { childList: true });
  if (dock) children.observe(dock, { childList: true });
  update();
  return () => {
    children.disconnect();
    resize.disconnect();
    if (boundaries.get(viewport) === update) { boundaries.delete(viewport); viewport.style.removeProperty(property); }
  };
}
