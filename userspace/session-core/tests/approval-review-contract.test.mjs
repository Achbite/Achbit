import assert from 'node:assert/strict';
import test from 'node:test';
import { admitSessionEvents } from '../dist/local-agent/admission.js';
import { prepareApprovalReview } from '../dist/local-agent/approvalReview.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { loopSnapshot } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { createSession, readEvents, runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

const sessionId = 'session:review-contract';
const runId = 'run:review-contract';
const requestId = 'request:review-contract';
const runtime = runtimeSnapshot(runId, { apiSurface: 'responses', hostedWebSearch: 'web_search',
  webSearch: { owner: 'providerHosted', providerToolType: 'web_search' } });
const event = (type, payload, extra = {}) => ({ type, sessionId, runId, payload, ...extra });
const rejected = { code: 'unknown_tool', message: 'Only evidence reads are allowed.',
  issues: [{ path: '$.name', rule: 'tool', message: 'Not an evidence read.' }] };
const call = (toolName = 'fs.read') => event('tool.requested', {
  providerCallId: 'provider:read', attemptId: 'attempt:read', toolName, input: {},
}, { callId: 'call:read' });
const settlement = (fields = {}) => event('provider.turn.settled', {
  purpose: 'approvalReview', providerRequestId: requestId, providerRuntimeRef: runtime.provider.providerRuntimeRef,
  outcome: 'completed', orderedCallIds: ['call:read'], ...fields,
});

async function snapshot(...extra) {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  await journal.append({ type: 'input.accepted', sessionId,
    payload: { commandId: 'command:input', messageId: 'message:input', text: 'Inspect the change.' } });
  await journal.append({ type: 'message.committed', sessionId,
    payload: { messageId: 'message:input', role: 'user', content: 'Inspect the change.', filesystemReferences: [], pluginSelections: [] } });
  await journal.append(event('run.started', { inputMessageId: 'message:input', workspaceBindings: [], runtimeSnapshot: runtime }));
  const receipt = { providerRequestId: requestId, purpose: 'approvalReview', responseConstraint: 'normal',
    dynamicInstructionBytes: 0, messages: [], workspaceBindings: [], tools: [],
    reviewInput: { instructions: 'Read the exact evidence.', content: 'original evidence '.repeat(2000) },
    partitions: ['instructions', 'sessionControls', 'tools', 'workspaceBindings', 'contextProviders', 'journalMessages', 'filesystemReferences']
      .map(kind => ({ kind, itemCount: 0, requestShapeUnits: kind === 'instructions' ? 1 : 0 })) };
  assertRuntimeContract('ContextCompositionReceipt', receipt);
  await journal.append(event('context.composed', receipt));
  for (const item of extra) await journal.append(item);
  return { journal, current: loopSnapshot(sessionId, await readEvents(journal, sessionId)), receipt };
}

for (const ordered of [false, true]) test(`approval review preserves exact read call facts and rejected unsafe tool evidence (ordered=${ordered})`, async () => {
  const { current, journal, receipt } = await snapshot(call());
  const inputs = [
    { callId: 'call:read', providerCallId: 'provider:read', toolName: 'fs.read', arguments: '{}' },
    { callId: 'call:rejected', providerCallId: 'provider:rejected', toolName: 'bash', arguments: '{}', error: rejected },
  ];
  const blocks = inputs.map((item, outputIndex) => ({ outputIndex, kind: item.error ? 'toolCallRejected' : 'toolCall',
    callId: item.callId, providerCallId: item.providerCallId, toolName: item.toolName, ...(item.error ? { error: item.error } : {}),
    item: { type: 'function_call', call_id: item.providerCallId, name: outputIndex ? 'bash' : 'frozen_read_alias', arguments: item.arguments } }));
  const completed = settlement(ordered ? { orderedOutputBlocks: blocks } : { toolCallInputs: inputs });
  assert.doesNotThrow(() => admitSessionEvents(current, [completed]));
  const mismatched = structuredClone(completed);
  mismatched.payload[ordered ? 'orderedOutputBlocks' : 'toolCallInputs'][0].providerCallId = 'provider:different';
  if (ordered) mismatched.payload.orderedOutputBlocks[0].item.call_id = 'provider:different';
  assert.throws(() => admitSessionEvents(current, [mismatched]), /provider_turn_call_identity_mismatch/);
  await journal.append(completed);
  const state = loopSnapshot(sessionId, await readEvents(journal, sessionId)).state;
  assert.equal(state.providerTurns[requestId].purpose, 'approvalReview');
  assert.deepEqual(state.activities['tool:call:rejected'].inputRejection, rejected);
  assert.deepEqual(state.shellAuthorizations, []);
  assert.equal((await readEvents(journal, sessionId)).find(item => item.type === 'context.composed').payload.reviewInput.content, receipt.reviewInput.content);
});

