import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installGuiFetch, loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

async function bodyLinks(t) {
  const [{ useConversationBodyLinks }, { useConversationHost }] = await loadGuiModules(t, [
    '/src/components/local-agent/useConversationBodyLinks.tsx', '/src/components/local-agent/ConversationHost.tsx',
  ]);
  const host = useConversationHost();
  const original = { resolveResource: host.resolveResource, locatePath: host.locatePath };
  const previousElement = globalThis.Element;
  class Anchor {
    constructor(href) { this.href = href; }
    closest() { return this; }
    getAttribute() { return this.href; }
    contains(element) { return element === this; }
  }
  globalThis.Element = Anchor;
  t.after(() => { Object.assign(host, original); globalThis.Element = previousElement; });
  const errors = [], locations = [], reads = [];
  const projection = { sessionId: 'session:test', workspaceBindings: [ { workspaceId: 'A' }, { workspaceId: 'B' } ], messages: [] };
  const offline = Object.assign(new Error('original root B unavailable'), { code: 'conversation_resource_unavailable' });
  const denied = Object.assign(new Error('original target permission denied'), { code: 'host_inspection_path_unavailable' });
  const missing = Object.assign(new Error('original target missing'), { code: 'host_inspection_path_not_found' });
  host.resolveResource = async (session, workspace, path) => {
    assert.equal(session, projection.sessionId); reads.push([workspace, path]);
    if (workspace === 'B') throw offline;
    if (path === '.') return { path: '/work/A', kind: 'directory' };
    if (path === 'denied') throw denied;
    if (path === 'missing') throw missing;
    return { path: '/work/A/' + path, kind: 'directory' };
  };
  host.locatePath = async path => { locations.push(path); };
  let open;
  function View() { open = useConversationBodyLinks(projection, 'en-US', message => errors.push(message), true).open; return null; }
  renderToStaticMarkup(createElement(View));
  function click(href, button = 0) {
    const anchor = new Anchor(href);
    const event = { target: anchor, currentTarget: anchor, button, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    const completed = open(event);
    assert.equal(event.defaultPrevented, true, 'do not follow this anchor in the browser');
    return completed;
  }
  return { host, errors, locations, reads, click };
}

test('an exact absolute link can use healthy A; unknown or denied targets never fall back to the OS', async t => {
  const { click, locations, reads, errors } = await bodyLinks(t);
  await click('/work/A/dir'); await tick();
  assert.deepEqual(locations, ['/work/A/dir']); assert.ok(reads.some(([w, p]) => w === 'A' && p === 'dir'));
  for (const [href, message] of [
    ['/work/A/denied', 'original target permission denied'], ['/work/A/missing', 'original target missing'],
    ['/work/B/dir', 'original root B unavailable'], ['/outside/file', 'original root B unavailable'],
    ['dir', 'original root B unavailable'],
  ]) {
    await click(href); await tick();
    assert.ok(errors.at(-1)?.includes(message), href + ': ' + errors.at(-1));
    assert.deepEqual(locations, ['/work/A/dir']);
  }
});

test('starting a click clears obsolete feedback; only the current native failure can publish an error', async t => {
  const { click, host, errors } = await bodyLinks(t);
  const gates = [];
  host.locatePath = path => new Promise((resolve, reject) => { gates.push({ path, resolve, reject }); });
  const start = async () => { click('workspace://A/dir'); await tick(); return gates.at(-1); };
  const first = await start(); first.reject(new Error('first actual rejection')); await tick();
  assert.match(errors.at(-1), /first actual rejection/);
  const notifications = errors.length;
  click('workspace://A/dir'); assert.deepEqual(errors.slice(notifications), [null], 'clear during the new event, not after its Host acknowledgement');
  await tick(); const retry = gates.at(-1);
  assert.notEqual(retry, first); assert.deepEqual(errors.slice(notifications), [null], 'no success notice while native work is pending');
  const third = await start(); third.reject(new Error('latest actual rejection')); await tick();
  assert.match(errors.at(-1), /latest actual rejection/);
  retry.resolve(); await tick(); assert.match(errors.at(-1), /latest actual rejection/, 'a late success cannot erase the latest rejection');
  const fourth = await start(), fifth = await start(); fifth.resolve(); await tick();
  const afterSuccess = [...errors]; fourth.reject(new Error('late failure')); await tick();
  assert.deepEqual(errors, afterSuccess); assert.equal(errors.at(-1), null);
});

test('empty main body links prevent navigation without a resource read or native action', async t => {
  const { click, reads, locations } = await bodyLinks(t);
  for (const button of [0, 1]) await click('', button);
  await tick(); assert.deepEqual(reads, []); assert.deepEqual(locations, []);
});

test('fixed JSON artifacts preserve exact bytes, including ordinary reports shaped like Host errors', async t => {
  const { readConversationArtifact } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const envelope = '{ "ok":false,"error":"artifact_read_failed","message":"a recorded error","data":null }\n';
  const responses = [
    new Response(envelope, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, immutable' } }),
    new Response('{"error":"recorded metric"}\n', { headers: { 'Content-Type': 'application/json' } }),
    Response.json({ ok: false, error: 'artifact_not_found', message: 'original archive error', data: null }),
    new Response('original proxy error', { status: 502 }),
  ];
  installGuiFetch(t, async () => responses.shift());
  const read = () => readConversationArtifact('session:test', 'artifact:report');
  const blob = await read(); assert.equal(blob.type, 'application/json');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from(envelope));
  assert.equal(await (await read()).text(), '{"error":"recorded metric"}\n');
  await assert.rejects(read(), error => error.code === 'artifact_not_found' && error.message.includes('original archive error'));
  await assert.rejects(read(), /original proxy error/);
  assert.equal(responses.length, 0);
});
