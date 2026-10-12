import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  decodeToolPromptProviderSnapshots,
  prepareToolPromptContributions,
  renderActiveToolGuidance,
  SessionService,
  emptySessionState,
  reduceSession,
  recoverSession,
  projectSession,
  loopSnapshot,
  runtimeInstructions,
  sessionControlToolDefinitions,
} from '../dist/index.js';
import { buildAgentProviderRequest, messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { publishPlan } from '../dist/local-agent/planStage.js';
import { HttpProviderPort } from '../dist/local-agent/httpPorts.js';
import { responseFrames } from '../dist/responseFrames.js';
import { environmentInstruction } from '../dist/local-agent/sessionEnvironment.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { LoopFailure } from '../dist/local-agent/loopFailure.js';
import { AgentManager } from '../dist/local-agent/agentManager.js';

const ALL_AGENT_CAPS = { messaging: true, continuation: true, delegation: true };
const NO_AGENT_CAPS = { messaging: false, continuation: false, delegation: false };

test('editing a settled message replaces active history while retaining journal facts and attachments', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:message-edit';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const requests = [];
  let releaseEdit;
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  t.after(() => releaseEdit());
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 4) await editGate;
    yield providerEvent(request.requestId, 'text.delta', { text: `Answer ${requests.length}.` });
    yield providerEvent(request.requestId, 'completed', { usage: {
      inputTokens: 100, outputTokens: 20, contextWindowTokens: 4_096,
      cacheReadInputTokens: 75, cacheMissInputTokens: 25,
    } });
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'message-edit');
  t.after(() => actor.dispose());
  const reference = { referenceId: 'reference:original', workspaceId: workspaceBinding.workspaceId,
    logicalPath: 'notes.txt', displayName: 'notes.txt', kind: 'file', mediaType: 'text/plain', byteLength: 8 };
  for (const [index, text] of ['Keep this first question.', 'Replace this second question.', 'Remove this third question.'].entries()) {
    await actor.submit({ ...messageCommand(sessionId, `command:edit-seed:${index}`, text),
      ...(index === 1 ? { filesystemReferences: [reference] } : {}) });
    await waitForProjection(actor, (value) => value.run?.status === 'completed' && requests.length === index + 1);
  }
  const original = await actor.snapshot();
  const saved = await readEvents(journal, sessionId);
  const statusReader = new SessionService(journal, { async create() { throw new Error('status_read_must_not_open_an_actor'); } });
  t.after(() => statusReader.dispose());
  await statusReader.statuses([sessionId]);
  const command = { schemaVersion: 'deepcode.command.v3', type: 'message.edit', sessionId,
    commandId: 'command:edit', messageId: original.messages[2].messageId, expectedRevision: original.revision, text: 'Revised second question.' };
  const stale = await actor.submit({ ...command, commandId: 'command:stale', expectedRevision: original.revision - 1 });
  assert.equal(stale.error.code, 'message_edit_stale');
  const invalid = await actor.submit({ ...command, commandId: 'command:invalid', messageId: original.messages[1].messageId });
  assert.equal(invalid.error.code, 'message_edit_target_invalid');
  const reply = await actor.submit(command);
  assert.equal(reply.status, 'accepted');
  await waitUntil(() => requests.length === 4, 'edited provider input');
  const active = await actor.submit({ ...command, commandId: 'command:active' });
  assert.equal(active.error.code, 'message_edit_run_active');
  releaseEdit();
  const edited = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual(edited.messages.map((message) => message.content), ['Keep this first question.', 'Answer 1.', 'Revised second question.', 'Answer 4.']);
  assert.deepEqual(edited.messages[2].filesystemReferences, [reference]);
  assert.equal(edited.tokenUsage.providerCallCount, 4, 'superseded calls still consumed Provider usage');
  assert.equal(edited.tokenUsage.inputTokens, 400);
  assert.equal(edited.tokenUsage.cacheReadInputTokens, 300);
  const input = JSON.stringify(requests[3].messages);
  assert.ok(input.includes('Keep this first question.'));
  assert.ok(input.includes('Revised second question.'));
  assert.equal(/Replace this second|Remove this third|Answer 2\.|Answer 3\./u.test(input), false);
  const after = await readEvents(journal, sessionId);
  assert.deepEqual(after.slice(0, saved.length), saved, 'the original journal is never rewritten');
  assert.equal(after.filter((event) => event.type === 'conversation.revised').length, 1);
  assert.equal((await actor.submit(command)).status, 'replayed');
  assert.equal(requests.length, 4, 'replayed edits cannot start another run');
  assert.deepEqual((await statusReader.statuses([sessionId]))[0].run, { runId: edited.run.runId, status: 'completed' });
  const read = await statusReader.read({ sessionId, view: 'messages' });
  assert.equal(/Replace this second|Remove this third|Answer 2\.|Answer 3\./u.test(JSON.stringify(read)), false);
  assert.deepEqual(projectSession(loopSnapshot(sessionId, after).state), edited);
  await actor.dispose();
  const restored = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'message-edit-reopened');
  t.after(() => restored.dispose());
  await restored.recover();
  assert.deepEqual(await restored.snapshot(), edited);
  await restored.submit({ ...command, commandId: 'command:edit-again', messageId: edited.messages[2].messageId,
    expectedRevision: edited.revision, text: 'Second revision.' });
  const second = await waitForProjection(restored, (value) => value.run?.status === 'completed' && requests.length === 5);
  assert.deepEqual(second.messages.map((message) => message.content), ['Keep this first question.', 'Answer 1.', 'Second revision.', 'Answer 5.']);
  assert.equal(second.tokenUsage.inputTokens, 500);
});

test('editing conversation history preserves member lineage without replaying superseded results', async (t) => {
  const sessionId = 'session:member-edit', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  const requests = [];
  let actor;
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await actor.recordAgentEvents([
        { type: 'agent.task.created', sessionId, runId: request.runId, callId: 'call:member',
          payload: { taskId: 'task:member', agentSessionId: 'session:member-child', capabilities: ALL_AGENT_CAPS, createsAgent: true,
            displayName: 'Researcher', text: 'Inspect the original request.', delivery: 'async' } },
        { type: 'agent.task.started', sessionId, runId: request.runId,
          payload: { taskId: 'task:member', childRunId: 'run:member-child' } },
        { type: 'agent.task.completed', sessionId, runId: request.runId,
          payload: { taskId: 'task:member', result: { outcome: 'completed', content: 'Superseded member evidence.', finalMessageId: 'message:member-result' } } },
      ]);
    }
    yield providerEvent(request.requestId, 'text.delta', { text: 'Task completed.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'member-edit');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:original', 'Original member request.'));
  const original = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(requests.length, 2, 'new child evidence fences the first premature answer');
  assert.ok(JSON.stringify(requests[1].messages).includes('Superseded member evidence.'));
  const reply = await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'message.edit', sessionId,
    commandId: 'command:member-edit', messageId: original.messages[0].messageId,
    expectedRevision: original.revision, text: 'Revised request.' });
  assert.equal(reply.status, 'accepted');
  const edited = await waitForProjection(actor, value => value.run?.status === 'completed' && requests.length === 3);
  assert.deepEqual(edited.agentTasks, original.agentTasks);
  assert.deepEqual(edited.agentChildren, original.agentChildren);
  assert.equal(/Original member request|Superseded member evidence/u.test(JSON.stringify(requests[2].messages)), false);
  await actor.recordAgentEvents([{ type: 'agent.closed', sessionId, payload: { agentSessionId: 'session:member-child' } }]);
  const closed = await actor.snapshot();
  assert.equal(closed.agentChildren[0].closed, true);
  const rebuilt = projectSession(loopSnapshot(sessionId, await readEvents(journal, sessionId)).state);
  assert.deepEqual(rebuilt.agentTasks, original.agentTasks);
  assert.deepEqual(rebuilt.agentChildren, closed.agentChildren);
  assert.deepEqual(rebuilt.messages.map(message => message.content), ['Revised request.', 'Task completed.']);
});

test('cancellation during delegation admission is observed without starting a child', async () => {
  const controller = new AbortController();
  const reason = new Error('parent_cancelled_during_admission');
  let hostCalls = 0;
  const manager = new AgentManager({
    async settings() { hostCalls += 1; throw new Error('cancelled_admission_reached_host'); },
    async createSession() { hostCalls += 1; throw new Error('cancelled_admission_created_child'); },
  }, async sessionId => ({
    async agentCapabilities() { return ALL_AGENT_CAPS; },
    async snapshot() {
      controller.abort(reason);
      return { sessionId, run: { runId: 'run:cancel-admission', status: 'running' } };
    },
  }));
  try {
    await assert.rejects(manager.execute('session:cancel-admission', 'run:cancel-admission', 'call:cancel-admission',
      { action: 'spawn', task: 'Must not start.', name: 'Cancelled analysis', delivery: 'async' }, controller.signal),
    error => error === reason);
  } finally { await manager.dispose(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hostCalls, 0);
});

test('subagent model command overrides agree with the public schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: Ajv } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile(new URL('../../../contracts/agent-runtime/schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile({ $defs: schema.$defs, $ref: '#/$defs/AgentOperation' });
  const definition = sessionControlToolDefinitions(undefined, true).find(tool => tool.name === 'agent');
  assert.equal(validate({ action: 'models' }), true);
  assert.deepEqual(decodeSessionControlCall('call:models', 'agent', { action: 'models' }).operation, { action: 'models' });
  assert.equal(definition.inputSchema.properties.profileId.type, 'string');
  assert.deepEqual(definition.inputSchema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const preset of ['analysis', 'collaboration']) {
    const operation = { action: 'spawn', preset, capabilities: { messaging: false, continuation: true },
      task: 'Inspect the task evidence.', name: 'Researcher', delivery: 'async',
      profileId: 'profile:selected', reasoningEffort: 'high' };
    assert.equal(validate(operation), true, JSON.stringify(validate.errors));
    assert.deepEqual(decodeSessionControlCall('call:model-selection', 'agent', operation).operation, operation);
    for (const invalid of [{ ...operation, profileId: '' }, { ...operation, reasoningEffort: '' },
      { ...operation, action: 'analyze' }, { ...operation, capabilities: { messaging: 'yes' } },
      { ...operation, capabilities: { computerUse: true } }]) {
      assert.equal(validate(invalid), false);
      assert.throws(() => decodeSessionControlCall('call:model-selection', 'agent', invalid));
    }
  }
  assert.equal(validate({ action: 'send', agentId: 'session:member', text: 'Follow up.', profileId: 'profile:selected' }), false);
  assert.throws(() => decodeSessionControlCall('call:send-model', 'agent',
    { action: 'send', agentId: 'session:member', text: 'Follow up.', profileId: 'profile:selected' }));
});

test('subagent model defaults and per-call overrides use the owner Run binding', async (t) => {
  const cases = [
    { name: 'main follows its bound Run, not the next GUI selection', expected: ['profile:owner-bound', 'medium'] },
    { name: 'member follows the owner Run, not its own model', member: true, expected: ['profile:owner-bound', 'medium'] },
    { name: 'following model permits an independent configured effort', settings: { reasoningEffort: 'high' }, expected: ['profile:owner-bound', 'high'] },
    { name: 'independent model uses its preset without owner effort', settings: { profileId: 'profile:default' }, expected: ['profile:default', null] },
    { name: 'independent model uses its configured effort', settings: { profileId: 'profile:default', reasoningEffort: 'high' }, expected: ['profile:default', 'high'] },
    { name: 'explicit model does not inherit another model effort', action: 'spawn', settings: { profileId: 'profile:default', reasoningEffort: 'high' },
      operation: { profileId: 'profile:override' }, expected: ['profile:override', null] },
    { name: 'explicit model and effort reach the child together', action: 'spawn', operation: { profileId: 'profile:override', reasoningEffort: 'max' }, expected: ['profile:override', 'max'] },
    { name: 'effort alone overrides the default', settings: { reasoningEffort: 'high' }, operation: { reasoningEffort: 'low' }, expected: ['profile:owner-bound', 'low'] },
    { name: 'missing owner Run rejects instead of using GUI selection', member: true, missingOwnerRun: true },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const ownerId = 'session:model-owner', memberId = 'session:model-member';
    const callerId = item.member ? memberId : ownerId;
    const ownerRuntime = runtimeSnapshot('run:owner-bound', { profileId: 'profile:owner-bound', reasoningEffort: 'medium' });
    const memberRuntime = { ...runtimeSnapshot('run:member-bound', { profileId: 'profile:member-bound', reasoningEffort: 'low' }),
      agentCapabilities: ALL_AGENT_CAPS, agentToolsEnabled: true };
    const states = new Map();
    states.set(ownerId, { ...emptySessionState(ownerId),
      run: item.missingOwnerRun ? undefined : { runId: 'run:owner-bound', status: 'running', workspaceBindings: [],
        profileId: 'profile:owner-bound', reasoningEffort: 'medium' },
      runRuntimeSnapshots: item.missingOwnerRun ? {} : { 'run:owner-bound': ownerRuntime },
      modelSettings: { profileId: 'profile:gui-next', reasoningEffortOverride: 'xhigh' },
      agentChildren: item.member ? [{ agentSessionId: memberId, displayName: 'Member', capabilities: ALL_AGENT_CAPS, closed: false }] : [] });
    if (item.member) states.set(memberId, { ...emptySessionState(memberId),
      agentContext: { capabilities: ALL_AGENT_CAPS, ownerSessionId: ownerId, parentSessionId: ownerId,
        parentRunId: 'run:owner-bound', parentCallId: 'call:member' },
      runRuntimeSnapshots: { 'run:member-bound': memberRuntime },
      run: { runId: 'run:member-bound', status: 'running', workspaceBindings: [], profileId: 'profile:member-bound', reasoningEffort: 'low' } });
    const actors = new Map([...states.keys()].map(sessionId => [sessionId, { sessionId,
      async agentCapabilities(runId) { return states.get(sessionId).runRuntimeSnapshots[runId].agentCapabilities; },
      async snapshot() { return projectSession(states.get(sessionId)); },
      async recordAgentEvents(events) {
        for (const event of events) {
          const state = states.get(sessionId);
          states.set(sessionId, reduceSession(state, { ...event, schemaVersion: 'deepcode.session-event.v5',
            sequence: state.revision + 1, eventId: `event:${sessionId}:${state.revision + 1}`, occurredAt: '2026-10-12T00:00:00.000Z' }));
        }
      } }]));
    const created = [], submitted = [];
    const manager = new AgentManager({
      async settings() { return { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
        maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, ...item.settings }; },
      async createSession(input) {
        created.push(structuredClone(input));
        let run;
        actors.set(input.sessionId, { sessionId: input.sessionId,
          async agentCapabilities() { return input.agentContext.capabilities; },
          async snapshot() { return { sessionId: input.sessionId, agentContext: input.agentContext, run }; },
          async submit(command) {
            if (command.type === 'message.submit') {
              submitted.push(structuredClone(command));
              run = { runId: 'run:new-child', status: 'completed' };
            }
            return { status: 'accepted' };
          },
          async waitForRunResult() { return { outcome: 'completed', content: 'Task evidence.', finalMessageId: 'message:child-final' }; } });
      },
    }, async id => { assert.ok(actors.has(id), `Unknown actor ${id}`); return actors.get(id); });
    try {
      const runId = states.get(callerId).run.runId;
      const operation = { action: item.action ?? 'spawn', task: 'Inspect the evidence.', name: 'Researcher', delivery: 'async', ...item.operation };
      const execution = manager.execute(callerId, runId, 'call:delegate', operation, new AbortController().signal);
      if (item.missingOwnerRun) {
        await assert.rejects(execution, /agent_owner_run_model_missing/);
        assert.deepEqual(created, []);
        assert.deepEqual(submitted, []);
        assert.equal(states.get(callerId).agentTasks.length, 0);
      } else {
        await execution;
        await manager.forSession(callerId).wait(runId, new AbortController().signal);
        assert.equal(created.length, 1);
        assert.equal(submitted.length, 1);
        assert.equal(created[0].profileId, item.expected[0]);
        assert.deepEqual([submitted[0].profileId, submitted[0].reasoningEffortOverride], item.expected);
        assert.equal(states.get(callerId).agentTasks[0].result.outcome, 'completed');
      }
    } finally { await manager.dispose(); }
  });
});

test('subagent models discovery uses the Host port without starting children', async () => {
  const { HttpAgentHostPort } = await import('../dist/local-agent/httpPorts.js');
  const models = [{ profileId: 'profile:configured', name: 'Configured model', model: 'model-id',
    reasoningEfforts: ['low', 'high', 'max'], reasoningEffort: 'high' }];
  let requests = 0, capabilities = ALL_AGENT_CAPS;
  const host = new HttpAgentHostPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async (url, init) => {
    requests += 1;
    assert.equal(url, 'http://fixture/api/local-agent/agents/models');
    assert.equal(new Headers(init.headers).get('x-deepcode-session-service-token'), 'fixture');
    return new Response(JSON.stringify({ ok: true, data: models }), { status: 200 });
  } });
  host.settings = async () => { throw new Error('discovery_must_not_start_admission'); };
  host.createSession = async () => { throw new Error('discovery_must_not_create_child'); };
  const manager = new AgentManager(host, async sessionId => ({
    async agentCapabilities() { return capabilities; },
    async snapshot() { return { sessionId, agentContext: { capabilities }, run: { runId: 'run:models', status: 'running' } }; },
  }));
  try {
    assert.deepEqual(await manager.execute('session:member', 'run:models', 'call:models',
      { action: 'models' }, new AbortController().signal), { models });
    assert.equal(requests, 1);
    capabilities = NO_AGENT_CAPS;
    await assert.rejects(manager.execute('session:analysis', 'run:models', 'call:models-analysis',
      { action: 'models' }, new AbortController().signal), /agent_capability_unavailable/);
    assert.equal(requests, 1);
  } finally { await manager.dispose(); }
});

test('an idle member preparation failure cannot reuse its previous successful run', async (t) => {
  const sessionId = 'session:member-reuse', runId = 'run:parent-current', childId = 'session:existing-member';
  const runtime = runtimeSnapshot(runId);
  let state = { ...emptySessionState(sessionId),
    run: { runId, status: 'running', workspaceBindings: [], profileId: runtime.provider.profileId },
    runRuntimeSnapshots: { [runId]: runtime },
    agentChildren: [{ agentSessionId: childId, displayName: 'Researcher', capabilities: ALL_AGENT_CAPS, closed: false }] };
  const facts = [], resultReads = [];
  const parent = { sessionId,
    async agentCapabilities() { return runtime.agentCapabilities; },
    async snapshot() { return projectSession(state); },
    async recordAgentEvents(events) {
      for (const event of events) {
        facts.push(structuredClone(event));
        state = reduceSession(state, { ...event, schemaVersion: 'deepcode.session-event.v5',
          sequence: state.revision + 1, eventId: `event:${state.revision + 1}`, occurredAt: '2026-10-11T00:00:00.000Z' });
      }
    } };
  const prepareError = { code: 'model_prepare_failed', message: 'The selected member model cannot be prepared.' };
  let submissions = 0, childRunId = 'run:previous-success';
  const child = { sessionId: childId,
    async agentCapabilities() { return ALL_AGENT_CAPS; },
    async snapshot() { return { sessionId: childId, agentContext: { capabilities: ALL_AGENT_CAPS, ownerSessionId: sessionId, parentSessionId: sessionId, parentRunId: runId, parentCallId: 'call:create' }, run: { runId: childRunId, status: 'completed' } }; },
    async submit(command) {
      if (command.type === 'session.permissions.set') return { status: 'accepted' };
      assert.equal(command.type, 'message.submit');
      if (++submissions === 1) return { status: 'rejected', error: prepareError };
      childRunId = 'run:new-success';
      return { status: 'accepted' };
    },
    async waitForRunResult(requestedRunId) {
      resultReads.push(requestedRunId);
      return { outcome: 'completed', content: requestedRunId === 'run:previous-success' ? 'Stale prior evidence.' : 'New task evidence.',
        finalMessageId: `message:${requestedRunId}` };
    } };
  const manager = new AgentManager({
    async settings() { return { enabled: true, profileId: 'profile:member', reasoningEffort: '',
      maxConcurrent: 4, maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true }; },
    async createSession() { throw new Error('existing_member_must_be_reused'); },
  }, async id => { assert.ok(id === sessionId || id === childId); return id === sessionId ? parent : child; });
  t.after(() => manager.dispose());
  const signal = new AbortController().signal;
  const first = await manager.execute(sessionId, runId, 'call:prepare-failure', { action: 'send', agentId: childId, text: 'First follow-up.' }, signal);
  const failed = state.agentTasks.find(task => task.taskId === first.taskId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.result, { outcome: 'failed', error: prepareError });
  assert.equal(failed.childRunId, undefined);
  assert.deepEqual(resultReads, [], 'a rejected prepare must not read the previous run result');
  assert.equal(state.agentChildren[0].closed, false);
  assert.equal(facts.some(event => event.type === 'agent.closed'), false);

  const second = await manager.execute(sessionId, runId, 'call:prepare-success', { action: 'send', agentId: childId, text: 'Next follow-up.' }, signal);
  await manager.forSession(sessionId).wait(runId, signal);
  const completed = state.agentTasks.find(task => task.taskId === second.taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.childRunId, 'run:new-success');
  assert.equal(completed.result.content, 'New task evidence.');
  assert.deepEqual(resultReads, ['run:new-success']);
  assert.equal(state.agentChildren[0].closed, false);
  assert.equal(JSON.stringify(state.agentTasks).includes('Stale prior evidence.'), false);
});

test('unified agents preserve nested ownership, custom capabilities, continuation and cancellation', async (t) => {
  const ownerId = 'session:unified-owner';
  const states = new Map(), actors = new Map(), facts = [], submissions = [], results = new Map();
  let sequence = 0, allowChildDelegation = true, configuredProfile = '';
  const initialize = (sessionId, agentContext) => {
    states.set(sessionId, { ...emptySessionState(sessionId), ...(agentContext ? { agentContext } : {}) });
    const actor = { sessionId,
      async agentCapabilities(runId) { return states.get(sessionId).runRuntimeSnapshots[runId].agentCapabilities; },
      async snapshot() { return projectSession(states.get(sessionId)); },
      async recordAgentEvents(events) {
        for (const event of events) {
          facts.push(structuredClone(event));
          const state = states.get(sessionId);
          states.set(sessionId, reduceSession(state, { ...event, schemaVersion: 'deepcode.session-event.v5',
            sequence: state.revision + 1, eventId: `event:${++sequence}`, occurredAt: '2026-10-12T00:00:00.000Z' }));
        }
      },
      async submit(command) {
        if (command.type === 'message.submit') {
          submissions.push(structuredClone(command));
          const settings = states.get(sessionId).modelSettings;
          startRun(sessionId, command.profileId ?? settings?.profileId,
            command.reasoningEffortOverride !== undefined ? command.reasoningEffortOverride : settings?.reasoningEffortOverride);
        }
        if (command.type === 'run.cancel') finish(sessionId, { outcome: 'cancelled' });
        return { status: 'accepted' };
      },
      async waitForRunResult(runId) { return results.get(runId).promise; },
    };
    actors.set(sessionId, actor);
    return actor;
  };
  const startRun = (sessionId, profileId = 'profile:owner', reasoningEffortOverride = null) => {
    const state = states.get(sessionId), runId = `run:unified:${++sequence}`;
    const runtime = runtimeSnapshot(runId, { profileId, reasoningEffort: reasoningEffortOverride,
      agentCapabilities: state.agentContext?.capabilities ?? ALL_AGENT_CAPS });
    states.set(sessionId, { ...state, run: { runId, status: 'running', workspaceBindings: [], profileId },
      modelSettings: { profileId, reasoningEffortOverride },
      runRuntimeSnapshots: { ...state.runRuntimeSnapshots, [runId]: runtime } });
    let resolve;
    results.set(runId, { promise: new Promise(done => { resolve = done; }), resolve });
    return runId;
  };
  const finish = (sessionId, result = { outcome: 'completed', content: 'Task evidence.', finalMessageId: `message:${++sequence}` }) => {
    const state = states.get(sessionId);
    states.set(sessionId, { ...state, run: { ...state.run, status: result.outcome } });
    results.get(state.run.runId).resolve(result);
  };
  initialize(ownerId);
  const ownerRunId = startRun(ownerId);
  const manager = new AgentManager({
    async settings() { return { enabled: true, profileId: configuredProfile, reasoningEffort: '', maxConcurrent: 4,
      maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: allowChildDelegation }; },
    async createSession(input) { return await initialize(input.sessionId, input.agentContext).snapshot(); },
  }, async id => { assert.ok(actors.has(id), `Unknown actor ${id}`); return actors.get(id); });
  t.after(() => manager.dispose());
  const signal = new AbortController().signal;
  const execute = (sessionId, operation) => manager.execute(sessionId, states.get(sessionId).run.runId,
    `call:${++sequence}`, operation, signal);
  const spawn = (sessionId, extra = {}) => execute(sessionId,
    { action: 'spawn', name: 'Researcher', task: 'Inspect the evidence.', delivery: 'async', ...extra });
  const first = await spawn(ownerId, { preset: 'collaboration' });
  const firstId = first.agentId;
  const firstRunId = states.get(firstId).run.runId;
  assert.deepEqual(states.get(firstId).agentContext.capabilities, ALL_AGENT_CAPS);
  const mixedCaps = { messaging: false, continuation: true, delegation: false };
  const nested = await spawn(firstId, { capabilities: mixedCaps, profileId: 'profile:selected-child', reasoningEffort: 'max' });
  const nestedId = nested.agentId;
  const lineage = structuredClone(states.get(nestedId).agentContext);
  assert.equal(lineage.ownerSessionId, ownerId);
  assert.equal(lineage.parentSessionId, firstId);
  assert.deepEqual(lineage.capabilities, mixedCaps);
  await assert.rejects(spawn(nestedId), /agent_capability_unavailable/);
  await assert.rejects(execute(firstId, { action: 'send', agentId: nestedId, text: 'Live message.' }), /agent_message_target_unavailable/);
  const oneShot = await spawn(firstId);
  assert.deepEqual(states.get(oneShot.agentId).agentContext.capabilities, NO_AGENT_CAPS);
  finish(nestedId);
  finish(oneShot.agentId);
  await manager.forSession(firstId).wait(firstRunId, signal);
  assert.equal(states.get(firstId).agentChildren.find(child => child.agentSessionId === oneShot.agentId).closed, true);
  assert.equal(states.get(firstId).agentChildren.find(child => child.agentSessionId === nestedId).closed, false);
  finish(firstId);
  await manager.forSession(ownerId).wait(ownerRunId, signal);

  configuredProfile = 'profile:new-global-default';
  const continued = await execute(ownerId, { action: 'send', agentId: nestedId, text: 'Continue the shared task.' });
  assert.equal(submissions.at(-1).profileId, undefined);
  assert.equal(submissions.at(-1).reasoningEffortOverride, undefined);
  assert.deepEqual(states.get(nestedId).modelSettings, { profileId: 'profile:selected-child', reasoningEffortOverride: 'max' });
  assert.deepEqual(states.get(nestedId).agentContext, lineage);
  assert.deepEqual(states.get(ownerId).agentChildren.map(child => child.agentSessionId), [firstId]);
  assert.equal(states.get(firstId).agentChildren.filter(child => child.agentSessionId === nestedId).length, 1);
  assert.equal(facts.find(event => event.type === 'agent.task.created' && event.payload.taskId === continued.taskId).payload.createsAgent, false);
  await execute(ownerId, { action: 'cancel', taskId: continued.taskId });
  assert.equal(states.get(ownerId).agentTasks.find(task => task.taskId === continued.taskId).result.outcome, 'cancelled');
  assert.equal(states.get(firstId).agentChildren.find(child => child.agentSessionId === nestedId).closed, false);
  await execute(ownerId, { action: 'close', agentId: firstId });
  assert.equal(states.get(ownerId).agentChildren[0].closed, true);
  assert.equal(states.get(firstId).agentChildren.find(child => child.agentSessionId === nestedId).closed, true);
  assert.equal(facts.some(event => event.type === 'agent.closed' && event.sessionId === ownerId && event.payload.agentSessionId === nestedId), false);
  allowChildDelegation = false;
  await assert.rejects(spawn(ownerId, { capabilities: { delegation: true } }), /agent_capability_not_grantable/);
  const limited = await spawn(ownerId, { preset: 'collaboration' });
  assert.deepEqual(states.get(limited.agentId).agentContext.capabilities, { ...ALL_AGENT_CAPS, delegation: false });
  finish(limited.agentId);
  await manager.forSession(ownerId).wait(ownerRunId, signal);
  allowChildDelegation = true;
  const restricted = await spawn(ownerId, { capabilities: { messaging: false, continuation: true, delegation: true } });
  await assert.rejects(spawn(restricted.agentId, { capabilities: { messaging: true } }), /agent_capability_not_grantable/);
  const permitted = await spawn(restricted.agentId);
  finish(permitted.agentId);
  await manager.forSession(restricted.agentId).wait(states.get(restricted.agentId).run.runId, signal);
  finish(restricted.agentId);
  await manager.forSession(ownerId).wait(ownerRunId, signal);
});

