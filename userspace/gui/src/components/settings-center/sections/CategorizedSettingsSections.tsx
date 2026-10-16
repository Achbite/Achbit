import CommandRuleSettings from './CommandRuleSettings';
import { requestInterfaceReload } from '../../../services/interfaceReload';
import React, { useMemo } from 'react';
import type { UserSettingValue } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../../i18n';
import { localizeSettingDefinition } from '../../../settingsLocalization';
import {
  agentSettingDefinitions,
  shellPreferenceSettingDefinitions,
  useSettingsStore,
  type SettingDefinition,
} from '../../../state/settingsStore';
import GuiAppearanceSettings from '../GuiAppearanceSettings';
import SettingsField from '../SettingsField';
import WorkspaceSandboxSettings from './WorkspaceSandboxSettings';
import DocumentEnvironmentSettings from './DocumentEnvironmentSettings';
import FileOpeningSettings, { FILE_READING_KEYS } from './FileOpeningSettings';
import CommandDenylistSettings from './CommandDenylistSettings';

interface RuntimeProps {
  apiStatus: string;
  serverVersion?: string;
  category?: 'general' | 'appearance' | 'about';
}

const APPEARANCE_KEYS = ['gui.colorTheme', 'gui.accentColor'] as const;
const INTERFACE_KEYS = [
  'workbench.language',
  'gui.navigationDensity',
  'gui.showContextRail',
  'gui.usageWidget.enabled',
  'gui.usageWidget.visibility',
  'gui.usageWidget.currency',
  'gui.showReasoning',
] as const;
const AGENT_INSTRUCTION_KEYS = ['agent.systemPrompt'] as const;
const AGENT_RESPONSE_KEYS = ['agent.responseLanguage'] as const;
const AGENT_SHELL_KEYS = ['agent.windows.shell', 'agent.windows.gitBashPath'] as const;
const AGENT_PERMISSION_KEYS = [
  'agent.permissions.workspaceMutation',
  'agent.permissions.engineeringDecisions',
  'agent.permissions.shell',
  'agent.permissions.shellAccess',
  'agent.permissions.networkRead',
  'agent.permissions.external',
] as const;
const AGENT_WEB_KEYS = [
  'agent.web.search.endpointTemplate',
  'agent.web.search.authHeaderName',
  'agent.web.search.authSecretRef',
] as const;

function guiDefinitions(): SettingDefinition[] {
  return shellPreferenceSettingDefinitions('gui');
}

function definitionsFor(
  keys: readonly string[],
  available: readonly SettingDefinition[],
  language: ReturnType<typeof normalizeUiLanguage>,
): SettingDefinition[] {
  const byKey = new Map(available.map((definition) => [definition.key, definition]));
  return keys.flatMap((key) => {
    const original = byKey.get(key);
    if (!original) return [];
    return [localizeSettingDefinition(original, language)];
  });
}

export function settingsSearchDefinitions(language: ReturnType<typeof normalizeUiLanguage>, os: unknown) {
  const available = [...guiDefinitions(), ...agentSettingDefinitions()];
  const groups = {
    general: ['workbench.language', ...FILE_READING_KEYS],
    gui: [...APPEARANCE_KEYS, ...INTERFACE_KEYS.filter((key) => key !== 'workbench.language')],
    agent: [...AGENT_INSTRUCTION_KEYS, ...AGENT_RESPONSE_KEYS],
    environment: [...(os === 'windows' ? AGENT_SHELL_KEYS : []), 'agent.documents.pythonPath'],
    permissions: AGENT_PERMISSION_KEYS,
    llm: AGENT_WEB_KEYS,
  };
  return Object.entries(groups).flatMap(([category, keys]) => definitionsFor(keys, available, language).map((definition) => ({ id: definition.key, title: definition.label, keywords: `${definition.key} ${definition.description}`, category })));
}

