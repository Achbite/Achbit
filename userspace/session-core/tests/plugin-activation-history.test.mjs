import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { prepareContextCompaction, pressureCompactionCutoff } from '../dist/local-agent/compaction.js';
import { completedExecutionReply, runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

const sessionId = 'session:history', runId = 'run:first', requestId = 'request:batch';
const uri = 'plugin://inspect@local', workspaceBindings = [workspaceBinding];
const read = { name: 'fs.read', description: 'Read', toolBindingRef: 'binding:read', availability: 'callable',
  origin: 'coreBuiltin', possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
const search = { ...read, name: 'plugin.search', toolBindingRef: 'binding:search', possibleEffects: ['localRead'] };
const slot = key => ({ callId: `slot:${key}`, providerCallId: `native:${key}`, toolName: key === 'p' ? 'plugin.activate' : 'fs.read',
  arguments: JSON.stringify(key === 'p' ? { pluginUris: [uri] } : { path: key }, null, 1) });
const activation = slot('p'), plugin = { uri, skillEntryPath: '/skills/inspect/SKILL.md' };
const guidance = text => [() => [{ toolName: 'fs.read', text, contributionId: `plugin-activation:${activation.callId}` }]];

// Feed journal facts to the conversation composer without involving the scheduler under test elsewhere.
function history(keys, shape = 'aggregate', { standalone = false, rejected = false } = {}) {
  const events = [], calls = keys.map(slot);
  const runtime = runtimeSnapshot(runId, { tools: [read, search], apiSurface: shape === 'ordered' ? 'responses' : 'chatCompletions' });
  const add = (type, payload, callId, owner = runId) => {
    const sequence = events.length + 1;
    const event = { type, sessionId, runId: owner, sequence, eventId: `event:${sequence}`, payload, ...(callId ? { callId } : {}) };
    events.push(event);
    return event;
  };
  const compose = (more = {}) => buildConversationProviderRequest({ purpose: 'agent', responseConstraint: 'normal',
    sessionId, runId, runtime, workspaceBindings, events, providerRequestId: 'request:next', ...more });
  add('message.committed', { role: 'user', messageId: 'message:one', content: 'Inspect the files.' });
  add('run.started', { inputMessageId: 'message:one', runtimeSnapshot: runtime, workspaceBindings });
  const issued = compose({ providerRequestId: requestId });
  add('context.composed', issued.receipt);
  for (const { callId, providerCallId, toolName, arguments: raw } of calls) {
    if (toolName === 'plugin.activate') {
      if (rejected) add('session.control.rejected', { providerCallId, toolName, input: { pluginUris: [] },
        error: { code: 'empty_plugin_uris', message: 'Select a plugin.' } }, callId);
      else if (!standalone) add('session.plugins.requested', { providerRequestId: requestId, providerCallId,
        pluginUris: [uri], workspaceBindingIds: [workspaceBinding.workspaceId] }, callId);
    } else add('tool.requested', { providerCallId, toolName, input: JSON.parse(raw), attemptId: `attempt:${callId}` }, callId);
  }
  const success = () => add('session.plugins.activated', { providerCallId: activation.providerCallId,
    pluginUris: [uri], kernelCatalogSnapshotRef: 'catalog:published' }, activation.callId);
  if (standalone) success(); // The old standalone success preceded the Provider settlement.
  const orderedOutputBlocks = [{ outputIndex: 0, kind: 'reasoning', item: { type: 'reasoning', encrypted_content: 'opaque' } },
    ...calls.map((call, i) => ({ outputIndex: i + 1, kind: 'toolCall', callId: call.callId, providerCallId: call.providerCallId,
      toolName: call.toolName, item: { type: 'function_call', call_id: call.providerCallId, name: call.toolName.replace('.', '_'), arguments: call.arguments } }))];
  const settled = add('provider.turn.settled', { purpose: 'agent', providerRequestId: requestId,
    providerRuntimeRef: runtime.provider.providerRuntimeRef, outcome: 'completed', orderedCallIds: calls.map(c => c.callId),
    ...(shape === 'aggregate' ? { toolCallInputs: calls.map(call => ({ ...call, thoughtSignature: `sig:${call.providerCallId}` })) }
      : shape === 'ordered' ? { orderedOutputBlocks } : {}) });
  const complete = key => {
    const { callId, toolName, arguments: raw } = slot(key);
    const { record } = completedExecutionReply({ ...runtime, runId, sessionId, callId, toolName, input: JSON.parse(raw),
      attemptId: `attempt:${callId}`, toolBindingRef: read.toolBindingRef }, { content: `content:${key}` });
    add('tool.completed', { record }, callId);
  };
  const publish = () => {
    if (!standalone) { add('session.plugins.preparing', {}, activation.callId); success(); }
    add('run.tools.prepared', { toolView: { kernelCatalogSnapshotRef: 'catalog:published', extensionGenerationRef: runtime.extensionGenerationRef,
      instructions: runtime.instructions, toolPromptContributions: runtime.toolPromptContributions,
      providerToolAliases: [...runtime.providerToolAliases, { canonicalName: 'inspect.report', wireName: 'inspect_report' }],
      selectedPlugins: { ...runtime.selectedPlugins, plugins: [{ ...plugin, pluginArtifactRef: 'artifact:inspect', pluginInstanceRef: 'instance:inspect',
        extensionGenerationRef: runtime.extensionGenerationRef, capabilityRefs: [] }] }, tools: [...runtime.tools,
        { ...read, name: 'inspect.report', origin: 'extension', pluginUri: uri, toolBindingRef: 'binding:report' }] } });
  };
  return { events, runtime, add, compose, complete, publish, calls, settled, issued };
}

const batchMessages = request => request.messages.filter(m => m.toolCalls || m.providerOutputBlocks || m.role === 'tool');

for (const [shape, order] of [['aggregate', ['p', 'a', 'b']], ['ordered', ['a', 'p', 'b']], ['facts', ['a', 'b', 'p']]]) {
  test(`${shape}: one original assistant batch and one result per slot, regardless of completion order`, () => {
    const h = history(order, shape);
    h.complete('b');
    // An approval review can issue its own Provider request and read before a sibling finishes.
    const { modelView: _mainView, ...review } = h.issued.receipt;
    h.add('context.composed', { ...review, purpose: 'approvalReview', providerRequestId: 'request:review' });
    const r = slot('review');
    h.add('tool.requested', { providerCallId: r.providerCallId, toolName: r.toolName, input: { path: 'review' }, attemptId: 'attempt:review' }, r.callId);
    h.add('provider.turn.settled', { providerRequestId: 'request:review', providerRuntimeRef: h.runtime.provider.providerRuntimeRef,
      purpose: 'approvalReview', outcome: 'completed', orderedCallIds: [r.callId], toolCallInputs: [r] });
    h.complete('review');
    h.complete('a');
    h.publish();
    const saved = structuredClone(h.events);
    const [carrier, ...results] = batchMessages(h.compose({ toolGuidance: guidance('Published usage.') }).request);
    assert.deepEqual(results.map(m => [m.role, m.toolCallId, m.providerCallId, m.toolOutcome]),
      h.calls.map(c => ['tool', c.callId, c.providerCallId, 'completed']));
    if (shape === 'ordered') assert.deepEqual(carrier.providerOutputBlocks, h.settled.payload.orderedOutputBlocks);
    else assert.deepEqual(carrier.toolCalls, h.calls.map(call => ({ callId: call.callId, providerCallId: call.providerCallId,
      name: call.toolName.replace('.', '_'), input: shape === 'facts' ? JSON.parse(call.arguments) : call.arguments,
      ...(shape === 'aggregate' ? { thoughtSignature: `sig:${call.providerCallId}` } : {}) })));
    for (const [i, key] of order.entries()) {
      if (key === 'p') assert.deepEqual(JSON.parse(results[i].content), { activated: [uri], tools: [{ name: 'inspect.report' }],
        skillEntries: [{ uri, path: plugin.skillEntryPath }], guidance: 'Published usage.' });
      else assert.equal(results[i].content, `content:${key}`);
    }
    assert.deepEqual(h.events, saved, 'presentation order must not reorder the journal or rewrite raw blocks');
  });
}

test('call-fact-only input rejection occupies its source position even without an activation request', () => {
  const h = history(['a', 'p', 'b'], 'facts', { rejected: true });
  h.complete('b'); h.complete('a');
  const [carrier, ...results] = batchMessages(h.compose().request);
  assert.deepEqual(carrier.toolCalls.map(call => [call.providerCallId, call.input]), [
    ['native:a', { path: 'a' }], ['native:p', { pluginUris: [] }], ['native:b', { path: 'b' }],
  ]);
  assert.deepEqual(results.map(m => [m.providerCallId, m.toolOutcome]), [
    ['native:a', 'completed'], ['native:p', 'inputRejected'], ['native:b', 'completed'],
  ]);
  assert.equal(JSON.parse(results[1].content).executed, false);
});

for (const outcome of ['failed', 'notExecuted', 'indeterminate']) {
  test(`activation ${outcome} keeps its native result and its successful sibling`, () => {
    const h = history(['p', 'a']);
    h.complete('a');
    if (outcome !== 'notExecuted') h.add('session.plugins.preparing', {}, activation.callId);
    const error = { code: `activation_${outcome}`, message: 'Original activation evidence.' };
    h.add('session.plugins.failed', { outcome, error }, activation.callId);
    const [carrier, result, sibling] = batchMessages(h.compose().request);
    assert.deepEqual(carrier.toolCalls.map(c => c.providerCallId), ['native:p', 'native:a']);
    assert.deepEqual([result.toolOutcome, result.toolCallId, result.providerCallId], [outcome, 'slot:p', 'native:p']);
    const body = JSON.parse(result.content);
    assert.deepEqual(body.error, error);
    assert.equal(body.status, outcome);
    assert.equal(body.executed, outcome === 'notExecuted' ? false : undefined);
    assert.doesNotMatch(result.content, /retry|resubmit|re-?execute/iu);
    assert.deepEqual([sibling.providerCallId, sibling.content], ['native:a', 'content:a']);
  });
}

test('an unfinished activation cannot enter an agent request or a compaction prefix', () => {
  const h = history(['a', 'p']);
  h.complete('a');
  const cutoff = h.add('session.plugins.preparing', {}, activation.callId).sequence;
  const missing = error => error.code === 'tool_result_missing';
  assert.throws(() => h.compose({ events: h.events.filter(e => e.sequence <= cutoff) }), missing);
  assert.throws(() => prepareContextCompaction({ sessionId, runId, runtime: h.runtime, workspaceBindings, events: h.events,
    requestEvent: { payload: { providerRequestId: 'request:summary', coveredThroughSequence: cutoff } } }), missing);
});

test('later runs and summaries reuse the first frozen batch, then omit it when covered', () => {
  const h = history(['a', 'p', 'b'], 'ordered');
  h.complete('b'); h.complete('a'); h.publish();
  const cutoff = h.events.at(-1).sequence;
  const first = h.compose({ toolGuidance: guidance('First usage.') });
  const expected = batchMessages(first.request);
  assert.equal(expected.length, 4);
  assert.equal(JSON.parse(expected[2].content).guidance, 'First usage.');
  h.add('context.composed', first.receipt);
  h.add('provider.turn.settled', { purpose: 'agent', providerRequestId: first.request.requestId,
    providerRuntimeRef: h.runtime.provider.providerRuntimeRef, outcome: 'completed', orderedCallIds: [] });
  h.add('message.committed', { role: 'assistant', content: 'Done.', messageId: 'message:answer', providerRequestId: first.request.requestId });
  const next = 'run:next', runtime = runtimeSnapshot(next, { tools: [search] });
  h.add('message.committed', { role: 'user', messageId: 'message:two', content: 'Continue.' }, undefined, next);
  h.add('run.started', { inputMessageId: 'message:two', runtimeSnapshot: runtime, workspaceBindings }, undefined, next);
  const more = { runId: next, runtime, toolGuidance: guidance('Later usage.') };
  const replay = h.compose(more);
  assert.deepEqual(batchMessages(replay.request), expected);
  assert.ok(!replay.receipt.modelView.additions.some(c => c.message.role === 'tool'));
  const summary = prepareContextCompaction({ ...more, sessionId, workspaceBindings, events: h.events,
    requestEvent: { payload: { providerRequestId: 'request:summary', coveredThroughSequence: cutoff } } });
  assert.deepEqual(batchMessages(summary.request), expected);
  h.add('context.compacted', { compactionId: 'compact', coveredThroughSequence: cutoff, summary: 'Retained handoff.' }, undefined, next);
  const compacted = h.compose(more).request;
  assert.deepEqual(batchMessages(compacted), []);
  assert.ok(compacted.messages.some(m => m.content === 'Retained handoff.'));
});

test('old standalone activation can be replayed from call facts alone without a pending request marker', () => {
  const h = history(['p'], 'facts', { standalone: true });
  h.publish();
  const [carrier, result] = batchMessages(h.compose().request);
  assert.deepEqual(carrier.toolCalls.map(c => [c.callId, c.providerCallId]), [[activation.callId, activation.providerCallId]]);
  assert.equal(result.providerCallId, activation.providerCallId);
  assert.deepEqual(JSON.parse(result.content).activated, [uri]);
});

test('a settled activation alone constitutes progress for same-run pressure compaction', () => {
  const h = history(['p']);
  h.add('session.plugins.failed', { outcome: 'notExecuted', error: { code: 'cancelled', message: 'Stopped before dispatch.' } }, activation.callId);
  const revision = h.events.at(-1).sequence;
  assert.equal(pressureCompactionCutoff({ events: h.events, state: { revision } }, runId, h.issued.receipt, h.runtime, 1), revision);
});
