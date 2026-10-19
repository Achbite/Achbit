import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_USER_SETTINGS } from '../../protocol/dist/index.js';
import { loadGuiModule, loadGuiModules, installGuiFetch } from './gui-projection-contract.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function elements(root, matches) {
  const result = [];
  const visit = value => Children.forEach(value, node => {
    if (!isValidElement(node)) return;
    if (matches(node)) result.push(node);
    visit(node.props.children);
  });
  visit(root); return result;
}
function capture(Component, props, renderChildren = true) {
  let tree;
  function Probe() { tree = Component(props); return renderChildren ? tree : null; }
  return { html: renderToStaticMarkup(createElement(Probe)), get tree() { return tree; } };
}
function settingsFixture(t, store, overrides = {}) {
  const initial = store.getInitialState(), previous = { ...initial };
  const writes = [];
  let fail = false;
  const patch = async patches => {
    writes.push(structuredClone(patches));
    if (fail) { store.setState({ errorMessage: 'settings write failed' }); return null; }
    const next = { ...store.getState().effectiveSettings, ...patches };
    for (const [key, value] of Object.entries(patches)) if (value === null) next[key] = DEFAULT_USER_SETTINGS[key];
    initial.effectiveSettings = next;
    store.setState({ effectiveSettings: next, errorMessage: null });
    return 'immediate';
  };
  const state = { effectiveSettings: { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'en-US', ...overrides }, loading: false,
    patchUserSettingsBatch: patch, patchUserSetting: (key, value) => patch({ [key]: value }), resetUserSetting: key => patch({ [key]: null }) };
  Object.assign(initial, state); store.setState(state);
  t.after(() => Object.assign(initial, previous));
  return { writes, failNext() { fail = true; } };
}

test('subagent switches and model choices persist their own fields without a form Save; numeric confirmation stays independent', async t => {
  const [{ useSettingsStore }, { default: Subagents }, { t: text }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/model-services/SubagentSettings.tsx', '/src/i18n.ts',
  ]);
  const fixture = settingsFixture(t, useSettingsStore);
  const { tree, html } = capture(Subagents, { profiles: [], connections: [] });
  assert.doesNotMatch(html, /type="submit"|>Save<\/button>/);
  const toggle = elements(tree, node => node.props.checked === false && typeof node.props.onChange === 'function')[0];
  toggle.props.onChange({ target: { checked: true } });
  await flush();
  assert.deepEqual(fixture.writes[0], { 'agent.subagents.enabled': true });
  assert.equal(useSettingsStore.getState().effectiveSettings['agent.subagents.enabled'], true);
  const number = elements(tree, node => node.props.label === text('en-US', 'settings.subagents.maxConcurrent'))[0];
  assert.equal(await number.props.onCommit(7), true);
  assert.deepEqual(fixture.writes.at(-1), { 'agent.subagents.maxConcurrent': 7 });
  const fields = elements(tree, node => node.props.profileId === '' && typeof node.props.mainProfileId !== 'undefined')[0];
  fields.props.onChange({ reasoningEffort: '' });
  await flush();
  assert.deepEqual(fixture.writes.at(-1), { 'agent.subagents.reasoningEffort': '' });
  fixture.failNext();
  assert.equal(await number.props.onCommit(9), false);
  assert.equal(useSettingsStore.getState().effectiveSettings['agent.subagents.maxConcurrent'], 7);
});

test('preset fonts and sizes save immediately through the shared settings owner without a second Save', async t => {
  const [{ useSettingsStore }, { default: Fonts }, typography] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/GuiFontSettings.tsx', '/src/theme/typography.ts',
  ]);
  const fixture = settingsFixture(t, useSettingsStore, { 'gui.fontSize': 16 });
  const { tree, html } = capture(Fonts, { language: 'en-US' });
  assert.doesNotMatch(html, />(Save|Reset)<\/button>/);
  const preset = elements(tree, node => node.props.value === 'warm-sans' && typeof node.props.onChange === 'function')[0];
  preset.props.onChange({ target: { value: 'compact' } });
  await flush();
  assert.deepEqual(fixture.writes[0], { 'gui.fontFamily': 'compact', 'gui.interfaceFontFamily': 'inherit',
    'gui.contentFontFamily': 'inherit', 'gui.terminalFontFamily': 'inherit' });
  assert.match(typography.typographyStyles(useSettingsStore.getState().effectiveSettings)['--dc-font-ui'], /DeepCode Quiet Mono SC/);
  const size = elements(tree, node => node.props.value === 12 && typeof node.props.onChange === 'function')[0];
  size.props.onChange({ target: { value: '11' } });
  await flush();
  assert.deepEqual(fixture.writes.at(-1), { 'gui.codeFontSize': 11 });
  assert.equal(useSettingsStore.getState().effectiveSettings['gui.fontSize'], 16);
  assert.equal(typography.typographyStyles(useSettingsStore.getState().effectiveSettings)['--dc-font-code-size'], '11px');
});

