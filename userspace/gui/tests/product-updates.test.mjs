import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModules } from './gui-projection-contract.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function browser(t) {
  const previous = { window: globalThis.window, document: globalThis.document, sessionStorage: globalThis.sessionStorage };
  const saved = new Map(), handlers = new Map(), calls = [], cleanups = [];
  const root = { inert: false };
  const status = { phase: 'waiting', currentVersion: '0.6.63-debug.1', version: '0.6.63-debug.2',
    downloaded: 1, total: 1, reason: null, error: null };
  const window = new EventTarget();
  Object.assign(window, { location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost' },
    localStorage: { getItem: () => null }, __TAURI__: {
      event: { async listen(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); } },
      core: { async invoke(command, args) { calls.push({ command, args }); return command === 'achbit_update_status' ? status : null; } },
    } });
  globalThis.window = window;
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => root };
  globalThis.sessionStorage = {
    get length() { return saved.size; }, key(index) { return [...saved.keys()][index] ?? null; },
    getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); },
  };
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { saved, calls, handlers, root, window, status, cleanups };
}

test('a real restart snapshot restores the draft and selected conversation before mounting', async t => {
  const b = browser(t);
  const [updates, views] = await loadGuiModules(t, ['/src/services/productUpdates.ts', '/src/services/interfaceReload.ts']);
  const draft = { draft: 'Keep this unsent text', pastedTexts: [], pastedImages: [],
    filesystemPaths: [{ path: '/work/notes.md', kind: 'file' }], pluginSelections: [], selectionStart: 5, selectionEnd: 5 };
  b.saved.set('achbit:composer:session:one', JSON.stringify(draft));
  const unregister = views.registerInterfaceReloadView('conversation', () => ({ sessionId: 'session:one', draftProjectId: null }));
  t.after(unregister);
  const snapshot = updates.snapshotForProductUpdate();
  b.saved.clear(); // A new native process creates a new WebView session.
  b.window.__TAURI__.core.invoke = async command => {
    b.calls.push({ command });
    return command === 'achbit_update_restore' ? snapshot : null;
  };
  await updates.restoreAfterProductUpdate();
  assert.deepEqual(JSON.parse(b.saved.get('achbit:composer:session:one')), draft);
  assert.deepEqual(views.takeRestoredInterfaceView('conversation', null), { sessionId: 'session:one', draftProjectId: null });
  assert.equal(b.calls.at(-1).command, 'achbit_update_restored');
});

test('unsaved settings and IME input defer an automatic restart; idle preparation freezes and snapshots the draft', async t => {
  const b = browser(t);
  let now = 0;
  const [updates, views, { useLocalAgentStore }] = await loadGuiModules(t, [
    '/src/services/productUpdates.ts', '/src/services/interfaceReload.ts', '/src/state/localAgentStore.ts',
  ]);
  t.mock.method(Date, 'now', () => now);
  useLocalAgentStore.setState({ runtimeReady: true, loading: false, submitting: false, catalogBusy: false });
  const stop = await updates.installProductUpdateMonitor(); b.cleanups.push(stop);
  b.saved.set('achbit:composer:new:independent', JSON.stringify({ draft: 'Unsent draft' }));
  const removeGuard = views.registerInterfaceReloadGuard(() => ({ label: 'Model settings', busy: false }));
  now = 20_000;
  b.handlers.get('achbit:update-prepare')({ payload: 1 }); await flush();
  assert.equal(b.calls.at(-1).args.storage, null);
  assert.equal(b.root.inert, false);
  removeGuard();
  b.window.dispatchEvent(new Event('compositionstart'));
  now = 40_000;
  b.handlers.get('achbit:update-prepare')({ payload: 2 }); await flush();
  assert.equal(b.calls.at(-1).args.storage, null);
  b.window.dispatchEvent(new Event('compositionend'));
  now = 60_000;
  b.handlers.get('achbit:update-prepare')({ payload: 3 }); await flush();
  assert.equal(b.root.inert, true);
  assert.equal(JSON.parse(b.calls.at(-1).args.storage['achbit:composer:new:independent']).draft, 'Unsent draft');
  b.handlers.get('achbit:update-resume')({ payload: null });
  assert.equal(b.root.inert, false);
});

test('failed restoration retains the native snapshot for a later retry', async t => {
  const b = browser(t);
  const [updates] = await loadGuiModules(t, ['/src/services/productUpdates.ts']);
  b.window.__TAURI__.core.invoke = async command => {
    b.calls.push({ command });
    return command === 'achbit_update_restore' ? { 'achbit:composer:x': '{"draft":"retained"}' } : null;
  };
  globalThis.sessionStorage.setItem = () => { throw new Error('storage unavailable'); };
  await assert.rejects(updates.restoreAfterProductUpdate(), /storage unavailable/);
  assert.equal(b.calls.some(call => call.command === 'achbit_update_restored'), false);
});
