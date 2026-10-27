// Production settings and typography with isolated HTTP fixtures. No Provider or live Host calls.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_USER_SETTINGS, type LlmProviderProfile, type ModelConnection, type ProviderAdapterDescriptor, type UserSettings } from '@achbit/protocol';
import SettingsCenter from '../../src/components/settings-center/SettingsCenter';
import { useSettingsStore } from '../../src/state/settingsStore';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import GuiTypography from '../../src/theme/GuiTypography';
import PaletteOverrides from '../../src/theme/PaletteOverrides';
import { typographyStyles } from '../../src/theme/typography';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';

installPaletteDefaults();
const key = 'achbit-settings-autosave-preview';
let settings: UserSettings = JSON.parse(localStorage.getItem(key) ?? '{}');
const connection: ModelConnection = { id: 'connection:fixture', name: '测试连接', adapterId: 'custom', billingMode: 'metered',
  baseUrl: 'https://example.invalid', credentialKind: 'apiKey' };
let profiles: LlmProviderProfile[] = JSON.parse(localStorage.getItem(`${key}:models`) ?? 'null') ?? [
  { id: 'model:fixture', connectionId: connection.id, name: '测试模型', model: 'fixture-model', kind: 'responses', providerFlavor: 'openai',
    enabled: true, contextWindowTokens: 1_000_000, maxOutputTokens: 8192, thinking: 'enabled', reasoningEffort: 'high' },
];
const adapter: ProviderAdapterDescriptor = { id: 'custom', name: '测试服务', billingModes: ['metered'], authMethods: ['apiKey'],
  protocols: ['responses', 'openaiCompatible'], defaultBaseUrl: connection.baseUrl, models: [], pricing: false, quota: false, source: 'builtin' };
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === '/api/user-settings') {
    if (init?.method === 'PATCH') {
      const { patches } = JSON.parse(String(init.body));
      const next = { ...settings, ...patches };
      for (const [name, value] of Object.entries(patches)) if (value === null) delete next[name];
      for (const name of ['agent.contextManagement.thresholdTokens', 'agent.subagents.maxConcurrent', 'agent.subagents.maxCallsPerRun', 'agent.subagents.maxMembersPerSession']) {
        if (next[name] !== undefined && (!Number.isSafeInteger(next[name]) || Number(next[name]) <= 0)) return Response.json({ ok: false, message: '请输入正整数。' });
      }
      try { typographyStyles({ ...DEFAULT_USER_SETTINGS, ...next }); }
      catch (cause) { return Response.json({ ok: false, message: String(cause) }); }
      settings = next; localStorage.setItem(key, JSON.stringify(settings));
      return Response.json({ ok: true, data: { settings, changedKeys: Object.keys(patches),
        activation: Object.keys(patches).some(name => name.startsWith('agent.contextManagement.')) ? 'nextRun' : 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings, runtimeSettings: settings, overriddenKeys: Object.keys(settings),
      storePath: '/fixture/settings.json', environment: { os: 'macos' } } });
  }
  if (path === '/api/llm/profiles') {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      if (patch.profile) {
        profiles = [...profiles.filter(profile => profile.id !== patch.profile.id), patch.profile];
        localStorage.setItem(`${key}:models`, JSON.stringify(profiles));
      }
    }
    return Response.json({ ok: true, data: { profiles, connections: [connection], defaultProfileId: profiles[0]?.id } });
  }
  if (path === '/api/llm/connections') return Response.json({ ok: true, data: { connections: [{ ...connection, authStatus: 'ready' }], adapters: [adapter] } });
  if (path === '/api/llm/usage') return Response.json({ ok: true, data: { connections: [] } });
  throw new Error(`Unexpected fixture request: ${path}`);
};
useSettingsStore.setState({ userSettings: settings, effectiveSettings: { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'zh-CN', ...settings },
  sources: Object.fromEntries(Object.keys(settings).map(name => [name, 'user'])), loading: false, environment: { os: 'macos' } });
useLocalAgentStore.setState({ selectedProfileId: 'model:fixture' });
function Fixture() {
  return <>
    <GuiTypography /><PaletteOverrides />
    <style>{`*{box-sizing:border-box}body{margin:0;font:14px var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}#root{height:100vh;padding:24px}.settings-center{height:100%;max-width:1080px;margin:auto}`}</style>
    <SettingsCenter apiStatus="connected" serverVersion="preview" />
  </>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
window.addEventListener('pagehide', () => { root.unmount(); window.fetch = originalFetch; }, { once: true });
