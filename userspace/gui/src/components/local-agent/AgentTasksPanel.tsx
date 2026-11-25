import { ConversationBodyLinkScope, useConversationBodyLinks } from './useConversationBodyLinks';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CONVERSATION_COMMAND_VERSION, type AgentChildProjection, type AgentTaskProjection,
  type PlanResponse, type SessionProjection, type ShellAuthorizationScope, type UserSettings } from '@achbit/protocol';
import { localizedError, t, type UiLanguage } from '../../i18n';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { ComposerDecisionPanels, ComposerQuestionPrompt } from './ComposerDecisionPanels';
import { submitReplyOnEnter } from './replyKeyboard';
import { Button } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { ConversationSessionScope } from './ConversationSessionScope';
import { InteractionCard } from './InteractionCard';
import { PlanCardContent } from './PlanCard';
import { planScopeAddition } from './planReview';
import { useAgentChildConversation } from './useAgentChildConversation';
import { selectPendingApproval, isAutomaticApproval } from './composerDecisions';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ArtifactLinks } from './ArtifactLinks';
import { requestWorkspacePreview, type AgentReaderTarget } from './readerState';
import { AgentNavigationScope, requestAgentOverview } from './agentNavigation';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { projectionItems, assistantDraftItems, conversationRounds } from './conversationItems';
import { ToolActivityGroup } from './ToolActivityDetails';
import PlanCard from './PlanCard';
import { PlanPreviewCard } from './PlanPreviewCard';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useConversationHost } from './ConversationHost';
import { AgentOverviewList } from './AgentOverview';
import './agentTasksPanel.css';

/** Read the selected child's actual parent projection, including for nested navigation. */
export function AgentConversationPage({ target, language, active }: {
  target: AgentReaderTarget; language: UiLanguage; active: boolean;
}) {
  const main = useLocalAgentStore(state => state.projection?.sessionId === target.parentSessionId ? state.projection : null);
  const parent = useAgentChildConversation(target.parentSessionId, active && !main);
  const projection = main ?? parent.projection;
  if (!projection) return <div className="agent-tasks__child-body">
    {parent.readError ? <div role="alert" className="agent-tasks__error"><p>{parent.readError}</p>
      <button type="button" onClick={() => void parent.refresh()}>{t(language, 'agent.team.refresh')}</button></div>
      : <p role="status">{t(language, 'agent.team.loading')}</p>}
  </div>;
  if (!target.agentSessionId) return <AgentOverviewList projection={projection} language={language} />;
  return <AgentTasksPanel projection={projection} language={language} visible={active}
    selectedSessionId={target.agentSessionId} entryId={target.entryId} onBack={() => requestAgentOverview(target.parentSessionId)} />;
}

export function AgentTasksPanel({ projection, language, visible = true, selectedSessionId, entryId = '', onBack = () => {} }: {
  projection: SessionProjection; language: UiLanguage; visible?: boolean;
  selectedSessionId?: string; entryId?: string; onBack?(): void;
}) {
  if (!selectedSessionId) return null;
  const tasks = (projection.agentTasks ?? []).filter(task => task.agentSessionId === selectedSessionId);
  const instance = projection.agentChildren?.find(child => child.agentSessionId === selectedSessionId);
  const pending = projection.pendingAgentDecisions?.find(decision => decision.agentSessionId === selectedSessionId);
  if (!instance && !tasks.length && !pending) return <p role="alert" className="agent-tasks__error">agent_child_not_found:{selectedSessionId}</p>;
  return <AgentChildView key={selectedSessionId} sessionId={selectedSessionId} tasks={tasks} instance={instance}
    displayName={pending?.displayName} language={language} expanded={visible} entryId={entryId} onBack={onBack} />;
}

