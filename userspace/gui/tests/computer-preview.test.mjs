import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

const target = { windowId: 47, generation: 3, pid: 12, app: 'Editor', title: 'File', width: 800, height: 600 };
const frame = { sequence: 4, width: 640, height: 480, capturedAt: 'now', dataUrl: 'data:image/jpeg;base64,AA==' };

test('preview keeps an unchanged target frame but never carries it across target generations or inactive/error states', async t => {
  const { acceptPreview } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const active = { state: 'active', target, frame };
  assert.equal(acceptPreview(active, { state: 'active', target }).frame, frame);
  assert.equal(acceptPreview(active, { pending: true }), active);
  assert.equal(acceptPreview(active, { state: 'active', target: { ...target, generation: 4 } }).frame, undefined);
  assert.equal(acceptPreview(active, { state: 'active', target: { ...target, windowId: 48 } }).frame, undefined);
  assert.equal(acceptPreview(active, { state: 'inactive', reason: 'closed' }).frame, undefined);
  assert.equal(acceptPreview(active, { state: 'active', target, frameError: 'capture failed' }).frame, undefined);
  assert.equal(acceptPreview(active, { state: 'active', target, pointer: { x: 0.4, y: 0.2, pulse: false, sharing: { state: 'stopped' } } }).pointer, undefined);
});

test('browser preview identity includes its Host, Session and exact previewId', async t => {
  const { acceptPreview } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const page = { hostInstanceId: 'host:1', windowLabel: 'main', sessionId: 'session:1', previewId: 'page:1', url: 'https://example.test' };
  const active = { state: 'active', target: page, frame };
  assert.equal(acceptPreview(active, { state: 'active', target: { ...page, sessionId: 'session:2' } }).frame, undefined);
  assert.equal(acceptPreview(active, { state: 'closed', reason: 'native_browser_page_closed' }).frame, undefined);
});

test('preview sits below right-rail cards and follows the bounded conversation when Reader resizes', async t => {
  const { previewPlacement } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const viewport = { width: 1440, height: 900 };
  const rail = rect(1140, 60, 300, 840);
  const inRail = previewPlacement(rect(240, 60, 900, 840), rail, 400, viewport, 780);
  assert.equal(inRail.top, 412);
  assert.ok(inRail.left >= rail.left && inRail.left + inRail.width <= rail.right);
  const reader = previewPlacement(rect(240, 60, 480, 840), null, 0, viewport, 710);
  assert.equal(reader.top, 72);
  assert.equal(reader.left + reader.width, 708);
  assert.ok(reader.top + reader.maxHeight < 710);
  const resized = previewPlacement(rect(80, 60, 240, 840), null, 0, viewport, 620);
  assert.equal(resized.left + resized.width, 308);
  assert.ok(resized.left >= 80 && resized.top + resized.maxHeight < 620);
});

test('preview measures real cards through the builtin UiRegion display-contents hosts', async t => {
  const { previewRailElements, previewPlacement } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = element => ({ display: element.display });
  t.after(() => { globalThis.getComputedStyle = previous; });
  const box = (top, height) => ({ left: 1200, right: 1490, width: 290, top, bottom: top + height, height });
  const card = (top, height) => ({ display: 'grid', children: [], getBoundingClientRect: () => box(top, height) });
  const contents = children => ({ display: 'contents', children, getBoundingClientRect: () => box(0, 0) });
  const tasks = card(66, 140), outputs = card(218, 109);
  const rail = { children: [contents([contents([tasks])]), contents([contents([outputs])])] };
  const measured = previewRailElements(rail);
  assert.deepEqual(measured, [tasks, outputs]);
  const position = previewPlacement({ ...box(52, 848), left: 240, right: 1200, width: 960 }, box(52, 848),
    Math.max(...measured.map(element => element.getBoundingClientRect().bottom)), { width: 1500, height: 900 }, 800);
  assert.equal(position.top, 339, 'preview is below the actual output card, not the zero-height region hosts');
  const agents = card(339, 80);
  rail.children.push(agents);
  assert.deepEqual(previewRailElements(rail), [tasks, outputs, agents]);
});

