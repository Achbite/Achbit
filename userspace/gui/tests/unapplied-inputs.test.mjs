import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

const reference = { referenceId: 'reference:retained', workspaceId: 'workspace:source', logicalPath: 'notes.txt',
  displayName: 'notes.txt', kind: 'file', mediaType: 'text/plain', byteLength: 12 };
const history = { commandId: 'command:retained', messageId: 'message:retained', runId: 'run:ended', status: 'notApplied',
  text: 'Keep this unapplied text\nwith its original line break.', filesystemReferences: [reference],
  pluginSelections: [{ selectionId: 'selection:one', uri: 'plugin://retained@local', label: 'Retained tool' }], sequence: 2, createdAt: '2026-11-05T00:00:00Z' };
const waiting = { ...history, commandId: 'command:waiting', messageId: 'message:waiting', runId: 'run:current', status: 'queued',
  text: 'This input is still waiting', filesystemReferences: [], pluginSelections: [] };

test('only active queued inputs occupy the real composer; terminal evidence is not deleted', async t => {
  const [{ ConversationComposer }] = await loadGuiModules(t, ['/src/components/local-agent/ConversationComposer.tsx']);
  const inputs = [history, waiting], before = structuredClone(inputs);
  const calls = [];
  let view;
  const composer = { conversationKey: 'session:queue', projection: { queuedInputs: inputs, contextCompositions: [] },
    recoveredContent: { filesystemReferences: [], guidanceReferences: [], restoredInputIds: [] },
    profiles: [], selectedProfileId: null, draft: 'New draft', pastedTexts: [], pastedImages: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    unappliedRecovery: { canUndo: true, undo: () => calls.push('undo') },
    canSend: true, showStopAction: false, textDecision: false, submitDraft: () => calls.push('send'), cancelRun: () => calls.push('stop') };
  function Probe() { view = ConversationComposer({ language: 'zh-CN', composer, uiActionError: null, onDismissUiActionError() {}, onEditBrowserReview() {} }); return view; }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.match(html, /This input is still waiting/);
  assert.doesNotMatch(html, /Keep this unapplied text|未加入本轮/);
  assert.match(html, />New draft<\/textarea>/);
  assert.deepEqual(inputs, before, 'rendering must not mutate the shared Session projection');
  assert.deepEqual(calls, []);
  const send = findReactElement(view, node => node.type === 'button' && node.props['data-ui-action'] === 'composer.controls.submit');
  send.props.onClick(); assert.deepEqual(calls, ['send']);
  assert.match(html, /撤销恢复/);
  findReactElement(view, node => node.props['data-ui-action'] === 'composer.controls.undo-recovery').props.onClick();
  assert.deepEqual(calls, ['send', 'undo'], 'Undo stays in Composer when recovered reminders are removed');
});

test('unapplied history remains collapsed and preserves text, attachments, tools and original actions', async t => {
  const [{ UnappliedInputs }] = await loadGuiModules(t, ['/src/components/local-agent/UnappliedInputs.tsx']);
  const calls = []; let view;
  function Probe() { view = UnappliedInputs({ sessionId: 'session:queue', inputs: [history, waiting], language: 'zh-CN', copiedId: null,
    onCopy: (id, text) => calls.push(['copy', id, text]), onOpenReference: value => calls.push(['open', value]) }); return view; }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal(view.type, 'details'); assert.equal(view.props.open, undefined);
  assert.match(html, /未加入任务的消息/); assert.match(html, /Keep this unapplied text\nwith its original line break\./);
  assert.match(html, /notes.txt/); assert.match(html, /Retained tool/);
  assert.doesNotMatch(html, /This input is still waiting/);
  assert.deepEqual(calls, [], 'presentation never resubmits an abandoned input');
  findReactElement(view, node => node.props['data-ui-action'] === 'conversation.unapplied-inputs.copy').props.onClick();
  findReactElement(view, node => node.props['data-ui-action'] === 'conversation.unapplied-inputs.open-reference').props.onClick();
  assert.deepEqual(calls, [['copy', `unapplied:${history.commandId}`, history.text], ['open', reference]]);
  const empty = renderToStaticMarkup(createElement(UnappliedInputs, { sessionId: 'session:queue', inputs: [waiting], language: 'en-US', copiedId: null, onCopy() {}, onOpenReference() {} }));
  assert.equal(empty, '');
});

test('successful restoration removes only its reminder while receipts and original history remain distinct', async t => {
  const [{ UnappliedInputs }] = await loadGuiModules(t, ['/src/components/local-agent/UnappliedInputs.tsx']);
  const second = { ...history, commandId: 'command:second', text: 'Second unapplied input' };
  const inputs = [history, second], before = structuredClone(inputs);
  const props = { sessionId: 'session:queue', inputs, language: 'zh-CN', copiedId: null, onCopy() {}, onOpenReference() {} };
  const recovery = { restoredIds: [history.commandId], resubmittedIds: [], inDecision: false, canUndo: true,
    restore() {}, undo() {} };
  let view;
  function Probe() { view = UnappliedInputs({ ...props, recovery }); return view; }
  const partial = renderToStaticMarkup(createElement(Probe));
  assert.match(partial, /1 条消息未处理/);
  assert.doesNotMatch(partial, /已恢复到草稿|Keep this unapplied text/);
  assert.match(partial, /Second unapplied input/);
  const undone = renderToStaticMarkup(createElement(UnappliedInputs, { ...props, recovery: { ...recovery, restoredIds: [] } }));
  assert.match(undone, /2 条消息未处理/);
  assert.match(undone, /Keep this unapplied text/);
  const drafts = renderToStaticMarkup(createElement(UnappliedInputs, { ...props,
    recovery: { ...recovery, restoredIds: inputs.map(item => item.commandId) } }));
  assert.equal(drafts, '', 'successful draft restoration removes all resolved reminders before a send receipt');
  const acknowledged = { ...recovery, restoredIds: [], resubmittedIds: inputs.map(item => item.commandId), canUndo: false };
  assert.equal(renderToStaticMarkup(createElement(UnappliedInputs, { ...props, recovery: acknowledged })), '');
  const repeated = { ...history, commandId: 'command:resubmission', text: 'Same task, new unprocessed submission' };
  const next = renderToStaticMarkup(createElement(UnappliedInputs, { ...props, inputs: [...inputs, repeated], recovery: acknowledged }));
  assert.match(next, /1 条消息未处理/);
  assert.match(next, /Same task, new unprocessed submission/);
  assert.doesNotMatch(next, /Second unapplied input/);
  assert.deepEqual(inputs, before);
});
