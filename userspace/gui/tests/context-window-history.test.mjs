// TCR: .task-artifacts/T-012-UI_Fix-20261121/history-TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

test('cold completed window restores only the last single-window Agent receipt without touching the Session', async t => {
  const store = await loadGuiModelStore(t), a = 'session:history-window', b = 'session:other-window', runId = 'run:history';
  const kinds = ['instructions','sessionControls','tools','workspaceBindings','contextProviders','journalMessages','filesystemReferences'];
  const receipt = (id, sequence, purpose, measured) => ({ providerRequestId: id, runId, sequence, purpose, createdAt: 'now',
    responseConstraint: 'normal', dynamicInstructionBytes: 0, messages: [], tools: [], workspaceBindings: [],
    partitions: kinds.map((kind, i) => ({ kind, itemCount: i ? 0 : 1, requestShapeUnits: i ? 0 : 10,
      ...(measured ? { tokenSource: 'sessionEstimated', estimatedInputTokens: i ? 0 : 128906 } : {}) })) });
  const receipts = [receipt('old', 4, 'agent', true), receipt('measured', 8, 'agent', true),
    receipt('search', 12, 'agent', false), receipt('review', 16, 'approvalReview', true), receipt('end', 20, 'agent', false)];
  const usage = id => ({ providerRequestId: id, providerRuntimeRef: 'runtime:main', contextWindowTokens: 550000,
    inputTokens: id === 'measured' ? 128906 : 146006, outputTokens: id === 'measured' ? 78 : 3532 });
  const empty = id => projectSession(emptySessionState(id));
  const snap = empty(a);
  const total = { ...snap.tokenUsage, providerCallCount: 5, reportedCallCount: 5, inputTokens: 600000,
    outputTokens: 5000, cacheMissInputTokens: 600000, cacheAvailable: true, cacheComplete: true, cacheHitRatio: 0 };
  Object.assign(snap, { revision: 26, run: { runId, status: 'completed', profileId: 'profile:main', workspaceBindings: [] },
    contextCompositions: [receipts.at(-1)], tokenUsage: total, totalTokenUsage: total,
    tokenUsageHistory: [{ ...total, runId, inputMessageId: 'm', sequence: 2, title: 'A', startedAt:'now', outcome:'completed' }] });
  const other = { ...empty(b), revision: 1 }, pages = [], details = [];
  store.setState({ catalog: { projects: [], sessions: [a,b].map(id => ({id})) }, sessionStatuses: {
    [a]: {sessionId:a,revision:snap.revision,run:{runId,status:'completed'}}, [b]:{sessionId:b,revision:1,run:null} } });
  let hold = true, release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const ok = data => Response.json({ ok:true, data });
  installGuiFetch(t, async (url, init) => {
    const path=decodeURIComponent(url.pathname);
    if (path.endsWith('/statuses')) return ok(Object.values(store.getState().sessionStatuses));
    if (path.endsWith('/projection')) return ok(path.includes(a) ? snap : other);
    if (path.endsWith('/read')) {
      const q=JSON.parse(init.body); assert.equal(q.view,'context'); assert.equal(q.throughSequence,26);pages.push(q.before);
      // The search aggregates are smaller than capacity. A capacity check alone is insufficient.
      const candidates=receipts.filter(r=>r.sequence<(q.before??Infinity)).slice(-2);
      return ok({sessionId:a,view:'context',revision:26,nextBefore:candidates[0].sequence>4?candidates[0].sequence:null,
        items:candidates.map(r=>({type:'context.composed',runId,sequence:r.sequence,providerRequestId:r.providerRequestId,
          data:{content:'{"messages":[',truncated:true}, usage:{content:JSON.stringify(usage(r.providerRequestId)),truncated:false}}))});
    }
    const r=receipts.find(r=>path.endsWith(`/context-compositions/${r.providerRequestId}`));assert.ok(r,path);details.push(r.providerRequestId);
    if (hold && r.providerRequestId==='measured') await gate;
    return ok(r);
  });
  await store.getState().activateSession(a);
  await waitUntil(()=>details.includes('measured'),'historical measurement requested');
  await store.getState().activateSession(b); hold=false;release();
  assert.equal(store.getState().contextWindowReading,null,'late A cannot populate B');
  await store.getState().activateSession(a);
  await waitUntil(()=>!!store.getState().contextWindowReading,'restore measured history after returning to A');
  const state=store.getState(); assert.equal(state.error,null);assert.equal(state.projection.contextUsage,null);
  assert.deepEqual(state.contextWindowReading.usage,{ ...usage('measured'), runId });
  assert.deepEqual(state.contextWindowReading.receipt.partitions,receipts[1].partitions);
  assert.equal(details.includes('old'),false,'stop after the most recent eligible receipt');
  const reads=pages.length; await state.refresh();assert.equal(pages.length,reads,'an unchanged revision does not trigger another historical read');
});
