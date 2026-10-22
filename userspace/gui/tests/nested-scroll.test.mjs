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
