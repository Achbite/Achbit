// TCR: .task-artifacts/T-020-GUI_Startup-20261121/locality-fix/revision-window/projection-retention-01/范围与TCR.md
// The weak/GC and sparse-window contracts also retain locality-fix/data/TCR-budget.md coverage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore, loadGuiModule } from './gui-projection-contract.mjs';

const MiB = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
const date = '2026-11-22T02:00:00Z';
const ids = ['session:budget-a', 'session:budget-b'];
const range = { firstRowKey: 'question', lastRowKey: 'reply-stream', anchorKey: 'reply-stream', offset: -73 };
const rowLimit = 32_768, overRows = rowLimit + 1;
const jumboBody = 'X'.repeat(8 * MiB + 1);
const empty = Object.freeze([]);
function message(messageId, role, content, sequence, runId = 'run:one', providerRequestId = 'req:one') {
  return { messageId, role, content, sequence, createdAt: date, feedback: null,
    filesystemReferences: empty, pluginSelections: empty, ...(role === 'assistant' ? { runId, providerRequestId } : {}) };
}
function row(m) {
  return { kind: 'message', messageId: m.messageId, timelineId: `timeline:${m.messageId}`, sequence: m.sequence,
    ...(m.role === 'assistant' ? { streamId: `${m.messageId}-stream` } : {}) };
}
// Actual, ordered, independently addressable message/timeline pairs; no sparse Array(length)
// or duplicate keys. Only the short, immutable middle of a transcript is shared by fixtures.
const history = [], historyRows = [];
function snapshot(id, { rows = 3, earlier = 'original earlier text', reply = `**${id} complete reply**`, revision = Math.max(15, rows) } = {}) {
  assert.ok((rows === 1 || rows >= 3) && revision >= rows);
  const p = projectSession(emptySessionState(id));
  p.revision = revision; p.run = { runId: 'run:one', status: 'completed', profileId: 'p:one', workspaceBindings: [] };
  const last = message('reply', 'assistant', reply, rows);
  if (rows === 1) { p.messages = [last]; p.timeline = [row(last)]; return p; }
  const count = rows - 3;
  while (history.length < count) {
    const i = history.length, turn = Math.floor(i / 2), assistant = i % 2 === 1;
    const m = message(`h:${i}`, assistant ? 'assistant' : 'user', assistant ? 'Done.' : 'Continue.', i + 2, `run:h${turn}`, `req:h${turn}`);
    history.push(Object.freeze(m)); historyRows.push(Object.freeze(row(m)));
  }
  const first = message('earlier', 'user', earlier, 1), q = message('question', 'user', `${id} question`, rows - 1);
  p.messages = [first, ...history.slice(0,count), q, last]; p.timeline = [row(first), ...historyRows.slice(0,count), row(q), row(last)];
  return p;
}
function projectionResponse(p) {
  if (p.timeline.length <= rowLimit) return Response.json({ ok:true, data:p }); // Real wire round trip for the jumbo-text hot test.
  // The row/GC tests need the GUI decoder, not repeated serialization of 32K immutable pairs.
  // Return a fresh projection and a detached copy of the only editable message. Keeping the
  // fixture or a sparse row alive must not keep this decoded projection / cache view alive.
  const data = { ...p, messages:p.messages.slice() }; data.messages[data.messages.length-1] = { ...data.messages.at(-1) };
  const response = new Response(null, {headers:{'content-type':'application/json'}});
  response.json = async () => ({ ok:true, data }); return response;
}
const over = id => snapshot(id, {rows:overRows});
const overWithOriginal = id => snapshot(id, {rows:overRows, earlier:jumboBody});
function fixture(t, store, makeSnapshot = over) {
  const raw = Object.fromEntries(ids.map(id => [id, makeSnapshot(id)]));
  const statuses = () => ids.map(id => ({ sessionId: id, revision: raw[id].revision, run: { runId: raw[id].run.runId, status: raw[id].run.status } }));
  store.setState({ catalog: { projects: [], sessions: ids.map(id => ({ id, title:id, createdAt: date, updatedAt: date, workspaceBindings: [] })) },
    sessionStatuses: Object.fromEntries(statuses().map(x => [x.sessionId, x])) });
  const requests = { full: [], status: 0, commands: [] }, gate = {};
  const reply = data => Response.json({ ok: true, data });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/statuses')) { requests.status++; if (gate.status) await gate.status; if (gate.statusError) throw gate.statusError; return reply(statuses()); }
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    if (url.pathname.endsWith('/commands')) { const command = JSON.parse(init.body); requests.commands.push(command);
      assert.equal(init.signal, undefined); raw[id].revision++; raw[id].messages.at(-1).feedback = command.feedback;
      return reply({ schemaVersion: 'achbit.command-reply.v3', status: 'accepted', commandId: command.commandId, sessionId:id, revision:raw[id].revision }); }
    assert.ok(url.pathname.endsWith('/projection'), url.pathname); requests.full.push(id);
    if (gate.full) await gate.full;
    if (gate.fullError) throw gate.fullError;
    return projectionResponse(raw[id]);
  });
  return { raw, requests, gate };
}
function capture(store) { const s=store.getState(); return s.rememberReadingWindow(s.projection, range); }
function hold() { let release; const wait = new Promise(r => { release = r; }); return { wait, release }; }

