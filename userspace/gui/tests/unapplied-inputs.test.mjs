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
    profiles: [], selectedProfileId: null, draft: 'New draft', pastedTexts: [], pastedImages: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
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
