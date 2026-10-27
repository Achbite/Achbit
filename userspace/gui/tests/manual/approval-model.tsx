// Production model settings with isolated catalog/settings fixtures. No Provider calls.
import React from 'react';
import { createRoot } from 'react-dom/client';
import LlmSection from '../../src/components/settings-center/sections/LlmSection';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';

installPaletteDefaults();
const connection = { id: 'connection:fixture', name: 'Configured provider', adapterId: 'custom', billingMode: 'metered', baseUrl: 'https://example.invalid', credentialKind: 'apiKey' };
const profiles = ['enabled', 'disabled', 'limited'].map(kind => ({ id: `model:${kind}`, connectionId: connection.id,
  name: `Fixture ${kind}`, kind: 'openaiCompatible', providerFlavor: kind === 'limited' ? 'deepseek' : 'openai',
  model: kind, enabled: true, thinking: kind === 'disabled' ? 'disabled' : 'enabled', reasoningEffort: 'high', contextWindowTokens: 128000, maxOutputTokens: 4096 }));
const originalFetch = window.fetch;
window.fetch = async input => {
  const path = new URL(String(input), location.origin).pathname;
  const data = path.endsWith('/llm/profiles') ? { profiles, connections: [connection], defaultProfileId: 'model:enabled' }
    : path.endsWith('/llm/connections') ? { connections: [], adapters: [] }
    : path.endsWith('/llm/usage') ? { connections: [] } : undefined;
  if (!data) throw new Error(`Unexpected fixture request: ${path}`);
  return Response.json({ ok: true, data });
};
useLocalAgentStore.setState({ selectedProfileId: 'model:enabled', refreshProfiles: async () => {} });
useSettingsStore.setState({ patchUserSettingsBatch: async patches => {
  useSettingsStore.setState({ effectiveSettings: { ...useSettingsStore.getState().effectiveSettings, ...patches } });
  return 'nextRun';
} });
function Fixture() {
  const settings = useSettingsStore(state => state.effectiveSettings);
  return <>
    <style>{`*{box-sizing:border-box}body{margin:24px auto;max-width:900px;font:14px var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}.fixture-toolbar{display:flex;gap:16px;margin-bottom:24px}main{padding:20px;border:1px solid var(--ac-border);border-radius:12px}output{display:block;margin-top:20px}`}</style>
    <nav className="fixture-toolbar"><label>当前对话模型<select defaultValue="model:enabled" onChange={event => useLocalAgentStore.setState({ selectedProfileId: event.target.value })}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <label>界面语言<select defaultValue="zh-CN" onChange={event => useSettingsStore.setState({ effectiveSettings: { ...settings, 'workbench.language': event.target.value } })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label></nav>
    <main><LlmSection /></main><output aria-label="已保存审批设置">{JSON.stringify({ model: settings['agent.approvalReview.profileId'], effort: settings['agent.approvalReview.reasoningEffort'] })}</output>
  </>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Fixture />);
window.addEventListener('pagehide', () => { window.fetch = originalFetch; root.unmount(); }, { once: true });
