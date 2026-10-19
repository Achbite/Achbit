import ToggleSwitch from '../shared/ToggleSwitch';
import NativeSelect from '../shared/NativeSelect';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { useSettingsSearchTarget } from './settingsSearch';
import { useSettingsHelp } from './SettingsHelp';
import React, { useEffect, useState } from 'react';
import { DEFAULT_USER_SETTINGS, type UserSettingValue } from '@deepcode/protocol';
import { useSettingsStore, type SettingDefinition } from '../../state/settingsStore';
import { parseSettingDraft, reconcileSettingDraft } from './settingDraft';
import { t, type UiLanguage } from '../../i18n';

interface SettingsFieldProps {
  definition: SettingDefinition;
  value: UserSettingValue | undefined;
  language: UiLanguage;
  disabled?: boolean;
  compact?: boolean;
  onChange: (key: string, value: UserSettingValue) => Promise<unknown>;
}

const SettingsField: React.FC<SettingsFieldProps> = ({
  definition,
  value,
  language,
  disabled = false,
  compact = false,
  onChange,
}) => {
  const targetRef = useSettingsSearchTarget(definition.key);
  const { helpId, helpEvents, help } = useSettingsHelp(definition.description);
  const defaultValue = DEFAULT_USER_SETTINGS[definition.key];
  const savedText = String(value ?? defaultValue ?? '');
  const [draft, setDraft] = useState({ saved: savedText, text: savedText });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = !['boolean', 'select'].includes(definition.control);
  const dirty = draft.text !== savedText;
  useInterfaceReloadGuard(editable && dirty, definition.label, saving);
  useEffect(() => setDraft((current) => reconcileSettingDraft(current, savedText)), [savedText]);
  const perform = async (operation: () => Promise<unknown>) => {
    setSaving(true); setError(null);
    try {
      const result = await operation();
      if (result === null || result === false) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const save = () => {
    const next = parseSettingDraft(draft.text, definition.control === 'number');
    if (next === null) { setError(t(language, 'settings.edit.validNumber')); return; }
    const submitted = draft.text;
    void perform(async () => {
      const result = await onChange(definition.key, next);
      if (result !== null && result !== false) {
        const canonical = String(useSettingsStore.getState().effectiveSettings[definition.key] ?? defaultValue ?? '');
        setDraft((current) => current.text === submitted ? { saved: canonical, text: canonical } : reconcileSettingDraft(current, canonical));
      }
      return result;
    });
  };
  const edit = (text: string) => { setDraft((current) => ({ ...current, text })); setError(null); };
  const onEditorKeyDown = (event: React.KeyboardEvent) => {
    if (!event.nativeEvent.isComposing && event.key === 'Escape' && definition.control === 'number') {
      event.preventDefault(); event.stopPropagation(); setDraft({ saved: savedText, text: savedText }); setError(null); return;
    }
    if (!event.nativeEvent.isComposing && !event.repeat && event.key === 'Enter' && (definition.control !== 'textarea' || event.metaKey || event.ctrlKey)) {
      event.preventDefault(); event.stopPropagation(); if (dirty && !disabled && !saving) save();
    }
  };

  const renderControl = () => {
    if (definition.control === 'boolean') {
      return (
        <ToggleSwitch
          aria-label={definition.label} aria-describedby={helpId}
          checked={Boolean(value)}
          disabled={disabled || saving}
          onChange={(event) => { const next = event.target.checked; void perform(() => onChange(definition.key, next)); }}
        />
      );
    }

    if (definition.control === 'number') {
      return (
        <input
          className="settings-field__input"
          aria-label={definition.label} aria-describedby={helpId}
          type="number"
          title={t(language, 'settings.edit.confirmNumber')}
          value={draft.text}
          disabled={disabled || saving}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onEditorKeyDown}
        />
      );
    }

    if (definition.control === 'select') {
      return (
        <NativeSelect
          className="settings-field__select"
          aria-label={definition.label} aria-describedby={helpId}
          value={String(value ?? defaultValue ?? '')}
          disabled={disabled || saving}
          onChange={(event) => { const next = event.target.value; void perform(() => onChange(definition.key, next)); }}
        >
          {(definition.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      );
    }

    if (definition.control === 'textarea') {
      return (
        <textarea
          className="settings-field__input settings-field__textarea"
          aria-label={definition.label} aria-describedby={helpId}
          value={draft.text}
          disabled={disabled || saving}
          rows={6}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onEditorKeyDown}
        />
      );
    }

    return (
      <input
        className="settings-field__input"
        aria-label={definition.label} aria-describedby={helpId}
        type="text"
        value={draft.text}
        disabled={disabled || saving}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={onEditorKeyDown}
      />
    );
  };

  return (
    <div ref={targetRef} tabIndex={-1} {...helpEvents}
      className={`settings-field${compact ? ' settings-field--compact' : ''}${definition.control === 'textarea' ? ' settings-field--multiline' : ''}`}
    >
      {help}
      <div className="settings-field__main">
        <div className="settings-field__title-row">
          <span className="settings-field__label">{definition.label}</span>
        </div>

      </div>
      <div className="settings-field__control" aria-busy={saving}>
        {renderControl()}
        {editable && definition.control !== 'number' && dirty && <div className="settings-field__edit-actions">
          <button type="button" className="settings-button" disabled={disabled || saving} onClick={save}>{t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}</button>
          <button type="button" className="settings-field__discard" disabled={saving} onClick={() => { setDraft({ saved: savedText, text: savedText }); setError(null); }}>{t(language, 'settings.edit.discard')}</button>
        </div>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
    </div>
  );
};

export default SettingsField;
