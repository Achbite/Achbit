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
import { reconcileJsonSettingDraft } from './settingDraft';

const GROUPS = [
  { id: 'interface', family: INTERFACE_FONT_FAMILY_SETTING, size: UI_FONT_SIZE_SETTING, minimum: 12 },
  { id: 'content', family: CONTENT_FONT_FAMILY_SETTING, size: CONTENT_FONT_SIZE_SETTING, minimum: 12 },
  { id: 'terminal', family: TERMINAL_FONT_FAMILY_SETTING, size: CODE_FONT_SIZE_SETTING, minimum: 10 },
] as const;
const FAMILY_KEYS = [UI_FONT_FAMILY_SETTING, ...GROUPS.map(group => group.family)];
const fontSnapshot = (settings: UserSettings) => JSON.stringify(Object.fromEntries(
  FONT_SETTING_KEYS.map(key => [key, settings[key] ?? DEFAULT_USER_SETTINGS[key]]),
));
const familyPatch = (key: string, value: string): UserSettings => ({ [key]: value,
  ...(key === UI_FONT_FAMILY_SETTING ? Object.fromEntries(GROUPS.map(group => [group.family, 'inherit'])) : {}),
});

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
  useEffect(() => setDraft(current => reconcileJsonSettingDraft(current, saved)), [saved]);
  const values = JSON.parse(draft.text) as UserSettings;
  const savedValues = JSON.parse(saved) as UserSettings;
  const textChanges = FAMILY_KEYS.filter(key => values[key] !== savedValues[key]);
  const target = useSettingsSearchTarget(UI_FONT_FAMILY_SETTING);
  useSettingsSearchEntries('ui-font', [{ id: UI_FONT_FAMILY_SETTING, category: 'gui', title: t(language, 'settings.font.title'), keywords: 'UI 界面 内容 终端 字体 字号 代码 font family size typography code terminal' }]);
  const edit = (key: string, value: string) => {
    setDraft(current => ({ ...current, text: JSON.stringify({ ...JSON.parse(current.text), ...familyPatch(key, value) }) }));
    setError(null);
  };
  const save = async (patches: UserSettings) => {
    setSaving(true); setError(null);
    try {
      const state = useSettingsStore.getState();
      typographyStyles({ ...state.effectiveSettings, ...patches });
      const result = await state.patchUserSettingsBatch(patches);
      if (result === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
      const canonical = fontSnapshot(useSettingsStore.getState().effectiveSettings);
      setDraft(current => reconcileJsonSettingDraft(current, canonical, Object.keys(patches)));
      setCustom(current => Object.fromEntries(Object.entries(current).filter(([key]) => !Object.hasOwn(patches, key))));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  let preview: CSSProperties | undefined;
  try { preview = typographyStyles(values) as CSSProperties; }
  catch { /* Keep custom text editable; confirmation reports validation. */ }
  const familyName = (family: string) => Object.hasOwn(UI_FONT_PRESETS, family) ? t(language, `settings.font.${family}`) : family;
  const picker = (key: string, label: string, inherit = false) => {
    const family = String(values[key]);
    const selected = !custom[key] && (family === 'inherit' || Object.hasOwn(UI_FONT_PRESETS, family)) ? family : 'custom';
    return <div className="appearance-font-choice">
      <label>{label}<NativeSelect value={selected} disabled={loading || saving} onChange={event => {
        const next = event.target.value;
        if (next === 'custom') setCustom(current => ({ ...current, [key]: true }));
        else void save(familyPatch(key, next));
      }}>
        {inherit && <option value="inherit">{t(language, 'settings.font.inherit')} · {familyName(String(values[UI_FONT_FAMILY_SETTING]))}</option>}
        {[...Object.keys(UI_FONT_PRESETS), 'custom'].map(value => <option key={value} value={value}>{t(language, `settings.font.${value}`)}</option>)}
      </NativeSelect></label>
      {selected === 'custom' && <label>{t(language, 'settings.font.customName')}<input
        value={family === 'inherit' || Object.hasOwn(UI_FONT_PRESETS, family) ? '' : family}
        placeholder="PingFang SC" disabled={loading || saving} onChange={event => edit(key, event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.repeat) {
            event.preventDefault(); event.stopPropagation(); void save(familyPatch(key, event.currentTarget.value));
          }
        }} /></label>}
    </div>;
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
                  onChange={event => void save({ [group.size]: Number(event.target.value) })}>
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
      {textChanges.length > 0 && <div className="appearance-config-box__actions">
        <button type="button" className="settings-button settings-button--primary" disabled={loading || saving || !preview}
          onClick={() => void save(Object.fromEntries(textChanges.map(key => [key, values[key]])))}>{t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}</button>
      </div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </section>;
}
