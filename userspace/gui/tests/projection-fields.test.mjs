import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService, emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { reduceAgentLifetime } from '../../session-core/dist/local-agent/agentLifecycle.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { emptyKernel, fakeRunPreparation, messageCommand, providerEvent, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';
import { decodeGuiProjection, installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';

test('a worker projection preserves the optional named helper and still rejects invalid task fields', async () => {
  const project = (helperId) => {
    const state = emptySessionState('session:worker');
    const event = { type: 'agent.task.created', sessionId: state.sessionId, runId: 'run:worker', callId: 'call:reader', sequence: 1,
      payload: { taskId: 'task:reader', agentSessionId: 'session:reader', capabilities: { messaging: 'parent', continuation: true, delegation: false },
        createsAgent: true, displayName: 'Reader', text: 'Read the note.', delivery: 'async', ...(helperId === undefined ? {} : { helperId }) } };
    Object.assign(state, reduceAgentLifetime(state, event));
    return projectSession(state);
  };
  for (const id of [undefined, 'reader', 'A:._-' + '9'.repeat(59)]) {
    const snapshot = project(id);
    assert.equal(snapshot.agentTasks[0].helperId, id);
    assert.deepEqual(await decodeGuiProjection(snapshot), snapshot);
  }
  const snapshot = project('reader');
  for (const fields of [{ helperId: '' }, { helperId: '.reader' }, { helperId: 'read er' }, { helperId: '9'.repeat(65) },
    { helperId: null }, { helperId: 1 }, { undeclared: 'reader' }]) {
    await assert.rejects(decodeGuiProjection({ ...snapshot, agentTasks: [{ ...snapshot.agentTasks[0], ...fields }] }), /conversation_projection_invalid/);
  }
});

async function sessionFixture(t) {
  let requests = 0;
  const service = new SessionService(new InMemoryCommandJournal(), { async create() {
    return { composition: {
      provider: { async *stream(request) {
        requests++;
        yield providerEvent(request.requestId, 'text.delta', { text: `Reply ${requests}.` });
        yield providerEvent(request.requestId, 'completed', { usage: {
          inputTokens: 20, outputTokens: 6, contextWindowTokens: 32000,
          ...(requests === 1 ? { reasoningOutputTokens: 0 } : requests === 2 ? { reasoningOutputTokens: 4 } : {}),
        } });
      } },
      kernel: emptyKernel(), runPreparation: fakeRunPreparation({ contextWindowTokens: 32000 }).port, async dispose() {},
    } };
  } });
  t.after(() => service.dispose(true));
  const sessionId = 'session:gui-projection-fields';
  const snapshot = () => service.snapshot(sessionId);
  const settle = () => waitForProjection({ snapshot }, value => value.run?.status === 'completed');
  return { service, sessionId, snapshot, settle, requests: () => requests };
}

test('GUI creates, sends, reopens history and continues with independently captured Session and Run modes', async t => {
  const { service, sessionId, snapshot, settle, requests } = await sessionFixture(t);
  const catalog = { projects: [], sessions: [] };
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/sessions')) {
      await service.createSession({ sessionId, displayTitle: 'Projection regression', workspaceBindings: [] });
      catalog.sessions.push({ id: sessionId, title: 'Projection regression', createdAt: '1', updatedAt: '1',
        profileId: 'profile:test', workspaceBindings: [] });
      return Response.json({ ok: true, data: await snapshot() });
    }
    if (url.pathname.endsWith('/commands')) return Response.json({ ok: true, data: await service.submit(JSON.parse(init.body)) });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: catalog });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:projection-fields', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }], catalog });
  await store.getState().sendMessage('Remember the first message.');
  const first = await settle();
  assert.equal(first.mode, 'full');
  assert.equal(first.run.mode, 'full');
  assert.equal(requests(), 1);
  await store.getState().setMode('minimal');
  assert.equal(store.getState().projection.mode, 'minimal');
  assert.equal(store.getState().projection.run.mode, 'full');
  store.setState({ sessionId: null, projection: null });
  await store.getState().activateSession(sessionId);
  assert.equal(store.getState().error, null);
  assert.deepEqual(store.getState().projection.messages, first.messages);
  assert.equal(store.getState().projection.mode, 'minimal');
  assert.equal(store.getState().projection.run.mode, 'full');
  assert.equal(requests(), 1, 'opening history and saving a mode do not start inference');
  await store.getState().sendMessage('Continue the conversation.');
  const continued = await settle();
  assert.equal(continued.run.mode, 'minimal');
  assert.equal(requests(), 2);
  await store.getState().setMode('full');
  const decoded = store.getState().projection;
  assert.equal(decoded.mode, 'full');
  assert.equal(decoded.run.mode, 'minimal');
  assert.equal(store.getState().error, null);
  assert.deepEqual(decoded.messages.filter(message => message.role === 'user').map(message => message.content),
    ['Remember the first message.', 'Continue the conversation.']);
});

