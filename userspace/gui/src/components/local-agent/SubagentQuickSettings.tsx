import { useState } from 'react';
import type { LlmProviderProfile, ModelConnection, UserSettings } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import SubagentModelFields from '../shared/SubagentModelFields';
import ToggleSwitch from '../shared/ToggleSwitch';
import { useAutoDismiss } from '../shared/useAutoDismiss';

export default function SubagentQuickSettings({ profiles, connections, mainProfileId, language }: {
  profiles: readonly LlmProviderProfile[];
  connections: readonly ModelConnection[];
  mainProfileId: string | null;
  language: UiLanguage;
}) {
  const settings = useSettingsStore(state => state.effectiveSettings);
  const loading = useSettingsStore(state => state.loading);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAutoDismiss(error, () => setError(null));
  const save = async (patches: UserSettings) => {
    if (saving || loading) return;
    setSaving(true); setError(null);
    try {
      const activation = await useSettingsStore.getState().patchUserSettingsBatch(patches);
      if (!activation) setError(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="deepcode-subagent-config">
    <fieldset disabled={saving || loading}>
      <label className="deepcode-subagent-config__toggle"><span>{t(language, 'settings.subagents.enabled')}</span>
        <ToggleSwitch checked={settings['agent.subagents.enabled'] === true}
          onChange={event => void save({ 'agent.subagents.enabled': event.target.checked })} />
      </label>
      <SubagentModelFields profiles={profiles} connections={connections} mainProfileId={mainProfileId} language={language}
        profileId={String(settings['agent.subagents.profileId'] ?? '')} reasoningEffort={String(settings['agent.subagents.reasoningEffort'] ?? '')}
        onChange={patches => void save(patches)} />
    </fieldset>
    {error && <p className="deepcode-session-model__error" role="alert">{error}</p>}
  </div>;
}
