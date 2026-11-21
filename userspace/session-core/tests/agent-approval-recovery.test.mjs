import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionActor, SessionService } from '../dist/index.js';
import { readConversation } from '../dist/local-agent/conversationRead.js';
import { loopSnapshot } from '../dist/local-agent/loopFacts.js';
import { reduceSession } from '../dist/local-agent/reducer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { completedExecutionReply, emptyKernel, fakeRunPreparation, messageCommand, providerEvent,
  readEvents, recordedSubagentSettings, singleEvent, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const root = 'session:recovery-owner';
const shell = { name: 'bash', toolBindingRef: 'binding:shell', origin: 'coreBuiltin', availability: 'callable',
  description: 'Run a command.', possibleEffects: ['process'], inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4, maxCallsPerRun: 16,
  maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: false, presets: '[]' };
const model = { profileId: 'profile:default', name: 'Fixture', model: 'fixture-model', reasoningEfforts: ['low', 'medium', 'high'],
  parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000,
    maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null } };
const preparationOptions = { tools: [shell], contextWindowTokens: 100000, permissions: { 'agent.permissions.shell': 'review' }, subagentSettings: settings };

// Generate actual commit boundaries once. Nothing from the live Actors, commands, or Kernel
// adapter survives in the recovered journal except the selected durable event prefixes.
async function recordedFamily(finalReview = 'allow', { finishOnline = false } = {}) {
  const journal = new InMemoryCommandJournal(), done = Promise.withResolvers(), firstWait = Promise.withResolvers();
  let service, childId, gateRequest, publishChild, reviews = 0;
  // Model the journal port's inherited permission publication. The parent command is real;
  // its patch changes the child's effective settings without writing a child lifecycle event.
  const inherited = finalReview === 'inherited', policy = { 'agent.permissions.shell': 'ask' };
  if (inherited) journal.subscribePermissions = (id, publish) => {
    if (id !== root) { publishChild = publish; publish({ ...policy }); }
    return () => {};
  };
  service = new SessionService(journal, { async create({ sessionId }) {
    const creation = (await readEvents(journal, sessionId))[0].payload, prep = fakeRunPreparation(preparationOptions);
    let turns = 0;
    return { composition: { runPreparation: { ...prep.port, async prepare(input) {
      const result = await prep.port.prepare(input);
      result.runtimeSnapshot.agentToolsEnabled = true;
      result.runtimeSnapshot.subagentSettings = await recordedSubagentSettings(journal, sessionId, input.runId);
      if (creation.agentContext) result.runtimeSnapshot.agentCapabilities = creation.agentContext.capabilities;
      return result;
    } }, provider: { async *stream(request) {
      const emit = (type, data) => providerEvent(request.requestId, type, data);
      if (request.purpose === 'approvalReview') {
        reviews++;
        yield emit('assistant.message', { content: !finishOnline && (reviews === 1 || finalReview === 'invalid') ? 'not valid JSON'
          : JSON.stringify({ decision: inherited ? 'allow' : finalReview, reason: 'Reviewed the original check.' }) });
      } else if (++turns === 1 && sessionId === root) {
        yield emit('tool.call', { callId: 'spawn', name: 'agent', input: { action: 'spawn', preset: 'collaboration', name: 'Executor', task: 'Run the check.', delivery: 'wait' } });
      } else if (turns === 1) {
        childId = sessionId;
        yield emit('tool.call', { callId: 'gated', name: 'bash', input: { workspace: 'primary', command: 'printf checked' } });
      } else yield emit('text.delta', { text: 'Check complete.' });
      yield emit('completed', finishOnline && request.purpose === 'approvalReview'
        ? { usage: { inputTokens: 80, outputTokens: 12, contextWindowTokens: preparationOptions.contextWindowTokens } } : {});
    } }, kernel: emptyKernel({ async execute(input) {
      if (input.nonWorkspaceAuthority) return completedExecutionReply(input, { exitCode: 0 });
      gateRequest = structuredClone(input);
      return { schemaVersion: 'achbit.kernel-reply', type: 'tool.execution', requestId: input.requestId, callId: input.callId,
        status: 'approvalRequired', preview: { summary: 'Check', effects: ['process'], logicalTargets: ['.'],
          approvalReviewer: inherited && policy['agent.permissions.shell'] === 'ask' ? 'user' : 'agent',
          reviewPolicy: { subject: 'shell', mode: inherited ? policy['agent.permissions.shell'] : 'review', reviewGrant: 'thisCallOnly' } } };
    } }), async dispose() {} } };
  } }, { async models() { return [model]; }, async settings() { return structuredClone(settings); },
    async createSession(input) { return service.createSession(input); } }, undefined, undefined, {
    accept(input) {
      if (input.kind !== 'event') return;
      const event = input.event;
      if (event.type === 'run.settled' && (event.sessionId === root || event.payload.outcome !== 'completed')) done.resolve(event);
      if (event.type === 'run.waiting' && event.sessionId === childId && event.payload.reason === 'approval') (inherited ? firstWait : done).resolve(event);
      if (inherited && !finishOnline && event.type === 'approval.requested' && event.payload.preview.approvalReviewer === 'agent') done.resolve(event);
    },
    failed(_id, error) { done.reject(error); },
  });
  try {
    await service.createSession({ sessionId: root, displayTitle: 'Owner', workspaceBindings: [workspaceBinding] });
    await service.submit(messageCommand(root, 'command:start', 'Delegate the check and wait.'));
    if (inherited) {
      const waiting = await Promise.race([firstWait.promise, done.promise]);
      assert.equal(waiting.type, 'run.waiting', JSON.stringify(waiting.payload));
      const patch = { 'agent.permissions.shell': 'review' };
      assert.equal((await service.submit({ schemaVersion: 'achbit.command.v3', sessionId: root, type: 'session.permissions.set',
        commandId: 'command:parent-policy', patches: patch })).status, 'accepted');
      Object.assign(policy, patch); publishChild({ ...policy });
    }
    const checkpoint = await done.promise;
    if (finishOnline) {
      assert.equal(checkpoint.payload.outcome, 'completed', JSON.stringify(checkpoint.payload));
      assert.equal(checkpoint.sessionId, root);
      assert.equal(reviews, 1);
    } else if (inherited) assert.equal(checkpoint.type, 'approval.requested', JSON.stringify(checkpoint.payload));
    else {
      assert.equal(checkpoint.type === 'run.settled' ? checkpoint.payload.outcome : checkpoint.payload.reason,
        finalReview === 'allow' ? 'completed' : 'approval', JSON.stringify(checkpoint.payload));
      assert.equal(reviews, 2);
    }
    const owner = await readEvents(journal, root), child = await readEvents(journal, childId);
    return { owner: owner.slice(0, singleEvent(owner, inherited ? 'session.permissions.updated' : 'agent.task.started').sequence),
      child: inherited && !finishOnline ? child.slice(0, checkpoint.sequence) : child, childId, gateRequest };
  } finally { await service.dispose(true); }
}

