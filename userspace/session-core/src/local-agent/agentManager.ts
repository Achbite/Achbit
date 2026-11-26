import { CONVERSATION_COMMAND_VERSION, inheritAgentRecipe } from '@achbit/protocol';
import type {
  AgentChildProjection, AgentHostPort, AgentOperation, AgentTaskProjection,
  CommandReply, JsonObject, SessionProjection,
} from '@achbit/protocol';
import type { SessionActor } from './actor.js';
import type { AgentTaskSummary, AgentLifecycleState } from './agentLifecycle.js';
import { agentOperationDefinitions } from './sessionControls.js';
import { capacityInputId, capacityNeeds, CapacityNeeded, CapacityStartUnknown, coversCapacity, delegatedCapacity,
  type CapacityGrant, type CapacityQuote, type CapacityReservation } from './agentCapacity.js';
import { errorFact, LoopFailure } from './loopFailure.js';
import type { ControlWait } from './sessionWake.js';
import { agentPresets, helperPresets, type AgentPreset, agentPermissionPatches, allowedAgentProfiles, canSpawnAgent, resolveAgentCapabilities } from './agentConfiguration.js';
import { SessionConfigurationRegistry } from './sessionConfiguration.js';
import { AgentLoopRegistry } from './loopRegistry.js';

export interface AgentWait extends ControlWait { taskIds?: string[] }

