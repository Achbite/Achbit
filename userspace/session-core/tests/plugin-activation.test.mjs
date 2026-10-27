import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeRunPluginConfig } from '../dist/local-agent/skillPlugins.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { sessionControlToolDefinitions } from '../dist/index.js';
import {
  actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, waitUntil, workspaceBinding,
} from './local-agent-fixtures.mjs';

const discoveryTool = { toolBindingRef: 'binding:plugin-search', name: 'plugin.search', description: 'Discover plugins.',
  inputSchema: { type: 'object', properties: {} }, possibleEffects: ['localRead'], availability: 'callable', origin: 'coreBuiltin' };

test('the actual builtin Computer Use instructions satisfy the Session plugin configuration contract', async () => {
  const capabilitySummary = await readFile(new URL('../../../plugins/computer-use/README.md', import.meta.url), 'utf8');
  const plugin = { uri: 'plugin://computer-use@builtin', displayName: 'Computer Use', capabilitySummary };
  const decoded = decodeRunPluginConfig({ extensionGenerationRef: 'generation:computer-use', permissions: {}, selectedPlugins: [plugin] });
  assert.deepEqual(decoded.selectedPlugins, [plugin]);
});

test('Agent plugin activation and explicit user mentions coexist across request boundaries', async t => {
  for (const surface of ['aggregate', 'responses']) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:plugins-${surface}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const browserUri = 'plugin://browser@local';
    const mentioned = { selectionId: 'selection:notes', uri: 'plugin://notes@local', label: 'Notes' };
    const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
    const port = { ...preparation.port, async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = `catalog:plugins:${preparation.prepared.length}`;
      if (request.pluginSelections?.some(selection => selection.uri === browserUri)) {
        runtime.tools.push({ toolBindingRef: `binding:${runtime.kernelCatalogSnapshotRef}`, name: 'browser.observe',
          description: 'Observe the internal browser.', inputSchema: { type: 'object', properties: {} },
          possibleEffects: ['localRead'], availability: 'callable', origin: 'extension', pluginUri: browserUri });
      }
      runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
        ...sessionControlToolDefinitions().map(tool => tool.name)]);
      return prepared;
    } };
    let turns = 0, executing = false, finishTool;
    const gate = new Promise(resolve => { finishTool = resolve; });
    const provider = { async *stream(request) {
      assert.ok(++turns <= 3);
      const emit = (name, input) => surface === 'responses'
        ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
          type: 'function_call', call_id: `native:${turns}`, name, arguments: JSON.stringify(input), status: 'completed' } })
        : providerEvent(request.requestId, 'tool.call', { callId: `native:${turns}`, name, input });
      if (turns === 1) {
        assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
        yield emit('plugin_activate', { pluginUris: [browserUri] });
      } else if (turns === 2) {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(browserUri)));
        yield emit('browser_observe', {});
      } else {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        yield providerEvent(request.requestId, 'text.delta', { text: 'Preview inspected.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = actorWith(journal, sessionId, provider, emptyKernel({ async execute(request) {
      assert.equal(request.toolName, 'browser.observe');
      executing = true; await gate;
      const reply = completedExecutionReply(request, { content: 'Visible preview.' });
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = `instance:${browserUri}`;
      return reply;
    } }), port, `plugin-${surface}`);
    t.after(async () => { finishTool(); await actor.dispose(); });
    await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the preview using my notes.'),
      pluginSelections: [mentioned], pluginCatalogRevision: 'catalog:notes' });
    await waitUntil(() => executing, 'activated browser executing');
    await actor.submit(messageCommand(sessionId, 'command:guidance', 'Check the button too.'));
    finishTool();
    const done = await waitForProjection(actor, state => state.run?.status === 'completed');
    const events = await readEvents(journal, sessionId);
    const userMessages = events.filter(event => event.type === 'message.committed' && event.payload.role === 'user');
    assert.deepEqual(userMessages[0].payload.pluginSelections, [mentioned]);
    assert.equal(userMessages[1].payload.pluginSelections, undefined);
    assert.deepEqual(events.find(event => event.type === 'session.plugins.activated').payload.pluginUris, [browserUri]);
    assert.deepEqual(new Set(preparation.prepared.at(-1).pluginSelections.map(selection => selection.uri)),
      new Set([mentioned.uri, browserUri]));
    assert.equal(done.messages.at(-1).content, 'Preview inspected.');
    assert.equal(done.activities.some(activity => activity.label === 'plugin.activate'), false,
      'Session activation must not invent a completed Kernel tool record');
    assert.equal(preparation.released.length, 1);
  }
});

