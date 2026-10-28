import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModule, installGuiFetch } from './gui-projection-contract.mjs';

test('automatic context settings belong to Agent behavior, default off at 500k, and persist through the shared settings API', async t => {
  const [{ useSettingsStore, agentSettingDefinitions }, { AgentSettingsSection, settingsSearchDefinitions }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
  ]);
  const enabled = 'agent.contextManagement.enabled', threshold = 'agent.contextManagement.thresholdTokens';
  assert.equal(agentSettingDefinitions().find(item => item.key === enabled).control, 'boolean');
  assert.equal(agentSettingDefinitions().find(item => item.key === threshold).control, 'number');
  let persisted = { 'workbench.language': 'zh-CN' };
  let runtimeSettings = { ...persisted };
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      persisted = { ...persisted, ...patches };
      for (const [key, value] of Object.entries(patches)) if (value === null) delete persisted[key];
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'nextRun' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings,
      storePath: '/fixture/user-settings.json' } });
  });
  await useSettingsStore.getState().loadUserSettings();
  assert.equal(useSettingsStore.getState().effectiveSettings[enabled], false);
  assert.equal(useSettingsStore.getState().effectiveSettings[threshold], 500_000);
  for (const [language, labels] of [
    ['zh-CN', ['自动上下文管理', '自动压缩阈值（token）']],
    ['en-US', ['Automatic context management', 'Automatic compaction threshold (tokens)']],
  ]) {
    for (const [index, key] of [enabled, threshold].entries()) {
      const entry = settingsSearchDefinitions(language, 'macos').find(item => item.id === key);
      assert.equal(entry.category, 'agent');
      assert.equal(entry.title, labels[index]);
    }
  }
  const initial = useSettingsStore.getInitialState(), savedInitial = initial.effectiveSettings;
  t.after(() => { initial.effectiveSettings = savedInitial; });
  initial.effectiveSettings = useSettingsStore.getState().effectiveSettings;
  let html = renderToStaticMarkup(createElement(AgentSettingsSection, { category: 'agent' }));
  assert.match(html, /aria-label="自动上下文管理"/);
  assert.doesNotMatch(html, /aria-label="自动上下文管理"[^>]*checked=""/);
  assert.match(html, /aria-label="自动压缩阈值（token）"[^>]*value="500000"/);
  assert.doesNotMatch(html, />保存<\/button>/, 'Agent choices and numbers need no second Save action');
  assert.equal(await useSettingsStore.getState().patchUserSettingsBatch({ [enabled]: true, [threshold]: 250_000 }), 'nextRun');
  assert.equal(useSettingsStore.getState().pendingNextRunActivation, true, 'saved changes remain distinct from the running configuration');
  const { useSettingsStore: reloaded } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  await reloaded.getState().loadUserSettings();
  assert.equal(reloaded.getState().effectiveSettings[enabled], true);
  assert.equal(reloaded.getState().effectiveSettings[threshold], 250_000);
  assert.equal(reloaded.getState().pendingNextRunActivation, true);
  runtimeSettings = { ...persisted };
  await reloaded.getState().loadUserSettings();
  assert.equal(reloaded.getState().pendingNextRunActivation, false, 'activation clears only after the Host reports the new runtime settings');
  initial.effectiveSettings = reloaded.getState().effectiveSettings;
  html = renderToStaticMarkup(createElement(AgentSettingsSection, { category: 'agent' }));
  assert.match(html, /aria-label="自动上下文管理"[^>]*checked=""/);
  assert.match(html, /aria-label="自动压缩阈值（token）"[^>]*value="250000"/);
  assert.equal(await reloaded.getState().resetUserSetting(enabled), 'nextRun');
  assert.equal(await reloaded.getState().resetUserSetting(threshold), 'nextRun');
  assert.equal(reloaded.getState().effectiveSettings[enabled], false);
  assert.equal(reloaded.getState().effectiveSettings[threshold], 500_000);
});