export const GuiSettingsSection: React.FC<RuntimeProps> = ({
  apiStatus,
  serverVersion,
  category = 'appearance',
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const storePath = useSettingsStore((state) => state.storePath);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const appearance = useMemo(
    () => definitionsFor(APPEARANCE_KEYS, guiDefinitions(), language),
    [language],
  );
  const preferences = useMemo(
    () => definitionsFor(category === 'general' ? ['workbench.language'] : category === 'appearance' ? INTERFACE_KEYS.filter((key) => key !== 'workbench.language') : [], guiDefinitions(), language),
    [category, language],
  );
  const onChange = (key: string, value: UserSettingValue) => {
    return patchUserSetting(key, value);
  };

  return (
    <div>
      <h2 className="settings-title">{category === 'general' ? (language === 'zh-CN' ? '通用' : 'General') : category === 'about' ? (language === 'zh-CN' ? '关于 DeepCode' : 'About DeepCode') : t(language, 'settings.gui.title')}</h2>
      {category === 'general' && <FileOpeningSettings language={language} />}
      {category === 'appearance' && <GuiAppearanceSettings definitions={appearance} language={language} />}
      {preferences.length > 0 && (
        <div className="settings-card">
          <h3 className="settings-card__title">{t(language, 'settings.gui.preferences')}</h3>
          <div className="settings-card__body">
            {preferences.map((definition) => (
              <SettingsField
                key={definition.key}
                definition={definition}
                value={effectiveSettings[definition.key]}
                source={sources[definition.key] ?? 'default'}
                language={language}
                disabled={loading}
                compact
                onChange={onChange}
                onReset={(key) => resetUserSetting(key)}
              />
            ))}
          </div>
        </div>
      )}
      {category === 'about' && (
        <div className="settings-card settings-runtime-card">
          <h3 className="settings-card__title">{t(language, 'settings.runtime.title')}</h3>
          <table className="settings-kv">
            <tbody>
              <tr><td>{t(language, 'settings.runtime.product')}</td><td>DeepCode</td></tr>
              <tr><td>{t(language, 'settings.runtime.serverVersion')}</td><td>{serverVersion ?? '-'}</td></tr>
              <tr><td>{t(language, 'settings.runtime.apiStatus')}</td><td>{apiStatus}</td></tr>
              <tr>
                <td>{t(language, 'settings.runtime.userSettingsFile')}</td>
                <td>{storePath
                  ? t(language, 'settings.runtime.loaded')
                  : t(language, 'settings.runtime.notLoaded')}</td>
              </tr>
            </tbody>
          </table>
          <div className="settings-card__body">
            <button type="button" className="settings-button" onClick={() => requestInterfaceReload()}>
              {language === 'zh-CN' ? '重新加载界面' : 'Reload interface'}
            </button>
          </div>
        </div>
      )}
      {errorMessage && <div className="settings-error" role="alert">{errorMessage}</div>}
    </div>
  );
};

interface AgentSettingsSectionProps {
  category?: 'agent' | 'environment' | 'permissions' | 'services';
}

export const AgentSettingsSection: React.FC<AgentSettingsSectionProps> = ({ category = 'agent' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const available = useMemo(() => agentSettingDefinitions(), []);
  const environment = useSettingsStore((state) => state.environment);
  const shellSettings = useMemo(() => definitionsFor(AGENT_SHELL_KEYS, available, language), [available, language]);
  const shell = environment?.shell as { executable?: string; dialect?: string } | undefined;
  const commands = Array.isArray(environment?.developerCommands) ? environment.developerCommands.filter((item): item is string => typeof item === 'string') : [];
  const chinese = language === 'zh-CN';
  const response = useMemo(
    () => definitionsFor(AGENT_RESPONSE_KEYS, available, language),
    [available, language],
  );
  const instructions = useMemo(
    () => definitionsFor(AGENT_INSTRUCTION_KEYS, available, language),
    [available, language],
  );
  const permissions = useMemo(
    () => definitionsFor(AGENT_PERMISSION_KEYS, available, language),
    [available, language],
  );
  const web = useMemo(
    () => definitionsFor(AGENT_WEB_KEYS, available, language),
    [available, language],
  );
  const onChange = (key: string, value: UserSettingValue) => {
    return patchUserSetting(key, value);
  };
  const renderCard = (title: string | null, definitions: readonly SettingDefinition[], extra?: React.ReactNode) => {
    if (definitions.length === 0 && !extra) return null;
    return (
      <section className="settings-group">
        {title && <h3 className="settings-card__title">{title}</h3>}
        <div className="settings-card settings-card__body">
          {definitions.map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              language={language}
              disabled={loading}
              compact
              onChange={onChange}
              onReset={(key) => resetUserSetting(key)}
            />
          ))}
          {extra}
        </div>
      </section>
    );
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, category === 'services' ? 'settings.agent.webTools' : `settings.nav.${category}`)}</h2>
      {category === 'agent' && renderCard(null, response)}
      {category === 'environment' && environment?.os === 'windows' && renderCard('Windows Shell', shellSettings)}
      {category === 'environment' && <DocumentEnvironmentSettings language={language} />}
      {category === 'environment' && <WorkspaceSandboxSettings chinese={chinese} />}
      {category === 'environment' && <div className="settings-card">
        <h3 className="settings-card__title">{chinese ? '环境上下文' : 'Environment context'}</h3>
        <div className="settings-card__body">
          <div className="settings-field settings-field--compact">
            <div className="settings-field__main">
              <div className="settings-field__label">{chinese ? '本机环境' : 'Local environment'}</div>
            </div>
            <button className="settings-button" disabled={loading} onClick={() => void patchUserSetting('agent.environmentRevision', Number(effectiveSettings['agent.environmentRevision'] ?? 0) + 1)}>{chinese ? '刷新环境' : 'Refresh environment'}</button>
          </div>
          {environment && <div className="settings-field__description">
            <p>{chinese ? '本机检测' : 'Local observation'}: {String(environment.os)} · {String(environment.arch)} · {shell?.dialect ?? '—'}</p>
            <p style={{ overflowWrap: 'anywhere' }}>{shell?.executable || (chinese ? '未找到所选 Shell' : 'Selected shell not found')}</p>
            <p>{chinese ? '可用开发命令' : 'Developer commands'}: {commands.join(' · ') || '—'}</p>
          </div>}
        </div>
      </div>}

      {category === 'agent' && renderCard(t(language, 'settings.agent.instructions'), instructions)}
      {category === 'permissions' && renderCard(null, permissions, <>
        <CommandDenylistSettings language={language} />
        <CommandRuleSettings language={language} />
        <CommandDenylistSettings language={language} setting="runtimeReadRoots" />
      </>)}
      {category === 'services' && renderCard(null, web)}
      {errorMessage && <div className="settings-error">{errorMessage}</div>}
    </div>
  );
};
