/** Scroll only the tab strip; never move keyboard focus or the conversation. */
export function revealActiveReaderTab(list: HTMLElement | null): void {
  const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!list || !active) return;
  const tab = active.closest<HTMLElement>('.reader-tab') ?? active;
  const bounds = list.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (bounds.width <= 0 || rect.width <= 0) return;
  const style = getComputedStyle(list);
  // CSS scroll padding includes the selected tab's decorative feet. 'auto' is zero.
  const left = bounds.left + (Number.parseFloat(style.scrollPaddingLeft) || 0);
  const right = bounds.right - (Number.parseFloat(style.scrollPaddingRight) || 0);
  const delta = rect.left < left || rect.width > right - left
    ? rect.left - left : Math.max(0, rect.right - right);
  if (delta) list.scrollLeft += delta;
}
