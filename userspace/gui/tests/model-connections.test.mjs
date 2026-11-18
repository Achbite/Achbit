import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules, findReactElement, installGuiFetch } from './gui-projection-contract.mjs';

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

test('creating a Kimi connection saves a custom first model with its provider behavior', async t => {
  const { ConnectionDetail } = await loadGuiModule(t, '/src/components/settings-center/sections/LlmSection.tsx');
  const adapter = { id: 'moonshot', name: 'Kimi', billingModes: ['metered'], authMethods: ['apiKey'],
    protocols: ['openaiCompatible'], defaultBaseUrl: 'https://api.moonshot.ai/v1', models: [{
      name: 'Kimi K3', model: 'kimi-k3', kind: 'openaiCompatible', providerFlavor: 'moonshot', enabled: true,
      contextWindowTokens: 1048576, maxOutputTokens: 32768, imageInput: true, thinking: 'enabled',
    }] };
  const customId = 'my-kimi-deployment';
  let form;
  function FillConnection() {
    const panel = ConnectionDetail({ adapters: [adapter], profiles: [], mode: 'metered', async onSaved() {}, onBack() {} });
    const field = findReactElement(panel, node => node.type === 'input' && node.props.list);
    if (field.props.value !== customId) field.props.onChange({ target: { value: customId } });
    form = findReactElement(panel, node => node.type === 'form');
    return null;
  }
  const writes = [];
  installGuiFetch(t, (url, init) => {
    writes.push({ path: url.pathname, method: init.method, ...JSON.parse(init.body) });
    return Response.json({ ok: true, data: {} });
  });
  renderToStaticMarkup(createElement(FillConnection));
  form.props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  const [{ path, method, connection, profile }] = writes;
  assert.equal(path, '/api/llm/connections');
  assert.equal(method, 'PATCH');
  assert.equal(connection.adapterId, 'moonshot');
  assert.equal(profile.connectionId, connection.id);
  assert.equal(profile.name, customId);
  assert.equal(profile.model, customId);
  assert.equal(profile.kind, 'openaiCompatible');
  assert.equal(profile.providerFlavor, 'moonshot');
  assert.equal(profile.contextWindowTokens, 128000);
  assert.equal(profile.maxOutputTokens, 16000);
  assert.equal(profile.imageInput, undefined);
  assert.equal(profile.thinking, undefined);
});

test('foreground sound is a discoverable persisted GUI preference and defaults to silent', async t => {
  const { DEFAULT_USER_SETTINGS } = await import('../../protocol/dist/index.js');
  const { SETTING_DEFINITIONS } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  assert.equal(DEFAULT_USER_SETTINGS['gui.completionSound.foreground'], false);
  const definition = SETTING_DEFINITIONS.find(value => value.key === 'gui.completionSound.foreground');
  assert.equal(definition.control, 'boolean');
  assert.equal(definition.group, 'gui');
});


test('the connection picker starts without a selection or write and cancellation does not save', async t => {
  const { default: Picker } = await loadGuiModule(t, '/src/components/settings-center/model-services/ModelPickerDialog.tsx');
  const models = ['fast', 'large'].map(model => ({ name: model.toUpperCase(), model, contextWindowTokens: 128_000 }));
  let tree, closed = 0, saved = 0;
  function Capture() { tree = Picker({ connection: { id: 'connection:catalog', name: 'Provider' },
    adapter: { name: 'Provider', protocols: ['responses'], models }, onClose() { closed++; }, async onSaved() { saved++; } }); return null; }
  renderToStaticMarkup(createElement(Capture));
  for (const model of models) {
    const row = findReactElement(tree, node => node.props.role === 'option' && JSON.parse(node.props['data-ui-target']).model === model.model);
    assert.equal(row.props['aria-selected'], false); assert.equal(row.props.tabIndex, model === models[0] ? 0 : -1);
  }
  const confirm = findReactElement(tree, node => node.props['data-ui-action'] === 'settings.model-picker.add');
  assert.equal(confirm.props.disabled, true); confirm.props.onClick();
  findReactElement(tree, node => node.props['data-ui-action'] === 'settings.model-picker.cancel').props.onClick();
  assert.deepEqual([closed, saved], [1, 0]);
});

