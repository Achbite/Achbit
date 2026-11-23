// TCR: T-020-GUI_Startup-20261121/locality-fix/revision-window/reading-first-02/0.7.88-fix/integration/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession, SessionService } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';
import { installGuiFetch, loadGuiModelStore, loadGuiModule } from './gui-projection-contract.mjs';

const tick = () => new Promise(r => setImmediate(r));
const hold = () => { const {promise, resolve} = Promise.withResolvers(); return {wait:promise, release:resolve}; };
const ok = (data, headers) => Response.json({ok:true, data}, {headers});
const capable = {'x-achbit-reading-window':'1'};
function full(id, turns) {
  const p = projectSession(emptySessionState(id)); p.revision = turns * 7 + 1;
  p.run = {runId:'r:last', status:'completed', profileId:'p:one', workspaceBindings:[]};
  for (let i=0; i<turns*2; i++) {
    const role=i%2?'assistant':'user', messageId=`${id}:m${i}`, sequence=1+i*3;
    p.messages.push({messageId,role,sequence,content:`${id} **complete ${i}**`,createdAt:'2026-11-23',feedback:null,filesystemReferences:[],pluginSelections:[],
      ...(role==='assistant'?{runId:`r:${i}`,providerRequestId:`q:${i}`}:{})});
    p.timeline.push({kind:'message',messageId,sequence,timelineId:`message:${messageId}`,...(role==='assistant'?{streamId:`${id}:stream${i}`}:{})});
  }
  return p;
}
const rowKey = row => row.streamId ?? row.messageId;
const status = p => ({sessionId:p.sessionId,revision:p.revision,run:{runId:p.run.runId,status:p.run.status}});
function catalog(store, ...views) {
  store.setState({catalog:{projects:[],sessions:views.map(p=>({id:p.sessionId,title:p.sessionId,createdAt:'t',updatedAt:'t',workspaceBindings:[]}))}});
}
function page(p, anchorKey, limit=12) {
  const rows=p.timeline.map((r,i)=>({key:rowKey(r),timelineId:r.timelineId,sequence:r.sequence,...(r.streamId?{streamId:r.streamId}:{}),message:p.messages[i]}));
  const target=anchorKey===undefined?rows.length-1:rows.findIndex(row=>row.key===anchorKey); assert.ok(target>=0);
  const startIndex=Math.max(0,Math.min(target-Math.floor(limit/2),rows.length-limit));
  return {sessionId:p.sessionId,revision:p.revision,view:'readingWindow',items:[],nextBefore:null,readingWindow:{kind:'ready',anchorKey:rows[target].key,startIndex,totalRows:rows.length,
    rows:rows.slice(startIndex,startIndex+limit),navigation:{keys:p.messages.filter(m=>m.role==='user').map(m=>m.messageId),labels:p.messages.filter(m=>m.role==='user').map(m=>m.content)}}};
}

for (const turns of [32,512,1024]) test(`opening ${turns} turns reads full immediately, including with an advertised reading-window API`,async t=>{
  const p=full(`session:direct-${turns}`,turns),store=await loadGuiModelStore(t),held=hold(),started=hold(),seen=[];
  catalog(store,p);t.after(held.release);
  installGuiFetch(t,async url=>{
    if (url.pathname.endsWith('/statuses')) return ok([status(p)],capable);
    seen.push(url.pathname.split('/').at(-1)); assert.ok(url.pathname.endsWith('/projection')); started.release();await held.wait;return ok(p);
  });
  await store.getState().refresh();const anchor=turns===512?{key:rowKey(p.timeline[turns]),offset:-23}:undefined;
  const first=store.getState().activateSession(p.sessionId,anchor);await started.wait;
  const same=store.getState().activateSession(p.sessionId);await tick();
  assert.deepEqual(seen,['projection']);assert.equal(store.getState().projection,null);assert.equal(store.getState().openingReadingWindow,null);
  held.release();await Promise.all([first,same]); assert.deepEqual(store.getState().projection,p);assert.deepEqual(seen,['projection']);
});

test('an explicit revision reader preserves canonical rows, anchor/offset indexing, and the producer fallback discriminator',async t=>{
  const p=full('session:explicit',32),{readRevisionWindow}=await loadGuiModule(t,'/src/services/localAgentApi.ts');
  let fallback=false;installGuiFetch(t,async (url,init)=>{
    assert.ok(url.pathname.endsWith('/read'));const q=JSON.parse(init.body);assert.equal(q.throughSequence,p.revision);assert.equal(q.view,'readingWindow');
    const body=page(p,q.anchorKey,q.limit);return ok(fallback?{...body,readingWindow:{kind:'requiresProjection'}}:body);
  });
  for(const key of [undefined,rowKey(p.timeline[22])]) assert.deepEqual(await readRevisionWindow(p.sessionId,p.revision,new AbortController().signal,key),page(p,key).readingWindow);
  fallback=true;assert.deepEqual(await readRevisionWindow(p.sessionId,p.revision,new AbortController().signal),{kind:'requiresProjection'});
});

