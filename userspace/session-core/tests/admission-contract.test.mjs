import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_REPLY_VERSION } from '@deepcode/protocol';
import { admitSessionEvents } from '../dist/local-agent/admission.js';
import { loopSnapshot, SessionService } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession, readEvents, runtimeSnapshot } from './local-agent-fixtures.mjs';

const sessionId = 'session:admission';
const runId = 'run:admission';
const event = (type, payload, extra = {}) => ({ type, sessionId, runId, payload, ...extra });
const runtime = runtimeSnapshot(runId);
const started = event('run.started', { inputMessageId: 'message:input', workspaceBindings: [], runtimeSnapshot: runtime });
const composition = event('context.composed', {
  providerRequestId: 'request:one', purpose: 'agent', responseConstraint: 'normal',
  dynamicInstructionBytes: 0, messages: [], workspaceBindings: [], tools: [],
  modelView: { throughSequence: 4, additions: [] },
  partitions: ['instructions', 'sessionControls', 'tools', 'workspaceBindings', 'contextProviders', 'journalMessages', 'filesystemReferences']
    .map((kind) => ({ kind, itemCount: kind === 'instructions' ? 1 : 0, requestShapeUnits: kind === 'instructions' ? 24 : 0 })),
});
const settled = (orderedCallIds = []) => event('provider.turn.settled', {
  outcome: 'completed', providerRequestId: 'request:one', purpose: 'agent',
  providerRuntimeRef: runtime.provider.providerRuntimeRef, orderedCallIds,
});
const finishing = event('run.finishing', { outcome: 'cancelled' });
const queued = event('input.queued', { commandId: 'command:queue', messageId: 'message:queue', text: '补充🙂' });

async function snapshot(...events) {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  await journal.append({ type: 'input.accepted', sessionId,
    payload: { commandId: 'command:input', messageId: 'message:input', text: 'Inspect the source.' } });
  await journal.append({ type: 'message.committed', sessionId,
    payload: { messageId: 'message:input', role: 'user', content: 'Inspect the source.', filesystemReferences: [], pluginSelections: [] } });
  for (const item of events) await journal.append(item);
  return { journal, current: loopSnapshot(sessionId, await readEvents(journal, sessionId)) };
}

test('Session admission rejects late queued input and an unfinished Provider without changing the input snapshot', async () => {
  const initial = await snapshot();
  assert.throws(() => admitSessionEvents(initial.current, [queued]), /session_event_run_not_active/);
  const active = await snapshot(started);
  const missingView = structuredClone(composition);
  delete missingView.payload.modelView;
  assert.throws(() => admitSessionEvents(active.current, [missingView]), /context_model_view_missing/);
  assert.doesNotThrow(() => admitSessionEvents(active.current, [composition]));
  const { current } = await snapshot(started, composition);
  const before = structuredClone(current);
  assert.throws(() => admitSessionEvents(current, [finishing]), /run_finishing_state_invalid/);
  assert.doesNotThrow(() => admitSessionEvents(current, [settled(), finishing]));
  assert.throws(() => admitSessionEvents(current, [settled(), finishing, queued]), /queued_input_run_not_active/);
  assert.deepEqual(current, before, 'a rejected batch cannot mutate the state used by the write owner');
});

test('a session file grant can be revoked across runs only by its original authority and run', async () => {
  const { current } = await snapshot(started);
  const grant = { authorityId: 'authority:session-files', runId: 'run:previous', scope: 'sessionFiles',
    summary: 'Read reference files', context: { fileAccess: { read: ['/references'], write: [] } } };
  current.state.shellAuthorizations = [grant];
  const revoke = event('approval.revoked', { commandId: 'command:revoke', authorityId: grant.authorityId }, { runId: grant.runId });
  assert.doesNotThrow(() => admitSessionEvents(current, [revoke]));
  assert.throws(() => admitSessionEvents(current, [{ ...revoke, runId }]), /approval_grant_missing/);
  assert.throws(() => admitSessionEvents(current, [{ ...revoke, payload: { ...revoke.payload, authorityId: 'authority:unknown' } }]), /approval_grant_missing/);
  assert.throws(() => admitSessionEvents(current, [revoke, revoke]), /approval_grant_missing/);
  current.state.shellAuthorizations = [{ ...grant, scope: 'runFiles' }];
  assert.throws(() => admitSessionEvents(current, [revoke]), /session_event_run_not_active/);
});

