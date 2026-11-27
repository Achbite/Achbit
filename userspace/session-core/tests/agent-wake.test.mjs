import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCapabilities, SessionService } from '../dist/index.js';
import { runAgentLoop } from '../dist/local-agent/loop.js';
import { SessionCapabilityManager } from '../dist/local-agent/sessionCapabilities.js';
import { messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  completedExecutionReply, emptyKernel, failedExecutionReply, fakeRunPreparation, forwardingJournal, messageCommand, providerEvent, readEvents,
  recordedSubagentSettings, waitUntil, workspaceBinding,
} from './local-agent-fixtures.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'indeterminate']);
const textOf = request => JSON.stringify(request.messages);
const occurrences = (text, value) => text.split(value).length - 1;
const call = (request, callId, name, input) => providerEvent(request.requestId, 'tool.call', { callId, name, input });
const done = request => providerEvent(request.requestId, 'completed', {});
const answer = (request, text) => providerEvent(request.requestId, 'text.delta', { text });
const subagentSettingsCommand = (sessionId, commandId, settings) => ({
  schemaVersion: 'achbit.command.v3', type: 'session.subagent-settings.set', sessionId, commandId, settings,
});

async function serviceFixture(t, ownerId, stream, options = {}) {
  const journal = options.journal ?? new InMemoryCommandJournal();
  const requests = new Map(), preparations = new Map(), disposed = new Map(), releases = new Map();
  let service, defaultReads = 0;
  const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
    maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: false, presets: '[]', ...options.settings };
  service = new SessionService(journal, { async create({ sessionId }) {
    const preparation = fakeRunPreparation({ contextWindowTokens: 100_000, ...options.preparation });
    return { composition: {
      kernel: options.kernel?.({ sessionId, journal }) ?? emptyKernel(),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
      runPreparation: { ...preparation.port, async release(input) {
        await options.beforeRelease?.(input);
        const receipt = await preparation.port.release(input);
        releases.set(sessionId, (releases.get(sessionId) ?? 0) + 1);
        return receipt;
      }, async prepare(input) {
        const prepared = await preparation.port.prepare(input);
        prepared.runtimeSnapshot.subagentSettings = await recordedSubagentSettings(journal, sessionId, input.runId);
        prepared.runtimeSnapshot.agentToolsEnabled = true;
        const creation = (await readEvents(journal, sessionId))[0];
        if (creation.payload.agentContext) prepared.runtimeSnapshot.agentCapabilities = creation.payload.agentContext.capabilities;
        const inputs = preparations.get(sessionId) ?? [];
        inputs.push(structuredClone(input));
        preparations.set(sessionId, inputs);
        return prepared;
      } },
      provider: { async *stream(request, signal) {
        const history = requests.get(sessionId) ?? [];
        history.push(structuredClone(request));
        requests.set(sessionId, history);
        yield* stream({ sessionId, request, signal, service, journal, turn: history.length });
      } },
      async dispose() { disposed.set(sessionId, (disposed.get(sessionId) ?? 0) + 1); },
    } };
  } }, {
    async settings() { defaultReads++; return structuredClone(settings); },
    async models() { return options.models ? options.models() : [
      { profileId: 'profile:default', name: 'Default', model: 'fixture-model', parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['low', 'medium', 'high'] },
      { profileId: 'profile:chosen', name: 'Chosen model', model: 'chosen-model', parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['high'] },
    ]; },
    async createSession(input) { await options.beforeCreate?.(input); return service.createSession(input); },
  }, options.configurations, options.loops);
  t.after(() => service.dispose());
  if (!options.reopen) await service.createSession({ sessionId: ownerId, displayTitle: 'Wake owner', workspaceBindings: [workspaceBinding], ...(options.recipe ? { recipe: options.recipe } : {}) });
  return { journal, service, requests, preparations, disposed, releases, settings, get defaultReads() { return defaultReads; } };
}

// T-022/最简Loop工具集/实施/子代理增额/TCR.md: verify the real Session admission and review boundaries.
for (const scenario of ['allow', 'deny', 'ask', 'invalid', 'manual']) test(`subagent capacity: ${scenario} reviews the exact dispatch before startup`, async t => {
  const ownerId = `session:capacity-${scenario}`, requests = [], childInputs = [], round = { main: 0 };
  const permissions = { 'agent.permissions.shell': scenario === 'manual' ? 'ask' : 'review',
    'agent.permissions.shellAccess': 'workspace', 'agent.permissions.networkRead': 'allow', 'agent.permissions.external': 'review' };
  const fixture = await serviceFixture(t, ownerId, async function* ({sessionId, request}) {
    if (sessionId !== ownerId) { childInputs.push(sessionId); yield answer(request, 'Verified the subtask.'); }
    else if (request.purpose === 'approvalReview') {
      requests.push(request);
      assert.equal(childInputs.length, 1, 'only the original child exists while reviewing');
      assert.deepEqual(request.tools, []); assert.deepEqual(request.hostedTools, []);
      assert.equal(request.responseFormat.name, 'subagent_capacity_decision');
      const evidence = JSON.parse(request.messages.at(-1).content);
      assert.equal(evidence.grant, 'thisDispatchOnly');
      assert.equal(evidence.operation.requestCapacity, 'A second independent check is needed.');
      assert.ok(evidence.userMessages.some(item=>item.content.includes('Check both stations')));
      assert.deepEqual(evidence.capacity.needs.map(item=>item.resource).sort(), ['callsThisRun','openMembers']);
      yield answer(request, scenario === 'invalid' ? '{"decision":"allow"}' : JSON.stringify({decision:scenario,reason:'Independent review of both checks.'}));
    } else if (++round.main === 1) {
      yield call(request, 'one', 'agent', {action:'spawn',name:'First',task:'Read station A',delivery:'wait'});
    } else if (round.main === 2) {
      yield call(request, 'two', 'agent', {action:'spawn',name:'Second',task:'Read station B',delivery:'wait',requestCapacity:'A second independent check is needed.'});
    } else {
      assert.equal(round.main, 3);
      const result = JSON.parse(request.messages.find(m=>m.role==='tool' && m.providerCallId==='two').content);
      if (scenario==='deny') { assert.equal(result.executed,false); assert.equal(result.status,'denied'); }
      else { assert.equal(result.outcome,'completed'); assert.ok(result.taskId); }
      yield answer(request, 'Station review finished.');
    }
    yield done(request);
  }, {settings:{maxConcurrent:1,maxMembersPerSession:1,maxCallsPerRun:1},recipe:{permissions}});
  await fixture.service.submit(messageCommand(ownerId, 'capacity:start', 'Check both stations independently.'));
  if (['ask','invalid','manual'].includes(scenario)) {
    await waitUntil(async () => (await fixture.service.snapshot(ownerId)).run?.waitingReason==='approval','capacity human fallback');
    const state = await fixture.service.snapshot(ownerId), gate = state.pendingApproval;
    assert.equal(state.agentTasks.length,1); assert.ok(gate); assert.equal(gate.preview.reviewPolicy.subject,'subagentCapacity');
    assert.equal(gate.preview.authorizationScopes,undefined);
    if (scenario!=='manual') assert.equal(gate.preview.review.decision,'ask');
    const cmd = {schemaVersion:'achbit.command.v3',type:'approval.respond',sessionId:ownerId,commandId:'capacity:human',runId:state.run.runId,callId:gate.callId,approvalId:gate.approvalId,decision:'allow'};
    assert.equal((await fixture.service.submit(cmd)).status,'accepted');
    assert.equal((await fixture.service.submit(cmd)).status,'replayed');
  }
  const state=await completed(fixture.service,ownerId);
  const events=await readEvents(fixture.journal,ownerId);
  assert.equal(requests.length,scenario==='manual'?0:1);
  assert.equal(state.agentTasks.length,scenario==='deny'?1:2);
  assert.equal(events.filter(e=>e.type==='approval.requested').length,1);
  const decision=events.find(e=>e.type==='approval.resolved');
  assert.equal(decision.payload.source,['allow','deny'].includes(scenario)?'agent':'user');
  assert.ok(events.filter(e=>e.type==='agent.task.created' && e.callId===decision.callId).every(e=>e.sequence>decision.sequence));
  assert.equal(state.shellAuthorizations?.length ?? 0,0);
});

const capacityPermissions = { 'agent.permissions.shell': 'review', 'agent.permissions.shellAccess': 'workspace',
  'agent.permissions.networkRead': 'allow', 'agent.permissions.external': 'review' };
const capacitySpawn = (name, delivery = 'wait') => ({ action: 'spawn', name, task: `Verify ${name}.`, delivery,
  requestCapacity: `An independent check of ${name} cannot reuse the first checker.` });
const capacityDecision = (state, gate, decision) => ({ schemaVersion: 'achbit.command.v3', type: 'approval.respond',
  sessionId: state.sessionId, runId: state.run.runId, callId: gate.callId, approvalId: gate.approvalId,
  commandId: `answer:${gate.approvalId}`, decision });

// Copy actual journal boundaries, not a live Actor, a fabricated grant or a restarted Provider turn.
test('subagent capacity: recover the original review and dispatch without replaying side effects', { timeout: 30_000 }, async t => {
  const root = 'session:capacity-recovery', options = { settings: { maxMembersPerSession: 1 }, recipe: { permissions: capacityPermissions } };
  const live = await serviceFixture(t, root, async function* ({ sessionId, request }) {
    if (sessionId !== root) yield answer(request, 'Child evidence.');
    else if (request.purpose === 'approvalReview') yield answer(request, JSON.stringify({ decision: 'allow', reason: 'Independent check requested.' }));
    else if (!request.messages.some(m => m.providerCallId === 'first')) yield call(request, 'first', 'agent', capacitySpawn('First'));
    else if (!request.messages.some(m => m.providerCallId === 'second')) yield call(request, 'second', 'agent', capacitySpawn('Second'));
    else yield answer(request, 'All checks complete.');
    yield done(request);
  }, options);
  await live.service.submit(messageCommand(root, 'capacity:record', 'Check the two stations independently.'));
  const finished = await completed(live.service, root), parent = await readEvents(live.journal, root);
  const children = await Promise.all(finished.agentTasks.map(task => readEvents(live.journal, task.agentSessionId)));
  const ticket = parent.find(e => e.type === 'agent.control.completed' && e.payload.result.status === 'capacityRequested');
  const gate = parent.find(e => e.type === 'approval.requested');
  const review = parent.find(e => e.type === 'context.composed' && e.payload.purpose === 'approvalReview');
  const reviewedTurn = parent.find(e => e.type === 'provider.turn.settled' && e.payload.purpose === 'approvalReview');
  const resolution = parent.find(e => e.type === 'approval.resolved');
  const reserve = parent.find(e => e.type === 'agent.task.created' && e.callId === ticket.callId);
  const started = parent.find(e => e.type === 'agent.task.started' && e.payload.taskId === reserve.payload.taskId);
  const settled = parent.find(e => e.type === 'agent.capacity.settled');
  const { admitSessionEvents } = await import('../dist/local-agent/admission.js');
  const { loopSnapshot } = await import('../dist/local-agent/loopFacts.js');
  const at = e => loopSnapshot(root, parent.slice(0, e.sequence));
  assert.throws(() => admitSessionEvents(at(gate), [reserve]), /agent_capacity_dispatch_mismatch/);
  assert.throws(() => admitSessionEvents(at(gate), [settled]), /agent_capacity_result_mismatch/);
  assert.throws(() => admitSessionEvents(at(settled), [reserve]), /agent_capacity_already_settled/);
  for (const [label, cut, childEvidence] of [
    ['requested', gate], ['interrupted review', review], ['reply not decided', reviewedTurn], ['approved', resolution],
    ['reservation before child exists', reserve], ['unused child session', reserve, 'empty'],
    ['child committed before parent start acknowledgement', reserve, 'complete'],
    ['cannot verify child startup', reserve, 'unreadable'], ['started', started, 'complete'], ['acknowledged', settled, 'complete'],
  ]) await t.test(label, async t => {
    const j = new InMemoryCommandJournal();
    for (const history of [parent.slice(0, cut.sequence), children[0], ...(childEvidence ? [childEvidence === 'empty' ? children[1].slice(0, 1) : children[1]] : [])]) {
      const [first, ...rest] = history;
      await j.createSession({ sessionId: first.sessionId, ...first.payload }); await j.appendBatch(rest);
    }
    const childId = reserve.payload.agentSessionId;
    if (childEvidence === 'unreadable') {
      const read = j.read.bind(j);
      j.read = async function* (id, ...args) { if (id === childId) throw new Error('child journal unavailable'); yield* read(id, ...args); };
    }
    let reviews = 0, creations = 0;
    const recovered = await serviceFixture(t, root, async function* ({ sessionId, request }) {
      if (request.purpose === 'approvalReview') { reviews++; yield answer(request, JSON.stringify({ decision: 'allow', reason: 'Original check required.' })); }
      else if (sessionId !== root) yield answer(request, 'Child evidence.');
      else {
        const replies = request.messages.filter(m => m.role === 'tool' && m.providerCallId === 'second');
        assert.equal(replies.length, 1);
        const result = JSON.parse(replies[0].content);
        if (cut === reserve && (!childEvidence || childEvidence === 'empty')) {
          assert.equal(result.executed, false); assert.equal(result.status, 'notStarted');
        } else assert.equal(result.outcome, 'completed', replies[0].content);
        yield answer(request, 'Original checks accounted for.');
      }
      yield done(request);
    }, { ...options, journal: j, reopen: true, beforeCreate() { creations++; } });
    // An operator command reopens the Actor; reading archive projections by itself must not resume work.
    await recovered.service.submit({ schemaVersion: 'achbit.command.v3', type: 'session.mode.set', sessionId: root, mode: 'full', commandId: 'recover' });
    if (cut === review || cut === reviewedTurn) {
      await waitUntil(async () => {
        const state = await recovered.service.snapshot(root);
        assert.ok(!terminal.has(state.run.status), JSON.stringify(state.terminalError));
        return state.pendingApproval?.preview.review?.decision === 'ask';
      }, 'human handoff for the interrupted budget-only review');
      const state = await recovered.service.snapshot(root);
      assert.equal(state.pendingApproval.approvalId, gate.payload.approvalId); assert.equal(creations, 0);
      assert.equal((await recovered.service.submit(capacityDecision(state, state.pendingApproval, 'allow'))).status, 'accepted');
    }
    if (childEvidence === 'unreadable') {
      await waitUntil(async () => (await readEvents(j, root)).some(e => e.type === 'run.runtime.release_failed'), 'unconfirmed cleanup reported');
      const history = await readEvents(j, root);
      assert.equal(history.find(e => e.type === 'run.finishing').payload.outcome, 'indeterminate');
      assert.equal(history.some(e => e.type === 'run.runtime.released' || e.type === 'agent.capacity.settled'), false);
      assert.equal(creations, 0);
      // After the journal becomes readable, a new service can finish cleanup without waiting on its own opening Actor.
      const repaired = new InMemoryCommandJournal();
      for (const [first, ...rest] of [history, ...children]) {
        await repaired.createSession({ sessionId: first.sessionId, ...first.payload }); await repaired.appendBatch(rest);
      }
      const retry = await serviceFixture(t, root, async function* () { assert.fail('cleanup must not call a Provider'); },
        { ...options, journal: repaired, reopen: true, beforeCreate() { assert.fail('cleanup must not create a child'); } });
      await retry.service.submit({ schemaVersion: 'achbit.command.v3', type: 'session.mode.set', sessionId: root, mode: 'full', commandId: 'retry-cleanup' });
      const closed = await readEvents(repaired, root);
      assert.equal(closed.find(e => e.type === 'run.settled').payload.outcome, 'indeterminate');
      assert.equal(closed.filter(e => e.type === 'agent.task.created' && e.callId === ticket.callId).length, 1);
      assert.equal(closed.filter(e => e.type === 'run.runtime.released').length, 1); return;
    }
    await completed(recovered.service, root);
    const after = await readEvents(j, root), newTask = after.filter(e => e.type === 'agent.task.created' && e.callId === ticket.callId);
    assert.equal(reviews, cut === gate ? 1 : 0); assert.equal(creations, cut.sequence < reserve.sequence ? 1 : 0);
    assert.equal(newTask.length, 1); assert.equal(after.filter(e => e.type === 'agent.capacity.settled').length, 1);
    assert.equal(after.filter(e => e.type === 'approval.resolved').length, 1);
    assert.equal(after.filter(e => e.type === 'agent.task.completed' && e.payload.taskId === newTask[0].payload.taskId).length, 1);
    if (cut === review) assert.equal(after.find(e => e.type === 'provider.turn.settled' && e.payload.purpose === 'approvalReview').payload.outcome, 'indeterminate');
  });
});

