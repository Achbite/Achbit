// TCR: T-031-UI_System-20261126/message-send-implementation/TCR.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, providerEvent, waitForProjection, waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';
import { installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';

const profile = { id: 'profile:echo', enabled: true, thinking: 'disabled' };
const ok = data => Response.json({ ok: true, data });
const fresh = id => ({ ...projectSession(emptySessionState(id)), revision: 1 });

test('first send echoes the exact draft before Session creation; rejection removes only its local display', async t => {
  const store = await loadGuiModelStore(t);
  const id = 'session:new-echo', blank = fresh(id);
  const created = Promise.withResolvers(), command = Promise.withResolvers(), receipt = Promise.withResolvers();
  store.setState({ runtimeReady: true, profiles: [profile], selectedProfileId: profile.id });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/sessions')) { await created.promise; return ok(blank); }
    if (url.pathname.endsWith('/commands')) {
      const c = JSON.parse(init.body); command.resolve(c); await receipt.promise;
      return ok({ schemaVersion: 'achbit.command-reply.v3', sessionId: id, commandId: c.commandId,
        revision: 1, status: 'rejected', error: { code: 'input_refused', message: 'Original reason' } });
    }
    if (url.pathname.endsWith('/catalog')) return ok({ projects: [], sessions: [] });
    if (url.pathname.endsWith('/projection')) return ok(blank);
    throw Error('unexpected route '+url.pathname);
  });
  const text = '  同一句\n' + '很长的原文'.repeat(100) + '\n';
  const result = store.getState().sendMessage(text, [], [], [], undefined, [], undefined, { submissionId: 'submission:first' });
  const rejected = assert.rejects(result, /input_refused:Original reason/);
  try {
    const local = store.getState().localInputs;
    assert.equal(local?.length, 1, 'local input visible synchronously while create is held');
    assert.equal(local[0].text, text); assert.equal(local[0].sessionId, null);
    assert.equal(store.getState().projection, null, 'no synthetic Session');
    created.resolve(); const c = await command.promise;
    assert.equal(c.commandId, local[0].commandId); assert.equal(store.getState().localInputs[0].sessionId, id);
    assert.deepEqual(store.getState().projection.messages, []);
  } finally { created.resolve(); receipt.resolve(); await rejected; }
  assert.deepEqual(store.getState().localInputs, []);
  assert.deepEqual(store.getState().errorSource, { kind: 'input', submissionId: 'submission:first' });
});

test('a newer observed running Session is not an idle echo even while its full projection is behind', async t => {
  const store = await loadGuiModelStore(t), id = 'session:stale', view = fresh(id);
  const run = { runId: 'run:live', status: 'running', profileId: profile.id, workspaceBindings: [] };
  store.setState({ sessionId: id, projection: view, profiles: [profile], selectedProfileId: profile.id,
    sessionStatuses: { [id]: { sessionId: id, revision: 2, run } } });
  const posted = Promise.withResolvers(), release = Promise.withResolvers();
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) { const c = JSON.parse(init.body); posted.resolve(); await release.promise;
      return ok({ schemaVersion: 'achbit.command-reply.v3', status:'accepted', sessionId: id, commandId: c.commandId, revision: 2 }); }
    if (url.pathname.endsWith('/projection')) return ok({ ...view, revision:2, run });
    throw Error('unexpected route '+url.pathname);
  });
  const sent = store.getState().sendMessage('补充', [], [], [], undefined, [], undefined, { submissionId:'submission:later' });
  try { assert.deepEqual(store.getState().localInputs, []); await posted.promise; assert.deepEqual(store.getState().localInputs, []); }
  finally { release.resolve(); await sent; await new Promise(setImmediate); }
});

test('actual Session gives equal messages distinct command identities; a failed display read does not fail or duplicate the send', async t => {
  const id = 'session:repeat', journal = new InMemoryCommandJournal();
  await createSession(journal, id);
  const requests = [];
  const actor = actorWith(journal, id, { async *stream(request) {
    requests.push(request);
    yield providerEvent(request.requestId, 'text.delta', { text: 'OK' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'echo');
  t.after(() => actor.dispose());
  const store = await loadGuiModelStore(t), commands = [];
  store.setState({ sessionId: id, projection: await actor.snapshot(), profiles: [profile], selectedProfileId: profile.id });
  let failRead = true;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) { const c = JSON.parse(init.body); commands.push(c); return ok(await actor.submit(c)); }
    if (url.pathname.endsWith('/projection')) { if (failRead) throw Error('display interrupted'); return ok(await actor.snapshot()); }
    if (url.pathname.endsWith('/statuses')) { const p = await actor.snapshot(); return ok([{ sessionId: id, revision: p.revision, run: p.run }]); }
    throw Error('unexpected route '+url.pathname);
  });
  const send = n => store.getState().sendMessage('相同正文', [], [], [], undefined, [], undefined, { submissionId: 'submission:'+n });
  const first = send(1), local = store.getState().localInputs[0];
  assert.equal((await first).status, 'accepted');
  await waitUntil(() => store.getState().errorSource === 'projection', 'explicit read failure');
  assert.match(store.getState().error, /display interrupted/);
  assert.equal(store.getState().localInputs[0].commandId, local.commandId);
  await waitForProjection(actor, p => p.run?.status === 'completed');
  failRead = false; await store.getState().refresh();
  assert.deepEqual(store.getState().localInputs, []);
  assert.equal((await send(2)).status, 'accepted');
  await waitForProjection(actor, p => p.run?.status === 'completed' && p.messages.filter(m => m.role === 'assistant').length === 2);
  await store.getState().refresh();
  const users = store.getState().projection.messages.filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => m.commandId), commands.map(c => c.commandId));
  assert.equal(new Set(users.map(m => m.messageId)).size, 2);
  assert.equal(new Set(users.map(m => m.commandId)).size, 2);
  assert.deepEqual(users.map(m => m.content), ['相同正文', '相同正文']);
  assert.equal(requests.length, 2); assert.deepEqual(store.getState().localInputs, []);
});
