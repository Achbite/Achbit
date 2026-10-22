import { useEffect, useRef, useState } from 'react';
import type { ConversationSessionStatus, ConversationSessionSummary } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { hasDesktopNotifications, notifyTaskCompleted } from '../../services/runtimeAdapter';
import { CompletionNotifications } from './completionNotifications';

export function useCompletionNotifications(
  statuses: Record<string, ConversationSessionStatus>,
  sessions: ConversationSessionSummary[],
  language: UiLanguage,
) {
  const tracker = useRef(new CompletionNotifications());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const completed = tracker.current.update(statuses, sessions.map(session => session.id));
    if (!hasDesktopNotifications()) return;
    for (const status of completed) {
      const title = sessions.find(session => session.id === status.sessionId)?.title
        || status.title || t(language, 'deepcodeGui.nav.newChat');
      void notifyTaskCompleted({ sessionId: status.sessionId,
        title: t(language, 'deepcodeGui.notification.completed'), body: title,
        openLabel: t(language, 'deepcodeGui.notification.open'),
        dismissLabel: t(language, 'deepcodeGui.notification.dismiss'),
      }).then(() => setError(null)).catch(reason => {
        setError(t(language, 'deepcodeGui.notification.failed', { error: String(reason) }));
      });
    }
  }, [statuses, sessions, language]);
  return { error, dismiss: () => setError(null) };
}
