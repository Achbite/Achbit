import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { readConversation } from '../dist/local-agent/conversationRead.js';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation,
  messageCommand, providerEvent, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

// Replay actual Actor-produced transaction boundaries, not a second implementation of its scheduler.
test('restart reconciles each activation boundary without repeating the ordinary effect or plugin preparation', async t => {
  const sessionId = 'session:activation-recovery', uri = 'plugin://inspector@local';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const search = { name: 'plugin.search', toolBindingRef: 'binding:search', origin: 'coreBuiltin', availability: 'callable',
    possibleEffects: ['localRead'], description: 'Search plugins', inputSchema: { type: 'object', properties: {} } };
  const prep = fakeRunPreparation({ tools: [search], contextWindowTokens: 20000 });
  const port = { ...prep.port, async prepare(input) {
    const result = await prep.port.prepare(input);
    if (result.runtimeSnapshot.selectedPlugins.plugins.length) result.runtimeSnapshot.kernelCatalogSnapshotRef = 'catalog:with-inspector';
    return result;
  } };
  let turns = 0, effects = 0;
  const actor = actorWith(journal, sessionId, { async *stream(r) {
    if (++turns === 1) {
      yield providerEvent(r.requestId, 'tool.call', { callId: 'native:activate', name: 'plugin_activate', input: { pluginUris: [uri] } });
      yield providerEvent(r.requestId, 'tool.call', { callId: 'native:ordinary', name: 'plugin_search', input: {} });
    } else yield providerEvent(r.requestId, 'text.delta', { text: 'Done.' });
    yield providerEvent(r.requestId, 'completed', {});
  } }, emptyKernel({ async execute(r) { effects++; return completedExecutionReply(r, { plugins: [] }); } }), port, 'seed');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:seed', 'Run this batch.'));
  await waitForProjection(actor, p => p.run?.status === 'completed');
  assert.equal(effects, 1);
  const source = await readEvents(journal, sessionId);
  const issued = source.find(e => e.type === 'session.plugins.requested');
  const marker = (type, matches = () => true) => {
    const index = source.findIndex(e => e.type === type && matches(e));
    assert.ok(index > 0, `missing durable boundary: ${type}`); return index;
  };
  const reply = marker('provider.turn.settled', e => e.payload.providerRequestId === issued.payload.providerRequestId);
  const done = marker('tool.completed'), preparing = marker('session.plugins.preparing');
  const published = marker('run.tools.prepared', e => e.payload.toolView.kernelCatalogSnapshotRef === 'catalog:with-inspector');
  for (const [label, end, known, outcome, result] of [
    ['after reply, no Kernel receipt', reply, false, 'indeterminate', 'notExecuted'],
    ['after ordinary effect, Kernel receipt available', reply, true, 'completed', 'notExecuted'],
    ['after ordinary completion', done, false, 'completed', 'notExecuted'],
    ['inside preparation, no publication', preparing, false, 'indeterminate', 'indeterminate'],
    ['after atomic publication', published, false, 'completed', 'completed'],
  ]) await t.test(label, async t => {
    const reopened = new InMemoryCommandJournal();
    await reopened.createSession({ sessionId, ...source[0].payload });
    await reopened.appendBatch(source.slice(1, end + 1));
    const requests = [], preparations = [], restores = [];
    const restored = actorWith(reopened, sessionId, { async *stream(r) {
      requests.push(r); yield providerEvent(r.requestId, 'text.delta', { text: 'Recovered.' });
      yield providerEvent(r.requestId, 'completed', {});
    } }, emptyKernel({ async execute() { assert.fail('repeated ordinary call'); }, async readRecord(id) {
      return known && id === source[done].callId ? source[done].payload.record : null;
    } }), { ...port, async prepare(input) {
      if (input.restoreEnvironment) restores.push(input);
      if (input.modelActivation) preparations.push(input);
      return port.prepare(input);
    } }, 'restored');
    t.after(() => restored.dispose());
    await restored.recover();
    const final = await waitForProjection(restored, p => ['completed', 'failed', 'indeterminate'].includes(p.run?.status));
    assert.equal(final.run.status, outcome, JSON.stringify(final.terminalError));
    assert.equal(preparations.length, 0);
    if (end === preparing) assert.deepEqual(restores, [], 'unknown activation only needs reconciliation and cleanup');
    const events = await readEvents(reopened, sessionId);
    const terminal = events.filter(e => e.type === 'session.plugins.activated' || e.type === 'session.plugins.failed');
    assert.deepEqual(terminal.map(e => [e.callId, e.payload.outcome ?? 'completed']), [[issued.callId, result]]);
    assert.equal(events.filter(e => e.type === 'provider.turn.settled' && e.payload.providerRequestId === issued.payload.providerRequestId).length, 1);
    assert.equal(events.filter(e => e.type === 'run.runtime.released').length, 1);
    assert.equal(events.filter(e => e.type === 'tool.completed').length, end === reply && !known ? 0 : 1);
    assert.equal(requests.length, outcome === 'completed' ? 1 : 0);
    if (requests.length) assert.deepEqual(requests[0].messages.filter(m => m.role === 'tool').map(m => [m.providerCallId, m.toolOutcome]),
      [['native:activate', result], ['native:ordinary', 'completed']]);
    if (result !== 'completed') {
      const item = (await readConversation(reopened, { sessionId, view: 'tools' })).items.find(item => item.callId === issued.callId);
      assert.equal(item.providerCallId, 'native:activate'); assert.equal(item.outcome, result);
      assert.equal(item.executed, result === 'notExecuted' ? false : undefined);
    }
  });
});
