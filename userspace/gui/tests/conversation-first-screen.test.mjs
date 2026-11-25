import { history, reader, pause } from './complete-reading-fixture.mjs';
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

test('the first transcript uses the saved row on both sides of the page threshold, and the tail when following', async t => {
  const oldSelf = globalThis.self; globalThis.self = {};
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const [{ ConversationTranscript }, { ConversationLayoutCache }, { projectionItems }, { MarkdownContent }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx', '/src/components/local-agent/conversationVirtualizer.ts',
    '/src/components/local-agent/conversationItems.ts', '/src/components/local-agent/BufferedMarkdown.tsx']);
  for (const [count, rowsPerRound, middle] of [[32, 1, 8], [33, 1, 8], [160, 8, 80]]) {
    const projection = projectSession(emptySessionState(`session:first-${count}`));
    for (let i = 0; i < count; i++) {
      const messageId = `q:${i}`, runId = `run:${Math.floor(i / rowsPerRound)}`, sequence = i + 1;
      projection.messages.push({ messageId, runId, sequence, role: 'user', content: `body ${i}`, filesystemReferences: [] });
      projection.timeline.push({ kind: 'message', timelineId: `timeline:${i}`, messageId, sequence });
    }
    const lastRun = `run:${Math.floor((count-1) / rowsPerRound)}`;
    projection.run = { runId: lastRun, status: 'completed' };
    projection.fileChangeRounds = [{ runId:lastRun, recordIds:['change'] }];
    projection.activities.push({ activityId:'a', runId:lastRun, tool:{recordId:'change',fileChanges:[{workspaceId:'w',path:'note.txt',kind:'modify'}]} });
    const presentation = { layoutKey: 'test', content: key => createElement(MarkdownContent, null, `**${key}**`) };
    const render = openingAnchor => renderToStaticMarkup(createElement(ConversationTranscript, {
      layoutCache: new ConversationLayoutCache(), projection, conversationItems: projectionItems(projection), draftItems: [],
      hasConversationContent: true, language: 'en-US', displaySettledRunIds: new Set([lastRun]), presentation,
      viewport: { openingAnchor, followingLatest: !openingAnchor, bodyRef: { current: null }, transcriptRef: { current: null }, messageEndRef: { current: null } },
    }));
    for (const [anchor, target] of [[`q:${middle}`, middle], [undefined, count - 1], ['missing-row', count - 1]]) {
      const markup = render(anchor);
      const rows = markup.match(/<div\b[^>]*data-conversation-anchor="[^"]+"[^>]*>/g) ?? [];
      const rendered = (key, sequence) => rows.some(tag => tag.includes(`data-conversation-anchor="${key}"`)
        && tag.includes('data-virtual-rendered="true"') && tag.includes(`data-transcript-sequence="${sequence}"`));
      assert.ok(rendered(`q:${target}`, target + 1), `${count} rounds, ${anchor ?? 'tail'}: target starts as a real row`);
      assert.ok(markup.includes(`<strong>message:q:${target}:content</strong>`), 'the target contains formatted text, not a spacer or a rail label');
      if (!anchor) assert.ok(rendered(`${lastRun}:file-changes`, count), 'following: the actual tail footer must replace its pending neighbour without hiding the message for an observer turn');
      if (anchor === `q:${middle}`) {
        assert.ok(rendered('q:0', 1), 'the start stays in the same scroll surface');
        assert.ok(markup.includes(`<strong>message:q:${target + 1}:content</strong>`), 'also mount the adjacent text');
        assert.ok(rendered(`q:${count - 1}`, count), 'the final message is present on first mount');
      }
    }
  }
});

