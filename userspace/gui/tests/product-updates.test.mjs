import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  return { html: renderToStaticMarkup(createElement(Probe)), tree };
}
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

test('product update notice renders the current update snapshot on the server', async t => {
  const b = browser(t);
  const [updates, { ProductUpdateNotice }] = await loadGuiModules(t, [
    '/src/services/productUpdates.ts', '/src/components/shared/ProductUpdateNotice.tsx',
  ]);
  const render = () => renderToStaticMarkup(createElement(ProductUpdateNotice));
  assert.equal(render(), '');
  const stop = await updates.installProductUpdateMonitor(); b.cleanups.push(stop);
  assert.match(render(), /data-product-update="waiting"/);
  findReactElement(capture(ProductUpdateNotice).tree, node => node.type === 'button').props.onClick();
  await flush();
  assert.equal(b.calls.some(call => call.command === 'achbit_update_install'), true);
  b.handlers.get('achbit:product-update')({ payload: { ...b.status, phase: 'downloading', downloaded: 25, total: 100 } });
  const downloading = render();
  assert.match(downloading, /role="progressbar"/);
  assert.match(downloading, /aria-valuenow="25"/);
  b.handlers.get('achbit:product-update')({ payload: { ...b.status, phase: 'error', error: 'Download interrupted' } });
  const failed = render();
  assert.match(failed, /data-product-update="error"/);
  assert.match(failed, /Download interrupted/);
});

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
  const [updates, views, { useLocalAgentStore }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/services/productUpdates.ts', '/src/services/interfaceReload.ts', '/src/state/localAgentStore.ts',
    '/src/state/settingsStore.ts',
  ]);
  t.mock.method(Date, 'now', () => now);
  useLocalAgentStore.setState({ runtimeReady: true, loading: false, submitting: false, catalogBusy: false });
  useSettingsStore.setState({ storePath: '/settings.json' });
  const stop = await updates.installProductUpdateMonitor(); b.cleanups.push(stop);
  await flush();
  b.saved.set('achbit:composer:new:independent', JSON.stringify({ draft: 'Unsent draft' }));
  const removeGuard = views.registerInterfaceReloadGuard(() => ({ label: 'Model settings', busy: false }));
  now = 20_000;
  b.handlers.get('achbit:update-prepare')({ payload: { nonce: 1, manual: false } }); await flush();
  assert.equal(b.calls.at(-1).args.storage, null);
  assert.equal(b.root.inert, false);
  removeGuard();
  b.window.dispatchEvent(new Event('compositionstart'));
  now = 40_000;
  b.handlers.get('achbit:update-prepare')({ payload: { nonce: 2, manual: false } }); await flush();
  assert.equal(b.calls.at(-1).args.storage, null);
  b.window.dispatchEvent(new Event('compositionend'));
  now = 60_000;
  b.handlers.get('achbit:update-prepare')({ payload: { nonce: 3, manual: false } }); await flush();
  assert.equal(b.root.inert, true);
  assert.equal(JSON.parse(b.calls.at(-1).args.storage['achbit:composer:new:independent']).draft, 'Unsent draft');
  b.handlers.get('achbit:update-resume')({ payload: null });
  assert.equal(b.root.inert, false);
});

