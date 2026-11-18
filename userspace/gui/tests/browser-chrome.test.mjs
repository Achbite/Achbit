// TCR: .task-artifacts/browser-interaction-20261117/TCR.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

test('browser shortcuts select the DOM input before requesting native chrome focus', async t => {
  const [{ focusBrowserChromeInput }] = await loadGuiModules(t, ['/src/components/local-agent/BrowserChrome.tsx']);
  const order = [], errors = [];
  const input = { focus: () => order.push('dom-focus'), select: () => order.push('selection') };
  focusBrowserChromeInput(input, async () => { order.push('native-focus'); }, error => errors.push(error));
  assert.deepEqual(order, ['dom-focus', 'selection', 'native-focus']);
  focusBrowserChromeInput(null, async () => assert.fail('an unmounted input cannot take focus'), error => errors.push(error));
  focusBrowserChromeInput(input, async () => { throw Error('original focus failure'); }, error => errors.push(error));
  await Promise.resolve();
  assert.deepEqual(errors, ['Error: original focus failure']);
});

test('browser addresses normalize user navigation without turning text or unsupported schemes into requests', async t => {
  const [{ nativeNavigationInput }] = await loadGuiModules(t, ['/src/services/nativeBrowser.ts']);
  for (const [input, expected] of [
    [' https://example.com/path?q=1 ', { url: 'https://example.com/path?q=1' }],
    ['example.com', { url: 'https://example.com/' }],
    ['LOCALHOST/path', { url: 'http://localhost/path' }],
    ['localhost.example.com', { url: 'https://localhost.example.com/' }],
    ['127.example.com', { url: 'https://127.example.com/' }],
    ['localhost:5173/app', { url: 'http://localhost:5173/app' }],
    ['127.0.0.1:8080', { url: 'http://127.0.0.1:8080/' }],
    ['[::1]:5173', { url: 'http://[::1]:5173/' }],
    ['http://server.test:8080/', { url: 'http://server.test:8080/' }],
    ['/workspace/a b.html', { filePath: '/workspace/a b.html' }],
    ['file:///workspace/a%20b.html', { filePath: '/workspace/a b.html' }],
    ['C:\\work\\page.html', { filePath: 'C:\\work\\page.html' }],
  ]) assert.deepEqual(nativeNavigationInput(input), expected, input);
  for (const input of ['', 'two search words', 'https://', 'localhost:99999', 'file:///bad%escape']) {
    assert.throws(() => nativeNavigationInput(input), /browser_address_(invalid|empty)/, input);
  }
  for (const input of ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com', 'file://remote/page.html']) {
    assert.throws(() => nativeNavigationInput(input), /browser_address_scheme/, input);
  }
});

test('browser chrome consumes actual history capabilities and distinguishes stop from reload', async t => {
  const [{ BrowserChrome }] = await loadGuiModules(t, ['/src/components/local-agent/BrowserChrome.tsx']);
  const page = { previewId: 'preview:chrome', sessionId: 'session:chrome', kind: 'page', url: 'https://example.com/', status: 'ready',
    navigation: { title: 'Example', canGoBack: true, canGoForward: false }, viewport: { mode: 'adaptive' }, zoom: 1 };
  const actions = [];
  const render = value => {
    let tree;
    function Probe() { tree = BrowserChrome({ page: value, active: true, busy: false, language: 'en-US', reviewing: false,
      onAction: async input => { actions.push(input); return value; }, onError: error => assert.fail(error),
      onFind: async () => ({ found: false }), onEndFind: async () => {}, onFocusPage() {}, onFocusChrome: async () => {}, onClose: async () => {}, onExitReview() {} }); return tree; }
    return { html: renderToStaticMarkup(createElement(Probe)), tree };
  };
  const ready = render(page);
  const action = (tree, id) => findReactElement(tree, node => node.props['data-ui-action'] === `reader.browser.${id}`);
  assert.equal(action(ready.tree, 'back').props.disabled, false);
  assert.equal(action(ready.tree, 'forward').props.disabled, true);
  action(ready.tree, 'back').props.onClick();
  action(ready.tree, 'reload').props.onClick();
  const loading = render({ ...page, status: 'loading' });
  assert.match(loading.html, /Stop loading/); assert.doesNotMatch(loading.html, /aria-label="Reload page"/);
  action(loading.tree, 'stop').props.onClick();
  assert.deepEqual(actions, [{ action: 'back' }, { action: 'reload' }, { action: 'stop' }]);
  assert.match(ready.html, /Page address/); assert.match(ready.html, /Page tools/);
  assert.match(render({ ...page, status: 'stopped' }).html, /Loading stopped/);
});

test('browser presentation keeps a full address for editing and localizes only owned input errors', async t => {
  const [{ browserAddressLabel, browserAddressError, nextBrowserZoom }] = await loadGuiModules(t, ['/src/components/local-agent/BrowserChrome.tsx']);
  assert.equal(browserAddressLabel({ kind: 'page', url: 'file:///work/a%20b.html' }), 'a b.html');
  assert.equal(browserAddressLabel({ kind: 'page', url: 'https://example.com/route' }), 'https://example.com/route');
  assert.match(browserAddressError(Error('browser_address_invalid'), 'en-US'), /valid page address/);
  assert.match(browserAddressError(Error('browser_address_invalid'), 'zh-CN'), /有效/);
  assert.equal(browserAddressError(Error('original navigation failure'), 'zh-CN'), 'original navigation failure');
  assert.equal(nextBrowserZoom(1, 1), 1.1);
  assert.equal(nextBrowserZoom(1.1, -1), 1);
  assert.equal(nextBrowserZoom(0.25, -1), 0.25);
  assert.equal(nextBrowserZoom(3, 1), 3);
});
