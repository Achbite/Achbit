import type { ConversationSessionStatus } from '@deepcode/protocol';

/** Observe transitions, never replay the completed history loaded when a window opens. */
export class CompletionNotifications {
  private seen = new Map<string, ConversationSessionStatus>();

  update(statuses: Record<string, ConversationSessionStatus>, sessionIds: string[]): ConversationSessionStatus[] {
    const completed: ConversationSessionStatus[] = [];
    for (const current of Object.values(statuses)) {
      const previous = this.seen.get(current.sessionId);
      if (previous && current.revision <= previous.revision) continue;
      this.seen.set(current.sessionId, current);
      if (previous && current.run?.status === 'completed'
        && (previous.run?.runId !== current.run.runId || previous.run.status !== 'completed')) {
        completed.push(current);
      }
    }
    const retained = new Set([...sessionIds, ...Object.keys(statuses)]);
    for (const id of this.seen.keys()) if (!retained.has(id)) this.seen.delete(id);
    return completed;
  }
}
