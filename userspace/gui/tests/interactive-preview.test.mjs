import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModule } from './gui-projection-contract.mjs';

test('explicit preview references resolve archived HTML while code and ordinary links remain literal', async t => {
  const [{ MarkdownContent }, { PreviewArtifactsScope }, { previewArtifactId }, { readerTargetKey }] = await loadGuiModules(t, [
    '/src/components/local-agent/BufferedMarkdown.tsx', '/src/components/local-agent/InteractivePreview.tsx',
    '/src/components/local-agent/interactivePreviewFrame.ts', '/src/components/local-agent/readerState.ts',
  ]);
  const uri = 'artifact://artifact:sample';
  assert.equal(previewArtifactId(`  ${uri}\n`), 'artifact:sample');
  for (const source of ['', '/tmp/demo.html', 'https://example.com', `${uri}\n${uri}`, `${uri}?live=true`]) assert.equal(previewArtifactId(source), null);
  const artifact = { artifactId: 'artifact:sample', label: 'Counter demo', contentMode: 'fixed', contentType: 'text/html' };
  const scope = { sessionId: 'session:preview', artifacts: [artifact] };
  const preview = '```achbit-preview\n' + uri + '\n```';
  const render = (text, value = scope, streaming = false) => renderToStaticMarkup(createElement(PreviewArtifactsScope.Provider, { value }, createElement(MarkdownContent, { streaming }, text)));
  const markup = render('Before\n\n' + preview + '\n\nAfter');
  assert.match(markup, /Before/); assert.match(markup, /After/); assert.match(markup, /data-preview-artifact="artifact:sample"/);
  assert.match(markup, /Counter demo/); assert.doesNotMatch(markup, /artifact:\/\//);
  assert.doesNotMatch(render('[HTML](' + uri + ')\n\n```html\n<button>Try</button>\n```'), /data-preview-artifact/);
  assert.doesNotMatch(render(preview, null), /data-preview-artifact/, 'document quotations do not opt into conversation previews');
  assert.match(render(preview, { ...scope, artifacts: [] }), /role="alert"/);
  for (const change of [{ contentMode: 'live' }, { contentType: 'text/markdown' }]) {
    assert.match(render(preview, { ...scope, artifacts: [{ ...artifact, ...change }] }), /role="alert"/);
  }
  const original = { kind: 'artifact', artifact };
  assert.notEqual(readerTargetKey(original), readerTargetKey({ ...original, interactive: true }), 'interactive and document views retain distinct tabs');
});

test('an unfinished preview waits while a stable streaming block keeps its identity through settlement', async t => {
  const [{ MarkdownContent }, { PreviewArtifactsScope }, { StreamingMarkdownParser }] = await loadGuiModules(t, [
    '/src/components/local-agent/BufferedMarkdown.tsx', '/src/components/local-agent/InteractivePreview.tsx', '/src/components/local-agent/streamingMarkdown.ts',
  ]);
  const scope = { sessionId: 'session:preview', artifacts: [{ artifactId: 'artifact:sample', label: 'Sample', contentMode: 'fixed', contentType: 'text/html' }] };
  const source = '```achbit-preview\nartifact://artifact:sample';
  const render = (text, streaming) => renderToStaticMarkup(createElement(PreviewArtifactsScope.Provider, { value: scope }, createElement(MarkdownContent, { streaming }, text)));
  assert.match(render(source, true), /interactive-preview--pending/);
  assert.doesNotMatch(render(source, true), /data-preview-artifact/);
  const complete = source + '\n```\n\nFirst paragraph.\n\nSecond paragraph.';
  assert.match(render(complete, true), /data-preview-artifact="artifact:sample"/);
  const parser = new StreamingMarkdownParser();
  const live = parser.update(complete, true);
  assert.equal(live[0].streaming, false);
  const settled = parser.update(complete, false);
  assert.equal(settled[0].key, live[0].key);
  assert.deepEqual(settled[0].tree, live[0].tree);
});

test('recent preview rows survive ordinary virtualization and release least recently used rows within a bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ConversationLayoutCache, ConversationVirtualizer } = await loadGuiModule(t, '/src/components/local-agent/conversationVirtualizer.ts');
  const previousIntersection = globalThis.IntersectionObserver, previousResize = globalThis.ResizeObserver;
  let intersect;
  globalThis.IntersectionObserver = class { constructor(callback) { intersect = callback; } observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  t.after(() => { globalThis.IntersectionObserver = previousIntersection; globalThis.ResizeObserver = previousResize; });
  const document = { activeElement: null, getSelection: () => null, addEventListener() {}, removeEventListener() {} };
  const virtual = new ConversationVirtualizer(new ConversationLayoutCache().session('preview'), () => {});
  const nodes = new Map(), events = new Map();
  const release = [];
  for (const key of ['plain', 'a', 'b', 'c', 'd', 'e']) {
    const node = { hidden: false, dataset: { conversationAnchor: key, virtualRendered: 'true' }, ownerDocument: document,
      contains: () => false, getBoundingClientRect: () => ({ height: 400 }) };
    nodes.set(key, node); events.set(key, []);
    release.push(virtual.register(key, node, visible => { events.get(key).push(visible); node.dataset.virtualRendered = String(visible); }));
  }
  virtual.connect({ ...document, ownerDocument: document });
  intersect([...nodes.values()].map(target => ({ target, isIntersecting: false })));
  for (const key of ['a', 'b', 'c', 'd']) virtual.retainPreview(key);
  t.mock.timers.tick(30_000);
  assert.deepEqual(events.get('plain'), [false], 'ordinary rows still use the existing release policy');
  for (const key of ['a', 'b', 'c', 'd']) assert.deepEqual(events.get(key), [], 'preview remains mounted with its live frame');
  intersect([{ target: nodes.get('e'), isIntersecting: true }]);
  virtual.retainPreview('a'); virtual.retainPreview('e');
  t.mock.timers.tick(30_000);
  assert.deepEqual(events.get('b'), [false], 'fifth preview evicts the least recently used row');
  assert.deepEqual(events.get('a'), [], 'interaction refreshes retention');
  virtual.disconnect(); release.forEach(dispose => dispose());
  const snapshot = JSON.stringify([...events]);
  t.mock.timers.tick(60_000);
  assert.equal(JSON.stringify([...events]), snapshot, 'released views have no delayed work');
});
