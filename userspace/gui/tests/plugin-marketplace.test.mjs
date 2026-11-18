import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

const commit = '1a2b3c4d'.repeat(5);
const base = 'https://github.com/example/demo';
const plugin = {
  id: 'echo', name: 'Text Echo', description: 'Echo text', kind: 'guidance', author: 'Example author', version: '1.2.0',
  sourceCommit: commit, sourceUrl: `${base}/tree/${commit}/echo`, licenseKind: 'open-source',
  licenseName: 'MIT', licenseUrl: `${base}/blob/${commit}/LICENSE`, downloadUrl: `${base}/releases/download/v1.2.0/echo.zip`,
};
const index = (...plugins) => ({ schemaVersion: 1, plugins });

test('a plugin directory can contain distinct licenses, optional attestations, or no entries', async t => {
  const { decodePluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  assert.deepEqual(decodePluginMarketplace(index()), []);
  const sourceAvailable = { ...plugin, id: 'theme', kind: 'ui', licenseKind: 'source-available', licenseName: 'Community License' };
  const verified = { ...plugin, verification: { kind: 'installation', platform: 'macos-arm64', version: '1.2.0', evidenceUrl: base } };
  assert.deepEqual(decodePluginMarketplace(index(verified, sourceAvailable)), [verified, sourceAvailable]);
  const publisher = { ...plugin, verification: { kind: 'publisher', evidenceUrl: base }, repositoryUrl: base };
  assert.deepEqual(decodePluginMarketplace(index(publisher)), [publisher]);
});

test('invalid origin, license or verification details are reported as a directory error', async t => {
  const { decodePluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  for (const document of [
    { schemaVersion: 2, plugins: [] }, index(plugin, plugin),
    index({ ...plugin, sourceCommit: commit.slice(0, 8) }), index({ ...plugin, sourceUrl: base + '/tree/main' }),
    index({ ...plugin, author: '' }), index({ ...plugin, licenseName: '' }),
    index({ ...plugin, licenseKind: 'undisclosed' }), index({ ...plugin, licenseUrl: 'file:///LICENSE' }),
    index({ ...plugin, downloadUrl: 'javascript:alert(1)' }), index({ ...plugin, downloadUrl: base + '/releases/latest/download/echo.zip' }),
    index({ ...plugin, verification: { kind: 'installation', platform: 'macos-arm64', version: '1.0.0' } }),
    index({ ...plugin, verification: { kind: 'installation', version: '1.2.0' } }),
  ]) assert.throws(() => decodePluginMarketplace(document));
});

test('directory fetch propagates HTTP failure and returns the data from a later successful request', async t => {
  const { fetchPluginMarketplace, PLUGIN_MARKETPLACE_INDEX_URL } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  const signal = new AbortController().signal;
  const responses = [new Response('', { status: 503 }), Response.json(index(plugin))];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, PLUGIN_MARKETPLACE_INDEX_URL);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.credentials, 'omit');
    return responses.shift();
  });
  await assert.rejects(fetchPluginMarketplace(signal), /503/);
  assert.deepEqual(await fetchPluginMarketplace(signal), [plugin]);
});

test('directory falls back on transport failure and requests raw main data anonymously from GitHub Contents', async t => {
  const { fetchPluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) throw new TypeError('private transport unavailable');
    return Response.json(index(plugin));
  });
  assert.deepEqual(await fetchPluginMarketplace(), [plugin]);
  assert.equal(calls.length, 2);
  const {url, init} = calls[1];
  assert.equal(url.host, 'api.github.com');
  assert.equal(url.pathname, '/repos/Achbite/achbit-plugins/contents/plugins.json');
  assert.equal(url.searchParams.get('ref'), 'main');
  assert.equal(init.credentials, 'omit');
  assert.equal(new Headers(init.headers).get('Accept'), 'application/vnd.github.raw+json');
});

test('a received invalid directory is surfaced without fetching another origin', async t => {
  const { fetchPluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  const responses = [new Response('not-json'), Response.json({schemaVersion: 2, plugins: []})];
  const mock = t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(fetchPluginMarketplace(), SyntaxError);
  await assert.rejects(fetchPluginMarketplace(), /directory format/);
  assert.equal(mock.mock.callCount(), 2);
});

test('cancelling during either origin aborts its request and stops fallback', async t => {
  const { fetchPluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  for (const failPrimary of [false, true]) {
    const owner = new AbortController();
    const reason = new DOMException('Panel closed', 'AbortError');
    let calls = 0;
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, {signal}) => {
      if (failPrimary && ++calls === 1) throw new TypeError('first origin unavailable');
      if (!failPrimary) calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        queueMicrotask(() => owner.abort(reason));
      });
    });
    await assert.rejects(fetchPluginMarketplace(owner.signal), error => error === reason);
    assert.equal(calls, failPrimary ? 2 : 1);
    await assert.rejects(fetchPluginMarketplace(owner.signal), error => error === reason);
    assert.equal(calls, failPrimary ? 2 : 1);
    fetch.mock.restore();
  }
});

test('both unresponsive origins are bounded and the failure retains their separate reasons', async t => {
  const { fetchPluginMarketplace } = await loadGuiModule(t, '/src/services/pluginMarketplace.ts');
  let resolveStarted;
  const secondStarted = new Promise(resolve => { resolveStarted = resolve; });
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (_url, {signal}) => {
    if (++count === 2) resolveStarted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('socket closed')), { once: true }));
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = fetchPluginMarketplace();
    t.mock.timers.runAll();
    await secondStarted;
    t.mock.timers.runAll();
    await assert.rejects(pending, error => /raw\.githubusercontent\.com:.*timed out/.test(error.message)
      && /api\.github\.com:.*timed out/.test(error.message));
    assert.equal(count, 2);
  } finally { t.mock.timers.reset(); }
});
