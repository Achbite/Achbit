import { interfaceReloadGuards, saveInterfaceViews, restoreInterfaceViews } from './interfaceReload';
import { useLocalAgentStore } from '../state/localAgentStore';
import { useSettingsStore } from '../state/settingsStore';

export interface ProductUpdateStatus {
  phase: string; currentVersion: string; version: string | null;
  downloaded: number; total: number | null; reason: string | null; error: string | null;
}
let state: ProductUpdateStatus = { phase: 'disabled', currentVersion: '', version: null,
  downloaded: 0, total: null, reason: null, error: null };
export interface ProductUpdateConfirmation { busy: boolean; unsaved: string[] }
let confirmation: ProductUpdateConfirmation | null = null;
let confirmReply: ((accepted: boolean) => void) | undefined;
export const productUpdateConfirmation = () => confirmation;
export function respondProductUpdate(accepted: boolean) {
  const reply = confirmReply;
  confirmReply = undefined; confirmation = null;
  for (const listener of listeners) listener();
  reply?.(accepted);
}
function confirmUpdate(value: ProductUpdateConfirmation): Promise<boolean> {
  confirmation = value;
  const result = new Promise<boolean>(resolve => { confirmReply = resolve; });
  for (const listener of listeners) listener();
  return result;
}
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
export function requestProductUpdate() {
  return state.phase === 'waiting' ? invoke<void>('achbit_update_install') : checkProductUpdate();
}

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

export function installProductUpdateMonitor(): () => void {
  const nativeEvents = window.__TAURI__?.event;
  if (!nativeEvents || !window.__TAURI__?.core?.invoke) return () => {};
  const cleanups: Array<() => void> = [];
  let lastInput = Date.now();
  let composing = false;
  let disposed = false;
  const root = document.getElementById('root');
  const thaw = () => { if (root) root.inert = false; delete document.documentElement.dataset.updating; };
  const activity = () => { lastInput = Date.now(); };
  const compositionStart = () => { composing = true; activity(); };
  const compositionEnd = () => { composing = false; activity(); };
  // Only activity delivered to this Achbit window postpones an automatic restart.
  const events = ['input', 'keydown', 'pointerdown', 'pointermove', 'wheel', 'focus'] as const;
  for (const event of events) window.addEventListener(event, activity, true);
  window.addEventListener('compositionstart', compositionStart, true);
  window.addEventListener('compositionend', compositionEnd, true);
  let statusVersion = 0;
  const reportError = (error: unknown) => {
    if (disposed) return;
    statusVersion++;
    publish({ ...state, phase: 'error', error: String(error) });
  };
  const prepare = (event: { payload: { nonce: number; manual: boolean; busy: boolean } }) => {
    void (async () => {
      if (disposed || confirmation !== null) {
        await invoke('achbit_update_prepare_response', { nonce: event.payload.nonce, storage: null });
        return;
      }
      let storage: { storage: Record<string, string>; confirmed: boolean } | null = null;
      const agent = useLocalAgentStore.getState();
      const settings = useSettingsStore.getState();
      const automatic = settings.storePath !== null && settings.effectiveSettings['gui.autoUpdate'] === true;
      const guards = interfaceReloadGuards();
      let ready = !disposed;
      let confirmed = false;
      if (event.payload.manual) {
        if (event.payload.busy || guards.length || composing) {
          thaw();
          ready = await confirmUpdate({ busy: event.payload.busy, unsaved: guards.map(guard => guard.label) });
          confirmed = ready;
        }
      } else {
        ready = ready && !composing && !settings.loading && automatic && Date.now() - lastInput >= 15_000
          && !guards.length && agent.runtimeReady && !agent.loading
          && !agent.submitting && !agent.catalogBusy && !agent.modelSettingsBusy;
      }
      if (ready && !disposed) {
        // Freeze only after confirmation. Session cancellation remains owned by the Host.
        if (root) root.inert = true;
        document.documentElement.dataset.updating = 'true';
        storage = { storage: snapshotForProductUpdate(), confirmed };
      }
      await invoke('achbit_update_prepare_response', { nonce: event.payload.nonce, storage });
    })().catch(error => {
      if (!disposed) thaw();
      reportError(error);
      void invoke('achbit_update_prepare_response', { nonce: event.payload.nonce, storage: null }).catch(console.error);
    });
  };
  let configured: boolean | undefined;
  let configuration = Promise.resolve();
  const configure = () => {
    const settings = useSettingsStore.getState();
    const enabled = settings.storePath !== null && settings.effectiveSettings['gui.autoUpdate'] === true;
    if (enabled === configured) return;
    configured = enabled;
    configuration = configuration.then(() => {
      if (!disposed) return invoke<void>('achbit_update_configure', { enabled });
    }).catch(reportError);
  };
  const release = async (stop: () => void) => {
    try { await stop(); } catch (error) { console.error('[Achbit update monitor cleanup]', error); }
  };
  const own = async (registration: Promise<() => void>) => {
    const stop = await registration;
    if (disposed) void release(stop); else cleanups.push(stop);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; respondProductUpdate(false); thaw();
    cleanups.forEach(release);
    for (const event of events) window.removeEventListener(event, activity, true);
    window.removeEventListener('compositionstart', compositionStart, true);
    window.removeEventListener('compositionend', compositionEnd, true);
  };
  const start = async () => {
    // Be able to thaw and answer preparation before offering or enabling installation.
    await own(nativeEvents.listen('achbit:update-resume', () => { if (!disposed) thaw(); }));
    if (disposed) return;
    await own(nativeEvents.listen('achbit:update-prepare', prepare));
    if (disposed) return;
    await own(nativeEvents.listen<ProductUpdateStatus>('achbit:product-update', ({ payload }) => {
      if (disposed) return;
      statusVersion++;
      publish(payload);
      if (!['preparing', 'installing'].includes(payload.phase)) thaw();
    }));
    if (disposed) return;
    const beforeRead = statusVersion;
    void invoke<ProductUpdateStatus>('achbit_update_status').then(initial => {
      if (!disposed && statusVersion === beforeRead) publish(initial);
    }).catch(error => {
      if (statusVersion === beforeRead) reportError(error);
    });
    cleanups.push(useSettingsStore.subscribe(configure));
    configure();
  };
  void start().catch(error => {
    reportError(error);
    dispose(); // release any subscriptions acquired before registration failed
  });
  return dispose;
}
