import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { DebugObservations } from '../dist/debug/observations.js';
import { providerTextStreamId } from '../dist/local-agent/streamIdentity.js';

const sessionId = 'session:observe', runId = 'run:observe';
const draft = (attempt, content, request = 'request:one') => ({ kind: 'draft', sessionId, draft: {
  runId, turnId: request, providerAttemptId: attempt, blocks: [{ kind: 'message', content,
    streamId: providerTextStreamId(sessionId, runId, request) }],
} });
const event = (sequence, type, payload, extra = {}) => ({ kind: 'event', sessionId, event: {
  schemaVersion: 'achbit.session-event', eventId: `event:${sequence}`, sessionId, runId,
  sequence, type, payload, occurredAt: new Date().toISOString(), ...extra,
} });

test('first text, subsequent tools and next text are pushed as groups without duplicated draft bodies', async t => {
  const frames = [], hub = new DebugObservations(async frame => { frames.push(frame); });
  t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'sub', sessionId });
  hub.accept(event(1, 'provider.attempt.updated', { providerRequestId: 'request:one', providerAttemptId: 'attempt:one', phase: 'started' }));
  hub.accept(draft('attempt:one', 'Start.')); await nextTick();
  assert.equal(frames.length, 1); assert.equal(frames[0].trigger, 'firstText');
  hub.accept(draft('attempt:one', 'Start. More explanation'));
  hub.accept(event(2, 'message.committed', { role: 'assistant', providerRequestId: 'request:one', messageId: 'message:one', content: 'Start. More explanation' }));
  hub.accept(event(3, 'tool.requested', { attemptId: 'tool-attempt:one', toolName: 'fs.read', providerCallId: 'provider:one', input: { path: 'a' } }, { callId: 'call:one' }));
  hub.accept(event(4, 'tool.completed', { record: { recordId: 'record:one', attemptId: 'tool-attempt:one', output: { content: 'File A' } } }, { callId: 'call:one' }));
  await nextTick(); assert.equal(frames.length, 1, 'tools and ongoing prose remain grouped');
  hub.accept(event(5, 'provider.attempt.updated', { providerRequestId: 'request:two', providerAttemptId: 'attempt:two', phase: 'started' }));
  hub.accept(draft('attempt:two', 'Now understood.', 'request:two')); await nextTick();
  assert.equal(frames.length, 2); assert.equal(frames[1].trigger, 'textAfterTools');
  const all = frames.flatMap(frame => frame.items);
  assert.deepEqual(all.filter(item => item.kind === 'text').map(item => item.text), ['Start.', ' More explanation', 'Now understood.']);
  assert.ok(frames[1].items.some(item => item.eventType === 'tool.completed'));
  assert.equal(all.find(item => item.eventType === 'message.committed').payload.content, undefined);
  hub.accept(event(6, 'run.settled', { outcome: 'completed' })); await nextTick();
  assert.equal(frames.at(-1).status, 'settled'); assert.equal(hub.status('sub').status, 'closed');
});

test('tool output ranges survive grouping and retries remain distinct', async t => {
  const frames = [], hub = new DebugObservations(async frame => { frames.push(frame); }); t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'sub', sessionId, inputBudgetTokens: 256 });
  hub.accept(draft('failed-attempt', 'Partial.')); await nextTick();
  hub.accept(draft('retry-attempt', 'Retry.')); await nextTick();
  hub.accept(event(1, 'tool.requested', { attemptId: 'attempt:read', toolName: 'fs.read', input: {}, providerCallId: 'p' }, { callId: 'call:read' }));
  const progress = { kind: 'toolProgress', sessionId, runId, callId: 'call:read', progress: { type: 'output', stream: 'stdout', offset: 0, bytes: Array.from(Buffer.from('x'.repeat(2000))) } };
  hub.accept(progress); hub.accept(progress);
  hub.accept(event(2, 'run.settled', { outcome: 'completed' })); await nextTick();
  const items = frames.flatMap(frame => frame.items);
  assert.deepEqual(items.filter(item => item.kind === 'text').map(item => item.providerAttemptId), ['failed-attempt', 'retry-attempt']);
  assert.equal(items.filter(item => item.kind === 'toolOutput').reduce((n, item) => n + item.bytes.length, 0), 2000);
  assert.ok(frames.some(frame => frame.trigger === 'inputBudget'));
  assert.ok(frames.every(frame => frame.estimatedTokens <= 256));
});

