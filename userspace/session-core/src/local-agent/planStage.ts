import type {
  NewSessionEvent, PlanAuthority, SessionProjection,
} from '@deepcode/protocol';
import { SESSION_CONTROL_PLAN_PUBLISH } from '@deepcode/protocol';
import { canonicalJsonValue } from './providerToolCodec.js';
import { LoopFailure } from './loopFailure.js';
import type { SessionState } from './reducer.js';
import type { PlanPublicationDraft, PlanScopeExtension } from './sessionControls.js';

/** Plan lifecycle is derived from the Session journal, never a second loop or store. */
export function publishPlan(
  state: SessionState,
  runId: string,
  callId: string,
  providerCallId: string,
  input: PlanPublicationDraft | PlanScopeExtension,
  workspaceIds: readonly string[],
  nextId: (kind: string) => string,
): NewSessionEvent {
  const latest = state.plans.findLast((plan) => plan.runId === runId);
  const previous = latest && ['confirmed', 'revisionRequested'].includes(latest.status)
    ? latest : undefined;
  const planId = previous?.planId ?? nextId('plan');
  if (!planId || planId === callId || planId === providerCallId || callId === providerCallId) {
    throw new LoopFailure('plan_identity_invalid', 'Plan、LogicalCall 与 ProviderCall 必须具有独立身份。');
  }
  if (!previous && state.plans.some((plan) => plan.planId === planId)) {
    throw new LoopFailure('plan_id_reused', 'Session 生成的 planId 已经存在。');
  }
  const reject = (code: string, message: string): NewSessionEvent => ({
    type: 'session.control.rejected', sessionId: state.sessionId, runId, callId,
    payload: { providerCallId, toolName: SESSION_CONTROL_PLAN_PUBLISH, input: { ...input }, error: { code, message } },
  });
  let draft: PlanPublicationDraft;
  if ('mode' in input) {
    if (previous?.status !== 'confirmed') return reject('plan_scope_extension_not_active',
      'Scope additions need a confirmed Plan in this run. Publish a complete Plan for a new task.');
    const manifest = structuredClone(previous.mutationManifest);
    const keys = new Set(manifest.map((operation) => JSON.stringify(canonicalJsonValue(operation))));
    for (const operation of input.mutationManifest) {
      const key = JSON.stringify(canonicalJsonValue(operation));
      if (!keys.has(key)) { manifest.push(structuredClone(operation)); keys.add(key); }
    }
    if (manifest.length === previous.mutationManifest.length) return reject('plan_scope_extension_unchanged',
      'No new scope was proposed. Continue within the confirmed scope.');
    draft = {
      title: previous.title, summary: `${previous.summary}\n\n${input.summary}`,
      steps: structuredClone(previous.steps), mutationManifest: manifest,
    };
  } else {
    draft = input;
  }
  const unknownWorkspace = draft.mutationManifest.find((operation) => !workspaceIds.includes(operation.workspaceId));
  if (unknownWorkspace) return reject('plan_workspace_binding_invalid', 'Plan 包含不属于当前运行的工作区。请使用当前 Session 目录索引。');
  if (previous) {
    const definition = (plan: PlanPublicationDraft) => JSON.stringify(canonicalJsonValue({
      title: plan.title, summary: plan.summary, steps: plan.steps, mutationManifest: plan.mutationManifest,
    }));
    if (definition(previous) === definition(draft)) return reject(
      'plan_revision_unchanged',
      'The proposed Plan is unchanged. Continue within the confirmed scope, or explain the result. Publish a revision only for a material scope change.',
    );
  }
  return {
    type: 'plan.published', sessionId: state.sessionId, runId, callId,
    payload: {
      ...structuredClone(draft), planId, revision: (previous?.revision ?? 0) + 1, providerCallId,
    },
  };
}

export function confirmationFacts(state: SessionState, plan: NonNullable<SessionProjection['pendingPlan']>,
  commandId: string, source: 'user' | 'agent' | 'parent', nextId: (kind: string) => string,
  inheritedAuthorities?: PlanAuthority[]): NewSessionEvent[] {
  const decisionId = nextId('plan-decision');
  const previous = planToSupersede(state, plan.planId, plan.revision);
  const events: NewSessionEvent[] = [];
  if (previous) events.push({ type: 'plan.superseded', sessionId: state.sessionId, runId: plan.runId,
    payload: { ...previous, supersededByPlanId: plan.planId, supersededByRevision: plan.revision } });
  events.push({ type: 'plan.confirmed', sessionId: state.sessionId, runId: plan.runId, callId: plan.callId,
    payload: { planId: plan.planId, revision: plan.revision, commandId, source, decisionId,
      authorities: source === 'parent' ? structuredClone(inheritedAuthorities ?? [])
        : planAuthoritiesForConfirmation(plan, state.sessionId, decisionId, nextId) } });
  return events;
}

export function planAuthoritiesForConfirmation(
  plan: NonNullable<SessionProjection['pendingPlan']>,
  sessionId: string,
  decisionId: string,
  nextId: (kind: string) => string,
): PlanAuthority[] {
  const workspaceIds = [...new Set(plan.mutationManifest.map((operation) => operation.workspaceId))];
  return workspaceIds.map((workspaceId) => ({
    authorityId: nextId('plan-authority'),
    planId: plan.planId,
    revision: plan.revision,
    decisionId,
    sessionId,
    runId: plan.runId,
    workspaceId,
    coveredOperations: plan.mutationManifest
      .filter((operation) => operation.workspaceId === workspaceId)
      .map((operation) => ({ ...operation })),
  }));
}

export function planToSupersede(
  state: SessionState,
  nextPlanId: string,
  nextRevision: number,
): { planId: string; revision: number } | null {
  if (state.activePlanRef && (
    state.activePlanRef.planId !== nextPlanId
    || state.activePlanRef.revision !== nextRevision
  )) return { ...state.activePlanRef };
  const previousRevision = state.plans
    .filter((candidate) => (
      candidate.planId === nextPlanId
      && candidate.revision < nextRevision
      && (candidate.status === 'confirmed' || candidate.status === 'revisionRequested')
    ))
    .sort((left, right) => right.revision - left.revision)[0];
  return previousRevision
    ? { planId: previousRevision.planId, revision: previousRevision.revision }
    : null;
}
