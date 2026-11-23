import { createContext, useContext, type ReactNode } from 'react';
import type { ActivityProjection, AgentTaskProjection, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { Button, DisclosureSummary, UiIcon } from '../../ui-components';

import { requestReader, type AgentReaderTarget } from './readerState';

type AgentSelection = { sessionId: string; entryId: string };
export function requestAgentConversation(parentSessionId: string, sessionId: string, entryId: string): void {
  requestReader(parentSessionId, { kind: 'agent', parentSessionId, agentSessionId: sessionId, entryId });
}
export function requestAgentOverview(parentSessionId: string): void {
  requestReader(parentSessionId, { kind: 'agent', parentSessionId });
}
const AgentNavigation = createContext({ selected: null as AgentSelection | null,
  activeAgent: null as AgentReaderTarget | null, closeAgent: () => {},
  tasks: [] as readonly AgentTaskProjection[], pendingDecisions: [] as NonNullable<SessionProjection['pendingAgentDecisions']>,
  open: (_selection: AgentSelection | null) => {} });

/** Reader owns navigation state; switching this view never starts or stops an Agent. */
export function AgentNavigationScope({ children, sessionId, activeAgent, onCloseAgent, tasks = [], pendingDecisions = [] }: {
  children: ReactNode; tasks?: readonly AgentTaskProjection[];
  sessionId?: string | null; pendingDecisions?: SessionProjection['pendingAgentDecisions'];
  activeAgent?: AgentReaderTarget | null; onCloseAgent?(): void;
}) {
  const parent = useContext(AgentNavigation);
  const active = activeAgent === undefined ? parent.activeAgent : activeAgent;
  const closeAgent = onCloseAgent ?? parent.closeAgent;
  const selected = active?.agentSessionId && active.parentSessionId === sessionId ? { sessionId: active.agentSessionId, entryId: active.entryId ?? '' } : null;
  const open = (selection: AgentSelection | null) => {
    if (!selection) closeAgent();
    else if (sessionId) requestAgentConversation(sessionId, selection.sessionId, selection.entryId);
  };
  return <AgentNavigation.Provider value={{ selected, open, activeAgent: active, closeAgent, tasks, pendingDecisions }}>{children}</AgentNavigation.Provider>;
}

export const useAgentNavigation = () => useContext(AgentNavigation);

/** A later task on the same Session cannot change an earlier task's displayed outcome. */
export function agentTaskNeedsInput(task: AgentTaskProjection | undefined, decisions: SessionProjection['pendingAgentDecisions']): boolean {
  return Boolean(task?.status === 'running' && task.childRunId
    && decisions?.some(decision => decision.agentSessionId === task.agentSessionId && decision.runId === task.childRunId));
}

type AgentActivity = ActivityProjection & { agent: NonNullable<ActivityProjection['agent']> };
const statusLabel = (language: UiLanguage, status: string) => t(language, status === 'needsInput' ? 'agent.team.needsInput'
  : status === 'started' ? 'agent.team.fold.started' : `agent.team.status.${status}`);

/** Count Sessions, retain task outcomes, and keep every distinct journal activity in sequence. */
function useAgentEvents(activities: readonly ActivityProjection[]) {
  const navigation = useAgentNavigation();
  const tasks = new Map(navigation.tasks.map(task => [task.taskId, task]));
  const events = [...new Map(activities.filter((a): a is AgentActivity => !!a.agent).map(a => [a.activityId, a])).values()]
    .sort((a, b) => a.sequence - b.sequence);
  const members = new Map<string, Map<string, string>>();
  for (const a of events) {
    const { agentSessionId, taskId, phase } = a.agent;
    const outcomes = members.get(agentSessionId) ?? new Map<string, string>();
    members.set(agentSessionId, outcomes);
    if (taskId) {
      const candidate = tasks.get(taskId);
      const task = candidate?.agentSessionId === agentSessionId ? candidate : undefined;
      // A message's activity.status is 'completed' for its delivery, not the child's result.
      outcomes.set(taskId, phase === 'completed' ? a.status : agentTaskNeedsInput(task, navigation.pendingDecisions) ? 'needsInput' : task?.status ?? 'running');
    }
  }
  const statuses = new Set<string>();
  for (const [sessionId, outcomes] of members) {
    if (outcomes.size) { for (const status of outcomes.values()) statuses.add(status); continue; }
    // A segment may contain only messages from a child started before a paragraph/decision.
    // Only task facts for this child and parent run can supply its status; don't borrow a later assignment.
    const matching = navigation.tasks.filter(task => task.agentSessionId === sessionId && task.parentRunId === events[0]?.runId);
    if (matching.length === 1) statuses.add(agentTaskNeedsInput(matching[0], navigation.pendingDecisions) ? 'needsInput' : matching[0]!.status);
    else statuses.add(matching.length > 0 && matching.every(task => task.status === 'completed') ? 'completed' : 'updated');
  }
  if (statuses.size > 1) statuses.delete('completed'); // Never summarize a mixed group as all done.
  return { events, count: members.size, statuses };
}

/** Each line opens the same child Reader; phase and targeting come from the event, never the display name. */
export function AgentGroupSummary({ activities, language }: { activities: readonly ActivityProjection[]; language: UiLanguage }) {
  const navigation = useAgentNavigation();
  return <ol className="agent-tasks__event-list">{activities.map(a => {
    if (!a.agent) return null;
    const status = a.agent.phase === 'completed' ? a.status : a.agent.phase;
    const label = statusLabel(language, status), entryId = a.activityId, sessionId = a.agent.agentSessionId;
    const selected = navigation.selected?.entryId === entryId && navigation.selected?.sessionId === sessionId;
    return <li key={entryId}><Button variant="ghost" size="compact" aria-pressed={selected} aria-label={`${a.label} · ${label}`}
      className={`agent-tasks__event agent-tasks__event--${status}`} onClick={() => navigation.open(selected ? null : { sessionId, entryId })}>
      <UiIcon name="subagents" /><span>{a.label}</span><small>{label}</small></Button></li>;
  })}</ol>;
}

export function AgentActivityDisclosure({ activities, language, expanded, onChange, summaryAction }: {
  activities: readonly ActivityProjection[]; language: UiLanguage; expanded: boolean; onChange(next: boolean, summary: HTMLElement): void;
  summaryAction?: Record<string, string>;
}) {
  const { count, statuses, events } = useAgentEvents(activities);
  if (!count) return null;
  const alerts = ['needsInput', 'failed'].filter(status => statuses.has(status));
  const other = ['indeterminate','cancelled','running','updated','completed'].find(status => statuses.has(status));
  const labels = alerts.length ? alerts : other ? [other] : [];
  return <details className="agent-tasks__fold" open={expanded}>
    <DisclosureSummary {...summaryAction} aria-expanded={expanded} data-conversation-disclosure={`agent-fold:${events[0]!.activityId}`} onClick={event => {
      event.preventDefault(); onChange(!expanded, event.currentTarget);
    }}><UiIcon name="subagents" /><strong>{t(language, count === 1 ? 'agent.team.fold.one' : 'agent.team.fold.many', { count })}</strong>
      {labels.map(status =>
        <span className={`agent-tasks__fold-status agent-tasks__fold-status--${status}`} key={status}>{statusLabel(language, status)}</span>)}
    </DisclosureSummary>
    {expanded && <AgentGroupSummary activities={events} language={language} />}
  </details>;
}
