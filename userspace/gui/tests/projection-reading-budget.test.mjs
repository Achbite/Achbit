// TCR: .task-artifacts/T-020-GUI_Startup-20261121/locality-fix/data/TCR-budget.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore, loadGuiModule } from './gui-projection-contract.mjs';

const MiB = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
const date = '2026-11-22T02:00:00Z';
const ids = ['session:budget-a', 'session:budget-b'];
const range = { firstRowKey: 'question', lastRowKey: 'reply-stream', anchorKey: 'reply-stream', offset: -73 };
function snapshot(id, jumbo = 8 * MiB + 1, revision = 15) {
  const p = projectSession(emptySessionState(id)), runId = 'run:one';
  p.revision = revision; p.run = { runId, status: 'completed', profileId: 'p:one', workspaceBindings: [] };
  p.messages = [['earlier', 'user', 'X'.repeat(jumbo)], ['question', 'user', `${id} question`], ['reply', 'assistant', `**${id} complete reply**`]].map(([messageId, role, content], index) => ({ messageId, role, content, feedback: null,
    filesystemReferences: [], pluginSelections: [], sequence: index + 1, createdAt: date,
    ...(role === 'assistant' ? { runId, providerRequestId: 'req:one' } : {}) }));
  p.timeline = p.messages.map(m => ({ kind: 'message', messageId: m.messageId, timelineId: `timeline:${m.messageId}`, sequence: m.sequence,
    ...(m.role === 'assistant' ? { streamId: 'reply-stream' } : {}) }));
  return p;
}
function fixture(t, store) {
  const raw = Object.fromEntries(ids.map(id => [id, snapshot(id)]));
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
    return reply(raw[id]);
  });
  return { raw, requests, gate };
}
function capture(store) { const s=store.getState(); return s.rememberReadingWindow(s.projection, range); }
function hold() { let release; const wait = new Promise(r => { release = r; }); return { wait, release }; }

test('two over-budget complete views: four alternating weak hits require four fresh Host receipts and zero extra full reads', async t => {
  const store=await loadGuiModelStore(t), {requests,gate}=fixture(t,store), originals=[];
  for (const id of ids) { await store.getState().activateSession(id); assert.equal(store.getState().error,null); originals.push(store.getState().projection); assert.equal(capture(store),true); }
  const ack=hold(); gate.status=ack.wait;
  const first=store.getState().activateSession(ids[0]); await tick();
  assert.equal(store.getState().projection,null, 'having a live WeakRef is not a fresh Host status'); assert.equal(store.getState().openingReadingWindow,null);
  ack.release(); await first; delete gate.status;
  for (const n of [1,0,1]) { await store.getState().activateSession(ids[n]); assert.equal(store.getState().projection,originals[n]); }
  assert.deepEqual(requests.full,ids); assert.equal(requests.status,4);
  assert.equal(store.getState().projection.messages[0].content.length,8*MiB+1,'the API delivers the complete offscreen message');
});