const plan = event('plan.published', {
  providerCallId: 'provider:plan', planId: 'plan:one', revision: 1, title: 'Inspect', summary: 'Inspect the source.',
  steps: [{ stepId: 'step:one', title: 'Inspect', details: 'Read the source.' }], mutationManifest: [],
}, { callId: 'call:plan' });

test('Plan response admission requires its matching decision and Todo in one batch; rejected commands are eventless', async () => {
  const { current } = await snapshot(started, composition, plan, settled(['call:plan']));
  const input = { schemaVersion: 'deepcode.command.v3', type: 'plan.respond', sessionId, runId,
    commandId: 'command:confirm', planId: 'plan:one', revision: 1, response: { kind: 'confirm' } };
  const reply = { schemaVersion: COMMAND_REPLY_VERSION, commandId: input.commandId, sessionId, status: 'accepted' };
  const confirmed = event('plan.confirmed', { commandId: input.commandId, planId: 'plan:one', revision: 1,
    decisionId: 'decision:one', authorities: [] }, { callId: 'call:plan' });
  const todos = event('todo.updated', { revision: 1, items: [{ text: 'Inspect', status: 'pending' }] });
  assert.throws(() => admitSessionEvents(current, [], { input, reply }), /plan_command_event_batch_invalid/);
  assert.throws(() => admitSessionEvents(current, [confirmed], { input, reply }), /plan_command_event_batch_invalid/);
  assert.doesNotThrow(() => admitSessionEvents(current, [confirmed, todos], { input, reply }));
  const rejected = { ...reply, status: 'rejected', error: { code: 'plan_not_pending', message: 'No pending Plan.' } };
  assert.doesNotThrow(() => admitSessionEvents(current, [], { input, reply: rejected }));
  assert.throws(() => admitSessionEvents(current, [confirmed], { input, reply: rejected }), /rejected_command_event_batch_invalid/);
});

test('Provider completion must preserve the admitted logical and native call identities', async () => {
  const { current } = await snapshot(started, composition, plan);
  assert.doesNotThrow(() => admitSessionEvents(current, [settled(['call:plan'])]));
  assert.throws(() => admitSessionEvents(current, [settled(['call:invented'])]), /provider_turn_call_order_mismatch/);
  const wrong = settled(['call:plan']);
  wrong.payload.toolCallInputs = [{ callId: 'call:plan', providerCallId: 'provider:wrong', toolName: 'plan.publish', input: {} }];
  assert.throws(() => admitSessionEvents(current, [wrong]), /provider_turn_call_identity_mismatch/);
});

test('reading an inactive history does not open a runtime or append recovery events', async (t) => {
  const { journal, current } = await snapshot(started, composition, plan, settled(['call:plan']), event('run.waiting', { reason: 'plan' }));
  const before = await readEvents(journal, sessionId);
  const service = new SessionService(journal, { async create() { throw new Error('history_must_not_open_runtime'); } });
  t.after(() => service.dispose());
  const projection = await service.snapshot(sessionId);
  assert.equal(projection.pendingPlan.planId, 'plan:one');
  assert.equal(projection.revision, current.state.revision);
  assert.equal(projection.run.status, 'waiting');
  await service.statuses([sessionId]);
  await service.read({ sessionId, view: 'messages' });
  assert.deepEqual(await journal.readCommand(sessionId, 'command:read'), null);
  assert.deepEqual(await readEvents(journal, sessionId), before);
  assert.deepEqual(await service.activity(), { active: false });
});

test('Todo reports require a current Provider run and an atomic Session revision', async () => {
  const { current } = await snapshot(started, composition);
  const update = event('todo.updated', { revision: 1, providerCallId: 'provider:todo',
    items: [{ text: 'Inspect', status: 'inProgress' }] }, { callId: 'call:todo' });
  assert.doesNotThrow(() => admitSessionEvents(current, [update]));
  assert.throws(() => admitSessionEvents(current, [{ ...update, runId: 'run:previous' }]), /session_event_run_not_active/);
  assert.throws(() => admitSessionEvents(current, [{ ...update, payload: { ...update.payload, revision: 2 } }]), /todo_revision_invalid/);
  assert.throws(() => admitSessionEvents(current, [settled(), finishing, update]), /todo_run_not_active|provider_turn_composition_missing/);
  assert.equal(current.state.todoList, null);
});