test('browser authorization scope survives reducer snapshots and projection copies', () => {
  const sessionId = 'session:browser-scope';
  const event = { type: 'approval.requested', sessionId, runId: 'run:browser', callId: 'call:browser',
    eventId: 'event:browser', sequence: 3, occurredAt: '2026-09-16T00:00:00Z',
    payload: { approvalId: 'approval:browser', preview: {
      summary: 'Use the internal browser', effects: ['external'], logicalTargets: ['browser:preview-1'], authorizationScope: 'sessionBrowser',
    } },
  };
  const input = reduceSession(emptySessionState(sessionId), { ...event, type: 'message.committed', sequence: 1, eventId: 'event:input',
    payload: { messageId: 'message:input', role: 'user', content: 'Test the browser', filesystemReferences: [], pluginSelections: [] },
  });
  const running = reduceSession(input, { ...event, type: 'run.started', sequence: 2, eventId: 'event:start',
    payload: { inputMessageId: 'message:input', workspaceBindings: [], runtimeSnapshot: runtimeSnapshot('run:browser') },
  });
  const state = reduceSession(running, event);
  const projected = projectSession(state);
  assert.equal(projected.pendingApproval.preview.authorizationScope, 'sessionBrowser');
  projected.pendingApproval.preview.effects.push('network');
  assert.deepEqual(state.pendingApproval.preview.effects, ['external']);
  const resolved = reduceSession(state, { ...event, type: 'approval.resolved', sequence: 4, eventId: 'event:allow',
    payload: { approvalId: 'approval:browser', commandId: 'command:allow', authorityId: 'authority:browser', decision: 'allow' },
  });
  assert.equal(projectSession(resolved).pendingApproval, null);
  assert.equal(projectSession(resolved).activities.find((activity) => activity.kind === 'approval').status, 'completed');
  const denied = reduceSession(state, { ...event, type: 'approval.resolved', sequence: 4, eventId: 'event:deny',
    payload: { approvalId: 'approval:browser', commandId: 'command:deny', authorityId: 'authority:denied', decision: 'deny' },
  });
  assert.equal(projectSession(denied).activities.find((activity) => activity.kind === 'approval').status, 'denied');
  assert.equal(state.pendingApproval.preview.authorizationScope, 'sessionBrowser');
});

test('queued input joins the same run after complete tool results and keeps late input before settlement', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:queued-turns';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'binding:queued-read', name: 'fs.read', description: 'Read a file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  let releaseProvider, releaseTool, releaseAnswer;
  const providerReady = new Promise((resolve) => { releaseProvider = resolve; });
  const toolReady = new Promise((resolve) => { releaseTool = resolve; });
  const answerReady = new Promise((resolve) => { releaseAnswer = resolve; });
  const requests = [];
  let toolStarted = false;
  let cancellations = 0;
  const originalError = { code: 'file_not_found', message: 'The requested file is missing.' };
  const kernel = emptyKernel({
    async execute(request) {
      toolStarted = true;
      await toolReady;
      return failedExecutionReply(request, null, originalError);
    },
    async cancel() { cancellations += 1; throw new Error('queued_input_must_not_cancel'); },
  });
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await providerReady;
      assert.equal(signal.aborted, false);
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider-call:queued-read', name: request.tools.find((tool) => tool.inputSchema.properties?.path).name,
        input: { workspace: 'primary', path: 'missing.txt' },
      });
    } else {
      if (requests.length === 2) {
        const toolIndex = request.messages.findIndex((message) => message.role === 'tool');
        const firstInput = request.messages.findIndex((message) => message.content === 'First supplement.');
        const secondInput = request.messages.findIndex((message) => message.content === 'Second supplement.');
        assert.ok(toolIndex >= 0 && firstInput > toolIndex && secondInput > firstInput);
        assert.deepEqual(jsonMessagePayload(request.messages[toolIndex]).error, originalError);
        await answerReady;
      } else {
        assert.equal(requests.length, 3);
        assert.equal(request.messages.at(-1).content, 'Last supplement.');
      }
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `answer:${requests.length}`, content: `Answer ${requests.length}.`,
      });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, kernel, preparation.port, 'queued-turns');
  t.after(async () => { releaseProvider(); releaseTool(); releaseAnswer(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:queue-start', 'Read the file.'));
  await waitUntil(() => requests.length === 1, 'initial Provider turn');
  const runId = (await actor.snapshot()).run.runId;
  const first = messageCommand(sessionId, 'command:queue-first', 'First supplement.');
  assert.equal((await actor.submit(first)).status, 'accepted');
  assert.equal((await actor.submit(first)).status, 'replayed');
  releaseProvider();
  await waitUntil(() => toolStarted, 'executing tool');
  await actor.submit(messageCommand(sessionId, 'command:queue-second', 'Second supplement.'));
  const queued = await actor.snapshot();
  assert.deepEqual(queued.queuedInputs.map((input) => input.text), ['First supplement.', 'Second supplement.']);
  assert.equal(queued.messages.some((message) => message.content === first.text), false);
  const changedRuntime = await actor.submit({ ...messageCommand(sessionId, 'command:queue-model', 'Keep my draft.'), profileId: 'profile:other' });
  assert.equal(changedRuntime.status, 'rejected');
  assert.equal(changedRuntime.error.code, 'queued_input_runtime_change');
  releaseTool();
  await waitUntil(() => requests.length === 2, 'next Provider sees complete tool and queued input');
  await actor.submit(messageCommand(sessionId, 'command:queue-last', 'Last supplement.'));
  releaseAnswer();
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.run.runId, runId);
  assert.deepEqual(completed.queuedInputs, []);
  assert.equal(preparation.prepared.length, 1);
  assert.equal(cancellations, 0);
  const tool = completed.activities.find((activity) => activity.kind === 'tool').tool;
  assert.deepEqual(tool.error, originalError);
  tool.error.message = 'Shell-local edit';
  assert.deepEqual((await actor.snapshot()).activities.find((activity) => activity.kind === 'tool').tool.error, originalError);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'run.started').length, 1);
  assert.equal(events.filter((event) => event.type === 'input.queued').length, 3);
  // Every event can advance from a frozen prior state. Sharing historical facts
  // must never mutate an earlier replay result or leak through public projection.
  const freeze = (value) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  let state = emptySessionState(sessionId);
  for (const event of events) { freeze(state); state = reduceSession(state, event); }
  assert.deepEqual(projectSession(state), await actor.snapshot());
});

test('request-boundary refresh retains the starting selection when another tool is queued', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:selected-boundaries';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef:'binding:selection-read',name:'fs.read',description:'Read a file.',
    inputSchema:{type:'object',required:['path'],properties:{path:{type:'string'}}},
    possibleEffects:['workspaceRead'],availability:'callable',origin:'coreBuiltin',
  }] });
  const first = {selectionId:'selection:first',uri:'plugin://first@local',label:'First'};
  const second = {selectionId:'selection:second',uri:'plugin://second@local',label:'Second'};
  let finishTool;
  const gate = new Promise(resolve=>{finishTool=resolve;});
  let toolStarted=false, requests=0;
  const kernel=emptyKernel({async execute(request){
    toolStarted=true;await gate;return completedExecutionReply(request,{content:'Read complete.'});
  }});
  const actor=actorWith(journal,sessionId,{async *stream(request){
    if(++requests===1) yield providerEvent(request.requestId,'tool.call',{
      callId:'provider-call:selection-read',name:request.tools.find(tool=>tool.inputSchema.properties?.path).name,
      input:{workspace:'primary',path:'README.md'},
    });
    else yield providerEvent(request.requestId,'assistant.message',{messageId:'answer:selection',content:'Done.'});
    yield providerEvent(request.requestId,'completed',{});
  }},kernel,preparation.port,'selected-boundaries');
  t.after(async()=>{finishTool();await actor.dispose();});
  await actor.submit({...messageCommand(sessionId,'command:selection-start','Read.'),pluginCatalogRevision:'catalog:first',pluginSelections:[first]});
  await waitUntil(()=>toolStarted,'tool executing');
  assert.deepEqual(preparation.prepared.at(-1).pluginSelections,[first]);
  await actor.submit({...messageCommand(sessionId,'command:selection-next','Use Second too.'),pluginCatalogRevision:'catalog:second',pluginSelections:[second]});
  finishTool();
  await waitForProjection(actor,value=>value.run?.status==='completed');
  assert.equal(requests,2);
  assert.deepEqual(preparation.prepared.at(-1).pluginSelections,[first,second]);
  assert.equal(preparation.prepared.at(-1).runId,preparation.prepared[0].runId);
});

test('waiting input stays separate from the decision and explicit cancel retains unconsumed text', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:queued-decision';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const requests = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    yield providerEvent(request.requestId, 'tool.call', {
      callId: `question:${requests.length}`, name: request.tools.find((tool) => tool.inputSchema.properties?.prompt).name,
      input: { kind: 'question', prompt: 'Which option?', allowFreeform: true },
    });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), preparation.port, 'queued-decision');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:decision-start', 'Ask a question.'));
  const waiting = await waitForProjection(actor, (value) => value.pendingInteraction !== null);
  await actor.submit(messageCommand(sessionId, 'command:decision-supplement', 'Additional context.'));
  const pending = await actor.snapshot();
  assert.deepEqual(pending.pendingInteraction, waiting.pendingInteraction);
  assert.equal(pending.queuedInputs[0].status, 'queued');
  assert.equal(requests.length, 1);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'interaction.respond',
    commandId: 'command:decision-response', sessionId, runId: waiting.run.runId,
    interactionId: waiting.pendingInteraction.interactionId, response: 'Option A.' });
  const nextWaiting = await waitForProjection(actor, (value) => value.pendingInteraction?.interactionId !== waiting.pendingInteraction.interactionId && value.pendingInteraction !== null);
  assert.equal(requests.length, 2);
  const messages = requests[1].messages;
  assert.ok(messages.findIndex((message) => message.role === 'tool') < messages.findIndex((message) => message.content === 'Additional context.'));
  assert.deepEqual(nextWaiting.queuedInputs, []);
  await actor.submit(messageCommand(sessionId, 'command:decision-cancelled-input', 'Do not lose this text.'));
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel',
    commandId: 'command:decision-cancel', sessionId, runId: nextWaiting.run.runId });
  const cancelled = await actor.snapshot();
  assert.equal(cancelled.run.status, 'cancelled');
  assert.deepEqual(cancelled.queuedInputs.map(({ text, status }) => ({ text, status })), [{ text: 'Do not lose this text.', status: 'notApplied' }]);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some((event) => event.type === 'input.accepted' && event.payload.commandId === 'command:decision-cancelled-input'), false);
  assert.equal(requests.length, 2);
  const delayed = await actor.submit({ ...messageCommand(sessionId, 'command:late-after-cancel', 'Delayed queued input.'), runId: nextWaiting.run.runId });
  assert.equal(delayed.status, 'rejected');
  assert.equal(delayed.error.code, 'queued_input_run_unavailable');
  assert.equal((await actor.snapshot()).run.runId, nextWaiting.run.runId);
  await actor.submit(messageCommand(sessionId, 'command:decision-new-run', 'Start a separate task.'));
  const newRun = await waitForProjection(actor, (value) => value.pendingInteraction !== null);
  assert.notEqual(newRun.run.runId, nextWaiting.run.runId);
  assert.equal(requests[2].messages.some((message) => message.content === 'Do not lose this text.'), false);
  assert.equal(newRun.queuedInputs[0].status, 'notApplied');
  const stale = await actor.submit({ ...messageCommand(sessionId, 'command:late-during-new-run', 'Stale queued input.'), runId: nextWaiting.run.runId });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.error.code, 'queued_input_run_unavailable');
  assert.equal((await actor.snapshot()).queuedInputs.length, 1);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel',
    commandId: 'command:decision-new-cancel', sessionId, runId: newRun.run.runId });
});

test('Kernel stream delivers progress before the terminal reply and rejects a missing reply', async () => {
  const { HttpKernelPort } = await import('../dist/local-agent/httpPorts.js');
  const { LiveToolOutput } = await import('../dist/local-agent/liveToolOutput.js');
  const request = { requestId: 'request:progress', callId: 'call:progress', attemptId: 'attempt:progress' };
  let stream;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const port = new HttpKernelPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async () => response });
  const output = new LiveToolOutput();
  let observed = 0; let settled = false;
  const result = port.execute(request, async (progress) => { output.update(request.callId, progress); observed += 1; });
  void result.then(() => { settled = true; });
  const frame = (progress) => stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress',
    callId: request.callId, attemptId: request.attemptId, progress }) + '\n'));
  frame({ type: 'started', startedAt: '1789298353986' });
  const bytes = [...new TextEncoder().encode('中文🙂')];
  frame({ type: 'output', stream: 'stdout', offset: 0, bytes: bytes.slice(0, 2) });
  frame({ type: 'output', stream: 'stdout', offset: 2, bytes: bytes.slice(2) });
  await waitUntil(() => observed === 3);
  assert.equal(settled, false);
  assert.equal(output.get(request.callId).stdout, '中文🙂');
  assert.equal(output.get(request.callId).stdoutBytes, bytes.length);
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'reply', reply: { ...request, status: 'completed' } }) + '\n'));
  await result;
  const missing = new HttpKernelPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async () =>
    new Response('', { headers: { 'content-type': 'application/x-ndjson' } }) });
  await assert.rejects(missing.execute(request), /kernel_execution_reply_missing/u);
});
import {
  workspaceBinding,
  actorWith,
  fakeRunPreparation,
  runtimeSnapshot,
  emptyKernel,
  completedExecutionReply,
  failedExecutionReply,
  indeterminateExecutionRecord,
  todoUpdateEvents,
  providerEvent,
  messageCommand,
  jsonMessagePayload,
  forwardingJournal,
  createSession,
  readEvents,
  singleEvent,
  assertEventOrder,
  assertSuccessfulCompactionOrder,
  waitForProjection,
  waitUntil,
  waitForAbort,
} from './local-agent-fixtures.mjs';

test('delegation capability expands after successful discovery and preserves the ordinary model prefix', async () => {
  const runtime = runtimeSnapshot('run:agent-directory');
  const input = { sessionId: 'session:agent-directory', runId: 'run:agent-directory', runtime,
    events: [], workspaceBindings: [], providerRequestId: 'request:directory', responseConstraint: 'normal' };
  const disabled = await buildAgentProviderRequest(input);
  const analysis = await buildAgentProviderRequest({ ...input, runtime: { ...runtime, agentToolsEnabled: true, agentCapabilities: NO_AGENT_CAPS } });
  assert.equal(disabled.request.tools.some(tool => tool.name === 'agent'), false);
  assert.deepEqual(analysis.request.messages, disabled.request.messages);
  assert.deepEqual(analysis.request.tools, disabled.request.tools);
  const memberRuntime = { ...runtime, agentToolsEnabled: true, agentCapabilities: ALL_AGENT_CAPS };
  const member = await buildAgentProviderRequest({ ...input, runtime: memberRuntime });
  const control = member.request.tools.find(tool => tool.name === 'agent');
  assert.deepEqual(control.inputSchema.properties.action.enum, ['models']);
  assert.deepEqual(member.request.messages, disabled.request.messages);
  const header = { schemaVersion: 'deepcode.session-event.v5', sessionId: input.sessionId,
    runId: input.runId, occurredAt: '2026-10-12T00:00:00.000Z' };
  const preparedEvents = [
    { ...header, eventId: 'event:models-run', sequence: 1, type: 'run.started',
      payload: { inputMessageId: 'message:models-input', workspaceBindings: [], runtimeSnapshot: memberRuntime } },
    { ...header, eventId: 'event:models-context', sequence: 2, type: 'context.composed', payload: member.receipt },
  ];
  const event = { schemaVersion: 'deepcode.session-event.v5', eventId: 'event:models', sessionId: input.sessionId,
    runId: input.runId, callId: 'call:models', sequence: 3, occurredAt: '2026-10-12T00:00:00.000Z' };
  const completed = { ...event, type: 'agent.control.completed', payload: { providerCallId: 'provider:models',
    operation: { action: 'models' }, result: { models: [] } } };
  const settled = { schemaVersion: event.schemaVersion, eventId: 'event:models-settled', sessionId: input.sessionId,
    runId: input.runId, sequence: 4, occurredAt: event.occurredAt, type: 'provider.turn.settled',
    payload: { providerRequestId: member.request.requestId, providerRuntimeRef: runtime.provider.providerRuntimeRef,
      purpose: 'agent', outcome: 'completed', orderedCallIds: [event.callId] } };
  const discovered = await buildAgentProviderRequest({ ...input, events: [...preparedEvents, completed, settled], runtime: memberRuntime });
  assert.deepEqual(discovered.request.tools.find(tool => tool.name === 'agent').inputSchema.properties.action.enum,
    ['models', 'spawn', 'send', 'wait', 'cancel', 'close']);
  assert.deepEqual(discovered.request.messages.filter(message => message.role === 'system'), disabled.request.messages);
  const limitedMember = await buildAgentProviderRequest({ ...input, events: [...preparedEvents, completed, settled],
    runtime: { ...memberRuntime, agentCapabilities: { ...ALL_AGENT_CAPS, delegation: false } } });
  assert.deepEqual(limitedMember.request.tools.find(tool => tool.name === 'agent').inputSchema.properties.action.enum,
    ['models', 'send']);
  assert.deepEqual(limitedMember.request.messages, discovered.request.messages);
  const rejected = { ...event, type: 'session.control.rejected', payload: { providerCallId: 'provider:models',
    toolName: 'agent', input: { action: 'models' }, error: { code: 'model_catalog_failed', message: 'Original catalog failure.' } } };
  const failed = await buildAgentProviderRequest({ ...input, events: [...preparedEvents, rejected, settled], runtime: memberRuntime });
  assert.deepEqual(failed.request.tools.find(tool => tool.name === 'agent').inputSchema.properties.action.enum, ['models']);
  assert.match(JSON.stringify(failed.request.messages), /Original catalog failure\./u);
});

test('requests without workspaces omit workspace tools and unavailable-capability reminders', async () => {
  const tools = ['fs.read', 'bash'].map((name, index) => ({ name, toolBindingRef: `binding:${name}`,
    description: name, inputSchema: { type: 'object', properties: {} },
    possibleEffects: [index === 0 ? 'workspaceRead' : 'process'], availability: 'callable', origin: 'coreBuiltin' }));
  const prepared = await buildAgentProviderRequest({ sessionId: 'session:no-workspace', runId: 'run:no-workspace',
    runtime: runtimeSnapshot('run:no-workspace', { tools }), events: [], workspaceBindings: [],
    providerRequestId: 'request:no-workspace', responseConstraint: 'normal' });
  assert.deepEqual(prepared.request.tools.map(tool => tool.name).sort(), ['artifact_present', 'interaction_request']);
  assert.equal(prepared.receipt.messages.some(message => message.contributionId === 'session:workspace-bindings'), false);
  assert.doesNotMatch(JSON.stringify(prepared.request.messages), /unavailable|No workspace is bound/u);
});

test('delegation evidence is delivered once, keeps call pairs intact and reuses frozen history', () => {
  const sessionId = 'session:agent-evidence', runId = 'run:agent-evidence';
  const events = [];
  const add = (type, payload, callId) => {
    const sequence = events.length + 1;
    events.push({ schemaVersion: 'deepcode.session-event.v5', eventId: `event:${sequence}`, sessionId, runId,
      sequence, occurredAt: '2026-10-11T00:00:00.000Z', type, payload, ...(callId ? { callId } : {}) });
  };
  for (const delivery of ['async', 'wait']) {
    const taskId = `task:${delivery}`, callId = `call:${delivery}`, agentSessionId = `session:${delivery}`;
    const capabilities = delivery === 'async' ? ALL_AGENT_CAPS : NO_AGENT_CAPS;
    const operation = { action: 'spawn', preset: delivery === 'async' ? 'collaboration' : 'analysis', task: 'Check the evidence.', name: delivery, delivery };
    add('agent.task.created', { taskId, agentSessionId, capabilities, createsAgent: true, displayName: delivery, text: operation.task, delivery }, callId);
    add('agent.task.started', { taskId, childRunId: `run:${delivery}` });
    const result = { outcome: 'completed', content: `Evidence from ${delivery}.`, finalMessageId: `message:${delivery}` };
    add('agent.task.completed', { taskId, result });
    add('agent.control.completed', { providerCallId: `provider:${delivery}`, operation,
      result: { taskId, agentId: agentSessionId, ...(delivery === 'wait' ? result : {}) } }, callId);
    add('provider.turn.settled', { providerRequestId: `request:${delivery}`, purpose: 'agent',
      providerRuntimeRef: 'provider-runtime:test', outcome: 'completed', orderedCallIds: [callId] });
  }
  add('agent.closed', { agentSessionId: 'session:async' });
  add('agent.message.received', { sourceSessionId: 'session:member', text: 'A related business finding.' });
  const contributions = messagesFromJournal(events, runId, []);
  const messages = contributions.map(value => value.message);
  const text = JSON.stringify(messages);
  for (const delivery of ['async', 'wait']) {
    assert.equal(text.split(`Evidence from ${delivery}.`).length - 1, 1);
    const callIndex = messages.findIndex(value => value.toolCalls?.some(call => call.callId === `call:${delivery}`));
    assert.equal(messages[callIndex + 1].toolCallId, `call:${delivery}`);
  }
  assert.equal(/agent\.task\.(created|started)|agent\.member\.closed|childRunId|displayName|"status"/u.test(text), false);
  assert.deepEqual(JSON.parse(messages.at(-1).content), { type: 'agent.message', agentId: 'session:member', text: 'A related business finding.' });
  const priorBoundary = events.length;
  add('context.composed', { purpose: 'agent', modelView: { throughSequence: priorBoundary, additions: structuredClone(contributions) } });
  events.find(event => event.type === 'agent.task.completed').payload.result.content = 'A newer renderer must not replace frozen evidence.';
  add('agent.message.received', { sourceSessionId: 'session:member', text: 'New evidence.' });
  const replayed = messagesFromJournal(events, runId, []);
  assert.deepEqual(replayed.slice(0, contributions.length), contributions);
  assert.equal(replayed.length, contributions.length + 1);
});

