import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_EVENT_VERSION } from '@achbit/protocol';
import { admitSessionEvents } from '../dist/local-agent/admission.js';
import { loopSnapshot } from '../dist/local-agent/loop.js';
import { projectTranscriptFacts } from '../dist/local-agent/reducer.js';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';

const sessionId = 'session:activation', runId = 'run:activation', callId = 'call:activation';
const providerRequestId = 'request:activation', providerCallId = 'native:activation';
const uri = 'plugin://reader@local', directory = workspaceBinding.workspaceId;
const runtime = runtimeSnapshot(runId);
const event = (type, payload, extra = {}) => ({ sessionId, runId, type, payload, ...extra });
const launch = [
  { sessionId, type: 'session.created', payload: { displayTitle: 'Activation', workspaceBindings: [workspaceBinding] } },
  { sessionId, type: 'input.accepted', payload: { commandId: 'cmd:one', messageId: 'msg:one', text: 'Read.' } },
  { sessionId, type: 'message.committed', payload: { messageId: 'msg:one', role: 'user', content: 'Read.' } },
  event('run.started', { inputMessageId: 'msg:one', workspaceBindings: [workspaceBinding], runtimeSnapshot: runtime }),
];
const offer = { itemId: 'plugin.activate', canonicalName: 'plugin.activate', wireName: 'plugin_activate',
  label: 'plugin_activate', origin: 'sessionControl', availability: 'callable' };
const composition = event('context.composed', { purpose: 'agent', providerRequestId, responseConstraint: 'normal',
  kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef, dynamicInstructionBytes: 0, messages: [],
  modelView: { throughSequence: launch.length, additions: [] }, tools: [offer],
  workspaceBindings: [{ itemId: directory, label: workspaceBinding.displayName }],
  partitions: ['instructions', 'sessionControls', 'tools', 'workspaceBindings', 'contextProviders', 'journalMessages', 'filesystemReferences']
    .map(kind => ({ kind, itemCount: 1, requestShapeUnits: 1 })),
});
const requested = event('session.plugins.requested', { providerRequestId, providerCallId, pluginUris: [uri], workspaceBindingIds: [directory] }, { callId });
const preparing = event('session.plugins.preparing', {}, { callId });
const fail = outcome => event('session.plugins.failed', { outcome, error: { code: 'fixture_error', message: 'No result.' } }, { callId });
const activated = event('session.plugins.activated', { providerCallId, pluginUris: [uri], kernelCatalogSnapshotRef: 'catalog:new' }, { callId });
const view = Object.fromEntries(['kernelCatalogSnapshotRef', 'extensionGenerationRef', 'tools', 'instructions', 'toolPromptContributions',
  'providerToolAliases', 'selectedPlugins'].map(key => [key, runtime[key]]));
const prepared = event('run.tools.prepared', { toolView: { ...view, kernelCatalogSnapshotRef: 'catalog:new',
  selectedPlugins: { catalogRevision: 'catalog:revision', plugins: [{ uri, pluginArtifactRef: 'artifact:reader',
    pluginInstanceRef: 'instance:reader', extensionGenerationRef: view.extensionGenerationRef, capabilityRefs: [] }] } } });
const input = { callId, providerCallId, toolName: 'plugin.activate', arguments: JSON.stringify({ pluginUris: [uri] }) };
const settled = event('provider.turn.settled', { purpose: 'agent', providerRequestId, providerRuntimeRef: runtime.provider.providerRuntimeRef,
  outcome: 'completed', orderedCallIds: [callId], toolCallInputs: [input] });
const ordered = event('provider.turn.settled', { ...settled.payload, orderedOutputBlocks: [{ kind: 'toolCall', callId, providerCallId,
  toolName: 'plugin.activate', outputIndex: 0, item: { type: 'function_call', name: offer.wireName, call_id: providerCallId, arguments: input.arguments } }] });
delete ordered.payload.toolCallInputs;
const finishing = event('run.finishing', { outcome: 'cancelled' });
const released = event('run.runtime.released', { runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef, extensionGenerationRef: runtime.extensionGenerationRef,
  kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef, providerRuntimeRef: runtime.provider.providerRuntimeRef, pluginInstanceRefs: [], alreadyReleased: false });
