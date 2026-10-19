import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_USER_SETTINGS, decodeContextManagementSettings } from '../../protocol/dist/index.js';
import { SessionActor, SessionService } from '../dist/index.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { agentOperationDefinitions, decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { readConversation } from '../dist/local-agent/conversationRead.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, completedExecutionReply,
  messageCommand, providerEvent, readEvents, waitForProjection, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

const answer = (request, text) => providerEvent(request.requestId, 'text.delta', { text });
const done = request => providerEvent(request.requestId, 'completed', {});
const call = (request, input) => providerEvent(request.requestId, 'tool.call', { callId: `native:${request.requestId}`, name: 'agent', input });
const terminal = projection => ['completed', 'failed', 'indeterminate', 'cancelled'].includes(projection.run?.status);
const oldText = 'Historical inspection details. '.repeat(3000);
const readTool = { toolBindingRef: 'binding:context-read', name: 'fs.read', description: 'Read a file.',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  possibleEffects: ['workspaceRead'], origin: 'coreBuiltin', availability: 'callable' };

async function completed(actor) {
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'completed', JSON.stringify(projection.terminalError));
  return projection;
}

test('context settings default off at 500k; optional child overrides preserve unspecified inherited rules', async t => {
  assert.equal(DEFAULT_USER_SETTINGS['agent.contextManagement.enabled'], false);
  assert.equal(DEFAULT_USER_SETTINGS['agent.contextManagement.thresholdTokens'], 500_000);
  assert.deepEqual(decodeContextManagementSettings({ enabled: false, thresholdTokens: 500_000 }), { enabled: false, thresholdTokens: 500_000 });
  assert.throws(() => decodeContextManagementSettings({ enabled: true, thresholdTokens: 0 }), /context_management_settings_invalid/);
  assert.throws(() => decodeContextManagementSettings({ enabled: true, thresholdTokens: 1.5 }), /context_management_settings_invalid/);
  const registry = new SessionConfigurationRegistry();
  const base = registry.resolve(undefined, { context: { id: 'journal', parameters: { maxTokens: 200_000 } },
    compaction: { id: 'summary', parameters: { enabled: true, thresholdTokens: 100_000, pressureRatio: 0.9 } } }, true);
  const configured = registry.resolve(base, { compaction: { id: 'summary', parameters: { thresholdTokens: 80_000 } } }, true);
  assert.deepEqual(configured.compaction.parameters, { enabled: true, thresholdTokens: 80_000, pressureRatio: 0.9 });
  assert.equal(configured.context.parameters.maxTokens, 200_000);
  const ports = await registry.create(configured);
  t.after(() => ports.dispose());
  const runtime = (await fakeRunPreparation({ contextWindowTokens: 128_000 }).port.prepare({ runId: 'run:budget' })).runtimeSnapshot;
  assert.equal(ports.context.windowTokens(runtime), 128_000, 'model capacity bounds inherited budgets');
  assert.deepEqual(ports.compaction.settings(runtime), { enabled: true, thresholdTokens: 80_000 });
  const operations = agentOperationDefinitions({ messaging: true, continuation: true, delegation: true }, { fullConfiguration: true });
  const spawn = operations.find(item => item.action === 'spawn');
  assert.deepEqual(spawn.inputSchema.required, ['action', 'task', 'name', 'delivery']);
  assert.match(spawn.description, /inherit from the parent/);
  assert.match(spawn.description, /doc.read model-services.md/);
  assert.equal(decodeSessionControlCall('call:compact', 'agent', { action: 'compact', agentId: 'session:child' }).operation.focus, undefined);
});

