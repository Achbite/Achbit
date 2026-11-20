import { ConversationBodyLinkScope, useConversationBodyLinks } from './useConversationBodyLinks';
import { useCallback, useEffect, useState } from 'react';
import type { PendingAgentDecision, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ModalDialog } from '../../ui-components';
import { ChildDecisions, type ChildReviewItem } from './AgentTasksPanel';
import { ConversationSessionScope } from './ConversationSessionScope';
import { pendingChildApproval, useAgentChildConversation } from './useAgentChildConversation';
import { awaitsApprovalReviewer } from './composerDecisions';
import './agentPlanReview.css';

type ReviewKind = ChildReviewItem['kind'];
type ReviewRoute = { decision: PendingAgentDecision; kind: ReviewKind; key: string };

/** A single child route can carry both a Plan and permission. Deferral is local to one item. */
export function nextAgentPlanReview(decisions: readonly PendingAgentDecision[], dismissed: ReadonlySet<string>): ReviewRoute | null {
  for (const decision of decisions) {
    const owner = [decision.agentSessionId, decision.runId];
    if (decision.plan) {
      const key = JSON.stringify([...owner, 'plan', decision.plan.planId, decision.plan.revision]);
      if (!dismissed.has(key)) return { decision, kind: 'plan', key };
    }
    if (decision.approval) {
      const key = JSON.stringify([...owner, 'approval', decision.approval.callId, decision.approval.approvalId]);
      if (!dismissed.has(key)) return { decision, kind: 'approval', key };
    }
  }
  return null;
}

export function matchesAgentPlanReview(decision: PendingAgentDecision, projection: SessionProjection): boolean {
  const plan = projection.pendingPlan;
  return Boolean(decision.plan && plan && projection.sessionId === decision.agentSessionId
    && plan.runId === decision.runId && plan.planId === decision.plan.planId && plan.revision === decision.plan.revision);
}

export function AgentPlanReview({ decisions, language, refresh }: {
  decisions: readonly PendingAgentDecision[]; language: UiLanguage; refresh(): Promise<void>;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const review = nextAgentPlanReview(decisions, dismissed);
  const key = review?.key;
  const dismiss = useCallback(() => {
    if (key) setDismissed(current => new Set([...current, key]));
  }, [key]);
  const resolved = useCallback(() => { dismiss(); void refresh(); }, [dismiss, refresh]);
  return review ? <AgentReviewRoute key={review.key} decision={review.decision} kind={review.kind} language={language}
    onDismiss={dismiss} onResolved={resolved} /> : null;
}

type ReviewProps = Pick<ReviewRoute, 'decision' | 'kind'> & { language: UiLanguage; onDismiss(): void; onResolved(): void };
function AgentReviewRoute(props: ReviewProps) {
  const child = useAgentChildConversation(props.decision.agentSessionId, true, props.kind === 'approval' ? props.decision : undefined);
  return <AgentReviewDialog {...props} child={child} />;
}

export function AgentReviewDialog({ child, decision, kind, language, onDismiss, onResolved }: ReviewProps & {
  child: ReturnType<typeof useAgentChildConversation>;
}) {
  const projection = child.projection;
  const [linkError, setLinkError] = useState<string | null>(null);
  const bodyLinks = useConversationBodyLinks(projection, language, setLinkError);
  const plan = kind === 'plan' && projection && matchesAgentPlanReview(decision, projection) ? projection.pendingPlan : null;
  const approval = kind === 'approval' && decision.approval && projection?.sessionId === decision.agentSessionId
    ? pendingChildApproval(projection, { runId: decision.runId, ...decision.approval }) : null;
  const item: ChildReviewItem | null = plan ? { kind: 'plan', plan } : approval ? { kind: 'approval', approval } : null;
  const stale = !!projection && !item && !child.readError;
  useEffect(() => { if (stale) onResolved(); }, [stale, onResolved]);
  // Session only routes final human handoffs. A sibling may still be running; this child read
  // must match the exact item and, for a delegated review, contain its ask before showing it.
  if (stale || (kind === 'approval' && !projection && !child.readError) || awaitsApprovalReviewer(approval)) return null;
  const title = t(language, kind === 'plan' ? 'agent.plan.review' : 'agent.approval.toolPermission');
  return <ConversationBodyLinkScope.Provider value={bodyLinks.open}><ConversationSessionScope.Provider value={decision.agentSessionId}>
    <ModalDialog className="agent-plan-review" aria-label={title}
      busy={child.submitting} onClose={onDismiss}>
      <section className="local-agent agent-plan-review__card">
        <header className="agent-plan-review__heading">
          <div><h2>{title}</h2><p>{decision.displayName}</p></div>
          <button type="button" disabled={child.submitting} onClick={onDismiss}>{t(language, 'agent.team.reviewLater')}</button>
        </header>
        <div className="agent-plan-review__body">
          {bodyLinks.selection}
          {linkError && <p role="alert" className="agent-tasks__error">{linkError}</p>}
          {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
            <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
          {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
          {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
          {projection && item && <ChildDecisions child={child} projection={projection} language={language} only={item} />}
        </div>
      </section>
    </ModalDialog>
  </ConversationSessionScope.Provider></ConversationBodyLinkScope.Provider>;
}