const closed = event('run.settled', finishing.payload);
const stored = (fact, index) => ({ ...structuredClone(fact), sequence: index + 1, occurredAt: '1', eventId: `event:${index + 1}`, schemaVersion: SESSION_EVENT_VERSION });
const snapshot = (...tail) => loopSnapshot(sessionId, [...launch, ...tail].map(stored));
const payload = (fact, fields) => ({ ...fact, payload: { ...fact.payload, ...fields } });
const activity = current => Object.values(current.state.activities).find(item => item.callId === callId);

for (const [form, turn] of [['aggregate', settled], ['ordered', ordered]]) {
  test(`${form}: activation registers its call exactly once; publication consumes only the matching slot`, () => {
    assert.doesNotThrow(() => admitSessionEvents(snapshot(composition), [requested, turn]));
    const current = snapshot(composition, requested, turn);
    assert.deepEqual(current.state.pendingPluginActivation, { ...requested.payload, callId, runId, phase: 'requested' });
    assert.equal(activity(current).status, 'requested');
    assert.deepEqual(activity(current).tool.resources.map(item => item.label), [uri]);
    assert.doesNotThrow(() => admitSessionEvents(current, [preparing, activated, prepared]));
    const ready = snapshot(composition, requested, turn, preparing);
    assert.equal(ready.state.pendingPluginActivation.phase, 'preparing');
    assert.equal(activity(ready).status, 'active');
    const result = snapshot(composition, requested, turn, preparing, activated, prepared);
    assert.equal(result.state.pendingPluginActivation, undefined);
    assert.deepEqual(result.state.providerCallFacts, current.state.providerCallFacts);
    assert.equal(activity(result).status, 'completed');
    assert.equal(activity(result).tool.recordId, undefined);
    assert.equal(activity(result).sequence, activity(current).sequence);
    assert.equal(result.state.runToolViews[runId].kernelCatalogSnapshotRef, 'catalog:new');
    assert.throws(() => admitSessionEvents(ready, [activated]));
    assert.throws(() => admitSessionEvents(ready, [activated, payload(prepared, { toolView: view })]));
    for (const wrong of [payload(activated, { providerCallId: 'native:other' }), payload(activated, { pluginUris: ['plugin://other@local'] }), { ...activated, callId: 'call:other' }]) {
      assert.throws(() => admitSessionEvents(ready, [wrong, prepared]));
    }
    assert.throws(() => admitSessionEvents(result, [activated, prepared]));
    assert.throws(() => admitSessionEvents(ready, [preparing]));
    const wrongArgs = structuredClone(turn);
    (wrongArgs.payload.toolCallInputs?.[0] ?? wrongArgs.payload.orderedOutputBlocks[0].item).arguments = JSON.stringify({ pluginUris: ['plugin://other@local'] });
    assert.throws(() => admitSessionEvents(snapshot(composition), [requested, wrongArgs]), /plugin_activation_input_mismatch/);
  });
}