test('soft threshold never interrupts a tool trajectory; task-end compaction preserves journal and later cacheable history', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:auto-tail', requests = [];
  await createSession(journal, sessionId, [workspaceBinding]);
  let mainTurns = 0;
  const preparation = fakeRunPreparation({ contextWindowTokens: 200_000, tools: [readTool],
    contextManagement: { enabled: true, thresholdTokens: 10_000 } });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (request.purpose === 'contextCompaction') {
      assert.equal(mainTurns, 2, 'the task finishes before soft-threshold compaction');
      yield answer(request, 'Handoff: inspection completed; retain record references.');
    } else if (++mainTurns === 1) {
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:read', name: 'fs_read', input: { workspace: 'primary', path: 'module.ts' } });
    } else yield answer(request, mainTurns === 2 ? 'Inspection finished.' : 'Next task finished.');
    yield done(request);
  } }, emptyKernel({ async execute(request) { return completedExecutionReply(request, { content: 'Observed file.' }); } }), preparation.port, 'auto-tail');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:auto-tail', oldText));
  await completed(actor);
  assert.deepEqual(requests.map(item => item.purpose), ['agent', 'agent', 'contextCompaction']);
  const events = await readEvents(journal, sessionId);
  const checkpoint = events.find(event => event.type === 'context.compacted');
  assert.equal(checkpoint.payload.trigger, 'automatic');
  assert.ok(events.find(event => event.type === 'tool.completed').sequence < checkpoint.payload.coveredThroughSequence);
  assert.ok(events.find(event => event.type === 'message.committed' && event.payload.content === 'Inspection finished.').sequence <= checkpoint.payload.coveredThroughSequence);
  const history = await readConversation(journal, { sessionId, view: 'messages', limit: 50 });
  assert.ok(history.items.some(item => String(item.content).startsWith('Historical inspection details.')));
  await actor.submit(messageCommand(sessionId, 'command:auto-next', 'Inspect the next module.'));
  await completed(actor);
  assert.match(JSON.stringify(requests.at(-1).messages), /Handoff: inspection completed/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Historical inspection details/);
  assert.equal(requests.filter(item => item.purpose === 'contextCompaction').length, 1);
});

test('disabled automatic management preserves history; enabling applies before a new run and keeps its user input intact', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:auto-entry', requests = [];
  await createSession(journal, sessionId);
  const options = { contextWindowTokens: 200_000, contextManagement: { enabled: false, thresholdTokens: 10_000 } };
  const preparation = fakeRunPreparation(options);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    yield answer(request, request.purpose === 'contextCompaction' ? 'Prior work summarized.' : 'Task complete.');
    yield done(request);
  } }, emptyKernel(), preparation.port, 'auto-entry');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:old', oldText));
  await completed(actor);
  assert.deepEqual(requests.map(item => item.purpose), ['agent']);
  options.contextManagement = { enabled: true, thresholdTokens: 10_000 };
  const nextText = 'New task with an exact constraint.';
  await actor.submit(messageCommand(sessionId, 'command:new', nextText));
  await completed(actor);
  assert.deepEqual(requests.map(item => item.purpose), ['agent', 'contextCompaction', 'agent']);
  assert.ok(requests[1].messages.at(-1).content.includes(nextText), 'new input is available as summary focus');
  assert.ok(requests[2].messages.some(message => message.role === 'user' && message.content === nextText));
  const events = await readEvents(journal, sessionId);
  const newInput = events.find(event => event.type === 'message.committed' && event.payload.content === nextText);
  assert.ok(events.find(event => event.type === 'context.compacted').payload.coveredThroughSequence < newInput.sequence);
});

test('explicit compaction waits until in-flight tools complete and does not need automatic management enabled', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:manual-boundary', requests = [];
  await createSession(journal, sessionId, [workspaceBinding]);
  let actor, mainTurns = 0;
  actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (request.purpose === 'contextCompaction') yield answer(request, 'Tool evidence retained.');
    else if (++mainTurns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:manual-read', name: 'fs_read', input: { workspace: 'primary', path: 'module.ts' },
    });
    else yield answer(request, 'Done.');
    yield done(request);
  } }, emptyKernel({ async execute(request) {
    const receipt = await actor.requestContextCompaction('session:parent', 'Keep file evidence.');
    assert.equal(receipt.status, 'scheduled');
    assert.equal(receipt.boundary, 'nextModelBoundary');
    assert.equal(requests.length, 1, 'scheduling never interrupts the active tool or starts another Provider');
    return completedExecutionReply(request, { content: 'File evidence.' });
  } }), fakeRunPreparation({ contextWindowTokens: 100_000, tools: [readTool] }).port, 'manual-boundary');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:manual', 'Inspect the file.'));
  await completed(actor);
  assert.deepEqual(requests.map(item => item.purpose), ['agent', 'contextCompaction', 'agent']);
  const events = await readEvents(journal, sessionId);
  assert.ok(events.find(event => event.type === 'tool.completed').sequence < events.find(event => event.type === 'context.compaction.requested').sequence);
  assert.equal(events.find(event => event.type === 'context.compacted').payload.trigger, 'agent');
});

