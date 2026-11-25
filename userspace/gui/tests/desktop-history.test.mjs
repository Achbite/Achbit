// TCR T-027-Frontend_Architecture-20261125/phase4/TCR.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';
import { installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

test('folded desktop tools fetch once on demand, retry errors, and hydrate synchronous plugin inputs from one complete read', async t => {
  const [api, details, plugins] = await loadGuiModules(t, [
    '/src/services/localAgentApi.ts', '/src/services/desktopHistory.ts', '/src/ui-plugins/activityInput.ts',
  ]);
  const id = 'session:desktop', full = projectSession(emptySessionState(id));
  full.revision = 8;
  const environment = { shell: '/bin/bash', interactive: false, executionScope: 'workspace', terminal: false,
    pathSource: 'runtime', writeScope: 'workspace', homeWritable: false, networkAccess: false };
  const summary = { exitCode: 0, success: true, timedOut: false, truncated: false, capturedBytes: 42, durationMs: 15, environment };
  const streams = { stdout: 'hello雪', stderr: 'diagnostic\n' };
  const activity = { activityId: 'tool:one', kind: 'tool', status: 'completed', label: 'Shell', runId: 'run:one', callId: 'call:one',
    sequence: 4, tool: { recordId: 'record:one', operation: 'bash', resources: [], shell: { command: 'pwd', cwd: '.',
      executionScope: 'workspace', terminal: false, result: { ...summary, ...streams } } } };
  full.activities = [activity];
  full.timeline = [{ kind: 'toolGroup', timelineId: 'group:one', providerRequestId: 'request:one',
    sequence: activity.sequence, activityIds: [activity.activityId] }];
  const partial = structuredClone(full); delete partial.activities[0].tool.shell.result;
  const view = { kind: 'desktop.history.v1', projection: partial, measurement: null,
    deferredShells: [{ activityId: activity.activityId, sequence: 7, summary }] };
  let fullReads = 0, outputReads = 0, badIdentity = true;
  const ok = data => Response.json({ ok: true, data });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/projection')) {
      if (init.headers.Accept) return ok(view);
      fullReads++; return ok(full);
    }
    assert.ok(url.pathname.endsWith('/shell-output/read'));
    outputReads++;
    const identity = JSON.parse(init.body);
    assert.deepEqual(identity, { sequence: 7, runId: activity.runId, callId: activity.callId, recordId: activity.tool.recordId });
    return ok({ sessionId: id, ...identity, ...streams, ...(badIdentity ? { recordId: 'other' } : {}) });
  });
  const projection = await api.getDesktopSessionProjection(id);
  assert.equal(fullReads, 0); assert.equal(outputReads, 0);
  const row = projection.activities[0], read = details.deferredShell(row).output;
  const off = read.subscribe(() => {}); t.after(off);
  await waitUntil(() => !!read.snapshot().error, 'wrong identity rejected');
  assert.match(read.snapshot().error, /shell_output_response_invalid/);
  badIdentity = false; read.retry();
  await waitUntil(() => !!read.snapshot().value, 'output restored');
  assert.deepEqual(read.snapshot().value, streams); off();
  const reopen = read.subscribe(() => {}); reopen();
  assert.equal(outputReads, 2);
  const toolInput = { kind: 'tool.result', activity: row, toolId: 'bash', locale: 'en-US', theme: 'dark' };
  const region = { kind: 'region', data: { kind: 'activities', activities: [row], expanded: false }, locale: 'en-US' };
  const source = plugins.pluginHistorySource(toolInput);
  assert.equal(source, plugins.pluginHistorySource(region));
  const a = source.subscribe(() => {}), b = source.subscribe(() => {}); t.after(a); t.after(b);
  await waitUntil(() => !!source.snapshot().value, 'one complete snapshot');
  assert.equal(fullReads, 1);
  assert.deepEqual(plugins.completePluginInput(toolInput, source.snapshot().value).activity, activity);
  assert.deepEqual(plugins.completePluginInput(region, source.snapshot().value).data.activities, [activity]);
  assert.equal(row.tool.shell.result, undefined);
  assert.equal(details.archivedMeasurements.get(projection), null);
  view.deferredShells[0].sequence = 12;
  await assert.rejects(api.getDesktopSessionProjection(id), /desktop_shell_reference_invalid/);
});

test('unmounting a pending detail cancels it and a late result cannot replace a newer expansion', async t => {
  const [details] = await loadGuiModules(t, ['/src/services/desktopHistory.ts']);
  const waiting = [];
  const read = new details.HistoryDetail(signal => new Promise(resolve => waiting.push({ signal, resolve })));
  const first = read.subscribe(() => {}); first();
  const second = read.subscribe(() => {});
  assert.equal(waiting[0].signal.aborted, true);
  waiting[1].resolve('current'); waiting[0].resolve('stale');
  await waitUntil(() => read.snapshot().value === 'current', 'latest result');
  second();
});
