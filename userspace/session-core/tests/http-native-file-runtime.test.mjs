import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { KERNEL_REPLY_VERSION, LOCAL_AGENT_PROTOCOL_VERSION } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { corePromptInstructions } from '../dist/local-agent/coreInstructions.js';
import { prepareApprovalReview } from '../dist/local-agent/approvalReview.js';
import { preparePlanReview } from '../dist/local-agent/planReview.js';
import { emptySessionState } from '../dist/local-agent/reducer.js';
import { prepareContextCompaction } from '../dist/local-agent/compaction.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { HttpRunPreparationPort } from '../dist/local-agent/httpPorts.js';
import { runtimeSnapshot } from './local-agent-fixtures.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';

// Exercise the production HTTP adapter with the same envelope fields emitted by
// Host prepare-run; actor FakePort fixtures cannot detect this decoder mismatch.
async function httpPreparation(t, promptContributions, codingTools = false) {
  const seed = runtimeSnapshot('run:http-native');
  let provider = structuredClone(seed.provider);
  let reviewer = structuredClone(seed.provider);
  let projectInstructions, userSystemPrompt;
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
          sessionId: input.sessionId, runId: input.runId, mode: codingTools ? 'minimal' : 'full', provider, approvalReviewer: reviewer,
          ...(projectInstructions === undefined ? {} : { projectInstructions }),
          ...(userSystemPrompt === undefined ? {} : { userSystemPrompt }),
          webSearch: seed.webSearch, extensionGenerationRef: seed.extensionGenerationRef,
          kernelCatalogSnapshotRef: seed.kernelCatalogSnapshotRef, tools: [], toolPromptProviders: [],
          toolSelection: { kernel: [], controls: [], plugins: seed.selectedPlugins.plugins.length > 0 },
          pluginConfig: { extensionGenerationRef: seed.extensionGenerationRef, permissions: seed.permissions, selectedPlugins: [] },
          selectedPlugins: seed.selectedPlugins, environment: seed.environment,
          agentCapabilities: seed.agentCapabilities, agentToolsEnabled: true, subagentSettings: seed.subagentSettings, contextManagement: seed.contextManagement };
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
    serviceToken: 'fixture-http-token', stableCoreInstructions: corePromptInstructions(!codingTools), promptContributions, codingTools });
  const request = { sessionId: 'session:http-native', runId: 'run:http-native', profileId: seed.provider.profileId,
    workspaceBindingIds: [] };
  return { port, request, requests, releases,
    useProjectInstructions(value) { projectInstructions = value; },
    useUserSystemPrompt(value) { userSystemPrompt = value; },
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
    const input = { ...fixture.request, workspaceBindings: [], runtime, events: [], providerRequestId: 'request:main', responseConstraint: 'normal' };
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

test('project instruction sources enter system context and replay unchanged until a new prepared snapshot changes them', async t => {
  const fixture = await httpPreparation(t);
  const initial = (await fixture.port.prepare(fixture.request)).runtimeSnapshot;
  for (const sources of [[], [{ path: '/project/AGENTS.md', text: '  \n' }]]) {
    fixture.useProjectInstructions(sources);
    assert.deepEqual((await fixture.port.prepare(fixture.request)).runtimeSnapshot.instructions, initial.instructions);
  }
  const sources = [{ path: '/project/AGENTS.md', text: 'Keep the project contract.\n' },
    { path: '/project/nested/AGENTS.md', text: 'Use the nested conventions.\n' }];
  fixture.useProjectInstructions(sources);
  const request = { ...fixture.request, workspaceBindingIds: ['workspace:project'] };
  const first = (await fixture.port.prepare(request)).runtimeSnapshot;
  const replay = JSON.parse(JSON.stringify(first));
  const contribution = replay.instructions.filter(item => item.id === 'achbit.project-instructions');
  assert.equal(contribution.length, 1);
  for (const source of sources) {
    assert.ok(contribution[0].text.includes(source.path));
    assert.ok(contribution[0].text.includes(source.text));
  }
  assert.deepEqual(fixture.requests.at(-1).workspaceBindingIds, request.workspaceBindingIds);
  assert.deepEqual(first.environment, initial.environment);
  assert.deepEqual(first.tools, initial.tools);
  const compose = async (runtime, runId = request.runId) => (await buildAgentProviderRequest({ ...request, runId, workspaceBindings: [],
    runtime, events: [], providerRequestId: 'request:project-instructions', responseConstraint: 'normal' })).request;
  const firstRequest = await compose(replay);
  assert.equal(firstRequest.messages.filter(message => message.role === 'system'
    && message.content.includes('Keep the project contract.')).length, 1);
  assert.ok(firstRequest.messages.filter(message => message.role !== 'system')
    .every(message => !message.content.includes('Keep the project contract.')));
  const same = (await fixture.port.prepare({ ...request, runId: 'run:same-project' })).runtimeSnapshot;
  assert.deepEqual((await compose(same, 'run:same-project')).messages, firstRequest.messages, 'new run identities do not alter the system prefix');
  fixture.useProjectInstructions([{ ...sources[0], text: 'The updated project contract.\n' }]);
  const changed = (await fixture.port.prepare({ ...request, runId: 'run:changed-project' })).runtimeSnapshot;
  assert.ok((await compose(changed, 'run:changed-project')).messages.some(message => message.role === 'system'
    && message.content.includes('The updated project contract.')));
  assert.deepEqual((await compose(replay)).messages, firstRequest.messages, 'recorded snapshots do not reread current sources');
  assert.deepEqual(replay.instructions, first.instructions);
});

for (const mode of ['full', 'minimal']) test(`HTTP user system prompt enters only the ${mode} working prefix once`, async t => {
  const fixture = await httpPreparation(t, [], mode === 'minimal');
  const { sessionId, runId } = fixture.request;
  const id = 'achbit.user-system-prompt', marker = 'global-only-marker', text = `  ${marker}\n按原文保留。\n`;
  fixture.useProjectInstructions([{ path: '/project/AGENTS.md', text: 'project-only-marker' }]);
  const prepare = async () => JSON.parse(JSON.stringify((await fixture.port.prepare(fixture.request)).runtimeSnapshot));
  const compose = runtime => buildAgentProviderRequest({ sessionId, runId, runtime, events: [], workspaceBindings: [],
    responseConstraint: 'normal', providerRequestId: 'request:user-prompt' });
  const baseline = await prepare();
  const empty = await compose(baseline);
  fixture.useUserSystemPrompt(text);
  const saved = await prepare();
  assertRuntimeContract('RunRuntimeSnapshot', saved);
  assert.equal(saved.mode, mode);
  assert.deepEqual(saved.instructions.filter(item => item.id === id), [{ id, text }]);
  const { request, receipt } = await compose(saved);
  assertRuntimeContract('ProviderRequest', request);
  const position = receipt.messages.findIndex(item => item.contributionId === `instruction:${id}`);
  assert.ok(position > 0 && position < request.messages.findIndex(message => message.content.includes('project-only-marker')));
  assert.deepEqual(request.messages[position], { role: 'system', content: text });
  assert.deepEqual(request.messages.toSpliced(position, 1), empty.request.messages, 'no other instruction replaced or duplicated');
  assert.deepEqual(request.tools, empty.request.tools);
  assert.deepEqual(saved.permissions, baseline.permissions);
  // Decision packets are built independently; the preference is not a user message or approval.
  const snapshot = { events: [], state: { ...emptySessionState(sessionId), run: { runId, workspaceBindings: [] } } };
  const approval = { runId, callId: 'call:review', preview: { effects: ['process'], logicalTargets: ['.'],
    operation: { toolName: 'bash', arguments: { command: 'pwd' } } } };
  const plan = { runId, planId: 'plan:review', revision: 1, title: 'Review', steps: [], mutationManifest: [], workspaceRequests: [] };
  for (const review of [prepareApprovalReview(snapshot, saved, approval, 'request:execution'), preparePlanReview(snapshot, saved, plan, 'request:plan')]) {
    assert.ok(review.request.messages.every(message => !message.content.includes(marker)));
  }
  for (const value of ['', ' \n']) {
    fixture.useUserSystemPrompt(value);
    assert.deepEqual((await compose(await prepare())).request.messages, empty.request.messages);
  }
  assert.deepEqual((await compose(saved)).request.messages, request.messages, 'replaying a captured snapshot does not consult live settings');
});

test('invalid HTTP user system prompt preserves the decoder error and releases the acquired runtime', async t => {
  const fixture = await httpPreparation(t);
  for (const invalid of [null, 42, '界'.repeat(21_846)]) {
    fixture.useUserSystemPrompt(invalid);
    await assert.rejects(fixture.port.prepare(fixture.request), /run_runtime_user_system_prompt_invalid/);
  }
  assert.equal(fixture.releases.length, 3);
});

test('invalid project instruction wire entries reject and release the prepared runtime', async t => {
  const fixture = await httpPreparation(t);
  const invalid = [null, {}, [{ path: '/project/AGENTS.md' }], [{ path: '', text: 'Instructions' }],
    [{ path: '/project/AGENTS.md', text: 5 }], [{ path: '/project/AGENTS.md', text: 'Instructions', count: 1 }]];
  for (const sources of invalid) {
    fixture.useProjectInstructions(sources);
    await assert.rejects(fixture.port.prepare(fixture.request), /run_runtime_project_instructions_invalid/);
  }
  assert.equal(fixture.releases.length, invalid.length, 'invalid sources use the existing preparation rollback');
});