test('an online inherited policy change reviews the replacement gate and finishes the original child call once', async () => {
  const { child, childId } = await recordedFamily('inherited', { finishOnline: true });
  const gates = child.filter(e => e.type === 'approval.requested');
  assert.deepEqual(gates.map(e => e.payload.preview.approvalReviewer), ['user', 'agent']);
  const [before, after] = gates;
  assert.equal(before.callId, after.callId);
  assert.notEqual(before.payload.approvalId, after.payload.approvalId);
  const request = child.find(e => e.type === 'context.composed' && e.payload.purpose === 'approvalReview');
  const blocked = loopSnapshot(childId, child.slice(0, request.sequence - 1)).state;
  assert.equal(blocked.run.waitingReason, 'approval');
  const ordinary = child.find(e => e.type === 'context.composed' && e.payload.purpose === 'agent');
  assert.throws(() => reduceSession(blocked, { ...ordinary, sequence: request.sequence }), /provider_request_run_not_active/u);
  assert.equal(singleEvent(child, 'context.updated').payload.providerRequestId, request.payload.providerRequestId);
  const resolution = singleEvent(child, 'approval.resolved');
  assert.deepEqual([resolution.runId, resolution.callId, resolution.payload.approvalId, resolution.payload.source],
    [before.runId, before.callId, after.payload.approvalId, 'agent']);
  const effect = singleEvent(child, 'tool.completed');
  assert.equal(effect.callId, before.callId);
  assert.equal(effect.payload.record.outcome, 'completed');
  assert.ok(effect.sequence > resolution.sequence);
  assert.equal(singleEvent(child, 'run.settled').payload.outcome, 'completed');
});

