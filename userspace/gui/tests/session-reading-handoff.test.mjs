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
  const [{ default: Panel }, { ConversationTranscript }, { ConversationDisplayProvider }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/LocalAgentPanel.tsx', '/src/components/local-agent/ConversationTranscript.tsx',
    '/src/components/local-agent/ConversationDisplayProvider.tsx', '/src/state/localAgentStore.ts']);
  return { store, render() {
    Object.assign(store.getInitialState(), store.getState());
    let transcript, body;
    function Probe() {
      const root = Panel({});
      transcript = findReactElement(root, n => n.type === ConversationTranscript);
      body = findReactElement(root, n => n.props.className === 'local-agent__body');
      return null;
    }
    renderToStaticMarkup(createElement(ConversationDisplayProvider, null, createElement(Probe)));
    return { body: body.props, html: renderToStaticMarkup(transcript) };
  } };
}

const page = (id, revision) => ({ sessionId: id, revision, view: 'messages', nextBefore: null,
  items: [ { type: 'message.committed', messageId: 'm:q', role: 'user', content: 'Which folder?', truncated: false },
    { type: 'message.committed', messageId: 'm:a', role: 'assistant', content: '**Folder A**', truncated: false },
    { type: 'message.committed', messageId: 'm:partial', role: 'assistant', content: 'unconfirmed tail', truncated: true } ] });
const ok = data => Response.json({ ok: true, data });
const snapshot = (id, revision = 7) => ({ ...projectSession(emptySessionState(id)), revision });
function held() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }

test('committed messages are readable without granting timeline actions while the full read is held', async t => {
  const { store, render } = await screen(t), id = 'session:cold';
  const full = held(), shown = held(); t.after(full.release);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/read')) return ok(page(id, 7));
    assert.ok(url.pathname.endsWith('/projection')); await full.promise; return ok(snapshot(id));
  });
  store.setState({ catalog: { projects: [], sessions: [{ id, title: 'Cold history' }] } });
  const stop = store.subscribe(s => { if (s.openingHistory) shown.release(); }); t.after(stop);
  const open = store.getState().activateSession(id); await shown.promise;
  assert.equal(store.getState().projection, null);
  const { html } = render();
  assert.match(html, /Which folder\?/); assert.match(html, /<strong>Folder A<\/strong>/);
  assert.doesNotMatch(html, /unconfirmed tail|data-ui-action="message\.|<iframe|empty--welcome/);
  full.release(); await open;
  assert.equal(store.getState().projection.sessionId, id);
  assert.doesNotMatch(render().html, /Which folder\?/);
});

test('a decoded target does not make the entire reading surface inert while rows prepare', async t => {
  const { store, render } = await screen(t), id = 'session:target';
  store.setState({ sessionId: id, catalog: { projects: [], sessions: [{ id, title: 'Target' }] }, projection: snapshot(id) });
  assert.notEqual(render().body.inert, true, 'formatting is owned by the row, not by the whole transcript');
});

test('known revision: only a mounted opening reader requests messages, once; a held preview cannot delay the target or leak into another view', async t => {
  const store = await loadGuiModelStore(t), a = 'session:a', b = 'session:b';
  const projection = held(), preview = held(); t.after(() => { projection.release(); preview.release(); });
  const requests = []; let previewSignal;
  store.setState({ catalog: { projects: [], sessions: [a,b].map(id => ({ id })) },
    sessionStatuses: Object.fromEntries([a,b].map(id => [id, { sessionId: id, revision: 7, run: null }])) });
  installGuiFetch(t, async (url, init) => {
    const id = decodeURIComponent(url.pathname.split('/').at(-2)); requests.push([id, url.pathname.split('/').at(-1)]);
    if (url.pathname.endsWith('/read')) { previewSignal = init.signal; await preview.promise; return ok(page(id, 7)); }
    if (id === a) await projection.promise;
    return ok(snapshot(id));
  });
  const activation = store.getState().activateSession(a);
  const p = store.getState().readOpeningMessages(a), same = store.getState().readOpeningMessages(a);
  projection.release(); await activation;
  assert.equal(store.getState().projection.sessionId, a); assert.equal(previewSignal.aborted, true);
  await store.getState().activateSession(b);
  preview.release(); await Promise.allSettled([p, same]);
  assert.equal(store.getState().sessionId, b); assert.equal(store.getState().openingHistory, null);
  assert.deepEqual(requests.filter(([,route]) => route === 'read'), [[a, 'read']]);
});

test('A → B → A with uninterrupted observation reuses the exact settled snapshot without any navigation requests; a gap or change invalidates that shortcut', async t => {
  const store = await loadGuiModelStore(t), a = 'session:a', b = 'session:b'; let revision = 7;
  const reads = [];
  const status = () => [a,b].map(id => ({ sessionId: id, revision: id === a ? revision : 7, run: null }));
  store.setState({ catalog: { projects: [], sessions: [a,b].map(id => ({ id })) },
    sessionStatuses: Object.fromEntries(status().map(s => [s.sessionId, s])) });
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/statuses')) { reads.push('statuses'); return ok(status()); }
    const id = decodeURIComponent(url.pathname.split('/').at(-2)); reads.push(id);
    assert.ok(url.pathname.endsWith('/projection')); return ok(snapshot(id, id === a ? revision : 7));
  });
  const { observeHistory, activateSession } = store.getState();
  observeHistory('ready'); await activateSession(a); const original = store.getState().projection;
  await activateSession(b);
  const back = activateSession(a);
  assert.equal(store.getState().projection, original, 'selection and text change together'); await back;
  assert.deepEqual(reads, [a,b]);
  await activateSession(b); revision++; observeHistory('change'); await activateSession(a);
  assert.equal(store.getState().projection.revision, 8); assert.deepEqual(reads.slice(2), ['statuses', a]);
  observeHistory('closed'); await activateSession(b); assert.equal(reads.at(-1), 'statuses');
});

test('an independently confirmed status releases an unknown-revision open while the messages page is pending', async t => {
  const store = await loadGuiModelStore(t), id = 'session:boundary';
  const pageStarted = held(), slow = held(); t.after(slow.release);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/read')) { pageStarted.release(); await slow.promise; return ok(page(id, 7)); }
    return ok(snapshot(id));
  });
  store.setState({ catalog: { projects: [], sessions: [{ id }] } });
  const opening = store.getState().activateSession(id); await pageStarted.promise;
  store.setState({ sessionStatuses: { [id]: { sessionId: id, revision: 7, run: null } } });
  await opening; assert.equal(store.getState().projection.revision, 7);
  slow.release(); assert.equal(store.getState().openingHistory, null);
});

test('child output rail reuses only completed results under the identical retained parent and uninterrupted observation', async t => {
  const [{ childDeliveries }] = await loadGuiModules(t, ['/src/components/local-agent/useAgentDeliveries.ts']);
  const root = snapshot('session:root'), siblings = ['session:c','session:d'];
  let stamp = {}, fail = false; const reads = [];
  const read = async id => { reads.push(id); if (fail && id === siblings[1]) throw Error('child_read_failed');
    return { ...snapshot(id), deliverables: [{ artifactId: id, presentationRunId: 'r' }] }; };
  const open = () => childDeliveries(root, siblings, new AbortController().signal, read, () => stamp);
  const first = await open(); assert.deepEqual(first.map(x => x.artifactId), siblings);
  assert.equal(await open(), first); assert.deepEqual(reads, siblings);
  stamp = {}; fail = true; await assert.rejects(open, /child_read_failed/);
  fail = false; assert.notEqual(await open(), first); assert.deepEqual(reads, [...siblings, ...siblings, ...siblings]);
});