for (const mode of ['compete', 'release', 'cancel']) test(`subagent capacity: fifth member at defaults, ${mode}`, async t => {
  const root = `session:capacity-five-${mode}`, release = Promise.withResolvers();
  let round = 0, nextRun = false;
  const fixture = await serviceFixture(t, root, async function* ({ sessionId, request, signal }) {
    if (sessionId !== root) {
      await Promise.race([release.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      signal.throwIfAborted(); yield answer(request, 'Checker done.');
    } else if (nextRun) {
      if (!request.messages.some(m => m.providerCallId === 'next-quota')) yield call(request, 'next-quota', 'agent', { action: 'models' });
      else {
        const quota = JSON.parse(request.messages.find(m => m.providerCallId === 'next-quota').content).capacity;
        assert.deepEqual([quota.concurrentTasks.limit, quota.openMembers.limit, quota.callsThisRun.limit, quota.callsThisRun.used], [4, 4, 16, 0]);
        assert.doesNotMatch(textOf(request), /capacityRequested|thisDispatchOnly/);
        yield answer(request, 'Defaults unchanged.');
      }
    } else if (++round === 1) {
      for (let n = 1; n <= 4; n++) yield call(request, `default:${n}`, 'agent', capacitySpawn(`Checker${n}`, 'async'));
    } else if (round === 2) {
      for (const name of (mode === 'compete' ? ['Fifth', 'Rival'] : ['Fifth'])) yield call(request, name, 'agent', capacitySpawn(name, 'async'));
    } else {
      const replies = request.messages.filter(m => m.role === 'tool');
      const fifth = JSON.parse(replies.find(m => m.providerCallId === 'Fifth').content); assert.ok(fifth.taskId);
      if (mode === 'compete') {
        const rival = JSON.parse(replies.find(m => m.providerCallId === 'Rival').content);
        assert.equal(rival.executed, false); assert.equal(rival.error.code, 'agent_capacity_scope_changed');
      }
      yield answer(request, 'Capacity checked.');
    }
    yield done(request);
  });
  try {
    await fixture.service.submit(messageCommand(root, 'capacity:five', 'Coordinate the independent checks.'));
    await waitUntil(async () => (await fixture.service.snapshot(root)).run.waitingReason === 'approval', 'one bounded decision per fifth dispatch');
    const held = await fixture.service.snapshot(root), gates = held.pendingApprovals;
    assert.equal(held.agentTasks.filter(x => x.status === 'running').length, 4);
    assert.equal(gates.length, mode === 'compete' ? 2 : 1);
    for (const g of gates) assert.deepEqual(g.preview.reviewPolicy.capacity.needs.map(n => [n.resource, n.used, n.limit, n.requested]),
      [['concurrentTasks', 4, 4, 5], ['openMembers', 4, 4, 5]]);
    if (mode === 'cancel') {
      await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId: root, runId: held.run.runId, commandId: 'cancel' });
      const cancelled = await fixture.service.snapshot(root); assert.equal(cancelled.run.status, 'cancelled'); assert.equal(cancelled.agentTasks.length, 4);
      assert.equal(cancelled.pendingApproval, null);
      assert.equal((await fixture.service.submit(capacityDecision(held, gates[0], 'allow'))).error.code, 'approval_not_pending');
    } else {
      if (mode === 'release') {
        release.resolve(); await waitUntil(async () => (await fixture.service.snapshot(root)).agentTasks.every(x => x.status === 'completed'), 'original slots released while gate open');
        assert.equal((await fixture.service.snapshot(root)).agentChildren.filter(c => !c.closed).length, 4);
      }
      for (const gate of gates) assert.equal((await fixture.service.submit(capacityDecision(held, gate, 'allow'))).status, 'accepted');
      await waitUntil(async () => (await readEvents(fixture.journal, root)).filter(e => e.type === 'agent.capacity.settled').length === gates.length, 'competing decisions rechecked under admission');
      release.resolve(); assert.equal((await completed(fixture.service, root)).agentTasks.length, 5);
    }
    const events = await readEvents(fixture.journal, root);
    assert.equal(events.filter(e => e.type === 'agent.task.created' && gates.some(g => g.callId === e.callId)).length, mode === 'cancel' ? 0 : 1);
    assert.equal(events.some(e => e.type === 'session.subagent-settings.updated'), false);
    nextRun = true; await fixture.service.submit(messageCommand(root, 'capacity:defaults', 'Inspect the next run defaults.'));
    await completed(fixture.service, root);
  } finally { release.resolve(); }
});

test('subagent capacity: seventeenth dispatch reuses the idle member and requests only callsThisRun', async t => {
  const root = 'session:capacity-seventeen'; let phase = 0, reviews = 0, member;
  const fixture = await serviceFixture(t, root, async function* ({ sessionId, request }) {
    if (sessionId !== root) yield answer(request, 'Completed one pass.');
    else if (request.purpose === 'approvalReview') {
      reviews++; const packet = JSON.parse(request.messages.at(-1).content);
      assert.equal(packet.operation.action, 'assign'); assert.equal(packet.operation.agentId, member);
      assert.deepEqual(packet.capacity.needs, [{ resource: 'callsThisRun', used: 16, limit: 16, requested: 17 }]);
      yield answer(request, JSON.stringify({ decision: 'allow', reason: 'One more pass on the same member.' }));
    } else if (++phase === 1) yield call(request, 'one', 'agent', capacitySpawn('Checker'));
    else {
      const replies = new Map(request.messages.filter(m => m.role === 'tool').map(m => [m.providerCallId, JSON.parse(m.content)]));
      member = replies.get('one').agentId;
      const n = Math.floor(phase / 2) + 1;
      if (phase <= 31) {
        if (phase % 2 === 0) yield call(request, `assign:${n}`, 'agent', { action: 'assign', agentId: member, task: `Pass ${n}` });
        else yield call(request, `wait:${n}`, 'agent', { action: 'wait', taskIds: [replies.get(`assign:${n}`).taskId] });
      } else if (phase === 32) yield call(request, 'no-reason', 'agent', { action: 'assign', agentId: member, task: 'Final pass' });
      else if (phase === 33) {
        assert.equal(replies.get('no-reason').executed, false); assert.equal(replies.get('no-reason').error.message, 'agent_run_call_limit');
        assert.match(JSON.stringify(replies.get('no-reason').error.causes), /requestCapacity/);
        yield call(request, 'seventeen', 'agent', { action: 'assign', agentId: member, task: 'Final pass', requestCapacity: 'The requested seventeenth pass remains.' });
      } else { assert.equal(replies.get('seventeen').agentId, member); yield answer(request, 'All passes handled.'); }
    }
    yield done(request);
  }, { recipe: { permissions: capacityPermissions } });
  await fixture.service.submit(messageCommand(root, 'capacity:seventeen', 'Run seventeen passes in the same member.'));
  const view = await completed(fixture.service, root); assert.equal(reviews, 1); assert.equal(view.agentTasks.length, 17);
  assert.equal(view.agentChildren.length, 1); assert.equal(new Set(view.agentTasks.map(task => task.childRunId)).size, 17);
});

test('subagent capacity: a nested request uses root evidence and cannot buy a helper or file grant', async t => {
  const root = 'session:capacity-nested', userTask = 'PRIVATE: independent coverage of both stations; no changes.';
  let worker, helper, reviews = 0;
  const fixture = await serviceFixture(t, root, async function* ({ sessionId, request, turn, journal }) {
    if (sessionId === root && turn === 1) yield call(request, 'worker', 'agent', { ...capacitySpawn('Worker'), preset: 'collaboration',
      capabilities: { delegation: true }, helpers: [{ id: 'checker', preset: 'analysis', maxCalls: 1 }] });
    else if (sessionId === root) yield answer(request, 'Nested work complete.');
    else if ((await readEvents(journal, sessionId))[0].payload.displayTitle === 'Worker') {
      worker = sessionId;
      if (request.purpose === 'approvalReview') {
        const packet = JSON.parse(request.messages.at(-1).content); reviews++;
        assert.deepEqual(request.tools, []); assert.deepEqual(request.hostedTools, []);
        assert.ok(packet.rootUserMessages.some(m => m.content === userTask));
        assert.ok(packet.userMessages.some(m => m.source === 'delegatedTask'));
        assert.equal(packet.capacity.ownerSessionId, root); assert.equal(packet.caller.sessionId, worker);
        yield answer(request, JSON.stringify({ decision: 'ask', reason: 'An extra active checker requires a human decision.' }));
      } else {
        assert.doesNotMatch(textOf(request), /PRIVATE: independent coverage/);
        const replies = new Map(request.messages.filter(m => m.role === 'tool').map(m => [m.providerCallId, JSON.parse(m.content)]));
        if (!replies.has('off-menu')) yield call(request, 'off-menu', 'agent', { ...capacitySpawn('Forbidden'), preset: 'collaboration' });
        else if (!replies.has('checker')) {
          assert.match(JSON.stringify(replies.get('off-menu')), /agent_helper_not_allowed/);
          yield call(request, 'checker', 'agent', { ...capacitySpawn('Checker'), preset: 'checker' });
        } else if (!replies.has('over-helper')) yield call(request, 'over-helper', 'agent', { ...capacitySpawn('Forbidden'), preset: 'checker' });
        else { assert.match(JSON.stringify(replies.get('over-helper')), /agent_helper_call_limit/); yield answer(request, 'One helper only.'); }
      }
    } else { helper = sessionId; yield answer(request, 'Helper evidence.'); }
    yield done(request);
  }, { settings: { maxConcurrent: 1, maxMembersPerSession: 1, allowFullConfiguration: true },
    preparation: { permissions: capacityPermissions }, recipe: { permissions: capacityPermissions } });
  await fixture.service.submit(messageCommand(root, 'nested', userTask));
  await waitUntil(async () => (await fixture.service.snapshot(root)).pendingAgentDecisions?.some(r => r.approval), 'nested human capacity decision');
  const owner = await fixture.service.snapshot(root), child = await fixture.service.snapshot(worker), [route] = owner.pendingAgentDecisions;
  assert.equal(route.agentSessionId, worker); assert.equal(helper, undefined); assert.equal(owner.pendingApproval, null);
  const cmd = capacityDecision(child, child.pendingApproval, 'allow');
  assert.equal((await fixture.service.submit({ ...cmd, commandId: 'wrong-scope', authorizationScope: 'runFiles' })).error.code, 'approval_scope_invalid');
  assert.equal((await fixture.service.submit(cmd)).status, 'accepted');
  await completed(fixture.service, root); assert.equal(reviews, 1); assert.ok(helper);
  const events = await readEvents(fixture.journal, worker);
  assert.equal(events.filter(e => e.type === 'agent.task.created').length, 1); assert.equal(events.filter(e => e.type === 'approval.requested').length, 1);
});

async function completed(service, sessionId) {
  await waitUntil(async () => terminal.has((await service.snapshot(sessionId)).run?.status), 'completed Agent task');
  const projection = await service.snapshot(sessionId);
  assert.equal(projection.run.status, 'completed', JSON.stringify(projection.terminalError));
  return projection;
}

test('accepted child task records the parent tool first response before child start and preserves later text timing', async t => {
  const ownerId = 'session:child-first-response';
  const childStarted = Promise.withResolvers(), releaseChild = Promise.withResolvers();
  t.after(() => releaseChild.resolve());
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId !== ownerId) {
      childStarted.resolve(await service.snapshot(ownerId));
      await releaseChild.promise;
      yield answer(request, 'Child evidence.');
    } else if (turn === 1) {
      yield call(request, 'root:spawn', 'agent', { action: 'spawn', name: 'Inspector', task: 'Return the evidence.', delivery: 'wait' });
    } else {
      assert.equal(turn, 2);
      yield answer(request, 'Parent report after child evidence.');
    }
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:child-first-response', 'Delegate the inspection.'));
  const during = await childStarted.promise;
  releaseChild.resolve();
  const finished = await completed(fixture.service, ownerId);
  const events = await readEvents(fixture.journal, ownerId);
  const created = events.find(event => event.type === 'agent.task.created');
  const started = events.find(event => event.type === 'agent.task.started');
  const first = events.find(event => event.type === 'run.timing.updated' && event.payload.firstResponseAt);
  assert.equal(first.payload.firstResponseKind, 'tool');
  assert.ok(created.sequence < first.sequence && first.sequence < started.sequence,
    'accepted tool response must be recorded before child execution, not after child submission');
  assert.equal(during.runTimings[0].firstResponseAt, first.payload.firstResponseAt);
  assert.equal(during.runTimings[0].firstTextAt, undefined, 'child text is not parent visible text');
  const timing = finished.runTimings[0];
  assert.equal(timing.firstResponseAt, first.payload.firstResponseAt);
  assert.equal(timing.firstResponseKind, 'tool');
  assert.ok(timing.firstTextMs > timing.firstResponseMs);
  assert.ok(timing.responseElapsedMs >= timing.firstTextMs - timing.firstResponseMs);
  assert.equal(timing.coverage, 'complete');
});

test('a child question interrupts synchronous delivery while an independent reminder still fires once', async t => {
  const ownerId = 'session:independent-wake';
  const question = 'Which station should I inspect?';
  const response = 'Inspect the north station.';
  const evidence = 'North station evidence is 29.';
  const reminder = 'Review the station result again.';
  let childId;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId !== ownerId) {
      childId = sessionId;
      if (turn === 1) {
        yield call(request, 'child:question', 'agent', { action: 'send', agentId: ownerId, text: question });
      } else if (!textOf(request).includes(response)) {
        yield call(request, `child:wait:${turn}`, 'session', { action: 'wait', timeoutSeconds: 2 });
      } else {
        assert.equal(occurrences(textOf(request), response), 1);
        yield answer(request, evidence);
      }
    } else if (turn === 1) {
      yield call(request, 'root:schedule', 'session', { action: 'schedule', afterSeconds: 1.5, text: reminder });
    } else if (turn === 2) {
      yield call(request, 'root:spawn', 'agent', { action: 'spawn', name: 'Analyst', task: 'Ask which station to inspect, then report its evidence.', delivery: 'wait' });
    } else if (turn === 3) {
      assert.equal(occurrences(textOf(request), question), 1, 'the question must interrupt delivery before the child completes');
      assert.equal(textOf(request).includes(evidence), false);
      const live = await service.snapshot(ownerId);
      const task = live.agentTasks[0];
      assert.equal(task.status, 'running');
      assert.equal(task.capabilities.messaging, 'parent');
      const notification = live.activities.find(activity => activity.agent?.phase === 'updated');
      assert.equal(notification.agent.agentSessionId, childId);
      assert.equal(notification.agent.taskId, undefined, 'a member message is not a task settlement');
      yield call(request, 'root:reply', 'agent', { action: 'send', agentId: childId, text: response });
    } else if (!textOf(request).includes(evidence) || !request.messages.some(message => message.role === 'user' && message.content === reminder)) {
      yield call(request, `root:wait:${turn}`, 'session', { action: 'wait', timeoutSeconds: 2 });
    } else {
      assert.equal(occurrences(textOf(request), evidence), 1, 'interrupted synchronous delivery must later publish exactly one result');
      yield answer(request, 'The station check and scheduled review are complete.');
    }
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:independent', 'Review one station and check it again later.'));
  const projection = await completed(fixture.service, ownerId);
  assert.equal(projection.agentTasks.length, 1);
  assert.equal(projection.agentTasks[0].status, 'completed');
  const events = await readEvents(fixture.journal, ownerId);
  const received = events.find(event => event.type === 'agent.message.received');
  const updates = projection.activities.filter(activity => activity.agent?.phase === 'updated');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sequence, received.sequence);
  assert.ok(projection.timeline.some(item => item.kind === 'toolGroup' && item.sequence === received.sequence
    && item.activityIds.includes(updates[0].activityId)));
  const archived = new SessionService(fixture.journal, { async create() { throw new Error('history_must_not_open_actor'); } });
  t.after(() => archived.dispose());
  assert.deepEqual((await archived.snapshot(ownerId)).activities.filter(activity => activity.agent),
    projection.activities.filter(activity => activity.agent), 'received updates and task completion survive journal replay');
  const fired = events.filter(event => event.type === 'wake.triggered');
  assert.equal(fired.length, 1);
  assert.ok(received.sequence < fired[0].sequence, 'an earlier message does not consume the scheduled follow-up');
  assert.equal(events.some(event => event.type === 'wake.cancelled'), false);
  const requests = fixture.requests.get(ownerId);
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages,
      'later evidence appends to the previously sent model view');
    assert.doesNotMatch(textOf(requests[index]), /wake\.scheduled|wake\.triggered|childRunId|"dueAt"|providerRuntimeRef/u);
  }
  assert.equal(requests.at(-1).messages.filter(message => message.role === 'user' && message.content === reminder).length, 1);
  const childCreation = (await readEvents(fixture.journal, childId))[0];
  assert.deepEqual(childCreation.payload.agentContext.capabilities, { messaging: 'parent', continuation: true, delegation: false });
});

test('cancelled and task-ended schedules do not produce late follow-up input', async t => {
  const ownerId = 'session:cancel-wake';
  let cancelledId;
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) yield call(request, 'schedule:cancel', 'session', { action: 'schedule', afterSeconds: 0.3, text: 'Cancelled review.' });
    else if (turn === 2) {
      cancelledId = JSON.parse(request.messages.findLast(message => message.role === 'tool').content).scheduleId;
      yield call(request, 'cancel:review', 'session', { action: 'cancelSchedule', scheduleId: cancelledId });
    } else if (turn === 3) yield call(request, 'schedule:end', 'session', { action: 'schedule', afterSeconds: 0.3, text: 'Review belonging to a finished task.' });
    else yield answer(request, 'No further review is needed.');
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:cancel-wake', 'Finish the review.'));
  await completed(fixture.service, ownerId);
  const settled = await readEvents(fixture.journal, ownerId);
  await new Promise(resolve => setTimeout(resolve, 350));
  const afterDeadline = await readEvents(fixture.journal, ownerId);
  assert.equal(afterDeadline.length, settled.length, 'finished tasks release remaining timer handles');
  assert.equal(afterDeadline.filter(event => event.type === 'wake.scheduled').length, 2);
  assert.deepEqual(afterDeadline.filter(event => event.type === 'wake.cancelled').map(event => event.payload.scheduleId), [cancelledId]);
  assert.equal(afterDeadline.some(event => event.type === 'wake.triggered'), false);
});

for (const maxConcurrent of [2, 1]) test(`one response admits async child spawns independently with Todo (limit ${maxConcurrent})`, async t => {
  const ownerId = `session:spawn-batch:${maxConcurrent}`;
  let releaseChildren;
  const release = new Promise(resolve => { releaseChildren = resolve; });
  const entered = new Set(), finished = new Set();
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service, signal }) {
    if (sessionId !== ownerId) {
      entered.add(sessionId);
      await Promise.race([release, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      signal.throwIfAborted();
      finished.add(sessionId);
      yield answer(request, `Evidence from ${sessionId}.`);
    } else if (turn === 1) {
      yield call(request, 'batch:todo', 'todo_update', { items: [{ text: 'Inspect both stations.', status: 'inProgress' }] });
      for (const name of ['North', 'South']) yield call(request, `batch:${name}`, 'agent', {
        action: 'spawn', name, task: `Read ${name} evidence.`, delivery: 'async',
      });
    } else if (turn === 2) {
      await waitUntil(() => entered.size === maxConcurrent, 'all admitted child Provider calls overlap');
      assert.equal(finished.size, 0, 'all admitted children are active before either can complete');
      const state = await service.snapshot(ownerId);
      assert.equal(state.agentTasks.length, maxConcurrent);
      if (maxConcurrent === 1) assert.match(textOf(request), /agent_concurrency_limit/u);
      releaseChildren();
      yield call(request, 'batch:wait', 'agent', { action: 'wait' });
    } else {
      const state = await service.snapshot(ownerId);
      if (state.agentTasks.some(task => task.status === 'running')) yield call(request, `batch:wait:${turn}`, 'agent', { action: 'wait' });
      else yield answer(request, 'All admitted station work is complete.');
    }
    yield done(request);
  }, { settings: { maxConcurrent } });
  t.after(() => releaseChildren());
  await fixture.service.submit(messageCommand(ownerId, 'command:batch', 'Inspect both stations in parallel.'));
  const projection = await completed(fixture.service, ownerId);
  assert.equal(projection.agentTasks.length, maxConcurrent);
  assert.ok(projection.agentTasks.every(task => task.status === 'completed'));
  assert.equal(projection.todoList.items.length, 1);
  assert.equal(projection.todoList.items[0].status, 'inProgress', 'Todo progress remains the submitted fact, not an end-of-run gate');
  const events = await readEvents(fixture.journal, ownerId);
  const controls = events.filter(event => event.type === 'agent.control.completed' || event.type === 'session.control.rejected');
  for (const providerCallId of ['batch:North', 'batch:South']) assert.equal(controls.filter(event => event.payload.providerCallId === providerCallId).length, 1);
  const errors = controls.filter(event => event.type === 'session.control.rejected');
  assert.equal(errors.length, 2 - maxConcurrent);
  if (errors.length) assert.equal(errors[0].payload.error.message, 'agent_concurrency_limit');
  const rootInput = textOf(fixture.requests.get(ownerId).at(-1));
  for (const childId of entered) assert.equal(occurrences(rootInput, `Evidence from ${childId}.`), 1);
});

