import assert from 'node:assert/strict';
import test from 'node:test';
import { admitSessionEvents } from '../dist/local-agent/admission.js';
import { loopSnapshot } from '../dist/local-agent/loop.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation,
  messageCommand, providerEvent, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

test('Responses hosted search is not a local function declaration: activation, read and hosted result survive the mistyped call', async t => {
  const sessionId = 'session:activation-hosted', uri = 'plugin://reader@local';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const search = { name: 'plugin.search', toolBindingRef: 'binding:search', description: 'Discover plugins.', origin: 'coreBuiltin',
    availability: 'callable', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {} } };
  const read = { ...search, name: 'fs.read', toolBindingRef: 'binding:read', description: 'Read a file.', possibleEffects: ['workspaceRead'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const preparation = fakeRunPreparation({ tools: [search, read], apiSurface: 'responses', contextWindowTokens: 32_000,
    hostedWebSearch: 'web_search', webSearch: { owner: 'providerHosted', providerToolType: 'web_search' } });
  const call = (call_id, name, input) => ({ type: 'function_call', call_id, name, status: 'completed', arguments: JSON.stringify(input) });
  const hosted = { type: 'web_search_call', id: 'hosted:result', status: 'completed', action: { type: 'search', query: 'reader' } };
  const items = [call('native:activate', 'plugin_activate', { pluginUris: [uri] }), hosted,
    call('native:wrong', 'web_search', { query: 'reader' }), call('native:read', 'fs_read', { path: 'note.txt' })];
  const requests = [], executions = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      for (const [outputIndex, item] of items.entries()) yield providerEvent(request.requestId, 'output.item.completed', { outputIndex, item });
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions.push([request.toolName, request.input.path]);
    return completedExecutionReply(request, { content: 'Read note.txt.' });
  } }), preparation.port, 'activation-hosted');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:hosted-batch', 'Activate the reader and inspect the note.'));
  const final = await waitForProjection(actor, s => ['completed', 'failed', 'indeterminate', 'cancelled'].includes(s.run?.status));
  assert.deepEqual(requests[0].hostedTools, [{ type: 'webSearch', providerToolType: 'web_search' }]);
  assert.ok(!requests[0].tools.some(tool => tool.name === 'web_search'));
  assert.equal(final.run.status, 'completed', JSON.stringify({ error: final.terminalError, executions, activations: preparation.prepared.filter(r => r.modelActivation).length }));
  assert.deepEqual(executions, [['fs.read', 'note.txt']]);
  assert.deepEqual(preparation.prepared.filter(r => r.modelActivation).map(r => r.pluginSelections.map(p => p.uri)), [[uri]]);
  assert.equal(requests.length, 2);

  const events = await readEvents(journal, sessionId);
  const turn = events.find(e => e.type === 'provider.turn.settled' && e.payload.providerRequestId === requests[0].requestId);
  const blocks = turn.payload.orderedOutputBlocks;
  assert.deepEqual(blocks.map(b => b.kind), ['toolCall', 'providerHosted', 'toolCallRejected', 'toolCall']);
  assert.deepEqual(blocks.map(b => b.item), items);
  assert.deepEqual(requests[1].messages.find(m => m.providerOutputBlocks).providerOutputBlocks, blocks);
  const result = requests[1].messages.filter(m => m.role === 'tool');
  assert.deepEqual(result.map(m => [m.providerCallId, m.toolOutcome]), [['native:activate', 'completed'], ['native:wrong', 'inputRejected'], ['native:read', 'completed']]);
  assert.deepEqual(JSON.parse(result[0].content).activated, [uri]);
  const rejection = JSON.parse(result[1].content);
  assert.equal(rejection.executed, false);
  assert.equal(rejection.error.code, 'provider_tool_alias_unknown');
  assert.equal(result[2].content, 'Read note.txt.');
  const activity = final.activities.find(a => a.providerHosted?.providerCallId === hosted.id);
  assert.equal(activity.status, 'completed');
  assert.deepEqual(activity.providerHosted.action, hosted.action);

  // Re-admit the actual registration transaction, changing only the supposedly unknown function.
  const first = events.findIndex(e => e.type === 'session.plugins.requested');
  const before = loopSnapshot(sessionId, events.slice(0, first));
  const batch = events.slice(first, events.indexOf(turn) + 1).map(({ eventId, occurredAt, sequence, schemaVersion, ...fact }) => structuredClone(fact));
  assert.doesNotThrow(() => admitSessionEvents(before, batch));
  const forged = batch.at(-1).payload.orderedOutputBlocks.find(b => b.kind === 'toolCallRejected');
  forged.toolName = forged.item.name = 'fs_read';
  assert.throws(() => admitSessionEvents(before, batch), /plugin_activation_batch_invalid/);
});
