import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, failedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';
import { readConversation } from '../dist/local-agent/conversationRead.js';
import { modelContextEvents, sameModelContext } from '../dist/local-agent/modelContext.js';
import { recoverSession, projectSession } from '../dist/local-agent/reducer.js';

const reader = { toolBindingRef: 'binding:session-read', name: 'session.read', description: 'Read conversation history.',
  origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['localRead'],
  inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, view: { type: 'string' } } } };

function setup(sessionId, journal, options = {}) {
  const preparation = fakeRunPreparation({ tools: [reader], contextWindowTokens: 100000,
    ...(options.compact ? { contextManagement: { enabled: true, thresholdTokens: 1 } } : {}) });
  const requests = [];
  const port = { ...preparation.port, async prepare(request) {
    const prepared = await preparation.port.prepare(request);
    prepared.runtimeSnapshot.provider.continuationKey = `native:${request.profileId}`;
    prepared.runtimeSnapshot.provider.providerRuntimeRef = `runtime:${request.runId}`;
    prepared.runtimeSnapshot.provider.apiSurface = request.profileId === 'deepseek-chat' ? 'chatCompletions' : 'responses';
    return prepared;
  } };
  const kernel = emptyKernel({ async execute(request) {
    assert.equal(request.toolName, 'session.read');
    if (options.readFails) return failedExecutionReply(request, {}, { code: 'archive_unavailable', message: 'Original archive failure' });
    return completedExecutionReply(request, await readConversation(journal, request.input));
  } });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const reading = request.tools.length === 1 && request.tools[0].name === 'session_read';
    if (request.purpose === 'contextCompaction') {
      yield providerEvent(request.requestId, 'text.delta', { text: `Checkpoint for ${request.profileId}` });
    } else if (reading && !options.answerWithoutRead) {
      yield providerEvent(request.requestId, 'tool.call', { callId: `read:${request.requestId}`, name: 'session_read', input: { sessionId, view: 'summary' } });
    } else if (options.native) {
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
        item: { type: 'reasoning', id: `private:${request.profileId}:${request.requestId}`, encrypted_content: `opaque:${request.profileId}`, summary: [] } });
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 1,
        item: { type: 'message', id: `message:${request.requestId}`, role: 'assistant', phase: 'final_answer',
          content: [{ type: 'output_text', text: `Done ${request.profileId}` }] } });
    } else {
      yield providerEvent(request.requestId, 'assistant.message', { messageId: `native-message:${request.requestId}`, content: `Done ${request.profileId}`, reasoningContent: `private:${request.profileId}` });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  return { preparation, requests, port, kernel, provider };
}

test('GPT → DeepSeek → GPT creates fresh contexts while retaining history and inherited plugins across Actor reload', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:handoff';
  await createSession(journal, sessionId, [workspaceBinding]);
  const f = setup(sessionId, journal);
  let actor = actorWith(journal, sessionId, f.provider, f.kernel, f.port, 'switch');
  t.after(() => actor.dispose());
  let step = 0;
  for (const profileId of ['gpt', 'gpt', 'deepseek', 'gpt', 'deepseek-chat']) {
    const command = messageCommand(sessionId, `command:${++step}`, `Task ${step}`, profileId);
    if (step === 1) command.pluginSelections = [{ selectionId: 'selection:notes', uri: 'plugin://notes@local', label: 'Notes' }];
    const reply = await actor.submit(command);
    assert.notEqual(reply.status, 'rejected');
    const state = await waitForProjection(actor, state => state.run && ['completed', 'failed', 'indeterminate'].includes(state.run.status)
      && state.messages.filter(message => message.role === 'user').length === step);
    assert.equal(state.run.status, 'completed', JSON.stringify(state.terminalError));
    if (step === 3) {
      await actor.dispose();
      actor = actorWith(journal, sessionId, f.provider, f.kernel, f.port, 'switch-reloaded');
    }
  }
  const events = await readEvents(journal, sessionId), starts = events.filter(event => event.type === 'run.started');
  assert.equal(starts.length, 5);
  assert.equal(starts[0].payload.contextStart, undefined);
  assert.equal(starts[1].payload.contextStart, undefined, 'same resolved identity keeps native continuation');
  for (const [index, start] of starts.entries()) {
    assert.equal(start.payload.runtimeSnapshot.selectedPlugins.plugins[0].uri, 'plugin://notes@local');
    const requests = f.requests.filter(request => request.runId === start.runId);
    if (index < 2) { assert.equal(requests.length, 1); continue; }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools.map(tool => tool.name), ['session_read']);
    assert.ok(requests[0].messages.every(message => !message.reasoningContent && !message.providerOutputBlocks && !message.providerItems));
    assert.deepEqual(requests[0].messages.filter(message => message.role === 'user').map(message => message.content), [`Task ${index + 1}`]);
    const read = events.find(event => event.type === 'tool.completed' && event.runId === start.runId);
    assert.equal(read.payload.record.input.throughSequence, start.payload.contextStart.historyThroughSequence);
    assert.equal(read.payload.record.output.revision, start.payload.contextStart.historyThroughSequence);
    assert.equal(read.payload.record.output.summary.lastUserMessage.content, `Task ${index}`);
    assert.ok(requests[1].tools.some(tool => tool.name === 'todo_update'));
  }
  assert.ok(f.requests[1].messages.some(message => message.reasoningContent === 'private:gpt'));
  const replay = projectSession(recoverSession(sessionId, events));
  assert.equal(replay.contextHandoff.status, 'ready');
  assert.equal(replay.messages.filter(message => message.role === 'user').length, 5);
  assert.equal(f.preparation.released.length, 5);
  assert.ok(modelContextEvents(events).every(event => event.sequence > starts[4].payload.contextStart.historyThroughSequence));
});