test('GUI validates optional mode values without changing either Session or Run facts', async t => {
  const { service, sessionId, settle } = await sessionFixture(t);
  await service.createSession({ sessionId, displayTitle: 'Modes', workspaceBindings: [] });
  await service.submit(messageCommand(sessionId, 'command:mode-projection', 'Start.'));
  const projection = await settle();
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const omitted = structuredClone(projection);
  delete omitted.mode;
  delete omitted.run.mode;
  assert.deepEqual(await decodeGuiProjection(omitted), omitted);
  for (const mode of ['invalid', null, 1, ['full']]) {
    await assert.rejects(decodeGuiProjection({ ...projection, mode }), /conversation_projection_invalid/);
    await assert.rejects(decodeGuiProjection({ ...projection, run: { ...projection.run, mode } }), /conversation_projection_invalid/);
  }
});

test('GUI retains reported reasoning subsets, zero and partial coverage and rejects inconsistent usage', async t => {
  const { service, sessionId, settle } = await sessionFixture(t);
  await service.createSession({ sessionId, displayTitle: 'Reasoning usage', workspaceBindings: [] });
  let projection;
  for (let index = 0; index < 3; index++) {
    await service.submit(messageCommand(sessionId, `command:usage:${index}`, `Message ${index}.`));
    projection = await settle();
    const decoded = await decodeGuiProjection(projection);
    assert.deepEqual(decoded, projection);
    assert.deepEqual(decoded.tokenUsage.reasoningUsage, {
      outputTokens: index === 0 ? 0 : 4, reportedCallCount: index === 0 ? 1 : 2, complete: index < 2,
    });
    assert.equal(decoded.tokenUsage.outputTokens, 6 * (index + 1), 'reasoning is already included in output');
    assert.equal(decoded.contextUsage.reasoningOutputTokens, index === 0 ? 0 : index === 1 ? 4 : undefined);
  }
  for (const field of ['tokenUsage', 'totalTokenUsage', 'tokenUsageHistory']) {
    const source = field === 'tokenUsageHistory' ? projection[field].find(round => round.reasoningUsage) : projection[field];
    for (const patch of [{ outputTokens: 1000 }, { outputTokens: -1 }, { reportedCallCount: 0 },
      { reportedCallCount: 1000 }, { complete: !source.reasoningUsage.complete }, { complete: 'false' }, { unknown: 1 }]) {
      const invalid = structuredClone(projection);
      const usage = field === 'tokenUsageHistory' ? invalid[field].find(round => round.reasoningUsage) : invalid[field];
      usage.reasoningUsage = { ...usage.reasoningUsage, ...patch };
      await assert.rejects(decodeGuiProjection(invalid), /conversation_projection_invalid/);
    }
  }
  for (const reasoningOutputTokens of [-1, 7, '4', null]) {
    await assert.rejects(decodeGuiProjection({ ...projection,
      contextUsage: { ...projection.contextUsage, reasoningOutputTokens } }), /conversation_projection_invalid/);
  }
});
