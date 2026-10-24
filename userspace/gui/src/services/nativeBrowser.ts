import { isRemoteHost } from './hostTarget';

export type BrowserViewport = { mode: 'adaptive' } | { mode: 'fixed'; width: number; height: number };

export interface NativeHostBinding { hostInstanceId: string; windowLabel: string; sessionId?:string }
export interface NativePage extends NativeHostBinding {
  previewId: string; url: string; status: string; visible: boolean; serviceOwner: string;
  kind:string; serviceId?:string;
  viewport: BrowserViewport;
  control?: { activeRuns: string[] };
  surface: { generation: number; sequence: number; activationId: number; activationAck: number; reason: string; bounds: [number, number, number, number] | null };
}
/** Translate a user's address into the existing Host navigation contract. */
export function nativeNavigationInput(address: string): { url: string } | { filePath: string } {
  const value = address.trim();
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return { filePath: value };
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('请输入完整的网页地址，或选择本地 HTML 文件。'); }
  if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')) {
    const path = decodeURIComponent(url.pathname);
    return { filePath: /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('支持 HTTP、HTTPS 网页和本地 HTML 文件。');
  return { url: url.href };
}
export function hasNativeBrowser(): boolean {
  return !isRemoteHost() && typeof window !== 'undefined' && Boolean(window.__TAURI__?.core?.invoke)
    && !window.__DEEPCODE_BROWSER_PREVIEW__
    && document.documentElement.dataset.product === 'deepcode-gui';
}

export async function listenNativePages(listener:(page:NativePage)=>void):Promise<()=>void> {
  if (!hasNativeBrowser()) return ()=>{};
  if (!window.__TAURI__?.event) throw new Error('Native browser page events are unavailable.');
  return window.__TAURI__.event.listen<NativePage>('deepcode:browser-page',({payload})=>listener(payload));
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
  return window.__TAURI__.event.listen<NativePage>('deepcode:browser-activate', ({ payload }) => listener(payload));
}
export async function nativeHostBinding(): Promise<NativeHostBinding | undefined> {
  if (!hasNativeBrowser()) return undefined;
  return window.__TAURI__!.core!.invoke!<NativeHostBinding>('deepcode_browser_host');
}
export async function nativeBrowserCommand<T>(binding: NativeHostBinding, input: Record<string, unknown>): Promise<T> {
  if (!hasNativeBrowser()) throw new Error('native_browser_host_unavailable');
  return window.__TAURI__!.core!.invoke!<T>('deepcode_browser_command', { binding, input });
}
