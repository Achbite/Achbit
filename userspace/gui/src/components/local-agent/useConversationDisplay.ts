import { useCallback, useRef, useState } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { conversationDisplay } from './conversationDisplay';

/** Presentation acknowledgement only; Session still owns every run and message fact. */
export function useConversationDisplay(projection: SessionProjection | null) {
  const [, revise] = useState(0);
  const state = useRef({ sessionId: projection?.sessionId, liveRuns: new Set<string>(), displayed: new Map<string, string>() });
  if (state.current.sessionId !== projection?.sessionId) state.current = { sessionId: projection?.sessionId, liveRuns: new Set(), displayed: new Map() };
  if (projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status)) state.current.liveRuns.add(projection.run.runId);
  const sessionId = projection?.sessionId;
  const onDisplayed = useCallback((identity: string, text: string) => {
    if (state.current.liveRuns.size === 0) return;
    if (state.current.sessionId !== sessionId || state.current.displayed.get(identity) === text) return;
    state.current.displayed.set(identity, text);
    revise((value) => value + 1);
  }, [sessionId]);
  return { ...conversationDisplay(projection, state.current.liveRuns, state.current.displayed), onDisplayed };
}
