import { useEffect, useRef, useState } from 'react';
import type { ConversationSessionStatus, ConversationSessionSummary } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { hasDesktopNotifications, notifyTaskCompleted } from '../../services/runtimeAdapter';
import { useSettingsStore } from '../../state/settingsStore';
import { CompletionNotifications } from './completionNotifications';

export function useCompletionNotifications(
  statuses: Record<string, ConversationSessionStatus>,
  sessions: ConversationSessionSummary[],
  language: UiLanguage,
) {
  const foregroundSound = useSettingsStore(state => state.effectiveSettings['gui.completionSound.foreground'] === true);
  const tracker = useRef(new CompletionNotifications());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const completed = tracker.current.update(statuses, sessions.map(session => session.id));
    if (!hasDesktopNotifications()) return;
    for (const status of completed) {
      const title = sessions.find(session => session.id === status.sessionId)?.title
        || status.title || t(language, 'achbitGui.nav.newChat');
      void notifyTaskCompleted({ foregroundSound, sessionId: status.sessionId,
        title: t(language, 'achbitGui.notification.completed'), body: title,
        openLabel: t(language, 'achbitGui.notification.open'),
        dismissLabel: t(language, 'achbitGui.notification.dismiss'),
      }).then(() => setError(null)).catch(reason => {
        setError(t(language, 'achbitGui.notification.failed', { error: String(reason) }));
      });
    }
  }, [statuses, sessions, language, foregroundSound]);
  return { error, dismiss: () => setError(null) };
}