test('two single-message jumbo replies and their measured context are immediately available on hot selection, even before status returns', async t => {
  const store = await loadGuiModelStore(t);
  const {requests, gate} = fixture(t, store, id => {
    const p = snapshot(id, {rows:1, reply:(id === ids[0] ? 'A' : 'B').repeat(8 * MiB + 1)});
    p.contextUsage = {runId:'run:one', providerRequestId:'req:one', providerRuntimeRef:`runtime:${id}`, sequence:3,
      updatedAt:date, inputTokens:80, outputTokens:20, contextWindowTokens:1000};
    p.contextCompositions = [{runId:'run:one', providerRequestId:'req:one', purpose:'agent', sequence:2, createdAt:date,
      responseConstraint:'normal', dynamicInstructionBytes:0, messages:[], workspaceBindings:[], tools:[],
      partitions:['instructions','sessionControls','tools','workspaceBindings','contextProviders','journalMessages','filesystemReferences']
        .map((kind,i) => ({kind, itemCount:+!i, requestShapeUnits:+!i}))}];
    return p;
  });
  const originals = new Map();
  for (const id of ids) {
    await store.getState().activateSession(id);
    const {projection:p, contextWindowReading:reading, error} = store.getState();
    assert.equal(error,null); assert.equal(p.sessionId,id); assert.equal(p.timeline.length,1);
    assert.equal(Buffer.byteLength(p.messages[0].content,'utf8'),8*MiB+1);
    assert.equal(p.messages[0].content.at(-1),id === ids[0] ? 'A' : 'B');
    assert.equal(reading.usage.providerRuntimeRef,`runtime:${id}`); assert.equal(reading.receipt.sequence,2);
    originals.set(id,{p,reading});
  }
  for (const id of ids) {
    const {p,reading} = originals.get(id), ack = hold(); gate.status = ack.wait;
    const visits = [], stop = store.subscribe(s => {
      if (s.sessionId === id) visits.push(s.projection === p && s.contextWindowReading === reading && !s.loading && s.openingReadingWindow === null);
    });
    const returned = store.getState().activateSession(id);
    try {
      await tick(); const s = store.getState();
      assert.ok(s.projection === p, 'ordinary byte-heavy history must not wait on the weak-view status gate');
      assert.ok(s.contextWindowReading === reading); assert.equal(s.openingReadingWindow,null); assert.equal(s.loading,false);
      assert.equal(s.shouldRememberReadingWindow(p),false,'one wide row does not need a sparse capture');
    } finally { ack.release(); await returned; stop(); delete gate.status; }
    assert.ok(visits.length && visits.every(Boolean), 'no transient blank, wrong owner, or partial reading during a warm return');
    assert.equal(store.getState().error,null);
  }
  assert.deepEqual(requests.full,ids,'one actual complete decode per owner; no return GET'); assert.equal(requests.status,2);
});

