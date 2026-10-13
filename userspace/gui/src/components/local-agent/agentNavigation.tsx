import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ActivityProjection, AgentTaskProjection, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

type AgentSelection = { sessionId: string; entryId: string };
const AGENT_OPEN_EVENT = 'deepcode:agent-open';
export function requestAgentConversation(parentSessionId: string, sessionId: string, entryId: string): void {
  window.dispatchEvent(new CustomEvent(AGENT_OPEN_EVENT, { detail: { parentSessionId, selection: { sessionId, entryId } } }));
}
const AgentNavigation = createContext({ surface: null as HTMLElement | null, selected: null as AgentSelection | null,
  tasks: [] as readonly AgentTaskProjection[], pendingDecisions: [] as NonNullable<SessionProjection['pendingAgentDecisions']>,
  open: (_selection: AgentSelection | null) => {} });

/** Local navigation only; switching this view never starts or stops an Agent. */
export function AgentNavigationScope({ children, sessionId, surface = null, tasks = [], pendingDecisions = [] }: {
  children: ReactNode; surface?: HTMLElement | null; tasks?: readonly AgentTaskProjection[];
  sessionId?: string | null; pendingDecisions?: SessionProjection['pendingAgentDecisions'];
}) {
  const [selected, open] = useState<AgentSelection | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ parentSessionId: string; selection: AgentSelection }>).detail;
      if (detail.parentSessionId === sessionId) open(detail.selection);
    };
    window.addEventListener(AGENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(AGENT_OPEN_EVENT, onOpen);
  }, [sessionId]);
  return <AgentNavigation.Provider value={{ selected, open, surface, tasks, pendingDecisions }}>{children}</AgentNavigation.Provider>;
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
        <DeepCodeShellIcon name="subagents" /><span>{activity.label}</span>
        {!sharedStatus && <span>{statusLabel}</span>}
      </button>;
    })}
    {sharedStatus && <span className="agent-tasks__group-status">{sharedStatus}</span>}
  </span>;
}