async function restore(t, family, cut, { alreadyHandedOff = false, holdLookup = false, oldWait = false } = {}) {
  const { childId, child, owner } = family, journal = new InMemoryCommandJournal();
  for (const [first, ...rest] of [owner, child.slice(0, cut.sequence)]) {
    await journal.createSession({ sessionId: first.sessionId, ...first.payload });
    await journal.appendBatch(rest);
  }
  const passive = new SessionService(journal, { async create() { assert.fail('A root projection must not reopen the family'); } });
  t.after(() => passive.dispose());
  const before = (await passive.snapshot(root)).pendingAgentDecisions ?? [];
  if (!alreadyHandedOff) assert.deepEqual(before, [], 'history alone is not a recovery handoff');
  const ready = Promise.withResolvers(), lookup = Promise.withResolvers(), release = Promise.withResolvers();
  const executions = [], effects = [], providerCalls = [];
  const runtime = singleEvent(child, 'run.started').payload.runtimeSnapshot;
  const actor = new SessionActor(childId, journal, { runPreparation: { ...fakeRunPreparation(preparationOptions).port, async prepare(input) {
    assert.equal(input.restoreEnvironment, true);
    assert.equal(input.runId, cut.runId);
    return { runtimeSnapshot: structuredClone(runtime) };
  } }, provider: { async *stream(request) {
    providerCalls.push(request);
    yield providerEvent(request.requestId, 'assistant.message', { content: request.purpose === 'approvalReview'
      ? JSON.stringify({ decision: 'ask', reason: 'The original check needs a user decision.' }) : 'Check handled.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, kernel: emptyKernel({ async readRecord() {
    if (holdLookup) { lookup.resolve(); await release.promise; }
    return null;
  }, async execute(input) {
    executions.push(input);
    assert.ok(input.nonWorkspaceAuthority, 'recovery must not re-dispatch the gated call to find another approval');
    const reply = completedExecutionReply(input, { exitCode: 0 }), { decision, authorityId } = input.nonWorkspaceAuthority;
    reply.record.authority = { decision, authorityId, source: 'user' };
    if (decision === 'deny') { reply.status = reply.record.outcome = 'denied'; delete reply.record.output; }
    else effects.push(input.callId);
    return reply;
  } }), async dispose() {} }, { onLoopFinished: () => ready.resolve(), observation: {
    accept(input) { if (input.kind === 'event' && (input.event.type === 'approval.reviewed' && input.event.payload.decision === 'ask'
      || input.event.type === 'run.waiting' && input.event.payload.reason === 'approval')) ready.resolve(); },
    failed(_id, error) { ready.reject(error); },
  } });
  t.after(async () => { release.resolve(); await actor.dispose(); });
  await actor.recover();
  // With an old run.waiting, the regression is that recover() never starts a Loop at all.
  // Drain scheduled in-memory work once rather than waiting forever on its missing event.
  await (oldWait ? new Promise(resolve => setImmediate(resolve)) : holdLookup ? lookup.promise : ready.promise);
  return { actor, passive, journal, before, executions, effects, providerCalls, releaseLookup: release.resolve };
}

test('an inherited policy can leave a replacement automatic approval under an older run.waiting', { timeout: 10_000 }, async t => {
  const original = await recordedFamily('inherited'), { childId, child } = original;
  const gates = child.filter(e => e.type === 'approval.requested'), [old, replacement] = gates, wait = singleEvent(child, 'run.waiting');
  assert.deepEqual(gates.map(e => e.payload.preview.approvalReviewer), ['user', 'agent']);
  assert.equal(old.callId, replacement.callId);
  assert.notEqual(old.payload.approvalId, replacement.payload.approvalId);
  assert.ok(old.sequence < wait.sequence && wait.sequence < replacement.sequence);
  assert.equal(child.some(e => e.type === 'session.permissions.updated' || e.type === 'approval.resolved'), false);
  const { actor, passive, journal, executions, effects } = await restore(t, original, replacement, { oldWait: true });
  const routes = (await passive.snapshot(root)).pendingAgentDecisions ?? [];
  assert.deepEqual(routes.map(r => r.approval), [{ callId: replacement.callId, approvalId: replacement.payload.approvalId }],
    'an older waiting reason must not leave the unreviewed replacement ownerless');
  assert.deepEqual(executions, []);
  assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', sessionId: childId, type: 'approval.respond', runId: replacement.runId,
    ...routes[0].approval, commandId: 'command:replacement', decision: 'deny' })).status, 'accepted');
  const final = await waitForProjection(actor, value => ['completed', 'failed', 'indeterminate'].includes(value.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  const events = await readEvents(journal, childId);
  assert.equal(singleEvent(events, 'approval.reviewed').payload.approvalId, replacement.payload.approvalId);
  assert.equal(singleEvent(events, 'tool.completed').payload.record.outcome, 'denied');
  assert.equal(executions.length, 1);
  assert.deepEqual(effects, []);
});

