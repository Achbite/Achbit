import { useEffect, useState, type CSSProperties } from 'react';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@deepcode/protocol';
import NativeSelect from '../shared/NativeSelect';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { CODE_FONT_SIZE_SETTING, CONTENT_FONT_FAMILY_SETTING, CONTENT_FONT_SIZE_SETTING, FONT_SETTING_KEYS,
  INTERFACE_FONT_FAMILY_SETTING, TERMINAL_FONT_FAMILY_SETTING, UI_FONT_FAMILY_SETTING, UI_FONT_SIZE_SETTING,
  UI_FONT_PRESETS, fontChoice, typographyStyles, uiFontFamily } from '../../theme/typography';
import { useSettingsSearchEntries, useSettingsSearchTarget } from './settingsSearch';
import { reconcileSettingDraft } from './settingDraft';

const GROUPS = [
  { id: 'interface', family: INTERFACE_FONT_FAMILY_SETTING, size: UI_FONT_SIZE_SETTING, minimum: 12 },
  { id: 'content', family: CONTENT_FONT_FAMILY_SETTING, size: CONTENT_FONT_SIZE_SETTING, minimum: 12 },
  { id: 'terminal', family: TERMINAL_FONT_FAMILY_SETTING, size: CODE_FONT_SIZE_SETTING, minimum: 10 },
] as const;
const fontSnapshot = (settings: UserSettings) => JSON.stringify(Object.fromEntries(
  FONT_SETTING_KEYS.map(key => [key, settings[key] ?? DEFAULT_USER_SETTINGS[key]]),
));

export default function GuiFontSettings({ language }: { language: UiLanguage }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const saved = fontSnapshot(settings);
  const [draft, setDraft] = useState({ saved, text: saved });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState(false);
  useInterfaceReloadGuard(draft.text !== saved, t(language, 'settings.font.title'), saving);
  useEffect(() => setDraft((current) => reconcileSettingDraft(current, saved)), [saved]);
  const values = JSON.parse(draft.text) as UserSettings;
  const target = useSettingsSearchTarget(UI_FONT_FAMILY_SETTING);
  useSettingsSearchEntries('ui-font', [{ id: UI_FONT_FAMILY_SETTING, category: 'gui', title: t(language, 'settings.font.title'), keywords: 'UI 界面 内容 终端 字体 字号 代码 font family size typography code terminal' }]);
  const edit = (key: string, value: string | number) => {
    setDraft(current => {
      const next = { ...JSON.parse(current.text), [key]: value };
      // Choosing the default applies it to all groups; details can override it again.
      if (key === UI_FONT_FAMILY_SETTING) for (const group of GROUPS) next[group.family] = 'inherit';
      return { ...current, text: JSON.stringify(next) };
    });
    if (key === UI_FONT_FAMILY_SETTING) setCustom(current => ({ [key]: Boolean(current[key]) }));
    setError(null);
  };
  let preview: CSSProperties | undefined;
  try { preview = typographyStyles(values) as CSSProperties; }
  catch { /* Keep invalid drafts editable; Save reports validation. */ }
  const familyName = (family: string) => Object.hasOwn(UI_FONT_PRESETS, family) ? t(language, `settings.font.${family}`) : family;
  const picker = (key: string, label: string, inherit = false) => {
    const family = String(values[key]);
    const selected = !custom[key] && (family === 'inherit' || Object.hasOwn(UI_FONT_PRESETS, family)) ? family : 'custom';
    return <div className="appearance-font-choice">
      <label>{label}<NativeSelect value={selected} disabled={loading || saving} onChange={event => {
        const next = event.target.value;
        setCustom(current => ({ ...current, [key]: next === 'custom' }));
        if (next !== 'custom') edit(key, next);
      }}>
        {inherit && <option value="inherit">{t(language, 'settings.font.inherit')} · {familyName(String(values[UI_FONT_FAMILY_SETTING]))}</option>}
        {[...Object.keys(UI_FONT_PRESETS), 'custom'].map(value => <option key={value} value={value}>{t(language, `settings.font.${value}`)}</option>)}
      </NativeSelect></label>
      {selected === 'custom' && <label>{t(language, 'settings.font.customName')}<input
        value={family === 'inherit' || Object.hasOwn(UI_FONT_PRESETS, family) ? '' : family}
        placeholder="PingFang SC" disabled={loading || saving} onChange={event => edit(key, event.target.value)} /></label>}
    </div>;
  };
  const save = async (reset = false) => {
    setSaving(true); setError(null);
    try {
      if (!reset) typographyStyles(values);
      const result = await useSettingsStore.getState().patchUserSettingsBatch(reset
        ? Object.fromEntries(FONT_SETTING_KEYS.map(key => [key, null])) : values);
      if (result === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
      const text = fontSnapshot(useSettingsStore.getState().effectiveSettings);
      setDraft({ saved: text, text });
      setCustom({});
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <section ref={target} tabIndex={-1} className="settings-card appearance-config-box appearance-fonts" aria-labelledby="ui-font-heading">
    <h3 id="ui-font-heading" className="settings-card__title">{t(language, 'settings.font.title')}</h3>
    <div className="appearance-config-box__body">
      {picker(UI_FONT_FAMILY_SETTING, t(language, 'settings.font.default'))}
      {!expanded && <div className="appearance-font-preview" style={preview}>
        <span className="appearance-font-preview__interface">DeepCode · {t(language, 'settings.font.interfacePreview')}</span>
        <p className="appearance-font-preview__content">{t(language, 'settings.font.preview')}</p>
        <code className="appearance-font-preview__code">const message = "你好，DeepCode";</code>
      </div>}
      <details className="appearance-font-details" onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary><DeepCodeShellIcon name="chevronRight" size={14} />{t(language, 'settings.font.details')}</summary>
        <div className="appearance-font-groups">
          {GROUPS.map(group => {
            let family: string | undefined;
            try { family = uiFontFamily(fontChoice(values, group.family), group.id === 'terminal'); } catch { /* Invalid custom draft. */ }
            return <fieldset className="appearance-font-group" key={group.id}>
              <legend>{t(language, `settings.font.${group.id}`)}</legend>
              <div className="appearance-font-group__controls">
                {picker(group.family, t(language, 'settings.font.family'), true)}
                <label>{t(language, 'settings.font.size')}<NativeSelect value={Number(values[group.size])} disabled={loading || saving}
                  onChange={event => edit(group.size, Number(event.target.value))}>
                  {Array.from({ length: 19 - group.minimum }, (_, index) => group.minimum + index).map(size => <option key={size} value={size}>{size} px</option>)}
                </NativeSelect></label>
              </div>
              <div className={`appearance-font-group__sample appearance-font-group__sample--${group.id}`} style={{ fontFamily: family, fontSize: Number(values[group.size]) }}>
                {group.id === 'terminal' ? <code>const message = "你好，DeepCode"; // 0123456789</code>
                  : group.id === 'interface' ? t(language, 'settings.font.interfacePreview') : t(language, 'settings.font.preview')}
              </div>
            </fieldset>;
          })}
        </div>
      </details>
      <div className="appearance-config-box__actions">
        <button type="button" className="settings-button" disabled={loading || saving} onClick={() => void save(true)}>{t(language, 'settings.reset')}</button>
        <button type="button" className="settings-button settings-button--primary" disabled={loading || saving || draft.text === saved || !preview}
          onClick={() => void save()}>{t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}</button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </section>;
}