test('explicit malformed, wrong-owner or denied windows keep their original failure and never retry a full read',async t=>{
  const p=full('session:badwindow',12),{readRevisionWindow}=await loadGuiModule(t,'/src/services/localAgentApi.ts'); let decorate;
  installGuiFetch(t,async url=>{assert.ok(url.pathname.endsWith('/read'));return decorate(structuredClone(page(p)));});
  for(const [transform,error] of [[x=>ok({...x,revision:p.revision-1}),/revision/],[x=>ok({...x,sessionId:'elsewhere'}),/identity/],
    [x=>{x.readingWindow.rows[1].message.content=2;return ok(x);},/invalid/],[x=>{x.readingWindow.rows[0].key='not the stream or message';return ok(x);},/invalid/],
    [x=>ok({...x,items:[{truncated:true}]}),/invalid/],[x=>{x.readingWindow.navigation.labels.pop();return ok(x);},/invalid/],
    [x=>{x.readingWindow.rows.at(-1).message.content='😀'.repeat(70_000);return ok(x);},/invalid/],[x=>{x.readingWindow.anchorKey=x.readingWindow.rows[0].key;return ok(x);},/anchor/],
    [()=>Response.json({ok:false,error:'session_forbidden',message:'private failure'},{status:403}),/session_forbidden:private failure/],
    [()=>Response.json({ok:false,error:'conversation_read_revision_changed',message:'current revision required'},{status:409}),/conversation_read_revision_changed:current revision required/]]) {
    decorate=transform;await assert.rejects(readRevisionWindow(p.sessionId,p.revision,new AbortController().signal),error);
  }
});

test('a real settled journal: explicit windows, ordinary GUI opens, and feedback agree on canonical targets',async t=>{
  const id='session:producer-gui-window',journal=new InMemoryCommandJournal();await createSession(journal,id);
  const actor=actorWith(journal,id,{async *stream(req){yield providerEvent(req.requestId,'text.delta',{text:'**Canonical** 完整回答'});yield providerEvent(req.requestId,'completed',{});}},emptyKernel(),fakeRunPreparation().port,'gui-window');
  t.after(()=>actor.dispose());await actor.submit(messageCommand(id,'command:produce','Original question'));
  const actual=await waitForProjection(actor,p=>p.run?.status==='completed');
  const service=new SessionService(journal,{async create(){throw new Error('unwanted actor');}});t.after(()=>service.dispose());
  const store=await loadGuiModelStore(t),{readRevisionWindow}=await loadGuiModule(t,'/src/services/localAgentApi.ts'),seen=[]; catalog(store,actual);
  installGuiFetch(t,async(url,init)=>{
    if(url.pathname.endsWith('/statuses'))return ok(await service.statuses([id]),{'x-achbit-reading-window':String(service.readingWindowVersion)});
    if(url.pathname.endsWith('/read')){seen.push('read');return ok(await service.read({...JSON.parse(init.body),sessionId:id}));}
    if(url.pathname.endsWith('/commands')){seen.push('command');return ok(await actor.submit(JSON.parse(init.body)));}
    assert.ok(url.pathname.endsWith('/projection'));seen.push('full');return ok(await service.snapshot(id));
  });
  await store.getState().refresh();await store.getState().activateSession(id);assert.deepEqual(seen,['full']);assert.deepEqual(store.getState().projection,actual);
  const w=await readRevisionWindow(id,actual.revision,new AbortController().signal);assert.deepEqual(w.rows.map(r=>r.message),actual.messages);
  assert.deepEqual(w.rows.map(r=>r.key),actual.timeline.map(rowKey));assert.deepEqual(w.rows.map(r=>r.timelineId),actual.timeline.map(r=>r.timelineId));
  await store.getState().setMessageFeedback(w.rows.at(-1).message.messageId,'up');const oracle=await service.snapshot(id);
  assert.deepEqual(store.getState().projection,oracle);assert.equal(oracle.messages.at(-1).feedback,'up');assert.deepEqual(seen,['full','read','command','full']);
});

test('a newer status while a direct read is in flight raises its floor; a denied replacement is not a successful open',async t=>{
  const p=full('session:floor',8),store=await loadGuiModelStore(t),held=hold(),started=hold();catalog(store,p);t.after(held.release);
  let revision=p.revision,reads=0,deny=false;installGuiFetch(t,async url=>{
    if(url.pathname.endsWith('/statuses')) return ok([{...status(p),revision}],capable);
    assert.ok(url.pathname.endsWith('/projection'));const captured=revision;
    if(++reads===1){started.release();await held.wait;return ok({...p,revision:captured});}
    return deny?Response.json({ok:false,error:'session_forbidden',message:'no longer available'},{status:403}):ok({...p,revision:captured});
  });
  await store.getState().refresh();const opening=store.getState().activateSession(p.sessionId);await started.wait;revision++;await store.getState().refresh();
  assert.equal(store.getState().projection,null);deny=true;held.release();await opening;
  assert.equal(reads,2);assert.equal(store.getState().projection,null);assert.equal(store.getState().error,'session_forbidden:no longer available');
});

test('a rapid cold A/B/A joins only the correct in-flight full and never publishes B or its late error',async t=>{
  const a=full('session:cold-a',12),b=full('session:cold-b',12),store=await loadGuiModelStore(t),ha=hold(),hb=hold(),sa=hold(),sb=hold(),seen=[];
  t.after(()=>{ha.release();hb.release();});catalog(store,a,b);
  installGuiFetch(t,async url=>{
    if(url.pathname.endsWith('/statuses'))return ok([status(a),status(b)],capable);
    assert.ok(url.pathname.endsWith('/projection'));const id=decodeURIComponent(url.pathname.split('/').at(-2));seen.push(id);
    if(id===a.sessionId){sa.release();await ha.wait;return ok(a);}assert.equal(id,b.sessionId);sb.release();await hb.wait;throw Error('left B');
  });
  await store.getState().refresh();const first=store.getState().activateSession(a.sessionId);await sa.wait;
  const other=store.getState().activateSession(b.sessionId);await sb.wait;const back=store.getState().activateSession(a.sessionId);
  hb.release();ha.release();await Promise.all([first,other,back]);assert.deepEqual(seen,[a.sessionId,b.sessionId]);assert.deepEqual(store.getState().projection,a);assert.equal(store.getState().error,null);
});