test('two over-row-budget complete views: four alternating weak hits require four fresh Host receipts and zero extra full reads', async t => {
  const store=await loadGuiModelStore(t), {requests,gate}=fixture(t,store,overWithOriginal), originals=[];
  for (const id of ids) { await store.getState().activateSession(id); assert.equal(store.getState().error,null); originals.push(store.getState().projection); assert.equal(capture(store),true); }
  const ack=hold(); gate.status=ack.wait;
  const first=store.getState().activateSession(ids[0]); await tick();
  assert.equal(store.getState().projection,null, 'having a live WeakRef is not a fresh Host status'); assert.equal(store.getState().openingReadingWindow,null);
  ack.release(); await first; delete gate.status;
  for (const n of [1,0,1]) { await store.getState().activateSession(ids[n]); assert.equal(store.getState().projection,originals[n]); }
  assert.deepEqual(requests.full,ids); assert.equal(requests.status,4);
  assert.equal(store.getState().projection.messages[0].content.length,8*MiB+1,'the API delivers the complete offscreen message');
});

test('when a row-evicted whole view is unavailable the real rows survive; completion and the original action await the one real full read', async t => {
  const store=await loadGuiModelStore(t), {requests,gate}=fixture(t,store,overWithOriginal);
  // Standard runs also exercise the JS runtime without weak support. The dedicated --expose-gc
  // run instead drops external references and asks V8 to really collect the weak value.
  if (!global.gc) t.mock.method(globalThis.WeakRef.prototype,'deref',function() { return undefined; });
  for (const id of ids) { await store.getState().activateSession(id); assert.equal(capture(store),true); }
  if (global.gc) { await tick(); global.gc(); await tick(); global.gc(); }
  const held=hold(); gate.full=held.wait;
  let completed=0;
  const open=()=>store.getState().activateSession(ids[0]).then(()=>completed++);
  const first=open(), also=open(); await tick();
  assert.deepEqual(requests.full,[...ids,ids[0]]); assert.equal(completed,0);
  const w=store.getState().openingReadingWindow; assert.ok(w);
  assert.equal(w.sessionId,ids[0]); assert.equal(w.anchorKey,'reply-stream'); assert.equal(w.offset,-73);
  assert.equal(w.hasBefore,true); assert.equal(w.hasAfter,false);
  assert.deepEqual(w.rows.map(row => row.sequence), [overRows-1,overRows], 'the ordering is the canonical timeline sequence');
  assert.deepEqual(w.rows.map(row=>[row.key,row.timelineId,row.message.content]),[
    ['question','timeline:question',`${ids[0]} question`],['reply-stream','timeline:reply',`**${ids[0]} complete reply**`]]);
  assert.equal(store.getState().projection,null); assert.equal('projection' in w,false); assert.ok(JSON.stringify(w).length<2000);
  const action=store.getState().awaitReadingProjection(w).then(p=>{ assert.equal(p.messages[0].content.length,8*MiB+1); return store.getState().setMessageFeedback('reply','up'); });
  assert.equal(requests.commands.length,0); held.release(); delete gate.full;
  await Promise.all([first,also,action]); assert.equal(completed,2); assert.equal(requests.commands.length,1);
  assert.deepEqual([requests.commands[0].type,requests.commands[0].sessionId,requests.commands[0].messageId],['message.feedback.set',ids[0],'reply']);
  assert.equal(store.getState().projection.messages.at(-1).feedback,'up'); assert.equal(store.getState().openingReadingWindow,null);
  assert.deepEqual(requests.full,[...ids,ids[0],ids[0]],'one recovery read plus one necessary post-command reconciliation');
});

test('an old revision, a failed status, or an ineligible window cannot flash a saved reading', async t => {
  const store=await loadGuiModelStore(t), {raw,requests,gate}=fixture(t,store);
  for (const id of ids) { await store.getState().activateSession(id); assert.equal(capture(store),true); }
  raw[ids[0]].revision++; raw[ids[0]].messages.at(-1).content='Edited after leaving';
  let held=hold(); gate.full=held.wait; const changed=store.getState().activateSession(ids[0]); await tick();
  assert.equal(store.getState().openingReadingWindow,null); assert.equal(store.getState().projection,null);
  held.release(); await changed; assert.equal(store.getState().projection.messages.at(-1).content,'Edited after leaving');
  gate.statusError=new Error('exact status failure'); gate.fullError=new Error('exact full read failure');
  held=hold(); gate.full=held.wait; const denied=store.getState().activateSession(ids[1]); await tick();
  assert.equal(store.getState().openingReadingWindow,null); held.release(); await denied;
  assert.equal(store.getState().error,'exact full read failure'); assert.equal(store.getState().statusError,'exact status failure');
  assert.deepEqual(requests.full,[...ids,...ids]);
});

