import { useEffect, useRef } from 'react';
import { UI_EVENT_TTL_MS } from '../../state/uiEvents';

/** For transient success feedback only. Errors and actionable state retain their owner. */
export function useAutoDismiss(message: unknown, dismiss: () => void, delay = UI_EVENT_TTL_MS) {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => latest.current(), delay);
    return () => clearTimeout(timer);
  }, [message, delay]);
}
