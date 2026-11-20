import assert from 'node:assert/strict';
import test from 'node:test';
import { installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';
import { createSession, readEvents, runtimeSnapshot, waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { projectSession, recoverSession } from '../../session-core/dist/local-agent/reducer.js';

function events(signal) {
  let controller, closed = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { closed = true; } });
  signal.addEventListener('abort', () => {
    if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); }
  }, { once: true });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(event, data = {}) { controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); },
    close() { closed = true; controller.close(); } };
}
const settled = (sessionId, eventSequence, runId = 'run:one') => ({ sessionId, eventSequence, runId, outcome: 'completed' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one Host subscription delivers a fast external completion without status polling or history replay', async t => {
  let stream, hostSignal, connects = 0;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/conversation/events', 'no status or catalog reads can infer a completion');
    connects++; hostSignal = init.signal; stream = events(init.signal); return stream.response;
  });
  const [{ watchConversationEvents }, { CompletionNotifications }] = await loadGuiModules(t, [
    '/src/services/conversationEvents.ts', '/src/achbit-gui/layout/completionNotifications.ts',
  ]);
  const first = new AbortController(), second = new AbortController();
  t.after(() => { first.abort(); second.abort(); });
  const tracker = new CompletionNotifications(), reminders = [], readerEvents = [];
  const firstWait = watchConversationEvents(first.signal, event => { if (tracker.accept(event)) reminders.push(event.sessionId); });
  await waitUntil(() => stream);
  stream.send('ready'); stream.send('change', { sessionId: 'session:historical' });
  await tick(); assert.deepEqual(reminders, []);
  stream.send('settled', settled('session:external-fast', 20));
  await waitUntil(() => reminders.length === 1);
  const secondWait = watchConversationEvents(second.signal, event => readerEvents.push(event));
  assert.equal(connects, 1, 'completion observer and Reader share one transport');
  assert.deepEqual(readerEvents, [{ type: 'ready' }], 'late observers only get a fresh read boundary');
  stream.send('settled', settled('session:external-fast', 20)); await tick();
  assert.deepEqual(reminders, ['session:external-fast']);
  first.abort(); await firstWait;
  assert.equal(hostSignal.aborted, false, 'one unmount cannot cancel another subscriber');
  second.abort(); await secondWait;
  assert.equal(hostSignal.aborted, true, 'the final unmount releases the physical connection');
});

test('an opened idle nested Reader refreshes on reassignment and coalesces changes during a read', async t => {
  let stream, hostSignal, reads = 0, releaseRead;
  let source = { status: 'completed', runId: 'run:old' }, displayed;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/conversation/events');
    hostSignal = init.signal; stream = events(init.signal); return stream.response;
  });
  const [{ watchConversationChanges }] = await loadGuiModules(t, ['/src/services/conversationEvents.ts']);
  const controller = new AbortController(); t.after(() => controller.abort());
  const waiting = watchConversationChanges('session:nested', controller.signal, async () => {
    reads++; const value = { ...source };
    if (releaseRead === null) await new Promise(resolve => { releaseRead = resolve; });
    if (!controller.signal.aborted) displayed = value;
  });
  await waitUntil(() => stream);
  assert.equal(reads, 0, 'install the observation before the initial read');
  stream.send('ready'); await waitUntil(() => displayed?.status === 'completed');
  await tick(); assert.equal(reads, 1, 'idle produces no periodic reads');
  stream.send('change', { sessionId: 'session:unrelated' }); await tick(); assert.equal(reads, 1);
  source = { status: 'running', runId: 'run:reassigned' };
  releaseRead = null; stream.send('change', { sessionId: 'session:nested' });
  await waitUntil(() => typeof releaseRead === 'function');
  source = { status: 'completed', runId: 'run:reassigned' };
  stream.send('change', { sessionId: 'session:nested' });
  stream.send('change', { sessionId: 'session:nested' }); await tick();
  assert.equal(reads, 2, 'one projection read remains in flight');
  releaseRead(); await waitUntil(() => displayed?.runId === 'run:reassigned' && displayed.status === 'completed');
  assert.equal(reads, 3, 'changes received during a read trigger one fresh canonical read');
  controller.abort(); await waiting;
  assert.equal(hostSignal.aborted, true);
});

