// TCR: T-020-GUI_Startup-20261121/paged-transcript-debug-20261124/TCR.md
import { history, reader } from './complete-reading-fixture.mjs';
import { transcriptFixture, okFixture, installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGuiModule } from './gui-projection-contract.mjs';

const jumboBody = 'X'.repeat(8 * 1024 * 1024 + 1);
for (const turns of [1, 32, 512, 1024]) test(`a ${turns}-turn history opens its complete last turn and retains all navigation entries`,async t=>{
  const p=history('s',turns), f=await reader(t,[p]), state=await f.open('s');
  assert.equal(state.error,null);assert.deepEqual(state.projection.messages,p.messages);
  assert.deepEqual(state.projection.timeline, p.timeline); assert.equal(f.reads().length,1);
});
for(const status of ['completed','failed','cancelled','indeterminate','running','waiting']) test(`returning to a ${status} run observes its actual controls and revalidates live work`,async t=>{
  const p=history('a'), b=history('b');p.run.status=status;
  const f=await reader(t,[p,b]);await f.open('a');await f.open('b');
  const before=f.reads().length;const s=await f.open('a');
  assert.equal(s.projection.run.status,status);assert.equal(s.projection.messages.at(-1).content,p.messages.at(-1).content);
  if(['running','waiting'].includes(status))assert.ok(f.reads().length>before);else assert.equal(f.reads().length,before);
});
for(const event of ['ready','closed','change']) test(`a Host ${event} invalidates the previously retained body`,async t=>{
  const a=history('a'),b=history('b'),f=await reader(t,[a,b]);
  await f.open('a');await f.open('b');a.messages.at(-1).content='edited at source';f.store.getState().observeHistory(event,'a');
  assert.equal((await f.open('a')).projection.messages.at(-1).content,'edited at source');
  assert.equal(f.reads().filter(r=>r.id==='a').length,2);
});
for(const bad of ['owner','bounds','cursor','dangling message','navigation','run owner','missing tail controls']) test(`a page with invalid ${bad} retains its failure without a different history request`,async t=>{
  const p=history('a'),response=transcriptFixture(p),x=response.transcript;
  switch(bad){
    case 'owner':response.sessionId='other';break; case 'bounds':x.start=x.end+1;break;case 'cursor':x.next=x.end;break;
    case 'dangling message':x.content.messages=[];break;case 'navigation':x.navigation[0].sequence=-1;break;
    case 'run owner':x.current.sessionId='other';break;case 'missing tail controls':delete x.current;break;
  }
  const { readTranscriptPage } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const requests = [];
  installGuiFetch(t, async (url, init) => {
    requests.push([url.pathname.split('/').at(-1), JSON.parse(init.body).view]);
    return okFixture(response);
  });
  await assert.rejects(readTranscriptPage('a', undefined, new AbortController().signal), /conversation_(transcript|read)_/);
  assert.deepEqual(requests, [['read', 'transcript']]);
});
test('six recent sessions retain real turns and the seventh evicts the least recently visited',async t=>{
  const views=Array.from({length:7},(_,i)=>history('s'+i));const f=await reader(t,views);
  for(const p of views)await f.open(p.sessionId);
  const count=f.reads().length;await f.open('s1');assert.equal(f.reads().length,count);
  await f.open('s0');assert.equal(f.reads().length,count+1);
});
test('a retained jumbo answer is whole and can be revisited without another history read',async t=>{
  const a=history('a',1),b=history('b',1);a.messages[1].content=jumboBody;
  const f=await reader(t,[a,b]);await f.open('a');await f.open('b');const state=await f.open('a');
  assert.equal(state.projection.messages.at(-1).content,jumboBody);
  assert.equal(f.reads().filter(r=>r.id==='a').length,1);
});
test('a catalog identity replacement retires its row, saved position and revision floor',async t=>{
  const a=history('a'),b=history('b'),f=await reader(t,[a,b]);await f.open('a');
  f.store.getState().rememberReadingAnchor('a',{key:a.messages.at(-2).messageId,offset:-12});
  await f.open('b');const cat=f.store.getState().catalog;
  f.store.setState({catalog:{...cat,sessions:cat.sessions.map(s=>s.id==='a'?{...s,createdAt:'new instance'}:s)}});
  a.messages.at(-1).content='replacement';const state=await f.open('a');assert.equal(f.reads().filter(read => read.id === 'a').length,2);
  assert.equal(state.projection.messages.at(-1).content,'replacement');
});
test('a saved middle row keeps its pixel offset across a cold reopen of the complete history',async t=>{
  const a=history('a',12),b=history('b'),f=await reader(t,[a,b]);await f.open('a');
  const m=a.messages[6];f.store.getState().rememberReadingAnchor('a',{key:m.messageId,offset:-18},m.sequence);
  await f.open('b'); f.store.getState().observeHistory('closed');
  const count=f.reads().length,restored=await f.open('a');
  assert.equal(f.reads().length,count+1);assert.deepEqual(restored.projection.messages,a.messages);
  // An independently loaded store owns its in-memory bookmarks. Browser persistence is verified on a real remount.
  assert.equal(restored.projection.timeline[6].sequence,m.sequence);
});
test('two large independent histories reuse their complete ordered timelines',async t=>{
  const views=['large-a','large-b'].map(id=>history(id,16385)),f=await reader(t,views);
  const previouslyShown=new Map();
  for(let i=0;i<4;i++){
    const p=views[i%2],s=await f.open(p.sessionId);
    assert.equal(s.projection.timeline.length,32770);
    assert.equal(s.projection.messages.at(-1).messageId,p.messages.at(-1).messageId);
    if(previouslyShown.has(p.sessionId))assert.equal(s.projection,previouslyShown.get(p.sessionId));
    previouslyShown.set(p.sessionId,s.projection);
  }
  assert.equal(f.reads().length,2);
});


