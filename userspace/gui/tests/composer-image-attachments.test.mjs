import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

function capture(Component, props) {
  let view;
  function Probe() { view = Component(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return view;
}

test('the real composer previews pasted, selected and recovered images while retaining original attachment actions', async t => {
  const [{ ConversationComposer }, { ComposerImageAttachment }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationComposer.tsx', '/src/components/local-agent/ComposerImageAttachment.tsx']);
  const pasted = { inputId: 'image:paste', name: 'Paste.png', dataUrl: 'data:image/png;base64,cGFzdGU=', mediaType: 'image/png', byteLength: 5 };
  const image = { referenceId: 'reference:restored', workspaceId: 'input:archive', logicalPath: 'original/image.png',
    kind: 'file', displayName: 'Restored.png', mediaType: 'image/png', byteLength: 10 };
  const text = { ...image, referenceId: 'reference:text', logicalPath: 'notes.txt', displayName: 'Notes.txt', mediaType: 'text/plain' };
  let pastedImages = [pasted], paths = [{ path: '/chosen/Screenshot.PNG', kind: 'file' }, { path: '/chosen/report.pdf', kind: 'file' }, { path: '/chosen/folder', kind: 'directory' }];
  const calls = [], references = [image, text], before = structuredClone(references);
  const composer = { conversationKey: 'session:images', projection: { sessionId: 'session:images', queuedInputs: [], contextCompositions: [] },
    profiles: [], selectedProfileId: null, draft: 'Keep the message', pastedTexts: [], pastedImages, failedDrafts: [],
    pendingFilesystemPaths: paths, pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    recoveredContent: { filesystemReferences: references, guidanceReferences: [], restoredInputIds: ['command:old'] },
    canSend: true, showStopAction: false, textDecision: false, submitDraft: () => calls.push('send'),
    setPastedImages: update => { pastedImages = update(pastedImages); }, setPendingFilesystemPaths: update => { paths = update(paths); },
    removeRecoveredReference: id => calls.push(['remove', id]) };
  const tree = capture(ConversationComposer, { composer, language: 'zh-CN', uiActionError: null, onDismissUiActionError() {}, onEditBrowserReview() {} });
  const tile = id => findReactElement(tree, node => node.type === ComposerImageAttachment && node.props.attachmentId === id);
  const pasteTile = tile(pasted.inputId), restoredTile = tile(image.referenceId), fileTile = tile('file:/chosen/Screenshot.PNG');
  assert.deepEqual(pasteTile.props.source, { dataUrl: pasted.dataUrl });
  assert.deepEqual(restoredTile.props.source, { sessionId: 'session:images', workspaceId: image.workspaceId, logicalPath: image.logicalPath });
  assert.deepEqual(fileTile.props.source, { path: '/chosen/Screenshot.PNG' });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /data-preview-state="ready"/);
  assert.match(html, /Notes\.txt/);
  assert.match(html, /report\.pdf/);
  const directory = findReactElement(tree, node => node.props['data-attachment-id'] === 'directory:/chosen/folder');
  assert.equal(directory.type, 'span');
  assert.match(renderToStaticMarkup(directory), /目录 · folder/);
  assert.deepEqual(calls, [], 'rendering previews neither sends nor removes an attachment');
  pasteTile.props.onRemove();
  fileTile.props.onRemove();
  restoredTile.props.onRemove();
  assert.deepEqual(pastedImages, []);
  assert.deepEqual(paths.map(item => item.path), ['/chosen/report.pdf', '/chosen/folder']);
  assert.deepEqual(calls, [['remove', image.referenceId]]);
  assert.deepEqual(references, before, 'recovered handles and history are not rewritten for thumbnails');
});

test('thumbnail viewing and removal are independent accessible controls using the shared viewer', async t => {
  const [{ ComposerImageAttachment }, { ImageReview }] = await loadGuiModules(t, [
    '/src/components/local-agent/ComposerImageAttachment.tsx', '/src/components/local-agent/ImageReview.tsx']);
  let removed = 0;
  const props = { attachmentId: 'image:one', name: 'Screenshot.png', source: { dataUrl: 'data:image/png;base64,aW1n' }, language: 'en-US',
    onRemove: () => removed++, openIdentity: { 'data-ui-action': 'composer.controls.open-image' },
    removeIdentity: { 'data-ui-action': 'composer.controls.remove-image' } };
  const tree = capture(ComposerImageAttachment, props);
  const viewer = findReactElement(tree, node => node.type === ImageReview);
  assert.equal(viewer.props.source, props.source.dataUrl);
  assert.equal(viewer.props.alt, props.name);
  assert.equal(viewer.props.title, props.name);
  const remove = findReactElement(tree, node => node.props['data-ui-action'] === 'composer.controls.remove-image');
  assert.match(remove.props['aria-label'], /Screenshot\.png/);
  assert.equal(removed, 0);
  remove.props.onClick();
  assert.equal(removed, 1);
  const loading = renderToStaticMarkup(createElement(ComposerImageAttachment, { ...props, source: { path: '/chosen/Screenshot.png' } }));
  assert.match(loading, /data-preview-state="loading"/);
  assert.match(loading, /data-ui-action="composer.controls.open-image"[^>]*disabled=""/);
  assert.match(loading, /data-ui-action="composer.controls.remove-image"/);
});

test('preview reads preserve route, session identity, cancellation and object URL ownership', async t => {
  const [{ loadComposerImage }] = await loadGuiModules(t, ['/src/components/local-agent/ComposerImageAttachment.tsx']);
  const calls = [], urls = [], revoked = [];
  const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = blob => { const url = `blob:preview-${urls.length}`; urls.push({ url, blob }); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; });
  const bytes = new Blob(['image'], { type: 'image/png' }), signal = new AbortController().signal;
  const host = { readLocalFile: async path => { calls.push(['file', path]); return bytes; }, resources: {
    readResourceBlob: async (...args) => { calls.push(['resource', ...args]); return bytes; },
  } };
  assert.deepEqual(await loadComposerImage({ dataUrl: 'data:existing' }, host, signal), { url: 'data:existing' });
  assert.deepEqual(calls, []);
  const local = await loadComposerImage({ path: '/selected/image.png' }, host, signal);
  assert.deepEqual(calls[0], ['file', '/selected/image.png']);
  local.release();
  const retained = await loadComposerImage({ sessionId: 'session:owner', workspaceId: 'input:archive', logicalPath: 'snapshot.png' }, host, signal);
  assert.deepEqual(calls[1], ['resource', 'session:owner', { workspaceId: 'input:archive', logicalPath: 'snapshot.png' }, 'image', signal]);
  retained.release();
  assert.deepEqual(revoked, urls.map(item => item.url));
  const error = new Error('original_resource_unavailable');
  await assert.rejects(loadComposerImage({ sessionId: 'session:owner', workspaceId: 'input:archive', logicalPath: 'missing.png' },
    { resources: { readResourceBlob: async () => { throw error; } } }, signal), value => value === error);
  const cancelled = new AbortController();
  await assert.rejects(loadComposerImage({ path: '/selected/slow.png' }, { readLocalFile: async () => { cancelled.abort(); return bytes; } }, cancelled.signal),
    value => value.name === 'AbortError');
  assert.equal(urls.length, 2, 'failed or cancelled reads never acquire object URLs');
});
