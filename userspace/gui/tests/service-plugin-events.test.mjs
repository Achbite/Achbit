import assert from 'node:assert/strict';
import test from 'node:test';
import { installGuiFetch, loadGuiModule } from './gui-projection-contract.mjs';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

function events(signal) {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(name) { controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: {}\n\n`)); },
    fail(error) { controller.error(error); },
  };
}
const service = status => ({ id: 'sample', name: 'Sample', description: '', path: '/plugins/sample', enabled: true,
  status, error: status === 'failed' ? 'Service exited: 7' : null,
  baseUrl: status === 'running' ? 'http://127.0.0.1:1234/v1' : null, pageUrl: null, stateDirectory: '/state/sample' });

test('service inventory updates only on Host events and stops on unmount', async t => {
  const { watchServicePlugins } = await loadGuiModule(t, '/src/services/servicePlugins.ts');
  let stream, inventory = [service('running')], reads = 0, connections = 0;
  installGuiFetch(t, (url, init) => {
    if (url.pathname === '/api/plugin-services/events') {
      connections++; stream = events(init.signal); return stream.response;
    }
    assert.equal(url.pathname, '/api/plugin-services'); reads++;
    return Response.json({ ok: true, data: { services: inventory } });
  });
  const controller = new AbortController(), publications = [];
  const stopped = watchServicePlugins(controller.signal, value => publications.push(value)).catch(error => error);
  t.after(() => controller.abort());
  await waitUntil(() => stream);
  assert.equal(reads, 0, 'opening a stream does not start an inventory polling timer');
  stream.send('ready'); await waitUntil(() => publications.length === 1);
  assert.equal(publications[0][0].status, 'running');
  stream.send('heartbeat'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, 'transport keepalive does not refresh inventory');
  inventory = [service('failed')]; stream.send('change');
  await waitUntil(() => publications.length === 2);
  assert.deepEqual(publications[1], inventory, 'the Host owns the exit error and cleared endpoint');
  assert.equal(reads, 2); assert.equal(connections, 1);
  controller.abort(); assert.equal((await stopped).name, 'AbortError');
});

test('service event subscription preserves read/stream errors and never publishes a substitute empty inventory', async t => {
  const { watchServicePlugins } = await loadGuiModule(t, '/src/services/servicePlugins.ts');
  let stream, failRead = false;
  installGuiFetch(t, (url, init) => {
    if (url.pathname.endsWith('/events')) { stream = events(init.signal); return stream.response; }
    if (failRead) throw new Error('original service inventory failure');
    return Response.json({ ok: true, data: { services: [service('running')] } });
  });
  const controller = new AbortController(), publications = [];
  t.after(() => controller.abort());
  const failed = assert.rejects(watchServicePlugins(controller.signal, value => publications.push(value)), /original service inventory failure/);
  await waitUntil(() => stream);
  stream.send('ready'); await waitUntil(() => publications.length === 1);
  failRead = true; stream.send('change'); await failed;
  assert.deepEqual(publications, [[service('running')]]);

  const next = new AbortController(); t.after(() => next.abort());
  const oldStream = stream;
  const disconnected = assert.rejects(watchServicePlugins(next.signal, value => publications.push(value)), /original event stream failure/);
  await waitUntil(() => stream !== oldStream);
  stream.fail(new Error('original event stream failure')); await disconnected;
  assert.equal(publications.length, 1);
});

test('unmount while a service read is pending cannot publish into the closed view', async t => {
  const { watchServicePlugins } = await loadGuiModule(t, '/src/services/servicePlugins.ts');
  let stream, releaseRead;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/events')) { stream = events(init.signal); return stream.response; }
    await new Promise(resolve => { releaseRead = resolve; });
    return Response.json({ ok: true, data: { services: [service('running')] } });
  });
  const controller = new AbortController(); t.after(() => controller.abort());
  const stopped = watchServicePlugins(controller.signal, () => assert.fail('unmounted view must not publish')).catch(error => error);
  await waitUntil(() => stream); stream.send('ready'); await waitUntil(() => releaseRead);
  controller.abort(); releaseRead(); await stopped;
});
