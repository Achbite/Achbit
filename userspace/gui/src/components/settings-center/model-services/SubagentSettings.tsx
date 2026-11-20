import { useState } from 'react';
import { connectedModelReasoningEfforts, type AgentSettings, type LlmProviderProfile, type ModelConnection } from '@achbit/protocol';
import SubagentModelFields from '../../shared/SubagentModelFields';
import { DisclosureSummary, ToggleSwitch } from '../../../ui-components';
import ConfirmedNumberInput from '../../shared/ConfirmedNumberInput';
import { useLocalAgentStore } from '../../../state/localAgentStore';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useConversationSubagents } from '../../shared/useConversationSubagents';
import { message, useModelLanguage } from './shared';
import { useSettingsHelp } from '../SettingsHelp';

const numericSettings = ['maxConcurrent', 'maxCallsPerRun', 'maxMembersPerSession'] as const;

export default function SubagentSettings({ profiles, connections }: {
  profiles: LlmProviderProfile[];
  connections: ModelConnection[];
}) {
  const { language } = useModelLanguage();
  const help = useSettingsHelp(t(language, 'settings.subagents.activation'));
  const subagents = useConversationSubagents();
  const settings = subagents.settings;
  const [error, setError] = useState('');
  useInterfaceReloadGuard(false, t(language, 'settings.subagents.title'), subagents.saving);
  const mainProfileId = useLocalAgentStore(state => state.selectedProfileId);
  if (!settings) return <p role="status">{t(language, 'settings.subagents.unavailable')}</p>;
  const { profileId: selected, reasoningEffort: effort, enabled } = settings;
  const profile = profiles.find(value => value.id === (selected || mainProfileId));
  const available = profiles.filter(value => value.enabled
    && connections.some(connection => connection.id === value.connectionId));
  const configured = !selected || available.some(value => value.id === selected);
  const efforts = connectedModelReasoningEfforts(profile, connections);
  const unsupportedEffort = !!effort && (profile?.thinking === 'disabled' || !efforts.some(value => value === effort));
  const save = async (patches: Partial<AgentSettings>): Promise<boolean> => {
    const next = { ...settings, ...patches };
    const changesModel = ['enabled', 'profileId', 'reasoningEffort'].some(name => Object.hasOwn(patches, name));
    if (changesModel && next.enabled) {
      const id = next.profileId;
      if (id && !available.some(value => value.id === id)) { setError(t(language, 'settings.subagents.profileRequired')); return false; }
      const model = profiles.find(value => value.id === (id || mainProfileId));
      const reasoning = next.reasoningEffort;
      if (reasoning && (model?.thinking === 'disabled' || !connectedModelReasoningEfforts(model, connections).some(value => value === reasoning))) {
        setError(t(language, 'settings.subagents.effortUnavailable')); return false;
      }
    }
    for (const name of numericSettings) {
      if (Object.hasOwn(patches, name) && (!Number.isSafeInteger(next[name]) || next[name] <= 0)) {
        setError(t(language, 'settings.subagents.positiveInteger')); return false;
      }
    }
    setError('');
    try { await subagents.save(patches); return true; }
    catch (failure) { setError(message(failure)); return false; }
  };
  return <details className="model-editor model-divider">
    <DisclosureSummary aria-describedby={help.helpId} {...help.helpEvents}>
      {help.help}<strong>{t(language, 'settings.subagents.title')}</strong>
      <span>{enabled ? (!selected ? t(language, 'settings.subagents.followMain')
        : available.find(value => value.id === selected)?.name ?? t(language, 'settings.subagents.unavailable'))
        : t(language, 'settings.common.disabled')}</span>
    </DisclosureSummary>
    <div>
      <fieldset disabled={subagents.busy}>
        <div className="model-form-grid model-subagent-settings">
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.activation')}>{t(language, 'settings.subagents.enabled')}</span>
            <ToggleSwitch checked={enabled} onChange={event => void save({ enabled: event.target.checked })} />
          </label>
          <SubagentModelFields profiles={profiles} connections={connections} profileId={selected} reasoningEffort={effort}
            mainProfileId={mainProfileId} language={language} onChange={patches => void save(patches)} />
          {numericSettings.map(name => <label key={name}>{t(language, `settings.subagents.${name}`)}
            <ConfirmedNumberInput required min={1} step={1} max={Number.MAX_SAFE_INTEGER}
              value={settings[name]} language={language} label={t(language, `settings.subagents.${name}`)}
              disabled={subagents.busy} onCommit={value => save({ [name]: value ?? 0 })} />
          </label>)}
          <label className="model-toggle-row"><span>{t(language, 'settings.subagents.allowMemberAnalysis')}</span>
            <ToggleSwitch checked={settings.allowMemberAnalysis}
              onChange={event => void save({ allowMemberAnalysis: event.target.checked })} /></label>
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.fullConfigurationHelp')}>{t(language, 'settings.subagents.allowFullConfiguration')}</span>
            <ToggleSwitch checked={settings.allowFullConfiguration}
              onChange={event => void save({ allowFullConfiguration: event.target.checked })} /></label>
          {!configured && <p className="model-wide">{t(language, 'settings.subagents.profileRequired')}</p>}
          {unsupportedEffort && <p className="settings-error model-wide" role="alert">{t(language, 'settings.subagents.effortUnavailable')}</p>}
          {error && <div className="settings-error model-wide" role="alert">{error}</div>}
        </div>
      </fieldset>
    </div>
  </details>;
}
