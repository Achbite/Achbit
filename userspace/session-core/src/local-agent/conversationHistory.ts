import { isSessionAuthorizationScope } from '@deepcode/protocol';
import type { RunLifecycleEvent, SessionEvent } from '@deepcode/protocol';

/** Journal facts remain intact. A revision excludes only the replaced conversation
 * range; session settings, directory membership and file grants retain their current values. */
export function activeConversationEvents<Event extends SessionEvent | RunLifecycleEvent>(events: readonly Event[]): Event[] {
  const revisions = events.filter((event): event is Extract<Event, { type: 'conversation.revised' }> => event.type === 'conversation.revised');
  for (const event of revisions) {
    const { fromSequence, throughSequence } = event.payload;
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 2
      || !Number.isSafeInteger(throughSequence) || throughSequence < fromSequence
      || throughSequence !== event.sequence - 1) throw new Error('conversation_revision_range_invalid');
  }
  const sessionGrants = events.filter((event): event is Extract<Event, { type: 'approval.resolved' }> =>
    event.type === 'approval.resolved' && event.payload.decision === 'allow' && (event.payload.authorizationScope !== undefined && isSessionAuthorizationScope(event.payload.authorizationScope)));
  const approvals = new Map(sessionGrants.map((event) => [event.payload.approvalId, event]));
  const authorities = new Map(sessionGrants.map((event) => [event.payload.authorityId, event.runId]));
  return events.filter((event) => {
    if (event.type === 'conversation.revised') return false;
    if (event.type.startsWith('session.') && event.type !== 'session.control.rejected') return true;
    if (event.type === 'approval.requested' || event.type === 'approval.resolved') {
      const approval = approvals.get(event.payload.approvalId);
      if (approval?.runId === event.runId && approval.callId === event.callId) return true;
    }
    if (event.type === 'approval.revoked' && authorities.get(event.payload.authorityId) === event.runId) return true;
    return !revisions.some(({ payload }) => event.sequence >= payload.fromSequence && event.sequence <= payload.throughSequence);
  });
}
