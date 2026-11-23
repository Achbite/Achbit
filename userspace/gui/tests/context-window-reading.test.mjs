// TCR: .task-artifacts/T-012-UI_Fix-20261121/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

test('the active context window keeps one measured request across unknown snapshots and cached navigation', async t => {
  const [{ createLocalAgentStore }, { ContextUsageControl }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/ContextUsageControl.tsx',
  ]);
  const store = createLocalAgentStore(), a = 'session:window-a', b = 'session:window-b';
  const runId = 'run:window', run = { runId, status: 'running', profileId: 'profile:main', workspaceBindings: [] };
  // Both catalog entries already have a session.created fact; A also has a run.
  const snapshots = { [a]: { ...projectSession(emptySessionState(a)), revision: 2, run }, [b]: { ...projectSession(emptySessionState(b)), revision: 1 } };
  const statuses = () => Object.values(snapshots).map(p => ({ sessionId: p.sessionId, revision: p.revision,
    run: p.run && { runId: p.run.runId, status: p.run.status } }));
  store.setState({ catalog: { projects: [], sessions: [a, b].map(id => ({ id })) },
    sessionStatuses: Object.fromEntries(statuses().map(s => [s.sessionId, s])) });
  installGuiFetch(t, async url => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: statuses() });
    const id = [a, b].find(id => decodeURIComponent(url.pathname) === `/api/conversation/sessions/${id}/projection`);
    assert.ok(id, url.pathname);
    return Response.json({ ok: true, data: snapshots[id] });
  });
  const display = () => {
    const { projection, contextWindowReading } = store.getState();
    return renderToStaticMarkup(createElement(ContextUsageControl, { language: 'en-US', contextOpen: true,
      contextUsage: projection?.contextUsage ?? null, contextCompositions: projection?.contextCompositions ?? [],
      retainedReading: !projection?.contextUsage ? contextWindowReading : null,
      setContextOpen() {}, rootRef: { current: null }, onToggle() {} }));
  };
  const read = async patch => {
    snapshots[a] = { ...snapshots[a], revision: snapshots[a].revision + 5, ...patch };
    await store.getState().refresh();
    assert.equal(store.getState().error, null);
    assert.equal(store.getState().statusError, null, 'the navigation fixture must provide a valid Host status receipt');
    assert.deepEqual(store.getState().projection, snapshots[a], 'the wire projection is unchanged');
    return display();
  };
  const at = '2026-11-21T06:04:00Z';
  const usage = { runId, providerRequestId: 'req:first', providerRuntimeRef: 'runtime:a', sequence: 3, updatedAt: at,
    inputTokens: 90, outputTokens: 10, contextWindowTokens: 1000, cacheReadInputTokens: 45, cacheMissInputTokens: 45 };
  const kinds = ['instructions', 'sessionControls', 'tools', 'workspaceBindings', 'contextProviders', 'journalMessages', 'filesystemReferences'];
  const receipt = { runId, providerRequestId: usage.providerRequestId, purpose: 'agent', sequence: 2, createdAt: at,
    responseConstraint: 'normal', dynamicInstructionBytes: 0, messages: [], workspaceBindings: [], tools: [],
    partitions: kinds.map((kind, i) => ({ kind, itemCount: +!i, requestShapeUnits: +!i,
      tokenSource: 'sessionEstimated', estimatedInputTokens: i ? 0 : 90 })) };
  const pending = { ...receipt, sequence: 4, providerRequestId: 'req:pending', partitions: receipt.partitions.map(({ kind }) => (
    { kind, itemCount: 3, requestShapeUnits: 10 })) };
  await store.getState().activateSession(a);
  assert.match(display(), /disabled=""/);
  assert.match(await read({ contextUsage: usage, contextCompositions: [receipt, pending] }), />10%<\/span>/);
  const held = await read({ contextUsage: null, contextCompositions: [pending] });
  assert.match(held, /role="dialog"/, 'the open panel must survive an unmeasured response');
  assert.match(held, />10%<\/span>/); assert.match(held, /Last measured/); assert.match(held, /50%/);
  assert.match(held, /≈90/); assert.doesNotMatch(held, /3 items/);
  await store.getState().activateSession(b); assert.match(display(), /disabled=""/);
  await store.getState().activateSession(a); assert.equal(display(), held);
  assert.match(await read({ run: { ...run, status: 'waiting', waitingReason: 'userInput' } }), /Last measured/);
  const zero = { ...usage, providerRequestId: 'req:zero', sequence: 18, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheMissInputTokens: 0 };
  const measuredZero = await read({ contextUsage: zero, contextCompositions: [{ ...receipt, sequence: 17, providerRequestId: zero.providerRequestId,
    partitions: receipt.partitions.map(p => ({ ...p, estimatedInputTokens: 0 })) }] });
  assert.match(measuredZero, />0%<\/span>/); assert.doesNotMatch(measuredZero, /Last measured|≈90/);
  assert.match(await read({ contextUsage: null, run: { ...run, status: 'completed' } }), /disabled=""/);
  await read({ run, contextUsage: usage, contextCompositions: [receipt] });
  assert.match(await read({ run: { ...run, runId: 'run:handoff', profileId: 'profile:next' }, contextUsage: null,
    contextCompositions: [] }), /disabled=""/, 'another run must not borrow the earlier measurement');
});
