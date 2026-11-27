import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCapabilities } from '../dist/local-agent/sessionCapabilities.js';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { consumeProvider } from '../dist/local-agent/loopProvider.js';
import { loopSnapshot } from '../dist/local-agent/loop.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation, failedExecutionReply,
  idFactory, indeterminateExecutionRecord, messageCommand, providerEvent, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const write = { name: 'fs.write', toolBindingRef: 'binding:write', origin: 'coreBuiltin', availability: 'callable',
  description: 'Write a file.', possibleEffects: ['workspaceMutation'], inputSchema: { type: 'object', required: ['path', 'content'],
    properties: { path: { type: 'string' }, content: { type: 'string' } } } };
const writeCall = id => ({ callId: `native:${id}`, name: 'fs_write', input: { path: 'sample.txt', content: id } });
const terminal = state => ['completed', 'failed', 'indeterminate', 'cancelled'].includes(state.run?.status);
const stopped = { code: 'provider_error', message: 'Explicit continuation required.', diagnostics: {
  source: 'providerTransport', phase: 'response', category: 'provider', retryable: false, causes: [], providerError: { retryDirective: 'NO_MORE_RETRY' },
} };
const disconnected = { code: 'provider_transport_failed', message: 'Connection reset.', diagnostics: {
  source: 'providerTransport', phase: 'send', category: 'network', retryable: true, causes: [],
} };

// The model sees no old call/result pairs, but Session retains the complete, validated journal.
async function replay(t, route, initial, execute) {
  const sessionId = `session:replay-${route}`, journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [], attempts = [], omitted = new Map();
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    const send = requests.push(request);
    if (send === 2 && route !== 'fresh') {
      yield providerEvent(request.requestId, 'failed', route === 'retry' ? disconnected : stopped);
      return;
    }
    if (send === 1 || send === (route === 'fresh' ? 2 : 3)) {
      for (const id of initial) yield providerEvent(request.requestId, 'tool.call', writeCall(id));
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    attempts.push(request);
    return attempts.length === 1 ? execute(request) : completedExecutionReply(request, { saved: request.input.content });
  } }), fakeRunPreparation({ tools: [write] }).port, `replay-${route}`);
  t.after(() => actor.dispose());
  const installed = createSessionCapabilities();
  await actor.replaceCapabilities({ ...installed, context: { ...installed.context, async prepare(...args) {
    const prepared = await installed.context.prepare(...args);
    const messages = prepared.request.messages.filter(m => {
      if (m.role === 'tool' && !omitted.has(m.providerCallId)) omitted.set(m.providerCallId, m.toolOutcome);
      return m.role !== 'tool' && !m.toolCalls;
    });
    return { ...prepared, request: { ...prepared.request, messages } };
  } } });
  await actor.submit(messageCommand(sessionId, 'command:write', 'Write the file.'));
  const previous = route === 'continue' ? await waitForProjection(actor, terminal) : undefined;
  if (previous) {
    assert.equal(previous.terminalError.code, stopped.code);
    const result = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'provider.continue',
      sessionId, runId: previous.run.runId, commandId: 'command:continue' });
    assert.equal(result.status, 'accepted');
  }
  const final = await waitForProjection(actor, s => terminal(s) && s.run.runId !== previous?.run.runId);
  const resumed = requests[route === 'fresh' ? 1 : 2];
  assert.ok(resumed);
  assert.doesNotMatch(JSON.stringify(resumed.messages), /native:/u);
  if (route === 'retry') {
    assert.equal(resumed.requestId, requests[1].requestId);
    assert.equal(resumed.attempt, 2);
  } else if (route === 'continue') {
    assert.notEqual(resumed.runId, requests[1].runId);
    assert.equal(final.run.continuation.runId, previous.run.runId);
  }
  return { final, attempts, omitted, events: await readEvents(journal, sessionId) };
}