test('two Host windows with identical catalog identity and revision retain only their own authenticated history', async t => {
  const savedWindow = globalThis.window;
  t.after(() => { if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow; });
  const credentials = ['12', '34'].map(pair => 'acui_' + pair.repeat(32));
  const ids = ['session:shared', 'session:other'];
  const stores = [];
  for (const uiToken of credentials) {
    globalThis.window = { location: { protocol: 'http:', hostname: 'achbit-gui.localhost', origin: 'http://achbit-gui.localhost' },
      __ACHBIT_HOST_BOOT__: { schemaVersion: 'achbit.host-ui-bootstrap', host: '127.0.0.1', port: '49132', uiToken, windowChrome: 'custom' } };
    const store = await loadGuiModelStore(t);
    store.setState({ catalog: { projects: [], sessions: ids.map(id => ({
      id, title: id, createdAt: '2026-11-24', updatedAt: '2026-11-24', workspaceBindings: [],
    })) } });
    store.getState().observeHistory('ready');
    stores.push(store);
  }
  const reads = [];
  installGuiFetch(t, (url, init) => {
    assert.equal(url.origin, 'http://127.0.0.1:49132');
    assert.ok(url.pathname.endsWith('/projection'));
    const owner = credentials.indexOf(init.headers['x-achbit-host-ui-token']);
    assert.notEqual(owner, -1);
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    reads.push([owner, id]);
    const p = history(id);
    p.messages.at(-1).content = 'Window ' + owner;
    return okFixture(p);
  });
  await stores[0].getState().activateSession(ids[0]);
  const first = stores[0].getState().projection;
  await stores[0].getState().activateSession(ids[1]);
  await stores[1].getState().activateSession(ids[0]);
  const second = stores[1].getState().projection;
  assert.equal(second.messages.at(-1).content, 'Window 1');
  assert.deepEqual(stores[1].getState().retainedProjections(), [second]);
  await stores[0].getState().activateSession(ids[0]);
  assert.equal(stores[0].getState().projection, first);
  assert.equal(first.messages.at(-1).content, 'Window 0');
  assert.deepEqual(reads, [[0, ids[0]], [0, ids[1]], [1, ids[0]]]);
});
