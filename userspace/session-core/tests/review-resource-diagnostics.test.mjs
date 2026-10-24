import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySessionState } from '../dist/index.js';
import { prepareApprovalReview } from '../dist/local-agent/approvalReview.js';
import { preparePlanReview } from '../dist/local-agent/planReview.js';
import { errorFact } from '../dist/local-agent/loopFailure.js';
import { readConversation } from '../dist/local-agent/conversationRead.js';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

function reviewFixture(command, user = 'Inspect this checkout. Do not modify product files.') {
  const sessionId = 'session:review-budget', runId = 'run:budget', callId = 'call:inspect';
  const operation = { toolName: 'bash', arguments: { command }, executionScope: 'host' };
  const events = [
    { type: 'message.committed', payload: { messageId: 'user:inspect', role: 'user', content: user } },
    { type: 'run.started', runId, payload: { inputMessageId: 'user:inspect' } },
    ...Array.from({ length: 3 }, (_, index) => ({ type: 'tool.completed', runId, payload: { record: {
      recordId: `record:${index}`, callId: `call:${index}`, toolName: 'bash', outcome: 'completed', completedAt: '123',
      input: { command: 'inspect'.repeat(150) }, output: { stdout: 'prior observation '.repeat(400), exitCode: 0 },
    } } })),
    { type: 'tool.completed', runId, payload: { record: { recordId: 'record:read', callId: 'call:read', toolName: 'fs.read', outcome: 'completed', completedAt: '124',
      input: { path: 'long-file.md' }, output: { content: 'prior source '.repeat(400) } } } },
    { type: 'tool.requested', runId, callId, payload: { toolName: 'bash', input: { command, requestHostPermission: 'Inspect the requested environment.' } } },
  ].map((event, index) => ({ ...event, sessionId, sequence: index + 1 }));
  return { snapshot: { events, state: { ...emptySessionState(sessionId), run: { runId, workspaceBindings: [workspaceBinding] } } },
    runtime: runtimeSnapshot(runId), approval: { runId, callId, preview: { operation,
      effects: ['process'], logicalTargets: ['.'], authorizationContext: { command, cwd: '/workspace' } } }, operation, user };
}

test('review budgets optional observations after complete authorization and operation', () => {
  const fixture = reviewFixture('printf inspect; # ' + 'a'.repeat(4000));
  fixture.runtime.provider.contextWindowTokens = 6000;
  const { request } = prepareApprovalReview(fixture.snapshot, fixture.runtime, fixture.approval, 'request:bounded');
  const packet = JSON.parse(request.messages[1].content);
  assert.deepEqual(packet.operation, fixture.operation);
  assert.equal(packet.userMessages[0].content, fixture.user);
  assert.equal(packet.requestedAccess.environment.command, fixture.operation.arguments.command);
  assert.ok(packet.recentObservations.omittedRecords > 0, 'optional evidence is removed instead of failing the entire review');
  assert.ok(request.messages.reduce((size, message) => size + message.content.length, 0) <= 18000);
  assert.equal(fixture.snapshot.events.filter(event => event.type === 'tool.completed').length, 4, 'the journal evidence is never mutated');
});

test('oversized mandatory review material has an approval-specific code and budget diagnosis', () => {
  const fixture = reviewFixture('inspect', 'Required user restriction. '.repeat(1000));
  let failure;
  try { prepareApprovalReview(fixture.snapshot, fixture.runtime, fixture.approval, 'request:too-large'); }
  catch (error) { failure = errorFact(error); }
  assert.equal(failure.code, 'approval_review_context_too_large');
  assert.equal(failure.diagnostics.phase, 'approvalReview');
  assert.match(failure.message, /模型尚未调用/);
  assert.match(failure.diagnostics.causes[0].message, /contextWindowTokens=4096; maxOutputTokens=512/);
});

for (const ordered of [false, true]) test(`provider-turn sibling rejections and Session control limits remain visible without losing a pagination sibling (ordered=${ordered})`, async () => {
  const sessionId = 'session:batch-read', runId = 'run:batch-read';
  const error = { code: 'session_control_turn_conflict', message: 'This control must be submitted alone.', issues: [{ path: '$', rule: 'control_turn', message: 'No calls executed.' }] };
  const calls = ['a', 'b'].map(id => ({ callId: `call:${id}`, providerCallId: `provider:${id}`, toolName: 'todo.update', arguments: '{"items":[]}', error }));
  const events = [
    { type: 'session.created', payload: { displayTitle: 'Batch read', workspaceBindings: [workspaceBinding] } },
    { type: 'session.control.rejected', runId, callId: 'call:limit', payload: { providerCallId: 'provider:limit', toolName: 'agent', input: { action: 'spawn' }, error: { code: 'agent_concurrency_limit', message: 'agent_concurrency_limit' } } },
    { type: 'provider.turn.settled', runId, payload: { providerRequestId: 'request:batch', providerRuntimeRef: 'provider:fixture', purpose: 'agent', outcome: 'completed', orderedCallIds: [], ...(ordered
      ? { orderedOutputBlocks: calls.map((call, outputIndex) => ({ outputIndex, kind: 'toolCallRejected', callId: call.callId, providerCallId: call.providerCallId, toolName: call.toolName, error: call.error,
        item: { type: 'function_call', call_id: call.providerCallId, name: call.toolName, arguments: call.arguments } })) }
      : { toolCallInputs: calls }) } },
  ].map((event, index) => ({ ...event, schemaVersion: 'deepcode.session-event.v5', sessionId, sequence: index + 1, eventId: `event:${index + 1}`, occurredAt: '2026-10-20T00:00:00Z' }));
  const journal = { async *read() { yield* events; } };
  const page = await readConversation(journal, { sessionId, view: 'tools', limit: 1 });
  assert.equal(page.items[0].providerOutcome, 'completed', 'Provider completion is not changed into an execution failure');
  assert.equal(page.items[0].rejectedCallCount, 2);
  assert.deepEqual(JSON.parse(page.items[0].rejectedCalls.content).map(call => [call.callId, call.executed]), [['call:a', false], ['call:b', false]]);
  const previous = await readConversation(journal, { sessionId, view: 'tools', before: page.nextBefore, limit: 1 });
  assert.equal(previous.items[0].toolName, 'agent');
  assert.equal(previous.items[0].executed, false);
  assert.equal(JSON.parse(previous.items[0].error.content).code, 'agent_concurrency_limit');
});

