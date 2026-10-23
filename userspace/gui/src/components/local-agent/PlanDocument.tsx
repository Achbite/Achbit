import React from 'react';
import type { ExecutionPlanStep } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';

interface PlanDocumentProps {
  title: string;
  summary: string;
  steps: Array<Pick<ExecutionPlanStep, 'title'> & Partial<ExecutionPlanStep>>;
  language: UiLanguage;
  streaming?: boolean;
  children?: React.ReactNode;
}

/** One reading layout for real parameter previews and validated, confirmed Plan revisions. */
export function PlanDocument({ title, summary, steps, language, streaming = false, children }: PlanDocumentProps) {
  return <div className="conversation-plan-document-body">
    <div className="conversation-markdown conversation-plan-document-content">
      {title && <h2 className="conversation-plan-title"><MarkdownInline>{title}</MarkdownInline></h2>}
      {summary && <MarkdownContent decisionProse streaming={streaming}>{summary}</MarkdownContent>}
      {steps.map((step, index) => <section className="conversation-plan-step" key={step.stepId ?? index}>
        <h3><span className="conversation-plan-step-number">{index + 1}.</span> <MarkdownInline>{step.title}</MarkdownInline></h3>
        {step.details && <MarkdownContent decisionProse streaming={streaming}>{step.details}</MarkdownContent>}
        {step.verification && step.verification.length > 0 && <div className="conversation-plan-verification">
          <h4>{t(language, 'agent.plan.verification')}</h4>
          <ul>{step.verification.map((item, itemIndex) => <li key={itemIndex}>
            <MarkdownContent decisionProse streaming={streaming}>{item}</MarkdownContent>
          </li>)}</ul>
        </div>}
      </section>)}
    </div>
    {children}
  </div>;
}
