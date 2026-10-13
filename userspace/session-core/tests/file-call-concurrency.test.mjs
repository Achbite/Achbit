import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { loopSnapshot, projectSession } from '../dist/index.js';
import { emptyRunLifecycle, reduceRunLifecycle, projectRunLifecycleEvent } from '../dist/local-agent/runLifecycle.js';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding, providerEvent,
  messageCommand, waitForProjection, waitUntil, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const file = { toolBindingRef: 'binding:file', name: 'fs.write', description: 'Write a file', origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['workspaceMutation'], inputSchema: { type: 'object', required: ['path', 'content'],
    properties: { path: { type: 'string' }, content: { type: 'string' } } } };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, name, calls, kernel) {
  const journal = new InMemoryCommandJournal(), sessionId = `session:${name}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [];
  const preparation = fakeRunPreparation({ tools: [file, { ...file, name: 'fs.read', toolBindingRef: 'binding:read',
    possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }],
    contextWindowTokens: 20000 }).port;
  const prepare = preparation.prepare;
  preparation.prepare = async request => {
    const result = await prepare(request);
    return { ...result, runtimeSnapshot: Object.freeze({ ...result.runtimeSnapshot, agentToolsEnabled: true }) };
  };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    assert.equal(request.tools.some(tool => tool.name === 'agent'), false, 'no AgentHost means no callable Agent handler');
    requests.push(request);
    if (requests.length === 1) for (const [index, call] of calls.entries()) {
      const { tool = 'fs_write', ...input } = call;
      yield providerEvent(request.requestId, 'tool.call', { callId: `provider:${index}`, name: tool,
        input: { workspace: 'primary', ...input } });
    } else yield providerEvent(request.requestId, 'assistant.message', { messageId: `answer:${name}`, content: 'Files processed.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, kernel, preparation, name);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, `command:${name}`, 'Apply the file changes.'));
  return { actor, journal, sessionId, requests };
}

test('independent file calls overlap while a successor observes its successful predecessor', async t => {
  const releaseA = gate(), started = [], contents = new Map();
  t.after(() => releaseA.resolve());
  const { actor, journal, sessionId, requests } = await setup(t, 'file-order', [
    { path: 'a', content: 'first' }, { path: 'b', content: 'independent' }, { path: 'a', content: 'second' },
  ], emptyKernel({ async execute(request) {
    const { path, content } = request.input;
    started.push(content);
    if (content === 'first') await releaseA.promise;
    if (content === 'second') assert.equal(contents.get('a'), 'first');
    contents.set(path, content);
    return completedExecutionReply(request, { saved: content });
  } }));
  await waitUntil(() => contents.has('b'), 'B completes while A is still blocked');
  assert.deepEqual(started, ['first', 'independent']);
  assert.equal(contents.has('a'), false);
  assert.equal(requests.length, 1, 'no model turn with incomplete tool results');
  releaseA.resolve();
  const final = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(contents.get('a'), 'second');
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.filter(event => event.type === 'tool.completed').map(event => event.payload.record.input.content),
    ['independent', 'first', 'second']);
  assert.equal(requests[1].messages.filter(message => message.role === 'tool').length, 3);
  assert.deepEqual(projectSession(loopSnapshot(sessionId, events).state), final);
});

test('separate approvals coexist and respond during independent execution; denial blocks only its successor', async t => {
  const releaseC = gate(), effects = [];
  t.after(() => releaseC.resolve());
  const { actor, journal, sessionId, requests } = await setup(t, 'file-approvals', [
    { path: 'a', content: 'a1' }, { path: 'b', content: 'b1' }, { path: 'c', content: 'c1' },
    { path: 'a', content: 'a2' }, { path: 'b', content: 'b2' },
  ], emptyKernel({ async execute(request) {
    const { path, content } = request.input;
    if ((content === 'a1' || content === 'b1') && !request.nonWorkspaceAuthority) return {
      schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId, callId: request.callId,
      status: 'approvalRequired', approvalId: `kernel:${path}`, preview: { summary: path, effects: ['workspaceMutation'], logicalTargets: [path] },
    };
    const reply = completedExecutionReply(request, { saved: content });
    if (request.nonWorkspaceAuthority?.decision === 'deny') {
      reply.status = reply.record.outcome = 'denied'; delete reply.record.output;
      reply.record.authority = { decision: 'deny', source: 'user', authorityId: request.nonWorkspaceAuthority.authorityId };
      return reply;
    }
    if (content === 'c1') await releaseC.promise;
    effects.push(content);
    return reply;
  } }));
  const pending = await waitForProjection(actor, value => value.pendingApprovals?.length === 2);
  assert.equal(pending.run.status, 'running');
  for (const [index, approval] of pending.pendingApprovals.entries()) {
    const result = await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'approval.respond', sessionId,
      commandId: `command:decide:${index}`, runId: approval.runId, callId: approval.callId, approvalId: approval.approvalId,
      decision: approval.preview.summary === 'a' ? 'allow' : 'deny' });
    assert.equal(result.status, 'accepted');
  }
  await waitUntil(() => effects.includes('a2'), 'approved successor executes without waiting for C');
  assert.equal(effects.includes('c1'), false);
  assert.equal(effects.includes('b2'), false);
  assert.equal(requests.length, 1);
  releaseC.resolve();
  const final = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.deepEqual(final.pendingApprovals, []);
  const events = await readEvents(journal, sessionId);
  const skipped = events.find(event => event.type === 'tool.not-executed');
  assert.equal(skipped.payload.reason, 'dependencyFailed');
  const denied = events.find(event => event.type === 'tool.completed' && event.payload.record.outcome === 'denied');
  assert.equal(skipped.payload.predecessorCallId, denied.callId);
  assert.equal(events.filter(event => event.type === 'run.started').length, 1);
  assert.deepEqual(projectSession(loopSnapshot(sessionId, events).state), final);
});

test('an input rejection on permission recheck closes the outstanding approval', async t => {
  let executions = 0;
  const { actor, journal, sessionId } = await setup(t, 'approval-input-rejection', [{ path: 'a', content: 'first' }],
    emptyKernel({ async execute(request) {
      if (++executions === 1) return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution',
        requestId: request.requestId, callId: request.callId, status: 'approvalRequired', approvalId: 'kernel:approval',
        preview: { summary: 'Write a', effects: ['workspaceMutation'], logicalTargets: ['a'] } };
      const rejection = Object.fromEntries(['sessionId', 'runId', 'extensionGenerationRef', 'kernelCatalogSnapshotRef', 'toolBindingRef', 'callId', 'attemptId', 'toolName', 'input'].map(key => [key, request[key]]));
      return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
        callId: request.callId, status: 'inputRejected', rejection: { ...rejection, rejectedAt: '2026-10-13T00:00:00Z',
          error: { code: 'target_changed', message: 'Target no longer accepts the write.', issues: [{ path: '$.path', rule: 'path', message: 'Target changed.' }] } } };
    } }));
  await waitForProjection(actor, value => value.pendingApproval !== null);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'session.permissions.set', sessionId,
    commandId: 'command:change-permission', patches: { 'agent.permissions.shell': 'allow' } });
  await waitForProjection(actor, value => value.run?.status === 'completed');
  const events = await readEvents(journal, sessionId);
  const rejected = events.findIndex(event => event.type === 'tool.input-rejected');
  assert.ok(rejected > 0);
  const boundary = projectSession(loopSnapshot(sessionId, events.slice(0, rejected + 1)).state);
  assert.deepEqual(boundary.pendingApprovals, []);
  assert.equal(boundary.pendingApproval, null);
  assert.equal(boundary.activities.find(activity => activity.kind === 'approval').status, 'cancelled');
  const lifecycle = events.slice(0, rejected + 1).map(projectRunLifecycleEvent).filter(Boolean).reduce(reduceRunLifecycle, emptyRunLifecycle());
  assert.deepEqual(lifecycle.pendingApprovals, []);
});

for (const outcome of ['cancelled', 'indeterminate']) test(`cancel drains every in-flight call, preserves ${outcome}, and marks queued calls unexecuted`, async t => {
  const executions = new Map(), cancellations = [], allCancelled = gate();
  const records = new Map();
  const calls = [...Array.from({ length: 6 }, (_, i) => ({ path: `file-${i}`, content: `${i}` })), { tool: 'fs_read', path: 'later' }];
  const { actor, journal, sessionId } = await setup(t, 'file-cancel', calls,
    emptyKernel({
      async execute(request) {
        const wait = gate(); executions.set(request.callId, { request, wait });
        return await wait.promise;
      },
      async cancel(callId, attemptId) {
        cancellations.push(callId);
        if (cancellations.length === 4) allCancelled.resolve();
        await allCancelled.promise;
        const { request, wait } = executions.get(callId);
        const reply = completedExecutionReply(request, {});
        reply.status = reply.record.outcome = outcome; delete reply.record.output;
        if (outcome === 'indeterminate') reply.record.error = { code: 'tool_effect_outcome_unknown', message: 'Cancellation crossed the effect boundary.' };
        records.set(callId, reply.record); wait.resolve(reply);
        return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.cancelled', requestId: 'cancel:fixture',
          callId, attemptId, status: outcome, record: reply.record };
      },
      async readRecord(callId) { return records.get(callId) ?? null; },
    }));
  await waitUntil(() => executions.size === 4, 'bounded parallel limit');
  const runId = (await actor.snapshot()).run.runId;
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel', sessionId, commandId: 'command:cancel-files', runId });
  const final = await waitForProjection(actor, value => value.run?.status === outcome);
  if (outcome === 'indeterminate') assert.equal(final.terminalError.code, 'tool_effect_outcome_unknown');
  assert.equal(executions.size, 4);
  assert.equal(new Set(cancellations).size, 4);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 4);
  assert.equal(events.filter(event => event.type === 'tool.not-executed' && event.payload.reason === 'cancelled').length, 3);
  assert.equal(events.some(event => event.type === 'tool.interrupted'), false);
});
