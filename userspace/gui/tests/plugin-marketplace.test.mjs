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
    assert.equal(init.signal, signal);
    assert.equal(init.credentials, 'omit');
    return responses.shift();
  });
  await assert.rejects(fetchPluginMarketplace(signal), /503/);
  assert.deepEqual(await fetchPluginMarketplace(signal), [plugin]);
});
