import { reader, history } from './complete-reading-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { findReactElement, installGuiFetch, loadGuiModelStore, loadGuiModules } from './gui-projection-contract.mjs';

// The real Panel, Transcript and store. Rendering is not a WebView timing measurement.
async function screen(t) {
  const previous = [globalThis.self, globalThis.sessionStorage];
  globalThis.self = {}; globalThis.sessionStorage = { getItem: () => null, removeItem() {} };
  t.after(() => { for (const [i, key] of ['self', 'sessionStorage'].entries()) {
    if (previous[i] === undefined) delete globalThis[key]; else globalThis[key] = previous[i];
  } });
  const [{ default: Panel }, { ConversationBodies }, { ConversationDisplayProvider }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/LocalAgentPanel.tsx', '/src/components/local-agent/ConversationBodies.tsx',
    '/src/components/local-agent/ConversationDisplayProvider.tsx', '/src/state/localAgentStore.ts']);
  return { store, render() {
    Object.assign(store.getInitialState(), store.getState());
    function Probe() {
      return findReactElement(Panel({}), n => n.type === ConversationBodies);
    }
    const html = renderToStaticMarkup(createElement(ConversationDisplayProvider, null, createElement(Probe)));
    assert.match(html, /class="local-agent__body"/);
    return { html };
  } };
}

const ok = data => Response.json({ ok: true, data });
const snapshot = (id, revision = 7) => ({ ...projectSession(emptySessionState(id)), revision });
function held() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }

test('one complete read renders committed formatted text and supplies its controls',async t=>{
  const {store,render}=await screen(t),p=history('session:formal',1);
  p.messages[1].content='**Folder A**';const requests=[]; installGuiFetch(t,async url=>{ requests.push(url.pathname.split('/').at(-1)); return ok(p); });
  store.setState({catalog:{projects:[],sessions:[{id:p.sessionId,createdAt:'date',title:'History'}]}});
  await store.getState().activateSession(p.sessionId);const {html}=render();assert.match(html,/<strong>Folder A<\/strong>/);assert.deepEqual(store.getState().projection.messages,p.messages);
  assert.deepEqual(requests,['projection']);
});
test('a known conversation leaves the reading surface interactive during independent layout preparation',async t=>{
  const {store,render}=await screen(t),p=history('session:target');
  store.setState({sessionId:p.sessionId,projection:p,loading:false});
  const {html}=render();assert.match(html,/assistant 5/);assert.doesNotMatch(html,/inert=""|opening-preview/);
});
test('two concurrent opens of the same identity share one complete read',async t=>{
  const p=history('a'),held=Promise.withResolvers(),f=await reader(t,[p],()=>held.promise);
  const a=f.open('a'),b=f.open('a');assert.equal(f.reads().length,1);held.resolve(p);await Promise.all([a,b]);assert.equal(f.store.getState().projection.sessionId,'a');
});
test('continuous observation reuses a settled snapshot and disconnection invalidates it',async t=>{
  const p=history('a'),q=history('b'),f=await reader(t,[p,q]);await f.open('a');await f.open('b');await f.open('a');
  assert.equal(f.reads().length,2);await f.open('b');f.store.getState().observeHistory('closed');await f.open('a');assert.equal(f.reads().length,3);
});
test('visited reading surfaces share the snapshot LRU and drop invalidated histories', async t => {
  const histories = Array.from({ length: 7 }, (_, index) => history(`session:recent-${index}`, 1));
  const fixture = await reader(t, histories);
  const ids = () => fixture.store.getState().retainedProjections().map(view => view.sessionId);
  const [first, second] = histories;
  for (const item of histories.slice(0, 6)) await fixture.open(item.sessionId);
  await fixture.open(first.sessionId);
  await fixture.open(histories[6].sessionId);
  assert.equal(ids().length, 6);
  assert.ok(ids().includes(first.sessionId));
  assert.ok(!ids().includes(second.sessionId));
  fixture.store.getState().observeHistory('change', first.sessionId);
  assert.ok(!ids().includes(first.sessionId));
  fixture.store.getState().observeHistory('closed');
  assert.deepEqual(ids(), []);
});
test('the catalog selection can read before an independent statuses request settles',async t=>{
  const p=history('a'),hold=Promise.withResolvers(),f=await reader(t,[p],undefined,async url=>{assert.ok(url.pathname.endsWith('/statuses'));await hold.promise;return ok([])});
  const refreshing=f.store.getState().refresh();await f.open('a');assert.deepEqual(f.store.getState().projection.messages,p.messages);
  hold.resolve();await refreshing;
});
test('child output rail reuses only completed results under the identical retained parent and uninterrupted observation', async t => {
  const [{ childDeliveries }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentDeliveries.ts', '/src/state/localAgentStore.ts',
  ]);
  store.getState().observeHistory('ready');
  const root = snapshot('session:root'), siblings = ['session:c','session:d'];
  let fail = false; const reads = [];
  const read = async id => { reads.push(id); if (fail) throw Error('child_read_failed');
    return { memberIds: [root.sessionId, ...siblings], childDeliverables: siblings.map(child => ({ artifactId: child, presentationRunId: 'r' })) }; };
  const members = new Set();
  const open = () => childDeliveries(root, siblings, new AbortController().signal, read, members);
  const first = await open(); assert.deepEqual(first.map(x => x.artifactId), siblings);
  assert.deepEqual([...members], siblings, 'only changes from descendants refresh their outputs');
  assert.equal(await open(), first); assert.deepEqual(reads, [root.sessionId]);
  store.getState().observeHistory('change', siblings[0]); fail = true; await assert.rejects(open, /child_read_failed/);
  fail = false; assert.notEqual(await open(), first); assert.deepEqual(reads, [root.sessionId, root.sessionId, root.sessionId]);
});


