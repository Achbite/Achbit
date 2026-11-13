// Regression TCR: .task-artifacts/frontend-fixes-20261113/TCR.md.
// Actual GUI hooks/stores; bounded HTTP fixtures never change a real permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelReasoningEfforts } from '../../protocol/dist/index.js';
import { installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

function exposeSsrState(store) { Object.assign(store.getInitialState(), store.getState()); }

test('composer switches from adjustable reasoning to a fixed-effort service-default model', { timeout: 20_000 }, async t => {
  const [{ useLocalAgentStore: store }, { useAgentComposer }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
  ]);
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  t.after(() => { if (previous === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previous; });
  const connectionId = 'connection:reasoning';
  const adjustable = { id: 'profile:adjustable', connectionId, name: 'Adjustable', model: 'configured-model',
    enabled: true, thinking: 'enabled', reasoningEffort: 'high', kind: 'responses', providerFlavor: 'openai' };
  const fixed = { id: 'profile:fixed', connectionId, name: 'Kimi Highspeed', model: 'kimi-for-coding-highspeed',
    enabled: true, thinking: 'enabled', kind: 'responses', providerFlavor: 'moonshot' };
  assert.deepEqual(modelReasoningEfforts(fixed), []);
  let profiles = [adjustable, fixed];
  const requests = [];
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    requests.push({ method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    if (init.method === 'PATCH') {
      const { profile } = JSON.parse(init.body);
      profiles = profiles.map(item => item.id === profile.id ? profile : item);
    }
    return Response.json({ ok: true, data: { profiles, defaultProfileId: adjustable.id } });
  });
  store.setState({ sessionId: null, projection: null, profiles, selectedProfileId: adjustable.id,
    defaultProfileId: adjustable.id, reasoningEffortOverride: 'high', runtimeReady: true,
    loading: false, submitting: false, catalogBusy: false, modelSettingsBusy: false });
  exposeSsrState(store);
  let composer;
  function Probe() { composer = useAgentComposer('en-US', () => {}); return null; }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(composer.selectedProfileId, adjustable.id);
  await composer.selectModel(fixed.id, null);
  assert.equal(store.getState().selectedProfileId, fixed.id);
  assert.equal(store.getState().reasoningEffortOverride, null);
  assert.equal(requests.filter(request => request.method === 'PATCH').length, 1);
});