test('child context budget is enforced independently of the larger model window and automatic soft threshold', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:small-budget';
  await createSession(journal, sessionId);
  const registry = new SessionConfigurationRegistry();
  const capabilities = await registry.create(registry.resolve(undefined, { context: { id: 'journal', parameters: { maxTokens: 8000 } } }, true));
  let calls = 0;
  const actor = new SessionActor(sessionId, journal, { capabilities, kernel: emptyKernel(),
    runPreparation: fakeRunPreparation({ contextWindowTokens: 200_000 }).port,
    provider: { async *stream() { calls++; throw new Error('over_budget_input_reached_provider'); } }, async dispose() {} });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:budget', oldText));
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'failed');
  assert.equal(projection.terminalError.code, 'context_input_budget_exceeded');
  assert.equal(calls, 0);
  assert.ok((await readEvents(journal, sessionId)).some(event => event.type === 'message.committed' && event.payload.content === oldText));
});

test('a failed automatic summary retains the final answer, original history and failure without committing a checkpoint', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:auto-failure';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'contextCompaction') yield providerEvent(request.requestId, 'failed', { code: 'summary_service_failed', message: 'Summary failed.' });
    else { yield answer(request, 'Work result retained.'); yield done(request); }
  } }, emptyKernel(), fakeRunPreparation({ contextWindowTokens: 200_000, contextManagement: { enabled: true, thresholdTokens: 10_000 } }).port, 'auto-failure');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:failure', oldText));
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'failed');
  assert.equal(projection.terminalError.code, 'summary_service_failed');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some(event => event.type === 'context.compacted'), false);
  assert.ok(events.some(event => event.type === 'message.committed' && event.payload.content === 'Work result retained.'));
  assert.ok(events.some(event => event.type === 'message.committed' && event.payload.content === oldText));
});

test('waiting for a user answer is not an idle automatic-compaction boundary', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:context-question', purposes = [];
  await createSession(journal, sessionId);
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    purposes.push(request.purpose);
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:question', name: 'interaction_request',
      input: { kind: 'question', mode: 'continue', prompt: 'Which module?', allowFreeform: true } });
    else yield answer(request, 'Independent work is complete; awaiting your answer.');
    yield done(request);
  } }, emptyKernel(), fakeRunPreparation({ contextWindowTokens: 200_000,
    contextManagement: { enabled: true, thresholdTokens: 10_000 } }).port, 'context-question');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:question', oldText));
  const projection = await waitForProjection(actor, item => item.run?.status === 'waiting' || terminal(item));
  assert.equal(projection.run.status, 'waiting', JSON.stringify(projection.terminalError));
  assert.deepEqual(purposes, ['agent', 'agent']);
});

test('new input arriving during task-end compaction remains outside its prefix and continues the same run', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:context-new-input';
  await createSession(journal, sessionId);
  let actor, summaries = 0, turns = 0;
  const nextText = 'Additional user constraint received during compaction.';
  actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'contextCompaction') {
      if (++summaries === 1) {
        const result = await actor.submit(messageCommand(sessionId, 'command:during-summary', nextText));
        assert.notEqual(result.status, 'rejected');
        assert.ok(!request.messages.some(message => message.content === nextText));
      }
      yield answer(request, 'Task history summarized.');
    } else {
      if (++turns === 2) assert.ok(request.messages.some(message => message.role === 'user' && message.content === nextText));
      yield answer(request, turns === 1 ? 'Initial result.' : 'Additional constraint handled.');
    }
    yield done(request);
  } }, emptyKernel(), fakeRunPreparation({ contextWindowTokens: 200_000,
    contextManagement: { enabled: true, thresholdTokens: 10_000 } }).port, 'context-new-input');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:initial', oldText));
  await completed(actor);
  assert.equal(turns, 2);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'run.started').length, 1);
  const firstCheckpoint = events.find(event => event.type === 'context.compacted');
  const input = events.find(event => event.type === 'message.committed' && event.payload.content === nextText);
  assert.ok(input.sequence > firstCheckpoint.payload.coveredThroughSequence);
});