for (const scenario of [
  { surface: 'aggregate', catalogFailure: false },
  { surface: 'responses', catalogFailure: false },
  { surface: 'aggregate', catalogFailure: true },
]) test(`discovery shares a turn with independent reads and Todo (${scenario.surface}, failure=${scenario.catalogFailure})`, async t => {
  const ownerId = `session:discovery-batch:${scenario.surface}:${scenario.catalogFailure}`;
  const tools = ['session.read', 'skill.read'].map(name => ({ toolBindingRef: `binding:${name}`, name,
    description: `Read ${name} evidence.`, origin: 'coreBuiltin', availability: 'callable', possibleEffects: [],
    inputSchema: { type: 'object', additionalProperties: false, properties: name === 'session.read'
      ? { sessionId: { type: 'string' }, view: { type: 'string' } } : { name: { type: 'string' } } } }));
  const executions = [];
  const calls = [
    ['discovery:session', 'session_read', { sessionId: 'session:evidence', view: 'summary' }],
    ['discovery:skill-a', 'skill_read', { name: 'first-skill' }],
    ['discovery:skill-b', 'skill_read', { name: 'second-skill' }],
    ['discovery:models', 'agent', { action: 'models' }],
    ['discovery:todo', 'todo_update', { items: [{ text: 'Read the independent evidence.', status: 'inProgress' }] }],
  ];
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    assert.ok(turn <= 2, 'one mixed batch must close before the final answer');
    if (turn === 1) {
      for (const [outputIndex, [id, name, input]] of calls.entries()) yield scenario.surface === 'aggregate'
        ? call(request, id, name, input)
        : providerEvent(request.requestId, 'output.item.completed', { outputIndex, item: {
          type: 'function_call', call_id: id, name, arguments: JSON.stringify(input), status: 'completed' } });
    } else {
      const results = request.messages.filter(message => message.role === 'tool');
      // Results arrive as their owners finish; identity, call order and exact-once closure are distinct contracts.
      assert.deepEqual(results.map(message => message.providerCallId).sort(), calls.map(([id]) => id).sort());
      const replayedCalls = request.messages.flatMap(message => [...(message.toolCalls ?? []),
        ...(message.providerOutputBlocks ?? []).filter(block => block.kind === 'toolCall')]);
      assert.deepEqual(replayedCalls.map(call => call.providerCallId), calls.map(([id]) => id));
      for (const [id] of calls.slice(0, 3)) assert.match(results.find(message => message.providerCallId === id).content, /read evidence:/u);
      const discovery = results.find(message => message.providerCallId === 'discovery:models');
      if (scenario.catalogFailure) assert.match(discovery.content, /model_catalog_unavailable/u);
      else {
        const policies = Object.fromEntries(JSON.parse(discovery.content).operations.map(op => [op.action,op.turn]));
        assert.equal(policies.models,'independentTools'); assert.equal(policies.send,'independentTools');
        assert.deepEqual(policies.spawn,{async:'agentCalls',wait:'singleCall'}); assert.equal(policies.assign,'agentCalls');
        for (const exclusive of ['wait','cancel','compact','close']) assert.equal(policies[exclusive],'singleCall');
      }
      assert.equal(results.some(message => message.content.includes('session_control_turn_conflict')), false);
      yield answer(request, 'All independent results were received.');
    }
    yield done(request);
  }, { preparation: { tools },
    ...(scenario.catalogFailure ? { models: async () => { throw new Error('model_catalog_unavailable'); } } : {}),
    kernel: () => emptyKernel({ async execute(request) {
      executions.push(request);
      return completedExecutionReply(request, { content: `read evidence:${request.providerCallId ?? request.callId}` });
    } }),
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:discovery-batch', 'Discover models and read the independent evidence in session:evidence.'));
  const state = await completed(fixture.service, ownerId);
  assert.deepEqual(state.agentTasks ?? [], []);
  assert.equal(state.todoList.items[0].status, 'inProgress');
  assert.deepEqual(executions.map(request => request.toolName), ['session.read', 'skill.read', 'skill.read']);
  const events = await readEvents(fixture.journal, ownerId);
  const facts = events.filter(event => ['tool.requested', 'agent.control.completed', 'session.control.rejected', 'todo.updated'].includes(event.type));
  assert.deepEqual(facts.map(event => event.payload.providerCallId), calls.map(([id]) => id));
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 3);
  assert.equal(events.some(event => event.type === 'agent.task.created'), false);
  if (scenario.catalogFailure) {
    assert.equal(facts[3].type, 'session.control.rejected');
    assert.equal(facts[3].payload.error.message, 'model_catalog_unavailable');
  }
});

// TCR: T-020/locality-fix/revision-window/self-measure-01/TCR-session-send.md.
// These are running Session actors, not a mocked message port. Hold the recipients through
// the mixed turn so neither an idle-member rejection nor a second assignment can fake delivery.
for (const kind of ['mixed','mixed-todo','receipt-lost','individual-failures','two-todos','exclusive','agent-only','agent-only-with-read']) test(`send batch: ${kind}`, async t => {
  const ownerId = `session:send-batch:${kind}`, unrelated = 'session:unrelated', release = Promise.withResolvers();
  const denied = ['two-todos','exclusive','agent-only-with-read'].includes(kind), failing = kind === 'individual-failures';
  const tool = {name:'fs.read',toolBindingRef:'binding:send-read',description:'Read a file.',origin:'coreBuiltin',availability:'callable',possibleEffects:['workspaceRead'],
    inputSchema:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'}}}};
  const executions=[], entered=new Set(), targetIds=[], asked=[];
  const fixture = await serviceFixture(t,ownerId,async function* ({sessionId,request,turn,service,signal}) {
    if (sessionId !== ownerId) {
      entered.add(sessionId);
      await Promise.race([release.promise, new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
      signal.throwIfAborted(); yield answer(request,'Done.');
    } else if (turn === 1) {
      for (const name of ['north','south']) yield call(request,`setup:${name}`,'agent',{action:'spawn',name,task:'Receive the note.',delivery:'async'});
    } else if (turn === 2) {
      await waitUntil(()=>entered.size===2,'both message recipients are running');
      targetIds.push(...(await service.snapshot(ownerId)).agentTasks.map(task=>task.agentSessionId));
      asked.push(['letter:north','agent',{action:'send',agentId:targetIds[0],text:'North note'}]);
      if (kind !== 'agent-only') asked.push(['read:ok','fs_read',{path:'ok'}]);
      asked.push(['letter:south','agent',{action:'send',agentId:failing?unrelated:targetIds[1],text:'South note'}]);
      if (failing) asked.push(['read:fail','fs_read',{path:'fail'}],['letter:invalid','agent',{action:'send',text:'Missing destination'}]);
      if (['mixed-todo','two-todos','agent-only-with-read'].includes(kind)) asked.push(['progress:a','todo_update',{items:[{status:'inProgress',text:'Inspect both notes.'}]}]);
      if (kind === 'two-todos') asked.push(['progress:b','todo_update',{items:[]}]);
      if (kind === 'exclusive') asked.push(['blocked:wait','agent',{action:'wait'}]);
      if (kind.startsWith('agent-only')) asked.push(['spawn:one','agent',{action:'spawn',delivery:'async',name:'extra',task:'Report separately.'}]);
      for (const [i,[id,name,input]] of asked.entries()) yield kind === 'mixed-todo' || failing
        ? providerEvent(request.requestId,'output.item.completed',{outputIndex:i,item:{type:'function_call',call_id:id,name,arguments:JSON.stringify(input),status:'completed'}})
        : call(request,id,name,input);
    } else { release.resolve(); yield answer(request,'Finish without reissuing calls.'); }
    yield done(request);
  },{preparation:{tools:[tool]},kernel:()=>emptyKernel({async execute(request){
    executions.push(request); return request.input.path==='fail'
      ? failedExecutionReply(request,{}, {code:'file_read_failed',message:'Original file error'}) : completedExecutionReply(request,{content:'Read once.'});
  }})});
  try {
    if (kind === 'receipt-lost') {
      const append = fixture.journal.append.bind(fixture.journal);
      fixture.journal.append = async event => {
        const committed = await append(event);
        if (event.type === 'agent.message.received' && event.payload.text === 'North note') throw new Error('delivery_receipt_lost');
        return committed;
      };
    }
    await fixture.service.createSession({sessionId:unrelated,displayTitle:'Unrelated',workspaceBindings:[]});
    await fixture.service.submit(messageCommand(ownerId,'command:send-batch','Send two notes and inspect the file.'));
    const state=await completed(fixture.service,ownerId), events=await readEvents(fixture.journal,ownerId);
    const results=fixture.requests.get(ownerId)[2].messages.filter(m=>m.role==='tool' && asked.some(([id])=>id===m.providerCallId));
    assert.deepEqual(results.map(m=>m.providerCallId).sort(),asked.map(([id])=>id).sort(),'one result per original call, with the original identity');
    const result=id=>JSON.parse(results.find(m=>m.providerCallId===id).content);
    if (denied) {
      const sources=kind==='two-todos'?['progress:a','progress:b']:kind==='exclusive'?['blocked:wait']:['spawn:one'];
      for (const [id] of asked) {
        const e=result(id); assert.equal(e.executed,false); assert.equal(e.error.code,'session_control_turn_conflict');
        assert.deepEqual(e.error.issues.map(i=>i.rule),[sources.includes(id)?'control_turn_source':'control_turn_peer']);
        if (kind!=='two-todos') assert.doesNotMatch(e.error.message,/todo\.update/iu,'one or no Todo is not the incompatibility');
      }
    } else {
      if (kind === 'receipt-lost') {
        const uncertain = result('letter:north');
        assert.equal(uncertain.status, 'indeterminate');
        assert.equal(uncertain.error.message, 'delivery_receipt_lost');
        assert.equal('executed' in uncertain || 'delivered' in uncertain, false);
        assert.equal(results.find(m => m.providerCallId === 'letter:north').toolOutcome, 'indeterminate');
      } else assert.deepEqual(result('letter:north'),{agentId:targetIds[0],delivered:true});
      if (!failing) assert.deepEqual(result('letter:south'),{agentId:targetIds[1],delivered:true});
      else { assert.match(results.find(m=>m.providerCallId==='letter:south').content,/agent_message_target_not_related/u);
        assert.match(results.find(m=>m.providerCallId==='letter:invalid').content,/agentId/u);
        assert.match(results.find(m=>m.providerCallId==='read:fail').content,/Original file error/u); }
      if (kind!=='agent-only') assert.match(results.find(m=>m.providerCallId==='read:ok').content,/Read once/u);
    }
    assert.deepEqual(executions.map(r=>r.input.path),denied||kind==='agent-only'?[]:failing?['ok','fail']:['ok']);
    assert.ok(executions.every(r=>r.sessionId===ownerId && r.runId===state.run.runId && r.toolBindingRef===tool.toolBindingRef));
    assert.equal(events.filter(e=>e.type==='tool.completed').length,executions.length);
    assert.equal(events.filter(e=>e.type==='todo.updated').length,+(kind==='mixed-todo'));
    assert.equal(state.agentTasks.length,kind==='agent-only'?3:2,'only explicitly admitted spawns create tasks');
    for(const [i,id] of targetIds.entries()) {
      const received=(await readEvents(fixture.journal,id)).filter(e=>e.type==='agent.message.received');
      assert.deepEqual(received.map(e=>[e.sessionId,e.runId,e.payload.sourceSessionId,e.payload.text]),denied||failing&&i===1?[]:
        [[id,state.agentTasks.find(t=>t.agentSessionId===id).childRunId,ownerId,i?'South note':'North note']]);
    }
    assert.equal((await readEvents(fixture.journal,unrelated)).some(e=>e.type==='agent.message.received'||e.type==='run.started'),false);
    const effects=events.filter(e=>['agent.control.completed','session.control.rejected','tool.requested','todo.updated'].includes(e.type)
      && asked.some(([id])=>id===e.payload.providerCallId));
    assert.deepEqual(effects.map(e=>e.payload.providerCallId),denied?[]:asked.map(([id])=>id),'settled facts preserve call order; incompatible batches did not dispatch');
    assert.equal(new Set(effects.map(e=>e.callId)).size,effects.length);
  } finally { release.resolve(); }
});

test('plugin activation mixed with agent.models and a read rejects the entire batch with its conflict source', async t => {
  const ownerId = 'session:plugin-discovery-conflict';
  const tool = { toolBindingRef: 'binding:read-conflict', name: 'fs.read', description: 'Read evidence.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: [],
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const discoveryTool = { toolBindingRef: 'binding:plugin-search-conflict', name: 'plugin.search', description: 'Discover plugins.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {} } };
  let modelReads = 0, executions = 0;
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) {
      yield call(request, 'exclusive:plugin', 'plugin_activate', { pluginUris: ['plugin://sample@builtin'] });
      yield call(request, 'exclusive:models', 'agent', { action: 'models' });
      yield call(request, 'exclusive:read', 'fs_read', { path: 'evidence.txt' });
    } else {
      assert.equal(turn, 2);
      const errors = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(errors.length, 3);
      assert.ok(errors.every(error => error.executed === false && error.error.code === 'session_control_turn_conflict'));
      assert.match(errors[0].error.message, /plugin\.activate \[exclusive:plugin\].*This call caused the conflict/u);
      assert.match(errors[1].error.message, /plugin\.activate \[exclusive:plugin\].*This call was rejected with the batch/u);
      assert.match(errors[2].error.message, /plugin\.activate \[exclusive:plugin\].*This call was rejected with the batch/u);
      yield answer(request, 'The conflicting batch had no effects.');
    }
    yield done(request);
  }, { preparation: { tools: [tool, discoveryTool] }, models: async () => { modelReads++; return []; },
    kernel: () => emptyKernel({ async execute(request) { executions++; return completedExecutionReply(request, {}); } }),
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:plugin-conflict', 'Inspect the conflicting batch.'));
  await completed(fixture.service, ownerId);
  assert.equal(modelReads, 0);
  assert.equal(executions, 0);
  const events = await readEvents(fixture.journal, ownerId);
  assert.equal(events.some(event => ['tool.requested', 'agent.control.completed', 'session.plugins.activated'].includes(event.type)), false);
  const [sent, feedback] = fixture.requests.get(ownerId);
  const alias = sent.tools.find(tool => tool.name === 'plugin_activate').name;
  const source = feedback.messages.find(message => message.role === 'tool' && message.providerCallId === 'exclusive:plugin');
  assert.ok(JSON.parse(source.content).error.message.includes(`Send ${alias} once with all needed URIs, separate from other Session controls`),
    'the correction uses the callable alias from the rejected request, not an internal control ID');
});

test('a session control mixed with child creation is rejected before either operation starts', async t => {
  const ownerId = 'session:exclusive-wake';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    assert.equal(sessionId, ownerId, 'a conflicting response must not start a child');
    if (turn === 1) {
      yield call(request, 'mixed:agent', 'agent', { action: 'spawn', name: 'Unexpected', task: 'No work should start.', delivery: 'async' });
      yield call(request, 'mixed:session', 'session', { action: 'schedule', afterSeconds: 1, text: 'No reminder should start.' });
    } else yield answer(request, 'The rejected response had no effects.');
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:exclusive', 'Inspect the call conflict.'));
  const state = await completed(fixture.service, ownerId);
  assert.deepEqual(state.agentTasks ?? [], []);
  const events = await readEvents(fixture.journal, ownerId);
  assert.equal(events.some(event => event.type === 'wake.scheduled' || event.type === 'agent.task.created'), false);
  const errors = fixture.requests.get(ownerId).at(-1).messages.flatMap(message => {
    if (message.role !== 'tool') return [];
    const payload = JSON.parse(message.content);
    return payload.status === 'inputRejected' ? [payload] : [];
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error.executed === false && error.error.code === 'session_control_turn_conflict'));
  assert.match(errors[0].error.message, /session\(action=schedule\) \[mixed:session\].*This call was rejected with the batch/u);
  assert.match(errors[1].error.message, /session\(action=schedule\) \[mixed:session\].*This call caused the conflict/u);
  const alias = fixture.requests.get(ownerId)[0].tools.find(tool => tool.name === 'session').name;
  assert.ok(errors[1].error.message.includes(`Send ${alias} as the only tool call`));
});

test('control conflicts preserve each input, identify the source and only hold back otherwise admissible siblings', async t => {
  const ownerId = 'session:control-correction';
  const read = (id, path = 'evidence.txt') => [id, 'fs_read', JSON.stringify({ path })];
  // A valid exclusive call, a valid agent-only action, then an invalid action which
  // must not mask an independent malformed sibling or make its fields an execution.
  const batches = [
    [['describe', 'session', '{"action":"describe"}'], ...[0, 1, 2, 3].map(i => read(`held:${i}`))],
    [['assign', 'agent', '{"action":"assign","agentId":"session:member","task":"Review evidence"}'], read('held:assign')],
    [['typo', 'agent', '{"action":"statuz"}'], read('held:typo'), ['bad:json', 'fs_read', '{"path":']],
    [['fields', 'session', '{"action":"describe","timeoutSeconds":5}'], read('held:fields')],
  ];
  const executions = [];
  const tool = { name: 'fs.read', toolBindingRef: 'binding:batch-read', origin: 'coreBuiltin', availability: 'callable',
    description: 'Read a file', possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn > 1 && turn <= batches.length + 1) {
      const last = batches[turn - 2];
      const results = last.map(([id]) => JSON.parse(request.messages.find(message => message.role === 'tool' && message.providerCallId === id).content));
      assert.ok(results.every(result => result.executed === false));
      const errors = results.map(result => result.error);
      assert.ok(errors[0].issues.some(issue => issue.rule === 'control_turn_source' && issue.message.includes(last[0][0])));
      for (const [index, [id]] of last.entries()) if (id.startsWith('held:')) {
        assert.equal(errors[index].code, 'session_control_turn_conflict');
        assert.deepEqual(errors[index].issues.map(issue => issue.rule), ['control_turn_peer']);
      }
      if (turn === 4) {
        assert.equal(errors[0].code, 'agent_action_invalid');
        assert.ok(errors[0].issues.some(issue => issue.path === '$.action'));
        assert.equal(errors[2].code, 'provider_tool_call_arguments_invalid');
        assert.deepEqual(errors[2].issues.map(issue => issue.rule), ['json_object']);
      }
      if (turn === 5) {
        assert.equal(errors[0].code, 'session_control_shape_invalid');
        assert.ok(errors[0].issues.some(issue => issue.path === '$.timeoutSeconds' && issue.rule === 'additionalProperties'));
      }
    }
    if (turn <= batches.length) {
      for (const [index, [id, name, raw]] of batches[turn - 1].entries()) yield turn % 2 === 1
        ? providerEvent(request.requestId, 'tool.call', { callId: id, name, arguments: raw })
        : providerEvent(request.requestId, 'output.item.completed', { outputIndex: index, item: { type: 'function_call', call_id: id, name, arguments: raw } });
    } else if (turn === batches.length + 1) {
      assert.deepEqual(executions, [], 'no rejected batch was split or executed');
      yield call(request, 'corrected:read', 'fs_read', { path: 'corrected.txt' });
    } else { assert.equal(turn, batches.length + 2); yield answer(request, 'Correction received.'); }
    yield done(request);
  }, { preparation: { tools: [tool] }, kernel: () => emptyKernel({ async execute(request) {
    executions.push(request.input.path); return completedExecutionReply(request, { content: 'corrected result' });
  } }) });
  await fixture.service.submit(messageCommand(ownerId, 'command:control-correction', 'Inspect the batch rules.'));
  await completed(fixture.service, ownerId);
  const events = await readEvents(fixture.journal, ownerId);
  const rejected = events.filter(e => e.type === 'provider.turn.settled').flatMap(e =>
    e.payload.toolCallInputs?.filter(call => call.error).map(c => [c.providerCallId, c.arguments])
    ?? e.payload.orderedOutputBlocks?.filter(c => c.kind === 'toolCallRejected').map(c => [c.providerCallId, c.item.arguments]) ?? []);
  assert.deepEqual(rejected, batches.flat().map(([id, , raw]) => [id, raw]));
  assert.deepEqual(executions, ['corrected.txt']);
  assert.equal(events.some(e => ['agent.control.completed', 'session.control.completed', 'agent.message.sent'].includes(e.type)), false);
});

test('a retained child continues across parent runs with its original Session, model and conversation', async t => {
  const ownerId = 'session:retained-member';
  const rootTurns = new Map();
  let childId, parentRuns = 0;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId !== ownerId) {
      childId = sessionId;
      if (turn === 1) yield answer(request, 'First frontend observation.');
      else {
        assert.match(textOf(request), /First frontend observation\./u);
        assert.match(textOf(request), /Continue the frontend review\./u);
        yield answer(request, 'Second frontend observation.');
      }
    } else {
      if (!rootTurns.has(request.runId)) { rootTurns.set(request.runId, 0); parentRuns += 1; }
      const runTurn = rootTurns.get(request.runId) + 1;
      rootTurns.set(request.runId, runTurn);
      if (parentRuns === 1 && runTurn === 1) yield call(request, 'retained:spawn', 'agent', {
        action: 'spawn', preset: 'collaboration', name: 'Frontend', task: 'Inspect the frontend.',
        profileId: 'profile:chosen', reasoningEffort: 'high', delivery: 'wait',
      });
      else if (parentRuns === 2 && runTurn === 1) yield call(request, 'retained:models', 'agent', { action: 'models' });
      else if (parentRuns === 2 && runTurn === 2) {
        const result = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
        assert.deepEqual(result.agents, [{ agentId: childId, name: 'Frontend', status: 'completed', acceptsMessages: false, acceptsTasks: true }]);
        yield call(request, 'retained:send', 'agent', { action: 'assign', agentId: childId, task: 'Continue the frontend review.' });
      } else if (parentRuns === 2 && !textOf(request).includes('Second frontend observation.')) {
        yield call(request, `retained:wait:${runTurn}`, 'agent', { action: 'wait' });
      } else yield answer(request, `Parent round ${parentRuns} is complete.`);
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:retained:first', 'Review the frontend.'));
  const first = await completed(fixture.service, ownerId);
  const firstChild = await fixture.service.snapshot(childId);
  const firstRunId = first.run.runId;
  assert.equal((await fixture.service.submit(subagentSettingsCommand(ownerId, 'command:retained-default',
    { ...fixture.settings, profileId: 'profile:default', reasoningEffort: '' }))).status, 'accepted');
  await fixture.service.submit(messageCommand(ownerId, 'command:retained:second', 'Continue the existing frontend work.'));
  const second = await completed(fixture.service, ownerId);
  assert.notEqual(second.run.runId, firstRunId);
  assert.equal(second.agentChildren.length, 1);
  assert.equal(second.agentChildren[0].closed, false);
  assert.equal(second.agentTasks.length, 2);
  assert.deepEqual(second.agentTasks.map(task => task.agentSessionId), [childId, childId]);
  assert.deepEqual(second.agentTasks.map(task => task.parentRunId), [firstRunId, second.run.runId]);
  const childEvents = await readEvents(fixture.journal, childId);
  assert.equal(childEvents.filter(event => event.type === 'session.created').length, 1);
  const childRuns = childEvents.filter(event => event.type === 'run.started');
  assert.equal(childRuns.length, 2);
  assert.notEqual(childRuns[0].runId, childRuns[1].runId);
  assert.deepEqual(childRuns.map(event => event.payload.runtimeSnapshot.provider.profileId), ['profile:chosen', 'profile:chosen']);
  assert.deepEqual(childRuns.map(event => event.payload.runtimeSnapshot.provider.reasoningEffort), ['high', 'high']);
  assert.equal(fixture.disposed.get(childId), 2, 'each finished activation is released without discarding the reusable Session');
  const history = await fixture.service.snapshot(childId);
  assert.deepEqual(history.agentContext, firstChild.agentContext);
  assert.ok(history.messages.some(message => message.content === 'First frontend observation.'));
  assert.ok(history.messages.some(message => message.content === 'Second frontend observation.'));
});

test('reopening the service restores child activity and closed-child history without opening Actors', async t => {
  const ownerId = 'session:restored-activity';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId !== ownerId) yield answer(request, 'Archived child evidence.');
    else if (turn === 1) {
      yield answer(request, 'Inspecting the child evidence.');
      yield call(request, 'history:spawn', 'agent', { action: 'spawn', name: 'Archive analyst',
        task: 'Return the archival evidence.', delivery: 'wait' });
    } else if (turn === 2) {
      const child = (await service.snapshot(ownerId)).agentChildren[0];
      assert.equal(child.closed, false, 'completing analysis leaves a dormant instance');
      yield call(request, 'history:close', 'agent', { action: 'close', agentId: child.agentSessionId });
    } else yield answer(request, 'The archived evidence is available.');
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:history', 'Inspect and retain the child history.'));
  const live = await completed(fixture.service, ownerId);
  const childId = live.agentChildren[0].agentSessionId;
  assert.equal(live.agentChildren[0].closed, true);
  const liveAgentActivities = Object.values(live.activities).filter(activity => activity.agent);
  assert.deepEqual(liveAgentActivities.map(activity => activity.agent.phase), ['started', 'completed']);
  assert.ok(live.timeline.some(item => item.kind === 'toolGroup'
    && item.activityIds.some(id => liveAgentActivities.some(activity => activity.activityId === id))));
  await fixture.service.dispose();
  let opens = 0;
  const reopened = new SessionService(fixture.journal, { async create() {
    opens += 1;
    throw new Error('history_read_must_not_open_an_actor');
  } });
  t.after(() => reopened.dispose());
  const restored = await reopened.snapshot(ownerId);
  assert.deepEqual(restored.activities, live.activities);
  assert.deepEqual(restored.timeline, live.timeline);
  assert.deepEqual(restored.agentChildren, live.agentChildren);
  assert.deepEqual(restored.agentTasks, live.agentTasks);
  const childHistory = await reopened.snapshot(childId);
  assert.equal(childHistory.run.status, 'completed');
  assert.ok(childHistory.messages.some(message => message.content === 'Archived child evidence.'));
  assert.equal(childHistory.agentContext.parentSessionId, ownerId);
  assert.equal(opens, 0);
});

const writePlan = {
  title: 'Write the report', summary: 'Store the confirmed report.',
  steps: [{ stepId: 'report', title: 'Write report', details: 'Write report.txt.' }],
  mutationManifest: [{ workspace: 'primary', operation: 'fs.write', target: 'report.txt' }],
};

test('a child workdir Plan continues without a decision or new authority and both runtimes finish', async t => {
  const ownerId = 'session:workdir-plan';
  let admissionStarted = false, releaseAdmission;
  const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
  t.after(() => releaseAdmission());
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId && turn === 1) yield call(request, 'workdir:spawn', 'agent', {
      action: 'spawn', name: 'Draft writer', task: 'Write a draft in your working directory.', delivery: 'wait',
    });
    else if (sessionId !== ownerId && turn === 1) yield call(request, 'workdir:plan', 'plan_publish', writePlan);
    else yield answer(request, sessionId === ownerId ? 'Draft delivered.' : 'Draft is ready.');
    yield done(request);
  }, { kernel: () => emptyKernel({ async planAdmission() {
    admissionStarted = true;
    await admissionGate;
    return { source: 'sessionWorkdir', authorities: [] };
  } }) });
  await fixture.service.submit(messageCommand(ownerId, 'command:workdir', 'Prepare a draft.'));
  await waitUntil(() => admissionStarted, 'Kernel is deciding existing workdir admission');
  const inFlight = await fixture.service.snapshot(ownerId);
  assert.deepEqual(inFlight.pendingAgentDecisions ?? [], [], 'no user decision is exposed before Kernel admission');
  assert.equal((await fixture.service.snapshot(inFlight.agentTasks[0].agentSessionId)).pendingPlan, null);
  releaseAdmission();
  const parent = await completed(fixture.service, ownerId);
  const childId = parent.agentTasks[0].agentSessionId;
  const child = await completed(fixture.service, childId);
  assert.equal(child.plans[0].confirmationSource, 'sessionWorkdir');
  const childEvents = await readEvents(fixture.journal, childId);
  assert.deepEqual(childEvents.find(event => event.type === 'plan.confirmed').payload.authorities, []);
  assert.equal(childEvents.some(event => event.type === 'run.waiting' && event.payload.reason === 'plan'), false);
  assert.deepEqual(parent.pendingAgentDecisions ?? [], []);
  for (const sessionId of [ownerId, childId]) {
    const events = await readEvents(fixture.journal, sessionId);
    assert.equal(fixture.releases.get(sessionId), 1);
    assert.ok(events.find(event => event.type === 'run.runtime.released').sequence < events.find(event => event.type === 'run.settled').sequence);
  }
});

