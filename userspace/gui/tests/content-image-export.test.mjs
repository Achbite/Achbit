import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModule, findReactElement } from './gui-projection-contract.mjs';

test('original images preserve bytes and format; failed reads and empty images remain errors', async t => {
  const { contentImage, readContentImage } = await loadGuiModule(t, '/src/components/local-agent/contentImage.ts');
  const bytes = new Uint8Array([0, 1, 2, 127, 255]);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'content-type': 'image/webp' } }));
  const image = await readContentImage('blob:loaded', 'chart.png');
  assert.equal(image.filename, 'chart.webp');
  assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()), bytes);
  assert.throws(() => contentImage(new Blob([]), 'empty'), /empty/);
  globalThis.fetch = async () => new Response('read error', { status: 403 });
  await assert.rejects(readContentImage('https://example.invalid/image', 'image'), /HTTP 403/);
});

test('DOM export captures full content dimensions and normalizes sticky copies without moving the live view', async t => {
  const { renderElementPng } = await loadGuiModule(t, '/src/components/local-agent/contentImage.ts');
  const liveSticky = { position: 'sticky', left: '0px', boxShadow: 'existing shadow' };
  const copy = { style: { ...liveSticky } }, cloneInput = { toggleAttribute(name, value) { this[name] = value; } };
  const node = { offsetWidth: 500, scrollWidth: 1400, offsetHeight: 300, scrollHeight: 2100, scrollLeft: 180,
    ownerDocument: { fonts: { ready: Promise.resolve() } }, parentElement: null,
    querySelectorAll(selector) { return selector === 'input' ? [{ checked: true }] : []; } };
  const parsed = { querySelectorAll(selector) { return selector === '[style]' ? [copy] : selector === 'input' ? [cloneInput] : []; } };
  const saved = Object.fromEntries(['getComputedStyle', 'DOMParser', 'XMLSerializer'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, {
    getComputedStyle: () => ({ backgroundColor: 'rgb(30, 31, 34)' }),
    DOMParser: class { parseFromString() { return parsed; } },
    XMLSerializer: class { serializeToString(value) { assert.equal(value, parsed); return '<svg>complete content</svg>'; } },
  });
  t.after(() => Object.assign(globalThis, saved));
  const image = new Blob(['png'], { type: 'image/png' });
  const result = await renderElementPng(node, async (source, options) => {
    assert.equal(source, node);
    assert.equal(options.width, 1400); assert.equal(options.height, 2100);
    assert.equal(options.style.overflow, 'visible');
    assert.equal(options.filter({ matches: () => true }), false, 'export controls are excluded');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg/>');
  }, async (svg, width, height, background) => {
    assert.equal(svg, '<svg>complete content</svg>');
    assert.deepEqual([width, height, background], [1400, 2100, 'rgb(30, 31, 34)']);
    return image;
  });
  assert.equal(result, image);
  assert.equal(copy.style.position, 'static');
  assert.equal(cloneInput.checked, true);
  assert.equal(liveSticky.position, 'sticky'); assert.equal(node.scrollLeft, 180);
  await assert.rejects(renderElementPng(node, async (_node, options) => options.imagePlaceholder,
    () => assert.fail('failed resource must not be encoded')), /could not be loaded/);
});

function previewWindow(t) {
  const previous = globalThis.window;
  const events = new Map(), requests = [];
  globalThis.window = {
    addEventListener(type, listener) { events.set(type, listener); },
    removeEventListener(type, listener) { if (events.get(type) === listener) events.delete(type); },
  };
  t.after(() => { globalThis.window = previous; });
  const frame = { postMessage(data, origin) { requests.push({ data, origin }); } };
  const reply = (data, source = frame) => events.get('message')?.({ source, data });
  return { events, requests, frame, reply };
}

test('preview export accepts only its frame and request, preserves the returned snapshot, and removes its listener', async t => {
  const { previewImage } = await loadGuiModule(t, '/src/components/local-agent/previewImage.ts');
  const { events, requests, frame, reply } = previewWindow(t);
  const result = previewImage(frame, 'live chart', new AbortController().signal);
  assert.equal(requests.length, 1);
  const { requestId } = requests[0].data;
  const blob = new Blob(['current canvas state'], { type: 'image/png' });
  reply({ type: 'achbit:preview', kind: 'export', requestId, blob }, {});
  reply({ type: 'achbit:preview', kind: 'export', requestId: 'another-request', blob });
  assert.equal(events.size, 1, 'unrelated completion does not settle the request');
  reply({ type: 'achbit:preview', kind: 'export', requestId, blob });
  const image = await result;
  assert.equal(image.blob, blob);
  assert.equal(image.filename, 'live chart.png');
  assert.equal(events.size, 0);
});

test('preview error, cancellation and timeout each settle once and release message listeners', async t => {
  const { previewImage } = await loadGuiModule(t, '/src/components/local-agent/previewImage.ts');
  const { events, requests, frame, reply } = previewWindow(t);
  let result = previewImage(frame, 'image', new AbortController().signal);
  reply({ type: 'achbit:preview', kind: 'export', requestId: requests.at(-1).data.requestId, error: 'canvas origin error' });
  await assert.rejects(result, /canvas origin error/); assert.equal(events.size, 0);
  const controller = new AbortController();
  result = previewImage(frame, 'image', controller.signal);
  controller.abort(new Error('view closed'));
  await assert.rejects(result, /view closed/); assert.equal(events.size, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  result = previewImage(frame, 'image', new AbortController().signal);
  const rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(30_000);
  await rejected; assert.equal(events.size, 0);
});

// Match the existing effect-capture convention while retaining state across isolated SSR renders.
function saveHarness(Component, props) {
  const slots = [], cleanups = [];
  let tree, cursor;
  function Probe() {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const original = internals.H; cursor = 0;
    internals.H = { ...original,
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect(effect) { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanups.push(effect()); } },
    };
    try { tree = Component(props); return tree; } finally { internals.H = original; }
  }
  return {
    render() { return renderToStaticMarkup(createElement(Probe)); },
    action() { return findReactElement(tree, node => node.props.icon === 'download'); },
    close() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('save control blocks duplicate work, treats cancellation as completion and retains actual save errors', async t => {
  const [{ ContentImageSave }, { useConversationHost }] = await loadGuiModules(t, [
    '/src/components/local-agent/ContentImageSave.tsx', '/src/components/local-agent/ConversationHost.tsx',
  ]);
  let resolve, produced = 0;
  const image = { filename: 'table.png', blob: new Blob(['png'], { type: 'image/png' }) };
  const saves = [];
  const host = useConversationHost();
  t.mock.method(host, 'saveImage', async file => { saves.push(file); });
  const control = saveHarness(ContentImageSave, { createImage: () => { produced++; return new Promise(done => { resolve = done; }); } });
  t.after(() => control.close());
  control.render(); control.action().props.onClick(); control.action().props.onClick();
  assert.equal(produced, 1);
  assert.match(control.render(), /aria-busy="true"/);
  resolve(image); await tick();
  assert.deepEqual(saves, [image]);
  assert.doesNotMatch(control.render(), /role="alert"/);
  assert.equal(control.action().props.disabled, false, 'native cancellation also resolves normally');
  host.saveImage = async () => { throw new Error('disk write failed'); };
  control.action().props.onClick(); resolve(image); await tick();
  assert.match(control.render(), /disk write failed/);
  host.saveImage = async () => {};
  control.action().props.onClick();
  assert.doesNotMatch(control.render(), /role="alert"/, 'a new attempt clears its previous error');
  resolve(image); await tick();
});

test('unmount aborts preparation and prevents a late snapshot opening a save dialog', async t => {
  const [{ ContentImageSave }, { useConversationHost }] = await loadGuiModules(t, [
    '/src/components/local-agent/ContentImageSave.tsx', '/src/components/local-agent/ConversationHost.tsx',
  ]);
  let signal, finish, saves = 0;
  t.mock.method(useConversationHost(), 'saveImage', async () => { saves++; });
  const control = saveHarness(ContentImageSave, { createImage: value => {
    signal = value; return new Promise(resolve => { finish = resolve; });
  } });
  control.render(); control.action().props.onClick(); control.close();
  assert.equal(signal.aborted, true);
  finish({ filename: 'late.png', blob: new Blob(['png']) }); await tick();
  assert.equal(saves, 0);
});