test('approval review refuses executable control calls and Provider hosted search', async () => {
  for (const toolName of ['bash', 'computer.control', 'session.control']) {
    const { current } = await snapshot(call(toolName));
    assert.throws(() => admitSessionEvents(current, [settlement()]), /approval_review_tool_invalid/);
  }
  const { current } = await snapshot(call());
  assert.throws(() => admitSessionEvents(current, [settlement({ hostedWebSearchCalls: [{ id: 'search:one' }] })]), /approval_review_tool_invalid/);
  assert.throws(() => admitSessionEvents(current, [settlement({ orderedOutputBlocks: [{ kind: 'providerHosted' }] })]), /approval_review_tool_invalid/);
});

test('a read requiring approval is not executed and cannot create authority or a dependency', async () => {
  const { journal, current } = await snapshot(call());
  const skipped = event('tool.not-executed', { attemptId: 'attempt:read', reason: 'approvalRequired' }, { callId: 'call:read' });
  assertRuntimeContract('ToolNotExecuted', skipped.payload);
  assert.doesNotThrow(() => admitSessionEvents(current, [settlement(), skipped]));
  const invalid = structuredClone(skipped);
  invalid.payload.predecessorCallId = 'call:another';
  assert.throws(() => admitSessionEvents(current, [settlement(), invalid]), /tool_not_executed_dependency_invalid/);
  await journal.append(settlement());
  await journal.append(skipped);
  const state = loopSnapshot(sessionId, await readEvents(journal, sessionId)).state;
  assert.equal(state.activities['tool:call:read'].status, 'rejected');
  assert.deepEqual(state.activities['tool:call:read'].notExecuted, { reason: 'approvalRequired' });
  assert.deepEqual(state.pendingApprovals, []);
  assert.deepEqual(state.shellAuthorizations, []);
});