for (const route of ['retry', 'continue', 'fresh']) {
  test(`${route}: an indeterminate Kernel record protects its native ID only on replay`, async t => {
    const { final, attempts, omitted, events } = await replay(t, route, ['uncertain'], request => ({
      ...completedExecutionReply(request, {}), status: 'indeterminate', record: indeterminateExecutionRecord(request),
    }));
    assert.equal(omitted.get('native:uncertain'), 'indeterminate');
    const count = route === 'fresh' ? 2 : 1;
    assert.equal(attempts.length, count, 'Kernel.execute must not receive another attempt for an uncertain native call on replay');
    assert.equal(new Set(attempts.map(r => r.attemptId)).size, count);
    assert.deepEqual(events.filter(e => e.type === 'tool.requested').map(e => e.callId), attempts.map(r => r.callId));
    assert.deepEqual(events.filter(e => e.type === 'tool.completed').map(e => e.payload.record.outcome),
      route === 'fresh' ? ['indeterminate', 'completed'] : ['indeterminate']);
    if (route === 'fresh') assert.equal(final.run.status, 'completed');
    else assert.equal(final.terminalError.code, 'provider_tool_call_duplicate');
  });
}

test('a definite failure and its unexecuted dependent do not reserve their IDs on continuation', async t => {
  const { final, attempts, omitted, events } = await replay(t, 'continue', ['failed', 'not-started'],
    request => failedExecutionReply(request, {}, { code: 'write_refused', message: 'Target refused the write.' }));
  assert.equal(final.run.status, 'completed');
  assert.deepEqual(Object.fromEntries(omitted), { 'native:failed': 'failed', 'native:not-started': 'notExecuted' });
  assert.deepEqual(attempts.map(r => r.input.content), ['failed', 'failed', 'not-started']);
  assert.equal(new Set(attempts.map(r => r.attemptId)).size, 3);
  assert.deepEqual(events.filter(e => e.type === 'tool.not-executed').map(e => e.payload.reason), ['dependencyFailed']);
  assert.deepEqual(events.filter(e => e.type === 'tool.completed').map(e => e.payload.record.outcome), ['failed', 'completed', 'completed']);
});

test('a started call with a lost reply and no Kernel record remains protected on replay', async t => {
  const sessionId = 'session:replay-interrupted', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [], executions = [];
  const call = writeCall('lost');
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    const send = requests.push(request);
    if (send === 2) { yield providerEvent(request.requestId, 'failed', disconnected); return; }
    if (send === 1 || send === 3) yield providerEvent(request.requestId, 'tool.call', call);
    else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request, onProgress) {
    executions.push(request);
    if (executions.length === 1) {
      await onProgress({ type: 'started', startedAt: String(Date.now()) });
      throw new Error('Lost execution reply.');
    }
    return completedExecutionReply(request, { saved: true });
  } }), fakeRunPreparation({ tools: [write] }).port, 'lost');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:first', 'Write the file.'));
  const original = await waitForProjection(actor, terminal);
  assert.equal(original.run.status, 'failed');
  const history = await readEvents(journal, sessionId);
  assert.deepEqual(history.filter(e => e.type === 'tool.interrupted').map(e => e.callId), [executions[0].callId]);
  assert.equal(history.some(e => e.type === 'tool.completed'), false);

  // Kernel failure itself is not eligible for provider.continue. A new request can, however,
  // carry its interrupted result when a real transport failure causes the Provider to resend.
  await actor.submit(messageCommand(sessionId, 'command:next', 'Check what happened.'));
  const retried = await waitForProjection(actor, s => terminal(s) && s.run.runId !== original.run.runId);
  assert.equal(requests[2].attempt, 2);
  assert.ok(requests[2].messages.some(m => m.providerCallId === call.callId && m.toolOutcome === 'indeterminate'));
  assert.equal(executions.length, 1, 'the replay must not dispatch the lost call under a second logical ID');
  assert.equal(retried.terminalError.code, 'provider_tool_call_duplicate');

  // Exercise the same decoder with the issuing run's actual interrupted journal but no model history.
  const { runId, payload } = history.find(e => e.type === 'run.started');
  const snapshot = loopSnapshot(sessionId, history);
  const { request, toolCodec } = buildConversationProviderRequest({ sessionId, runId, runtime: payload.runtimeSnapshot,
    workspaceBindings: [workspaceBinding], events: [], providerRequestId: 'request:compacted', purpose: 'agent', responseConstraint: 'normal' });
  assert.doesNotMatch(JSON.stringify(request.messages), /native:lost/u);
  await assert.rejects(consumeProvider(request, toolCodec, runId, {
    readSnapshot: async () => snapshot, commit: async () => snapshot, updateAssistantDraft() {}, nextId: idFactory('retry'),
    composition: { provider: { async *stream() {
      yield providerEvent(request.requestId, 'tool.call', call);
      yield providerEvent(request.requestId, 'completed', {});
    } } },
  }, new AbortController().signal, undefined, true), { code: 'provider_tool_call_duplicate' });
});
