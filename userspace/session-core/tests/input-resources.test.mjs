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

test('queued directories become formal bindings while files and historical request handles remain references', async t => {
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
      assert.deepEqual(request.workspaceBindings.map(binding => binding.workspaceId), [workspaceBinding.workspaceId, image.workspaceId, text.workspaceId, 'workspace:other']);
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
  const directory = await actor.submit({ ...messageCommand(sessionId, 'command:directory', 'Use this directory as a reference and modification target.'), runId,
    filesystemReferences: [{ referenceId: 'directory:other', workspaceId: 'workspace:other', logicalPath: '.', displayName: 'Other project', kind: 'directory' }] });
  assert.equal(directory.status, 'accepted');
  assert.deepEqual((await actor.snapshot()).run.workspaceBindings, [workspaceBinding]);
  finishFirst();
  const completed = await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(completed.run.runId, runId);
  const bound = [workspaceBinding, { workspaceId: 'workspace:other', displayName: 'Other project' }];
  assert.deepEqual(completed.run.workspaceBindings, bound);
  assert.deepEqual(completed.workspaceBindings, bound);
  assert.deepEqual(executions.map(request => request.workspaceBindings), [[workspaceBinding.workspaceId], [workspaceBinding.workspaceId, image.workspaceId, text.workspaceId, 'workspace:other']]);
  assert.equal(executions[1].input.workspaceId, text.workspaceId);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.find(event => event.type === 'run.started').payload.workspaceBindings, [workspaceBinding]);
  assert.deepEqual(events.filter(event => event.type === 'session.directory-index.attached').map(event => event.payload.workspaceBinding), bound.slice(1));
  assert.deepEqual(events.filter(event => event.type === 'context.composed').map(event => event.payload.workspaceBindings.length), [1, 4, 4]);
  // Starting another run must not reinterpret the preceding supplemental messages.
  await actor.submit(messageCommand(sessionId, 'command:next', 'Summarize the same inputs.'));
  const next = await waitForProjection(actor, state => state.run?.status === 'completed' && state.run.runId !== runId);
  assert.deepEqual(next.run.workspaceBindings, bound);
  assert.equal((await readEvents(journal, sessionId)).filter(event => event.type === 'session.directory-index.attached').length, 1);
});

const directory = { referenceId: 'reference:project', workspaceId: 'workspace:added', logicalPath: '.', displayName: 'Added project', kind: 'directory' };
const planFor = workspace => ({ title: 'Update supplied project', summary: 'Write the requested result.',
  steps: [{ stepId: 'write', title: 'Write', details: 'Create the result after confirmation.' }],
  mutationManifest: [{ operation: 'fs.write', workspace, target: 'result.txt' }] });

test('initial directories bind before run start and Plan still waits for confirmation; file parents stay unbound', async t => {
  for (const reference of [directory, { ...file('input.txt', 'text/plain'), workspaceId: 'workspace:file-parent' }]) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:initial-${reference.kind}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    let turns = 0, admissions = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      if (++turns === 1) {
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:plan', name: 'plan_publish', input: planFor('workspace2') });
      } else {
        assert.equal(turns, 2);
        yield providerEvent(request.requestId, 'text.delta', { text: 'Binding outcome recorded.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } }, emptyKernel({ async planAdmission(request) {
      admissions++;
      assert.equal(request.mutationManifest[0].workspaceId, reference.workspaceId);
      return { source: 'user', authorities: [], ...(reference.kind === 'file'
        ? { workspaceRequests: [{ workspaceId: reference.workspaceId, rootPath: '/fixture/file-parent' }] } : {}) };
    } }), fakeRunPreparation().port, `initial-${reference.kind}`);
    t.after(() => actor.dispose());
    await actor.submit({ ...messageCommand(sessionId, 'command:input', 'Work on this input.'), filesystemReferences: [reference] });
    const waiting = await waitForProjection(actor, value => value.pendingPlan !== null);
    if (reference.kind === 'directory') {
      assert.equal(waiting.activePlanRef, null);
      assert.deepEqual(waiting.run.workspaceBindings.map(x => x.workspaceId), [workspaceBinding.workspaceId, directory.workspaceId]);
      const plan = waiting.pendingPlan;
      await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond', sessionId,
        commandId: 'command:confirm', runId: plan.runId, planId: plan.planId, revision: plan.revision, response: { kind: 'confirm' } });
    } else {
      assert.deepEqual(waiting.pendingPlan.workspaceRequests, [{ workspaceId: reference.workspaceId, rootPath: '/fixture/file-parent' }]);
      assert.equal(waiting.workspaceBindings.some(binding => binding.workspaceId === reference.workspaceId), false);
      const plan = waiting.pendingPlan;
      const refused = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond', sessionId,
        commandId: 'command:unbound-confirm', runId: plan.runId, planId: plan.planId, revision: plan.revision, response: { kind: 'confirm' } });
      assert.equal(refused.status, 'rejected');
      assert.equal(refused.error.code, 'plan_workspace_binding_required');
      await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond', sessionId,
        commandId: 'command:cancel', runId: plan.runId, planId: plan.planId, revision: plan.revision, response: { kind: 'cancel' } });
    }
    const completed = await waitForProjection(actor, value => value.run?.status === (reference.kind === 'file' ? 'cancelled' : 'completed'));
    assert.equal(admissions, 1);
    assert.equal(completed.workspaceBindings.some(x => x.workspaceId === reference.workspaceId), reference.kind === 'directory');
    const events = await readEvents(journal, sessionId);
    assert.deepEqual(events.find(event => event.type === 'run.started').payload.workspaceBindings, completed.workspaceBindings);
    assert.equal(events.filter(event => event.type === 'session.control.rejected').length, 0);
  }
});

