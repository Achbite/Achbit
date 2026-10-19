export interface InterfaceUpdateState { available: boolean; error: string | null }
let state: InterfaceUpdateState = { available: false, error: null };
const listeners = new Set<() => void>();
let loadedResources: string[] | null = null;
let pending: Promise<void> | null = null;
let controller: AbortController | null = null;

export const interfaceUpdateSnapshot = () => state;
export const subscribeInterfaceUpdates = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: InterfaceUpdateState) { state = next; listeners.forEach((listener) => listener()); }
export function reportInterfaceLoadError(error: unknown) {
  publish({ ...state, error: error instanceof Error ? error.message : String(error) });
}
export function interfaceResourcesChanged(loaded: readonly string[], next: readonly string[]): boolean {
  if (loaded.length !== next.length) return true;
  const sortedNext = [...next].sort();
  return [...loaded].sort().some((value, index) => value !== sortedNext[index]);
}
function resources(document: Document): string[] {
  return Array.from(document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]'))
    .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? '').sort();
}

/** Compare this window's entry assets with the published UI. No Kernel or Session version gate. */
export function checkInterfaceUpdate(): Promise<void> {
  if (!loadedResources || state.available) return Promise.resolve();
  if (pending) return pending;
  controller = new AbortController();
  const current = controller;
  const timeout = window.setTimeout(() => current.abort(), 5000);
  pending = (async () => {
    try {
      const response = await fetch(new URL('./index.html', document.baseURI), { cache: 'no-store', signal: current.signal });
      if (!response.ok) throw new Error(`Interface update check: HTTP ${response.status}`);
      const next = resources(new DOMParser().parseFromString(await response.text(), 'text/html'));
      if (!next.length) throw new Error('Interface update check: published entry has no module assets');
      if (loadedResources && interfaceResourcesChanged(loadedResources, next)) publish({ ...state, available: true });
    } catch (error) {
      if (!current.signal.aborted) reportInterfaceLoadError(error);
    } finally { window.clearTimeout(timeout); pending = null; }
  })();
  return pending;
}

export function installInterfaceUpdateMonitor(): () => void {
  if (import.meta.env.DEV) return () => {};
  loadedResources = resources(document);
  const check = () => { if (document.visibilityState === 'visible') void checkInterfaceUpdate(); };
  const loadFailed = (event: Event) => reportInterfaceLoadError((event as Event & { payload: unknown }).payload);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('vite:preloadError', loadFailed);
  return () => { controller?.abort(); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); window.removeEventListener('vite:preloadError', loadFailed); loadedResources = null; };
}

export async function loadInterfaceModule<T>(load: () => Promise<T>): Promise<T> {
  try { return await load(); }
  catch (error) { reportInterfaceLoadError(error); throw error; }
}
