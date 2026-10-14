import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

test('subagent navigation uses Reader identity and preserves nested parent and child scope', async t => {
  const [{ requestAgentConversation, AgentNavigationScope, useAgentNavigation }, { READER_OPEN_EVENT, readerTargetKey }] = await loadGuiModules(t, [
    '/src/components/local-agent/agentNavigation.tsx', '/src/components/local-agent/readerState.ts',
  ]);
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = previousWindow; });
  const events = [];
  window.addEventListener(READER_OPEN_EVENT, event => events.push(event.detail));
  requestAgentConversation('session:root', 'session:child', 'activity:first');
  const target = events[0].target;
  assert.deepEqual(events[0], { sessionId: 'session:root', target: {
    kind: 'agent', parentSessionId: 'session:root', agentSessionId: 'session:child', entryId: 'activity:first',
  } });
  assert.equal(readerTargetKey(target), readerTargetKey({ ...target, entryId: 'activity:later' }));
  assert.equal(readerTargetKey(target), readerTargetKey({ ...target, sourceSessionId: 'session:root' }));
  assert.equal(readerTargetKey(target), readerTargetKey({ ...target, agentSessionId: 'session:grandchild' }), 'child selection updates the single subagents tab');
  assert.equal(readerTargetKey(target), readerTargetKey({ kind: 'agent', parentSessionId: 'session:root' }), 'overview shares the same tab');
  let closed = 0;
  function NestedNavigation() {
    const navigation = useAgentNavigation();
    assert.equal(navigation.selected, null, 'a parent entry does not select a nested child entry');
    navigation.open({ sessionId: 'session:grandchild', entryId: 'activity:nested' });
    navigation.open(null);
    return null;
  }
  renderToStaticMarkup(createElement(AgentNavigationScope, { sessionId: 'session:root', activeAgent: target, onCloseAgent: () => { closed += 1; } },
    createElement(AgentNavigationScope, { sessionId: 'session:child' }, createElement(NestedNavigation))));
  assert.deepEqual(events[1], { sessionId: 'session:child', target: {
    kind: 'agent', parentSessionId: 'session:child', agentSessionId: 'session:grandchild', entryId: 'activity:nested',
  } });
  assert.equal(closed, 1, 'nested navigation shares the Reader close operation');
});

test('subagent page information displays the child model configuration with copyable identity', async t => {
  const [{ AgentPageInformation }] = await loadGuiModules(t, ['/src/components/local-agent/AgentTasksPanel.tsx']);
  const projection = { run: { reasoningEffort: 'max', thinking: 'enabled' }, agentContext: { model: {
    profileId: 'profile:child', model: 'child-model', reasoningEffort: 'low', thinking: 'disabled',
    parameters: { contextWindowTokens: 128000, maxOutputTokens: 8192 },
  } } };
  const html = renderToStaticMarkup(createElement(AgentPageInformation, {
    name: 'Image reviewer', sessionId: 'session:child-with-a-long-identifier', projection, language: 'en-US',
  }));
  for (const value of ['Image reviewer', 'session:child-with-a-long-identifier', 'child-model', 'profile:child', 'Max', 'Enabled', '128,000', '8,192']) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, />Low<|>Disabled</, 'the active child run supplies its effective effort and thinking mode');
  const chinese = renderToStaticMarkup(createElement(AgentPageInformation, { name: '审阅', sessionId: 'session:child', projection, language: 'zh-CN' }));
  assert.match(chinese, /> · 最高</);
  assert.match(chinese, /> · 启用</);
  assert.doesNotMatch(chinese, />max<|>enabled</);
  assert.match(html, /aria-label="Copy name"/);
  assert.match(html, /aria-label="Copy ID"/);
  assert.match(html, /agent-tasks__identity/);
  assert.match(html, /agent-tasks__model/);
  const unavailable = renderToStaticMarkup(createElement(AgentPageInformation, {
    name: 'Child', sessionId: 'session:child', projection: {}, language: 'en-US',
  }));
  assert.match(unavailable, /Not provided/);
  assert.doesNotMatch(unavailable, /child-model|profile:child/);
});

test('selected subagent details render as Reader content instead of an overlay', async t => {
  const [{ AgentTasksPanel }] = await loadGuiModules(t, ['/src/components/local-agent/AgentTasksPanel.tsx']);
  const projection = { agentChildren: [{ agentSessionId: 'session:child', displayName: 'Reviewer', closed: false }], agentTasks: [], pendingAgentDecisions: [] };
  const html = renderToStaticMarkup(createElement(AgentTasksPanel, {
    projection, language: 'zh-CN', selectedSessionId: 'session:child', entryId: 'activity:child',
  }));
  assert.match(html, /<section\b[^>]*aria-label="子智能体"/);
  assert.doesNotMatch(html, /<strong>子智能体<\/strong>|关闭子智能体页面/, 'the Reader tab owns the title and close control');
  assert.match(html, /aria-label="子智能体信息"/);
  assert.match(html, /aria-label="返回子智能体列表"/);
  assert.match(html, /Reviewer/);
  assert.match(html, /session:child/);
  assert.doesNotMatch(html, /<dialog\b|role="dialog"/);
  assert.equal(renderToStaticMarkup(createElement(AgentTasksPanel, { projection, language: 'en-US' })), '');
});

test('sidebar entry, grouped list, detail back and selection cycle all reuse the subagents tab', async t => {
  const [{ AgentOverview, AgentOverviewList }, { AgentPageInformation }, { requestAgentOverview }, { READER_OPEN_EVENT, readerTargetKey }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentOverview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx',
    '/src/components/local-agent/agentNavigation.tsx', '/src/components/local-agent/readerState.ts',
  ]);
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = previousWindow; });
  const requests = [];
  window.addEventListener(READER_OPEN_EVENT, event => requests.push(event.detail));
  const projection = { sessionId: 'session:parent', agentTasks: [
    { agentSessionId: 'session:working', displayName: 'Worker', status: 'running', text: 'Inspect the source' },
    { agentSessionId: 'session:finished', displayName: 'Reviewer', status: 'completed', text: 'Review', result: { content: 'Review complete' } },
  ] };
  findReactElement(AgentOverview({ projection, language: 'en-US' }), node => node.type === 'button'
    && node.props['aria-label'] === 'View all subagents').props.onClick();
  const list = AgentOverviewList({ projection, language: 'en-US' });
  const html = renderToStaticMarkup(list);
  assert.match(html, /aria-label="Running"/);
  assert.match(html, /aria-label="Completed"/);
  assert.match(html, /Inspect the source/);
  assert.match(html, /Review complete/);
  const member = name => findReactElement(list, node => node.type === 'button'
    && renderToStaticMarkup(node).replace(/<[^>]*>/g, '').includes(name));
  member('Worker').props.onClick();
  function BackProbe() {
    const information = AgentPageInformation({ name: 'Worker', sessionId: 'session:working', projection: {}, language: 'en-US',
      onBack: () => requestAgentOverview(projection.sessionId) });
    findReactElement(information, node => node.type === 'button'
      && node.props['aria-label'] === 'Back to subagents').props.onClick();
    return information;
  }
  renderToStaticMarkup(createElement(BackProbe));
  member('Reviewer').props.onClick();
  assert.deepEqual(requests.map(request => request.target.agentSessionId), [undefined, 'session:working', undefined, 'session:finished']);
  assert.ok(requests.every(request => request.sessionId === projection.sessionId && request.target.parentSessionId === projection.sessionId));
  assert.equal(new Set(requests.map(request => readerTargetKey(request.target))).size, 1);
});
