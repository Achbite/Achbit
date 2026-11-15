// TCR: .task-artifacts/model-panel-preview/TCR.md (confirmed implementation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_USER_SETTINGS } from '../../protocol/dist/index.js';
import { findReactElement, installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  return { html: renderToStaticMarkup(createElement(Probe)), tree };
}

test('reasoning style persists via canonical settings, preserves the model and retains a failed save', async t => {
  const [{ default: Settings }, { useSettingsStore: store }, { useLocalAgentStore: agent }, style] = await loadGuiModules(t, [
    '/src/components/settings-center/ReasoningControlSettings.tsx', '/src/state/settingsStore.ts',
    '/src/state/localAgentStore.ts', '/src/components/local-agent/reasoningControlStyle.ts',
  ]);
  let settings = { ...DEFAULT_USER_SETTINGS }, fail = false;
  const writes = [];
  agent.setState({ selectedProfileId: 'profile:unchanged', reasoningEffortOverride: 'high' });
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body); writes.push(patches);
      if (fail) return Response.json({ ok: false, message: 'fixture setting write failed' });
      settings = { ...settings, ...patches };
      return Response.json({ ok: true, data: { settings, activation: 'immediate', changedKeys: Object.keys(patches) } });
    }
    return Response.json({ ok: true, data: { settings, runtimeSettings: settings, storePath: 'fixture' } });
  });
  await store.getState().loadUserSettings();
  Object.assign(store.getInitialState(), store.getState());
  let page = capture(Settings, { language: 'en-US' });
  findReactElement(page.tree, node => node.props.role === 'radio' && node.key === 'slider').props.onClick();
  await flush(); await flush();
  assert.deepEqual(writes, [{ [style.REASONING_CONTROL_SETTING]: 'slider' }]);
  assert.equal(store.getState().effectiveSettings[style.REASONING_CONTROL_SETTING], 'slider');
  assert.equal(agent.getState().selectedProfileId, 'profile:unchanged');
  assert.equal(agent.getState().reasoningEffortOverride, 'high');
  fail = true;
  Object.assign(store.getInitialState(), store.getState());
  page = capture(Settings, { language: 'en-US' });
  findReactElement(page.tree, node => node.props.role === 'radio' && node.key === 'segments').props.onClick();
  await flush(); await flush();
  assert.equal(store.getState().effectiveSettings[style.REASONING_CONTROL_SETTING], 'slider');
  assert.equal(store.getState().errorMessage, 'fixture setting write failed');
  assert.equal(style.reasoningControlStyle(undefined), 'segments');
  assert.throws(() => style.reasoningControlStyle('invalid'), /invalid_reasoning_effort_control/);
});

test('slider uses supplied discrete capabilities, previews without saving and commits on release', async t => {
  const [{ default: Slider }] = await loadGuiModules(t, ['/src/components/local-agent/ReasoningEffortSlider.tsx']);
  const writes = [], efforts = ['low', 'high', 'max'];
  const props = { efforts, value: 'high', disabled: false, language: 'en-US', onSelect: async effort => { writes.push(effort); } };
  const { tree, html } = capture(Slider, props);
  const range = findReactElement(tree, node => node.type === 'input');
  assert.equal(range.props.max, 2); assert.equal(range.props.value, 1);
  assert.equal(range.props['aria-valuetext'], 'High');
  range.props.onChange({ currentTarget: { valueAsNumber: 2 } });
  assert.deepEqual(writes, []);
  range.props.onPointerUp({ button: 0, currentTarget: { valueAsNumber: 2 } });
  await flush(); assert.deepEqual(writes, ['max']);
  assert.match(html, /type="range"/);
  const unset = capture(Slider, { ...props, value: null });
  assert.match(unset.html, /data-unset="true"/);
  assert.match(unset.html, /aria-valuetext="Choose level"/);
  assert.equal(writes.length, 1, 'rendering an unset effort must not select the first level');
  const disabled = capture(Slider, { ...props, disabled: true });
  const locked = findReactElement(disabled.tree, node => node.type === 'input');
  locked.props.onKeyUp({ key: 'End', currentTarget: { valueAsNumber: 2 } });
  await flush(); assert.equal(writes.length, 1);
});

test('slider effect requires enabled subagents and the actual highest confirmed capability', async t => {
  const [{ default: Slider }] = await loadGuiModules(t, ['/src/components/local-agent/ReasoningEffortSlider.tsx']);
  const writes = [];
  const props = { efforts: ['low', 'high', 'max'], value: 'max', disabled: false, language: 'en-US',
    subagentsEnabled: true, onSelect: async value => { writes.push(value); } };
  assert.match(capture(Slider, props).html, /data-energized="true"/);
  assert.doesNotMatch(capture(Slider, { ...props, subagentsEnabled: false }).html, /data-energized/);
  assert.doesNotMatch(capture(Slider, { ...props, value: 'high' }).html, /data-energized/);
  assert.doesNotMatch(capture(Slider, { ...props, value: null }).html, /data-energized/);
  assert.doesNotMatch(capture(Slider, { ...props, value: 'xhigh' }).html, /data-energized/);
  assert.match(capture(Slider, { ...props, efforts: ['low', 'high'], value: 'high' }).html, /data-energized="true"/);
  assert.deepEqual(writes, [], 'visual feedback must not write model or subagent settings');
});

