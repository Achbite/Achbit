import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitUntil, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const file = (name, mediaType) => ({ referenceId: `reference:${name}`, workspaceId: `input:${name}`,
  logicalPath: name, displayName: name, kind: 'file', mediaType, byteLength: 8 });
const readTool = { toolBindingRef: 'binding:read', name: 'fs.read', description: 'Read a file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
const history = request => request.messages.filter(message => !message.images?.length && !message.toolImages?.length);

test('queued file snapshots join the next request without changing in-flight or historical bindings', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:queued-files';
  await createSession(journal, sessionId, [workspaceBinding]);
  const image = file('screen.png', 'image/png'), text = file('notes.txt', 'text/plain');
  let finishFirst;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  const requests = [], executions = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    const turn = requests.length;
    assert.ok(turn <= 4);
    if (turn === 1) {
      await gate;
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:old', name: 'fs_read', input: { workspace: 'primary', path: 'README.md' } });
    } else if (turn === 2) {
      assert.deepEqual(request.workspaceBindings.map(binding => binding.workspaceId), [workspaceBinding.workspaceId, image.workspaceId, text.workspaceId]);
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
      const screenshot = request.messages.find(message => message.images?.length);
      assert.deepEqual(screenshot.images, [{ workspaceId: image.workspaceId, logicalPath: image.logicalPath, mediaType: image.mediaType }]);
      assert.match(screenshot.content, /"imageId":"reference:screen.png"/);
      assert.ok(history(request).some(message => message.content.includes('"workspace":"workspace2"')));
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:new', name: 'fs_read', input: { workspace: 'workspace3', path: text.logicalPath } });
    } else {
      const calls = request.messages.flatMap(message => message.toolCalls ?? []);
      const inputs = calls.map(call => typeof call.input === 'string' ? JSON.parse(call.input) : call.input);
      assert.deepEqual(inputs.map(input => input.workspace), ['primary', 'workspace3']);
      assert.deepEqual(history(request).slice(0, history(requests[1]).length), history(requests[1]));
      assert.equal(request.messages.filter(message => message.images?.length).length, 0);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Read the supplied screenshot and notes.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions.push(structuredClone(request));
    return completedExecutionReply(request, { content: 'File content.' });
  } }), fakeRunPreparation({ tools: [readTool], contextWindowTokens: 32768 }).port, 'queued-files');
  t.after(async () => { finishFirst(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Inspect this project.'));
  await waitUntil(() => requests.length === 1, 'initial request held');
  const runId = (await actor.snapshot()).run.runId;
  for (const reference of [image, text]) {
    const reply = await actor.submit({ ...messageCommand(sessionId, `command:${reference.referenceId}`, ''), runId, filesystemReferences: [reference] });
    assert.equal(reply.status, 'accepted');
  }
  const queued = await actor.snapshot();
  assert.equal(queued.queuedInputs.length, 2);
  assert.deepEqual(queued.run.workspaceBindings, [workspaceBinding]);
  const directory = await actor.submit({ ...messageCommand(sessionId, 'command:directory', 'Add another project.'), runId,
    filesystemReferences: [{ referenceId: 'directory:other', workspaceId: 'workspace:other', logicalPath: '.', displayName: 'Other project', kind: 'directory' }] });
  assert.equal(directory.status, 'rejected');
  assert.equal(directory.error.code, 'queued_input_runtime_change');
  finishFirst();
  const completed = await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(completed.run.runId, runId);
  assert.deepEqual(executions.map(request => request.workspaceBindings), [[workspaceBinding.workspaceId], [workspaceBinding.workspaceId, image.workspaceId, text.workspaceId]]);
  assert.equal(executions[1].input.workspaceId, text.workspaceId);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.find(event => event.type === 'run.started').payload.workspaceBindings, [workspaceBinding]);
  assert.deepEqual(events.filter(event => event.type === 'context.composed').map(event => event.payload.workspaceBindings.length), [1, 3, 3]);
  // Starting another run must not reinterpret the preceding supplemental messages.
  await actor.submit(messageCommand(sessionId, 'command:next', 'Summarize the same inputs.'));
  await waitForProjection(actor, state => state.run?.status === 'completed' && state.run.runId !== runId);
});
