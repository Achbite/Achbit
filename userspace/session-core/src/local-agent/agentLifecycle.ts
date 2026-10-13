import type { AgentChildProjection, AgentLifecycleEvent, AgentTaskProjection, SessionEvent } from '@deepcode/protocol';

export type AgentTaskSummary = Omit<AgentTaskProjection, 'text' | 'result'>;
export interface AgentLifecycleState {
  agentTasks: AgentTaskSummary[];
  agentChildren: AgentChildProjection[];
}
type AgentRelationEvent = Exclude<AgentLifecycleEvent, { type: 'session.created' }>;
export type AgentLifetimeEvent = Extract<SessionEvent, { type: AgentRelationEvent['type'] }>;
export type AgentLifetime = { agentTasks: AgentTaskProjection[]; agentChildren: AgentChildProjection[] };

export function isAgentLifetimeEvent(event: SessionEvent): event is AgentLifetimeEvent {
  return event.type === 'agent.task.created' || event.type === 'agent.task.started'
    || event.type === 'agent.task.completed' || event.type === 'agent.closed';
}

/** Full replay validates business evidence; management uses the same relation transitions.
 * Spreads retain the full task payload when this reducer receives full journal facts. */
export function reduceAgentLifetime(previous: AgentLifetime, event: AgentLifetimeEvent): AgentLifetime {
  if (event.type === 'agent.task.completed') {
    const result = event.payload.result;
    if (result.outcome === 'completed' && (!result.content || !result.finalMessageId)
      || ['failed', 'indeterminate'].includes(result.outcome) && !result.error) throw new Error('agent_task_result_invalid');
  }
  return reduceAgentLifecycle(previous, event) as AgentLifetime;
}

export function reduceAgentLifecycle(previous: AgentLifecycleState, event: AgentRelationEvent): AgentLifecycleState {
  const next = { agentTasks: previous.agentTasks, agentChildren: previous.agentChildren };
  switch (event.type) {
    case 'agent.task.created':
      if (next.agentTasks.some(task => task.taskId === event.payload.taskId)) throw new Error('agent_task_duplicate');
      const { createsAgent, ...task } = event.payload;
      next.agentTasks = [...next.agentTasks, { ...task, parentRunId: event.runId, status: 'running' }];
      const child = next.agentChildren.find(item => item.agentSessionId === event.payload.agentSessionId);
      if (createsAgent) {
        if (child) throw new Error('agent_child_duplicate');
        next.agentChildren = [...next.agentChildren, { agentSessionId: event.payload.agentSessionId,
          displayName: event.payload.displayName, capabilities: structuredClone(event.payload.capabilities), closed: false }];
      } else if (!event.payload.capabilities.continuation || child && (child.closed
        || Object.keys(child.capabilities).some(key => child.capabilities[key as keyof typeof child.capabilities]
          !== event.payload.capabilities[key as keyof typeof child.capabilities]))) throw new Error('agent_child_not_continuable');
      break;
    case 'agent.task.started':
    case 'agent.task.completed': {
      const task = next.agentTasks.find(item => item.taskId === event.payload.taskId);
      if (!task || task.parentRunId !== event.runId || task.status !== 'running') throw new Error('agent_task_transition_invalid');
      if (event.type === 'agent.task.started') {
        if (task.childRunId) throw new Error('agent_task_already_started');
        next.agentTasks = next.agentTasks.map(item => item === task ? { ...item, childRunId: event.payload.childRunId } : item);
      } else {
        const result = event.payload.result;
        next.agentTasks = next.agentTasks.map(item => item === task ? { ...item, status: result.outcome, result: structuredClone(result) } : item);
      }
      break;
    }
    case 'agent.closed': {
      const member = next.agentChildren.find(item => item.agentSessionId === event.payload.agentSessionId);
      if (!member || member.closed || next.agentTasks.some(task => task.agentSessionId === member.agentSessionId && task.status === 'running')) {
        throw new Error('agent_child_close_invalid');
      }
      next.agentChildren = next.agentChildren.map(item => item === member ? { ...item, closed: true } : item);
      break;
    }
  }
  return next;
}


/** In-process storage adapter uses the same field projection as journal SQL. */
export function projectAgentLifecycleEvent(event: SessionEvent): AgentLifecycleEvent | null {
  const base = { sessionId: event.sessionId, sequence: event.sequence };
  switch (event.type) {
    case 'session.created': return { ...base, type: event.type,
      payload: event.payload.agentContext ? { agentContext: structuredClone(event.payload.agentContext) } : {} };
    case 'agent.task.created': {
      const { text: _text, ...payload } = event.payload;
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: structuredClone(payload) };
    }
    case 'agent.task.started': return { ...base, type: event.type, runId: event.runId, payload: { ...event.payload } };
    case 'agent.task.completed': return { ...base, type: event.type, runId: event.runId,
      payload: { taskId: event.payload.taskId, result: { outcome: event.payload.result.outcome } } };
    case 'agent.closed': return { ...base, type: event.type, payload: { ...event.payload } };
    default: return null;
  }
}
