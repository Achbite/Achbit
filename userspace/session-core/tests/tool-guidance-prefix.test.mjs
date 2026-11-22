import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionActor } from '../dist/index.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent, createSession,
  messageCommand, readEvents, waitForProjection, workspaceBinding, idFactory,
} from './local-agent-fixtures.mjs';

const tools = [
  ['fs.read', 'workspaceRead', { path: { type: 'string' } }],
  ['bash', 'process', { command: { type: 'string' } }],
  ['skill.read', 'localRead', { name: { type: 'string' } }],
  ['plugin.search', 'localRead', { query: { type: 'string' } }],
].map(([name, effect, properties]) => ({
  name, description: name, toolBindingRef: `binding:${name}`, origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: [effect],
  inputSchema: { type: 'object', properties, required: [] },
}));

test('Skill reads, activation and subsequent Loops retain core tool definitions and sent history', async t => {
  for (const apiSurface of ['chatCompletions', 'responses']) {
    const sessionId = `session:skill-prefix-${apiSurface}`;
    const journal = new InMemoryCommandJournal();
    await createSession(journal, sessionId, [workspaceBinding]);
    const frontend = 'plugin://frontend@local';
    const operations = 'plugin://achbit-iteration@builtin';
    const preparation = fakeRunPreparation({ tools, apiSurface, contextWindowTokens: 100000 });
    const runPreparation = { ...preparation.port, async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      Object.assign(runtime.environment, { productDocsPath: '/fixture/docs',
        hostDataDirectory: '/fixture/state', runtimeExecutables: { kernel: '/fixture/kernel', cli: '/fixture/cli' } });
      for (const plugin of runtime.selectedPlugins.plugins) {
        plugin.skillEntryPath = plugin.uri === frontend ? '/fixture/frontend/SKILL.md' : '/fixture/iteration/SKILL.md';
      }
      return prepared;
    } };
    const toolGuidance = new SessionConfigurationRegistry(undefined, achbitProductComponents)
      .productToolGuidance({ productComponents: ['achbit.product-operations'] });
    const requests = [];
    const provider = { async *stream(request) {
      const step = requests.length;
      assert.ok(step < 6, 'the two completed Loops and explicit selection need six requests');
      if (step > 0) {
        assert.deepEqual(request.tools, requests[0].tools, 'Skill metadata must keep every tool declaration stable');
        assert.deepEqual(request.messages.slice(0, requests.at(-1).messages.length), requests.at(-1).messages,
          'new requests must retain all previously sent messages');
      }
      requests.push(structuredClone(request));
      if (step === 0 || step === 3 || step === 1) {
        const name = step === 1 ? 'plugin_activate' : 'skill_read';
        const input = step === 1 ? { pluginUris: [frontend] } : { name: 'achbit-iteration' };
        yield apiSurface === 'responses'
          ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
            type: 'function_call', call_id: `native:${step}`, name, arguments: JSON.stringify(input), status: 'completed',
          } })
          : providerEvent(request.requestId, 'tool.call', { callId: `native:${step}`, name, input });
      } else {
        yield providerEvent(request.requestId, 'text.delta', { text: 'Finished.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = new SessionActor(sessionId, journal, {
      provider, runPreparation, toolGuidance,
      kernel: emptyKernel({ async execute(request) {
        assert.equal(request.toolName, 'skill.read');
        return completedExecutionReply(request, { content: '# Iteration\nFollow the actual entry point.' });
      } }),
      async dispose() {},
    }, { nextId: idFactory(`skill-prefix-${apiSurface}`) });
    t.after(() => actor.dispose());

    await actor.submit(messageCommand(sessionId, 'command:first', 'Read the iteration Skill and activate the frontend Skill.'));
    await waitForProjection(actor, state => state.run?.status === 'completed');
    await actor.submit(messageCommand(sessionId, 'command:second', 'Read the iteration Skill again, then answer.'));
    await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 5);
    await actor.submit({ ...messageCommand(sessionId, 'command:third', 'Use the selected Skills.'), pluginSelections: [
      { uri: frontend, label: 'Frontend', selectionId: 'selection:frontend' },
      { uri: operations, label: 'Iteration', selectionId: 'selection:iteration' },
    ] });
    await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 6);

    for (const index of [1, 4]) {
      const result = requests[index].messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.match(result.content, /^# Iteration\nFollow the actual entry point\.\n\nAchbit product resources:/);
      assert.ok(result.content.includes('/fixture/cli'));
    }
    const activated = JSON.parse(requests[2].messages.at(-1).content);
    assert.deepEqual(activated.skillEntries, [{ uri: frontend, path: '/fixture/frontend/SKILL.md' }]);
    const selected = requests[5].messages.at(-1);
    assert.equal(selected.role, 'user');
    assert.ok(selected.content.startsWith('Use the selected Skills.'));
    for (const path of ['/fixture/frontend/SKILL.md', '/fixture/iteration/SKILL.md', '/fixture/cli']) {
      assert.ok(selected.content.includes(path));
    }
    const events = await readEvents(journal, sessionId);
    assert.equal(events.filter(event => event.type === 'run.started').length, 3);
    const latest = events.findLast(event => event.type === 'context.composed');
    const started = events.findLast(event => event.type === 'run.started');
    const replay = buildConversationProviderRequest({
      purpose: 'agent', responseConstraint: 'normal', sessionId, runId: started.runId,
      providerRequestId: 'request:replay', runtime: started.payload.runtimeSnapshot, toolGuidance,
      events: events.filter(event => event.sequence <= latest.payload.modelView.throughSequence),
      modelViewEvents: events, workspaceBindings: [workspaceBinding],
    });
    assert.deepEqual(replay.request.messages, requests[5].messages, 'frozen model views survive a fresh context build');
    assert.deepEqual(replay.request.tools, requests[5].tools);
    await actor.dispose();
  }
});

