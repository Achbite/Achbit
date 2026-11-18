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
  return (composer, readerExpanded = true, changeBar, conversationBodyRef) => capture(ConversationComposer, {
    language: 'zh-CN', composer, readerExpanded, changeBar, conversationBodyRef, uiActionError: null,
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

test('the mounted composer connects and releases its own transcript boundary measurement', async t => {
  const render = await setup(t);
  const conversationBodyRef = { current: null };
  const tree = render(draftComposer(), false, undefined, conversationBodyRef);
  const footer = findReactElement(tree, node => node.type === 'footer');
  const previous = globalThis.ResizeObserver;
  let observed = 0, disconnected = 0;
  globalThis.ResizeObserver = class {
    observe() { observed++; }
    disconnect() { disconnected++; }
  };
  t.after(() => { globalThis.ResizeObserver = previous; });
  const properties = new Map();
  const viewport = { clientHeight: 400, getBoundingClientRect: () => ({ bottom: 400 }), style: {
    getPropertyValue: name => properties.get(name), setProperty: (name, value) => properties.set(name, value),
    removeProperty: name => properties.delete(name),
  } };
  conversationBodyRef.current = { parentElement: viewport };
  const shell = { closest: () => null,
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 448 }) }) };
  footer.props.ref(shell);
  assert.equal(properties.get('--conversation-composer-overlap'), '48px');
  assert.equal(observed, 3);
  footer.props.ref(null);
  assert.equal(disconnected, 1);
  assert.equal(properties.size, 0);
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

test('Reader keeps message editing and Plan decisions in their full existing views', async t => {
  const render = await setup(t);
  for (const overrides of [
    { editingMessage: { message: { filesystemReferences: [] } } },
    { pendingPlan: { planId: 'plan:reader', runId: 'run:reader', revision: 1, status: 'pending',
      title: '确认计划', steps: [], mutationManifest: [] }, textDecision: true },
  ]) {
    const composer = draftComposer(overrides), tree = render(composer), html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /展开输入框|收起输入框/);
    assert.equal(findReactElement(tree, node => node.type === 'textarea').props.value, composer.draft);
    if (overrides.editingMessage) assert.match(html, /重新生成/);
    if (overrides.pendingPlan) assert.match(html, /确认执行|Confirm/);
  }
});

test('Reader attachment summary preserves the one-line draft, attachment actions and normal conversation view', async t => {
  const render = await setup(t), sent = [], removed = [];
  const composer = draftComposer({ pendingFilesystemPaths: [{ kind: 'file', path: '/workspace/保留附件.md' }],
    setPendingFilesystemPaths: update => removed.push(update(composer.pendingFilesystemPaths)),
    submitDraft: async () => sent.push(composer.draft) });
  const tree = render(composer);
  const input = findReactElement(tree, node => node.type === 'textarea');
  const summary = findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.attachment-summary');
  const rail = findReactElement(tree, node => node.props.id === summary.props['aria-controls']);
  assert.equal(input.props.rows, 1);
  assert.equal(input.props.wrap, 'off');
  assert.equal(input.props.value, composer.draft);
  assert.equal(summary.props['aria-expanded'], false);
  assert.equal(summary.props['aria-label'], '查看 1 个附件');
  assert.match(renderToStaticMarkup(rail), /保留附件.md/);
  findReactElement(rail, node => node.props['aria-label'] === '移除 保留附件.md').props.onClick();
  assert.deepEqual(removed, [[]], 'the summary keeps the original removal route');
  await findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.submit').props.onClick();
  assert.deepEqual(sent, [composer.draft]);
  const full = render(composer, false);
  assert.equal(findReactElement(full, node => node.type === 'textarea').props.rows, 3);
  assert.equal(findReactElement(full, node => node.type === 'textarea').props.value, composer.draft);
  assert.match(renderToStaticMarkup(full), /保留附件.md/);
  assert.doesNotMatch(renderToStaticMarkup(full), /composer.controls.attachment-summary/);
});

test('Reader counts an annotation and its capture as one visible item without losing the capture', async t => {
  const render = await setup(t);
  const composer = draftComposer({ pendingFilesystemPaths: [{ kind: 'file', path: '/captures/one.png' }],
    pastedTexts: [{ inputId: 'annotation:one', text: '浏览器批注', browserReview: { screenshot: '/captures/one.png',
      annotation: { id: 'note:one', title: '页面', url: 'https://example.test', comment: '保留' } } }] });
  const tree = render(composer);
  const summary = findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.attachment-summary');
  assert.match(renderToStaticMarkup(summary), /标注 1/);
  assert.equal(summary.props['aria-label'], '查看 1 个附件');
  assert.equal(findReactElement(tree, node => node.type === 'textarea').props.rows, 1);
  assert.deepEqual(composer.pendingFilesystemPaths, [{ kind: 'file', path: '/captures/one.png' }]);
});
