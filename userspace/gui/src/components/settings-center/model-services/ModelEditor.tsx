import ToggleSwitch from '../../shared/ToggleSwitch';
import { useAutoDismiss } from '../../shared/useAutoDismiss';
import NativeSelect from '../../shared/NativeSelect';
import { modelReasoningEfforts } from '@deepcode/protocol';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useState } from 'react';
import type { LlmProviderProfile, ProviderAdapterDescriptor } from '@deepcode/protocol';
import { patchLlmProfiles, probeLlmProfile } from '../../../services/apiClient';
import { useModelLanguage, data, message, Hint } from './shared';

export default function ModelEditor({ profile, adapter, defaultId, onSaved, onRemove }: {
  profile: LlmProviderProfile; adapter: ProviderAdapterDescriptor; defaultId?: string;
  onSaved(): Promise<void>; onRemove?(): void;
}) {
  const { text, language } = useModelLanguage();
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  useAutoDismiss(!failed && feedback, () => setFeedback(''));
  useInterfaceReloadGuard(!!onRemove || JSON.stringify(draft) !== JSON.stringify(profile), profile.name, busy);
  const set = <K extends keyof LlmProviderProfile>(key: K, value: LlmProviderProfile[K]) => setDraft(p => ({ ...p, [key]: value }));
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setFeedback(''); setFailed(false);
    try { await action(); } catch (error) { setFailed(true); setFeedback(message(error)); } finally { setBusy(false); }
  };
  return <details className="model-editor" open={onRemove ? true : undefined}>
    <summary><strong>{profile.name}</strong><span>{profile.model}{profile.id === defaultId ? ` · ${text('最近使用', 'Last used')}` : ''}</span></summary>
    <form onSubmit={e => { e.preventDefault(); void perform(async () => { data(await patchLlmProfiles({ profile: draft })); await onSaved(); setFeedback(text('已保存', 'Saved')); }); }}>
      <fieldset disabled={busy}>
        <div className="model-form-grid">
          <label>{text('显示名称', 'Display name')}<input required value={draft.name} onChange={e => set('name', e.target.value)} /></label>
          <label>{text('模型', 'Model')}<input required value={draft.model} list={`models-${profile.id}`} onChange={e => set('model', e.target.value)} /><datalist id={`models-${profile.id}`}>{adapter.models.map(m => <option key={m.model} value={m.model} />)}</datalist></label>
          <label className="model-wide">{text('API 协议', 'API protocol')}<NativeSelect value={draft.kind} onChange={e => setDraft(p => ({ ...p, kind: e.target.value as LlmProviderProfile['kind'], hostedWebSearch: undefined }))}>{adapter.protocols.map(kind => <option key={kind} value={kind}>{kind === 'responses' ? 'Responses API' : kind === 'openaiCompatible' ? 'Chat Completions' : kind === 'anthropic' ? 'Anthropic Messages' : 'Ollama'}</option>)}</NativeSelect></label>
          <label>{text('上下文窗口', 'Context window')}<input type="number" required min="2" value={draft.contextWindowTokens ?? ''} onChange={e => set('contextWindowTokens', e.target.valueAsNumber)} /></label>
          <label>{text('最大输出', 'Maximum output')}<input type="number" required min="1" max={(draft.contextWindowTokens ?? 2)-1} value={draft.maxOutputTokens ?? ''} onChange={e => set('maxOutputTokens', e.target.valueAsNumber)} /></label>
          <label>{text('联网搜索', 'Web search')}<NativeSelect disabled={draft.kind !== 'responses'} title={draft.kind === 'responses' ? undefined : text('当前协议未接入服务原生搜索', 'Provider search is unavailable for this protocol')} value={draft.hostedWebSearch ?? ''} onChange={e => set('hostedWebSearch', e.target.value ? 'web_search' : undefined)}><option value="">{text('关闭', 'Off')}</option><option value="web_search">{text('服务原生搜索', 'Provider search')}</option></NativeSelect></label>
          <label>{text('图片输入', 'Image input')}<NativeSelect value={draft.imageInput === undefined ? '' : String(draft.imageInput)} onChange={e => set('imageInput', e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">{text('模型预设', 'Model preset')}</option><option value="true">{text('支持', 'Supported')}</option><option value="false">{text('不支持', 'Unsupported')}</option></NativeSelect></label>
        </div>
        <details className="model-advanced"><summary>{text('更多参数', 'More options')}</summary><div className="model-form-grid">
          <label>Thinking<NativeSelect value={draft.thinking ?? ''} onChange={e => set('thinking', (e.target.value || undefined) as LlmProviderProfile['thinking'])}><option value="">{t(language, 'settings.llm.serviceDefault')}</option><option value="enabled">{text('启用', 'Enabled')}</option><option value="disabled">{text('关闭', 'Disabled')}</option></NativeSelect></label>
          <label>{t(language, 'settings.llm.reasoningEffort')}<NativeSelect value={draft.reasoningEffort ?? ''} disabled={draft.thinking === 'disabled'} onChange={e => set('reasoningEffort', (e.target.value || undefined) as LlmProviderProfile['reasoningEffort'])}><option value="">{t(language, 'settings.llm.serviceDefault')}</option>{modelReasoningEfforts(draft).map(value => <option key={value} value={value}>{t(language, `settings.llm.effort.${value}`)}</option>)}</NativeSelect></label>
          <label>Temperature<input type="number" step="0.1" min="0" max="2" value={draft.temperature ?? ''} onChange={e => set('temperature', e.target.value === '' ? undefined : e.target.valueAsNumber)} /></label>
          {adapter.id === 'custom' && <label>{text('协议行为', 'Protocol behavior')}<NativeSelect value={draft.providerFlavor} onChange={e => set('providerFlavor', e.target.value as LlmProviderProfile['providerFlavor'])}>{['openai','deepseek','zhipu','moonshot'].map(v => <option key={v}>{v}</option>)}</NativeSelect></label>}
        </div></details>
        <div className="model-actions"><label className="model-check"><ToggleSwitch checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} />{text('启用', 'Enabled')}</label>
          <button type="button" disabled={!!onRemove} onClick={() => void perform(async () => { const result = data(await probeLlmProfile({ profileId: profile.id })); if (!result.ok) throw new Error(result.error); setFeedback(`${text('连接可用', 'Connected')} · ${result.latencyMs} ms`); })}>{text('探测', 'Test')}</button><Hint>{text('使用已保存的配置发送一次短请求，计入实际用量。', 'Send a short request using saved settings. It counts towards usage.')}</Hint>
          {!onRemove && profile.id !== defaultId && <button type="button" disabled={!profile.enabled} onClick={() => void perform(async () => { data(await patchLlmProfiles({ defaultProfileId: profile.id })); await onSaved(); })}>{text('设为最近使用', 'Use by default')}</button>}
          <button className="model-danger" type="button" onClick={() => onRemove ? onRemove() : void perform(async () => { data(await patchLlmProfiles({ removeProfileId: profile.id })); await onSaved(); })}>{text('移除', 'Remove')}</button>
          <button className="model-primary model-push" type="submit">{text('保存此模型', 'Save model')}</button>
        </div>
      </fieldset>
      {feedback && <div className={failed ? 'settings-error' : 'model-feedback'} role={failed ? 'alert' : 'status'}>{feedback}</div>}
    </form>
  </details>;
}