test('a new activation is bound to the unfinished agent request, its declared control and its captured directory set', () => {
  const current = snapshot(composition);
  const after = snapshot(composition, requested, settled);
  for (const offerOverride of [[], [{ ...offer, availability: 'blocked' }], [{ ...offer, origin: 'extension' }]]) {
    assert.throws(() => admitSessionEvents(snapshot(payload(composition, { tools: offerOverride })), [requested, settled]));
  }
  for (const fields of [{ providerRequestId: 'request:other' }, { workspaceBindingIds: [] }, { providerCallId: callId }]) {
    assert.throws(() => admitSessionEvents(current, [payload(requested, fields), settled]));
  }
  assert.doesNotThrow(() => admitSessionEvents(current, [activated, settled, prepared]), 'legacy writer: standalone result, turn, then view');
  assert.throws(() => admitSessionEvents(snapshot(payload(composition, { tools: [] })), [activated, settled, prepared]), /plugin_activation_source_missing/);
  assert.throws(() => admitSessionEvents(current, [requested]), /plugin_activation_turn_missing/);
  const legacyEvidence = structuredClone(settled); delete legacyEvidence.payload.toolCallInputs;
  assert.throws(() => admitSessionEvents(current, [requested, legacyEvidence]), /plugin_activation_call_mismatch/);
  const second = { ...input, callId: 'call:two', providerCallId: 'native:two' };
  assert.throws(() => admitSessionEvents(current, [requested, payload(settled, { toolCallInputs: [input, second] })]), /plugin_activation_batch_invalid/);
  assert.throws(() => admitSessionEvents(current, [requested, payload(settled, { toolCallInputs: [input, { ...second, providerCallId }] })]), /plugin_activation_call_mismatch/);
  const minimal = loopSnapshot(sessionId, [...launch.slice(0, -1), payload(launch.at(-1), { runtimeSnapshot: { ...runtime, mode: 'minimal' } }), composition].map(stored));
  assert.throws(() => admitSessionEvents(minimal, [requested, settled]), /plugin_activation_source_missing/);
  assert.throws(() => admitSessionEvents(current, [requested, { ...requested, callId: 'call:two' }, settled]));
  assert.throws(() => admitSessionEvents(after, [requested, settled]));
  assert.throws(() => admitSessionEvents(after, [event('session.control.completed', { providerCallId: 'native:other', operation: { action: 'describe' }, result: {} }, { callId: 'call:other' })]));
  assert.throws(() => admitSessionEvents(current, [preparing]));
  assert.throws(() => admitSessionEvents(after, [activated, prepared]));
  assert.throws(() => admitSessionEvents(after, [payload(composition, { providerRequestId: 'request:next' })]));
  const edited = event('session.workspaces.updated', { commandId: 'cmd:edit', baseBindings: [], workspaceBindings: [] });
  delete edited.runId;
  assert.doesNotThrow(() => admitSessionEvents(snapshot(composition, edited), [requested, settled]));
  assert.throws(() => admitSessionEvents(snapshot(composition, edited), [payload(requested, { workspaceBindingIds: [] }), settled]));
  const file = { referenceId: 'ref:file', workspaceId: 'workspace:attachment', logicalPath: 'evidence.txt', displayName: 'evidence.txt', kind: 'file' };
  const fileHistory = [...launch.slice(0, 2), payload(launch[2], { filesystemReferences: [file] }), launch[3]];
  const withFile = payload(composition, { workspaceBindings: [...composition.payload.workspaceBindings, { itemId: file.workspaceId, label: file.displayName }] });
  const fileSnapshot = loopSnapshot(sessionId, [...fileHistory, withFile].map(stored));
  assert.doesNotThrow(() => admitSessionEvents(fileSnapshot, [requested, settled]));
  assert.throws(() => admitSessionEvents(fileSnapshot, [payload(requested, { workspaceBindingIds: [directory, file.workspaceId] }), settled]), /plugin_activation_directory_mismatch/);
});

test('preparing waits for ordinary siblings; release preserves not-started versus indeterminate evidence until the run closes', () => {
  const tool = event('tool.requested', { providerCallId: 'native:tool', attemptId: 'attempt:tool', toolName: 'bash', input: { command: 'pwd' } }, { callId: 'call:tool' });
  const toolOffer = { itemId: 'bash', canonicalName: 'bash', wireName: 'bash', label: 'bash', origin: 'coreBuiltin', availability: 'callable' };
  const mixed = payload(settled, { orderedCallIds: [callId, 'call:tool'], toolCallInputs: [input,
    { callId: 'call:tool', providerCallId: 'native:tool', toolName: 'bash', arguments: '{"command":"pwd"}' }] });
  const committed = [payload(composition, { tools: [offer, toolOffer] }), requested, tool, mixed];
  assert.throws(() => admitSessionEvents(snapshot(...committed), [preparing]), /plugin_activation_siblings_pending/);
  const gate = event('approval.requested', { approvalId: 'approval:tool', preview: { summary: 'Read?', effects: ['process'], logicalTargets: [], approvalReviewer: 'agent' } }, { callId: 'call:tool' });
  const waiting = snapshot(...committed, gate, event('run.waiting', { reason: 'approval' }));
  const review = payload(composition, { purpose: 'approvalReview', responseConstraint: 'answerOnly', tools: [], providerRequestId: 'request:review' });
  delete review.payload.modelView;
  assert.doesNotThrow(() => admitSessionEvents(waiting, [review]));
  assert.doesNotThrow(() => admitSessionEvents(waiting, [fail('notExecuted')]));
  assert.throws(() => admitSessionEvents(waiting, [payload(composition, { purpose: 'contextCompaction', providerRequestId: 'request:compaction' })]), /plugin_activation_pending/);
  const skipped = event('tool.not-executed', { attemptId: 'attempt:tool', reason: 'cancelled' }, { callId: 'call:tool' });
  assert.doesNotThrow(() => admitSessionEvents(snapshot(...committed, skipped), [preparing]));
  for (const [phase, valid, invalid] of [[[], ['notExecuted'], ['indeterminate', 'failed']], [[preparing], ['failed', 'indeterminate'], ['notExecuted']]]) {
    const history = [composition, requested, settled, ...phase];
    for (const terminal of [[], [finishing, released]]) {
      const current = snapshot(...history, ...terminal);
      for (const outcome of valid) {
        const failure = fail(outcome);
        assert.doesNotThrow(() => admitSessionEvents(current, [failure, ...(terminal.length ? [closed] : [])]));
        const ended = snapshot(...history, ...terminal, failure);
        assert.equal(ended.state.pendingPluginActivation, undefined);
        assert.deepEqual(ended.state.providerCallFacts, current.state.providerCallFacts);
        assert.equal(activity(ended).status, outcome === 'notExecuted' ? 'cancelled' : outcome);
        assert.deepEqual(activity(ended).tool.error, failure.payload.error);
        assert.equal(activity(ended).tool.recordId, undefined);
        assert.equal(activity(ended).inputRejection, undefined);
      }
      for (const outcome of invalid) assert.throws(() => admitSessionEvents(current, [fail(outcome)]));
      assert.throws(() => admitSessionEvents(current, [{ ...fail(valid[0]), callId: 'call:other' }]));
      assert.throws(() => admitSessionEvents(current, [fail(valid[0]), fail(valid[0])]));
      if (terminal.length) assert.throws(() => admitSessionEvents(current, [closed]));
    }
  }
});

