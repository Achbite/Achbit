import { useSyncExternalStore } from 'react';
import { uiEvents, type UiEvent } from './uiEvents';

/** Session-scoped read of the shared notice store; a notice never leaks into another conversation. */
export function useUiEvents(sessionId?: string | null): readonly UiEvent[] {
  const events = useSyncExternalStore(uiEvents.subscribe, uiEvents.snapshot, uiEvents.snapshot);
  return events.filter(event => event.sessionId === (sessionId ?? undefined));
}
