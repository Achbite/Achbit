import { useRef, useState } from 'react';
import type { LlmProviderProfile, ModelConnection, ProviderAdapterDescriptor } from '@achbit/protocol';
import { Button, CloseButton, ModalDialog, PanelHeader, UiIcon } from '../../../ui-components';
import { useUiOwner } from '../../../ui-ownership/useUiOwner';
import { patchLlmProfiles } from '../../../services/apiClient';
import ModelEditor from './ModelEditor';
import { data, message, useModelLanguage } from './shared';
import './modelPicker.css';

export default function ModelPickerDialog({ connection, adapter, onClose, onSaved }: {
  connection: ModelConnection; adapter: ProviderAdapterDescriptor; onClose(): void; onSaved(): Promise<void>;
}) {
  const { text, language } = useModelLanguage();
  const owner = useUiOwner('settings.model-picker', undefined, { connectionId: connection.id });
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog');
  const [visitedCustom, setVisitedCustom] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  // One draft identity per opening, including a retry after a failed readback.
  const [custom] = useState<LlmProviderProfile>(() => ({ id: `model:${crypto.randomUUID()}`, connectionId: connection.id,
    name: '', model: '', kind: adapter.protocols[0], providerFlavor: adapter.models[0]?.providerFlavor ?? 'openai',
    contextWindowTokens: 128000, maxOutputTokens: 16000, enabled: true }));
  const words = query.trim().toLocaleLowerCase().split(/\s+/u);
  const candidates = adapter.models.filter(model => words.every(word => `${model.name} ${model.model}`.toLocaleLowerCase().includes(word)));
  const preset = candidates.find(model => model.model === selected);
  const add = async () => {
    if (!preset || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const profile = { ...preset, id: custom.id, connectionId: connection.id };
      const saved = data(await patchLlmProfiles({ profile }));
      if (!saved.profiles.some(item => item.id === profile.id)) throw new Error(text('保存结果中没有此模型。', 'Saved model is missing from the response.'));
      await onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <ModalDialog className="achbit-gui-text-dialog-backdrop model-picker-backdrop" aria-label={text('添加模型', 'Add model')} busy={busy} onClose={onClose}>
    <section {...owner.part('dialog')} className="achbit-gui-text-dialog model-picker-dialog">
      <PanelHeader><h2>{text('添加模型', 'Add model')}</h2><CloseButton {...owner.action('close', 'click')} aria-label={text('关闭', 'Close')} disabled={busy} onClick={onClose} /></PanelHeader>
      <div className="model-picker-context">{connection.name}{connection.name !== adapter.name && <span>{adapter.name}</span>}</div>
      <div className="model-picker-tabs" role="group" aria-label={text('模型来源', 'Model source')}>
        <Button {...owner.action('catalog', 'click')} aria-pressed={mode === 'catalog'} disabled={busy} onClick={() => setMode('catalog')}>{text('提供商型号', 'Provider models')}</Button>
        <Button {...owner.action('custom', 'click')} aria-pressed={mode === 'custom'} disabled={busy} onClick={() => { setVisitedCustom(true); setMode('custom'); }}>{text('自定义模型', 'Custom model')}</Button>
      </div>
      {mode === 'catalog' && <>
        <div className="model-picker-body">
          <input {...owner.action('search', 'type')} className="settings-field__input" aria-label={text('搜索模型', 'Search models')} placeholder={text('搜索名称或模型 ID', 'Search name or model ID')}
            value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
          <div className="model-picker-list" role="listbox" aria-label={text('可选型号', 'Available models')} onKeyDown={event => {
            if (busy || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=option]')];
            const index = rows.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            rows[next]?.focus(); if (candidates[next]) setSelected(candidates[next].model);
          }}>
            {candidates.map((model, i) => <Button {...owner.action('choose', 'click', { model: model.model })} key={model.model} role="option" aria-selected={preset === model}
              tabIndex={preset === model || !preset && i === 0 ? 0 : -1} className="model-picker-candidate" disabled={busy} onClick={() => setSelected(model.model)}>
              <span className="model-picker-candidate__name"><strong>{model.name}</strong><code>{model.model}</code></span>
              <span className="model-picker-candidate__meta">{model.contextWindowTokens != null && <small>{model.contextWindowTokens.toLocaleString(language)} {text('上下文', 'context')}</small>}
                <span className="model-picker-candidate__check" aria-hidden="true"><UiIcon name="check" size={14} /></span></span>
            </Button>)}
          </div>
          {!candidates.length && <p className="model-picker-empty">{adapter.models.length ? text('没有匹配的型号', 'No matching models') : text('此提供商没有内置型号模板，可添加自定义模型。', 'This provider has no model templates. Add a custom model.')}</p>}
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
        <footer><span className="model-picker-status" role="status">{busy ? text('正在添加…', 'Adding…') : preset?.model ?? text('请选择具体型号', 'Choose a model')}</span>
          <Button {...owner.action('cancel', 'click')} variant="secondary" disabled={busy} onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button {...owner.action('add', 'click')} variant="primary" disabled={busy || !preset} onClick={() => void add()}>{text('添加模型', 'Add model')}</Button>
        </footer>
      </>}
      {visitedCustom && <div hidden={mode !== 'custom'} className="model-picker-body model-services"><ModelEditor profile={custom} adapter={adapter} onRemove={onClose} onBusyChange={setBusy} onSaved={onSaved} /></div>}
    </section>
  </ModalDialog>;
}
