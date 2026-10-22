import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, reduceSession, recoverSession, projectSession } from '../dist/index.js';
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
  assert.deepEqual(recoverSession(sessionId, events), expected);
  assert.deepEqual(projectSession(recoverSession(sessionId, events)), await actor.snapshot());
  assert.deepEqual(recoverSession(sessionId, events), expected, 'replay indexes do not outlive a read');
  assert.deepEqual(events, saved, 'recovery does not mutate canonical payloads');
  const mutations = [
    history => { const contexts = history.filter(event => event.type === 'context.composed');
      contexts[1].payload.providerRequestId = contexts[0].payload.providerRequestId; },
    history => { const calls = history.filter(event => event.type === 'tool.requested');
      calls[1].callId = calls[0].callId; },
    history => { history.find(event => event.type === 'provider.attempt.updated').payload.providerRequestId = 'request:missing'; },
  ];
  for (const mutate of mutations) {
    const history = structuredClone(events); mutate(history);
    let expectedError;
    assert.throws(() => incremental(history), error => { expectedError = error.message; return true; });
    assert.throws(() => recoverSession(sessionId, history), error => error.message === expectedError);
  }
});
