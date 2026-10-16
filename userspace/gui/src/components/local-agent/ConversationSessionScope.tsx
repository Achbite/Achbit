import { createContext, useContext } from 'react';
import { useLocalAgentStore } from '../../state/localAgentStore';

/** Embedded child content resolves resources against its own Session. */
export const ConversationSessionScope = createContext<string | undefined>(undefined);

export function useConversationSessionId(): string | null {
  const scoped = useContext(ConversationSessionScope);
  const selected = useLocalAgentStore(state => state.sessionId);
  return scoped ?? selected;
}
