import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

const annotation = { id: 'annotation:one', mode: 'element', url: 'https://example.test', title: 'Page', selector: '#title',
  text: 'Selected text', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  comment: 'Keep this.\n\n> This comment is not part of the evidence JSON.' };
const image = { referenceId: 'image:one', workspaceId: 'input:image', logicalPath: 'capture.png', displayName: 'capture.png',
  kind: 'file', mediaType: 'image/png', byteLength: 20 };
const note = { referenceId: 'note:one', workspaceId: 'input:note', logicalPath: 'note.txt', displayName: '浏览器批注',
  kind: 'file', mediaType: 'text/plain', source: 'pastedText', byteLength: 100 };

function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

test('annotation capture evidence keeps user comments separate and names only a unique attached image', async t => {
  const [{ formatBrowserAnnotation, browserAnnotationCapture }] = await loadGuiModules(t, ['/src/components/local-agent/browserReview.ts']);
  for (const chinese of [true, false]) {
    const text = formatBrowserAnnotation(annotation, 'preview:one', chinese, '/private/captures/capture.png');
    assert.doesNotMatch(text, /\/private\/captures/);
    assert.ok(text.endsWith(annotation.comment));
    assert.equal(browserAnnotationCapture(text, [image]), image);
    assert.equal(browserAnnotationCapture(text, [{ ...image, logicalPath: 'imported/capture.png' }]).workspaceId, image.workspaceId);
    assert.equal(browserAnnotationCapture(formatBrowserAnnotation(annotation, 'preview:one', chinese), []), undefined,
      'capture is optional when the native Host has no screenshot capability');
    assert.throws(() => browserAnnotationCapture(text, []), /annotation_capture_reference_missing/);
    const duplicates = [1, 2].map(id => ({ ...image, referenceId: `duplicate:${id}`, logicalPath: `${id}/capture.png` }));
    assert.throws(() => browserAnnotationCapture(text, duplicates), /annotation_capture_reference_ambiguous/);
    assert.equal(browserAnnotationCapture(text, [image, ...duplicates]), image, 'exact logical path takes precedence');
  }
  assert.throws(() => browserAnnotationCapture('Browser annotation\n\n> invalid', [image]), SyntaxError);
});

test('sent image and annotation previews use retained resource handles and preserve errors and cancellation', async t => {
  const [{ loadMessageAttachmentImage }, { formatBrowserAnnotation }] = await loadGuiModules(t, [
    '/src/components/local-agent/MessageAttachments.tsx', '/src/components/local-agent/browserReview.ts']);
  const calls = [], revoked = [], urls = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => { const url = `blob:attachment-${urls.length}`; urls.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; });
  let content = formatBrowserAnnotation(annotation, 'preview:one', true, '/captures/capture.png');
  const host = { resources: {
    readResourceReference: async (...args) => { calls.push(['text', ...args]); return { content }; },
    readResourceBlob: async (...args) => { calls.push(['image', ...args]); return new Blob(['image'], { type: 'image/png' }); },
  } };
  const signal = new AbortController().signal;
  const loaded = await loadMessageAttachmentImage('session:one', note, [note, image], host, signal);
  assert.deepEqual(calls, [
    ['text', 'session:one', { workspaceId: note.workspaceId, logicalPath: note.logicalPath }, signal],
    ['image', 'session:one', { workspaceId: image.workspaceId, logicalPath: image.logicalPath }, 'image', signal],
  ]);
  assert.equal(loaded.kind, 'image'); loaded.release();
  content = formatBrowserAnnotation(annotation, 'preview:one', true);
  assert.deepEqual(await loadMessageAttachmentImage('session:one', note, [note], host, signal), { kind: 'text' });
  const error = new Error('original_resource_failure');
  await assert.rejects(loadMessageAttachmentImage('session:one', image, [image], {
    resources: { readResourceBlob: async () => { throw error; } },
  }, signal), value => value === error);
  const controller = new AbortController();
  await assert.rejects(loadMessageAttachmentImage('session:one', note, [note, image], {
    resources: { readResourceReference: async () => { controller.abort(); return { content }; } },
  }, controller.signal), value => value.name === 'AbortError');
  assert.deepEqual(urls, revoked);
  assert.equal(urls.length, 1, 'absent, failed and cancelled captures acquire no object URLs');
});

test('a retained thumbnail failure belongs to its reference, with the original reason and an explicit retry on remount', async t => {
  const [{ MessageAttachments }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/MessageAttachments.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx']);
  const sessionId = 'session:lost', reason = 'canonicalize fixture/capture.png: No such file or directory (os error 2)';
  const state = new Map([[`attachment:${image.referenceId}:failure`, { key: JSON.stringify([sessionId, image, null]), reason }]]);
  const html = renderToStaticMarkup(createElement(ConversationVirtualRow, { rowKey: 'input', virtualizer: { layout: () => ({ state }) }, eager: true,
    children: () => createElement(MessageAttachments, { sessionId, references: [image], language: 'en-US', identity: ref => ({ 'data-ui-ref': ref.referenceId }),
      onError: assert.fail, onOpen: assert.fail }) }));
  assert.match(html, /capture\.png · Preview unavailable/); assert.ok(html.includes(reason)); assert.match(html, /Retry preview/);
  assert.match(html, /data-ui-ref="image:one"/); assert.doesNotMatch(html, /role="alert"|<img/);
});

test('compact sent attachments keep localized annotation labels, original file actions and viewer identities', async t => {
  const [{ MessageAttachments }, { ImageReview }] = await loadGuiModules(t, [
    '/src/components/local-agent/MessageAttachments.tsx', '/src/components/local-agent/ImageReview.tsx']);
  const file = { ...note, referenceId: 'file:notes', displayName: 'Notes.txt' };
  const directory = { referenceId: 'directory:one', workspaceId: 'project:one', logicalPath: 'docs', displayName: 'Docs', kind: 'directory' };
  const refs = [image, note, file, directory], original = structuredClone(refs), opened = [], errors = [];
  for (const language of ['zh-CN', 'en-US']) {
    const tree = MessageAttachments({ sessionId: 'session:one', references: refs, language,
      identity: reference => ({ 'data-ui-action': 'conversation.references.open', 'data-ui-target': reference.referenceId }),
      onOpen: async ref => { assert.ok(refs.includes(ref)); opened.push([ref.workspaceId, ref.logicalPath]); }, onError: error => errors.push(error) });
    const preview = findReactElement(tree, node => node.props.reference === note);
    assert.equal(preview.props.label, language === 'zh-CN' ? '标注 1' : 'Annotation 1');
    const viewer = capture(preview.type, preview.props);
    assert.equal(viewer.type, ImageReview);
    assert.equal(viewer.props.triggerIdentity['data-ui-target'], note.referenceId);
    assert.equal(viewer.props.className, 'local-agent__message-note');
    assert.equal(viewer.props.source, undefined, 'no capture is invented while the resource read is pending');
    const html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /<textarea|commentary/);
    assert.match(html, /Notes.txt/);
    assert.match(html, /TXT/);
    await findReactElement(tree, node => node.props.openIdentity?.['data-ui-target'] === directory.referenceId).props.onClick();
    await findReactElement(tree, node => node.props.openIdentity?.['data-ui-target'] === file.referenceId).props.onClick();
  }
  assert.deepEqual(opened, [['project:one', 'docs'], ['input:note', 'note.txt'], ['project:one', 'docs'], ['input:note', 'note.txt']]);
  assert.deepEqual(errors, []);
  assert.deepEqual(refs, original, 'presentation never rewrites the message resource identities');
});
