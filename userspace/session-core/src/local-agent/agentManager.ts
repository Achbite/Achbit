import { CONVERSATION_COMMAND_VERSION } from '@deepcode/protocol';
import type {
  AgentCapabilities, AgentChildProjection, AgentHostPort, AgentOperation, AgentTaskProjection,
  CommandReply, JsonObject, SessionProjection,
} from '@deepcode/protocol';
import type { SessionActor } from './actor.js';
import type { AgentTaskSummary, AgentLifecycleState } from './agentLifecycle.js';
import { agentOperationDefinitions } from './sessionControls.js';
import { errorFact, LoopFailure } from './loopFailure.js';
import type { ControlWait } from './sessionWake.js';
import { agentPresets, agentPermissions, resolveAgentCapabilities, DEFAULT_AGENT_CONFIGURATION } from './agentConfiguration.js';
import { SessionConfigurationRegistry } from './sessionConfiguration.js';

export interface AgentWait extends ControlWait { taskIds?: string[] }

export interface AgentSessionRuntime {
  execute(runId: string, callId: string, operation: AgentOperation, signal: AbortSignal): Promise<JsonObject>;
  wait(runId: string, signal: AbortSignal, acceptedWait?: AgentWait): Promise<void>;
  cancel(runId: string): Promise<void>;
}

