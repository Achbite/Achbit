import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModules, installGuiFetch } from './gui-projection-contract.mjs';

test('SSH GUI uses the remote Host for browsing, defaults and selected-file previews', async t => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  const nativeCalls = [];
  globalThis.window = {
    location: { protocol: 'deepcode-gui:', hostname: 'localhost' },
    __DEEPCODE_HOST_BOOT__: { schemaVersion: 'deepcode.host-ui-bootstrap', host: '127.0.0.1', port: '32123',
      uiToken: 'dcui_' + 'a'.repeat(64), windowChrome: 'custom', remote: true, remoteLabel: 'remote-test' },
    __TAURI__: { core: { invoke: async (...args) => { nativeCalls.push(args); } } },
  };
  globalThis.document = { documentElement: { dataset: { product: 'deepcode-gui' } } };
  t.after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });
  const [runtime, browser, hostModule] = await loadGuiModules(t, [
    '/src/services/runtimeAdapter.ts', '/src/services/nativeBrowser.ts', '/src/components/local-agent/ConversationHost.tsx',
  ]);
  assert.equal(runtime.hasNativePathPicker(), false);
  assert.equal(browser.hasNativeBrowser(), false);
  const calls = [];
  installGuiFetch(t, (url, init) => {
    calls.push(url.pathname);
    assert.equal(url.origin, 'http://127.0.0.1:32123');
    assert.equal(init.headers['x-deepcode-host-ui-token'], 'dcui_' + 'a'.repeat(64));
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
  assert.equal(await (await host.readLocalFile('/remote/remote.txt')).text(), 'remote file contents');
  assert.deepEqual(calls, ['/api/workspaces/default-path', '/api/fs/browse', '/api/fs/read']);
  assert.deepEqual(nativeCalls, []);
});