test('automatic updates follow loaded settings; manual installation only bypasses the input grace period', async t => {
  const b = browser(t);
  let now = 0;
  const [updates, views, { useLocalAgentStore }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/services/productUpdates.ts', '/src/services/interfaceReload.ts', '/src/state/localAgentStore.ts',
    '/src/state/settingsStore.ts',
  ]);
  t.mock.method(Date, 'now', () => now);
  useLocalAgentStore.setState({ runtimeReady: true, loading: false, submitting: false, catalogBusy: false });
  const stop = await updates.installProductUpdateMonitor(); b.cleanups.push(stop); await flush();
  assert.equal(b.calls.at(-1).command, 'achbit_update_configure');
  assert.equal(b.calls.at(-1).args.enabled, false, 'do not enable automation before loading the saved preference');
  const settings = useSettingsStore.getState().effectiveSettings;
  useSettingsStore.setState({ storePath: '/settings.json', effectiveSettings: { ...settings, 'gui.autoUpdate': false } });
  await flush();
  let nonce = 0;
  const prepare = async manual => {
    b.handlers.get('achbit:update-prepare')({ payload: { nonce: ++nonce, manual } }); await flush();
    const reply = b.calls.findLast(call => call.command === 'achbit_update_prepare_response');
    assert.equal(reply.args.nonce, nonce);
    return reply.args.storage;
  };
  now = 60_000;
  assert.equal(await prepare(false), null);
  await updates.checkProductUpdate();
  assert.equal(b.calls.at(-1).command, 'achbit_update_check', 'manual checking remains available while automatic updates are off');
  b.window.dispatchEvent(new Event('pointerdown'));
  assert.notEqual(await prepare(true), null, 'the install click itself must not force a 15-second wait');
  b.handlers.get('achbit:update-resume')({});
  for (const key of ['submitting', 'loading', 'catalogBusy', 'modelSettingsBusy', 'subagentSettingsBusy']) {
    useLocalAgentStore.setState({ [key]: true });
    assert.equal(await prepare(true), null, `${key} must still block a manual update`);
    useLocalAgentStore.setState({ [key]: false });
  }
  const removeGuard = views.registerInterfaceReloadGuard(() => ({ label: 'Unsaved settings', busy: false }));
  assert.equal(await prepare(true), null); removeGuard();
  b.window.dispatchEvent(new Event('compositionstart'));
  assert.equal(await prepare(true), null);
  b.window.dispatchEvent(new Event('compositionend'));
  useSettingsStore.setState({ effectiveSettings: { ...settings, 'gui.autoUpdate': true } }); await flush();
  assert.equal(b.calls.at(-1).args.enabled, true);
  now += 20_000;
  const anotherApplication = new EventTarget();
  anotherApplication.dispatchEvent(new Event('keydown'));
  assert.notEqual(await prepare(false), null, 'outside activity must not reset the Achbit timer');
  b.handlers.get('achbit:update-resume')({});
  b.window.dispatchEvent(new Event('wheel'));
  assert.equal(await prepare(false), null, 'reading or scrolling inside Achbit counts as activity');
});

test('About Achbit exposes a manual check and a ready installation action', async t => {
  const b = browser(t);
  const [updates, { GuiSettingsSection }] = await loadGuiModules(t, [
    '/src/services/productUpdates.ts', '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
  ]);
  const stop = await updates.installProductUpdateMonitor(); b.cleanups.push(stop); await flush();
  const action = () => findReactElement(capture(GuiSettingsSection, { category: 'about', apiStatus: 'connected' }).tree,
    node => node.type === 'button' && /安装更新|检查更新|Install update|Check for updates/.test(node.props.children));
  action().props.onClick(); await flush();
  assert.equal(b.calls.at(-1).command, 'achbit_update_install');
  b.handlers.get('achbit:product-update')({ payload: { ...b.status, phase: 'current' } });
  action().props.onClick(); await flush();
  assert.equal(b.calls.at(-1).command, 'achbit_update_check');
});

test('the automatic update setting survives reload and a failed save preserves the saved value', async t => {
  browser(t);
  let persisted = {}, fail = false;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      if (fail) return Response.json({ ok: false, message: 'settings write failed' });
      const { patches } = JSON.parse(init.body);
      assert.deepEqual(patches, { 'gui.autoUpdate': false });
      persisted = { ...persisted, ...patches };
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, storePath: '/settings.json' } });
  });
  const [{ useSettingsStore }] = await loadGuiModules(t, ['/src/state/settingsStore.ts']);
  await useSettingsStore.getState().loadUserSettings();
  assert.equal(useSettingsStore.getState().effectiveSettings['gui.autoUpdate'], true);
  assert.equal(await useSettingsStore.getState().patchUserSetting('gui.autoUpdate', false), 'immediate');
  const [{ useSettingsStore: reloaded }] = await loadGuiModules(t, ['/src/state/settingsStore.ts']);
  await reloaded.getState().loadUserSettings();
  assert.equal(reloaded.getState().effectiveSettings['gui.autoUpdate'], false);
  fail = true;
  assert.equal(await reloaded.getState().patchUserSetting('gui.autoUpdate', true), null);
  assert.equal(reloaded.getState().effectiveSettings['gui.autoUpdate'], false);
  assert.match(reloaded.getState().errorMessage, /settings write failed/);
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
