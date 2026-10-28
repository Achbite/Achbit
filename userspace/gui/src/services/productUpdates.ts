import { interfaceReloadGuards, saveInterfaceViews, restoreInterfaceViews } from './interfaceReload';
import { useLocalAgentStore } from '../state/localAgentStore';

export interface ProductUpdateStatus {
  phase: string; currentVersion: string; version: string | null;
  downloaded: number; total: number | null; reason: string | null; error: string | null;
}
let state: ProductUpdateStatus = { phase: 'disabled', currentVersion: '', version: null,
  downloaded: 0, total: null, reason: null, error: null };
const listeners = new Set<() => void>();
export const productUpdateSnapshot = () => state;
export const subscribeProductUpdates = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
function publish(next: ProductUpdateStatus) { state = next; for (const listener of listeners) listener(); }
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const call = window.__TAURI__?.core?.invoke;
  if (!call) return Promise.reject(new Error('desktop_updater_unavailable'));
  return call<T>(command, args);
}
export function checkProductUpdate() { return invoke<void>('achbit_update_check'); }

export async function restoreAfterProductUpdate(): Promise<void> {
  if (!window.__TAURI__?.core?.invoke) return;
  const storage = await invoke<Record<string, string> | null>('achbit_update_restore');
  if (!storage) return;
  for (const [key, value] of Object.entries(storage)) sessionStorage.setItem(key, value);
  restoreInterfaceViews();
  await invoke('achbit_update_restored');
}

export function snapshotForProductUpdate(): Record<string, string> {
  saveInterfaceViews();
  const storage: Record<string, string> = {};
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index);
    if (key && (key.startsWith('achbit:composer:') || key.startsWith('achbit:reader:')
      || key === 'achbit:interface-reload')) storage[key] = sessionStorage.getItem(key)!;
  }
  return storage;
}

export async function installProductUpdateMonitor(): Promise<() => void> {
  if (!window.__TAURI__?.event || !window.__TAURI__?.core?.invoke) return () => {};
  let lastInput = Date.now();
  let composing = false;
  let disposed = false;
  const root = document.getElementById('root');
  const thaw = () => { if (root) root.inert = false; delete document.documentElement.dataset.updating; };
  const activity = () => { lastInput = Date.now(); };
  const compositionStart = () => { composing = true; activity(); };
  const compositionEnd = () => { composing = false; activity(); };
  const events = ['input', 'keydown', 'pointerdown'] as const;
  for (const event of events) window.addEventListener(event, activity, true);
  window.addEventListener('compositionstart', compositionStart, true);
  window.addEventListener('compositionend', compositionEnd, true);
  const stopStatus = await window.__TAURI__.event.listen<ProductUpdateStatus>('achbit:product-update', event => {
    publish(event.payload);
    if (!['preparing', 'installing'].includes(event.payload.phase)) thaw();
  });
  const stopResume = await window.__TAURI__.event.listen('achbit:update-resume', thaw);
  const stopPrepare = await window.__TAURI__.event.listen<number>('achbit:update-prepare', event => {
    void (async () => {
      let storage: Record<string, string> | null = null;
      const agent = useLocalAgentStore.getState();
      if (!disposed && !composing && Date.now() - lastInput >= 15_000
        && !interfaceReloadGuards().length && agent.runtimeReady && !agent.loading
        && !agent.submitting && !agent.catalogBusy && !agent.modelSettingsBusy && !agent.subagentSettingsBusy) {
        // Freeze inputs before the snapshot; the native Host then checks all Sessions.
        if (root) root.inert = true;
        document.documentElement.dataset.updating = 'true';
        storage = snapshotForProductUpdate();
      }
      await invoke('achbit_update_prepare_response', { nonce: event.payload, storage });
    })().catch(error => {
      thaw();
      publish({ ...state, phase: 'error', error: String(error) });
      void invoke('achbit_update_prepare_response', { nonce: event.payload, storage: null }).catch(console.error);
    });
  });
  publish(await invoke<ProductUpdateStatus>('achbit_update_status'));
  return () => {
    disposed = true; thaw(); stopStatus(); stopResume(); stopPrepare();
    for (const event of events) window.removeEventListener(event, activity, true);
    window.removeEventListener('compositionstart', compositionStart, true);
    window.removeEventListener('compositionend', compositionEnd, true);
  };
}
