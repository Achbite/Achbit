import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('inline diff keeps only nearby changes, correct line numbers and complete counts in a bounded preview', async t => {
  const { calculateChangePreview } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}\n`);
  const after = [...lines]; after[20] = 'changed 21\n'; after[170] = 'changed 171\n';
  const preview = calculateChangePreview(lines.join(''), after.join(''));
  assert.deepEqual(preview.counts, { added: 2, removed: 2 });
  assert.deepEqual(preview.hunks.map(h => [h.oldStart, h.newStart]), [[19, 19], [169, 169]]);
  assert.deepEqual(preview.hunks[0].lines, [' line 19', ' line 20', '-line 21', '+changed 21', ' line 22', ' line 23']);
  assert.equal(preview.truncated, false);
  assert.equal(preview.hunks.flatMap(h => h.lines).some(line => line === ' line 100'), false);
  for (const [before, after, counts] of [[null, lines.join(''), { added: 200, removed: 0 }], [lines.join(''), null, { added: 0, removed: 200 }]]) {
    const large = calculateChangePreview(before, after);
    assert.equal(large.truncated, true);
    assert.equal(large.hunks.flatMap(h => h.lines).length, 80);
    assert.deepEqual(large.counts, counts);
  }
  const longLine = calculateChangePreview(null, 'x'.repeat(50_000));
  assert.equal(longLine.truncated, true);
  assert.ok(longLine.hunks[0].lines[0].length <= 16_000);
  assert.deepEqual(calculateChangePreview(lines.join(''), lines.join('')).hunks, []);
});

test('nested tool disclosures stay anchored through loading and collapse without entering the ordered reading rows', async t => {
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const { ConversationAnchors } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const previousWindow = globalThis.window;
  const frames = new Map(); let sequence = 0;
  globalThis.window = { requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); } };
  t.after(() => { globalThis.window = previousWindow; });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'tools', projection: { sessionId: 'tools' }, loading: false,
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let height = 60, toggleTop = 600, nodes;
  const body = { scrollTop: 500, scrollHeight: 2400, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => nodes };
  const row = { dataset: { conversationAnchor: 'tools-row' }, hidden: false,
    getBoundingClientRect: () => ({ top: 400 - body.scrollTop, bottom: 600 + height - body.scrollTop }) };
  const toggle = { dataset: { conversationDisclosure: 'tool:read' }, hidden: false,
    getBoundingClientRect: () => ({ top: toggleTop - body.scrollTop, bottom: toggleTop + 24 - body.scrollTop }) };
  nodes = [row]; viewport.bodyRef.current = body; viewport.setLatestFollowMode(false);
  nodes = [row, toggle]; // Tool headings mount after the group expands.
  viewport.anchorDisclosure(toggle);
  height += 320; body.scrollHeight += 320;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  toggleTop += 30; body.scrollHeight += 30; // Async content above the clicked tool.
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  viewport.anchorDisclosure(toggle); height -= 320; body.scrollHeight -= 320;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  const anchors = new ConversationAnchors().read(body);
  assert.deepEqual(anchors.nodes, [row]);
  assert.equal(anchors.byKey.get('tool:read'), toggle);
  body.scrollTop += 80; viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 610, 'reader movement replaces the click anchor');
});
