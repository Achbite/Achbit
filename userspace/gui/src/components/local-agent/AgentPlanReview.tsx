import { useCallback, useEffect, useState } from 'react';
import type { PendingAgentDecision, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import ModalDialog from '../shared/ModalDialog';
import { ChildDecisions } from './AgentTasksPanel';
import { ConversationSessionScope } from './ConversationSessionScope';
import { useAgentChildConversation } from './useAgentChildConversation';
import './agentPlanReview.css';

function planKey(decision: PendingAgentDecision): string {
  return JSON.stringify([decision.agentSessionId, decision.runId, decision.plan?.planId, decision.plan?.revision]);
}

/** Dismissal is view state only; the original child Plan remains pending. */
export function nextAgentPlanReview(decisions: readonly PendingAgentDecision[], dismissed: ReadonlySet<string>) {
  const decision = decisions.find(item => item.plan && !dismissed.has(planKey(item)));
  return decision ? { decision, key: planKey(decision) } : null;
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
  return review ? <AgentPlanReviewDialog key={review.key} decision={review.decision} language={language}
    onDismiss={dismiss} onResolved={resolved} /> : null;
}

function AgentPlanReviewDialog({ decision, language, onDismiss, onResolved }: {
  decision: PendingAgentDecision; language: UiLanguage; onDismiss(): void; onResolved(): void;
}) {
  const child = useAgentChildConversation(decision.agentSessionId, planKey(decision), true, true);
  const projection = child.projection;
  const matches = projection && matchesAgentPlanReview(decision, projection);
  useEffect(() => {
    if (projection && !matches && !child.readError) onResolved();
  }, [projection, matches, child.readError, onResolved]);
  if (projection && !matches && !child.readError) return null;
  return <ConversationSessionScope.Provider value={decision.agentSessionId}>
    <ModalDialog className="agent-plan-review" aria-label={t(language, 'agent.plan.review')}
      busy={child.submitting} onClose={onDismiss}>
      <section className="local-agent agent-plan-review__card">
        <header className="agent-plan-review__heading">
          <div><h2>{t(language, 'agent.plan.review')}</h2><p>{decision.displayName}</p></div>
          <button type="button" disabled={child.submitting} onClick={onDismiss}>{t(language, 'agent.team.reviewLater')}</button>
        </header>
        <div className="agent-plan-review__body">
          {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
            <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
          {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
          {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
          {projection && matches && <ChildDecisions child={child} projection={projection} language={language} />}
        </div>
      </section>
    </ModalDialog>
  </ConversationSessionScope.Provider>;
}
