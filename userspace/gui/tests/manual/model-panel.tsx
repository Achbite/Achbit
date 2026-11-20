// Confirmed design acceptance: production components, isolated HTTP only. No real configuration writes.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_USER_SETTINGS, SESSION_PROJECTION_VERSION, COMMAND_REPLY_VERSION, type LlmProviderProfile, type SessionProjection, type UserSettings, type AgentSettings } from '@achbit/protocol';
import SessionModelSelector from '../../src/components/local-agent/SessionModelSelector';
import SettingsCenter from '../../src/components/settings-center/SettingsCenter';
import AchbitSidebar from '../../src/achbit-gui/layout/AchbitSidebar';
import { ModelSettingsNavigation, type ModelSettingsTarget } from '../../src/components/settings-center/modelSettingsNavigation';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import { InteractionPreview } from './InteractionPreview';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/achbit-gui/achbitGui.css';
import '../../src/achbit-gui/styles/achbitShell.css';
import '../../src/components/settings-center/settingsCenter.css';
import '../../src/components/shared/focus.css';
installPaletteDefaults();
const connection = { id: 'connection:fixture', name: 'Fixture', adapterId: 'custom', billingMode: 'metered' as const,
  baseUrl: 'https://example.test/v1', credentialKind: 'apiKey' as const, authStatus: 'ready' as const };
let profiles: LlmProviderProfile[] = [
  { id: 'model:three', connectionId: connection.id, name: '三档模型', model: 'glm-5.3', providerFlavor: 'zhipu', kind: 'openaiCompatible', enabled: true, thinking: 'enabled', reasoningEffort: 'high' },
  { id: 'model:five', connectionId: connection.id, name: '带有很长显示名称的模型用于检查截断而不是溢出', model: 'gpt-5.4', providerFlavor: 'openai', kind: 'responses', enabled: true, reasoningEffort: 'high' },
  { id: 'model:fixed', connectionId: connection.id, name: '固定强度模型', model: 'kimi-for-coding-highspeed', providerFlavor: 'moonshot', kind: 'responses', enabled: true },
  { id: 'model:unset', connectionId: connection.id, name: '未选强度模型', model: 'glm-5.3', providerFlavor: 'zhipu', kind: 'openaiCompatible', enabled: true },
  { id: 'model:disabled', connectionId: connection.id, name: '关闭思考模型', model: 'gpt-5.4', providerFlavor: 'openai', kind: 'responses', enabled: true, thinking: 'disabled' },
];
let defaultProfileId = profiles[0]!.id;
const defaults: AgentSettings = { enabled: false, profileId: '', reasoningEffort: '', maxConcurrent: 3, maxCallsPerRun: 11,
  maxMembersPerSession: 2, allowMemberAnalysis: true, allowFullConfiguration: true, presets: '[]' };
let settings: UserSettings = { ...DEFAULT_USER_SETTINGS, ...Object.fromEntries(Object.entries(defaults).map(([key, value]) => [`agent.subagents.${key}`, value])) };
const usage = { providerCallCount: 0, reportedCallCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
  cacheMissInputTokens: 0, cacheAvailable: false, cacheComplete: false, cacheHitRatio: null };
let projection: SessionProjection = { schemaVersion: SESSION_PROJECTION_VERSION, sessionId: 'session:panel', revision: 1,
  display: { creationTitle: 'Fixture' }, modelSettings: { profileId: profiles[0].id, reasoningEffortOverride: 'high' }, subagentSettings: defaults,
  permissionOverrides: {}, effectivePermissions: null, shellAuthorizations: [], workspaceBindings: [], sessionDirectoryIndexes: [],
  timeline: [], messages: [], queuedInputs: [], narratives: [], assistantDraft: null, interactions: [], pendingInteraction: null,
  pendingApproval: null, plans: [], activePlanRef: null, pendingPlan: null, todoList: null, contextUsage: null,
  contextCompositions: [], tokenUsage: usage, totalTokenUsage: usage, tokenUsageHistory: [], run: null, activities: [], artifacts: [], deliverables: [], terminalError: null };