test('one-second first response and 180-second maximum age use independent timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = []; let time = 0;
  const hub = new DebugObservations(async frame => frames.push(frame), () => time); t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'sub', sessionId });
  hub.accept(draft('attempt', 'Incomplete sentence'));
  t.mock.timers.tick(1000); await nextTick(); assert.equal(frames.length, 1);
  hub.accept(event(1, 'tool.requested', { attemptId: 'a', toolName: 'fs.read', input: {} }, { callId: 'c' }));
  time = 180000; t.mock.timers.tick(180000); await nextTick();
  assert.equal(frames.at(-1).trigger, 'maxAge');
});

test('failed delivery reports partial observation without throwing into producers', async t => {
  const hub = new DebugObservations(async () => { throw new Error('receiver closed'); }); t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'sub', sessionId });
  assert.doesNotThrow(() => hub.accept(draft('attempt', 'Start.'))); await nextTick();
  const status = hub.status('sub'); assert.equal(status.status, 'failed'); assert.equal(status.coverage, 'partial');
  assert.equal(status.error.code, 'observation_send_failed');
  assert.doesNotThrow(() => hub.accept(event(1, 'run.settled', { outcome: 'completed' })));
});

test('child decisions push immediately to their task owners without changing parent journal cursors', async t => {
  const frames = [], hub = new DebugObservations(async frame => frames.push(frame)); t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'parent', sessionId, runId });
  hub.subscribe({ subscriptionId: 'other-run', sessionId, runId: 'run:other' });
  hub.subscribe({ subscriptionId: 'unrelated', sessionId: 'session:unrelated' });
  hub.accept(event(10, 'agent.task.created', { taskId: 'task:child', agentSessionId: 'session:child' }));
  const child = event(900, 'interaction.requested', { interactionId: 'question:child', prompt: 'Continue?', mode: 'wait' },
    { sessionId: 'session:child', runId: 'run:child', callId: 'call:question' });
  child.sessionId = 'session:child';
  hub.accept(child); await nextTick();
  assert.equal(frames.length, 0, 'a reserved task without a started child run cannot route decisions');
  hub.accept(event(11, 'agent.task.started', { taskId: 'task:child', childRunId: 'run:child' }));
  hub.accept(child); hub.accept(child); await nextTick();
  assert.equal(frames.length, 1); assert.equal(frames[0].trigger, 'decisionRequired');
  assert.equal(frames[0].subscriptionId, 'parent'); assert.equal(frames[0].lastEventSequence, 11);
  const question = frames[0].items.find(item => item.sourceSessionId === 'session:child');
  assert.equal(question.eventSequence, 900); assert.equal(question.payload.interactionId, 'question:child');
  assert.equal(question.agentRoute[0].taskId, 'task:child'); assert.equal(question.runId, 'run:child');
  hub.accept(event(12, 'agent.task.completed', { taskId: 'task:child' }));
  hub.accept({ ...child, event: { ...child.event, sequence: 901 } }); await nextTick();
  assert.equal(frames.length, 1, 'a completed task no longer routes decisions');
  assert.equal(hub.status('parent').lastEventSequence, 12);
});

test('initial running-task snapshots route nested decisions and preserve references under the input budget', async t => {
  const frames = [], hub = new DebugObservations(async frame => frames.push(frame)); t.after(() => hub.dispose());
  hub.subscribe({ subscriptionId: 'parent', sessionId, runId, inputBudgetTokens: 256 });
  hub.seedTasks({ sessionId, revision: 20, agentTasks: [{ taskId: 't1', agentSessionId: 'child', parentRunId: runId, childRunId: 'child-run', status: 'running' }] });
  hub.seedTasks({ sessionId: 'child', revision: 30, agentTasks: [{ taskId: 't2', agentSessionId: 'grandchild', parentRunId: 'child-run', childRunId: 'grandchild-run', status: 'running' }] });
  const question = event(1, 'approval.requested', { approvalId: 'approval:grandchild', description: 'x'.repeat(5000) },
    { sessionId: 'grandchild', runId: 'grandchild-run', callId: 'call:approval' });
  question.sessionId = 'grandchild'; hub.accept(question); await nextTick();
  assert.equal(frames.length, 1); assert.equal(frames[0].trigger, 'decisionRequired');
  assert.equal(frames[0].lastEventSequence, 0);
  const item = frames[0].items[0]; assert.equal(item.kind, 'eventReference');
  assert.equal(item.sourceSessionId, 'grandchild'); assert.equal(item.eventSequence, 1);
  assert.deepEqual(item.agentRoute.map(route => route.taskId), ['t2', 't1']);
  hub.accept({ ...question, event: { ...question.event, sequence: 2, runId: 'unrelated-run' } }); await nextTick();
  assert.equal(frames.length, 1);
});
