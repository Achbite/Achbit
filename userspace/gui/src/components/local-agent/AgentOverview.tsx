import type { SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { requestAgentConversation, requestAgentOverview } from './agentNavigation';

/** A display of the latest member facts; opening history reuses the conversation's navigation. */
export function agentOverviewMembers(projection: SessionProjection) {
  const tasks = new Map(projection.agentTasks?.map(task => [task.agentSessionId, task]));
  const children = new Map(projection.agentChildren?.map(child => [child.agentSessionId, child]));
  const decisions = new Map(projection.pendingAgentDecisions?.map(decision => [decision.agentSessionId, decision]));
  const ids = new Set([...children.keys(), ...tasks.keys(), ...decisions.keys()]);
  return [...ids].map(sessionId => ({ sessionId,
    name: tasks.get(sessionId)?.displayName ?? children.get(sessionId)?.displayName ?? decisions.get(sessionId)!.displayName,
    status: decisions.has(sessionId) ? 'needsInput' : tasks.get(sessionId)?.status ?? (children.get(sessionId)?.closed ? 'closed' : 'idle'),
    description: tasks.get(sessionId)?.result?.content ?? tasks.get(sessionId)?.text,
  }));
}

const statusKey = (status: string) => status === 'closed' ? 'agent.team.closed' : status === 'needsInput' ? 'agent.team.needsInput' : `agent.team.status.${status}`;

export function AgentOverview({ projection, language }: { projection: SessionProjection; language: UiLanguage }) {
  const members = agentOverviewMembers(projection);
  // Finished or closed members still have history; hide only a Session with no members.
  if (!members.length) return null;
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
  const otherCounts = ['needsInput', 'running', 'failed', 'indeterminate', 'cancelled', 'closed', 'idle'].filter(status => counts.has(status));
  return <section className="deepcode-gui-task-list-card">
    <div className="deepcode-gui-task-list-card__title">{t(language, 'agent.team.title')}</div>
    <button type="button" className="deepcode-gui-agent-summary" aria-label={t(language, 'agent.page.overview')}
      onClick={() => requestAgentOverview(projection.sessionId)}>
      <DeepCodeShellIcon name="subagents" />
      <span className="deepcode-gui-agent-summary__active">{otherCounts.map(status => <span key={status}>
        {counts.get(status)} {t(language, statusKey(status))}
      </span>)}</span>
      {counts.has('completed') && <span>{counts.get('completed')} {t(language, statusKey('completed'))}</span>}
      <DeepCodeShellIcon name="chevronRight" />
    </button>
  </section>;
}

/** Only parent projection facts are used; this list does not open every child's history. */
export function AgentOverviewList({ projection, language }: { projection: SessionProjection; language: UiLanguage }) {
  const members = agentOverviewMembers(projection);
  if (!members.length) return <p className="agent-tasks__list-empty">{t(language, 'agent.page.empty')}</p>;
  return <div className="agent-tasks__overview">
    {['needsInput', 'running', 'idle', 'completed', 'failed', 'cancelled', 'indeterminate', 'closed'].map(status => {
      const group = members.filter(member => member.status === status);
      if (!group.length) return null;
      return <section key={status} aria-label={t(language, statusKey(status))}>
        <h3>{t(language, statusKey(status))}<span>{group.length}</span></h3>
        <div className="deepcode-gui-agent-members">
          {group.map(member => <button type="button" key={member.sessionId} className={`deepcode-gui-agent-member deepcode-gui-agent-member--${member.status}`}
            onClick={() => requestAgentConversation(projection.sessionId, member.sessionId, `overview:${member.sessionId}`)}>
            <DeepCodeShellIcon name="subagents" /><span><strong>{member.name}</strong>
              {member.description && <small>{member.description}</small>}</span><DeepCodeShellIcon name="chevronRight" />
          </button>)}
        </div>
      </section>;
    })}
  </div>;
}
