import type { SessionProjection } from '@achbit/protocol';

/** Window-local display of a composer submission. It has neither a message ID nor a journal sequence. */
export interface LocalInput {
  sessionId: string | null;
  commandId: string;
  submissionId: string;
  text: string;
  attachmentNames: string[];
  acceptedRevision?: number;
}

/** A projection can win the race with the HTTP receipt. Neither text nor arrival order is identity. */
export function stillLocal(inputs: LocalInput[], view: SessionProjection | null): LocalInput[] {
  if (!view || !inputs.length) return inputs;
  const remaining = inputs.filter(input => input.sessionId !== view.sessionId
    || !(view.queuedInputs.some(q => q.commandId === input.commandId)
      || view.messages.some(m => m.role === 'user' && m.commandId === input.commandId)
      // A later edit may already have removed the accepted message. Don't resurrect it.
      || input.acceptedRevision !== undefined && view.revision >= input.acceptedRevision));
  return remaining.length === inputs.length ? inputs : remaining;
}
