/** Scroll only the tab strip; never move keyboard focus or the conversation. */
export function revealActiveReaderTab(list: HTMLElement | null): void {
  const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!list || !active) return;
  const tab = active.closest<HTMLElement>('.reader-tab') ?? active;
  const bounds = list.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (bounds.width <= 0 || rect.width <= 0) return;
  const delta = rect.left < bounds.left || rect.width > bounds.width
    ? rect.left - bounds.left : Math.max(0, rect.right - bounds.right);
  if (delta) list.scrollLeft += delta;
}
