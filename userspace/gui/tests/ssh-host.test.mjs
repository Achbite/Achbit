import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, installGuiFetch } from './gui-projection-contract.mjs';

test('SSH GUI uses the remote Host for browsing, defaults and selected-file previews', async t => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  const nativeCalls = [];
  globalThis.window = {
    location: { protocol: 'achbit-gui:', hostname: 'localhost' },
    __ACHBIT_HOST_BOOT__: { schemaVersion: 'achbit.host-ui-bootstrap', host: '127.0.0.1', port: '32123',
      uiToken: 'acui_' + 'a'.repeat(64), windowChrome: 'custom', remote: true, remoteLabel: 'remote-test' },
    __TAURI__: { core: { invoke: async (...args) => { nativeCalls.push(args); } } },
  };
  t.after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });
  const [runtime, browser, hostModule, { ResourcePreview }] = await loadGuiModules(t, [
    '/src/services/runtimeAdapter.ts', '/src/services/nativeBrowser.ts', '/src/components/local-agent/ConversationHost.tsx',
    '/src/components/local-agent/ResourcePreview.tsx',
  ]);
  globalThis.document = { documentElement: { dataset: { product: 'achbit-gui' } } };
  assert.equal(runtime.hasNativePathPicker(), false);
  assert.equal(browser.hasNativeBrowser(), false);
  const calls = [];
  installGuiFetch(t, (url, init) => {
    calls.push(url.pathname);
    assert.equal(url.origin, 'http://127.0.0.1:32123');
    assert.equal(init.headers['x-achbit-host-ui-token'], 'acui_' + 'a'.repeat(64));
    if (url.pathname === '/api/workspaces/default-path') return Response.json({ ok: true, data: { path: '/remote/workspace' } });
    if (url.pathname === '/api/fs/browse') return Response.json({ ok: true, data: { entries: [{ name: 'remote.txt' }] } });
    assert.equal(url.pathname, '/api/fs/read');
    assert.deepEqual(JSON.parse(init.body), { path: '/remote/remote.txt' });
    return new Response('remote file contents');
  });
  assert.equal((await runtime.getDefaultWorkspacePath()).data, '/remote/workspace');
  assert.equal((await runtime.browsePath('/remote')).data.entries[0].name, 'remote.txt');
  const host = hostModule.useConversationHost();
  assert.equal(host.openFile, undefined);
  assert.equal(host.locatePath, undefined);
  const renderReader = () => renderToStaticMarkup(createElement(ResourcePreview, { language: 'en-US', preview: {
    sessionId: 'session:remote', tabs: [{ id: 'remote-file', target: { kind: 'file', path: '/remote/remote.txt' } }],
    activeId: 'remote-file', visible: true, expanded: false, treeVisible: false, width: 55, error: null,
    selectTab() {}, closeTab() {}, newPage() {}, expand() {}, resize() {}, openTarget() {},
  } }));
  assert.doesNotMatch(renderReader(), /Open file with|Open in VS Code|Show in folder/,
    'remote Reader omits actions absent from the Host capabilities');
  host.openFile = async () => {};
  t.after(() => { host.openFile = undefined; host.locatePath = undefined; });
  assert.match(renderReader(), /Open in VS Code/);
  assert.doesNotMatch(renderReader(), /Show in folder/);
  host.openFile = undefined;
  host.locatePath = async () => {};
  assert.match(renderReader(), /Show in folder/);
  assert.doesNotMatch(renderReader(), /Open in VS Code/);
  host.locatePath = undefined;
  assert.equal(await (await host.readLocalFile('/remote/remote.txt')).text(), 'remote file contents');
  assert.deepEqual(calls, ['/api/workspaces/default-path', '/api/fs/browse', '/api/fs/read']);
  assert.deepEqual(nativeCalls, []);
  const target = { destination: 'dev@windows', cliPath: "C:\\Achbit App\\achbit-cli.exe", remoteShell: 'windows' };
  await runtime.connectSsh(target);
  assert.deepEqual(nativeCalls, [['achbit_connect_ssh', { target }]]);
});
