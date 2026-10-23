import type { SessionProjection } from '@achbit/protocol';

/** Automatic review remains a process fact, not a foreground user decision. */
export function isAutomaticApproval(approval: SessionProjection['pendingApproval'], run: SessionProjection['run'] | undefined): boolean {
  return approval?.preview.approvalReviewer === 'agent' && approval.preview.review?.decision !== 'ask' && run?.status === 'running';
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