type AgentSnapshot = Awaited<ReturnType<SessionActor['agentSnapshot']>>;
export interface AgentManagementSnapshot extends AgentLifecycleState {
  sessionId: string;
  agentContext?: SessionProjection['agentContext'];
  run: Pick<NonNullable<SessionProjection['run']>, 'runId' | 'status'> | null;
}
export interface AgentSessionAccess {
  withActor<T>(sessionId: string, operation: (actor: SessionActor) => Promise<T>): Promise<T>;
  read(sessionId: string): Promise<AgentManagementSnapshot>;
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
    readonly sessions: AgentSessionAccess,
    readonly configurations = new SessionConfigurationRegistry(),
  ) {}

  forSession(sessionId: string): AgentSessionRuntime {
    return {
      execute: (runId, callId, operation, signal) => this.execute(sessionId, runId, callId, operation, signal),
      wait: (runId, signal, acceptedWait) => this.wait(sessionId, runId, acceptedWait?.taskIds, signal, acceptedWait),
      cancel: runId => this.cancelRun(sessionId, runId),
    };
  }

  async execute(sessionId: string, runId: string, callId: string, operation: AgentOperation, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    if (this.#closing) throw new Error('agent_manager_stopped');
    const caller = await this.snapshot(sessionId);
    if (caller.run?.runId !== runId || caller.run.status !== 'running') throw new Error('agent_caller_run_not_active');
    const capabilities = await this.sessions.withActor(sessionId, actor => actor.agentCapabilities(runId));
    const allowed = operation.action === 'models' || operation.action === 'send' ? capabilities.messaging || capabilities.delegation
      : capabilities.delegation;
    if (!allowed) throw new Error('agent_capability_unavailable');
    switch (operation.action) {
      case 'models': {
        const settings = await abortable(this.host.settings(), signal);
        const presets = agentPresets(settings).map(preset => ({ ...preset,
          capabilities: resolveAgentCapabilities(preset, undefined, capabilities, settings.allowMemberAnalysis) }));
        const fullConfiguration = settings.allowFullConfiguration === true;
        const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
        const owner = await this.snapshot(ownerId);
        const profileIds = [...new Set([settings.profileId || owner.run?.profileId,
          ...presets.map(preset => preset.profileId)].filter((id): id is string => Boolean(id)))];
        const canSpawn = settings.enabled && capabilities.delegation && (!caller.agentContext || settings.allowMemberAnalysis);
        const operations = agentOperationDefinitions(capabilities, { fullConfiguration, canSpawn,
          allowChildDelegation: settings.allowMemberAnalysis,
          presetIds: presets.map(preset => preset.id), ...(!fullConfiguration ? { profileIds } : {}) });
        const models = canSpawn ? (await abortable(this.host.models(), signal))
          .filter(model => fullConfiguration || profileIds.includes(model.profileId)) : [];
        const family = capabilities.messaging === true || capabilities.delegation ? await this.family(owner) : [];
        const managed = new Set((await this.family(caller)).map(item => item.sessionId));
        const contacts = family.flatMap(item => item.agentChildren ?? [])
          .filter(child => child.agentSessionId !== caller.sessionId && !child.closed
            && (managed.has(child.agentSessionId) || capabilities.messaging === true && child.capabilities.messaging === true))
          .map(child => ({ agentId: child.agentSessionId, name: child.displayName,
            status: family.find(item => item.sessionId === child.agentSessionId)?.run?.status ?? 'idle',
            acceptsTasks: child.capabilities.continuation }));
        return { operations,
          ...(caller.agentContext ? { parentAgentId: caller.agentContext.parentSessionId } : {}),
          ...(capabilities.messaging === true || capabilities.delegation ? { agents: contacts } : {}),
          ...(canSpawn ? { models, presets, fullConfiguration,
            defaultProfileId: settings.profileId || owner.run?.profileId,
            configuration: this.configurations.describe(fullConfiguration) } : {}) };
      }
      case 'spawn': {
        const task = await abortable(this.admit(sessionId, runId, () => this.start(caller, runId, callId, operation, signal)), signal);
        // Delivery waits after the Provider completion is committed by the Loop.
        return { taskId: task.taskId, agentId: task.agentSessionId };
      }
      case 'send':
        return await abortable(this.admit(sessionId, runId, () => this.send(caller, runId, callId, operation.agentId, operation.text, signal)), signal);
      case 'wait': {
        const projection = await this.snapshot(sessionId);
        const tasks = (projection.agentTasks ?? []).filter(task => task.parentRunId === runId);
        if (operation.taskIds?.some(taskId => !tasks.some(task => task.taskId === taskId))) throw new Error('agent_task_not_owned');
        return { completedTaskIds: (projection.agentTasks ?? [])
          .filter(task => task.parentRunId === runId && task.status !== 'running' && (!operation.taskIds || operation.taskIds.includes(task.taskId)))
          .map(task => task.taskId) };
      }
      case 'cancel': {
        return await abortable(this.admit(sessionId, runId, async () => {
          signal.throwIfAborted();
          const family = await this.family(await this.snapshot(sessionId));
          const parent = family.find(item => item.agentTasks?.some(task => task.taskId === operation.taskId));
          const task = parent?.agentTasks?.find(item => item.taskId === operation.taskId);
          if (!parent || !task) throw new Error('agent_task_not_owned');
          await this.cancelTask(parent.sessionId, task);
          return { taskId: task.taskId, outcome: (await this.sessions.read(parent.sessionId)).agentTasks
            .find(item => item.taskId === task.taskId)!.status };
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

  private async start(caller: AgentSnapshot, runId: string, callId: string,
    operation: Extract<AgentOperation, { action: 'spawn' }>, signal: AbortSignal,
    existingChild?: AgentChildProjection): Promise<AgentTaskProjection> {
    signal.throwIfAborted();
    caller = await this.snapshot(caller.sessionId);
    const settings = await this.host.settings();
    if (!settings.enabled) throw new Error('agent_disabled');
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await this.snapshot(ownerId);
    const presets = agentPresets(settings);
    const preset = presets.find(item => item.id === (operation.preset ?? 'analysis'));
    if (!preset) throw new Error('agent_preset_unavailable');
    const configuration = !existingChild ? this.configurations.resolve(preset.configuration ?? DEFAULT_AGENT_CONFIGURATION,
      { ...operation.loop, ...(operation.context ? { context: operation.context } : {}) }, settings.allowFullConfiguration === true) : undefined;
    if (!existingChild && !caller.effectivePermissions) throw new Error('agent_parent_permissions_missing');
    const permissions = !existingChild ? agentPermissions(caller.effectivePermissions!, preset.permissions, operation.permissions) : undefined;
    let modelSelection: { profileId: string; reasoningEffortOverride: import('@deepcode/protocol').LlmReasoningEffort | null } | undefined;
    let instanceModel: import('@deepcode/protocol').AgentModelConfiguration | undefined;
    if (!existingChild) {
      const ruleProfileId = preset.profileId || settings.profileId || owner.run?.profileId;
      const followsOwner = !preset.profileId && !settings.profileId && (operation.profileId === undefined || operation.profileId === ruleProfileId);
      if (followsOwner && !owner.run?.profileId) throw new Error('agent_owner_run_model_missing');
      const profileId = operation.profileId ?? ruleProfileId;
      if (!profileId) throw new Error('agent_model_unavailable');
      if (!settings.allowFullConfiguration && (operation.reasoningEffort !== undefined
        || ![ruleProfileId, ...presets.map(item => item.profileId)].includes(profileId))) throw new Error('agent_full_configuration_required');
      const modelRule = profileId === ruleProfileId ? preset : presets.find(item => item.profileId === profileId) ?? preset;
      const model = (await this.host.models()).find(item => item.profileId === profileId);
      if (!model) throw new Error('agent_model_unavailable');
      const reasoningEffortOverride = operation.reasoningEffort ?? modelRule.reasoningEffort ?? (followsOwner
        ? settings.reasoningEffort || owner.run!.reasoningEffort || null
        : (profileId === ruleProfileId ? settings.reasoningEffort : '') || model?.reasoningEffort || null);
      if (model && reasoningEffortOverride && !model.reasoningEfforts.includes(reasoningEffortOverride)) throw new Error('agent_reasoning_effort_unavailable');
      modelSelection = { profileId, reasoningEffortOverride };
      instanceModel = { profileId, model: model.model, reasoningEffort: reasoningEffortOverride,
        thinking: model.thinking ?? null, parameters: structuredClone(model.parameters) };
    }
    const callerCapabilities = await this.sessions.withActor(caller.sessionId, actor => actor.agentCapabilities(runId));
    if (!existingChild && (!callerCapabilities.delegation || caller.agentContext && !settings.allowMemberAnalysis)) {
      throw new Error('agent_delegation_disabled');
    }
    const capabilities = existingChild?.capabilities ?? resolveAgentCapabilities(preset, operation.capabilities, callerCapabilities, settings.allowMemberAnalysis);
    if (existingChild && (!existingChild.capabilities.continuation || existingChild.closed)) throw new Error('agent_child_not_continuable');
    if ((caller.agentTasks ?? []).filter(task => task.parentRunId === runId).length >= settings.maxCallsPerRun) throw new Error('agent_run_call_limit');
    const family = await this.family(owner);
    if (family.flatMap(item => item.agentTasks ?? []).filter(task => task.status === 'running').length >= settings.maxConcurrent) throw new Error('agent_concurrency_limit');
    if (!existingChild
      && family.flatMap(item => item.agentChildren ?? []).filter(child => !child.closed).length
        >= settings.maxMembersPerSession) throw new Error('agent_continuation_limit');

    const task: AgentTaskProjection = {
      taskId: id('agent-task'), agentSessionId: existingChild?.agentSessionId ?? id('session'),
      capabilities,
      displayName: existingChild?.displayName ?? operation.name, text: operation.task,
      delivery: operation.delivery, parentRunId: runId, status: 'running',
    };
    await this.sessions.withActor(caller.sessionId, parent => parent.recordAgentEvents([{ type: 'agent.task.created', sessionId: caller.sessionId, runId, callId,
      payload: { taskId: task.taskId, agentSessionId: task.agentSessionId, capabilities, createsAgent: !existingChild,
        displayName: task.displayName, text: task.text, delivery: task.delivery } }]));
    let childCreated = Boolean(existingChild);
    let previousChildRunId: string | undefined;
    let childInputSubmitted = false;
    try {
      if (!existingChild) {
        await this.host.createSession({ sessionId: task.agentSessionId, displayTitle: task.displayName,
          workspaceBindings: caller.run!.workspaceBindings, profileId: modelSelection!.profileId,
          agentContext: { capabilities, configuration, model: instanceModel, ownerSessionId: ownerId, parentSessionId: caller.sessionId,
            parentRunId: runId, parentCallId: callId } });
        childCreated = true;
      }
      await this.sessions.withActor(task.agentSessionId, async child => {
        signal.throwIfAborted();
        previousChildRunId = (await child.agentSnapshot()).run?.runId;
        if (!existingChild) {
          accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.permissions.set',
            sessionId: task.agentSessionId, commandId: id('agent-permissions'), patches: permissions! }));
        }
        signal.throwIfAborted();
        childInputSubmitted = true;
        accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'message.submit',
          sessionId: task.agentSessionId, commandId: id('agent-input'),
          text: `Task from agent ${caller.sessionId}:\n${task.text}`,
          ...modelSelection }, async childRunId => {
            await this.sessions.withActor(caller.sessionId, parent => parent.recordAgentEvents([{ type: 'agent.task.started', sessionId: caller.sessionId, runId,
              payload: { taskId: task.taskId, childRunId } }]));
            task.childRunId = childRunId;
          }));
        const started = await child.agentSnapshot();
        if (!started.run || started.run.runId === previousChildRunId) throw new Error('agent_child_run_missing');
        if (task.childRunId !== started.run.runId) throw new Error('agent_task_start_identity_mismatch');
        this.track(caller.sessionId, task);
      });
    } catch (error) {
      if (childCreated && childInputSubmitted) {
        try {
          const cleaned = await this.sessions.withActor(task.agentSessionId, async child => {
            const running = await child.agentSnapshot();
            if (running.run && running.run.runId !== previousChildRunId) {
              if (!task.childRunId) {
                task.childRunId = running.run.runId;
                await this.sessions.withActor(caller.sessionId, parent => parent.recordAgentEvents([{ type: 'agent.task.started', sessionId: caller.sessionId, runId,
                  payload: { taskId: task.taskId, childRunId: task.childRunId! } }]));
              }
              if (!terminal(running.run.status)) accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION,
                type: 'run.cancel', sessionId: child.sessionId, commandId: id('agent-cancel'), runId: running.run.runId }));
              await this.track(caller.sessionId, task).completion;
              return true;
            }
            return false;
          });
          if (cleaned) { signal.throwIfAborted(); return task; }
        } catch (cleanup) {
          // A started child without settlement remains pending. Its journal and lease retain the real failure.
          if (task.childRunId) throw new AggregateError([error, cleanup], 'agent_start_cleanup_failed');
          error = new AggregateError([error, cleanup], 'agent_start_cleanup_failed');
        }
      }
      await this.sessions.withActor(caller.sessionId, parent => parent.recordAgentEvents([{ type: 'agent.task.completed', sessionId: caller.sessionId, runId,
        payload: { taskId: task.taskId, result: { outcome: 'failed', error: errorFact(error) } } },
        ...(!existingChild ? [{ type: 'agent.closed' as const,
          sessionId: caller.sessionId, payload: { agentSessionId: task.agentSessionId } }] : [])]));
      if (signal.aborted) signal.throwIfAborted();
    }
    return task;
  }

  private async send(caller: AgentSnapshot, runId: string, callId: string, targetId: string, text: string, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    caller = await this.snapshot(caller.sessionId);
    if (targetId === caller.sessionId) throw new Error('agent_message_self');
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await this.snapshot(ownerId);
    const family = await this.family(owner);
    const snapshot = family.find(item => item.sessionId === targetId);
    if (!snapshot) throw new Error('agent_message_target_not_related');
    const managesTarget = (await this.family(caller)).some(item => item.sessionId === targetId);
    const callerCapabilities = await this.sessions.withActor(caller.sessionId, actor => actor.agentCapabilities(runId));
    if (!managesTarget && !callerCapabilities.messaging) throw new Error('agent_messaging_disabled');
    if (!managesTarget && callerCapabilities.messaging === 'parent' && caller.agentContext?.parentSessionId !== targetId) {
      throw new Error('agent_message_target_not_parent');
    }
    if (!managesTarget && snapshot.agentContext?.capabilities.messaging === 'parent' && snapshot.agentContext.parentSessionId !== caller.sessionId) {
      throw new Error('agent_message_source_not_parent');
    }
    if (!managesTarget && snapshot.agentContext?.capabilities.messaging === false) throw new Error('agent_message_target_unavailable');
    const relation = family.flatMap(item => item.agentChildren ?? []).find(child => child.agentSessionId === targetId);
    if (relation?.closed) throw new Error('agent_child_closed');
    if (snapshot.run && ['running', 'waiting'].includes(snapshot.run.status)) {
      const targetRunId = snapshot.run.runId;
      await this.sessions.withActor(targetId, async target => {
        if (!managesTarget && !(await target.agentCapabilities(targetRunId)).messaging) throw new Error('agent_message_target_unavailable');
        await target.recordAgentEvents([{ type: 'agent.message.received', sessionId: targetId, runId: targetRunId,
          payload: { sourceSessionId: caller.sessionId, text } }]);
      });
      return { agentId: targetId, delivered: true };
    }
    const child = relation;
    if (!child || !child.capabilities.continuation) throw new Error('agent_message_target_not_continuable');
    const task = await this.start(caller, runId, callId, { action: 'spawn', name: child.displayName,
      task: text, delivery: 'async' }, signal, child);
    return { taskId: task.taskId, agentId: targetId };
  }

  private async family(root: AgentManagementSnapshot | AgentSnapshot): Promise<AgentManagementSnapshot[]> {
    const result: AgentManagementSnapshot[] = [];
    const visited = new Set<string>();
    const visit = async (parent: AgentManagementSnapshot | AgentSnapshot): Promise<void> => {
      if (visited.has(parent.sessionId)) throw new Error('agent_lineage_cycle');
      visited.add(parent.sessionId);
      result.push({ ...parent, agentTasks: parent.agentTasks ?? [], agentChildren: parent.agentChildren ?? [] });
      for (const child of parent.agentChildren ?? []) {
        // A failed creation is an archived task fact, not an existing Session.
        if (child.closed && !(parent.agentTasks ?? []).some(task => task.agentSessionId === child.agentSessionId && task.childRunId)) continue;
        const projection = await this.sessions.read(child.agentSessionId);
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

  private async close(caller: AgentManagementSnapshot | AgentSnapshot, targetId: string): Promise<void> {
    const family = await this.family(await this.sessions.read(caller.sessionId));
    const parent = family.find(item => item.agentChildren?.some(child => child.agentSessionId === targetId && !child.closed));
    if (!parent) throw new Error('agent_child_not_open');
    const target = family.find(item => item.sessionId === targetId);
    if (!target) throw new Error('agent_child_missing');
    for (const child of target.agentChildren ?? []) {
      if (!child.closed) await this.close(target, child.agentSessionId);
    }
    const owner = await this.sessions.read(caller.agentContext?.ownerSessionId ?? caller.sessionId);
    for (const taskOwner of await this.family(owner)) {
      for (const task of taskOwner.agentTasks ?? []) {
        if (task.agentSessionId === targetId && task.status === 'running') await this.cancelTask(taskOwner.sessionId, task);
      }
    }
    const current = await this.sessions.read(parent.sessionId);
    if (current.agentChildren?.find(child => child.agentSessionId === targetId)?.closed) return;
    await this.sessions.withActor(parent.sessionId, actor => actor.recordAgentEvents([{ type: 'agent.closed', sessionId: parent.sessionId,
      payload: { agentSessionId: targetId } }]));
  }

  private track(parentSessionId: string, task: AgentTaskSummary): TaskLease {
    const existing = this.#leases.get(task.taskId);
    if (existing) return existing;
    const lease: TaskLease = { parentSessionId, parentRunId: task.parentRunId, agentSessionId: task.agentSessionId, completion: Promise.resolve() };
    lease.completion = this.sessions.withActor(task.agentSessionId, async child => {
      const result = await child.waitForRunResult(task.childRunId!);
      await this.sessions.withActor(parentSessionId, parent => parent.recordAgentEvents([
        { type: 'agent.task.completed', sessionId: parentSessionId,
          runId: task.parentRunId, payload: { taskId: task.taskId, result } },
      ]));
    });
    this.#leases.set(task.taskId, lease);
    // Preserve rejected promises until their parent drains them; they are never treated as task success.
    void lease.completion.then(() => {
      if (!lease.cancellation && this.#leases.get(task.taskId) === lease) this.#leases.delete(task.taskId);
    }, () => undefined);
    return lease;
  }

  private async wait(sessionId: string, runId: string, ids?: string[], signal?: AbortSignal, acceptedWait?: ControlWait): Promise<void> {
    const tasks = (await this.sessions.read(sessionId)).agentTasks?.filter(task => task.parentRunId === runId) ?? [];
    if (ids?.some(taskId => !tasks.some(task => task.taskId === taskId))) throw new Error('agent_task_not_owned');
    const pending = tasks.filter(task => (task.status === 'running' || this.#leases.has(task.taskId)) && (!ids || ids.includes(task.taskId)));
    const leases = pending.map(task => {
      if (!task.childRunId) throw new Error('agent_task_start_incomplete');
      return this.track(sessionId, task).completion;
    });
    if (!pending.length) return;
    // Waiting for tasks must also admit a child's question or an independent reminder.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const input = this.sessions.withActor(sessionId, actor => actor.waitForInput(runId, controller.signal, undefined,
      snapshot => pending.every(task => snapshot.state.agentTasks.find(item => item.taskId === task.taskId)?.status !== 'running'), acceptedWait));
    try { await Promise.race([abortable(Promise.all(leases).then(() => undefined), controller.signal), input]); }
    finally {
      controller.abort();
      signal?.removeEventListener('abort', onAbort);
      await input.catch(() => undefined);
    }
  }

  private async cancelTask(sessionId: string, task: AgentTaskSummary): Promise<void> {
    if (task.status !== 'running') { await this.#leases.get(task.taskId)?.completion; return; }
    if (!task.childRunId) throw new Error('agent_task_start_incomplete');
    const childRunId = task.childRunId;
    const lease = this.track(sessionId, task);
    if (!lease.cancellation) {
      lease.cancellation = this.sessions.withActor(task.agentSessionId, async child => {
        const snapshot = await child.agentSnapshot();
        const run = snapshot.run;
        if (!run || run.runId !== childRunId) throw new Error('agent_child_run_mismatch');
        if (!terminal(run.status)) accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION,
          type: 'run.cancel', sessionId: child.sessionId, runId: childRunId, commandId: id('agent-cancel') }));
        await lease.completion;
      });
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
    const tasks = (await this.sessions.read(sessionId)).agentTasks ?? [];
    const results = await Promise.allSettled(tasks.filter(task => task.parentRunId === runId && (task.status === 'running' || this.#leases.has(task.taskId)))
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

  private snapshot(sessionId: string): Promise<AgentSnapshot> {
    return this.sessions.withActor(sessionId, actor => actor.agentSnapshot());
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
