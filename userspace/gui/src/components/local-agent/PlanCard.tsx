import { UiRegion } from '../../ui-plugins/UiRegion';
import React, { useEffect, useRef } from 'react';
import type { PlanOperation, PlanProjection, WorkspaceBindingDisplay } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { PlanDocument } from './PlanDocument';
import { useConversationRowState } from './ConversationVirtualRow';
import { planOperationDetail, planScopeAddition } from './planReview';
import { ApprovalReviewReason } from './ApprovalReviewReason';

interface PlanCardProps {
  plan: PlanProjection;
  active: boolean;
  previousPlan?: PlanProjection;
  workspaceBindings?: readonly WorkspaceBindingDisplay[];
  language: UiLanguage;
  onToggle?: (card: HTMLElement, expanded: boolean) => void;
}

const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  active,
  previousPlan,
  workspaceBindings = [],
  language,
  onToggle,
}) => {
  const cardRef = useRef<HTMLElement>(null);
  const previousStatus = useRef(plan.status);
  const [expanded, setExpanded] = useConversationRowState(`plan:${plan.revision}:${plan.status}:expanded`, false);
  const toggle = (next: boolean) => {
    if (cardRef.current) onToggle?.(cardRef.current, next);
    setExpanded(next);
  };

  useEffect(() => {
    if (previousStatus.current !== plan.status) {
      if (plan.status === 'confirmed') setExpanded(false);
      previousStatus.current = plan.status;
    }
  }, [plan.status]);

  const status = t(language, plan.review?.decision === 'deny' ? 'agent.plan.reviewDenied'
    : plan.status === 'confirmed' && plan.confirmationSource === 'parent' ? 'agent.plan.confirmedByParent'
    : plan.status === 'confirmed' && plan.confirmationSource === 'agent' && plan.review?.decision === 'allow' ? 'agent.plan.confirmedByAgent' : `agent.plan.status.${plan.status}`);
  const addition = planScopeAddition(previousPlan, plan);
  const stepCount = t(language, 'agent.plan.stepCount', { count: plan.steps.length });

  if (addition) return <UiRegion slot="activity.row" actions={{ setExpanded: toggle }}><article ref={cardRef} className="local-agent__tool-entry">
    <button type="button" className="local-agent__tool-entry-heading" aria-expanded={expanded}
      onClick={() => toggle(!expanded)}>
      <AchbitShellIcon name="compose" />
      <strong>{language === 'zh-CN' ? '计划范围调整' : 'Plan scope adjustment'}</strong>
      <span>{status}</span>
      <span className="local-agent__tool-entry-chevron" aria-hidden="true"><AchbitShellIcon name="chevronRight" /></span>
    </button>
    {expanded && <PlanCardContent plan={plan} previousPlan={previousPlan} workspaceBindings={workspaceBindings} language={language} />}
  </article></UiRegion>;

  return (
    <article ref={cardRef} className={`local-agent__plan-card local-agent__plan-card--${plan.status}`}>
      {expanded ? (
        <div className="local-agent__plan-document">
          <button
            type="button"
            className="local-agent__plan-document-meta"
            aria-expanded="true"
            aria-label={t(language, 'agent.plan.collapse')}
            onClick={() => toggle(false)}
          >
            <AchbitShellIcon name="activity" />
            <span>
              {t(language, 'agent.plan.documentLabel')}
              {' · '}
              {t(language, 'agent.plan.revision', { revision: plan.revision })}
              {active ? ` · ${t(language, 'agent.plan.active')}` : ''}
            </span>
            <span className="local-agent__plan-card-status">{status}</span>
            <AchbitShellIcon name="chevronDown" />
          </button>
          <PlanCardContent plan={plan} previousPlan={previousPlan} workspaceBindings={workspaceBindings} language={language} />
        </div>
      ) : (
        <button
          type="button"
          className="local-agent__plan-card-summary"
          aria-expanded="false"
          aria-label={t(language, 'agent.plan.expand')}
          onClick={() => toggle(true)}
        >
          <AchbitShellIcon name="activity" />
          <strong><MarkdownInline>{plan.title}</MarkdownInline></strong>
          <span className="local-agent__plan-card-status">{status} · {stepCount}</span>
          <span className="local-agent__plan-card-chevron" aria-hidden="true">
            <AchbitShellIcon name="chevronRight" />
          </span>
        </button>
      )}
    </article>
  );
};

