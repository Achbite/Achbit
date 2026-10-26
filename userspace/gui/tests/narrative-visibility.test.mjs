// TCR: external evidence/process-folding-0660-20261027/TCR.md
// Preserve the stable 0.6.60 process grouping: narrative and tools fold together.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGuiModules } from './gui-projection-contract.mjs';

async function transcript(t) {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ConversationTranscript }, { ConversationLayoutCache }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx', '/src/components/local-agent/conversationVirtualizer.ts',
  ]);
  const runId = 'run:progress';
  const activity = index => ({ activityId: `activity:${index}`, runId, sequence: index,
    kind: 'tool', status: 'completed', label: 'fs.read', callId: `call:${index}`,
    tool: { operation: 'fs.read', resources: [] } });
  const before = activity(1), after = activity(3);
  const opening = '我先检查连接配置。';
  const progress = '已确认配置格式，接下来更新连接。';
  const final = '连接已更新。';
  const props = {
    layoutCache: new ConversationLayoutCache(), language: 'zh-CN', loading: false,
    showReasoning: false, displaySettledRunIds: new Set(), onDisplayed() {},
    projection: { sessionId: 'session:progress', run: { runId, status: 'running' },
      plans: [], interactions: [], activities: [before, after], artifacts: [], fileChangeRounds: [], timeline: [],
      pendingApproval: null, terminalError: null, assistantDraft: null },
    hasConversationContent: true, draftItems: [],
    conversationItems: [
      { type: 'narrative', sequence: 0, streamId: 'stream:opening',
        value: { runId, narrativeId: 'narrative:opening', content: opening } },
      { type: 'toolGroup', sequence: 1, groupId: 'group:before', values: [before] },
      { type: 'narrative', sequence: 2, streamId: 'stream:progress',
        value: { runId, narrativeId: 'narrative:progress', content: progress } },
      { type: 'toolGroup', sequence: 3, groupId: 'group:after', values: [after] },
      { type: 'message', sequence: 4, streamId: 'stream:final',
        value: { runId, messageId: 'message:final', role: 'assistant', content: final, filesystemReferences: [] } },
    ],
    presentation: { content: id => id === 'narrative:narrative:opening' ? opening : id.startsWith('narrative:') ? progress : final },
    viewport: { bodyRef: { current: null }, transcriptRef: { current: null }, messageEndRef: { current: null },
      followingLatest: true, setLatestFollowMode() {}, preserveReadingPosition() {}, scrollToAnchor() {}, anchorDisclosure() {} },
    openWorkspaceResource() {}, setUiActionError() {},
  };
  return { props, runId, opening, progress, final, render: input => renderToStaticMarkup(createElement(ConversationTranscript, input)) };
}

function rowTag(html, key) {
  const tag = html.match(new RegExp(`<div[^>]*data-conversation-anchor="${key}"[^>]*>`))?.[0];
  assert.ok(tag, `missing transcript row ${key}`);
  return tag;
}

test('progress and tools remain ordered, collapse together after the answer, and restore on reopening', async t => {
  const { props, runId, opening, progress, final, render } = await transcript(t);
  const processKeys = ['stream:opening', 'group:before', 'stream:progress', 'group:after'];
  const allKeys = [...processKeys, 'stream:final'];
  const assertOrder = html => {
    const positions = allKeys.map(key => html.indexOf(`data-conversation-anchor="${key}"`));
    assert.ok(positions.every(position => position >= 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'preserve the Session timeline order');
  };
  const running = render(props);
  assertOrder(running);
  for (const key of allKeys) assert.doesNotMatch(rowTag(running, key), /\bhidden=/);
  for (const text of [opening, progress, final]) assert.ok(running.includes(text));

  const settledProps = { ...props, displaySettledRunIds: new Set([runId]),
    projection: { ...props.projection, run: { runId, status: 'completed' } } };
  const settled = render(settledProps);
  assertOrder(settled);
  for (const key of processKeys) assert.match(rowTag(settled, key), /\bhidden=/);
  assert.doesNotMatch(rowTag(settled, 'stream:final'), /\bhidden=/);
  assert.ok(settled.includes(final));
  assert.ok(!settled.includes(opening) && !settled.includes(progress));
  assert.match(settled, /conversation-process-toggle[^>]*aria-expanded="false"/);

  // Reopening the same run restores its retained presentation choice and every row.
  const disclosure = props.layoutCache.session(props.projection.sessionId).get(`${runId}:disclosure`);
  assert.ok(disclosure);
  disclosure.state.set('process', { displaySettled: true, open: true });
  const reopened = render(settledProps);
  assertOrder(reopened);
  for (const key of allKeys) assert.doesNotMatch(rowTag(reopened, key), /\bhidden=/);
  for (const text of [opening, progress, final]) assert.ok(reopened.includes(text));
  assert.match(reopened, /conversation-process-toggle[^>]*aria-expanded="true"/);
});

test('running reasoning history stays mounted only when the existing display preference is enabled', async t => {
  const { props, runId, render } = await transcript(t);
  const key = `${runId}:reasoning-history`;
  assert.equal(render(props).includes(`data-conversation-anchor="${key}"`), false);
  const enabled = render({ ...props, showReasoning: true });
  assert.match(rowTag(enabled, key), /data-virtual-rendered="true"/);
  assert.doesNotMatch(rowTag(enabled, key), /\bhidden=/);
  const settled = render({ ...props, showReasoning: true, displaySettledRunIds: new Set([runId]),
    projection: { ...props.projection, run: { runId, status: 'completed' } } });
  assert.match(rowTag(settled, key), /\bhidden=/, 'completed reasoning retains the existing process disclosure');
});
