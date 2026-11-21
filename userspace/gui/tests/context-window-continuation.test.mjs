// TCR: .task-artifacts/T-012-UI_Fix-20261121/continuation-TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';
import { installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';

async function followUp(t) {
  const store = await loadGuiModelStore(t), sid = 'session:continued-window';
  const base = projectSession(emptySessionState(sid));
  const at = '2026-11-21T07:39:55Z', capacity = 550000;
  const run = id => ({ runId: id, status: 'running', profileId: 'profile:main', workspaceBindings: [] });
  const round = (runId, sequence, calls) => ({ ...base.tokenUsage, runId, sequence, inputMessageId: `m:${sequence}`,
    title: 'Continue', startedAt: at, providerCallCount: calls, reportedCallCount: calls,
    cacheAvailable: calls > 0, cacheComplete: calls > 0 });
  const receipt = (runId, sequence, purpose, input) => ({ runId, sequence, providerRequestId: `req:${sequence}`,
    purpose, createdAt: at, responseConstraint: 'normal', dynamicInstructionBytes: 0, messages: [], tools: [], workspaceBindings: [],
    partitions: ['instructions','sessionControls','tools','workspaceBindings','contextProviders','journalMessages','filesystemReferences']
      .map((kind, i) => ({ kind, itemCount: +!i, requestShapeUnits: +!i,
        ...(input !== null ? { tokenSource: 'sessionEstimated', estimatedInputTokens: i ? 0 : input } : {}) })) });
  const old = run('run:old'), next = run('run:next');
  const measured = receipt(old.runId, 5, 'agent', 121025), review = receipt(old.runId, 9, 'approvalReview', 7000);
  const hosted = receipt(old.runId, 14, 'agent', null), pending = receipt(next.runId, 25, 'agent', null);
  const usage = (r, inputTokens, outputTokens) => ({ providerRequestId: r.providerRequestId, providerRuntimeRef: `runtime:${r.runId}`,
    inputTokens, outputTokens, contextWindowTokens: capacity });
  const wire = (r, input, output) => ({ ...usage(r, input, output), runId:r.runId, sequence:r.sequence + 3, updatedAt:at });
  const first = { ...base, revision:8, run:old, contextUsage:wire(measured,121025,444), contextCompositions:[measured], tokenUsageHistory:[round(old.runId,2,1)] };
  const ended = { ...first, revision:20, run:{...old,status:'completed'}, contextUsage:null, contextCompositions:[hosted], tokenUsageHistory:[round(old.runId,2,3)] };
  // At run.started the projection still carries the last OLD composition; the new run has not even composed a request.
  const started = { ...ended, revision:23, run:next, tokenUsageHistory:[round(next.runId,23,0), ...ended.tokenUsageHistory] };
  const waiting = { ...started, revision:26, contextCompositions:[pending] };
  const current = { ...waiting, revision:30, contextUsage:wire(pending,142099,579), contextCompositions:[receipt(next.runId,25,'agent',142099)],
    tokenUsageHistory:[round(next.runId,23,1), ...ended.tokenUsageHistory] };
  let p, hold; const details = [], pages = [];
  const ok = data => Response.json({ok:true,data});
  const status = () => ({sessionId:sid,revision:p.revision,run:{runId:p.run.runId,status:p.run.status}});
  installGuiFetch(t, async (url, init) => {
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith('/statuses')) return ok([status()]);
    if (path.endsWith('/projection')) return ok(p);
    if (path.endsWith('/read')) {
      const q = JSON.parse(init.body); assert.equal(q.view,'context'); pages.push(q);
      const items = [measured,review,hosted,pending].filter(r => r.sequence < q.before && r.sequence <= q.throughSequence)
        .map(r => ({type:'context.composed',sequence:r.sequence,runId:r.runId,providerRequestId:r.providerRequestId,
          usage:r===pending ? null : {truncated:false,content:JSON.stringify(r===measured ? usage(r,121025,444) : r===review ? usage(r,7000,30) : usage(r,157722,1589))}}));
      return ok({sessionId:sid,view:'context',revision:q.throughSequence,items,nextBefore:null});
    }
    const detail = [measured,review,hosted,pending].find(r => path.endsWith(`/context-compositions/${r.providerRequestId}`));
    assert.ok(detail,path); details.push(detail.providerRequestId);
    if (hold && detail===measured) await hold; // Also model a transport completing after cancellation.
    return ok(detail);
  });
  const load = async snap => {
    p = snap;
    if (!store.getState().sessionId) {
      store.setState({catalog:{projects:[],sessions:[{id:sid}]},sessionStatuses:{[sid]:status()}});
      await store.getState().activateSession(sid);
    } else await store.getState().refresh();
    assert.equal(store.getState().error,null);
    assert.deepEqual(store.getState().projection,p);
    return store.getState().contextWindowReading;
  };
  return {store, first,ended,started,waiting,current,measured,pages,details,load,
    holdHistory() { let release; hold = new Promise(resolve => { release=resolve; }); t.after(release); return release; }};
}

test('a warm follow-up immediately keeps the original single-window reading and drops an edited-away origin', async t => {
  const f=await followUp(t); const read=await f.load(f.first); const release=f.holdHistory();
  assert.deepEqual((await f.load(f.ended)).receipt,read.receipt);
  assert.deepEqual(await f.load(f.started),read,'the next run has zero calls; do not wait for it to settle');
  assert.deepEqual(await f.load(f.waiting),read,'a pending composition must not replace the measured breakdown');
  release();
  const edited={...f.waiting,revision:27,tokenUsageHistory:[f.waiting.tokenUsageHistory[0]]};
  assert.equal(await f.load(edited),null,'the measurement no longer belongs to active history');
});

test('cold run.started restores the previous run without a new request and honors the model-context boundary', async t => {
  const f=await followUp(t); await f.load(f.started);
  await waitUntil(()=>!!f.store.getState().contextWindowReading,'previous single-window reading while new run has zero reports');
  const r=f.store.getState().contextWindowReading;
  assert.equal(r.usage.runId,f.first.run.runId); assert.equal(r.usage.inputTokens+r.usage.outputTokens,121469);
  assert.deepEqual(r.receipt.partitions,f.measured.partitions);
  const n=f.pages.length; await f.load(f.waiting); assert.equal(f.pages.length,n,'starting the stream did not add any usage');
  const handoff={...f.waiting,revision:27,contextHandoff:{runId:f.waiting.run.runId,historyThroughSequence:20,
    previousProfileId:'profile:main',profileId:'profile:main',status:'reading'}};
  assert.equal(await f.load(handoff),null,'even the same profile may have a different model context');
});

test('a slow previous-run history response cannot overwrite a newer live measurement', async t => {
  const f=await followUp(t), release=f.holdHistory(); await f.load(f.waiting);
  await waitUntil(()=>f.details.includes(f.measured.providerRequestId),'follow-up history lookup in flight');
  assert.equal((await f.load(f.current)).usage.providerRequestId,f.current.contextUsage.providerRequestId);
  release(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.store.getState().contextWindowReading.usage.inputTokens,142099);
});
