import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { loopSnapshot } from '../dist/local-agent/loop.js';
import { consumeProvider } from '../dist/local-agent/loopProvider.js';
import { decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { actorWith, completedExecutionReply, failedExecutionReply, createSession, emptyKernel, fakeRunPreparation, idFactory,
  messageCommand, providerEvent, readEvents, waitForProjection, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

const uri = 'plugin://inspector@local';
const search = { name: 'plugin.search', toolBindingRef: 'binding:search', description: 'Discover plugins.',
  origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {} } };
const read = { ...search, name: 'fs.read', toolBindingRef: 'binding:original', description: 'Read a file.',
  possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
const activate = { callId: 'native:activate', name: 'plugin_activate', arguments: JSON.stringify({ pluginUris: [uri] }) };
const file = path => ({ callId: `native:${path}`, name: 'fs_read', arguments: JSON.stringify({ path }) });
const future = { callId: 'native:future', name: 'inspector_report', arguments: ' { "mode" : "preview" } ', thoughtSignature: 'opaque-call-signature' };
const reasoning = { type: 'reasoning', id: 'reasoning:one', encrypted_content: 'opaque-reasoning' };
const nativeItem = call => ({ type: 'function_call', id: `item:${call.callId}`, call_id: call.callId, name: call.name,
  arguments: call.arguments, status: 'completed' });

async function batch(t, label, calls, { surface = 'aggregate', execute, prepareActivation, toolSelection } = {}) {
  const journal = new InMemoryCommandJournal(), sessionId = `session:${label}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [], executions = [], activations = [];
  const preparation = fakeRunPreparation({ tools: [search, read], contextWindowTokens: 32_000,
    apiSurface: surface === 'responses' ? 'responses' : 'chatCompletions' });
  const port = { ...preparation.port, async prepare(input) {
    if (input.modelActivation) { activations.push(input); await prepareActivation?.(input); }
    const prepared = await preparation.port.prepare(input);
    if (toolSelection) prepared.runtimeSnapshot.toolSelection = toolSelection;
    if (input.pluginSelections?.some(selection => selection.uri === uri)) {
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = 'catalog:activated';
      runtime.tools.find(tool => tool.name === read.name).toolBindingRef = 'binding:replacement';
      runtime.tools.push({ ...search, name: 'inspector.report', toolBindingRef: 'binding:report', origin: 'extension', pluginUri: uri });
      runtime.providerToolAliases.push({ canonicalName: 'inspector.report', wireName: 'inspector_report' });
    }
    return prepared;
  } };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      if (surface === 'responses') yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: reasoning });
      for (const [index, call] of calls.entries()) yield surface === 'aggregate'
        ? providerEvent(request.requestId, 'tool.call', call)
        : providerEvent(request.requestId, 'output.item.completed', { outputIndex: index + 1, item: nativeItem(call) });
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'Batch processed.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    executions.push(request);
    return execute ? await execute(request) : completedExecutionReply(request, { content: `Read ${request.input.path}` });
  } }), port, label);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, `command:${label}`, 'Inspect the files and activate the plugin.'));
  return { actor, journal, sessionId, requests, executions, activations };
}

async function finish({ actor, journal, sessionId, requests }) {
  const final = await waitForProjection(actor, s => ['completed', 'failed', 'indeterminate', 'cancelled'].includes(s.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  assert.equal(requests.length, 2, 'no sibling needs to be submitted again');
  return { events: await readEvents(journal, sessionId), results: requests[1].messages.filter(m => m.role === 'tool') };
}

for (const surface of ['aggregate', 'responses']) {
  for (const [position, index] of [['first', 0], ['middle', 2], ['last', 3]]) {
    test(`${surface}, activation ${position}: execute original bindings; preserve the future alias as rejected native input`, async t => {
      const calls = [file('a'), future, file('b')];
      calls.splice(index, 0, activate);
      const run = await batch(t, `batch-${surface}-${position}`, calls, { surface });
      const { events, results } = await finish(run);
      const issued = events.find(e => e.type === 'context.composed' && e.payload.providerRequestId === run.requests[0].requestId);
      assert.deepEqual(run.executions.map(r => [r.input.path, r.toolBindingRef, r.kernelCatalogSnapshotRef]),
        ['a', 'b'].map(path => [path, 'binding:original', issued.payload.kernelCatalogSnapshotRef]));
      assert.equal(run.activations.length, 1);
      assert.deepEqual(run.requests.map(request => request.tools.some(tool => tool.name === future.name)), [false, true]);
      assert.deepEqual(results.map(m => m.providerCallId), calls.map(c => c.callId));
      assert.equal(new Set(results.map(m => m.toolCallId)).size, calls.length);
      assert.ok(results.every(m => m.toolCallId && m.toolCallId !== m.providerCallId));
      assert.deepEqual(JSON.parse(results[index].content).activated, [uri]);
      const unknown = results.find(m => m.providerCallId === future.callId);
      assert.equal(unknown.toolOutcome, 'inputRejected');
      const rejection = JSON.parse(unknown.content);
      assert.equal(rejection.executed, false);
      assert.equal(rejection.error.code, 'provider_tool_alias_unknown');
      assert.deepEqual(rejection.error.issues.map(i => i.rule), ['declared_tool']);

      const turns = events.filter(e => e.type === 'provider.turn.settled' && e.payload.providerRequestId === issued.payload.providerRequestId);
      assert.equal(turns.length, 1);
      const settled = turns[0].payload;
      assert.deepEqual(settled.orderedCallIds, results.filter(m => m !== unknown).map(m => m.toolCallId));
      const registered = events.filter(e => e.type === 'tool.requested' || e.type === 'session.plugins.requested');
      assert.deepEqual(registered.map(e => [e.payload.providerCallId, e.callId]),
        results.filter(m => m !== unknown).map(m => [m.providerCallId, m.toolCallId]));
      assert.ok(registered.every(e => e.sequence < turns[0].sequence));
      const carriers = run.requests[1].messages.filter(m => m.toolCalls || m.providerOutputBlocks);
      assert.equal(carriers.length, 1);
      if (surface === 'aggregate') {
        assert.deepEqual(settled.toolCallInputs.map(c => [c.providerCallId, c.arguments, c.thoughtSignature]),
          calls.map(c => [c.callId, c.arguments, c.thoughtSignature]));
        assert.deepEqual(carriers[0].toolCalls.map(c => [c.providerCallId, c.callId, c.name, c.input, c.thoughtSignature]),
          calls.map((c, i) => [c.callId, results[i].toolCallId, c.name, c.arguments, c.thoughtSignature]));
      } else {
        assert.deepEqual(settled.orderedOutputBlocks.map(b => [b.outputIndex, b.item]),
          [reasoning, ...calls.map(nativeItem)].map((item, i) => [i, item]));
        assert.deepEqual(settled.orderedOutputBlocks.slice(1).map(b => [b.kind, b.callId]),
          results.map(m => [m === unknown ? 'toolCallRejected' : 'toolCall', m.toolCallId]));
        assert.deepEqual(carriers[0].providerOutputBlocks, settled.orderedOutputBlocks);
      }
    });
  }
}

test('both reads start, B completes while A is held, then the activation prepares; the model sees A before B', async t => {
  const gates = { a: Promise.withResolvers(), b: Promise.withResolvers() };
  t.after(() => { gates.a.resolve(); gates.b.resolve(); });
  const run = await batch(t, 'batch-overlap', [activate, file('a'), file('b')], { async execute(request) {
    await gates[request.input.path].promise;
    return completedExecutionReply(request, { content: `Read ${request.input.path}` });
  } });
  await waitUntil(() => run.executions.length === 2, 'both reads started before either was released');
  gates.b.resolve();
  const id = path => run.executions.find(r => r.input.path === path).callId;
  const state = await waitForProjection(run.actor, s => s.activities.some(a => a.callId === id('b') && a.status === 'completed'));
  assert.notEqual(state.activities.find(a => a.callId === id('a'))?.status, 'completed');
  assert.deepEqual(run.activations, []);
  assert.equal(run.requests.length, 1);
  gates.a.resolve();
  const { events, results } = await finish(run);
  assert.deepEqual(events.filter(e => e.type === 'tool.completed' || e.type === 'session.plugins.preparing')
    .map(e => e.callId), [id('b'), id('a'), results[0].toolCallId]);
  assert.deepEqual(results.map(m => m.providerCallId), ['native:activate', 'native:a', 'native:b']);
  assert.deepEqual(results.slice(1).map(m => m.content), ['Read a', 'Read b']);
});

test('an outstanding approval blocks activation, not its sibling; denial and a directory edit do not rebind either call', async t => {
  const run = await batch(t, 'batch-approval', [file('gated'), file('independent'), activate], { async execute(request) {
    if (request.input.path === 'gated' && !request.nonWorkspaceAuthority) return {
      schemaVersion: 'achbit.kernel-reply', type: 'tool.execution', requestId: request.requestId, callId: request.callId,
      status: 'approvalRequired', approvalId: 'kernel:gated', preview: { summary: 'Review gated file', effects: ['workspaceRead'], logicalTargets: ['gated'] },
    };
    const reply = completedExecutionReply(request, { content: 'Independent read.' });
    if (request.nonWorkspaceAuthority?.decision === 'deny') {
      reply.status = reply.record.outcome = 'denied'; delete reply.record.output;
      reply.record.authority = { decision: 'deny', source: 'user', authorityId: request.nonWorkspaceAuthority.authorityId };
    }
    return reply;
  } });
  const state = await waitForProjection(run.actor, s => s.pendingApproval
    && s.activities.some(a => a.callId === run.executions.find(r => r.input.path === 'independent')?.callId && a.status === 'completed'));
  assert.deepEqual(run.activations, []);
  assert.equal(run.requests.length, 1);
  const attached = { workspaceId: 'workspace:new', displayName: 'New directory' };
  assert.equal((await run.actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.attach', sessionId: run.sessionId,
    commandId: 'command:attach', workspaceBinding: attached })).status, 'accepted');
  const { runId, callId, approvalId } = state.pendingApproval;
  assert.equal((await run.actor.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond', sessionId: run.sessionId,
    commandId: 'command:deny', runId, callId, approvalId, decision: 'deny' })).status, 'accepted');
  const { events, results } = await finish(run);
  assert.deepEqual(run.activations.map(a => a.workspaceBindingIds), [[workspaceBinding.workspaceId]]);
  assert.deepEqual(run.requests[1].workspaceBindings.map(b => b.workspaceId), [workspaceBinding.workspaceId, attached.workspaceId]);
  assert.deepEqual(run.executions.map(r => [r.input.path, r.toolBindingRef]), [['gated', 'binding:original'], ['independent', 'binding:original'], ['gated', 'binding:original']]);
  assert.deepEqual(results.map(m => m.providerCallId), ['native:gated', 'native:independent', 'native:activate']);
  assert.deepEqual(results.slice(0, 2).map(m => m.toolOutcome), ['denied', 'completed']);
  assert.deepEqual(JSON.parse(results[2].content).activated, [uri]);
  assert.ok(events.find(e => e.type === 'session.plugins.preparing').sequence > events.find(e => e.type === 'tool.completed' && e.callId === callId).sequence);
});

test('preparation failure preserves the success and original error of independent reads', async t => {
  const run = await batch(t, 'batch-partial', [file('ok'), activate, file('bad')], {
    prepareActivation() { throw new Error('The selected inspector is disabled.'); },
    execute: request => request.input.path === 'ok' ? completedExecutionReply(request, { content: 'Already read.' })
      : failedExecutionReply(request, {}, { code: 'original_read_failure', message: 'Could not read this file.' }),
  });
  const { events, results } = await finish(run);
  assert.deepEqual(results.map(m => [m.providerCallId, m.toolOutcome]), [['native:ok', 'completed'], ['native:activate', 'failed'], ['native:bad', 'failed']]);
  assert.equal(results[0].content, 'Already read.');
  assert.match(results[1].content, /selected inspector is disabled/u);
  assert.match(results[2].content, /Could not read this file/u);
  assert.deepEqual(run.executions.map(r => r.input.path), ['ok', 'bad']);
  assert.equal(run.activations.length, 1);
  assert.equal(events.some(e => e.type === 'session.plugins.activated'), false);
  assert.equal(run.requests[1].tools.some(tool => tool.name === future.name), false);
});

for (const [surface, raw, code] of [['aggregate', '{ "pluginUris" : [] }', 'plugin_selection_invalid'],
  ['responses', '{"pluginUris":', 'provider_tool_call_arguments_invalid']]) {
  test(`${surface}: invalid activation arguments reject one slot, not the enclosing response`, async t => {
    const run = await batch(t, `invalid-${surface}`, [file('before'), { ...activate, arguments: raw }, file('after')], { surface });
    const { results } = await finish(run);
    assert.deepEqual(run.executions.map(r => r.input.path), ['before', 'after']);
    assert.deepEqual(run.activations, []);
    assert.deepEqual(results.map(m => [m.providerCallId, m.toolOutcome]), [['native:before', 'completed'], ['native:activate', 'inputRejected'], ['native:after', 'completed']]);
    const rejected = JSON.parse(results[1].content);
    assert.equal(rejected.executed, false);
    assert.equal(rejected.error.code, code);
    if (code === 'plugin_selection_invalid') assert.match(rejected.error.message, /\$\.pluginUris/u);
  });
}

for (const [kind, other, expected] of [
  ['two-activations', { ...activate, callId: 'native:second' }, ['control_turn_source', 'control_turn_source', 'control_turn_peer']],
  ['invalid-todo', { name: 'todo_update', callId: 'native:todo', arguments: '{' }, ['control_turn_source', 'json_object', 'control_turn_peer']],
]) {
  test(`${kind}: reject the entire mixed batch before effects, retaining each independent field error`, async t => {
    const calls = [activate, other, file('held')];
    const run = await batch(t, `conflict-${kind}`, calls);
    const { events, results } = await finish(run);
    assert.deepEqual(results.map(m => m.providerCallId), calls.map(c => c.callId));
    const rejected = results.map(m => JSON.parse(m.content));
    assert.ok(rejected.every(e => e.executed === false));
    assert.deepEqual(rejected.map(e => e.error.issues.map(i => i.rule)), expected.map(rule => [rule]));
    assert.deepEqual(rejected.map(e => e.error.code), expected.map(rule => rule === 'json_object' ? 'provider_tool_call_arguments_invalid' : 'session_control_turn_conflict'));
    assert.deepEqual(run.activations, []); assert.deepEqual(run.executions, []);
    assert.equal(events.some(e => e.type === 'session.plugins.requested' || e.type === 'tool.requested' || e.type === 'todo.updated'), false);
  });
}

test('an undeclared activation spelling does not impose batch rules or expand a restricted tool view', async t => {
  const run = await batch(t, 'batch-restricted', [activate, file('allowed')], { toolSelection: { kernel: ['fs.read'], controls: [], plugins: false } });
  const { results } = await finish(run);
  assert.ok(run.requests.every(request => !request.tools.some(t => t.name === activate.name || t.name === future.name)));
  assert.deepEqual(results.map(m => m.providerCallId), [activate.callId, 'native:allowed']);
  assert.equal(JSON.parse(results[0].content).error.code, 'provider_tool_alias_unknown');
  assert.equal(results[1].content, 'Read allowed');
  assert.deepEqual(run.executions.map(r => r.input.path), ['allowed']);
  assert.deepEqual(run.activations, []);
});

test('a repeated native ID across owners makes the entire response uninterpretable', async t => {
  const run = await batch(t, 'batch-duplicate', [file('a'), { ...activate, callId: 'native:a' }]);
  const state = await waitForProjection(run.actor, s => s.run?.status === 'failed');
  assert.equal(state.terminalError.code, 'provider_tool_call_duplicate');
  assert.deepEqual(run.activations, []); assert.deepEqual(run.executions, []);
  const events = await readEvents(run.journal, run.sessionId);
  assert.equal(events.some(e => e.type === 'session.plugins.requested' || e.type === 'tool.requested'), false);
});

for (const outcome of ['published', 'indeterminate']) {
  test(`a compacted replay cannot repeat the native activation ID (${outcome})`, async t => {
    const drain = Promise.withResolvers();
    t.after(() => drain.resolve());
    const run = await batch(t, `replay-${outcome}`, [activate], { prepareActivation: () => outcome === 'indeterminate' ? drain.promise : undefined });
    if (outcome === 'published') await finish(run);
    else {
      await waitUntil(() => run.activations.length > 0, 'activation preparing');
      const cancelled = run.actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', commandId: 'command:interrupt',
        sessionId: run.sessionId, runId: run.activations[0].runId });
      await waitUntil(async () => (await run.journal.readCommand(run.sessionId, 'command:interrupt'))?.reply.status === 'accepted', 'cancel admitted during preparation');
      drain.resolve(); await cancelled;
    }
    const events = await readEvents(run.journal, run.sessionId);
    assert.ok(events.some(e => outcome === 'published' ? e.type === 'session.plugins.activated'
      : e.type === 'session.plugins.failed' && e.payload.outcome === 'indeterminate'));
    const snapshot = loopSnapshot(run.sessionId, events);
    const { runId, payload } = events.find(e => e.type === 'run.started');
    // Model input omits the earlier result; the decoder still receives the actual journal snapshot.
    const { request, toolCodec } = buildConversationProviderRequest({ sessionId: run.sessionId, runId, purpose: 'agent',
      providerRequestId: 'request:replay', responseConstraint: 'normal', runtime: payload.runtimeSnapshot, workspaceBindings: [workspaceBinding], events: [] });
    assert.equal(request.messages.some(m => m.role === 'tool'), false);
    const decode = (nativeId, replaying) => consumeProvider(request, toolCodec, runId, {
      nextId: idFactory('decode'), updateAssistantDraft() {}, commit: async () => snapshot, readSnapshot: async () => snapshot,
      composition: { provider: { async *stream(attempt) {
        yield providerEvent(attempt.requestId, 'tool.call', { ...activate, callId: nativeId });
        yield providerEvent(attempt.requestId, 'completed', {});
      } } },
    }, new AbortController().signal, { decode: decodeSessionControlCall }, replaying);
    await assert.rejects(decode(activate.callId, true), { code: 'provider_tool_call_duplicate' });
    for (const [id, replaying] of [['native:fresh', true], [activate.callId, false]]) {
      const turn = await decode(id, replaying);
      assert.equal(turn.kind, 'tools');
      assert.deepEqual(turn.calls.map(call => [call.owner, call.providerCallId, call.pluginUris]), [['activation', id, [uri]]]);
    }
  });
}
