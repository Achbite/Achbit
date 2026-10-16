import type {
  ContextCompositionReceipt,
  ContextModelViewContribution,
  SessionEvent,
} from '@deepcode/protocol';

/** Read derived views from the same journal; execution facts remain authoritative. */
export function journalModelViews(events: readonly SessionEvent[]): {
  throughSequence: number;
  contributions: Map<string, ContextModelViewContribution>;
} {
  let throughSequence = 0;
  const contributions = new Map<string, ContextModelViewContribution>();
  for (const event of events) {
    if (event.type !== 'context.composed' || !event.payload.modelView) continue;
    throughSequence = Math.max(throughSequence, event.payload.modelView.throughSequence);
    for (const contribution of event.payload.modelView.additions) {
      contributions.set(contribution.contributionId, contribution);
    }
  }
  return { throughSequence, contributions };
}

/** Check new journal writes once, at Session admission, without re-rendering history. */
export function admitModelView(receipt: ContextCompositionReceipt, events: readonly SessionEvent[]): void {
  if (receipt.purpose === 'approvalReview') {
    if (receipt.modelView !== undefined) throw new Error('context_model_view_purpose_invalid');
    return;
  }
  if (!receipt.modelView) throw new Error('context_model_view_missing');
  const { throughSequence, additions } = receipt.modelView;
  const factSequences = new Set(events.map(event => event.sequence));
  if (!Number.isSafeInteger(throughSequence) || !factSequences.has(throughSequence)) {
    throw new Error('context_model_view_boundary_invalid');
  }
  const existing = journalModelViews(events).contributions;
  const selected = new Map(receipt.messages.map(message => [message.contributionId, message]));
  for (const contribution of additions) {
    const message = selected.get(contribution.contributionId);
    if (!message || existing.has(contribution.contributionId)
      || !factSequences.has(contribution.sourceSequence) || contribution.sourceSequence > throughSequence
      || message.role !== contribution.message.role || message.contributionKind !== contribution.contributionKind
      || contribution.message.images?.length || contribution.message.toolImages?.length) {
      throw new Error('context_model_view_contribution_invalid');
    }
    existing.set(contribution.contributionId, contribution);
  }
  if (receipt.messages.some(message => message.contributionKind === 'journalMessages'
    && !existing.has(message.contributionId))) {
    throw new Error('context_model_view_contribution_missing');
  }
}
