import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticCompactionCutoff, estimateContextInput, pressureCompactionCutoff } from '../dist/local-agent/compaction.js';
import { emptySessionState } from '../dist/local-agent/reducer.js';
import { runtimeSnapshot } from './local-agent-fixtures.mjs';

// Pure component fixtures: no Provider, transport, live Session or summary call.
function estimationFixture({ priorUnits = 1_577_493, units = 1_584_125, inputTokens = 286_771 } = {}) {
  const sessionId = 'session:estimate', previousRun = 'run:previous', runId = 'run:next';
  const options = { contextWindowTokens: 1_050_000, maxOutputTokens: 128_000, apiSurface: 'responses',
    contextManagement: { enabled: true, thresholdTokens: 500_000 } };
  const previous = runtimeSnapshot(previousRun, options), runtime = runtimeSnapshot(runId, options);
  previous.provider.providerRuntimeRef = 'provider-runtime:previous';
  runtime.provider.providerRuntimeRef = 'provider-runtime:next';
  previous.provider.inputTokenCalibrationKey = runtime.provider.inputTokenCalibrationKey = 'input-token-calibration:fixture';
  const receiptFor = (providerRequestId, requestShapeUnits) => ({
    providerRequestId, purpose: 'agent', responseConstraint: 'normal', dynamicInstructionBytes: 0,
    messages: [], tools: [], workspaceBindings: [],
    partitions: [{ kind: 'journalMessages', itemCount: 1, requestShapeUnits }],
  });
  const prior = { ...receiptFor('request:previous', priorUnits), runId: previousRun, sequence: 3, createdAt: '3' };
  const receipt = receiptFor('request:next', units);
  const usage = { providerRequestId: prior.providerRequestId, providerRuntimeRef: previous.provider.providerRuntimeRef,
    runId: previousRun, sequence: 4, updatedAt: '4', contextWindowTokens: 1_050_000,
    inputTokens, outputTokens: 100, cacheReadInputTokens: inputTokens, cacheMissInputTokens: 0 };
  const events = [
    { sequence: 1, type: 'message.committed', payload: { messageId: 'message:previous', role: 'user', content: 'Prior task.' } },
    { sequence: 2, type: 'run.started', runId: previousRun,
      payload: { inputMessageId: 'message:previous', runtimeSnapshot: previous } },
    { sequence: 3, type: 'context.composed', runId: previousRun, payload: prior },
    { sequence: 4, type: 'context.updated', runId: previousRun, payload: usage },
    { sequence: 5, type: 'message.committed', payload: { messageId: 'message:next', role: 'user', content: 'Next task.' } },
    { sequence: 6, type: 'run.started', runId, payload: { inputMessageId: 'message:next', runtimeSnapshot: runtime } },
  ];
  const state = emptySessionState(sessionId);
  Object.assign(state, { revision: 6, contextUsage: usage, contextCompositions: [prior],
    runRuntimeSnapshots: { [previousRun]: previous, [runId]: runtime } });
  state.tokenUsage.inputTokens = 51_197_542;
  return { snapshot: { events, state }, previous, runtime, receipt, prior, usage, runId };
}

function automatic(fixture, boundary = 'nextRun') {
  return automaticCompactionCutoff(fixture.snapshot, fixture.runId, fixture.receipt, fixture.runtime,
    fixture.runtime.contextManagement, boundary);
}

test('same resolved model keeps calibrated input across new runtime identities instead of crossing 500k', () => {
  const f = estimationFixture();
  assert.notEqual(f.previous.provider.providerRuntimeRef, f.runtime.provider.providerRuntimeRef);
  assert.equal(Math.ceil(f.receipt.partitions[0].requestShapeUnits / 3), 528_042);
  assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), 287_977);
  assert.equal(automatic(f), null, 'a new run must not inflate ~287k actual input into a >500k estimate');
  assert.equal(automatic(f, 'idle'), null);
  const restored = JSON.parse(JSON.stringify(f.snapshot));
  assert.equal(estimateContextInput(restored, f.receipt, f.runtime), 287_977, 'calibration uses frozen journal facts');
});

test('500k remains an estimated next-input threshold including cached tokens, not cumulative billing', () => {
  for (const [units, expected, cutoff] of [[2_999_994, 499_999, null], [3_000_000, 500_000, 4], [3_000_006, 500_001, 4]]) {
    const f = estimationFixture({ priorUnits: 3_000_000, inputTokens: 500_000, units });
    assert.equal(f.usage.cacheMissInputTokens, 0, 'even fully cached input counts toward context capacity');
    assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), expected);
    assert.equal(automatic(f), cutoff, `next-run estimate ${expected}`);
    assert.equal(automatic(f, 'idle'), cutoff === null ? null : 6, `idle estimate ${expected}`);
  }
});

test('same-run calibration still works when no cross-run calibration key is supplied', () => {
  const f = estimationFixture();
  delete f.previous.provider.inputTokenCalibrationKey;
  delete f.runtime.provider.inputTokenCalibrationKey;
  f.runtime.provider.providerRuntimeRef = f.usage.providerRuntimeRef;
  assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), 287_977);
});

test('changed accounting identity, window or missing cross-run evidence cannot borrow old calibration', () => {
  const cases = [
    ['different model or endpoint', f => { f.runtime.provider.inputTokenCalibrationKey = 'input-token-calibration:other'; }],
    ['missing current key', f => { delete f.runtime.provider.inputTokenCalibrationKey; }],
    ['missing previous key', f => { delete f.previous.provider.inputTokenCalibrationKey; }],
    ['missing previous snapshot', f => { delete f.snapshot.state.runRuntimeSnapshots[f.usage.runId]; }],
    ['usage belongs to another runtime', f => { f.previous.provider.providerRuntimeRef = 'provider-runtime:unrelated'; }],
    ['changed model window', f => { f.runtime.provider.contextWindowTokens = 1_000_000; }],
  ];
  for (const [label, change] of cases) {
    const f = estimationFixture();
    change(f);
    assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), 528_042, label);
  }
});

test('first requests, unavailable baselines and post-checkpoint input retain the existing conservative estimate', () => {
  for (const change of [
    f => { f.snapshot.state.contextUsage = null; },
    f => { f.snapshot.state.contextCompositions = []; },
    f => { f.prior.partitions[0].requestShapeUnits = 0; },
    f => { f.snapshot.events.push({ sequence: 7, type: 'context.compacted', payload: { coveredThroughSequence: 4 } }); },
  ]) {
    const f = estimationFixture();
    change(f);
    assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), 528_042);
  }
  const f = estimationFixture();
  f.snapshot.events.unshift({ sequence: 0, type: 'context.compacted', payload: { coveredThroughSequence: 0 } });
  assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), 287_977,
    'a measurement newer than a checkpoint may calibrate subsequent requests');
});

test('pressure compaction uses the calibrated input plus output reserve even with automatic management disabled', () => {
  for (const [inputTokens, cutoff] of [[921_999, null], [922_000, 4]]) {
    const f = estimationFixture({ priorUnits: 6_000_000, units: 6_000_000, inputTokens });
    f.runtime.contextManagement.enabled = false;
    assert.equal(automatic(f), null);
    assert.equal(estimateContextInput(f.snapshot, f.receipt, f.runtime), inputTokens);
    assert.equal(pressureCompactionCutoff(f.snapshot, f.runId, f.receipt, f.runtime), cutoff);
  }
});
