import type { ConversationRound } from './conversationItems';
import type { InteractionProjection } from '@achbit/protocol';
import { messageDisplayText } from './interactionPresentation';

export interface ConversationNavigationEntry { key: string; rowIndex: number; label: string }

export function conversationNavigation(rounds: ConversationRound[], interactions: InteractionProjection[] = []): ConversationNavigationEntry[] {
  const entries: ConversationNavigationEntry[] = [];
  let rowIndex = 0;
  for (const round of rounds) for (const row of round.rows) {
    if (row.item?.type === 'message' && row.item.value.role === 'user') {
      entries.push({
        key: row.key,
        rowIndex,
        label: messageDisplayText(row.item.value, interactions).trim().slice(0, 180)
          || row.item.value.filesystemReferences.map((reference) => reference.displayName).join(', ').slice(0, 180),
      });
    }
    rowIndex += 1;
  }
  return entries;
}
