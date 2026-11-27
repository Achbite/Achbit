import { useEffect, useMemo, useState } from 'react';
import { Button, CloseButton, UiIcon } from '../ui-components';

type Notice = ReturnType<typeof readCompletionNotice>;
export function readCompletionNotice(params: URLSearchParams) {
  return { session: params.get('session') ?? '', subject: params.get('body') ?? '', status: params.get('title') ?? '',
    openLabel: params.get('open') ?? '', dismissLabel: params.get('dismiss') ?? '' };
}

/** This window can open the originating conversation or hide itself. It never changes the run. */
export function completionActions(sessionId: string, report: (error: string) => void) {
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    try {
      const core = window.__TAURI__?.core;
      if (!core?.invoke) throw new Error('desktop_notifications_unavailable');
      await core.invoke(command, args);
    } catch (reason) { report(String(reason)); }
  };
  const dismiss = () => invoke('achbit_dismiss_completion');
  return { open: () => sessionId ? invoke('achbit_open_completion', { sessionId }) : undefined, dismiss,
    escape(event: KeyboardEvent) { if (event.key === 'Escape' && !event.isComposing && !event.repeat) void dismiss(); } };
}

export function CompletionReminderView({ notice, actions, error }: { notice: Notice; actions: ReturnType<typeof completionActions>; error: string }) {
  return <main><span className="reminder-mark" aria-hidden="true"><UiIcon name="check" size={16} /></span>
    <Button id="open" aria-label={notice.openLabel} aria-describedby="body title id" disabled={!notice.session} onClick={actions.open}>
      <strong id="body" title={notice.subject}>{notice.subject}</strong>
      <span className="reminder-context">Achbit · <span id="title">{notice.status}</span></span>
      <span id="id" title={notice.session} hidden={!notice.session}>{notice.session}</span>
    </Button>
    <CloseButton id="dismiss" aria-label={notice.dismissLabel} onClick={actions.dismiss} />
    <div id="error" role="alert">{error}</div></main>;
}

export default function CompletionReminderCard({ notice }: { notice: Notice }) {
  const [error, setError] = useState('');
  const actions = useMemo(() => completionActions(notice.session, setError), [notice.session]);
  useEffect(() => {
    document.addEventListener('keydown', actions.escape);
    return () => document.removeEventListener('keydown', actions.escape);
  }, [actions]);
  return <CompletionReminderView notice={notice} actions={actions} error={error} />;
}
