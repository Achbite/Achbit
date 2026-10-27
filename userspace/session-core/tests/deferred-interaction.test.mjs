import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, providerEvent, createSession,
  messageCommand, readEvents, waitForProjection, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

for (const surface of ['aggregate', 'responses']) test(`questions continue on the single Loop and replies enter at request boundaries (${surface})`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:questions-${surface}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ contextWindowTokens: 16000 });
  const requests = []; let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const ordinal = requests.length;
    assert.ok(ordinal <= 5, 'No second Loop or unanswered-question polling');
    if (ordinal <= 2) {
      const input = { kind: 'question', mode: 'continue', prompt: `Question ${ordinal}: choose a direction`, allowFreeform: true,
        options: [{ id: 'a', label: 'Direction A' }, { id: 'b', label: 'Direction B' }] };
      const name = request.tools.find(tool => tool.inputSchema.properties?.allowFreeform).name;
      yield surface === 'responses'
        ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
          type: 'function_call', call_id: `question:${ordinal}`, name, arguments: JSON.stringify(input), status: 'completed' } })
        : providerEvent(request.requestId, 'tool.call', { callId: `question:${ordinal}`, name, input });
    } else {
      if (ordinal === 3) { held = true; await gate; }
      if (ordinal >= 4) {
        const replies = request.messages.filter(message => message.role === 'user' && message.content.includes('User response to question'));
        assert.equal(replies.length, ordinal === 4 ? 1 : 2);
        assert.ok(replies[0].content.includes('Question 1') && replies[0].content.includes('First answer'));
        const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        assert.equal(results.filter(result => result.status === 'pending').length, 2, 'Question receipts remain fixed after later answers');
        assert.ok(results.every(result => !('response' in result)), 'A resolved deferred question does not append a second tool output');
      }
      yield providerEvent(request.requestId, 'assistant.message', { messageId: `message:stage-${ordinal}`,
        content: ordinal === 5 ? 'All answers incorporated.' : `Independent analysis ${ordinal} complete; unresolved direction awaits the user.` });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, `questions-${surface}`);
  t.after(async () => { release(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Ask about A and B early, continue independent analysis, then use my answers.'));
  await waitUntil(() => held, 'independent analysis in progress');
  const running = await actor.snapshot();
  assert.equal(running.run.status, 'running');
  assert.equal(running.pendingInteraction.interactionId, running.interactions[0].interactionId, 'CLI/TUI can answer while the same Loop continues');
  assert.equal(running.interactions.length, 2);
  assert.equal(preparation.released.length, 0);
  const answer = (interaction, response, commandId) => actor.submit({ schemaVersion: 'achbit.command.v3',
    type: 'interaction.respond', sessionId, commandId, runId: running.run.runId, interactionId: interaction.interactionId, response });
  assert.equal((await answer(running.interactions[0], 'First answer', 'command:answer-a')).status, 'accepted');
  const queued = await actor.snapshot();
  assert.equal(queued.queuedInputs[0].interactionId, running.interactions[0].interactionId);
  assert.equal(queued.interactions[0].status, 'answered');
  assert.equal(requests.length, 3, 'Answer did not start a parallel provider call');
  release();
  const waiting = await waitForProjection(actor, state => state.run?.status === 'waiting');
  assertRuntimeContract('SessionProjection', waiting);
  assert.equal(waiting.pendingInteraction.interactionId, running.interactions[1].interactionId);
  assert.equal(waiting.messages.at(-1).role, 'assistant', 'Independent final prose is retained before waiting');
  assert.equal(waiting.messages.find(message => message.content === 'First answer').replyToInteraction.prompt, running.interactions[0].prompt);
  assert.equal(await actor.hasActiveWork(), true, 'Unanswered questions keep the bound Host alive');
  assert.equal(preparation.released.length, 0);
  assert.equal((await answer(running.interactions[0], 'Different answer', 'command:duplicate-answer')).status, 'rejected');
  await answer(running.interactions[1], 'Second answer', 'command:answer-b');
  const done = await waitForProjection(actor, state => state.run?.status === 'completed');
  assertRuntimeContract('SessionProjection', done);
  assert.equal(done.interactions.filter(item => item.status === 'answered').length, 2);
  assert.equal(done.pendingInteraction, null);
  assert.equal(preparation.released.length, 1);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'run.started').length, 1);
  assert.equal(events.filter(event => event.type === 'run.waiting').length, 1);
  assert.equal(events.filter(event => event.type === 'run.runtime.released').length, 1);
  const answerEvent = events.find(event => event.type === 'message.committed' && event.payload.content === 'First answer');
  const analysisEvent = events.find(event => event.type === 'message.committed' && event.payload.messageId === 'message:stage-3');
  assert.ok(answerEvent.sequence > analysisEvent.sequence, 'Queued answer is appended only after the active provider turn settles');
});

test('cancelling a run closes unresolved questions without inventing answers', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:question-cancel';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ contextWindowTokens: 16000 }); let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'question:cancel',
      name: request.tools.find(tool => tool.inputSchema.properties?.allowFreeform).name,
      input: { kind: 'question', mode: 'continue', prompt: 'Which direction?', allowFreeform: true } });
    else yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:independent', content: 'Independent work is ready.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), preparation.port, 'question-cancel');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Clarify and continue.'));
  const waiting = await waitForProjection(actor, state => state.run?.status === 'waiting');
  await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', commandId: 'command:cancel', sessionId, runId: waiting.run.runId });
  const done = await waitForProjection(actor, state => state.run?.status === 'cancelled');
  assert.equal(done.interactions[0].status, 'closed');
  assert.equal(done.interactions[0].response, undefined);
  assert.equal(done.pendingInteraction, null);
  assert.equal(preparation.released.length, 1);
});