test('local Provider streams resume after silence, cancel immediately and close their connection', async (t) => {
  let response;
  let connectionClosed = false;
  const server = createServer((request, outgoing) => {
    request.resume();
    response = outgoing;
    outgoing.on('close', () => { connectionClosed = true; });
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.write(`data: ${JSON.stringify(providerEvent('request:local-idle', 'text.delta', { text: 'Before silence' }))}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  t.after(() => { controller.abort(); server.closeAllConnections(); server.close(); });
  const port = new HttpProviderPort({ apiBase: `http://127.0.0.1:${server.address().port}`, serviceToken: 'fixture' });
  const iterator = port.stream({ requestId: 'request:local-idle' }, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.data.text, 'Before silence');
  let received = false;
  const next = iterator.next().then((value) => { received = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received, false, 'no progress or completion is fabricated while the server is silent');
  response.write(`data: ${JSON.stringify(providerEvent('request:local-idle', 'text.delta', { text: 'After silence' }))}\n\n`);
  assert.equal((await next).value.data.text, 'After silence');
  const pending = iterator.next();
  controller.abort(new Error('user_cancelled_idle_stream'));
  await assert.rejects(pending, /user_cancelled_idle_stream/);
  await waitUntil(() => connectionClosed, 'cancelled Provider connection closes');
});

test('an interrupted local Provider response preserves its transport cause without retry', async (t) => {
  let response;
  let requests = 0;
  const server = createServer((request, outgoing) => {
    requests += 1;
    request.resume();
    response = outgoing;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.write(`data: ${JSON.stringify(providerEvent('request:broken-local', 'text.delta', { text: 'Partial' }))}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = new HttpProviderPort({ apiBase: `http://127.0.0.1:${server.address().port}`, serviceToken: 'fixture' });
  const iterator = port.stream({ requestId: 'request:broken-local' }, new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.data.text, 'Partial');
  const pending = iterator.next();
  response.destroy();
  await assert.rejects(pending, (error) => error.code === 'provider_stream_failed' && /ECONNRESET/.test(error.message));
  assert.equal(requests, 1);
});

test('Provider error causes survive Session indeterminate settlement', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:provider-cause';
  await createSession(journal, sessionId, [workspaceBinding]);
  const cause = Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' });
  let requests = 0;
  const provider = new HttpProviderPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async () => {
    requests += 1;
    throw new TypeError('terminated', { cause });
  } });
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'provider-cause');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:provider-cause', 'Continue.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'indeterminate');
  assert.equal(requests, 1);
  assert.equal(projection.terminalError.code, 'provider_turn_outcome_unknown');
  assert.match(projection.terminalError.message, /provider_stream_failed/);
  assert.match(projection.terminalError.message, /terminated; cause UND_ERR_BODY_TIMEOUT: Body Timeout Error/);
  assert.equal(projection.messages.some((message) => message.role === 'assistant'), false);
});

for (const lateRecord of [false, true]) test(`lost Kernel reply closes tool history after release (late record: ${lateRecord})`, async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = `session:lost-reply-${lateRecord}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const tool = { toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read a file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
  const preparation = fakeRunPreparation({ tools: [tool], apiSurface: 'responses' });
  const executions = [];
  const records = new Map();
  let released = false;
  const kernel = emptyKernel({
    async execute(request, onProgress) {
      executions.push(request);
      assert.equal(request.input.workspaceId, workspaceBinding.workspaceId, 'omitted workspace means primary');
      if (executions.length === 1) {
        const reply = completedExecutionReply(request, { content: 'first result' });
        records.set(request.callId, reply.record);
        return reply;
      }
      if (!lateRecord) await onProgress?.({ type: 'started', startedAt: '1789298353986' });
      throw new Error('fetch failed: execution response disconnected');
    },
    async readRecord(callId) {
      if (released && lateRecord && executions.at(-1)?.callId === callId) {
        return completedExecutionReply(executions.at(-1), { content: 'late result' }).record;
      }
      return records.get(callId) ?? null;
    },
  });
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      const read = request.tools.find((item) => item.name === 'fs_read');
      assert.equal(read.inputSchema.required.includes('workspace'), false);
      for (const outputIndex of [0, 1]) yield providerEvent(request.requestId, 'output.item.completed', {
        outputIndex, item: { type: 'function_call', call_id: `native:read-${outputIndex}`, name: read.name,
          arguments: JSON.stringify({ path: `${outputIndex}.txt` }), status: 'completed' },
      });
    } else {
      assert.equal(executions.length, 2, 'unknown effects and completed peers must not be replayed');
      assert.deepEqual(request.tools, requests[0].tools);
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
      const results = request.messages.filter((message) => message.role === 'tool');
      assert.deepEqual(results.map((message) => message.providerCallId), ['native:read-0', 'native:read-1']);
      const last = JSON.parse(results.at(-1).content);
      if (lateRecord) assert.equal(last.output.content, 'late result');
      else {
        assert.equal(last.status, 'indeterminate');
        assert.match(last.error.message, /fetch failed: execution response disconnected/);
        assert.equal(Object.hasOwn(last, 'executed'), false, 'absence of a record is not proof of nonexecution');
      }
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'native:next', content: 'History is complete.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, {
    ...preparation.port,
    async release(request) { released = true; return preparation.port.release(request); },
  }, `lost-${lateRecord}`);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:first', 'Read two files.'));
  const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  assert.match(failed.terminalError.message, /fetch failed/);
  const events = await readEvents(journal, sessionId);
  const terminal = events.find((event) => event.callId === executions[1].callId && event.type === (lateRecord ? 'tool.completed' : 'tool.interrupted'));
  assert.ok(terminal);
  assertEventOrder(singleEvent(events, 'run.runtime.released'), terminal, singleEvent(events, 'run.settled'));
  assert.equal(failed.activities.find((item) => item.callId === executions[1].callId).status, lateRecord ? 'completed' : 'indeterminate');
  if (!lateRecord) {
    // Reproduce the stored failure that predates a tool terminal event. Reading
    // it must expose both original facts without appending a synthetic result.
    const history = events.filter((event) => event !== terminal)
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    const beforeRead = structuredClone(history);
    const { recoverSession, projectSession } = await import('../dist/local-agent/reducer.js');
    const { readConversation } = await import('../dist/local-agent/conversationRead.js');
    const projection = projectSession(recoverSession(sessionId, history));
    assert.equal(projection.run.status, 'failed');
    assert.match(projection.terminalError.message, /fetch failed/);
    const unfinished = projection.activities.find((item) => item.callId === executions[1].callId);
    assert.equal(unfinished.status, 'active', 'a started call stays active until its interruption fact');
    assert.equal(unfinished.interruption, undefined);
    assert.equal(unfinished.tool, undefined);
    const read = await readConversation({ async *read() { yield* history; } }, { sessionId, view: 'summary' });
    assert.equal(read.sessionId, sessionId);
    assert.equal(read.revision, history.length);
    assert.deepEqual(history, beforeRead);
  }
  await actor.submit(messageCommand(sessionId, 'command:next', 'Continue with the known state.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(requests.length, 2);
});

test('snapshot reads only new journal events and matches full replay', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:incremental';
  await createSession(journal, sessionId, [workspaceBinding]);
  const reads = [];
  const read = journal.read.bind(journal);
  journal.read = async function* (id, after = 0) { reads.push(after); yield* read(id, after); };
  const actor = actorWith(journal, sessionId, { async *stream() {} }, emptyKernel(), fakeRunPreparation().port, 'incremental');
  t.after(() => actor.dispose());
  const first = await actor.snapshot();
  const second = await actor.snapshot();
  assert.deepEqual(second, first);
  assert.deepEqual(reads, [0, first.revision]);
  await journal.append({ type: 'session.model-settings.updated', sessionId,
    payload: { commandId: 'command:settings', settings: { profileId: 'profile:new', reasoningEffortOverride: null } } });
  const updated = await actor.snapshot();
  const { projectSession } = await import('../dist/local-agent/reducer.js');
  assert.deepEqual(updated, projectSession(loopSnapshot(sessionId, await readEvents(journal, sessionId)).state, null));
  assert.equal(updated.modelSettings.profileId, 'profile:new');
});

test('transport: oversized Unicode replies preserve content within bounded frames', () => {
  const value = { protocolVersion: 'deepcode.local-agent.v1', requestId: 'large', ok: true,
    data: { text: '中文🙂\n\"\\'.repeat(180_000) } };
  const frames = [...responseFrames(value)];
  assert.ok(frames.length > 1);
  const chunks = frames.map((frame, index) => {
    assert.ok(Buffer.byteLength(frame) <= 1024 * 1024);
    const chunk = JSON.parse(frame);
    assert.equal(chunk.index, index);
    assert.equal(chunk.final, index === frames.length - 1);
    return chunk.text;
  });
  assert.deepEqual(JSON.parse(chunks.join('')), value);
  assert.deepEqual([...responseFrames({ ok: true })], ['{"ok":true}']);
});

test('message uses one prepared runtime through composition, completion, cache projection, settlement, and release', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:answer-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparation = fakeRunPreparation({
    contextWindowTokens: 16_000,
    maxOutputTokens: 128,
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      assert.equal(request.purpose, 'agent');
      assert.equal(request.responseConstraint, 'normal');
      assert.equal(request.providerRuntimeRef, 'provider-runtime:g1');
      assert.equal(request.profileId, 'profile:selected');
      assert.equal(request.maxOutputTokens, 128);
      assert.ok(request.messages.some((message) => (
        message.role === 'system' && message.content === 'Stable core instruction.'
      )));

      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:answer',
        content: 'Fixture answer.',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          contextWindowTokens: 16_000,
          cacheReadInputTokens: 75,
          cacheMissInputTokens: 25,
        },
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'answer-chain',
  );

  const reply = await actor.submit(messageCommand(
    sessionId,
    'command:answer',
    'Arbitrary fixture input.',
    'profile:selected',
  ));
  assert.equal(reply.status, 'accepted');
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'runtime release');

  assert.equal(providerRequests.length, 1);
  assert.deepEqual(preparation.prepared.map((request) => ({
    sessionId: request.sessionId,
    runId: request.runId,
    profileId: request.profileId,
  })), [{
    sessionId,
    runId: projection.run.runId,
    profileId: 'profile:selected',
  }]);
  assert.deepEqual(projection.tokenUsage, {
    providerCallCount: 1,
    reportedCallCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 75,
    cacheMissInputTokens: 25,
    cacheAvailable: true,
    cacheComplete: true,
    cacheHitRatio: 0.75,
  });

  const events = await readEvents(journal, sessionId);
  const runStarted = singleEvent(events, 'run.started');
  const composition = singleEvent(events, 'context.composed');
  const completion = singleEvent(events, 'provider.turn.settled');
  const usage = singleEvent(events, 'context.updated');
  const assistant = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'assistant'
  ));
  const settlement = singleEvent(events, 'run.settled');

  assert.ok(assistant, 'assistant message must be durable');
  assert.deepEqual(runStarted.payload.runtimeSnapshot, preparation.snapshots[0]);
  assert.equal(composition.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(completion.payload.providerRuntimeRef, runStarted.payload.runtimeSnapshot.provider.providerRuntimeRef);
  assert.deepEqual(completion.payload.orderedCallIds, []);
  assert.equal(usage.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(assistant.runId, runStarted.runId);
  assert.equal(assistant.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(settlement.payload.finalMessageId, assistant.payload.messageId);
  assertEventOrder(composition, completion, usage, assistant, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: runStarted.runId,
    kernelCatalogSnapshotRef: runStarted.payload.runtimeSnapshot.kernelCatalogSnapshotRef,
  }]);

  await actor.dispose();
});

test('new runs refresh execution facts while restart and compaction retain each prepared run environment', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:environment';
  await createSession(journal, sessionId);
  let observed = { ...runtimeSnapshot('environment:fixture').environment,
    os: 'linux', arch: 'aarch64', locale: 'zh-CN', responseLanguage: 'zh-CN', userShell: '/bin/bash',
    workspaceShellSupported: false,
    workspaceSandbox: { available: false, reason: 'fixture sandbox probe diagnostic' },
    runtimeExecutables: { kernel: '/opt/deepcode/deepcode-kernel', cli: '/opt/deepcode/deepcode-cli' } };
  const saved = environmentInstruction(observed);
  const modelEnvironment = JSON.parse(saved.text.split('\n')[1]);
  for (const field of ['runtimeExecutables', 'shellAvailable', 'workspaceShellSupported', 'workspaceSandbox']) {
    assert.equal(modelEnvironment[field], undefined);
  }
  for (const field of ['os', 'arch', 'executionTarget', 'shell', 'executionPath', 'developerCommands']) {
    assert.deepEqual(modelEnvironment[field], observed[field]);
  }
  assert.doesNotMatch(saved.text, /Service readiness|fixture sandbox probe diagnostic/u);
  assert.deepEqual(observed.workspaceSandbox, { available: false, reason: 'fixture sandbox probe diagnostic' });
  assert.deepEqual(observed.runtimeExecutables,
    { kernel: '/opt/deepcode/deepcode-kernel', cli: '/opt/deepcode/deepcode-cli' });
  const preparation = fakeRunPreparation();
  const port = {
    ...preparation.port,
    async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      prepared.runtimeSnapshot.environment = structuredClone(request.restoreEnvironment ? request.environment : observed);
      prepared.runtimeSnapshot.instructions.push(environmentInstruction(prepared.runtimeSnapshot.environment));
      return prepared;
    },
  };
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    yield providerEvent(request.requestId, 'assistant.message', {
      messageId: `provider-message:${request.requestId}`,
      content: request.purpose === 'contextCompaction' ? 'Saved task facts only.' : 'Task result.',
    });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  let actor = actorWith(journal, sessionId, provider, emptyKernel(), port, 'environment');
  t.after(() => actor.dispose());
  let runCount = 0;
  const submit = async (text) => {
    runCount += 1;
    await actor.submit(messageCommand(sessionId, `command:environment:${runCount}`, text));
    await waitForProjection(actor, (value) => value.run?.status === 'completed'
      && preparation.prepared.length === runCount);
    await waitUntil(() => preparation.released.length === runCount, 'environment runtime release');
  };
  await submit('First task.');
  observed = { ...observed, locale: 'en-US', responseLanguage: 'en-US', userShell: '/bin/zsh' };
  await submit('Another task.');
  await actor.dispose();
  actor = actorWith(journal, sessionId, provider, emptyKernel(), port, 'environment-reopened');
  await actor.recover();
  await submit('Continue after restart.');
  await actor.submit({
    schemaVersion: 'deepcode.command.v3', type: 'context.focus',
    commandId: 'command:environment-focus', sessionId, task: 'Continue with the saved facts.',
  });
  await waitForProjection(actor, (value) => value.run?.status === 'completed'
    && preparation.prepared.length === 4);
  await waitUntil(() => preparation.released.length === 4, 'environment focus release');

  const agentRequests = requests.filter((request) => request.purpose === 'agent');
  assert.equal(agentRequests.length, 4);
  const prefix = agentRequests[0].messages.slice(0, 2);
  assert.deepEqual(prefix, [
    { role: 'system', content: 'Stable core instruction.' },
    { role: 'system', content: saved.text },
  ]);
  for (const [index, request] of agentRequests.entries()) {
    const expected = index === 0 ? saved : environmentInstruction(observed);
    assert.deepEqual(request.messages.slice(0, prefix.length), [prefix[0], { role: 'system', content: expected.text }]);
    assert.deepEqual(request.tools, agentRequests[0].tools);
    assert.equal(request.messages.filter((message) => message.content === expected.text).length, 1);
  }
  assert.ok(agentRequests[3].messages.some((message) => message.content?.includes('Saved task facts only.')));
  assert.equal(requests.filter((request) => request.purpose === 'contextCompaction').length, 1);
  const runs = (await readEvents(journal, sessionId)).filter((event) => event.type === 'run.started');
  assert.equal(runs.length, 4);
  for (const [index, run] of runs.entries()) {
    assert.deepEqual(run.payload.runtimeSnapshot.instructions.find((item) => item.id === saved.id),
      index === 0 ? saved : environmentInstruction(observed));
    assert.deepEqual(run.payload.runtimeSnapshot.environment.runtimeExecutables, observed.runtimeExecutables);
    assert.deepEqual(run.payload.runtimeSnapshot.environment.workspaceSandbox, observed.workspaceSandbox);
    assert.equal(run.payload.runtimeSnapshot.environment.workspaceShellSupported, false);
  }
  const compacting = requests.find(request => request.purpose === 'contextCompaction');
  assert.equal(compacting.providerRuntimeRef, agentRequests[3].providerRuntimeRef);

  const newSession = 'session:environment-new';
  await createSession(journal, newSession);
  const fresh = actorWith(journal, newSession, provider, emptyKernel(), port, 'environment-new');
  t.after(() => fresh.dispose());
  await fresh.submit(messageCommand(newSession, 'command:environment-new', 'A new conversation.'));
  await waitForProjection(fresh, (value) => value.run?.status === 'completed');
  assert.equal(requests.at(-1).messages[1].content, environmentInstruction(observed).text);
});

test('run binding exposes hosted search once and replays its Provider item unchanged', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:hosted-web-search';
  await createSession(journal, sessionId, [workspaceBinding]);
  const hostedItems = [{
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: { type: 'search', queries: ['current compiler release'],
      sources: [{ type: 'url', url: 'https://example.com/compiler-release' }] },
  }, {
    type: 'web_search_call',
    id: 'ws_2',
    status: 'failed',
    action: { type: 'open_page', url: 'https://example.com/unavailable' },
  }, {
    type: 'web_search_call',
    id: 'ws_3',
    status: 'completed',
  }];
  const preparation = fakeRunPreparation({
    apiSurface: 'responses',
    hostedWebSearch: 'web_search',
    webSearch: { owner: 'providerHosted', providerToolType: 'web_search' },
    tools: [{
      name: 'web.search', toolBindingRef: 'tool-binding:search:blocked',
      description: 'Local search adapter.', inputSchema: { type: 'object' },
      possibleEffects: ['network'], availability: 'blocked', origin: 'coreBuiltin',
    }, {
      name: 'web.fetch', toolBindingRef: 'tool-binding:fetch:g1',
      description: 'Read a known URL.', inputSchema: { type: 'object' },
      possibleEffects: ['network'], availability: 'callable', origin: 'coreBuiltin',
    }],
    toolPromptContributions: [{
      contributionRef: 'tool-prompt-contribution:fetch',
      canonicalToolName: 'web.fetch', preparedToolBindingRef: 'tool-binding:fetch:g1',
      origin: 'coreBuiltin', promptSnippet: 'Read a known URL.',
      usageGuidelines: ['Read URLs supplied by the user or earlier results.'],
    }],
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      assert.deepEqual(request.hostedTools, [{
        type: 'webSearch',
        providerToolType: 'web_search',
      }]);
      assert.equal(request.tools.some((tool) => tool.name === 'web_search'), false);
      assert.ok(request.tools.some((tool) => tool.name === 'web_fetch'));
      const searchGuidance = request.messages.filter((message) => (
        message.role === 'system' && message.content.includes('Read URLs supplied by the user or earlier results.')
      ));
      assert.equal(searchGuidance.length, 1);
      assert.match(searchGuidance[0].content, /\bweb_fetch\b/u);
      assert.equal(searchGuidance[0].content.match(/\bweb_search\b/gu)?.length, 1);
      if (providerRequests.length === 1) {
        for (const item of hostedItems) {
          yield providerEvent(request.requestId, 'hosted.web-search.completed', {
            item: structuredClone(item),
          });
        }
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:hosted-first',
          content: 'First current answer.',
        });
      } else {
        const replay = request.messages.find((message) => (
          message.role === 'assistant'
          && message.content === 'First current answer.'
        ));
        assert.ok(replay, 'prior hosted-search answer must be in the next context');
        assert.deepEqual(replay.providerItems, hostedItems);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:hosted-second',
          content: 'Second answer after exact replay.',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'hosted-web-search',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:hosted-first',
    'Find the current compiler release.',
  ));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await actor.submit(messageCommand(
    sessionId,
    'command:hosted-second',
    'Use the prior result in this follow-up.',
  ));
  await waitUntil(() => providerRequests.length === 2, 'second hosted Provider request');
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'Second answer after exact replay.')
  ));

  const events = await readEvents(journal, sessionId);
  const settlements = events.filter((event) => event.type === 'provider.turn.settled');
  assert.deepEqual(settlements[0].payload.hostedWebSearchCalls, hostedItems);
  const systemPrefix = (request) => request.messages.slice(
    0, request.messages.findIndex((message) => message.role === 'user'),
  );
  assert.deepEqual(systemPrefix(providerRequests[1]), systemPrefix(providerRequests[0]));
  const firstAssistant = events.find((event) => (
    event.type === 'message.committed'
    && event.payload.content === 'First current answer.'
  ));
  assert.equal(firstAssistant.payload.providerRequestId, settlements[0].payload.providerRequestId);
  const compositions = events.filter((event) => event.type === 'context.composed');
  assert.ok(compositions[0].payload.tools.some((tool) => (
    tool.origin === 'providerHosted'
    && tool.canonicalName === 'web.search'
    && tool.wireName === 'web_search'
  )));
  assert.equal(compositions[0].payload.tools.filter((tool) => tool.canonicalName === 'web.search').length, 1);
  assert.equal(compositions[0].payload.messages.filter((message) => (
    message.contributionId === 'instruction:deepcode.tool-guidance'
  )).length, 1);
  assert.ok(compositions[1].payload.messages.some((message) => (
    message.blocks.some((block) => (
      block.kind === 'hostedWebSearch' && block.providerCallId === hostedItems[0].id
    ))
  )));

  await actor.dispose();
});

test('Responses output items preserve narrative, hosted activity, and final-message order', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-provider-output';
  await createSession(journal, sessionId, [workspaceBinding]);
  const finalText = '发布说明见这里。\uE200cite\uE202turn0search0\uE201';
  const nativeItems = [{
    type: 'message',
    id: 'provider-message:search-intro',
    role: 'assistant',
    phase: 'commentary',
    status: 'completed',
    content: [{ type: 'output_text', text: 'I will search first.' }],
  }, {
    type: 'web_search_call',
    id: 'provider-search:first',
    status: 'completed',
  }, {
    type: 'message',
    id: 'provider-message:search-follow-up',
    role: 'assistant',
    phase: 'commentary',
    status: 'completed',
    content: [{ type: 'output_text', text: 'I found a release page and will inspect it.' }],
  }, {
    type: 'web_search_call',
    id: 'provider-search:second',
    status: 'failed',
    action: { type: 'open_page', url: 'https://example.com/compiler-release' },
  }, {
    type: 'message',
    id: 'provider-message:search-final',
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text: finalText, annotations: [{ type: 'url_citation', url: 'https://example.com/compiler-release', title: 'Compiler release', start_index: 8, end_index: finalText.length }] }],
  }];
  const preparation = fakeRunPreparation({ contextWindowTokens: 8192,
    apiSurface: 'responses',
    hostedWebSearch: 'web_search',
    webSearch: { owner: 'providerHosted', providerToolType: 'web_search' },
  });
  const providerRequests = [];
  let completeFinalItem;
  const finalItemHeld = new Promise((resolve) => { completeFinalItem = resolve; });
  let completeFirstTurn;
  const firstTurnHeld = new Promise((resolve) => { completeFirstTurn = resolve; });
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        for (const [outputIndex, item] of nativeItems.entries()) {
          if (item.type === 'message') {
            yield providerEvent(request.requestId, 'text.delta', {
              text: item.content[0].text,
              outputIndex,
            });
            if (outputIndex === nativeItems.length - 1) await finalItemHeld;
          }
          yield providerEvent(request.requestId, 'output.item.completed', {
            outputIndex,
            item: structuredClone(item),
          });
        }
        await firstTurnHeld;
      } else {
        const replay = request.messages.find((message) => message.providerOutputBlocks);
        assert.ok(replay, 'the next turn must replay the ordered Provider output');
        assert.equal(replay.content, '');
        assert.deepEqual(
          replay.providerOutputBlocks.map((block) => block.kind),
          ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
        );
        assert.deepEqual(
          replay.providerOutputBlocks.map((block) => block.item),
          nativeItems,
        );
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:ordered-follow-up',
          content: 'The ordered output was replayed.',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'ordered-provider-output',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-first',
    'Search for the current compiler release.',
  ));
  const finalStreamingProjection = await waitForProjection(actor, (value) => (
    value.assistantDraft?.blocks?.at(-1)?.outputIndex === nativeItems.length - 1
    && value.assistantDraft.blocks.at(-1)?.kind === 'message'
  ));
  assert.equal(
    finalStreamingProjection.assistantDraft.blocks.at(-1).content,
    nativeItems.at(-1).content[0].text,
  );
  assert.equal(finalStreamingProjection.assistantDraft.blocks.at(-1).displayContent, '发布说明见这里。');
  completeFinalItem();
  const streamingProjection = await waitForProjection(actor, (value) => (
    value.assistantDraft?.blocks?.length === nativeItems.length
    && value.assistantDraft.blocks.at(-1)?.kind === 'finalMessage'
  ));
  assert.equal(streamingProjection.assistantDraft.content, undefined);
  assert.equal(streamingProjection.assistantDraft.reasoningContent, undefined);
  assert.deepEqual(
    streamingProjection.assistantDraft.blocks.map((block) => block.kind),
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    streamingProjection.assistantDraft.blocks.map((block) => block.outputIndex),
    [0, 1, 2, 3, 4],
  );
  assert.equal(Object.hasOwn(streamingProjection.assistantDraft.blocks[1], 'action'), false);
  assert.deepEqual(streamingProjection.assistantDraft.blocks[3].action, nativeItems[3].action);
  completeFirstTurn();
  const firstProjection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  const firstEvents = await readEvents(journal, sessionId);
  const firstSettlement = singleEvent(firstEvents, 'provider.turn.settled');
  assert.deepEqual(
    firstSettlement.payload.orderedOutputBlocks.map((block) => block.kind),
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    firstSettlement.payload.orderedOutputBlocks.map((block) => block.item),
    nativeItems,
  );
  assert.equal(firstEvents.some((event) => (
    event.type === 'tool.requested' || event.type === 'tool.completed'
  )), false, 'Provider-hosted activity must not create Kernel tool facts');

  const orderedBlocks = firstSettlement.payload.orderedOutputBlocks;
  const narrativeIds = new Set(orderedBlocks.flatMap((block) => (
    block.kind === 'narrative' ? [block.narrativeId] : []
  )));
  const activityIds = new Set(orderedBlocks.flatMap((block) => (
    block.kind === 'providerHosted' ? [block.activityId] : []
  )));
  const finalMessageId = orderedBlocks.find((block) => block.kind === 'finalMessage').messageId;
  assert.equal(firstProjection.messages.find(message => message.messageId === finalMessageId).content, finalText);
  assert.equal(firstProjection.messages.find(message => message.messageId === finalMessageId).displayContent,
    '发布说明见这里。[Compiler release](<https://example.com/compiler-release>)');
  assert.deepEqual(firstProjection.messages.find(message => message.messageId === finalMessageId).sourceReferences, {
    citations: [{ url: 'https://example.com/compiler-release', title: 'Compiler release' }], unresolved: false,
  });
  const orderedTimelineKinds = firstProjection.timeline.flatMap((item) => {
    if (item.kind === 'narrative' && narrativeIds.has(item.narrativeId)) return ['narrative'];
    if (
      item.kind === 'toolGroup'
      && item.activityIds.some((activityId) => activityIds.has(activityId))
    ) return ['providerHosted'];
    if (item.kind === 'message' && item.messageId === finalMessageId) return ['finalMessage'];
    return [];
  });
  assert.deepEqual(
    orderedTimelineKinds,
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    firstProjection.timeline.flatMap((item) => (
      item.kind === 'narrative' && narrativeIds.has(item.narrativeId)
        || item.kind === 'message' && item.messageId === finalMessageId
        ? [item.outputIndex]
        : []
    )),
    [0, 2, 4],
  );
  assert.deepEqual(
    firstProjection.timeline.flatMap((item) => (
      item.kind === 'narrative' && narrativeIds.has(item.narrativeId)
        || item.kind === 'message' && item.messageId === finalMessageId
        ? [item.streamId]
        : []
    )),
    streamingProjection.assistantDraft.blocks.flatMap((block) => {
      if (block.kind === 'providerHosted') return [];
      assert.equal(typeof block.streamId, 'string');
      assert.ok(block.streamId.length > 0);
      return [block.streamId];
    }),
  );
  assert.deepEqual(
    [...activityIds].map((activityId) => firstProjection.activities.find((activity) => (
      activity.activityId === activityId
    ))?.kind),
    ['providerHosted', 'providerHosted'],
  );
  const hostedActivities = [...activityIds].map(activityId => firstProjection.activities
    .find(activity => activity.activityId === activityId).providerHosted);
  assert.equal(Object.hasOwn(hostedActivities[0], 'action'), false);
  assert.deepEqual(hostedActivities[1].action, nativeItems[3].action);
  assert.equal(
    firstProjection.messages.find((message) => message.messageId === finalMessageId)?.content,
    finalText,
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-follow-up',
    'Continue from that result.',
  ));
  await waitUntil(() => providerRequests.length === 2, 'ordered Provider replay request');
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'The ordered output was replayed.')
  ));

  await actor.dispose();
});

test('explicit commentary streams before settlement and continues the same run without changing the prefix', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:commentary-continuation';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses' });
  const requests = [];
  const intro = { type: 'message', id: 'provider-message:intro', role: 'assistant', phase: 'commentary',
    status: 'completed', content: [{ type: 'output_text', text: 'I will inspect the current implementation.' }] };
  let finishIntro, finishAnswer;
  const introHeld = new Promise((resolve) => { finishIntro = resolve; });
  const answerHeld = new Promise((resolve) => { finishAnswer = resolve; });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    assert.ok(requests.length <= 2);
    if (requests.length === 1) {
      yield providerEvent(request.requestId, 'text.delta', { outputIndex: 0, text: intro.content[0].text });
      await introHeld;
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: intro });
    } else {
      assert.equal(request.runId, requests[0].runId);
      assert.deepEqual(request.tools, requests[0].tools);
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
      const replay = request.messages.find((message) => message.providerOutputBlocks);
      assert.deepEqual(replay.providerOutputBlocks.map((block) => block.item), [intro]);
      assert.equal(replay.providerOutputBlocks[0].kind, 'narrative');
      await answerHeld;
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
        ...intro, id: 'provider-message:answer', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'The inspection is complete.' }],
      } });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'commentary');
  t.after(async () => { finishIntro(); finishAnswer(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:commentary', 'Inspect the implementation.'));
  const draft = await waitForProjection(actor, (value) => value.assistantDraft?.blocks[0]?.content === intro.content[0].text);
  assert.equal(draft.run.status, 'running');
  assert.equal(draft.assistantDraft.activity.phase, 'generatingOutput');
  assert.ok(draft.assistantDraft.activity.lastContentAt);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'provider.turn.settled'), false);
  finishIntro();
  const continuing = await waitForProjection(actor, (value) => requests.length === 2 || value.run?.status === 'failed');
  assert.equal(continuing.run.status, 'running', JSON.stringify(continuing.terminalError));
  assert.equal(requests.length, 2);
  const events = await readEvents(journal, sessionId);
  assert.equal(singleEvent(events, 'narrative.committed').payload.content, intro.content[0].text);
  assert.equal(events.some((event) => event.type === 'run.finishing'), false);
  assert.equal(events.filter((event) => event.type === 'input.accepted').length, 1);
  finishAnswer();
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.messages.at(-1).content, 'The inspection is complete.');
  assert.equal((await readEvents(journal, sessionId)).filter((event) => event.type === 'provider.turn.settled').length, 2);
  assert.equal(preparation.released.length, 1);
});

test('native function_call identity survives settlement, execution, and replay', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-provider-tool';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparedTool = {
    toolBindingRef: 'tool-binding:ordered-read:g1',
    name: 'fs.read',
    description: 'Read one fixture path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({
    apiSurface: 'responses',
    tools: [preparedTool],
  });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      return completedExecutionReply(request, { content: 'ordered fixture contents' });
    },
  });
  const providerRequests = [];
  let nativeItems;
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.path !== undefined
        ));
        assert.ok(definition, 'prepared Kernel tool must be exposed to Responses');
        nativeItems = [{
          type: 'message',
          id: 'provider-message:ordered-read-intro',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I will read the fixture.' }],
        }, {
          type: 'function_call',
          id: 'provider-item:ordered-read',
          call_id: 'provider-call:ordered-read',
          name: definition.name,
          arguments: JSON.stringify({ workspace: 'primary', path: 'README.md' }),
          status: 'completed',
        }];
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'I will read the fixture.',
          outputIndex: 0,
        });
        for (const [outputIndex, item] of nativeItems.entries()) {
          yield providerEvent(request.requestId, 'output.item.completed', {
            outputIndex,
            item: structuredClone(item),
          });
        }
      } else {
        const replay = request.messages.find((message) => message.providerOutputBlocks);
        assert.ok(replay, 'continuation must replay the native ordered output items');
        assert.deepEqual(replay.providerOutputBlocks.map((block) => block.item), nativeItems);
        const replayedCall = replay.providerOutputBlocks.find((block) => block.kind === 'toolCall');
        assert.ok(replayedCall);
        assert.equal(replayedCall.providerCallId, 'provider-call:ordered-read');
        assert.ok(request.messages.some((message) => (
          message.role === 'tool'
          && message.toolCallId === replayedCall.callId
          && message.providerCallId === replayedCall.providerCallId
        )), 'tool result must retain the exact native provider call identity');
        const finalItem = {
          type: 'message',
          id: 'provider-message:ordered-read-final',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The ordered read completed.' }],
        };
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'The ordered read completed.',
          outputIndex: 0,
        });
        yield providerEvent(request.requestId, 'output.item.completed', {
          outputIndex: 0,
          item: finalItem,
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'ordered-provider-tool',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-tool',
    'Read the fixture with the available tool.',
  ));
  const projection = await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'The ordered read completed.')
  ));
  const events = await readEvents(journal, sessionId);
  const settlements = events.filter((event) => event.type === 'provider.turn.settled');
  const toolRequested = singleEvent(events, 'tool.requested');
  assert.deepEqual(
    settlements[0].payload.orderedOutputBlocks.map((block) => block.kind),
    ['narrative', 'toolCall'],
  );
  const toolBlock = settlements[0].payload.orderedOutputBlocks[1];
  assert.equal(toolBlock.callId, toolRequested.callId);
  assert.equal(toolBlock.providerCallId, toolRequested.payload.providerCallId);
  assert.equal(toolBlock.toolName, toolRequested.payload.toolName);
  assert.equal(toolRequested.payload.providerCallId, 'provider-call:ordered-read');
  assert.equal(kernelRequests.length, 1);
  assert.ok(projection.activities.some((activity) => (
    activity.kind === 'tool' && activity.callId === toolRequested.callId
  )));

  await actor.dispose();
});

test('filesystem references retain logical metadata and bindings in Provider context', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:filesystem-reference';
  const importedWorkspace = {
    workspaceId: 'workspace:attachment',
    displayName: 'report.pdf',
  };
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:filesystem-reference',
        content: 'Reference received.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'filesystem-reference',
  );

  const command = messageCommand(
    sessionId,
    'command:filesystem-reference',
    'Inspect the attached PDF.',
  );
  command.filesystemReferences = [{
    referenceId: 'reference:pdf',
    workspaceId: importedWorkspace.workspaceId,
    logicalPath: 'report.pdf',
    displayName: importedWorkspace.displayName,
    kind: 'file',
    mediaType: 'application/pdf',
    byteLength: 123,
  }];
  const reply = await actor.submit(command);
  assert.equal(reply.status, 'accepted');
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(providerRequests.length, 1);
  const userMessage = providerRequests[0].messages.find((message) => message.role === 'user');
  assert.ok(userMessage);
  assert.match(userMessage.content, /"workspace":"workspace2"/u);
  assert.match(userMessage.content, /"path":"report\.pdf"/u);
  assert.match(userMessage.content, /"mediaType":"application\/pdf"/u);
  assert.doesNotMatch(userMessage.content, /workspace:attachment/u);
  assert.deepEqual(completed.messages[0].filesystemReferences, command.filesystemReferences);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(
    singleEvent(events, 'run.started').payload.workspaceBindings,
    [workspaceBinding, importedWorkspace],
  );
  const committed = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  ));
  assert.deepEqual(committed.payload.filesystemReferences, command.filesystemReferences);
  const composition = singleEvent(events, 'context.composed');
  assert.deepEqual(
    composition.payload.messages
      .find((message) => message.filesystemReferences.length > 0)
      .filesystemReferences,
    [{ itemId: 'reference:pdf', label: 'report.pdf' }],
  );
  await actor.dispose();
});

for (const [field, label, identity, error] of [
  ['providerToolAliases', 'Provider aliases', 'alias-contract', /run_runtime_provider_tool_aliases_missing/u],
  ['toolPromptContributions', 'tool prompt contributions', 'tool-prompt-contract', /run_runtime_tool_prompt_contributions_missing/u],
]) {
  test(`the current RunRuntimeSnapshot contract rejects missing ${label} explicitly`, async () => {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:${identity}`, runId = `run:${identity}`, messageId = `message:${identity}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const runtime = runtimeSnapshot(runId);
    await journal.append({ type: 'message.committed', sessionId, payload: {
      messageId, role: 'user', content: 'Verify the current runtime snapshot contract.',
    } });
    await journal.append({ type: 'run.started', sessionId, runId, payload: {
      inputMessageId: messageId, workspaceBindings: [workspaceBinding], runtimeSnapshot: runtime,
    } });
    const events = await readEvents(journal, sessionId);
    delete events.find(event => event.type === 'run.started').payload.runtimeSnapshot[field];
    assert.throws(() => loopSnapshot(sessionId, events), error);
  });
}

test('tool prompt preparation binds exact callable tools and rejects invalid ownership', () => {
  const readTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read UTF-8 text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const bashTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Run a command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
    possibleEffects: ['process'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const selectedPlugins = {
    catalogRevision: 'plugin-catalog:fixture',
    plugins: [],
  };
  const providers = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:core',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:bash',
      canonicalToolName: 'bash',
      promptSnippet: 'Run commands.',
      usageGuidelines: ['Use this for command execution.'],
    }, {
      contributionRef: 'tool-prompt-contribution:read',
      canonicalToolName: 'fs.read',
      promptSnippet: 'Read known text files.',
      usageGuidelines: ['Use this instead of shell text readers.'],
    }],
  }]);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:invalid',
    origin: 'coreBuiltin',
    contributions: [],
    undeclared: true,
  }]), /tool_prompt_providers_invalid/u);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:invalid-line',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:invalid-line',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Invalid\nline.'],
    }],
  }]), /tool_prompt_contribution_invalid/u);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:duplicate-ref',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:duplicate',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['First contribution.'],
    }, {
      contributionRef: 'tool-prompt-contribution:duplicate',
      canonicalToolName: 'bash',
      usageGuidelines: ['Second contribution.'],
    }],
  }]), /tool_prompt_contribution_duplicate/u);
  const prepared = prepareToolPromptContributions(
    providers,
    [bashTool, readTool],
    selectedPlugins,
  );

  assert.deepEqual(prepared.map((item) => ({
    name: item.canonicalToolName,
    binding: item.preparedToolBindingRef,
  })), [{
    name: 'fs.read',
    binding: 'tool-binding:read:g1',
  }, {
    name: 'bash',
    binding: 'tool-binding:bash:g1',
  }]);
  const captured = structuredClone({ providers, prepared });
  for (const [target, replacement] of [
    [providers, {}],
    [providers[0].contributions, {}],
    [providers[0].contributions[0].usageGuidelines, 'Changed by a consumer.'],
    [prepared, {}],
    [prepared[0].usageGuidelines, 'Changed by a consumer.'],
  ]) Reflect.set(target, 0, replacement);
  assert.deepEqual({ providers, prepared }, captured, 'a consumer cannot change the prepared guidance snapshots');
  assert.deepEqual(
    prepareToolPromptContributions(providers, [bashTool, readTool], selectedPlugins),
    prepared,
  );
  const rendered = renderActiveToolGuidance(prepared, [{
    canonicalName: 'fs.read',
    wireName: 'fs_read',
  }, {
    canonicalName: 'bash',
    wireName: 'bash',
  }], [readTool, bashTool], []);
  assert.ok(rendered);
  for (const [wireName, contribution] of [['fs_read', prepared[0]], ['bash', prepared[1]]]) {
    assert.ok(rendered.includes(wireName));
    assert.ok(rendered.includes(contribution.promptSnippet));
    for (const guideline of contribution.usageGuidelines) assert.ok(rendered.includes(guideline));
  }
  assert.doesNotMatch(rendered, /fs\.read/u);

  const readOnlyProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:read',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:read-only',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Read known text files directly.'],
    }],
  }]);
  assert.deepEqual(prepareToolPromptContributions(readOnlyProviders, [{
    ...readTool,
    availability: 'blocked',
  }], selectedPlugins), []);
  assert.throws(
    () => prepareToolPromptContributions(readOnlyProviders, [], selectedPlugins),
    /tool_prompt_target_missing:fs\.read/u,
  );

  const conflictingProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:conflict',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:owner-one',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['First owner.'],
    }, {
      contributionRef: 'tool-prompt-contribution:owner-two',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Second owner.'],
    }],
  }]);
  assert.throws(
    () => prepareToolPromptContributions(conflictingProviders, [readTool], selectedPlugins),
    /tool_prompt_owner_conflict:fs\.read/u,
  );
  assert.throws(
    () => prepareToolPromptContributions(readOnlyProviders, [{
      ...readTool,
      origin: 'extension',
      pluginUri: 'plugin://fixture@mcp',
    }], selectedPlugins),
    /tool_prompt_origin_mismatch:fs\.read/u,
  );

  const extensionTool = {
    ...readTool,
    toolBindingRef: 'tool-binding:fixture-read:g1',
    name: 'fixture.read',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
  };
  const extensionProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:fixture',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:fixture-read',
      canonicalToolName: 'fixture.read',
      usageGuidelines: ['Use the selected fixture reader.'],
    }],
  }]);
  const selectedWithFixture = {
    catalogRevision: 'plugin-catalog:fixture',
    plugins: [{
      uri: 'plugin://fixture@mcp',
      pluginArtifactRef: 'plugin-artifact:fixture',
      pluginInstanceRef: 'plugin-instance:fixture:g1',
      extensionGenerationRef: 'extension-generation:g1',
      capabilityRefs: ['mcp-tool:fixture.read'],
    }],
  };
  const firstGenerationPrepared = prepareToolPromptContributions(
    extensionProviders,
    [extensionTool],
    selectedWithFixture,
  );
  assert.deepEqual(firstGenerationPrepared.map((item) => ({
    binding: item.preparedToolBindingRef,
    origin: item.origin,
    pluginUri: item.pluginUri,
  })), [{
    binding: 'tool-binding:fixture-read:g1',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
  }]);
  const nextGenerationPrepared = prepareToolPromptContributions(
    extensionProviders,
    [{ ...extensionTool, toolBindingRef: 'tool-binding:fixture-read:g2' }],
    {
      ...selectedWithFixture,
      plugins: selectedWithFixture.plugins.map((plugin) => ({
        ...plugin,
        pluginInstanceRef: 'plugin-instance:fixture:g2',
        extensionGenerationRef: 'extension-generation:g2',
      })),
    },
  );
  assert.equal(firstGenerationPrepared[0].preparedToolBindingRef, 'tool-binding:fixture-read:g1');
  assert.equal(nextGenerationPrepared[0].preparedToolBindingRef, 'tool-binding:fixture-read:g2');
  assert.throws(
    () => prepareToolPromptContributions(extensionProviders, [extensionTool], selectedPlugins),
    /tool_prompt_provider_plugin_unselected:plugin:\/\/fixture@mcp/u,
  );
  assert.throws(
    () => prepareToolPromptContributions(extensionProviders, [{
      ...extensionTool,
      pluginUri: 'plugin://different@mcp',
    }], selectedWithFixture),
    /tool_prompt_plugin_mismatch:fixture\.read/u,
  );

  const collidingTools = [extensionTool, {
    ...extensionTool,
    toolBindingRef: 'tool-binding:fixture-dash-read:g1',
    name: 'fixture-read',
  }];
  const collidingProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:colliding-fixture',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
    contributions: collidingTools.map((tool, index) => ({
      contributionRef: `tool-prompt-contribution:collision:${index}`,
      canonicalToolName: tool.name,
      promptSnippet: `Route ${index}.`,
      usageGuidelines: [],
    })),
  }]);
  const collidingPrepared = prepareToolPromptContributions(
    collidingProviders,
    collidingTools,
    selectedWithFixture,
  );
  const collidingAliases = createProviderToolAliases(collidingTools.map((tool) => tool.name));
  assert.equal(new Set(collidingAliases.map((alias) => alias.wireName)).size, 2);
  const collidingGuidance = renderActiveToolGuidance(
    collidingPrepared,
    collidingAliases,
    collidingTools,
    [],
  );
  assert.ok(collidingGuidance);
  const collidingLines = new Set(collidingGuidance.split('\n'));
  for (const [index, tool] of collidingTools.entries()) {
    const wireName = collidingAliases.find((alias) => alias.canonicalName === tool.name)?.wireName;
    assert.ok(wireName);
    assert.ok(collidingLines.has(`- ${wireName}: Route ${index}.`));
  }
});

test('Session renders one run-scoped tool guidance message with Provider aliases', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-guidance';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tools = [{
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read UTF-8 text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  }, {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Run a command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
    possibleEffects: ['process'],
    availability: 'callable',
    origin: 'coreBuiltin',
  }];
  const toolPromptContributions = [{
    contributionRef: 'tool-prompt-contribution:read',
    preparedToolBindingRef: 'tool-binding:read:g1',
    canonicalToolName: 'fs.read',
    origin: 'coreBuiltin',
    promptSnippet: 'Read UTF-8 workspace text directly.',
    usageGuidelines: ['Use this for a known text file.'],
  }, {
    contributionRef: 'tool-prompt-contribution:bash',
    preparedToolBindingRef: 'tool-binding:bash:g1',
    canonicalToolName: 'bash',
    origin: 'coreBuiltin',
    promptSnippet: 'Run commands.',
    usageGuidelines: ['Use this for search, builds, tests, and command execution.'],
  }];
  const preparation = fakeRunPreparation({ tools, toolPromptContributions });
  const requests = [];
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:tool-guidance',
        content: 'Done.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'tool-guidance',
  );

  await actor.submit(messageCommand(sessionId, 'command:tool-guidance', 'Inspect one known file.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(requests.length, 1);
  const systemMessages = requests[0].messages.filter((message) => message.role === 'system');
  const guidanceMessages = systemMessages.filter((message) => (
    message.content.startsWith('Active tool guidance:')
  ));
  assert.equal(guidanceMessages.length, 1);
  assert.equal(systemMessages.indexOf(guidanceMessages[0]), 1);
  assert.deepEqual(requests[0].hostedTools, []);
  assert.doesNotMatch(guidanceMessages[0].content, /API's native search tool/u);
  const aliases = new Map(preparation.snapshots[0].providerToolAliases.map((alias) => (
    [alias.canonicalName, alias.wireName]
  )));
  const providerToolNames = new Set(requests[0].tools.map((tool) => tool.name));
  const guidanceLines = new Set(guidanceMessages[0].content.split('\n'));
  for (const contribution of toolPromptContributions) {
    const alias = aliases.get(contribution.canonicalToolName);
    assert.ok(alias);
    assert.ok(providerToolNames.has(alias));
    assert.ok(guidanceLines.has(`- ${alias}: ${contribution.promptSnippet}`));
    for (const guideline of contribution.usageGuidelines) {
      assert.ok(guidanceLines.has(`- ${alias}: ${guideline}`));
    }
  }
  assert.equal(guidanceMessages[0].content.match(/^- /gmu)?.length, 4);
  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const guidanceReceipts = composition.payload.messages.filter((message) => (
    message.contributionId === 'instruction:deepcode.tool-guidance'
  ));
  assert.equal(guidanceReceipts.length, 1);
  assert.equal(guidanceReceipts[0].contributionKind, 'instructions');
  assert.equal(guidanceReceipts[0].role, 'system');
  assert.deepEqual(guidanceReceipts[0].blocks.map((block) => block.kind), ['text']);
  await actor.dispose();
});

test('explicit run approvals are journaled and only accepted for a Kernel candidate', async (t) => {
  for (const candidate of [false, true]) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:run-approval-${candidate}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const preparation = fakeRunPreparation({ tools: [{
      toolBindingRef: 'binding:approval', name: 'web.fetch', description: 'Read URL', origin: 'coreBuiltin', availability: 'callable',
      possibleEffects: ['network'], inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    }] });
    const preview = { summary: 'Approval fixture', effects: ['external'], logicalTargets: ['.'],
      ...(candidate ? { authorizationScope: 'runHostShell', authorizationContext: { workspaceId: workspaceBinding.workspaceId, shell: '/bin/bash' } } : {}) };
    let calls = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:approval', name: request.tools.find((tool) => tool.inputSchema.properties?.url).name, input: { url: 'https://example.test' } });
      else {
        const result = request.messages.map(jsonMessagePayload).find((value) => value?.outcome === 'completed');
        assert.deepEqual(result.approval, { decision: 'allow', scope: candidate ? 'runHostShell' : 'call' });
        yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:done', content: 'Done.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } }, emptyKernel({ async execute(request) {
      if (!request.nonWorkspaceAuthority) return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId, callId: request.callId, status: 'approvalRequired', approvalId: 'approval:run', preview };
      return completedExecutionReply(request, { content: 'Result' });
    } }), preparation.port, 'run-approval');
    t.after(() => actor.dispose());
    await actor.submit(messageCommand(sessionId, 'command:start', 'Exercise approval.'));
    const waiting = await waitForProjection(actor, (state) => state.pendingApproval !== null);
    const approval = waiting.pendingApproval;
    const command = { schemaVersion: 'deepcode.command.v3', type: 'approval.respond', commandId: 'command:allow-run', sessionId,
      runId: approval.runId, callId: approval.callId, approvalId: approval.approvalId, decision: 'allow', authorizationScope: 'runHostShell' };
    const reply = await actor.submit(command);
    assert.equal(reply.status, candidate ? 'accepted' : 'rejected');
    if (!candidate) {
      assert.equal((await actor.snapshot()).pendingApproval.approvalId, approval.approvalId);
      await actor.submit({ ...command, commandId: 'command:allow-once', authorizationScope: undefined });
    }
    await waitForProjection(actor, (state) => state.run?.status === 'completed');
    const resolved = singleEvent(await readEvents(journal, sessionId), 'approval.resolved');
    assert.equal(resolved.payload.authorizationScope, candidate ? 'runHostShell' : undefined);
    assert.equal(resolved.payload.decision, 'allow');
  }
});

test('read-only bash result projects its real write scope and continues the Loop', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:bash-read-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Execute one bounded Bash command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer' },
      },
    },
    possibleEffects: ['process', 'workspaceMutation', 'external'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      const reply = completedExecutionReply(request, {
        workspaceId: workspaceBinding.workspaceId,
        command: request.input.command,
        cwd: '.',
        workspaceMode: 'read',
        executionScope: 'workspace',
        terminal: false,
        stdout: 'probe-ok',
        stderr: '',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
        capturedBytes: 8,
        durationMs: 1,
        environment: {
          shell: '/bin/bash',
          interactive: false,
          executionScope: 'workspace',
          terminal: false,
          pathSource: 'hostPlusStandardDeveloperPaths',
          writeScope: 'authorizedResources',
          homeWritable: true,
          networkAccess: false,
        },
      });
      reply.record.preparedEffect.logicalTargets = ['.'];
      Object.assign(reply.record.preparedEffect.canonicalInvocation.arguments, { workspaceMode: 'read', executionScope: 'workspace' });
      reply.record.preparedEffect.processWorkspaceMode = 'read';
      reply.record.preparedEffect.processExecutionScope = 'workspace';
      return reply;
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.command !== undefined
        ));
        assert.ok(definition, 'bash must be exposed to the Provider');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-read',
          name: definition.name,
          input: {
            workspace: 'primary',
            command: "printf 'probe-ok'",
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      const toolResult = request.messages
        .map(jsonMessagePayload)
        .find((payload) => payload?.outcome === 'completed');
      assert.equal(toolResult?.output?.workspaceMode, 'read');
      assert.equal(toolResult?.output?.executionScope, 'workspace');
      assert.equal(toolResult?.output?.terminal, false);
      assert.equal(toolResult?.output?.workspaceId, undefined);
      assert.equal(toolResult?.output?.environment?.writeScope, 'authorizedResources');
      assert.equal(toolResult?.output?.environment?.homeWritable, true);
      assert.equal(toolResult?.output?.environment?.networkAccess, false);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:bash-read-answer',
        content: 'Read-only shell continuation completed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'bash-read-chain',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:bash-read',
    'Run the read-only shell probe.',
  ));
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'process shell runtime release');

  assert.equal(providerRequests.length, 2);
  assert.equal(kernelRequests.length, 1);
  assert.equal('workspaceMode' in kernelRequests[0].input, false);
  assert.equal('executionScope' in kernelRequests[0].input, false);
  const shellActivity = projection.activities.find((activity) => (
    activity.callId === kernelRequests[0].callId
  ));
  assert.equal(shellActivity?.status, 'completed');
  assert.equal(shellActivity?.tool?.shell?.result?.environment.writeScope, 'authorizedResources');
  assert.equal(shellActivity?.tool?.shell?.result?.environment.homeWritable, true);
  assert.equal(shellActivity?.tool?.shell?.result?.environment.networkAccess, false);
  const events = await readEvents(journal, sessionId);
  const requested = singleEvent(events, 'tool.requested');
  const completed = singleEvent(events, 'tool.completed');
  const providerCompletions = events.filter((event) => event.type === 'provider.turn.settled');
  assert.equal(providerCompletions.length, 2);
  assertEventOrder(requested, completed, providerCompletions[1]);

  await actor.dispose();

  for (const writeScope of ['workspaceAndKernelTemporary', 'kernelTemporaryOnly', 'recordedScope']) {
    const history = structuredClone(events);
    const environment = history.find((event) => event.type === 'tool.completed').payload.record.output.environment;
    Object.assign(environment, { writeScope, homeWritable: false, networkAccess: false });
    const beforeRead = structuredClone(history);
    const service = new SessionService({ async *read() { yield* history; } }, {
      async create() { throw new Error('Reading history must not prepare or execute a run'); },
    });
    const restored = await service.snapshot(sessionId);
    const result = restored.activities.find((activity) => activity.callId === kernelRequests[0].callId).tool.shell.result;
    assert.deepEqual(result.environment, environment);
    assert.deepEqual(history, beforeRead);
    assert.deepEqual(restored.shellAuthorizations, []);
    environment.homeWritable = 'false';
    const invalidHistory = structuredClone(history);
    const readable = await service.snapshot(sessionId);
    const invalidTool = readable.activities.find((activity) => activity.callId === kernelRequests[0].callId);
    assert.equal(invalidTool.status, 'completed');
    assert.equal(invalidTool.tool.shell, undefined);
    assert.equal(invalidTool.tool.projectionError.code, 'bash_projection_environment_invalid');
    assert.deepEqual(readable.messages, restored.messages);
    assert.deepEqual(readable.run, restored.run);
    assert.deepEqual(history, invalidHistory);
  }
  for (const [detail, expectedCode] of [
    [{ fileChanges: [{ workspaceId: workspaceBinding.workspaceId, path: 'output.txt', kind: 'create',
      before: { exists: false }, after: { exists: true, contentRef: 'content:one', sizeBytes: '12' } }] }, 'kernel_file_changes_invalid'],
    [{ artifacts: [{ artifactId: 'artifact:bad', label: 'Output', contentType: 'text/plain', contentMode: 'fixed' }] }, 'tool_artifact_resource_invalid'],
  ]) {
    const history = structuredClone(events);
    Object.assign(history.find((event) => event.type === 'tool.completed').payload.record.output, detail);
    const original = structuredClone(history);
    const service = new SessionService({ async *read() { yield* history; } }, {
      async create() { throw new Error('History must not start a run'); },
    });
    const readable = await service.snapshot(sessionId);
    const tool = readable.activities.find((activity) => activity.callId === kernelRequests[0].callId).tool;
    assert.equal(tool.projectionError.code, expectedCode);
    assert.equal(tool.shell.result.exitCode, 0);
    assert.equal(readable.run.status, 'completed');
    assert.deepEqual(readable.messages, projection.messages);
    assert.deepEqual(history, original);
  }
  for (const extra of [{ operation: 'fs.delete', targets: ['logs'], workspaceId: workspaceBinding.workspaceId }, { rule: 'example' }]) {
    const history = structuredClone(events);
    const record = history.find((event) => event.type === 'tool.completed').payload.record;
    record.outcome = 'denied';
    record.error = { code: 'operation_denied', message: 'Original refusal.', ...extra };
    const original = structuredClone(history);
    const readable = projectSession(loopSnapshot(sessionId, history).state);
    const activity = readable.activities.find((item) => item.callId === record.callId);
    assert.equal(activity.status, 'denied');
    assert.deepEqual(activity.tool.error, { code: 'operation_denied', message: 'Original refusal.' });
    assert.equal(activity.tool.projectionError, undefined);
    assert.equal(readable.run.status, 'completed');
    assert.deepEqual(history, original);
  }
  assert.equal(kernelRequests.length, 1);
  assert.equal(providerRequests.length, 2);
  assert.equal(preparation.prepared.length, 1);
});

for (const toolName of ['bash', 'powershell']) {
for (const output of [null, { stage: 'execution', details: { toolId: toolName } }]) {
  test(`pre-spawn shell failure settles and replays without invented process output (${toolName}, ${output === null ? 'null' : 'diagnostic'})`, async (t) => {
    const journal = new InMemoryCommandJournal();
    const sessionId = 'session:shell-unavailable';
    await createSession(journal, sessionId, [workspaceBinding]);
    const preparation = fakeRunPreparation({ tools: [{
      toolBindingRef: `tool-binding:${toolName}:g1`, name: toolName, description: 'Run the selected shell.',
      inputSchema: { type: 'object', required: ['command'], properties: {
        command: { type: 'string' },
      } }, possibleEffects: ['process', 'workspaceMutation', 'external'], availability: 'callable', origin: 'coreBuiltin',
    }] });
    const error = { code: `${toolName}_unavailable`, message: 'No Bash executable is available for the bound workspace.' };
    let calls = 0;
    const kernel = emptyKernel({ async execute(request) {
      calls += 1;
      const reply = failedExecutionReply(request, output, error);
      reply.record.preparedEffect.logicalTargets = ['.'];
      Object.assign(reply.record.preparedEffect.canonicalInvocation.arguments, { workspaceMode: 'read', executionScope: 'workspace' });
      reply.record.preparedEffect.processWorkspaceMode = 'read';
      reply.record.preparedEffect.processExecutionScope = 'workspace';
      return reply;
    } });
    let turns = 0;
    const provider = { async *stream(request) {
      if (++turns === 1) {
        yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:shell-unavailable', name: request.tools[0].name,
          input: { workspace: 'primary', command: 'git status -sb' } });
      } else {
        const result = request.messages.map(jsonMessagePayload).find((item) => item?.outcome === 'failed');
        assert.deepEqual(result?.error, error);
        assert.deepEqual(result?.output, output);
        yield providerEvent(request.requestId, 'assistant.message', { messageId: `provider:answer:${turns}`, content: 'The shell could not start.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    let actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'shell-unavailable');
    t.after(() => actor.dispose());
    await actor.submit(messageCommand(sessionId, 'command:shell-unavailable', 'Check the branch.'));
    const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
    const activity = projection.activities.find((item) => item.tool?.shell);
    assert.equal(activity?.status, 'failed');
    assert.equal(activity?.tool?.shell?.result, undefined);
    assert.equal(activity?.tool?.shell?.command, 'git status -sb');
    const events = await readEvents(journal, sessionId);
    assert.equal(singleEvent(events, 'tool.completed').payload.record.error.code, `${toolName}_unavailable`);
    singleEvent(events, 'run.runtime.released');
    singleEvent(events, 'run.settled');
    assert.equal(preparation.released.length, 1);
    await actor.dispose();
    actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'shell-reopened');
    await actor.recover();
    await actor.submit(messageCommand(sessionId, 'command:shell-after-restart', 'Explain the error.'));
    await waitForProjection(actor, (value) => value.run?.status === 'completed' && preparation.released.length === 2);
    assert.equal(calls, 1);
  });
}
}

test('a run without workspace bindings never exposes workspace-scoped tools', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:no-workspace-tools';
  await createSession(journal, sessionId);
  const tools = [
    {
      toolBindingRef: 'tool-binding:list:no-workspace',
      name: 'fs.read',
      description: 'Read one workspace file.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
      },
      possibleEffects: ['workspaceRead'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:shell:no-workspace',
      name: 'bash',
      description: 'Run one workspace process.',
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
        },
      },
      possibleEffects: ['process', 'workspaceMutation', 'external'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:web:no-workspace',
      name: 'web.search',
      description: 'Search a non-workspace source.',
      inputSchema: { type: 'object' },
      possibleEffects: ['network'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:mcp:no-workspace',
      name: 'mcp.echo',
      description: 'Call a non-workspace external tool.',
      inputSchema: { type: 'object' },
      possibleEffects: ['external'],
      availability: 'callable',
      origin: 'extension',
      pluginUri: 'plugin://echo@test',
    },
  ];
  const preparation = fakeRunPreparation({
    tools,
    toolPromptContributions: tools.filter((tool) => tool.origin === 'coreBuiltin').map((tool) => ({
      contributionRef: `tool-prompt-contribution:${tool.name}`,
      canonicalToolName: tool.name,
      preparedToolBindingRef: tool.toolBindingRef,
      origin: tool.origin,
      promptSnippet: tool.description,
      usageGuidelines: [],
    })),
  });
  let capturedRequest;
  const actor = actorWith(
    journal,
    sessionId,
    {
      async *stream(request) {
        capturedRequest = structuredClone(request);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:no-workspace',
          content: 'No workspace is required for this answer.',
        });
        yield providerEvent(request.requestId, 'completed', {});
      },
    },
    emptyKernel(),
    preparation.port,
    'no-workspace-tools',
  );

  await actor.submit(messageCommand(sessionId, 'command:no-workspace', 'Report your status.'));
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  assert.deepEqual(capturedRequest.workspaceBindings, []);
  assert.deepEqual(capturedRequest.tools.map((tool) => tool.name), [
    'web_search',
    'artifact_present',
    'interaction_request',
    'mcp_echo',
  ]);
  const searchDescription = tools.find(tool => tool.name === 'web.search').description;
  assert.equal(capturedRequest.tools.find(tool => tool.name === 'web_search').description, searchDescription);
  assert.equal(capturedRequest.messages.some(message => (
    message.role === 'system' && message.content.includes(searchDescription)
  )), false, 'the tool description is not duplicated in system guidance');
  assert.deepEqual(capturedRequest.hostedTools, []);
  assert.equal(capturedRequest.tools.some((tool) => (
    tool.inputSchema?.properties?.workspaceId !== undefined || tool.inputSchema?.properties?.workspace !== undefined
  )), false);
  assert.deepEqual(
    projection.contextCompositions.at(-1).tools.map((tool) => tool.itemId),
    ['web.search', 'artifact.present', 'interaction.request', 'mcp.echo'],
  );
  await actor.dispose();
});

test('explicit /focus and same-runtime pressure compact only after a successful summary turn', async () => {
  await verifyExplicitFocusCompaction();
  await verifyPressureCompaction();
});

test('compaction rejects invalid output without executing tools or retrying and preserves completion state', async (t) => {
  for (const [name, output, completion, code, outcome = 'failed'] of [
    ['empty', [], {}, 'context_compaction_empty'],
    ['mismatch', [
      ['text.delta', { text: 'Streamed summary.' }],
      ['assistant.message', { messageId: 'summary:mismatch', content: 'Different summary.' }],
    ], {}, 'provider_message_mismatch'],
    ['usage', [], { usage: { inputTokens: -1 } }, 'provider_usage_invalid'],
    ['tool-call', [
      ['tool.call', { callId: 'provider:summary-tool', name: 'fs_read', input: { path: 'fixture.txt' } }],
    ], {}, 'context_compaction_tool_call_invalid', 'indeterminate'],
    ['native-tool-call', [
      ['output.item.completed', { outputIndex: 0, item: { type: 'function_call',
        id: 'fc_summary', call_id: 'summary-tool', name: 'fs_read', arguments: '{"path":"fixture.txt"}' } }],
    ], {}, 'context_compaction_tool_call_invalid', 'indeterminate'],
  ]) await t.test(name, async (t) => {
    const journal = new InMemoryCommandJournal(), sessionId = `session:completed-compaction-${name}`;
    await createSession(journal, sessionId);
    const preparation = fakeRunPreparation();
    let sends = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      sends++;
      assert.equal(request.purpose, 'contextCompaction');
      for (const [type, data] of output) yield providerEvent(request.requestId, type, data);
      yield providerEvent(request.requestId, 'completed', completion);
    } }, emptyKernel(), preparation.port, `completed-compaction-${name}`);
    t.after(() => actor.dispose());
    await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'context.focus',
      sessionId, commandId: 'command:focus', task: 'Summarize the known facts.' });
    const result = await waitForProjection(actor, value => ['failed', 'indeterminate'].includes(value.run?.status));
    assert.equal(result.run.status, outcome);
    if (outcome === 'failed') assert.equal(result.terminalError.code, code);
    else {
      assert.equal(result.terminalError.code, 'provider_turn_outcome_unknown');
      assert.match(result.terminalError.message, new RegExp(code));
    }
    assert.equal(sends, 1);
    assert.equal(preparation.released.length, 1);
    const events = await readEvents(journal, sessionId);
    assert.equal(singleEvent(events, 'provider.turn.settled').payload.outcome, outcome);
    const attempt = events.find(event => event.type === 'provider.attempt.updated' && event.payload.phase === 'failed');
    assert.equal(attempt.payload.error.code, code);
    assert.equal(events.some(event => event.type === 'context.compacted'), false);
    assert.equal(events.some(event => event.type === 'tool.requested' || event.type === 'tool.completed'), false);
  });
});

test('completed Provider cleanup failures preserve the original diagnostics and secondary errors', async (t) => {
  for (const purpose of ['agent', 'contextCompaction']) await t.test(purpose, async (t) => {
    const journal = new InMemoryCommandJournal(), sessionId = `session:completed-cleanup-${purpose}`;
    await createSession(journal, sessionId);
    const diagnostics = { source: 'sessionTransport', phase: 'localStream', category: 'transport', retryable: false,
      isBody: true, causes: [{ message: 'Stream closed before cleanup finished.', kind: 'ConnectionReset' }] };
    const primary = new LoopFailure('provider_stream_failed', 'The local stream failed.', diagnostics);
    const expected = { code: primary.code, message: primary.message, diagnostics: { ...diagnostics,
      secondary: [{ code: 'agent_loop_failed', message: 'Reader cleanup failed.' }] } };
    let sends = 0;
    const preparation = fakeRunPreparation();
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      sends++;
      assert.equal(request.purpose, purpose);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Completed content.' });
      yield providerEvent(request.requestId, 'completed', {});
      throw new AggregateError([primary, new Error('Reader cleanup failed.')], primary.message);
    } }, emptyKernel(), preparation.port, `completed-cleanup-${purpose}`);
    t.after(() => actor.dispose());
    await actor.submit(purpose === 'agent'
      ? messageCommand(sessionId, 'command:start', 'Answer the question.')
      : { schemaVersion: 'deepcode.command.v3', type: 'context.focus', sessionId,
          commandId: 'command:focus', task: 'Summarize the known facts.' });
    const result = await waitForProjection(actor, value => ['failed', 'indeterminate'].includes(value.run?.status));
    assert.equal(result.run.status, 'failed');
    assert.deepEqual(result.terminalError, expected);
    assert.deepEqual(result.failureSnapshot.error, expected);
    assert.equal(sends, 1);
    assert.equal(preparation.released.length, 1);
    const events = await readEvents(journal, sessionId);
    assert.deepEqual(singleEvent(events, 'provider.turn.settled').payload.error, expected);
    assert.equal(result.providerAttempts[0].phase, 'failed');
  });
});

test('completed Provider cancellation preserves pure cancellation and independent failures', async (t) => {
  for (const purpose of ['agent', 'contextCompaction']) for (const kind of ['cancel', 'failure', 'secondary']) await t.test(`${purpose}:${kind}`, async (t) => {
    const journal = new InMemoryCommandJournal(), sessionId = `session:completed-cancel-${purpose}-${kind}`;
    await createSession(journal, sessionId);
    let completed = false, runId, sends = 0;
    const failure = new LoopFailure('provider_stream_failed', 'Independent cleanup failure.');
    const preparation = fakeRunPreparation();
    const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
      sends++;
      runId = request.runId;
      yield providerEvent(request.requestId, 'text.delta', { text: 'Completed content.' });
      yield providerEvent(request.requestId, 'completed', {});
      completed = true;
      await waitForAbort(signal);
      if (kind === 'failure') throw failure;
      if (kind === 'secondary') throw new AggregateError([signal.reason, failure], String(signal.reason));
      throw signal.reason;
    } }, emptyKernel(), preparation.port, `completed-cancel-${purpose}-${kind}`);
    t.after(() => actor.dispose());
    await actor.submit(purpose === 'agent'
      ? messageCommand(sessionId, 'command:start', 'Answer the question.')
      : { schemaVersion: 'deepcode.command.v3', type: 'context.focus', sessionId,
          commandId: 'command:focus', task: 'Summarize the known facts.' });
    await waitUntil(() => completed, 'Provider completion observed before cancellation');
    await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel',
      commandId: 'command:cancel', sessionId, runId });
    const result = await waitForProjection(actor, value => ['failed', 'indeterminate'].includes(value.run?.status));
    assert.equal(result.run.status, kind === 'cancel' ? 'indeterminate' : 'failed');
    if (kind === 'cancel') assert.equal(result.terminalError.code, 'provider_turn_outcome_unknown');
    if (kind === 'failure') assert.deepEqual(result.terminalError, { code: failure.code, message: failure.message });
    if (kind === 'secondary') assert.deepEqual(result.terminalError.diagnostics.secondary,
      [{ code: failure.code, message: failure.message }]);
    assert.equal(sends, 1);
    assert.equal(preparation.released.length, 1);
  });
});

test('Provider HTTP cancellation does not replace an independent error or secondary cleanup failure', async () => {
  const controller = new AbortController();
  controller.abort('user_cancelled');
  const failure = new LoopFailure('provider_event_json_invalid', 'Invalid Provider frame.');
  for (const error of [controller.signal.reason, failure, new AggregateError([controller.signal.reason, failure])]) {
    const port = new HttpProviderPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async () => { throw error; } });
    const iterator = port.stream({ requestId: 'request:cancel-error' }, controller.signal)[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), actual => {
      if (error === controller.signal.reason || error === failure) assert.equal(actual, error);
      else assert.deepEqual(actual.diagnostics.secondary, [{ code: failure.code, message: failure.message }]);
      return true;
    });
  }
});

test('completed Provider persistence failures stay failed and never resend generation', async (t) => {
  for (const purpose of ['agent', 'contextCompaction']) for (const phase of ['attempt', 'settlement']) await t.test(`${purpose}:${phase}`, async (t) => {
    const journal = new InMemoryCommandJournal(), sessionId = `session:completed-journal-${purpose}-${phase}`;
    await createSession(journal, sessionId);
    const append = journal.append.bind(journal);
    const appendBatch = journal.appendBatch.bind(journal);
    const diagnostics = { source: 'session', phase: 'journal', category: 'transport', retryable: false,
      causes: [{ message: 'Journal write failed.', kind: 'ConnectionReset' }] };
    const failure = new LoopFailure('journal_append_failed', `Could not persist the completed ${phase}.`, diagnostics);
    journal.append = async event => {
      if (phase === 'attempt' && event.type === 'provider.attempt.updated' && event.payload.phase === 'completed') throw failure;
      return append(event);
    };
    journal.appendBatch = async events => {
      if (phase === 'settlement' && events.some(event => event.type === 'provider.turn.settled' && event.payload.outcome === 'completed')) throw failure;
      return appendBatch(events);
    };
    let sends = 0;
    const preparation = fakeRunPreparation();
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      sends++;
      assert.equal(request.purpose, purpose);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Completed content.' });
      yield providerEvent(request.requestId, 'completed', {});
    } }, emptyKernel(), preparation.port, `completed-journal-${purpose}`);
    t.after(() => actor.dispose());
    await actor.submit(purpose === 'agent'
      ? messageCommand(sessionId, 'command:start', 'Answer the question.')
      : { schemaVersion: 'deepcode.command.v3', type: 'context.focus', sessionId,
          commandId: 'command:focus', task: 'Summarize the known facts.' });
    const result = await waitForProjection(actor, value => ['failed', 'indeterminate'].includes(value.run?.status));
    assert.equal(result.run.status, 'failed');
    assert.deepEqual(result.terminalError, { code: failure.code, message: failure.message, diagnostics });
    assert.equal(sends, 1);
    assert.equal(preparation.released.length, 1);
    const events = await readEvents(journal, sessionId);
    assert.equal(singleEvent(events, 'provider.turn.settled').payload.outcome, 'failed');
    assert.equal(events.some(event => event.type === 'context.compacted'), false);
  });
});

test('cancel and service disposal close their owned runtime boundaries in order', async () => {
  await verifyWaitingCancelRelease();
  await verifyComposedDisposeRelease();
  await verifyExecutingToolDisposeCleanup();
});

test('Session service owns Host activity through background completion', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:host-background-activity';
  await createSession(journal, sessionId);
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const preparation = fakeRunPreparation();
  const service = new SessionService(journal, {
    async create() {
      return { composition: {
          provider: { async *stream(request) {
          await held;
          yield providerEvent(request.requestId, 'text.delta', { text: 'Background work completed.' });
          yield providerEvent(request.requestId, 'completed', {});
        } },
          kernel: emptyKernel(), runPreparation: preparation.port,
        async dispose() {},
      } };
    },
  });
  t.after(async () => { finish(); await service.dispose(); });
  assert.deepEqual(await service.activity(), { active: false });
  await service.submit(messageCommand(sessionId, 'command:host-background', 'Complete this work.'));
  assert.deepEqual(await service.activity(), { active: true });
  finish();
  await waitUntil(async () => !(await service.activity()).active, 'background completion releases Host without a shell snapshot');
  assert.deepEqual(await service.activity(), { active: false });
  assert.equal(preparation.released.length, 1);
});

test('deletion remains available while an unloadable actor rolls back cleanly', async () => {
  const baseJournal = new InMemoryCommandJournal();
  const sessionId = 'session:delete-unloadable';
  await createSession(baseJournal, sessionId);
  let readCount = 0;
  let recoveryStartedResolve;
  let releaseRecoveryResolve;
  const recoveryStarted = new Promise((resolve) => { recoveryStartedResolve = resolve; });
  const releaseRecovery = new Promise((resolve) => { releaseRecoveryResolve = resolve; });
  const journal = forwardingJournal(baseJournal, async function* (targetSessionId, afterSequence) {
    readCount += 1;
    if (readCount !== 2) {
      for await (const event of baseJournal.read(targetSessionId, afterSequence)) yield event;
      return;
    }
    recoveryStartedResolve();
    await releaseRecovery;
    throw new Error('fixture_recovery_failed');
  });
  let disposeCount = 0;
  const preparation = fakeRunPreparation();
  const service = new SessionService(journal, {
    async create() {
      return {
        composition: {
              provider: { async *stream() { throw new Error('unexpected_provider_turn'); } },
                  kernel: emptyKernel(),
          runPreparation: preparation.port,
          async dispose() { disposeCount += 1; },
        },
      };
    },
  });

  const snapshot = service.submit(messageCommand(sessionId, 'command:open-for-delete', 'Start explicitly.'));
  await recoveryStarted;
  const deletion = service.deleteSession(sessionId);
  releaseRecoveryResolve();
  await assert.rejects(snapshot, /fixture_recovery_failed/u);
  await deletion;
  assert.equal(disposeCount, 1);
  await assert.rejects(async () => {
    for await (const _event of baseJournal.read(sessionId)) {
      // The deleted journal must not yield any event.
    }
  }, /session_not_found/u);
  await service.dispose();
});

test('family deletion rejects an unreadable journal and preserves its data', async () => {
  const baseJournal = new InMemoryCommandJournal();
  const sessionId = 'session:delete-unreadable';
  await createSession(baseJournal, sessionId);
  const before = [];
  for await (const event of baseJournal.read(sessionId)) before.push(event);
  const journal = forwardingJournal(baseJournal, async function* () {
    throw new Error('fixture_journal_unreadable');
  });
  const service = new SessionService(journal, {
    async create() { throw new Error('unexpected_composition_create'); },
  });
  try {
    await assert.rejects(service.deleteSession(sessionId), /fixture_journal_unreadable/u);
    const after = [];
    for await (const event of baseJournal.read(sessionId)) after.push(event);
    assert.deepEqual(after, before);
  } finally {
    await service.dispose();
  }
});

test('partial family deletion preserves the original error and exact deleted IDs', async (t) => {
  const { SessionDeletionError } = await import('../dist/local-agent/service.js');
  const base = new InMemoryCommandJournal(), ownerId = 'session:partial-owner', childId = 'session:partial-child';
  await createSession(base, ownerId);
  let initialized = false, actor;
  const provider = { async *stream(request) {
    if (!initialized) {
      initialized = true;
      await base.createSession({ sessionId: childId, displayTitle: 'Child', workspaceBindings: [], agentContext: {
        capabilities: NO_AGENT_CAPS, ownerSessionId: ownerId, parentSessionId: ownerId,
        parentRunId: request.runId, parentCallId: 'call:create-child',
      } });
      await actor.recordAgentEvents([
        { type: 'agent.task.created', sessionId: ownerId, runId: request.runId, callId: 'call:create-child', payload: {
          taskId: 'task:partial-child', agentSessionId: childId, capabilities: NO_AGENT_CAPS, createsAgent: true,
          displayName: 'Child', text: 'A recorded task.', delivery: 'async',
        } },
        { type: 'agent.task.completed', sessionId: ownerId, runId: request.runId, payload: {
          taskId: 'task:partial-child', result: { outcome: 'failed', error: { code: 'fixture_start_failed', message: 'Start failed.' } },
        } },
      ]);
    }
    yield providerEvent(request.requestId, 'text.delta', { text: 'Task failure recorded.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  actor = actorWith(base, ownerId, provider, emptyKernel(), fakeRunPreparation().port, 'partial-delete');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(ownerId, 'command:partial-owner', 'Run the task.'));
  await waitForProjection(actor, value => value.run?.status === 'completed');
  await actor.dispose();
  const original = new Error('fixture_owner_delete_failed');
  const journal = forwardingJournal(base, (...args) => base.read(...args));
  journal.deleteSession = async id => { if (id === ownerId) throw original; await base.deleteSession(id); };
  const service = new SessionService(journal, { async create() { throw new Error('unexpected_composition_create'); } });
  try {
    await assert.rejects(service.deleteSession(ownerId), error => {
      assert.ok(error instanceof SessionDeletionError);
      assert.equal(error.errors[0], original);
      assert.deepEqual(error.details, { deletedSessionIds: [childId], remainingSessionIds: [ownerId] });
      return true;
    });
    await assert.rejects(readEvents(base, childId), /session_not_found/);
    assert.ok((await readEvents(base, ownerId)).length > 0);
  } finally { await service.dispose(); }
});

test('an escaped Loop fault remains Session-local and releases its runtime', async () => {
  const baseJournal = new InMemoryCommandJournal();
  const failingSessionId = 'session:contained-loop-failure';
  const healthySessionId = 'session:healthy-after-loop-failure';
  const journal = {
    createSession: (input) => baseJournal.createSession(input),
    deleteSession: (sessionId) => baseJournal.deleteSession(sessionId),
    append: (event) => baseJournal.append(event),
    appendBatch(events) {
      if (events.some((event) => (
        event.sessionId === failingSessionId && event.type === 'provider.turn.settled'
      ))) throw new Error('fixture_journal_settlement_failed');
      return baseJournal.appendBatch(events);
    },
    read: (sessionId, afterSequence) => baseJournal.read(sessionId, afterSequence),
    readCommand: (sessionId, commandId) => baseJournal.readCommand(sessionId, commandId),
    commitCommand: (command, events, reply) => baseJournal.commitCommand(command, events, reply),
  };
  await createSession(journal, failingSessionId);
  await createSession(journal, healthySessionId);

  const failingPreparation = fakeRunPreparation();
  const answerProvider = {
    async *stream(request) {
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:${request.sessionId}`,
        content: `answer for ${request.sessionId}`,
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const failingActor = actorWith(
    journal,
    failingSessionId,
    answerProvider,
    emptyKernel(),
    failingPreparation.port,
    'contained-loop-failure',
  );
  await failingActor.submit(messageCommand(
    failingSessionId,
    'command:contained-loop-failure',
    'Trigger the fixture failure.',
  ));
  await waitUntil(() => failingActor.hasLoopFailure(), 'contained Loop failure');
  assert.equal(failingPreparation.released.length, 1);
  const failedHistory = await failingActor.snapshot();
  assert.equal(failedHistory.failureSnapshot.error.message, 'fixture_journal_settlement_failed');
  assert.ok(failedHistory.messages.length > 0, 'saved history stays readable after an escaped failure');
  await assert.rejects(failingActor.submit(messageCommand(failingSessionId, 'command:failed-actor', 'Continue.')),
    /session_loop_failed:fixture_journal_settlement_failed/u);

  const healthyPreparation = fakeRunPreparation();
  const healthyActor = actorWith(
    journal,
    healthySessionId,
    answerProvider,
    emptyKernel(),
    healthyPreparation.port,
    'healthy-after-loop-failure',
  );
  await healthyActor.submit(messageCommand(
    healthySessionId,
    'command:healthy-after-loop-failure',
    'Complete after the other Session failed.',
  ));
  const healthy = await waitForProjection(
    healthyActor,
    (projection) => projection.run?.status === 'completed',
  );
  assert.equal(healthy.terminalError, null);
  assert.equal(healthyPreparation.released.length, 1);

  await failingActor.dispose();
  await healthyActor.dispose();
});

test('one Plan confirmation resumes the same run into Todo-backed execution', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-plan-execution';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:write:g1',
    name: 'fs.write',
    description: 'Replace one fixture file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    possibleEffects: ['workspaceMutation'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool], contextWindowTokens: 8_192 });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.equal(request.planAuthorities?.length, 1);
      assert.equal(request.planAuthorities[0].runId, request.runId);
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'fs.write',
        target: 'README.md',
      }]);
      return completedExecutionReply(request, { written: true });
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const writeDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
        && candidate.inputSchema?.properties?.content !== undefined
      ));

      if (providerRequests.length === 1) {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(planDefinition, 'plan.publish must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:plan',
          name: planDefinition.name,
          input: {
            title: 'Update fixture README',
            summary: 'Write the confirmed fixture content.',
            steps: [{
              stepId: 'write-readme',
              title: 'Write README',
              details: 'Replace README.md with the confirmed fixture content.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'fs.write',
              target: 'README.md',
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'normal');
        const preConfirmationRequest = providerRequests[0];
        assert.deepEqual(
          request.messages.slice(0, preConfirmationRequest.messages.length),
          preConfirmationRequest.messages,
          'Plan confirmation must preserve the preceding Provider message prefix',
        );
        const confirmationIndex = request.messages.findIndex(message => jsonMessagePayload(message)?.response?.kind === 'confirm');
        assert.ok(confirmationIndex >= preConfirmationRequest.messages.length,
          'Plan confirmation and its next action must be appended after the preceding Provider prefix');
        const confirmation = jsonMessagePayload(request.messages[confirmationIndex]);
        const todo = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.type === 'todo.current');
        assert.ok(confirmation, 'confirmed Plan must be projected as the plan call result');
        assert.equal(confirmation.todoSeeded, true);
        assert.ok(typeof confirmation.nextAction === 'string' && confirmation.nextAction.trim());
        assert.ok(todo, 'confirmation must atomically seed Provider-visible Todo');
        assert.equal('executionDirective' in todo, false);
        assert.ok(writeDefinition, 'confirmed execution tool must remain available');
        assert.equal(
          request.tools.some((candidate) => candidate.name.includes('todo')),
          true,
          'Todo is a Session control available independently of Plan approval',
        );

        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:write',
          name: writeDefinition.name,
          input: {
            workspace: 'primary',
            path: 'README.md',
            content: 'Confirmed fixture content.\n',
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 3) {
        yield* todoUpdateEvents(request, 'completed', true);
        return;
      }
      assert.equal(providerRequests.length, 4);
      assert.equal(request.responseConstraint, 'normal');
      const todoStates = request.messages
        .map(jsonMessagePayload)
        .filter((payload) => payload?.type?.startsWith('todo.'));
      assert.equal(todoStates.length, 1, 'the model update must not append a duplicate full Todo snapshot');
      assert.equal(todoStates[0].items[0].status, 'pending');
      assert.deepEqual(jsonMessagePayload(request.messages.findLast(message => message.role === 'tool')),
        { accepted: true });
      for (let index = 1; index < providerRequests.length; index += 1) {
        assert.deepEqual(providerRequests[index].messages.slice(0, providerRequests[index - 1].messages.length), providerRequests[index - 1].messages);
      }
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:plan-complete',
        content: 'Confirmed plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-plan-execution',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:plan-start',
    'Update the fixture through a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const plan = waiting.pendingPlan;
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');
  const stalePlanReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-stale',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'cancel' },
  });
  assert.equal(stalePlanReply.status, 'rejected');
  assert.equal(stalePlanReply.error?.code, 'plan_not_pending');
  assert.equal(
    (await journal.readCommand(sessionId, 'command:plan-stale'))?.reply.status,
    'rejected',
  );

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed Plan runtime release');
  assert.equal(providerRequests.length, 4);
  assert.equal(kernelRequests.length, 1);
  assert.equal(completed.plans[0].status, 'confirmed');
  assert.equal(completed.activePlanRef, null);
  assert.equal(completed.todoList.items[0].status, 'completed');

  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'input.accepted').length, 1);
  const published = singleEvent(events, 'plan.published');
  const confirmed = singleEvent(events, 'plan.confirmed');
  const seeded = events.find(event => event.type === 'todo.updated' && !event.callId);
  const requested = singleEvent(events, 'tool.requested');
  const progressed = events.find(event => event.type === 'todo.updated' && event.callId);
  assert.equal(seeded.payload.items[0].status, 'pending');
  assert.equal(progressed.payload.items[0].status, 'completed');
  const toolCompleted = singleEvent(events, 'tool.completed');
  const finalMessage = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'assistant'
  ));
  const finishing = singleEvent(events, 'run.finishing');
  const released = singleEvent(events, 'run.runtime.released');
  const settlement = singleEvent(events, 'run.settled');
  assert.ok(finalMessage, 'same run must finish with one final assistant message');
  assertEventOrder(
    published,
    confirmed,
    seeded,
    requested,
    toolCompleted,
    progressed,
    finalMessage,
    finishing,
    released,
    settlement,
  );

  await actor.dispose();
});

