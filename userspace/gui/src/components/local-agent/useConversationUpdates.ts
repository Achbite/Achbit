import { useEffect, useState } from 'react';
import { watchConversationChanges, watchConversationEvents } from '../../services/conversationEvents';
import { useLocalAgentStore, type LocalAgentState } from '../../state/localAgentStore';

export function useConversationUpdates(refresh: () => Promise<void>, hostReady: boolean) {
  const observe = useLocalAgentStore(state => state.observeHistory);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    return startConversationUpdates(refresh, hostReady, setError, watchConversationChanges, observe);
  }, [refresh, hostReady, attempt, observe]);
  return { error, dismiss: () => setError(null), retry: () => setAttempt(value => value + 1) };
}

/** Subscribe before the baseline read. All Session changes can affect sidebar or child projections. */
export function startConversationUpdates(refresh: () => Promise<void>, hostReady: boolean,
  onError: (error: string) => void, watch = watchConversationChanges, observe?: LocalAgentState['observeHistory']): () => void {
  if (!hostReady) return () => {};
  const controller = new AbortController();
  void watch(null, controller.signal, refresh, (signal, receive) => watchConversationEvents(signal, event => {
    observe?.(event.type === 'ready' ? 'ready' : 'change');
    receive(event);
  })).catch(error => {
    if (!controller.signal.aborted) { observe?.('closed'); onError(error instanceof Error ? error.message : String(error)); }
  });
  return () => { controller.abort(); observe?.('closed'); };
}

export function useProfilesUpdated(refreshProfiles: () => Promise<void>) {
  useEffect(() => {
    const handleProfilesUpdated = () => { void refreshProfiles(); };
    window.addEventListener('achbit:llm-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('achbit:llm-profiles-updated', handleProfilesUpdated);
  }, [refreshProfiles]);
}
