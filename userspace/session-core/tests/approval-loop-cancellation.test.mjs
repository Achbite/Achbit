import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { LoopFailure } from '../dist/local-agent/loopFailure.js';
import {
  actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, waitForProjection, completedExecutionReply, readEvents, waitForAbort, cancelNotFound,
} from './local-agent-fixtures.mjs';

const shell = { toolBindingRef: 'binding:shell', name: 'bash', description: 'Run a command', origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['process'], inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const history = { toolBindingRef: 'binding:history', name: 'session.read', description: 'Read session history', origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {
    sessionId: { type: 'string' }, view: { type: 'string' } }, required: ['sessionId'] } };
const operation = { workspaceId: workspaceBinding.workspaceId, workspaceRoot: '/workspace', command: 'make check',
  cwd: '/workspace', environment: { shell: '/bin/bash', executionScope: 'host' }, terminal: null, workspaceMode: 'write', toolName: 'bash' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function preparation(reads) {
  const result = fakeRunPreparation({ tools: [shell, ...(reads ? [history] : [])], permissions: { 'agent.permissions.shell': 'review' } });
  const prepare = result.port.prepare;
  result.port.prepare = async request => {
    const prepared = await prepare(request);
    prepared.runtimeSnapshot.approvalReviewer = { ...prepared.runtimeSnapshot.provider,
      providerRuntimeRef: 'provider-runtime:reviewer', profileId: 'profile:reviewer', contextWindowTokens: 8192, maxOutputTokens: 1024 };
    return prepared;
  };
  return result;
}

function needsReview(request) {
  return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
    callId: request.callId, status: 'approvalRequired', preview: { summary: 'Run make check', effects: ['process'], logicalTargets: ['.'],
      approvalReviewer: 'agent', authorizationContext: operation } };
}

async function decide(actor, sessionId, type) {
  const state = await actor.snapshot();
  if (type === 'run') return actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel',
    sessionId, commandId: 'command:cancel', runId: state.run.runId });
  const approval = state.pendingApproval;
  assert.ok(approval);
  return actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'approval.respond', sessionId,
    commandId: 'command:manual', runId: approval.runId, callId: approval.callId, approvalId: approval.approvalId, decision: 'allow' });
}

for (const withReadTools of [false, true]) test(`manual decision aborts only the active execution reviewer (read tools=${withReadTools})`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:manual-provider-${withReadTools}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const started = deferred();
  let mainTurns = 0, reviews = 0, executed = 0, reviewSignal;
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    if (request.purpose === 'approvalReview') {
      reviews++;
      reviewSignal = signal;
      started.resolve();
      await waitForAbort(signal);
      throw signal.reason;
    }
    assert.equal(signal.aborted, false, 'manual decision must leave the run active');
    if (++mainTurns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'provider:operation', name: 'bash', input: { workspace: 'primary', command: 'make check' } });
    else yield providerEvent(request.requestId, 'assistant.message', { content: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (!request.nonWorkspaceAuthority) return needsReview(request);
    const decision = (await readEvents(journal, sessionId)).find(event => event.type === 'approval.resolved'
      && event.payload.authorityId === request.nonWorkspaceAuthority.authorityId);
    assert.equal(decision.payload.source, 'user');
    executed++;
    return completedExecutionReply(request, { stdout: 'Passed' });
  } }), preparation(withReadTools).port, 'manual-provider');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Run make check.'));
  await started.promise;
  await decide(actor, sessionId, 'manual');
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(reviewSignal.aborted, true);
  assert.equal(reviewSignal.reason.code, 'approval_review_obsolete');
  assert.equal(reviews, 1);
  assert.equal(executed, 1);
  const events = await readEvents(journal, sessionId);
  const settledReview = events.find(event => event.type === 'provider.turn.settled' && event.payload.purpose === 'approvalReview');
  assert.equal(settledReview.payload.outcome, 'cancelled');
  assert.equal(events.filter(event => event.type === 'approval.resolved' && event.payload.source === 'agent').length, 0);
});

