import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import vm from 'node:vm';
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

test('the shipped frame bridge measures flow but does not mistake a viewport shell for its natural height', async t => {
  const { interactivePreviewDocument } = await loadGuiModule(t, '/src/components/local-agent/interactivePreviewFrame.ts');
  let script, measured, scheduled, height = 84, extent = 0, overflowY = 'visible';
  const original = globalThis.DOMParser;
  globalThis.DOMParser = class { parseFromString() { return { createElement: () => ({}), head: { prepend: node => { script = node.textContent; } }, documentElement: { outerHTML: '' } }; } };
  t.after(() => { if (original) globalThis.DOMParser = original; else delete globalThis.DOMParser; });
  interactivePreviewDocument('<main>Fixture</main>');
  const messages = [];
  const root = { get scrollHeight() { return Math.max(extent, 420); } };
  const page = { readyState: 'complete', documentElement: root, addEventListener() {}, body: {
    getBoundingClientRect: () => ({ height }), get scrollHeight() { return Math.max(height, extent); } } };
  const context = { document: page, parent: { postMessage(value) { messages.push(value); } }, innerWidth: 700, innerHeight: 420,
    getComputedStyle: () => ({ marginTop: '0px', marginBottom: '0px', overflowY }), addEventListener() {},
    requestAnimationFrame(fn) { scheduled = fn; return 1; }, ResizeObserver: class { constructor(f) { measured = f; } observe() {} } };
  context.window = context;
  vm.runInNewContext(script, context); scheduled();
  assert.equal(messages.at(-1).height, 84, 'short content does not inherit the document viewport floor');
  extent = 980; measured(); scheduled(); assert.equal(messages.at(-1).height, 980);
  height = 420; extent = 420; overflowY = 'hidden'; measured(); scheduled();
  assert.equal(messages.at(-1).viewport, true, 'body-sized app with an internal scroller delegates geometry to the host pane');
  const count = messages.length; context.innerHeight = height = 800; measured(); scheduled();
  assert.equal(messages.length, count, 'fitting the app canvas does not feed its new viewport back into host layout');
  overflowY = 'visible'; height = 96; extent = 0; measured(); scheduled();
  assert.equal(messages.at(-1).viewport, false); assert.equal(messages.at(-1).height, 96);
});

test('inline geometry distinguishes natural, wrappable and viewport-relative widths without a resize loop', async t => {
  const { interactivePreviewDocument } = await loadGuiModule(t, '/src/components/local-agent/interactivePreviewFrame.ts');
  let script, scheduled, observer, declaration = 'auto', priority = '', ideal = 368, min = 120;
  const original = globalThis.DOMParser;
  globalThis.DOMParser = class { parseFromString() { return { createElement: () => ({}), head: { prepend: node => { script = node.textContent; } }, documentElement: { outerHTML: '' } }; } };
  t.after(() => { if (original) globalThis.DOMParser = original; else delete globalThis.DOMParser; });
  interactivePreviewDocument('<main>Intrinsic size fixture</main>', true);
  const messages = [];
  const root = { style: { getPropertyValue: () => declaration, getPropertyPriority: () => priority,
    setProperty(_, v, p) { declaration = v; priority = p; }, removeProperty() { declaration = ''; } },
    get clientWidth() { return env.innerWidth; }, get scrollHeight() { return env.innerHeight; },
    getBoundingClientRect: () => ({ width: declaration === 'max-content' ? ideal : declaration === 'min-content' ? min : env.innerWidth }) };
  const env = { innerWidth: 840, innerHeight: 360, parent: { postMessage(v) { messages.push(v); } },
    document: { readyState: 'complete', documentElement: root, addEventListener() {}, body: { scrollHeight: 96, getBoundingClientRect: () => ({ height: 96 }) } },
    addEventListener() {}, getComputedStyle: () => ({ marginTop: '0px', marginBottom: '0px', overflowY: 'visible' }),
    requestAnimationFrame(f) { scheduled = f; return 1; }, ResizeObserver: class { constructor(f) { observer = f; } observe() {} } };
  env.window = env; vm.runInNewContext(script, env); scheduled();
  const sample = () => { observer(); scheduled(); return messages.at(-1); };
  assert.deepEqual([sample().preferredWidth, sample().minimumWidth, sample().height], [368, 120, 96]);
  const n = messages.length; env.innerWidth = ideal; sample(); assert.equal(messages.length, n, 'fitting is not another size request');
  env.innerWidth = 280; assert.equal(sample().preferredWidth, 368, 'a narrower pane does not become the new natural width');
  min = ideal; assert.equal(sample().minimumWidth, 368, 'only intrinsically wide content asks for a larger minimum canvas');
  ideal = min = 224; sample(); env.innerWidth = 224; ideal = min = 180;
  assert.equal(sample().preferredWidth, 0, 'viewport-dependent lengths release the cap instead of shrinking recursively');
  assert.equal(declaration, 'auto'); assert.equal(priority, '', 'the author declaration and priority are restored');
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


test('preview actions distinguish repeated inline blocks and the Reader of the same artifact', async t => {
  const [{ MarkdownContent }, { PreviewArtifactsScope, ArtifactInteractivePreview }, { RichContentScope }] = await loadGuiModules(t, [
    '/src/components/local-agent/BufferedMarkdown.tsx', '/src/components/local-agent/InteractivePreview.tsx',
    '/src/components/local-agent/RichContentIdentity.tsx',
  ]);
  const artifact = { artifactId: 'artifact:repeated', label: 'Repeated', contentMode: 'fixed', contentType: 'text/html' };
  const scope = { sessionId: 'session:repeated', artifacts: [artifact] };
  const preview = '```achbit-preview\nartifact://artifact:repeated\n```';
  const html = renderToStaticMarkup(createElement(PreviewArtifactsScope.Provider, { value: scope },
    createElement(RichContentScope.Provider, { value: { sessionId: scope.sessionId, rowKey: 'stream:repeated', contentKey: 'body' } },
      createElement(MarkdownContent, null, preview + '\n\n' + preview)),
    createElement(ArtifactInteractivePreview, { sessionId: scope.sessionId, artifact })));
  const actions = [...html.matchAll(/<button\b[^>]*data-ui-action="conversation.preview.([^"]+)"[^>]*>/g)]
    .map(([tag, action]) => ({ action, target: JSON.parse(/data-ui-target="([^"]+)"/.exec(tag)[1].replaceAll('&quot;', '"')) }));
  const saveActions = actions.filter(item => item.action === 'save');
  assert.equal(saveActions.length, 3);
  assert.equal(new Set(saveActions.map(item => JSON.stringify(item))).size, 3);
  assert.ok(saveActions.every(item => item.target.artifactId === artifact.artifactId && item.target.sessionId === scope.sessionId));
  const moreActions = actions.filter(item => item.action === 'more');
  assert.equal(moreActions.length, 2);
  assert.ok(moreActions.every(item => item.target.location === 'inline'));
  assert.equal(new Set(moreActions.map(item => JSON.stringify(item.target))).size, 2);
  const originalActions = actions.filter(item => item.action !== 'save' && item.action !== 'more');
  assert.equal(originalActions.length, 8);
  assert.equal(new Set(originalActions.map(item => JSON.stringify(item))).size, 8);
  assert.equal(originalActions.filter(item => item.target.location === 'inline').length, 6);
  assert.equal(originalActions.filter(item => item.target.location === 'reader').length, 2);
  assert.ok(actions.every(item => item.target.artifactId === artifact.artifactId && item.target.sessionId === scope.sessionId));
});
