import { useCallback, useEffect, useState } from 'react';
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
import './agentTasksPanel.css';

export function AgentTasksPanel({ projection, language, visible = true, onNeedsInputChange }: {
  projection: SessionProjection; language: UiLanguage; visible?: boolean; onNeedsInputChange?(pending: boolean): void;
}) {
  const tasks = projection.agentTasks ?? [];
  const children = projection.agentChildren ?? [];
  const [expanded, setExpanded] = useState(false);
  const [needsInput, setNeedsInput] = useState<Record<string, boolean>>({});
  const onNeedsInput = useCallback((sessionId: string, pending: boolean) => {
    setNeedsInput(current => current[sessionId] === pending ? current : { ...current, [sessionId]: pending });
  }, []);
  const sessionIds = [...new Set([...children.map(child => child.agentSessionId), ...tasks.map(task => task.agentSessionId)])];
  const waiting = sessionIds.some(id => needsInput[id]);
  useEffect(() => { onNeedsInputChange?.(waiting); }, [waiting, onNeedsInputChange]);
  if (!sessionIds.length) return null;
  return <details className="agent-tasks" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><strong>{t(language, 'agent.team.title')}</strong><span>{sessionIds.length}</span>
      {waiting && <span className="agent-tasks__attention">{t(language, 'agent.team.needsInput')}</span>}
    </summary>
    <div className="agent-tasks__list">
      {sessionIds.map(sessionId => <AgentChildView key={sessionId} sessionId={sessionId}
        tasks={tasks.filter(task => task.agentSessionId === sessionId)}
        instance={children.find(child => child.agentSessionId === sessionId)}
        language={language} panelExpanded={visible && expanded} onNeedsInput={onNeedsInput} />)}
    </div>
  </details>;
}

function AgentChildView({ sessionId, tasks, instance, language, panelExpanded, onNeedsInput }: {
  sessionId: string; tasks: AgentTaskProjection[]; instance?: AgentChildProjection; language: UiLanguage;
  panelExpanded: boolean; onNeedsInput(sessionId: string, pending: boolean): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [descendantNeedsInput, setDescendantNeedsInput] = useState(false);
  const revision = tasks.map(task => `${task.taskId}:${task.childRunId ?? ''}:${task.status}`).join('|');
  const child = useAgentChildConversation(sessionId, revision, tasks.some(task => task.status === 'running'), panelExpanded && expanded,
    childNeedsBackgroundRead(instance, tasks));
  const projection = child.projection;
  const pending = descendantNeedsInput || Boolean(projection?.pendingApproval || projection?.pendingPlan || projection?.interactions.some(item => item.status === 'pending'));
  useEffect(() => { onNeedsInput(sessionId, pending); }, [onNeedsInput, sessionId, pending]);
  const name = instance?.displayName ?? tasks[0]!.displayName;
  return <ConversationSessionScope.Provider value={sessionId}>
    <details className="agent-tasks__child" open={expanded} onToggle={event => { event.stopPropagation(); setExpanded(event.currentTarget.open); }}>
      <summary><strong>{name}</strong>
        {instance?.closed && <span>{t(language, 'agent.team.closed')}</span>}
        {pending && <span className="agent-tasks__attention">{t(language, 'agent.team.needsInput')}</span>}
        {tasks.at(-1) && <span>{t(language, `agent.team.status.${tasks.at(-1)!.status}`)}</span>}
      </summary>
      {expanded && <div className="agent-tasks__child-body">
        {tasks.map(task => <article key={task.taskId} className="agent-tasks__task">
          <header><strong>{t(language, 'agent.team.tasks')}</strong><span>{t(language, `agent.team.status.${task.status}`)}</span></header>
          <MarkdownContent>{task.text}</MarkdownContent>
          {task.result?.content && <MarkdownContent>{task.result.content}</MarkdownContent>}
          {task.result?.error && <p className="agent-tasks__error" role="alert">{task.result.error.message}</p>}
          {projection && task.childRunId && <FileChanges activities={roundChangeActivities(projection, task.childRunId)} />}
        </article>)}
        {child.readError && <div role="alert" className="agent-tasks__error"><p>{child.readError}</p>
          <button type="button" onClick={() => void child.refresh()}>{t(language, 'agent.team.refresh')}</button></div>}
        {child.commandError && <p role="alert" className="agent-tasks__error">{child.commandError}</p>}
        {!projection && !child.readError && <p role="status">{t(language, 'agent.team.loading')}</p>}
        {projection && <>
          <ArtifactLinks artifacts={projection.artifacts} onOpen={(workspaceId, path) => requestWorkspacePreview(sessionId, workspaceId, path)} />
          <ChildDecisions key={`${projection.pendingPlan?.planId ?? ''}:${projection.pendingPlan?.revision ?? ''}`}
            child={child} projection={projection} language={language} />
          <AgentConversationHistory projection={projection} name={name} language={language}
            expanded={conversationExpanded} onExpandedChange={setConversationExpanded} />
          {projection.terminalError && <p role="alert" className="agent-tasks__error">{projection.terminalError.message}</p>}
        </>}
      </div>}
      {projection && <div className="agent-tasks__child-body" hidden={!expanded}>
        <AgentTasksPanel key={projection.sessionId} projection={projection} language={language}
          visible={panelExpanded && expanded} onNeedsInputChange={setDescendantNeedsInput} />
      </div>}
    </details>
  </ConversationSessionScope.Provider>;
}

export function AgentConversationHistory({ projection, name, language, expanded, onExpandedChange }: {
  projection: SessionProjection; name: string; language: UiLanguage; expanded: boolean;
  onExpandedChange(expanded: boolean): void;
}) {
  return <details className="agent-tasks__conversation" open={expanded}
    onToggle={event => { event.stopPropagation(); onExpandedChange(event.currentTarget.open); }}>
    <summary>{t(language, 'agent.team.conversation')}</summary>
    {expanded && projection.timeline.flatMap(item => {
      if (item.kind === 'message') {
        const message = projection.messages.find(message => message.messageId === item.messageId);
        return message && (message.role === 'user' || message.role === 'assistant') ? [{
          key: item.timelineId, label: message.role === 'user' ? t(language, 'agent.team.input') : name,
          content: message.displayContent ?? message.content,
        }] : [];
      }
      if (item.kind === 'narrative') {
        const narrative = projection.narratives.find(narrative => narrative.narrativeId === item.narrativeId);
        return narrative ? [{ key: item.timelineId, label: name, content: narrative.displayContent ?? narrative.content }] : [];
      }
      return [];
    }).map(message => <article key={message.key}>
      <header>{message.label}</header><MarkdownContent>{message.content}</MarkdownContent>
    </article>)}
    {expanded && projection.assistantDraft?.blocks.map(block => block.kind !== 'providerHosted' && <article key={block.streamId}>
      <header>{name}</header><MarkdownContent streaming>{block.displayContent ?? block.content}</MarkdownContent>
    </article>)}
  </details>;
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
