import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadGuiModule } from './gui-projection-contract.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeStream() {
  const calls = [];
  return { calls, stream(sessionId, resources, signal, ready, changed, unavailable) {
    return new Promise((resolve, reject) => {
      calls.push({ sessionId, resources, signal, ready, changed, unavailable, reject });
      signal.addEventListener('abort', resolve, { once: true });
    });
  } };
}

test('resource subscriptions share one ready stream and isolate cancellation', async t => {
  const { createResourceSubscriptions } = await loadGuiModule(t, '/src/services/resourceSubscriptions.ts');
  const transport = fakeStream(), watch = createResourceSubscriptions(value => value, transport.stream);
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  t.after(() => controllers.forEach(controller => controller.abort()));
  const notifications = controllers.map(() => []);
  const waits = controllers.map((controller, index) => watch('session:files', [`file-${index}`], controller.signal, indices => notifications[index].push(indices)));
  await tick();
  assert.equal(transport.calls.length, 1, 'eight mounted tabs use one HTTP stream');
  assert.equal(transport.calls[0].resources.length, 8);
  transport.calls[0].ready();
  assert.deepEqual(notifications, controllers.map(() => [[0]]));
  transport.calls[0].changed([3]);
  assert.deepEqual(notifications[3], [[0], [0]]);
  assert.deepEqual(notifications[0], [[0]]);
  controllers[3].abort(); await waits[3]; await tick();
  assert.equal(transport.calls[0].signal.aborted, false, 'retain the old watch until replacement is ready');
  assert.equal(transport.calls[1].resources.length, 7);
  transport.calls[1].ready();
  assert.equal(transport.calls[0].signal.aborted, true);
  assert.deepEqual(notifications[0], [[0]], 'adding/removing other tabs does not reread every file');
  controllers.forEach(controller => controller.abort()); await Promise.all(waits); await tick();
  assert.equal(transport.calls[1].signal.aborted, true);
});

test('subscription replacement observes changes during the ready handoff and deduplicates identities', async t => {
  const { createResourceSubscriptions } = await loadGuiModule(t, '/src/services/resourceSubscriptions.ts');
  const transport = fakeStream(), watch = createResourceSubscriptions(value => value, transport.stream);
  const a = new AbortController(), b = new AbortController(), c = new AbortController();
  t.after(() => { a.abort(); b.abort(); c.abort(); });
  const seen = [[], [], []];
  const waits = [watch('s', ['a'], a.signal, indices => seen[0].push(indices))];
  await tick(); transport.calls[0].ready();
  waits.push(watch('s', ['a'], b.signal, indices => seen[1].push(indices)));
  await tick(); assert.equal(transport.calls.length, 1);
  waits.push(watch('s', ['b'], c.signal, indices => seen[2].push(indices)));
  await tick();
  transport.calls[0].changed([0]);
  assert.deepEqual(seen, [[[0], [0]], [[0], [0]], []]);
  transport.calls[1].ready();
  assert.deepEqual(seen[2], [[0]]);
  assert.equal(transport.calls[0].signal.aborted, true);
  a.abort(); b.abort(); c.abort(); await Promise.all(waits);
});

test('a failed initial stream rejects visibly and a fresh subscription can retry', async t => {
  const { createResourceSubscriptions } = await loadGuiModule(t, '/src/services/resourceSubscriptions.ts');
  const transport = fakeStream(), watch = createResourceSubscriptions(value => value, transport.stream);
  const abort = new AbortController(); t.after(() => abort.abort());
  let ready = 0;
  const first = watch('s', ['a'], abort.signal, () => ready++);
  const rejected = assert.rejects(first, /original watch failure/);
  await tick(); transport.calls[0].reject(new Error('original watch failure')); await rejected;
  assert.equal(ready, 0);
  const retry = watch('s', ['a'], abort.signal, () => ready++);
  await tick(); transport.calls[1].ready();
  assert.equal(ready, 1);
  abort.abort(); await retry;
});

test('one missing resource cannot reject healthy subscribers sharing the connection', async t => {
  const { createResourceSubscriptions } = await loadGuiModule(t, '/src/services/resourceSubscriptions.ts');
  const transport = fakeStream(), watch = createResourceSubscriptions(value => value, transport.stream);
  const good = new AbortController(), missing = new AbortController();
  t.after(() => { good.abort(); missing.abort(); });
  const notifications = [];
  const healthy = watch('s', ['a'], good.signal, indices => notifications.push(indices));
  const failed = assert.rejects(watch('s', ['missing'], missing.signal, () => assert.fail('missing resource cannot become ready')), /file missing/);
  await tick(); transport.calls[0].ready([0]); transport.calls[0].unavailable([1], new Error('file missing')); await failed;
  assert.deepEqual(notifications, [[0]]);
  transport.calls[0].changed([0]); assert.deepEqual(notifications, [[0], [0]]);
  await tick(); transport.calls[1].ready();
  assert.equal(good.signal.aborted, false);
  good.abort(); await healthy;
});

