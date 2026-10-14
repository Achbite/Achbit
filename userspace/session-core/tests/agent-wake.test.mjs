import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCapabilities, SessionService } from '../dist/index.js';
import { messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  completedExecutionReply, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents,
  waitUntil, workspaceBinding,
} from './local-agent-fixtures.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'indeterminate']);
const textOf = request => JSON.stringify(request.messages);
const occurrences = (text, value) => text.split(value).length - 1;
const call = (request, callId, name, input) => providerEvent(request.requestId, 'tool.call', { callId, name, input });
const done = request => providerEvent(request.requestId, 'completed', {});
const answer = (request, text) => providerEvent(request.requestId, 'text.delta', { text });

async function serviceFixture(t, ownerId, stream, options = {}) {
  const journal = options.journal ?? new InMemoryCommandJournal();
  const requests = new Map(), preparations = new Map(), disposed = new Map();
  let service;
  const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
    maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, ...options.settings };
  service = new SessionService(journal, { async create({ sessionId }) {
    const preparation = fakeRunPreparation({ contextWindowTokens: 100_000, ...options.preparation });
    return { composition: {
      kernel: options.kernel?.({ sessionId, journal }) ?? emptyKernel(),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      runPreparation: { ...preparation.port, async prepare(input) {
        const prepared = await preparation.port.prepare(input);
        prepared.runtimeSnapshot.agentToolsEnabled = true;
        prepared.runtimeSnapshot.agentDelegationEnabled = settings.enabled;
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
    async settings() { return { ...settings }; },
    async models() { return [
      { profileId: 'profile:default', name: 'Default', model: 'fixture-model', parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['low', 'medium', 'high'] },
      { profileId: 'profile:chosen', name: 'Chosen model', model: 'chosen-model', parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['high'] },
    ]; },
    async createSession(input) { return service.createSession(input); },
  }, options.configurations, options.loops);
  t.after(() => service.dispose());
  if (!options.reopen) await service.createSession({ sessionId: ownerId, displayTitle: 'Wake owner', workspaceBindings: [workspaceBinding], ...(options.recipe ? { recipe: options.recipe } : {}) });
  return { journal, service, requests, preparations, disposed, settings };
}

async function completed(service, sessionId) {
  await waitUntil(async () => terminal.has((await service.snapshot(sessionId)).run?.status), 'completed Agent task');
  const projection = await service.snapshot(sessionId);
  assert.equal(projection.run.status, 'completed', JSON.stringify(projection.terminalError));
  return projection;
}

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
        assert.deepEqual(result.agents, [{ agentId: childId, name: 'Frontend', status: 'completed', acceptsTasks: true }]);
        yield call(request, 'retained:send', 'agent', { action: 'send', agentId: childId, text: 'Continue the frontend review.' });
      } else if (parentRuns === 2 && !textOf(request).includes('Second frontend observation.')) {
        yield call(request, `retained:wait:${runTurn}`, 'agent', { action: 'wait' });
      } else yield answer(request, `Parent round ${parentRuns} is complete.`);
    }
    yield done(request);
  });
  fixture.settings.allowFullConfiguration = true;
  await fixture.service.submit(messageCommand(ownerId, 'command:retained:first', 'Review the frontend.'));
  const first = await completed(fixture.service, ownerId);
  const firstChild = await fixture.service.snapshot(childId);
  const firstRunId = first.run.runId;
  fixture.settings.profileId = 'profile:new-default';
  fixture.settings.reasoningEffort = '';
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
      if (!request.nonWorkspaceAuthority) return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution',
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
  assert.equal((await fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond',
    sessionId: childId, commandId: 'command:child-plan', runId: childRunId,
    ...plan.plan, response: { kind: 'confirm' } })).status, 'accepted');
  const question = await pending('question');
  assert.equal(question.agentSessionId, childId);
  assert.equal(question.runId, childRunId);
  assert.equal(question.plan, undefined);
  assert.equal((await fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'interaction.respond',
    sessionId: childId, commandId: 'command:child-question', runId: childRunId,
    interactionId: question.interactionIds[0], response: 'Use the north station.' })).status, 'accepted');
  const approval = await pending('approval');
  assert.equal(approval.agentSessionId, childId);
  assert.equal(approval.runId, childRunId);
  assert.deepEqual(approval.interactionIds, []);
  assert.equal((await fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'approval.respond',
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
        name: 'Coordinator', task: 'Create a reusable writer and obtain its initial report.', delivery: 'wait' });
      else if (turn === 2) {
        memberId = (await service.snapshot(ownerId)).agentChildren[0].agentSessionId;
        descendantId = (await service.snapshot(memberId)).agentChildren[0].agentSessionId;
        yield call(request, 'root:continue-descendant', 'agent', { action: 'send', agentId: descendantId,
          text: 'Publish the new report scope for user confirmation.' });
      } else if (!textOf(request).includes('The descendant report is confirmed.')) {
        yield call(request, `root:wait:${turn}`, 'agent', { action: 'wait' });
      } else yield answer(request, 'The descendant continuation is complete.');
    } else {
      const creation = (await readEvents(fixture.journal, sessionId))[0];
      if (creation.payload.agentContext.parentSessionId === ownerId) {
        if (turn === 1) yield call(request, 'member:create-writer', 'agent', { action: 'spawn', preset: 'collaboration',
          name: 'Writer', task: 'Return an initial report.', delivery: 'wait' });
        else yield answer(request, 'The reusable writer is ready.');
      } else if (turn === 1) yield answer(request, 'Initial writer report.');
      else if (turn === 2) yield call(request, 'descendant:plan', 'plan_publish', writePlan);
      else yield answer(request, 'The descendant report is confirmed.');
    }
    yield done(request);
  });
  await fixture.service.submit(messageCommand(ownerId, 'command:descendant', 'Delegate, then continue the reusable descendant.'));
  await waitUntil(async () => (await fixture.service.snapshot(ownerId)).pendingAgentDecisions?.some(item => item.plan), 'continued descendant Plan');
  const root = await fixture.service.snapshot(ownerId);
  const route = root.pendingAgentDecisions[0];
  assert.equal(route.agentSessionId, descendantId);
  const task = root.agentTasks.find(item => item.agentSessionId === descendantId);
  assert.equal(route.runId, task.childRunId);
  assert.equal((await fixture.service.snapshot(descendantId)).agentContext.parentSessionId, memberId);
  assert.equal((await fixture.service.snapshot(memberId)).run.status, 'completed');
  const reply = await fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond',
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
  assert.equal((await fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond',
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

test('a visible Plan confirmation waits for the previous Loop resource lease before resuming', async t => {
  const ownerId = 'session:plan-release-race';
  let releaseOutput, releaseCleanup, enteredProvider = false, enteredCleanup = false;
  const outputGate = new Promise(resolve => { releaseOutput = resolve; });
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  t.after(() => { releaseOutput(); releaseCleanup(); });
  const capabilities = { ...createSessionCapabilities(), async dispose() {
    enteredCleanup = true;
    await cleanupGate;
  } };
  const fixture = await serviceFixture(t, ownerId, async function* ({ request, turn }) {
    if (turn === 1) {
      enteredProvider = true;
      await outputGate;
      yield call(request, 'release-race:plan', 'plan_publish', writePlan);
    } else yield answer(request, 'Continued after the confirmed Plan.');
    yield done(request);
  }, { capabilities });
  await fixture.service.submit(messageCommand(ownerId, 'command:release-race', 'Confirm the report Plan.'));
  await waitUntil(() => enteredProvider, 'first request holds its Session capability lease');
  await fixture.service.replaceCapabilities(ownerId, createSessionCapabilities());
  releaseOutput();
  await waitUntil(() => enteredCleanup, 'retired capability cleanup starts after publishing the Plan');
  const waiting = await fixture.service.snapshot(ownerId);
  assert.equal(waiting.run.status, 'waiting');
  const plan = waiting.pendingPlan;
  assert.ok(plan);
  let replied = false;
  const response = fixture.service.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond',
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
  const add = (type, payload, callId) => events.push({ schemaVersion: 'deepcode.session-event.v5', sessionId, runId,
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

test('an accepted session wait reloads with its original timer and deadline and no uncertain Provider result', async t => {
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
  const reopened = await serviceFixture(t, ownerId, async function* ({ request }) {
    assert.deepEqual(request.messages.slice(0, sentPrefix.length), sentPrefix);
    assert.equal(request.messages.filter(message => message.role === 'user' && message.content === reminder).length, 1);
    assert.doesNotMatch(textOf(request), /"afterSequence"|"deadline"|provider_turn_outcome_unknown/u);
    yield answer(request, 'The scheduled review survived reloading.');
    yield done(request);
  }, { journal, reopen: true });
  await reopened.service.replaceCapabilities(ownerId, createSessionCapabilities());
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
  const reopened = await serviceFixture(t, ownerId, async function* ({ sessionId, request }) {
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
  await reopened.service.replaceCapabilities(ownerId, createSessionCapabilities());
  const complete = await completed(reopened.service, ownerId);
  assert.equal(complete.agentTasks.length, 1);
  assert.equal(complete.agentTasks[0].status, 'completed');
  assert.equal(complete.agentTasks[0].agentSessionId, childId);
  assert.equal(reopened.requests.get(ownerId).length, 1);
  assert.equal(reopened.requests.get(childId).length, 1);
  assert.equal((await readEvents(journal, ownerId)).filter(event => event.type === 'agent.task.completed').length, 1);
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

test('a permitted peer wakes a dormant instance without changing lineage or its saved configuration', async t => {
  const ownerId = 'session:peer-wake';
  let northId, northFinished;
  const northReady = new Promise(resolve => { northFinished = resolve; });
  const fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, journal, service }) {
    if (sessionId === ownerId) {
      if (turn === 1) {
        yield call(request, 'peer:north', 'agent', { action: 'spawn', preset: 'collaboration', name: 'North', task: 'Return your first finding.', delivery: 'async',
          loop: { controls: { id: 'standard', parameters: { optionalTools: [] } } } });
        yield call(request, 'peer:south', 'agent', { action: 'spawn', preset: 'collaboration', name: 'South', task: 'Review North.', delivery: 'async' });
      } else if (!(await service.snapshot(ownerId)).agentTasks.every(task => task.status === 'completed')) {
        yield call(request, `peer:wait:${turn}`, 'agent', { action: 'wait' });
      } else yield answer(request, 'Both peer tasks are complete.');
    } else {
      const name = (await readEvents(journal, sessionId))[0].payload.displayTitle;
      if (name === 'North') {
        northId = sessionId;
        assert.equal(request.tools.some(tool => tool.name === 'todo_update'), false);
        yield answer(request, turn === 1 ? 'North first finding.' : 'North follow-up finding.');
        if (turn === 1) northFinished();
      } else if (turn === 1) {
        await northReady;
        await waitUntil(async () => (await service.snapshot(northId)).run?.status === 'completed', 'North dormant');
        yield call(request, 'peer:send', 'agent', { action: 'send', agentId: northId, text: 'Review the second observation.' });
      } else if (!textOf(request).includes('North follow-up finding.')) {
        yield call(request, `peer:south-wait:${turn}`, 'agent', { action: 'wait' });
      } else yield answer(request, 'South reviewed the follow-up.');
    }
    yield done(request);
  });
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
  const southId = parent.agentChildren.find(value => value.agentSessionId !== northId).agentSessionId;
  const south = await fixture.service.snapshot(southId);
  assert.equal(south.agentTasks[0].agentSessionId, northId);
  assert.deepEqual(south.agentChildren ?? [], [], 'the task sender does not acquire archival ownership');
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
  }, { recipe: { permissionPolicy: { id: 'workspace-only' }, permissions: { 'agent.permissions.workspaceMutation': 'plan' } } });
  await assert.rejects(fixture.service.createSession({ sessionId: 'session:bad-runner', displayTitle: 'Bad',
    workspaceBindings: [workspaceBinding], recipe: { runner: { id: 'uninstalled' } } }), /agent_loop_unavailable/);
  await assert.rejects(readEvents(fixture.journal, 'session:bad-runner'), /session_not_found/);
  await fixture.service.submit(messageCommand(ownerId, 'command:deny-recipes', 'Try invalid compositions.'));
  assert.deepEqual((await completed(fixture.service, ownerId)).agentTasks ?? [], []);
});

test('delegation toggles append ordered facts without changing tools or accepting disabled tasks', async t => {
  const ownerId = 'session:delegation-toggle';
  let fixture;
  fixture = await serviceFixture(t, ownerId, async function* ({ sessionId, request, turn, service }) {
    assert.equal(sessionId, ownerId, 'disabled delegation must not start a child');
    assert.ok(request.tools.some(tool => tool.name === 'agent'), 'the installed handler remains discoverable when off');
    if (turn === 1) {
      for (const enabled of [true, false, true, true, false]) {
        fixture.settings.enabled = enabled;
        await service.delegationChanged(enabled);
      }
      yield call(request, 'toggle:discover', 'agent', { action: 'models' });
    } else if (turn === 2) {
      const first = fixture.requests.get(ownerId)[0];
      assert.deepEqual(request.tools, first.tools);
      assert.deepEqual(request.messages.slice(0, first.messages.length), first.messages);
      assert.equal(occurrences(textOf(request), 'stop delegating new tasks'), 3);
      assert.equal(occurrences(textOf(request), 'new agent delegation is enabled'), 2);
      yield call(request, 'toggle:rejected', 'agent', { action: 'spawn', name: 'Disabled', task: 'Must not start', delivery: 'async' });
    } else {
      assert.equal(turn, 3);
      assert.match(textOf(request), /agent_disabled/u);
      yield answer(request, 'Continued without delegating.');
    }
    yield done(request);
  }, { settings: { enabled: false } });
  await fixture.service.submit(messageCommand(ownerId, 'command:toggle', 'Inspect available agent operations.'));
  const state = await completed(fixture.service, ownerId);
  assert.deepEqual(state.agentTasks ?? [], []);
  const events = await readEvents(fixture.journal, ownerId);
  assert.deepEqual(events.filter(event => event.type === 'agent.delegation.changed').map(event => event.payload.enabled),
    [false, true, false, true, false]);
  const last = events.at(-1);
  const compacted = [...events, { ...last, eventId: 'event:toggle-compacted', sequence: last.sequence + 1,
    type: 'context.compacted', payload: { compactionId: 'compact:toggle', coveredThroughSequence: last.sequence,
      summary: 'The task inspected available agent operations.' } }];
  const retained = messagesFromJournal(compacted, state.run.runId, [workspaceBinding]);
  const policies = retained.filter(item => item.contributionId.startsWith('agent-delegation:'));
  assert.equal(policies.length, 1, 'compaction retains the latest exact policy independently of summary wording');
  assert.match(policies[0].message.content, /stop delegating new tasks/u);
  const before = fixture.requests.get(ownerId).length;
  fixture.settings.enabled = true;
  await fixture.service.delegationChanged(true);
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
      assert.equal(notices.length, 2);
      assert.match(notices[0].content, /stop delegating new tasks/u);
      assert.match(notices[1].content, /new agent delegation is enabled/u);
      yield answer(request, 'Read complete.');
    }
    yield done(request);
  }, { preparation: { tools: [tool] }, kernel: () => emptyKernel({ async execute(request) {
    for (const enabled of [false, true]) {
      fixture.settings.enabled = enabled;
      await fixture.service.delegationChanged(enabled);
    }
    return completedExecutionReply(request, { content: 'Read evidence.' });
  } }) });
  await fixture.service.submit(messageCommand(ownerId, 'command:in-flight-toggle', 'Read example.txt.'));
  await completed(fixture.service, ownerId);
});

test('total usage includes nested and closed Agents once and updates without a parent journal event', async t => {
  const ownerId = 'session:descendant-usage';
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
        name: 'Usage child', task: 'Delegate one detail, then report.', delivery: 'async' });
      else if (turn === 2) { rootWaiting = true; await rootGate; yield answer(request, 'Initial work complete.'); }
      else if (turn === 3) yield call(request, 'usage:continue', 'agent', { action: 'send', agentId: childId, text: 'One follow-up.' });
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
  });
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
