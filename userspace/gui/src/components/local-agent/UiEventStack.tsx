import type { UiEventTone } from '../../state/uiEvents';
import { uiEvents } from '../../state/uiEvents';
import { useUiEvents } from '../../state/useUiEvents';
import { t, type UiLanguage } from '../../i18n';
import { CloseButton, UiIcon, type UiIconName } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

const TONE_ICONS: Record<UiEventTone, UiIconName> = { info: 'info', success: 'check', warning: 'warning' };

/** The single place notification-type UI stacks, expires and is dismissed from. */
export function UiEventStack({ sessionId, language }: { sessionId?: string | null; language: UiLanguage }) {
  const identity = useUiOwner('conversation.notices', undefined, { sessionId });
  const events = useUiEvents(sessionId);
  if (!events.length) return null;
  const dismissLabel = t(language, 'agent.error.dismiss');
  return <aside className="local-agent__ui-events" role="status" aria-live="polite">
    {events.map(event => <div key={event.id} className={`local-agent__ui-event local-agent__ui-event--${event.tone}`}>
      <UiIcon name={TONE_ICONS[event.tone]} size={15} />
      <span>{event.text}</span>
      <CloseButton size="compact" aria-label={dismissLabel} title={dismissLabel}
        {...identity.action('dismiss', 'click', { eventId: event.id })} onClick={() => uiEvents.dismiss(event.id)} />
    </div>)}
  </aside>;
}