test('numbers commit on Enter, not typing, and retain native validity, IME and optional-empty semantics', async t => {
  const { default: NumberInput } = await loadGuiModule(t, '/src/components/shared/ConfirmedNumberInput.tsx');
  const commits = [];
  const { tree } = capture(NumberInput, { value: 4, language: 'en-US', label: 'Concurrent tasks', required: true, min: 1,
    onCommit: async value => { commits.push(value); return true; } });
  const input = elements(tree, node => node.type === 'input')[0];
  input.props.onChange({ target: { value: '7', valueAsNumber: 7 } });
  assert.deepEqual(commits, []);
  const event = overrides => ({ key: 'Enter', nativeEvent: { isComposing: false }, repeat: false,
    currentTarget: { value: '7', valueAsNumber: 7, reportValidity: () => true }, preventDefault() {}, stopPropagation() {}, ...overrides });
  await input.props.onKeyDown(event({ nativeEvent: { isComposing: true } }));
  await input.props.onKeyDown(event({ repeat: true }));
  await input.props.onKeyDown(event({ currentTarget: { value: '', valueAsNumber: NaN, reportValidity: () => false } }));
  assert.deepEqual(commits, []);
  await input.props.onKeyDown(event());
  assert.deepEqual(commits, [7]);
  const optional = capture(NumberInput, { value: 0.5, language: 'en-US', label: 'Temperature', min: 0, max: 2,
    onCommit: async value => { commits.push(value); return true; } });
  await elements(optional.tree, node => node.type === 'input')[0].props.onKeyDown(event({
    currentTarget: { value: '', valueAsNumber: NaN, reportValidity: () => true },
  }));
  assert.deepEqual(commits, [7, undefined]);
});

test('usage widget choices and palette pickers save immediately while text drafts remain explicit', async t => {
  const [{ useSettingsStore }, { UsageWidgetSettings }, { default: Palette }, palette] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/ui-plugins/UsageWidgetSettings.tsx',
    '/src/components/settings-center/GuiPaletteSettings.tsx', '/src/theme/palette.ts',
  ]);
  const fixture = settingsFixture(t, useSettingsStore);
  let closed = 0;
  // The native portal needs a browser; inspect the actual control handlers without mounting that portal in SSR.
  const widget = capture(UsageWidgetSettings, { onClose() { closed++; } }, false);
  assert.equal(elements(widget.tree, node => node.type === 'button' && node.props.type === 'submit').length, 0);
  elements(widget.tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'CNY' } });
  await flush();
  assert.deepEqual(fixture.writes.at(-1), { 'gui.usageWidget.currency': 'CNY' });
  assert.equal(closed, 0, 'a choice does not require closing and reopening the dialog');
  elements(widget.tree, node => node.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } });
  await flush();
  assert.deepEqual(fixture.writes.at(-1), { 'gui.usageWidget.enabled': false });
  const colors = capture(Palette, { language: 'en-US' });
  assert.doesNotMatch(colors.html, />(Save|Reset this palette|Restore default colors)<\/button>/);
  elements(colors.tree, node => node.props.type === 'color')[0].props.onChange({ target: { value: '#123456' } });
  await flush();
  const stored = palette.decodePaletteOverrides(useSettingsStore.getState().effectiveSettings[palette.PALETTE_SETTING]);
  assert.equal(stored[palette.paletteToken('light', palette.PALETTE_FIELDS[0])], '#123456');
});

