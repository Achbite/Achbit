import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../dist/local-agent/service.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { completedExecutionReply, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents, recordedSubagentSettings, workspaceBinding } from './local-agent-fixtures.mjs';

const shell = { name: 'bash', toolBindingRef: 'binding:shell', origin: 'coreBuiltin', availability: 'callable',
  description: 'Run a command.', possibleEffects: ['process'], inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4, maxCallsPerRun: 16,
  maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: true, presets: '[]' };
const model = { profileId: 'profile:default', name: 'Fixture', model: 'fixture-model', reasoningEfforts: ['low', 'medium', 'high'],
  parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096,
    imageInput: false, temperature: null, hostedWebSearch: null } };

// Replay an active call after a Kernel permission revalidation. The prior run.waiting is not
// acceptance of manual input for the *new* approvalId on that call.
async function checkArchivedApprovalRoutes(source, root, leaf, requested, scenario) {
  const journal = new InMemoryCommandJournal();
  for (const sessionId of [root, leaf]) {
    const [first, ...rest] = await readEvents(source, sessionId);
    await journal.createSession({ sessionId, ...first.payload });
    await journal.appendBatch(rest);
  }
  const passive = new SessionService(journal, { async create() { assert.fail('history opened an Actor'); } });
  const original = { sessionId: leaf, runId: requested.runId, callId: requested.callId }, preview = requested.payload.preview;
  const sibling = (await readEvents(journal, leaf)).find(event => event.type === 'tool.requested' && event.payload.input.command === 'independent action');
  try {
    await journal.append({ type: 'run.waiting', sessionId: leaf, runId: requested.runId, payload: { reason: 'approval', detail: 'Waiting for the original request.' } });
    assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions[0].approval, { approvalId: requested.payload.approvalId, callId: requested.callId });
    if (scenario === 'concurrent') {
      // Deferring a dialog is client-local. A second pending call must be visible even before answering the first.
      await journal.append({ ...original, type: 'approval.requested', callId: sibling.callId, payload: { approvalId: 'approval:concurrent', preview } });
      const identities = async () => (await passive.snapshot(root)).pendingAgentDecisions.map(route => [route.agentSessionId, route.runId, route.approval]);
      const first = [leaf, requested.runId, { approvalId: requested.payload.approvalId, callId: requested.callId }];
      assert.deepEqual(await identities(), [first, [leaf, requested.runId, { approvalId: 'approval:concurrent', callId: sibling.callId }]],
        'the root offers both pending human approvals for the same child run');
      await journal.append({ ...original, type: 'approval.resolved', callId: sibling.callId, payload: { approvalId: 'approval:concurrent', commandId: 'command:concurrent', authorityId: 'authority:concurrent', decision: 'deny', source: 'user' } });
      assert.deepEqual(await identities(), [first], 'answering the second call does not discard the first');
      return;
    }
    await journal.append({ ...original, type: 'approval.requested', payload: { approvalId: 'approval:replacement', preview: { ...preview, approvalReviewer: 'agent' } } });
    assert.equal((await passive.snapshot(leaf)).run.waitingReason, 'approval');
    assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions ?? [], [], 'the old wait does not route the replacement while the model reviews it');
    await journal.append({ ...original, type: 'approval.requested', callId: sibling.callId, payload: { approvalId: 'approval:second', preview } });
    assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions[0].approval, { approvalId: 'approval:second', callId: sibling.callId }, 'the first human item need not be the first pending item');
    await journal.append({ ...original, type: 'approval.resolved', callId: sibling.callId, payload: { approvalId: 'approval:second', commandId: 'command:second', authorityId: 'authority:second', decision: 'allow', source: 'user' } });
    assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions ?? [], [], 'neither a resolved item nor an unreviewed replacement is actionable');
  } finally { await passive.dispose(); }
}

