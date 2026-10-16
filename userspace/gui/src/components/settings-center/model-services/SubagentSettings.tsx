import { useEffect, useState, type FormEvent } from 'react';
import { modelReasoningEfforts, type LlmProviderProfile, type ModelConnection, type UserSettings } from '@deepcode/protocol';
import SubagentModelFields from '../../shared/SubagentModelFields';
import ToggleSwitch from '../../shared/ToggleSwitch';
import { useLocalAgentStore } from '../../../state/localAgentStore';
import { t } from '../../../i18n';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { useSettingsStore } from '../../../state/settingsStore';
import { message, useModelLanguage } from './shared';

const numericSettings = ['maxConcurrent', 'maxCallsPerRun', 'maxMembersPerSession'] as const;

function editableSettings(settings: UserSettings): UserSettings {
  return Object.fromEntries(['enabled', 'profileId', 'reasoningEffort', ...numericSettings, 'allowMemberAnalysis', 'allowFullConfiguration']
    .map(name => [`agent.subagents.${name}`, settings[`agent.subagents.${name}`]]));
}

export default function SubagentSettings({ profiles, connections }: {
  profiles: LlmProviderProfile[];
  connections: ModelConnection[];
}) {
  const { language } = useModelLanguage();
  const settings = useSettingsStore(state => state.effectiveSettings);
  const baseline = JSON.stringify(editableSettings(settings));
  const [draft, setDraft] = useState<UserSettings>(() => editableSettings(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(JSON.parse(baseline)); setError(''); }, [baseline]);
  const dirty = JSON.stringify(draft) !== baseline;
  useInterfaceReloadGuard(dirty, t(language, 'settings.subagents.title'), saving);
  const selected = String(draft['agent.subagents.profileId']);
  const effort = String(draft['agent.subagents.reasoningEffort']);
  const enabled = draft['agent.subagents.enabled'] === true;
  const mainProfileId = useLocalAgentStore(state => state.selectedProfileId);
  const profile = profiles.find(value => value.id === (selected || mainProfileId));
  const available = profiles.filter(value => value.enabled
    && connections.some(connection => connection.id === value.connectionId));
  const configured = !selected || available.some(value => value.id === selected);
  const efforts = modelReasoningEfforts(profile);
  const unsupportedEffort = !!effort && (profile?.thinking === 'disabled' || !efforts.some(value => value === effort));
  const set = (name: string, value: UserSettings[string]) => {
    setDraft(current => ({ ...current, [`agent.subagents.${name}`]: value }));
    setError('');
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enabled && !configured) { setError(t(language, 'settings.subagents.profileRequired')); return; }
    if (enabled && unsupportedEffort) { setError(t(language, 'settings.subagents.effortUnavailable')); return; }
    for (const name of numericSettings) {
      const value = draft[`agent.subagents.${name}`];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        setError(t(language, 'settings.subagents.positiveInteger')); return;
      }
    }
    setSaving(true); setError('');
    try {
      const activation = await useSettingsStore.getState().patchUserSettingsBatch(draft);
      if (!activation) setError(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (failure) { setError(message(failure)); }
    finally { setSaving(false); }
  };
  return <details className="model-editor model-divider">
    <summary><strong>{t(language, 'settings.subagents.title')}</strong>
      <span>{settings['agent.subagents.enabled'] === true
        ? (!settings['agent.subagents.profileId'] ? t(language, 'settings.subagents.followMain')
          : available.find(value => value.id === settings['agent.subagents.profileId'])?.name ?? t(language, 'settings.subagents.unavailable'))
        : t(language, 'settings.common.disabled')}</span>
    </summary>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={saving}>
        <div className="model-form-grid model-subagent-settings">
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.activation')}>{t(language, 'settings.subagents.enabled')}</span>
            <ToggleSwitch checked={enabled} onChange={event => set('enabled', event.target.checked)} />
          </label>
          <SubagentModelFields profiles={profiles} connections={connections} profileId={selected} reasoningEffort={effort}
            mainProfileId={mainProfileId} language={language} onChange={patches => {
              setDraft(current => ({ ...current, ...patches })); setError('');
            }} />
          {numericSettings.map(name => <label key={name}>{t(language, `settings.subagents.${name}`)}
            <input type="number" required min={1} step={1} max={Number.MAX_SAFE_INTEGER}
              value={draft[`agent.subagents.${name}`] as number | string}
              onChange={event => set(name, event.target.value === '' ? '' : Number(event.target.value))} />
          </label>)}
          <label className="model-toggle-row"><span>{t(language, 'settings.subagents.allowMemberAnalysis')}</span>
            <ToggleSwitch checked={draft['agent.subagents.allowMemberAnalysis'] === true}
              onChange={event => set('allowMemberAnalysis', event.target.checked)} /></label>
          <label className="model-toggle-row"><span title={t(language, 'settings.subagents.fullConfigurationHelp')}>{t(language, 'settings.subagents.allowFullConfiguration')}</span>
            <ToggleSwitch checked={draft['agent.subagents.allowFullConfiguration'] === true}
              onChange={event => set('allowFullConfiguration', event.target.checked)} /></label>
          <p className="model-wide">{t(language, 'settings.subagents.fullConfigurationHelp')}</p>
          {!configured && <p className="model-wide">{t(language, 'settings.subagents.profileRequired')}</p>}
          {unsupportedEffort && <p className="settings-error model-wide" role="alert">{t(language, 'settings.subagents.effortUnavailable')}</p>}
          {error && <div className="settings-error model-wide" role="alert">{error}</div>}
        </div>
        <div className="model-actions"><button type="submit" className="model-primary model-push" disabled={!dirty}>
          {t(language, saving ? 'settings.common.saving' : 'settings.common.save')}
        </button></div>
      </fieldset>
    </form>
  </details>;
}