test('confirmed Host Bash preserves failed execution and reports later Todo progress separately', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-bash-retry';
  await createSession(journal, sessionId, [workspaceBinding]);

  const command = "printf ready > build/marker.txt";
  const terminal = { stdin: 'ready\n' };
  const preparedTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Execute a bounded Bash command from the bound workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 600 },
        terminal: {
          type: 'object',
          additionalProperties: false,
          required: ['stdin'],
          properties: { stdin: { type: 'string' } },
        },
      },
    },
    possibleEffects: ['process', 'workspaceMutation', 'external'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ contextWindowTokens: 64_000, tools: [preparedTool] });
  const kernelRequests = [];
  const shellOutput = (request, exitCode, stderr = '') => ({
    workspaceId: workspaceBinding.workspaceId,
    command: request.input.command,
    cwd: '.',
    workspaceMode: 'write',
    executionScope: 'host',
    terminal: request.input.terminal !== undefined,
    stdout: exitCode === 0 ? 'ready' : '',
    stderr,
    exitCode,
    success: exitCode === 0,
    timedOut: false,
    truncated: false,
    capturedBytes: exitCode === 0 ? 5 : stderr.length,
    durationMs: 1,
    environment: {
      shell: '/bin/bash',
      interactive: request.input.terminal !== undefined,
      executionScope: 'host',
      terminal: request.input.terminal !== undefined,
      pathSource: 'hostPlusStandardDeveloperPaths',
      writeScope: 'hostUser',
      homeWritable: true,
      networkAccess: true,
    },
  });
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.equal(request.planAuthorities?.length, 1);
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'bash',
        command,
        writablePaths: [{ path: 'build', kind: 'directory' }],
        terminal,
      }]);
      const reply = kernelRequests.length === 1
        ? failedExecutionReply(
            request,
            shellOutput(request, 7, 'fixture failure'),
            { code: 'bash_exit_nonzero', message: 'Bash command exited with status 7.' },
          )
        : completedExecutionReply(request, shellOutput(request, 0));
      reply.record.preparedEffect.logicalTargets = ['.'];
      Object.assign(reply.record.preparedEffect.canonicalInvocation.arguments, { workspaceMode: 'write', executionScope: 'host' });
      reply.record.preparedEffect.processWorkspaceMode = 'write';
      reply.record.preparedEffect.processExecutionScope = 'host';
      reply.record.authority = {
        decision: 'allow',
        source: 'composite',
        workspaceAuthority: reply.record.authority,
        externalAuthority: {
          decision: 'allow',
          source: 'userSetting',
          authorityId: 'user-setting:agent.permissions.external',
        },
      };
      return reply;
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const bashDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.command !== undefined
      ));

      if (providerRequests.length === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-plan',
          name: planDefinition.name,
          input: {
            title: 'Create marker through Bash',
            summary: 'Run the exact confirmed Bash mutation.',
            steps: [{
              stepId: 'run-bash',
              title: 'Run Bash mutation',
              details: 'Create build/marker.txt from the bound workspace root.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'bash',
              command,
              writablePaths: [{ path: 'build', kind: 'directory' }],
              terminal,
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'normal');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-first',
          name: bashDefinition.name,
          input: {
            workspace: 'primary',
            command,
            terminal,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 3) {
        assert.equal(request.responseConstraint, 'normal');
        const failedResult = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.outcome === 'failed');
        assert.equal(failedResult?.error?.code, 'bash_exit_nonzero');
        assert.equal(failedResult?.output?.exitCode, 7);
        assert.equal(failedResult?.output?.stderr, 'fixture failure');
        assert.equal(failedResult?.output?.workspaceId, undefined);
        const todo = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.type === 'todo.current');
        assert.equal(todo?.items[0].status, 'pending');
        yield* todoUpdateEvents(request, 'inProgress');
        return;
      }
      if (providerRequests.length === 4) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-retry',
          name: bashDefinition.name,
          input: {
            workspace: 'primary',
            command,
            terminal,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 5) {
        yield* todoUpdateEvents(request);
        return;
      }
      assert.equal(providerRequests.length, 6);
      assert.equal(request.responseConstraint, 'normal');
      const todo = request.messages
        .map(jsonMessagePayload)
        .findLast((payload) => payload?.type === 'todo.current');
      assert.equal(todo?.items[0].status, 'pending', 'the original seeded model view remains unchanged');
      assert.deepEqual(jsonMessagePayload(request.messages.findLast(message => message.role === 'tool')),
        { accepted: true });
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:bash-plan-complete',
        content: 'Confirmed Bash plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-bash-retry',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:bash-plan-start',
    'Create the marker through a confirmed Bash plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:bash-plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: waiting.pendingPlan.planId,
    revision: waiting.pendingPlan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed Bash runtime release');
  assert.equal(kernelRequests.length, 2);
  assert.equal(completed.todoList.items[0].status, 'completed');
  const shellActivities = completed.activities.filter((activity) => (
    activity.tool?.operation === 'bash'
  ));
  assert.deepEqual(shellActivities.map((activity) => activity.status), ['failed', 'completed']);
  assert.equal(shellActivities[0].tool.shell.result.exitCode, 7);

  const events = await readEvents(journal, sessionId);
  const toolRecords = events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => event.payload.record);
  assert.deepEqual(toolRecords.map((record) => record.outcome), ['failed', 'completed']);
  assert.deepEqual(events.filter(event => event.type === 'todo.updated' && event.callId)
    .map(event => event.payload.items[0].status), ['inProgress', 'completed']);

  await actor.dispose();
});