test('adding a model applies its complete preset without changing identity or a custom display name', async t => {
  const { selectNewModelPreset } = await loadGuiModule(t, '/src/components/settings-center/model-services/ModelEditor.tsx');
  const large = { name: 'Kimi K3.1 Pro', model: 'k3.1-pro', kind: 'responses', providerFlavor: 'moonshot',
    contextWindowTokens: 1048576, maxOutputTokens: 32768, imageInput: true, thinking: 'enabled', reasoningEffort: 'high', enabled: true };
  const small = { name: 'Kimi K2.7 Code Highspeed', model: 'kimi-for-coding-highspeed', kind: 'responses', providerFlavor: 'moonshot',
    contextWindowTokens: 262144, maxOutputTokens: 32768, imageInput: true, thinking: 'enabled', enabled: true };
  const adapter = { models: [large, small] };
  const draft = { ...large, id: 'model:new', connectionId: 'connection:plan', temperature: 0.8, hostedWebSearch: 'web_search' };
  const partial = selectNewModelPreset(draft, adapter, 'kimi-for');
  const selected = selectNewModelPreset(partial, adapter, small.model);
  assert.equal(selected.name, small.name);
  assert.equal(selected.id, draft.id);
  assert.equal(selected.connectionId, draft.connectionId);
  assert.equal(selected.contextWindowTokens, 262144);
  assert.equal(selected.reasoningEffort, undefined, 'fixed-effort model must not inherit adjustable effort');
  assert.equal(selected.hostedWebSearch, undefined);
  assert.equal(selected.temperature, undefined);
  assert.equal(selectNewModelPreset({ ...draft, name: 'My coding model' }, adapter, small.model).name, 'My coding model');
  assert.equal(draft.contextWindowTokens, 1048576, 'the previous draft is not rewritten');
});

test('model settings expose supported thinking choices and retain unsupported saved choices visibly', async t => {
  const { default: ModelEditor } = await loadGuiModule(t, '/src/components/settings-center/model-services/ModelEditor.tsx');
  const adapter = { id: 'glm-coding', protocols: ['openaiCompatible'], models: [] };
  const profile = { id: 'model:glm', connectionId: 'connection:plan', name: 'GLM', model: 'glm-5.3', kind: 'openaiCompatible',
    providerFlavor: 'zhipu', contextWindowTokens: 1000000, maxOutputTokens: 131072, thinking: 'enabled', reasoningEffort: 'high', enabled: true };
  const render = value => {
    let tree;
    function Capture() { tree = ModelEditor({ profile: value, adapter, async onSaved() {} }); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    const select = current => findReactElement(tree, node => node.props.value === current && typeof node.props.onChange === 'function');
    const options = current => Children.toArray(select(current).props.children).filter(node => node.type === 'option');
    return { html, select, options };
  };
  const current = render(profile);
  assert.deepEqual(current.options('high').map(node => node.props.value), ['', 'low', 'high', 'max']);
  assert.deepEqual(current.options('enabled').map(node => node.props.value), ['', 'enabled']);
  const saved = render({ ...profile, thinking: 'disabled', reasoningEffort: 'medium' });
  assert.equal(saved.options('disabled').find(node => node.props.value === 'disabled').props.disabled, true);
  assert.equal(saved.options('medium').find(node => node.props.value === 'medium').props.disabled, true);
  assert.match(saved.html, /role="alert"/);
  const fixed = render({ ...profile, providerFlavor: 'moonshot', model: 'kimi-for-coding-highspeed', reasoningEffort: 'high' });
  assert.equal(fixed.select('high').props.disabled, false, 'an unsupported saved effort can still be cleared');
  assert.equal(fixed.options('high')[0].props.value, '');
  assert.match(fixed.html, /role="alert"/);
});


test('a fixed-effort model can send with its service default without inventing a reasoning override', async t => {
  const [{ useLocalAgentStore: store }, { useAgentComposer }, { default: Selector }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
    '/src/components/local-agent/SessionModelSelector.tsx',
  ]);
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => JSON.stringify({ draft: 'Continue', pastedTexts: [], pastedImages: [], filesystemPaths: [], pluginSelections: [] }) };
  const initial = store.getInitialState(), previous = { ...initial };
  t.after(() => {
    Object.assign(initial, previous);
    if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage;
  });
  const profile = { id: 'profile:fixed', connectionId: 'connection:kimi', name: 'Kimi Highspeed', enabled: true,
    kind: 'responses', providerFlavor: 'moonshot', model: 'kimi-for-coding-highspeed', thinking: 'enabled' };
  store.setState({ profiles: [profile], defaultProfileId: profile.id });
  store.getState().startNewSession();
  Object.assign(initial, store.getState());
  let composer;
  function Probe() { composer = useAgentComposer('en-US', () => {}); return null; }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(composer.canSend, true);
  assert.equal(composer.modelSelectionConfirmed, true);
  assert.equal(composer.reasoningEffortOverride, null);
  const html = renderToStaticMarkup(createElement(Selector, { language: 'en-US', profiles: [profile],
    selectedProfileId: profile.id, reasoningEffortOverride: null, confirmed: composer.modelSelectionConfirmed,
    contextUsage: null, contextCompositions: [], onSelect: async () => {} }));
  assert.doesNotMatch(html, /Choose level/);
  assert.match(html, /Service default/);
});
