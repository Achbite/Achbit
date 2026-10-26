// TCR: external evidence/session-progress-20261026/TCR-narrative-visibility.md
// Authored for the reported display regression; execution was explicitly excluded this turn.
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
      { type: 'toolGroup', sequence: 1, groupId: 'group:before', values: [before] },
      { type: 'narrative', sequence: 2, streamId: 'stream:progress',
        value: { runId, narrativeId: 'narrative:progress', content: progress } },
      { type: 'toolGroup', sequence: 3, groupId: 'group:after', values: [after] },
      { type: 'message', sequence: 4, streamId: 'stream:final',
        value: { runId, messageId: 'message:final', role: 'assistant', content: final, filesystemReferences: [] } },
    ],
    presentation: { content: id => id.startsWith('narrative:') ? progress : final },
    viewport: { bodyRef: { current: null }, transcriptRef: { current: null }, messageEndRef: { current: null },
      followingLatest: true, setLatestFollowMode() {}, preserveReadingPosition() {}, scrollToAnchor() {}, anchorDisclosure() {} },
    openWorkspaceResource() {}, setUiActionError() {},
  };
  return { props, runId, progress, final, render: input => renderToStaticMarkup(createElement(ConversationTranscript, input)) };
}

function rowTag(html, key) {
  const tag = html.match(new RegExp(`<div[^>]*data-conversation-anchor="${key}"[^>]*>`))?.[0];
  assert.ok(tag, `missing transcript row ${key}`);
  return tag;
}

test('a committed progress narrative remains visible and ordered when execution details collapse', async t => {
  const { props, runId, progress, final, render } = await transcript(t);
  const running = render(props);
  const settled = render({ ...props, displaySettledRunIds: new Set([runId]),
    projection: { ...props.projection, run: { runId, status: 'completed' } } });
  for (const html of [running, settled]) {
    assert.ok(html.includes(progress));
    assert.ok(html.includes(final));
    assert.doesNotMatch(rowTag(html, 'stream:progress'), /\bhidden=/);
    const positions = ['group:before', 'stream:progress', 'group:after', 'stream:final']
      .map(key => html.indexOf(`data-conversation-anchor="${key}"`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'presentation keeps the Session timeline order');
  }
  assert.match(rowTag(settled, 'group:before'), /\bhidden=/);
  assert.match(rowTag(settled, 'group:after'), /\bhidden=/);
  assert.doesNotMatch(rowTag(settled, 'stream:final'), /\bhidden=/);
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
