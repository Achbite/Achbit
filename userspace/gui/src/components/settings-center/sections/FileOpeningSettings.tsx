import type { UiLanguage } from '../../../i18n';
import { shellPreferenceSettingDefinitions, useSettingsStore } from '../../../state/settingsStore';
import { localizeSettingDefinition } from '../../../settingsLocalization';
import SettingsField from '../SettingsField';

export const FILE_READING_KEYS = ['gui.defaultFileOpen', 'gui.showRuntimeFiles'] as const;

export default function FileOpeningSettings({ language }: { language: UiLanguage }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const reset = useSettingsStore((state) => state.resetUserSetting);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const chinese = language === 'zh-CN';
  const title = chinese ? '文件与阅读' : 'Files and reading';
  const available = shellPreferenceSettingDefinitions('gui');
  const definitions = FILE_READING_KEYS.flatMap(key => available.filter(definition => definition.key === key))
    .map(definition => localizeSettingDefinition(definition, language));
  if (!definitions.length) return null;
  return <section className="settings-card"><h3 className="settings-card__title">{title}</h3><div className="settings-card__body">
    {definitions.map(definition => <SettingsField key={definition.key} definition={definition}
      value={settings[definition.key]} source={sources[definition.key] ?? 'default'}
      language={language} compact disabled={loading} onChange={patch} onReset={reset} />)}
  </div></section>;
}
