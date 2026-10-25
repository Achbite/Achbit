import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService, loopSnapshot, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, waitForProjection, completedExecutionReply, readEvents, waitForAbort } from '../../session-core/tests/local-agent-fixtures.mjs';
import { decodeGuiProjection } from './gui-projection-contract.mjs';

const tool = (name, properties, effects) => ({ name, toolBindingRef: `binding:${name}`, description: name,
  origin: 'coreBuiltin', availability: 'callable', possibleEffects: effects,
  inputSchema: { type: 'object', properties, required: Object.keys(properties) } });
const shell = tool('bash', { command: { type: 'string' } }, ['process']);
const file = tool('fs.write', { path: { type: 'string' }, content: { type: 'string' } }, ['workspaceMutation']);
const history = tool('session.read', { sessionId: { type: 'string' }, view: { type: 'string' } }, ['localRead']);
const computer = tool('computer.control', { action: { type: 'string' } }, ['external']);

function preparation(tools, review = false) {
  const result = fakeRunPreparation({ tools, contextWindowTokens: 20000, apiSurface: 'responses' });
  if (review) {
    const prepare = result.port.prepare;
    result.port.prepare = async request => {
      const prepared = await prepare(request);
      prepared.runtimeSnapshot.approvalReviewer = { ...prepared.runtimeSnapshot.provider,
        providerRuntimeRef: 'provider-runtime:review', profileId: 'profile:review' };
      return prepared;
    };
  }
  return result.port;
}
function approval(request) {
  return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
    callId: request.callId, status: 'approvalRequired', preview: { summary: 'Review requested operation',
      approvalReviewer: 'agent', effects: ['process'], logicalTargets: ['.'],
      operation: { toolName: request.toolName, arguments: request.input } } };
}
function* call(request, id, name, input, ordered = false, outputIndex = 0) {
  yield providerEvent(request.requestId, ordered ? 'output.item.completed' : 'tool.call', ordered
    ? { outputIndex, item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } }
    : { callId: id, name, input });
}
async function readableHistory(journal, sessionId, projection) {
  assert.deepEqual(await decodeGuiProjection(projection), projection, 'live Session output satisfies GUI contract');
  const events = await readEvents(journal, sessionId);
  const before = structuredClone(events);
  const recovered = projectSession(loopSnapshot(sessionId, events).state);
  assert.deepEqual(await decodeGuiProjection(recovered), recovered);
  const service = new SessionService({ async *read() { yield* events; } }, { async create() { throw new Error('History must not start a run'); } });
  assert.deepEqual(await decodeGuiProjection(await service.snapshot(sessionId)), recovered);
  assert.deepEqual(events, before, 'opening history never repairs or rewrites journal facts');
  return events;
}

for (const mode of ['legacy', 'ordered', 'unavailable', 'rejected']) test(`approval evidence stays readable through Loop, GUI and reopening (${mode})`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:review-projection-${mode}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  let main = 0, reviews = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'approvalReview') {
      if (++reviews === 1) yield* call(request, 'review-evidence', 'session_read',
        { sessionId: mode === 'rejected' ? 'session:other' : sessionId, view: 'messages' }, mode === 'ordered');
      else {
        assert.ok(request.messages.some(message => message.role === 'tool'), 'review consumes its own evidence or rejection');
        yield providerEvent(request.requestId, 'assistant.message', { content: JSON.stringify({ decision: 'allow', reason: 'The requested task is authorized.' }) });
      }
    } else if (++main === 1) yield* call(request, 'main-operation', 'bash', { workspace: 'primary', command: 'printf checked' });
    else {
      assert.doesNotMatch(JSON.stringify(request.messages), /REVIEW_ONLY_EVIDENCE|review-evidence/);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Operation handled.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (request.toolName === 'session.read') return mode === 'unavailable' ? approval(request)
      : completedExecutionReply(request, { content: 'REVIEW_ONLY_EVIDENCE' });
    return request.nonWorkspaceAuthority ? completedExecutionReply(request, { stdout: 'checked' }) : approval(request);
  } }), preparation([shell, history], true), `review-${mode}`);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Execute the requested command.'));
  const final = await waitForProjection(actor, p => ['completed', 'failed'].includes(p.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  const events = await readableHistory(journal, sessionId, final);
  assert.equal(reviews, 2);
  assert.equal(events.filter(e => e.type === 'approval.requested').length, 1);
  assert.equal(final.activities.filter(a => a.label === 'session.read').length, 1);
});

test('independent file calls keep their review turns separate from each other and the main transcript', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:concurrent-review-projection';
  await createSession(journal, sessionId, [workspaceBinding]);
  let startedReviews = 0, main = 0, writes = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'approvalReview') {
      if (!request.messages.some(message => message.role === 'tool')) {
        startedReviews++;
        yield* call(request, `review:${request.requestId}`, 'session_read', { sessionId, view: 'messages' }, true);
      } else yield providerEvent(request.requestId, 'assistant.message', { content: '{"decision":"allow","reason":"Authorized independent write."}' });
    } else if (++main === 1) {
      for (const [index, path] of ['a.txt', 'b.txt'].entries()) yield* call(request, `write:${path}`, 'fs_write', { path, content: path }, true, index);
    } else {
      assert.doesNotMatch(JSON.stringify(request.messages), /REVIEW_ONLY_EVIDENCE/);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Both writes completed.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (request.toolName === 'session.read') return completedExecutionReply(request, { content: 'REVIEW_ONLY_EVIDENCE' });
    if (!request.nonWorkspaceAuthority) return approval(request);
    writes++;
    return completedExecutionReply(request, { saved: true });
  } }), preparation([file, history], true), 'concurrent-review');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Write two independent files.'));
  const final = await waitForProjection(actor, p => ['completed', 'failed'].includes(p.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  assert.equal(writes, 2);
  assert.equal(startedReviews, 2);
  const events = await readableHistory(journal, sessionId, final);
  const readTurns = events.filter(e => e.type === 'provider.turn.settled' && e.payload.purpose === 'approvalReview' && e.payload.orderedCallIds?.length);
  assert.equal(readTurns.length, 2);
  assert.equal(new Set(readTurns.flatMap(e => e.payload.orderedCallIds)).size, 2);
});

