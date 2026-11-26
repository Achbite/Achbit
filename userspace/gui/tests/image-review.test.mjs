import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule } from './gui-projection-contract.mjs';

test('closed thumbnails mount no full image or modal controls; the open viewer uses the same source', async t => {
  const { ImageReview } = await loadGuiModule(t, '/src/components/local-agent/ImageReview.tsx');
  const props = { source: 'blob:loaded-image', alt: 'Rendered chart' };
  const thumbnail = renderToStaticMarkup(createElement(ImageReview, props));
  assert.equal((thumbnail.match(/src="blob:loaded-image"/g) ?? []).length, 1);
  assert.match(thumbnail, /<dialog[^>]+aria-label="Rendered chart"[^>]*><\/dialog>/);
  assert.doesNotMatch(thumbnail, /disabled=""/);
  assert.match(thumbnail, /aria-label="[^"]*Rendered chart"/);
});

test('open viewers retain fit, zoom, close and native dismissal for intrinsic and decoded images', async t => {
  const { ImageReviewDialog } = await loadGuiModule(t, '/src/components/local-agent/ImageReview.tsx');
  const props = { source: 'blob:loaded-image', alt: 'Rendered chart' };
  for (const intrinsicSize of [undefined, { width: 500, height: 4200 }]) {
    const calls = [];
    let dialog;
    function Probe() { dialog = ImageReviewDialog({ ...props, open: true, intrinsicSize, onClose: () => calls.push('closed') }); return dialog; }
    const html = renderToStaticMarkup(createElement(Probe));
    assert.match(html, /<dialog[^>]+aria-label="Rendered chart"/);
    assert.equal((html.match(/src="blob:loaded-image"/g) ?? []).length, 1);
    const element = { close: () => calls.push('close') };
    dialog.props.ref.current = element;
    const button = label => findReactElement(dialog, node => node.type === 'button' && label.test(node.props['aria-label'] ?? node.props.children));
    const fit = [...html.matchAll(/<button\b([^>]*)>(?:Fit to window|适应窗口)<\/button>/gu)];
    assert.equal(fit.length, 1, 'one native fit action');
    assert.match(fit[0][1], /\baria-pressed="true"/u);
    for (const label of [/^(Zoom in|放大图片)$/, /^(Zoom out|缩小图片)$/]) assert.equal(button(label).props.disabled, true);
    dialog.props.onClick({ target: {}, currentTarget: element });
    assert.deepEqual(calls, [], 'content clicks do not dismiss');
    button(/^(Close image|关闭图片)$/).props.onClick();
    dialog.props.onClick({ target: element, currentTarget: element });
    dialog.props.onCancel({ stopPropagation: () => calls.push('cancel') });
    dialog.props.onClose();
    assert.deepEqual(calls, ['close', 'close', 'cancel', 'closed']);
  }
});

test('artifact image card is a single viewer trigger and stays unavailable until its image is loaded', async t => {
  const { ImageReview } = await loadGuiModule(t, '/src/components/local-agent/ImageReview.tsx');
  const { ArtifactLinks } = await loadGuiModule(t, '/src/components/local-agent/ArtifactLinks.tsx');
  const props = { alt: 'result.png', className: 'achbit-gui-output-item document-artifacts__item',
    children: [createElement('span', { key: 'thumbnail', className: 'document-artifacts__thumbnail' },
      createElement('img', { src: 'blob:artifact', alt: '' })), createElement('strong', { key: 'label' }, 'result.png')] };
  const html = renderToStaticMarkup(createElement(ImageReview, { ...props, source: 'blob:artifact' }));
  const item = html;
  assert.equal((item.match(/<button\b/g) ?? []).length, 1, 'thumbnail and label share one clickable image item');
  assert.match(item, /document-artifacts__item/);
  assert.match(item, /result\.png/);
  assert.doesNotMatch(item, /disabled=/);
  const loading = renderToStaticMarkup(createElement(ImageReview, props));
  assert.match(loading, /disabled=""/);
  assert.match(loading, /<dialog[^>]*><\/dialog>/);
  const artifact = renderToStaticMarkup(createElement(ArtifactLinks, { artifacts: [{
    artifactId: 'artifact:image', sessionId: 'session:image', label: 'output/result.png', createdAt: '2026-10-14T00:00:00Z',
    contentMode: 'fixed', contentType: 'image/png',
  }], onOpen: async () => {} }));
  assert.match(artifact, /aria-label="[^"]*result.png"/);
  assert.match(artifact, /<dialog[^>]+aria-label="result.png"[^>]*><\/dialog>/, 'the output owns an empty native dialog until opened');
  assert.equal((artifact.match(/<button\b/g) ?? []).length, 1);
});