test('manual preview position stays in the run and is constrained by sidebar, Reader and viewport bounds', async t => {
  const { constrainPreviewPosition } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const remembered = { left: 1000, top: 450 };
  const size = { width: 240, height: 180 };
  const original = constrainPreviewPosition(remembered, size, rect(240, 52, 1200, 848), { width: 1440, height: 900 }, 780);
  assert.equal(original.left, 1000);
  assert.equal(original.top, 450);
  const reader = constrainPreviewPosition(remembered, size, rect(80, 52, 520, 648), { width: 1440, height: 700 }, 600);
  assert.equal(reader.left, 348);
  assert.equal(reader.top, 408);
  assert.deepEqual(remembered, { left: 1000, top: 450 }, 'layout clamping does not overwrite the user position');
  const restored = constrainPreviewPosition(remembered, size, rect(240, 52, 1200, 848), { width: 1440, height: 900 }, 780);
  assert.deepEqual(restored, original);
  const narrow = constrainPreviewPosition({ left: -100, top: -100 }, size, rect(240, 52, 200, 180), { width: 430, height: 220 }, 200);
  assert.equal(narrow.left, 252);
  assert.equal(narrow.top, 64);
  assert.equal(narrow.width, 166);
  assert.equal(narrow.maxHeight, 124);
});

test('one preview image control distinguishes drag from activation and preserves keyboard movement', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ComputerPreviewTarget } = await loadGuiModule(t, '/src/deepcode-gui/layout/ComputerTargetPreview.tsx');
  const moves = [], activations = [], captures = new Set();
  // DOMRect exposes these coordinates through prototype accessors, not own enumerable properties.
  class PreviewBounds { get left() { return 100; } get top() { return 200; } }
  const handle = { dataset: {}, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const pointer = (x, y) => ({ button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y, currentTarget: handle, preventDefault() {} });
  const click = detail => ({ detail, preventDefault() {}, stopPropagation() {} });
  function Probe() {
    const control = ComputerPreviewTarget({ view: { state: 'active', target, frame }, language: 'en-US', activating: false,
      getPosition: () => new PreviewBounds(), onMove: value => moves.push(value), onActivate: () => activations.push('activate') });
    const handlers = control.props;
    handlers.onPointerDown(pointer(20, 30));
    handlers.onPointerMove(pointer(22, 31));
    handlers.onPointerUp(pointer(22, 31));
    handlers.onClick(click(1));
    assert.equal(moves.length, 0, 'small pointer movement stays a click');
    assert.equal(activations.length, 1);
    handlers.onPointerDown(pointer(20, 30));
    handlers.onPointerMove(pointer(40, 50));
    assert.equal(handle.dataset.dragging, 'true');
    handlers.onPointerUp(pointer(40, 50));
    handlers.onClick(click(1));
    assert.deepEqual(moves, [{ left: 120, top: 220 }]);
    assert.equal(activations.length, 1, 'releasing a drag must not activate the native target');
    assert.equal(handle.dataset.dragging, undefined);
    assert.equal(captures.size, 0);
    handlers.onKeyDown({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
    assert.deepEqual(moves.at(-1), { left: 60, top: 200 });
    handlers.onClick(click(0));
    assert.equal(activations.length, 2, 'keyboard activation still reveals the target');
    handlers.onPointerDown(pointer(20, 30));
    handlers.onPointerCancel(pointer(20, 30));
    handlers.onPointerMove(pointer(80, 80));
    assert.equal(moves.length, 2, 'cancelled gestures stop moving');
    return control;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /<img/);
  assert.doesNotMatch(html, /computer-target-preview__heading/);
});

test('preview can still move while target activation is pending without submitting another activation', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ComputerPreviewTarget } = await loadGuiModule(t, '/src/deepcode-gui/layout/ComputerTargetPreview.tsx');
  const moves = [];
  function Probe() {
    const control = ComputerPreviewTarget({ view: { state: 'active', target, frame }, language: 'en-US', activating: true,
      getPosition: () => ({ left: 100, top: 200 }), onMove: value => moves.push(value), onActivate: () => assert.fail('pending activation must not submit again') });
    control.props.onClick({ detail: 0 });
    control.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
    return control;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, / disabled=""/);
  assert.deepEqual(moves, [{ left: 100, top: 210 }]);
});
