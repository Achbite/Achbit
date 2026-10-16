import { useLayoutEffect, useRef, useState } from 'react';
import { CONVERSATION_COMMAND_VERSION, type AgentChildProjection, type AgentTaskProjection,
  type PlanResponse, type SessionProjection, type ShellAuthorizationScope, type UserSettings } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { ComposerDecisionPanels } from './ComposerDecisionPanels';
import { ConversationSessionScope } from './ConversationSessionScope';
import { InteractionCard } from './InteractionCard';
import { PlanCardContent } from './PlanCard';
import { planScopeAddition } from './planReview';
import { useAgentChildConversation } from './useAgentChildConversation';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ArtifactLinks } from './ArtifactLinks';
import { requestWorkspacePreview, type AgentReaderTarget } from './readerState';
import { AgentNavigationScope, requestAgentOverview } from './agentNavigation';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { projectionItems, assistantDraftItems } from './conversationItems';
import { ToolActivityGroup, ProviderHostedDraftGroup } from './ToolActivityDetails';
import PlanCard from './PlanCard';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useConversationHost } from './ConversationHost';
import { AgentOverviewList } from './AgentOverview';
import './agentTasksPanel.css';

/** Read the selected child's actual parent projection, including for nested navigation. */
export function AgentConversationPage({ target, language, active }: {
  target: AgentReaderTarget; language: UiLanguage; active: boolean;
}) {
  const main = useLocalAgentStore(state => state.projection?.sessionId === target.parentSessionId ? state.projection : null);
  const parent = useAgentChildConversation(target.parentSessionId, '', false, active && !main);
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
  const revision = tasks.map(task => `${task.taskId}:${task.childRunId ?? ''}:${task.status}`).join('|');
  const child = useAgentChildConversation(sessionId, revision, tasks.some(task => task.status === 'running'), expanded);
  const projection = child.projection;
  const name = instance?.displayName ?? tasks[0]?.displayName ?? displayName!;
  const pendingKey = agentDecisionKey(projection);
  useLayoutEffect(() => {
    const container = body.current;
    const target = decision.current;
    if (!expanded || !pendingKey || !container || !target) return;
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  }, [expanded, pendingKey, entryId]);
  return <ConversationSessionScope.Provider value={sessionId}><AgentNavigationScope sessionId={sessionId} tasks={projection?.agentTasks} pendingDecisions={projection?.pendingAgentDecisions}>
    <section hidden={!expanded} className="agent-tasks__page" aria-label={t(language, 'agent.page.title')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onBack(); } }}>
      <AgentPageInformation name={name} sessionId={sessionId} projection={projection} language={language} onBack={onBack}
        status={`${pendingKey ? t(language, 'agent.team.needsInput') : tasks.at(-1) ? t(language, `agent.team.status.${tasks.at(-1)!.status}`) : ''}${instance?.closed ? ` · ${t(language, 'agent.team.closed')}` : ''}`} />
      <div ref={body} className="agent-tasks__child-body">
        {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
          <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
        {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
        {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
        {projection && expanded && <>
          <AgentConversationHistory projection={projection} name={name} language={language} expanded />
          <ArtifactLinks artifacts={projection.artifacts} onOpen={(workspaceId, path) => requestWorkspacePreview(sessionId, workspaceId, path)} />
          <div ref={decision}><ChildDecisions key={`${projection.pendingPlan?.planId ?? ''}:${projection.pendingPlan?.revision ?? ''}`}
            child={child} projection={projection} language={language} /></div>
          {projection.terminalError && <p role="alert" className="agent-tasks__error">{projection.terminalError.message}</p>}
        </>}
      </div>
    </section>
  </AgentNavigationScope></ConversationSessionScope.Provider>;
}

export function AgentPageInformation({ name, sessionId, projection, language, onBack, status }: {
  name: string; sessionId: string; projection: SessionProjection | null; language: UiLanguage; onBack?(): void; status?: string;
}) {
  const host = useConversationHost();
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const model = projection?.agentContext?.model;
  const effort = projection?.run?.reasoningEffort ?? model?.reasoningEffort;
  const thinking = projection?.run?.thinking ?? model?.thinking;
  const modelDetails = model ? `${t(language, 'agent.page.profile')}: ${model.profileId}\n${t(language, 'agent.page.contextWindow')}: ${model.parameters.contextWindowTokens.toLocaleString(language)}\n${t(language, 'agent.page.maxOutput')}: ${model.parameters.maxOutputTokens.toLocaleString(language)}` : undefined;
  const copy = async (key: string, text: string) => {
    try { await host.copyText(text); setCopied(key); setCopyError(null); }
    catch (error) { setCopyError(error instanceof Error ? error.message : String(error)); }
  };
  const modelName = model?.model ?? t(language, projection ? 'agent.page.unavailable' : 'agent.team.loading');
  return <>
    <div className="document-preview__toolbar native-browser-address agent-tasks__toolbar" aria-label={t(language, 'agent.page.information')}>
      <button type="button" className="reader-icon-button" onClick={onBack} aria-label={t(language, 'agent.page.back')} title={t(language, 'agent.page.back')}><DeepCodeShellIcon name="chevronLeft" /></button>
      <DeepCodeShellIcon name="subagents" />
      <div className="agent-tasks__identity">
        {([['name', name], ['id', sessionId]] as const).map(([key, value]) => <button key={key} type="button" className={`agent-tasks__identity-${key}`}
          onClick={() => void copy(key, value)} aria-label={t(language, copied === key ? 'agent.message.copied' : `agent.page.copy${key === 'name' ? 'Name' : 'Id'}`)}
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
  const approval = projection.pendingApproval;
  const pending = [
    ...(plan ? [`plan:${plan.planId}:${plan.revision}`] : []),
    ...projection.interactions.filter(item => item.status === 'pending').map(item => `interaction:${item.interactionId}`),
    ...(approval && !(approval.preview.approvalReviewer === 'agent' && projection.run?.status === 'running')
      ? [`approval:${approval.approvalId}`] : []),
  ];
  return pending.length ? pending.join('|') : null;
}

/** Child history consumes the same canonical rows and activity/Plan components as the main view. */
export function AgentConversationHistory({ projection, name, language, expanded }: {
  projection: SessionProjection; name: string; language: UiLanguage; expanded: boolean;
}) {
  if (!expanded) return null;
  const openResource = (workspaceId: string, path: string) => requestWorkspacePreview(projection.sessionId, workspaceId, path);
  const items = projectionItems(projection);
  return <div className="agent-tasks__conversation">
    {items.map(item => item.type === 'toolGroup'
      ? <ToolActivityGroup key={item.groupId} activities={item.values} artifacts={projection.artifacts} language={language} onExpand={() => {}}
          pendingApproval={projection.pendingApproval} reviewingApproval={projection.run?.status === 'running'} onOpenWorkspaceResource={openResource} />
      : item.type === 'plan' ? <PlanCard key={`plan:${item.sequence}`} plan={item.value} active={false} language={language} workspaceBindings={projection.workspaceBindings} />
      : item.type === 'interaction' ? <InteractionCard key={`interaction:${item.sequence}`} interaction={item.value} language={language} disabled />
      : <article key={`${item.type}:${item.sequence}`}>
          <header>{item.type === 'message' && item.value.role === 'user' ? t(language, 'agent.team.input') : name}</header>
          <MarkdownContent>{item.value.displayContent ?? item.value.content}</MarkdownContent>
        </article>)}
    {assistantDraftItems(projection.assistantDraft).map(item => item.type === 'text'
      ? <article key={item.block.streamId}><MarkdownContent streaming>{item.block.displayContent ?? item.block.content}</MarkdownContent></article>
      : item.type === 'providerHostedGroup' ? <ProviderHostedDraftGroup key={item.groupId} blocks={item.blocks} language={language} onExpand={() => {}} /> : null)}
    {projection.fileChangeRounds?.map(round => <FileChanges key={round.runId} activities={roundChangeActivities(projection, round.runId)} />)}
  </div>;
}

export function ChildDecisions({ child, projection, language }: {
  child: ReturnType<typeof useAgentChildConversation>; projection: SessionProjection; language: UiLanguage;
}) {
  const [revisionText, setRevisionText] = useState('');
  const pendingPlan = projection.pendingPlan;
  const previousPlan = pendingPlan ? projection.plans.find(plan => plan.planId === pendingPlan.planId && plan.revision === pendingPlan.revision - 1) : undefined;
  const base = () => ({ schemaVersion: CONVERSATION_COMMAND_VERSION, commandId: `command:${crypto.randomUUID()}`, sessionId: projection.sessionId });
  const respondPlan = (response: PlanResponse) => {
    if (!pendingPlan) return Promise.reject(new Error('plan_response_missing'));
    return child.submit({ ...base(), type: 'plan.respond', runId: pendingPlan.runId,
      planId: pendingPlan.planId, revision: pendingPlan.revision, response });
  };
  const respondInteraction = (response: string, interactionId?: string) => {
    const interaction = projection.interactions.find(item => item.interactionId === interactionId && item.status === 'pending');
    if (!interaction) return Promise.reject(new Error('interaction_response_missing'));
    return child.submit({ ...base(), type: 'interaction.respond', runId: interaction.runId, interactionId: interaction.interactionId, response });
  };
  const respondApproval = (decision: 'allow' | 'deny', authorizationScope?: ShellAuthorizationScope) => {
    const approval = projection.pendingApproval;
    if (!approval) return Promise.reject(new Error('approval_response_missing'));
    return child.submit({ ...base(), type: 'approval.respond', runId: approval.runId, callId: approval.callId,
      approvalId: approval.approvalId, decision, ...(authorizationScope ? { authorizationScope } : {}) });
  };
  const setPermissions = (patches: UserSettings) => child.submit({ ...base(), type: 'session.permissions.set', patches });
  const disabled = child.submitting || Boolean(child.readError);
  return <div className="agent-tasks__decisions">
    {pendingPlan && <>
      <h4><MarkdownInline>{pendingPlan.title}</MarkdownInline></h4>
      <PlanCardContent plan={pendingPlan} previousPlan={previousPlan} workspaceBindings={projection.workspaceBindings} language={language} />
    </>}
    <ComposerDecisionPanels language={language} onSetPermissions={setPermissions} composer={{
      pendingPlan, pendingScopeAddition: pendingPlan ? planScopeAddition(previousPlan, pendingPlan) : null,
      pendingInteraction: null, pendingApproval: projection.pendingApproval, projection, submitting: disabled,
      respondInteraction, respondApproval, submitPlanDecision: async response => { try { await respondPlan(response); } catch { /* Shown above. */ } },
    }} />
    {pendingPlan && <form className="agent-tasks__revision" onSubmit={event => {
      event.preventDefault();
      if (!disabled && revisionText.trim()) void respondPlan({ kind: 'requestRevision', text: revisionText.trim() }).catch(() => {});
    }}>
      <textarea aria-label={t(language, 'agent.team.revise')} placeholder={t(language, 'agent.team.revisePlaceholder')}
        value={revisionText} onChange={event => setRevisionText(event.target.value)} disabled={disabled} rows={2} />
      <div><button type="submit" disabled={disabled || !revisionText.trim()}>{t(language, 'agent.team.revise')}</button>
        <button type="button" disabled={disabled} onClick={() => void respondPlan({ kind: 'cancel' }).catch(() => {})}>{t(language, 'agent.plan.ignoreAndStop')}</button></div>
    </form>}
    {projection.interactions.filter(interaction => interaction.status === 'pending').map(interaction => <InteractionCard
      key={interaction.interactionId} interaction={interaction} language={language} disabled={disabled} onRespond={respondInteraction} />)}
  </div>;
}