test('cancelling a parent awaiting a child Plan drains child runtime before parent settlement', async t => {
  const ownerId = 'session:cancel-child-plan';
  let releaseChild, childReleasing = false;
  const cleanupGate = new Promise(resolve => { releaseChild = resolve; });
  t.after(() => releaseChild());
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId && turn === 1) yield call(request, 'cleanup:spawn', 'agent', {
      action: 'spawn', name: 'Writer', task: 'Request a report Plan.', delivery: 'async',
    });
    else if (sessionId !== ownerId) yield call(request, 'cleanup:plan', 'plan_publish', writePlan);
    else yield answer(request, 'The report needs confirmation.');
    yield done(request);
  }, { async beforeRelease({ sessionId }) {
    if (sessionId !== ownerId) { childReleasing = true; await cleanupGate; }
  } });
  await fixture.service.submit(messageCommand(ownerId, 'command:cleanup', 'Prepare the report.'));
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).pendingAgentDecisions?.some(item => item.plan)
    && (await readEvents(fixture.journal, ownerId)).some(event => event.type === 'message.committed' && event.payload.role === 'assistant'), 'parent answer and pending child Plan');
  const before = await fixture.service.snapshot(ownerId), childId = before.agentTasks[0].agentSessionId;
  assert.equal(terminal.has(before.run.status), false, 'an answer does not fabricate final settlement while a child owns work');
  const cancellation = fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel',
    sessionId: ownerId, commandId: 'command:stop-cleanup', runId: before.run.runId });
  await waitUntil(() => childReleasing, 'child runtime release begins');
  assert.equal((await fixture.service.snapshot(childId)).pendingPlan, null);
  for (const sessionId of [ownerId, childId]) assert.equal((await readEvents(fixture.journal, sessionId))
    .some(event => event.type === 'run.settled'), false, 'runtime release must complete before settlement');
  releaseChild();
  assert.equal((await cancellation).status, 'accepted');
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).run.status === 'cancelled', 'parent cancelled after release');
  for (const sessionId of [ownerId, childId]) {
    const events = await readEvents(fixture.journal, sessionId);
    assert.equal((await fixture.service.snapshot(sessionId)).run.status, 'cancelled');
    assert.equal(fixture.releases.get(sessionId), 1);
    assert.ok(events.find(event => event.type === 'run.runtime.released').sequence < events.find(event => event.type === 'run.settled').sequence);
  }
  assert.deepEqual((await fixture.service.snapshot(ownerId)).pendingAgentDecisions ?? [], []);
  assert.equal((await readEvents(fixture.journal, childId)).filter(event => event.type === 'plan.cancelled').length, 1);
});

test('parent decisions expose light child identities and route Plan, question and approval replies to their original Session', async t => {
  const ownerId = 'session:child-decisions';
  const tool = { toolBindingRef: 'binding:decision-read', name: 'web.fetch', description: 'Read one source.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['network'],
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'decision:spawn', 'agent', { action: 'spawn', name: 'Reporter',
        task: 'Confirm the report scope, ask which station, then read the source.', delivery: 'async' });
      else if (!textOf(request).includes('The confirmed north report is ready.')) yield call(request, `decision:wait:${turn}`, 'agent', { action: 'wait' });
      else yield answer(request, 'The delegated report is complete.');
    } else if (turn === 1) yield call(request, 'child:plan', 'plan_publish', writePlan);
    else if (turn === 2) yield call(request, 'child:question', 'interaction_request', {
      kind: 'question', prompt: 'Which station should the report describe?', allowFreeform: true,
    });
    else if (turn === 3) {
      assert.match(textOf(request), /Use the north station\./u);
      yield call(request, 'child:source', 'web_fetch', { url: 'https://station.example.test/north' });
    } else yield answer(request, 'The confirmed north report is ready.');
    yield done(request);
  }, {
    preparation: { tools: [tool] },
    kernel: () => emptyKernel({ async execute(request) {
      if (!request.nonWorkspaceAuthority) return { schemaVersion: 'achbit.kernel-reply', type: 'tool.execution',
        requestId: request.requestId, callId: request.callId, status: 'approvalRequired', approvalId: 'approval:child-source',
        preview: { summary: 'Read the station source.', effects: ['external'], logicalTargets: ['https://station.example.test/north'] } };
      return completedExecutionReply(request, { content: 'Confirmed station source.' });
    } }),
  });
  const reads = { full: [], agents: [], runs: [] };
  let trace = false;
  const originalRead = fixture.journal.read.bind(fixture.journal);
  const originalAgents = fixture.journal.readAgentLifecycle.bind(fixture.journal);
  const originalRuns = fixture.journal.readRunLifecycle.bind(fixture.journal);
  fixture.journal.read = async function* (sessionId, afterSequence) {
    if (trace) reads.full.push(sessionId);
    yield* originalRead(sessionId, afterSequence);
  };
  fixture.journal.readAgentLifecycle = async sessionId => {
    const value = await originalAgents(sessionId);
    if (trace) {
      reads.agents.push(sessionId);
      assert.doesNotMatch(JSON.stringify(value), /Confirm the report scope|Archived child evidence|"text"|"content"/u);
    }
    return value;
  };
  fixture.journal.readRunLifecycle = async (sessionId, afterSequence) => {
    const value = await originalRuns(sessionId, afterSequence);
    if (trace) {
      reads.runs.push(sessionId);
      assert.doesNotMatch(JSON.stringify(value), /runtimeSnapshot|Which station|Read the station source|"prompt"|"content"/u);
    }
    return value;
  };
  await fixture.service.submit(messageCommand(ownerId, 'command:decisions', 'Delegate the report and show its decisions here.'));
  const pending = async kind => {
    await waitUntil(async () => ((await fixture.service.snapshot(ownerId)).pendingAgentDecisions ?? [])
      .some(decision => kind === 'question' ? decision.interactionIds.length : decision[kind]), `child ${kind} routing`);
    // The child is waiting; a parent projection only needs its compact pending references.
    await new Promise(resolve => setImmediate(resolve));
    trace = true;
    let snapshot;
    try { snapshot = await fixture.service.snapshot(ownerId); }
    finally { trace = false; }
    const route = snapshot.pendingAgentDecisions[0];
    assert.equal(reads.full.some(sessionId => sessionId !== ownerId), false);
    assert.ok(reads.agents.includes(route.agentSessionId));
    assert.ok(reads.runs.includes(route.agentSessionId));
    assert.equal(route.displayName, 'Reporter');
    return route;
  };
  const plan = await pending('plan');
  const childId = plan.agentSessionId;
  const childRunId = plan.runId;
  assert.equal((await fixture.service.snapshot(ownerId)).pendingPlan, null, 'a child decision is not copied into the parent Plan');
  assert.equal((await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond',
    sessionId: childId, commandId: 'command:child-plan', runId: childRunId,
    ...plan.plan, response: { kind: 'confirm' } })).status, 'accepted');
  const question = await pending('question');
  assert.equal(question.agentSessionId, childId);
  assert.equal(question.runId, childRunId);
  assert.equal(question.plan, undefined);
  assert.equal((await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'interaction.respond',
    sessionId: childId, commandId: 'command:child-question', runId: childRunId,
    interactionId: question.interactionIds[0], response: 'Use the north station.' })).status, 'accepted');
  const approval = await pending('approval');
  assert.equal(approval.agentSessionId, childId);
  assert.equal(approval.runId, childRunId);
  assert.deepEqual(approval.interactionIds, []);
  assert.equal((await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond',
    sessionId: childId, commandId: 'command:child-approval', runId: childRunId,
    ...approval.approval, decision: 'allow' })).status, 'accepted');
  const finished = await completed(fixture.service, ownerId);
  assert.deepEqual(finished.pendingAgentDecisions ?? [], []);
  const childEvents = await readEvents(fixture.journal, childId);
  const resolved = childEvents.filter(event => ['plan.confirmed', 'interaction.resolved', 'approval.resolved'].includes(event.type));
  assert.deepEqual(resolved.map(event => event.payload.commandId), ['command:child-plan', 'command:child-question', 'command:child-approval']);
  assert.ok(resolved.every(event => event.sessionId === childId && event.runId === childRunId));
  assert.equal(resolved[0].payload.source, 'user');
  assert.equal((await readEvents(fixture.journal, ownerId)).some(event =>
    ['command:child-plan', 'command:child-question', 'command:child-approval'].includes(event.payload.commandId)), false);
});