test('unrelated session updates keep real child outputs warm while parent, descendants and Host gaps invalidate them', async t => {
  const [{ childDeliveries }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentDeliveries.ts', '/src/state/localAgentStore.ts',
  ]);
  const root = snapshot('session:parent');
  const child = 'session:child', grandchild = 'session:grandchild';
  let reads = 0;
  const read = async () => ({ memberIds: [child, grandchild], childDeliverables: [{ artifactId: 'output-' + ++reads }] });
  const open = (reader = read) => childDeliveries(root, [child], new AbortController().signal, reader);
  const observe = store.getState().observeHistory;
  observe('ready');
  const first = await open();
  observe('change', 'session:unrelated');
  assert.equal(await open(), first, 'unrelated work must not discard completed outputs');
  observe('change', grandchild);
  const second = await open();
  assert.notEqual(second, first);
  observe('change', root.sessionId);
  const third = await open();
  assert.notEqual(third, second);
  observe('closed');
  await open();
  observe('ready');
  const held = Promise.withResolvers();
  const inFlight = open(() => held.promise);
  observe('change', grandchild);
  held.resolve({ memberIds: [child, grandchild], childDeliverables: [{ artifactId: 'old' }] });
  await inFlight;
  assert.notEqual((await open())[0].artifactId, 'old', 'a change to a newly discovered descendant invalidates the pending result');
  assert.equal(reads, 5);

  observe('change', child);
  const pending = Promise.withResolvers();
  const pendingRead = open(() => pending.promise);
  observe('change', 'session:unrelated');
  const current = [{ artifactId: 'current' }];
  pending.resolve({ memberIds: [child, grandchild], childDeliverables: current });
  assert.equal(await pendingRead, current);
  assert.equal(await open(), current, 'unrelated work during the initial read does not force another read');

  observe('change', child);
  const disconnected = Promise.withResolvers();
  const beforeGap = open(() => disconnected.promise);
  observe('closed');
  observe('ready');
  disconnected.resolve({ memberIds: [child, grandchild], childDeliverables: current });
  await beforeGap;
  assert.notEqual(await open(), current, 'a snapshot spanning an event-stream gap cannot be reused');
});

test('returning to a parent keeps its output in the six most recently used conversation results', async t => {
  const [{ childDeliveries }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentDeliveries.ts', '/src/state/localAgentStore.ts',
  ]);
  store.getState().observeHistory('ready');
  const parents = Array.from({ length: 7 }, (_, i) => snapshot('session:parent-' + i));
  const reads = [];
  const open = parent => childDeliveries(parent, ['session:child'], new AbortController().signal, async id => {
    reads.push(id);
    return { memberIds: ['session:child'], childDeliverables: [{ artifactId: id }] };
  });
  const first = await open(parents[0]);
  const second = await open(parents[1]);
  for (const parent of parents.slice(2, 6)) await open(parent);
  assert.equal(await open(parents[0]), first);
  await open(parents[6]);
  assert.equal(await open(parents[0]), first);
  assert.notEqual(await open(parents[1]), second);
  assert.deepEqual(reads, [...parents.map(parent => parent.sessionId), parents[1].sessionId]);
});

for (const reconnectBeforeReply of [false, true]) {
  test('a late complete read across an observation gap is revalidated on return (reconnected=' + reconnectBeforeReply + ')', async t => {
    const a = history('a', 1), current = history('a', 2), b = history('b', 1);
    const first = Promise.withResolvers(), fresh = Promise.withResolvers();
    let count = 0;
    const f = await reader(t, [current, b], id => id === 'b' ? b : ++count === 1 ? first.promise : fresh.promise);
    const pending = f.open('a');
    f.store.getState().observeHistory('closed');
    if (reconnectBeforeReply) f.store.getState().observeHistory('ready');
    first.resolve(a);
    await pending;
    await f.open('b');
    const returning = f.open('a');
    assert.equal(f.store.getState().projection?.revision, a.revision, 'the last visible document can be shown while reading');
    fresh.resolve(current);
    await returning;
    assert.equal(f.store.getState().projection.revision, current.revision);
    assert.equal(count, 2);
    if (!reconnectBeforeReply) f.store.getState().observeHistory('ready');
    await f.open('b');
    await f.open('a');
    const verifiedAt = count;
    await f.open('b');
    await f.open('a');
    assert.equal(count, verifiedAt, 'the verified result stays warm under continuous observation');
  });
}
