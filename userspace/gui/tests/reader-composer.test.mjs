import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

function draftComposer(overrides = {}) {
  return {
    conversationKey: 'session:reader-input', draft: '保留草稿\n第二行',
    pendingApproval: null, pendingPlan: null, pendingInteraction: null,
    pendingFilesystemPaths: [], pastedTexts: [], pastedImages: [], failedDrafts: [],
    pluginSelections: [], profiles: [], filteredPlugins: [], commandSuggestions: [],
    recoveredContent: { filesystemReferences: [], guidanceReferences: [], restoredInputIds: [] },
    textareaRef: { current: null }, canSend: true, showStopAction: false,
    submitDraft: async () => {}, ...overrides,
  };
}

function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

async function setup(t) {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ ConversationComposer }] = await loadGuiModules(t, ['/src/components/local-agent/ConversationComposer.tsx']);
  return (composer, readerExpanded = true, changeBar) => capture(ConversationComposer, {
    language: 'zh-CN', composer, readerExpanded, changeBar, uiActionError: null,
    onDismissUiActionError() {}, onEditBrowserReview() {},
  });
}

test('expanded Reader starts with one editable input and exposes an accessible expansion control', async t => {
  const render = await setup(t), calls = [];
  const composer = draftComposer({ submitDraft: async () => calls.push('submit') });
  const tree = render(composer);
  const input = findReactElement(tree, node => node.type === 'textarea');
  const toggle = findReactElement(tree, node => node.props['aria-label'] === '展开输入框');
  assert.equal(input.props.value, composer.draft);
  assert.equal(input.props.rows, 1);
  assert.equal(input.props.wrap, 'off');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(toggle.props['aria-controls'], input.props.id);
  assert.deepEqual(calls, [], 'rendering does not send or change the draft');
  await findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.submit').props.onClick();
  assert.deepEqual(calls, ['submit'], 'the compact input reuses the existing submit route');
  assert.equal(input.props.value, '保留草稿\n第二行');
});

test('Reader disclosure and file-change entry coexist without entering the editable surface', async t => {
  const render = await setup(t), calls = [];
  const changeBar = createElement('button', { 'aria-label': '查看修改文件' }, '已修改 2 个文件');
  const composer = draftComposer({ submitDraft: async () => calls.push('submit') });
  const tree = render(composer, true, changeBar);
  const accessories = findReactElement(tree, node => node.props.className === 'conversation-change-dock');
  const input = findReactElement(tree, node => node.type === 'textarea');
  const toggle = findReactElement(accessories, node => node.props['data-ui-action'] === 'composer.controls.toggle-expanded');
  assert.equal(findReactElement(accessories, node => node.props['aria-label'] === '查看修改文件'), changeBar);
  assert.equal(toggle.props['aria-controls'], input.props.id);
  assert.equal(input.props.value, composer.draft);
  assert.deepEqual(calls, [], 'accessory rendering never submits a message');
  await findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.submit').props.onClick();
  assert.deepEqual(calls, ['submit']);
});

test('ordinary conversation input keeps its full presentation and existing stop action', async t => {
  const render = await setup(t), calls = [];
  const composer = draftComposer({ showStopAction: true, cancelRun: async () => calls.push('stop') });
  const tree = render(composer, false);
  const input = findReactElement(tree, node => node.type === 'textarea');
  assert.equal(input.props.rows, 3);
  assert.equal(input.props.wrap, 'soft');
  assert.doesNotMatch(renderToStaticMarkup(tree), /展开输入框|收起输入框/);
  await findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.stop').props.onClick();
  assert.deepEqual(calls, ['stop']);
});

test('Reader keeps attachments, editing and Plan decisions in their full existing views', async t => {
  const render = await setup(t);
  for (const overrides of [
    { pendingFilesystemPaths: [{ kind: 'file', path: '/workspace/保留附件.md' }] },
    { editingMessage: { message: { filesystemReferences: [] } } },
    { pendingPlan: { planId: 'plan:reader', runId: 'run:reader', revision: 1, status: 'pending',
      title: '确认计划', steps: [], mutationManifest: [] }, textDecision: true },
  ]) {
    const composer = draftComposer(overrides), tree = render(composer), html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /展开输入框|收起输入框/);
    assert.equal(findReactElement(tree, node => node.type === 'textarea').props.value, composer.draft);
    if (overrides.pendingFilesystemPaths) assert.ok(html.includes('保留附件.md'));
    if (overrides.editingMessage) assert.match(html, /重新生成/);
    if (overrides.pendingPlan) assert.match(html, /确认执行|Confirm/);
  }
});