test('an ancestor continuing a descendant routes its Plan by the current task without changing archival ownership', async t => {
  const ownerId = 'session:descendant-decision';
  let memberId, descendantId;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'root:create-member', 'agent', { action: 'spawn', preset: 'collaboration',
        capabilities: { delegation: true }, name: 'Coordinator', task: 'Create a reusable writer and obtain its initial report.', delivery: 'wait' });
      else if (turn === 2) {
        memberId = (await service.snapshot(ownerId)).agentChildren[0].agentSessionId;
        descendantId = (await service.snapshot(memberId)).agentChildren[0].agentSessionId;
        yield call(request, 'root:continue-descendant', 'agent', { action: 'assign', agentId: descendantId,
          task: 'Publish the new report scope for user confirmation.' });
      } else if (!textOf(request).includes('The descendant report is confirmed.')) {
        yield call(request, `root:wait:${turn}`, 'agent', { action: 'wait' });
      } else yield answer(request, 'The descendant continuation is complete.');
    } else {
      const creation = (await readEvents(fixture.journal, sessionId))[0];
      if (creation.payload.agentContext.parentSessionId === ownerId) {
        if (turn === 1) yield call(request, 'member:create-writer', 'agent', { action: 'spawn', preset: 'analysis',
          name: 'Writer', task: 'Return an initial report.', delivery: 'wait' });
        else yield answer(request, 'The reusable writer is ready.');
      } else if (turn === 1) yield answer(request, 'Initial writer report.');
      else if (turn === 2) yield call(request, 'descendant:contacts', 'agent', { action: 'models' });
      else if (turn === 3) {
        const contacts = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
        assert.equal(contacts.parentAgentId, ownerId);
        assert.equal(contacts.coordinatorAgentId, ownerId);
        yield call(request, 'descendant:owner-message', 'agent', { action: 'send', agentId: contacts.parentAgentId,
          text: 'Current task owner verified.' });
      } else if (turn === 4) yield call(request, 'descendant:plan', 'plan_publish', writePlan);
      else yield answer(request, 'The descendant report is confirmed.');
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:descendant', 'Delegate, then continue the reusable descendant.'));
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).pendingAgentDecisions?.some(item => item.plan), 'continued descendant Plan');
  const root = await fixture.service.snapshot(ownerId);
  const route = root.pendingAgentDecisions[0];
  assert.equal(route.agentSessionId, descendantId);
  const task = root.agentTasks.find(item => item.agentSessionId === descendantId);
  assert.equal(route.runId, task.childRunId);
  assert.equal((await fixture.service.snapshot(descendantId)).agentContext.parentSessionId, memberId);
  assert.equal((await fixture.service.snapshot(memberId)).run.status, 'completed');
  const reply = await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond',
    sessionId: route.agentSessionId, commandId: 'command:descendant-plan', runId: route.runId,
    ...route.plan, response: { kind: 'confirm' } });
  assert.equal(reply.status, 'accepted');
  assert.deepEqual((await completed(fixture.service, ownerId)).pendingAgentDecisions ?? [], []);
  const confirmation = (await readEvents(fixture.journal, descendantId)).find(event => event.type === 'plan.confirmed');
  assert.equal(confirmation.payload.commandId, 'command:descendant-plan');
  assert.equal(confirmation.payload.source, 'user');
});

test('a child Plan retains the original parent authority reference without inventing a user confirmation', async t => {
  const ownerId = 'session:parent-plan-reference';
  const tool = { toolBindingRef: 'binding:report-write', name: 'fs.write', description: 'Write the report.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['workspaceMutation'],
    inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } };
  const scopeRequests = [], executions = [];
  let parentAuthority;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'owner:plan', 'plan_publish', writePlan);
      else if (turn === 2) yield call(request, 'owner:reporter', 'agent', { action: 'spawn', name: 'Writer',
        task: 'Write the approved report.', delivery: 'wait' });
      else yield answer(request, 'The approved report has been written.');
    } else if (turn === 1) yield call(request, 'writer:plan', 'plan_publish', writePlan);
    else if (turn === 2) yield call(request, 'writer:write', 'fs_write', { workspace: 'primary', path: 'report.txt', content: 'North station report.' });
    else yield answer(request, 'The report file is ready.');
    yield done(request);
  }, {
    preparation: { tools: [tool] },
    kernel: ({ sessionId, journal }) => emptyKernel({
      async planAdmission(request) {
        if (sessionId === ownerId) return { source: 'user', authorities: [] };
        scopeRequests.push(structuredClone(request));
        const confirmed = (await readEvents(journal, ownerId)).find(event => event.type === 'plan.confirmed');
        assert.equal(confirmed.payload.source, 'user');
        parentAuthority = structuredClone(confirmed.payload.authorities[0]);
        assert.deepEqual(request.mutationManifest, parentAuthority.coveredOperations);
        return { source: 'parent', authorities: [parentAuthority] };
      },
      async execute(request) {
        executions.push(structuredClone(request));
        assert.deepEqual(request.planAuthorities, [parentAuthority]);
        return completedExecutionReply(request, { written: true });
      },
    }),
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:parent-plan', 'Write report.txt through a child.'));
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).pendingPlan !== null, 'root Plan confirmation');
  const plan = (await fixture.service.snapshot(ownerId)).pendingPlan;
  assert.equal((await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond',
    sessionId: ownerId, commandId: 'command:confirm-parent', runId: plan.runId,
    planId: plan.planId, revision: plan.revision, response: { kind: 'confirm' } })).status, 'accepted');
  const finished = await completed(fixture.service, ownerId);
  assert.equal(finished.agentTasks[0].status, 'completed');
  const childId = finished.agentTasks[0].agentSessionId;
  const childEvents = await readEvents(fixture.journal, childId);
  const confirmations = childEvents.filter(event => event.type === 'plan.confirmed');
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].payload.source, 'parent');
  assert.deepEqual(confirmations[0].payload.authorities, [parentAuthority]);
  assert.equal(parentAuthority.sessionId, ownerId);
  assert.equal(parentAuthority.runId, plan.runId);
  assert.notEqual(parentAuthority.sessionId, childId);
  assert.equal(scopeRequests.length, 1);
  assert.equal(scopeRequests[0].sessionId, childId);
  assert.equal(scopeRequests[0].runId, finished.agentTasks[0].childRunId);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].sessionId, childId, 'the file effect keeps its actual child executor identity');
  assert.equal(childEvents.some(event => event.type === 'plan.confirmed' && event.payload.source === 'user'), false);
});

test('a visible Plan confirmation waits for the previous Loop to return before resuming', async t => {
  const ownerId = 'session:plan-release-race';
  let releaseOutput, releaseCleanup, enteredProvider = false, enteredCleanup = false;
  const outputGate = new Promise(resolve => { releaseOutput = resolve; });
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  t.after(() => { releaseOutput(); releaseCleanup(); });
  const runner = { async run(...args) {
    const result = await runAgentLoop(...args);
    if (result.status === 'waiting' && result.reason === 'plan') {
      enteredCleanup = true;
      await cleanupGate;
    }
    return result;
  } };
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) {
      enteredProvider = true;
      await outputGate;
      yield call(request, 'release-race:plan', 'plan_publish', writePlan);
    } else yield answer(request, 'Continued after the confirmed Plan.');
    yield done(request);
  }, { runner });
  await fixture.service.submit(messageCommand(ownerId, 'command:release-race', 'Confirm the report Plan.'));
  await waitUntil(() => enteredProvider, 'first request owns the active Loop');
  await assert.rejects(fixture.service.replaceCapabilities(ownerId, createSessionCapabilities()), /session_capabilities_run_active/u);
  releaseOutput();
  await waitUntil(() => enteredCleanup, 'previous Loop is returning after publishing the Plan');
  const waiting = await fixture.service.snapshot(ownerId);
  assert.equal(waiting.run.status, 'waiting');
  const plan = waiting.pendingPlan;
  assert.ok(plan);
  let replied = false;
  const response = fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'plan.respond',
    sessionId: ownerId, commandId: 'command:confirm-during-release', runId: plan.runId,
    planId: plan.planId, revision: plan.revision, response: { kind: 'confirm' } }).then(reply => {
    replied = true;
    return reply;
  });
  await waitUntil(async () => (await readEvents(fixture.journal, ownerId))
    .some(event => event.type === 'plan.confirmed'), 'the accepted confirmation is durable');
  assert.equal(replied, false, 'confirmation joins the previous Loop instead of losing its resume request');
  assert.equal(fixture.requests.get(ownerId).length, 1);
  releaseCleanup();
  assert.equal((await response).status, 'accepted');
  await completed(fixture.service, ownerId);
  assert.equal(fixture.requests.get(ownerId).length, 2);
});

test('a cancel acknowledgement cannot consume an undelivered child result', () => {
  const sessionId = 'session:cancel-result', runId = 'run:cancel-result', taskId = 'task:cancel-result';
  const events = [];
  const add = (type, payload, callId) => events.push({ schemaVersion: 'achbit.session-event.v5', sessionId, runId,
    eventId: `event:cancel:${events.length + 1}`, sequence: events.length + 1, occurredAt: '2026-10-13T00:00:00.000Z',
    type, payload, ...(callId ? { callId } : {}) });
  const spawn = { action: 'spawn', preset: 'collaboration', name: 'Inspector', task: 'Inspect the source.', delivery: 'async' };
  add('agent.task.created', { taskId, agentSessionId: 'session:inspector', displayName: spawn.name, text: spawn.task,
    createsAgent: true, capabilities: { messaging: true, continuation: true, delegation: true }, delivery: 'async' }, 'call:spawn');
  add('agent.task.started', { taskId, childRunId: 'run:inspector' });
  add('agent.control.completed', { providerCallId: 'provider:spawn', operation: spawn,
    result: { taskId, agentId: 'session:inspector' } }, 'call:spawn');
  add('provider.turn.settled', { providerRequestId: 'request:spawn', purpose: 'agent',
    providerRuntimeRef: 'provider-runtime:test', outcome: 'completed', orderedCallIds: ['call:spawn'] });
  // The child finishes before a pending cancellation is handled. The cancellation
  // acknowledges its outcome, but has not delivered the child's evidence.
  add('agent.task.completed', { taskId, result: { outcome: 'completed', content: 'The source contains 29 entries.', finalMessageId: 'message:inspector' } });
  add('agent.control.completed', { providerCallId: 'provider:cancel', operation: { action: 'cancel', taskId },
    result: { taskId, outcome: 'completed' } }, 'call:cancel');
  add('provider.turn.settled', { providerRequestId: 'request:cancel', purpose: 'agent',
    providerRuntimeRef: 'provider-runtime:test', outcome: 'completed', orderedCallIds: ['call:cancel'] });
  const messages = messagesFromJournal(events, runId, []).map(contribution => contribution.message);
  assert.equal(occurrences(JSON.stringify(messages), 'The source contains 29 entries.'), 1);
  const result = messages.map(message => {
    try { return JSON.parse(message.content); } catch { return null; }
  }).find(payload => payload?.type === 'agent.result');
  assert.equal(result.taskId, taskId);
  assert.equal(result.result.outcome, 'completed');
  assert.deepEqual(JSON.parse(messages.find(message => message.toolCallId === 'call:cancel').content), { taskId, outcome: 'completed' });
});

async function copyCommittedJournal(histories) {
  // A crash leaves exactly the already committed facts. Copy that boundary before
  // disposing the old process fixture, whose orderly shutdown has separate facts.
  const journal = new InMemoryCommandJournal();
  for (const events of histories) {
    const creation = events[0];
    assert.equal(creation.type, 'session.created');
    await journal.createSession({ sessionId: creation.sessionId, ...structuredClone(creation.payload) });
    await journal.appendBatch(events.slice(1).map(event => {
      const { schemaVersion: _schema, eventId: _eventId, sequence: _sequence, occurredAt: _time, ...fact } = event;
      return structuredClone(fact);
    }));
  }
  return journal;
}

function acceptedWait(events, action) {
  const event = events.findLast(item => ['session.control.completed', 'agent.control.completed'].includes(item.type)
    && item.payload.operation.action === action && item.payload.result.wait);
  if (!event) return undefined;
  const settled = events.some(item => item.type === 'provider.turn.settled' && item.sequence > event.sequence
    && item.payload.orderedCallIds?.includes(event.callId));
  return settled ? event : undefined;
}

for (const overdue of [false, true]) test('an accepted session wait reloads with its original timer and deadline and no uncertain Provider result'
  + (overdue ? ' when both are already due' : ''), async t => {
  const ownerId = 'session:reload-scheduled-wait', reminder = 'Review the stored result after reloading.';
  const original = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) yield call(request, 'reload:schedule', 'session', { action: 'schedule', afterSeconds: 0.45, text: reminder });
    else if (turn === 2) yield call(request, 'reload:wait', 'session', { action: 'wait', timeoutSeconds: 1 });
    else yield answer(request, 'The original fixture should already have been stopped.');
    yield done(request);
  });
  await original.service.submit(messageCommand(ownerId, 'command:reload-wait', 'Review this result later.'));
  await waitUntil(async () => Boolean(acceptedWait(await readEvents(original.journal, ownerId), 'wait')), 'wait acceptance and Provider settlement');
  const captured = await readEvents(original.journal, ownerId);
  const wait = acceptedWait(captured, 'wait');
  const scheduled = captured.find(event => event.type === 'wake.scheduled');
  const sentPrefix = original.requests.get(ownerId).at(-1).messages;
  assert.equal(captured.some(event => event.type === 'wake.triggered'), false);
  assert.ok(wait.payload.result.wait.deadline > scheduled.payload.dueAt);
  const journal = await copyCommittedJournal([captured]);
  await original.service.dispose();
  // Reload may happen after both persisted deadlines. Advance only the clock;
  // do not run timer callbacks before recovery has reconciled the durable facts.
  if (overdue) t.mock.timers.enable({ apis: ['Date'], now: wait.payload.result.wait.deadline + 1 });
  const resumeRecovered = Promise.withResolvers();
  t.after(() => resumeRecovered.resolve());
  const reopened = await serviceFixture(t, ownerId, async function* ({ request }) {
    await resumeRecovered.promise;
    assert.deepEqual(request.messages.slice(0, sentPrefix.length), sentPrefix);
    assert.equal(request.messages.filter(message => message.role === 'user' && message.content === reminder).length, 1);
    assert.doesNotMatch(textOf(request), /"afterSequence"|"deadline"|provider_turn_outcome_unknown/u);
    yield answer(request, 'The scheduled review survived reloading.');
    yield done(request);
  }, { journal, reopen: true });
  await assert.rejects(reopened.service.replaceCapabilities(ownerId, createSessionCapabilities()), /session_capabilities_run_active/u);
  resumeRecovered.resolve();
  await completed(reopened.service, ownerId);
  const events = await readEvents(journal, ownerId);
  assert.equal(events.filter(event => event.type === 'wake.scheduled').length, 1);
  assert.equal(events.find(event => event.type === 'wake.scheduled').payload.dueAt, scheduled.payload.dueAt);
  assert.deepEqual(acceptedWait(events, 'wait').payload.result.wait, wait.payload.result.wait);
  const triggered = events.filter(event => event.type === 'wake.triggered');
  assert.equal(triggered.length, 1);
  assert.ok(Date.parse(triggered[0].occurredAt) >= scheduled.payload.dueAt,
    `wake occurred at ${triggered[0].occurredAt} before dueAt ${new Date(scheduled.payload.dueAt).toISOString()}`);
  assert.equal(reopened.requests.get(ownerId).length, 1);
});

for (const delivery of ['async', 'wait']) test(`reloading an accepted ${delivery === 'async' ? 'agent wait' : 'synchronous spawn'} delivers the actual child result once`, async t => {
  const ownerId = `session:reload-agent-${delivery}`, evidence = `Recovered ${delivery} child evidence.`;
  let childId;
  const original = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId !== ownerId) {
      childId = sessionId;
      if (turn === 1) yield call(request, 'child:reload-wait', 'session', { action: 'wait', timeoutSeconds: 0.6 });
      else yield answer(request, evidence);
    } else if (turn === 1) yield call(request, 'owner:reload-spawn', 'agent', { action: 'spawn', name: 'Recoverable analyst',
      task: 'Wait briefly, then return the evidence.', delivery });
    else if (delivery === 'async' && turn === 2) yield call(request, 'owner:reload-wait', 'agent', { action: 'wait' });
    else yield answer(request, 'The original fixture should already have been stopped.');
    yield done(request);
  });
  await original.service.submit(messageCommand(ownerId, 'command:reload-agent', 'Obtain the child evidence.'));
  const action = delivery === 'async' ? 'wait' : 'spawn';
  await waitUntil(async () => childId && acceptedWait(await readEvents(original.journal, ownerId), action)
    && acceptedWait(await readEvents(original.journal, childId), 'wait'), 'parent and child waits are durably accepted');
  const parentEvents = await readEvents(original.journal, ownerId);
  const childEvents = await readEvents(original.journal, childId);
  assert.equal(parentEvents.some(event => event.type === 'agent.task.completed'), false);
  const journal = await copyCommittedJournal([parentEvents, childEvents]);
  await original.service.dispose();
  const resumeRecovered = Promise.withResolvers();
  t.after(() => resumeRecovered.resolve());
  const reopened = await serviceFixture(t, ownerId, async function* ({ sessionId, request }) {
    await resumeRecovered.promise;
    assert.doesNotMatch(textOf(request), /"afterSequence"|"deadline"|provider_turn_outcome_unknown/u);
    if (sessionId === ownerId) {
      assert.equal(occurrences(textOf(request), evidence), 1);
      yield answer(request, 'Recovered child evidence received.');
    } else {
      assert.equal(sessionId, childId);
      yield answer(request, evidence);
    }
    yield done(request);
  }, { journal, reopen: true });
  await assert.rejects(reopened.service.replaceCapabilities(ownerId, createSessionCapabilities()), /session_capabilities_run_active/u);
  resumeRecovered.resolve();
  const complete = await completed(reopened.service, ownerId);
  assert.equal(complete.agentTasks.length, 1);
  assert.equal(complete.agentTasks[0].status, 'completed');
  assert.equal(complete.agentTasks[0].agentSessionId, childId);
  assert.equal(reopened.requests.get(ownerId).length, 1);
  assert.equal(reopened.requests.get(childId).length, 1);
  assert.equal((await readEvents(journal, ownerId)).filter(event => event.type === 'agent.task.completed').length, 1);
});

