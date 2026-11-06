import React, { useId, useState } from 'react';
import { t, type UiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import { ModalDialog } from '../../../ui-components';
import { useSettingsHelp } from '../SettingsHelp';
import { useSettingsSearchEntries, useSettingsSearchTarget } from '../settingsSearch';

export default function CommandDenylistSettings({ language, setting = 'commandDenylist' }: { language: UiLanguage; setting?: 'commandDenylist' | 'runtimeReadRoots' }) {
  const SETTING_KEY = `agent.permissions.${setting}`;
  const messages = `settings.${setting}`;
  const value = useSettingsStore((state) => state.effectiveSettings[SETTING_KEY]);
  const loading = useSettingsStore((state) => state.loading);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const title = t(language, `${messages}.title`);
  const description = t(language, `${messages}.description`);
  const target = useSettingsSearchTarget(SETTING_KEY);
  const { helpId, helpEvents, help } = useSettingsHelp(description);
  useSettingsSearchEntries(SETTING_KEY, [{ id: SETTING_KEY, category: 'permissions', title, keywords: description }]);
  const valid = Array.isArray(value) && value.every((command) => typeof command === 'string' && command.trim().length > 0 && !/[\r\n]/u.test(command));
  const savedText = valid ? value.join('\n') : null;
  const configurationError = valid ? null : t(language, `${messages}.invalid`);
  useInterfaceReloadGuard(draft !== null && draft !== savedText, title, saving);

  const close = () => { setDraft(null); setError(null); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    setSaving(true); setError(null);
    try {
      const commands = draft.split(/\r?\n/u).map((command) => command.trim()).filter(Boolean);
      const result = await patch(SETTING_KEY, commands);
      if (result === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return <>
    <div ref={target} tabIndex={-1} aria-describedby={helpId} {...helpEvents} className="settings-field settings-field--compact">
      {help}
      <div className="settings-field__main"><span className="settings-field__label">{title}</span></div>
      <div className="settings-field__control">
        <button type="button" className="settings-button" disabled={loading || savedText === null}
          onClick={() => { setError(null); setDraft(savedText); }}>{t(language, `${messages}.edit`)}</button>
        {configurationError && <p className="settings-error" role="alert">{configurationError}</p>}
      </div>
    </div>
    {draft !== null && <ModalDialog className="plugin-import-overlay" aria-labelledby={`${id}-title`} busy={saving} onClose={close}>
      <form className="plugin-import" onSubmit={(event) => void save(event)}>
        <h3 id={`${id}-title`}>{title}</h3>
        <p id={`${id}-description`}>{description}</p>
        <textarea autoFocus className="settings-field__input settings-field__textarea" rows={10}
          aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} value={draft}
          spellCheck={false} disabled={saving} onChange={(event) => { setDraft(event.target.value); setError(null); }} />
        {error && <p className="settings-error" role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="button" className="settings-button" disabled={saving} onClick={close}>{t(language, 'agent.session.cancel')}</button>
          <button type="submit" className="settings-button settings-button--primary" disabled={saving || draft === savedText}>
            {t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}
          </button>
        </div>
      </form>
    </ModalDialog>}
  </>;
}
