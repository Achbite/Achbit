import { useEffect, useRef } from 'react';

/** For local action feedback only. Session failures are never timed away. */
export function useAutoDismiss(message: unknown, dismiss: () => void, delay = 6000) {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => latest.current(), delay);
    return () => clearTimeout(timer);
  }, [message, delay]);
}
