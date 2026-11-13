// Regression TCR: .task-artifacts/frontend-fixes-20261113/TCR.md.
// A journal read watermark does not imply that queued user input was consumed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, workspaceBinding,
} from './local-agent-fixtures.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function observeWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(value => ({ value })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
const discoveryTool = { toolBindingRef: 'binding:plugin-search', name: 'plugin.search', description: 'Discover plugins.',
  inputSchema: { type: 'object', properties: {} }, possibleEffects: ['localRead'], availability: 'callable', origin: 'coreBuiltin' };
const readTool = { ...discoveryTool, toolBindingRef: 'binding:read', name: 'fs.read' };

test('queued input arriving during preparation wakes a later session.wait without another input', { timeout: 5_000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:queued-before-wait';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [discoveryTool, readTool], contextWindowTokens: 8192 });
  const preparing = deferred(), drain = deferred(), waitAccepted = deferred(), thirdRequest = deferred();
  let preparations = 0;
  const port = { ...preparation.port, async prepare(request) {
    preparations++;
    // Initial runtime, first request boundary, then boundary after fs.read.
    if (preparations === 3) { preparing.resolve(); await drain.promise; }
    return preparation.port.prepare(request);
  } };
  const originalBatch = journal.appendBatch.bind(journal);
  journal.appendBatch = async events => {
    const committed = await originalBatch(events);
    if (events.some(event => event.type === 'session.control.completed' && event.payload.operation.action === 'wait')) waitAccepted.resolve();
    return committed;
  };
  const requests = [], supplement = 'Use the queued instruction before waiting again.';
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      yield providerEvent(request.requestId, 'tool.call', { callId: 'read:before-wait', name: 'fs_read', input: { path: 'notes.md' } });
    } else if (requests.length === 2) {
      assert.ok(request.tools.some(tool => tool.name === 'session'));
      assert.equal(request.messages.some(message => message.role === 'user' && message.content === supplement), false,
        'input arriving during preparation intentionally belongs to the following request');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'wait:after-late-input', name: 'session', input: { action: 'wait' } });
    } else {
      thirdRequest.resolve(structuredClone(request));
      yield providerEvent(request.requestId, 'text.delta', { text: 'Queued instruction applied.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    return completedExecutionReply(request, { content: 'Independent notes.' });
  } }), port, 'wait-boundary');
  t.after(async () => { drain.resolve(); await actor.dispose(); });

  assert.equal((await actor.submit(messageCommand(sessionId, 'command:start', 'Read the notes, then wait.'))).status, 'accepted');
  assert.ok(await observeWithin(preparing.promise, 1_500));
  const runId = (await actor.snapshot()).run.runId;
  assert.equal((await actor.submit({ ...messageCommand(sessionId, 'command:supplement', supplement), runId })).status, 'accepted');
  assert.equal(requests.length, 1);
  drain.resolve();
  assert.ok(await observeWithin(waitAccepted.promise, 1_500));
  const continued = await observeWithin(thirdRequest.promise, 750);
  const events = await readEvents(journal, sessionId);
  const queued = events.find(event => event.type === 'input.queued' && event.payload.commandId === 'command:supplement');
  const wait = events.find(event => event.type === 'session.control.completed' && event.payload.operation.action === 'wait');
  const composition = events.find(event => event.type === 'context.composed' && event.payload.providerRequestId === requests[1].requestId);
  assert.ok(queued.sequence <= composition.payload.modelView.throughSequence, 'the regression must cross the unread input watermark');
  assert.equal(wait.payload.result.wait.afterSequence, composition.payload.modelView.throughSequence, 'retain the existing persisted watermark contract');
  assert.ok(continued, 'unconsumed queued input must end the wait without a third user message');
  assert.equal(continued.value.messages.filter(message => message.role === 'user' && message.content === supplement).length, 1);
  const final = await waitForProjection(actor, snapshot => snapshot.run?.status === 'completed');
  assert.equal(final.queuedInputs.filter(input => input.status === 'queued').length, 0);
  const completedEvents = await readEvents(journal, sessionId);
  assert.equal(completedEvents.filter(event => event.type === 'input.accepted' && event.payload.commandId === 'command:supplement').length, 1);
  assert.equal(requests.length, 3, 'consumed input must not create another model request');
});