export function PlanCardContent({ plan, previousPlan, workspaceBindings = [], language }: Omit<PlanCardProps, 'active' | 'onToggle'>) {
  const addition = planScopeAddition(previousPlan, plan);
  const document = <PlanDocument title={plan.title} summary={plan.summary} steps={plan.steps} language={language}>
      {plan.review?.status === 'completed' && plan.review.decision && plan.review.reason
        && <ApprovalReviewReason language={language} review={{ decision: plan.review.decision, reason: plan.review.reason }} />}
      {plan.mutationManifest.length > 0 && (
        <details className="local-agent__plan-manifest">
          <summary>{t(language, 'agent.plan.mutationManifest', { count: plan.mutationManifest.length })}</summary>
          <ul>{plan.mutationManifest.map((operation, index) => (
            <li key={`${operation.workspaceId}:${operation.operation}:${planOperationDetail(operation)}:${index}`}>
              <code>
                {workspaceBindings.length > 1 ? `${workspaceBindings.find((binding) => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}
                {planOperationDetail(operation, language)}
              </code>
            </li>
          ))}</ul>
        </details>
      )}
    </PlanDocument>;
  if (addition) return <section className="conversation-plan-document-body conversation-plan-scope-addition">
    <div className="conversation-markdown">
      <p><strong>{language === 'zh-CN' ? '补充执行范围' : 'Additional execution scope'}</strong></p>
      <MarkdownContent>{addition.reason}</MarkdownContent>
      <ul>{addition.operations.map((operation, index) => <li key={index}>
        <code>{workspaceBindings.length > 1 ? `${workspaceBindings.find((binding) => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}{planOperationDetail(operation, language)}</code>
      </li>)}</ul>
      <p>{language === 'zh-CN' ? '阶段与验收要求保持不变，确认后新增范围生效。' : 'Phases and verification are unchanged. Confirm to authorize the added scope.'}</p>
    </div>
    <details className="local-agent__plan-manifest">
      <summary>{language === 'zh-CN' ? '查看完整方案与全部范围' : 'View the complete Plan and scope'}</summary>
      {document}
    </details>
  </section>;
  return <>
    {previousPlan && <PlanRevisionDetails previous={previousPlan} current={plan} language={language} workspaceBindings={workspaceBindings} />}
    {document}
  </>;
}


function PlanRevisionDetails({ previous, current, language, workspaceBindings }: {
  previous: PlanProjection; current: PlanProjection; language: UiLanguage; workspaceBindings: readonly WorkspaceBindingDisplay[];
}) {
  const chinese = language === 'zh-CN';
  const operationText = (operation: PlanOperation) => `${workspaceBindings.length > 1
    ? `${workspaceBindings.find((binding) => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}${planOperationDetail(operation, language)}`;
  const added = current.mutationManifest.filter((item) => !previous.mutationManifest.some((old) => JSON.stringify(old) === JSON.stringify(item)));
  const removed = previous.mutationManifest.filter((item) => !current.mutationManifest.some((next) => JSON.stringify(next) === JSON.stringify(item)));
  return <section className="conversation-plan-revision-note conversation-markdown">
    <p>{planRevisionSummary(previous, current, language)}</p>
    {(added.length > 0 || removed.length > 0) && <ul>
      {added.map((operation, index) => <li key={`add:${index}`}>{chinese ? '新增范围：' : 'Added scope: '}<code>{operationText(operation)}</code></li>)}
      {removed.map((operation, index) => <li key={`remove:${index}`}>{chinese ? '移除范围：' : 'Removed scope: '}<del><code>{operationText(operation)}</code></del></li>)}
    </ul>}
    {previous.steps.filter((step) => !current.steps.some((next) => next.stepId === step.stepId)).map((step) => <div key={`removed:${step.stepId}`}>
      <p>{chinese ? '移除阶段：' : 'Removed phase: '}<del><MarkdownInline>{step.title}</MarkdownInline></del></p>
      {(step.verification ?? []).map((item, index) => <div key={index}>{chinese ? '移除验收：' : 'Removed verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
    </div>)}
    {current.steps.map((step) => {
      const old = previous.steps.find((item) => item.stepId === step.stepId);
      const removedChecks = (old?.verification ?? []).filter((item) => !step.verification?.includes(item));
      const addedChecks = (step.verification ?? []).filter((item) => !old?.verification?.includes(item));
      const detailsChanged = old && (old.title !== step.title || old.details !== step.details);
      if (old && !detailsChanged && !removedChecks.length && !addedChecks.length) return null;
      return <div key={step.stepId}>
        <p><strong>{chinese ? old ? '调整阶段：' : '新增阶段：' : old ? 'Changed phase: ' : 'Added phase: '}<MarkdownInline>{step.title}</MarkdownInline></strong></p>
        {removedChecks.map((item, index) => <div key={`remove:${index}`}>{chinese ? '移除验收：' : 'Removed verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
        {addedChecks.map((item, index) => <div key={`add:${index}`}>{chinese ? '新增验收：' : 'Added verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
        {detailsChanged && <details><summary>{chinese ? '阶段正文变化' : 'Phase text changes'}</summary>
          <p>{chinese ? '修订前' : 'Before'}</p><MarkdownContent>{`${old.title}\n\n${old.details}`}</MarkdownContent>
          <p>{chinese ? '修订后' : 'After'}</p><MarkdownContent>{`${step.title}\n\n${step.details}`}</MarkdownContent>
        </details>}
      </div>;
    })}
  </section>;
}

function planRevisionSummary(previous: PlanProjection, current: PlanProjection, language: UiLanguage): string {
  const added = current.steps.filter((step) => !previous.steps.some((old) => old.stepId === step.stepId)).length;
  const removed = previous.steps.filter((step) => !current.steps.some((next) => next.stepId === step.stepId)).length;
  const changed = current.steps.filter((step) => previous.steps.some((old) => old.stepId === step.stepId
    && (old.title !== step.title || old.details !== step.details || JSON.stringify(old.verification) !== JSON.stringify(step.verification)))).length;
  const scopeChanged = JSON.stringify(previous.mutationManifest) !== JSON.stringify(current.mutationManifest);
  return language === 'zh-CN'
    ? `本次修订：新增 ${added} 步 · 调整 ${changed} 步 · 移除 ${removed} 步${scopeChanged ? ' · 执行范围有变化，请核对后确认' : ''}`
    : `Revision: ${added} added · ${changed} changed · ${removed} removed${scopeChanged ? ' · Execution scope changed; review before confirming' : ''}`;
}

export default PlanCard;
