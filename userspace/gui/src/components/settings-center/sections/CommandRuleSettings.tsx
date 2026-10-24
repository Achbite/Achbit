import NativeSelect from '../../shared/NativeSelect';
import { useState } from 'react';
import { decodeShellCommandRules } from '@achbit/protocol';
import { t, type UiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';
import { useSettingsSearchEntries, useSettingsSearchTarget } from '../settingsSearch';

export default function CommandRuleSettings({ language }: { language: UiLanguage }) {
  const value = useSettingsStore(state => state.effectiveSettings['agent.permissions.commandRules']);
  const patch = useSettingsStore(state => state.patchUserSetting);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = useSettingsSearchTarget('agent.permissions.commandRules');
  useSettingsSearchEntries('command-rules', [{ id: 'agent.permissions.commandRules', category: 'permissions',
    title: t(language, 'settings.commandRules.title') }]);
  let rules;
  try { rules = decodeShellCommandRules(value); }
  catch (error) { return <p role="alert">{String(error)}</p>; }
  const update = async (index: number, decision?: 'ask' | 'allow' | 'deny') => {
    setBusy(true); setError(null);
    try {
      const current = decodeShellCommandRules(value);
      const next = decision ? current.map((rule, i) => i === index ? { ...rule, decision } : rule) : current.filter((_, i) => i !== index);
      if (!await patch('agent.permissions.commandRules', JSON.stringify(next))) throw new Error(useSettingsStore.getState().errorMessage ?? 'Could not save command rules');
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  return <div ref={target} tabIndex={-1} className="settings-command-rules">
    <strong>{t(language, 'settings.commandRules.title')}</strong>
    {!rules.length && <p>{t(language, 'settings.commandRules.empty')}</p>}
    {rules.map((rule, index) => <div key={JSON.stringify(rule.context)} className="settings-command-rule">
      <details><summary><code>{String(rule.context.command)}</code></summary>
        <pre>{JSON.stringify(rule.context, null, 2)}</pre></details>
      <NativeSelect disabled={busy} aria-label={t(language, 'settings.commandRules.title')} value={rule.decision} onChange={event => void update(index, event.target.value as 'ask' | 'allow' | 'deny')}>
        {(['ask', 'allow', 'deny'] as const).map(mode => <option key={mode} value={mode}>{t(language, `agent.permission.${mode}`)}</option>)}
      </NativeSelect>
      <button type="button" disabled={busy} onClick={() => void update(index)}>{t(language, 'settings.commandRules.remove')}</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
