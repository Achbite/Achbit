import { history, reader, pause } from './complete-reading-fixture.mjs';
// TCR: .task-artifacts/T-020-GUI_Startup-20261121/locality-fix/data/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore, loadGuiModules } from './gui-projection-contract.mjs';

const a = 'session:read-a', b = 'session:read-b', c = 'session:read-c';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function deferredReader(t) {
  const views=[a,b,c].map(id=>history(id)),flights=[];
  const f=await reader(t,views,(id,init)=>{
    const pending=Promise.withResolvers();flights.push({...pending,id,signal:init.signal,view:views.find(p=>p.sessionId===id)});return pending.promise;
  });
  return {...f,flights,views};
}
test('A/B/A cancels both abandoned requests and only the selected generation admits its body',async t=>{
  const f=await deferredReader(t),x=f.open(a),y=f.open(b),z=f.open(a);
  assert.deepEqual(f.flights.map(v=>v.id),[a,b,a]);assert.ok(f.flights[0].signal.aborted&&f.flights[1].signal.aborted);
  f.flights[2].resolve(f.views[0]);await z;f.flights[1].reject(Error('abandoned'));f.flights[0].resolve(f.views[0]);
  await Promise.all([x,y]);assert.equal(f.store.getState().projection.sessionId,a);assert.equal(f.store.getState().error,null);
});
test('three successive selections cancel prior transports immediately with no retention timer',async t=>{
  const f=await deferredReader(t),pending=[a,b,c].map(f.open);
  assert.deepEqual(f.flights.map(r=>r.signal.aborted),[true,true,false]);for(const r of f.flights)r.resolve(r.view);
  await Promise.all(pending);assert.equal(f.store.getState().projection.sessionId,c);
});
test('a newly observed revision is re-read before an older body can be published',async t=>{
  const f=await deferredReader(t),open=f.open(a),p=f.views[0];f.store.setState({sessionStatuses:{[a]:{sessionId:a,revision:p.revision+1,run:null}}});
  f.flights[0].resolve(p);await pause();assert.equal(f.store.getState().projection,null);const fresh={...p,revision:p.revision+1};
  f.flights[1].resolve(fresh);await open;assert.equal(f.store.getState().projection.revision,fresh.revision);
});
test('permission data from an abandoned selection cannot populate the active run',async t=>{
  const f=await deferredReader(t),old=f.open(a),next=f.open(b);
  f.flights[0].resolve({...f.views[0],effectivePermissions:{'agent.permissions.workspaceMutation':'allow'}});
  f.flights[1].resolve({...f.views[1],effectivePermissions:{'agent.permissions.workspaceMutation':'plan'}});
  await Promise.all([old,next]);assert.equal(f.store.getState().projection.effectivePermissions['agent.permissions.workspaceMutation'],'plan');
});
test('a failed read retains its original error and retry takes a new receipt',async t=>{
  const f=await deferredReader(t),opening=f.open(a);f.flights[0].reject(Error('Host refused the page'));await opening;
  assert.equal(f.store.getState().error,'Host refused the page');assert.equal(f.flights.length,1);
  const retry=f.open(a);f.flights[1].resolve(f.views[0]);await retry;assert.equal(f.store.getState().error,null);assert.equal(f.store.getState().projection.sessionId,a);
});

test('the presented committed text of an exact warm snapshot is not scanned again; a replacement with identical IDs stays independent', async t => {
  const oldSelf = globalThis.self; globalThis.self = {};
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const [{ usePresentedCommittedContent }] = await loadGuiModules(t, ['/src/presentation/PresentationRuntime.tsx']);
  const scanned = [];
  const snapshot = (id, text) => ({ sessionId: id, revision: 8, messages: [{ messageId: 'same', role: 'user', get content() { scanned.push(text); return text; } }], narratives: [] });
  function Body({ p, locale }) { return usePresentedCommittedContent(p, locale).content('message:same:content'); }
  const show = (p, locale = 'en-US') => renderToStaticMarkup(createElement(Body, { p, locale }));
  const one = snapshot(a, 'A source'), two = snapshot(b, 'B source');
  assert.match(show(one), /A source/); assert.match(show(two), /B source/); assert.match(show(one, 'zh-CN'), /A source/);
  assert.deepEqual(scanned, ['A source', 'B source'], 'remount and language change do not reconstruct the canonical text index');
  assert.match(show(snapshot(a, 'changed at source')), /changed at source/); assert.equal(scanned.length, 3);
});
