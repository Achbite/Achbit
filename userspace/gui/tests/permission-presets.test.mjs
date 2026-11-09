import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { permissionSettings } from '@achbit/protocol';
import { loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

test('permission presets batch only access settings and leave workflow and command restrictions unchanged', async t => {
  const { PERMISSION_PRESETS, currentPermissionPreset } = await loadGuiModule(t, '/src/components/local-agent/permissionPresets.ts');
  const original = permissionSettings({ 'agent.permissions.workspaceMutation': 'review', 'agent.permissions.engineeringDecisions': 'delegate',
    'agent.permissions.commandDenylist': ['protected command'] });
  assert.deepEqual(PERMISSION_PRESETS.map(preset => preset.id), ['ask', 'review', 'full']);
  for (const [index, [mode, scope]] of [['ask', 'workspace'], ['review', 'workspace'], ['allow', 'full']].entries()) {
    const preset = PERMISSION_PRESETS[index];
    assert.deepEqual(preset.patches, { 'agent.permissions.shell': mode, 'agent.permissions.shellAccess': scope,
      'agent.permissions.networkRead': mode, 'agent.permissions.external': mode });
    const settings = permissionSettings({ ...original, ...preset.patches });
    assert.equal(currentPermissionPreset(settings)?.id, preset.id);
    for (const key of Object.keys(original).filter(key => !(key in preset.patches))) assert.deepEqual(settings[key], original[key]);
    assert.equal(currentPermissionPreset({ ...settings, 'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.engineeringDecisions': 'ask' })?.id, preset.id);
  }
});

test('mixed permission domains and restricted execution scope are reported as custom', async t => {
  const { PERMISSION_PRESETS, currentPermissionPreset } = await loadGuiModule(t, '/src/components/local-agent/permissionPresets.ts');
  const full = permissionSettings(PERMISSION_PRESETS.find(preset => preset.id === 'full').patches);
  assert.equal(currentPermissionPreset({ ...full, 'agent.permissions.networkRead': 'ask' }), undefined);
  assert.equal(currentPermissionPreset({ ...full, 'agent.permissions.external': 'deny' }), undefined);
  assert.equal(currentPermissionPreset({ ...full, 'agent.permissions.shellAccess': 'workspace' }), undefined);
});

test('network and external settings expose three choices and display an existing deny truthfully', async t => {
  const [{ SETTING_DEFINITIONS }, { default: SettingsField }, { localizeSettingDefinition }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/SettingsField.tsx', '/src/settingsLocalization.ts',
  ]);
  for (const key of ['agent.permissions.networkRead', 'agent.permissions.external']) {
    const definition = SETTING_DEFINITIONS.find(item => item.key === key);
    assert.deepEqual(definition.options.map(option => option.value), ['ask', 'review', 'allow']);
    for (const language of ['zh-CN', 'en-US']) {
      const localized = localizeSettingDefinition(definition, language);
      assert.equal(localized.options.find(option => option.value === 'review').label, language === 'zh-CN' ? '替我批准' : 'Review for me');
      const html = renderToStaticMarkup(createElement(SettingsField, { definition: localized, language, value: 'deny', onChange: async () => {} }));
      assert.match(html, /<option value="deny" disabled="" selected="">(拒绝|Deny)<\/option>/);
    }
  }
});

test('the detailed permission page reads as a custom level in both languages', async t => {
  const { t: translate } = await loadGuiModule(t, '/src/i18n.ts');
  assert.equal(translate('zh-CN', 'agent.permission.details'), '自定义权限');
  assert.equal(translate('en-US', 'agent.permission.details'), 'Custom permissions');
});