test('explicit directory attachment updates the active run without changing the in-flight tool snapshot', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:explicit-directory';
  await createSession(journal, sessionId, [workspaceBinding]);
  const release = Promise.withResolvers(), requests = [], executions = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await release.promise;
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:old', name: 'fs_read', input: { path: 'README.md' } });
    } else {
      assert.deepEqual(request.workspaceBindings.map(x => x.workspaceId), [workspaceBinding.workspaceId, directory.workspaceId]);
      yield providerEvent(request.requestId, 'text.delta', { text: 'New directory is bound.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions.push(request);
    return completedExecutionReply(request, { content: 'Original project.' });
  } }), fakeRunPreparation({ tools: [readTool] }).port, 'explicit-directory');
  t.after(async () => { release.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Read the project.'));
  await waitUntil(() => requests.length === 1, 'first request held');
  const reply = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.attach', sessionId,
    commandId: 'command:attach', workspaceBinding: { workspaceId: directory.workspaceId, displayName: directory.displayName } });
  assert.equal(reply.status, 'accepted');
  assert.equal((await actor.snapshot()).run.workspaceBindings.length, 2);
  release.resolve();
  await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.deepEqual(executions[0].workspaceBindings, [workspaceBinding.workspaceId]);
  const ended = (await actor.snapshot()).run.workspaceBindings;
  await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.detach', sessionId,
    commandId: 'command:detach', workspaceId: directory.workspaceId });
  assert.deepEqual((await actor.snapshot()).workspaceBindings, [workspaceBinding]);
  assert.deepEqual((await actor.snapshot()).run.workspaceBindings, ended, 'later detach must not rewrite a completed run');
});

test('Kernel Plan binding rejection retains its structured error and does not fail the whole Loop', async t => {
  const { HttpKernelPort } = await import('../dist/local-agent/httpPorts.js');
  const port = new HttpKernelPort({ apiBase: 'http://fixture.invalid', serviceToken: 'fixture', fetchImpl: async () =>
    new Response(JSON.stringify({ ok: false, error: 'plan_workspace_binding_invalid', message: 'Directory was detached before admission.' }), { status: 400 }) });
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plan-binding-rejected';
  await createSession(journal, sessionId, [workspaceBinding]);
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:plan', name: 'plan_publish', input: planFor('primary') });
    else {
      assert.equal(turns, 2);
      assert.match(JSON.stringify(request.messages), /Directory was detached before admission/);
      yield providerEvent(request.requestId, 'text.delta', { text: 'The Plan was rejected without execution.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ planAdmission: request => port.planAdmission(request) }), fakeRunPreparation().port, 'plan-rejected');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Prepare the Plan.'));
  const completed = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(completed.terminalError, null);
  const events = await readEvents(journal, sessionId);
  const rejected = events.find(event => event.type === 'session.control.rejected');
  assert.equal(rejected.payload.error.code, 'plan_workspace_binding_invalid');
  assert.equal(rejected.payload.error.message, 'Directory was detached before admission.');
  assert.equal(events.some(event => event.type === 'plan.published'), false);
});