test('tool reads and context reads include rejected input and pre-provider approval failure with original identities', async () => {
  const sessionId = 'session:diagnostic-read', runId = 'run:diagnostic-read';
  const error = { code: 'approval_review_context_too_large', message: 'Required material exceeds budget.',
    diagnostics: { source: 'session', phase: 'approvalReview', category: 'configuration', retryable: false, causes: [{ kind: 'budget', message: 'requiredCharacters=19000; budgetCharacters=18000' }] } };
  const events = [
    { type: 'session.created', payload: { displayTitle: 'Read test', workspaceBindings: [workspaceBinding] } },
    { type: 'tool.input-rejected', runId, callId: 'call:rejected', payload: { rejection: {
      toolName: 'fs.read', input: { path: 42 }, rejectedAt: '123',
      error: { code: 'tool_input_invalid', message: 'path must be a string', issues: [{ path: '$.path', rule: 'type', message: 'Use a string.' }] },
    } } },
    { type: 'approval.reviewed', runId, callId: 'call:review', payload: { approvalId: 'approval:read', providerRequestId: 'request:not-sent', decision: 'ask', reason: error.message, error } },
    { type: 'approval.resolved', runId, callId: 'call:review', payload: { approvalId: 'approval:read', authorityId: 'authority:once', commandId: 'command:allow', decision: 'allow', source: 'user' } },
  ].map((event, index) => ({ ...event, schemaVersion: 'deepcode.session-event.v5', sessionId, sequence: index + 1, eventId: `event:${index + 1}`, occurredAt: '2026-10-20T00:00:00Z' }));
  const journal = { async *read() { yield* events; } };
  const latest = await readConversation(journal, { sessionId, view: 'tools', limit: 1 });
  assert.equal(latest.items[0].type, 'approval.reviewed');
  assert.equal(latest.items[0].contextPrepared, false);
  assert.deepEqual(latest.items[0].review.error, error);
  assert.equal(latest.items[0].resolution.source, 'user');
  const earlier = await readConversation(journal, { sessionId, view: 'tools', before: latest.nextBefore, limit: 1 });
  assert.equal(earlier.items[0].outcome, 'rejected');
  assert.equal(earlier.items[0].executed, false);
  assert.equal(earlier.items[0].callId, 'call:rejected');
  assert.equal(earlier.items[0].recordId, undefined, 'input rejection must not invent an execution record');
  assert.equal(JSON.parse(earlier.items[0].error.content).code, 'tool_input_invalid');
  const context = await readConversation(journal, { sessionId, view: 'context', providerRequestId: 'request:not-sent' });
  assert.equal(context.items[0].contextPrepared, false);
  assert.equal(context.items[0].reviewInput, undefined, 'a failed preparation is not a sent model input');
});

// A configured large reviewer must not inherit the removed fixed 18k character ceiling.
test('review admits complete authorization over 18k when the configured model has capacity', () => {
  const fixture = reviewFixture('inspect', 'Required user restriction. '.repeat(1000));
  fixture.runtime.provider.contextWindowTokens = 131072;
  const { request } = prepareApprovalReview(fixture.snapshot, fixture.runtime, fixture.approval, 'request:large-model');
  assert.ok(request.messages[1].content.length > 18000);
  assert.equal(JSON.parse(request.messages[1].content).userMessages[0].content, fixture.user);
});

test('Plan review uses model capacity while retaining its separate tool-free decision', () => {
  const fixture = reviewFixture('inspect', 'Required user restriction. '.repeat(1000));
  const plan = { runId: fixture.approval.runId, planId: 'plan:budget', revision: 1, title: 'Inspect', summary: 'Review requested files', steps: [], mutationManifest: [], workspaceRequests: [] };
  assert.throws(() => preparePlanReview(fixture.snapshot, fixture.runtime, plan, 'request:small-plan'), error => error.code === 'plan_review_context_too_large');
  fixture.runtime.provider.contextWindowTokens = 131072;
  const { request } = preparePlanReview(fixture.snapshot, fixture.runtime, plan, 'request:large-plan');
  assert.ok(request.messages[1].content.length > 18000);
  assert.deepEqual(request.tools, []);
  assert.equal(request.responseConstraint, 'answerOnly');
  assert.equal(JSON.parse(request.messages[1].content).userMessages[0].content, fixture.user);
});
