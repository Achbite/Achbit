import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCatalog, readImageReferences, visualContextMessages } from '../dist/local-agent/visualContext.js';
import { decodeConversationReadQuery, readConversation } from '../dist/local-agent/conversationRead.js';
import { withProviderAttempts } from '../dist/local-agent/providerAttempts.js';
import { ProviderReportedFailure } from '../dist/local-agent/loopFailure.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const sessionId = 'session:images', runId = 'run:images';
function history() {
  const events = [];
  const append = (type, payload, extra = {}) => {
    const event = { type, sessionId, runId, eventId: `event:${events.length}`, sequence: events.length + 1, payload, ...extra };
    events.push(event);
    return event;
  };
  append('session.created', { workspaceBindings: [] });
  return { events, append };
}
const file = id => ({ referenceId: id, workspaceId: 'input:images', logicalPath: `${id}.png`, mediaType: 'image/png', displayName: id, kind: 'file' });
const ids = messages => messages.map(message => JSON.parse(message.message.content.slice('Current visual inputs: '.length)).imageId);
const observe = (append, id, purpose = 'observation') => append('tool.completed', { record: {
  toolName: 'browser.observe', input: {}, outcome: 'completed', output: { modelImages: [{ artifactId: id, ...(purpose ? { purpose } : {}) }] },
} }, { callId: `call:${id}` });
const choose = (append, imageIds, outcome = 'completed') => append('tool.completed', { record: {
  toolName: 'session.read', input: { sessionId, view: 'images', imageIds }, outcome,
  ...(outcome === 'completed' ? { output: {} } : { error: { code: 'session_image_not_found' } }),
} }, { callId: 'call:read' });
const compose = (append, events, providerRequestId = `request:${events.length}`, purpose = 'agent') => {
  append('context.composed', { providerRequestId, purpose, messages: visualContextMessages(events, runId).map(message => ({
    contributionId: message.contributionId,
  })) });
  return providerRequestId;
};
const settle = (append, providerRequestId, outcome = 'completed', purpose = 'agent') => (
  append('provider.turn.settled', { providerRequestId, purpose, outcome })
);

test('attachments and GUI observations are consumed by a successful request and archived images can be reopened once', () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('design')] }, { runId: undefined });
  append('run.started', { inputMessageId: 'input' });
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design']);
  compose(append, events);
  observe(append, 'before');
  observe(append, 'detail');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'before', 'detail']);
  const request = compose(append, events);
  append('tool.completed', { record: { toolName: 'fs.read', input: {}, outcome: 'completed', output: { content: 'code' } } });
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'before', 'detail']);
  settle(append, request);
  assert.deepEqual(ids(visualContextMessages(events, runId)), []);
  observe(append, 'after');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['after']);
  choose(append, ['before', 'after']);
  const compared = visualContextMessages(events, runId);
  assert.deepEqual(ids(compared), ['before', 'after']);
  assert.deepEqual(compared[0].message.toolImages, [{ callId: 'call:before', artifactId: 'before' }]);
  const comparison = compose(append, events);
  choose(append, ['missing'], 'failed');
  assert.deepEqual(visualContextMessages(events, runId), compared);
  settle(append, comparison);
  assert.deepEqual(visualContextMessages(events, runId), []);
  choose(append, ['before', 'after']);
  assert.deepEqual(visualContextMessages(events, runId), compared);
  choose(append, []);
  assert.deepEqual(visualContextMessages(events, runId), []);
  assert.equal(imageCatalog(events).size, 4);
});

test('reference images retain their lifetime and unrelated or unsuccessful requests do not consume observations', () => {
  const { events, append } = history();
  observe(append, 'reference', null);
  observe(append, 'screen');
  const rejected = compose(append, events);
  settle(append, rejected, 'failed');
  const review = compose(append, events, 'request:review', 'approvalReview');
  settle(append, review, 'completed', 'approvalReview');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['reference', 'screen']);
  const successful = compose(append, events);
  settle(append, successful);
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['reference']);
  assert.equal(imageCatalog(events).size, 2, 'consumption never deletes archived references');
});

test('only attachments and observations actually selected into a completed request are consumed', () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('initial')] });
  observe(append, 'first');
  const first = compose(append, events);
  append('message.committed', { role: 'user', messageId: 'supplement', filesystemReferences: [file('added')] });
  observe(append, 'second');
  settle(append, first);
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['added', 'second']);
  assert.equal(imageCatalog(events).size, 4);
});

test('explicit GUI rebind clears old observation selection and keeps the archive readable', () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('design')] }, { runId: undefined });
  append('run.started', { inputMessageId: 'input' });
  observe(append, 'old-window');
  append('run.host.rebound', {});
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design']);
  assert.equal(readImageReferences(events, ['old-window']).length, 1);
  observe(append, 'new-window');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'new-window']);
});

