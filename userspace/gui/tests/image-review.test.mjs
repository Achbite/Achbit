import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule } from './gui-projection-contract.mjs';

test('image review keeps its native dialog and image source with explicit zoom and fit controls', async t => {
  const { ImageReview } = await loadGuiModule(t, '/src/components/local-agent/ImageReview.tsx');
  const calls = [];
  let view;
  function Probe() {
    view = ImageReview({ source: 'blob:loaded-image', alt: 'Rendered chart' });
    return view;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  const opener = findReactElement(view, node => node.type === 'button' && node.props['aria-label']?.includes('Rendered chart'));
  const dialog = findReactElement(view, node => node.type === 'dialog' && node.props['aria-label'] === 'Rendered chart');
  dialog.props.ref.current = { showModal: () => calls.push('open'), close: () => calls.push('close') };
  opener.props.onClick();
  findReactElement(dialog, node => node.type === 'button' && /^(Close image|关闭图片)$/.test(node.props.children)).props.onClick();
  assert.deepEqual(calls, ['open', 'close']);
  assert.equal((html.match(/src="blob:loaded-image"/g) ?? []).length, 2);
  assert.match(html, /<dialog[^>]+aria-label="Rendered chart"/);
  assert.equal(opener.props.disabled, false, 'loaded thumbnails remain clickable');
  assert.equal(findReactElement(dialog, node => node.type === 'button' && /^(Fit to window|适应窗口)$/.test(node.props.children)).props['aria-pressed'], true);
  for (const label of [/^(Zoom in|放大图片)$/, /^(Zoom out|缩小图片)$/]) {
    assert.equal(findReactElement(dialog, node => node.type === 'button' && label.test(node.props['aria-label'])).props.disabled, true,
      'zoom waits for the decoded image and visible viewport dimensions');
  }
});

test('artifact image card is a single viewer trigger and stays unavailable until its image is loaded', async t => {
  const { ImageReview } = await loadGuiModule(t, '/src/components/local-agent/ImageReview.tsx');
  const { ArtifactLinks } = await loadGuiModule(t, '/src/components/local-agent/ArtifactLinks.tsx');
  const props = { alt: 'result.png', className: 'deepcode-gui-output-item document-artifacts__item',
    children: [createElement('span', { key: 'thumbnail', className: 'document-artifacts__thumbnail' },
      createElement('img', { src: 'blob:artifact', alt: '' })), createElement('strong', { key: 'label' }, 'result.png')] };
  const html = renderToStaticMarkup(createElement(ImageReview, { ...props, source: 'blob:artifact' }));
  const item = html.slice(0, html.indexOf('<dialog'));
  assert.equal((item.match(/<button\b/g) ?? []).length, 1, 'thumbnail and label share one clickable image item');
  assert.match(item, /document-artifacts__item/);
  assert.match(item, /result\.png/);
  assert.doesNotMatch(item, /disabled=/);
  const loading = renderToStaticMarkup(createElement(ImageReview, props));
  assert.match(loading.slice(0, loading.indexOf('<dialog')), /disabled=""/);
  assert.doesNotMatch(loading.slice(loading.indexOf('<dialog')), /<img\b/);
  const artifact = renderToStaticMarkup(createElement(ArtifactLinks, { artifacts: [{
    artifactId: 'artifact:image', sessionId: 'session:image', label: 'output/result.png', createdAt: '2026-10-14T00:00:00Z',
    contentMode: 'fixed', contentType: 'image/png',
  }], onOpen: async () => {} }));
  assert.match(artifact, /<dialog[^>]+aria-label="result.png"/, 'the actual fixed-image output entry mounts the shared viewer');
  assert.equal((artifact.slice(0, artifact.indexOf('<dialog')).match(/<button\b/g) ?? []).length, 1);
});
