export function clippedBrowserBounds(rect: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  return { x, y, width: Math.max(0, Math.min(width, rect.x + rect.width) - x), height: Math.max(0, Math.min(height, rect.y + rect.height) - y) };
}
export function measureBrowserSurface(surface: HTMLElement, active: boolean) {
  const bounds = clippedBrowserBounds(surface.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  const covered = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"], .achbit-local-agent-overlay, .settings-center-overlay, details[data-native-overlay][open], [data-native-overlay]:not(details)')].some(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.width > 0 && rect.height > 0 && rect.right > bounds.x && rect.left < bounds.x + bounds.width
      && rect.bottom > bounds.y && rect.top < bounds.y + bounds.height;
  });
  const reason = !active ? 'inactive' : bounds.width < 1 || bounds.height < 1 ? 'emptyBounds' : covered ? 'covered' : 'visible';
  return { ...bounds, visible: reason === 'visible', reason };
}
