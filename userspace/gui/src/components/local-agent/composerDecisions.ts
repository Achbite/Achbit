import type { SessionProjection } from '@achbit/protocol';

/** Non-blocking questions stay in history until the Session requires user input. */
export function foregroundInteractions(projection: SessionProjection | null) {
  const run = projection?.run;
  if (!projection || !run || !['running', 'waiting'].includes(run.status)) return [];
  const awaitingAnswers = run.status === 'waiting' && run.waitingReason === 'userInput';
  return projection.interactions.filter(item => item.runId === run.runId && item.status === 'pending'
    && (item.mode !== 'continue' || awaitingAnswers));
}

/** One UI selection controls both the composer and its matching transcript card. */
export function composerDecisionView(composer: Pick<SessionProjection, 'pendingApproval' | 'pendingPlan' | 'pendingInteraction'>
  & { conversationKey: string }, selectedTextDecision?: string | null) {
  const concurrentDecisionKey = composer.pendingApproval && (composer.pendingPlan || composer.pendingInteraction)
    ? JSON.stringify([composer.conversationKey, composer.pendingApproval.approvalId,
      composer.pendingPlan?.planId, composer.pendingPlan?.revision])
    : null;
  const showApproval = Boolean(composer.pendingApproval
    && (!concurrentDecisionKey || selectedTextDecision !== concurrentDecisionKey));
  const foregroundInteractionId = !showApproval && !composer.pendingPlan
    ? composer.pendingInteraction?.interactionId ?? null : null;
  return { concurrentDecisionKey, showApproval, foregroundInteractionId };
}

/** The parent route supplies the final-handoff fact; this child preview must still agree. */
export function awaitsApprovalReviewer(approval: SessionProjection['pendingApproval']): boolean {
  return approval?.preview.approvalReviewer === 'agent' && approval.preview.review?.decision !== 'ask';
}

/** Automatic review remains a process fact, not a foreground user decision. */
export function isAutomaticApproval(approval: SessionProjection['pendingApproval'], run: SessionProjection['run'] | undefined): boolean {
  return awaitsApprovalReviewer(approval) && run?.status === 'running';
}
export function isAutomaticPlanReview(plan: SessionProjection['pendingPlan'], permissions: SessionProjection['effectivePermissions'] | undefined): boolean {
  return plan?.review?.status === 'reviewing' && permissions?.['agent.permissions.workspaceMutation'] === 'review';
}
export function foregroundApproval(approval: SessionProjection['pendingApproval'], run: SessionProjection['run'] | undefined) {
  return isAutomaticApproval(approval, run) ? null : approval;
}
export function foregroundPlan(plan: SessionProjection['pendingPlan'], permissions: SessionProjection['effectivePermissions'] | undefined) {
  return isAutomaticPlanReview(plan, permissions) ? null : plan;
}
