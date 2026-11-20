import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, reduceSession, recoverSession, projectSession, SessionService } from '../dist/index.js';
import { projectSessionHistory } from '../dist/local-agent/reducer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation, messageCommand,
  providerEvent, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

test('history replay keeps incremental facts, errors and input ownership across requests and runs', async t => {
  const sessionId = 'session:replay-indexes', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{ toolBindingRef: 'binding:read', name: 'fs.read',
    description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    possibleEffects: ['localRead'], availability: 'callable', origin: 'coreBuiltin' }] });
  let requests = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests++;
    if (requests % 2) {
      for (let call = 0; call < 2; call++) yield providerEvent(request.requestId, 'tool.call', {
        callId: `provider:${requests}:${call}`, name: request.tools.find(tool => tool.inputSchema.properties?.path).name,
        input: { workspace: 'primary', path: `fixture-${call}.txt` },
      });
    } else yield providerEvent(request.requestId, 'text.delta', { text: `Answer ${requests}.` });
    yield providerEvent(request.requestId, 'completed', { usage: {
      inputTokens: 100, outputTokens: 20, contextWindowTokens: 4096,
    } });
  } }, emptyKernel({ async execute(request) { return completedExecutionReply(request, { content: 'File content.' }); } }), preparation.port, 'replay-indexes');
  t.after(() => actor.dispose());
  for (let run = 0; run < 2; run++) {
    await actor.submit(messageCommand(sessionId, `command:${run}`, `Question ${run}.`));
    await waitForProjection(actor, projection => projection.run?.status === 'completed' && requests === (run + 1) * 2);
  }
  const events = await readEvents(journal, sessionId), saved = structuredClone(events);
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 4);
  const incremental = history => history.reduce(reduceSession, emptySessionState(sessionId));
  const expected = incremental(events);
  // Published incremental states stay immutable; only unobservable replay-owned maps can be reused.
  const runRecords = { 'run.timing.updated': 'runTimings', 'run.started': 'runRuntimeSnapshots',
    'run.runtime.released': 'runRuntimeReleases' };
  const touched = new Set();
  let held = emptySessionState(sessionId);
  for (const event of events) {
    const key = runRecords[event.type];
    const before = key && structuredClone(held[key]);
    const next = reduceSession(held, event);
    if (key) {
      touched.add(key);
      assert.notEqual(next[key], held[key], key + ': incremental states do not share the written map');
      assert.deepEqual(held[key], before, key + ': later events cannot change a prior state');
    }
    held = next;
  }
  assert.equal(touched.size, 3);
  assert.deepEqual(recoverSession(sessionId, events), expected);
  assert.deepEqual(projectSession(recoverSession(sessionId, events)), await actor.snapshot());
  assert.deepEqual(recoverSession(sessionId, events), expected, 'replay indexes do not outlive a read');
  assert.deepEqual(events, saved, 'recovery does not mutate canonical payloads');
  const projected = projectSessionHistory(sessionId, events);
  assert.deepEqual(projected, projectSession(expected));
  const publishedReceipt = projected.contextCompositions.at(-1);
  const originalReceipt = events.find(event => event.type === 'context.composed'
    && event.payload.providerRequestId === publishedReceipt.providerRequestId).payload;
  const index = publishedReceipt.messages.findIndex(message => message.blocks.length);
  assert.notEqual(index, -1);
  publishedReceipt.messages[index].label = 'presentation only';
  publishedReceipt.messages[index].blocks[0].blockIndex = -1;
  publishedReceipt.messages[index].filesystemReferences.push({ label: 'presentation only' });
  assert.deepEqual(events, saved, 'mutating the public message, block or reference list cannot change the journal');
  assert.notDeepEqual(publishedReceipt.messages, originalReceipt.messages);

  const historyService = new SessionService(journal, { async create() { throw new Error('unexpected_actor'); } });
  t.after(() => historyService.dispose());
  assert.deepEqual(await historyService.snapshot(sessionId), projectSession(expected));
  const firstReceipt = expected.contextCompositions[0];
  assert.ok(!projected.contextCompositions.some(r => r.providerRequestId === firstReceipt.providerRequestId));
  assert.deepEqual(await historyService.contextComposition(sessionId, firstReceipt.providerRequestId), firstReceipt,
    'a receipt omitted from the public projection is still available in full');

  const mutations = [
    history => { const contexts = history.filter(event => event.type === 'context.composed');
      contexts[1].payload.providerRequestId = contexts[0].payload.providerRequestId; },
    history => { const calls = history.filter(event => event.type === 'tool.requested');
      calls[1].callId = calls[0].callId; },
    history => { history.find(event => event.type === 'provider.attempt.updated').payload.providerRequestId = 'request:missing'; },
    history => { delete history.find(event => event.type === 'context.composed').payload.messages[0].blocks; },
    history => { history.find(event => event.type === 'context.composed').payload.messages = {}; },
    history => { history.find(event => event.type === 'run.timing.updated').runId = 'run:not-current'; },
    history => { history.find(event => event.type === 'run.runtime.released').payload.runRuntimeSnapshotRef = 'snapshot:wrong'; },
  ];
  for (const mutate of mutations) {
    const history = structuredClone(events); mutate(history);
    let expectedError;
    assert.throws(() => incremental(history), error => { expectedError = error.message; return true; });
    assert.throws(() => recoverSession(sessionId, history), error => error.message === expectedError);
    assert.throws(() => projectSessionHistory(sessionId, history), error => error.message === expectedError);
  }
  const revised = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'message.edit', sessionId,
    commandId: 'command:history-replay-edit', messageId: expected.messages[0].messageId,
    expectedRevision: expected.revision, text: 'Replacement question.' });
  assert.equal(revised.status, 'accepted');
  const liveAfterEdit = await waitForProjection(actor, p => p.run?.status === 'completed' && requests === 6);
  const edited = await readEvents(journal, sessionId);
  assert.ok(edited.some(event => event.type === 'conversation.revised'));
  assert.deepEqual(projectSessionHistory(sessionId, edited), projectSession(recoverSession(sessionId, edited)));
  assert.deepEqual(await historyService.snapshot(sessionId), liveAfterEdit,
    'only the active branch is visible after editing; the old branch still contributes its usage');
});
