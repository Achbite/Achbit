import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { useEffect, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { normalizeGuiAccentColor, normalizeGuiThemePreference, resolveGuiTheme, type GuiResolvedTheme } from '../../theme/achbitGuiTheme';
import {
  PALETTE_FIELDS, PALETTE_SETTING, decodePaletteOverrides, isPaletteColor,
  paletteColor, paletteToken, type PaletteOverrides,
} from '../../theme/palette';
import UiIcon from '../../icons/registry';
import { reconcileSettingDraft, reconcileJsonSettingDraft } from './settingDraft';
import { useSettingsSearchEntries, useSettingsSearchTarget } from './settingsSearch';

export default function GuiPaletteSettings({ language }: { language: UiLanguage }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const encoded = String(settings[PALETTE_SETTING] ?? '{}');
  const [draft, setDraft] = useState({ saved: encoded, text: encoded });
  const [theme, setTheme] = useState<GuiResolvedTheme>(() => resolveGuiTheme(
    normalizeGuiThemePreference(settings['gui.colorTheme']),
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useSettingsSearchTarget(PALETTE_SETTING);
  useSettingsSearchEntries('palette', [{ id: PALETTE_SETTING, category: 'gui',
    title: t(language, 'settings.palette.title'), keywords: t(language, 'settings.palette.keywords') }]);
  useEffect(() => setDraft(current => {
    try { return reconcileJsonSettingDraft(current, encoded); }
    catch { return reconcileSettingDraft(current, encoded); } // Invalid saved JSON remains visible below.
  }), [encoded]);

  const accent = normalizeGuiAccentColor(settings['gui.accentColor']);
  const dirty = draft.text !== encoded;
  useInterfaceReloadGuard(dirty, language === 'zh-CN' ? '配色' : 'Palette', saving);
  const disabled = loading || saving;
  let values: PaletteOverrides | null = null;
  let configError: string | null = null;
  try {
    // Draft hex text may be incomplete; validate it on Save, not while typing.
    decodePaletteOverrides(encoded);
    values = JSON.parse(draft.text) as PaletteOverrides;
  } catch (reason) { configError = String(reason); }
  const edit = (key: string, color: string) => {
    setDraft((current) => ({ ...current, text: JSON.stringify({ ...JSON.parse(current.text), [key]: color }) }));
    setError(null);
  };
  const save = async (next: string, confirmedKeys?: readonly string[]) => {
    setSaving(true); setError(null);
    try {
      decodePaletteOverrides(next);
      const state = useSettingsStore.getState();
      const activation = next === '{}' ? await state.resetUserSetting(PALETTE_SETTING)
        : await state.patchUserSetting(PALETTE_SETTING, next);
      if (activation === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
      const canonical = String(useSettingsStore.getState().effectiveSettings[PALETTE_SETTING] ?? '{}');
      setDraft(current => confirmedKeys ? reconcileJsonSettingDraft(current, canonical, confirmedKeys)
        : { saved: canonical, text: canonical });
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  const chooseColor = async (key: string, color: string) => {
    try {
      const current = decodePaletteOverrides(String(useSettingsStore.getState().effectiveSettings[PALETTE_SETTING] ?? '{}'));
      await save(JSON.stringify({ ...current, [key]: color }), [key]);
    } catch (reason) { setError(String(reason)); }
  };
  const label = (field: typeof PALETTE_FIELDS[number]) => t(language, `settings.palette.fields.${field}`);
  const color = (field: typeof PALETTE_FIELDS[number]) => paletteColor(values ?? {}, theme, field, accent);
  const previewColor = (field: typeof PALETTE_FIELDS[number]) => isPaletteColor(color(field)) ? color(field) : paletteColor({}, theme, field, accent);

  return <details className="settings-palette settings-appearance__setting">
    <summary ref={target} className="settings-palette__summary">
      <UiIcon name="chevronRight" size={14} />
      <span>{t(language, 'settings.palette.title')}</span>
    </summary>
    <div className="settings-palette__toolbar">
      <div className="settings-palette__tabs" role="group" aria-label={t(language, 'settings.palette.editTheme')}>
        {(['light', 'dark'] as const).map((value) => <button key={value} type="button"
          aria-pressed={theme === value} onClick={() => setTheme(value)} disabled={saving}>
          {t(language, `settings.palette.${value}`)}
        </button>)}
      </div>
    </div>
    {values && <>
      <div className="settings-palette__preview" aria-label={t(language, 'settings.palette.preview')}
        style={{ background: previewColor('background'), color: previewColor('foreground'), borderColor: previewColor('border') }}>
        <span className="settings-palette__preview-sidebar" style={{ background: previewColor('sidebar') }}><UiIcon name="sidebar" /></span>
        <div style={{ background: previewColor('surface') }}>
          <strong>{t(language, 'settings.palette.previewTitle')}</strong>
          <span style={{ color: previewColor('muted') }}>{t(language, 'settings.palette.previewBody')}</span>
        </div>
        <UiIcon name="check" />
      </div>
      <div className="settings-palette__fields">
        {PALETTE_FIELDS.map((field) => {
          const value = color(field);
          const valid = isPaletteColor(value);
          const key = paletteToken(theme, field);
          return <div key={key} className="settings-palette__field">
            <span>{label(field)}</span>
            <div className="settings-palette__color-control">
              <input type="color" value={previewColor(field).slice(0, 7)} disabled={disabled}
                aria-label={`${label(field)} — ${t(language, 'settings.palette.picker')}`}
                onChange={event => void chooseColor(key, event.target.value + (value.length === 9 ? value.slice(7) : ''))} />
              <input type="text" value={value} spellCheck={false} autoComplete="off" disabled={disabled}
                aria-label={`${label(field)} — HEX`} aria-invalid={!valid} maxLength={9}
                onChange={(event) => edit(key, event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && dirty && !saving) void save(draft.text); }} />
            </div>
          </div>;
        })}
      </div>
      {dirty && <div className="settings-palette__actions">
        <button type="button" className="settings-button" disabled={disabled || !dirty}
          onClick={() => { setDraft({ saved: encoded, text: encoded }); setError(null); }}>{t(language, 'settings.edit.discard')}</button>
        <button type="button" className="settings-button settings-button--primary" disabled={disabled || !dirty}
          onClick={() => void save(draft.text)}>{t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}</button>
      </div>}
    </>}
    {(configError || error) && <p className="settings-error" role="alert">{configError || error}</p>}
  </details>;
}