test('archive transcript reads with only composition headers do not require new-write admission; standalone history remains readable', async () => {
  for (const tail of [[requested, ordered, preparing, activated, prepared], [activated, settled, prepared]]) {
    const journal = new InMemoryCommandJournal();
    await journal.createSession({ sessionId, ...launch[0].payload });
    await journal.appendBatch([...launch.slice(1), composition, ...tail]);
    const facts = await journal.readTranscriptFacts(sessionId);
    assert.equal(facts.events.some(e => e.type === 'context.composed'), false);
    const page = projectTranscriptFacts(sessionId, facts);
    assert.equal(page.current.run.runId, runId);
    const recovered = snapshot(composition, ...tail);
    assert.equal(recovered.state.providerCallFacts[callId].providerCallId, providerCallId);
    assert.equal(activity(recovered)?.status, tail[0] === requested ? 'completed' : undefined);
    assert.deepEqual(page.content.activities.find(item => item.callId === callId), activity(recovered));
  }
  // A field-selected archive can retain terminal evidence without the registration page.
  // It should remain readable, but must not synthesize a runnable slot or a Kernel activity.
  const partial = projectTranscriptFacts(sessionId, { sessionId, tip: '8:event:8', revision: 8, start: 7, end: 8,
    previous: 1, next: null, navigation: [], compositions: [],
    events: [...launch.map(stored), stored(preparing, 6), stored(fail('indeterminate'), 7)] });
  assert.ok(!partial.content.activities.some(item => item.callId === callId));
});

test('public journal schema requires both identities and exact per-phase payloads', () => {
  for (const fact of [requested, preparing, activated, fail('failed'), fail('notExecuted'), fail('indeterminate')]) {
    assertRuntimeContract('SessionEvent', stored(fact, 0));
    for (const key of ['runId', 'callId']) {
      const missing = stored(fact, 0); delete missing[key];
      assert.throws(() => assertRuntimeContract('SessionEvent', missing));
    }
    assert.throws(() => assertRuntimeContract('SessionEvent', stored(payload(fact, { extra: true }), 0)));
  }
  for (const wrong of [payload(requested, { pluginUris: [] }), payload(requested, { pluginUris: [uri, uri] }),
    payload(requested, { pluginUris: ['plugin://uncatalogued'] }), payload(requested, { workspaceBindingIds: [directory, directory] }),
    fail('completed'), payload(fail('failed'), { error: { code: 'no_message' } })]) {
    assert.throws(() => assertRuntimeContract('SessionEvent', stored(wrong, 0)));
  }
});
