import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySessionState } from '../dist/index.js';
import { prepareApprovalReview } from '../dist/local-agent/approvalReview.js';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

function fixture(toolName, input, records) {
  const sessionId = 'session:evidence', runId = 'run:evidence', callId = 'call:evidence';
  const events = [
    { type: 'message.committed', payload: { role: 'user', messageId: 'message:task', content: 'Verify the isolated Debug instance. Keep the standard instance unchanged.' } },
    { type: 'run.started', runId, payload: { inputMessageId: 'message:task' } },
    ...records.map((record, index) => ({ type: 'tool.completed', runId: record.runId ?? runId,
      payload: { record: { recordId: `record:${index}`, callId: `call:${index}`, completedAt: '123', outcome: 'completed', ...record } } })),
    { type: 'tool.requested', runId, callId, payload: { toolName, input } },
  ].map((event, index) => ({ sessionId, sequence: index + 1, ...event }));
  const snapshot = { events, state: { ...emptySessionState(sessionId), run: { runId, workspaceBindings: [workspaceBinding] } } };
  const approval = { runId, callId, preview: { operation: { toolName, arguments: input }, effects: ['process'], logicalTargets: ['.'] } };
  return { snapshot, prepare() {
    const result = prepareApprovalReview(snapshot, runtimeSnapshot(runId), approval, 'request:review');
    return { ...result, packet: JSON.parse(result.request.messages[1].content) };
  } };
}

test('review includes successful script writes and subsequent edits instead of only their filenames', () => {
  const content = '# Isolated instance validation\n' + '# original source\n'.repeat(110) + 'print("verified")\n';
  const write = { toolName: 'fs.write', input: { path: 'checks/verify.py', workspaceId: 'workspace:test', content }, output: { saved: true } };
  const edit = { toolName: 'fs.edit', input: { path: 'checks/verify.py', edits: [{ oldText: 'verified', newText: 'finished' }] }, output: { patched: true } };
  const f = fixture('bash', { command: 'python3 checks/verify.py' }, [write, edit]);
  const before = structuredClone(f.snapshot);
  const { packet, receipt } = f.prepare();
  assert.deepEqual(packet.recentObservations.records.map(record => JSON.parse(record.input.text)), [write.input, edit.input]);
  assert.ok(packet.recentObservations.records.every(record => !record.input.truncated));
  assert.equal(packet.grant, 'thisCallOnly');
  assert.deepEqual(JSON.parse(receipt.reviewInput.content), packet);
  assert.deepEqual(f.snapshot, before);
});

test('review retains file-read coverage and failed write outcomes without inventing complete script evidence', () => {
  const f = fixture('bash', { command: 'python3 checks/verify.py' }, [
    { toolName: 'fs.read', input: { path: 'checks/verify.py', startLine: 20 },
      output: { content: 'tail only', startLine: 20, endLine: 28, truncated: true, byteTruncated: false } },
    { toolName: 'fs.write', input: { path: 'checks/verify.py', content: 'x'.repeat(7000) }, outcome: 'failed', error: { message: 'read only' } },
  ]);
  const evidence = f.prepare().packet.recentObservations.records;
  assert.equal(evidence[0].output.text, 'tail only');
  assert.equal(evidence[0].sourceCoverage.startLine, 20);
  assert.equal(evidence[0].sourceCoverage.truncated, true);
  assert.equal(evidence[1].outcome, 'failed');
  assert.equal(evidence[1].input.truncated, true);
  assert.match(evidence[1].error.text, /read only/);
});

test('review budgets unrelated receipts before script evidence and preserves original user restrictions', () => {
  const content = '# script\n'.repeat(150) + 'print("isolated")';
  const f = fixture('bash', { command: 'cd checkout && python3 checks/verify.py' }, [
    { toolName: 'fs.write', input: { path: 'checkout/checks/verify.py', content }, output: { saved: true } },
    ...Array.from({ length: 6 }, (_, i) => ({ toolName: 'fs.read', input: { path: `logs/${i}.log` }, output: { content: 'log'.repeat(2000) } })),
  ]);
  const { packet, request } = f.prepare();
  assert.ok(packet.recentObservations.omittedRecords > 0);
  assert.equal(JSON.parse(packet.recentObservations.records.find(record => record.toolName === 'fs.write').input.text).content, content);
  assert.match(packet.userMessages[0].content, /standard instance unchanged/);
  assert.ok(request.messages.reduce((n, message) => n + message.content.length, 0) <= 18000);
});

test('capture review uses the exact window from the latest current-run list, without exposing unrelated windows', () => {
  const window = { windowId: 42, owner: 'DeepCode-Debug', pid: 123, title: 'Debug test', bounds: { x: 0, y: 0, width: 900, height: 600 } };
  const listed = windows => ({ toolName: 'computer.control', input: { action: 'listWindows' }, output: { windows } });
  const f = fixture('computer.control', { action: 'capture', windowId: 42 }, [listed([window, { windowId: 99, title: 'Unrelated private window' }])]);
  const { packet } = f.prepare();
  assert.deepEqual(packet.observedTarget.window, window);
  assert.equal(packet.observedTarget.observation.recordId, 'record:0');
  assert.doesNotMatch(JSON.stringify(packet), /Unrelated private window/);
  for (const newer of [listed([]), { ...listed([window]), outcome: 'failed', error: { message: 'list failed' } }]) {
    assert.equal(fixture('computer.control', { action: 'capture', windowId: 42 }, [listed([window]), newer]).prepare().packet.observedTarget, undefined);
  }
  assert.equal(fixture('computer.control', { action: 'capture', windowId: 42 }, [{ ...listed([window]), runId: 'run:previous' }]).prepare().packet.observedTarget, undefined);
});