test('identical session/revision and proxy origin on a different Host authorization never borrow the first store’s full or window data', async t => {
  const previous=globalThis.window;
  t.after(()=>{ if(previous===undefined) delete globalThis.window; else globalThis.window=previous; });
  async function load(token) {
    globalThis.window={location:{protocol:'http:',hostname:'achbit-gui.localhost',origin:'http://achbit-gui.localhost'},
      __ACHBIT_HOST_BOOT__:{schemaVersion:'achbit.host-ui-bootstrap',host:'127.0.0.1',port:'49132',uiToken:token,windowChrome:'custom'}};
    return loadGuiModelStore(t);
  }
  const credentials=[`acui_${'12'.repeat(32)}`,`acui_${'34'.repeat(32)}`], one=await load(credentials[0]),two=await load(credentials[1]);
  const ss=ids.map(sessionId=>({sessionId,revision:sessionId===ids[0]?overRows:15,run:{runId:'run:one',status:'completed'}}));
  for(const store of [one,two]) store.setState({catalog:{projects:[],sessions:ids.map(id=>({id,title:id,createdAt:date,updatedAt:date,workspaceBindings:[]}))},sessionStatuses:Object.fromEntries(ss.map(x=>[x.sessionId,x]))});
  const full=[];
  installGuiFetch(t,(url,init)=>{
    assert.equal(url.origin,'http://127.0.0.1:49132'); const host=credentials.indexOf(init.headers['x-achbit-host-ui-token']); assert.notEqual(host,-1);
    if(url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:ss});
    assert.ok(url.pathname.endsWith('/projection')); const id=decodeURIComponent(url.pathname.split('/')[4]); full.push([host,id]);
    const p=snapshot(id,{rows:id===ids[0]?overRows:3,reply:`private Host ${host}`}); return projectionResponse(p);
  });
  await one.getState().activateSession(ids[0]); const original=one.getState().projection; assert.equal(capture(one),true);
  await one.getState().activateSession(ids[1]); await two.getState().activateSession(ids[0]);
  assert.equal(two.getState().projection.messages.at(-1).content,'private Host 1'); assert.equal(two.getState().openingReadingWindow,null);
  await one.getState().activateSession(ids[0]); assert.equal(one.getState().projection,original); assert.equal(original.messages.at(-1).content,'private Host 0');
  assert.deepEqual(full,[[0,ids[0]],[0,ids[1]],[1,ids[0]]]);
});

test('catalog deletion/recreation retires both the window and its old revision floor, including during a held fresh-status check', async t => {
  const store=await loadGuiModelStore(t), {raw,requests,gate}=fixture(t,store);
  for (const id of ids) { await store.getState().activateSession(id); assert.equal(capture(store),true); }
  const delayed=hold(); gate.status=delayed.wait; const old=store.getState().activateSession(ids[0]); await tick();
  const [former,other]=store.getState().catalog.sessions;
  store.setState({catalog:{projects:[],sessions:[other]}});
  assert.equal(store.getState().sessionStatuses[ids[0]],undefined);
  store.setState({catalog:{projects:[],sessions:[{...former,createdAt:'new instance'},other]}});
  raw[ids[0]]=snapshot(ids[0],{revision:3}); raw[ids[0]].messages.at(-1).content='the new identity';
  delayed.release(); await old; delete gate.status;
  assert.equal(store.getState().projection,null); assert.equal(store.getState().openingReadingWindow,null); assert.equal(store.getState().error,'conversation_session_not_found');
  await store.getState().refresh(); await store.getState().activateSession(ids[0]);
  assert.equal(store.getState().error,null); assert.equal(store.getState().projection.revision,3); assert.equal(store.getState().projection.messages.at(-1).content,'the new identity');
  assert.deepEqual(requests.full,[...ids,ids[0]]);
});

const cached = projection => ({projection,contextWindowReading:null});

