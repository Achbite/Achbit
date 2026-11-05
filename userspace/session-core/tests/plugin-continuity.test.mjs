import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { sessionControlToolDefinitions } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand,
  providerEvent, readEvents, waitForProjection, workspaceBinding,
} from './local-agent-fixtures.mjs';

test('activated plugins survive completed Loops and journal reload, merge explicit selection, and withdraw when disabled', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plugin-continuity';
  await createSession(journal, sessionId, [workspaceBinding]);
  const browser = 'plugin://browser@local', notes = 'plugin://notes@local';
  const enabled = new Set([browser, notes]);
  const discovery = { toolBindingRef: 'binding:discovery', name: 'plugin.search', description: 'Discover plugins.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {} } };
  const preparation = fakeRunPreparation({ tools: [discovery], contextWindowTokens: 100000 });
  const port = { ...preparation.port, async prepare(request) {
    const prepared = await preparation.port.prepare({ ...request,
      inheritedPluginSelections: request.inheritedPluginSelections?.filter(selection => enabled.has(selection.uri)),
    });
    const runtime = prepared.runtimeSnapshot;
    runtime.kernelCatalogSnapshotRef = `catalog:${request.runId}:${runtime.selectedPlugins.plugins.length}`;
    for (const plugin of runtime.selectedPlugins.plugins) {
      const name = plugin.uri === browser ? 'browser.observe' : 'notes.read';
      runtime.tools.push({ ...discovery, toolBindingRef: `${runtime.kernelCatalogSnapshotRef}:${name}`,
        name, description: name, origin: 'extension', pluginUri: plugin.uri });
    }
    runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
      ...sessionControlToolDefinitions().map(tool => tool.name)], request.previousProviderToolAliases);
    return prepared;
  } };
  const requests = [];
  const provider = { async *stream(request) {
    const step = requests.length;
    assert.ok(step < 5);
    if (step > 0) {
      assert.deepEqual(request.messages.slice(0, requests.at(-1).messages.length), requests.at(-1).messages);
      assert.equal(request.tools.some(tool => tool.name === 'browser_observe'), step < 4);
      assert.equal(request.tools.some(tool => tool.name === 'notes_read'), step >= 3);
    }
    if (step === 2) assert.deepEqual(request.tools, requests[1].tools, 'the next Loop keeps the complete tool declarations');
    requests.push(structuredClone(request));
    if (step === 0) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:activate', name: 'plugin_activate', input: { pluginUris: [browser] },
    });
    else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  let actor = actorWith(journal, sessionId, provider, emptyKernel(), port, 'continuity-first');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:first', 'Activate the browser capability.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(preparation.released.length, 1);
  await actor.dispose();
  actor = actorWith(journal, sessionId, provider, emptyKernel(), port, 'continuity-reloaded');

  await actor.submit(messageCommand(sessionId, 'command:second', 'Continue the same conversation.'));
  await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 3);
  await actor.submit({ ...messageCommand(sessionId, 'command:third', 'Also use notes.'),
    pluginSelections: [{ selectionId: 'selection:notes', uri: notes, label: 'Notes' }] });
  await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 4);
  enabled.delete(browser);
  await actor.submit(messageCommand(sessionId, 'command:fourth', 'Continue after disabling the browser.'));
  await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 5);

  const events = await readEvents(journal, sessionId);
  const starts = events.filter(event => event.type === 'run.started');
  assert.equal(starts.length, 4);
  const selected = starts.map(event => event.payload.runtimeSnapshot.selectedPlugins.plugins.map(plugin => plugin.uri).sort());
  assert.deepEqual(selected, [[], [browser], [browser, notes], [notes]]);
  const secondInput = events.find(event => event.type === 'input.accepted' && event.payload.commandId === 'command:second');
  assert.equal(secondInput.payload.pluginSelections, undefined, 'inherited activation must not be rewritten as an explicit user selection');
  assert.equal(preparation.released.length, 4, 'every Loop still releases its own runtime');
  assert.equal(new Set(preparation.released.map(release => release.runId)).size, 4);
  assert.notEqual(starts[1].payload.runtimeSnapshot.tools.find(tool => tool.name === 'browser.observe').toolBindingRef,
    starts[2].payload.runtimeSnapshot.tools.find(tool => tool.name === 'browser.observe').toolBindingRef);
});
