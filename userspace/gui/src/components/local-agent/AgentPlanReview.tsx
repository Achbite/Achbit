import { ConversationBodyLinkScope, useConversationBodyLinks } from './useConversationBodyLinks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { PendingAgentDecision, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { Button, ModalDialog } from '../../ui-components';
import { ChildDecisions, type ChildReviewItem } from './AgentTasksPanel';
import { ConversationSessionScope } from './ConversationSessionScope';
import { pendingChildInteraction, useAgentChildConversation, type ChildReviewTarget } from './useAgentChildConversation';
import { awaitsApprovalReviewer, selectPendingApproval } from './composerDecisions';
import './agentPlanReview.css';

type ReviewRoute = ChildReviewTarget & { key: string };
type ReviewState = 'later' | 'resolved';

/** Preserve the published order of Plans and approvals, even for multiple routes to the same child. */
export function* planAndApprovalReviews(decisions: readonly PendingAgentDecision[]): Generator<ReviewRoute> {
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

export function* agentReviews(decisions: readonly PendingAgentDecision[]): Generator<ReviewRoute> {
  yield* planAndApprovalReviews(decisions);
  for (const decision of decisions) {
    for (const interactionId of decision.interactionIds) {
      const key = JSON.stringify([decision.agentSessionId, decision.runId, 'interaction', interactionId]);
      yield { decision, kind: 'interaction', interactionId, key };
    }
  }
}

export function nextReview(routes: Iterable<ReviewRoute>, dismissed: Pick<ReadonlySet<string>, 'has'>) {
  for (const route of routes) if (!dismissed.has(route.key)) return route;
  return null;
}

export function matchesAgentPlanReview(decision: PendingAgentDecision, projection: SessionProjection): boolean {
  const plan = projection.pendingPlan;
  return Boolean(decision.plan && plan && projection.sessionId === decision.agentSessionId
    && plan.runId === decision.runId && plan.planId === decision.plan.planId && plan.revision === decision.plan.revision);
}

type DraftAccess = { read(key: string): string; write(key: string, text: string): void };

/** Plans keep their explicit review dialog. Tool permissions and questions share the parent composer. */
export function AgentPlanReview({ decisions, language, refresh, preferParent = false, drafts, onInlineChange }: {
  decisions: readonly PendingAgentDecision[]; language: UiLanguage; refresh(): Promise<void>;
  preferParent?: boolean; drafts?: DraftAccess; onInlineChange?(present: boolean): void;
}) {
  const [skipped, setSkipped] = useState<ReadonlyMap<string, ReviewState>>(() => new Map());
  const [reopened, setReopened] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const published = useMemo(() => new Map(Array.from(agentReviews(decisions), route => [route.key, route] as const)), [decisions]);
  const manual = reopened ? published.get(reopened) : undefined;
  const held = pinned && !skipped.has(pinned) ? published.get(pinned) : undefined;
  // A new sibling must not replace the answer being edited. An existing parent decision or draft
  // stays in place unless the user explicitly opens a child item. Plans retain their own flow.
  const automatic = nextReview(preferParent ? Array.from(published.values()).filter(r => r.kind === 'plan') : published.values(), skipped);
  const review = manual ?? (held && (!preferParent || held.kind === 'plan') ? held : automatic);
  useLayoutEffect(() => { setPinned(review?.key ?? null); }, [review?.key]);
  const later: ReviewRoute[] = [];
  // Offer untouched siblings before postponed ones, even when the parent has kept its own draft.
  if (preferParent) for (const route of published.values()) {
    if (route.kind !== 'plan' && !skipped.has(route.key)) later.push(route);
  }
  for (const [key, state] of skipped) {
    const route = published.get(key);
    if (state === 'later' && route) later.push(route);
  }
  useEffect(() => {
    setSkipped(current => {
      if ([...current.keys()].every(key => published.has(key))) return current;
      return new Map([...current].filter(([key]) => published.has(key)));
    });
    setReopened(current => current && !published.has(current) ? null : current);
  }, [published]);
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
  const resolved = useCallback(() => { if (key && drafts?.read(key)) drafts.write(key, ''); finish('resolved'); void refresh(); }, [key, drafts, finish, refresh]);
  let surface = null;
  if (review) {
    const { key, ...target } = review;
    surface = <AgentReviewRoute key={key} {...target} language={language} onDismiss={dismiss} onResolved={resolved}
      draft={drafts?.read(key)} onDraftChange={drafts ? value => drafts.write(key, value) : undefined} onInlineChange={onInlineChange} />;
  }
  if (!later.length || (review && !manual)) return surface;
  // Keep a deferred item's opener reachable. Opening and postponing are presentation only.
  const next = later[0]!;
  return <><Button className="agent-plan-review__reopen" variant="secondary" size="compact"
    aria-haspopup={next.kind === 'plan' ? 'dialog' : undefined} aria-expanded={Boolean(manual)}
    onClick={() => manual ? dismiss() : setReopened(next.key)}>{t(language, 'agent.decision.pending')} ({later.length})</Button>{surface}</>;
}

type ReviewProps = ChildReviewTarget & { language: UiLanguage; onDismiss(): void; onResolved(): void;
  draft?: string; onDraftChange?(value: string): void; onInlineChange?(present: boolean): void };
function AgentReviewRoute(props: ReviewProps) {
  const child = useAgentChildConversation(props.decision.agentSessionId, true, props);
  return <AgentReviewSurface {...props} child={child} />;
}

export function AgentReviewSurface(props: ReviewProps & { child: ReturnType<typeof useAgentChildConversation> }) {
  const { child, decision, kind, language, onDismiss, onResolved } = props;
  const projection = child.projection;
  const [linkError, setLinkError] = useState<string | null>(null);
  const bodyLinks = useConversationBodyLinks(projection, language, setLinkError);
  const plan = kind === 'plan' && projection && matchesAgentPlanReview(decision, projection) ? projection.pendingPlan : null;
  const approval = kind === 'approval' && decision.approval && projection?.sessionId === decision.agentSessionId
    ? selectPendingApproval(projection, { runId: decision.runId, ...decision.approval }, false) : null;
  const interaction = props.kind === 'interaction'
    ? pendingChildInteraction(projection, { runId: decision.runId, interactionId: props.interactionId }, decision) : null;
  const item: ChildReviewItem | null = plan ? { kind: 'plan', plan } : approval ? { kind: 'approval', approval }
    : interaction ? { kind: 'interaction', interaction } : null;
  const stale = !!projection && !item && !child.readError;
  useEffect(() => { if (stale) onResolved(); }, [stale, onResolved]);
  // Session only routes final human handoffs. A sibling may still be running; this child read
  // must match the exact item and, for a delegated review, contain its ask before showing it.
  const visible = !stale && (kind === 'plan' || Boolean(item || child.readError)) && !awaitsApprovalReviewer(approval);
  const inline = visible && kind !== 'plan';
  const { onInlineChange } = props;
  useLayoutEffect(() => {
    if (!inline) return;
    onInlineChange?.(true);
    return () => onInlineChange?.(false);
  }, [inline, onInlineChange]);
  if (!visible) return null;
  const title = t(language, kind === 'plan' ? 'agent.plan.review' : kind === 'approval' ? 'agent.approval.toolPermission'
    : interaction?.kind === 'confirmation' ? 'agent.interaction.confirmation' : 'agent.interaction.question');
  const postpone = <Button variant="ghost" size="compact" disabled={child.submitting} onClick={onDismiss}>{t(language, 'agent.team.reviewLater')}</Button>;
  const contents = <>
    {bodyLinks.selection}
    {linkError && <p role="alert" className="agent-tasks__error">{linkError}</p>}
    {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
      <Button size="compact" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</Button></div>}
    {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
    {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
    {projection && item && <ChildDecisions child={child} projection={projection} language={language} only={item}
      inComposer={inline} draft={props.draft} onDraftChange={props.onDraftChange} onDefer={onDismiss} />}
  </>;
  return <ConversationBodyLinkScope.Provider value={bodyLinks.open}><ConversationSessionScope.Provider value={decision.agentSessionId}>
    {inline ? <section data-agent-review="inline" className="agent-review-inline" aria-label={title} onKeyDown={event => {
      if (event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || child.submitting) return;
      event.preventDefault(); event.stopPropagation(); onDismiss();
    }}>
      <header className="agent-review-inline__source"><span>{t(language, 'agent.team.title')} · <strong>{decision.displayName}</strong></span>{postpone}</header>
      {contents}
    </section> : <ModalDialog className="agent-plan-review" aria-label={title} busy={child.submitting} onClose={onDismiss}>
      <section className="local-agent agent-plan-review__card">
        <header className="agent-plan-review__heading"><div><h2>{title}</h2><p>{decision.displayName}</p></div>{postpone}</header>
        <div className="agent-plan-review__body">{contents}</div>
      </section>
    </ModalDialog>}
  </ConversationSessionScope.Provider></ConversationBodyLinkScope.Provider>;
}