test('yielded Shell leaves later calls honestly unexecuted and readable after cancellation', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:yielded-shell-projection';
  await createSession(journal, sessionId, [workspaceBinding]);
  let job, wake = () => {}, turns = 0, executions = 0;
  const finish = () => {
    if (job?.status !== 'active') return;
    job = { ...job, status: 'cancelled', revision: job.revision + 1, completedAt: String(Date.now()),
      error: { code: 'tool_execution_cancelled', message: 'Cancelled by owner.' } };
    wake();
  };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) {
      yield* call(request, 'first', 'bash', { command: 'sleep 120' }, true, 0);
      yield* call(request, 'later', 'bash', { command: 'printf after' }, true, 1);
    } else {
      assert.match(JSON.stringify(request.messages), /dependencyPending/);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Waiting for the first command.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions++;
    job = { jobId: 'job:yielded', sessionId, runId: request.runId, callId: request.callId, revision: 1,
      toolName: 'bash', command: request.input.command, targets: ['.'], status: 'active', startedAt: String(Date.now()),
      output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
    const reply = completedExecutionReply(request, { job });
    reply.record.preparedEffect.operation = 'bash';
    return reply;
  }, async readProcesses(request, signal) {
    if (request.cancel) finish();
    const changed = () => job && request.revisions?.[job.jobId] !== job.revision;
    if (request.waitMs && !changed()) await new Promise(resolve => {
      const done = () => { signal?.removeEventListener('abort', done); if (wake === done) wake = () => {}; resolve(); };
      wake = done; signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
    });
    return changed() ? [structuredClone(job)] : [];
  } }), preparation([shell]), 'yielded-shell');
  t.after(async () => { finish(); wake(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Run the two commands in order.'));
  const active = await waitForProjection(actor, p => p.activities.some(a => a.notExecuted));
  assert.equal(executions, 1);
  assert.deepEqual(await decodeGuiProjection(active), active);
  const skipped = active.activities.find(a => a.notExecuted);
  assert.equal(skipped.notExecuted.reason, 'dependencyPending');
  assert.equal(skipped.tool, undefined);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel', commandId: 'command:stop', sessionId, runId: active.run.runId });
  const final = await waitForProjection(actor, p => p.run?.status === 'cancelled');
  await readableHistory(journal, sessionId, final);
});

for (const selected of [shell, computer]) test(`lost ${selected.name} result preserves unknown outcome and can reopen and continue`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:unknown-${selected.name}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  let turns = 0, executions = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield* call(request, 'lost-result', selected.name.replaceAll('.', '_'),
      selected.name === 'bash' ? { command: 'printf started' } : { action: 'listWindows' });
    else {
      assert.match(JSON.stringify(request.messages), /tool_result_unknown/);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Unknown outcome acknowledged without repeating the tool.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request, onProgress) {
    executions++;
    await onProgress?.({ type: 'started', startedAt: String(Date.now()) });
    throw new Error('Kernel transport disconnected after dispatch');
  } }), preparation([selected]), 'lost-result');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Perform the operation.'));
  const failed = await waitForProjection(actor, p => p.run?.status === 'failed');
  const interrupted = failed.activities.find(a => a.kind === 'tool');
  assert.equal(interrupted.status, 'indeterminate');
  assert.equal(interrupted.interruption.code, 'tool_result_unknown');
  await readableHistory(journal, sessionId, failed);
  await actor.submit(messageCommand(sessionId, 'command:continue', 'Explain the unknown outcome; do not repeat the operation.'));
  const continued = await waitForProjection(actor, p => p.run?.status === 'completed');
  assert.equal(executions, 1);
  await readableHistory(journal, sessionId, continued);
});


test('cancelling a pending execution review closes the approval and keeps its tool unexecuted', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:cancel-review-projection';
  await createSession(journal, sessionId, [workspaceBinding]);
  let reviewStarted;
  const reviewing = new Promise(resolve => { reviewStarted = resolve; });
  let executions = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    if (request.purpose === 'approvalReview') {
      reviewStarted();
      await waitForAbort(signal);
      throw signal.reason;
    }
    yield* call(request, 'awaiting-review', 'bash', { command: 'printf reviewed' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (!request.nonWorkspaceAuthority) return approval(request);
    executions++;
    return completedExecutionReply(request, { stdout: 'reviewed' });
  } }), preparation([shell, history], true), 'cancel-review');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Run the reviewed operation.'));
  await reviewing;
  const pending = await actor.snapshot();
  assert.deepEqual(await decodeGuiProjection(pending), pending);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel',
    commandId: 'command:cancel', sessionId, runId: pending.run.runId });
  const final = await waitForProjection(actor, p => p.run?.status === 'cancelled');
  assert.equal(executions, 0);
  assert.equal(final.pendingApproval, null);
  assert.ok(final.activities.some(a => a.kind === 'approval' && a.status === 'cancelled'));
  assert.equal(final.activities.some(a => ['active', 'requested', 'waiting'].includes(a.status)), false);
  await readableHistory(journal, sessionId, final);
});
