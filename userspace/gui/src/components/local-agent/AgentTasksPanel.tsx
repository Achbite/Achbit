import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { CONVERSATION_COMMAND_VERSION, type AgentChildProjection, type AgentTaskProjection,
  type PlanResponse, type SessionProjection, type ShellAuthorizationScope, type UserSettings } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { ComposerDecisionPanels } from './ComposerDecisionPanels';
import { ConversationSessionScope } from './ConversationSessionScope';
import { InteractionCard } from './InteractionCard';
import { PlanCardContent } from './PlanCard';
import { planScopeAddition } from './planReview';
import { childNeedsBackgroundRead, useAgentChildConversation } from './useAgentChildConversation';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ArtifactLinks } from './ArtifactLinks';
import { requestWorkspacePreview } from './readerState';
import { AgentNavigationScope, useAgentNavigation } from './agentNavigation';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { projectionItems, assistantDraftItems } from './conversationItems';
import { ToolActivityGroup, ProviderHostedDraftGroup } from './ToolActivityDetails';
import PlanCard from './PlanCard';
import './agentTasksPanel.css';

export function AgentTasksPanel({ projection, language, visible = true, onNeedsInputChange }: {
  projection: SessionProjection; language: UiLanguage; visible?: boolean; onNeedsInputChange?(pending: boolean): void;
}) {
  const tasks = projection.agentTasks ?? [];
  const children = projection.agentChildren ?? [];
  const navigation = useAgentNavigation();
  const sessionIds = [...new Set([...children.map(child => child.agentSessionId), ...tasks.map(task => task.agentSessionId)])];
  const waiting = sessionIds.some(id => navigation.needsInput[id]);
  useEffect(() => { onNeedsInputChange?.(waiting); }, [waiting, onNeedsInputChange]);
  useEffect(() => {
    if (!navigation.selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { navigation.open(null); event.preventDefault(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigation.selected, navigation.open]);
  if (!sessionIds.length) return null;
  return <>
    {sessionIds.map(sessionId => <AgentChildView key={sessionId} sessionId={sessionId}
      tasks={tasks.filter(task => task.agentSessionId === sessionId)}
      instance={children.find(child => child.agentSessionId === sessionId)} language={language}
      expanded={visible && navigation.selected === sessionId} onClose={() => navigation.open(null)} onNeedsInput={navigation.setNeedsInput} />)}
  </>;
}

function AgentChildView({ sessionId, tasks, instance, language, expanded, onClose, onNeedsInput }: {
  sessionId: string; tasks: AgentTaskProjection[]; instance?: AgentChildProjection; language: UiLanguage;
  expanded: boolean; onClose(): void; onNeedsInput(sessionId: string, pending: boolean): void;
}) {
  const { surface } = useAgentNavigation();
  const [descendantNeedsInput, setDescendantNeedsInput] = useState(false);
  const revision = tasks.map(task => `${task.taskId}:${task.childRunId ?? ''}:${task.status}`).join('|');
  const child = useAgentChildConversation(sessionId, revision, tasks.some(task => task.status === 'running'), expanded,
    childNeedsBackgroundRead(instance, tasks));
  const projection = child.projection;
  const pending = descendantNeedsInput || Boolean(projection?.pendingApproval || projection?.pendingPlan || projection?.interactions.some(item => item.status === 'pending'));
  useEffect(() => { onNeedsInput(sessionId, pending); }, [onNeedsInput, sessionId, pending]);
  const name = instance?.displayName ?? tasks[0]!.displayName;
  return <ConversationSessionScope.Provider value={sessionId}><AgentNavigationScope surface={surface} tasks={projection?.agentTasks}>
    {surface && createPortal(<aside hidden={!expanded} className="agent-tasks__drawer" aria-label={name} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <header><strong>{name}</strong>
        <span>{tasks.at(-1) && t(language, `agent.team.status.${tasks.at(-1)!.status}`)}{instance?.closed && ` · ${t(language, 'agent.team.closed')}`}</span>
        <button type="button" aria-label={t(language, 'agent.team.closeView')} onClick={onClose}><DeepCodeShellIcon name="close" /></button>
      </header>
      <div className="agent-tasks__child-body">
        {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
          <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
        {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
        {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
        {projection && expanded && <>
          <AgentConversationHistory projection={projection} name={name} language={language} expanded />
          <ArtifactLinks artifacts={projection.artifacts} onOpen={(workspaceId, path) => requestWorkspacePreview(sessionId, workspaceId, path)} />
          <ChildDecisions key={`${projection.pendingPlan?.planId ?? ''}:${projection.pendingPlan?.revision ?? ''}`}
            child={child} projection={projection} language={language} />
          {projection.terminalError && <p role="alert" className="agent-tasks__error">{projection.terminalError.message}</p>}
        </>}
      </div>
      {projection && <AgentTasksPanel key={projection.sessionId} projection={projection} language={language}
        visible={expanded} onNeedsInputChange={setDescendantNeedsInput} />}
    </aside>, surface)}
  </AgentNavigationScope></ConversationSessionScope.Provider>;
}

/** Child history consumes the same canonical rows and activity/Plan components as the main view. */
export function AgentConversationHistory({ projection, name, language, expanded }: {
  projection: SessionProjection; name: string; language: UiLanguage; expanded: boolean;
  onExpandedChange?(expanded: boolean): void;
}) {
  if (!expanded) return null;
  const openResource = (workspaceId: string, path: string) => requestWorkspacePreview(projection.sessionId, workspaceId, path);
  return <div className="agent-tasks__conversation">
    {projectionItems(projection).map(item => item.type === 'toolGroup'
      ? <ToolActivityGroup key={item.groupId} activities={item.values} language={language} onExpand={() => {}}
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

function ChildDecisions({ child, projection, language }: {
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
