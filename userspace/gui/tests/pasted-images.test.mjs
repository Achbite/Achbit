import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModelStore, installGuiFetch } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { workspaceBinding, actorWith, createSession, fakeRunPreparation, emptyKernel, providerEvent, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const image = { inputId: 'image:clipboard', name: 'clipboard.png', mediaType: 'image/png', byteLength: png.length,
  dataUrl: `data:image/png;base64,${png.toString('base64')}` };

test('image paste preserves draft text and follows the same failed-draft ownership as other attachments', async t => {
  const [{ useAgentComposer }, { useLocalAgentStore: store }, { emptyComposerState, submitComposerState }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentComposer.ts', '/src/state/localAgentStore.ts', '/src/components/local-agent/composerSubmission.ts',
  ]);
  const previous = { storage: globalThis.sessionStorage, reader: globalThis.FileReader };
  const saved = new Map();
  globalThis.sessionStorage = { getItem: key => saved.get(key) ?? JSON.stringify({ ...emptyComposerState(), draft: 'existing draft' }),
    setItem: (key, value) => saved.set(key, value) };
  globalThis.FileReader = class {
    readAsDataURL(file) { assert.equal(file.type, 'image/png'); this.result = image.dataUrl; queueMicrotask(() => this.onload()); }
  };
  t.after(() => { globalThis.sessionStorage = previous.storage; globalThis.FileReader = previous.reader; });
  store.setState({ sessionId: 'session:paste', projection: null, loading: false, catalogBusy: false, profiles: [] });
  Object.assign(store.getInitialState(), store.getState());
  let composer;
  function Probe() { composer = useAgentComposer('zh-CN', () => {}); return null; }
  renderToStaticMarkup(createElement(Probe));
  let prevented = false;
  composer.pasteText({ preventDefault() { prevented = true; }, clipboardData: {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File([png], 'clipboard.png', { type: 'image/png' }) }],
    getData: () => '',
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  const draft = JSON.parse(saved.get('achbit:composer:session:paste'));
  assert.equal(draft.draft, 'existing draft');
  assert.equal(draft.pastedImages.length, 1);
  assert.equal(draft.pastedImages[0].dataUrl, image.dataUrl);
  assert.deepEqual(draft.filesystemPaths, []);
  let current = draft, failed;
  await submitComposerState('session:paste', draft, { read: () => current, write: (_key, value) => { current = value; },
    retainFailed: (_key, value) => { failed = value; }, send: async () => { current = { ...emptyComposerState(), draft: 'new draft' }; throw new Error('upload failed'); } });
  assert.equal(current.draft, 'new draft');
  assert.deepEqual(failed.pastedImages, draft.pastedImages);
  let ordinaryPrevented = false;
  composer.pasteText({ preventDefault() { ordinaryPrevented = true; }, clipboardData: { items: [], getData: () => 'plain text' } });
  assert.equal(ordinaryPrevented, false);
});

test('clipboard images use the existing size and format bounds', async t => {
  const [{ clipboardImages, readPastedImage, MAX_PASTED_IMAGE_BYTES }] = await loadGuiModules(t, ['/src/services/pastedImage.ts']);
  let attempted = 0;
  installGuiFetch(t, async () => { attempted++; return Response.json({ ok: false, message: 'invalid PNG contents' }); });
  assert.deepEqual(clipboardImages({ items: [{ kind: 'string', type: 'text/plain' }] }), []);
  await assert.rejects(readPastedImage(new File(['svg'], 'x.svg', { type: 'image/svg+xml' }), 'image:svg', false), /PNG/);
  await assert.rejects(readPastedImage(new File([new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' }), 'image:large', false), /8 MiB.*invalid PNG contents/);
  await assert.rejects(readPastedImage(new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }), 'image:huge', false), /32 MiB/);
  assert.equal(attempted, 1);
});

test('oversized paste puts only the prepared image in the draft without changing the clipboard File', async t => {
  const [{ readPastedImage, pastedImageBytes, MAX_PASTED_IMAGE_BYTES }] = await loadGuiModules(t, ['/src/services/pastedImage.ts']);
  const source = new File([new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1)], 'input.webp', { type: 'image/webp' });
  installGuiFetch(t, async (url, init) => {
    assert.equal(url.pathname, '/api/conversation/input-resources/prepare-image');
    assert.equal(init.method, 'POST'); assert.equal(init.body, source); assert.equal(init.headers['Content-Type'], 'image/webp');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const old = globalThis.FileReader; t.after(() => { globalThis.FileReader = old; });
  globalThis.FileReader = class { async readAsDataURL(blob) {
    assert.equal(blob.size, png.length); this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`; this.onload();
  } };
  const draft = await readPastedImage(source, 'image:normalized', false);
  assert.equal(draft.inputId, 'image:normalized'); assert.equal(draft.mediaType, 'image/png'); assert.equal(draft.byteLength, png.length);
  assert.deepEqual(Buffer.from(pastedImageBytes(draft)), png); assert.equal(source.size, MAX_PASTED_IMAGE_BYTES + 1);
});

test('image-only paste uploads bytes before submitting the bound image and keeps upload errors retryable', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:pasted-image';
  await createSession(journal, sessionId, [workspaceBinding]);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'text.delta', { text: 'Image received.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'pasted-image');
  t.after(() => actor.dispose());
  const reference = { referenceId: 'input:image', workspaceId: 'workspace:image', logicalPath: 'clipboard.png',
    displayName: 'clipboard.png', kind: 'file', mediaType: 'image/png', byteLength: png.length };
  let uploads = 0, commands = 0;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.includes('/input-resources/')) {
      assert.equal(init.headers['Content-Type'], 'image/png');
      assert.deepEqual(Buffer.from(init.body), png);
      if (uploads++ === 0) return Response.json({ ok: false, error: 'original_upload_failure', message: 'disk full' });
      return Response.json({ ok: true, data: { reference } });
    }
    if (url.pathname.endsWith('/commands')) {
      commands++; const command = JSON.parse(init.body);
      assert.equal(command.text, ''); assert.deepEqual(command.filesystemReferences, [reference]);
      return Response.json({ ok: true, data: await actor.submit(command) });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:images', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: await actor.snapshot(), selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }] });
  await assert.rejects(store.getState().sendMessage('', [], [], [], undefined, [image]), /original_upload_failure/);
  assert.equal(commands, 0); assert.equal(store.getState().submitting, false);
  await assert.rejects(store.getState().sendMessage('', [], [], [], undefined, Array(9).fill(image)), /reference_limit/);
  assert.equal(uploads, 1);
  await store.getState().sendMessage('', [], [], [], undefined, [image]);
  const completed = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.deepEqual(completed.messages[0].filesystemReferences, [reference]);
  assert.equal(uploads, 2); assert.equal(commands, 1);
});
