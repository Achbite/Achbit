import { decodeShellCommandRules, isShellAuthorizationScope, sessionAuthorizationScope, type ShellAuthorizationScope } from '@achbit/protocol';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import type { AgentComposer } from './useAgentComposer';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { planOperationDetail } from './planReview';
import { ApprovalOperationDetails } from './ApprovalOperationDetails';
import { ApprovalReviewReason } from './ApprovalReviewReason';
import { InteractionOptions } from './InteractionOptions';
import { isAutomaticApproval, isAutomaticPlanReview } from './composerDecisions';
import type { LocalAgentState } from '../../state/localAgentStore';

type DecisionComposer = Pick<AgentComposer, 'pendingPlan' | 'pendingScopeAddition' | 'pendingInteraction'
  | 'pendingApproval' | 'submitting' | 'submitPlanDecision' | 'respondInteraction' | 'respondApproval' | 'projection'>;

export function ComposerQuestionPrompt({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const { pendingPlan, pendingScopeAddition, pendingInteraction, interactionNavigation, submitting, submitPlanDecision, respondInteraction, projection } = composer;
  const confirmation = pendingInteraction?.kind === 'confirmation';
  const sendDecision = async (text: string) => {
    try { await respondInteraction(text, pendingInteraction?.interactionId); } catch { /* The shared store exposes the error. */ }
  };
  return <>
      {(pendingPlan || pendingInteraction) && (
        <section id={pendingPlan ? undefined : 'conversation-interaction'} tabIndex={-1}
          className={`local-agent__interaction-panel${pendingPlan ? ' local-agent__interaction-panel--plan' : ''}`}>
            <header className="local-agent__interaction-panel-heading">
              <span className="local-agent__interaction-caption">
                <AchbitShellIcon name={pendingPlan ? 'artifact' : 'question'} size={17} />
                {pendingPlan
                  ? t(language, pendingScopeAddition ? 'agent.plan.reviewScope' : 'agent.plan.review')
                  : t(language, confirmation ? 'agent.interaction.confirmation' : 'agent.interaction.question')}
              </span>
              <div className="local-agent__interaction-controls">
              {!pendingPlan && interactionNavigation && <div className="local-agent__interaction-navigation" role="group"
                aria-label={t(language, 'agent.interaction.navigation')}>
                <button type="button" aria-label={t(language, 'agent.interaction.previous')}
                  title={t(language, 'agent.interaction.previous')} disabled={submitting || interactionNavigation.index === 0}
                  onClick={interactionNavigation.previous}><AchbitShellIcon name="chevronLeft" size={15} /></button>
                <span aria-live="polite">{interactionNavigation.index + 1}/{interactionNavigation.count}</span>
                <button type="button" aria-label={t(language, 'agent.interaction.next')}
                  title={t(language, 'agent.interaction.next')} disabled={submitting || interactionNavigation.index === interactionNavigation.count - 1}
                  onClick={interactionNavigation.next}><AchbitShellIcon name="chevronRight" size={15} /></button>
              </div>}
              {(pendingPlan || pendingInteraction?.allowFreeform) && <button
                type="button"
                className="local-agent__interaction-close"
                aria-label={t(language, pendingPlan ? 'agent.plan.closeReview' : confirmation ? 'agent.interaction.closeConfirmation' : 'agent.interaction.closeQuestion')}
                title={t(language, pendingPlan ? 'agent.plan.ignoreAndStop' : 'agent.interaction.skip')}
                disabled={submitting}
                onClick={() => pendingPlan
                  ? void submitPlanDecision({ kind: 'cancel' })
                  : void sendDecision(t(language, 'agent.interaction.skip'))}
              ><AchbitShellIcon name="close" size={15} /></button>}
              </div>
            </header>
          <div
            key={pendingInteraction?.interactionId}
            className="local-agent__interaction-document-scroll"
            tabIndex={0}
            role="region"
            aria-label={t(language, 'agent.interaction.details')}
          >
            <div className="local-agent__interaction-prompt">
              {pendingPlan
                ? pendingScopeAddition ? <>
                  <MarkdownContent decisionProse>{pendingScopeAddition.reason}</MarkdownContent>
                  <ul>{pendingScopeAddition.operations.map((operation, index) => <li key={index}>
                    <code>{(projection?.workspaceBindings.length ?? 0) > 1 ? `${projection?.workspaceBindings.find(binding => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}{planOperationDetail(operation, language)}</code>
                  </li>)}</ul>
                </> : <MarkdownInline>{pendingPlan.title}</MarkdownInline>
                : <MarkdownContent decisionProse>{pendingInteraction?.prompt ?? ''}</MarkdownContent>}
            </div>
          </div>
        </section>
      )}
  </>;
}

export function ComposerDecisionPanels({ language, composer, onSetPermissions }: {
  language: UiLanguage; composer: DecisionComposer; onSetPermissions?: LocalAgentState['setPermissions'];
}) {
  const {
    pendingPlan,
    pendingScopeAddition,
    pendingInteraction,
    pendingApproval,
    submitting,
    submitPlanDecision,
    respondInteraction,
    respondApproval,
    projection,
  } = composer;
  const proposedScope = pendingApproval?.preview.authorizationScope;
  const offeredScopes = pendingApproval?.preview.authorizationScopes ?? [];
  const approvalScope = isShellAuthorizationScope(proposedScope) && offeredScopes.includes(proposedScope) ? proposedScope : undefined;
  const sessionScope = approvalScope && sessionAuthorizationScope(approvalScope);
  const hostApproval = proposedScope === 'runHostShell' || pendingApproval?.preview.operation?.executionScope === 'host';
  const primaryScope = hostApproval ? undefined : approvalScope;
  const approvalRef = useRef<HTMLElement>(null);
  const sessionBrowser = pendingApproval?.preview.authorizationScope === 'sessionBrowser';
  const runCommand = pendingApproval?.preview.authorizationScopes?.includes('runCommand');
  const setMainPermissions = useLocalAgentStore(state => state.setPermissions);
  const setPermissions = onSetPermissions ?? setMainPermissions;
  const savedRules = useSettingsStore(state => state.effectiveSettings['agent.permissions.commandRules']);
  const patchSetting = useSettingsStore(state => state.patchUserSetting);
  const [ruleDecision, setRuleDecision] = useState<'allow' | 'ask' | 'deny'>('allow');
  const [ruleSaved, setRuleSaved] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const reviewing = isAutomaticApproval(pendingApproval, projection?.run);
  const reviewingPlan = isAutomaticPlanReview(pendingPlan, projection?.effectivePermissions);
  useLayoutEffect(() => { setRuleSaved(false); setRuleError(null); }, [pendingApproval?.approvalId]);
  const saveRule = async () => {
    if (!pendingApproval?.preview.authorizationContext) return;
    try {
      const rules = decodeShellCommandRules(savedRules);
      const context = pendingApproval.preview.authorizationContext;
      const next = JSON.stringify([...rules.filter(rule => JSON.stringify(rule.context) !== JSON.stringify(context)), { decision: ruleDecision, context }]);
      const saved = await patchSetting('agent.permissions.commandRules', next);
      if (!saved) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
      await setPermissions({ 'agent.permissions.commandRules': next });
      setRuleSaved(true);
    } catch (error) { setRuleError(error instanceof Error ? error.message : String(error)); }
  };
  useLayoutEffect(() => {
    if (pendingApproval && !reviewing && document.activeElement === document.body) approvalRef.current?.focus({ preventScroll: true });
  }, [pendingApproval?.approvalId, reviewing]);
  const answerApproval = async (decision: 'allow' | 'deny', scope?: ShellAuthorizationScope) => {
    if (!pendingApproval || submitting || reviewing) return;
    try { await respondApproval(decision, scope); } catch { /* The store retains the original error. */ }
  };
  const sendDecision = async (text: string) => {
    if (!pendingInteraction || !text.trim() || submitting) return;
    try {
      await respondInteraction(text, pendingInteraction.interactionId);
    } catch {
      // The store reports the original command error; the shared draft is retained.
    }
  };
  return (
    <>
      {pendingPlan ? reviewingPlan ? <section className="local-agent__auto-review" aria-label={t(language, 'agent.plan.reviewing')}>
          <header><span className="local-agent__auto-review-spinner" aria-hidden="true" /><strong role="status">{t(language, 'agent.plan.reviewing')}</strong>
            <button type="button" disabled={submitting} onClick={() => void setPermissions({ 'agent.permissions.workspaceMutation': 'plan' }).catch(() => {})}>{t(language, 'agent.permission.takeOver')}</button>
          </header>
        </section> : (
          <>
            {pendingPlan.review?.status === 'completed' && pendingPlan.review.decision && pendingPlan.review.reason
              && <ApprovalReviewReason language={language} review={{ decision: pendingPlan.review.decision, reason: pendingPlan.review.reason }} />}
            {Boolean(pendingPlan.workspaceRequests?.length) && <section className="local-agent__decision" aria-label={language === 'zh-CN' ? '工作区权限' : 'Workspace access'}>
              <header className="local-agent__decision-heading"><AchbitShellIcon name="shield" /><strong>{t(language, 'agent.plan.workspaceRequest')}</strong></header>
              <ul>{pendingPlan.workspaceRequests!.map(request => <li key={request.workspaceId}><code>{request.rootPath}</code></li>)}</ul>
            </section>}
            <ol className="local-agent__interaction-options">
              <li>
                <button type="button" disabled={submitting}
                  title={pendingScopeAddition ? t(language, 'agent.plan.continuePhases') : undefined}
                  onClick={() => void submitPlanDecision({ kind: 'confirm' })}>
                  <span className="local-agent__interaction-option-marker" aria-hidden="true">1</span>
                  <span className="local-agent__interaction-option-copy"><b>{pendingPlan.workspaceRequests?.length ? t(language, 'agent.plan.confirmWorkspace') : t(language, pendingScopeAddition ? 'agent.plan.confirmScope' : 'agent.plan.confirm')}</b></span>
                </button>
              </li>
              {Boolean(pendingPlan.workspaceRequests?.length) && <li>
                <button type="button" disabled={submitting} onClick={() => void submitPlanDecision({ kind: 'cancel' })}>
                  <span className="local-agent__interaction-option-marker" aria-hidden="true">2</span>
                  <span className="local-agent__interaction-option-copy"><b>{t(language, 'agent.plan.cancelWorkspace')}</b></span>
                </button>
              </li>}
            </ol>
          </>
      ) : pendingInteraction && <InteractionOptions options={pendingInteraction.options} disabled={submitting}
        onAnswer={response => { void sendDecision(response); }} />}
      {reviewing && pendingApproval && <section className="local-agent__auto-review" aria-label={t(language, 'agent.permission.reviewing')}>
        <header>
          <span className="local-agent__auto-review-spinner" aria-hidden="true" />
          <strong role="status">{t(language, 'agent.permission.reviewing')}</strong>
          <button type="button" disabled={submitting} onClick={() => void setPermissions({ 'agent.permissions.shell': 'ask' }).catch(() => {})}>
            {t(language, 'agent.permission.takeOver')}
          </button>
        </header>
        <pre className="local-agent__auto-review-command"><code>{pendingApproval.preview.summary}</code></pre>
        <ApprovalOperationDetails preview={pendingApproval.preview} language={language} />
      </section>}
      {pendingApproval && !reviewing && (
        <section
          ref={approvalRef}
          tabIndex={-1}
          className="local-agent__decision"
          aria-labelledby={`approval-${pendingApproval.approvalId}`}
          onKeyDown={(event) => {
            if (event.repeat || event.nativeEvent.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === 'Escape' || (event.key === 'Enter' && event.target === approvalRef.current)) {
              event.preventDefault();
              event.stopPropagation();
              void answerApproval(event.key === 'Escape' ? 'deny' : 'allow', event.key === 'Enter' ? primaryScope : undefined);
            }
          }}
        >
          <header className="local-agent__decision-heading">
            <span className="local-agent__decision-mark" aria-hidden="true">
              <AchbitShellIcon name={sessionBrowser ? 'browser' : 'shield'} />
            </span>
            <span>{t(language, sessionBrowser ? 'agent.approval.browser' : 'agent.approval.toolPermission')}</span>
          </header>
          <strong className="local-agent__decision-title" id={`approval-${pendingApproval.approvalId}`}>
                {sessionBrowser
                  ? t(language, 'agent.approval.browserQuestion')
                  : t(language, 'agent.approval.question')}
          </strong>
          {!sessionBrowser && <pre className="local-agent__decision-command">
            <code>{pendingApproval.preview.summary}</code>
          </pre>}
          {pendingApproval.preview.review && <ApprovalReviewReason review={pendingApproval.preview.review} language={language} />}
          <ApprovalOperationDetails preview={pendingApproval.preview} language={language} />
          <div className="local-agent__decision-controls">
          {(sessionBrowser || runCommand) ? (
            <details className="local-agent__decision-scope">
              <summary>
                <span>{t(language, 'agent.approval.scope')}</span>
                <AchbitShellIcon name="chevronDown" />
              </summary>
              {sessionBrowser && <pre className="local-agent__decision-command"><code>{pendingApproval.preview.summary}</code></pre>}
              {runCommand && <p>{t(language, 'agent.permission.grantHelp')}</p>}
              {runCommand && <div className="local-agent__permission-save-rule">
                <select aria-label={t(language, 'settings.commandRules.title')} value={ruleDecision} onChange={event => setRuleDecision(event.target.value as 'allow' | 'ask' | 'deny')}>
                  {(['allow', 'ask', 'deny'] as const).map(mode => <option key={mode} value={mode}>{t(language, `agent.permission.${mode}`)}</option>)}
                </select>
                <button type="button" disabled={submitting || reviewing || ruleSaved} onClick={() => void saveRule()}>{t(language, ruleSaved ? 'agent.permission.ruleSaved' : 'agent.permission.saveRule')}</button>
                {ruleError && <p role="alert">{ruleError}</p>}
              </div>}

            </details>
          ) : <span />}
          <div className="local-agent__decision-actions">
            {hostApproval && offeredScopes.includes('runHostShell') && <button type="button"
              className="local-agent__decision-session" disabled={submitting || reviewing}
              title={t(language, 'agent.permission.scope.runHostShell')}
              onClick={() => void answerApproval('allow', 'runHostShell')}
            >{t(language, 'agent.permission.scope.runHostShell')}</button>}
            {sessionScope && offeredScopes.includes(sessionScope) && <button
              type="button"
              className="local-agent__decision-session"
              title={t(language, `agent.permission.scope.${sessionScope}`)}
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('allow', sessionScope)}
            >{t(language, 'agent.approval.allowSession')}</button>}
            <button
              type="button"
              aria-label={t(language, 'agent.approval.deny')}
              aria-keyshortcuts="Escape"
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('deny')}
            ><span>{t(language, 'agent.approval.deny')}</span><kbd aria-hidden="true">Esc</kbd></button>
            <button
              type="button"
              className="local-agent__decision-allow"
              aria-label={t(language, sessionBrowser ? 'agent.approval.allowSession' : hostApproval ? 'agent.approval.allowOnce' : primaryScope ? 'agent.approval.allowRun' : 'agent.approval.allow')}
              title={primaryScope ? t(language, `agent.permission.scope.${primaryScope}`) : undefined}
              aria-keyshortcuts="Enter"
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('allow', primaryScope)}
            ><span>{t(language, sessionBrowser ? 'agent.approval.allowSession' : hostApproval ? 'agent.approval.allowOnce' : primaryScope ? 'agent.approval.allowRun' : 'agent.approval.allow')}</span><kbd aria-hidden="true">↵</kbd></button>
          </div>
          </div>
        </section>
      )}
    </>
  );
}