test('confirmed fs.delete reads targetKind from canonical arguments and completes Todo', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-delete';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:delete:g1',
    name: 'fs.delete',
    description: 'Delete one exact workspace target.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'targetKind'],
      properties: {
        path: { type: 'string' },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'] },
      },
    },
    possibleEffects: ['workspaceMutation'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ contextWindowTokens: 8192, tools: [preparedTool] });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'fs.delete',
        target: 'generated',
        targetKind: 'directoryTree',
      }]);
      return completedExecutionReply(request, { deleted: true });
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const deleteDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.targetKind !== undefined
      ));
      if (providerRequests.length === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:delete-plan',
          name: planDefinition.name,
          input: {
            title: 'Delete generated directory',
            summary: 'Delete the exact confirmed directory tree.',
            steps: [{
              stepId: 'delete-generated',
              title: 'Delete generated directory',
              details: 'Delete the generated directory tree.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'fs.delete',
              target: 'generated',
              targetKind: 'directoryTree',
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'normal');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:delete',
          name: deleteDefinition.name,
          input: {
            workspace: 'primary',
            path: 'generated',
            targetKind: 'directoryTree',
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      if (providerRequests.length === 3) {
        yield* todoUpdateEvents(request);
        return;
      }
      assert.equal(providerRequests.length, 4);
      const todo = request.messages
        .map(jsonMessagePayload)
        .findLast((payload) => payload?.type === 'todo.current');
      assert.equal(todo?.items[0].status, 'pending', 'the original seeded model view remains unchanged');
      assert.deepEqual(jsonMessagePayload(request.messages.findLast(message => message.role === 'tool')),
        { accepted: true });
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:delete-plan-complete',
        content: 'Confirmed delete plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-delete',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:delete-plan-start',
    'Delete the generated directory through a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:delete-plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: waiting.pendingPlan.planId,
    revision: waiting.pendingPlan.revision,
    response: { kind: 'confirm' },
  });

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed delete runtime release');
  assert.equal(kernelRequests.length, 1);
  assert.equal(completed.todoList.items[0].status, 'completed');
  assert.equal(completed.plans[0].status, 'confirmed');
  assert.equal(completed.activePlanRef, null);

  await actor.dispose();
});

