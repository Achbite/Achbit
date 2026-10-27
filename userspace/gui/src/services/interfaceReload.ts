import { useEffect, useRef } from 'react';

const storageKey = 'achbit:interface-reload';
const views = new Map<string, () => unknown>();
const guards = new Map<symbol, () => { label: string; busy: boolean } | null>();
let restored: Record<string, unknown> = {};
try {
  const saved = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(storageKey);
  if (saved) restored = JSON.parse(saved);
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(storageKey);
} catch (error) { console.error('Cannot restore interface view state', error); }

/** Only view state is saved here. Session facts are read again from the shared service. */
export function restoredInterfaceView<T>(key: string, initial: T): T {
  return (restored[key] as T | undefined) ?? initial;
}
export function registerInterfaceReloadView(key: string, read: () => unknown) {
  views.set(key, read);
  return () => { views.delete(key); };
}
export function takeRestoredInterfaceView<T>(key: string, initial: T): T {
  const value = restoredInterfaceView(key, initial);
  delete restored[key];
  return value;
}
export function useInterfaceReloadView(key: string, value: unknown) {
  const current = useRef(value);
  current.current = value;
  useEffect(() => registerInterfaceReloadView(key, () => current.current), [key]);
}
export function useInterfaceReloadGuard(dirty: boolean, label: string, busy = false) {
  const current = useRef({ dirty, label, busy });
  current.current = { dirty, label, busy };
  useEffect(() => registerInterfaceReloadGuard(() => current.current.dirty || current.current.busy ? current.current : null), []);
}
export function registerInterfaceReloadGuard(read: () => { label: string; busy: boolean } | null) {
  const id = Symbol();
  guards.set(id, read);
  return () => { guards.delete(id); };
}
export function interfaceReloadGuards() { return [...guards.values()].flatMap(read => read() ?? []); }
export function requestInterfaceReload() { window.dispatchEvent(new Event('achbit:request-interface-reload')); }
function saveInterfaceViews() {
  sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries([...views].map(([key, read]) => [key, read()]))));
}
export function reloadInterface() {
  if (interfaceReloadGuards().some(guard => guard.busy)) return;
  saveInterfaceViews();
  window.location.reload();
}
/** A tool can request refresh, but cannot discard a user's unsaved settings. */
export function refreshInterface(): { status: 'needsUser' | 'scheduled'; guards: Array<{ label: string; busy: boolean }> } {
  const pending = interfaceReloadGuards();
  if (pending.length) return { status: 'needsUser', guards: pending.map(({ label, busy }) => ({ label, busy })) };
  saveInterfaceViews();
  // Let the native evaluation return its receipt before the document is replaced.
  window.setTimeout(() => {
    if (interfaceReloadGuards().length === 0) window.location.reload();
  }, 250);
  return { status: 'scheduled', guards: [] };
}
export function installInterfaceReloadShortcut() {
  const hostWindow = window as Window & { __ACHBIT_INTERFACE__?: { refresh: typeof refreshInterface } };
  const control = { refresh: refreshInterface };
  hostWindow.__ACHBIT_INTERFACE__ = control;
  const keydown = (event: KeyboardEvent) => {
    if (!event.isComposing && !event.repeat && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault(); event.stopImmediatePropagation(); requestInterfaceReload();
    }
  };
  window.addEventListener('keydown', keydown, true);
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void window.__TAURI__?.event?.listen('achbit:reload-interface', requestInterfaceReload).then(stop => { if (disposed) stop(); else unlisten = stop; });
  return () => {
    disposed = true; unlisten?.(); window.removeEventListener('keydown', keydown, true);
    if (hostWindow.__ACHBIT_INTERFACE__ === control) delete hostWindow.__ACHBIT_INTERFACE__;
  };
}
