import { useEffect, useState } from 'react';
import type { ConversationSessionStatus, SessionProjection } from '@deepcode/protocol';

const STORAGE_KEY = 'deepcode.gui.read-run-markers';

export function runReadMarker(run: ConversationSessionStatus['run']): string | null {
  return run && ['completed', 'cancelled', 'failed', 'releaseFailed', 'indeterminate'].includes(run.status)
    ? `${run.runId}:${run.status}`
    : null;
}

/** Local reading state only; the Session run and its terminal status stay intact. */
export function useReadRunMarkers(projection: SessionProjection | null, visible: boolean) {
  const [readRuns, setReadRuns] = useState<Record<string, string>>(readStoredRuns);
  const sessionId = projection?.sessionId;
  const marker = runReadMarker(projection?.run ?? null);

  useEffect(() => {
    if (!visible || !sessionId || !marker) return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      setReadRuns((current) => current[sessionId] === marker
        ? current
        : { ...current, [sessionId]: marker });
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [sessionId, marker, visible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(readRuns));
    } catch {
      // Reading indicators remain usable for this window when storage is unavailable.
    }
  }, [readRuns]);

  return readRuns;
}

function readStoredRuns(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )));
  } catch {
    return {};
  }
}
