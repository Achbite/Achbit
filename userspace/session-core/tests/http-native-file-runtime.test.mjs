import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { KERNEL_REPLY_VERSION, LOCAL_AGENT_PROTOCOL_VERSION } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { prepareContextCompaction } from '../dist/local-agent/compaction.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { HttpRunPreparationPort } from '../dist/local-agent/httpPorts.js';
import { runtimeSnapshot } from './local-agent-fixtures.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';

// Exercise the production HTTP adapter with the same envelope fields emitted by
// Host prepare-run; actor FakePort fixtures cannot detect this decoder mismatch.
async function httpPreparation(t, promptContributions) {
  const seed = runtimeSnapshot('run:http-native');
  let provider = structuredClone(seed.provider);
  let reviewer = structuredClone(seed.provider);
  const requests = [], releases = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers['x-achbit-session-service-token'], 'fixture-http-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      let data;
      if (request.url === '/api/local-agent/runtime/prepare-run') {
        requests.push(input);
        data = { schemaVersion: LOCAL_AGENT_PROTOCOL_VERSION, type: 'run.runtime.prepared',
          sessionId: input.sessionId, runId: input.runId, provider, approvalReviewer: reviewer,
          webSearch: seed.webSearch, extensionGenerationRef: seed.extensionGenerationRef,
          kernelCatalogSnapshotRef: seed.kernelCatalogSnapshotRef, tools: [], toolPromptProviders: [],
          toolSelection: { kernel: [], controls: [], plugins: seed.selectedPlugins.plugins.length > 0 },
          pluginConfig: { extensionGenerationRef: seed.extensionGenerationRef, permissions: seed.permissions, selectedPlugins: [] },
          selectedPlugins: seed.selectedPlugins, environment: seed.environment,
          agentCapabilities: seed.agentCapabilities, agentToolsEnabled: true, contextManagement: seed.contextManagement };
      } else if (request.url === '/api/local-agent/runtime/release-run') {
        releases.push(input);
        data = { schemaVersion: KERNEL_REPLY_VERSION, type: 'tool.catalog.released', ...input,
          released: true, alreadyReleased: false };
      } else throw new Error(`unexpected_http_path:${request.url}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = new HttpRunPreparationPort({ apiBase: `http://127.0.0.1:${server.address().port}`,
    serviceToken: 'fixture-http-token', stableCoreInstructions: seed.instructions, promptContributions });
  const request = { sessionId: 'session:http-native', runId: 'run:http-native', profileId: seed.provider.profileId,
    workspaceBindings: [] };
  return { port, request, requests, releases,
    usePlugins(uris) { seed.selectedPlugins.plugins = uris.map(uri => ({ uri,
      pluginArtifactRef: `artifact:${uri}`, pluginInstanceRef: `instance:${uri}`,
      extensionGenerationRef: seed.extensionGenerationRef, capabilityRefs: [] })); },
    useProvider(extra) { provider = { ...seed.provider, ...extra }; },
    useReviewer(extra) { reviewer = { ...seed.provider, ...extra }; } };
}

test('HTTP preparation admits enabled inherited plugins while requiring every new explicit selection', async t => {
  const fixture = await httpPreparation(t);
  const selected = uri => ({ selectionId: uri, uri, label: uri });
  const explicit = 'plugin://explicit@local', retained = 'plugin://retained@local';
  const request = { ...fixture.request, pluginSelections: [selected(explicit)],
    inheritedPluginSelections: [selected(retained)] };
  for (const available of [[explicit, retained], [explicit]]) {
    fixture.usePlugins(available);
    const prepared = await fixture.port.prepare(request);
    assert.deepEqual(prepared.runtimeSnapshot.selectedPlugins.plugins.map(plugin => plugin.uri), available);
    assert.deepEqual(fixture.requests.at(-1).inheritedPluginSelections, request.inheritedPluginSelections);
  }
  for (const unavailable of [[retained], [explicit, 'plugin://unrequested@local']]) {
    fixture.usePlugins(unavailable);
    await assert.rejects(fixture.port.prepare(request), /selected_plugin_snapshot_identity_mismatch/);
  }
});