const writes: object[] = [];
let failSettings = false;
const result = (data: unknown) => Response.json({ ok: true, data });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  if (path === '/api/user-settings') {
    if (init?.method === 'PATCH') {
      const { patches } = JSON.parse(String(init.body)); writes.push({ kind: 'settings', patches });
      if (failSettings) return Response.json({ ok: false, message: 'fixture settings write failed' });
      settings = { ...settings, ...patches };
      return result({ settings, changedKeys: Object.keys(patches), activation: 'nextRun' });
    }
    return result({ settings, runtimeSettings: settings, storePath: '/fixture/settings.json' });
  }
  if (path.endsWith('/commands')) {
    const command = JSON.parse(String(init?.body)); writes.push(command);
    if (failSettings) return Response.json({ ok: false, message: 'fixture settings write failed' });
    if (command.type === 'session.model-settings.set') projection = { ...projection, modelSettings: command.settings, revision: projection.revision + 1 };
    else if (command.type === 'session.subagent-settings.set') projection = { ...projection, subagentSettings: command.settings, revision: projection.revision + 1 };
    else throw new Error(`Unexpected fixture command: ${command.type}`);
    const selected = projection.modelSettings!;
    defaultProfileId = selected.profileId;
    profiles = profiles.map(item => item.id === defaultProfileId ? { ...item, reasoningEffort: selected.reasoningEffortOverride ?? item.reasoningEffort } : item);
    settings = { ...settings, ...Object.fromEntries(Object.entries(projection.subagentSettings!).map(([key, value]) => [`agent.subagents.${key}`, value])) };
    return result({ schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: command.commandId, sessionId: projection.sessionId, revision: projection.revision });
  }
  if (path.endsWith('/projection')) return result(projection);
  if (path === '/api/llm/profiles') {
    if (init?.method === 'PATCH') {
      const update = JSON.parse(String(init.body));
      if (update.profile) profiles = profiles.map(item => item.id === update.profile.id ? update.profile : item);
      if (update.defaultProfileId) defaultProfileId = update.defaultProfileId;
    }
    return result({ profiles, connections: [connection], defaultProfileId });
  }
  if (path === '/api/llm/connections') return result({ connections: [connection], adapters: [{ id: 'custom', name: 'Fixture', billingModes: ['metered'], authMethods: ['apiKey'], protocols: ['openaiCompatible', 'responses'], models: [], defaultBaseUrl: connection.baseUrl, source: 'builtin' }] });
  if (path.includes('/usage')) return result({ connections: [], totals: {}, days: [], models: [] });
  throw new Error(`Unexpected fixture request: ${path}`);
};
useSettingsStore.setState({ effectiveSettings: settings, userSettings: settings, loading: false });
useLocalAgentStore.setState({ sessionId: projection.sessionId, projection, profiles, connections: [connection], selectedProfileId: profiles[0].id,
  reasoningEffortOverride: 'high', defaultProfileId: profiles[0].id, runtimeReady: true, loading: false, submitting: false });