test('the Session loop sends attachments and observations once while subsequent history retains their references', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:image-lifetime';
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [], executions = [];
  const tool = { toolBindingRef: 'binding:read', name: 'fs.read', description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    assert.ok(requests.length <= 3);
    if (requests.length < 3) {
      yield providerEvent(request.requestId, 'tool.call', { callId: `native:${requests.length}`, name: 'fs_read',
        input: { workspace: 'primary', path: requests.length === 1 ? 'screen.png' : 'notes.txt' } });
    } else {
      yield providerEvent(request.requestId, 'text.delta', { text: 'Checked the image and notes.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions.push(request);
    return completedExecutionReply(request, executions.length === 1
      ? { modelImages: [{ artifactId: 'artifact:screen', purpose: 'observation' }],
        artifacts: [{ artifactId: 'artifact:screen', uri: 'artifact://screen', label: 'Screen', contentMode: 'fixed' }] }
      : { content: 'Notes contain no images.' });
  } }), fakeRunPreparation({ tools: [tool], contextWindowTokens: 32768 }).port, 'image-lifetime');
  t.after(() => actor.dispose());
  const submitted = await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the screenshot, then read the notes.'),
    filesystemReferences: [{ ...file('design'), byteLength: 8 }] });
  assert.equal(submitted.status, 'accepted');
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.messages.flatMap(message => message.toolImages ?? [])),
    [[], [{ callId: executions[0].callId, artifactId: 'artifact:screen' }], []]);
  assert.deepEqual(requests.map(request => request.messages.flatMap(message => message.images ?? [])),
    [[{ workspaceId: 'input:images', logicalPath: 'design.png', mediaType: 'image/png' }], [], []]);
  assert.ok(requests[2].messages.some(message => message.role === 'tool' && message.content.includes('artifact:screen')));
  assert.ok(requests[2].messages.some(message => message.content.includes('design.png')));
  assert.equal(imageCatalog(await readEvents(journal, sessionId)).size, 2);
});

test('a new run carries references without pixels and can reopen images across a compaction', () => {
  const { events, append } = history();
  observe(append, 'original');
  append('context.compacted', { coveredThroughSequence: events.length, summary: 'Original image is archived.' });
  append('message.committed', { role: 'user', messageId: 'next', content: 'Compare the old image.' }, { runId: 'run:next' });
  append('run.started', { inputMessageId: 'next' }, { runId: 'run:next' });
  assert.deepEqual(visualContextMessages(events, 'run:next'), []);
  const selection = choose(append, ['original']);
  selection.runId = 'run:next';
  assert.deepEqual(ids(visualContextMessages(events, 'run:next')), ['original']);
  assert.throws(() => readImageReferences(events, ['missing']), /session_image_not_found/);
});

test('image reference pages preserve whole source events and explicit selection rejects unavailable references', async () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', filesystemReferences: [file('a'), file('b')] });
  append('message.committed', { role: 'user', filesystemReferences: [file('c'), file('d')] });
  const journal = { async *read() { yield* events; } };
  const first = await readConversation(journal, { sessionId, view: 'images', limit: 1 });
  assert.deepEqual(first.items.map(item => item.imageId), ['c', 'd']);
  const second = await readConversation(journal, { sessionId, view: 'images', before: first.nextBefore, limit: 1 });
  assert.deepEqual(second.items.map(item => item.imageId), ['a', 'b']);
  assert.equal(second.nextBefore, null);
  const selected = await readConversation(journal, { sessionId, view: 'images', imageIds: ['d', 'a'] });
  assert.deepEqual(selected.items.map(item => item.imageId), ['d', 'a']);
  await assert.rejects(readConversation(journal, { sessionId, view: 'images', imageIds: ['unknown'] }), /session_image_not_found/);
  assert.deepEqual(decodeConversationReadQuery({ sessionId, view: 'images', imageIds: [] }).imageIds, []);
  assert.throws(() => decodeConversationReadQuery({ sessionId, view: 'images', imageIds: ['a', 'a'] }), /conversation_read_invalid/);
  assert.throws(() => decodeConversationReadQuery({ sessionId, view: 'images', imageIds: ['a'], before: 3 }), /conversation_read_invalid/);
});

test('retry preserves selected attachment and observation images in the request and replay', async () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('attachment')] }, { runId: undefined });
  append('run.started', { inputMessageId: 'input' });
  observe(append, 'observation');
  const selected = visualContextMessages(events, runId);
  assert.deepEqual(ids(selected), ['attachment', 'observation']);
  const requests = [], facts = [];
  const request = { requestId: 'request:images', sessionId, runId, purpose: 'agent',
    messages: selected.map(contribution => contribution.message) };
  compose(append, events, request.requestId);
  await withProviderAttempts(request, { nextId: kind => `${kind}:${facts.length}`, commit: async event => {
    facts.push(event); append(event.type, event.payload);
  }, updateAssistantDraft() {} },
    new AbortController().signal, async (attempt, completed) => {
      requests.push(structuredClone(attempt));
      if (requests.length === 1) throw new ProviderReportedFailure('provider_network_failed', 'Connection interrupted',
        { source: 'providerTransport', category: 'network', retryable: true });
      completed();
    });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(requests[1].messages.flatMap(message => message.images ?? []),
    [{ workspaceId: 'input:images', logicalPath: 'attachment.png', mediaType: 'image/png' }]);
  assert.deepEqual(requests[1].messages.flatMap(message => message.toolImages ?? []),
    [{ callId: 'call:observation', artifactId: 'observation' }]);
  assert.deepEqual(visualContextMessages(events, runId), selected, 'attempt lifecycle events must not consume the selected images');
  assert.equal(facts.at(-1).payload.phase, 'completed');
  settle(append, request.requestId);
  assert.deepEqual(visualContextMessages(events, runId), []);
});