test('reopening an ordinary inbox wait collects a child already settled before its result reached the parent', async t => {
  const owner = 'session:inbox-recovery', evidence = 'Child completed once.';
  const finishChild = Promise.withResolvers();
  let childId;
  t.after(() => finishChild.resolve());
  const original = await serviceFixture(t, owner, async function* ({ sessionId, request, turn }) {
    if (sessionId !== owner) { childId = sessionId; await finishChild.promise; yield answer(request, evidence); }
    else if (turn === 1) yield call(request, 'spawn', 'agent', { action: 'spawn', name: 'Worker', task: 'Return evidence.', delivery: 'async' });
    else if (turn === 2) yield call(request, 'wait', 'session', { action: 'wait' });
    else yield answer(request, 'Done.');
    yield done(request);
  });
  await original.service.submit(messageCommand(owner, 'command:start', 'Collect the delegated result.'));
  await waitUntil(async () => acceptedWait(await readEvents(original.journal, owner), 'wait'), 'ordinary wait committed');
  const parentCut = await readEvents(original.journal, owner);
  assert.ok(!parentCut.some(e => e.type === 'agent.task.completed'));
  finishChild.resolve();
  await completed(original.service, owner);
  const childCut = await readEvents(original.journal, childId);
  assert.equal(childCut.find(e => e.type === 'run.settled')?.payload.outcome, 'completed');
  const journal = await copyCommittedJournal([parentCut, childCut]);
  await original.service.dispose();
  const reopened = await serviceFixture(t, owner, async function* ({ sessionId, request }) {
    assert.equal(sessionId, owner, 'do not rerun the child');
    assert.equal(occurrences(textOf(request), evidence), 1);
    yield answer(request, 'Joined the original result.'); yield done(request);
  }, { journal, reopen: true });
  // Activate only the parent; no extra message, timer or explicit agent.wait.
  await assert.rejects(reopened.service.replaceCapabilities(owner, createSessionCapabilities()), /session_capabilities_run_active/u);
  await completed(reopened.service, owner);
  assert.equal(reopened.requests.get(owner).length, 1);
  assert.ok(!reopened.requests.has(childId));
  assert.equal((await readEvents(journal, owner)).filter(e => e.type === 'agent.task.completed').length, 1);
});

test('an answer arriving with a peer message is committed before the next Loop request', async t => {
  const ownerId = 'session:answer-message';
  let releaseMessage;
  const parentAnswerStarted = new Promise(resolve => { releaseMessage = resolve; });
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal }) {
    if (sessionId !== ownerId) {
      if (turn === 1) {
        await parentAnswerStarted;
        yield call(request, 'answer:peer-message', 'agent', { action: 'send', agentId: ownerId, text: 'New peer evidence.' });
      } else yield answer(request, 'Child result.');
    } else if (turn === 1) {
      yield call(request, 'answer:spawn', 'agent', { action: 'spawn', name: 'Analyst', task: 'Send your finding.', delivery: 'async' });
    } else if (turn === 2) {
      releaseMessage();
      await waitUntil(async () => (await readEvents(journal, ownerId)).some(event => event.type === 'agent.message.received'), 'peer message during answer');
      yield answer(request, 'First answer must remain visible.');
    } else yield answer(request, 'Final answer with peer evidence.');
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:answer-message', 'Inspect the result.'));
  const projection = await completed(fixture.service, ownerId);
  assert.ok(projection.messages.some(message => message.content === 'First answer must remain visible.'));
  assert.equal(projection.messages.at(-1).content, 'Final answer with peer evidence.');
  const events = await readEvents(fixture.journal, ownerId);
  const first = events.find(event => event.type === 'message.committed' && event.payload.content === 'First answer must remain visible.');
  const turn = events.find(event => event.type === 'provider.turn.settled' && event.payload.providerRequestId === first.payload.providerRequestId);
  assert.ok(turn && turn.sequence < first.sequence);
  const later = fixture.requests.get(ownerId)[2];
  assert.equal(occurrences(textOf(later), 'First answer must remain visible.'), 1);
  assert.equal(occurrences(textOf(later), 'New peer evidence.'), 1);
  assert.ok(events.find(event => event.type === 'run.settled').sequence > first.sequence);
});

test('peer messages never reassign dormant instances; the coordinator explicitly continues their original configuration', async t => {
  const ownerId = 'session:peer-wake';
  let northId, southId, decisionSent = false;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal, service }) {
    if (sessionId === ownerId) {
      if (turn === 1) {
        yield call(request, 'peer:north', 'agent', { action: 'spawn', preset: 'collaboration', name: 'North', task: 'Return your first finding.', delivery: 'async',
          loop: { controls: { id: 'standard', parameters: { optionalTools: [] } } } });
        yield call(request, 'peer:south', 'agent', { action: 'spawn', preset: 'collaboration', capabilities: { delegation: true },
          name: 'South', task: 'Review North.', delivery: 'async' });
      } else {
        const current = await service.snapshot(ownerId);
        if (textOf(request).includes('Please assign North again.') && current.agentTasks.length === 2) {
          yield call(request, 'peer:assign', 'agent', { action: 'assign', agentId: northId, task: 'Review the second observation.' });
        } else if (textOf(request).includes('North follow-up finding.') && !decisionSent) {
          decisionSent = true;
          yield call(request, 'peer:decision', 'agent', { action: 'send', agentId: southId, text: 'North follow-up accepted.' });
        } else if (current.agentTasks.every(task => task.status === 'completed')) yield answer(request, 'Both peer tasks are complete.');
        else yield call(request, `peer:wait:${turn}`, 'agent', { action: 'wait' });
      }
    } else {
      const name = (await readEvents(journal, sessionId))[0].payload.displayTitle;
      if (name === 'North') {
        northId = sessionId;
        assert.equal(request.tools.some(tool => tool.name === 'todo_update'), false);
        yield answer(request, turn === 1 ? 'North first finding.' : 'North follow-up finding.');
      } else {
        southId = sessionId;
        if (turn === 1) {
          await waitUntil(async () => northId && (await service.snapshot(northId)).run?.status === 'completed', 'North dormant');
          yield call(request, 'peer:send', 'agent', { action: 'send', agentId: northId, text: 'Review the second observation.' });
        } else if (turn === 2) {
          assert.match(textOf(request), /agent_message_target_inactive/u);
          yield call(request, 'peer:forbidden-assign', 'agent', { action: 'assign', agentId: northId, task: 'Must remain coordinator-owned.' });
        } else if (turn === 3) {
          assert.match(textOf(request), /agent_coordinator_required/u);
          assert.equal(((await service.snapshot(northId)).agentTasks ?? []).length, 0);
          assert.equal((await readEvents(journal, northId)).filter(event => event.type === 'run.started').length, 1);
          yield call(request, 'peer:request-owner', 'agent', { action: 'send', agentId: ownerId, text: 'Please assign North again.' });
        } else if (textOf(request).includes('North follow-up accepted.')) yield answer(request, 'South reviewed the follow-up.');
        else yield call(request, `peer:south-wait:${turn}`, 'session', { action: 'wait' });
      }
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:peer-wake', 'Perform the peer review.'));
  const parent = await completed(fixture.service, ownerId);
  const child = await fixture.service.snapshot(northId);
  assert.equal(child.agentContext.parentSessionId, ownerId);
  assert.equal(child.agentContext.ownerSessionId, ownerId);
  assert.equal(child.agentContext.model.profileId, 'profile:default');
  assert.deepEqual(child.recipe.configuration.controls.parameters.optionalTools, []);
  const northEvents = await readEvents(fixture.journal, northId);
  assert.equal(northEvents.filter(event => event.type === 'session.created').length, 1);
  assert.equal(northEvents.filter(event => event.type === 'run.started').length, 2);
  assert.equal(northEvents.filter(event => event.type === 'session.permissions.updated').length, 0);
  assert.equal(parent.agentTasks.filter(task => task.agentSessionId === northId).length, 2);
  const south = await fixture.service.snapshot(southId);
  assert.deepEqual(south.agentTasks ?? [], [], 'a peer does not acquire task ownership');
  assert.deepEqual(south.agentChildren ?? [], [], 'a peer does not acquire archival ownership');
});

test('parallel collaborators exchange protocol proposals and consume one coordinator decision in independent contexts', async t => {
  const ownerId = 'session:protocol-coordinator';
  const entered = new Set(), ids = new Map(), escalated = new Set();
  let decisionSent = false;
  const decision = 'Use the optional field. Server is the single proto writer.';
  const incoming = request => request.messages.filter(message => message.role === 'user').flatMap(message => {
    try { const value = JSON.parse(message.content); return value.type === 'agent.message' ? [value] : []; }
    catch { return []; }
  });
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal, service }) {
    assert.ok(turn < 15, 'collaboration must make progress rather than repeatedly poll');
    const messages = incoming(request);
    if (sessionId === ownerId) {
      if (turn === 1) {
        for (const name of ['Client', 'Server']) yield call(request, `protocol:spawn:${name}`, 'agent', {
          action: 'spawn', preset: 'collaboration', name, delivery: 'async',
          task: `${name.toLowerCase()}_private_scope_note: implement your side and discuss the proto with your teammate. Escalate disagreement.`,
        });
      } else if (messages.filter(message => message.text.startsWith('Protocol disagreement:')).length === 2 && !decisionSent) {
        assert.equal((await service.snapshot(ownerId)).agentTasks.filter(task => task.status === 'running').length, 2);
        decisionSent = true;
        for (const agentId of ids.values()) yield call(request, `protocol:decision:${agentId}`, 'agent', { action: 'send', agentId, text: decision });
      } else if ((await service.snapshot(ownerId)).agentTasks.every(task => task.status === 'completed')) {
        yield answer(request, 'Client and Server integrated the same protocol decision.');
      } else yield call(request, `protocol:wait:${turn}`, 'agent', { action: 'wait' });
    } else {
      const name = (await readEvents(journal, sessionId))[0].payload.displayTitle;
      const peer = name === 'Client' ? 'Server' : 'Client';
      ids.set(name, sessionId);
      assert.equal(textOf(request).includes('PRIVATE_ROOT_NOT_DELEGATED'), false);
      assert.equal(textOf(request).includes(`${peer.toLowerCase()}_private_scope_note`), false);
      if (turn === 1) {
        entered.add(sessionId);
        await waitUntil(() => entered.size === 2, 'both child Provider calls overlap');
        yield call(request, `protocol:contacts:${name}`, 'agent', { action: 'models' });
      } else if (turn === 2) {
        const contacts = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
        assert.equal(contacts.parentAgentId, ownerId);
        assert.equal(contacts.coordinatorAgentId, ownerId);
        assert.equal(contacts.operations.some(operation => ['spawn', 'assign', 'close'].includes(operation.action)), false);
        const target = contacts.agents.find(agent => agent.name === peer);
        assert.ok(target.acceptsMessages);
        assert.equal(target.acceptsTasks, false);
        yield call(request, `protocol:proposal:${name}`, 'agent', { action: 'send', agentId: target.agentId,
          text: `${name} proposes ${name === 'Client' ? 'required' : 'optional'} field.` });
      } else if (messages.some(message => message.text.startsWith(`${peer} proposes`)) && !escalated.has(sessionId)) {
        escalated.add(sessionId);
        yield call(request, `protocol:escalate:${name}`, 'agent', { action: 'send', agentId: ownerId,
          text: `Protocol disagreement: ${name} and ${peer} differ on required versus optional; please decide and name one writer.` });
      } else if (messages.some(message => message.agentId === ownerId && message.text === decision)) {
        assert.ok(messages.some(message => message.agentId === ids.get(peer)));
        yield answer(request, `${name} implemented the optional field; evidence: its interface check.`);
      } else yield call(request, `protocol:await:${name}:${turn}`, 'session', { action: 'wait' });
    }
    yield done(request);
  }, { settings: { maxConcurrent: 2 } });
  await fixture.service.submit(messageCommand(ownerId, 'command:protocol', 'PRIVATE_ROOT_NOT_DELEGATED: coordinate the two implementations.'));
  const parent = await completed(fixture.service, ownerId);
  assert.equal(entered.size, 2);
  assert.equal(parent.agentTasks.length, 2);
  assert.ok(parent.agentTasks.every(task => task.result.content.includes('implemented the optional field')));
  for (const childId of ids.values()) {
    const child = await fixture.service.snapshot(childId);
    assert.deepEqual(child.agentContext.capabilities, { messaging: true, continuation: true, delegation: false });
    assert.deepEqual(child.agentTasks ?? [], []);
    assert.equal(fixture.releases.get(childId), 1);
    const messages = (await readEvents(fixture.journal, childId)).filter(event => event.type === 'agent.message.received');
    assert.equal(messages.filter(event => event.payload.sourceSessionId === ownerId && event.payload.text === decision).length, 1);
    assert.equal(messages.filter(event => event.payload.sourceSessionId !== ownerId).length, 1);
  }
  assert.equal((await readEvents(fixture.journal, ownerId)).some(event => event.type === 'session.control.rejected'), false);
});

test('a creating ancestor cannot cancel or close a descendant now assigned by the coordinator', async t => {
  const ownerId = 'session:current-task-management';
  let ancestorId, descendantId, released = false;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal, service }) {
    assert.ok(turn < 14);
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'management:ancestor', 'agent', { action: 'spawn', preset: 'collaboration',
        capabilities: { delegation: true }, name: 'Ancestor', task: 'Create a child and finish the initial task.', delivery: 'wait' });
      else if (turn === 2) {
        for (const agentId of [descendantId, ancestorId]) yield call(request, `management:assign:${agentId}`, 'agent', {
          action: 'assign', agentId, task: 'Continue under the root coordinator.',
        });
      } else if (textOf(request).includes('Current ownership checks completed.') && !released) {
        released = true;
        yield call(request, 'management:finish', 'agent', { action: 'send', agentId: descendantId, text: 'Coordinator permits task completion.' });
      } else if ((await service.snapshot(ownerId)).agentTasks.every(task => task.status === 'completed')) yield answer(request, 'Ownership preserved.');
      else yield call(request, `management:wait:${turn}`, 'agent', { action: 'wait' });
    } else if ((await readEvents(journal, sessionId))[0].payload.displayTitle === 'Ancestor') {
      ancestorId = sessionId;
      if (turn === 1) yield call(request, 'management:descendant', 'agent', { action: 'spawn', preset: 'collaboration',
        name: 'Descendant', task: 'Return initial evidence.', delivery: 'wait' });
      else if (turn === 2) yield answer(request, 'Initial ancestor work complete.');
      else if (turn === 3) {
        const root = await service.snapshot(ownerId);
        const task = root.agentTasks.find(task => task.agentSessionId === descendantId && task.status === 'running');
        yield call(request, 'management:forbidden-cancel', 'agent', { action: 'cancel', taskId: task.taskId });
      } else if (turn === 4) {
        assert.match(textOf(request), /agent_task_not_owned/u);
        yield call(request, 'management:forbidden-close', 'agent', { action: 'close', agentId: descendantId });
      } else if (turn === 5) {
        assert.match(textOf(request), /agent_coordinator_required/u);
        assert.equal((await service.snapshot(descendantId)).run.status, 'running');
        yield call(request, 'management:report', 'agent', { action: 'send', agentId: ownerId, text: 'Current ownership checks completed.' });
      } else yield answer(request, 'Ancestor follow-up complete.');
    } else {
      descendantId = sessionId;
      if (turn === 1) yield answer(request, 'Initial descendant evidence.');
      else if (textOf(request).includes('Coordinator permits task completion.')) yield answer(request, 'Descendant follow-up complete.');
      else yield call(request, `management:child-wait:${turn}`, 'session', { action: 'wait' });
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:management', 'Continue retained members under the main coordinator.'));
  const result = await completed(fixture.service, ownerId);
  assert.equal(result.agentTasks.length, 3);
  assert.ok(result.agentTasks.every(task => task.status === 'completed'));
  const ancestor = await fixture.service.snapshot(ancestorId);
  assert.equal(ancestor.agentChildren[0].closed, false);
  assert.equal((await readEvents(fixture.journal, descendantId)).some(event => event.type === 'run.settled' && event.payload.outcome === 'cancelled'), false);
});

test('close rejects an active member and its idle archival ancestor without implicit cancellation or partial closure', async t => {
  const ownerId = 'session:idle-close';
  let ancestorId, leafId, closed = false;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal, service }) {
    assert.ok(turn < 14);
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'idle-close:create', 'agent', { action: 'spawn', preset: 'collaboration',
        capabilities: { delegation: true }, name: 'Ancestor', task: 'Create a retained child and finish.', delivery: 'wait' });
      else if (turn === 2) yield call(request, 'idle-close:assign', 'agent', { action: 'assign', agentId: leafId, task: 'Wait for a reply, then finish.' });
      else if (turn === 3) yield call(request, 'idle-close:active', 'agent', { action: 'close', agentId: leafId });
      else if (turn === 4) {
        assert.match(textOf(request), /agent_child_not_idle/u);
        yield call(request, 'idle-close:ancestor', 'agent', { action: 'close', agentId: ancestorId });
      } else if (turn === 5) {
        const rejections = (await readEvents(journal, ownerId)).filter(event => event.type === 'session.control.rejected');
        assert.equal(rejections.length, 2);
        assert.ok(rejections.every(event => event.payload.error.code === 'agent_child_not_idle'));
        for (const id of [ownerId, ancestorId, leafId]) {
          const history = await readEvents(journal, id);
          assert.equal(history.some(event => event.type === 'agent.closed'), false);
          assert.equal(history.some(event => event.type === 'run.settled' && event.payload.outcome === 'cancelled'), false);
        }
        assert.equal((await service.snapshot(leafId)).run.status, 'running');
        yield call(request, 'idle-close:reply', 'agent', { action: 'send', agentId: leafId, text: 'Finish with your final evidence now.' });
      } else if (!(await service.snapshot(ownerId)).agentTasks.every(task => task.status === 'completed')) {
        yield call(request, `idle-close:wait:${turn}`, 'agent', { action: 'wait' });
      } else if (!closed) {
        closed = true;
        yield call(request, 'idle-close:finished', 'agent', { action: 'close', agentId: ancestorId });
      } else yield answer(request, 'The whole idle subtree is closed without cancelling completed work.');
    } else if ((await readEvents(journal, sessionId))[0].payload.displayTitle === 'Ancestor') {
      ancestorId = sessionId;
      if (turn === 1) yield call(request, 'idle-close:leaf', 'agent', { action: 'spawn', preset: 'collaboration',
        name: 'Leaf', task: 'Return the initial result.', delivery: 'wait' });
      else yield answer(request, 'Initial ancestor result.');
    } else {
      leafId = sessionId;
      if (turn === 1) yield answer(request, 'Initial leaf result.');
      else if (textOf(request).includes('Finish with your final evidence now.')) yield answer(request, 'Final leaf evidence.');
      else yield call(request, `idle-close:leaf-wait:${turn}`, 'session', { action: 'wait' });
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:idle-close', 'Close retained members only after their actual task results.'));
  const root = await completed(fixture.service, ownerId);
  assert.ok(root.agentTasks.every(task => task.status === 'completed'));
  assert.ok(root.agentChildren.every(child => child.closed));
  assert.ok((await fixture.service.snapshot(ancestorId)).agentChildren.every(child => child.closed));
  const leafEvents = await readEvents(fixture.journal, leafId);
  assert.equal(leafEvents.filter(event => event.type === 'run.settled').length, 2);
  assert.ok(leafEvents.filter(event => event.type === 'run.settled').every(event => event.payload.outcome === 'completed'));
});

