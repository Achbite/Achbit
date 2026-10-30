import ToggleSwitch from '../../shared/ToggleSwitch';
import { useAutoDismiss } from '../../shared/useAutoDismiss';
import NativeSelect from '../../shared/NativeSelect';
import ConfirmedNumberInput from '../../shared/ConfirmedNumberInput';
import { modelReasoningEfforts, modelThinkingModes } from '@achbit/protocol';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useEffect, useRef, useState } from 'react';
import type { LlmProviderProfile, ProviderAdapterDescriptor } from '@achbit/protocol';
import { patchLlmProfiles, probeLlmProfile } from '../../../services/apiClient';
import { reconcileSettingFields } from '../settingDraft';
import { useModelLanguage, data, message, Hint } from './shared';

// Applying a preset is an explicit action on a new, unsaved profile only.
export function selectNewModelPreset(profile: LlmProviderProfile, adapter: ProviderAdapterDescriptor, model: string): LlmProviderProfile {
  const preset = adapter.models.find(item => item.model === model);
  if (!preset) return { ...profile, model };
  const name = !profile.name || adapter.models.some(item => item.name === profile.name) || profile.name === profile.model ? preset.name : profile.name;
  return { ...preset, id: profile.id, connectionId: profile.connectionId, name };
}

export default function ModelEditor({ profile, adapter, defaultId, onSaved, onRemove }: {
  profile: LlmProviderProfile; adapter: ProviderAdapterDescriptor; defaultId?: string;
  onSaved(): Promise<void>; onRemove?(): void;
}) {
  const { text, language } = useModelLanguage();
  const [draft, setDraft] = useState(profile);
  const [confirmed, setConfirmed] = useState(profile);
  const baseline = useRef(profile);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = profile; setConfirmed(profile);
    setDraft(current => reconcileSettingFields(current, previous, profile));
  }, [profile]);
  useAutoDismiss(!failed && feedback, () => setFeedback(''));
  const textDirty = draft.name !== confirmed.name || draft.model !== confirmed.model;
  useInterfaceReloadGuard(!!onRemove || textDirty, confirmed.name, busy);
  const set = <K extends keyof LlmProviderProfile>(key: K, value: LlmProviderProfile[K]) => setDraft(p => ({ ...p, [key]: value }));
  const perform = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setFeedback(''); setFailed(false);
    try { await action(); return true; }
    catch (error) { setFailed(true); setFeedback(message(error)); return false; }
    finally { setBusy(false); }
  };
  const persist = async (next: LlmProviderProfile, keys: readonly (keyof LlmProviderProfile)[]) => {
    const result = data(await patchLlmProfiles({ profile: next }));
    const saved = result.profiles.find(item => item.id === profile.id);
    if (!saved) throw new Error('Saved model is missing from the response.');
    const previous = baseline.current;
    baseline.current = saved; setConfirmed(saved);
    setDraft(current => {
      const merged = reconcileSettingFields(current, previous, saved);
      for (const key of keys) {
        if (Object.hasOwn(saved, key)) Object.assign(merged, { [key]: saved[key] });
        else delete merged[key];
      }
      return merged;
    });
    await onSaved();
  };
  const choose = async (patches: Partial<LlmProviderProfile>): Promise<boolean> => {
    if (onRemove) { setDraft(current => ({ ...current, ...patches })); return true; }
    return perform(() => persist({ ...baseline.current, ...patches }, Object.keys(patches) as (keyof LlmProviderProfile)[]));
  };
  const selected = onRemove ? draft : confirmed;
  const efforts = modelReasoningEfforts(selected);
  const thinkingModes = modelThinkingModes(selected);
  const unsupportedEffort = selected.reasoningEffort !== undefined && !efforts.includes(selected.reasoningEffort);
  const unsupportedThinking = selected.thinking !== undefined && !thinkingModes.includes(selected.thinking);
  const numeric = (key: 'contextWindowTokens' | 'maxOutputTokens' | 'temperature', label: string, constraints: { min: number; max?: number; step?: number; required?: boolean }) =>
    <ConfirmedNumberInput {...constraints} value={selected[key]} language={language} label={label} disabled={busy}
      onCommit={value => choose({ [key]: value })}
      {...(onRemove ? { onDraftChange: (value: number | undefined) => set(key, value) } : {})} />;
  return <details className="model-editor" open={onRemove ? true : undefined}>
    <summary><strong>{confirmed.name}</strong><span>{confirmed.model}{profile.id === defaultId ? ` · ${text('最近使用', 'Last used')}` : ''}</span></summary>
    <form noValidate={!onRemove} onSubmit={event => {
      event.preventDefault();
      if (!onRemove && !textDirty) return;
      void perform(async () => {
        await persist(onRemove ? draft : { ...baseline.current, name: draft.name, model: draft.model },
          onRemove ? Object.keys(draft) as (keyof LlmProviderProfile)[] : ['name', 'model']);
        setFeedback(text('已保存', 'Saved'));
      });
    }}>
      <fieldset disabled={busy}>
        <div className="model-form-grid">
          <label>{text('显示名称', 'Display name')}<input required value={draft.name} onChange={event => set('name', event.target.value)} /></label>
          <label>{text('模型', 'Model')}<input required value={draft.model} list={`models-${profile.id}`} onChange={event => { const model = event.target.value; setDraft(current => onRemove ? selectNewModelPreset(current, adapter, model) : { ...current, model }); }} /><datalist id={`models-${profile.id}`}>{adapter.models.map(model => <option key={model.model} value={model.model} />)}</datalist></label>
          <label className="model-wide">{text('API 协议', 'API protocol')}<NativeSelect value={selected.kind} onChange={event => void choose({ kind: event.target.value as LlmProviderProfile['kind'], hostedWebSearch: undefined,
            ...(event.target.value !== 'openaiCompatible' ? { fileInputMediaTypes: [] } : {}) })}>{adapter.protocols.map(kind => <option key={kind} value={kind}>{kind === 'responses' ? 'Responses API' : kind === 'openaiCompatible' ? 'Chat Completions' : kind === 'anthropic' ? 'Anthropic Messages' : 'Ollama'}</option>)}</NativeSelect></label>
          <label>{text('上下文窗口', 'Context window')}{numeric('contextWindowTokens', text('上下文窗口', 'Context window'), { min: 2, required: true })}</label>
          <label>{text('最大输出', 'Maximum output')}{numeric('maxOutputTokens', text('最大输出', 'Maximum output'), { min: 1, max: (selected.contextWindowTokens ?? 2) - 1, required: true })}</label>
          <label>{text('联网搜索', 'Web search')}<NativeSelect disabled={selected.kind !== 'responses'} title={selected.kind === 'responses' ? undefined : text('当前协议未接入服务原生搜索', 'Provider search is unavailable for this protocol')} value={selected.hostedWebSearch ?? ''} onChange={event => void choose({ hostedWebSearch: event.target.value ? 'web_search' : undefined })}><option value="">{text('关闭', 'Off')}</option><option value="web_search">{text('服务原生搜索', 'Provider search')}</option></NativeSelect></label>
          <label>{text('图片输入', 'Image input')}<NativeSelect value={selected.imageInput === undefined ? '' : String(selected.imageInput)} onChange={event => void choose({ imageInput: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">{text('模型预设', 'Model preset')}</option><option value="true">{text('支持', 'Supported')}</option><option value="false">{text('不支持', 'Unsupported')}</option></NativeSelect></label>
          <label>{text('PDF 输入', 'PDF input')}<NativeSelect disabled={selected.kind !== 'openaiCompatible'}
            title={selected.kind === 'openaiCompatible' ? undefined : text('当前协议尚未接入原生 PDF 输入', 'Native PDF input is unavailable for this protocol')}
            value={String(selected.fileInputMediaTypes?.includes('application/pdf') === true)}
            onChange={event => void choose({ fileInputMediaTypes: event.target.value === 'true' ? ['application/pdf'] : [] })}>
            <option value="false">{text('不支持', 'Unsupported')}</option><option value="true">{text('支持', 'Supported')}</option>
          </NativeSelect></label>
        </div>
        <details className="model-advanced"><summary>{text('更多参数', 'More options')}</summary><div className="model-form-grid">
          <label>Thinking<NativeSelect value={selected.thinking ?? ''} onChange={event => void choose({ thinking: (event.target.value || undefined) as LlmProviderProfile['thinking'] })}><option value="">{t(language, 'settings.llm.serviceDefault')}</option>{unsupportedThinking && <option value={selected.thinking} disabled>{text('关闭（当前模型不支持）', 'Disabled (unavailable for this model)')}</option>}{thinkingModes.map(value => <option key={value} value={value}>{value === 'enabled' ? text('启用', 'Enabled') : text('关闭', 'Disabled')}</option>)}</NativeSelect></label>
          <label>{t(language, 'settings.llm.reasoningEffort')}<NativeSelect value={selected.reasoningEffort ?? ''} disabled={selected.thinking === 'disabled' || efforts.length === 0 && !unsupportedEffort} onChange={event => void choose({ reasoningEffort: (event.target.value || undefined) as LlmProviderProfile['reasoningEffort'] })}><option value="">{t(language, 'settings.llm.serviceDefault')}</option>{unsupportedEffort && <option value={selected.reasoningEffort} disabled>{t(language, `settings.llm.effort.${selected.reasoningEffort}`)}</option>}{efforts.map(value => <option key={value} value={value}>{t(language, `settings.llm.effort.${value}`)}</option>)}</NativeSelect></label>
          {(unsupportedThinking || unsupportedEffort) && <p className="model-wide" role="alert">{text('已保存的思考参数不适用于此模型，请重新选择。', 'Saved thinking settings are unavailable for this model. Choose supported values.')}</p>}
          <label>Temperature{numeric('temperature', 'Temperature', { min: 0, max: 2, step: 0.1 })}</label>
          {adapter.id === 'custom' && <label>{text('协议行为', 'Protocol behavior')}<NativeSelect value={selected.providerFlavor} onChange={event => void choose({ providerFlavor: event.target.value as LlmProviderProfile['providerFlavor'] })}>{['openai','deepseek','zhipu','moonshot'].map(value => <option key={value}>{value}</option>)}</NativeSelect></label>}
        </div></details>
        <div className="model-actions"><label className="model-check"><ToggleSwitch checked={selected.enabled} onChange={event => void choose({ enabled: event.target.checked })} />{text('启用', 'Enabled')}</label>
          <button type="button" disabled={!!onRemove} onClick={() => void perform(async () => { const result = data(await probeLlmProfile({ profileId: profile.id })); if (!result.ok) throw new Error(result.error); setFeedback(`${text('连接可用', 'Connected')} · ${result.latencyMs} ms`); })}>{text('探测', 'Test')}</button><Hint>{text('使用已保存的配置发送一次短请求，计入实际用量。', 'Send a short request using saved settings. It counts towards usage.')}</Hint>
          {!onRemove && profile.id !== defaultId && <button type="button" disabled={!confirmed.enabled} onClick={() => void perform(async () => { data(await patchLlmProfiles({ defaultProfileId: profile.id })); await onSaved(); })}>{text('设为最近使用', 'Use by default')}</button>}
          <button className="model-danger" type="button" onClick={() => onRemove ? onRemove() : void perform(async () => { data(await patchLlmProfiles({ removeProfileId: profile.id })); await onSaved(); })}>{text('移除', 'Remove')}</button>
          {(onRemove || textDirty) && <button className="model-primary model-push" type="submit">{onRemove ? text('添加模型', 'Add model') : text('保存文本', 'Save text')}</button>}
        </div>
      </fieldset>
      {feedback && <div className={failed ? 'settings-error' : 'model-feedback'} role={failed ? 'alert' : 'status'}>{feedback}</div>}
    </form>
  </details>;
}
