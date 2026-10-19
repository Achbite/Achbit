import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { reconcileSettingDraft } from '../settings-center/settingDraft';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'onKeyDown'> & {
  value: number | undefined;
  language: UiLanguage;
  label: string;
  onCommit(value: number | undefined): Promise<boolean | void>;
  /** New-object forms collect drafts locally until their explicit create action. */
  onDraftChange?(value: number | undefined): void;
};

export default function ConfirmedNumberInput({ value, language, label, onCommit, onDraftChange, disabled, ...props }: Props) {
  const saved = value === undefined || !Number.isFinite(value) ? '' : String(value);
  const [draft, setDraft] = useState({ saved, text: saved });
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(current => reconcileSettingDraft(current, saved)), [saved]);
  useInterfaceReloadGuard(draft.text !== saved, label, saving);
  return <>
    <input {...props} type="number" value={draft.text} disabled={disabled || saving}
      title={props.title ?? t(language, 'settings.edit.confirmNumber')}
      onChange={event => {
        setDraft(current => ({ ...current, text: event.target.value })); setError(null);
        onDraftChange?.(event.target.value === '' ? undefined : event.target.valueAsNumber);
      }}
      onKeyDown={async event => {
        if (event.nativeEvent.isComposing || event.repeat) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          setDraft({ saved, text: saved }); setError(null); onDraftChange?.(value); return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation();
        const input = event.currentTarget;
        if (disabled || pending.current || !input.reportValidity() || input.value === saved) return;
        const next = input.value === '' ? undefined : input.valueAsNumber;
        if (next !== undefined && !Number.isFinite(next)) { setError(t(language, 'settings.edit.validNumber')); return; }
        pending.current = true; setSaving(true); setError(null);
        try {
          if (await onCommit(next) !== false) {
            const text = next === undefined ? '' : String(next);
            setDraft({ saved: text, text });
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { pending.current = false; setSaving(false); }
      }} />
    {error && <span className="settings-error" role="alert">{error}</span>}
  </>;
}
