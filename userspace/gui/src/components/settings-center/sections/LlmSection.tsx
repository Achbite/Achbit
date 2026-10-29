import { useAutoDismiss } from '../../shared/useAutoDismiss';
import { captureFocusReturn, returnInteractionFocus, useInteractionFocus } from '../../shared/interactionFocus';
import NativeSelect from '../../shared/NativeSelect';
import { modelReasoningEfforts, type UserSettings } from '@achbit/protocol';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSummary, ConnectionsResult, LlmProviderProfile, LlmProfilesResult, ModelConnection, ProviderAdapterDescriptor, UsageReport } from '@achbit/protocol';
import { getLlmProfiles, getModelConnections, patchModelConnections, queryModelUsage } from '../../../services/apiClient';
import { useLocalAgentStore } from '../../../state/localAgentStore';
import { useSettingsStore } from '../../../state/settingsStore';
import { useSettingsSearchEntries } from '../settingsSearch';
import { useSettingsHelp } from '../SettingsHelp';
import { AgentSettingsSection } from './CategorizedSettingsSections';
import ModelEditor from '../model-services/ModelEditor';
import SubscriptionAuth from '../model-services/SubscriptionAuth';
import UsageView from '../model-services/UsageView';
import SubagentSettings from '../model-services/SubagentSettings';
import { Cost, data, Hint, message, periodQuery, useModelLanguage } from '../model-services/shared';
import { UiSettingsContributions, useDisplayTheme } from '../../../ui-plugins/UiPlugins';
import '../model-services/modelServices.css';

type Page = { kind: 'list' } | { kind: 'usage'; connectionId?: string } | { kind: 'web' } |
  { kind: 'connection'; id: string } | { kind: 'new'; mode: 'metered' | 'subscription' };