// Block an unrelated sibling so the child does not enter run.waiting on behalf of this call.
// All checkpoints are original child facts, not polling the root until an approval appears.
for (const outcome of ['manual', 'ask', 'failure', 'allow']) test(`child execution approval routes to the owner only at human handoff (${outcome})`, { timeout: 10_000 }, async t => {
  const root = `session:owner-${outcome}`, nested = outcome === 'ask', journal = new InMemoryCommandJournal();
  const requested = Promise.withResolvers(), sibling = Promise.withResolvers(), releaseSibling = Promise.withResolvers();
  const reviewing = [Promise.withResolvers(), Promise.withResolvers()], releaseReview = [Promise.withResolvers(), Promise.withResolvers()];
  const handedOff = Promise.withResolvers(), resolved = Promise.withResolvers(), settled = Promise.withResolvers(), failure = Promise.withResolvers();
  const checkpoint = async gate => {
    const value = await Promise.race([gate.promise, failure.promise]);
    if (value instanceof Error) throw value;
    return value;
  };
  const calls = [], agentTurns = new Map();
  let service, leaf, reviews = 0;
  service = new SessionService(journal, { async create({ sessionId }) {
    const context = (await readEvents(journal, sessionId))[0].payload.agentContext;
    const preparation = fakeRunPreparation({ contextWindowTokens: 100000, tools: [shell], subagentSettings: settings });
    return { composition: { runPreparation: { ...preparation.port, async prepare(input) {
      const result = await preparation.port.prepare(input);
      result.runtimeSnapshot.subagentSettings = await recordedSubagentSettings(journal, sessionId, input.runId);
      result.runtimeSnapshot.agentToolsEnabled = true;
      if (context) result.runtimeSnapshot.agentCapabilities = context.capabilities;
      return result;
    } }, provider: { async *stream(request) {
      const emit = (type, data) => providerEvent(request.requestId, type, data);
      const call = (callId, name, input) => emit('tool.call', { callId, name, input });
      if (request.purpose === 'approvalReview') {
        assert.equal(sessionId, leaf, 'the coordinator model must not be the reviewer');
        const round = reviews++;
        reviewing[round].resolve(); await releaseReview[round].promise;
        if (outcome === 'failure') throw new Error('fixture review unavailable');
        yield emit('assistant.message', { content: nested && round === 0 ? 'invalid decision'
          : JSON.stringify({ decision: outcome, reason: 'Reviewed the original call.' }) });
      } else {
        const turn = (agentTurns.get(sessionId) ?? 0) + 1;
        agentTurns.set(sessionId, turn);
        if (turn === 1 && (sessionId === root || nested && context?.parentSessionId === root)) {
          yield call('spawn:' + sessionId, 'agent', { action: 'spawn', preset: 'collaboration', name: sessionId === root && nested ? 'Middle' : 'Executor',
            ...(nested && sessionId === root ? { capabilities: { delegation: true } } : {}), task: 'Perform the delegated check.', delivery: 'wait' });
        } else if (turn === 1) {
          leaf = sessionId;
          yield call('gated', 'bash', { workspace: 'primary', command: 'gated action' });
          yield call('sibling', 'bash', { workspace: 'primary', command: 'independent action' });
        } else yield emit('text.delta', { text: 'Completed the delegated check.' });
      }
      yield emit('completed', {});
    } }, kernel: emptyKernel({ async execute(input) {
      if (input.input.command === 'independent action') { sibling.resolve(); await releaseSibling.promise; }
      else {
        calls.push(input);
        if (!input.nonWorkspaceAuthority) return { schemaVersion: 'achbit.kernel-reply', type: 'tool.execution', requestId: input.requestId,
          callId: input.callId, status: 'approvalRequired', preview: { summary: 'Gated action', effects: ['process'], logicalTargets: ['.'],
            approvalReviewer: outcome === 'manual' ? 'user' : 'agent', authorizationContext: { command: input.input.command } } };
      }
      return completedExecutionReply(input, { exitCode: 0, stdout: 'done' });
    } }), async dispose() {} } };
  } }, { async models() { return [model]; }, async settings() { return structuredClone(settings); },
    async createSession(input) { return service.createSession(input); } }, undefined, undefined, {
    accept(input) {
      if (input.kind !== 'event') return;
      const event = input.event;
      if (event.sessionId === leaf && event.type === 'approval.requested') requested.resolve(event);
      if (event.sessionId === leaf && event.type === 'approval.reviewed'
        && event.payload.decision === 'ask' && event.payload.error?.code !== 'approval_review_invalid') handedOff.resolve(event);
      if (event.sessionId === leaf && event.type === 'approval.resolved') resolved.resolve(event);
      if (event.type === 'run.settled' && event.payload.outcome !== 'completed') failure.resolve(new Error(JSON.stringify(event.payload)));
      if (event.sessionId === root && event.type === 'run.settled') settled.resolve(event);
    }, failed(_sessionId, error) { throw error; },
  });
  t.after(async () => { releaseSibling.resolve(); for (const gate of releaseReview) gate.resolve(); await service.dispose(true); });
  await service.createSession({ sessionId: root, displayTitle: 'Owner', workspaceBindings: [workspaceBinding] });
  await service.submit(messageCommand(root, 'command:start', 'Delegate the check and wait for its completion.'));
  const pending = await checkpoint(requested);
  await checkpoint(sibling);
  if (outcome === 'manual') {
    for (const scenario of ['concurrent', 'replacement']) await checkArchivedApprovalRoutes(journal, root, leaf, pending, scenario);
  } else {
    await checkpoint(reviewing[0]);
    assert.deepEqual((await service.snapshot(root)).pendingAgentDecisions ?? [], [], 'active reviewer is not a human decision');
    releaseReview[0].resolve();
    if (nested) {
      await checkpoint(reviewing[1]);
      assert.deepEqual((await service.snapshot(root)).pendingAgentDecisions ?? [], [], 'a recorded first format failure is still being corrected');
      releaseReview[1].resolve();
    }
    if (outcome !== 'allow') await checkpoint(handedOff);
  }
  if (outcome !== 'allow') {
    const projection = await service.snapshot(root);
    assert.equal(projection.pendingApproval, null);
    assert.deepEqual(projection.pendingAgentDecisions, [{ agentSessionId: leaf, displayName: 'Executor', runId: pending.runId,
      approval: { approvalId: pending.payload.approvalId, callId: pending.callId }, interactionIds: [] }]);
    assert.equal((await service.snapshot(leaf)).run.status, 'running', 'the unrelated sibling must not delay a human decision');
    if (nested) {
      assert.notEqual((await service.snapshot(leaf)).agentContext.parentSessionId, root);
      const passive = new SessionService(journal, { async create() { assert.fail('a route read must not reopen any Actor'); } });
      try { assert.deepEqual((await passive.snapshot(root)).pendingAgentDecisions, projection.pendingAgentDecisions); }
      finally { await passive.dispose(); }
    }
    assert.equal(agentTurns.get(root), 1, 'the parent stays in its existing wait');
    const route = projection.pendingAgentDecisions[0];
    assert.equal((await service.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond',
      sessionId: route.agentSessionId, runId: route.runId, ...route.approval, commandId: 'command:human', decision: 'allow' })).status, 'accepted');
  }
  assert.equal((await checkpoint(resolved)).payload.source, outcome === 'allow' ? 'agent' : 'user');
  assert.deepEqual((await service.snapshot(root)).pendingAgentDecisions ?? [], []);
  releaseSibling.resolve();
  assert.equal((await checkpoint(settled)).payload.outcome, 'completed');
  assert.deepEqual(calls.map(call => [call.sessionId, call.runId, call.callId]), Array(2).fill([leaf, pending.runId, pending.callId]));
  assert.equal(calls[1].nonWorkspaceAuthority.decision, 'allow');
  assert.equal((await readEvents(journal, root)).some(event => event.type === 'approval.resolved' || event.type === 'approval.requested'), false);
});
