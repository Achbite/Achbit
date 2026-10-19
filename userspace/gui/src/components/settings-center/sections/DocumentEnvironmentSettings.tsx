import type { UiLanguage } from '../../../i18n';
import { agentSettingDefinitions, useSettingsStore } from '../../../state/settingsStore';
import { localizeSettingDefinition } from '../../../settingsLocalization';
import SettingsField from '../SettingsField';

export default function DocumentEnvironmentSettings({ language }: { language: UiLanguage }) {
  const key = 'agent.documents.pythonPath';
  const value = useSettingsStore((state) => state.effectiveSettings[key]);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const definition = localizeSettingDefinition(agentSettingDefinitions().find((entry) => entry.key === key)!, language);
  return <section className="settings-card">
    <h3 className="settings-card__title">{language === 'zh-CN' ? 'PDF 生成环境' : 'PDF generation environment'}</h3>
    <div className="settings-card__body">
      <SettingsField definition={definition} value={value} language={language} compact
        onChange={(setting, next) => patch(setting, typeof next === 'string' ? next.trim() : next)} />
    </div>
  </section>;
}
