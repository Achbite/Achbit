import { CONVERSATION_COMMAND_VERSION } from '@deepcode/protocol';
import type {
  AgentCapabilities, AgentChildProjection, AgentHostPort, AgentOperation, AgentTaskProjection,
  CommandReply, JsonObject, SessionProjection,
} from '@deepcode/protocol';
import type { SessionActor } from './actor.js';
import { agentOperationDefinitions } from './sessionControls.js';
import { errorFact, LoopFailure } from './loopFailure.js';

export interface AgentSessionRuntime {
  execute(runId: string, callId: string, operation: AgentOperation, signal: AbortSignal): Promise<JsonObject>;
  wait(runId: string, signal: AbortSignal): Promise<void>;
  cancel(runId: string): Promise<void>;
}

type TaskLease = {
  parentSessionId: string;
  parentRunId: string;
  agentSessionId: string;
  completion: Promise<void>;
  cancellation?: Promise<void>;
};

/** Runtime leases only. Relationships, requests and results are reduced from Session journals. */
export class AgentManager {
  readonly #leases = new Map<string, TaskLease>();
  #admissions: Promise<void> = Promise.resolve();
  #closing = false;
  readonly #blockedOwners = new Map<string, number>();
  #activeAdmission?: { sessionId: string; runId: string; completion: Promise<unknown> };

  constructor(
    readonly host: AgentHostPort,
    readonly actor: (sessionId: string) => Promise<SessionActor>,
  ) {}

  forSession(sessionId: string): AgentSessionRuntime {
    return {
      execute: (runId, callId, operation, signal) => this.execute(sessionId, runId, callId, operation, signal),
      wait: (runId, signal) => this.wait(sessionId, runId, undefined, signal),
      cancel: runId => this.cancelRun(sessionId, runId),
    };
  }

