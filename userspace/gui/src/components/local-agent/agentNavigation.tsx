import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ActivityProjection, AgentTaskProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

const AgentNavigation = createContext({ surface: null as HTMLElement | null, selected: null as string | null,
  tasks: [] as readonly AgentTaskProjection[], needsInput: {} as Record<string, boolean>,
  setNeedsInput: (_sessionId: string, _pending: boolean) => {}, open: (_sessionId: string | null) => {} });

/** Local navigation only; switching this view never starts or stops an Agent. */
export function AgentNavigationScope({ children, surface = null, tasks = [] }: {
  children: ReactNode; surface?: HTMLElement | null; tasks?: readonly AgentTaskProjection[];
}) {
  const [selected, open] = useState<string | null>(null);
  const [needsInput, updateNeedsInput] = useState<Record<string, boolean>>({});
  const setNeedsInput = useCallback((sessionId: string, pending: boolean) => {
    updateNeedsInput(current => current[sessionId] === pending ? current : { ...current, [sessionId]: pending });
  }, []);
  return <AgentNavigation.Provider value={{ selected, open, surface, tasks, needsInput, setNeedsInput }}>{children}</AgentNavigation.Provider>;
}

export const useAgentNavigation = () => useContext(AgentNavigation);

export function AgentActivity({ activity, language }: { activity: ActivityProjection; language: UiLanguage }) {
  const navigation = useAgentNavigation();
  if (!activity.agent) return null;
  return <button type="button" className="agent-activity" onClick={() => navigation.open(activity.agent!.agentSessionId)}>
    <DeepCodeShellIcon name="subagents" />
    <span>{activity.label}</span>
    <span>{t(language, activity.agent.phase === 'started' ? 'agent.team.started' : `agent.team.status.${activity.status}`)}</span>
    <DeepCodeShellIcon name="chevronRight" />
  </button>;
}

/** Task status stays next to the journal activity that introduced it, never in the composer. */
export function AgentGroupSummary({ activities, language }: { activities: readonly ActivityProjection[]; language: UiLanguage }) {
  const navigation = useAgentNavigation();
  const ids = [...new Set(activities.flatMap(activity => activity.agent ? [activity.agent.taskId] : []))];
  if (!ids.length) return null;
  return <span className="agent-tasks__members">
    {ids.map(id => {
      const task = navigation.tasks.find(task => task.taskId === id);
      const activity = activities.find(activity => activity.agent?.taskId === id)!;
      const sessionId = activity.agent!.agentSessionId;
      const status = task?.status ?? activity.status;
      const needsInput = status === 'running' && navigation.needsInput[sessionId];
      return <button type="button" key={id} aria-pressed={navigation.selected === sessionId}
        className={`agent-tasks__member agent-tasks__member--${status}`}
        onClick={() => navigation.open(navigation.selected === sessionId ? null : sessionId)}>
        <DeepCodeShellIcon name="subagents" /><span>{activity.label}</span>
        <span>{t(language, needsInput ? 'agent.team.needsInput' : `agent.team.status.${status}`)}</span>
      </button>;
    })}
  </span>;
}
