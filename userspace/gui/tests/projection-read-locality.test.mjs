// TCR: .task-artifacts/T-020-GUI_Startup-20261121/locality-fix/data/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore, loadGuiModules } from './gui-projection-contract.mjs';

const a = 'session:read-a', b = 'session:read-b', c = 'session:read-c';
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = (sessionId, revision = 8) => ({ sessionId, revision, run: null });
const view = (id, title = id, revision = 8) => ({ ...projectSession(emptySessionState(id)), revision, display: { creationTitle: title } });
const summary = id => ({ id, title: id, workspaceBindings: [], createdAt: '2026-11-20', updatedAt: '2026-11-20' });
function seed(store, ids) {
  store.setState({ catalog: { projects: [], sessions: ids.map(summary) }, sessionStatuses: Object.fromEntries(ids.map(id => [id, status(id)])) });
}

// The transport deliberately allows a late response *after* its signal aborts. No clock or real Host needed.
function requests(t, other) {
  const reads = [];
  installGuiFetch(t, (url, init) => {
    if (!url.pathname.endsWith('/projection')) return other ? other(url, init) : assert.fail(`Unexpected ${url.pathname}`);
    return new Promise((resolve, reject) => reads.push({ id: decodeURIComponent(url.pathname.split('/').at(-2)), signal: init.signal,
      send: data => resolve(Response.json({ ok: true, data })), reject }));
  });
  t.after(() => reads.forEach(r => r.reject(new Error('fixture released'))));
  return reads;
}
async function begin(store, id) {
  const done = store.getState().activateSession(id);
  await tick();
  return { done };
}

test('a known cold A/B/A uses the pending full read once; only the selected generation admits a snapshot', async t => {
  const store = await loadGuiModelStore(t); seed(store, [a,b]);
  const reads = requests(t), displayed = [];
  t.after(store.subscribe(state => { if (state.projection) displayed.push(state.projection.sessionId); }));
  const first = await begin(store, a), away = await begin(store, b), back = await begin(store, a);
  assert.deepEqual(reads.map(r => r.id), [a,b]);
  assert.equal(reads[0].signal.aborted, false, 'the new A owns the still-pending transport');
  assert.equal(store.getState().projection, null);
  reads[1].send(view(b, 'unclaimed B')); reads[0].send(view(a, 'first A'));
  await Promise.all([first.done, away.done, back.done]);
  assert.equal(store.getState().error, null); assert.equal(store.getState().projection.display.creationTitle, 'first A');
  assert.deepEqual(displayed, [a]);
  const reopen = await begin(store, b);
  assert.deepEqual(reads.map(r => r.id), [a,b,b], 'completed orphan was never admitted');
  reads[2].send(view(b, 'new B')); await reopen.done; assert.equal(store.getState().projection.display.creationTitle, 'new B');
});

test('only the current and immediately recent cold transports survive; elapsed grace never caches a late response', async t => {
  const store = await loadGuiModelStore(t); seed(store, [a,b,c]); const reads = requests(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = await begin(store, a), second = await begin(store, b), third = await begin(store, c);
  assert.equal(reads[0].signal.aborted, true, 'opening C expels A immediately');
  assert.equal(reads[1].signal.aborted, false, 'B is the sole recent return candidate');
  t.mock.timers.tick(500);
  assert.equal(reads[1].signal.aborted, true, 'no consumer within half a second');
  assert.equal(reads[2].signal.aborted, false, 'an active read has no handoff deadline');
  for (const r of reads) r.send(view(r.id));
  await Promise.all([first.done, second.done, third.done]);
  const back = await begin(store, a); assert.equal(store.getState().projection, null); assert.equal(reads.length, 4);
  reads[3].send(view(a, 'after eviction')); await back.done; assert.equal(store.getState().projection.display.creationTitle, 'after eviction');
});

test('newer observed revision starts its own read without waiting for an abandoned older response', async t => {
  const store = await loadGuiModelStore(t); seed(store, [a,b]); const reads = requests(t);
  const first = await begin(store,a), away = await begin(store,b);
  store.setState({ sessionStatuses: { [a]: status(a, 9), [b]: status(b) } });
  const back = await begin(store,a);
  assert.deepEqual(reads.map(r => r.id), [a,b,a]); assert.equal(reads[0].signal.aborted, true);
  reads[2].send(view(a, 'new revision', 9)); await back.done;
  reads[0].send(view(a, 'old revision')); reads[1].send(view(b)); await Promise.all([first.done, away.done]);
  assert.equal(store.getState().projection.revision, 9); assert.equal(store.getState().projection.display.creationTitle, 'new revision');
});

test('a handed-off snapshot with inherited permissions needs the new selection’s own fresh read', async t => {
  const store = await loadGuiModelStore(t); seed(store, [a,b]); const reads = requests(t);
  const first = await begin(store,a), away = await begin(store,b), back = await begin(store,a);
  const child = { ...view(a), agentContext: { parentSessionId: 'parent', ownerSessionId: 'owner', parentRunId: 'r', parentCallId: 'c',
    capabilities: { messaging: true, continuation: true, delegation: true } }, effectivePermissions: { 'agent.permissions.workspaceMutation': 'allow' } };
  reads[0].send(child); reads[1].send(view(b)); await tick();
  assert.equal(store.getState().projection, null, 'never flash the old permission'); assert.deepEqual(reads.map(r => r.id), [a,b,a]);
  reads[2].send({ ...child, effectivePermissions: { 'agent.permissions.workspaceMutation': 'plan' } });
  await Promise.all([first.done, away.done, back.done]); assert.equal(store.getState().projection.effectivePermissions['agent.permissions.workspaceMutation'], 'plan');
});

test('a joined transport reports its original failure and a user retry is a fresh request', async t => {
  const store = await loadGuiModelStore(t); seed(store, [a,b]); const reads = requests(t);
  const first = await begin(store,a), away = await begin(store,b), back = await begin(store,a);
  reads[0].reject(new Error('Host refused the projection')); reads[1].send(view(b)); await tick();
  assert.equal(store.getState().error, 'Host refused the projection'); assert.equal(store.getState().errorSource, 'projection');
  await Promise.all([first.done, away.done, back.done]); assert.equal(reads.length, 2, 'no hidden retry on failure');
  const retry = await begin(store,a); reads[2].send(view(a)); await retry.done; assert.equal(store.getState().error, null);
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