test('tree actions resolve exact paths without first opening a preview or submitting a message', async t => {
  const { runTreeResourceAction } = await loadGuiModule(t, '/src/components/local-agent/ResourceTreeMenu.tsx');
  const reference = { workspaceId: 'workspace:session-files', logicalPath: 'notes/research.md' };
  const entry = { name: 'research.md', kind: 'file', resource: reference };
  const copied = [], resolved = [], attachments = [], opens = [];
  const host = { copyText: async text => copied.push(text), resources: {
    resolveResourceReference: async (session, resource) => { resolved.push({ session, resource }); return { path: '/sessions/child/notes/research.md', kind: 'file' }; },
  }, locatePath: async path => opens.push(['folder', path]), openFile: async path => opens.push(['editor', path]) };
  let previews = 0;
  const run = action => runTreeResourceAction(action, entry, 'session:child', host, () => previews++, async files => attachments.push(files));
  await run('relativePath'); await run('name');
  assert.deepEqual(copied, ['notes/research.md', 'research.md']); assert.equal(resolved.length, 0);
  await run('absolutePath'); await run('attach'); await run('folder'); await run('editor');
  assert.equal(previews, 0);
  assert.equal(copied[2], '/sessions/child/notes/research.md');
  assert.deepEqual(attachments, [[{ path: '/sessions/child/notes/research.md', kind: 'file' }]]);
  assert.ok(resolved.every(item => item.session === 'session:child' && item.resource === reference));
  assert.deepEqual(opens, [['folder', copied[2]], ['editor', copied[2]]]);
  await run('preview'); assert.equal(previews, 1);
  host.resources.resolveResourceReference = async () => { throw new Error('original access error'); };
  await assert.rejects(run('attach'), /original access error/);
  assert.equal(attachments.length, 1);
});

test('Debug exposes the same resource menu action with validated item identity arguments', async t => {
  const { createDebugUiRegistry } = await loadGuiModule(t, '/src/debug/registry.ts');
  const registry = createDebugUiRegistry(), calls = [];
  const dispose = registry.register('tree', { slot: 'reader.tree', pluginId: null, read: () => ({}),
    actions: () => ({ openTreeItemMenu: id => calls.push(id) }) });
  assert.deepEqual(registry.list()[0].actions[0].arguments, ['string']);
  await registry.call('tree', 'openTreeItemMenu', ['file:one']);
  assert.deepEqual(calls, ['file:one']);
  await assert.rejects(registry.call('tree', 'openTreeItemMenu', [42]), /invalid_arguments/);
  dispose();
});

test('image and HTML previews are bounded independently of the operating viewport', async t => {
  const { previewFrameConstraints } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  assert.deepEqual(previewFrameConstraints({ contentKind: 'image', width: 600, height: 1200 }, 240, 800), { width: 120, maxHeight: 240 });
  assert.deepEqual(previewFrameConstraints({ contentKind: 'image', width: 1200, height: 600 }, 240, 800), { width: 240, maxHeight: 240 });
  assert.deepEqual(previewFrameConstraints({ contentKind: 'viewport', width: 320, height: 2000 }, 240, 800), { width: 240, maxHeight: 240 });
  assert.deepEqual(previewFrameConstraints({ contentKind: 'viewport', width: 320, height: 2000 }, 176, 120), { width: 176, maxHeight: 120 });
  assert.deepEqual(previewFrameConstraints({ width: 600, height: 1200 }, 240, 800), { width: 240, maxHeight: 800 }, 'desktop frames keep their existing geometry contract');
});

test('pure image capture selects the visible image rectangle, not white pixels or HTML layout', async () => {
  const script = await readFile(new URL('../../../shells/shared/native_browser/preview_region.js', import.meta.url), 'utf8');
  const viewport = { innerWidth: 400, innerHeight: 1000 };
  const image = { complete: true, naturalWidth: 1600, naturalHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 8, right: 400, bottom: 233 }) };
  const imageRegion = vm.runInNewContext(script, { ...viewport, document: { contentType: 'image/png', querySelector: () => image } });
  assert.deepEqual(JSON.parse(JSON.stringify(imageRegion)), { contentKind: 'image', rect: [0, 0.008, 1, 0.225] });
  const html = vm.runInNewContext(script, { ...viewport, document: { contentType: 'text/html', querySelector() { throw new Error('must not crop arbitrary HTML'); } } });
  assert.deepEqual(JSON.parse(JSON.stringify(html)), { contentKind: 'viewport', rect: null });
  assert.throws(() => vm.runInNewContext(script, { ...viewport, document: { contentType: 'image/png', querySelector: () => ({ ...image, complete: false }) } }), /image_not_ready/);
});
