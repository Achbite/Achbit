import { useLayoutEffect, useRef, useState } from 'react';
import { localizedError, t, type UiLanguage } from '../../i18n';
import { interfaceReloadGuards } from '../../services/interfaceReload';
import { canQuitAchbit, quitAchbit, type QuitAchbitReply } from '../../services/runtimeAdapter';
import { Button, ModalDialog } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useSettingsSearchTarget } from './settingsSearch';
import { useSettingsHelp } from './SettingsHelp';

type Confirmation = Extract<QuitAchbitReply, { status: 'confirmationRequired' }> & { unsaved: string[] };
type QuitState = { busy: boolean; prompt: Confirmation | null; error: string | null };
const ready: QuitState = { busy: false, prompt: null, error: null };
const unsavedLabels = () => [...new Set(interfaceReloadGuards().map(guard => guard.label))];

/** One mounted About action; only a click sends IPC, never rendering, searching or cancelling. */
export function createQuitAction(publish: (state: QuitState) => void) {
  let state = ready;
  const show = (next: QuitState) => { state = next; publish(next); };
  return {
    async submit(prompt: Confirmation | null) {
      if (state.busy || state.prompt !== prompt) return;
      show({ busy: true, prompt, error: null });
      try {
        const unsaved = unsavedLabels();
        if (prompt && unsaved.some(label => !prompt.unsaved.includes(label))) {
          show({ ...ready, prompt: { ...prompt, unsaved } }); // Newly dirty settings need informed consent too.
          return;
        }
        const reply = await quitAchbit(prompt?.hostId ?? null, unsaved.length > 0);
        if (reply.status === 'confirmationRequired') show({ ...ready, prompt: { ...reply, unsaved: unsavedLabels() } });
        else show({ ...ready, busy: true }); // Native accepted exit; don't issue a second request before teardown.
      } catch (error) {
        show({ ...ready, error: error instanceof Error ? error.message : String(error) });
      }
    },
    cancel(prompt: Confirmation) { if (!state.busy && state.prompt === prompt) show(ready); },
  };
}

export default function QuitAchbitAction({ language }: { language: UiLanguage }) {
  const [state, setState] = useState(ready);
  const [action] = useState(() => createQuitAction(setState));
  return canQuitAchbit() ? <QuitAchbitControls language={language} state={state} action={action} /> : null;
}

export function QuitAchbitControls({ language, state, action }: {
  language: UiLanguage; state: QuitState; action: ReturnType<typeof createQuitAction>;
}) {
  const owner = useUiOwner('settings.quit');
  const target = useSettingsSearchTarget('about.quit');
  const cancel = useRef<HTMLButtonElement>(null);
  const { prompt, busy, error } = state;
  const { help, helpEvents, helpId } = useSettingsHelp(busy || prompt ? undefined : t(language, 'settings.quit.scope'));
  // After showModal(), even a pointer-opened destructive prompt defaults Enter to Cancel.
  useLayoutEffect(() => { if (prompt) cancel.current?.focus({ preventScroll: true }); }, [prompt]);
  return <>
    <Button {...owner.action('open', 'click')} {...helpEvents} ref={target} variant="secondary"
      aria-describedby={helpId} disabled={busy} onClick={() => void action.submit(null)}>{t(language, 'settings.quit.action')}</Button>
    {help}
    {error !== null && <p className="settings-error" role="alert">{localizedError(language, error)}</p>}
    {prompt && <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-label={t(language, 'settings.quit.title')}
      busy={busy} onClose={() => action.cancel(prompt)}>
      <section className="achbit-gui-text-dialog">
        <header><h2>{t(language, 'settings.quit.title')}</h2></header>
        <p className="achbit-gui-text-dialog__message">{t(language, 'settings.quit.scope')}</p>
        {prompt.active && <p className="achbit-gui-text-dialog__message">{t(language, 'settings.quit.active')}</p>}
        {prompt.unsaved.length > 0 && <div className="achbit-gui-text-dialog__message">
          <p>{t(language, 'settings.quit.unsaved')}</p><ul>{prompt.unsaved.map(label => <li key={label}>{label}</li>)}</ul>
        </div>}
        <footer><Button {...owner.action('cancel', 'click')} ref={cancel} autoFocus disabled={busy}
          onClick={() => action.cancel(prompt)}>{t(language, 'app.closeConfirm.cancel')}</Button>
          <Button {...owner.action('confirm', 'click')} variant="danger" disabled={busy}
            onClick={() => void action.submit(prompt)}>{t(language, 'settings.quit.action')}</Button></footer>
      </section>
    </ModalDialog>}
  </>;
}
