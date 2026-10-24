import type { BrowserViewport } from '../../services/nativeBrowser';

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { mode: 'fixed', width: 1280, height: 800 };

/** Keep CSS layout dimensions separate from the panel's display dimensions. */
export function fitBrowserViewport(viewport: BrowserViewport, width: number, height: number) {
  if (viewport.mode === 'adaptive') return { width, height, scale: 1, left: 0 };
  const scale = Math.max(0, Math.min(width / viewport.width, height / viewport.height, 1));
  return { width: viewport.width, height: viewport.height, scale, left: (width - viewport.width * scale) / 2 };
}
