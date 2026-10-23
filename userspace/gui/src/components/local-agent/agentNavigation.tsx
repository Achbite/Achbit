import { createContext, useContext, type ReactNode } from 'react';
import type { ActivityProjection, AgentTaskProjection, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';

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

/** Task status stays next to the journal activity that introduced it, never in the composer. */
export function AgentGroupSummary({ activities, language, entryPrefix = activities[0]?.activityId ?? '' }: {
  activities: readonly ActivityProjection[]; language: UiLanguage; entryPrefix?: string;
}) {
  const navigation = useAgentNavigation();
  const members = [...new Map(activities.filter(activity => activity.agent).map(activity => [activity.agent!.taskId ?? activity.activityId, activity])).values()]
    .map(activity => {
      const task = navigation.tasks.find(task => task.taskId === activity.agent!.taskId);
      const status = activity.agent!.phase === 'updated' ? 'updated' : activity.agent!.phase === 'completed' ? activity.status
        : task?.status ?? (activity.status === 'active' ? 'running' : activity.status);
      return { activity, status, statusLabel: t(language, activity.agent!.phase === 'started' && agentTaskNeedsInput(task, navigation.pendingDecisions)
        ? 'agent.team.needsInput' : `agent.team.status.${status}`) };
    });
  if (!members.length) return null;
  const sharedStatus = members.every(member => member.statusLabel === members[0]!.statusLabel) ? members[0]!.statusLabel : null;
  return <span className="agent-tasks__members">
    {members.map(({ activity, status, statusLabel }) => {
      const sessionId = activity.agent!.agentSessionId;
      const entryId = `${entryPrefix}:${activity.agent!.taskId ?? activity.activityId}`;
      const selected = navigation.selected?.entryId === entryId;
      return <button type="button" key={activity.activityId} aria-pressed={selected} aria-label={`${activity.label} · ${statusLabel}`}
        className={`agent-tasks__member agent-tasks__member--${status}`}
        onClick={() => navigation.open(selected ? null : { sessionId, entryId })}>
        <AchbitShellIcon name="subagents" /><span>{activity.label}</span>
        {!sharedStatus && <span>{statusLabel}</span>}
      </button>;
    })}
    {sharedStatus && <span className="agent-tasks__group-status">{sharedStatus}</span>}
  </span>;
}
