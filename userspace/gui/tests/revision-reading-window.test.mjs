// TCR: .task-artifacts/T-020-GUI_Startup-20261121/locality-fix/revision-window/gui/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySessionState, projectSession, SessionService } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';
import { installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';

const tick = () => new Promise(r => setImmediate(r));
function hold() { let release; const wait = new Promise(r => { release = r; }); return { wait, release }; }
function full(id, turns) {
  const p = projectSession(emptySessionState(id)); p.revision = turns * 7 + 1;
  p.run = { runId:'r:last', status:'completed', profileId:'p:one', workspaceBindings:[] };
  for (let i=0; i<turns*2; i++) {
    const role=i%2?'assistant':'user', messageId=`${id}:m${i}`, sequence=1+i*3;
    p.messages.push({messageId,role,sequence,content:`${id} **complete ${i}**`,createdAt:'2026-11-23',feedback:null,filesystemReferences:[],pluginSelections:[],
      ...(role==='assistant'?{runId:`r:${i}`,providerRequestId:`q:${i}`}:{})});
    p.timeline.push({kind:'message',messageId,sequence,timelineId:`message:${messageId}`,...(role==='assistant'?{streamId:`${id}:stream${i}`}:{})});
  }
  return p;
}
const rowKey = item => item.streamId ?? item.messageId;
function page(p, anchorKey, limit=12) {
  const norm = p.timeline.map((item,i)=>({key:rowKey(item),timelineId:item.timelineId,sequence:item.sequence,...(item.streamId?{streamId:item.streamId}:{}),message:p.messages[i]}));
  const target = anchorKey===undefined?norm.length-1:norm.findIndex(x=>x.key===anchorKey);
  assert.ok(target>=0);
  const startIndex=Math.max(0,Math.min(target-Math.floor(limit/2),norm.length-limit));
  return {sessionId:p.sessionId,revision:p.revision,view:'readingWindow',items:[],nextBefore:null,readingWindow:{kind:'ready',anchorKey:norm[target].key,startIndex,totalRows:norm.length,
    rows:norm.slice(startIndex,startIndex+limit),navigation:{keys:p.messages.filter(m=>m.role==='user').map(m=>m.messageId),labels:p.messages.filter(m=>m.role==='user').map(m=>m.content)}}};
}
const ok = (data,headers) => Response.json({ok:true,data},{headers});
function transport(t,store,snapshots,opt={}) {
  const seen=[];const headers=opt.capable===false?{}:{'x-achbit-reading-window':'1'};
  store.setState({catalog:{projects:[],sessions:Object.keys(snapshots).map(id=>({id,title:id,createdAt:'t',updatedAt:'t',workspaceBindings:[]}))}});
  installGuiFetch(t,async(url,init)=>{
    if(url.pathname.endsWith('/statuses')){seen.push('status'); return ok(Object.values(snapshots).map(p=>({sessionId:p.sessionId,revision:p.revision,run:{runId:p.run.runId,status:p.run.status}})),headers);}
    const id=decodeURIComponent(url.pathname.split('/')[4]), p=snapshots[id]; assert.ok(p,id);
    if(url.pathname.endsWith('/read')){const query=JSON.parse(init.body); seen.push({id,query,signal:init.signal});
      assert.equal(query.view,'readingWindow','no excerpt substitutes for a revision window');return opt.read?opt.read(p,query,init):ok(page(p,query.anchorKey,query.limit));}
    assert.ok(url.pathname.endsWith('/projection'),url.pathname);seen.push(`full:${id}`);
    if(opt.full) await opt.full(p,init);return ok(p);
  });return seen;
}
for(const turns of [32,512,1024]) test(`cold ${turns}-turn opened history presents the exact revision/anchor before a full read, first demand joins the canonical completion`,async t=>{
  const id=`session:window-${turns}`,p=full(id,turns),store=await loadGuiModelStore(t),held=hold();t.after(held.release);
  const seen=transport(t,store,{[id]:p},{full:()=>held.wait});
  await store.getState().refresh();const i=turns===512?turns:undefined;
  const anchor=i===undefined?undefined:{key:rowKey(p.timeline[i]),offset:-23};
  const opening=store.getState().activateSession(id,anchor);await tick();
  const w=store.getState().openingReadingWindow;assert.ok(w,'a successful HTTP capability receipt enabled the cold path');assert.equal(w.source,'revisionWindow');
  assert.equal(store.getState().projection,null);const expected=page(p,anchor?.key).readingWindow;
  assert.deepEqual(w.rows,expected.rows);assert.equal(w.offset,anchor?.offset??0);assert.equal(w.startIndex,expected.startIndex);assert.equal(w.totalRows,p.timeline.length);
  assert.deepEqual(w.surface.navigation.keys,expected.navigation.keys);assert.equal(w.surface.before,w.startIndex*120);
  assert.deepEqual(seen.filter(x=>typeof x==='object').map(x=>x.query),[{view:'readingWindow',throughSequence:p.revision,...(anchor?{anchorKey:anchor.key}:{}) ,limit:12}]);
  assert.ok(!seen.includes(`full:${id}`),'no whole-history transport races the cold window');
  const firstScroll=store.getState().awaitReadingProjection(w), second=store.getState().awaitReadingProjection(w);await tick();
  assert.equal(seen.filter(x=>x===`full:${id}`).length,1);assert.equal(store.getState().projection,null);
  held.release();await opening;assert.deepEqual(await firstScroll,p);assert.equal(await second,store.getState().projection);assert.equal(store.getState().openingReadingWindow,null);
});

test('the advertised producer alone can request canonical fallback; known legacy status never sends an unsupported view',async t=>{
  for(const capable of [true,false]){const store=await loadGuiModelStore(t),id='session:fallback',p=full(id,8);
    const seen=transport(t,store,{[id]:p},{capable,read:()=>ok({...page(p),readingWindow:{kind:'requiresProjection'}})});
    await store.getState().refresh();await store.getState().activateSession(id);
    assert.deepEqual(store.getState().projection,p);assert.equal(seen.filter(x=>typeof x==='object').length,+capable);assert.equal(seen.filter(x=>x===`full:${id}`).length,1);
  }
});

test('an advertised malformed, wrong-revision, wrong-owner or denied window never retries the legacy full read',async t=>{
  const id='session:badwindow',p=full(id,12),store=await loadGuiModelStore(t);let decorate;
  const seen=transport(t,store,{[id]:p},{read:()=>decorate(structuredClone(page(p)))});await store.getState().refresh();
  for(const [transform,error] of [[x=>ok({...x,revision:p.revision-1}),/revision/], [x=>ok({...x,sessionId:'elsewhere'}),/identity/],
    [x=>{x.readingWindow.rows[1].message.content=2;return ok(x);},/invalid/], [x=>{x.readingWindow.rows[0].key='not the stream or message';return ok(x);},/invalid/],
    [x=>ok({...x,items:[{truncated:true}]}),/invalid/],
    [x=>{x.readingWindow.navigation.labels.pop();return ok(x);},/invalid/],
    [x=>{x.readingWindow.rows.at(-1).message.content='😀'.repeat(70_000);return ok(x);},/invalid/],
    [x=>{x.readingWindow.anchorKey=x.readingWindow.rows[0].key;return ok(x);},/anchor/], [()=>Response.json({ok:false,error:'session_forbidden',message:'private failure'},{status:403}),/session_forbidden:private failure/]]){
    decorate=transform;await store.getState().activateSession(id);assert.match(store.getState().error,error);assert.equal(store.getState().openingReadingWindow,null);assert.equal(store.getState().projection,null);
  }
  assert.ok(!seen.includes(`full:${id}`));
});

test('a real settled Session journal crosses the public read and GUI decoder with the same canonical row targets and feedback command', async t=>{
  const id='session:producer-gui-window',journal=new InMemoryCommandJournal();await createSession(journal,id);
  const actor=actorWith(journal,id,{async *stream(req){yield providerEvent(req.requestId,'text.delta',{text:'**Canonical** 完整回答'});yield providerEvent(req.requestId,'completed',{});}},emptyKernel(),fakeRunPreparation().port,'gui-window');
  t.after(()=>actor.dispose());await actor.submit(messageCommand(id,'command:produce','Original question'));
  const actual=await waitForProjection(actor,p=>p.run?.status==='completed');
  const service=new SessionService(journal,{async create(){throw new Error('unwanted actor');}});t.after(()=>service.dispose());
  const store=await loadGuiModelStore(t),seen=[];store.setState({catalog:{projects:[],sessions:[{id,createdAt:'t'}]}});
  let oracle=await service.snapshot(id);assert.deepEqual(oracle,actual);
  installGuiFetch(t,async(url,init)=>{
    if(url.pathname.endsWith('/statuses'))return ok(await service.statuses([id]),{'x-achbit-reading-window':String(service.readingWindowVersion)});
    if(url.pathname.endsWith('/read')){seen.push('read');return ok(await service.read({...JSON.parse(init.body),sessionId:id}));}
    if(url.pathname.endsWith('/commands')){seen.push('command');return ok(await actor.submit(JSON.parse(init.body)));}
    assert.ok(url.pathname.endsWith('/projection'));seen.push('full');return ok(await service.snapshot(id));
  });
  await store.getState().refresh();const published=hold();t.after(published.release);
  t.after(store.subscribe(s=>{if(s.openingReadingWindow||s.error)published.release();}));
  const opening=store.getState().activateSession(id);await published.wait;
  const w=store.getState().openingReadingWindow;assert.ok(w,store.getState().error??'missing real window');assert.deepEqual(seen,['read']);
  assert.deepEqual(w.rows.map(r=>r.message),oracle.messages);assert.deepEqual(w.rows.map(r=>r.key),oracle.timeline.map(rowKey));
  assert.deepEqual(w.rows.map(r=>r.timelineId),oracle.timeline.map(r=>r.timelineId));
  assert.deepEqual(await store.getState().awaitReadingProjection(w),oracle);await opening;
  await store.getState().setMessageFeedback(w.rows.at(-1).message.messageId,'up');oracle=await service.snapshot(id);
  assert.deepEqual(store.getState().projection,oracle);assert.equal(oracle.messages.at(-1).feedback,'up');assert.deepEqual(seen,['read','full','command','full']);
});

test('a reported revision race requires an independent new status; a malformed old page is not this retry',async t=>{
  const id='session:revision-race',p=full(id,12),store=await loadGuiModelStore(t);let reads=0;
  const seen=transport(t,store,{[id]:p},{read:(v,q)=>{if(++reads===1){v.revision++;v.messages.at(-1).content='only new text';return Response.json({ok:false,error:'conversation_read_revision_changed',message:'conversation_read_revision_changed'},{status:409});}return ok(page(v,q.anchorKey));}});
  await store.getState().refresh();const first=p.revision;const opening=store.getState().activateSession(id);await tick();const w=store.getState().openingReadingWindow;
  assert.equal(w?.revision,first+1);assert.equal(w.rows.at(-1).message.content,'only new text');assert.deepEqual(seen.map(x=>typeof x==='string'?x:x.query.throughSequence),['status',first,'status',first+1]);
  store.getState().readingWindowPresented(w);await opening;assert.equal(seen.filter(x=>x===`full:${id}`).length,1);
});

test('a late cold window can hand off A/B/A but no abandoned view starts its full restoration',async t=>{
  const a='session:cold-a',b='session:cold-b',sa=full(a,12),sb=full(b,12),store=await loadGuiModelStore(t),ha=hold(),hb=hold();t.after(()=>{ha.release();hb.release();});
  const seen=transport(t,store,{[a]:sa,[b]:sb},{read:async(p,q)=>{await(p.sessionId===a?ha:hb).wait;return ok(page(p,q.anchorKey));}});
  await store.getState().refresh();const old=store.getState().activateSession(a);await tick();const away=store.getState().activateSession(b);await tick();const back=store.getState().activateSession(a);await tick();
  const reads=seen.filter(x=>typeof x==='object');assert.deepEqual(reads.map(x=>x.id),[a,b]);assert.equal(reads[0].signal.aborted,false);
  hb.release();ha.release();await tick();const w=store.getState().openingReadingWindow;assert.equal(w?.sessionId,a);
  store.getState().readingWindowPresented(w);await Promise.all([old,away,back]);assert.equal(store.getState().projection.sessionId,a);assert.ok(!seen.includes(`full:${b}`));
});

test('leaving an acknowledged or not-yet-acknowledged window cancels its recovery gate and stale interactions',async t=>{
  const a='session:leave-a',b='session:leave-b',store=await loadGuiModelStore(t),sa=full(a,8),sb=full(b,8);const seen=transport(t,store,{[a]:sa,[b]:sb});
  await store.getState().refresh();const first=store.getState().activateSession(a);await tick();const wa=store.getState().openingReadingWindow;
  store.getState().readingWindowPresented(wa);const next=store.getState().activateSession(b);await tick();await first;
  await assert.rejects(store.getState().awaitReadingProjection(wa),/conversation_session_changed/);assert.ok(!seen.includes(`full:${a}`));
  store.getState().readingWindowPresented(store.getState().openingReadingWindow);await next;assert.deepEqual(store.getState().projection,sb);
});