test('approval context admits declared read aliases and keeps decisions and Plan review tool-free', async () => {
  const tools = [
    { name: 'fs.read', possibleEffects: ['workspaceRead'] },
    { name: 'session.read', possibleEffects: ['localRead'] },
    { name: 'bash', possibleEffects: ['process'] },
  ].map(tool => ({ ...tool, toolBindingRef: `binding:${tool.name}`, origin: 'coreBuiltin',
    availability: 'callable', description: tool.name, inputSchema: { type: 'object', properties: {}, required: [] } }));
  const reviewRuntime = runtimeSnapshot(runId, { tools, contextWindowTokens: 8192 });
  reviewRuntime.providerToolAliases = reviewRuntime.providerToolAliases.map(alias => ({ ...alias,
    wireName: alias.canonicalName === 'fs.read' ? 'evidence_file_v1'
      : alias.canonicalName === 'session.read' ? 'evidence_history_v1' : alias.wireName }));
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  await journal.append({ type: 'input.accepted', sessionId,
    payload: { commandId: 'command:input', messageId: 'message:input', text: 'Inspect the change.' } });
  await journal.append({ type: 'message.committed', sessionId,
    payload: { messageId: 'message:input', role: 'user', content: 'Inspect the change.', filesystemReferences: [], pluginSelections: [] } });
  await journal.append(event('run.started', { inputMessageId: 'message:input', workspaceBindings: [workspaceBinding], runtimeSnapshot: reviewRuntime }));
  const main = await buildAgentProviderRequest({ sessionId, runId, runtime: reviewRuntime,
    events: await readEvents(journal, sessionId), workspaceBindings: [workspaceBinding],
    providerRequestId: 'request:operation', responseConstraint: 'normal' });
  await journal.append(event('context.composed', main.receipt));
  await journal.append(event('tool.requested', { providerCallId: 'provider:operation', attemptId: 'attempt:operation',
    toolName: 'bash', input: { workspaceId: workspaceBinding.workspaceId, command: 'make check' } }, { callId: 'call:operation' }));
  await journal.append(event('provider.turn.settled', { purpose: 'agent', providerRequestId: 'request:operation',
    providerRuntimeRef: reviewRuntime.provider.providerRuntimeRef, outcome: 'completed', orderedCallIds: ['call:operation'] }));
  await journal.append(event('approval.requested', { approvalId: 'approval:operation', preview: {
    summary: 'Run make check', effects: ['process'], logicalTargets: ['.'], approvalReviewer: 'agent' } }, { callId: 'call:operation' }));
  const current = loopSnapshot(sessionId, await readEvents(journal, sessionId));
  const pending = current.state.pendingApproval;
  assert.ok(pending);
  const reading = prepareApprovalReview(current, reviewRuntime, pending, requestId);
  assertRuntimeContract('ProviderRequest', reading.request);
  assertRuntimeContract('ContextCompositionReceipt', reading.receipt);
  assert.equal(reading.receipt.responseConstraint, 'normal');
  assert.deepEqual(reading.receipt.tools.map(tool => [tool.canonicalName, tool.wireName]), [
    ['fs.read', 'evidence_file_v1'], ['session.read', 'evidence_history_v1'],
  ]);
  assert.doesNotThrow(() => admitSessionEvents(current, [event('context.composed', reading.receipt)]));
  const final = prepareApprovalReview(current, reviewRuntime, pending, 'request:decision', false, [], true);
  assertRuntimeContract('ProviderRequest', final.request);
  assertRuntimeContract('ContextCompositionReceipt', final.receipt);
  assert.equal(final.receipt.responseConstraint, 'answerOnly');
  assert.deepEqual(final.receipt.tools, []);
  assert.doesNotThrow(() => admitSessionEvents(current, [event('context.composed', final.receipt)]));

  const { responseFormat: _format, ...missingDecisionSchema } = final.request;
  for (const request of [
    { ...reading.request, tools: [] },
    { ...reading.request, responseFormat: final.request.responseFormat },
    { ...reading.request, hostedTools: [{ type: 'webSearch', providerToolType: 'web_search' }] },
    { ...final.request, tools: reading.request.tools },
    missingDecisionSchema,
  ]) assert.throws(() => assertRuntimeContract('ProviderRequest', request));

  const invalidReceipts = [
    { ...reading.receipt, tools: [] },
    { ...reading.receipt, responseConstraint: 'answerOnly' },
    ...[
      { canonicalName: 'bash', itemId: 'bash', wireName: 'bash' },
      { wireName: 'invented_alias' },
      { itemId: 'session.read' },
      { origin: 'sessionControl' },
      { availability: 'unavailable' },
    ].map(change => ({ ...reading.receipt, tools: [{ ...reading.receipt.tools[0], ...change }] })),
  ];
  for (const receipt of invalidReceipts) {
    assert.throws(() => admitSessionEvents(current, [event('context.composed', receipt)]), /approval_review_context_invalid/);
  }
  const planSnapshot = { ...current, state: { ...current.state, pendingApproval: null, pendingApprovals: [],
    pendingPlan: { review: { status: 'reviewing', providerRequestId: requestId } } } };
  assert.throws(() => admitSessionEvents(planSnapshot, [event('context.composed', reading.receipt)]), /approval_review_context_invalid/);
  assert.doesNotThrow(() => admitSessionEvents(planSnapshot, [event('context.composed', { ...final.receipt, providerRequestId: requestId })]));
});