test('original child runtime recovers from execution review commit boundaries', { timeout: 15_000 }, async t => {
  const family = await recordedFamily(), { child, childId, gateRequest } = family;
  const requested = singleEvent(child, 'approval.requested'), { runId, callId } = requested, { approvalId } = requested.payload;
  const format = child.find(e => e.type === 'approval.reviewed' && e.payload.error?.code === 'approval_review_invalid');
  assert.ok(format && format.sequence > requested.sequence);
  const route = { agentSessionId: childId, displayName: 'Executor', runId, approval: { approvalId, callId }, interactionIds: [] };
  for (const [name, cut, decision] of [['before first review', requested, 'allow'], ['before format correction', format, 'deny']]) {
    await t.test(name, async t => {
      const { actor, passive, journal, executions, effects, providerCalls } = await restore(t, family, cut);
      const routes = (await passive.snapshot(root)).pendingAgentDecisions ?? [];
      assert.deepEqual(routes, [route], 'recover returned without handing the original child approval to a decision maker');
      assert.deepEqual(executions, [], 'no Kernel dispatch before a decision');
      const tail = (await readEvents(journal, childId)).slice(cut.sequence);
      const reviewIds = providerCalls.map(call => call.requestId);
      assert.deepEqual(tail.filter(e => e.type === 'context.composed').map(e => e.payload.providerRequestId), reviewIds);
      assert.deepEqual(tail.filter(e => e.type === 'provider.turn.settled').map(e => e.payload.providerRequestId), reviewIds);
      const handoff = singleEvent(tail, 'approval.reviewed');
      assert.equal(handoff.payload.approvalId, approvalId);
      if (!reviewIds.includes(handoff.payload.providerRequestId)) {
        const detail = await readConversation(journal, { sessionId: childId, view: 'context', providerRequestId: handoff.payload.providerRequestId });
        assert.equal(detail.items[0].contextPrepared, false, 'an interrupted review must not impersonate an earlier Provider request');
        assert.ok(handoff.payload.error, 'preserve the reason for the local handoff');
      }
      assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond', sessionId: routes[0].agentSessionId,
        runId: routes[0].runId, ...routes[0].approval, commandId: 'command:original-decision', decision })).status, 'accepted');
      const final = await waitForProjection(actor, value => ['completed', 'failed', 'indeterminate'].includes(value.run?.status));
      assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
      const events = await readEvents(journal, childId), resolution = singleEvent(events, 'approval.resolved'), record = singleEvent(events, 'tool.completed').payload.record;
      assert.equal(singleEvent(events, 'approval.requested').payload.approvalId, approvalId);
      assert.deepEqual([resolution.callId, resolution.payload.approvalId, resolution.payload.source, resolution.payload.decision], [callId, approvalId, 'user', decision]);
      assert.equal(executions.length, 1);
      for (const key of ['sessionId', 'runId', 'callId', 'attemptId', 'toolBindingRef', 'kernelCatalogSnapshotRef', 'extensionGenerationRef', 'input']) {
        assert.deepEqual(executions[0][key], gateRequest[key], key);
      }
      assert.deepEqual(record.authority, { decision, authorityId: resolution.payload.authorityId, source: 'user' });
      assert.equal(record.outcome, decision === 'allow' ? 'completed' : 'denied');
      assert.deepEqual(effects, decision === 'allow' ? [callId] : []);
      assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions ?? [], []);
      assert.equal((await readEvents(journal, root)).length, family.owner.length, 'recovery and reply wrote only to the child');
    });
  }
  for (const finalReview of ['ask', 'invalid']) await t.test(`preserve final ${finalReview} handoff; original answer during recovery`, async t => {
    const original = await recordedFamily(finalReview), finalAsk = original.child.findLast(e => e.type === 'approval.reviewed');
    assert.equal(finalAsk.payload.decision, 'ask');
    assert.equal(finalAsk.payload.error?.code, finalReview === 'invalid' ? 'approval_review_invalid' : undefined);
    const { actor, journal, before, executions, effects, providerCalls, releaseLookup } = await restore(t, original, finalAsk,
      { alreadyHandedOff: true, holdLookup: finalReview === 'ask' });
    assert.equal(before.length, 1);
    const originalRoute = before[0];
    assert.deepEqual(originalRoute.approval, { callId: finalAsk.callId, approvalId: finalAsk.payload.approvalId });
    assert.deepEqual(executions, []);
    try {
      assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond', sessionId: originalRoute.agentSessionId,
        runId: originalRoute.runId, ...originalRoute.approval, commandId: 'command:existing-ask', decision: 'deny' })).status, 'accepted');
    } finally { releaseLookup(); }
    const final = await waitForProjection(actor, value => ['completed', 'failed', 'indeterminate'].includes(value.run?.status));
    assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
    const events = await readEvents(journal, original.childId);
    assert.deepEqual(events.slice(finalAsk.sequence).filter(e => e.type === 'approval.requested' || e.type === 'approval.reviewed'), []);
    assert.equal(singleEvent(events, 'tool.completed').payload.record.outcome, 'denied');
    assert.equal(providerCalls.some(call => call.purpose === 'approvalReview'), false);
    assert.equal(executions.length, 1);
    assert.deepEqual(effects, []);
  });
  for (const [name, cut, code] of [
    ['composed review without completion', child.find(e => e.type === 'context.composed' && e.payload.purpose === 'approvalReview'), 'provider_turn_outcome_unknown'],
    ['resolved call without Kernel record', singleEvent(child, 'approval.resolved'), 'tool_effect_outcome_unknown'],
  ]) await t.test(name, async t => {
    const { actor, passive, journal, executions, providerCalls } = await restore(t, family, cut);
    const final = await actor.snapshot();
    assert.equal(final.run.status, 'indeterminate');
    assert.equal(final.terminalError.code, code);
    assert.deepEqual(executions, []);
    assert.deepEqual(providerCalls, []);
    assert.equal((await readEvents(journal, childId)).slice(cut.sequence).some(e => e.type === 'approval.reviewed'), false);
    assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions ?? [], []);
  });
});