test('five individually sub-limit bodies above the former aggregate byte budget all remain whole', async t => {
  const {RecentSessionViews} = await loadGuiModule(t,'/src/state/recentSessionViews.ts'), cache = new RecentSessionViews();
  // Five distinct real bodies, each ~7.5 MiB UTF-8 / 5 MiB UTF-16: below the old single limit
  // in either unit; above the old aggregate in both. No five full JSON round trips here.
  const views = Array.from({length:5}, (_,i) => cached(snapshot(`session:sum-${i}`, {rows:1,reply:'甲乙丙丁戊'[i].repeat(5*MiB/2)})));
  const bytes = views.map(v => Buffer.byteLength(v.projection.messages[0].content,'utf8'));
  assert.ok(bytes.every(n => n<8*MiB) && bytes.reduce((a,b) => a+b,0)>24*MiB);
  for (const view of views) cache.put(view,null); // all five count as noncurrent
  cache.trim(null);
  for (const v of views) {
    assert.ok(cache.get(v.projection.sessionId) === v, 'byte totals alone must not demote an older whole view');
    assert.equal(cache.shouldRemember(v.projection),false); assert.equal(cache.candidate(v.projection.sessionId),undefined);
  }
});

test('whole-view admission does not traverse decoded message text or a retained context measurement to size it', async t => {
  const {RecentSessionViews} = await loadGuiModule(t,'/src/state/recentSessionViews.ts'), cache=new RecentSessionViews();
  const p=snapshot('session:read-cost',{rows:1}), reads=[];
  const reading={usage:{runId:'run:one',providerRequestId:'req:one',providerRuntimeRef:'runtime:one',inputTokens:1,outputTokens:1,contextWindowTokens:1000},receipt:null};
  // Observe real enumerable fields of the complete view and its separately retained reading.
  // No fabricated length or smaller test-only budget; consuming the view may still read them.
  for (const [object,key] of [[p.messages[0],'content'],[reading.usage,'providerRuntimeRef']]) {
    const value=object[key]; Object.defineProperty(object,key,{enumerable:true,get:()=>{reads.push(key);return value;}});
  }
  const view={projection:p,contextWindowReading:reading};cache.put(view,p.sessionId);
  assert.equal(cache.shouldRemember(p),false);cache.trim(null);assert.ok(cache.get(p.sessionId)===view);
  assert.deepEqual(reads,[],'neither message bodies nor context readings are part of the row/count admission policy');
});

test('32,768 real inactive rows are admissible; 32,769 are exempt only while current', async t => {
  const {RecentSessionViews} = await loadGuiModule(t,'/src/state/recentSessionViews.ts'), cache = new RecentSessionViews();
  const exact = cached(snapshot('session:exact',{rows:rowLimit})), overView = cached(over('session:one-over'));
  const a=exact.projection.sessionId, b=overView.projection.sessionId;
  cache.put(exact,a); assert.equal(cache.shouldRemember(exact.projection),false); cache.trim(null); assert.ok(cache.get(a) === exact);
  cache.put(overView,b); assert.ok(cache.get(b) === overView); assert.ok(cache.get(a) === exact, 'the active view spends no inactive row allowance');
  assert.equal(cache.shouldRemember(overView.projection),true); assert.equal(cache.remember(overView.projection,range),true);
  cache.trim(a); assert.ok(cache.get(a) === exact); assert.equal(cache.has(b),false);
  assert.ok(cache.candidate(b)?.weak?.deref() === overView); assert.equal(cache.candidate(b)?.window.anchorKey,'reply-stream');
});

test('cumulative inactive rows evict by recency at exactly one extra row, below the six-view limit', async t => {
  const {RecentSessionViews} = await loadGuiModule(t,'/src/state/recentSessionViews.ts'), cache = new RecentSessionViews();
  const active=cached(snapshot('session:current')), a=cached(snapshot('session:half-a',{rows:rowLimit/2})), b=cached(snapshot('session:half-b',{rows:rowLimit/2}));
  const id=active.projection.sessionId; cache.put(active,id); cache.put(a,id); cache.put(b,id);
  assert.ok(cache.get(a.projection.sessionId) === a && cache.get(b.projection.sessionId) === b, 'exactly 32,768 noncurrent rows fit');
  assert.equal(cache.shouldRemember(active.projection),true, 'the active reader can capture a window when all three together exceed the row budget');
  cache.put(a,id); // readmission refreshes A, so B, not A, is the oldest half
  const extra=cached(snapshot('session:last-row',{rows:1})); cache.put(extra,id);
  assert.ok(cache.get(id) === active && cache.get(a.projection.sessionId) === a && cache.get(extra.projection.sessionId) === extra);
  assert.equal(cache.has(b.projection.sessionId),false); assert.ok(cache.candidate(b.projection.sessionId)?.weak?.deref() === b);
});

