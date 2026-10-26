import type { ConversationEvent } from '../../services/conversationEvents';

/** Only new Host settlement events can notify; history snapshots and ready boundaries cannot. */
export class CompletionNotifications {
  private seen = new Map<string, { runId: string; sequence: number }>();

  accept(event: ConversationEvent): boolean {
    if (event.type !== 'settled' || event.outcome !== 'completed') return false;
    const previous = this.seen.get(event.sessionId);
    if (previous && (event.eventSequence <= previous.sequence || event.runId === previous.runId)) return false;
    this.seen.set(event.sessionId, { runId: event.runId, sequence: event.eventSequence });
    return true;
  }
}
