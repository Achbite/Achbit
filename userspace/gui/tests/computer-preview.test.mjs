import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

const target = { windowId: 47, generation: 3, pid: 12, app: 'Editor', title: 'File', width: 800, height: 600 };
const frame = { sequence: 4, width: 640, height: 480, capturedAt: 'now', dataUrl: 'data:image/jpeg;base64,AA==' };

test('Windows and macOS enable desktop and browser preview', async t => {
  const { computerPreviewSources } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  assert.deepEqual(computerPreviewSources('Win32'), { desktop: true, browser: true });
  assert.deepEqual(computerPreviewSources('MacIntel'), { desktop: true, browser: true });
  assert.deepEqual(computerPreviewSources('Linux x86_64'), { desktop: false, browser: false });
});

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

test('browser preview preserves target identity and removes a closed page until a new target appears', async t => {
  const { acceptPreview } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const page = { hostInstanceId: 'host:1', windowLabel: 'main', sessionId: 'session:1', previewId: 'page:1', url: 'https://example.test' };
  const active = { state: 'active', target: page, frame };
  assert.equal(acceptPreview(active, { state: 'active', target: { ...page, sessionId: 'session:2' } }).frame, undefined);
  const closed = acceptPreview(active, { state: 'closed', reason: 'native_browser_page_closed' });
  assert.equal(closed, null, 'closing the page removes the preview, including its placeholder and reason');
  const pending = acceptPreview(closed, { pending: true });
  assert.deepEqual(pending, { state: 'starting' }, 'waiting for another target cannot revive the closed page');
  const nextPage = { ...page, previewId: 'page:2', url: 'https://example.test/next' };
  const next = acceptPreview(pending, { state: 'active', target: nextPage });
  assert.deepEqual(next.target, nextPage);
  assert.equal(next.frame, undefined, 'a new page cannot reuse the old screenshot');
  const nextFrame = { ...frame, sequence: 5, dataUrl: 'data:image/jpeg;base64,AQ==' };
  assert.equal(acceptPreview(next, { state: 'active', target: nextPage, frame: nextFrame }).frame, nextFrame);
  assert.equal(acceptPreview(next, { state: 'failed', reason: 'capture failed' }).reason, 'capture failed',
    'actual preview failures remain visible');
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

test('multiple preview targets start staggered and may overlap while remaining inside the available area', async t => {
  const { previewPlacement } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const conversation = rect(240, 60, 900, 840), rail = rect(1140, 60, 300, 840);
  const first = previewPlacement(conversation, rail, 400, { width: 1440, height: 900 }, 780, 0);
  const second = previewPlacement(conversation, rail, 400, { width: 1440, height: 900 }, 780, 1);
  assert.equal(second.left, first.left - 24);
  assert.equal(second.top, first.top + 24);
  assert.ok(second.left + second.width > first.left && second.top < first.top + 180,
    'the default offset leaves both previews exposed without forcing separate rows');
  assert.ok(second.left >= rail.left + 12 && second.top > 400);
  assert.equal(second.top + second.maxHeight, first.top + first.maxHeight);
  const reader = previewPlacement(rect(240, 60, 480, 840), null, 0, { width: 1440, height: 900 }, 710, 1);
  assert.ok(reader.left >= 252 && reader.left + reader.width <= 708);
  assert.ok(reader.top + reader.maxHeight < 710);
  const narrow = previewPlacement(rect(80, 60, 200, 840), null, 0, { width: 1440, height: 900 }, 620, 1);
  assert.equal(narrow.left, 92, 'horizontal stagger is constrained when the thumbnail fills a narrow area');
  assert.equal(narrow.width, 176);
  assert.equal(narrow.top, 96);
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
  const { ComputerPreviewTarget } = await loadGuiModule(t, '/src/achbit-gui/layout/ComputerTargetPreview.tsx');
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
  const { ComputerPreviewTarget } = await loadGuiModule(t, '/src/achbit-gui/layout/ComputerTargetPreview.tsx');
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

test('two preview controls move and activate their own targets without sharing drag or pending state', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ComputerPreviewTarget } = await loadGuiModule(t, '/src/achbit-gui/layout/ComputerTargetPreview.tsx');
  const page = { hostInstanceId: 'host:1', windowLabel: 'main', sessionId: 'session:1', previewId: 'page:2', url: 'https://example.test/preview' };
  const positions = [{ left: 900, top: 400 }, { left: 876, top: 424 }], activated = [];
  const captures = new Set();
  const handle = { dataset: {}, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const pointer = (x, y) => ({ button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y, currentTarget: handle, preventDefault() {} });
  const click = () => ({ detail: 1, preventDefault() {}, stopPropagation() {} });
  function Probe() {
    const controls = [target, page].map((boundTarget, index) => ComputerPreviewTarget({
      view: { state: 'active', target: boundTarget, frame }, language: 'en-US', activating: index === 0,
      getPosition: () => positions[index], onMove: position => { positions[index] = position; },
      onActivate: () => activated.push(boundTarget),
    }));
    controls[0].props.onPointerDown(pointer(10, 10));
    controls[0].props.onPointerMove(pointer(50, 30));
    controls[0].props.onPointerUp(pointer(50, 30));
    controls[0].props.onClick(click());
    assert.deepEqual(positions, [{ left: 940, top: 420 }, { left: 876, top: 424 }]);
    assert.deepEqual(activated, []);
    controls[1].props.onPointerDown(pointer(50, 30));
    controls[1].props.onPointerUp(pointer(50, 30));
    controls[1].props.onClick(click());
    assert.deepEqual(activated, [page], 'the browser remains activatable while the desktop target is pending');
    controls[1].props.onPointerDown(pointer(50, 30));
    controls[1].props.onPointerMove(pointer(114, 26));
    controls[1].props.onPointerUp(pointer(114, 26));
    controls[1].props.onClick(click());
    assert.deepEqual(positions, [{ left: 940, top: 420 }, { left: 940, top: 420 }], 'independent targets may occupy the same position');
    assert.deepEqual(activated, [page], 'the dragged browser does not activate on release');
    controls[1].props.onPointerDown(pointer(114, 26));
    controls[1].props.onPointerUp(pointer(114, 26));
    controls[1].props.onClick(click());
    assert.deepEqual(activated, [page, page], 'the next ordinary click is not swallowed by the previous drag');
    return createElement('div', null, ...controls.map((control, index) => createElement('div', { key: index }, control)));
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal((html.match(/<button\b/g) ?? []).length, 2);
  assert.equal((html.match(/aspect-ratio:640 \/ 480/g) ?? []).length, 2);
  assert.equal(captures.size, 0);
});
