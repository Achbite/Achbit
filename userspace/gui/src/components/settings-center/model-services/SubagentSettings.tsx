import { useState } from 'react';
import { modelReasoningEfforts, type LlmProviderProfile, type ModelConnection, type UserSettings } from '@achbit/protocol';
import SubagentModelFields from '../../shared/SubagentModelFields';
import ToggleSwitch from '../../shared/ToggleSwitch';
import ConfirmedNumberInput from '../../shared/ConfirmedNumberInput';
import { useLocalAgentStore } from '../../../state/localAgentStore';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useSettingsStore } from '../../../state/settingsStore';
import { message, useModelLanguage } from './shared';
import { useSettingsHelp } from '../SettingsHelp';

const numericSettings = ['maxConcurrent', 'maxCallsPerRun', 'maxMembersPerSession'] as const;

export default function SubagentSettings({ profiles, connections }: {
  profiles: LlmProviderProfile[];
  connections: ModelConnection[];
}) {
  const { language } = useModelLanguage();
  const defaultsHelp = useSettingsHelp(t(language, 'settings.subagents.defaultsHelp'));
  const settings = useSettingsStore(state => state.effectiveSettings);
  const loading = useSettingsStore(state => state.loading);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useInterfaceReloadGuard(false, t(language, 'settings.subagents.title'), saving);
  const selected = String(settings['agent.subagents.profileId']);
  const effort = String(settings['agent.subagents.reasoningEffort']);
  const enabled = settings['agent.subagents.enabled'] === true;
  const mainProfileId = useLocalAgentStore(state => state.selectedProfileId);
  const profile = profiles.find(value => value.id === (selected || mainProfileId));
  const available = profiles.filter(value => value.enabled
    && connections.some(connection => connection.id === value.connectionId));
  const configured = !selected || available.some(value => value.id === selected);
  const efforts = modelReasoningEfforts(profile);
  const unsupportedEffort = !!effort && (profile?.thinking === 'disabled' || !efforts.some(value => value === effort));
  const save = async (patches: UserSettings): Promise<boolean> => {
    const next = { ...useSettingsStore.getState().effectiveSettings, ...patches };
    const changesModel = ['enabled', 'profileId', 'reasoningEffort'].some(name => Object.hasOwn(patches, `agent.subagents.${name}`));
    if (changesModel && next['agent.subagents.enabled'] === true) {
      const id = String(next['agent.subagents.profileId']);
      if (id && !available.some(value => value.id === id)) { setError(t(language, 'settings.subagents.profileRequired')); return false; }
      const model = profiles.find(value => value.id === (id || mainProfileId));
      const reasoning = String(next['agent.subagents.reasoningEffort']);
      if (reasoning && (model?.thinking === 'disabled' || !modelReasoningEfforts(model).some(value => value === reasoning))) {
        setError(t(language, 'settings.subagents.effortUnavailable')); return false;
      }
    }
    for (const name of numericSettings) {
      const key = `agent.subagents.${name}`;
      if (Object.hasOwn(patches, key) && (!Number.isSafeInteger(patches[key]) || Number(patches[key]) <= 0)) {
        setError(t(language, 'settings.subagents.positiveInteger')); return false;
      }
    }
    setSaving(true); setError('');
    try {
      const activation = await useSettingsStore.getState().patchUserSettingsBatch(patches);
      if (!activation) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
      return true;
    } catch (failure) { setError(message(failure)); return false; }
    finally { setSaving(false); }
  };
  return <details className="model-editor model-divider">
    <summary aria-describedby={defaultsHelp.helpId} {...defaultsHelp.helpEvents}>
      {defaultsHelp.help}<strong>{t(language, 'settings.subagents.title')}</strong>
      <span>{enabled ? (!selected ? t(language, 'settings.subagents.followMain')
        : available.find(value => value.id === selected)?.name ?? t(language, 'settings.subagents.unavailable'))
        : t(language, 'settings.common.disabled')}</span>
    </summary>
    <div>
      <fieldset disabled={loading || saving}>
        <div className="model-form-grid model-subagent-settings">
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.activation')}>{t(language, 'settings.subagents.enabled')}</span>
            <ToggleSwitch checked={enabled} onChange={event => void save({ 'agent.subagents.enabled': event.target.checked })} />
          </label>
          <SubagentModelFields profiles={profiles} connections={connections} profileId={selected} reasoningEffort={effort}
            mainProfileId={mainProfileId} language={language} onChange={patches => void save(Object.fromEntries(
              Object.entries(patches).map(([key, value]) => [`agent.subagents.${key}`, value]),
            ))} />
          {numericSettings.map(name => <label key={name}>{t(language, `settings.subagents.${name}`)}
            <ConfirmedNumberInput required min={1} step={1} max={Number.MAX_SAFE_INTEGER}
              value={Number(settings[`agent.subagents.${name}`])} language={language} label={t(language, `settings.subagents.${name}`)}
              disabled={loading || saving} onCommit={value => save({ [`agent.subagents.${name}`]: value ?? '' })} />
          </label>)}
          <label className="model-toggle-row"><span>{t(language, 'settings.subagents.allowMemberAnalysis')}</span>
            <ToggleSwitch checked={settings['agent.subagents.allowMemberAnalysis'] === true}
              onChange={event => void save({ 'agent.subagents.allowMemberAnalysis': event.target.checked })} /></label>
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.fullConfigurationHelp')}>{t(language, 'settings.subagents.allowFullConfiguration')}</span>
            <ToggleSwitch checked={settings['agent.subagents.allowFullConfiguration'] === true}
              onChange={event => void save({ 'agent.subagents.allowFullConfiguration': event.target.checked })} /></label>
          {!configured && <p className="model-wide">{t(language, 'settings.subagents.profileRequired')}</p>}
          {unsupportedEffort && <p className="settings-error model-wide" role="alert">{t(language, 'settings.subagents.effortUnavailable')}</p>}
          {error && <div className="settings-error model-wide" role="alert">{error}</div>}
        </div>
      </fieldset>
    </div>
  </details>;
}