test('six complete views including the current one fit; the seventh displaces the least recently admitted view', async t => {
  const {RecentSessionViews} = await loadGuiModule(t,'/src/state/recentSessionViews.ts'), cache = new RecentSessionViews();
  const views = Array.from({length:7}, (_,i) => cached(snapshot(`session:six-${i}`)));
  const id = i => views[i].projection.sessionId;
  for (const v of views.slice(0,6)) cache.put(v,v.projection.sessionId);
  for (let i=0;i<6;i++) assert.ok(cache.get(id(i))===views[i], 'exactly six fit');
  cache.put(cache.get(id(0)),id(0)); // same re-admission that a settled store activation performs
  cache.put(views[6],id(6));
  assert.deepEqual(views.map((_,i)=>cache.has(id(i))),[true,false,true,true,true,true,true]);
  assert.equal(cache.candidate(id(1)),undefined, 'a count-only eviction does not consume a weak/window slot');
});

test('row-evicted reading windows keep their own count, byte and row budgets; unsupported rows are not silently skipped', async t => {
  const {RecentSessionViews}=await loadGuiModule(t,'/src/state/recentSessionViews.ts');
  const cache=new RecentSessionViews(), mk=id=>over(`session:${id}`);
  const put=p=>cache.put({projection:p,contextWindowReading:null},p.sessionId);
  const one=mk('one'),two=mk('two'),three=mk('three');
  for (const p of [one,two,three]) { put(p); assert.equal(cache.remember(p,range),true); cache.trim(null); assert.equal(cache.has(p.sessionId),false); }
  assert.equal(cache.candidate(one.sessionId),undefined); assert.ok(cache.candidate(two.sessionId)?.window); assert.ok(cache.candidate(three.sessionId)?.window);
  for (const p of [one,two,three]) { p.messages.at(-1).content='z'.repeat(110*1024); put(p); assert.equal(cache.remember(p,range),true); cache.trim(null); }
  assert.equal(cache.candidate(two.sessionId),undefined,'two individually admissible windows together exceed the total byte allowance');
  three.messages.at(-1).content='z'.repeat(300*1024); put(three); assert.equal(cache.remember(three,range),false);
  three.messages.at(-1).content='This suffix cannot replace the entire requested screen'; three.messages[0].content=jumboBody; put(three);
  assert.equal(cache.remember(three,{firstRowKey:'earlier',lastRowKey:'earlier',anchorKey:'earlier',offset:0}),false,'reject, do not truncate even a single huge row');
  const seq=three.timeline.at(-1).sequence; three.messages.at(-1).sequence=++three.revision; three.timeline.at(-1).sequence=three.revision;
  three.activities.push({activityId:'activity',kind:'tool',status:'completed',label:'fs.read',runId:'run:one',sequence:seq,tool:{operation:'fs.read',resources:[]}});
  three.timeline.splice(-1,0,{kind:'toolGroup',timelineId:'tool',sequence:seq,providerRequestId:'req:one',activityIds:['activity']});
  assert.equal(cache.remember(three,range),false,'a gap in the supported renderable types invalidates the whole span');
  const long=mk('rows'); const original=long.messages.at(-1);
  for(let n=0;n<24;n++){const sequence=++long.revision;long.messages.push({...original,messageId:`m:${n}`,sequence}); long.timeline.push({kind:'message',messageId:`m:${n}`,streamId:`s:${n}`,timelineId:`t:${n}`,sequence});}
  put(long); assert.equal(cache.remember(long,{...range,lastRowKey:'s:23'}),false,'do not trim a requested 26-row screen to 24');
  const small=snapshot('session:small'); put(small); assert.equal(cache.shouldRemember(small),false,'ordinary small sessions do not walk their history for window capture');
  const inherited=mk('child'); inherited.agentContext={ownerSessionId:'parent',parentSessionId:'parent',parentRunId:'parent-run',parentCallId:'parent-call',capabilities:{messaging:true,continuation:true,delegation:true}}; put(inherited);
  assert.equal(cache.remember(inherited,range),false);cache.trim(null);assert.equal(cache.candidate(inherited.sessionId),undefined,'no weak whole-view reuse either');
});
