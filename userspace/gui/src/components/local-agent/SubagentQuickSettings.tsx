import { useState } from 'react';
import { decodeAgentSettings, type AgentSettings, type LlmProviderProfile, type ModelConnection, type UserSettings } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import SubagentModelFields from '../shared/SubagentModelFields';
import ToggleSwitch from '../shared/ToggleSwitch';
import { useAutoDismiss } from '../shared/useAutoDismiss';

export default function SubagentQuickSettings({ profiles, connections, mainProfileId, language }: {
  profiles: readonly LlmProviderProfile[];
  connections: readonly ModelConnection[];
  mainProfileId: string | null;
  language: UiLanguage;
}) {
  const sessionId = useLocalAgentStore(state => state.sessionId);
  const saved = useLocalAgentStore(state => state.projection?.subagentSettings);
  const draft = useLocalAgentStore(state => state.draftSubagentSettings);
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const defaultsLoading = useSettingsStore(state => state.loading);
  const loading = useLocalAgentStore(state => state.loading || state.submitting);
  const saving = useLocalAgentStore(state => state.subagentSettingsBusy);
  const settings = sessionId ? saved : draft ?? subagentDefaults(defaults);
  const [error, setError] = useState<string | null>(null);
  useAutoDismiss(error, () => setError(null));
  const save = async (next: AgentSettings) => {
    if (saving || loading) return;
    setError(null);
    try {
      const saved = await useLocalAgentStore.getState().setSubagentSettings(next);
      if (!saved) setError(useLocalAgentStore.getState().error ?? t(language, 'settings.common.saveFailed'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="deepcode-subagent-config">
    {settings ? <fieldset disabled={saving || loading || (!sessionId && defaultsLoading)}>
      <label className="deepcode-subagent-config__toggle"><span title={t(language, 'settings.subagents.activation')}>{t(language, 'settings.subagents.enabled')}</span>
        <ToggleSwitch checked={settings.enabled}
          onChange={event => void save({ ...settings, enabled: event.target.checked })} />
      </label>
      <SubagentModelFields profiles={profiles} connections={connections} mainProfileId={mainProfileId} language={language}
        profileId={settings.profileId} reasoningEffort={settings.reasoningEffort}
        onChange={patches => void save({ ...settings, ...patches })} />
      <label className="deepcode-subagent-config__toggle"><span title={t(language, 'settings.subagents.fullConfigurationHelp')}>{t(language, 'settings.subagents.allowFullConfiguration')}</span>
        <ToggleSwitch checked={settings.allowFullConfiguration}
          onChange={event => void save({ ...settings, allowFullConfiguration: event.target.checked })} />
      </label>
    </fieldset> : <>
      <p>{t(language, 'settings.subagents.unconfigured')}</p>
      <button type="button" disabled={saving || loading || defaultsLoading}
        onClick={() => void save(subagentDefaults(defaults))}>{t(language, 'settings.subagents.applyDefaults')}</button>
    </>}
    {error && <p className="achbit-session-model__error" role="alert">{error}</p>}
  </div>;
}

function subagentDefaults(settings: UserSettings): AgentSettings {
  return decodeAgentSettings({
    enabled: settings['agent.subagents.enabled'],
    profileId: settings['agent.subagents.profileId'],
    reasoningEffort: settings['agent.subagents.reasoningEffort'],
    maxConcurrent: settings['agent.subagents.maxConcurrent'],
    maxCallsPerRun: settings['agent.subagents.maxCallsPerRun'],
    maxMembersPerSession: settings['agent.subagents.maxMembersPerSession'],
    allowMemberAnalysis: settings['agent.subagents.allowMemberAnalysis'],
    allowFullConfiguration: settings['agent.subagents.allowFullConfiguration'],
    presets: settings['agent.subagents.presets'],
  });
}