async function agentService(t, ownerId, stream) {
  const journal = new InMemoryCommandJournal();
  let service;
  service = new SessionService(journal, { async create({ sessionId }) {
    const preparation = fakeRunPreparation({ contextWindowTokens: 100_000,
      contextManagement: { enabled: sessionId === ownerId, thresholdTokens: sessionId === ownerId ? 500_000 : 750_000 } });
    return { composition: { kernel: emptyKernel(), runPreparation: { ...preparation.port, async prepare(input) {
      const prepared = await preparation.port.prepare(input);
      prepared.runtimeSnapshot.agentToolsEnabled = true;
      const child = (await readEvents(journal, sessionId))[0].payload.agentContext;
      if (child) prepared.runtimeSnapshot.agentCapabilities = child.capabilities;
      return prepared;
    } }, provider: { async *stream(request) { yield* stream({ sessionId, request, service, journal }); } }, async dispose() {} } };
  } }, {
    async settings() { return { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4, maxCallsPerRun: 16,
      maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: true, presets: '[]' }; },
    async models() { return [{ profileId: 'profile:default', name: 'Default', model: 'fixture', reasoningEfforts: ['low'],
      parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100_000,
        maxOutputTokens: 512, imageInput: false, temperature: null, hostedWebSearch: null } }]; },
    async createSession(input) { return service.createSession(input); },
  });
  t.after(() => service.dispose());
  await service.createSession({ sessionId: ownerId, displayTitle: 'Context owner', workspaceBindings: [] });
  return { service, journal };
}

test('real child creation inherits actual parent rules; optional overrides merge without mandatory context arguments', async t => {
  const ownerId = 'session:context-owner';
  let turn = 0;
  const { service, journal } = await agentService(t, ownerId, async function* ({ sessionId, request }) {
    if (sessionId !== ownerId) yield answer(request, 'Child result.');
    else if (++turn === 1) yield call(request, { action: 'spawn', name: 'Inherited', task: 'Inspect.', delivery: 'wait' });
    else if (turn === 2) yield call(request, { action: 'spawn', name: 'Override', task: 'Inspect separately.', delivery: 'wait',
      context: { id: 'journal', parameters: { maxTokens: 40_000 } },
      loop: { compaction: { id: 'summary', parameters: { thresholdTokens: 30_000 } } } });
    else yield answer(request, 'Parent result.');
    yield done(request);
  });
  await service.submit(messageCommand(ownerId, 'command:inherit', 'Delegate two inspections.'));
  await waitUntil(async () => terminal(await service.snapshot(ownerId)), 'parent completion');
  const parent = await service.snapshot(ownerId);
  assert.equal(parent.run.status, 'completed', JSON.stringify(parent.terminalError));
  assert.equal(parent.agentChildren.length, 2);
  const configurations = [];
  for (const child of parent.agentChildren) configurations.push((await readEvents(journal, child.agentSessionId))[0].payload.recipe.configuration);
  assert.deepEqual(configurations[0].context.parameters, { maxTokens: 100_000 });
  assert.deepEqual(configurations[0].compaction.parameters, { enabled: true, thresholdTokens: 500_000 });
  assert.deepEqual(configurations[1].context.parameters, { maxTokens: 40_000 });
  assert.deepEqual(configurations[1].compaction.parameters, { enabled: true, thresholdTokens: 30_000 });
});

test('parent compact queues an idle retained child without starting work; assignment consumes it once', async t => {
  const ownerId = 'session:compact-owner';
  let turn = 0, childId, childCalls = 0;
  const { service, journal } = await agentService(t, ownerId, async function* ({ sessionId, request, service }) {
    if (sessionId !== ownerId) {
      childCalls++;
      yield answer(request, request.purpose === 'contextCompaction' ? 'Retained evidence summary.' : 'Child result.');
    } else if (++turn === 1) yield call(request, { action: 'spawn', name: 'Retained', task: 'Inspect.', delivery: 'wait' });
    else if (turn === 2) {
      childId = (await service.snapshot(ownerId)).agentChildren[0].agentSessionId;
      yield call(request, { action: 'compact', agentId: childId });
    } else if (turn === 3) {
      assert.equal(childCalls, 1, 'idle compaction must not start a child task');
      assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('"boundary":"nextRun"')));
      yield call(request, { action: 'assign', agentId: childId, task: 'Continue the inspection.' });
    } else if (turn === 4) yield call(request, { action: 'wait' });
    else yield answer(request, 'Parent done.');
    yield done(request);
  });
  await service.submit(messageCommand(ownerId, 'command:compact-owner', 'Inspect and continue.'));
  await waitUntil(async () => terminal(await service.snapshot(ownerId)), 'parent completion');
  const parent = await service.snapshot(ownerId);
  assert.equal(parent.run.status, 'completed', JSON.stringify(parent.terminalError));
  assert.equal(parent.agentTasks.length, 2);
  assert.equal(childCalls, 3, 'two work requests and one summary');
  const events = await readEvents(journal, childId);
  assert.equal(events.filter(event => event.type === 'run.started').length, 2);
  assert.equal(events.filter(event => event.type === 'context.compacted' && event.payload.trigger === 'agent').length, 1);
});
