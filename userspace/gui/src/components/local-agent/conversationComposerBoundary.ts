/** Extend the transcript through transparent accessories, never beneath an actionable wait card. */
export function observeConversationComposerBoundary(shell: HTMLElement, viewport: HTMLElement | null, showingShellWait = false, childInline = false): () => void {
  // UiRegion commits the composer into a detached portal host before attaching it.
  // The conversation owner supplies its viewport; ancestor lookup here is too early.
  const surface = shell.querySelector<HTMLElement>(childInline ? '[data-agent-review="inline"]' : showingShellWait ? '.local-agent__shell-wait' : '.local-agent__composer');
  // A standalone composer or an entirely replaced region need not own a transcript.
  if (!viewport || !surface) return () => {};
  const property = '--conversation-composer-overlap';
  const update = () => {
    const overlap = viewport.clientHeight > 0
      ? Math.max(0, surface.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom)
      : 0;
    const value = `${overlap}px`;
    if (viewport.style.getPropertyValue(property) !== value) viewport.style.setProperty(property, value);
  };
  const resize = new ResizeObserver(update);
  resize.observe(viewport);
  resize.observe(shell);
  resize.observe(surface);
  update();
  return () => {
    resize.disconnect();
    viewport.style.removeProperty(property);
  };
}