for (const stop of ['run', 'manual']) test(`a ${stop} stop closes undispatched review calls without indeterminate outcomes`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:batch-${stop}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const started = deferred(), pendingRead = deferred();
  let mainTurns = 0, reads = 0, executed = 0, reviewRequest;
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    if (request.purpose === 'approvalReview') {
      for (let index = 0; index < 2; index++) yield providerEvent(request.requestId, 'tool.call', {
        callId: `provider:evidence-${index}`, name: 'session_read', input: { sessionId, view: 'messages' } });
    } else if (++mainTurns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'provider:operation', name: 'bash', input: { workspace: 'primary', command: 'make check' } });
    else {
      assert.equal(signal.aborted, false);
      assert.doesNotMatch(JSON.stringify(request.messages), /provider:evidence/);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Done.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (request.toolName === 'session.read') {
      reads++;
      reviewRequest = request;
      started.resolve();
      return pendingRead.promise;
    }
    if (!request.nonWorkspaceAuthority) return needsReview(request);
    executed++;
    return completedExecutionReply(request, { stdout: 'Passed' });
  }, async cancel(callId, attemptId) {
    if (callId !== reviewRequest.callId) return cancelNotFound(callId, attemptId);
    const reply = completedExecutionReply(reviewRequest, {});
    reply.status = reply.record.outcome = 'cancelled';
    delete reply.record.output;
    pendingRead.resolve(reply);
    return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.cancelled', requestId: 'cancel:review',
      callId, attemptId, status: 'cancelled', record: reply.record };
  } }), preparation(true).port, 'review-batch');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Run make check.'));
  await started.promise;
  await decide(actor, sessionId, stop);
  const final = await waitForProjection(actor, state => state.run?.status === (stop === 'run' ? 'cancelled' : 'completed'));
  assert.equal(final.terminalError, null);
  assert.equal(reads, 1);
  assert.equal(executed, stop === 'run' ? 0 : 1);
  const events = await readEvents(journal, sessionId);
  const calls = events.filter(event => event.type === 'tool.requested' && event.payload.toolName === 'session.read');
  assert.equal(calls.length, 2);
  const terminal = calls.map(call => events.find(event => event.callId === call.callId && ['tool.completed', 'tool.not-executed'].includes(event.type)));
  assert.equal(terminal[0].payload.record.outcome, 'cancelled');
  assert.equal(terminal[1].type, 'tool.not-executed');
  assert.equal(terminal[1].payload.reason, 'cancelled');
  assert.equal(events.filter(event => event.type === 'approval.resolved' && event.payload.source === 'agent').length, 0);
});

for (const failure of ['execution', 'cleanup']) test(`an independent ${failure} failure during review cancellation remains a failure`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:review-error-${failure}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const started = deferred(), pendingRead = deferred();
  let readRequest, reads = 0;
  const original = new LoopFailure('review_read_failed', 'Independent read failure.');
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'approvalReview') {
      for (let index = 0; index < 2; index++) yield providerEvent(request.requestId, 'tool.call', {
        callId: `provider:evidence-${index}`, name: 'session_read', input: { sessionId, view: 'messages' } });
    } else yield providerEvent(request.requestId, 'tool.call', {
      callId: 'provider:operation', name: 'bash', input: { workspace: 'primary', command: 'make check' } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (request.toolName !== 'session.read') return needsReview(request);
    reads++;
    readRequest = request;
    started.resolve();
    return pendingRead.promise;
  }, async cancel(callId, attemptId) {
    assert.equal(callId, readRequest.callId);
    if (failure === 'execution') {
      pendingRead.reject(original);
      return cancelNotFound(callId, attemptId);
    }
    pendingRead.resolve(completedExecutionReply(readRequest, {}));
    throw new Error('Independent cancellation cleanup failure.');
  } }), preparation(true).port, 'review-errors');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Run make check.'));
  await started.promise;
  await decide(actor, sessionId, 'run');
  const final = await waitForProjection(actor, state => state.run?.status === 'failed');
  assert.equal(final.terminalError.code, failure === 'execution' ? 'review_read_failed' : 'tool_cancel_cleanup_failed');
  assert.equal(reads, 1);
  const events = await readEvents(journal, sessionId);
  const unstarted = events.find(event => event.type === 'tool.requested' && event.payload.providerCallId === 'provider:evidence-1');
  assert.ok(events.some(event => event.type === 'tool.not-executed' && event.callId === unstarted.callId && event.payload.reason === 'cancelled'));
  assert.equal(events.some(event => event.type === 'run.settled' && event.payload.outcome === 'cancelled'), false);
});
