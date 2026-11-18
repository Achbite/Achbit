import { isRemoteHost } from './hostTarget';

export type BrowserViewport = { mode: 'adaptive' } | { mode: 'fixed'; width: number; height: number };

export interface NativeHostBinding { hostInstanceId: string; windowLabel: string; sessionId?:string }
export interface NativePage extends NativeHostBinding {
  previewId: string; url: string; status: string; visible: boolean; serviceOwner: string;
  kind:string; serviceId?:string;
  viewport: BrowserViewport;
  navigation: { title: string; canGoBack: boolean; canGoForward: boolean };
  zoom: number;
  loadError: string | null;
  control?: { activeRuns: string[] };
  surface: { generation: number; sequence: number; activationId: number; activationAck: number; reason: string; bounds: [number, number, number, number] | null };
}
/** Translate a user's address into the existing Host navigation contract. */
export function nativeNavigationInput(address: string): { url: string } | { filePath: string } {
  const value = address.trim();
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return { filePath: value };
  if (!value) throw new Error('browser_address_empty');
  let candidate = value;
  if (!/^(?:https?|file):/i.test(value)) {
    const host = /^(localhost(?:\.[\w-]+)*|(?:[\w-]+\.)+[\w-]+|\[[\da-f:]+\]|[\w-]+:\d+)(?::\d+)?(?:[/?#].*)?$/i.exec(value);
    if (!host || /\s/.test(value)) throw new Error(/^[a-z][\w+.-]*:/i.test(value) ? 'browser_address_scheme' : 'browser_address_invalid');
    const authority = value.split(/[/?#]/, 1)[0];
    const local = /^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/.test(authority) || /:\d+$/.test(authority);
    candidate = `${local ? 'http' : 'https'}://${value}`;
  }
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new Error('browser_address_invalid'); }
  if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')) {
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { throw new Error('browser_address_invalid'); }
    return { filePath: /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('browser_address_scheme');
  return { url: url.href };
}
export function hasNativeBrowser(): boolean {
  return !isRemoteHost() && typeof window !== 'undefined' && Boolean(window.__TAURI__?.core?.invoke)
    && !window.__ACHBIT_BROWSER_PREVIEW__
    && document.documentElement.dataset.product === 'achbit-gui';
}

export async function listenNativePages(listener:(page:NativePage)=>void):Promise<()=>void> {
  if (!hasNativeBrowser()) return ()=>{};
  if (!window.__TAURI__?.event) throw new Error('Native browser page events are unavailable.');
  return window.__TAURI__.event.listen<NativePage>('achbit:browser-page',({payload})=>listener(payload));
}

/** Subscribe before listing so page changes during the snapshot are retained. */
export async function watchNativePages(binding: NativeHostBinding, listener: (pages: NativePage[]) => void): Promise<() => void> {
  const pages = new Map<string, NativePage>();
  const pending = new Map<string, NativePage>();
  let initialized = false;
  const apply = (page: NativePage) => {
    if (page.status === 'closed') pages.delete(page.previewId);
    else pages.set(page.previewId, page);
  };
  const unlisten = await listenNativePages(page => {
    if (page.hostInstanceId !== binding.hostInstanceId || page.sessionId !== binding.sessionId) return;
    if (!initialized) { pending.set(page.previewId, page); return; }
    apply(page);
    listener([...pages.values()]);
  });
  try {
    const snapshot = await nativeBrowserCommand<{ pages: NativePage[] }>(binding, { action: 'list' });
    for (const page of snapshot.pages) apply(page);
    for (const page of pending.values()) apply(page);
    pending.clear();
    initialized = true;
    listener([...pages.values()]);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}
export async function listenNativeActivation(listener: (page: NativePage) => void): Promise<() => void> {
  if (!hasNativeBrowser()) return () => {};
  if (!window.__TAURI__?.event) throw new Error('Native browser page events are unavailable.');
  return window.__TAURI__.event.listen<NativePage>('achbit:browser-activate', ({ payload }) => listener(payload));
}
export interface NativeBrowserChromeEvent { previewId: string; action?: string; error?: string | null }
export async function listenNativeBrowserChrome(listener: (event: NativeBrowserChromeEvent) => void): Promise<() => void> {
  if (!hasNativeBrowser()) return () => {};
  if (!window.__TAURI__?.event) throw new Error('Native browser page events are unavailable.');
  return window.__TAURI__.event.listen<NativeBrowserChromeEvent>('achbit:browser-chrome', ({ payload }) => listener(payload));
}
export async function nativeHostBinding(): Promise<NativeHostBinding | undefined> {
  if (!hasNativeBrowser()) return undefined;
  return window.__TAURI__!.core!.invoke!<NativeHostBinding>('achbit_browser_host');
}
export async function nativeBrowserCommand<T>(binding: NativeHostBinding, input: Record<string, unknown>): Promise<T> {
  if (!hasNativeBrowser()) throw new Error('native_browser_host_unavailable');
  return window.__TAURI__!.core!.invoke!<T>('achbit_browser_command', { binding, input });
}