test('unfinished Todo preserves final explanation and progress while the run ends normally', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-plan-answer-rejected';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      if (providerRequests.length === 1) {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(planDefinition, 'plan.publish must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:plan',
          name: planDefinition.name,
          input: {
            title: 'Execute one confirmed step',
            summary: 'The confirmed step must enter an execution turn.',
            steps: [{
              stepId: 'execute-step',
              title: 'Execute the step',
              details: 'Use the available structured actions after confirmation.',
            }],
            mutationManifest: [],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      assert.equal(providerRequests.length, 2);
      assert.equal(request.responseConstraint, 'normal');
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.response?.kind === 'confirm'));
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.type === 'todo.current'));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:invalid-execution-answer',
        content: 'Execution is blocked. The confirmed work has not been completed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'confirmed-plan-answer-rejected',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:plan-start',
    'Publish and execute a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const plan = waiting.pendingPlan;
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');

  const failed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'completed run runtime release');
  assert.equal(providerRequests.length, 2);
  assert.equal(failed.plans[0].status, 'confirmed');
  assert.equal(failed.todoList.items[0].status, 'pending');
  assert.equal(failed.terminalError, null);
  assert.equal(failed.activePlanRef, null);

  const events = await readEvents(journal, sessionId);
  const confirmed = singleEvent(events, 'plan.confirmed');
  const seeded = events.find(event => event.type === 'todo.updated' && !event.callId);
  const completions = events.filter((event) => event.type === 'provider.turn.settled');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(completions.length, 2);
  assert.equal(settlement.payload.outcome, 'completed');
  const finalMessage = events.find((event) => event.type === 'message.committed' && event.payload.role === 'assistant');
  assert.equal(finalMessage?.payload.content, 'Execution is blocked. The confirmed work has not been completed.');
  assert.equal(events.some((event) => event.type === 'plan.completed'), false);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assertEventOrder(confirmed, seeded, completions[1], finalMessage, singleEvent(events, 'run.finishing'), singleEvent(events, 'run.runtime.released'), settlement);

  await actor.dispose();
});

test('scope-only proposals preserve phase definitions and cannot silently rewrite the Plan', () => {
  const previous = { planId: 'plan:scope', revision: 1, runId: 'run:scope', status: 'confirmed',
    title: 'Implement', summary: 'Approved work',
    steps: [{ stepId: 'core', title: 'Core', details: 'Implement the required behavior.', verification: ['--werror'] }],
    mutationManifest: [{ workspaceId: 'workspace:scope', operation: 'fs.edit', target: 'src', targetKind: 'directoryTree' }],
  };
  const input = { mode: 'extendScope', summary: 'Include test changes', mutationManifest: [
    { workspaceId: 'workspace:scope', operation: 'fs.write', target: 'tests', targetKind: 'directoryTree' },
  ] };
  const decoded = decodeSessionControlCall('call:scope', 'plan.publish', input);
  const event = publishPlan({ plans: [previous] }, previous.runId, decoded.callId, 'provider:scope', decoded.draft, ['workspace:scope'], () => 'plan:new');
  assert.equal(event.type, 'plan.published');
  assert.equal(event.payload.planId, previous.planId);
  assert.equal(event.payload.revision, 2);
  assert.deepEqual(event.payload.steps, previous.steps);
  assert.equal(event.payload.summary, `${previous.summary}\n\n${input.summary}`);
  assert.deepEqual(event.payload.mutationManifest, [...previous.mutationManifest, ...input.mutationManifest]);
  assert.equal('mode' in event.payload, false, 'the journal keeps a complete Plan fact');
  assert.throws(() => decodeSessionControlCall('call:mixed', 'plan.publish', { ...input, steps: [] }),
    (error) => error.code === 'session_control_shape_invalid');
  const absent = publishPlan({ plans: [] }, previous.runId, decoded.callId, 'provider:scope', decoded.draft, ['workspace:scope'], () => 'plan:new');
  assert.equal(absent.type, 'session.control.rejected');
  assert.equal(absent.payload.error.code, 'plan_scope_extension_not_active');
  const repeated = publishPlan({ plans: [previous] }, previous.runId, decoded.callId, 'provider:scope',
    { ...input, mutationManifest: previous.mutationManifest }, ['workspace:scope'], () => 'plan:new');
  assert.equal(repeated.payload.error.code, 'plan_scope_extension_unchanged');
});

test('Plan revisions preserve independent Todo and completed Todo does not revoke approved scope', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-revision-progress';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ contextWindowTokens: 100_000, tools: [{
    toolBindingRef: 'tool-binding:write:g1', name: 'fs.write', description: 'Write an approved file.',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
    possibleEffects: ['workspaceMutation'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  const initial = {
    title: 'Implement and verify', summary: 'Complete the approved work.',
    steps: [
      { stepId: 'implement', title: 'Implement', details: 'Write the implementation.' },
      { stepId: 'verify', title: 'Verify', details: 'Check the result.' },
    ],
    mutationManifest: [{ workspace: 'primary', operation: 'fs.write', target: 'README.md' }],
  };
  const cleanup = { stepId: 'cleanup', title: 'Clean up', details: 'Ignore generated files.' };
  const revised = {
    ...initial, title: 'Implement, verify and clean up',
    steps: [initial.steps[0], { ...initial.steps[1], details: 'Check the result and generated files.' }, cleanup],
    mutationManifest: [...initial.mutationManifest, { workspace: 'primary', operation: 'fs.write', target: '.gitignore' }],
  };
  const requests = [];
  const executions = [];
  let originalTodo;
  const kernel = emptyKernel({ async execute(request) {
    executions.push(structuredClone(request));
    const authority = request.planAuthorities[0];
    assert.equal(authority.revision, Math.min(executions.length, 2));
    assert.deepEqual(authority.coveredOperations.map((operation) => operation.target), executions.length === 1 ? ['README.md'] : ['README.md', '.gitignore']);
    return completedExecutionReply(request, { written: true });
  } });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const turn = requests.length;
    assert.ok(turn <= 10);
    if (turn > 1) {
      const previous = requests.at(-2);
      assert.deepEqual(request.tools, previous.tools, 'Plan phases preserve tool definitions and ordering');
      assert.deepEqual(request.messages.slice(0, previous.messages.length), previous.messages, 'Plan phases append facts without rewriting the cached prefix');
    }
    assert.equal(request.responseConstraint, 'normal');
    const payloads = request.messages.map(jsonMessagePayload);
    const todo = (await actor.snapshot()).todoList;
    const record = payloads.find((payload) => payload?.recordId);
    const planTool = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest);
    const progressTool = request.tools.find((tool) => tool.name === 'todo_update');
    const writeTool = request.tools.find((tool) => tool.inputSchema.properties?.content);
    let name, input;
    if (turn === 1) { name = planTool.name; input = initial; }
    else if (turn === 2) {
      originalTodo = structuredClone(todo);
      name = writeTool.name; input = { workspace: 'primary', path: 'README.md', content: 'Implemented.' };
    } else if (turn === 3) {
      name = progressTool.name; input = { items: todo.items.map((item, index) => ({ text: item.text, status: index === 0 ? 'completed' : 'inProgress' })) };
    } else if (turn === 4) {
      name = planTool.name; input = { ...revised, steps: [cleanup] };
    } else if (turn === 5) {
      const error = payloads.findLast((payload) => payload?.accepted === false).error;
      assert.equal(error.code, 'plan_revision_steps_missing');
      assert.match(error.message, /implement.*verify/);
      name = planTool.name; input = revised;
    } else if (turn === 6) {
      assert.equal(todo.runId, originalTodo.runId);
      assert.equal(todo.revision, 2);
      assert.deepEqual(todo.items.map(item => item.text), originalTodo.items.map(item => item.text));
      assert.deepEqual(todo.items.map(item => item.status), ['completed', 'inProgress']);
      name = writeTool.name; input = { workspace: 'primary', path: '.gitignore', content: 'core\n' };
    } else if (turn === 7) {
      name = progressTool.name; input = { items: [
        { text: todo.items[0].text, status: 'completed' }, { text: 'Clean up', status: 'invented' },
      ] };
    } else if (turn === 8) {
      const error = payloads.findLast(payload => payload?.accepted === false).error;
      assert.equal(error.code, 'todo_update_invalid');
      assert.equal(todo.items[1].status, 'inProgress', 'invalid progress applies no partial update');
      name = progressTool.name; input = { items: [...todo.items.map(item => ({ text: item.text, status: 'completed' })), { text: 'Clean up', status: 'completed' }] };
    } else if (turn === 9) {
      assert.ok(todo.items.every(item => item.status === 'completed'));
      name = writeTool.name; input = { workspace: 'primary', path: '.gitignore', content: 'core\nbuild\n' };
    } else {
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:revision-finished', content: 'The revised work and cleanup are complete.' });
      yield providerEvent(request.requestId, 'completed', {});
      return;
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: `provider-call:revision-${turn}`, name, input });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'revision');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:revision-start', 'Implement and verify.'));
  let waiting = await waitForProjection(actor, (value) => value.pendingPlan?.revision === 1);
  const firstId = waiting.pendingPlan.planId;
  for (const revision of [1, 2]) {
    if (revision === 2) {
      waiting = await waitForProjection(actor, (value) => value.pendingPlan?.revision === 2);
      assert.equal(waiting.pendingPlan.planId, firstId);
      assert.equal(waiting.todoList.items.length, 2, 'the proposed revision cannot replace Todo before confirmation');
      assert.deepEqual(waiting.todoList.items.map((item) => ({ text: item.text, status: item.status })),
        originalTodo.items.map((item, index) => ({ text: item.text, status: index === 0 ? 'completed' : 'inProgress' })),
        'proposal and rejected calls preserve phase identities, labels and observed progress until the user decides');
      assert.equal(executions.length, 1, 'new scope must wait for user confirmation');
    }
    await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond', commandId: `command:revision-confirm-${revision}`, sessionId,
      runId: waiting.run.runId, planId: firstId, revision, response: { kind: 'confirm' } });
  }
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual(completed.plans.map((plan) => plan.status), ['superseded', 'confirmed']);
  assert.ok(completed.todoList.items.every((item) => item.status === 'completed'));
  assert.equal(requests.length, 10);
  assert.equal(executions.length, 3);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'todo.updated').length, 3);
  assert.equal(completed.activePlanRef, null);
  assert.deepEqual(events.filter((event) => event.type === 'session.control.rejected').map((event) => event.payload.error.code),
    ['plan_revision_steps_missing', 'todo_update_invalid']);
  const final = events.find((event) => event.type === 'message.committed' && event.payload.role === 'assistant');
  assertEventOrder(events.findLast(event => event.type === 'todo.updated'), final, singleEvent(events, 'run.finishing'), singleEvent(events, 'run.runtime.released'), singleEvent(events, 'run.settled'));
  assert.equal(preparation.released.length, 1);
});

test('runtime instructions use configured aliases and plugin input while control schemas preserve permission boundaries', () => {
  const stableCore = [{ id: 'deepcode.coding-agent', text: 'Stable core instruction.' }];
  const baseConfig = {
    extensionGenerationRef: 'extension-generation:g1',
    selectedPlugins: [{
      uri: 'plugin://fixture@skill',
      displayName: 'Fixture',
      capabilitySummary: 'Read the explicitly selected fixture instructions.',
    }],
  };
  const planAsk = runtimeInstructions(stableCore, {
    ...baseConfig,
    permissions: { 'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.engineeringDecisions': 'ask' },
  }, {
    interactionRequest: 'ask_user_wire',
    planPublish: 'publish_plan_wire',
  });
  const allowDelegate = runtimeInstructions(stableCore, {
    ...baseConfig,
    permissions: { 'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate' },
  });

  const planInstruction = planAsk.find((instruction) => (
    instruction.id === 'deepcode.workspace-autonomy'
  ))?.text ?? '';
  assert.ok(planInstruction.includes('publish_plan_wire'));
  assert.ok(planInstruction.includes('ask_user_wire'));
  const allowInstruction = allowDelegate.find((instruction) => (
    instruction.id === 'deepcode.workspace-autonomy'
  ))?.text ?? '';
  assert.ok(allowInstruction.includes('interaction_request'));
  assert.equal(allowInstruction.includes('plan_publish'), false);
  const pluginInstruction = planAsk.find((instruction) => (
    instruction.id === 'plugin.fixture.skill'
  ))?.text ?? '';
  assert.ok(pluginInstruction.includes(baseConfig.selectedPlugins[0].displayName));
  assert.ok(pluginInstruction.includes(baseConfig.selectedPlugins[0].capabilitySummary));
  for (const instructions of [planAsk, allowDelegate]) {
    assert.deepEqual(instructions.find(instruction => instruction.id === stableCore[0].id), stableCore[0]);
  }
  const controls = sessionControlToolDefinitions();
  const publish = controls.find((tool) => tool.name === 'plan.publish');
  const progress = controls.find((tool) => tool.name === 'todo.update');
  assert.ok(controls.some((tool) => tool.name === 'interaction.request'));
  assert.deepEqual(progress.inputSchema.required, ['items']);
  const bashScope = publish.inputSchema.properties.mutationManifest.items.oneOf.find((branch) => branch.properties.operation.enum?.includes('bash'));
  assert.equal(bashScope.required.includes('command'), false);
  assert.ok(bashScope.required.includes('writablePaths'));
  assert.equal(bashScope.properties.workspaceMode, undefined);
  assert.equal(bashScope.properties.executionScope, undefined);
});

test('plan rejection names the invalid manifest field and preserves the Provider prefix for correction', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-field-diagnostic';
  await createSession(journal, sessionId, [workspaceBinding]);
  const input = {
    title: 'Create the project', summary: 'Write sources and build script.',
    steps: [{ stepId: 'write', title: 'Write files', details: 'Create the source files and build script.' }],
    mutationManifest: ['include/pool.hpp', 'src/main.cpp', 'build.sh', 'run.sh'].map((target) => ({
      workspace: 'primary', operation: 'fs.write', target,
    })),
  };
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    assert.ok(requests.length <= 2);
    const plan = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest);
    const candidate = structuredClone(input);
    if (requests.length === 1) {
      candidate.mutationManifest[2].executable = true;
      candidate.mutationManifest[3].executable = true;
    }
    else {
      const rejection = request.messages.map(jsonMessagePayload).find((value) => value?.accepted === false);
      assert.equal(rejection.executed, false);
      assert.equal(rejection.error.code, 'session_control_shape_invalid');
      for (const field of ['mutationManifest[2]', 'mutationManifest[3]', 'executable', 'workspace', 'operation', 'target']) {
        assert.ok(rejection.error.message.includes(field), `the diagnostic must identify ${field}`);
      }
      assert.deepEqual(request.tools, requests[0].tools, 'correction must not change the cached tool definitions');
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: `call:plan-${requests.length}`, name: plan.name, input: candidate });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'plan-field-diagnostic');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:plan-field', 'Prepare the project.'));
  const waiting = await waitForProjection(actor, (value) => value.run?.status === 'waiting' && value.pendingPlan !== null);
  assert.equal(waiting.pendingPlan.mutationManifest.length, 4);
  assert.equal(waiting.activePlanRef, null, 'valid publication still requires user confirmation');
  const events = await readEvents(journal, sessionId);
  const rejected = singleEvent(events, 'session.control.rejected');
  assert.equal(rejected.payload.input.mutationManifest[2].executable, true, 'keep the original invalid input in the journal');
  assert.equal(events.filter((event) => event.type === 'plan.published').length, 1);
  assert.equal(events.some((event) => event.type === 'tool.requested' || event.type === 'plan.confirmed'), false);
});

test('an explicit Provider failure remains failed with its original error', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:provider-failure';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const provider = {
    async *stream(request) {
      yield providerEvent(request.requestId, 'failed', {
        code: 'provider_http_failed',
        message: 'Provider returned HTTP 400: tool_choice is not supported in thinking mode.',
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'provider-failure',
  );

  await actor.submit(messageCommand(sessionId, 'command:provider-failure', 'Run the fixture.'));
  const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  await waitUntil(() => preparation.released.length === 1, 'failed Provider runtime release');
  assert.deepEqual(failed.terminalError, {
    code: 'provider_http_failed',
    message: 'Provider returned HTTP 400: tool_choice is not supported in thinking mode.',
  });

  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(settlement.payload.outcome, 'failed');
  assert.deepEqual(settlement.payload.error, failed.terminalError);
  const providerSettlement = singleEvent(events, 'provider.turn.settled');
  assert.equal(providerSettlement.payload.outcome, 'failed');
  assert.deepEqual(providerSettlement.payload.error, failed.terminalError);
  assertEventOrder(composition, providerSettlement, settlement);

  await actor.dispose();
});

test('Provider cache fields are absent together or exactly partition one call input', async () => {
  const invalidCases = [
    { label: 'missing-miss', cacheReadInputTokens: 40 },
    { label: 'undercount', cacheReadInputTokens: 40, cacheMissInputTokens: 50 },
    { label: 'overcount', cacheReadInputTokens: 60, cacheMissInputTokens: 50 },
  ];
  for (const { label, ...cacheFields } of invalidCases) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:invalid-cache-${label}`;
    await createSession(journal, sessionId);
    const preparation = fakeRunPreparation({ contextWindowTokens: 4_096 });
    const provider = {
      async *stream(request) {
        yield providerEvent(request.requestId, 'completed', {
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            contextWindowTokens: 4_096,
            ...cacheFields,
          },
        });
      },
    };
    const actor = actorWith(
      journal,
      sessionId,
      provider,
      emptyKernel(),
      preparation.port,
      `invalid-cache-${label}`,
    );

    await actor.submit(messageCommand(
      sessionId,
      `command:invalid-cache-${label}`,
      'Validate the cache usage contract.',
    ));
    const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
    await waitUntil(() => preparation.released.length === 1, 'invalid cache runtime release');
    assert.equal(failed.terminalError?.code, 'provider_usage_invalid');
    const events = await readEvents(journal, sessionId);
    assert.equal(singleEvent(events, 'provider.turn.settled').payload.outcome, 'failed');
    assert.equal(events.some((event) => event.type === 'context.updated'), false);
    await actor.dispose();
  }
});

test('current Todo state precedes later inserted user input without splitting its tool result', () => {
  const sessionId = 'session:todo-user-boundary';
  const runId = 'run:todo-user-boundary';
  const events = [
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:1',
      sessionId,
      sequence: 1,
      occurredAt: '2026-09-02T00:00:00.000Z',
      type: 'message.committed',
      runId,
      payload: {
        messageId: 'message:initial',
        role: 'user',
        content: 'Initial request.',
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:2',
      sessionId,
      sequence: 2,
      occurredAt: '2026-09-02T00:00:01.000Z',
      type: 'todo.updated',
      runId,
      payload: {
        revision: 1,
        items: [{
          text: 'Execute the fixture step.',
          status: 'inProgress',
        }],
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:3',
      sessionId,
      sequence: 3,
      occurredAt: '2026-09-02T00:00:02.000Z',
      type: 'interaction.requested',
      runId,
      callId: 'call:interaction',
      payload: {
        interactionId: 'interaction:one',
        providerCallId: 'provider-call:interaction',
        kind: 'question',
        prompt: 'Choose one option.',
        allowFreeform: true,
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:4',
      sessionId,
      sequence: 4,
      occurredAt: '2026-09-02T00:00:03.000Z',
      type: 'provider.turn.settled',
      runId,
      payload: {
        providerRequestId: 'provider-request:interaction',
        purpose: 'agent',
        providerRuntimeRef: 'provider-runtime:test',
        outcome: 'completed',
        orderedCallIds: ['call:interaction'],
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:5',
      sessionId,
      sequence: 5,
      occurredAt: '2026-09-02T00:00:04.000Z',
      type: 'interaction.resolved',
      runId,
      payload: {
        interactionId: 'interaction:one',
        commandId: 'command:interaction',
        response: 'Option A',
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v5',
      eventId: 'event:6',
      sessionId,
      sequence: 6,
      occurredAt: '2026-09-02T00:00:05.000Z',
      type: 'message.committed',
      runId,
      payload: {
        messageId: 'message:interaction-response',
        role: 'user',
        content: 'Option A',
      },
    },
  ];

  const contributions = messagesFromJournal(events, runId, []);
  const resultIndex = contributions.findIndex((item) => (
    item.contributionId === 'interaction-result:interaction:one'
  ));
  const todoIndex = contributions.findIndex((item) => (
    item.contributionId === 'todo-state:event:2'
  ));
  const userIndex = contributions.findIndex((item) => (
    item.contributionId === 'message:message:interaction-response'
  ));
  assert.ok(resultIndex >= 0);
  assert.ok(todoIndex >= 0 && todoIndex < resultIndex, 'Todo stays at its original event boundary');
  assert.ok(userIndex > resultIndex, 'the later tagged user input must follow its tool result');
  assert.equal(contributions.at(-1)?.message.role, 'user');
});

test('an interaction response is inserted after its tool result and a stale second response is durable', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:interaction-resume';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const interactionDefinition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.prompt !== undefined
          && candidate.inputSchema?.properties?.allowFreeform !== undefined
        ));
        assert.ok(interactionDefinition, 'interaction control must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:interaction-resume',
          name: interactionDefinition.name,
          input: {
            kind: 'question',
            prompt: 'Which fixture option?',
            allowFreeform: true,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      assert.equal(providerRequests.length, 2);
      const callIndex = request.messages.findIndex((message) => (
        message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0
      ));
      const resultIndex = request.messages.findIndex((message) => message.role === 'tool');
      const responseIndex = request.messages.findLastIndex((message) => (
        message.role === 'user' && message.content === 'Use option A.'
      ));
      assert.ok(callIndex >= 0, 'the prior interaction call must remain in context');
      assert.ok(resultIndex > callIndex, 'the interaction result must follow its call');
      assert.ok(responseIndex > resultIndex, 'the tagged user response must follow the tool result');
      assert.equal(request.messages.at(-1)?.role, 'user');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:interaction-resume',
        content: 'Option A accepted.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'interaction-resume',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:interaction-start',
    'Ask for one fixture decision.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingInteraction !== null
  ));
  const interaction = waiting.pendingInteraction;
  const accepted = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'interaction.respond',
    commandId: 'command:interaction-accepted',
    sessionId,
    runId: waiting.run.runId,
    interactionId: interaction.interactionId,
    response: 'Use option A.',
  });
  assert.equal(accepted.status, 'accepted');
  const stale = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'interaction.respond',
    commandId: 'command:interaction-stale',
    sessionId,
    runId: waiting.run.runId,
    interactionId: interaction.interactionId,
    response: 'Use option B.',
  });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.error?.code, 'interaction_not_pending');
  assert.equal(
    (await journal.readCommand(sessionId, 'command:interaction-stale'))?.reply.status,
    'rejected',
  );

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.pendingInteraction, null);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'interaction.resolved').length, 1);
  const answer = completed.messages.find((message) => message.content === 'Use option A.');
  assert.deepEqual(answer.replyToInteraction, { interactionId: interaction.interactionId, prompt: 'Which fixture option?' });
  assert.deepEqual(loopSnapshot(sessionId, events).state.messages.find((message) => message.messageId === answer.messageId).replyToInteraction,
    answer.replyToInteraction, 'journal replay preserves the exact question without GUI caching or inference');
  assert.equal(events.filter((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  )).length, 2);
  await actor.dispose();
});

test('phase plans and progress accept lists beyond the former item counts while retaining semantic validation', () => {
  const input = { title: 'Complete the requested phases', summary: 'One phase can affect many files.',
    steps: Array.from({ length: 13 }, (_, index) => ({ stepId: `phase-${index}`, title: `Phase ${index}`, details: 'Deliver the phase outcome.',
      verification: Array.from({ length: 9 }, (_, check) => `Verify outcome ${check}`) })),
    mutationManifest: Array.from({ length: 129 }, (_, index) => ({ workspaceId: 'workspace:primary', operation: 'fs.write', target: `src/file-${index}.ts` })),
  };
  input.mutationManifest.push({ workspaceId: 'workspace:primary', operation: 'bash',
    writablePaths: Array.from({ length: 129 }, (_, index) => ({ path: `build/output-${index}`, kind: 'directory' })) });
  assert.deepEqual(decodeSessionControlCall('call:large-plan', 'plan.publish', input).draft, input);
  const items = input.steps.map(step => ({ text: step.title, status: 'inProgress' }));
  assert.deepEqual(decodeSessionControlCall('call:large-progress', 'todo.update', { items }).items, items);
  const schema = sessionControlToolDefinitions().find((tool) => tool.name === 'plan.publish').inputSchema;
  assert.equal(schema.properties.steps.maxItems, undefined);
  assert.equal(schema.properties.mutationManifest.maxItems, undefined);
  assert.throws(() => decodeSessionControlCall('call:duplicate', 'plan.publish', { ...input, steps: [input.steps[0], input.steps[0]] }),
    (error) => error.code === 'session_control_plan_step_duplicate');
  assert.throws(() => decodeSessionControlCall('call:invalid-progress', 'todo.update', { items: [{ text: 'Task', status: 'invented' }] }),
    (error) => error.code === 'todo_update_invalid');
});

test('Plan title schema advertises the same single-line boundary enforced during publication', () => {
  const schema = sessionControlToolDefinitions().find((tool) => tool.name === 'plan.publish').inputSchema;
  const pattern = new RegExp(schema.properties.title.pattern, 'u');
  const input = { title: '保留 `Dockerfile`、`Makefile`', summary: '说明',
    steps: [{ stepId: 'inspect', title: '检查工作区', details: '读取目录' }], mutationManifest: [] };
  assert.ok(pattern.test(input.title));
  assert.equal(decodeSessionControlCall('call:title', 'plan.publish', input).draft.title, input.title);
  for (const title of ['计划\n\n', '计划\n第二行', ' 计划', '计划 ', '\u0000']) {
    assert.equal(pattern.test(title), false, 'the advertised schema must reject the actual failing input');
    assert.throws(() => decodeSessionControlCall('call:title', 'plan.publish', { ...input, title }),
      (error) => error.code === 'session_control_display_text_invalid' && /单行/.test(error.message));
  }
  assert.equal(schema.properties.steps.items.properties.title.pattern, schema.properties.title.pattern);
});

async function verifyExplicitFocusCompaction() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:focus-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation({
    contextWindowTokens: 2_000,
    maxOutputTokens: 120,
    apiSurface: 'responses',
    hostedWebSearch: 'web_search',
    webSearch: { owner: 'providerHosted', providerToolType: 'web_search' },
  });
  const requests = [];
  let agentTurn = 0;
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.purpose === 'contextCompaction') {
        assert.equal(request.responseConstraint, 'answerOnly');
        assert.equal(request.maxOutputTokens, 120);
        assert.deepEqual(request.tools, requests[0].tools);
        assert.deepEqual(request.hostedTools, requests[0].hostedTools);
        assert.equal(request.hostedTools.length, 1, 'focus retains the supplied hosted definition under answerOnly');
        assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages,
          'summary must preserve the preceding conversation prefix');
        assert.equal(request.messages.at(-1).role, 'user');
        assert.match(request.messages.at(-1).content, /^Summarize the supplied conversation into a factual handoff/);
        assert.match(request.messages.at(-1).content, /future-work focus, but do not answer it:\nPreserve the selected facts\.$/);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:focus-summary',
          content: 'Durable focus summary.',
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      agentTurn += 1;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:focus-agent:${agentTurn}`,
        content: `Agent fixture result ${agentTurn}.`,
      });
      yield providerEvent(request.requestId, 'completed', agentTurn === 1
        ? {
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              contextWindowTokens: 2_000,
            },
          }
        : {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'focus-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:focus-seed', 'Seed context.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'focus seed release');
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'context.focus',
    commandId: 'command:focus',
    sessionId,
    task: 'Preserve the selected facts.',
  });
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed' && preparation.prepared.length === 2
  ));
  await waitUntil(() => preparation.released.length === 2, 'focus run release');

  assert.deepEqual(requests.map((request) => request.purpose), [
    'agent',
    'contextCompaction',
    'agent',
  ]);
  const events = await readEvents(journal, sessionId);
  const focusRequest = events.find((event) => (
    event.type === 'context.compaction.requested' && event.payload.trigger === 'userFocus'
  ));
  assert.ok(focusRequest, 'explicit /focus must create a compaction request');
  assert.equal(focusRequest.payload.focus, 'Preserve the selected facts.');
  assert.equal(focusRequest.payload.commandId, 'command:focus');
  const focusInput = events.find((event) => (
    event.type === 'input.accepted' && event.payload.commandId === 'command:focus'
  ));
  assert.equal(focusInput?.payload.text, 'Preserve the selected facts.');
  assertSuccessfulCompactionOrder(events, focusRequest, 'Durable focus summary.');

  await actor.dispose();
}

