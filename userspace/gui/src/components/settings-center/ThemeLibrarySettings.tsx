import { useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { normalizeGuiAccentColor, type GuiResolvedTheme } from '../../theme/deepcodeGuiTheme';
import { PALETTE_FIELDS, PALETTE_SETTING, decodePaletteOverrides, paletteColor } from '../../theme/palette';
import { THEME_LIBRARY_SETTING, applyThemePalette, builtinThemes, decodeThemeLibrary, importTheme, selectedThemeId, themeOverrides, type ThemeDocument, type SavedTheme } from '../../theme/themeLibrary';
import ModalDialog from '../shared/ModalDialog';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import ThemePicker, { ThemeBadge } from './ThemePicker';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { useSettingsSearchEntries, useSettingsSearchTarget } from './settingsSearch';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';

export default function ThemeLibrarySettings({ language }: { language: UiLanguage }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useAutoDismiss(notice, () => setNotice(null));
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  useInterfaceReloadGuard(importing && text.trim().length > 0, t(language, 'settings.themes.importTitle'), busy);
  const file = useRef<HTMLInputElement>(null);
  const target = useSettingsSearchTarget(THEME_LIBRARY_SETTING);
  useSettingsSearchEntries('themes', [{ id: THEME_LIBRARY_SETTING, category: 'gui', title: t(language, 'settings.themes.title'), keywords: '主题 导入 浅色 深色 theme import presets Catppuccin Gruvbox Nord' }]);
  const accent = normalizeGuiAccentColor(settings['gui.accentColor']);
  let library: SavedTheme[] = [];
  let colors = {};
  let configError: string | null = null;
  try {
    library = decodeThemeLibrary(String(settings[THEME_LIBRARY_SETTING] ?? '[]'));
    colors = decodePaletteOverrides(String(settings[PALETTE_SETTING] ?? '{}'));
  } catch (reason) { configError = String(reason); }
  const allThemes = [...builtinThemes(), ...library];
  let pending: ThemeDocument | null = null;
  let importError: string | null = null;
  if (text.trim()) {
    try { pending = importTheme(text); } catch (reason) { importError = String(reason); }
  }
  const persist = async (key: string, value: string | null) => {
    const state = useSettingsStore.getState();
    const result = value === null ? await state.resetUserSetting(key) : await state.patchUserSetting(key, value);
    if (result === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
  };
  const apply = async (id: string, mode: GuiResolvedTheme) => {
    if (id === 'custom') return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const current = decodePaletteOverrides(String(useSettingsStore.getState().effectiveSettings[PALETTE_SETTING] ?? '{}'));
      const theme = id === 'default' ? null : allThemes.find((item) => item.id === id)!;
      const next = applyThemePalette(current, theme, mode);
      await persist(PALETTE_SETTING, Object.keys(next).length ? JSON.stringify(next) : null);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (!pending) return;
    setBusy(true); setError(null);
    try {
      const current = decodeThemeLibrary(String(useSettingsStore.getState().effectiveSettings[THEME_LIBRARY_SETTING] ?? '[]'));
      if ([...builtinThemes(), ...current].some((theme) => theme.name === pending.name)) throw new Error(t(language, 'settings.themes.duplicate'));
      await persist(THEME_LIBRARY_SETTING, JSON.stringify([...current, { id: crypto.randomUUID(), ...pending }]));
      setImporting(false); setText(''); setNotice(t(language, 'settings.themes.imported'));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    setError(null); setNotice(null);
    try {
      const document: ThemeDocument = { name: 'My Theme' };
      for (const mode of ['light', 'dark'] as const) document[mode] = Object.fromEntries(PALETTE_FIELDS.map((field) => [field, paletteColor(colors, mode, field, accent)]));
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      setNotice(t(language, 'settings.themes.copied'));
    } catch (reason) { setError(String(reason)); }
  };
  return <details className="settings-card appearance-config-box appearance-theme-library">
    <summary ref={target} className="settings-card__title">{t(language, 'settings.themes.title')}<DeepCodeShellIcon name="chevronRight" size={14} /></summary>
    <div className="appearance-config-box__body">
      {!configError && (['light', 'dark'] as const).map((mode) => {
        const selected = selectedThemeId(allThemes, colors, mode);
        const choices = [
          { id: 'default', name: 'DeepCode', colors: {} },
          ...allThemes.filter((theme) => Object.keys(theme[mode] ?? {}).length).map((theme) => ({ id: theme.id, name: theme.name, colors: themeOverrides(theme) })),
          ...(selected === 'custom' ? [{ id: 'custom', name: t(language, 'settings.themes.custom'), colors }] : []),
        ];
        return <ThemePicker key={mode} label={t(language, `settings.themes.${mode}`)} choices={choices} selected={selected}
          mode={mode} accent={accent} disabled={loading || busy} onSelect={(id) => void apply(id, mode)} />;
      })}
      <div className="appearance-config-box__actions">
        <button type="button" className="settings-button" disabled={loading || busy || !!configError} onClick={() => { setError(null); setImporting(true); }}>{t(language, 'settings.themes.import')}</button>
        <button type="button" className="settings-button" disabled={loading || busy || !!configError} onClick={() => void copy()}>{t(language, 'settings.themes.copy')}</button>
      </div>
      {notice && <p className="appearance-config-box__hint" role="status">{notice}</p>}
      {(configError || (!importing && error)) && <p className="settings-error" role="alert">{configError || error}</p>}
    </div>
    {importing && <ModalDialog className="appearance-import-overlay" aria-labelledby="theme-import-heading" busy={busy} onClose={() => { setImporting(false); setError(null); }}>
      <div className="appearance-import-dialog">
        <h3 id="theme-import-heading">{t(language, 'settings.themes.importTitle')}</h3>
        <p>{t(language, 'settings.themes.importHint')}</p>
        <input hidden ref={file} type="file" accept=".json,application/json" onChange={async (event) => {
          const selected = event.target.files?.[0]; event.target.value = '';
          if (!selected) return;
          try { setText(await selected.text()); setError(null); } catch (reason) { setError(String(reason)); }
        }} />
        <button type="button" className="settings-button" disabled={busy} onClick={() => file.current?.click()}>{t(language, 'settings.themes.chooseFile')}</button>
        <label className="appearance-import-input">{t(language, 'settings.themes.json')}
          <textarea autoFocus value={text} disabled={busy} spellCheck={false} placeholder={'{ "name": "My Theme", "dark": { "accent": "…" } }'}
            onChange={(event) => { setText(event.target.value); setError(null); }} />
        </label>
        {pending && <div className="appearance-import-preview">
          <strong>{pending.name}</strong>
          {(['light', 'dark'] as const).filter((mode) => Object.keys(pending[mode] ?? {}).length).map((mode) => <span key={mode}>
            <ThemeBadge colors={themeOverrides(pending!)} mode={mode} accent={accent} />{t(language, `settings.themes.${mode}`)}
          </span>)}
        </div>}
        {(importError || error) && <p className="settings-error" role="alert">{importError || error}</p>}
        <div className="appearance-config-box__actions">
          <button type="button" className="settings-button" disabled={busy} onClick={() => { setImporting(false); setError(null); }}>{t(language, 'settings.themes.cancel')}</button>
          <button type="button" className="settings-button settings-button--primary" disabled={busy || !pending} onClick={() => void add()}>{t(language, 'settings.themes.add')}</button>
        </div>
      </div>
    </ModalDialog>}
  </details>;
}