test('HTTP preparation preserves stable token calibration keys for the provider and reviewer', async t => {
  const fixture = await httpPreparation(t);
  fixture.useProvider({ inputTokenCalibrationKey: 'input-token-calibration:main' });
  fixture.useReviewer({ inputTokenCalibrationKey: 'input-token-calibration:reviewer' });
  const prepared = await fixture.port.prepare(fixture.request);
  const restored = JSON.parse(JSON.stringify(prepared.runtimeSnapshot));
  assert.equal(restored.provider.inputTokenCalibrationKey, 'input-token-calibration:main');
  assert.equal(restored.approvalReviewer.inputTokenCalibrationKey, 'input-token-calibration:reviewer');
  assertRuntimeContract('ProviderRuntimeSnapshot', restored.provider);
  assertRuntimeContract('ProviderRuntimeSnapshot', restored.approvalReviewer);
  assert.equal(fixture.releases.length, 0);
  for (const invalid of [null, '', 'invalid key', 'invalid\n', 42]) {
    assert.throws(() => assertRuntimeContract('ProviderRuntimeSnapshot', { ...restored.provider, inputTokenCalibrationKey: invalid }));
    fixture.useProvider({ inputTokenCalibrationKey: invalid });
    await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  }
  assert.equal(fixture.releases.length, 5, 'invalid calibration metadata must release the prepared runtime');
});

test('real HTTP run preparation accepts omitted, empty and PDF file capabilities for provider and reviewer', async t => {
  const fixture = await httpPreparation(t);
  for (const capability of [undefined, [], ['application/pdf']]) {
    const extra = capability === undefined ? {} : { fileInputMediaTypes: capability };
    fixture.useProvider(extra); fixture.useReviewer(extra);
    const prepared = await fixture.port.prepare(fixture.request);
    assert.deepEqual(prepared.runtimeSnapshot.provider.fileInputMediaTypes, capability ?? []);
    assert.deepEqual(prepared.runtimeSnapshot.approvalReviewer.fileInputMediaTypes, capability ?? []);
    assertRuntimeContract('ProviderRuntimeSnapshot', prepared.runtimeSnapshot.provider);
    assertRuntimeContract('ProviderRuntimeSnapshot', prepared.runtimeSnapshot.approvalReviewer);
  }
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.releases.length, 0, 'valid capabilities must not trigger preparation rollback');
});

test('prepared product instructions survive snapshot replay and share the agent/summary prefix independently of tools', async t => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  for (const ids of [[], ['achbit.rich-replies']]) {
    const parts = registry.productInstructions({ productComponents: ids, tools: { plugins: false } });
    const fixture = await httpPreparation(t, parts);
    const { runtimeSnapshot } = await fixture.port.prepare(fixture.request);
    const runtime = JSON.parse(JSON.stringify(runtimeSnapshot));
    assert.deepEqual(runtime.instructions.filter(item => item.id === 'achbit.rich-replies'), parts);
    const input = { ...fixture.request, runtime, events: [], providerRequestId: 'request:main', responseConstraint: 'normal' };
    const main = await buildAgentProviderRequest(input);
    const summary = prepareContextCompaction({ ...input, requestEvent: {
      payload: { coveredThroughSequence: 0, providerRequestId: 'request:summary' },
    } });
    const rich = main.request.messages.some(message => message.content.includes('Mermaid'));
    assert.equal(rich, ids.length > 0);
    assert.deepEqual(main.request.tools, []);
    assert.deepEqual(summary.request.tools, main.request.tools);
    assert.deepEqual(summary.request.messages.slice(0, -1), main.request.messages);
    assert.equal(summary.request.responseConstraint, 'answerOnly');
  }
});

test('HTTP file capability errors remain strict and release the acquired run runtime', async t => {
  const fixture = await httpPreparation(t);
  for (const invalid of [
    { fileInputMediaTypes: 'application/pdf' },
    { fileInputMediaTypes: null },
    { fileInputMediaTypes: ['application/pdf', 'application/pdf'] },
    { fileInputMediaTypes: ['text/plain'] },
    { apiSurface: 'responses', fileInputMediaTypes: ['application/pdf'] },
  ]) {
    fixture.useProvider(invalid);
    await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  }
  fixture.useProvider({ fileInputMediaTypes: [] });
  fixture.useReviewer({ fileInputMediaTypes: ['text/plain'] });
  await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  assert.equal(fixture.releases.length, 6);
  assert.ok(fixture.releases.every(release => release.sessionId === fixture.request.sessionId
    && release.runId === fixture.request.runId && release.kernelCatalogSnapshotRef));
});