test('a measured mixed screen shows its formatted anchor between two scrollable pages without paging labels', async t => {
  const oldSelf = globalThis.self; globalThis.self = {};
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const [{ ConversationTranscript }, { ConversationLayoutCache }, { MarkdownContent }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx', '/src/components/local-agent/conversationVirtualizer.ts', '/src/components/local-agent/BufferedMarkdown.tsx']);
  const message = { role: 'user', messageId: 'q', content: '**Anchor**', filesystemReferences: [], runId: 'r', sequence: 9 };
  const p=history('session:mixed',3);p.messages[2]={...p.messages[2],content:message.content};
  const [{projectionItems}]=await loadGuiModules(t,['/src/components/local-agent/conversationItems.ts']);
  const html=renderToStaticMarkup(createElement(ConversationTranscript,{projection:p,layoutCache:new ConversationLayoutCache(),
    conversationItems:projectionItems(p),draftItems:[],displaySettledRunIds:new Set(),language:'en-US',hasConversationContent:true,loading:false,
    presentation:{layoutKey:'test',content:()=>createElement(MarkdownContent,null,message.content)},
    viewport:{followingLatest:false,bodyRef:{current:null},transcriptRef:{current:null},messageEndRef:{current:null},openingAnchor:p.messages[2].messageId}}));
  assert.match(html,/<strong>Anchor<\/strong>/);assert.ok(html.includes(p.messages[0].messageId) && html.includes(p.messages.at(-2).messageId), 'both adjacent turns are in the document');
  assert.doesNotMatch(html, /data-transcript-page|Earlier turns|Later turns/);
  assert.doesNotMatch(html,/data-pending-neighbor|Opening conversation/);
});

test('the frame acceptance helper only counts pending content in the actual reading viewport', async t => {
  const [{ firstConversationFrameReady: ready }] = await loadGuiModules(t, ['/tests/support/firstConversationFrame.ts']);
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

test('a visible image is local to its formatted row, including while its URL is being resolved', async t => {
  const oldSelf = globalThis.self, oldImage = globalThis.HTMLImageElement;
  class HeldImage {
    src = 'https://unused.invalid/inline'; complete = false; loading = 'lazy';
    hasAttribute() { return false; }
    getBoundingClientRect() { return { top: 40, bottom: 140, width: 200, height: 100 }; }
  }
  globalThis.self = {}; globalThis.HTMLImageElement = HeldImage;
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf;
    if (oldImage === undefined) delete globalThis.HTMLImageElement; else globalThis.HTMLImageElement = oldImage; });
  const [{ firstConversationFrameReady }, { ImageContent }] = await loadGuiModules(t, [
    '/tests/support/firstConversationFrame.ts', '/src/components/local-agent/RichContent.tsx']);
  const img = new HeldImage();
  const body = { getBoundingClientRect: () => ({ top: 0, bottom: 400, width: 480, height: 400 }) };
  const row = { ...body, dataset: { virtualRendered: 'true' }, querySelectorAll: selector => selector.includes('img') ? [img] : [] };
  assert.equal(firstConversationFrameReady(body, [row]), true, 'do not wait for the image request to finish');
  const props = { source: 'workspace://files/picture.png', alt: 'Picture', width: 800, height: 600 };
  const pending = renderToStaticMarkup(createElement(ImageContent, props));
  assert.match(pending, /data-reading-image="loading"/);
  assert.match(pending, /aspect-ratio:800\s*\/\s*600/);
  const [{ MarkdownContent }] = await loadGuiModules(t, ['/src/components/local-agent/BufferedMarkdown.tsx']);
  const message = renderToStaticMarkup(createElement(MarkdownContent, null, '**Before** ![Picture](workspace://files/picture.png) **After**'));
  assert.match(message, /<strong>Before<\/strong>.*data-reading-image="loading".*<strong>After<\/strong>/s);
  assert.match(pending, /role="status"/);
  assert.doesNotMatch(pending, /data-conversation-pending/, 'resolving a local image is not unfinished Markdown');
});

test('a conversation without children opens its history and run with one read',async t=>{
  const p=history('a'),f=await reader(t,[p]);const state=await f.open('a');
  assert.deepEqual(state.projection.messages,p.messages);assert.deepEqual(state.projection.run,p.run);
  assert.equal(state.loading,false);assert.deepEqual(f.seen.map(x=>x.route),['projection']);
});
test('a persistently older page fails at the authenticated revision floor without fetching excerpts',async t=>{
  const p=history('a'),f=await reader(t,[p]);f.store.setState({sessionStatuses:{a:{sessionId:'a',revision:p.revision+1,run:null}}});
  const state=await f.open('a');assert.match(state.error,/session_projection_revision_behind/);assert.equal(state.projection,null);assert.equal(f.reads().length,2);
});

test('a saved historical page opens with the current model and run and retains both on hot return', async t => {
  const p = history('session:anchor-model'), other = history('session:other-model');
  p.modelSettings = { profileId: 'profile:bound', reasoningEffortOverride: 'high' };
  const f = await reader(t, [p, other]);
  const anchor = p.messages[2];
  await f.open(p.sessionId);
  const state = f.store.getState();
  state.rememberReadingAnchor(p.sessionId, { key: anchor.messageId, offset: 0 }, anchor.sequence);
  await f.open(other.sessionId);
  f.store.getState().observeHistory('closed');
  f.store.getState().observeHistory('ready');
  const before = f.reads().length;
  const restored = await f.open(p.sessionId);
  assert.deepEqual(f.reads().slice(before).map(r => r.id), [p.sessionId]);
  assert.equal(restored.projection.messages[2].messageId, anchor.messageId);
  assert.deepEqual(restored.projection.run, p.run);
  assert.equal(restored.selectedProfileId, p.modelSettings.profileId);
  assert.equal(restored.reasoningEffortOverride, 'high');
  await f.open(other.sessionId);
  const count = f.reads().length;
  const hot = await f.open(p.sessionId);
  assert.equal(f.reads().length, count);
  assert.equal(hot.projection, restored.projection);
  assert.equal(hot.selectedProfileId, p.modelSettings.profileId);
});
