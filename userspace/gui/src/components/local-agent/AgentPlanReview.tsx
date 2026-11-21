import { ConversationBodyLinkScope, useConversationBodyLinks } from './useConversationBodyLinks';
import { useCallback, useEffect, useState } from 'react';
import type { PendingAgentDecision, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { Button, ModalDialog } from '../../ui-components';
import { ChildDecisions, type ChildReviewItem } from './AgentTasksPanel';
import { ConversationSessionScope } from './ConversationSessionScope';
import { pendingChildApproval, pendingChildInteraction, useAgentChildConversation, type ChildReviewTarget } from './useAgentChildConversation';
import { awaitsApprovalReviewer } from './composerDecisions';
import './agentPlanReview.css';

type ReviewRoute = ChildReviewTarget & { key: string };
type ReviewState = 'later' | 'resolved';

/** Preserve the published order of Plans and approvals, even for multiple routes to the same child. */
function* planAndApprovalReviews(decisions: readonly PendingAgentDecision[]): Generator<ReviewRoute> {
  for (const decision of decisions) {
    const owner = [decision.agentSessionId, decision.runId];
    if (decision.plan) {
      const key = JSON.stringify([...owner, 'plan', decision.plan.planId, decision.plan.revision]);
      yield { decision, kind: 'plan', key };
    }
    if (decision.approval) {
      const key = JSON.stringify([...owner, 'approval', decision.approval.callId, decision.approval.approvalId]);
      yield { decision, kind: 'approval', key };
    }
  }
}

function* agentReviews(decisions: readonly PendingAgentDecision[]): Generator<ReviewRoute> {
  yield* planAndApprovalReviews(decisions);
  for (const decision of decisions) {
    for (const interactionId of decision.interactionIds) {
      const key = JSON.stringify([decision.agentSessionId, decision.runId, 'interaction', interactionId]);
      yield { decision, kind: 'interaction', interactionId, key };
    }
  }
}

function nextReview(routes: Iterable<ReviewRoute>, dismissed: Pick<ReadonlySet<string>, 'has'>) {
  for (const route of routes) if (!dismissed.has(route.key)) return route;
  return null;
}

export function nextAgentPlanReview(decisions: readonly PendingAgentDecision[], dismissed: ReadonlySet<string>) {
  return nextReview(planAndApprovalReviews(decisions), dismissed);
}

export function nextAgentReview(decisions: readonly PendingAgentDecision[], dismissed: Pick<ReadonlySet<string>, 'has'>) {
  return nextReview(agentReviews(decisions), dismissed);
}

export function matchesAgentPlanReview(decision: PendingAgentDecision, projection: SessionProjection): boolean {
  const plan = projection.pendingPlan;
  return Boolean(decision.plan && plan && projection.sessionId === decision.agentSessionId
    && plan.runId === decision.runId && plan.planId === decision.plan.planId && plan.revision === decision.plan.revision);
}

export function AgentPlanReview({ decisions, language, refresh }: {
  decisions: readonly PendingAgentDecision[]; language: UiLanguage; refresh(): Promise<void>;
}) {
  const [skipped, setSkipped] = useState<ReadonlyMap<string, ReviewState>>(() => new Map());
  const [reopened, setReopened] = useState<string | null>(null);
  const automatic = nextAgentReview(decisions, skipped);
  const later: ReviewRoute[] = [];
  if (skipped.size && (!automatic || reopened)) {
    const published = new Map(Array.from(agentReviews(decisions), route => [route.key, route] as const));
    for (const [key, state] of skipped) {
      const route = published.get(key);
      if (state === 'later' && route) later.push(route);
    }
  }
  const manual = later.find(route => route.key === reopened);
  const review = manual ?? automatic;
  const key = review?.key;
  const finish = useCallback((state: ReviewState) => {
    if (!key) return;
    setSkipped(current => {
      const next = new Map(current);
      next.delete(key); // Deferring a reopened item moves it behind its still-deferred siblings.
      return next.set(key, state);
    });
    setReopened(null);
  }, [key]);
  const dismiss = useCallback(() => finish('later'), [finish]);
  const resolved = useCallback(() => { finish('resolved'); void refresh(); }, [finish, refresh]);
  let dialog = null;
  if (review) {
    const { key, ...target } = review;
    dialog = <AgentReviewRoute key={key} {...target} language={language} onDismiss={dismiss} onResolved={resolved} />;
  }
  if (!later.length || (automatic && !manual)) return dialog;
  // Keep the opener mounted for native dialog focus return. Opening it never answers or clears another item.
  return <><Button className="agent-plan-review__reopen" variant="secondary" size="compact" aria-haspopup="dialog"
    onClick={() => setReopened(later[0].key)}>{t(language, 'agent.decision.pending')} ({later.length})</Button>{dialog}</>;
}

type ReviewProps = ChildReviewTarget & { language: UiLanguage; onDismiss(): void; onResolved(): void };
function AgentReviewRoute(props: ReviewProps) {
  const child = useAgentChildConversation(props.decision.agentSessionId, true, props);
  return <AgentReviewDialog {...props} child={child} />;
}

export function AgentReviewDialog(props: ReviewProps & { child: ReturnType<typeof useAgentChildConversation> }) {
  const { child, decision, kind, language, onDismiss, onResolved } = props;
  const projection = child.projection;
  const [linkError, setLinkError] = useState<string | null>(null);
  const bodyLinks = useConversationBodyLinks(projection, language, setLinkError);
  const plan = kind === 'plan' && projection && matchesAgentPlanReview(decision, projection) ? projection.pendingPlan : null;
  const approval = kind === 'approval' && decision.approval && projection?.sessionId === decision.agentSessionId
    ? pendingChildApproval(projection, { runId: decision.runId, ...decision.approval }) : null;
  const interaction = props.kind === 'interaction'
    ? pendingChildInteraction(projection, { runId: decision.runId, interactionId: props.interactionId }, decision) : null;
  const item: ChildReviewItem | null = plan ? { kind: 'plan', plan } : approval ? { kind: 'approval', approval }
    : interaction ? { kind: 'interaction', interaction } : null;
  const stale = !!projection && !item && !child.readError;
  useEffect(() => { if (stale) onResolved(); }, [stale, onResolved]);
  // Session only routes final human handoffs. A sibling may still be running; this child read
  // must match the exact item and, for a delegated review, contain its ask before showing it.
  if (stale || (kind !== 'plan' && !projection && !child.readError) || awaitsApprovalReviewer(approval)) return null;
  const title = t(language, kind === 'plan' ? 'agent.plan.review' : kind === 'approval' ? 'agent.approval.toolPermission'
    : interaction?.kind === 'confirmation' ? 'agent.interaction.confirmation' : 'agent.interaction.question');
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