test('desktop activation and explicit selection carry execution availability without a GUI or shell probe', async t => {
  for (const explicit of [false, true]) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:desktop-${explicit}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const uri = 'plugin://computer-use@builtin';
    const desktop = { toolBindingRef: 'binding:desktop', name: 'computer.control', description: 'Native desktop control.',
      inputSchema: { type: 'object', properties: {} }, possibleEffects: ['external'], availability: 'callable',
      origin: 'extension', pluginUri: uri, runtimeStatus: { platform: 'macos', accessibility: true } };
    const browser = { ...desktop, toolBindingRef: 'binding:browser', name: 'browser.observe', availability: 'blocked',
      availabilityReason: { code: 'gui_browser_unavailable', message: 'This run has no GUI window for embedded browser tools.' } };
    delete browser.runtimeStatus;
    const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
    const port = { ...preparation.port, async prepare(request) {
      assert.equal(request.hostBinding, undefined);
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = `catalog:desktop:${preparation.prepared.length}`;
      if (request.pluginSelections?.some(selection => selection.uri === uri)) runtime.tools.push(desktop, browser);
      runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
        ...sessionControlToolDefinitions().map(tool => tool.name)]);
      return prepared;
    } };
    let turns = 0, executions = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      turns += 1;
      assert.ok(turns <= (explicit ? 2 : 3));
      if (!explicit && turns === 1) {
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:activate', name: 'plugin_activate', input: { pluginUris: [uri] } });
      } else {
        assert.ok(request.tools.some(tool => tool.name === 'computer_control'));
        assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
        const capabilities = request.messages.find(message => message.role === 'system' && message.content.includes('Execution-layer tool status'));
        assert.equal(capabilities, undefined);
        assert.doesNotMatch(JSON.stringify(request.messages), /gui_browser_unavailable|accessibility|runtimeStatus/u);
        if (!explicit) {
          const result = request.messages.filter(message => message.role === 'tool')
            .map(message => JSON.parse(message.content)).find(result => result.activated);
          assert.deepEqual(result.activated, [uri]);
          assert.deepEqual(result.tools, [{ name: desktop.name }]);
        }
        if (!executions) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:desktop', name: 'computer_control', input: { action: 'status' } });
        else yield providerEvent(request.requestId, 'text.delta', { text: 'Native desktop inspection complete.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } }, emptyKernel({ async execute(request) {
      assert.equal(request.toolName, 'computer.control');
      executions += 1;
      const reply = completedExecutionReply(request, { status: 'ready' });
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = 'instance:desktop';
      return reply;
    } }), port, `desktop-${explicit}`);
    t.after(() => actor.dispose());
    await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the native desktop status.'),
      ...(explicit ? { pluginSelections: [{ selectionId: 'selection:desktop', uri, label: 'Computer Use' }], pluginCatalogRevision: 'catalog:desktop' } : {}) });
    await waitForProjection(actor, state => state.run?.status === 'completed');
    assert.equal(executions, 1);
    assert.equal(preparation.released.length, 1);
    const canonical = (await readEvents(journal, sessionId)).flatMap(event => event.type === 'run.started'
      ? event.payload.runtimeSnapshot.tools : event.type === 'run.tools.prepared' ? event.payload.toolView.tools : []);
    assert.ok(canonical.some(tool => tool.availabilityReason?.code === 'gui_browser_unavailable'));
    assert.ok(canonical.some(tool => tool.runtimeStatus?.accessibility === true));
    if (!explicit) {
      const events = await readEvents(journal, sessionId);
      const activated = events.find(event => event.type === 'session.plugins.activated');
      assert.equal(activated.payload.kernelCatalogSnapshotRef,
        events.find(event => event.type === 'run.tools.prepared').payload.toolView.kernelCatalogSnapshotRef);
    }
  }
});

test('plugin preparation failure is returned without changing the callable tool view', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plugin-disabled';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
  const port = { ...preparation.port, async prepare(request) {
    if (request.pluginSelections?.length) throw new Error('plugin_selection_disabled: Plugin is disabled.');
    return preparation.port.prepare(request);
  } };
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:disabled', name: 'plugin_activate', input: { pluginUris: ['plugin://disabled@local'] },
    });
    else {
      assert.equal(turns, 2);
      assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('plugin_selection_disabled')));
      assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
      yield providerEvent(request.requestId, 'text.delta', { text: 'The selected plugin is disabled.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), port, 'plugin-disabled');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Use the plugin.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some(event => event.type === 'session.plugins.activated' || event.type === 'run.tools.prepared'), false);
});