test('business messages bypass an unrelated child creation admission without reading its unstarted reservation', async t => {
  const ownerId = 'session:message-during-admission';
  const creation = Promise.withResolvers(), releaseCreation = Promise.withResolvers();
  t.after(() => releaseCreation.resolve());
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal }) {
    if (sessionId === ownerId) {
      if (turn === 1) {
        yield call(request, 'admission:active', 'agent', { action: 'spawn', preset: 'collaboration', name: 'Active', task: 'Send your update.', delivery: 'async' });
        yield call(request, 'admission:slow', 'agent', { action: 'spawn', name: 'Slow', task: 'Return evidence.', delivery: 'async' });
      } else yield answer(request, 'All evidence received.');
    } else if ((await readEvents(journal, sessionId))[0].payload.displayTitle === 'Active' && turn === 1) {
      await creation.promise;
      yield call(request, 'admission:message', 'agent', { action: 'send', agentId: ownerId, text: 'Message while another child is being prepared.' });
    } else yield answer(request, 'Child evidence.');
    yield done(request);
  }, { async beforeCreate(input) {
    if (input.displayTitle === 'Slow') { creation.resolve(); await releaseCreation.promise; }
  } });
  await fixture.service.submit(messageCommand(ownerId, 'command:admission-message', 'Delegate two tracks.'));
  await creation.promise;
  await waitUntil(async () => (await readEvents(fixture.journal, ownerId)).some(event => event.type === 'agent.message.received'),
    'message must arrive before the creation gate is released');
  releaseCreation.resolve();
  assert.equal((await completed(fixture.service, ownerId)).agentTasks.length, 2);
});

test('parent cancellation drains both a peer-message wait and a pending child Plan', async t => {
  const ownerId = 'session:cancel-collaboration';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal }) {
    if (sessionId === ownerId) {
      if (turn === 1) {
        for (const name of ['Waiting peer', 'Plan writer']) yield call(request, `cancel:spawn:${name}`, 'agent', {
          action: 'spawn', preset: 'collaboration', name, task: 'Wait for coordination.', delivery: 'async',
        });
      } else yield call(request, `cancel:wait:${turn}`, 'agent', { action: 'wait' });
    } else if ((await readEvents(journal, sessionId))[0].payload.displayTitle === 'Plan writer') {
      yield call(request, 'cancel:child-plan', 'plan_publish', writePlan);
    } else yield call(request, 'cancel:peer-wait', 'session', { action: 'wait' });
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:cancel-collaboration', 'Coordinate two workers.'));
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).pendingAgentDecisions?.some(item => item.plan), 'child Plan pending');
  const before = await fixture.service.snapshot(ownerId);
  const waitingPeer = before.agentChildren.find(child => child.displayName === 'Waiting peer').agentSessionId;
  await waitUntil(async () => (await readEvents(fixture.journal, waitingPeer)).some(event => event.type === 'session.control.completed'), 'peer waiting for a message');
  assert.equal((await fixture.service.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId: ownerId,
    commandId: 'command:cancel-both', runId: before.run.runId })).status, 'accepted');
  const after = await fixture.service.snapshot(ownerId);
  assert.equal(after.run.status, 'cancelled');
  assert.ok(after.agentTasks.every(task => task.status === 'cancelled'));
  assert.deepEqual(after.pendingAgentDecisions ?? [], []);
  for (const sessionId of [ownerId, ...before.agentChildren.map(child => child.agentSessionId)]) {
    const child = await fixture.service.snapshot(sessionId);
    assert.equal(child.run.status, 'cancelled');
    assert.equal(child.pendingPlan, null);
    assert.equal(fixture.releases.get(sessionId), 1);
    const events = await readEvents(fixture.journal, sessionId);
    assert.ok(events.find(event => event.type === 'run.runtime.released').sequence < events.find(event => event.type === 'run.settled').sequence);
  }
});

test('nested spawn input errors return correction results before a valid child task starts', async t => {
  const ownerId = 'session:spawn-input-correction';
  const invalid = [
    { fields: { loop: { controls: { id: '' } } }, message: 'agent_contribution_invalid' },
    { fields: { runner: { id: '' } }, message: 'agent_contribution_invalid' },
    { fields: { permissions: { 'agent.permissions.shell': 'invalid' } }, message: 'permission_setting_invalid:agent.permissions.shell' },
  ];
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId !== ownerId) yield answer(request, 'Child correction completed.');
    else if (turn <= invalid.length + 1) {
      assert.deepEqual((await service.snapshot(ownerId)).agentTasks ?? [], [], 'invalid inputs cannot start a child');
      if (turn > 1) {
        const rejection = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
        assert.equal(rejection.error.code, 'agent_configuration_invalid');
        assert.equal(rejection.error.message, invalid[turn - 2].message);
      }
      yield call(request, `spawn:correction:${turn}`, 'agent', {
        action: 'spawn', name: 'Worker', task: 'Complete the corrected task.', delivery: 'wait',
        ...(invalid[turn - 1]?.fields ?? {}),
      });
    } else {
      assert.equal(turn, invalid.length + 2);
      assert.ok(textOf(request).includes('Child correction completed.'));
      yield answer(request, 'Parent correction completed.');
    }
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:spawn-correction', 'Delegate this task.'));
  const projection = await completed(fixture.service, ownerId);
  assert.equal(projection.agentTasks.length, 1);
  assert.equal(projection.agentTasks[0].status, 'completed');
  const events = await readEvents(fixture.journal, ownerId);
  assert.equal(events.filter(event => event.type === 'run.started').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'session.control.rejected').map(event => event.payload.error.message),
    invalid.map(item => item.message));
  assert.equal(events.filter(event => event.type === 'agent.task.created').length, 1);
  assert.equal(projection.messages.at(-1).content, 'Parent correction completed.');
});

test('one contribution registry validates, describes and restores supported instance choices', async () => {
  const { SessionConfigurationRegistry, builtinSessionContributions } = await import('../dist/index.js');
  const { agentPresets } = await import('../dist/local-agent/agentConfiguration.js');
  const registry = new SessionConfigurationRegistry();
  const controls = { id: 'standard', parameters: { optionalTools: [] } };
  const saved = registry.resolve(undefined, { controls });
  assert.deepEqual(saved.controls, controls);
  assert.equal(registry.describe(false).context, undefined);
  assert.deepEqual(registry.describe(false).compaction[0].parametersSchema.properties, {});
  assert.throws(() => registry.resolve(undefined, { context: { id: 'journal' } }), /agent_full_configuration_required/);
  assert.throws(() => registry.resolve(undefined, { compaction: { id: 'summary', parameters: { pressureRatio: 0.8 } } }), /agent_full_configuration_required/);
  const advanced = registry.resolve(undefined, { context: { id: 'journal' }, compaction: { id: 'summary', parameters: { pressureRatio: 0.8 } } }, true);
  assert.equal(advanced.compaction.parameters.pressureRatio, 0.8);
  assert.throws(() => registry.resolve(undefined, { controls: { id: 'missing' } }, true), /agent_contribution_unavailable/);
  assert.throws(() => registry.resolve(undefined, { controls: { id: 'standard', parameters: { optionalTools: ['unknown'] } } }, true), /agent_controls_parameters_invalid/);
  let created = 0, disposed = 0;
  const base = createSessionCapabilities();
  const custom = new SessionConfigurationRegistry([...builtinSessionContributions(), {
    kind: 'context', id: 'registered-context', description: 'Registered context contribution.',
    parametersSchema: { type: 'object', additionalProperties: false, properties: {} },
    validate(parameters) { assert.deepEqual(parameters, {}); },
    create() { created += 1; return { implementation: base.context, async dispose() { disposed += 1; } }; },
  }]);
  const configuration = custom.resolve(saved, { context: { id: 'registered-context' } }, true);
  for (let activation = 0; activation < 2; activation += 1) {
    const ports = await custom.create(structuredClone(configuration));
    assert.deepEqual(ports.controls.optionalTools, []);
    assert.throws(() => ports.controls.decode('call:disabled', 'todo.update', { items: [] }), /session_control_unavailable/);
    await ports.dispose();
  }
  assert.deepEqual([created, disposed], [2, 2]);
  const presets = agentPresets({ presets: JSON.stringify([{ id: 'custom', name: 'Custom', capabilities: { messaging: false, continuation: true, delegation: false }, configuration }]) });
  assert.equal(presets[2].configuration.context.id, 'registered-context');
});

test('recipes select registered drivers for root and model-composed child sessions and restore them', async t => {
  const { AgentLoopRegistry, builtinAgentLoops, runAgentLoop } = await import('../dist/index.js');
  const ownerId = 'session:composed-drivers';
  const runs = [], disposed = [];
  const loops = new AgentLoopRegistry([...builtinAgentLoops(), {
    id: 'instrumented', description: 'Host-installed instrumented driver.',
    parametersSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' } } },
    validate(parameters) { if (typeof parameters.label !== 'string') throw new Error('label_required'); },
    create({ label }) { return {
      label,
      async run(...args) { runs.push(this.label); return runAgentLoop(...args); },
      async dispose() { disposed.push(this.label); },
    }; },
  }]);
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId !== ownerId) {
      assert.equal(request.tools.some(tool => tool.name === 'todo_update'), false);
      yield answer(request, 'Composed worker finished.');
    } else if (turn === 1) yield call(request, 'compose:discover', 'agent', { action: 'models' });
    else if (turn === 2) {
      const choices = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.deepEqual(choices.presets.map(preset => preset.id), ['analysis', 'collaboration']);
      assert.ok(choices.runners.some(runner => runner.id === 'instrumented'));
      assert.ok(choices.permissionPolicies.some(policy => policy.id === 'workspace-only'));
      assert.equal(choices.workspaceSandbox.defaultBackendId, 'platform-default');
      yield call(request, 'compose:spawn', 'agent', { action: 'spawn', task: 'Inspect with a task-specific driver.',
        name: 'Dependency investigator', delivery: 'wait', profileId: 'profile:chosen', reasoningEffort: 'high',
        capabilities: { messaging: false, continuation: false, delegation: false },
        runner: { id: 'instrumented', parameters: { label: 'child' } },
        context: { id: 'journal' }, loop: { controls: { id: 'standard', parameters: { optionalTools: [] } },
          compaction: { id: 'summary', parameters: { pressureRatio: 0.75 } } },
        permissionPolicy: { id: 'workspace-only' }, workspaceSandbox: { backendId: 'platform-default' },
      });
    } else yield answer(request, 'Composed task complete.');
    yield done(request);
  }, { loops, settings: { allowFullConfiguration: true }, recipe: {
    runner: { id: 'instrumented', parameters: { label: 'root' } }, permissionPolicy: { id: 'workspace-only' },
  } });
  await fixture.service.submit(messageCommand(ownerId, 'command:composition', 'Compose a worker.'));
  const parent = await completed(fixture.service, ownerId);
  const childId = parent.agentTasks[0].agentSessionId;
  const child = await fixture.service.snapshot(childId);
  assert.equal(child.run.status, 'completed');
  assert.equal(child.recipe.runner.parameters.label, 'child');
  assert.equal(child.recipe.profileId, 'profile:chosen');
  assert.equal(child.recipe.configuration.compaction.parameters.pressureRatio, 0.75);
  assert.equal(child.recipe.permissionPolicy.id, 'workspace-only');
  assert.equal(child.agentContext.configuration, undefined, 'one creation owner for new configuration');
  await fixture.service.dispose();
  assert.deepEqual(runs.sort(), ['child', 'root']);
  assert.deepEqual(disposed.sort(), ['child', 'root']);
  const restored = await serviceFixture(t, ownerId, async function* ({ request }) {
    yield answer(request, 'Restored driver completed.'); yield done(request);
  }, { journal: fixture.journal, reopen: true, loops });
  await restored.service.submit(messageCommand(ownerId, 'command:restored-driver', 'Continue.'));
  await completed(restored.service, ownerId);
  await restored.service.dispose();
  assert.equal(runs.filter(label => label === 'root').length, 2);
  assert.equal(disposed.filter(label => label === 'root').length, 2);
});

test('unknown drivers and child policy escalation are rejected before child creation', async t => {
  const ownerId = 'session:recipe-denials';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    assert.equal(sessionId, ownerId);
    if (turn <= 2) yield call(request, `deny:${turn}`, 'agent', {
      action: 'spawn', name: 'Rejected worker', task: 'Must not start.', delivery: 'wait',
      ...(turn === 1 ? { runner: { id: 'uninstalled' } } : { permissionPolicy: { id: 'local-standard' } }),
    });
    else {
      assert.match(textOf(request), /agent_loop_unavailable/u);
      assert.match(textOf(request), /agent_policy_not_grantable/u);
      yield answer(request, 'All invalid compositions were rejected.');
    }
    yield done(request);
  }, { settings: { allowFullConfiguration: true }, recipe: { permissionPolicy: { id: 'workspace-only' }, permissions: { 'agent.permissions.workspaceMutation': 'plan' } } });
  await assert.rejects(fixture.service.createSession({ sessionId: 'session:bad-runner', displayTitle: 'Bad',
    workspaceBindings: [workspaceBinding], recipe: { runner: { id: 'uninstalled' } } }), /agent_loop_unavailable/);
  await assert.rejects(readEvents(fixture.journal, 'session:bad-runner'), /session_not_found/);
  await fixture.service.submit(messageCommand(ownerId, 'command:deny-recipes', 'Try invalid compositions.'));
  assert.deepEqual((await completed(fixture.service, ownerId)).agentTasks ?? [], []);
});

test('saved Session delegation changes do not rewrite a running task declaration or inject settings into messages', async t => {
  const ownerId = 'session:delegation-toggle';
  let fixture;
  fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    assert.equal(sessionId, ownerId, 'disabled delegation must not start a child');
    assert.equal(request.tools.some(tool => tool.name === 'agent'), false, 'unstarted delegation has no model tool');
    if (turn === 1) {
      for (const [i, enabled] of [true, false, true, true, false].entries()) {
        const edit = subagentSettingsCommand(ownerId, `command:toggle:${i}`, { ...fixture.settings, enabled });
        assert.equal((await service.submit(edit)).status, 'accepted');
      }
      yield call(request, 'toggle:discover', 'agent', { action: 'models' });
    } else if (turn === 2) {
      const first = fixture.requests.get(ownerId)[0];
      assert.deepEqual(request.tools, first.tools);
      assert.deepEqual(request.messages.slice(0, first.messages.length), first.messages);
      assert.equal(occurrences(textOf(request), 'stop delegating new tasks'), 0);
      assert.equal(occurrences(textOf(request), 'new agent delegation is enabled'), 0);
      yield call(request, 'toggle:rejected', 'agent', { action: 'spawn', name: 'Disabled', task: 'Must not start', delivery: 'async' });
    } else {
      assert.equal(turn, 3);
      assert.match(textOf(request), /provider_tool_alias_unknown/u);
      yield answer(request, 'Continued without delegating.');
    }
    yield done(request);
  }, { settings: { enabled: false } });
  await fixture.service.submit(messageCommand(ownerId, 'command:toggle', 'Inspect available agent operations.'));
  const state = await completed(fixture.service, ownerId);
  assert.deepEqual(state.agentTasks ?? [], []);
  const events = await readEvents(fixture.journal, ownerId);
  assert.equal(events[0].payload.subagentSettings.enabled, false, 'creation captured the original selection');
  assert.equal(events.find(event => event.type === 'run.started').payload.runtimeSnapshot.subagentSettings.enabled, false);
  assert.deepEqual(events.filter(event => event.type === 'session.subagent-settings.updated').map(e => e.payload.settings.enabled), [true, false, true, true, false]);
  const last = events.at(-1);
  const compacted = [...events, { ...last, eventId: 'event:toggle-compacted', sequence: last.sequence + 1,
    type: 'context.compacted', payload: { compactionId: 'compact:toggle', coveredThroughSequence: last.sequence,
      summary: 'The task inspected available agent operations.' } }];
  const retained = messagesFromJournal(compacted, state.run.runId, [workspaceBinding]);
  const policies = retained.filter(item => item.contributionId.startsWith('agent-delegation:'));
  assert.equal(policies.length, 0, 'settings remain journal facts and do not become model text');
  const before = fixture.requests.get(ownerId).length;
  assert.equal((await fixture.service.submit(subagentSettingsCommand(ownerId, 'command:toggle-idle', { ...fixture.settings, enabled: true }))).status, 'accepted');
  assert.equal(fixture.requests.get(ownerId).length, before, 'a setting change does not start a model request');
});

test('delegation changes during execution preserve the provider call and result group', async t => {
  const ownerId = 'session:delegation-in-flight';
  let fixture;
  const tool = { toolBindingRef: 'binding:toggle-read', name: 'fs.read', description: 'Read one file.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: [],
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) yield call(request, 'toggle:read', 'fs_read', { path: 'example.txt' });
    else {
      assert.equal(turn, 2);
      const callIndex = request.messages.findIndex(message => message.role === 'assistant' && message.toolCalls?.length);
      assert.ok(callIndex >= 0);
      const result = request.messages[callIndex + 1];
      assert.equal(result.role, 'tool', 'runtime notices must not split the call/result group');
      assert.equal(result.providerCallId, 'toggle:read');
      const notices = request.messages.slice(callIndex + 2).filter(message => message.role === 'user' && message.content.startsWith('Runtime setting changed:'));
      assert.equal(notices.length, 0);
      assert.ok(request.tools.some(tool => tool.name === 'agent'), 'the in-flight run keeps its captured declaration');
      yield answer(request, 'Read complete.');
    }
    yield done(request);
  }, { preparation: { tools: [tool] }, kernel: () => emptyKernel({ async execute(request) {
    assert.equal((await fixture.service.submit(subagentSettingsCommand(ownerId, 'command:read-toggle',
      { ...fixture.settings, enabled: false }))).status, 'accepted');
    return completedExecutionReply(request, { content: 'Read evidence.' });
  } }) });
  await fixture.service.submit(messageCommand(ownerId, 'command:in-flight-toggle', 'Read example.txt.'));
  await completed(fixture.service, ownerId);
});

