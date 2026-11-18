import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import { reconcileSettingDraft } from '../settings-center/settingDraft';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'onKeyDown'> & {
  value: number | undefined;
  language: UiLanguage;
  label: string;
  onCommit(value: number | undefined): Promise<boolean | void>;
  /** Forms can submit the current numeric draft without first pressing Enter. */
  onDraftChange?(value: number | undefined): void;
};

const sameNumber = (text: string, saved: string) => text === saved || text !== '' && saved !== '' && Number(text) === Number(saved);

export default function ConfirmedNumberInput({ value, language, label, onCommit, onDraftChange, disabled, ...props }: Props) {
  const saved = value === undefined || !Number.isFinite(value) ? '' : String(value);
  const [draft, setDraft] = useState({ saved, text: saved });
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(current => current.saved !== saved && sameNumber(current.text, saved)
    ? { saved, text: saved } : reconcileSettingDraft(current, saved)), [saved]);
  useInterfaceReloadGuard(!sameNumber(draft.text, saved), label, saving);
  return <>
    <input {...props} type="number" value={draft.text} disabled={disabled || saving}
      title={props.title ?? t(language, 'settings.edit.confirmNumber')}
      onChange={event => {
        const input = event.target, text = input.value;
        setDraft(current => ({ ...current, text })); setError(null);
        // Native number inputs can expose an empty value for incomplete, invalid input.
        onDraftChange?.(text === '' && !input.validity.badInput ? undefined : input.valueAsNumber);
      }}
      onKeyDown={async event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
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