export interface AgentSessionRuntime {
  execute(runId: string, callId: string, operation: AgentOperation, signal: AbortSignal, grant?: CapacityGrant): Promise<JsonObject>;
  wait(runId: string, signal: AbortSignal, acceptedWait?: AgentWait): Promise<void>;
  reconcileCapacityStart(reservation: CapacityReservation): Promise<string | null>;
  capacityEvidence(quote: CapacityQuote): Promise<readonly {content:string}[]>;
  /** Restore result delivery, without joining children or changing an inbox wait's wake conditions. */
  reattach(runId: string, tasks: readonly AgentTaskSummary[]): void;
  cancel(runId: string, owner?: SessionActor): Promise<void>;
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
  readCapacityStart(reservation: CapacityReservation): Promise<string | null>;
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
    readonly loops = new AgentLoopRegistry(),
  ) {}

  forSession(sessionId: string): AgentSessionRuntime {
    return {
      execute: (runId, callId, operation, signal, grant) => this.execute(sessionId, runId, callId, operation, signal, grant),
      wait: (runId, signal, acceptedWait) => this.wait(sessionId, runId, acceptedWait?.taskIds, signal, acceptedWait),
      reattach: (runId, tasks) => {
        for (const task of tasks) {
          if (task.parentRunId === runId && task.status === 'running' && task.childRunId) this.track(sessionId, task);
        }
      },
      cancel: (runId, owner) => this.cancelRun(sessionId, runId, owner),
      reconcileCapacityStart: reservation => this.admit(sessionId, reservation.runId, () => {
        if (reservation.sessionId !== sessionId) throw new Error('agent_capacity_owner_mismatch');
        return this.reconcileCapacityStart(reservation);
      }),
      capacityEvidence: async quote => {
        const caller = await this.snapshot(sessionId);
        if ((caller.agentContext?.ownerSessionId ?? sessionId) !== quote.ownerSessionId) throw new Error('agent_capacity_owner_mismatch');
        const owner = await this.snapshot(quote.ownerSessionId);
        if (!delegatedCapacity(owner.permissions)) throw new LoopFailure('capacity_review_policy_changed','The coordinator no longer delegates budget review.');
        return this.sessions.withActor(quote.ownerSessionId, actor => actor.capacityEvidence(quote.ownerRunId));
      },
    };
  }

  async execute(sessionId: string, runId: string, callId: string, operation: AgentOperation, signal: AbortSignal, grant?: CapacityGrant): Promise<JsonObject> {
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
        if (!caller.subagentSettings) throw new Error('agent_settings_missing');
        const settings = caller.subagentSettings;
        const menu = caller.agentContext?.helpers;
        const templates = agentPresets(settings);
        const used = (id: string) => (caller.agentTasks ?? []).filter(t => t.parentRunId === runId && t.helperId === id).length;
        const presets = (menu ? helperPresets(templates, menu.filter(s => used(s.id) < s.maxCalls)) : templates).map(preset => ({ ...preset,
          ...(menu ? { remainingCalls:menu.find(s => s.id === preset.id)!.maxCalls - used(preset.id) } : {}),
          capabilities: resolveAgentCapabilities(preset, undefined, capabilities, settings.allowMemberAnalysis) }));
        const fullConfiguration = !caller.agentContext && settings.allowFullConfiguration === true;
        const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
        const owner = await this.snapshot(ownerId);
        const defaultProfileId = settings.profileId || owner.run?.profileId;
        const profileIds = menu ? [...new Set(presets.map(p => p.profileId || defaultProfileId).filter((id): id is string => Boolean(id)))]
          : allowedAgentProfiles(settings, presets, owner.run?.profileId);
        const canSpawn = canSpawnAgent(settings, capabilities, !!caller.agentContext) && presets.length > 0;
        const operations = agentOperationDefinitions(capabilities, { fullConfiguration, helperMenu:menu !== undefined, canSpawn, coordinator: !caller.agentContext,
          allowChildDelegation: settings.allowMemberAnalysis,
          presetIds: presets.map(preset => preset.id), productComponentIds: this.configurations.productComponents().map(item => item.id as string),
          ...(!fullConfiguration ? { profileIds } : {}) });
        const models = canSpawn ? (await abortable(this.host.models(), signal))
          .filter(model => fullConfiguration || profileIds.includes(model.profileId)) : [];
        const family = await this.family(owner);
        const managed = activeTaskSessions(family, caller.sessionId, runId);
        const parentId = caller.agentContext ? taskOwner(family, caller.sessionId, runId).sessionId : undefined;
        const contacts = family.flatMap(item => item.agentChildren ?? [])
          .filter(child => {
            const target = family.find(item => item.sessionId === child.agentSessionId);
            return child.agentSessionId !== caller.sessionId && !child.closed && target
              && !contactError(caller,capabilities,target,managed,parentId,owner.run?.runId);
          })
          .map(child => {
            const target = family.find(item => item.sessionId === child.agentSessionId);
            const active = target?.run && ['running', 'waiting'].includes(target.run.status);
            return { agentId: child.agentSessionId, name: child.displayName,
              status: target?.run?.status ?? 'idle', acceptsMessages: Boolean(active),
              acceptsTasks: !caller.agentContext && canSpawn && child.capabilities.continuation && (!target?.run || terminal(target.run.status)) };
          });
        return { operations, coordinatorAgentId: ownerId,
          capacity: {
            concurrentTasks: { used: family.flatMap(item => item.agentTasks ?? []).filter(task => task.status === 'running').length, limit: settings.maxConcurrent },
            openMembers: { used: family.flatMap(item => item.agentChildren ?? []).filter(child => !child.closed).length, limit: settings.maxMembersPerSession },
            callsThisRun: { used: (caller.agentTasks ?? []).filter(task => task.parentRunId === runId).length, limit: settings.maxCallsPerRun },
          },
          ...(parentId ? { parentAgentId: parentId } : {}),
          ...(capabilities.messaging === true || capabilities.delegation ? { agents: contacts } : {}),
          ...(canSpawn ? { models, presets, fullConfiguration,
            ...(menu ? {} : {defaultProfileId}),
            ...(fullConfiguration ? { workspaces: caller.run.workspaceBindings, runners: this.loops.describe(), productComponents: this.configurations.productComponents(),
            permissionPolicies: [
              { id: 'local-standard', description: 'Keep Kernel admission and automatic Plan/file gates. Parameters can only restrict the inherited policy.',
                parametersSchema: { type: 'object', additionalProperties: false, properties: {
                  allowHostExecution: { type: 'boolean' }, allowExternalTools: { type: 'boolean' } } } },
              { id: 'workspace-only', description: 'Deny Host processes and external tools; file tools still pass Kernel admission.',
                parametersSchema: { type: 'object', additionalProperties: false, properties: {} } },
            ],
            workspaceSandbox: { defaultBackendId: 'platform-default',
              observed: caller.environment?.workspaceSandbox ?? null,
              description: 'Select platform-default or the observed backend. Shell isolation never grants file mutation authority. Unavailable isolation fails closed.' },
            configuration: this.configurations.describe(fullConfiguration) } : {}) } : {}) };
      }
      case 'spawn': {
        const task = await abortable(this.admit(sessionId, runId, () => this.start(caller, runId, callId, operation, signal, undefined, grant)), signal);
        // Delivery waits after the Provider completion is committed by the Loop.
        return { taskId: task.taskId, agentId: task.agentSessionId };
      }
      case 'send': {
        let writing = false;
        const beforeWrite = () => { signal.throwIfAborted(); writing = true; };
        try {
          return await abortable(this.send(caller, runId, operation.agentId, operation.text, signal, beforeWrite), signal);
        } catch (error) {
          if (!writing) throw error;
          return { agentId: operation.agentId, status: 'indeterminate', error: errorFact(error) };
        }
      }
      case 'compact': {
        const ownerId = caller.agentContext?.ownerSessionId ?? sessionId;
        const family = await this.family(await this.snapshot(ownerId));
        const managed = activeTaskSessions(family, sessionId, runId);
        const child = family.flatMap(item => item.agentChildren).find(item => item.agentSessionId === operation.agentId && !item.closed);
        if (!child || child.agentSessionId === sessionId
          || caller.agentContext && !managed.has(child.agentSessionId)) throw new Error('agent_child_not_owned');
        return await abortable(this.sessions.withActor(child.agentSessionId, async actor => ({ agentId: child.agentSessionId,
          ...await actor.requestContextCompaction(sessionId, operation.focus) })), signal);
      }
      case 'assign': {
        if (caller.agentContext) throw new Error('agent_coordinator_required');
        return await abortable(this.admit(sessionId, runId, async () => {
          signal.throwIfAborted();
          const family = await this.family(await this.snapshot(sessionId));
          const child = family.flatMap(item => item.agentChildren).find(item => item.agentSessionId === operation.agentId && !item.closed);
          if (!child) throw new Error('agent_child_not_open');
          const target = family.find(item => item.sessionId === operation.agentId);
          if (!target || target.run && !terminal(target.run.status)) throw new Error('agent_child_not_idle');
          const task = await this.start(caller, runId, callId, { action: 'spawn', name: child.displayName,
            task: operation.task, delivery: 'async', requestCapacity: operation.requestCapacity }, signal, child, grant);
          return { taskId: task.taskId, agentId: task.agentSessionId };
        }), signal);
      }
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
          const ownerId = caller.agentContext?.ownerSessionId ?? sessionId;
          const family = await this.family(await this.snapshot(ownerId));
          const managed = activeTaskSessions(family, sessionId, runId);
          const parent = family.find(item => managed.has(item.sessionId)
            && item.agentTasks.some(task => task.taskId === operation.taskId && task.parentRunId === item.run?.runId));
          const task = parent?.agentTasks.find(item => item.taskId === operation.taskId);
          if (!parent || !task || task.agentSessionId === sessionId) throw new Error('agent_task_not_owned');
          await this.cancelTask(parent.sessionId, task);
          return { taskId: task.taskId, outcome: (await this.sessions.read(parent.sessionId)).agentTasks
            .find(item => item.taskId === task.taskId)!.status };
        }), signal);
      }
      case 'close':
        if (caller.agentContext) throw new Error('agent_coordinator_required');
        return await abortable(this.admit(sessionId, runId, async () => {
          signal.throwIfAborted();
          await this.close(caller, operation.agentId);
          return { agentId: operation.agentId, closed: true };
        }), signal);
    }
  }

  private async start(caller: AgentSnapshot, runId: string, callId: string,
    operation: Extract<AgentOperation, { action: 'spawn' }>, signal: AbortSignal,
    existingChild?: AgentChildProjection, grant?: CapacityGrant): Promise<AgentTaskProjection> {
    signal.throwIfAborted();
    caller = await this.snapshot(caller.sessionId);
    if (caller.run?.runId !== runId || caller.run.status !== 'running') throw new Error('agent_caller_run_not_active');
    if (!caller.subagentSettings) throw new Error('agent_settings_missing');
    const settings = caller.subagentSettings;
    if (!settings.enabled) throw new Error('agent_disabled');
    const customConfiguration = [operation.capabilities, operation.permissions, operation.runner,
      operation.permissionPolicy, operation.workspaceSandbox, operation.tools, operation.productComponents,
      operation.context, operation.loop, operation.reasoningEffort, operation.peerGroup, operation.helpers, operation.fileScope].some(value => value !== undefined) || operation.preset === null;
    if (!existingChild && customConfiguration) {
      if (caller.agentContext) throw new Error('agent_coordinator_configuration_required');
      if (!settings.allowFullConfiguration) throw new Error('agent_full_configuration_required');
    }
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await this.snapshot(ownerId);
    const templates = agentPresets(settings);
    const menu = caller.agentContext?.helpers;
    const presets = menu ? helperPresets(templates, menu) : templates;
    const selectedId = operation.preset ?? (menu ? undefined : 'analysis');
    const entry = menu?.find(spec => spec.id === selectedId);
    if (menu && !entry) throw new Error('agent_helper_not_allowed');
    if (entry && (caller.agentTasks ?? []).filter(task => task.parentRunId === runId && task.helperId === entry.id).length >= entry.maxCalls) throw new Error('agent_helper_call_limit');
    const preset: AgentPreset | undefined = operation.preset === null
      ? {id:'', name:operation.name, capabilities:{messaging:'parent',continuation:true,delegation:false}}
      : presets.find(item => item.id === selectedId);
    if (!preset) throw new Error('agent_preset_unavailable');
    const helpers = entry ? entry.helpers ?? [] : operation.helpers;
    if (helpers) {
      const checkMenu = (tree: NonNullable<typeof helpers>) => { helperPresets(templates,tree); for (const h of tree) if (h.helpers) checkMenu(h.helpers); };
      checkMenu(helpers);
      if (helpers.length && (!settings.allowMemberAnalysis || operation.capabilities?.delegation === false)) throw new Error('agent_capability_not_grantable');
    }
    const inheritedConfiguration = !existingChild
      ? await this.sessions.withActor(caller.sessionId, actor => actor.contextConfiguration(runId)) : undefined;
    const configuration = !existingChild ? this.configurations.resolve(
      this.configurations.resolve(inheritedConfiguration, preset.configuration ?? {}, true),
      { ...operation.loop, ...(operation.context ? { context: operation.context } : {}) }, settings.allowFullConfiguration === true) : undefined;
    const permissions = !existingChild ? agentPermissionPatches(preset.permissions, operation.permissions) : undefined;
    let modelSelection: { profileId: string; reasoningEffortOverride: import('@achbit/protocol').LlmReasoningEffort | null } | undefined;
    let instanceModel: import('@achbit/protocol').AgentModelConfiguration | undefined;
    if (!existingChild) {
      const ruleProfileId = preset.profileId || settings.profileId || owner.run?.profileId;
      const followsOwner = !preset.profileId && !settings.profileId && (operation.profileId === undefined || operation.profileId === ruleProfileId);
      if (followsOwner && !owner.run?.profileId) throw new Error('agent_owner_run_model_missing');
      if (entry && operation.profileId !== undefined) throw new Error('agent_helper_profile_not_allowed');
      const profileId = operation.profileId ?? ruleProfileId;
      if (!profileId) throw new Error('agent_model_unavailable');
      if ((caller.agentContext || !settings.allowFullConfiguration) && (operation.reasoningEffort !== undefined
        || !allowedAgentProfiles(settings, presets, owner.run?.profileId).includes(profileId))) throw new Error('agent_full_configuration_required');
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
    const recipe = !existingChild ? inheritAgentRecipe(caller.recipe, {
      configuration, runner: this.loops.validate(operation.runner ?? preset.runner ?? caller.recipe?.runner),
      tools: operation.tools ?? preset.tools, fileScope:operation.fileScope ?? preset.fileScope,
      productComponents: operation.productComponents ?? preset.productComponents,
      permissionPolicy: operation.permissionPolicy ?? preset.permissionPolicy,
      workspaceSandbox: operation.workspaceSandbox ?? preset.workspaceSandbox,
      profileId: modelSelection!.profileId, ...(modelSelection!.reasoningEffortOverride ? { reasoningEffort: modelSelection!.reasoningEffortOverride } : {}),
      permissions,
    }) : undefined;
    const callerCapabilities = await this.sessions.withActor(caller.sessionId, actor => actor.agentCapabilities(runId));
    if (!existingChild && !canSpawnAgent(settings, callerCapabilities, !!caller.agentContext)) {
      throw new Error('agent_delegation_disabled');
    }
    const capabilities = existingChild?.capabilities ?? resolveAgentCapabilities(preset,
      {...operation.capabilities, ...(helpers ? {delegation:helpers.length > 0} : {})}, callerCapabilities, settings.allowMemberAnalysis);
    if (operation.peerGroup && capabilities.messaging !== true) throw new Error('agent_peer_group_requires_team_messaging');
    if (operation.capabilities?.delegation === true && helpers?.length === 0) throw new Error('agent_helper_menu_empty');
    if (recipe?.fileScope && !caller.run.workspaceBindings.some(b => b.workspaceId === recipe.fileScope!.workspaceId)) throw new Error('agent_file_scope_workspace_unavailable');
    if (existingChild && (!existingChild.capabilities.continuation || existingChild.closed)) throw new Error('agent_child_not_continuable');
    const family = await this.family(owner);
    const needs = capacityNeeds({
      callsThisRun: [(caller.agentTasks ?? []).filter(task => task.parentRunId === runId).length, settings.maxCallsPerRun, 1],
      concurrentTasks: [family.flatMap(item => item.agentTasks ?? []).filter(task => task.status === 'running').length, settings.maxConcurrent, 1],
      openMembers: [family.flatMap(item => item.agentChildren ?? []).filter(child => !child.closed).length, settings.maxMembersPerSession, existingChild ? 0 : 1],
    });
    const quote = { ownerSessionId: ownerId, ownerRunId: owner.run?.runId ?? '', needs };
    if (grant) {
      if (!operation.requestCapacity || grant.sessionId !== caller.sessionId || grant.runId !== runId || grant.callId !== callId
        || !owner.run || !['running', 'waiting'].includes(owner.run.status) || !coversCapacity(grant.quote, quote)
        || grant.source === 'agent' && !(delegatedCapacity(owner.permissions) && delegatedCapacity(caller.permissions))) {
        throw new LoopFailure('agent_capacity_scope_changed', 'The approved envelope no longer covers this dispatch. No new task was started.');
      }
    } else if (needs.length) {
      if (operation.requestCapacity && owner.run && ['running', 'waiting'].includes(owner.run.status)) {
        throw new CapacityNeeded(quote, delegatedCapacity(owner.permissions) && delegatedCapacity(caller.permissions));
      }
      const code = { callsThisRun:'agent_run_call_limit', concurrentTasks:'agent_concurrency_limit', openMembers:'agent_continuation_limit' }[needs[0]!.resource];
      const usage = needs.map(n => `${n.resource} ${n.used}/${n.limit}`).join('; ');
      throw new LoopFailure(code, code, { source: 'session', phase: 'agentAdmission', category: 'capacity', retryable: false,
        causes: [{ kind: 'subagentCapacity', message: `${usage}. No task started. Supply requestCapacity with a reason to request review for this dispatch.` }] });
    }
    signal.throwIfAborted();

    const task: AgentTaskProjection = {
      taskId: id('agent-task'), agentSessionId: existingChild?.agentSessionId ?? id('session'),
      capabilities, ...(entry ? {helperId:entry.id} : {}),
      displayName: existingChild?.displayName ?? operation.name, text: operation.task,
      delivery: operation.delivery, parentRunId: runId, status: 'running',
    };
    await this.sessions.withActor(caller.sessionId, parent => parent.recordAgentEvents([{ type: 'agent.task.created', sessionId: caller.sessionId, runId, callId,
      payload: { taskId: task.taskId, agentSessionId: task.agentSessionId, capabilities, createsAgent: !existingChild, ...(entry ? {helperId:entry.id} : {}),
        displayName: task.displayName, text: task.text, delivery: task.delivery } }]));
    let childCreated = Boolean(existingChild);
    let previousChildRunId: string | undefined;
    let childInputSubmitted = false;
    try {
      if (!existingChild) {
        await this.host.createSession({ sessionId: task.agentSessionId, displayTitle: task.displayName,
          subagentSettings: structuredClone(settings),
          workspaceBindings: caller.run!.workspaceBindings, profileId: modelSelection!.profileId, recipe,
          agentContext: { capabilities, model: instanceModel, ...(operation.peerGroup ? {peerGroup:operation.peerGroup} : {}),
            ...(helpers ? {helpers:structuredClone(helpers)} : {}), ownerSessionId: ownerId, parentSessionId: caller.sessionId,
            parentRunId: runId, parentCallId: callId } });
        childCreated = true;
      }
      await this.sessions.withActor(task.agentSessionId, async child => {
        signal.throwIfAborted();
        previousChildRunId = (await child.agentSnapshot()).run?.runId;
        signal.throwIfAborted();
        childInputSubmitted = true;
        accepted(await child.submit({ schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'message.submit',
          sessionId: task.agentSessionId, commandId: grant ? capacityInputId(task.taskId) : id('agent-input'),
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
          if (grant && !task.childRunId) throw new CapacityStartUnknown(task.taskId, cleanup);
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

  private async send(caller: AgentSnapshot, runId: string, targetId: string, text: string, signal: AbortSignal, beforeWrite: () => void): Promise<JsonObject> {
    signal.throwIfAborted();
    caller = await this.snapshot(caller.sessionId);
    if (targetId === caller.sessionId) throw new Error('agent_message_self');
    const ownerId = caller.agentContext?.ownerSessionId ?? caller.sessionId;
    if (this.#blockedOwners.has(ownerId)) throw new Error('agent_owner_deleting');
    const owner = await this.snapshot(ownerId);
    const family = await this.family(owner);
    const snapshot = family.find(item => item.sessionId === targetId);
    if (!snapshot) throw new Error('agent_message_target_not_related');
    if (caller.run?.runId !== runId || caller.run.status !== 'running') throw new Error('agent_caller_run_not_active');
    const managed = activeTaskSessions(family, caller.sessionId, runId);
    const managesTarget = !caller.agentContext || managed.has(targetId);
    const parentId = caller.agentContext ? taskOwner(family,caller.sessionId,runId).sessionId : undefined;
    const callerCapabilities = await this.sessions.withActor(caller.sessionId, actor => actor.agentCapabilities(runId));
    const denied = contactError(caller,callerCapabilities,snapshot,managed,parentId,owner.run?.runId);
    if (denied) throw new Error(denied);
    const relation = family.flatMap(item => item.agentChildren ?? []).find(child => child.agentSessionId === targetId);
    if (relation?.closed) throw new Error('agent_child_closed');
    if (snapshot.run && ['running', 'waiting'].includes(snapshot.run.status)) {
      const targetRunId = snapshot.run.runId;
      await this.sessions.withActor(targetId, async target => {
        signal.throwIfAborted();
        if (!managesTarget && !(await target.agentCapabilities(targetRunId)).messaging) throw new Error('agent_message_target_unavailable');
        await target.recordAgentEvents([{ type: 'agent.message.received', sessionId: targetId, runId: targetRunId,
          payload: { sourceSessionId: caller.sessionId, text } }], beforeWrite);
      });
      return { agentId: targetId, delivered: true };
    }
    throw new LoopFailure('agent_message_target_inactive', 'The target has no active task to receive this message. The owner can use assign to start a follow-up task.');
  }

  private async family(root: AgentManagementSnapshot | AgentSnapshot): Promise<AgentManagementSnapshot[]> {
    const result: AgentManagementSnapshot[] = [];
    const visited = new Set<string>();
    const visit = async (parent: AgentManagementSnapshot | AgentSnapshot): Promise<void> => {
      if (visited.has(parent.sessionId)) throw new Error('agent_lineage_cycle');
      visited.add(parent.sessionId);
      result.push({ ...parent, agentTasks: parent.agentTasks ?? [], agentChildren: parent.agentChildren ?? [] });
      for (const child of parent.agentChildren ?? []) {
        // A reservation is visible before Session creation. Only started children have a usable run identity.
        if (!(parent.agentTasks ?? []).some(task => task.agentSessionId === child.agentSessionId && task.childRunId)) continue;
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
    const subtree = await this.family(target);
    const ids = new Set(subtree.map(item => item.sessionId));
    const owner = await this.sessions.read(caller.agentContext?.ownerSessionId ?? caller.sessionId);
    const activeTask = (await this.family(owner)).some(item => item.agentTasks.some(task => ids.has(task.agentSessionId) && task.status === 'running'));
    // Check the whole archival subtree before closing any member. Close never implies cancellation.
    if (activeTask || subtree.some(item => item.run && !terminal(item.run.status))) {
      throw new LoopFailure('agent_child_not_idle', '成员或其后代仍有活动任务，未关闭或取消任何任务。请先等待最终任务结果；需要停止工作时显式 cancel。若成员正在等回复，请先 send 回复。');
    }
    for (const child of target.agentChildren ?? []) {
      if (!child.closed) await this.close(target, child.agentSessionId);
    }
    const current = await this.sessions.read(parent.sessionId);
    if (current.agentChildren?.find(child => child.agentSessionId === targetId)?.closed) return;
    await this.sessions.withActor(parent.sessionId, actor => actor.recordAgentEvents([{ type: 'agent.closed', sessionId: parent.sessionId,
      payload: { agentSessionId: targetId } }]));
  }

  // During release recovery the opening Actor must not await its own Service opening promise.
  private withParent<T>(id: string, owner: SessionActor | undefined, op: (actor: SessionActor) => Promise<T>): Promise<T> {
    return owner?.sessionId === id ? op(owner) : this.sessions.withActor(id, op);
  }

  private track(parentSessionId: string, task: AgentTaskSummary, owner?: SessionActor): TaskLease {
    const existing = this.#leases.get(task.taskId);
    if (existing) return existing;
    const lease: TaskLease = { parentSessionId, parentRunId: task.parentRunId, agentSessionId: task.agentSessionId, completion: Promise.resolve() };
    lease.completion = this.sessions.withActor(task.agentSessionId, async child => {
      const result = await child.waitForRunResult(task.childRunId!);
      await this.withParent(parentSessionId, owner, parent => parent.recordAgentEvents([
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

  private async reconcileCapacityStart(reservation: CapacityReservation, owner?: SessionActor): Promise<string | null> {
    const { taskId, agentSessionId, createsAgent } = reservation.payload;
    const { sessionId, runId } = reservation;
    try {
      const childRunId = await this.sessions.readCapacityStart(reservation);
      await this.withParent(sessionId, owner, parent => parent.recordAgentEvents(childRunId
        ? [{ type: 'agent.task.started', sessionId, runId, payload: { taskId, childRunId } }]
        : [{ type: 'agent.task.completed', sessionId, runId, payload: { taskId, result: { outcome: 'failed', error: {
          code: 'agent_capacity_not_started', message: 'Dispatch interrupted before the child accepted the task. No assignment was repeated.',
        } } } }, ...(createsAgent ? [{ type: 'agent.closed' as const, sessionId, payload: { agentSessionId } }] : [])]));
      return childRunId;
    } catch (error) { throw new CapacityStartUnknown(taskId, error); }
  }

  private async cancelTask(sessionId: string, task: AgentTaskSummary, owner?: SessionActor): Promise<void> {
    if (task.status !== 'running') { await this.#leases.get(task.taskId)?.completion; return; }
    if (!task.childRunId) {
      const reserved = await this.withParent(sessionId, owner, parent => parent.capacityReservation(task.parentRunId, task.taskId));
      if (!reserved) throw new Error('agent_task_start_incomplete');
      const childRunId = await this.reconcileCapacityStart(reserved, owner);
      if (!childRunId) return;
      task = { ...task, childRunId };
    }
    const childRunId = task.childRunId!;
    const lease = this.track(sessionId, task, owner);
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

  async cancelRun(sessionId: string, runId: string, owner?: SessionActor): Promise<void> {
    const admission = this.#activeAdmission;
    if (admission?.sessionId === sessionId && admission.runId === runId) {
      await admission.completion.catch(() => undefined);
    }
    const tasks = (await this.sessions.read(sessionId)).agentTasks ?? [];
    const results = await Promise.allSettled(tasks.filter(task => task.parentRunId === runId && (task.status === 'running' || this.#leases.has(task.taskId)))
      .map(task => this.cancelTask(sessionId, task, owner)));
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

/** One contact predicate for discovery and send. Ownership follows live tasks; direct peer groups
 * belong to root-created siblings in the same root run, never to their children or a later team. */
function contactError(caller: AgentSnapshot, caps: AgentPreset['capabilities'], target: AgentManagementSnapshot,
  managed: Set<string>, parentId?: string, rootRun?: string): string | undefined {
  const a = caller.agentContext, b = target.agentContext;
  if (!a || managed.has(target.sessionId)) return;
  if (!caps.messaging) return 'agent_messaging_disabled';
  if (target.sessionId === parentId) return b?.capabilities.messaging === false ? 'agent_message_target_unavailable' : undefined;
  if (caps.messaging === 'parent') return 'agent_message_target_not_parent';
  if (b?.capabilities.messaging === 'parent') return 'agent_message_source_not_parent';
  if (b?.capabilities.messaging === false) return 'agent_message_target_unavailable';
  if (a.peerGroup || b?.peerGroup) {
    if (!a.peerGroup || a.peerGroup !== b?.peerGroup || a.parentSessionId !== a.ownerSessionId || b.parentSessionId !== a.ownerSessionId
      || a.parentRunId !== rootRun || b.parentRunId !== rootRun) return 'agent_peer_group_mismatch';
  }
}

/** Current task ownership is separate from immutable creation/archival lineage. */
function taskOwner(family: readonly AgentManagementSnapshot[], childId: string, childRunId: string): AgentManagementSnapshot {
  const parents = family.filter(parent => parent.run && !terminal(parent.run.status)
    && parent.agentTasks.some(task => task.status === 'running' && task.parentRunId === parent.run!.runId
      && task.agentSessionId === childId && task.childRunId === childRunId));
  if (parents.length !== 1) throw new Error(parents.length ? 'agent_task_owner_ambiguous' : 'agent_task_owner_missing');
  return parents[0]!;
}

function activeTaskSessions(family: readonly AgentManagementSnapshot[], sessionId: string, runId: string): Set<string> {
  const result = new Set<string>();
  const visit = (id: string, run: string) => {
    if (result.has(id)) throw new Error('agent_task_lineage_cycle');
    result.add(id);
    const current = family.find(item => item.sessionId === id);
    if (!current || current.run?.runId !== run) throw new Error('agent_task_run_mismatch');
    for (const task of current.agentTasks) {
      if (task.parentRunId !== run || task.status !== 'running' || !task.childRunId) continue;
      const child = family.find(item => item.sessionId === task.agentSessionId);
      // A child can have settled just before its result reaches the task owner.
      if (child?.run?.runId === task.childRunId && !terminal(child.run.status)) visit(child.sessionId, task.childRunId);
    }
  };
  visit(sessionId, runId);
  return result;
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
