import AppearanceConfiguration from './AppearanceConfiguration';
import { PALETTE_SETTING, decodePaletteOverrides, paletteToken } from '../../theme/palette';
import GuiPaletteSettings from './GuiPaletteSettings';
import { useSettingsSearchTarget } from './settingsSearch';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useSettingsHelp } from './SettingsHelp';
import React from 'react';
import type { UiLanguage } from '../../i18n';
import {
  useSettingsStore,
  type SettingDefinition,
} from '../../state/settingsStore';
import {
  GUI_ACCENT_COLORS,
  GUI_THEME_PREFERENCES,
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  type GuiAccentColor,
  type GuiThemePreference,
} from '../../theme/achbitGuiTheme';


interface GuiAppearanceSettingsProps {
  definitions: SettingDefinition[];
  language: UiLanguage;
}


function optionLabel(definition: SettingDefinition, value: string): string {
  return definition.options?.find((option) => option.value === value)?.label ?? value;
}

interface AppearanceSettingHeaderProps {
  definition: SettingDefinition;
}

const AppearanceSettingHeader: React.FC<AppearanceSettingHeaderProps> = ({
  definition,
}) => {
  const target = useSettingsSearchTarget(definition.key);
  const { helpId, helpEvents, help } = useSettingsHelp(definition.description);
  return (
  <div ref={target} tabIndex={-1} aria-describedby={helpId} {...helpEvents} className="settings-appearance__header">
    {help}
    <div>
      <div className="settings-field__title-row">
        <span className="settings-field__label">{definition.label}</span>
      </div>

    </div>
  </div>
);
};

const GuiAppearanceSettings: React.FC<GuiAppearanceSettingsProps> = ({
  definitions,
  language,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const patchUserSettingsBatch = useSettingsStore((state) => state.patchUserSettingsBatch);
  const themeDefinition = definitions.find((definition) => definition.key === 'gui.colorTheme');
  const accentDefinition = definitions.find((definition) => definition.key === 'gui.accentColor');
  const theme = normalizeGuiThemePreference(effectiveSettings['gui.colorTheme']);
  const accent = normalizeGuiAccentColor(effectiveSettings['gui.accentColor']);
  const themeDisabled = loading;
  const accentDisabled = loading;
  if (!themeDefinition && !accentDefinition) return null;

  const selectTheme = (value: GuiThemePreference, disabled: boolean) => {
    if (!disabled && value !== theme) void patchUserSetting('gui.colorTheme', value);
  };
  const selectAccent = (value: GuiAccentColor, disabled: boolean) => {
    if (disabled) return;
    try {
      const colors = decodePaletteOverrides(String(effectiveSettings[PALETTE_SETTING] ?? '{}'));
      delete colors[paletteToken('light', 'accent')];
      delete colors[paletteToken('dark', 'accent')];
      void patchUserSettingsBatch({ 'gui.accentColor': value, [PALETTE_SETTING]: JSON.stringify(colors) });
    } catch (reason) {
      useSettingsStore.setState({ errorMessage: String(reason) });
    }
  };

  return (
    <>
    <div className="settings-card settings-appearance">
      <div className="settings-appearance__body">
        {themeDefinition && (
          <section className="settings-appearance__setting">
            <AppearanceSettingHeader definition={themeDefinition} />
            <div
              className="settings-theme-grid"
              role="group"
              aria-label={themeDefinition.label}
            >
              {GUI_THEME_PREFERENCES.map((value) => (
                <button
                  className="settings-theme-card"
                  type="button"
                  data-theme-choice={value}
                  aria-pressed={theme === value}
                  disabled={themeDisabled}
                  key={value}
                  onClick={event => { selectTheme(value, themeDisabled); if (event.detail > 0) event.currentTarget.blur(); }}
                >
                  <span className="settings-theme-label">
                    <span className="settings-selection-check" aria-hidden="true"><AchbitShellIcon name="check" size={14} /></span>
                    {optionLabel(themeDefinition, value)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {accentDefinition && (
        <section className="settings-appearance__setting">
            <AppearanceSettingHeader definition={accentDefinition} />
            <div
              className="settings-accent-options"
              role="group"
              aria-label={accentDefinition.label}
            >
              {GUI_ACCENT_COLORS.map((value) => (
                <button
                  className="settings-accent-option"
                  type="button"
                  aria-pressed={accent === value}
                  disabled={accentDisabled}
                  key={value}
                  onClick={event => { selectAccent(value, accentDisabled); if (event.detail > 0) event.currentTarget.blur(); }}
                >
                  <span
                    className={`settings-accent-swatch settings-accent-swatch--${value}`}
                    aria-hidden="true"
                  />
                  <span>{optionLabel(accentDefinition, value)}</span>
                  <span className="settings-accent-check" aria-hidden="true"><AchbitShellIcon name="check" size={14} /></span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
    <AppearanceConfiguration language={language} />
    <GuiPaletteSettings language={language} />
    </>
  );
};

export default GuiAppearanceSettings;