test('existing model choices persist independently and reuse confirmed state; new model creation stays explicit', async t => {
  const [{ default: ModelEditor }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/components/settings-center/model-services/ModelEditor.tsx', '/src/state/settingsStore.ts',
  ]);
  settingsFixture(t, useSettingsStore);
  const connection = { id: 'connection:autosave', name: 'Fixture', adapterId: 'custom', billingMode: 'metered', baseUrl: 'https://example.invalid', credentialKind: 'apiKey' };
  let saved = { id: 'model:autosave', connectionId: connection.id, name: 'Saved name', model: 'fixture-model', kind: 'responses',
    enabled: true, contextWindowTokens: 128_000, maxOutputTokens: 4096, providerFlavor: 'openai' };
  const writes = [];
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    assert.equal(init.method, 'PATCH');
    const { profile } = JSON.parse(init.body);
    writes.push(profile); saved = profile;
    return Response.json({ ok: true, data: { profiles: [saved], connections: [connection], defaultProfileId: saved.id } });
  });
  const props = { profile: saved, adapter: { id: 'custom', protocols: ['responses', 'openaiCompatible'], models: [] }, defaultId: saved.id,
    async onSaved() {} };
  const editor = capture(ModelEditor, props);
  assert.doesNotMatch(editor.html, /type="submit"/);
  elements(editor.tree, node => node.props.checked === true && typeof node.props.onChange === 'function')[0]
    .props.onChange({ target: { checked: false } });
  await flush();
  assert.equal(saved.enabled, false);
  assert.equal(saved.name, 'Saved name');
  const number = elements(editor.tree, node => node.props.label === 'Context window')[0];
  assert.equal(await number.props.onCommit(64_000), true);
  assert.equal(saved.contextWindowTokens, 64_000);
  assert.equal(saved.enabled, false, 'the next change uses the acknowledged profile, not the opening snapshot');
  const created = capture(ModelEditor, { ...props, profile: { ...props.profile, id: 'model:new' }, onRemove() {} });
  assert.match(created.html, /type="submit"[^>]*>Add model/);
  const count = writes.length;
  await elements(created.tree, node => node.props.label === 'Context window')[0].props.onCommit(32_000);
  assert.equal(writes.length, count, 'a new model is not created by editing one option');
});

test('canonical field refresh preserves independent text edits and removes acknowledged optional fields', async t => {
  const { reconcileSettingFields, reconcileJsonSettingDraft } = await loadGuiModule(t, '/src/components/settings-center/settingDraft.ts');
  const previous = { name: 'Saved', enabled: true, temperature: 0.5 };
  assert.deepEqual(reconcileSettingFields({ ...previous, name: 'Unsaved text' }, previous, { name: 'Saved', enabled: false }),
    { name: 'Unsaved text', enabled: false });
  const before = JSON.stringify({ font: 'saved', size: 14 });
  const draft = { saved: before, text: JSON.stringify({ font: 'Unsaved family', size: 14 }) };
  const updated = reconcileJsonSettingDraft(draft, JSON.stringify({ font: 'saved', size: 16 }), ['size']);
  assert.deepEqual(JSON.parse(updated.text), { font: 'Unsaved family', size: 16 });
});

test('rapid shared-setting writes and readback stay ordered without dropping either update', async t => {
  const { useSettingsStore } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  let persisted = {}, release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  installGuiFetch(t, async (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      writes.push(patches);
      if (writes.length === 1) await gate;
      persisted = { ...persisted, ...patches };
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, overriddenKeys: Object.keys(persisted), storePath: '/fixture/settings.json' } });
  });
  const first = useSettingsStore.getState().patchUserSetting('gui.showReasoning', true);
  const second = useSettingsStore.getState().patchUserSetting('gui.usageWidget.currency', 'CNY');
  await flush();
  assert.equal(writes.length, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['immediate', 'immediate']);
  assert.deepEqual(writes, [{ 'gui.showReasoning': true }, { 'gui.usageWidget.currency': 'CNY' }]);
  assert.equal(useSettingsStore.getState().effectiveSettings['gui.showReasoning'], true);
  assert.equal(useSettingsStore.getState().effectiveSettings['gui.usageWidget.currency'], 'CNY');
});
