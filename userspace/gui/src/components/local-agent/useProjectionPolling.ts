import { useEffect } from 'react';

export function useProjectionPolling(
  sessionId: string | null,
  projectionPollingActive: boolean,
  refresh: () => Promise<void>,
  hostReady: boolean,
) {
  useEffect(() => startProjectionPolling(projectionPollingActive, refresh, hostReady), [projectionPollingActive, refresh, sessionId, hostReady]);
}

/** One in-flight snapshot read; visibility changes never create a second polling chain. */
export function startProjectionPolling(active: boolean, refresh: () => Promise<void>, hostReady: boolean): () => void {
  // SSH authentication can keep the transport unavailable for several minutes.
  // Host readiness owns when snapshot requests may start; an idle run only
  // changes the polling interval after that connection exists.
  if (!hostReady) return () => {};
  let cancelled = false;
  let refreshing = false;
  let timeout: number | null = null;
  const schedule = () => {
    if (cancelled || refreshing || timeout !== null) return;
    const delay = document.visibilityState === 'hidden' ? 10_000 : active ? 120 : 4_000;
    timeout = window.setTimeout(() => {
      timeout = null;
      poll();
    }, delay);
  };
  const poll = () => {
    if (cancelled || refreshing) return;
    refreshing = true;
    void refresh().finally(() => { refreshing = false; schedule(); });
  };
  const visibilityChanged = () => {
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = null;
    if (document.visibilityState === 'visible') poll();
    else schedule();
  };
  schedule();
  document.addEventListener('visibilitychange', visibilityChanged);
  return () => {
    cancelled = true;
    document.removeEventListener('visibilitychange', visibilityChanged);
    if (timeout !== null) window.clearTimeout(timeout);
  };
}

export function useProfilesUpdated(refreshProfiles: () => Promise<void>) {
  useEffect(() => {
    const handleProfilesUpdated = () => {
      void refreshProfiles();
    };
    window.addEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
  }, [refreshProfiles]);
}
