import type { ConversationRound } from './conversationItems';

// Saved positions can name either a timeline row or one of its round's own controls.
function rowAtAnchor(round: ConversationRound, anchor: string): number {
  const row = round.rows.findIndex(item => item.key === anchor);
  if (row >= 0) return row;
  if (anchor === `${round.key}:disclosure`) return Math.max(0, round.rows.findIndex(item => item.item?.type !== 'message'));
  return ['file-changes', 'reasoning-history', 'provider-status'].some(suffix => anchor === `${round.key}:${suffix}`)
    ? Math.max(0, round.rows.length - 1) : -1;
}

/** Choose which execution details near the saved row or tail mount immediately. */
export function openingRows(rounds: readonly ConversationRound[], anchor?: string, limit = 12): Set<string> {
  let total = 0, target = -1;
  const keys = new Set<string>();
  for (const round of rounds) {
    if (anchor && target < 0) {
      const i = rowAtAnchor(round, anchor);
      if (i >= 0) { target = total + i; keys.add(anchor); }
    }
    total += round.rows.length;
  }
  const start = Math.max(0, Math.min(total - limit, target < 0 ? total : target - Math.floor(limit / 3)));
  let index = 0;
  for (const round of rounds) {
    const end = index + round.rows.length;
    for (let i = Math.max(index, start); i < Math.min(end, start + limit); i++) keys.add(round.rows[i - index]!.key);
    if (end >= start + limit) break;
    index = end;
  }
  return keys;
}