for (const [name, options, code] of [
  ['failed history read', { readFails: true }, 'model_handoff_read_failed'],
  ['answer without reading', { answerWithoutRead: true }, 'model_handoff_read_required'],
]) test(`${name} does not open ordinary tools or erase old history`, async t => {
  const sessionId = `session:${name.replaceAll(' ', '-')}`, journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const f = setup(sessionId, journal, options);
  const actor = actorWith(journal, sessionId, f.provider, f.kernel, f.port, name.replaceAll(' ', '-'));
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:a', 'First task', 'gpt'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  await actor.submit(messageCommand(sessionId, 'command:b', 'Continue task', 'deepseek'));
  const state = await waitForProjection(actor, state => state.run?.status === 'failed');
  assert.equal(state.terminalError.code, code);
  assert.equal(state.contextHandoff.status, 'reading');
  assert.equal(f.requests.filter(request => request.profileId === 'deepseek').length, 1);
  assert.equal(state.messages.filter(message => message.role === 'user').length, 2);
  if (options.readFails) assert.equal(state.terminalError.message, 'Original archive failure');
});

test('native reasoning objects, frozen model views and compaction checkpoints cannot cross a switch', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:native-boundary';
  await createSession(journal, sessionId, [workspaceBinding]);
  const f = setup(sessionId, journal, { native: true, compact: true });
  const actor = actorWith(journal, sessionId, f.provider, f.kernel, f.port, 'native');
  t.after(() => actor.dispose());
  for (const profileId of ['gpt', 'deepseek', 'gpt']) {
    await actor.submit(messageCommand(sessionId, `command:${f.requests.length}`, 'Continue', profileId));
    const result = await waitForProjection(actor, state => ['completed', 'failed'].includes(state.run?.status));
    assert.equal(result.run.status, 'completed', JSON.stringify(result.terminalError));
  }
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'context.compacted').length, 3);
  const starts = events.filter(event => event.type === 'run.started');
  for (const start of starts.slice(1)) {
    const first = f.requests.find(request => request.runId === start.runId);
    assert.ok(first.messages.every(message => !message.providerOutputBlocks && !message.reasoningSignature && !message.reasoningContent));
    assert.ok(first.messages.every(message => !message.content.includes('Checkpoint for')));
    const previous = new Set(events.filter(event => event.type === 'provider.turn.settled'
      && event.sequence <= start.payload.contextStart.historyThroughSequence).flatMap(event => event.payload.orderedOutputBlocks?.map(block => block.item.id) ?? []));
    for (const request of f.requests.filter(request => request.runId === start.runId)) {
      assert.ok(request.messages.every(message => message.providerOutputBlocks?.every(block => !previous.has(block.item.id)) ?? true));
    }
  }
});

test('continuation identity does not conflate protocol, model, endpoint, account or absent provenance', () => {
  const a = { profileId: 'a', apiSurface: 'responses', providerRuntimeRef: 'run:1', continuationKey: 'service-account-model:a' };
  assert.equal(sameModelContext(a, { ...a, providerRuntimeRef: 'run:2' }), true);
  for (const b of [{ ...a, profileId: 'b' }, { ...a, continuationKey: 'service-account-model:b' }, { ...a, continuationKey: undefined }])
    assert.equal(sameModelContext(a, b), false);
  assert.equal(sameModelContext({ ...a, continuationKey: undefined }, { ...a, continuationKey: undefined, providerRuntimeRef: 'run:2' }), false);
});