Object.assign(window, { __modelPanel: {
  snapshot: () => ({ writes, settings, projection, model: useLocalAgentStore.getState().selectedProfileId, effort: useLocalAgentStore.getState().reasoningEffortOverride }),
  fail: (value: boolean) => { failSettings = value; },
  select: (id: string | null) => { const model = profiles.find(profile => profile.id === id); useLocalAgentStore.setState({ selectedProfileId: id, reasoningEffortOverride: model?.reasoningEffort ?? null }); },
} });
function Preview() {
  const [settingsOpen, setSettingsOpen] = useState(false), [collapsed, setCollapsed] = useState(false);
  const [target, setTarget] = useState<ModelSettingsTarget | null>(null);
  const model = useLocalAgentStore(state => state.selectedProfileId), effort = useLocalAgentStore(state => state.reasoningEffortOverride);
  const busy = useLocalAgentStore(state => state.modelSettingsBusy);
  return <ModelSettingsNavigation.Provider value={next => { setTarget(next); setSettingsOpen(true); }}>
    <style>{`html,body,#root{height:100%;margin:0}.panel-fixture{height:100%;display:grid;grid-template-columns:264px minmax(0,1fr);color:var(--ac-foreground);background:var(--ac-surface)}.panel-fixture.is-collapsed{grid-template-columns:0 minmax(0,1fr)}.fixture-sidebar{background:var(--ac-sidebar);overflow:hidden}.fixture-sidebar>.achbit-gui-left-rail{height:100%}.fixture-main{grid-column:2;position:relative;min-width:0;padding:24px;display:flex;flex-direction:column;gap:20px}.fixture-composer{margin-top:auto;align-self:center;width:min(640px,100%);border:1px solid var(--ac-border);border-radius:20px;background:var(--ac-surface-subtle);padding:16px}.fixture-composer textarea{width:100%;height:80px;border:0;background:transparent;color:inherit}.fixture-composer>div{display:flex;justify-content:flex-end}.fixture-settings{position:fixed;inset:20px;z-index:50;background:var(--ac-surface);border:1px solid var(--ac-border);border-radius:14px;padding-top:42px}.fixture-close{position:absolute;right:12px;top:9px;z-index:1}.fixture-settings>.settings-center{height:100%;min-height:0}.fixture-toolbar{display:flex;gap:14px;flex-wrap:wrap}@media(max-width:640px){.panel-fixture{grid-template-columns:0 minmax(0,1fr)}.fixture-sidebar{display:none}.fixture-settings{inset:8px}.fixture-main{padding:14px}}`}</style>
    <div className={`panel-fixture${collapsed ? ' is-collapsed' : ''}`}><aside className="fixture-sidebar"><AchbitSidebar language="zh-CN"
      catalogStatus="ready" projects={[]} sessions={[]} sessionStatuses={{}} statusError={null} readRunMarkers={{}} collapsedProjectIds={new Set()}
      activeSessionId={null} draftProjectId={null} busy={false} reorderDisabled={false} reorderError={null} onReorder={() => {}}
      projectCreateMenuOpen={false} onCreatePrimarySession={() => {}} onOpenProjectCreateMenu={() => {}} onToggleProject={() => {}}
      onCreateProjectSession={() => {}} onActivateSession={() => {}} onOpenProjectContextMenu={() => {}} onOpenSessionContextMenu={() => {}}
      onCollapse={() => setCollapsed(true)} onOpenSettings={() => { setTarget(null); setSettingsOpen(true); }} /></aside>
      <main className="fixture-main"><div className="fixture-toolbar"><button id="open-settings" onClick={() => { setTarget(null); setSettingsOpen(true); }}>设置</button>
        <button id="expand-sidebar" onClick={() => setCollapsed(false)}>展开侧栏</button>
        <button id="theme" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; }}>切换主题</button></div>
        <p>正式组件隔离验证：模型 / 思考强度 / 子代理 / 设置定位。</p>
        <div className="fixture-composer"><textarea aria-label="消息" /><div><SessionModelSelector language="zh-CN" profiles={profiles} connections={[connection]}
          selectedProfileId={model} reasoningEffortOverride={effort} contextUsage={null} contextCompositions={[]} confirmed={!!effort || model === 'model:fixed'} busy={busy}
          onSelect={async (id, next) => { await useLocalAgentStore.getState().selectModel(id, next); }} /></div></div>
      </main></div>
    {settingsOpen && <section className="fixture-settings"><button className="fixture-close" id="close-settings" onClick={() => setSettingsOpen(false)}>关闭设置</button>
      <SettingsCenter apiStatus="connected" initialModelTarget={target} /></section>}
  </ModelSettingsNavigation.Provider>;
}
createRoot(document.getElementById('root')!).render(<InteractionPreview><Preview /></InteractionPreview>);
