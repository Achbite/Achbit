import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

test('HTML viewport retains desktop geometry across split and expanded Reader areas', async t => {
  const [{ fitBrowserViewport, DEFAULT_BROWSER_VIEWPORT }, { HtmlDocumentFrame }] = await loadGuiModules(t, [
    '/src/components/local-agent/browserViewport.ts', '/src/components/local-agent/HtmlDocumentFrame.tsx',
  ]);
  for (const width of [480, 1030, 1500]) {
    const layout = fitBrowserViewport(DEFAULT_BROWSER_VIEWPORT, width, 820);
    assert.equal(layout.width, 1280); assert.equal(layout.height, 800);
    assert.ok(layout.width * layout.scale <= width);
    assert.ok(layout.height * layout.scale <= 820);
  }
  assert.deepEqual(fitBrowserViewport({ mode: 'adaptive' }, 480, 820), { width: 480, height: 820, scale: 1, left: 0 });
  const html = renderToStaticMarkup(createElement(HtmlDocumentFrame, { title: 'sample', content: '<p>content</p>', viewport: DEFAULT_BROWSER_VIEWPORT }));
  assert.match(html, /sandbox=""/); assert.match(html, /srcDoc="&lt;p&gt;content&lt;\/p&gt;"/i);
  assert.match(html, /width:1280px;height:800px/);
});

test('viewport selector preserves explicit dimensions and exposes adaptive mode', async t => {
  const [{ BrowserViewportControl }] = await loadGuiModules(t, ['/src/components/local-agent/BrowserViewportControl.tsx']);
  const changes = [], value = { mode: 'fixed', width: 1440, height: 900 };
  const tree = BrowserViewportControl({ value, language: 'zh-CN', onChange: next => changes.push(next) });
  const select = findReactElement(tree, node => node.type === 'select');
  select.props.onChange({ target: { value: 'adaptive' } });
  select.props.onChange({ target: { value: 'fixed' } });
  assert.deepEqual(changes, [{ mode: 'adaptive' }, value]);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /1440 × 900/); assert.match(html, /自适应/); assert.match(html, /页面尺寸/);
});