function AgentChildView({ sessionId, tasks, instance, displayName, language, expanded, entryId, onBack }: {
  sessionId: string; tasks: AgentTaskProjection[]; instance?: AgentChildProjection; language: UiLanguage;
  displayName?: string; expanded: boolean; entryId: string; onBack(): void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const decision = useRef<HTMLDivElement>(null);
  const child = useAgentChildConversation(sessionId, expanded);
  const projection = child.projection;
  const [linkError, setLinkError] = useState<string | null>(null);
  const bodyLinks = useConversationBodyLinks(projection, language, setLinkError);
  const name = instance?.displayName ?? tasks[0]?.displayName ?? displayName!;
  const pendingKey = agentDecisionKey(projection);
  useLayoutEffect(() => {
    const container = body.current;
    const target = decision.current;
    if (!expanded || !pendingKey || !container || !target) return;
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  }, [expanded, pendingKey, entryId]);
  return <ConversationBodyLinkScope.Provider value={bodyLinks.open}><ConversationSessionScope.Provider value={sessionId}><AgentNavigationScope sessionId={sessionId} tasks={projection?.agentTasks} pendingDecisions={projection?.pendingAgentDecisions}>
    <section hidden={!expanded} className="agent-tasks__page" aria-label={t(language, 'agent.page.title')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onBack(); } }}>
      <AgentPageInformation name={name} sessionId={sessionId} projection={projection} language={language} onBack={onBack}
        status={`${pendingKey ? t(language, 'agent.team.needsInput') : tasks.at(-1) ? t(language, `agent.team.status.${tasks.at(-1)!.status}`) : ''}${instance?.closed ? ` · ${t(language, 'agent.team.closed')}` : ''}`} />
      <div ref={body} className="agent-tasks__child-body">
          {bodyLinks.selection}
          {linkError && <p role="alert" className="agent-tasks__error">{linkError}</p>}
        {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
          <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
        {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
        {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
        {projection && expanded && <>
          <AgentConversationHistory projection={projection} name={name} language={language} expanded />
          <ArtifactLinks location="agent" artifacts={projection.artifacts} onOpen={(workspaceId, path) => requestWorkspacePreview(sessionId, workspaceId, path)} />
          <div ref={decision}><ChildDecisions key={`${projection.pendingPlan?.planId ?? ''}:${projection.pendingPlan?.revision ?? ''}`}
            child={child} projection={projection} language={language} /></div>
          {projection.terminalError && <p role="alert" className="agent-tasks__error" title={projection.terminalError.message}>{localizedError(language, projection.terminalError.message, projection.terminalError.code)}</p>}
        </>}
      </div>
    </section>
  </AgentNavigationScope></ConversationSessionScope.Provider></ConversationBodyLinkScope.Provider>;
}

export function AgentPageInformation({ name, sessionId, projection, language, onBack, status }: {
  name: string; sessionId: string; projection: SessionProjection | null; language: UiLanguage; onBack?(): void; status?: string;
}) {
  const host = useConversationHost();
  const [copied, setCopied] = useState<{ key: string; sessionId: string } | null>(null);
  useAutoDismiss(copied, () => setCopied(null), 1500);
  const [copyError, setCopyError] = useState<string | null>(null);
  const model = projection?.agentContext?.model;
  const effort = projection?.run?.reasoningEffort ?? model?.reasoningEffort;
  const thinking = projection?.run?.thinking ?? model?.thinking;
  const modelDetails = model ? `${t(language, 'agent.page.profile')}: ${model.profileId}\n${t(language, 'agent.page.contextWindow')}: ${model.parameters.contextWindowTokens.toLocaleString(language)}\n${t(language, 'agent.page.maxOutput')}: ${model.parameters.maxOutputTokens.toLocaleString(language)}` : undefined;
  const copy = async (key: string, text: string) => {
    try { await host.copyText(text); setCopied({ key, sessionId }); setCopyError(null); }
    catch (error) { setCopyError(error instanceof Error ? error.message : String(error)); }
  };
  const modelName = model?.model ?? t(language, projection ? 'agent.page.unavailable' : 'agent.team.loading');
  return <>
    <div className="document-preview__toolbar native-browser-address agent-tasks__toolbar" aria-label={t(language, 'agent.page.information')}>
      <button type="button" className="reader-icon-button" onClick={onBack} aria-label={t(language, 'agent.page.back')} title={t(language, 'agent.page.back')}><AchbitShellIcon name="chevronLeft" /></button>
      <AchbitShellIcon name="subagents" />
      <div className="agent-tasks__identity">
        {([['name', name], ['id', sessionId]] as const).map(([key, value]) => <button key={key} type="button" className={`agent-tasks__identity-${key}`}
          onClick={() => void copy(key, value)} aria-label={t(language, copied?.sessionId === sessionId && copied.key === key ? 'agent.message.copied' : `agent.page.copy${key === 'name' ? 'Name' : 'Id'}`)}
          title={`${t(language, `agent.page.${key}`)}: ${value}${status ? ` · ${status}` : ''}`}><span>{value}</span></button>)}
      </div>
      <div className="agent-tasks__model" title={modelDetails} aria-label={t(language, 'agent.page.model')}>
        <span>{modelName}</span>
        {effort && <small title={t(language, 'settings.llm.reasoningEffort')}> · {t(language, `settings.llm.effort.${effort}`)}</small>}
        {thinking && <small title={t(language, 'agent.page.thinking')}> · {t(language, `settings.common.${thinking}`)}</small>}
      </div>
    </div>
    {copyError && <p role="alert" className="agent-tasks__error">{copyError}</p>}
  </>;
}

/** Stable identity keeps ordinary polling from repeatedly moving the reader's scroll position. */
export function agentDecisionKey(projection: SessionProjection | null): string | null {
  if (!projection) return null;
  const plan = projection.pendingPlan;
  const approval = selectPendingApproval(projection);
  const pending = [
    ...(plan ? [`plan:${plan.planId}:${plan.revision}`] : []),
    ...projection.interactions.filter(item => item.status === 'pending').map(item => `interaction:${item.interactionId}`),
    ...(approval ? [`approval:${approval.approvalId}`] : []),
  ];
  return pending.length ? pending.join('|') : null;
}

/** Child history consumes the same canonical rows and activity/Plan components as the main view. */
export function AgentConversationHistory({ projection, name, language, expanded }: {
  projection: SessionProjection; name: string; language: UiLanguage; expanded: boolean;
}) {
  if (!expanded) return null;
  const openResource = (workspaceId: string, path: string) => requestWorkspacePreview(projection.sessionId, workspaceId, path);
  const rounds = conversationRounds(projectionItems(projection), assistantDraftItems(projection.assistantDraft), projection.run?.runId);
  return <div className="agent-tasks__conversation">
    {rounds.flatMap(round => round.rows).map(({ key, item, draft }) => {
      if (item?.type === 'toolGroup' || draft?.type === 'providerHostedGroup') {
        const group = item?.type === 'toolGroup' ? item : undefined;
        return <ToolActivityGroup key={key} activities={group?.values ?? []} hostedKeys={group?.hostedKeys} batchConflicts={group?.batchConflicts}
          hostedDraft={draft?.type === 'providerHostedGroup' ? draft : undefined} artifacts={projection.artifacts} language={language} onExpand={() => {}}
          pendingApproval={projection.pendingApproval} reviewingApproval={isAutomaticApproval(projection.pendingApproval, projection.run)} onOpenWorkspaceResource={openResource} />;
      }
      if (!item) return draft?.type === 'text'
        ? <article key={key}><MarkdownContent streaming>{draft.block.displayContent ?? draft.block.content}</MarkdownContent></article>
        : draft?.type === 'planPreview' ? <PlanPreviewCard key={key} preview={draft.value} language={language} /> : null;
      if (item.type === 'plan') return <PlanCard key={key} plan={item.value} active={false} language={language} workspaceBindings={projection.workspaceBindings} />;
      if (item.type === 'interaction') return <InteractionCard key={key} interaction={item.value} language={language} disabled />;
      return <article key={key}>
        <header>{item.type === 'message' && item.value.role === 'user' ? t(language, 'agent.team.input') : name}</header>
        <MarkdownContent>{item.value.displayContent ?? item.value.content}</MarkdownContent>
      </article>;
    })}
    {projection.fileChangeRounds?.map(round => <FileChanges key={round.runId} activities={roundChangeActivities(projection, round.runId)} />)}
  </div>;
}

/** A forwarded control acts on one verified item; the Reader still shows the child's decision history. */
export type ChildReviewItem = { kind: 'plan'; plan: NonNullable<SessionProjection['pendingPlan']> }
  | { kind: 'approval'; approval: NonNullable<SessionProjection['pendingApproval']> }
  | { kind: 'interaction'; interaction: SessionProjection['interactions'][number] };

export function ChildDecisions({ child, projection, language, only, inComposer = false, draft, onDraftChange, onDefer }: {
  child: ReturnType<typeof useAgentChildConversation>; projection: SessionProjection; language: UiLanguage; only?: ChildReviewItem;
  inComposer?: boolean; draft?: string; onDraftChange?(value: string): void; onDefer?(): void;
}) {
  const [revisionText, setRevisionText] = useState('');
  const pendingPlan = only ? (only.kind === 'plan' ? only.plan : null) : projection.pendingPlan;
  const pendingApproval = only ? (only.kind === 'approval' ? selectPendingApproval(projection, only.approval) : null)
    : selectPendingApproval(projection) ?? (isAutomaticApproval(projection.pendingApproval, projection.run) ? projection.pendingApproval : null);
  const pending = projection.interactions.filter(item => item.status === 'pending');
  const routedQuestion = only?.kind === 'interaction' && projection.run?.runId === only.interaction.runId
    && (projection.run.status === 'running' || projection.run.status === 'waiting')
    ? pending.find(item => item.runId === only.interaction.runId && item.interactionId === only.interaction.interactionId) ?? null : null;
  const interactions = only ? (routedQuestion ? [routedQuestion] : []) : pending;
  const previousPlan = pendingPlan ? projection.plans.find(plan => plan.planId === pendingPlan.planId && plan.revision === pendingPlan.revision - 1) : undefined;
  const base = () => ({ schemaVersion: CONVERSATION_COMMAND_VERSION, commandId: `command:${crypto.randomUUID()}`, sessionId: projection.sessionId });
  const respondPlan = (response: PlanResponse) => {
    if (!pendingPlan) return Promise.reject(new Error('plan_response_missing'));
    return child.submit({ ...base(), type: 'plan.respond', runId: pendingPlan.runId,
      planId: pendingPlan.planId, revision: pendingPlan.revision, response });
  };
  const respondInteraction = (response: string, interactionId?: string) => {
    const interaction = interactions.find(item => item.interactionId === interactionId);
    if (!interaction) return Promise.reject(new Error('interaction_response_missing'));
    return child.submit({ ...base(), type: 'interaction.respond', runId: interaction.runId, interactionId: interaction.interactionId, response });
  };
  const respondApproval = (decision: 'allow' | 'deny', authorizationScope?: ShellAuthorizationScope) => {
    if (!pendingApproval) return Promise.reject(new Error('approval_response_missing'));
    return child.submit({ ...base(), type: 'approval.respond', runId: pendingApproval.runId, callId: pendingApproval.callId,
      approvalId: pendingApproval.approvalId, decision, ...(authorizationScope ? { authorizationScope } : {}) });
  };
  const setPermissions = (patches: UserSettings) => child.submit({ ...base(), type: 'session.permissions.set', patches });
  const disabled = child.submitting || Boolean(child.readError);
  const question = inComposer ? routedQuestion : null;
  const composer = {
    pendingPlan, pendingScopeAddition: pendingPlan ? planScopeAddition(previousPlan, pendingPlan) : null,
    pendingInteraction: question, pendingApproval, projection, submitting: disabled, respondInteraction, respondApproval,
    submitPlanDecision: async (response: Extract<PlanResponse, { kind: 'confirm' | 'cancel' }>) => {
      try { await respondPlan(response); } catch { /* Child command errors are shown by the owning view. */ }
    },
  };
  const panels = <ComposerDecisionPanels language={language} composer={composer} onSetPermissions={setPermissions} deferApprovalOnEscape={only?.kind === 'approval'} />;
  if (inComposer) {
    if (pendingApproval && only?.kind === 'approval') return <div className="local-agent__composer local-agent__composer--approval">{panels}</div>;
    if (!question) return null;
    return <>
      <ComposerQuestionPrompt language={language} composer={{ ...composer, conversationKey: projection.sessionId, interactionNavigation: null }} forwarded={{ onDefer }} />
      <ChildQuestionForm key={JSON.stringify([projection.sessionId, question.runId, question.interactionId])} sessionId={projection.sessionId}
        question={question} language={language} disabled={disabled} draft={draft} onDraftChange={onDraftChange} onAnswer={respondInteraction}>
        {panels}
      </ChildQuestionForm>
    </>;
  }
  return <div className="agent-tasks__decisions">
    {pendingPlan && <>
      <h4><MarkdownInline>{pendingPlan.title}</MarkdownInline></h4>
      <PlanCardContent plan={pendingPlan} previousPlan={previousPlan} workspaceBindings={projection.workspaceBindings} language={language} />
    </>}
    {panels}
    {pendingPlan && <form className="agent-tasks__revision" onSubmit={event => {
      event.preventDefault();
      if (!disabled && revisionText.trim()) void respondPlan({ kind: 'requestRevision', text: revisionText.trim() }).catch(() => {});
    }}>
      <textarea aria-label={t(language, 'agent.team.revise')} placeholder={t(language, 'agent.team.revisePlaceholder')}
        value={revisionText} onChange={event => setRevisionText(event.target.value)} disabled={disabled} rows={2} />
      <div><button type="submit" disabled={disabled || !revisionText.trim()}>{t(language, 'agent.team.revise')}</button>
        <button type="button" disabled={disabled} onClick={() => void respondPlan({ kind: 'cancel' }).catch(() => {})}>{t(language, 'agent.plan.ignoreAndStop')}</button></div>
    </form>}
    {interactions.map(interaction => <InteractionCard
      key={interaction.interactionId} interaction={interaction} language={language} disabled={disabled} onRespond={respondInteraction} />)}
  </div>;
}

/** Question-specific form owner: no draft, submit or keyboard event is routed to the parent message input. */
function ChildQuestionForm({ sessionId, question, language, disabled, draft, onDraftChange, onAnswer, children }: {
  sessionId: string; question: SessionProjection['interactions'][number]; language: UiLanguage; disabled: boolean;
  draft?: string; onDraftChange?(text: string): void; onAnswer(text: string, id: string): Promise<unknown>; children: ReactNode;
}) {
  const identity = useUiOwner('composer.forwarded-answer', undefined, { sessionId, runId: question.runId, interactionId: question.interactionId });
  const [localDraft, setLocalDraft] = useState('');
  const value = draft ?? localDraft;
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false), commitFrame = useRef<number | null>(null);
  useLayoutEffect(() => () => { if (commitFrame.current !== null) cancelAnimationFrame(commitFrame.current); }, []);
  useLayoutEffect(() => {
    const el = input.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [value]);
  const answer = (text: string) => {
    if (disabled || !question.allowFreeform || !text.trim() || composing.current || commitFrame.current !== null) return;
    // Only Session reconciliation consumes a routed draft. Keep it through failures and deferral.
    void onAnswer(text, question.interactionId).catch(() => {});
  };
  return <form className="local-agent__composer local-agent__composer--interaction" onSubmit={event => {
    event.preventDefault(); event.stopPropagation(); answer(value);
  }}>
    {children}
    {question.allowFreeform && <>
      <span className="local-agent__decision-input-mark" aria-hidden="true"><AchbitShellIcon name="compose" size={16} /></span>
      <textarea {...identity.action('input', 'type')} ref={input} rows={1} value={value} disabled={disabled}
        aria-label={t(language, 'agent.question.answer')} placeholder={t(language, 'agent.composer.placeholder.interaction')}
        onChange={event => (onDraftChange ?? setLocalDraft)(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => {
          composing.current = false;
          if (commitFrame.current !== null) cancelAnimationFrame(commitFrame.current);
          commitFrame.current = requestAnimationFrame(() => { commitFrame.current = null; });
        }} onKeyDown={event => {
          const ime = composing.current || commitFrame.current !== null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          if (event.key === 'Enter' || (event.key === 'Escape' && ime)) event.stopPropagation();
          if (!ime && !event.defaultPrevented) submitReplyOnEnter(event);
        }} />
      <div className="local-agent__composer-footer"><div className="local-agent__composer-actions">
        <Button {...identity.action('skip', 'click')} size="compact" className="local-agent__interaction-secondary" disabled={disabled}
          onClick={() => answer(t(language, 'agent.interaction.skip'))}>{t(language, 'agent.interaction.skip')}</Button>
        <Button {...identity.action('submit', 'click')} type="submit" variant="primary" size="compact" className="local-agent__send local-agent__send--decision"
          aria-label={t(language, 'agent.question.answer')} title={t(language, 'agent.composer.sendEnter')} disabled={disabled || !value.trim()}>{t(language, 'agent.composer.send')}</Button>
      </div></div>
    </>}
  </form>;
}