async function verifyPressureCompaction() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:pressure-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation({
    contextWindowTokens: 2_000,
    maxOutputTokens: 200,
  });
  const requests = [];
  let agentTurn = 0;
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      assert.equal(request.providerRuntimeRef, 'provider-runtime:g1');
      assert.equal(request.maxOutputTokens, 200);
      if (request.purpose === 'contextCompaction') {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:pressure-summary',
          content: 'Durable pressure summary.',
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      agentTurn += 1;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:pressure-agent:${agentTurn}`,
        content: `Pressure fixture result ${agentTurn}.`,
      });
      yield providerEvent(request.requestId, 'completed', agentTurn === 1
        ? {
            usage: {
              inputTokens: 1_850,
              outputTokens: 20,
              contextWindowTokens: 2_000,
            },
          }
        : {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'pressure-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:pressure-seed', 'Seed pressure facts.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'pressure seed release');
  await actor.submit(messageCommand(sessionId, 'command:pressure-next', 'Continue with another turn.'));
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed' && preparation.prepared.length === 2
  ));
  await waitUntil(() => preparation.released.length === 2, 'pressure run release');

  assert.deepEqual(requests.map((request) => request.purpose), [
    'agent',
    'contextCompaction',
    'agent',
  ]);
  const runtime = preparation.snapshots[1].provider;
  assert.ok(1_850 + runtime.maxOutputTokens >= runtime.contextWindowTokens);
  const events = await readEvents(journal, sessionId);
  const pressureRequest = events.find((event) => (
    event.type === 'context.compaction.requested' && event.payload.trigger === 'pressure'
  ));
  assert.ok(pressureRequest, 'same-runtime usage plus full output reserve must request compaction');
  assertSuccessfulCompactionOrder(events, pressureRequest, 'Durable pressure summary.');

  await actor.dispose();
}

async function verifyWaitingCancelRelease() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cancel-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const provider = {
    async *stream(request) {
      const interactionDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.prompt !== undefined
        && candidate.inputSchema?.properties?.allowFreeform !== undefined
      ));
      assert.ok(interactionDefinition, 'interaction control must be available');
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider-call:interaction',
        name: interactionDefinition.name,
        input: {
          kind: 'question',
          prompt: 'Fixture decision?',
          allowFreeform: true,
        },
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'cancel-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:cancel-start', 'Enter a waiting boundary.'));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingInteraction !== null
  ));
  assert.equal(preparation.released.length, 0);
  assert.equal(await actor.hasActiveWork(), true, 'waiting retains the Host that owns the run bindings');
  const cancelReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'run.cancel',
    commandId: 'command:cancel',
    sessionId,
    runId: waiting.run.runId,
  });
  assert.equal(cancelReply.status, 'accepted');
  const cancelled = await waitForProjection(actor, (value) => value.run?.status === 'cancelled');
  await waitUntil(() => preparation.released.length === 1, 'cancelled run release');
  assert.equal(cancelled.pendingInteraction, null);
  await waitUntil(async () => !await actor.hasActiveWork(), 'settled Session releases Host activity');

  const events = await readEvents(journal, sessionId);
  const completion = singleEvent(events, 'provider.turn.settled');
  const interaction = singleEvent(events, 'interaction.requested');
  const settlement = singleEvent(events, 'run.settled');
  assert.deepEqual(completion.payload.orderedCallIds, [interaction.callId]);
  assert.equal(settlement.payload.outcome, 'cancelled');
  assertEventOrder(interaction, completion, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: waiting.run.runId,
    kernelCatalogSnapshotRef: preparation.snapshots[0].kernelCatalogSnapshotRef,
  }]);

  await actor.dispose();
}

async function verifyComposedDisposeRelease() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:dispose-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  let streamStartedResolve;
  const streamStarted = new Promise((resolve) => { streamStartedResolve = resolve; });
  let compositionDisposed = false;
  const provider = {
    async *stream(request, signal) {
      streamStartedResolve(request.requestId);
      await waitForAbort(signal);
      throw new Error('fixture_provider_interrupted');
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'dispose-chain',
    () => { compositionDisposed = true; },
  );

  await actor.submit(messageCommand(sessionId, 'command:dispose', 'Begin an active Provider turn.'));
  const providerRequestId = await streamStarted;
  await actor.dispose();

  assert.equal(compositionDisposed, true);
  assert.equal(preparation.released.length, 1);
  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const providerSettlement = singleEvent(events, 'provider.turn.settled');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(composition.payload.providerRequestId, providerRequestId);
  assert.equal(providerSettlement.payload.outcome, 'indeterminate');
  assert.equal(providerSettlement.payload.error.code, 'provider_turn_outcome_unknown');
  assert.match(providerSettlement.payload.error.message, /fixture_provider_interrupted/u);
  assert.equal(settlement.payload.outcome, 'indeterminate');
  assert.equal(settlement.payload.error.code, 'provider_turn_outcome_unknown');
  assert.match(settlement.payload.error.message, /fixture_provider_interrupted/u);
  assertEventOrder(composition, providerSettlement, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: settlement.runId,
    kernelCatalogSnapshotRef: preparation.snapshots[0].kernelCatalogSnapshotRef,
  }]);
}

async function verifyExecutingToolDisposeCleanup() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:executing-tool-dispose';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparedTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read one fixture file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const provider = {
    async *stream(request) {
      const readDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
      ));
      assert.ok(readDefinition, 'read tool must be available');
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider-call:dispose-read',
        name: readDefinition.name,
        input: { workspace: 'primary', path: 'README.md' },
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  let request;
  let resolveExecution;
  let executionStartedResolve;
  const executionStarted = new Promise((resolve) => { executionStartedResolve = resolve; });
  let physicalCleanupComplete = false;
  const kernel = emptyKernel({
    async execute(candidate) {
      request = structuredClone(candidate);
      executionStartedResolve();
      return await new Promise((resolve) => { resolveExecution = resolve; });
    },
    async cancel(callId, attemptId) {
      assert.equal(callId, request.callId);
      assert.equal(attemptId, request.attemptId);
      physicalCleanupComplete = true;
      const record = indeterminateExecutionRecord(request);
      resolveExecution({
        schemaVersion: 'deepcode.kernel-reply',
        type: 'tool.execution',
        requestId: request.requestId,
        callId,
        status: 'indeterminate',
        record,
      });
      return {
        schemaVersion: 'deepcode.kernel-reply',
        type: 'tool.cancelled',
        requestId: 'kernel-cancel:dispose-read',
        callId,
        attemptId,
        status: 'indeterminate',
        record,
      };
    },
  });
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'executing-tool-dispose',
    () => assert.equal(physicalCleanupComplete, true),
  );

  await actor.submit(messageCommand(sessionId, 'command:dispose-read', 'Read the fixture.'));
  await executionStarted;
  await actor.dispose();

  assert.equal(physicalCleanupComplete, true);
  assert.equal(preparation.released.length, 0);
  const events = await readEvents(journal, sessionId);
  const completed = singleEvent(events, 'tool.completed');
  assert.equal(completed.payload.record.outcome, 'indeterminate');
  assert.equal(events.some((event) => event.type === 'run.settled'), false);
}

test('missing completion stays indeterminate; a completed unknown alias returns an unexecuted rejection', async () => {
  for (const completed of [false, true]) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:native-terminal-${completed}`;
    await createSession(journal, sessionId);
    const preparation = fakeRunPreparation({ apiSurface: 'responses' });
    let turns = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      turns += 1;
      assert.ok(turns <= 2);
      if (turns === 2) {
        const rejected = request.messages.map(jsonMessagePayload).find((value) => value?.status === 'inputRejected');
        assert.equal(rejected.executed, false);
        assert.equal(rejected.error.code, 'provider_tool_alias_unknown');
        const raw = request.messages.flatMap((message) => message.providerOutputBlocks ?? []).find((block) => block.kind === 'toolCallRejected');
        assert.equal(raw.item.name, 'undeclared_tool');
        assert.equal(raw.item.arguments, '{');
        assert.ok(request.tools.every((tool) => tool.name !== 'undeclared_tool'));
        yield providerEvent(request.requestId, 'assistant.message', { messageId: 'native:corrected-answer', content: 'This tool is unavailable.' });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
        item: { type: 'function_call', call_id: 'native-terminal', name: completed ? 'undeclared_tool' : request.tools[0].name, arguments: '{', status: 'completed' } });
      if (completed) yield providerEvent(request.requestId, 'completed', {});
      else throw new Error('fixture_connection_closed');
    } }, emptyKernel(), preparation.port, `terminal-${completed}`);
    await actor.submit(messageCommand(sessionId, 'command:terminal', 'Inspect.'));
    const result = await waitForProjection(actor, (value) => value.run?.status === (completed ? 'completed' : 'indeterminate'));
    if (!completed) {
      assert.equal(result.terminalError.code, 'provider_turn_outcome_unknown');
      assert.match(result.terminalError.message, /fixture_connection_closed/);
    }
    assert.equal(turns, completed ? 2 : 1);
    const events = await readEvents(journal, sessionId);
    assert.equal(events.some((event) => event.type === 'tool.requested' || event.type === 'tool.input-rejected'), false);
    const settlement = events.find((event) => event.type === 'provider.turn.settled');
    assert.equal(settlement.payload.outcome, completed ? 'completed' : 'indeterminate');
    if (completed) {
      assert.deepEqual(settlement.payload.orderedCallIds, []);
      assert.equal(settlement.payload.orderedOutputBlocks[0].kind, 'toolCallRejected');
      assert.equal(result.activities.find((activity) => activity.status === 'rejected').inputRejection.code, 'provider_tool_alias_unknown');
    } else {
      assert.equal('orderedOutputBlocks' in settlement.payload, false);
    }
    await actor.dispose();
  }
});

test('Kernel infrastructure errors remain run failures rather than correctable input results', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:kernel-infrastructure';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'binding:read', name: 'fs.read', description: 'Read source.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    turns += 1;
    yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:read', name: request.tools.find((tool) => tool.inputSchema.properties?.path).name, input: { workspace: 'primary', path: 'README.md' } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute() { throw new Error('tool_record_store_read_failed: fixture disk error'); } }), preparation.port, 'infrastructure');
  await actor.submit(messageCommand(sessionId, 'command:infra', 'Read source.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  assert.equal(turns, 1);
  assert.match(projection.terminalError.message, /fixture disk error/);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'tool.input-rejected'), false);
  await actor.dispose();
});

test('the real Session bridge persists model commands and passes effort through message and focus preparation', { timeout: 15_000 }, async (t) => {
  const journal = new InMemoryCommandJournal();
  const prepared = [];
  let releaseHeldPreparation;
  const heldPreparation = new Promise((resolve) => { releaseHeldPreparation = resolve; });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      const parts = url.pathname.split('/').map(decodeURIComponent);
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = body ? JSON.parse(body) : null;
      let data;
      if (url.pathname === '/api/local-agent/journal/sessions') data = await journal.createSession(input);
      else if (parts[6] === 'events') {
        data = [];
        for await (const event of journal.read(parts[5], Number(url.searchParams.get('after')))) data.push(event);
      } else if (parts[6] === 'commands') data = await journal.readCommand(parts[5], parts[7]);
      else if (url.pathname === '/api/local-agent/journal/commands') data = await journal.commitCommand(input.command, input.events, input.reply);
      else if (url.pathname === '/api/local-agent/runtime/prepare-run') {
        prepared.push(input);
        if (input.sessionId === 'session:bridge-held') await heldPreparation;
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'fixture_prepare_boundary', message: 'Preparation reached; no Provider is started.' }));
        return;
      } else throw new Error(`unexpected_http_path:${url.pathname}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sessionServiceBridge.js', import.meta.url))], {
    env: { ...process.env, DEEPCODE_LOCAL_AGENT_API_BASE: `http://127.0.0.1:${server.address().port}`, DEEPCODE_LOCAL_AGENT_TOKEN: 'fixture-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const frames = lines[Symbol.asyncIterator]();
  t.after(async () => {
    releaseHeldPreparation();
    if (child.exitCode === null) child.kill();
    lines.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let next = 0;
  const send = async (operation, data) => {
    const requestId = `bridge-request:${++next}`;
    child.stdin.write(`${JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId, operation, data })}\n`);
    const frame = await frames.next();
    assert.equal(frame.done, false, stderr);
    const reply = JSON.parse(frame.value);
    assert.equal(reply.requestId, requestId);
    return reply;
  };
  // A request at the frame limit and another valid request may share a pipe write.
  // The limit belongs to each JSON line, not to an OS read or to the trailing LF.
  const fullRequest = { protocolVersion: 'deepcode.local-agent', requestId: 'bridge-limit', operation: 'health', data: { padding: '' } };
  fullRequest.data.padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(fullRequest)));
  const encodedFull = JSON.stringify(fullRequest);
  assert.equal(Buffer.byteLength(encodedFull), 1024 * 1024);
  child.stdin.write(`${encodedFull}\n${JSON.stringify({ ...fullRequest, requestId: 'bridge-next', data: { padding: '下一个🙂' } })}\n`);
  const healthReplies = [JSON.parse((await frames.next()).value), JSON.parse((await frames.next()).value)];
  assert.deepEqual(new Set(healthReplies.map((reply) => reply.requestId)), new Set(['bridge-limit', 'bridge-next']));
  assert.ok(healthReplies.every((reply) => reply.ok && reply.data.state === 'ready'));
  const sessionId = 'session:bridge-settings';
  assert.equal((await send('createSession', { sessionId, displayTitle: 'Bridge fixture', workspaceBindings: [] })).ok, true);
  const command = { schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', commandId: 'command:wire-settings', sessionId, settings: { profileId: 'profile:wire', reasoningEffortOverride: 'medium' } };
  const saved = await send('submit', { command });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const projection = (await send('snapshot', { sessionId })).data;
  assert.deepEqual(projection.modelSettings, command.settings);
  assert.equal(projection.run, null);
  assert.equal(prepared.length, 0);
  for (const type of ['message.submit', 'context.focus']) {
    const reply = await send('submit', { command: { schemaVersion: 'deepcode.command.v3', type, commandId: `command:${type}`, sessionId, [type === 'message.submit' ? 'text' : 'task']: 'Inspect source.', reasoningEffortOverride: 'low' } });
    assert.equal(reply.ok, false);
    assert.match(JSON.stringify(reply.error), /fixture_prepare_boundary/);
  }
  assert.deepEqual(prepared.map((request) => [request.profileId, request.reasoningEffortOverride]), [['profile:wire', 'low'], ['profile:wire', 'low']]);
  const heldSessionId = 'session:bridge-held';
  assert.equal((await send('createSession', { sessionId: heldSessionId, displayTitle: 'Held preparation', workspaceBindings: [] })).ok, true);
  child.stdin.write(`${JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId: 'bridge-held', operation: 'submit',
    data: { command: messageCommand(heldSessionId, 'command:bridge-held', 'Prepare this run.') } })}\n`);
  await waitUntil(() => prepared.some((request) => request.sessionId === heldSessionId), 'one Session holds its prepare request');
  // Independent Session reads and commands must finish before that preparation.
  assert.equal((await send('snapshot', { sessionId })).data.sessionId, sessionId);
  assert.equal((await send('submit', { command: { ...command, commandId: 'command:wire-concurrent',
    settings: { profileId: 'profile:wire', reasoningEffortOverride: 'high' } } })).ok, true);
  releaseHeldPreparation();
  const heldReply = JSON.parse((await frames.next()).value);
  assert.equal(heldReply.requestId, 'bridge-held');
  assert.match(JSON.stringify(heldReply.error), /fixture_prepare_boundary/);
  assert.equal((await send('shutdown', {})).ok, true);
  await once(child, 'exit');
  assert.equal(child.exitCode, 0, stderr);
});

test('reopening a run waiting for Plan confirmation restores its original effort rather than newer Session settings', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-effort';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ reasoningEffort: 'high' });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    yield providerEvent(request.requestId, 'tool.call', {
      callId: 'provider-call:effort-plan', name: request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name,
      input: { title: 'Inspect project', summary: 'Read the relevant sources.', steps: [{ stepId: 'inspect', title: 'Inspect', details: 'Read relevant files.' }], mutationManifest: [] },
    });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'plan-effort');
  await actor.submit({ ...messageCommand(sessionId, 'command:plan-effort', 'Plan the inspection.', 'profile:one'), reasoningEffortOverride: 'max' });
  const waiting = await waitForProjection(actor, (value) => value.run?.status === 'waiting');
  assert.equal(waiting.run.reasoningEffort, 'max');
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', sessionId, commandId: 'command:change-waiting', settings: { profileId: 'profile:one', reasoningEffortOverride: 'low' } });
  await actor.dispose();
  const reopened = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'plan-effort-reopened');
  await reopened.recover();
  const restored = await reopened.snapshot();
  assert.equal(restored.run.runId, waiting.run.runId);
  assert.equal(restored.run.status, 'waiting');
  assert.equal(restored.run.reasoningEffort, 'max');
  assert.equal(restored.modelSettings.reasoningEffortOverride, 'low');
  assert.equal(restored.pendingPlan.planId, waiting.pendingPlan.planId);
  assert.equal(turns, 1);
  assert.deepEqual(preparation.prepared.map((request) => request.reasoningEffortOverride), ['max', 'max']);
  await reopened.dispose();
});


test('first request reserves output budget before calling a Provider and preserves original input', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:first-budget';
  await createSession(journal, sessionId, [workspaceBinding]);
  let calls = 0;
  const provider = { async *stream() { calls += 1; throw new Error('must not call Provider'); } };
  const preparation = fakeRunPreparation({ contextWindowTokens: 100, maxOutputTokens: 30 });
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'first-budget');
  const original = 'Full original input '.repeat(500);
  await actor.submit(messageCommand(sessionId, 'command:first-budget', original));
  const projection = await waitForProjection(actor, (projection) => projection.run?.status === 'failed');
  assert.equal(calls, 0);
  assert.equal(projection.terminalError.code, 'context_input_budget_exceeded');
  assert.equal(projection.messages[0].content, original);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'context.compacted'), false);
  await actor.dispose();
});

test('new file inputs preserve the existing Provider prefix and keep historical files readable', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:input-cache';
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    yield providerEvent(request.requestId, 'assistant.message', { messageId: `message:cache-${requests.length}`, content: 'Read the referenced input.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const preparation = fakeRunPreparation({ contextWindowTokens: 64000 });
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'input-cache');
  for (let index = 0; index < 3; index += 1) {
    const command = messageCommand(sessionId, `command:cache-${index}`, index === 1 ? '' : `Original input ${index}`);
    if (index < 2) command.filesystemReferences = [{ referenceId: `reference:${index}`, workspaceId: `file-workspace:${index}`,
      logicalPath: 'user-input.txt', displayName: 'Pasted document', kind: 'file', mediaType: 'text/plain', byteLength: 100000, source: 'pastedText' }];
    await actor.submit(command);
    await waitForProjection(actor, (projection) => projection.run?.status === 'completed');
  }
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
  }
  assert.deepEqual(requests[2].workspaceBindings.map((binding) => binding.workspaceId), ['workspace:test', 'file-workspace:0', 'file-workspace:1']);
  const pastedMessage = (await actor.snapshot()).messages.find((message) => message.role === 'user' && message.content === '');
  assert.equal(pastedMessage.filesystemReferences[0].source, 'pastedText');
  assert.match(requests[1].messages.at(-1).content, /Read its full contents with fs.read using nextByte/);
  await actor.dispose();
});

for (const shell of ['bash', 'powershell']) {
test(`workspace ${shell} Plan declares paths without locking its command text`, () => {
  const definition = sessionControlToolDefinitions().find((tool) => tool.inputSchema.properties?.mutationManifest);
  const input = { title: 'Build project', summary: 'Build in the allowed directory.',
    steps: [{ stepId: 'build', title: 'Build', details: 'Compile the project.' }],
    mutationManifest: [{ workspaceId: 'workspace:test', operation: shell, command: 'make build', writablePaths: [{ path: 'build', kind: 'directory' }] }] };
  const decoded = decodeSessionControlCall('call:plan-paths', definition.name, input);
  assert.deepEqual(decoded.draft.mutationManifest, input.mutationManifest);
  const projectFile = structuredClone(input);
  projectFile.mutationManifest[0].writablePaths = [{ path: 'src/main.cpp', kind: 'file' }];
  assert.throws(() => decodeSessionControlCall('call:project-file', definition.name, projectFile), /kind=directory/);
  const absentPaths = structuredClone(input);
  delete absentPaths.mutationManifest[0].writablePaths;
  assert.throws(() => decodeSessionControlCall('call:missing-paths', definition.name, absentPaths), /writablePaths/);
  const withoutCommand = structuredClone(input);
  delete withoutCommand.mutationManifest[0].command;
  assert.deepEqual(decodeSessionControlCall('call:scope-only', definition.name, withoutCommand).draft.mutationManifest,
    withoutCommand.mutationManifest);
  for (const [field, value] of [['workspaceMode', 'write'], ['executionScope', 'host']]) {
    const authorityField = structuredClone(input);
    authorityField.mutationManifest[0][field] = value;
    assert.throws(() => decodeSessionControlCall('call:authority-field', definition.name, authorityField), new RegExp(field));
  }
  const outside = structuredClone(input);
  outside.mutationManifest[0].writablePaths[0].path = '../outside';
  assert.throws(() => decodeSessionControlCall('call:outside', definition.name, outside), (error) => error.code === 'session_control_plan_target_invalid');
});

}

test('Todo replacement is atomic, accepts blocked and empty lists, and has no evidence or Plan fields', () => {
  const items = [{ text: 'Investigate', status: 'completed' }, { text: 'Missing input', status: 'blocked' }];
  assert.deepEqual(decodeSessionControlCall('call:todo', 'todo.update', { items }).items, items);
  assert.deepEqual(decodeSessionControlCall('call:clear', 'todo.update', { items: [] }).items, []);
  assert.throws(() => decodeSessionControlCall('call:invalid', 'todo.update', {
    items: [...items, { text: 'Wrong status', status: 'invented' }],
  }), error => error.code === 'todo_update_invalid');
  assert.throws(() => decodeSessionControlCall('call:evidence', 'todo.update', { items, sourceFactRef: 'record:old' }), /sourceFactRef/);
  assert.throws(() => decodeSessionControlCall('call:status-type', 'todo.update', { items: [{ text: 'Task', status: ['blocked'] }] }), error => error.code === 'todo_update_invalid');
});

test('reasoning display bounds real text and summary independently without changing replay data', async () => {
  const { LiveReasoning, reasoningReadItem } = await import('../dist/local-agent/reasoningRead.js');
  const live = new LiveReasoning();
  live.append('request:one', 'run:one', '中文🙂'.repeat(5000), 'text');
  live.append('request:one', 'run:one', 'Native summary.', 'summary');
  const window = live.read('request:one');
  assert.equal(window.truncated, true);
  assert.deepEqual(window.parts.map((part) => part.kind), ['text', 'summary']);
  assert.ok(window.parts.reduce((total, part) => total + part.content.length, 0) <= 8192);
  const event = { sequence: 10, runId: 'run:one', payload: { outcome: 'completed', providerRequestId: 'request:one',
    reasoningContent: 'x'.repeat(20000), orderedOutputBlocks: [{ kind: 'reasoning', item: { summary: [{ type: 'summary_text', text: 'Native summary.' }] } }] } };
  const page = reasoningReadItem(event, 0);
  assert.equal(page.nextOffset, 8192);
  assert.equal(page.parts[0].kind, 'summary');
  assert.equal(reasoningReadItem(event, null).parts, undefined);
  assert.equal(event.payload.reasoningContent.length, 20000);
});

test('Kernel changes produce ordered round references while display evidence stays out of Provider context', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:change-round';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 64000, tools: [{
    toolBindingRef: 'binding:write', name: 'fs.write', description: 'Write text.', origin: 'coreBuiltin',
    availability: 'callable', possibleEffects: ['workspaceMutation'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  }] });
  const changes = [{ workspaceId: workspaceBinding.workspaceId, path: 'sample.txt', kind: 'modify',
    before: { exists: true, contentRef: '/fixture/attempt/before' }, after: { exists: true, contentRef: '/fixture/attempt/after' } }];
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    const item = requests.length === 1
      ? { type: 'function_call', call_id: 'provider-call:change', name: request.tools.find((tool) => tool.inputSchema.properties?.path).name,
          arguments: JSON.stringify({ workspace: 'primary', path: 'sample.txt', content: 'new' }), status: 'completed' }
      : { type: 'message', id: 'provider-message:change', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Saved.' }] };
    yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel({ execute: async (request) =>
    completedExecutionReply(request, { saved: true, fileChanges: changes }) }), preparation.port, 'changes');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:changes', 'Update the file.'));
  const projection = await waitForProjection(actor, (projection) => projection.run?.status === 'completed');
  const tool = projection.activities.find((activity) => activity.tool?.fileChanges?.length)?.tool;
  assert.ok(tool);
  assert.deepEqual(tool.fileChanges, changes);
  assert.deepEqual(projection.fileChangeRounds, [{ runId: projection.run.runId, recordIds: [tool.recordId] }]);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.equal(JSON.stringify(toolMessage).includes('fileChanges'), false);
  assert.equal(JSON.stringify(toolMessage).includes('/fixture/attempt/'), false);
  const event = (await readEvents(journal, sessionId)).find((event) => event.type === 'tool.completed');
  assert.deepEqual(event.payload.record.output.fileChanges, changes);
});

