import { useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { REASONING_CONTROL_SETTING, reasoningControlStyle, type ReasoningControlStyle } from '../local-agent/reasoningControlStyle';
import { useSettingsSearchEntries, useSettingsSearchTarget } from './settingsSearch';

export default function ReasoningControlSettings({ language }: { language: UiLanguage }) {
  const identity = useUiOwner('settings.reasoningControl');
  const value = useSettingsStore(state => state.effectiveSettings[REASONING_CONTROL_SETTING]);
  const loading = useSettingsStore(state => state.loading);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useSettingsSearchTarget(REASONING_CONTROL_SETTING);
  const title = t(language, 'settings.reasoningControl.title');
  useInterfaceReloadGuard(false, title, saving);
  useSettingsSearchEntries('reasoning-control', [{ id: REASONING_CONTROL_SETTING, category: 'gui', title,
    keywords: '思考 推理 强度 分段 按钮 滑条 reasoning effort segments slider' }]);
  let selected: ReasoningControlStyle | null = null, configError: string | null = null;
  try { selected = reasoningControlStyle(value); } catch (cause) { configError = String(cause); }
  const save = async (style: ReasoningControlStyle) => {
    if (saving || loading) return;
    setSaving(true); setError(null);
    try {
      const activation = await useSettingsStore.getState().patchUserSetting(REASONING_CONTROL_SETTING, style);
      if (!activation) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <section {...identity.part('root')} className="settings-card appearance-config-box appearance-reasoning-control">
    <h3 ref={target} className="settings-card__title">{title}</h3>
    <div className="appearance-config-box__body">
      <div className="appearance-reasoning-choices" role="radiogroup" aria-label={title} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (buttons.indexOf(document.activeElement as HTMLButtonElement) + 1) % buttons.length;
        buttons[index]?.focus(); buttons[index]?.click();
      }}>
        {(['segments', 'slider'] as const).map(style => <button key={style} {...identity.action('select-style', 'click', { style })}
          type="button" role="radio" aria-checked={selected === style} disabled={saving || loading}
          onClick={() => void save(style)} className="appearance-reasoning-choice">
          <strong>{t(language, `settings.reasoningControl.${style}`)}</strong>
          <span className={`appearance-reasoning-choice__${style}`} aria-hidden="true">{style === 'segments' && <><i /><i /><i /><i /><i /></>}</span>
        </button>)}
      </div>
      {(configError || error) && <p className="settings-error" role="alert">{configError || error}</p>}
    </div>
  </section>;
}
