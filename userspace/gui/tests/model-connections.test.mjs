import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('connection creation follows authentication capability, independently of plan billing', async t => {
  const { ConnectionDetail, adapterCredentialKind } = await loadGuiModule(t, '/src/components/settings-center/sections/LlmSection.tsx');
  for (const [billing, methods, expected] of [
    ['metered', ['apiKey'], 'apiKey'], ['subscription', ['apiKey'], 'apiKey'],
    ['subscription', ['browser', 'deviceCode'], 'oauth'], ['metered', ['none'], 'none'],
  ]) {
    const adapter = { id: `test-${expected}`, name: 'Test service', billingModes: [billing], authMethods: methods,
      protocols: ['openaiCompatible'], defaultBaseUrl: 'https://example.test/v1', models: [], pricing: false, quota: false, source: 'builtin' };
    assert.equal(adapterCredentialKind(adapter), expected);
    const html = renderToStaticMarkup(createElement(ConnectionDetail, {
      adapters: [adapter], profiles: [], mode: billing, onMode() {}, async onSaved() {}, onBack() {},
    }));
    assert.equal(/type="password"/.test(html), expected === 'apiKey');
    assert.equal(/type="url"/.test(html), expected !== 'oauth');
    assert.equal(/创建并继续登录|Create and continue to sign in/.test(html), expected === 'oauth');
    assert.match(html, /list="connection-model-templates"/);
    assert.match(html, /aria-pressed="true"/);
    if (billing === 'subscription' && expected === 'apiKey') assert.match(html, /套餐 Key|Plan keys/);
  }
});

test('foreground sound is a discoverable persisted GUI preference and defaults to silent', async t => {
  const { DEFAULT_USER_SETTINGS } = await import('../../protocol/dist/index.js');
  const { SETTING_DEFINITIONS } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  assert.equal(DEFAULT_USER_SETTINGS['gui.completionSound.foreground'], false);
  const definition = SETTING_DEFINITIONS.find(value => value.key === 'gui.completionSound.foreground');
  assert.equal(definition.control, 'boolean');
  assert.equal(definition.group, 'gui');
});