function ApprovalReviewerModel({ profiles, connections }: { profiles: LlmProviderProfile[]; connections: ModelConnection[] }) {
  const { language } = useModelLanguage();
  const { helpId, helpEvents, help } = useSettingsHelp(t(language, 'settings.approvalReview.description'));
  const selected = useSettingsStore(state => String(state.effectiveSettings['agent.approvalReview.profileId'] ?? ''));
  const effort = useSettingsStore(state => String(state.effectiveSettings['agent.approvalReview.reasoningEffort'] ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const conversationModel = useLocalAgentStore(state => state.selectedProfileId);
  const profile = profiles.find(profile => profile.id === (selected || conversationModel));
  const available = profiles.filter(profile => profile.enabled);
  const efforts = modelReasoningEfforts(profile);
  const unsupportedEffort = !!effort && (profile?.thinking === 'disabled' || !efforts.some(value => value === effort));
  const save = async (patches: UserSettings) => {
    setSaving(true); setError('');
    try {
      const activation = await useSettingsStore.getState().patchUserSettingsBatch(patches);
      if (!activation) setError(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  };
  return <details className="model-editor model-divider">
    <summary aria-describedby={helpId} {...helpEvents}>{help}<strong>{t(language, 'settings.approvalReview.title')}</strong>
      <span>{selected ? profile?.name ?? t(language, 'settings.approvalReview.unavailable') : t(language, 'settings.approvalReview.conversationModel')}
        {effort ? ` · ${t(language, `settings.llm.effort.${effort}`)}` : ''}</span></summary>
    <div className="model-form-grid model-reviewer-settings">
      <label>{t(language, 'settings.approvalReview.providerModel')}
        <NativeSelect value={selected} disabled={saving} onChange={event => {
          const next = profiles.find(profile => profile.id === (event.target.value || conversationModel));
          void save({ 'agent.approvalReview.profileId': event.target.value,
            ...(next?.thinking === 'disabled' || effort && !modelReasoningEfforts(next).some(value => value === effort)
              ? { 'agent.approvalReview.reasoningEffort': '' } : {}) });
        }}>
          <option value="">{t(language, 'settings.approvalReview.useConversationModel')}</option>
          {selected && !available.some(profile => profile.id === selected) && <option value={selected}>{selected}</option>}
          {connections.map(connection => <optgroup key={connection.id} label={connection.name}>
            {available.filter(profile => profile.connectionId === connection.id).map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
          </optgroup>)}
        </NativeSelect>
      </label>
      <label>{t(language, 'settings.llm.reasoningEffort')}
        <NativeSelect value={effort} disabled={saving} onChange={event => void save({ 'agent.approvalReview.reasoningEffort': event.target.value })}>
          <option value="">{profile?.thinking === 'disabled' ? t(language, 'agent.profile.thinkingDisabled') : t(language, 'settings.approvalReview.inheritEffort')}</option>
          {effort && !efforts.some(value => value === effort) && <option value={effort} disabled>{t(language, `settings.llm.effort.${effort}`)}</option>}
          {efforts.map(value => <option key={value} value={value} disabled={profile?.thinking === 'disabled'}>{t(language, `settings.llm.effort.${value}`)}</option>)}
        </NativeSelect>
      </label>
      {unsupportedEffort && <p className="model-wide" role="alert">{t(language, 'settings.approvalReview.effortUnavailable')}</p>}
      {error && <div className="settings-error model-wide" role="alert">{error}</div>}
    </div>
  </details>;
}
export function adapterCredentialKind(adapter: ProviderAdapterDescriptor): ModelConnection['credentialKind'] {
  if (adapter.authMethods.includes('apiKey')) return 'apiKey';
  if (adapter.authMethods.includes('browser') || adapter.authMethods.includes('deviceCode')) return 'oauth';
  return 'none';
}

function newModel(connection: ModelConnection, adapter: ProviderAdapterDescriptor): LlmProviderProfile {
  return { ...(adapter.models[0] ?? { name: '', model: '', kind: adapter.protocols[0], providerFlavor: 'openai', enabled: true, contextWindowTokens: 128000, maxOutputTokens: 16000 }), id: `model:${crypto.randomUUID()}`, connectionId: connection.id };
}
function connectionSettings(connection: ModelConnection): ModelConnection {
  const { id, name, adapterId, billingMode, baseUrl, credentialKind } = connection;
  return { id, name, adapterId, billingMode, baseUrl, credentialKind };
}

export function ConnectionDetail({ current, adapters, profiles, defaultId, mode, onMode, onSaved, onBack }: {
  current?: ConnectionSummary; adapters: ProviderAdapterDescriptor[]; profiles: LlmProviderProfile[];
  defaultId?: string; mode: 'metered' | 'subscription'; onMode?(mode: 'metered' | 'subscription'): void; onSaved(id?: string): Promise<void>; onBack(): void;
}) {
  const { text, language } = useModelLanguage();
  const theme = useDisplayTheme();
  const available = adapters.filter(a => a.billingModes.includes(mode));
  const first = available[0];
  const [draft, setDraft] = useState<ModelConnection>(current ? connectionSettings(current) : {
    id: `connection:${crypto.randomUUID()}`, name: first.name, adapterId: first.id, billingMode: mode,
    baseUrl: first.defaultBaseUrl, credentialKind: adapterCredentialKind(first),
  });
  const adapter = adapters.find(a => a.id === draft.adapterId)!;
  const [apiKey, setApiKey] = useState('');
  const [initialModel, setInitialModel] = useState(first.models[0]?.model ?? '');
  const [newProfile, setNewProfile] = useState<LlmProviderProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useAutoDismiss(saved, () => setSaved(false));
  const models = profiles.filter(p => p.connectionId === draft.id);
  const baseline = useRef(JSON.stringify(draft));
  const initialModelBaseline = useRef(initialModel);
  useInterfaceReloadGuard(!!apiKey || !current && initialModel !== initialModelBaseline.current || JSON.stringify(draft) !== (current ? JSON.stringify(connectionSettings(current)) : baseline.current), draft.name, busy);
  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const template = adapter.models.find(model => model.model === initialModel);
      const profile = { ...newModel(draft, template ? adapter : { ...adapter, models: [] }), ...(template ?? { name: initialModel.trim(), model: initialModel.trim() }) };
      data(await patchModelConnections({ connection: draft, ...(apiKey ? { apiKey } : {}), ...(!current ? { profile } : {}) }));
      setApiKey(''); await onSaved(draft.id); setSaved(true);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <>
    <div className="model-heading"><h2>{current?.name ?? (mode === 'subscription' ? text('添加 Coding Plan', 'Add Coding Plan') : text('添加 API 连接', 'Add API connection'))}</h2></div>
    {!current && onMode && <div className="model-mode-switch" role="group" aria-label={text('接入方式', 'Connection type')}>
      <button type="button" aria-pressed={mode === 'metered'} onClick={() => onMode('metered')}>{text('API / 本地模型', 'API / local model')}</button>
      <button type="button" aria-pressed={mode === 'subscription'} onClick={() => onMode('subscription')}>Coding Plan</button>
    </div>}
    <form className="model-connection-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <div className="model-form-grid">
          {!current && <label>{text('服务', 'Service')}<NativeSelect value={draft.adapterId} onChange={e => { const a = adapters.find(a => a.id === e.target.value)!; setDraft(p => ({ ...p, adapterId: a.id, name: a.name, baseUrl: a.defaultBaseUrl, credentialKind: adapterCredentialKind(a) })); setApiKey(''); setInitialModel(a.models[0]?.model ?? ''); }}>{available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></label>}
          <label>{text('连接名称', 'Connection name')}<input required value={draft.name} onChange={e => { setDraft(p => ({ ...p, name: e.target.value })); setSaved(false); }} /></label>
          {draft.credentialKind !== 'oauth' && <label className="model-wide">{text('API 地址', 'API address')}<input type="url" required value={draft.baseUrl} onChange={e => { setDraft(p => ({ ...p, baseUrl: e.target.value })); setSaved(false); }} /></label>}
          {draft.credentialKind === 'apiKey' && <label className="model-wide">API Key<input type="password" autoComplete="off" required={!current} value={apiKey} placeholder={current?.authStatus === 'ready' ? text('已配置，留空保持', 'Configured; leave blank to keep') : ''} onChange={e => { setApiKey(e.target.value); setSaved(false); }} /></label>}
          {!current && <label>{text('首个模型', 'First model')}<input required value={initialModel} list="connection-model-templates" placeholder={text('输入服务商提供的模型 ID', 'Enter a model ID from your provider')} onChange={event => setInitialModel(event.target.value)} /><datalist id="connection-model-templates">{adapter.models.map(model => <option key={model.model} value={model.model}>{model.name}</option>)}</datalist></label>}
        </div>
        <p className="model-connection-hint">{draft.credentialKind === 'oauth'
          ? text('使用订阅账号登录，支持浏览器授权或设备码。', 'Sign in with your subscription account using a browser or device code.')
          : draft.credentialKind === 'none' ? text('连接本机模型服务，无需 API Key。', 'Connect to a local model service without an API key.')
          : mode === 'subscription' ? text('使用对应套餐和地区的专用 API Key。套餐 Key 与按量 API Key 不通用。', 'Use the API key for this plan and region. Plan keys and metered API keys are separate.')
          : text('使用该服务的 API Key，费用按服务商规则计算。', 'Use this service’s API key. Your provider determines billing.')}</p>
        <div className="model-actions"><span className="model-feedback" role="status">{saved ? text('已保存', 'Saved') : ''}</span><button className="model-primary model-push" type="submit">{current ? text('保存连接', 'Save connection') : draft.credentialKind === 'oauth' ? text('创建并继续登录', 'Create and continue to sign in') : text('创建连接', 'Create connection')}</button></div>
      </fieldset>
    </form>
    {error && <div className="settings-error" role="alert">{error}</div>}
    {current && <>
      {current.credentialKind === 'oauth' && <SubscriptionAuth connection={current} onChanged={() => onSaved()} />}
      <UiSettingsContributions slot="settings.connection.detail" onConnectionChanged={() => onSaved()} input={{ kind: 'settings.connection', connection: current, locale: language, theme }} />
      <div className="model-heading model-divider"><h3>{text('模型', 'Models')}</h3><button disabled={!!newProfile} onClick={() => setNewProfile(newModel(draft, adapter))}>{text('添加模型', 'Add model')}</button></div>
      {models.map(profile => <ModelEditor key={profile.id} profile={profile} adapter={adapter} defaultId={defaultId} onSaved={() => onSaved()} />)}
      {newProfile && <ModelEditor key={newProfile.id} profile={newProfile} adapter={adapter} onSaved={async () => { await onSaved(); setNewProfile(null); }} onRemove={() => setNewProfile(null)} />}
      <div className="model-actions model-divider"><button onClick={() => void onSaved()}>{text('重新加载', 'Reload')}</button><button className="model-danger model-push" disabled={busy || models.length > 0} onClick={async () => {
        setBusy(true); try { data(await patchModelConnections({ removeConnectionId: draft.id })); await onSaved(); onBack(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}>{text('移除连接', 'Remove connection')}</button>{models.length > 0 && <Hint>{text('先移除连接下的模型，再移除连接。', 'Remove the models before removing this connection.')}</Hint>}</div>
    </>}
  </>;
}

export default function LlmSection({ active = true }: { active?: boolean }) {
  const interaction = useInteractionFocus();
  const { text, language } = useModelLanguage();
  const theme = useDisplayTheme();
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [catalog, setCatalog] = useState<ConnectionsResult | null>(null);
  const [profiles, setProfiles] = useState<LlmProfilesResult | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('[data-escape-layer="open"]'))) return;
      if (page.kind === 'list') return;
      event.preventDefault(); event.stopPropagation();
      const origin = captureFocusReturn();
      setPage({ kind: 'list' });
      requestAnimationFrame(() => returnInteractionFocus({ ...origin, target: addButton.current }, interaction?.keyboard ?? true));
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [active, page.kind, interaction]);
  const refresh = useCallback(async (id?: string) => {
    const [connectionsResult, profilesResult] = await Promise.all([getModelConnections(), getLlmProfiles()]);
    setCatalog(data(connectionsResult));
    // An invalid default still exposes editable profiles; the original error remains visible.
    if (profilesResult.data) setProfiles(profilesResult.data);
    if (!profilesResult.ok) setError(profilesResult.message ?? profilesResult.error ?? 'Profile read failed');
    else { setError(''); await useLocalAgentStore.getState().refreshProfiles(); }
    setRevision(n => n + 1);
    if (id) setPage({ kind: 'connection', id });
  }, []);
  useEffect(() => { setLoading(true); void refresh().catch(e => setError(message(e))).finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(); setUsageError(''); setUsage(null);
    void queryModelUsage(periodQuery(30), controller.signal).then(result => { if (controller.signal.aborted) return; try { setUsage(data(result)); } catch (e) { setUsageError(message(e)); } });
    return () => controller.abort();
  }, [revision]);
  useSettingsSearchEntries('llm', [{ id: 'llm-connections', category: 'llm', title: text('模型与服务', 'Models & services'), keywords: 'API Coding Plan OpenAI Codex subagent delegation 子代理 协作成员 并发 连接 模型 用量 订阅' }]);
  const current = page.kind === 'connection' ? catalog?.connections.find(c => c.id === page.id) : undefined;
  const goBack = () => setPage({ kind: 'list' });
  const reorder = async (id: string, delta: number) => {
    if (!catalog) return;
    const order = catalog.connections.map(c => c.id); const index = order.indexOf(id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    try { setCatalog(data(await patchModelConnections({ order }))); } catch (e) { setError(message(e)); }
  };
  return <section className="model-services" id="llm-connections">
    {page.kind !== 'list' && <nav className="model-breadcrumb"><button onClick={goBack}>← {text('模型与服务', 'Models & services')}</button><span>›</span><span>{page.kind === 'usage' ? text('用量统计', 'Usage') : page.kind === 'web' ? text('Web 工具', 'Web tools') : current?.name ?? text('添加连接', 'Add connection')}</span></nav>}
    {error && <div className="settings-error" role="alert">{error}</div>}
    {loading && <div role="status">{text('正在读取…', 'Loading…')}</div>}
    {page.kind === 'list' && <>
      <div className="model-heading"><h2>{text('模型与服务', 'Models & services')}</h2><div className="model-connection-entry"><button ref={addButton} onClick={() => setPage({ kind: 'new', mode: 'metered' })}>+ {text('API 连接', 'API connection')}</button><button onClick={() => setPage({ kind: 'new', mode: 'subscription' })}>+ Coding Plan</button></div></div>
      <div className="model-actions model-subheading"><span>{text('最近使用', 'Last used')} · {profiles?.profiles.find(p => p.id === profiles.defaultProfileId)?.name ?? '—'}</span><button className="model-push" onClick={() => setPage({ kind: 'usage' })}>{text('用量统计', 'Usage')} ↗</button></div>
      {profiles && <ApprovalReviewerModel profiles={profiles.profiles} connections={profiles.connections} />}
      {profiles && <SubagentSettings profiles={profiles.profiles} connections={profiles.connections} />}
      {catalog && (['metered', 'subscription'] as const).map(mode => {
        const list = catalog.connections.filter(c => c.billingMode === mode);
        return <section className="model-connection-group" key={mode}><div className="model-heading"><h3>{mode === 'metered' ? text('API 连接', 'API connections') : 'Coding Plan'}</h3><span>{text('近 30 天', 'Last 30 days')}{mode === 'metered' && <Hint>{text('显示已记录请求的 API 费用估算，非服务方账单。', 'Estimated cost of recorded requests; not a provider invoice.')}</Hint>}</span></div>
          {list.length === 0 ? <div className="model-empty">{text('暂无连接', 'No connections')}</div> : list.map(c => {
            const stat = usage?.connections.find(v => v.connectionId === c.id);
            const index = catalog!.connections.findIndex(v => v.id === c.id);
            return <div className="model-connection-row" key={c.id}>
              <button className="model-connection-open" onClick={() => setPage({ kind: 'connection', id: c.id })}><span className={`model-status model-status--${c.authStatus}`} /><span><strong>{c.name}</strong><small>{c.credentialKind === 'oauth' ? c.account?.label ?? text('未登录', 'Signed out') : `${catalog?.adapters.find(a => a.id === c.adapterId)?.name ?? c.adapterId} · ${c.authStatus === 'ready' ? text('已配置', 'Configured') : text('待配置', 'Not configured')}`} · {profiles?.profiles.filter(p => p.connectionId === c.id && p.enabled).length ?? 0} {text('个模型', 'models')}</small></span></button>
              <button className="model-connection-usage" onClick={() => setPage({ kind: 'usage', connectionId: c.id })}>{mode === 'metered' ? <Cost totals={stat} /> : <span>{stat?.reportedCalls ? (stat.inputTokens + stat.outputTokens).toLocaleString() : '—'} tokens</span>}<small>{stat?.calls ?? (usage ? 0 : '—')} {text('次调用', 'calls')}</small></button>
              <div className="model-reorder"><button aria-label={text('上移', 'Move up')} disabled={index === 0} onClick={() => void reorder(c.id, -1)}>↑</button><button aria-label={text('下移', 'Move down')} disabled={index === (catalog?.connections.length ?? 0)-1} onClick={() => void reorder(c.id, 1)}>↓</button></div>
              <button aria-label={text('配置连接', 'Configure connection')} onClick={() => setPage({ kind: 'connection', id: c.id })}>›</button>
            </div>;
          })}
        </section>;
      })}
      {catalog && <UiSettingsContributions slot="settings.models.overview" input={{ kind: 'settings.models', connections: catalog.connections, adapters: catalog.adapters, locale: language, theme }} />}
      {usageError && <div className="settings-error" role="alert">{usageError}</div>}
      <div className="model-actions model-divider"><button onClick={() => setPage({ kind: 'web' })}>{text('Web 工具', 'Web tools')} ›</button><button className="model-push" onClick={() => void refresh().catch(e => setError(message(e)))}>{text('重新加载', 'Reload')}</button></div>
    </>}
    {catalog && profiles && (page.kind === 'new' || current) && <ConnectionDetail key={current?.id ?? (page.kind === 'new' ? page.mode : '')} current={current} adapters={catalog.adapters} profiles={profiles.profiles} defaultId={profiles.defaultProfileId} mode={current?.billingMode ?? (page.kind === 'new' ? page.mode : 'metered')} onMode={mode => setPage({ kind: 'new', mode })} onSaved={refresh} onBack={goBack} />}
    {page.kind === 'usage' && catalog && <UsageView connections={catalog.connections} initialConnection={page.connectionId} />}
    {page.kind === 'web' && <AgentSettingsSection category="services" />}
  </section>;
}
