import { useEffect, useState } from 'react';
import { watchConversationChanges } from '../../services/conversationEvents';

export function useConversationUpdates(sessionId: string | null, refresh: () => Promise<void>, hostReady: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    return startConversationUpdates(refresh, hostReady, setError);
  }, [sessionId, refresh, hostReady, attempt]);
  return { error, dismiss: () => setError(null), retry: () => setAttempt(value => value + 1) };
}

/** Subscribe before the baseline read. All Session changes can affect sidebar or child projections. */
export function startConversationUpdates(refresh: () => Promise<void>, hostReady: boolean,
  onError: (error: string) => void, watch = watchConversationChanges): () => void {
  if (!hostReady) return () => {};
  const controller = new AbortController();
  void watch(null, controller.signal, refresh).catch(error => {
    if (!controller.signal.aborted) onError(error instanceof Error ? error.message : String(error));
  });
  return () => controller.abort();
}

export function useProfilesUpdated(refreshProfiles: () => Promise<void>) {
  useEffect(() => {
    const handleProfilesUpdated = () => { void refreshProfiles(); };
    window.addEventListener('achbit:llm-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('achbit:llm-profiles-updated', handleProfilesUpdated);
  }, [refreshProfiles]);
}