// Test the actual selection message and activation result. A location does not
// authorize a file read. Even skill.read itself only reads compiled-in content.
const bash = tools.find(tool => tool.name === 'bash');
const powershell = { ...bash, name: 'powershell', description: 'PowerShell', toolBindingRef: 'binding:powershell' };
const fileReaders = [tools.find(tool => tool.name === 'fs.read'), bash, powershell];
const extension = 'plugin://custom@cli';
for (const [scenario, readers, disclose] of [
  ['bash-only', [bash], true],
  ['powershell-only', [powershell], true],
  ['no-file-reader', [], false],
  ['blocked-core-readers', fileReaders.map(tool => ({ ...tool, availability: 'blocked',
    availabilityReason: { code: 'fixture_blocked', message: 'Not callable.' } })), false],
  ['same-named-extensions', fileReaders.map(tool => ({ ...tool, origin: 'extension', pluginUri: extension })), false],
]) test(`file Skill entries respect the callable reader in explicit selection and activation: ${scenario}`, async t => {
  const sessionId = `session:skill-entry-${scenario}`;
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const first = 'plugin://outline@skill', next = 'plugin://review@skill';
  const root = scenario === 'powershell-only' ? 'C:/synthetic' : '/synthetic';
  const paths = new Map([[first, `${root}/project-notes/SKILL.md`], [next, `${root}/check-notes/SKILL.md`]]);
  const portableTools = tools.filter(tool => tool.name === 'plugin.search' || tool.name === 'skill.read');
  const preparation = fakeRunPreparation({ tools: [...portableTools, ...readers], contextWindowTokens: 32_000 });
  const runPreparation = { ...preparation.port, async prepare(input) {
    const prepared = await preparation.port.prepare(input);
    const { runtimeSnapshot: runtime } = prepared;
    const selected = runtime.selectedPlugins.plugins;
    runtime.kernelCatalogSnapshotRef = selected.some(p => p.uri === next) ? 'catalog:activated' : 'catalog:initial';
    if (scenario === 'powershell-only') Object.assign(runtime.environment, { os: 'windows',
      shell: { tool: 'powershell', executable: 'pwsh.exe', dialect: 'powershell' } });
    for (const plugin of selected) if (paths.has(plugin.uri)) plugin.skillEntryPath = paths.get(plugin.uri);
    return prepared;
  } };
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:select-next', name: 'plugin_activate', input: { pluginUris: [next] } });
    else { assert.equal(requests.length, 2); yield providerEvent(request.requestId, 'text.delta', { text: 'Finished without reading files.' }); }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = new SessionActor(sessionId, journal, { runPreparation, provider, kernel: emptyKernel(), async dispose() {} }, { nextId: idFactory(scenario) });
  t.after(() => actor.dispose());
  const selections = [first, ...(readers.some(tool => tool.origin === 'extension') ? [extension] : [])]
    .map((uri, index) => ({ uri, selectionId: `selection:${index}`, label: `Selection ${index}` }));
  await actor.submit({ ...messageCommand(sessionId, 'command:select', 'Use the selected guidance.'), pluginSelections: selections });
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(requests.length, 2);
  const [initial, activated] = requests, user = initial.messages.findLast(message => message.role === 'user');
  for (const reader of fileReaders) {
    const declared = initial.tools.some(tool => tool.name === reader.name.replace('.', '_'));
    assert.equal(declared, readers.some(tool => tool.name === reader.name && tool.availability === 'callable'));
  }
  assert.equal(user.content.includes(paths.get(first)), disclose);
  assert.ok(!user.content.includes(paths.get(next)), 'the second Skill was not selected in the initial request');
  const reply = activated.messages.findLast(message => message.role === 'tool');
  assert.equal(reply.providerCallId, 'native:select-next');
  assert.deepEqual(JSON.parse(reply.content), { activated: [next], tools: [], ...(disclose ? { skillEntries: [{ uri: next, path: paths.get(next) }] } : {}) });
  assert.deepEqual(activated.tools, initial.tools, 'text guidance does not publish a reader or rewrite declarations');
  assert.deepEqual(activated.messages.slice(0, initial.messages.length), initial.messages);
  for (const request of requests) {
    const prefix = JSON.stringify({ tools: request.tools, system: request.messages.filter(m => m.role === 'system') });
    for (const path of paths.values()) {
      assert.ok(!prefix.includes(path));
      if (!disclose) assert.ok(!JSON.stringify(request.messages).includes(path));
    }
  }
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'session.plugins.activated').length, 1);
  assert.ok(!events.some(event => event.type === 'tool.completed' || event.type === 'approval.requested'));
});