test('edge particles share the confirmed highest subagent gate and remain decorative', async t => {
  const [{ default: Slider }] = await loadGuiModules(t, ['/src/components/local-agent/ReasoningEffortSlider.tsx']);
  const props = { efforts: ['low', 'high', 'max'], value: 'max', disabled: false, language: 'en-US', subagentsEnabled: true,
    async onSelect() { assert.fail('rendering the edge effect must not submit a selection'); } };
  const { tree } = capture(Slider, props);
  const edge = findReactElement(tree, node => node.props.className === 'achbit-reasoning-slider__edge-particles');
  assert.equal(edge.props['aria-hidden'], 'true');
  assert.equal(edge.props.children.length, 6);
  assert.ok(edge.props.children.every(node => node.type === 'i' && node.props.tabIndex === undefined));
  assert.doesNotMatch(capture(Slider, { ...props, subagentsEnabled: false }).html, /data-energized|__edge-particles/);
  assert.match(capture(Slider, { ...props, efforts: ['low', 'high'], value: 'high' }).html, /__edge-particles/);
  for (const value of ['high', null, 'xhigh']) assert.doesNotMatch(capture(Slider, { ...props, value }).html, /data-energized|__edge-particles/);
  assert.doesNotMatch(capture(Slider, { ...props, efforts: [], value: null }).html, /data-energized|__edge-particles/);
});

test('energy particles are decorative and exist only while the highest subagent state is enabled', async t => {
  const [{ default: Slider }] = await loadGuiModules(t, ['/src/components/local-agent/ReasoningEffortSlider.tsx']);
  const props = { efforts: ['low', 'high', 'max'], value: 'max', disabled: false, language: 'en-US', subagentsEnabled: true,
    async onSelect() { assert.fail('rendering visual effects must not submit a selection'); } };
  const { tree } = capture(Slider, props);
  const particles = findReactElement(tree, node => node.props.className === 'achbit-reasoning-slider__particles');
  assert.equal(particles.props['aria-hidden'], 'true');
  assert.equal(particles.props.children.length, 8);
  assert.ok(particles.props.children.every(node => node.type === 'i' && node.props.tabIndex === undefined));
  const range = findReactElement(tree, node => node.type === 'input');
  assert.equal(range.props.type, 'range'); assert.equal(range.props['aria-valuetext'], 'Max');
  assert.doesNotMatch(capture(Slider, { ...props, subagentsEnabled: false }).html, /achbit-reasoning-slider__particles/);
  assert.doesNotMatch(capture(Slider, { ...props, value: 'high' }).html, /achbit-reasoning-slider__particles/);
});

test('model settings target opens only its matching editor without changing the default profile', async t => {
  const [{ ConnectionDetail }] = await loadGuiModules(t, ['/src/components/settings-center/sections/LlmSection.tsx']);
  const profiles = ['other', 'selected'].map(id => ({ id, connectionId: 'connection:one', name: id, model: id,
    enabled: true, kind: 'responses', providerFlavor: 'openai', reasoningEffort: 'high' }));
  const adapter = { id: 'custom', name: 'Fixture', billingModes: ['metered'], authMethods: ['apiKey'],
    protocols: ['responses'], models: [], defaultBaseUrl: 'https://example.test/v1' };
  const current = { id: 'connection:one', name: 'Fixture', adapterId: 'custom', billingMode: 'metered',
    baseUrl: adapter.defaultBaseUrl, credentialKind: 'apiKey', authStatus: 'ready' };
  const { tree, html } = capture(ConnectionDetail, { current, adapters: [adapter], profiles, defaultId: 'other',
    targetProfileId: 'selected', mode: 'metered', async onSaved() {}, onBack() {} });
  const target = findReactElement(tree, node => node.props.profile?.id === 'selected');
  const other = findReactElement(tree, node => node.props.profile?.id === 'other');
  assert.equal(target.props.reveal, true); assert.equal(other.props.reveal, false);
  assert.equal(target.props.defaultId, 'other');
  assert.match(html, /data-profile-id="selected" open=""/);
  assert.doesNotMatch(html, /data-profile-id="other" open/);
});

// TCR: .task-artifacts/ui-small-fixes-20261115/TCR.md.
test('the explicit overview target opens Models & services without a connection or profile target', async t => {
  const [{ default: SettingsCenter }, { default: LlmSection }, { useSettingsStore: settings }, { useLocalAgentStore: agent }] = await loadGuiModules(t, [
    '/src/components/settings-center/SettingsCenter.tsx', '/src/components/settings-center/sections/LlmSection.tsx',
    '/src/state/settingsStore.ts', '/src/state/localAgentStore.ts',
  ]);
  Object.assign(settings.getInitialState(), { effectiveSettings: { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'en-US' }, loading: false });
  agent.setState({ selectedProfileId: 'profile:keep', reasoningEffortOverride: 'high' });
  const target = { kind: 'overview' };
  const center = capture(SettingsCenter, { apiStatus: 'connected', initialModelTarget: target });
  assert.equal(findReactElement(center.tree, node => node.props.data?.kind === 'settingsNavigation').props.data.activePage, 'llm');
  const overview = capture(LlmSection, { initialModelTarget: target });
  assert.match(overview.html, /Models &amp; services/);
  assert.match(overview.html, /API connection/);
  assert.match(overview.html, /Coding Plan/);
  assert.doesNotMatch(overview.html, /model-breadcrumb|data-profile-id/);
  const detail = capture(LlmSection, { initialModelTarget: { kind: 'model', connectionId: 'connection:one', profileId: 'profile:keep' } });
  assert.match(detail.html, /model-breadcrumb/, 'explicit model deep links remain supported');
  assert.equal(agent.getState().selectedProfileId, 'profile:keep');
  assert.equal(agent.getState().reasoningEffortOverride, 'high');
});
