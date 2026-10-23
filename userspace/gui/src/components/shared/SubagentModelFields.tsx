import { modelReasoningEfforts, type AgentSettings, type LlmProviderProfile, type ModelConnection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import NativeSelect from './NativeSelect';

/** The caller owns persistence: Session settings or defaults for future Sessions. */
export default function SubagentModelFields({ profiles, connections, profileId, reasoningEffort, mainProfileId, language, disabled, onChange }: {
  profiles: readonly LlmProviderProfile[];
  connections: readonly ModelConnection[];
  profileId: string;
  reasoningEffort: string;
  mainProfileId: string | null;
  language: UiLanguage;
  disabled?: boolean;
  onChange(patches: Partial<Pick<AgentSettings, 'profileId' | 'reasoningEffort'>>): void;
}) {
  const profile = profiles.find(value => value.id === (profileId || mainProfileId));
  const available = profiles.filter(value => value.enabled && connections.some(connection => connection.id === value.connectionId));
  const efforts = modelReasoningEfforts(profile);
  return <>
    <label>{t(language, 'settings.subagents.providerModel')}
      <NativeSelect value={profileId} disabled={disabled} onChange={event => {
        const next = profiles.find(value => value.id === (event.target.value || mainProfileId));
        onChange({ profileId: event.target.value,
          ...(next?.thinking === 'disabled' || reasoningEffort && !modelReasoningEfforts(next).some(value => value === reasoningEffort)
            ? { reasoningEffort: '' } : {}) });
      }}>
        <option value="">{t(language, 'settings.subagents.followMain')}</option>
        {profileId && !available.some(value => value.id === profileId) && <option value={profileId} disabled>{profile?.name ?? profileId} · {t(language, 'settings.subagents.unavailable')}</option>}
        {connections.map(connection => <optgroup key={connection.id} label={connection.name}>
          {available.filter(value => value.connectionId === connection.id).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
        </optgroup>)}
      </NativeSelect>
    </label>
    <label>{t(language, 'settings.llm.reasoningEffort')}
      <NativeSelect value={reasoningEffort} disabled={disabled || profile?.thinking === 'disabled'} onChange={event => onChange({ reasoningEffort: event.target.value as AgentSettings['reasoningEffort'] })}>
        <option value="">{profile?.thinking === 'disabled' ? t(language, 'agent.profile.thinkingDisabled')
          : t(language, profileId ? 'settings.subagents.inheritEffort' : 'settings.subagents.followMain')}</option>
        {reasoningEffort && !efforts.some(value => value === reasoningEffort) && <option value={reasoningEffort} disabled>{reasoningEffort}</option>}
        {efforts.map(value => <option key={value} value={value}>{t(language, `settings.llm.effort.${value}`)}</option>)}
      </NativeSelect>
    </label>
  </>;
}
