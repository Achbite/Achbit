import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../../shells/shared/native_browser/review.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(t) {
  let now = 0, timerId = 0, host, root;
  const timers = new Map();
  class Node {
    constructor() { this.style = {}; this.hidden = false; this.value = ''; this.listeners = new Map(); this.captured = new Set(); this.children = []; this.offsetWidth = 300; this.offsetHeight = 190; }
    addEventListener(type, callback, options) {
      const listeners = this.listeners.get(type) ?? new Set(); listeners.add(callback); this.listeners.set(type, listeners);
      options?.signal?.addEventListener('abort', () => listeners.delete(callback), { once: true });
    }
    emit(type, detail = {}) {
      const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 120,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, composedPath: () => [], ...detail };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
      return event;
    }
    append(node) { this.children.push(node); }
    prepend(node) { this.children.unshift(node); }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    hasPointerCapture(id) { return this.captured.has(id); }
    setPointerCapture(id) { this.captured.add(id); }
    releasePointerCapture(id) { this.captured.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
    attachShadow() { root = new Node(); return root; }
    set innerHTML(_value) {
      this.elements = Object.fromEntries(['.box', '.editor', 'textarea', '.hint', '[data-cancel]'].map(key => [key, new Node()]));
      this.elements['.box'].hidden = this.elements['.editor'].hidden = true;
    }
    querySelector(selector) { return this.elements[selector]; }
  }
  const document = new Node(), window = new Node();
  const target = { nodeType: 1, id: 'card', localName: 'article', innerText: 'Task content',
    getBoundingClientRect: () => ({ x: 50, y: 70, right: 350, bottom: 270, width: 300, height: 200 }) };
  document.documentElement = new Node();
  document.createElement = () => { const node = new Node(); host ??= node; return node; };
  document.elementFromPoint = () => target;
  document.querySelector = () => target;
  document.getSelection = () => ({ removeAllRanges() {} });
  const context = { document, window, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    location: { href: 'file:///review.html' }, CSS: { escape: value => value }, AbortController,
    crypto: { randomUUID: () => 'annotation:one' },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const start = vm.runInNewContext(script, context);
  start({ reviewId: 'review:one', labels: { annotation: 'Annotate', comment: 'Comment', hint: 'Click or drag' } });
  t.after(() => window.__achbitReview.dispose());
  const shield = root.children[0], box = root.querySelector('.box'), editor = root.querySelector('.editor'), input = root.querySelector('textarea');
  return { window, document, shield, box, editor, input, host, timers,
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    save() { assert.equal(editor.hidden, false, 'valid selection must open the comment editor'); input.value = 'Keep this area'; editor.emit('submit'); return plain(window.__achbitReview.pending); },
  };
}

test('annotation click preserves element evidence, saves once and clears on matching acknowledgement', t => {
  const h = harness(t);
  h.shield.emit('pointerdown'); h.shield.emit('pointerup');
  const note = h.save();
  assert.equal(note.mode, 'element'); assert.equal(note.selector, '#card'); assert.equal(note.comment, 'Keep this area');
  assert.deepEqual(note.rect, { x: 50, y: 70, width: 300, height: 200 });
  h.window.__achbitReview.acknowledge('other'); assert.ok(h.window.__achbitReview.pending);
  h.window.__achbitReview.acknowledge(note.id);
  assert.equal(h.window.__achbitReview.pending, null); assert.equal(h.box.hidden, true); assert.equal(h.input.value, '');
});

test('annotation paints feedback immediately on pointerdown', t => {
  const h = harness(t); h.shield.emit('pointerdown');
  assert.equal(h.box.hidden, false); assert.equal(h.box.style.width, '300px');
});

test('annotation direct drag does not require waiting for the long-press timer', t => {
  const h = harness(t); h.shield.emit('pointerdown'); h.tick(80);
  h.shield.emit('pointermove', { clientX: 210, clientY: 220 }); h.shield.emit('pointerup', { clientX: 210, clientY: 220 });
  const note = h.save(); assert.equal(note.mode, 'region'); assert.equal(note.selector, null);
  assert.deepEqual(note.rect, { x: 100, y: 120, width: 110, height: 100 });
});

test('movement before the hold threshold continues region selection instead of cancelling it', t => {
  const h = harness(t); h.shield.emit('pointerdown'); h.tick(100);
  h.shield.emit('pointermove', { clientX: 112, clientY: 130 }); h.tick(500);
  h.shield.emit('pointermove', { clientX: 240, clientY: 280 }); h.shield.emit('pointerup', { clientX: 240, clientY: 280 });
  assert.deepEqual(h.save().rect, { x: 100, y: 120, width: 140, height: 160 });
});

test('stationary or slightly jittering holds still open a valid element editor', t => {
  for (const offset of [0, 4]) {
    const h = harness(t); h.shield.emit('pointerdown'); h.shield.emit('pointermove', { clientX: 100 + offset, clientY: 120 + offset }); h.tick(600);
    h.shield.emit('pointerup', { clientX: 100 + offset, clientY: 120 + offset });
    assert.equal(h.save().mode, 'element', 'holding without a deliberate drag must not select a zero/tiny region');
  }
});

test('hold then drag supports reverse selection and clips to viewport', t => {
  const h = harness(t); h.shield.emit('pointerdown'); h.tick(600);
  h.shield.emit('pointermove', { clientX: -20, clientY: -30 }); h.shield.emit('pointerup', { clientX: -20, clientY: -30 });
  assert.deepEqual(h.save().rect, { x: 0, y: 0, width: 100, height: 120 });
});

test('secondary pointers cannot start or interrupt the active selection', t => {
  const h = harness(t);
  h.shield.emit('pointerdown', { pointerId: 2, isPrimary: false }); assert.equal(h.shield.hasPointerCapture(2), false);
  h.shield.emit('pointerdown'); h.shield.emit('pointermove', { pointerId: 2, clientX: 400, clientY: 400 });
  h.shield.emit('pointercancel', { pointerId: 2 });
  h.shield.emit('lostpointercapture', { pointerId: 2 });
  assert.equal(h.shield.hasPointerCapture(1), true);
  h.shield.emit('pointerup'); assert.equal(h.save().mode, 'element');
});

test('pointer cancellation, capture loss and window blur release gesture resources', t => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
    const h = harness(t); h.shield.emit('pointerdown');
    if (reason === 'blur') h.window.emit(reason);
    else if (reason === 'lostpointercapture') h.shield.releasePointerCapture(1);
    else h.shield.emit(reason);
    assert.equal(h.shield.hasPointerCapture(1), false, `${reason} releases before pointerup`);
    assert.equal(h.timers.size, 0, `${reason} cancels the hold`);
    h.tick(600); h.shield.emit('pointerup');
    assert.equal(h.editor.hidden, true, reason); assert.equal(h.shield.hasPointerCapture(1), false, reason); assert.equal(h.timers.size, 0, reason);
  }
});

test('annotation suppresses the native context menu and Escape disposes the overlay', t => {
  const h = harness(t);
  assert.equal(h.shield.emit('contextmenu').defaultPrevented, true);
  h.shield.emit('pointerdown'); h.document.emit('keydown', { key: 'Escape' }); h.tick(600);
  assert.equal(h.host.removed, true); assert.equal(h.window.__achbitReview.active, false); assert.equal(h.window.__achbitReview.exitReason, 'escape');
  assert.equal(h.timers.size, 0); assert.equal(h.shield.hasPointerCapture(1), false);
});