test('A and B retain independent settings and C journals the whole creation selection supplied by its Host', async t => {
  const a = 'session:settings-a', ownerId = 'session:settings-b', c = 'session:settings-c';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId && turn === 1) {
      assert.match(request.tools.find(tool => tool.name === 'agent').description, /Proactively delegate useful independent work/u);
      assert.doesNotMatch(textOf(request), /new agent delegation is enabled|stop delegating new tasks/u);
      yield call(request, 'settings:spawn', 'agent', { action: 'spawn', name: 'Inspector', task: 'Inspect independently.', delivery: 'wait' });
    } else {
      if ([a, c].includes(sessionId)) assert.equal(request.tools.some(tool => tool.name === 'agent'), sessionId === c);
      yield answer(request, 'Independent evidence.');
    }
    yield done(request);
  });
  const aModel = { profileId: 'profile:default', reasoningEffortOverride: 'medium' };
  const bModel = { profileId: 'profile:chosen', reasoningEffortOverride: 'high' };
  await fixture.service.createSession({ sessionId: a, displayTitle: 'A', workspaceBindings: [workspaceBinding],
    profileId: aModel.profileId, recipe: { reasoningEffort: aModel.reasoningEffortOverride } });
  const aChoice = { ...fixture.settings, enabled: false, profileId: 'profile:default', reasoningEffort: 'medium', maxConcurrent: 1 };
  const bChoice = { ...fixture.settings, enabled: true, profileId: 'profile:chosen', reasoningEffort: 'high', allowFullConfiguration: true };
  assert.equal((await fixture.service.submit(subagentSettingsCommand(a, 'command:save-a', aChoice))).status, 'accepted');
  assert.equal((await fixture.service.submit(subagentSettingsCommand(ownerId, 'command:save-b', bChoice))).status, 'accepted');
  const modelEdit = { schemaVersion: 'achbit.command.v3', type: 'session.model-settings.set', sessionId: ownerId,
    commandId: 'command:save-b-model', settings: bModel };
  assert.equal((await fixture.service.submit(modelEdit)).status, 'accepted');
  assert.equal((await fixture.service.submit(modelEdit)).status, 'replayed');
  const b = await fixture.service.snapshot(ownerId);
  assert.deepEqual([b.modelSettings, b.subagentSettings], [bModel, bChoice], 'editing the model retains the other half for the Host');
  // Host chooses the default tuple. Session must persist exactly its supplied creation fields, not reread a different default.
  await fixture.service.createSession({ sessionId: c, displayTitle: 'C', workspaceBindings: [], profileId: b.modelSettings.profileId,
    recipe: { reasoningEffort: b.modelSettings.reasoningEffortOverride }, subagentSettings: b.subagentSettings });
  assert.equal(fixture.defaultReads, 2, 'only A and B needed a Host seed; commands and explicitly seeded C did not');
  const creation = (await readEvents(fixture.journal, c))[0].payload;
  assert.deepEqual([creation.profileId, creation.recipe.reasoningEffort, creation.subagentSettings], [bModel.profileId, bModel.reasoningEffortOverride, bChoice]);
  for (const id of [a, ownerId, a, c, ownerId]) {
    const view = await fixture.service.snapshot(id);
    assert.deepEqual([view.modelSettings, view.subagentSettings], id === a ? [aModel, aChoice] : [bModel, bChoice]);
  }
  assert.equal(fixture.requests.size, 0, 'saving and switching between views starts no Provider');
  for (const [id, choice] of [[a, aChoice], [c, bChoice]]) {
    await fixture.service.submit(messageCommand(id, `command:${id}`, 'Start with this conversation selection.'));
    await completed(fixture.service, id);
    assert.deepEqual((await readEvents(fixture.journal, id)).find(e => e.type === 'run.started').payload.runtimeSnapshot.subagentSettings, choice);
  }
  await fixture.service.submit(messageCommand(ownerId, 'command:settings-run', 'Inspect the evidence.'));
  const finished = await completed(fixture.service, ownerId);
  const child = await fixture.service.snapshot(finished.agentChildren[0].agentSessionId);
  assert.deepEqual(child.subagentSettings, bChoice);
  assert.equal(child.agentContext.capabilities.delegation, false, 'inherited configuration cannot elevate analysis capability');
  assert.equal(child.run.profileId, 'profile:chosen');
  assert.equal(child.run.reasoningEffort, 'high');
  assert.deepEqual((await fixture.service.snapshot(a)).subagentSettings, aChoice);
  assert.equal(fixture.defaultReads, 2, 'assignments inherit their caller’s captured selection instead of reading Host defaults');
  await fixture.service.dispose();
  const reopened = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) yield call(request, 'disabled:discover', 'agent', { action: 'models' });
    else {
      const discovery = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.ok(discovery.operations.every(operation => !['spawn', 'assign'].includes(operation.action)));
      yield answer(request, 'Next task captured the newly saved owner selection.');
    }
    yield done(request);
  }, { journal: fixture.journal, reopen: true, settings: fixture.settings });
  for (const id of [a, ownerId, c, child.sessionId]) {
    const view = await reopened.service.snapshot(id);
    assert.deepEqual([view.modelSettings, view.subagentSettings], id === a ? [aModel, aChoice] : [bModel, bChoice]);
  }
  assert.equal(reopened.requests.size, 0, 'opening history starts no Provider');
  assert.equal((await reopened.service.submit(subagentSettingsCommand(ownerId, 'command:settings-b-off', aChoice))).status, 'accepted');
  const updated = await reopened.service.snapshot(ownerId);
  assert.deepEqual([updated.modelSettings, updated.subagentSettings], [bModel, aChoice], 'editing subagents retains the saved model and effort');
  await reopened.service.submit(messageCommand(ownerId, 'command:settings-after-reopen', 'Use this Session’s new selection.'));
  assert.deepEqual((await completed(reopened.service, ownerId)).subagentSettings, aChoice);
  assert.deepEqual((await readEvents(reopened.journal, ownerId)).filter(e => e.type === 'run.started').map(e => e.payload.runtimeSnapshot.subagentSettings), [bChoice, aChoice]);
  assert.deepEqual((await reopened.service.snapshot(c)).subagentSettings, bChoice);
});

test('disabling the parent selection preserves its active run and subsequent assignment until its next task', async t => {
  const ownerId = 'session:settings-running';
  let firstChild;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    if (sessionId !== ownerId) {
      firstChild ??= sessionId;
      started.resolve(sessionId);
      await release.promise;
      const captured = (await service.snapshot(sessionId)).subagentSettings;
      assert.equal(captured.enabled, true, 'both assignments inherit the active parent run, not its latest saved value');
      yield answer(request, 'Child finished after parent settings changed.');
    } else if (turn === 1) yield call(request, 'running:first', 'agent', { action: 'spawn', name: 'Running', task: 'Finish the inspection.', delivery: 'wait' });
    else if (turn === 2) yield call(request, 'running:second', 'agent', { action: 'spawn', name: 'New', task: 'Use the parent task snapshot.', delivery: 'wait' });
    else if (turn === 4) yield call(request, 'disabled:models', 'agent', { action: 'models' });
    else if (turn === 5) {
      const discovery = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.ok(discovery.operations.every(operation => !['spawn', 'assign'].includes(operation.action)));
      yield call(request, 'disabled:spawn', 'agent', { action: 'spawn', name: 'Forbidden', task: 'Must not start.', delivery: 'async' });
    } else {
      if (turn === 6) assert.match(textOf(request), /agent_disabled/u);
      yield answer(request, 'Existing child evidence retained.');
    }
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:settings-running', 'Delegate an inspection.'));
  const childId = await started.promise;
  assert.equal((await fixture.service.submit(subagentSettingsCommand(ownerId, 'command:disable-running-parent',
    { ...fixture.settings, enabled: false }))).status, 'accepted');
  assert.equal((await fixture.service.snapshot(ownerId)).subagentSettings.enabled, false);
  assert.equal((await fixture.service.snapshot(childId)).run.status, 'running');
  release.resolve();
  const finished = await completed(fixture.service, ownerId);
  assert.equal(finished.agentTasks.length, 2);
  assert.ok(finished.agentTasks.every(task => task.status === 'completed'));
  assert.equal(finished.agentChildren[0].closed, false);
  await fixture.service.submit(messageCommand(ownerId, 'command:disabled-next-task', 'Start after changing this Session.'));
  const next = await completed(fixture.service, ownerId);
  assert.equal(next.subagentSettings.enabled, false);
  assert.equal(next.agentTasks.length, 2);
});

test('Session settings validation and replays keep the canonical command reply with exactly one saved fact', async t => {
  const id = 'session:settings-journal';
  const fixture = await serviceFixture(t, id, async function* () { throw new Error('settings_must_not_start_provider'); });
  const original = structuredClone(fixture.settings), bad = { ...original, maxConcurrent: 0 };
  const invalid = subagentSettingsCommand(id, 'command:invalid-write', bad);
  const rejected = await fixture.service.submit(invalid);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error.code, 'agent_settings_invalid');
  const rejectedReplay = await fixture.service.submit(invalid);
  assert.equal(rejectedReplay.status, 'replayed'); assert.deepEqual(rejectedReplay.error, rejected.error);
  assert.equal(fixture.defaultReads, 1, 'invalid commands do not reread creation settings');
  assert.deepEqual((await fixture.service.snapshot(id)).subagentSettings, original);
  await assert.rejects(fixture.service.createSession({ sessionId: 'session:invalid-settings-copy', displayTitle: 'Invalid copy',
    workspaceBindings: [], subagentSettings: bad }), /agent_settings_invalid/);
  await assert.rejects(readEvents(fixture.journal, 'session:invalid-settings-copy'), /session_not_found/);

  const selected = { ...original, enabled: false }, command = subagentSettingsCommand(id, 'command:settings-write', selected);
  const accepted = await fixture.service.submit(command);
  assert.equal(accepted.status, 'accepted');
  const view = await fixture.service.snapshot(id);
  assert.equal(view.revision, accepted.revision);
  assert.deepEqual(view.subagentSettings, selected);
  assert.deepEqual(await fixture.service.submit(command), { ...accepted, status: 'replayed' });
  assert.equal(fixture.defaultReads, 1, 'the Session never rereads defaults for edits/replays');
  assert.deepEqual(fixture.settings, original, 'only the external Host command owner updates creation defaults');
  assert.deepEqual((await readEvents(fixture.journal, id)).filter(e => e.type === 'session.subagent-settings.updated')
    .map(e => [e.payload.commandId, e.payload.settings]), [[command.commandId, selected]]);
  assert.equal(fixture.requests.size, 0);
});

test('total usage includes nested and closed Agents once and updates without a parent journal event', async t => {
  const ownerId = 'session:descendant-usage';
  const journal = new InMemoryCommandJournal();
  let releaseChild, releaseChildFinal, releaseRoot;
  const childGate = new Promise(resolve => { releaseChild = resolve; });
  const childFinalGate = new Promise(resolve => { releaseChildFinal = resolve; });
  const rootGate = new Promise(resolve => { releaseRoot = resolve; });
  t.after(() => { releaseChild(); releaseChildFinal(); releaseRoot(); });
  let childId, grandchildId, rootWaiting = false, childWaiting = false;
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal }) {
    let usage;
    if (sessionId === ownerId) {
      usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheMissInputTokens: 50 };
      if (turn === 1) yield call(request, 'usage:spawn', 'agent', { action: 'spawn', preset: 'collaboration',
        capabilities: { delegation: true }, name: 'Usage child', task: 'Delegate one detail, then report.', delivery: 'async' });
      else if (turn === 2) { rootWaiting = true; await rootGate; yield answer(request, 'Initial work complete.'); }
      else if (turn === 3) yield call(request, 'usage:continue', 'agent', { action: 'assign', agentId: childId, task: 'One follow-up.' });
      else if (turn === 4) yield call(request, 'usage:wait', 'agent', { action: 'wait' });
      else if (turn === 5) yield call(request, 'usage:close', 'agent', { action: 'close', agentId: childId });
      else yield answer(request, 'Archived work complete.');
    } else {
      const creation = (await readEvents(journal, sessionId))[0];
      if (creation.payload.agentContext.parentSessionId === ownerId) {
        childId = sessionId;
        if (turn === 1) {
          await childGate;
          yield call(request, 'usage:nested', 'agent', { action: 'spawn', name: 'Usage grandchild',
            task: 'Return the detail.', delivery: 'wait' });
          usage = { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 180, cacheMissInputTokens: 120 };
        } else if (turn === 2) {
          childWaiting = true; await childFinalGate;
          yield answer(request, 'Child work complete.');
          usage = { inputTokens: 120, outputTokens: 12 }; // Provider omitted cache detail.
        } else yield answer(request, 'Follow-up complete.'); // Provider omitted all usage.
      } else {
        grandchildId = sessionId;
        yield answer(request, 'Detail complete.');
        usage = { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 100, cacheMissInputTokens: 100 };
      }
    }
    yield providerEvent(request.requestId, 'completed', usage ? { usage: { ...usage, contextWindowTokens: 100_000 } } : {});
  }, { journal: forwardingJournal(journal, journal.read.bind(journal)), settings: { allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:usage:first', 'Delegate the details.'));
  await waitUntil(() => rootWaiting && childId, 'parent Provider is held while its child runs');
  const before = await fixture.service.snapshot(ownerId);
  assert.equal(before.totalTokenUsage.inputTokens, 100);
  releaseChild();
  await waitUntil(() => childWaiting, 'nested result has arrived before child final response');
  const during = await fixture.service.snapshot(ownerId);
  assert.equal(during.revision, before.revision, 'child usage does not manufacture a parent journal event');
  assert.equal(during.tokenUsage.inputTokens, 100);
  assert.equal(during.totalTokenUsage.inputTokens, 600);
  assert.equal(during.totalTokenUsage.cacheReadInputTokens, 330);
  assert.equal(during.totalTokenUsage.cacheHitRatio, 330 / 600);
  assert.deepEqual(during.contextUsage, before.contextUsage);
  const childDuring = await fixture.service.snapshot(childId);
  assert.equal(childDuring.tokenUsage.inputTokens, 300);
  assert.equal(childDuring.totalTokenUsage.inputTokens, 500);
  releaseChildFinal();
  await completed(fixture.service, childId);
  releaseRoot();
  await completed(fixture.service, ownerId);
  await fixture.service.submit(messageCommand(ownerId, 'command:usage:again', 'Continue and archive the same member.'));
  const result = await completed(fixture.service, ownerId);
  assert.equal(result.agentChildren.length, 1);
  assert.equal(result.agentTasks.length, 2);
  assert.equal(result.agentChildren[0].closed, true);
  const child = await fixture.service.snapshot(childId), grandchild = await fixture.service.snapshot(grandchildId);
  assert.equal(child.tokenUsage.providerCallCount, 3);
  assert.equal(child.tokenUsage.reportedCallCount, 1);
  assert.equal(result.totalTokenUsage.inputTokens, result.tokenUsage.inputTokens + 420 + 200);
  assert.equal(result.totalTokenUsage.cacheReadInputTokens, result.tokenUsage.cacheReadInputTokens + 180 + 100);
  assert.equal(result.totalTokenUsage.providerCallCount, result.tokenUsage.providerCallCount + 3 + 1);
  assert.equal(result.totalTokenUsage.reportedCallCount, result.tokenUsage.reportedCallCount + 1 + 1);
  assert.equal(result.totalTokenUsage.cacheComplete, false);
  assert.equal(grandchild.totalTokenUsage.inputTokens, 200);
  await fixture.service.dispose();
  const reopened = new SessionService(fixture.journal, { async create() { throw new Error('history_must_not_open_actor'); } });
  t.after(() => reopened.dispose());
  assert.deepEqual((await reopened.snapshot(ownerId)).totalTokenUsage, result.totalTokenUsage,
    'closed descendants and their unknown usage remain included when history is read without Actors');
});

test('ordinary members select coordinator templates without overriding permissions or Loop policy', async t => {
  const ownerId = 'session:template-owner';
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn }) {
    if (sessionId === ownerId) {
      if (turn === 1) yield call(request, 'template:member', 'agent', { action: 'spawn', preset: 'collaboration',
        capabilities: { delegation: true }, name: 'Member', task: 'Inspect your configured templates.', delivery: 'wait' });
      else yield answer(request, 'Template control verified.');
    } else if (turn === 1) yield call(request, 'template:override', 'agent', { action: 'spawn', name: 'Unauthorized customization',
      task: 'Must not start.', delivery: 'wait', permissions: { 'agent.permissions.shell': 'ask' } });
    else if (turn === 2) {
      assert.match(textOf(request), /agent_coordinator_configuration_required/u);
      yield call(request, 'template:discover', 'agent', { action: 'models' });
    } else {
      const choices = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.deepEqual(choices.presets.map(p => p.id), ['analysis', 'collaboration']);
      assert.equal(choices.permissionPolicies, undefined);
      assert.equal(choices.runners, undefined);
      assert.equal(choices.fullConfiguration, false);
      yield answer(request, 'Configured templates available.');
    }
    yield done(request);
  }, { settings: { allowMemberAnalysis: true, allowFullConfiguration: true } });
  await fixture.service.submit(messageCommand(ownerId, 'command:templates', 'Check configured members.'));
  const parent = await completed(fixture.service, ownerId);
  const child = await fixture.service.snapshot(parent.agentTasks[0].agentSessionId);
  assert.deepEqual(child.agentChildren ?? [], []);
  assert.equal(child.run.status, 'completed');
});

test('capability replacement rejects active runs and transfers ownership only while idle', { timeout: 5_000 }, async t => {
  const ownerId = 'session:idle-capabilities';
  const output = Promise.withResolvers(), entered = Promise.withResolvers();
  t.after(() => output.resolve());
  let originalDisposed = 0, replacementDisposed = 0;
  const original = { ...createSessionCapabilities(), async dispose() { originalDisposed += 1; } };
  const replacement = { ...createSessionCapabilities(), async dispose() { replacementDisposed += 1; } };
  const fixture = await serviceFixture(t, ownerId, async function* ({ request }) {
    entered.resolve();
    await output.promise;
    yield answer(request, 'The run kept its original configuration.');
    yield done(request);
  }, { capabilities: original });
  await fixture.service.submit(messageCommand(ownerId, 'command:active-policy', 'Keep the admitted policy.'));
  await entered.promise;
  await assert.rejects(fixture.service.replaceCapabilities(ownerId, replacement), /session_capabilities_run_active/u);
  assert.equal(originalDisposed, 0);
  assert.equal(replacementDisposed, 0, 'rejected ownership stays with the caller');
  output.resolve();
  await completed(fixture.service, ownerId);
  // Drain the settled Loop's final microtasks before the idle operator action.
  await new Promise(resolve => setImmediate(resolve));
  await fixture.service.replaceCapabilities(ownerId, replacement);
  assert.equal(originalDisposed, 1);
  assert.equal(replacementDisposed, 0);
  await fixture.service.dispose();
  assert.equal(replacementDisposed, 1);
});

test('retiring a capability implementation still waits for its final request lease', async () => {
  let oldDisposed = 0, nextDisposed = 0;
  const manager = new SessionCapabilityManager({ ...createSessionCapabilities(), async dispose() { oldDisposed += 1; } });
  const lease = manager.acquire();
  await manager.replace({ ...createSessionCapabilities(), async dispose() { nextDisposed += 1; } });
  assert.equal(oldDisposed, 0);
  await lease.release();
  await lease.release();
  assert.equal(oldDisposed, 1, 'the old request lease releases its implementation once');
  await manager.dispose();
  assert.equal(nextDisposed, 1);
});
