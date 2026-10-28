import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGuiModelStore, installGuiFetch } from './gui-projection-contract.mjs';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

const summary = (id, title = id) => ({ id, title, workspaceBindings: [], createdAt: '2026-10-26', updatedAt: '2026-10-26' });
const catalogOf = (...sessions) => ({ projects: [], sessions });
function events(signal) {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(name) { controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: {}\n\n`)); },
    fail(error) { controller.error(error); } };
}

test('Host catalog notifications refresh titles and external additions/removals without changing the active view', async t => {
  const current = summary('session:current'), external = summary('session:external', 'Canonical external title');
  let catalog = catalogOf(current), stream, streamSignal, reads = 0;
  installGuiFetch(t, (url, init) => {
    if (url.pathname === '/api/conversation/catalog/events') {
      streamSignal = init.signal; stream = events(init.signal); return stream.response;
    }
    assert.equal(url.pathname, '/api/conversation/catalog', 'no status/projection polling is needed to discover new conversations');
    reads++;
    return Response.json({ ok: true, data: catalog });
  });
  const store = await loadGuiModelStore(t);
  const projection = { sessionId: current.id, revision: 1 };
  store.setState({ catalog, sessionId: current.id, projection, selectedProfileId: 'profile:chosen', draftProjectId: 'project:draft' });
  const stop = store.getState().watchCatalog(); t.after(stop);
  await waitUntil(() => stream);
  assert.equal(reads, 0, 'connecting alone does not start a catalog polling chain');
  stream.send('ready'); await waitUntil(() => reads === 1 && store.getState().catalogStatus === 'ready');
  const generated = { ...current, title: 'Generated title' };
  catalog = catalogOf(generated); stream.send('change');
  await waitUntil(() => store.getState().catalog.sessions[0].title === generated.title);
  assert.equal(store.getState().projection, projection, 'catalog titles update without a Session revision or projection refresh');
  catalog = catalogOf(external, generated); stream.send('change');
  await waitUntil(() => store.getState().catalog.sessions.some(item => item.id === external.id));
  assert.equal(store.getState().catalog.sessions[0].title, external.title);
  assert.equal(store.getState().sessionId, current.id);
  assert.equal(store.getState().projection, projection);
  assert.equal(store.getState().selectedProfileId, 'profile:chosen');
  assert.equal(store.getState().draftProjectId, 'project:draft');
  catalog = catalogOf(generated); stream.send('change');
  await waitUntil(() => store.getState().catalog.sessions.length === 1);
  assert.equal(store.getState().catalog.sessions[0].title, generated.title);
  assert.equal(reads, 4);
  stop(); assert.equal(streamSignal.aborted, true, 'unmount releases the stream');
});

test('catalog notifications arriving during a manual mutation are reconciled after its response', async t => {
  const current = summary('session:current'), external = summary('session:external');
  const catalog = catalogOf(current);
  let stream, releaseRename, reads = 0;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/events')) { stream = events(init.signal); return stream.response; }
    if (init.method === 'PATCH') {
      await new Promise(resolve => { releaseRename = resolve; });
      return Response.json({ ok: true, data: catalogOf({ ...current, title: 'Manual title' }) });
    }
    assert.equal(url.pathname, '/api/conversation/catalog'); reads++;
    return Response.json({ ok: true, data: catalogOf(external, { ...current, title: 'Manual title' }) });
  });
  const store = await loadGuiModelStore(t); store.setState({ catalog });
  const stop = store.getState().watchCatalog(); t.after(stop); await waitUntil(() => stream);
  const rename = store.getState().updateSession(current.id, { title: 'Manual title' });
  await waitUntil(() => releaseRename);
  stream.send('change'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0, 'the local mutation owns its pending response');
  releaseRename(); await rename;
  await waitUntil(() => store.getState().catalog.sessions.length === 2);
  assert.equal(store.getState().catalog.sessions.find(item => item.id === current.id).title, 'Manual title');
  assert.equal(reads, 1);
});

test('a late catalog read cannot rewind a newer notification or erase a real read failure', async t => {
  const current = summary('session:current'), external = summary('session:external');
  let stream, releaseOld, requests = 0, fail = false;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/events')) { stream = events(init.signal); return stream.response; }
    assert.equal(url.pathname, '/api/conversation/catalog');
    if (++requests === 1) {
      await new Promise(resolve => { releaseOld = resolve; });
      return Response.json({ ok: true, data: catalogOf(current) });
    }
    if (fail) throw new Error('catalog read interrupted');
    return Response.json({ ok: true, data: catalogOf(external, current) });
  });
  const store = await loadGuiModelStore(t); store.setState({ catalog: catalogOf(current) });
  const old = store.getState().refreshCatalog(); await waitUntil(() => releaseOld);
  const stop = store.getState().watchCatalog(); t.after(stop); await waitUntil(() => stream);
  stream.send('ready'); await waitUntil(() => store.getState().catalog.sessions.length === 2);
  releaseOld(); await old;
  assert.equal(store.getState().catalog.sessions.length, 2);
  fail = true; stream.send('change');
  await waitUntil(() => store.getState().error?.includes('catalog read interrupted'));
  assert.equal(store.getState().catalog.sessions.length, 2, 'failed reads do not invent an empty directory');
  assert.equal(store.getState().errorSource, 'catalog');
  fail = false; stream.send('change'); await waitUntil(() => store.getState().error === null);
  stream.fail(new Error('original event stream failure'));
  await waitUntil(() => store.getState().catalogWatchError?.includes('original event stream failure'));
});


test('catalog stream failure survives snapshot refresh and explicit retry restores live changes', async t => {
  let stream, signal, connects = 0, catalog = catalogOf(summary('session:old'));
  installGuiFetch(t, (url, init) => {
    if (url.pathname.endsWith('/events')) {
      connects++; signal = init.signal; stream = events(init.signal); return stream.response;
    }
    assert.equal(url.pathname, '/api/conversation/catalog');
    return Response.json({ ok: true, data: catalog });
  });
  const store = await loadGuiModelStore(t);
  const stop = store.getState().watchCatalog(); t.after(stop);
  await waitUntil(() => connects === 1); stream.send('ready');
  await waitUntil(() => store.getState().catalog.sessions.length === 1);
  stream.fail(new Error('catalog transport interrupted'));
  await waitUntil(() => store.getState().catalogWatchError === 'catalog transport interrupted');
  await store.getState().refreshCatalog();
  assert.equal(store.getState().catalogWatchError, 'catalog transport interrupted');
  assert.equal(connects, 1, 'a snapshot cannot pretend to repair a failed subscription');
  const firstSignal = signal;
  store.getState().retryCatalogWatch(); await waitUntil(() => connects === 2);
  assert.equal(firstSignal.aborted, true);
  stream.send('ready'); await waitUntil(() => store.getState().catalogWatchError === null);
  catalog = catalogOf(summary('session:external'), summary('session:old')); stream.send('change');
  await waitUntil(() => store.getState().catalog.sessions.length === 2);
  stop(); assert.equal(signal.aborted, true, 'original owner releases the retried subscription');
  store.getState().retryCatalogWatch(); assert.equal(connects, 2, 'unmounted owner cannot reconnect');
});
