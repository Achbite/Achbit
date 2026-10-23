import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_USER_SETTINGS } from '../../protocol/dist/index.js';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  return { html: renderToStaticMarkup(createElement(Probe)), tree };
}
function fieldKeys(root) {
  const keys = [];
  const visit = children => Children.forEach(children, node => {
    if (!isValidElement(node)) return;
    if (node.props.definition) keys.push(node.props.definition.key);
    visit(node.props.children);
  });
  visit(root); return keys;
}
function fixture(t, store, language) {
  const initial = store.getInitialState(), original = { ...initial };
  const settings = { ...DEFAULT_USER_SETTINGS, 'workbench.language': language };
  const state = { effectiveSettings: settings, sources: Object.fromEntries(Object.keys(settings).map(key => [key, 'user'])),
    environment: { os: 'macos' }, loading: false, errorMessage: null };
  Object.assign(initial, state); store.setState(state);
  t.after(() => Object.assign(initial, original));
  return initial;
}
const generalKeys = ['workbench.language', 'gui.navigationDensity', 'gui.showContextRail', 'gui.showReasoning', 'gui.completionSound.foreground',
  'gui.usageWidget.enabled', 'gui.usageWidget.visibility', 'gui.usageWidget.currency', 'gui.defaultFileOpen', 'gui.showRuntimeFiles'];
const agentKeys = ['agent.responseLanguage', 'agent.contextManagement.enabled', 'agent.contextManagement.thresholdTokens', 'agent.systemPrompt'];

test('completion sound controls and their search entry are available only in the desktop shell', async t => {
  const previous = globalThis.window;
  t.after(() => { globalThis.window = previous; });
  const [{ default: CompletionSoundSettings }, { settingsSearchDefinitions }] = await loadGuiModules(t, [
    '/src/components/settings-center/CompletionSoundSettings.tsx',
    '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
  ]);
  globalThis.window = { __TAURI__: { core: { invoke() {} } } };
  const desktop = capture(CompletionSoundSettings, { language: 'zh-CN' });
  assert.match(desktop.html, /试听/); assert.match(desktop.html, /选择音频/);
  assert.match(desktop.html, /type="file"/);
  assert.doesNotMatch(desktop.html, /<h3|<hr/, 'audio controls preserve the flat General page');
  assert.equal(settingsSearchDefinitions('zh-CN', 'macos').filter(x => x.id === 'gui.completionSound').length, 1);
  window.__DEEPCODE_BROWSER_PREVIEW__ = true;
  assert.equal(capture(CompletionSoundSettings, { language: 'zh-CN' }).html, '');
  assert.equal(settingsSearchDefinitions('zh-CN', 'macos').some(x => x.id === 'gui.completionSound'), false);
});

for (const language of ['zh-CN', 'en-US']) test(`settings retain their eight pages and open on flat General preferences (${language})`, async t => {
  const [{ useSettingsStore }, { default: SettingsCenter }, { GuiSettingsSection, AgentSettingsSection, settingsSearchDefinitions }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/SettingsCenter.tsx',
    '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
  ]);
  const initial = fixture(t, useSettingsStore, language);
  const center = capture(SettingsCenter, { apiStatus: 'connected' });
  const navigation = findReactElement(center.tree, node => node.props.data?.kind === 'settingsNavigation').props.data;
  assert.equal(navigation.activePage, 'general');
  assert.deepEqual(navigation.pages.map(page => page.id), ['general', 'gui', 'agent', 'environment', 'permissions', 'llm', 'plugins', 'about']);
  assert.deepEqual(navigation.pages.map(page => page.label), language === 'zh-CN'
    ? ['通用', '外观', 'Agent 行为', '执行环境', '工具权限', '模型与服务', '插件', '关于']
    : ['General', 'Appearance', 'Agent behavior', 'Execution environment', 'Tool permissions', 'Models & services', 'Plugins', 'About']);
  assert.match(center.html, /id="setting-page-general"/);
  const general = capture(GuiSettingsSection, { category: 'general', apiStatus: 'connected' });
  const agent = capture(AgentSettingsSection, { category: 'agent' });
  assert.deepEqual(fieldKeys(general.tree), generalKeys);
  assert.deepEqual(fieldKeys(agent.tree), agentKeys);
  for (const page of [general, agent]) {
    assert.doesNotMatch(page.html, /<h3|<hr|<p[ >]|settings-field__source|>(重置|Reset|保存|Save)<\/button>/,
      'flat settings have no extra headings, descriptions, separators, source badges or confirmation/reset actions');
  }
  const appearance = capture(GuiSettingsSection, { category: 'appearance', apiStatus: 'connected' });
  assert.deepEqual(fieldKeys(appearance.tree), [], 'appearance does not render general or Agent controls');
  assert.match(appearance.html, /data-theme-choice=/);
  assert.match(appearance.html, /id="ui-font-heading"/);
  assert.match(appearance.html, /settings-palette__summary/);
  assert.doesNotMatch(appearance.html, />(重置|Reset|重置此配色|Reset this palette|恢复默认配色|Restore default colors)<\/button>/);
  const entries = settingsSearchDefinitions(language, 'macos');
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  assert.deepEqual(entries.filter(entry => entry.category === 'general').map(entry => entry.id), generalKeys);
  assert.deepEqual(entries.filter(entry => entry.category === 'agent').map(entry => entry.id), agentKeys);
  assert.deepEqual(entries.filter(entry => entry.category === 'gui').map(entry => entry.id), ['gui.colorTheme', 'gui.accentColor']);
  initial.errorMessage = 'settings_write_failed: permission denied';
  for (const Component of [GuiSettingsSection, AgentSettingsSection]) {
    const html = renderToStaticMarkup(createElement(Component, { apiStatus: 'connected' }));
    assert.match(html, /settings_write_failed: permission denied/, 'simplification retains original save failures');
  }
});

test('interface reload restores the current settings page once, then subsequent openings return to General', async t => {
  const previous = globalThis.sessionStorage;
  const values = new Map([['deepcode:interface-reload', JSON.stringify({ settingsPage: 'agent', settingsScroll: 120 })]]);
  globalThis.sessionStorage = { getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
  t.after(() => { if (previous === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previous; });
  const [{ useSettingsStore }, { default: SettingsCenter }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/SettingsCenter.tsx',
  ]);
  fixture(t, useSettingsStore, 'en-US');
  const page = () => findReactElement(capture(SettingsCenter, { apiStatus: 'connected' }).tree,
    node => node.props.data?.kind === 'settingsNavigation').props.data.activePage;
  assert.equal(page(), 'agent');
  assert.equal(page(), 'general');
  assert.equal(page(), 'general');
  assert.equal(values.has('deepcode:interface-reload'), false);
});