test('plan preview streams formed fields at the same revision and publishes only after complete validation', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:streamed-plan';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const input = { title: 'Inspect the project', summary: 'Read the relevant source.', steps: [{ stepId: 'inspect', title: 'Read source', details: 'Inspect the source.' }], mutationManifest: [] };
  const serialized = JSON.stringify(input);
  const split = serialized.indexOf(',"steps"');
  const secondSplit = serialized.indexOf(',"details"');
  const releases = [];
  const gate = () => new Promise((resolve) => releases.push(resolve));
  const requests = [];
  const provider = { async *stream(request, signal) {
    requests.push(structuredClone(request));
    const name = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name;
    for (const fragment of [serialized.slice(0, split), serialized.slice(split, secondSplit), serialized.slice(secondSplit)]) {
      yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'call:plan', name, argumentsDelta: fragment });
      await Promise.race([gate(), waitForAbort(signal)]);
      if (signal.aborted) return;
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: 'call:plan', name, input });
    yield providerEvent(request.requestId, 'completed', { usage: { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 90, cacheMissInputTokens: 10, contextWindowTokens: 4096 } });
  } };
  const wireProvider = new HttpProviderPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      try {
        for await (const event of provider.stream(request, init.signal)) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, providerAttemptId: request.providerAttemptId })}\n\n`));
        controller.close();
      } catch (error) { controller.error(error); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const actor = actorWith(journal, sessionId, wireProvider, emptyKernel(), preparation.port, 'streamed-plan');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:preview', 'Plan an inspection.'));
  const first = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.title === input.title);
  assert.equal(first.pendingPlan, null);
  assert.equal(first.plans.length, 0);
  assert.equal(first.activities.some((activity) => activity.kind === 'tool'), false);
  assert.equal(first.assistantDraft.planPreview.summary, input.summary);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'plan.published'), false);
  await waitUntil(() => releases.length === 1, 'first preview fragment'); releases.shift()();
  const second = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.steps.length === 1);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.assistantDraft.planPreview.steps, ['Read source']);
  assert.equal(second.pendingPlan, null);
  await waitUntil(() => releases.length === 1, 'second preview fragment'); releases.shift()();
  await waitUntil(() => releases.length === 1, 'complete preview fragment'); releases.shift()();
  const published = await waitForProjection(actor, (p) => p.run?.status === 'waiting' && p.pendingPlan !== null);
  assert.equal(published.assistantDraft, null);
  assert.equal(published.pendingPlan.title, input.title);
  assert.deepEqual(published.pendingPlan.steps, input.steps);
  assert.deepEqual(published.pendingPlan.mutationManifest, []);
  assert.equal(published.activePlanRef, null);
  assert.equal(published.contextUsage.cacheReadInputTokens, 90);
  assert.equal(requests.length, 1, 'preview never requests another model response');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'plan.published').length, 1);
  assert.equal(events.some((event) => event.type === 'plan.confirmed' || event.type === 'tool.requested'), false);
});

for (const outcome of ['failed', 'cancelled']) test(`an unfinished plan preview is cleared when its request is ${outcome}`, async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = `session:preview-${outcome}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { async *stream(request, signal) {
    const name = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name;
    yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'call:draft', name, argumentsDelta: '{"title":"Unfinished",' });
    await Promise.race([gate, waitForAbort(signal)]);
    if (signal.aborted) return;
    yield providerEvent(request.requestId, 'failed', { code: 'fixture_provider_failed', message: 'Provider failed during plan generation.' });
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, `preview-${outcome}`);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:begin', 'Plan this inspection.'));
  const streaming = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.title === 'Unfinished');
  if (outcome === 'cancelled') await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel', sessionId, runId: streaming.run.runId, commandId: 'command:cancel-preview' });
  else release();
  // An interrupted Provider with no terminal receipt keeps the existing unknown-outcome contract.
  const settled = await waitForProjection(actor, (p) => p.run?.status === (outcome === 'cancelled' ? 'indeterminate' : 'failed'));
  if (outcome === 'cancelled') assert.equal(settled.terminalError.code, 'provider_turn_outcome_unknown');
  else assert.equal(settled.terminalError.code, 'fixture_provider_failed');
  assert.equal(settled.assistantDraft, null);
  assert.equal(settled.pendingPlan, null);
  assert.equal(settled.plans.length, 0);
  assert.equal(preparation.released.length, 1);
});

test('plan preview reads complete JSON fields and keeps its display buffer bounded', async () => {
  const { PlanPreviewBuffer } = await import('../dist/local-agent/planPreview.js');
  const preview = new PlanPreviewBuffer('plan_publish');
  const delta = (argumentsDelta, name = 'plan_publish') => preview.append({ callIndex: 0, callId: 'call:prefix', name, argumentsDelta });
  assert.equal(delta('{"title":"Ignored"}', 'fs_read'), undefined);
  assert.equal(delta('{"title":"Escaped \\').title, '');
  assert.equal(delta('" quote", "steps":[{"title":"Step one",').title, 'Escaped " quote');
  assert.deepEqual(delta('"details":"pending').steps, ['Step one']);
  const bounded = delta('x'.repeat(100_000));
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length < 9000);
  for (const count of [12, 13]) {
    const full = new PlanPreviewBuffer('plan_publish').append({ callIndex: 0, callId: 'call:many-phases', name: 'plan_publish',
      argumentsDelta: JSON.stringify({ title: 'Phase preview', steps: Array.from({ length: count }, (_, index) => ({ title: `Phase ${index}` })) }) });
    assert.equal(full.steps.length, 12);
    assert.equal(full.truncated, count === 13, 'the display prefix must disclose additional phases');
  }
});

test('aggregate input admission preserves raw errors, permits correction, and never replays an executed peer', async (t) => {
  for (const [suffix, invalid, code] of [
    ['json', '{"workspace":"primary","path":', 'provider_tool_call_arguments_invalid'],
    ['workspace', '{"workspace":"unknown","path":"probe.txt"}', 'provider_workspace_handle_not_bound'],
    ['empty', '{"workspace":"","path":"probe.txt"}', 'provider_workspace_handle_required'],
    ['unknown', '{"workspace":"primary","path":"probe.txt"}', 'provider_tool_alias_unknown'],
  ]) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:aggregate-input-${suffix}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const tool = { toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read a file.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
    const executions = [];
    const kernel = emptyKernel({ async execute(request) {
      executions.push(request); return completedExecutionReply(request, { content: 'Read result.' });
    } });
    const requests = [];
    const provider = { async *stream(request) {
      requests.push(structuredClone(request));
      assert.ok(requests.length <= 4);
      const name = request.tools.find((candidate) => candidate.inputSchema.properties?.path).name;
      if (requests.length === 1) {
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:ok', name, arguments: '{"workspace":"primary","path":"first.txt"}' });
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:bad', name: suffix === 'unknown' ? 'undeclared_tool' : name, arguments: invalid });
      } else if (requests.length === 2) {
        assert.equal(executions.length, 1);
        const raw = request.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.providerCallId === 'native:bad');
        assert.equal(raw.input, invalid, 'the model sees its exact original arguments');
        assert.equal(raw.name, suffix === 'unknown' ? 'undeclared_tool' : name);
        const rejected = request.messages.map(jsonMessagePayload).find((value) => value?.status === 'inputRejected');
        assert.equal(rejected.executed, false);
        assert.equal(rejected.error.code, code);
        if (code.startsWith('provider_workspace_')) {
          assert.ok(rejected.error.message.includes('primary'), 'the rejection must name the bound logical handles');
        }
        assert.deepEqual(request.tools, requests[0].tools);
        assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:corrected', name, arguments: '{"workspace":"primary","path":"probe.txt"}' });
      } else {
        if (requests.length === 4) {
          assert.equal(name, 'read_current_run');
          const historical = request.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.providerCallId === 'native:bad');
          assert.equal(historical.name, suffix === 'unknown' ? 'undeclared_tool' : requests[0].tools.find((candidate) => candidate.inputSchema.properties?.path).name);
          assert.equal(historical.input, invalid, 'rejected history keeps the original owner alias and arguments');
        }
        yield providerEvent(request.requestId, 'assistant.message', { messageId: `native:answer:${requests.length}`, content: 'Both files read.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const preparation = fakeRunPreparation({ contextWindowTokens: 8192, tools: [tool] });
    const actor = actorWith(journal, sessionId, provider, kernel, {
      ...preparation.port,
      async prepare(request) {
        const result = await preparation.port.prepare(request);
        if (preparation.prepared.length > 1) {
          result.runtimeSnapshot.providerToolAliases.find((alias) => alias.canonicalName === 'fs.read').wireName = 'read_current_run';
        }
        return result;
      },
    }, `aggregate-${suffix}`);
    t.after(() => actor.dispose());
    await actor.submit(messageCommand(sessionId, 'command:start', 'Read both files.'));
    const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
    assert.deepEqual(executions.map((request) => request.input.path), ['first.txt', 'probe.txt']);
    const rejected = Object.values(projection.activities).filter((activity) => activity.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].inputRejection.code, code);
    const timelineActivities = projection.timeline.flatMap((item) => item.kind === 'toolGroup' ? item.activityIds : []);
    assert.ok(timelineActivities.includes(rejected[0].activityId), 'a rejected activity must appear in the shared timeline');
    await actor.submit(messageCommand(sessionId, 'command:followup', 'Summarize the earlier result.'));
    await waitForProjection(actor, (value) => value.run?.runId !== projection.run.runId && value.run?.status === 'completed');
    assert.equal(executions.length, 2, 'a new run must not execute rejected historical calls');
  }
});

test('mixed Plan batches are rejected before any effect and can be corrected to an independently confirmed plan', async (t) => {
  for (const surface of ['aggregate', 'responses']) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:plan-batch-${surface}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const plan = { title: 'Read a file', summary: 'Verify the file.', steps: [{ stepId: 'read', title: 'Read', details: 'Read the file.' }], mutationManifest: [] };
    const tool = { toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read a file.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
    let turns = 0;
    const provider = { async *stream(request) {
      assert.ok(++turns <= 2);
      const name = request.tools.find((candidate) => candidate.inputSchema.properties?.mutationManifest).name;
      const emit = (id, name, input, outputIndex) => surface === 'aggregate'
        ? providerEvent(request.requestId, 'tool.call', { callId: id, name, arguments: JSON.stringify(input) })
        : providerEvent(request.requestId, 'output.item.completed', { outputIndex, item: {
          type: 'function_call', call_id: id, name, arguments: JSON.stringify(input), status: 'completed' } });
      if (turns === 2) {
        const errors = request.messages.map(jsonMessagePayload).filter((value) => value?.status === 'inputRejected');
        assert.equal(errors.length, 2);
        assert.ok(errors.every((value) => value.executed === false && value.error.code === 'session_control_turn_conflict'));
      }
      yield emit(`native:plan-${turns}`, name, plan, 0);
      if (turns === 1) yield emit('native:read', request.tools.find((candidate) => candidate.inputSchema.properties?.path).name,
        { workspace: 'primary', path: 'probe.txt' }, 1);
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation({ tools: [tool], contextWindowTokens: 8192 }).port, `mixed-${surface}`);
    t.after(() => actor.dispose());
    await actor.submit(messageCommand(sessionId, 'command:start', 'Prepare a plan.'));
    const projection = await waitForProjection(actor, (value) => value.pendingPlan !== null);
    assert.equal(projection.activePlanRef, null);
    const events = await readEvents(journal, sessionId);
    assert.equal(events.filter((event) => event.type === 'plan.published').length, 1);
    assert.equal(events.some((event) => event.type === 'tool.requested' || event.type === 'plan.confirmed'), false);
  }
});

test('transient provider attempts keep one request, discard partial output, and execute no partial tools', async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:network-retry';
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [];
  const failure = { code: 'provider_transport_failed', message: 'Connection reset.', diagnostics: {
    source: 'providerTransport', phase: 'send', category: 'network', retryable: true,
    isConnect: true, isTimeout: false, causes: [{ message: 'Connection reset by peer', kind: 'ConnectionReset', osCode: 104 }],
  } };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      yield providerEvent(request.requestId, 'text.delta', { text: 'Discard this incomplete answer.' });
      yield providerEvent(request.requestId, 'tool.call', { callId: 'partial:call', name: 'partial_tool', input: {} });
      yield providerEvent(request.requestId, 'failed', failure);
    } else {
      yield providerEvent(request.requestId, 'text.delta', { text: 'Recovered answer.' });
      yield providerEvent(request.requestId, 'completed', {});
    }
  } }, emptyKernel(), fakeRunPreparation().port, 'retry');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:retry', 'Continue despite a network fluctuation.'));
  const result = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.notEqual(requests[0].providerAttemptId, requests[1].providerAttemptId);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.deepEqual(result.providerAttempts.map((value) => value.phase), ['retryWaiting', 'completed']);
  assert.equal(result.messages.at(-1).content, 'Recovered answer.');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assert.equal(events.filter((event) => event.type === 'context.composed').length, 1);
  assert.deepEqual(events.find((event) => event.type === 'provider.attempt.updated' && event.payload.phase === 'failed').payload.error, failure);
});

test('five total network sends stop the run, retain a snapshot, and allow an explicit continuation', { timeout: 25000 }, async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:retry-exhausted';
  await createSession(journal, sessionId);
  let count = 0, recover = false;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    count++;
    yield providerEvent(request.requestId, recover ? 'text.delta' : 'failed', recover ? { text: 'Continued.' } : {
      code: 'provider_transport_failed', message: 'Refused.', diagnostics: {
        source: 'providerTransport', phase: 'send', category: 'network', retryable: true,
        causes: [{ message: 'Connection refused', kind: 'ConnectionRefused' }],
      },
    });
    if (recover) yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'exhausted');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:fail-five', 'Run.'));
  const deadline = Date.now() + 21000;
  let result;
  while (Date.now() < deadline) {
    result = await actor.snapshot();
    if (['failed', 'indeterminate'].includes(result.run?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(count, 5);
  assert.ok(['failed', 'indeterminate'].includes(result.run?.status));
  assert.equal(result.failureSnapshot.providerAttemptIds.length, 5);
  assert.equal(result.failureSnapshot.error.code, 'provider_transport_failed');
  assert.equal(result.providerAttempts.at(-1).phase, 'failed');
  const reader = new SessionService(journal, { async create() { throw new Error('history_read_must_not_start_runtime'); } });
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.snapshot(sessionId), result);
  recover = true;
  await actor.submit(messageCommand(sessionId, 'command:continue-after-five', 'Continue.'));
  const continued = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(count, 6);
  assert.equal(continued.messages.at(-1).content, 'Continued.');
  assert.equal(continued.failureSnapshot, undefined);
});

test('protocol failures and cancellation never enter a network retry loop', async (t) => {
  const { withProviderAttempts } = await import('../dist/local-agent/providerAttempts.js');
  const { ProviderReportedFailure } = await import('../dist/local-agent/loopFailure.js');
  for (const purpose of ['agent', 'contextCompaction']) {
    const controller = new AbortController(), events = [];
    let calls = 0;
    const request = { requestId: 'request:single', sessionId: 'session:single', runId: 'run:single', purpose };
    const deps = { nextId: () => 'attempt:single', updateAssistantDraft() {}, commit: async (event) => { events.push(event); } };
    await assert.rejects(withProviderAttempts(request, deps, controller.signal, async () => {
      calls++;
      throw new ProviderReportedFailure('provider_invalid_json', 'Malformed frame.');
    }), /Malformed frame/);
    assert.equal(calls, 1);
    assert.equal(events.some((event) => event.payload.phase === 'retryWaiting'), false);
    const original = new ProviderReportedFailure('provider_transport_failed', 'Reset.', {
      source: 'providerTransport', phase: 'send', category: 'network', retryable: true, causes: [],
    });
    calls = 0;
    deps.commit = async (event) => { if (event.payload.phase === 'retryWaiting') controller.abort(new Error('user_cancelled')); };
    await assert.rejects(withProviderAttempts(request, deps, controller.signal, async () => { calls++; throw original; }), /user_cancelled/);
    assert.equal(calls, 1);
  }
});


test('an upstream service error retains its directive and ends without a network retry', async (t) => {
  const { isLocalAgentErrorValue } = await import('@deepcode/protocol');
  const journal = new InMemoryCommandJournal(), sessionId = 'session:service-unavailable';
  await createSession(journal, sessionId);
  const failure = { code: 'provider_error', message: 'Our servers are currently overloaded. Please try again later.', diagnostics: {
    source: 'providerTransport', phase: 'response', category: 'provider', retryable: false, causes: [],
    providerError: { code: 'server_is_overloaded', type: 'service_unavailable_error', retryDirective: 'NO_MORE_RETRY' },
  } };
  assert.equal(isLocalAgentErrorValue(failure), true);
  let sends = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    sends++;
    yield providerEvent(request.requestId, 'failed', failure);
  } }, emptyKernel(), fakeRunPreparation().port, 'service-unavailable');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:service-unavailable', 'Continue the task.'));
  const result = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  assert.equal(sends, 1);
  assert.deepEqual(result.failureSnapshot.error, failure);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some((event) => event.type === 'provider.attempt.updated' && event.payload.phase === 'retryWaiting'), false);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
});

test('a Kernel input rejection can request confirmation and resume the same run', async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:input-confirmation';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tool = { toolBindingRef: 'tool-binding:write:g1', name: 'fs.write', description: 'Write a file.',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
    possibleEffects: ['workspaceMutation'], availability: 'callable', origin: 'coreBuiltin' };
  let calls = 0, turns = 0;
  const originalError = { code: 'input_resource_read_only', message: 'Input snapshot is read-only. Choose a writable destination.',
    diagnostics: { source: 'kernel', phase: 'prepare', category: 'input', retryable: false, causes: [] },
    issues: [{ path: '$.workspaceId', rule: 'readOnlyInput', message: 'Input snapshot is read-only.' }] };
  const kernel = emptyKernel({ async execute(request) {
    calls++;
    const rejection = Object.fromEntries(['sessionId', 'runId', 'extensionGenerationRef', 'kernelCatalogSnapshotRef', 'toolBindingRef', 'callId', 'attemptId', 'toolName', 'input'].map(key => [key, request[key]]));
    return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
      callId: request.callId, status: 'inputRejected', rejection: { ...rejection, rejectedAt: '2026-09-18T00:00:00Z', error: originalError } };
  } });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    turns++;
    if (turns === 1) {
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:write', name: 'fs_write', input: { path: 'preview.html', content: 'Draft' } });
    } else if (turns === 2) {
      const result = request.messages.map(jsonMessagePayload).find(value => value?.status === 'inputRejected');
      assert.deepEqual(result.error, originalError);
      assert.equal(result.executed, false);
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:confirm', name: 'interaction_request', input: {
        kind: 'confirmation', prompt: 'Use a session working copy?', options: [{ id: 'draft', label: 'Use a working copy' }], allowFreeform: true,
      } });
    } else {
      assert.equal(turns, 3);
      assert.ok(request.messages.some(message => message.content?.includes('Use a working copy')));
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'native:done', content: 'The working-copy destination is confirmed.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, kernel, fakeRunPreparation({ tools: [tool] }).port, 'input-confirmation');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Prepare a preview.'));
  const waiting = await waitForProjection(actor, value => value.pendingInteraction !== null);
  assert.equal(waiting.pendingInteraction.kind, 'confirmation');
  assert.equal(waiting.pendingApproval, null);
  assert.equal(turns, 2);
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'interaction.respond', commandId: 'command:confirm',
    sessionId, runId: waiting.run.runId, interactionId: waiting.pendingInteraction.interactionId, response: 'Use a working copy' });
  const completed = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(completed.run.runId, waiting.run.runId);
  assert.equal(calls, 1, 'confirmation must not replay the rejected write');
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.find(event => event.type === 'tool.input-rejected').payload.rejection.error, originalError);
  assert.equal(events.some(event => event.type === 'run.settled' && event.payload.outcome === 'failed'), false);
});

test('Todo can start before tools without a Plan, preserve a failed record and end with blocked work', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:independent-todo';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ contextWindowTokens: 8192, tools: [{
    toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read a file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  let turn = 0;
  const kernel = emptyKernel({ async execute(request) {
    assert.equal(request.planAuthorities, undefined);
    return failedExecutionReply(request, null, { code: 'file_missing', message: 'The requested file does not exist.' });
  } });
  const provider = { async *stream(request) {
    turn += 1;
    const tool = request.tools.find(tool => tool.name === 'todo_update');
    assert.ok(tool, 'Todo must be available without Plan approval');
    if (turn === 1) {
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:todo-start', name: tool.name,
        input: { items: [{ text: 'Investigate input', status: 'inProgress' }, { text: 'Process input', status: 'pending' }] } });
      const read = request.tools.find(tool => tool.inputSchema.properties?.path);
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:read', name: read.name, input: { path: 'missing.txt' } });
    } else if (turn === 2) {
      const record = request.messages.map(jsonMessagePayload).find(payload => payload?.recordId);
      assert.equal(record.outcome, 'failed');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:todo-blocked', name: tool.name,
        input: { items: [{ text: 'Process input', status: 'blocked' }, { text: 'Investigate input', status: 'completed' }] } });
    } else {
      assert.equal(turn, 3);
      assert.deepEqual(jsonMessagePayload(request.messages.findLast(message => message.role === 'tool')),
        { accepted: true });
      assert.equal(request.messages.map(jsonMessagePayload).some(payload => payload?.type === 'todo.current'), false);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Input is missing; processing remains blocked.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'independent-todo');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Inspect and process the input.'));
  const finished = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(finished.plans.length, 0);
  assert.equal(finished.terminalError, null);
  assert.equal(finished.todoList.revision, 2);
  assert.deepEqual(finished.todoList.items.map(item => item.status), ['blocked', 'completed']);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'session.control.rejected').length, 0);
  const updates = events.filter(event => event.type === 'todo.updated');
  const failure = singleEvent(events, 'tool.completed');
  assert.equal(failure.payload.record.outcome, 'failed');
  assert.equal(failure.payload.record.error.code, 'file_missing');
  assertEventOrder(updates[0], singleEvent(events, 'tool.requested'), failure, updates[1], singleEvent(events, 'run.finishing'));
  assert.equal(preparation.released.length, 1);
});


test('tool results keep the workspace handle of the request that produced the call', async () => {
  const { encodeProviderMessage } = await import('../dist/local-agent/providerToolCodec.js');
  const old = { workspaceHandleById: new Map([['workspace:one', 'primary']]) };
  const current = { workspaceHandleById: new Map([['workspace:one', 'workspace2']]) };
  const message = { role: 'tool', toolCallId: 'call:old', content: JSON.stringify({ outcome: 'failed',
    output: { workspaceId: 'workspace:one', path: 'src/main.cpp', paths: { workspace: '/project', home: '/session/home' } },
    error: { code: 'plan_scope_required', workspaceId: 'workspace:one', targets: ['src/main.cpp'] },
  }) };
  const content = JSON.parse(encodeProviderMessage(message, current, new Map([['call:old', old]])).content);
  assert.equal(content.output.workspace, 'primary');
  assert.equal(content.error.workspace, 'primary');
  assert.equal(content.output.workspaceId, undefined);
  assert.deepEqual(content.output.paths, { workspace: '/project', home: '/session/home' });
  assert.equal(JSON.parse(message.content).output.workspaceId, 'workspace:one');
});

test('explicit GUI rebind preserves waiting and uses the new catalog only for subsequent calls', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:host-rebind';
  await createSession(journal, sessionId, [workspaceBinding]);
  const oldBinding = { hostInstanceId: 'gui:old', windowLabel: 'main' };
  const newBinding = { hostInstanceId: 'gui:new', windowLabel: 'main' };
  const tool = { toolBindingRef: 'binding:status', name: 'computer.control', description: 'Read GUI status.',
    inputSchema: { type: 'object', properties: { action: { const: 'status' } }, required: ['action'] },
    possibleEffects: ['external'], availability: 'callable', origin: 'extension', pluginUri: 'plugin://computer-use@builtin' };
  const preparation = fakeRunPreparation({ apiSurface: 'responses', tools: [tool], contextWindowTokens: 32768 });
  const prepare = preparation.port.prepare;
  preparation.port.prepare = async request => {
    const result = await prepare(request);
    result.runtimeSnapshot.environment.hostBinding = request.rebindHost?.hostBinding ?? oldBinding;
    if (request.rebindHost) result.runtimeSnapshot.kernelCatalogSnapshotRef = 'catalog:new-gui';
    return result;
  };
  const requests = [], executions = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) yield providerEvent(request.requestId, 'output.item.completed', {
      outputIndex: 0, item: { type: 'function_call', call_id: 'native:question', name: 'interaction_request',
        arguments: JSON.stringify({ kind: 'question', prompt: 'Continue after reopening?', allowFreeform: true }), status: 'completed' },
    });
    else if (requests.length === 2) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:status', name: 'computer_control', input: { action: 'status' },
    });
    else yield providerEvent(request.requestId, 'text.delta', { text: 'New GUI checked.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { executions.push(request); return completedExecutionReply(request, { status: 'ready' }); } }), preparation.port, 'host-rebind');
  t.after(() => actor.dispose());
  await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Wait before using a new GUI.'), hostBinding: oldBinding });
  const waiting = await waitForProjection(actor, p => p.run?.status === 'waiting');
  const command = { schemaVersion: 'deepcode.command.v3', type: 'run.host.rebind', commandId: 'command:rebind',
    sessionId, runId: waiting.run.runId, expectedHostBinding: oldBinding, hostBinding: newBinding };
  const stale = await actor.submit({ ...command, commandId: 'command:stale', expectedHostBinding: newBinding });
  assert.equal(stale.error.code, 'host_rebind_target_changed');
  assert.equal((await actor.submit(command)).status, 'accepted');
  assert.equal((await actor.submit(command)).status, 'replayed');
  const rebound = await actor.snapshot();
  assert.equal(rebound.run.status, 'waiting');
  assert.deepEqual(rebound.run.hostBinding, newBinding);
  assert.deepEqual(rebound.pendingInteraction, waiting.pendingInteraction);
  assert.equal(requests.length, 1, 'rebind does not answer, resume or replay');
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'interaction.respond', commandId: 'command:answer',
    sessionId, runId: waiting.run.runId, interactionId: waiting.pendingInteraction.interactionId, response: 'Continue.' });
  await waitForProjection(actor, p => p.run?.status === 'completed');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].kernelCatalogSnapshotRef, 'catalog:new-gui');
  const resumed = requests[1].messages;
  const callIndex = resumed.findIndex(m => m.providerOutputBlocks?.some(b => b.providerCallId === 'native:question'));
  const resultIndex = resumed.findIndex(m => m.role === 'tool' && m.providerCallId === 'native:question');
  const noticeIndex = resumed.findIndex(m => m.content.includes('The user selected a new GUI target.')
    && m.content.includes('observationId') && m.content.includes('previewId'));
  assert.ok(callIndex >= 0 && resultIndex > callIndex && noticeIndex > resultIndex,
    'the GUI rebind notice must follow the pending native tool result, not split the call/result pair');
  assert.doesNotMatch(resumed[noticeIndex].content, /gui:new|hostInstanceId|windowLabel/u);
  assert.deepEqual(requests[2].messages.slice(0, resumed.length), resumed,
    'later requests retain the same binding-notice position in the completed history');
  assert.equal(requests[1].providerRuntimeRef, requests[0].providerRuntimeRef);
  const rebindEvents = (await readEvents(journal, sessionId)).filter(e => e.type === 'run.host.rebound');
  assert.equal(rebindEvents.length, 1);
  assert.deepEqual(rebindEvents[0].payload.hostBinding, newBinding);
  assert.equal(rebindEvents[0].payload.toolView.kernelCatalogSnapshotRef, 'catalog:new-gui');
  assert.equal((await actor.submit({ ...command, commandId: 'command:finished' })).error.code, 'host_rebind_not_waiting');
});
