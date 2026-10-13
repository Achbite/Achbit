import { useEffect, useId, useState } from 'react';
import type { SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { requestAgentConversation } from './agentNavigation';

/** A display of the latest member facts; opening history reuses the conversation's navigation. */
export function agentOverviewMembers(projection: SessionProjection) {
  const tasks = new Map(projection.agentTasks?.map(task => [task.agentSessionId, task]));
  const children = new Map(projection.agentChildren?.map(child => [child.agentSessionId, child]));
  const decisions = new Map(projection.pendingAgentDecisions?.map(decision => [decision.agentSessionId, decision]));
  const ids = new Set([...children.keys(), ...tasks.keys(), ...decisions.keys()]);
  return [...ids].map(sessionId => ({ sessionId,
    name: tasks.get(sessionId)?.displayName ?? children.get(sessionId)?.displayName ?? decisions.get(sessionId)!.displayName,
    status: decisions.has(sessionId) ? 'needsInput' : tasks.get(sessionId)?.status ?? 'idle',
  }));
}

const statusKey = (status: string) => status === 'needsInput' ? 'agent.team.needsInput' : `agent.team.status.${status}`;

export function AgentOverview({ projection, language }: { projection: SessionProjection; language: UiLanguage }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  useEffect(() => setExpanded(false), [projection.sessionId]);
  const members = agentOverviewMembers(projection);
  // Finished or closed members still have history; hide only a Session with no members.
  if (!members.length) return null;
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
  const otherCounts = ['needsInput', 'running', 'failed', 'indeterminate', 'cancelled', 'idle'].filter(status => counts.has(status));
  return <section className="deepcode-gui-task-list-card">
    <div className="deepcode-gui-task-list-card__title">{t(language, 'agent.team.title')}</div>
    <button type="button" className="deepcode-gui-agent-summary" aria-expanded={expanded} aria-controls={listId}
      onClick={() => setExpanded(value => !value)}>
      <DeepCodeShellIcon name="subagents" />
      <span className="deepcode-gui-agent-summary__active">{otherCounts.map(status => <span key={status}>
        {counts.get(status)} {t(language, statusKey(status))}
      </span>)}</span>
      {counts.has('completed') && <span>{counts.get('completed')} {t(language, statusKey('completed'))}</span>}
      <DeepCodeShellIcon name={expanded ? 'chevronDown' : 'chevronRight'} />
    </button>
    {expanded && <div id={listId} className="deepcode-gui-agent-members">
      {members.map(member => <button type="button" key={member.sessionId} className={`deepcode-gui-agent-member deepcode-gui-agent-member--${member.status}`}
        onClick={() => requestAgentConversation(projection.sessionId, member.sessionId, `overview:${member.sessionId}`)}>
        <DeepCodeShellIcon name="subagents" /><span>{member.name}</span><span>{t(language, statusKey(member.status))}</span>
      </button>)}
    </div>}
  </section>;
}