  async execute(sessionId: string, runId: string, callId: string, operation: AgentOperation, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    if (this.#closing) throw new Error('agent_manager_stopped');
    const caller = await (await this.actor(sessionId)).snapshot();
    if (caller.run?.runId !== runId || caller.run.status !== 'running') throw new Error('agent_caller_run_not_active');
    const capabilities = await (await this.actor(sessionId)).agentCapabilities(runId);
    const allowed = operation.action === 'models' ? capabilities.messaging || capabilities.delegation
      : operation.action === 'send' ? capabilities.messaging : capabilities.delegation;
    if (!allowed) throw new Error('agent_capability_unavailable');
    switch (operation.action) {
      case 'models':
        return { operations: agentOperationDefinitions(capabilities), models: await abortable(this.host.models(), signal) };
      case 'spawn': {
        const task = await abortable(this.admit(sessionId, runId, () => this.start(caller, runId, callId, operation, signal)), signal);
        if (operation.delivery === 'wait') {
          await this.wait(sessionId, runId, [task.taskId], signal);
          const completed = (await (await this.actor(sessionId)).snapshot()).agentTasks!.find(item => item.taskId === task.taskId)!;
          return { taskId: task.taskId, agentId: task.agentSessionId, ...completed.result };
        }
        return { taskId: task.taskId, agentId: task.agentSessionId };
      }
      case 'send':
        return await abortable(this.admit(sessionId, runId, () => this.send(caller, runId, callId, operation.agentId, operation.text, signal)), signal);
      case 'wait': {
        await this.wait(sessionId, runId, operation.taskIds, signal);
        const projection = await (await this.actor(sessionId)).snapshot();
        return { completedTaskIds: (projection.agentTasks ?? [])
          .filter(task => task.parentRunId === runId && task.status !== 'running' && (!operation.taskIds || operation.taskIds.includes(task.taskId)))
          .map(task => task.taskId) };
      }
      case 'cancel': {
        return await abortable(this.admit(sessionId, runId, async () => {
          signal.throwIfAborted();
          const family = await this.family(await (await this.actor(sessionId)).snapshot());
          const parent = family.find(item => item.agentTasks?.some(task => task.taskId === operation.taskId));
          const task = parent?.agentTasks?.find(item => item.taskId === operation.taskId);
          if (!parent || !task) throw new Error('agent_task_not_owned');
          await this.cancelTask(parent.sessionId, task);
          return { taskId: task.taskId, outcome: (await (await this.actor(parent.sessionId)).snapshot()).agentTasks!
            .find(item => item.taskId === task.taskId)!.result?.outcome };
        }), signal);
      }
      case 'close':
        return await abortable(this.admit(sessionId, runId, async () => {
          signal.throwIfAborted();
          await this.close(caller, operation.agentId);
          return { agentId: operation.agentId, closed: true };
        }), signal);
    }
  }

  private async start(caller: SessionProjection, runId: string, callId: string,
    operation: Extract<AgentOperation, { action: 'spawn' }>, signal: AbortSignal,
    existingChild?: AgentChildProjection): Promise<AgentTaskProjection> {
    signal.throwIfAborted();
    caller = await (await this.actor(caller.sessionId)).snapshot();
    const settings = await this.host.settings();
    if (!settings.enabled) throw new Error('agent_disabled');
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await (await this.actor(ownerId)).snapshot();
    let modelSelection: { profileId: string; reasoningEffortOverride: import('@deepcode/protocol').LlmReasoningEffort | null } | undefined;
    if (!existingChild) {
      const followsOwner = operation.profileId === undefined && !settings.profileId;
      if (followsOwner && !owner.run?.profileId) throw new Error('agent_owner_run_model_missing');
      const profileId = operation.profileId ?? (settings.profileId || owner.run!.profileId);
      const reasoningEffortOverride = operation.reasoningEffort ?? (operation.profileId !== undefined ? null
        : settings.reasoningEffort || (followsOwner ? owner.run!.reasoningEffort : undefined) || null);
      modelSelection = { profileId, reasoningEffortOverride };
    }
    const callerCapabilities = await (await this.actor(caller.sessionId)).agentCapabilities(runId);
    if (!existingChild && (!callerCapabilities.delegation || caller.agentContext && !settings.allowMemberAnalysis)) {
      throw new Error('agent_delegation_disabled');
    }
    const capabilities = existingChild?.capabilities ?? resolveCapabilities(operation, callerCapabilities, settings.allowMemberAnalysis);
    if (existingChild && (!existingChild.capabilities.continuation || existingChild.closed)) throw new Error('agent_child_not_continuable');
    if ((caller.agentTasks ?? []).filter(task => task.parentRunId === runId).length >= settings.maxCallsPerRun) throw new Error('agent_run_call_limit');
    const family = await this.family(owner);
    if (family.flatMap(item => item.agentTasks ?? []).filter(task => task.status === 'running').length >= settings.maxConcurrent) throw new Error('agent_concurrency_limit');
    if (capabilities.continuation && !existingChild
      && family.flatMap(item => item.agentChildren ?? []).filter(child => !child.closed && child.capabilities.continuation).length
        >= settings.maxMembersPerSession) throw new Error('agent_continuation_limit');
    const parent = await this.actor(caller.sessionId);
    const task: AgentTaskProjection = {
      taskId: id('agent-task'), agentSessionId: existingChild?.agentSessionId ?? id('session'),
      capabilities,
      displayName: existingChild?.displayName ?? operation.name, text: operation.task,
      delivery: operation.delivery, parentRunId: runId, status: 'running',
    };
    await parent.recordAgentEvents([{ type: 'agent.task.created', sessionId: caller.sessionId, runId, callId,
      payload: { taskId: task.taskId, agentSessionId: task.agentSessionId, capabilities, createsAgent: !existingChild,
        displayName: task.displayName, text: task.text, delivery: task.delivery } }]);
    let childCreated = Boolean(existingChild);
    let previousChildRunId: string | undefined;
    let childInputSubmitted = false;
    try {
      if (!existingChild) {
        await this.host.createSession({ sessionId: task.agentSessionId, displayTitle: task.displayName,
          workspaceBindings: caller.run!.workspaceBindings, profileId: modelSelection!.profileId,
          agentContext: { capabilities, ownerSessionId: ownerId, parentSessionId: caller.sessionId,
            parentRunId: runId, parentCallId: callId } });
        childCreated = true;
      }
      signal.throwIfAborted();
      const child = await this.actor(task.agentSessionId);
      previousChildRunId = (await child.snapshot()).run?.runId;
      const permissions = caller.effectivePermissions;
      if (!permissions) throw new Error('agent_parent_permissions_missing');
      accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.permissions.set',
        sessionId: task.agentSessionId, commandId: id('agent-permissions'), patches: permissions }));
      signal.throwIfAborted();
      childInputSubmitted = true;
      accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'message.submit',
        sessionId: task.agentSessionId, commandId: id('agent-input'),
        text: `Task from agent ${caller.sessionId}:\n${task.text}`,
        ...modelSelection }));
      const started = await child.snapshot();
      if (!started.run || started.run.runId === previousChildRunId) throw new Error('agent_child_run_missing');
      task.childRunId = started.run.runId;
      await parent.recordAgentEvents([{ type: 'agent.task.started', sessionId: caller.sessionId, runId,
        payload: { taskId: task.taskId, childRunId: task.childRunId } }]);
      this.track(caller.sessionId, task);
    } catch (error) {
      if (childCreated && childInputSubmitted) {
        try {
          const child = await this.actor(task.agentSessionId);
          const running = await child.snapshot();
          if (running.run && running.run.runId !== previousChildRunId) {
            if (!task.childRunId) {
              task.childRunId = running.run.runId;
              await parent.recordAgentEvents([{ type: 'agent.task.started', sessionId: caller.sessionId, runId,
                payload: { taskId: task.taskId, childRunId: task.childRunId } }]);
            }
            if (!terminal(running.run.status)) accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION,
              type: 'run.cancel', sessionId: child.sessionId, commandId: id('agent-cancel'), runId: running.run.runId }));
            await this.track(caller.sessionId, task).completion;
            if (signal.aborted) signal.throwIfAborted();
            return task;
          }
        } catch (cleanup) {
          // A started child without settlement remains pending. Its journal and lease retain the real failure.
          if (task.childRunId) throw new AggregateError([error, cleanup], 'agent_start_cleanup_failed');
          error = new AggregateError([error, cleanup], 'agent_start_cleanup_failed');
        }
      }
      await parent.recordAgentEvents([{ type: 'agent.task.completed', sessionId: caller.sessionId, runId,
        payload: { taskId: task.taskId, result: { outcome: 'failed', error: errorFact(error) } } },
        ...(capabilities.continuation && !existingChild ? [{ type: 'agent.closed' as const,
          sessionId: caller.sessionId, payload: { agentSessionId: task.agentSessionId } }] : [])]);
      if (signal.aborted) signal.throwIfAborted();
    }
    return task;
  }

  private async send(caller: SessionProjection, runId: string, callId: string, targetId: string, text: string, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    caller = await (await this.actor(caller.sessionId)).snapshot();
    if (targetId === caller.sessionId) throw new Error('agent_message_self');
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await (await this.actor(ownerId)).snapshot();
    const family = await this.family(owner);
    const snapshot = family.find(item => item.sessionId === targetId);
    if (!snapshot) throw new Error('agent_message_target_not_related');
    const relation = family.flatMap(item => item.agentChildren ?? []).find(child => child.agentSessionId === targetId);
    if (relation?.closed) throw new Error('agent_child_closed');
    const target = await this.actor(targetId);
    const targetCapabilities = snapshot.run
      ? await target.agentCapabilities(snapshot.run.runId) : snapshot.agentContext?.capabilities;
    if (snapshot.run && ['running', 'waiting'].includes(snapshot.run.status)) {
      if (!targetCapabilities?.messaging) throw new Error('agent_message_target_unavailable');
      await target.recordAgentEvents([{ type: 'agent.message.received', sessionId: targetId, runId: snapshot.run.runId,
        payload: { sourceSessionId: caller.sessionId, text } }]);
      return { agentId: targetId, delivered: true };
    }
    const managed = await this.family(caller);
    const child = managed.flatMap(item => item.agentChildren ?? []).find(item => item.agentSessionId === targetId && !item.closed);
    if (!child || !child.capabilities.continuation) throw new Error('agent_message_target_not_continuable');
    const task = await this.start(caller, runId, callId, { action: 'spawn', name: child.displayName,
      task: text, delivery: 'async' }, signal, child);
    return { taskId: task.taskId, agentId: targetId };
  }

  private async family(root: SessionProjection): Promise<SessionProjection[]> {
    const result: SessionProjection[] = [];
    const visited = new Set<string>();
    const visit = async (parent: SessionProjection): Promise<void> => {
      if (visited.has(parent.sessionId)) throw new Error('agent_lineage_cycle');
      visited.add(parent.sessionId);
      result.push(parent);
      for (const child of parent.agentChildren ?? []) {
        // A failed creation is an archived task fact, not an existing Session.
        if (child.closed && !(parent.agentTasks ?? []).some(task => task.agentSessionId === child.agentSessionId && task.childRunId)) continue;
        const projection = await (await this.actor(child.agentSessionId)).snapshot();
        if (projection.agentContext?.parentSessionId !== parent.sessionId
          || projection.agentContext.ownerSessionId !== (root.agentContext?.ownerSessionId ?? root.sessionId)) {
          throw new Error('agent_lineage_mismatch');
        }
        await visit(projection);
      }
    };
    await visit(root);
    return result;
  }

  private async close(caller: SessionProjection, targetId: string): Promise<void> {
    const family = await this.family(await (await this.actor(caller.sessionId)).snapshot());
    const parent = family.find(item => item.agentChildren?.some(child => child.agentSessionId === targetId && !child.closed));
    if (!parent) throw new Error('agent_child_not_open');
    const target = family.find(item => item.sessionId === targetId);
    if (!target) throw new Error('agent_child_missing');
    for (const child of target.agentChildren ?? []) {
      if (!child.closed) await this.close(target, child.agentSessionId);
    }
    const owner = await (await this.actor(caller.agentContext?.ownerSessionId ?? caller.sessionId)).snapshot();
    for (const taskOwner of await this.family(owner)) {
      for (const task of taskOwner.agentTasks ?? []) {
        if (task.agentSessionId === targetId && task.status === 'running') await this.cancelTask(taskOwner.sessionId, task);
      }
    }
    const current = await (await this.actor(parent.sessionId)).snapshot();
    if (current.agentChildren?.find(child => child.agentSessionId === targetId)?.closed) return;
    await (await this.actor(parent.sessionId)).recordAgentEvents([{ type: 'agent.closed', sessionId: parent.sessionId,
      payload: { agentSessionId: targetId } }]);
  }

  private track(parentSessionId: string, task: AgentTaskProjection): TaskLease {
    const existing = this.#leases.get(task.taskId);
    if (existing) return existing;
    const lease: TaskLease = { parentSessionId, parentRunId: task.parentRunId, agentSessionId: task.agentSessionId, completion: Promise.resolve() };
    lease.completion = (async () => {
      const child = await this.actor(task.agentSessionId);
      const result = await child.waitForRunResult(task.childRunId!);
      await (await this.actor(parentSessionId)).recordAgentEvents([{ type: 'agent.task.completed', sessionId: parentSessionId,
        runId: task.parentRunId, payload: { taskId: task.taskId, result } }]);
    })();
    this.#leases.set(task.taskId, lease);
    // Preserve rejected promises until their parent drains them; they are never treated as task success.
    void lease.completion.then(() => {
      if (!lease.cancellation && this.#leases.get(task.taskId) === lease) this.#leases.delete(task.taskId);
    }, () => undefined);
    return lease;
  }

  private async wait(sessionId: string, runId: string, ids?: string[], signal?: AbortSignal): Promise<void> {
    const parent = await this.actor(sessionId);
    const tasks = (await parent.snapshot()).agentTasks?.filter(task => task.parentRunId === runId) ?? [];
    if (ids?.some(taskId => !tasks.some(task => task.taskId === taskId))) throw new Error('agent_task_not_owned');
    const pending = tasks.filter(task => task.status === 'running' && (!ids || ids.includes(task.taskId)));
    const leases = pending.map(task => {
      if (!task.childRunId) throw new Error('agent_task_start_incomplete');
      return this.track(sessionId, task).completion;
    });
    await abortable(Promise.all(leases).then(() => undefined), signal);
  }

  private async cancelTask(sessionId: string, task: AgentTaskProjection): Promise<void> {
    if (task.status !== 'running') return;
    if (!task.childRunId) throw new Error('agent_task_start_incomplete');
    const childRunId = task.childRunId;
    const lease = this.track(sessionId, task);
    if (!lease.cancellation) {
      lease.cancellation = (async () => {
        const child = await this.actor(task.agentSessionId);
        const snapshot = await child.snapshot();
        const run = snapshot.run;
        if (!run || run.runId !== childRunId) throw new Error('agent_child_run_mismatch');
        if (!terminal(run.status)) accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION,
          type: 'run.cancel', sessionId: child.sessionId, runId: childRunId, commandId: id('agent-cancel') }));
        await lease.completion;
      })();
      void lease.cancellation.then(() => {
        if (this.#leases.get(task.taskId) === lease) this.#leases.delete(task.taskId);
      }, () => undefined);
    }
    await lease.cancellation;
  }

  async cancelRun(sessionId: string, runId: string): Promise<void> {
    const admission = this.#activeAdmission;
    if (admission?.sessionId === sessionId && admission.runId === runId) {
      await admission.completion.catch(() => undefined);
    }
    const parent = await this.actor(sessionId);
    const tasks = (await parent.snapshot()).agentTasks ?? [];
    const results = await Promise.allSettled(tasks.filter(task => task.parentRunId === runId && task.status === 'running')
      .map(task => this.cancelTask(sessionId, task)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'agent_children_cancel_failed');
  }

  async blockOwner(ownerId: string): Promise<() => void> {
    this.#blockedOwners.set(ownerId, (this.#blockedOwners.get(ownerId) ?? 0) + 1);
    await this.#admissions;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.#blockedOwners.get(ownerId)!;
      if (count === 1) this.#blockedOwners.delete(ownerId);
      else this.#blockedOwners.set(ownerId, count - 1);
    };
  }

  async dispose(): Promise<void> {
    this.#closing = true;
    await this.#admissions;
    const parents = new Map([...this.#leases.values()].map(lease => [lease.parentRunId, lease.parentSessionId]));
    const results = await Promise.allSettled([...parents].map(([runId, sessionId]) => this.cancelRun(sessionId, runId)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'agent_manager_dispose_failed');
  }

  private async admit<T>(sessionId: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const result = this.#admissions.then(async () => {
      if (this.#closing) throw new Error('agent_manager_stopped');
      const completion = operation();
      const active = { sessionId, runId, completion };
      this.#activeAdmission = active;
      try { return await completion; }
      finally { if (this.#activeAdmission === active) this.#activeAdmission = undefined; }
    });
    this.#admissions = result.then(() => undefined, () => undefined);
    return result;
  }
}

function id(kind: string): string { return `${kind}:${crypto.randomUUID()}`; }
function terminal(status: string): boolean { return ['completed', 'failed', 'cancelled', 'indeterminate'].includes(status); }
function accepted(reply: CommandReply): void {
  if (reply.status === 'rejected') throw new LoopFailure(reply.error!.code, reply.error!.message);
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    // The operation already exists: observe its rejection even if cancellation arrived during admission.
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function resolveCapabilities(operation: Extract<AgentOperation, { action: 'spawn' }>, caller: AgentCapabilities,
  allowChildDelegation: boolean): AgentCapabilities {
  const collaboration = operation.preset === 'collaboration';
  const capabilities: AgentCapabilities = {
    messaging: collaboration,
    continuation: collaboration,
    delegation: collaboration && caller.delegation && allowChildDelegation,
    ...operation.capabilities,
  };
  for (const key of ['messaging', 'continuation', 'delegation'] as const) {
    if (capabilities[key] && (!caller[key] || key === 'delegation' && !allowChildDelegation)) {
      throw new Error('agent_capability_not_grantable');
    }
  }
  return capabilities;
}
