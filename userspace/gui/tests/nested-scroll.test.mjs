import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('nested output retains follow while scrolling internally and releases it at the upper boundary', async t => {
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const previous = globalThis.window, frames = new Map(); let frame = 0;
  globalThis.window = { requestAnimationFrame(callback) { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame(id) { frames.delete(id); }, getComputedStyle: node => node.style };
  t.after(() => { globalThis.window = previous; });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'session:scroll', loading: false, projection: { sessionId: 'session:scroll' },
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const body = { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  const output = { scrollTop: 300, scrollHeight: 1500, clientHeight: 300, parentElement: body,
    style: { overflowY: 'auto', overscrollBehaviorY: 'auto' } };
  const text = { scrollHeight: 0, clientHeight: 0, parentElement: output };
  viewport.bodyRef.current = body;
  viewport.setLatestFollowMode(true);
  viewport.bodyHandlers.onWheel({ target: text, deltaY: -100 });
  output.scrollTop = 200;
  body.scrollHeight += 100;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 1100, 'an inner scroll must not detach the conversation from new output');

  output.scrollTop = 0;
  viewport.bodyHandlers.onWheel({ target: text, deltaY: -100 });
  body.scrollTop -= 100;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  body.scrollHeight += 200;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 1000, 'at the upper boundary the reader can move into history without being pulled back');

  output.scrollTop = output.scrollHeight - output.clientHeight;
  viewport.bodyHandlers.onWheel({ target: text, deltaY: 100 });
  body.scrollTop += 100;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 1100, 'downward outer movement from the lower boundary remains the reader position');
  body.scrollTop = body.scrollHeight - body.clientHeight;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  body.scrollHeight += 100;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 1400, 'only reaching the conversation tail resumes automatic following');
});

test('a short page keeps the displayed jump position through layout, and a new jump uses the requested offset', async t => {
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  let viewport;
  const saved = [];
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'turn', loading: false, projection: { sessionId: 'turn' },
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '',
      rememberAnchor: (_id, anchor, sequence) => saved.push([anchor.offset, sequence]) });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const body = { scrollTop: 0, scrollHeight: 900, clientHeight: 700, getBoundingClientRect: () => ({ top: 0 }) };
  const node = { dataset: { conversationAnchor: 'message', transcriptSequence: '41' }, closest: () => node, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 248 - body.scrollTop, bottom: 350 - body.scrollTop }) };
  body.querySelectorAll = () => [node];
  viewport.bodyRef.current = body;
  viewport.scrollToAnchor('message');
  assert.equal(node.getBoundingClientRect().top, 48);
  assert.deepEqual(saved, [[48, 41]]);
  body.scrollHeight = 1100;
  viewport.preserveReadingPosition();
  assert.equal(node.getBoundingClientRect().top, 48);
  assert.deepEqual(saved, [[48, 41]]);
  viewport.scrollToAnchor('message');
  assert.equal(node.getBoundingClientRect().top, 12);
  assert.deepEqual(saved, [[48, 41], [12, 41]]);
});

test('a native scrollbar drag releases a placed row and continues through local history', async t => {
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'drag', loading: false, projection: { sessionId: 'drag' },
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const body = { scrollTop: 0, scrollHeight: 1500, clientHeight: 500, clientWidth: 600, offsetWidth: 600,
    getBoundingClientRect: () => ({ top: 0, left: 0 }) };
  const node = { dataset: { conversationAnchor: 'addressed' }, closest: () => node, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 420 - body.scrollTop, bottom: 480 - body.scrollTop }) };
  body.querySelectorAll = () => [node];
  viewport.bodyRef.current = body;
  viewport.scrollToAnchor('addressed');
  viewport.bodyHandlers.onPointerDown({ target: body, currentTarget: body, pointerType: 'mouse', button: 0 });
  assert.equal(body.scrollTop, 408);
  body.scrollTop = 1000;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  assert.equal(body.scrollTop, 1000, 'native drag reaches the true end');
  body.scrollTop = 75;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  assert.equal(body.scrollTop, 75, 'earlier local history remains freely scrollable after addressing a row');
});