test('when an oversized whole view is unavailable the real rows survive; completion and the original action await the one real full read', async t => {
  const store=await loadGuiModelStore(t), {requests,gate}=fixture(t,store);
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
  assert.deepEqual(w.rows.map(row => row.sequence), [2,3], 'the ordering is the canonical timeline sequence');
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
  const ss=ids.map(sessionId=>({sessionId,revision:15,run:{runId:'run:one',status:'completed'}}));
  for(const store of [one,two]) store.setState({catalog:{projects:[],sessions:ids.map(id=>({id,title:id,createdAt:date,updatedAt:date,workspaceBindings:[]}))},sessionStatuses:Object.fromEntries(ss.map(x=>[x.sessionId,x]))});
  const full=[];
  installGuiFetch(t,(url,init)=>{
    assert.equal(url.origin,'http://127.0.0.1:49132'); const host=credentials.indexOf(init.headers['x-achbit-host-ui-token']); assert.notEqual(host,-1);
    if(url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:ss});
    assert.ok(url.pathname.endsWith('/projection')); const id=decodeURIComponent(url.pathname.split('/')[4]); full.push([host,id]);
    const p=snapshot(id,id===ids[0]?5*MiB:1); p.messages.at(-1).content=`private Host ${host}`; return Response.json({ok:true,data:p});
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
  raw[ids[0]]=snapshot(ids[0],12,3); raw[ids[0]].messages.at(-1).content='the new identity';
  delayed.release(); await old; delete gate.status;
  assert.equal(store.getState().projection,null); assert.equal(store.getState().openingReadingWindow,null); assert.equal(store.getState().error,'conversation_session_not_found');
  await store.getState().refresh(); await store.getState().activateSession(ids[0]);
  assert.equal(store.getState().error,null); assert.equal(store.getState().projection.revision,3); assert.equal(store.getState().projection.messages.at(-1).content,'the new identity');
  assert.deepEqual(requests.full,[...ids,ids[0]]);
});

test('the cache budgets whole and window data by bytes, rows and recency; unsupported rows are not silently skipped', async t => {
  const {RecentSessionViews}=await loadGuiModule(t,'/src/state/recentSessionViews.ts');
  const cache=new RecentSessionViews(), mk=(id,n=1,rev=15)=>snapshot(`session:${id}`,n,rev);
  const put=p=>cache.put({projection:p,contextWindowReading:null},p.sessionId);
  const one=mk('one',5*MiB),two=mk('two',5*MiB),three=mk('three',5*MiB);
  for (const p of [one,two,three]) { put(p); assert.equal(cache.remember(p,range),true); cache.trim(null); assert.equal(cache.has(p.sessionId),false); }
  assert.equal(cache.candidate(one.sessionId),undefined); assert.ok(cache.candidate(two.sessionId)?.window); assert.ok(cache.candidate(three.sessionId)?.window);
  for (const p of [one,two,three]) { p.messages.at(-1).content='z'.repeat(110*1024); put(p); assert.equal(cache.remember(p,range),true); cache.trim(null); }
  assert.equal(cache.candidate(two.sessionId),undefined,'two individually admissible windows together exceed the total byte allowance');
  three.messages.at(-1).content='z'.repeat(300*1024); put(three); assert.equal(cache.remember(three,range),false);
  three.messages.at(-1).content='This suffix cannot replace the entire requested screen'; put(three);
  assert.equal(cache.remember(three,{...range,firstRowKey:'earlier'}),false,'reject, do not truncate the huge row');
  three.timeline.splice(2,0,{kind:'toolGroup',timelineId:'tool',sequence:20,activityIds:['activity']});
  assert.equal(cache.remember(three,range),false,'a gap in the supported renderable types invalidates the whole span');
  const long=mk('rows',5*MiB); const original=long.messages.at(-1);
  for(let n=0;n<24;n++){long.messages.push({...original,messageId:`m:${n}`,sequence:10+n}); long.timeline.push({kind:'message',messageId:`m:${n}`,streamId:`s:${n}`,timelineId:`t:${n}`,sequence:10+n});}
  put(long); assert.equal(cache.remember(long,{...range,lastRowKey:'s:23'}),false,'do not trim a requested 26-row screen to 24');
  const small=mk('small',512); put(small); assert.equal(cache.shouldRemember(small),false,'ordinary small sessions do not walk their history for window capture');
  const many=new RecentSessionViews();
  for(let i=0;i<5;i++){const p=mk(`budget-${i}`,3*MiB); many.put({projection:p,contextWindowReading:null},p.sessionId);}
  many.trim(null); assert.equal(many.has('session:budget-0'),false,'total strong charge is bounded even below the item count limit');
  assert.equal(many.has('session:budget-4'),true);
  const inherited=mk('child',5*MiB); inherited.agentContext={ownerSessionId:'parent'}; put(inherited);
  assert.equal(cache.remember(inherited,range),false);cache.trim(null);assert.equal(cache.candidate(inherited.sessionId),undefined,'no weak whole-view reuse either');
});