test('a child-only change shows and withdraws an approval in the current main store without a parent revision or polling', async t => {
  const root = 'session:owner', middle = 'session:member', leaf = 'session:executor', runId = 'run:owner';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, root);
  await journal.appendBatch([
    { type: 'message.committed', sessionId: root, payload: { messageId: 'm:delegate', role: 'user', content: 'Delegate the task.' } },
    { type: 'run.started', sessionId: root, runId, payload: { inputMessageId: 'm:delegate', workspaceBindings: [], runtimeSnapshot: runtimeSnapshot(runId) } },
    { type: 'agent.task.created', sessionId: root, runId, callId: 'call:spawn', payload: { taskId: 'task:member', agentSessionId: middle,
      displayName: 'Member', text: 'Delegate a check.', delivery: 'wait', createsAgent: true, capabilities: { messaging: true, continuation: true, delegation: true } } },
    { type: 'agent.task.started', sessionId: root, runId, payload: { taskId: 'task:member', childRunId: 'run:member' } },
  ]);
  const baseline = projectSession(recoverSession(root, await readEvents(journal, root)));
  const route = { agentSessionId: leaf, displayName: 'Executor', runId: 'run:executor', interactionIds: [], approval: { approvalId: 'approval:private', callId: 'call:gated' } };
  let stream, projections = 0, pending = false;
  installGuiFetch(t, (url, init) => {
    if (url.pathname === '/api/conversation/events') { stream = events(init.signal); return stream.response; }
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [{ sessionId: root, revision: baseline.revision, run: { runId, status: 'running' } }] });
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(root)}/projection`);
    projections++;
    return Response.json({ ok: true, data: { ...baseline, ...(pending ? { pendingAgentDecisions: [route] } : {}) } });
  });
  const [{ startConversationUpdates }, { createLocalAgentStore }] = await loadGuiModules(t, [
    '/src/components/local-agent/useConversationUpdates.ts', '/src/state/localAgentStore.ts',
  ]);
  const store = createLocalAgentStore(), errors = [];
  store.setState({ sessionId: root });
  const stop = startConversationUpdates(store.getState().refresh, true, error => errors.push(error));
  t.after(stop);
  await waitUntil(() => stream); stream.send('ready');
  await waitUntil(() => store.getState().projection?.revision === baseline.revision);
  pending = true; stream.send('change', { sessionId: leaf });
  await waitUntil(() => store.getState().projection?.pendingAgentDecisions?.length === 1);
  assert.deepEqual(store.getState().projection.pendingAgentDecisions, [route]);
  pending = false; stream.send('change', { sessionId: leaf });
  await waitUntil(() => !store.getState().projection.pendingAgentDecisions?.length);
  assert.equal(store.getState().projection.revision, baseline.revision);
  await tick(); assert.equal(projections, 3); assert.deepEqual(errors, []);
});

test('a failed Host stream surfaces the original error to all views and a new subscription can retry', async t => {
  let stream, connects = 0;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/conversation/events');
    connects++; stream = events(init.signal); return stream.response;
  });
  const [{ watchConversationEvents }] = await loadGuiModules(t, ['/src/services/conversationEvents.ts']);
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  t.after(() => controllers.forEach(controller => controller.abort()));
  const first = assert.rejects(watchConversationEvents(controllers[0].signal, () => {}), /observation_lagged: exact failure/);
  const second = assert.rejects(watchConversationEvents(controllers[1].signal, () => {}), /observation_lagged: exact failure/);
  await waitUntil(() => stream); stream.send('ready');
  stream.send('error', { code: 'observation_lagged', message: 'exact failure' });
  await Promise.all([first, second]);
  assert.equal(connects, 1, 'failure never starts hidden polling or automatic replay');
  const received = [];
  const retry = watchConversationEvents(controllers[2].signal, event => received.push(event));
  await waitUntil(() => connects === 2); stream.send('ready');
  await waitUntil(() => received.length === 1);
  assert.deepEqual(received, [{ type: 'ready' }]);
  controllers[2].abort(); await retry;
});

test('malformed settlement and silent stream closure are failures, not invented completion facts', async t => {
  let stream;
  installGuiFetch(t, (_url, init) => { stream = events(init.signal); return stream.response; });
  const [{ watchConversationEvents }] = await loadGuiModules(t, ['/src/services/conversationEvents.ts']);
  const controller = new AbortController(); t.after(() => controller.abort());
  const received = [];
  const malformed = assert.rejects(watchConversationEvents(controller.signal, event => received.push(event)), /conversation_settlement_invalid/);
  await waitUntil(() => stream); stream.send('ready'); stream.send('settled', { ...settled('session:bad', 1), outcome: 'running' });
  await malformed; assert.deepEqual(received, [{ type: 'ready' }]);
  const closed = assert.rejects(watchConversationEvents(controller.signal, () => {}), /conversation_events_closed/);
  stream.close(); await closed;
});


test('the main conversation refreshes statuses and projection on events without idle reads', async t => {
  let stream, reads = 0, release;
  installGuiFetch(t, (_url, init) => { stream = events(init.signal); return stream.response; });
  const [{ watchConversationChanges }] = await loadGuiModules(t, ['/src/services/conversationEvents.ts']);
  const controller = new AbortController(); t.after(() => controller.abort());
  const wait = watchConversationChanges(null, controller.signal, async () => {
    reads++;
    if (reads === 2) await new Promise(resolve => { release = resolve; });
  });
  await waitUntil(() => stream);
  assert.equal(reads, 0);
  stream.send('ready'); await waitUntil(() => reads === 1);
  await tick(); assert.equal(reads, 1);
  stream.send('change', { sessionId: 'session:external' });
  await waitUntil(() => release);
  stream.send('change', { sessionId: 'session:child' });
  stream.send('settled', settled('session:external', 30));
  await tick(); assert.equal(reads, 2, 'one canonical read remains in flight');
  release(); await waitUntil(() => reads === 3);
  await tick(); assert.equal(reads, 3, 'idle does not schedule a refresh');
  controller.abort(); await wait;
});
