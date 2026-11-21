import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, installGuiFetch, loadGuiModelStore, loadGuiModules } from './gui-projection-contract.mjs';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

test('a pending history page never paints excerpts as the conversation', async t => {
  const oldSelf = globalThis.self, oldStorage = globalThis.sessionStorage;
  globalThis.self = {}; globalThis.sessionStorage = { getItem: () => null, removeItem() {} };
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf;
    if (oldStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldStorage; });
  const [{ default: Panel }, { ConversationTranscript }, { ConversationDisplayProvider }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/LocalAgentPanel.tsx', '/src/components/local-agent/ConversationTranscript.tsx',
    '/src/components/local-agent/ConversationDisplayProvider.tsx', '/src/state/localAgentStore.ts']);
  const id = 'session:opening';
  store.setState({ sessionId: id, loading: true, loadingPurpose: 'session', projection: null,
    openingHistory: { sessionId: id, revision: 87, messages: [{ id: 'reply', role: 'assistant', content: '**RAW_EXCERPT**', truncated: true }] } });
  Object.assign(store.getInitialState(), store.getState());
  let node;
  function Probe() { node = findReactElement(Panel({}), x => x.type === ConversationTranscript); return null; }
  renderToStaticMarkup(createElement(ConversationDisplayProvider, null, createElement(Probe)));
  const html = renderToStaticMarkup(node);
  assert.doesNotMatch(html, /RAW_EXCERPT/);
  assert.match(html, /role="status"/);
});

test('long conversation Markdown waits for its real tree without a raw tail; the document Reader retains its searchable provisional text', async t => {
  const oldSelf = globalThis.self; globalThis.self = {};
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const [{ MarkdownContent }] = await loadGuiModules(t, ['/src/components/local-agent/BufferedMarkdown.tsx']);
  const text = 'A'.repeat(25000) + '\n\n**MARKDOWN_TAIL**';
  const pending = renderToStaticMarkup(createElement(MarkdownContent, null, text));
  assert.match(pending, /aria-busy="true"/);
  assert.doesNotMatch(pending, /MARKDOWN_TAIL/);
  assert.match(renderToStaticMarkup(createElement(MarkdownContent, { documentPreview: true }, text)), /MARKDOWN_TAIL/);
  const short = renderToStaticMarkup(createElement(MarkdownContent, null, '**REAL_BODY**'));
  assert.match(short, /<strong>REAL_BODY<\/strong>/);
});

test('only the actual reading viewport holds the first frame', async t => {
  const [{ firstConversationFrameReady: ready }] = await loadGuiModules(t, ['/src/components/local-agent/firstConversationFrame.ts']);
  const box = (top, bottom) => ({ getBoundingClientRect: () => ({ top, bottom, width: 400, height: bottom - top }) });
  const pending = (top, bottom) => ({ ...box(top, bottom), hasAttribute: () => true });
  const row = (top, bottom, rendered, parts = []) => ({ ...box(top, bottom), dataset: { virtualRendered: String(rendered) }, querySelectorAll: () => parts });
  const body = box(400, 800);
  const rows = [row(0, 400, false), row(400, 1000, true, [pending(850, 980)]), row(1000, 1400, false)];
  assert.equal(ready(body, rows), true, 'unmounted history and a busy diagram below the fold are independent');
  rows[1] = row(400, 1000, false);
  assert.equal(ready(body, rows), false, 'the saved visible row has not mounted');
  rows[1] = row(400, 1000, true, [pending(780, 920)]);
  assert.equal(ready(body, rows), false, 'a visible pending Markdown block cannot be shown');
  rows[1] = row(400, 1000, true);
  assert.equal(ready(body, rows), true);
});

test('the full read overlaps a held opening page without publishing a stale projection', async t => {
  const id = 'session:overlap', fresh = projectSession(emptySessionState(id));
  fresh.revision = 76;
  let release, fullReads = 0;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/read')) { await held; return Response.json({ ok: true, data: { sessionId: id, revision: 76, view: 'messages', items: [], nextBefore: null } }); }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: { ...fresh, revision: ++fullReads === 1 ? 75 : 76 } });
    throw new Error(`Unexpected ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ catalog: { projects: [], sessions: [{ id }] } });
  const activation = store.getState().activateSession(id);
  await waitUntil(() => fullReads === 1, 'full read while page pending');
  assert.equal(store.getState().projection, null);
  release(); await activation;
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().projection.revision, 76);
  assert.equal(fullReads, 2, 'the one established retry verifies the page revision');
});
