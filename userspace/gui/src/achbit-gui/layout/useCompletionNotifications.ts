import { useEffect, useRef, useState } from 'react';
import type { ConversationSessionSummary } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { hasDesktopNotifications, notifyTaskCompleted } from '../../services/runtimeAdapter';
import { watchConversationEvents } from '../../services/conversationEvents';
import { useSettingsStore } from '../../state/settingsStore';
import useAppStatusStore from '../../state/appStatusStore';
import { CompletionNotifications } from './completionNotifications';

export function useCompletionNotifications(sessions: ConversationSessionSummary[], language: UiLanguage) {
  const foregroundSound = useSettingsStore(state => state.effectiveSettings['gui.completionSound.foreground'] === true);
  const hostReady = useAppStatusStore(state => state.apiStatus === 'connected');
  const tracker = useRef(new CompletionNotifications());
  const latest = useRef({ sessions, language, foregroundSound });
  latest.current = { sessions, language, foregroundSound };
  const [error, setError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!hostReady) return;
    const controller = new AbortController();
    void watchConversationEvents(controller.signal, event => {
      if (event.type === 'ready') { setWatchError(null); return; }
      if (!tracker.current.accept(event) || event.type !== 'settled' || !hasDesktopNotifications()) return;
      const current = latest.current;
      const title = current.sessions.find(session => session.id === event.sessionId)?.title
        || t(current.language, 'achbitGui.nav.newChat');
      void notifyTaskCompleted({ foregroundSound: current.foregroundSound, sessionId: event.sessionId,
        title: t(current.language, 'achbitGui.notification.completed'), body: title,
        openLabel: t(current.language, 'achbitGui.notification.open'),
        dismissLabel: t(current.language, 'achbitGui.notification.dismiss'),
      }).catch(reason => {
        if (!controller.signal.aborted) setError(t(latest.current.language, 'achbitGui.notification.failed', { error: String(reason) }));
      });
    }).catch(reason => {
      if (!controller.signal.aborted) setWatchError(t(latest.current.language, 'achbitGui.notification.failed', { error: String(reason) }));
    });
    return () => controller.abort();
  }, [hostReady, attempt]);
  return { error: watchError ?? error, canRetry: watchError !== null,
    dismiss: () => { setError(null); setWatchError(null); },
    retry: () => { setWatchError(null); setAttempt(value => value + 1); } };
}
