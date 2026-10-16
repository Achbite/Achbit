import { decodeAgentCapabilities, isLlmReasoningEffort } from '@deepcode/protocol';
import type { SessionOperation, JsonObject } from '@deepcode/protocol';
import { inputAfter, pendingWakeups, type ControlWait } from './sessionWake.js';
import { ManagedProcesses } from './managedProcesses.js';
import { validatePermissionPatches, providerRuntimeForPurpose } from '@deepcode/protocol';
import { confirmationFacts } from './planStage.js';
import { admitSessionEvents } from './admission.js';
import { failureSnapshotEvent } from './failureSnapshot.js';
import { errorFact } from './loopFailure.js';
import { LiveReasoning } from './reasoningRead.js';
import { LiveToolOutput } from './liveToolOutput.js';
import type { AgentSessionRuntime } from './agentManager.js';
import { savedSessionEnvironment } from './sessionEnvironment.js';
import type {
  AssistantDraftProjection,
  AgentTaskResult,
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  InteractionProjection,
  NewSessionEvent,
  PlanAuthority,
  RunSettlement,
  SessionEvent,
  SessionProjection,
} from '@deepcode/protocol';
import {
  COMMAND_REPLY_VERSION,
  SESSION_EVENT_VERSION,
} from '@deepcode/protocol';
import type { AgentComposition, SessionCapabilities } from './plugins.js';
import { SessionCapabilityManager } from './sessionCapabilities.js';
import {
  loopSnapshot,
  runAgentLoop,
  terminalToolEvents,
  uncompletedProviderComposition,
  providerTurnTerminalEvent,
  type LoopCommand,
  type LoopSnapshot,
} from './loop.js';
import { projectSession, reduceSession } from './reducer.js';

export interface SessionActorOptions {
  agents?: AgentSessionRuntime;
  profileId?: string;
  initialEvents?: readonly SessionEvent[];
  nextId?(kind: string): string;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  task: Promise<void>;
}

const MAX_FILESYSTEM_REFERENCE_COUNT = 8;

export class SessionActor {
  readonly #journal: CommandJournalPort;
  readonly #composition: AgentComposition;
  readonly #capabilities: SessionCapabilityManager;
  readonly #profileId?: string;
  readonly #agents?: AgentSessionRuntime;
  readonly #changes = new Set<() => void>();
  readonly #nextId: (kind: string) => string;
  #mailbox = Promise.resolve();
  #writes = Promise.resolve();
  #active?: ActiveRun;
  #disposed = false;
  readonly #wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #disposeTask?: Promise<void>;
  #processes?: ManagedProcesses;
  #loopFailure?: Error;
  #snapshot?: LoopSnapshot;
  #initialEvents?: readonly SessionEvent[];
  #initialSnapshot?: Promise<LoopSnapshot>;
  #publishedPermissions?: NonNullable<SessionProjection['effectivePermissions']>;
  readonly #unsubscribePermissions: () => void;
  #assistantDraft: AssistantDraftProjection | null = null;
  readonly liveReasoning = new LiveReasoning();
  readonly #liveToolOutput = new LiveToolOutput();

  constructor(
    readonly sessionId: string,
    journal: CommandJournalPort,
    composition: AgentComposition,
    options: SessionActorOptions = {},
  ) {
    this.#journal = journal;
    this.#composition = composition;
    this.#capabilities = new SessionCapabilityManager(composition.capabilities);
    this.#profileId = options.profileId;
    this.#agents = options.agents;
    this.#nextId = options.nextId ?? defaultIdFactory(sessionId);
    this.#initialEvents = options.initialEvents;
    this.#unsubscribePermissions = journal.subscribePermissions(sessionId, settings => {
      this.#publishedPermissions = settings;
      if (this.#snapshot) this.#snapshot = { ...this.#snapshot, state: { ...this.#snapshot.state, publishedPermissions: settings } };
      for (const wake of this.#changes) wake();
    });
  }

  async recover(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      signal?.throwIfAborted();
      const snapshot = await this.loadSnapshot();
      signal?.throwIfAborted();
      const run = snapshot.state.run;
      if (!run) return;
      if (isTerminal(run.status)) return;
      if (run.status === 'releasing' || run.status === 'releaseFailed') {
        const settlement = snapshot.state.pendingRunSettlements[run.runId];
        if (!settlement) throw new Error('run_finishing_settlement_missing');
        await this.finalizeRunRuntime(snapshot, run.runId, settlement);
        return;
      }
      const restored = await this.restoreRunRuntime(snapshot, run.runId);
      signal?.throwIfAborted();
      this.restoreWakeTimers(snapshot);
      if (restored && run.status === 'running') {
        this.startLoop({ type: 'recover', runId: run.runId });
      }
    });
  }

  async submit(command: ConversationCommand, beforeRunStart?: (runId: string) => Promise<void>): Promise<CommandReply> {
    return await this.enqueue(async () => {
      this.assertOperational();
      return await this.handleCommand(command, beforeRunStart);
    });
  }

  async agentCapabilities(runId: string): Promise<import('@deepcode/protocol').AgentCapabilities> {
    const runtime = (await this.loadSnapshot()).state.runRuntimeSnapshots[runId];
    if (!runtime) throw new Error('run_runtime_snapshot_missing');
    return decodeAgentCapabilities(runtime.agentCapabilities);
  }

  async snapshot(): Promise<SessionProjection> {
    const projection = projectSession((await this.loadSnapshot()).state, this.#assistantDraft);
    for (const activity of projection.activities) {
      if (activity.status === 'active' && activity.callId) {
        const output = this.#liveToolOutput.get(activity.callId);
        if (output) activity.liveOutput = output;
      }
    }
    return projection;
  }

  /** Coordination reads never construct transcript, activity or file-change projections. */
  async agentSnapshot(): Promise<Pick<SessionProjection, 'sessionId' | 'recipe' | 'agentContext' | 'agentTasks' | 'agentChildren' | 'run'> & { environment?: import('@deepcode/protocol').JsonObject }> {
    const state = (await this.loadSnapshot()).state;
    return structuredClone({ sessionId: state.sessionId, recipe: state.recipe, agentContext: state.agentContext,
      agentTasks: state.agentTasks, agentChildren: state.agentChildren, run: state.run,
      environment: state.run ? state.runRuntimeSnapshots[state.run.runId]?.environment : undefined });
  }

  /** Called only after the service's last external Actor lease has been released. */
  async retireIfSettledChild(): Promise<boolean> {
    const state = (await this.loadSnapshot()).state;
    if (!state.agentContext || state.run && !isTerminal(state.run.status)) return false;
    // run.settled can wake a result consumer just before the Loop's finally completes.
    await this.#active?.task;
    await this.dispose();
    return true;
  }

  hasLoopFailure(): boolean {
    return this.#loopFailure !== undefined;
  }

  /** Trusted Session coordination writes; the same journal admission/reducer owns these facts. */
  async recordAgentEvents(events: readonly NewSessionEvent[]): Promise<void> {
    await this.withWrite(async () => this.appendEvents(events, await this.loadSnapshot()));
  }

  async waitForInput(runId: string, signal?: AbortSignal, timeoutSeconds?: number,
    done?: (snapshot: LoopSnapshot) => boolean, acceptedWait?: ControlWait): Promise<JsonObject> {
    const initial = await this.loadSnapshot();
    const composition = initial.events.findLast(event => event.type === 'context.composed'
      && event.runId === runId && event.payload.purpose === 'agent');
    const boundary = acceptedWait?.afterSequence ?? (composition?.type === 'context.composed'
      ? composition.payload.modelView?.throughSequence ?? composition.sequence : initial.state.revision);
    const deadline = acceptedWait?.deadline ?? (timeoutSeconds === undefined ? Infinity : Date.now() + timeoutSeconds * 1000);
    for (;;) {
      signal?.throwIfAborted();
      // Subscribe before reading the published snapshot to avoid losing an arriving input.
      let wake!: () => void;
      const changed = new Promise<void>(resolve => { wake = resolve; });
      this.#changes.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshot = await this.loadSnapshot();
        if (this.#disposed) throw new Error('session_actor_disposed');
        if (this.#loopFailure) throw this.#loopFailure;
        if (snapshot.state.run?.runId !== runId || isTerminal(snapshot.state.run.status)) return {};
        if (inputAfter(snapshot.events, runId, boundary) || done?.(snapshot)) return {};
        if (Date.now() >= deadline) return { timedOut: true };
        if (Number.isFinite(deadline)) timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        await changed;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.#changes.delete(wake);
        signal?.removeEventListener('abort', wake);
      }
    }
  }

  private async sessionOperation(runId: string, operation: SessionOperation, signal: AbortSignal): Promise<JsonObject> {
    if (operation.action === 'describe') return { operations: [
      { action: 'schedule', arguments: { afterSeconds: 'positive number', text: 'review or follow-up task' }, description: 'Schedule one follow-up in this task. Earlier messages do not cancel it. Task completion cancels remaining schedules.' },
      { action: 'cancelSchedule', arguments: { scheduleId: 'schedule reference' } },
      { action: 'wait', arguments: { timeoutSeconds: 'optional positive number' }, description: 'Pause until a message, child result, scheduled follow-up or user input arrives. Optional timeout only bounds this wait.' },
    ] };
    // The Loop commits this known response before subscribing to future input.
    if (operation.action === 'wait') return {};
    return this.withWrite(async () => {
      signal.throwIfAborted();
      const snapshot = await this.loadSnapshot();
      if (snapshot.state.run?.runId !== runId || snapshot.state.run.status !== 'running') throw new Error('session_run_not_active');
      if (operation.action === 'schedule') {
        const scheduleId = this.#nextId('schedule');
        await this.appendEvents([{ type: 'wake.scheduled', sessionId: this.sessionId, runId,
          payload: { scheduleId, dueAt: Date.now() + Math.ceil(operation.afterSeconds * 1000), text: operation.text } }], snapshot);
        return { scheduleId };
      }
      if (!pendingWakeups(snapshot.events, runId).has(operation.scheduleId)) throw new Error('schedule_not_pending');
      await this.appendEvents([{ type: 'wake.cancelled', sessionId: this.sessionId, runId, payload: { scheduleId: operation.scheduleId } }], snapshot);
      return { scheduleId: operation.scheduleId, cancelled: true };
    });
  }

  private restoreWakeTimers(snapshot: LoopSnapshot): void {
    const runId = snapshot.state.run?.runId;
    const pending = runId ? pendingWakeups(snapshot.events, runId) : new Map();
    for (const [id, timer] of this.#wakeTimers) if (!pending.has(id) || this.#disposed) {
      clearTimeout(timer); this.#wakeTimers.delete(id);
    }
    if (this.#disposed || !runId) return;
    for (const [id, event] of pending) {
      if (this.#wakeTimers.has(id)) continue;
      this.#wakeTimers.set(id, setTimeout(() => {
        this.#wakeTimers.delete(id);
        void this.withWrite(async () => {
          if (this.#disposed) return;
          const current = await this.loadSnapshot();
          if (!pendingWakeups(current.events, runId).has(id)) return;
          if (Date.now() < event.payload.dueAt) {
            this.restoreWakeTimers(current);
            return;
          }
          await this.appendEvents([{ type: 'wake.triggered', sessionId: this.sessionId, runId,
            payload: { scheduleId: id, text: event.payload.text } }], current);
        }).catch(error => { this.#loopFailure = error; for (const wake of this.#changes) wake(); });
      }, Math.max(0, event.payload.dueAt - Date.now())));
    }
  }

  async waitForRunResult(runId: string): Promise<AgentTaskResult> {
    for (;;) {
      const snapshot = await this.loadSnapshot();
      const settled = snapshot.events.find(event => event.type === 'run.settled' && event.runId === runId);
      if (settled?.type === 'run.settled') {
        if (settled.payload.outcome !== 'completed') return structuredClone(settled.payload);
        const finalMessageId = settled.payload.finalMessageId;
        const message = snapshot.state.messages.find(item => item.messageId === finalMessageId);
        if (!message) throw new Error('agent_final_message_missing');
        return { ...settled.payload, content: message.content };
      }
      this.assertOperational();
      if (snapshot.state.run?.status === 'releaseFailed') throw new Error(`agent_child_release_failed:${snapshot.state.terminalError?.message ?? runId}`);
      if (this.#disposed) throw new Error('agent_child_disposed_before_settlement');
      await this.waitForChange(snapshot.state.revision);
    }
  }

  private async waitForChange(revision: number, signal?: AbortSignal, permissions?: NonNullable<SessionProjection['effectivePermissions']>): Promise<void> {
    signal?.throwIfAborted();
    let wake!: () => void;
    const changed = new Promise<void>(resolve => { wake = resolve; });
    this.#changes.add(wake);
    signal?.addEventListener('abort', wake, { once: true });
    try {
      // Subscribe before the read so a settlement between the two cannot be missed.
      const current = await this.loadSnapshot();
      if (current.state.revision !== revision || permissions && current.state.publishedPermissions !== permissions
        || this.#loopFailure || this.#disposed) return;
      await changed;
      signal?.throwIfAborted();
    } finally { this.#changes.delete(wake); signal?.removeEventListener('abort', wake); }
  }

  async hasActiveWork(): Promise<boolean> {
    if (this.#loopFailure) return false;
    const run = (await this.loadSnapshot()).state.run;
    // Waiting releases the Provider turn, not the in-memory run bindings owned by this Host.
    return this.#active !== undefined
      || (run != null && !isTerminal(run.status));
  }

  dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    this.#disposed = true;
    for (const timer of this.#wakeTimers.values()) clearTimeout(timer);
    this.#wakeTimers.clear();
    for (const wake of this.#changes) wake();
    this.#active?.controller.abort('session_service_stopped');
    this.#disposeTask = this.disposeResources();
    return this.#disposeTask;
  }

  private async disposeResources(): Promise<void> {
    // Commands already admitted to the mailbox may still be preparing a run.
    // Drain them, then also stop any Loop they started before releasing ports.
    await this.#mailbox;
    this.#active?.controller.abort('session_service_stopped');
    const errors: unknown[] = [];
    try {
      await this.#active?.task;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.closeProcesses();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#composition.runner?.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#capabilities.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#composition.dispose();
    } catch (error) {
      errors.push(error);
    }
    this.#unsubscribePermissions();
    if (errors.length > 0) throw new AggregateError(errors, 'session_actor_dispose_failed');
  }

  async delegationChanged(enabled: boolean): Promise<void> {
    if (!this.#agents) return;
    await this.enqueue(() => this.withWrite(async () => {
      const current = await this.loadSnapshot();
      if (current.state.agentDelegationEnabled === enabled) return;
      await this.appendEvents([{ type: 'agent.delegation.changed', sessionId: this.sessionId, payload: { enabled } }], current);
    }));
  }

  /** Trusted operator entry; never exposed through the model's callable catalog. */
  async replaceCapabilities(implementation: SessionCapabilities): Promise<void> {
    if (this.#disposed) throw new Error('session_actor_disposed');
    this.assertOperational();
    await this.#capabilities.replace(implementation);
  }

  private async handleCommand(command: ConversationCommand, beforeRunStart?: (runId: string) => Promise<void>): Promise<CommandReply> {
    if (this.#disposed) throw new Error('session_actor_disposed');
    if (command.sessionId !== this.sessionId) {
      return this.reject(command, 'session_identity_mismatch', '命令不属于当前会话。');
    }
    const stored = await this.#journal.readCommand(this.sessionId, command.commandId);
    if (stored) {
      if (canonicalJson(stored.command) !== canonicalJson(command)) {
        return {
          schemaVersion: COMMAND_REPLY_VERSION,
          commandId: command.commandId,
          sessionId: this.sessionId,
          status: 'rejected',
          revision: stored.reply.revision,
          error: { code: 'command_id_conflict', message: '同一 commandId 已用于不同内容。' },
        };
      }
      return { ...stored.reply, status: 'replayed' };
    }

    switch (command.type) {
      case 'run.host.rebind':
        return await this.handleHostRebind(command);
      case 'session.permissions.set':
        return await this.handlePermissions(command);
      case 'approval.revoke':
        return await this.handleRevoke(command);
      case 'session.model-settings.set':
        return await this.handleModelSettings(command);
      case 'session.directory-index.attach':
        return await this.handleDirectoryIndexAttach(command);
      case 'session.directory-index.detach':
        return await this.handleDirectoryIndexDetach(command);
      case 'message.submit':
        return await this.handleMessage(command, beforeRunStart);
      case 'message.edit':
        return await this.handleMessageEdit(command);
      case 'context.focus':
        return await this.handleFocus(command);
      case 'message.feedback.set':
        return await this.handleMessageFeedback(command);
      case 'run.cancel':
        return await this.handleCancel(command);
      case 'interaction.respond':
        return await this.handleInteraction(command);
      case 'approval.respond':
        return await this.handleApproval(command);
      case 'plan.respond':
        return await this.handlePlan(command);
    }
  }

  private async handleHostRebind(command: Extract<ConversationCommand, { type: 'run.host.rebind' }>): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const run = snapshot.state.run;
    if (this.#active || run?.runId !== command.runId || run.status !== 'waiting') {
      return this.recordRejection(command, 'host_rebind_not_waiting', '仅可为已暂停等待用户的任务重新选择窗口。');
    }
    const same = (a: typeof run.hostBinding, b: typeof run.hostBinding) => a?.hostInstanceId === b?.hostInstanceId && a?.windowLabel === b?.windowLabel;
    if (!run.hostBinding || !same(run.hostBinding, command.expectedHostBinding)) {
      return this.recordRejection(command, 'host_rebind_target_changed', '任务绑定已变化，请查看当前状态后再选择窗口。');
    }
    if (same(run.hostBinding, command.hostBinding)) {
      return this.recordRejection(command, 'host_rebind_unchanged', '任务已经使用当前窗口。');
    }
    const runtime = snapshot.state.runRuntimeSnapshots[command.runId];
    let prepared;
    try {
      prepared = await this.#composition.runPreparation.prepare({
        sessionId: this.sessionId, runId: command.runId, profileId: runtime.provider.profileId,
        environment: runtime.environment,
        ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
        ...recoveryPluginSelection(snapshot, command.runId, runtime),
        rebindHost: { commandId: command.commandId, expectedBinding: command.expectedHostBinding, hostBinding: command.hostBinding },
      });
    } catch (error) {
      const failure = errorFact(asError(error));
      return this.recordRejection(command, failure.code, failure.message);
    }
    const { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools, toolPromptContributions,
      providerToolAliases, selectedPlugins } = prepared.runtimeSnapshot;
    const preparedBinding = prepared.runtimeSnapshot.environment.hostBinding as typeof command.hostBinding | undefined;
    if (!same(preparedBinding, command.hostBinding)) {
      return this.recordRejection(command, 'host_rebind_preparation_mismatch', '准备的工具目录未绑定到所选窗口。');
    }
    return this.commitCommand(command, [{ type: 'run.host.rebound', sessionId: this.sessionId, runId: command.runId,
      payload: { commandId: command.commandId, previousBinding: command.expectedHostBinding, hostBinding: command.hostBinding,
        toolView: { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools, toolPromptContributions, providerToolAliases, selectedPlugins } },
    }], acceptedReply(command));
  }

  private async handlePermissions(command: Extract<ConversationCommand, { type: 'session.permissions.set' }>): Promise<CommandReply> {
    try { validatePermissionPatches(command.patches); }
    catch { return this.recordRejection(command, 'permission_settings_invalid', '权限设置无效。'); }
    const snapshot = await this.loadSnapshot();
    const events: NewSessionEvent[] = [{ type: 'session.permissions.updated', sessionId: this.sessionId,
      payload: { commandId: command.commandId, patches: command.patches } }];
    // A change to Shell policy invalidates outstanding reusable grants, visibly.
    if (Object.keys(command.patches).some(key => ['agent.permissions.shell', 'agent.permissions.shellAccess', 'agent.permissions.commandRules', 'agent.permissions.commandDenylist', 'agent.permissions.networkRead'].includes(key))) {
      events.push(...snapshot.state.shellAuthorizations.map(grant => ({ type: 'approval.revoked' as const,
        sessionId: this.sessionId, runId: grant.runId, payload: { commandId: command.commandId, authorityId: grant.authorityId } })));
    }
    const reply = await this.commitCommand(command, events, acceptedReply(command));
    let planConfirmed = false;
    if (snapshot.state.pendingPlan && command.patches['agent.permissions.workspaceMutation'] === 'allow') {
      const plan = snapshot.state.pendingPlan;
      const admission = await this.#composition.kernel.planAdmission({ sessionId: this.sessionId,
        runId: plan.runId, mutationManifest: plan.mutationManifest });
      if (admission.source !== 'user') {
        await this.withWrite(async () => {
          const current = await this.loadSnapshot();
          await this.appendEvents(confirmationFacts(current.state, plan, command.commandId,
            admission.source, this.#nextId, admission.authorities), current);
        });
        planConfirmed = true;
      }
    }
    if (!this.#active && snapshot.state.run?.status === 'waiting'
      && (snapshot.state.run.waitingReason === 'approval'
        || planConfirmed)) {
      this.startLoop({ type: 'resume', runId: snapshot.state.run.runId });
    }
    return reply;
  }

  private async handleRevoke(command: Extract<ConversationCommand, { type: 'approval.revoke' }>): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot.state.shellAuthorizations.some(grant => grant.runId === command.runId && grant.authorityId === command.authorityId)) {
      return this.recordRejection(command, 'approval_grant_missing', '该授权已经结束或撤销。');
    }
    return this.commitCommand(command, [{ type: 'approval.revoked', sessionId: this.sessionId, runId: command.runId,
      payload: { commandId: command.commandId, authorityId: command.authorityId } }], acceptedReply(command));
  }

  private async handleModelSettings(
    command: Extract<ConversationCommand, { type: 'session.model-settings.set' }>,
  ): Promise<CommandReply> {
    if (!command.settings || !validProfileId(command.settings.profileId)
      || !validReasoningOverride(command.settings.reasoningEffortOverride)) {
      return await this.recordRejection(command, 'session_model_settings_invalid', '对话模型设置无效。');
    }
    return await this.commitCommand(command, [{
      type: 'session.model-settings.updated', sessionId: this.sessionId,
      payload: { commandId: command.commandId, settings: { ...command.settings } },
    }], acceptedReply(command));
  }

  private async handleDirectoryIndexAttach(
    command: Extract<ConversationCommand, { type: 'session.directory-index.attach' }>,
  ): Promise<CommandReply> {
    if (!validWorkspaceBinding(command.workspaceBinding)) {
      return await this.recordRejection(
        command,
        'session_directory_index_invalid',
        '目录索引的 workspace identity 无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    if (snapshot.state.workspaceBindings.some((binding) => (
      binding.workspaceId === command.workspaceBinding.workspaceId
    ))) {
      return await this.recordRejection(
        command,
        'session_directory_index_duplicate',
        '该目录已经属于当前 Session 的有效目录集合。',
      );
    }
    const reply = await this.commitCommand(
      command,
      [{
        type: 'session.directory-index.attached',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          workspaceBinding: { ...command.workspaceBinding },
        },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleDirectoryIndexDetach(
    command: Extract<ConversationCommand, { type: 'session.directory-index.detach' }>,
  ): Promise<CommandReply> {
    if (!validProfileId(command.workspaceId)) {
      return await this.recordRejection(
        command,
        'session_directory_index_invalid',
        '目录索引的 workspaceId 无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    if (!snapshot.state.sessionDirectoryIndexes.some((binding) => (
      binding.workspaceId === command.workspaceId
    ))) {
      return await this.recordRejection(
        command,
        'session_directory_index_not_attached',
        '该目录不是当前 Session 可移除的对话目录索引。',
      );
    }
    const events: NewSessionEvent[] = [{
        type: 'session.directory-index.detached',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, workspaceId: command.workspaceId },
      }];
    const activePlan = snapshot.state.activePlanRef
      ? snapshot.state.plans.find((candidate) => (
          candidate.planId === snapshot.state.activePlanRef?.planId
          && candidate.revision === snapshot.state.activePlanRef.revision
        ))
      : undefined;
    if (activePlan?.mutationManifest.some((operation) => (
      operation.workspaceId === command.workspaceId
    ))) {
      events.push({
        type: 'plan.invalidated',
        sessionId: this.sessionId,
        runId: activePlan.runId,
        payload: {
          planId: activePlan.planId,
          revision: activePlan.revision,
          reason: `Plan 引用的 workspace binding 已从 Session 移除：${command.workspaceId}`,
          sourceFactRef: command.commandId,
        },
      });
    }
    const reply = await this.commitCommand(
      command,
      events,
      acceptedReply(command),
    );
    return reply;
  }

  private async handleMessage(
    command: Extract<ConversationCommand, { type: 'message.submit' }>,
    beforeRunStart?: (runId: string) => Promise<void>,
  ): Promise<CommandReply> {
    return await this.handleRunInput(command, command.text, null, undefined, beforeRunStart);
  }

  private async handleFocus(
    command: Extract<ConversationCommand, { type: 'context.focus' }>,
  ): Promise<CommandReply> {
    return await this.handleRunInput(command, command.task, command.task);
  }

  private async handleMessageEdit(command: Extract<ConversationCommand, { type: 'message.edit' }>): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    if (snapshot.state.run && !isTerminal(snapshot.state.run.status)) {
      return await this.recordRejection(command, 'message_edit_run_active', '请等待当前任务结束后再编辑重跑。');
    }
    if (command.expectedRevision !== snapshot.state.revision) {
      return await this.recordRejection(command, 'message_edit_stale', '会话内容已变化，请重新选择要编辑的消息。');
    }
    const original = snapshot.state.messages.find((message) => message.messageId === command.messageId);
    const accepted = snapshot.events.find((event) => event.type === 'input.accepted'
      && event.payload.messageId === command.messageId);
    const started = snapshot.events.find((event) => event.type === 'run.started'
      && event.payload.inputMessageId === command.messageId);
    if (!original || original.role !== 'user' || original.replyToInteraction || !accepted || !started) {
      return await this.recordRejection(command, 'message_edit_target_invalid', '只能编辑已结束任务的起始用户消息。');
    }
    const revised: Extract<NewSessionEvent, { type: 'conversation.revised' }> = {
      type: 'conversation.revised', sessionId: this.sessionId,
      payload: { commandId: command.commandId, messageId: command.messageId,
        fromSequence: accepted.sequence, throughSequence: snapshot.state.revision },
    };
    return await this.handleRunInput({
      schemaVersion: command.schemaVersion, type: 'message.submit', commandId: command.commandId,
      sessionId: this.sessionId, text: command.text,
      filesystemReferences: original.filesystemReferences,
      pluginSelections: original.pluginSelections,
      ...(original.guidanceReferences ? { guidanceReferences: original.guidanceReferences } : {}),
      ...(command.hostBinding ? { hostBinding: command.hostBinding } : {}),
    }, command.text, null, { command, revised });
  }

  private async handleRunInput(
    command: Extract<ConversationCommand, { type: 'message.submit' | 'context.focus' }>,
    submittedText: string,
    focusTask: string | null,
    edit?: { command: Extract<ConversationCommand, { type: 'message.edit' }>; revised: Extract<NewSessionEvent, { type: 'conversation.revised' }> },
    beforeRunStart?: (runId: string) => Promise<void>,
  ): Promise<CommandReply> {
    const journalCommand = edit?.command ?? command;
    if (!submittedText.trim() && (command.type === 'context.focus' || !command.filesystemReferences?.length)) {
      if (command.type === 'context.focus') {
        return await this.recordRejection(
          command,
          'context_focus_task_empty',
          '/focus 后必须提供新的任务正文。',
        );
      }
      return await this.recordRejection(journalCommand, 'message_empty', '用户消息不能为空。');
    }
    if (command.profileId !== undefined && !validProfileId(command.profileId)) {
      return await this.recordRejection(command, 'llm_profile_invalid', '模型 Profile 标识无效。');
    }
    if (command.reasoningEffortOverride !== undefined && !validReasoningOverride(command.reasoningEffortOverride)) {
      return await this.recordRejection(command, 'session_model_settings_invalid', '推理强度无效。');
    }
    const filesystemReferenceError = validateFilesystemReferences(command.filesystemReferences);
    if (filesystemReferenceError) {
      return await this.recordRejection(
        command,
        'message_filesystem_reference_invalid',
        filesystemReferenceError,
      );
    }
    const queued = await this.withWrite(async () => {
      const current = await this.loadSnapshot();
      const run = current.state.run;
      if (command.type === 'message.submit' && command.runId !== undefined
        && (!run || run.runId !== command.runId || !['running', 'waiting'].includes(run.status))) {
        return await this.commitCommandWithinWrite(command, [], {
          ...acceptedReply(command), status: 'rejected',
          error: { code: 'queued_input_run_unavailable', message: '该消息所属的运行已结束或不再接收输入；消息未进入其他运行。' },
        });
      }
      if (!run || !['running', 'waiting'].includes(run.status)) return null;
      if (command.type === 'context.focus') {
        return await this.commitCommandWithinWrite(command, [], {
          ...acceptedReply(command), status: 'rejected',
          error: { code: 'context_focus_run_active', message: '当前任务仍在运行；普通补充消息可以排队，/focus 请在本轮结束后使用。' },
        });
      }
      const runtime = current.state.runRuntimeSnapshots[run.runId];
      if (!runtime) throw new Error('run_runtime_snapshot_missing');
      let incompatible: string | undefined;
      if (
        command.profileId !== undefined && command.profileId !== runtime.provider.profileId
        || command.reasoningEffortOverride !== undefined
          && command.reasoningEffortOverride !== (runtime.provider.reasoningEffortOverride ?? null)
      ) {
        incompatible = '当前运行的模型设置已固定，排队消息不能替换本轮模型或推理设置。';
      }
      if (incompatible) {
        return await this.commitCommandWithinWrite(command, [], {
          ...acceptedReply(command), status: 'rejected',
          error: { code: 'queued_input_runtime_change', message: incompatible },
        });
      }
      return await this.commitCommandWithinWrite(command, [{
        type: 'input.queued', sessionId: this.sessionId, runId: run.runId,
        payload: {
          commandId: command.commandId, messageId: this.#nextId('message'), text: submittedText,
          ...(command.guidanceReferences?.length ? {guidanceReferences:structuredClone(command.guidanceReferences)} : {}),
          ...(command.pluginCatalogRevision ? { pluginCatalogRevision: command.pluginCatalogRevision } : {}),
          ...(command.filesystemReferences?.length ? { filesystemReferences: command.filesystemReferences.map((reference) => ({ ...reference })) } : {}),
          ...(command.pluginSelections?.length ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) } : {}),
        },
      }], acceptedReply(command));
    });
    if (queued) return queued;
    // A final turn may already be releasing its runtime; wait for that owned task
    // before admitting the next run, without blocking other Sessions.
    if (this.#active) await this.#active.task;
    const current = await this.loadSnapshot();
    const before = edit ? loopSnapshot(this.sessionId, [...current.journalEvents, {
      ...edit.revised, schemaVersion: SESSION_EVENT_VERSION, eventId: `preflight:${command.commandId}`,
      sequence: current.state.revision + 1, occurredAt: '1970-01-01T00:00:00.000Z',
    }]) : current;
    if (before.state.run && !isTerminal(before.state.run.status)) {
      return await this.recordRejection(command, 'run_release_pending', '当前运行尚未完成资源释放。');
    }
    const messageId = this.#nextId('message');
    const runId = this.#nextId('run');
    const profileId = command.profileId ?? before.state.modelSettings?.profileId ?? this.#profileId;
    const reasoningEffortOverride = command.reasoningEffortOverride !== undefined
      ? command.reasoningEffortOverride
      : before.state.modelSettings && profileId === before.state.modelSettings.profileId
        ? before.state.modelSettings.reasoningEffortOverride : null;
    const runWorkspaceBindings = before.state.workspaceBindings.map(binding => ({ ...binding }));
    const prepared = await this.#composition.runPreparation.prepare({
      sessionId: this.sessionId,
      runId,
      environment: savedSessionEnvironment(before.events),
      ...(command.hostBinding ? { hostBinding: { ...command.hostBinding } } : {}),
      ...(profileId ? { profileId } : {}),
      ...(reasoningEffortOverride ? { reasoningEffortOverride } : {}),
      ...(command.pluginCatalogRevision
        ? { pluginCatalogRevision: command.pluginCatalogRevision }
        : {}),
      ...(command.pluginSelections?.length
        ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
        : {}),
    });
    const runtimeSnapshot = !this.#agents && prepared.runtimeSnapshot.agentToolsEnabled
      ? { ...prepared.runtimeSnapshot, agentToolsEnabled: false }
      : prepared.runtimeSnapshot;
    const events: NewSessionEvent[] = [
      ...(edit ? [edit.revised] : []),
      ...(this.#agents && typeof runtimeSnapshot.agentDelegationEnabled === 'boolean'
        && before.state.agentDelegationEnabled !== runtimeSnapshot.agentDelegationEnabled
        ? [{ type: 'agent.delegation.changed' as const, sessionId: this.sessionId, payload: { enabled: runtimeSnapshot.agentDelegationEnabled } }] : []),
      {
        type: 'session.model-settings.updated',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, settings: { profileId: runtimeSnapshot.provider.profileId,
          reasoningEffortOverride: before.state.agentContext ? runtimeSnapshot.provider.reasoningEffort ?? null : reasoningEffortOverride } },
      },
      {
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          messageId,
          text: submittedText,
          ...(command.guidanceReferences?.length ? {guidanceReferences:structuredClone(command.guidanceReferences)} : {}),
          ...(command.pluginSelections?.length
            ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
            : {}),
        },
      },
      {
        type: 'message.committed',
        sessionId: this.sessionId,
        payload: {
          messageId,
          role: 'user',
          content: submittedText,
          ...(command.guidanceReferences?.length ? {guidanceReferences:structuredClone(command.guidanceReferences)} : {}),
          ...(command.filesystemReferences?.length
            ? {
                filesystemReferences: command.filesystemReferences.map((reference) => ({
                  ...reference,
                })),
              }
            : {}),
          ...(command.pluginSelections?.length
            ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
            : {}),
        },
      },
      {
        type: 'run.started',
        sessionId: this.sessionId,
        runId,
        payload: {
          inputMessageId: messageId,
          workspaceBindings: runWorkspaceBindings,
          runtimeSnapshot,
        },
      },
    ];
    if (focusTask !== null) {
      events.push({
        type: 'context.compaction.requested',
        sessionId: this.sessionId,
        runId,
        payload: {
          compactionId: this.#nextId('compaction'),
          providerRequestId: this.#nextId('provider-request'),
          trigger: 'userFocus',
          coveredThroughSequence: before.state.revision,
          focus: focusTask,
          commandId: command.commandId,
        },
      });
    }
    let reply: CommandReply;
    try {
      reply = await this.commitCommand(
        journalCommand,
        events,
        acceptedReply(command),
      );
    } catch (error) {
      try {
        await this.#composition.runPreparation.release({
          sessionId: this.sessionId,
          runId,
          kernelCatalogSnapshotRef: runtimeSnapshot.kernelCatalogSnapshotRef,
        });
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'run_admission_release_failed');
      }
      throw error;
    }
    await beforeRunStart?.(runId);
    this.startLoop({ type: 'start', runId });
    return reply;
  }

  private async handleMessageFeedback(
    command: Extract<ConversationCommand, { type: 'message.feedback.set' }>,
  ): Promise<CommandReply> {
    if (!validProfileId(command.messageId)) {
      return await this.recordRejection(
        command,
        'message_feedback_target_invalid',
        '反馈目标消息标识无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    const message = snapshot.state.messages.find((candidate) => (
      candidate.messageId === command.messageId
    ));
    if (!message || message.role !== 'assistant') {
      return await this.recordRejection(
        command,
        'message_feedback_target_missing',
        '反馈只能关联当前 Session 中已有的 Assistant 消息。',
      );
    }
    const reply = await this.commitCommand(
      command,
      [{
        type: 'message.feedback.updated',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          messageId: command.messageId,
          feedback: command.feedback,
        },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleInteraction(
    command: Extract<ConversationCommand, { type: 'interaction.respond' }>,
  ): Promise<CommandReply> {
    let resume = false;
    const reply = await this.withWrite(async () => {
      const snapshot = await this.loadSnapshot();
      const interaction = snapshot.state.interactions.find(item => item.interactionId === command.interactionId
        && item.runId === command.runId && item.status === 'pending');
      const run = snapshot.state.run;
      const continuing = interaction?.mode === 'continue';
      if (!interaction || run?.runId !== command.runId || !['running', 'waiting'].includes(run.status)
        || !continuing && (run.status !== 'waiting' || run.waitingReason !== 'userInput')) {
        return this.commitCommandWithinWrite(command, [], { ...acceptedReply(command), status: 'rejected',
          error: { code: 'interaction_not_pending', message: '该交互请求已经关闭或不属于当前运行。' } });
      }
      const response = command.response.trim();
      if (!validInteractionResponse(interaction, response)) {
        return this.commitCommandWithinWrite(command, [], { ...acceptedReply(command), status: 'rejected',
          error: { code: 'interaction_response_invalid', message: '响应不符合当前交互请求。' } });
      }
      const messageId = this.#nextId('message');
      const events: NewSessionEvent[] = [continuing ? {
        type: 'input.queued', sessionId: this.sessionId, runId: command.runId,
        payload: { commandId: command.commandId, messageId, text: response, interactionId: interaction.interactionId },
      } : {
        type: 'input.accepted', sessionId: this.sessionId,
        payload: { commandId: command.commandId, messageId, text: response },
      }, {
        type: 'interaction.resolved', sessionId: this.sessionId, runId: command.runId,
        payload: { interactionId: interaction.interactionId, commandId: command.commandId, response },
      }];
      if (!continuing) events.push({ type: 'message.committed', sessionId: this.sessionId, runId: command.runId,
        payload: { messageId, role: 'user', content: response } });
      // A reply never answers an outstanding Plan/permission or another blocking question.
      resume = run.status === 'waiting' && run.waitingReason === 'userInput'
        && !snapshot.state.interactions.some(item => item !== interaction && item.runId === run.runId
          && item.status === 'pending' && item.mode !== 'continue');
      return this.commitCommandWithinWrite(command, events, acceptedReply(command));
    });
    if (resume) {
      // The waiting fact may be visible just before the owned Loop task returns.
      // Join that task; never start a second Loop beside it.
      if (this.#active) await this.#active.task;
      this.startLoop({ type: 'resume', runId: command.runId });
    }
    return reply;
  }

  private async handleApproval(
    command: Extract<ConversationCommand, { type: 'approval.respond' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const approval = snapshot.state.pendingApprovals.find(item => item.approvalId === command.approvalId);
    if (
      !approval
      || approval.approvalId !== command.approvalId
      || approval.callId !== command.callId
      || approval.runId !== command.runId
      || snapshot.state.run?.runId !== command.runId
      || !['running', 'waiting'].includes(snapshot.state.run.status)
    ) {
      return await this.recordRejection(
        command,
        'approval_not_pending',
        '该 effect 裁决已经关闭或不属于当前运行。',
      );
    }
    if (command.authorizationScope && (command.decision !== 'allow' || !(approval.preview.authorizationScopes ?? [approval.preview.authorizationScope]).includes(command.authorizationScope))) {
      return await this.recordRejection(command, 'approval_scope_invalid', '当前操作未提供该授权范围。');
    }
    const reply = await this.commitCommand(
      command,
      [{
        type: 'approval.resolved',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: command.callId,
        payload: {
          approvalId: command.approvalId,
          commandId: command.commandId,
          decision: command.decision,
          source: 'user',
          authorityId: this.#nextId('authority'),
          ...(command.authorizationScope ? { authorizationScope: command.authorizationScope } : {}),
        },
      }],
      acceptedReply(command),
    );
    if (!this.#active) this.startLoop({ type: 'resume', runId: command.runId });
    return reply;
  }

  private async handlePlan(
    command: Extract<ConversationCommand, { type: 'plan.respond' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const plan = snapshot.state.pendingPlan;
    if (
      !plan
      || plan.planId !== command.planId
      || plan.revision !== command.revision
      || plan.runId !== command.runId
      || snapshot.state.run?.runId !== command.runId
      || snapshot.state.run.status !== 'waiting'
      || snapshot.state.run.waitingReason !== 'plan'
    ) {
      return await this.recordRejection(
        command,
        'plan_not_pending',
        '该 Plan 已关闭、已变化或不属于当前运行。',
      );
    }
    if (command.response.kind === 'requestRevision' && !command.response.text.trim()) {
      return await this.recordRejection(
        command,
        'plan_response_invalid',
        'Plan 修订说明不能为空。',
      );
    }

    const events: NewSessionEvent[] = [];
    if (command.response.kind === 'confirm') {
      events.push(...confirmationFacts(snapshot.state, plan, command.commandId, 'user', this.#nextId));
    } else if (command.response.kind === 'requestRevision') {
      const messageId = this.#nextId('message');
      events.push({
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, messageId, text: command.response.text },
      });
      events.push({
        type: 'plan.revision.requested',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: plan.callId,
        payload: {
          planId: plan.planId,
          revision: plan.revision,
          commandId: command.commandId,
          text: command.response.text,
        },
      });
      events.push({
        type: 'message.committed',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: { messageId, role: 'user', content: command.response.text },
      });
    } else {
      events.push({
        type: 'plan.cancelled',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: plan.callId,
        payload: {
          planId: plan.planId,
          revision: plan.revision,
          commandId: command.commandId,
        },
      });
    }
    const reply = await this.commitCommand(command, events, acceptedReply(command));
    if (command.response.kind === 'cancel') {
      if (this.#active?.runId === command.runId) {
        this.#active.controller.abort('user_cancelled_plan');
        await this.#active.task;
      } else {
        await this.runLoop({ type: 'cancel', runId: command.runId });
      }
    } else {
      if (this.#active) await this.#active.task;
      this.startLoop({ type: 'resume', runId: command.runId });
    }
    return reply;
  }

  private async handleCancel(
    command: Extract<ConversationCommand, { type: 'run.cancel' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot.state.run || snapshot.state.run.runId !== command.runId) {
      return await this.recordRejection(command, 'run_not_current', '取消目标不是当前运行。');
    }
    if (isTerminal(snapshot.state.run.status)) {
      return await this.recordRejection(command, 'run_already_settled', '运行已经结束。');
    }
    const plan = snapshot.state.pendingPlan;
    const reply = await this.commitCommand(
      command,
      plan
        ? [{
            type: 'plan.cancelled',
            sessionId: this.sessionId,
            runId: command.runId,
            callId: plan.callId,
            payload: {
              planId: plan.planId,
              revision: plan.revision,
              commandId: command.commandId,
            },
          }]
        : [],
      acceptedReply(command),
    );
    if (this.#active?.runId === command.runId) {
      this.#active.controller.abort('user_cancelled');
      await this.#active.task;
    } else {
      await this.runLoop({ type: 'cancel', runId: command.runId });
    }
    return reply;
  }

  private startLoop(command: LoopCommand): void {
    if (this.#active) throw new Error('session_run_already_active');
    this.#assistantDraft = null;
    const controller = new AbortController();
    const active: ActiveRun = { runId: command.runId, controller, task: Promise.resolve() };
    active.task = this.runLoop(command, controller.signal)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        this.#loopFailure = await this.containLoopFailure(command.runId, error);
      })
      .finally(() => {
        if (this.#active === active) this.#active = undefined;
        for (const wake of this.#changes) wake();
      });
    this.#active = active;
  }

  private async runLoop(
    command: LoopCommand,
    signal = new AbortController().signal,
  ): Promise<void> {
    const snapshot = await this.loadSnapshot();
    await this.ensureProcesses(command.runId);
    const runner = this.#composition.runner ?? { run: runAgentLoop };
    const result = await runner.run(
      snapshot,
      command,
      {
        composition: this.#composition,
        capabilities: this.#capabilities,
        ...(this.#agents ? { agents: this.#agents } : {}),
        sessionOperation: (runId, operation, signal) => this.sessionOperation(runId, operation, signal),
        waitForInput: (runId, wait, signal) => this.waitForInput(runId, signal, undefined, undefined, wait),
        syncProcesses: async () => { await this.ensureProcesses(command.runId); await this.#processes?.sync(); },
        waitProcesses: signal => this.#processes?.wait(signal) ?? Promise.resolve(),
        waitForChange: (revision, signal, permissions) => this.waitForChange(revision, signal, permissions),
        readSnapshot: () => this.withWrite(() => this.loadSnapshot()),
        commit: (events) => this.withWrite(async () => {
          const current = await this.loadSnapshot();
          const batch = typeof events === 'function' ? events(current) : Array.isArray(events) ? events : [events];
          await this.appendEvents(batch, current);
          return await this.loadSnapshot();
        }),
        takeQueuedInputs: (runId) => this.withWrite(async () => {
          const current = await this.loadSnapshot();
          if (signal.aborted) return current;
          const queued = current.state.queuedInputs.filter((input) => input.runId === runId);
          const runtime = current.state.runRuntimeSnapshots[runId];
          if (!runtime) throw new Error('run_runtime_snapshot_missing');
          const activeView = current.state.runToolViews[runId] ?? runtime;
          const initialSelections = recoveryPluginSelection(current, runId, runtime).pluginSelections ?? [];
          const selections = [...new Map([...initialSelections, ...queued.flatMap((input) => input.pluginSelections)]
            .map((selection) => [selection.uri, selection])).values()];
          const events: NewSessionEvent[] = [];
          if (selections.length || activeView.selectedPlugins.plugins.length) {
            const catalogRevision = queued.filter((input) => input.pluginSelections.length).at(-1)?.pluginCatalogRevision;
            const prepared = await this.#composition.runPreparation.prepare({
              sessionId: this.sessionId, runId, profileId: runtime.provider.profileId,
              environment: runtime.environment,
              ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
              pluginSelections: selections,
              refreshPlugins: !queued.some(input=>input.pluginSelections.length),
              ...(catalogRevision ? { pluginCatalogRevision: catalogRevision } : {}),
            });
            const { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools, toolPromptContributions,
              providerToolAliases, selectedPlugins } = prepared.runtimeSnapshot;
            if (kernelCatalogSnapshotRef !== activeView.kernelCatalogSnapshotRef) events.push({ type: 'run.tools.prepared', sessionId: this.sessionId, runId,
              payload: { toolView: { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools,
                toolPromptContributions, providerToolAliases, selectedPlugins } } });
          }
          events.push(...queued.flatMap<NewSessionEvent>((input) => [{
            type: 'input.accepted', sessionId: this.sessionId,
            payload: { commandId: input.commandId, messageId: input.messageId, text: input.text,
              ...(input.guidanceReferences?.length ? {guidanceReferences:structuredClone(input.guidanceReferences)} : {}),
              ...(input.pluginSelections.length ? { pluginSelections: input.pluginSelections } : {}) },
          }, {
            type: 'message.committed', sessionId: this.sessionId, runId,
            payload: { messageId: input.messageId, role: 'user', content: input.text,
              ...(input.guidanceReferences?.length ? {guidanceReferences:structuredClone(input.guidanceReferences)} : {}),
              ...(input.filesystemReferences.length ? { filesystemReferences: input.filesystemReferences } : {}),
              ...(input.pluginSelections.length ? { pluginSelections: input.pluginSelections } : {}) },
          }]));
          if (events.length) await this.appendEvents(events, current);
          return await this.loadSnapshot();
        }),
        updateAssistantDraft: (draft) => {
          if (draft && draft.runId !== command.runId) {
            throw new Error('assistant_draft_run_identity_mismatch');
          }
          this.#assistantDraft = draft ? structuredClone(draft) : null;
        },
        resetReasoning: () => this.liveReasoning.reset(),
        updateReasoning: (requestId, runId, text, kind) => this.liveReasoning.append(requestId, runId, text, kind),
        updateToolProgress: (callId, progress) => this.#liveToolOutput.update(callId, progress),
        nextId: this.#nextId,
      },
      signal,
    );
    if (result.status === 'finishing') {
      const current = await this.loadSnapshot();
      const settlement = current.state.pendingRunSettlements[command.runId];
      if (!settlement) throw new Error('run_finishing_settlement_missing');
      if (settlement.outcome === 'failed' || settlement.outcome === 'indeterminate') {
        await this.withWrite(async () => { const state = await this.loadSnapshot();
          await this.appendEvents([failureSnapshotEvent(state, command.runId, settlement.error)], state);
        });
      }
      await this.finalizeRunRuntime(await this.loadSnapshot(), command.runId, settlement);
    }
  }

  private async containLoopFailure(runId: string, error: unknown): Promise<Error> {
    let failure = asError(error);
    let snapshot: LoopSnapshot;
    try {
      snapshot = await this.loadSnapshot();
    } catch (snapshotError) {
      return new AggregateError(
        [failure, asError(snapshotError)],
        failure.message,
      );
    }
    try {
      await this.withWrite(async () => { const current = await this.loadSnapshot();
        await this.appendEvents([failureSnapshotEvent(current, runId, errorFact(failure))], current);
      });
    } catch (snapshotError) { failure = new AggregateError([failure, asError(snapshotError)], failure.message); }
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    const cleanup = await Promise.allSettled([
      this.closeProcesses(),
      this.#agents?.cancel(runId) ?? Promise.resolve(),
      runtime && !snapshot.state.runRuntimeReleases[runId] ? this.#composition.runPreparation.release({
        sessionId: this.sessionId, runId, kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
      }) : Promise.resolve(),
    ]);
    const errors = cleanup.flatMap(result => result.status === 'rejected' ? [asError(result.reason)] : []);
    if (errors.length) failure = new AggregateError([failure, ...errors], failure.message);
    return failure;
  }

  private async restoreRunRuntime(snapshot: LoopSnapshot, runId: string): Promise<boolean> {
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    if (!runtime) throw new Error('run_runtime_snapshot_missing');
    decodeAgentCapabilities(runtime.agentCapabilities);
    let prepared;
    try {
      prepared = await this.#composition.runPreparation.prepare({
        sessionId: this.sessionId,
        runId,
        profileId: runtime.provider.profileId,
        environment: runtime.environment,
        restoreEnvironment: true,
        ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
        ...recoveryPluginSelection(snapshot, runId, runtime),
      });
    } catch (error) {
      await this.settleRecoveryFailure(runId, error);
      return false;
    }
    const restored = prepared.runtimeSnapshot;
    if (restored.provider.providerRuntimeRef !== runtime.provider.providerRuntimeRef
      || providerRuntimeForPurpose(restored, 'approvalReview').providerRuntimeRef !== providerRuntimeForPurpose(runtime, 'approvalReview').providerRuntimeRef
      || restored.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef
      || restored.extensionGenerationRef !== runtime.extensionGenerationRef) {
      const mismatch = new Error('run_runtime_recovery_identity_mismatch');
      try {
        await this.#composition.runPreparation.release({
          sessionId: this.sessionId,
          runId,
          kernelCatalogSnapshotRef: prepared.runtimeSnapshot.kernelCatalogSnapshotRef,
        });
      } finally {
        await this.settleRecoveryFailure(runId, mismatch);
      }
      return false;
    }
    return true;
  }

  private async settleRecoveryFailure(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const before = await this.loadSnapshot();
    const pending = uncompletedProviderComposition(before, runId);
    const outcome: Extract<RunSettlement, { outcome: 'failed' | 'indeterminate' }> = {
      outcome: pending ? 'indeterminate' : 'failed',
      error: { code: errorCode(message), message },
    };
    await this.appendLifecycleEvents([
      ...(pending ? [providerTurnTerminalEvent(this.sessionId, runId, pending,
        providerRuntimeForPurpose(before.state.runRuntimeSnapshots[runId]!, pending.purpose).providerRuntimeRef, outcome)] : []), {
      type: 'run.finishing',
      sessionId: this.sessionId,
      runId,
      payload: outcome,
    }]);
    const snapshot = await this.loadSnapshot();
    const settlement = snapshot.state.pendingRunSettlements[runId];
    if (!settlement) throw new Error('run_finishing_settlement_missing');
    await this.finalizeRunRuntime(snapshot, runId, settlement);
  }

  private async ensureProcesses(runId: string): Promise<void> {
    const snapshot = await this.loadSnapshot();
    const runtime = snapshot.state.runToolViews[runId] ?? snapshot.state.runRuntimeSnapshots[runId];
    if (!this.#processes && runtime?.selectedPlugins.plugins.some(plugin => plugin.uri === 'plugin://processes@builtin')) {
      this.#processes = new ManagedProcesses(this.sessionId, runId, this.#composition.kernel,
        jobs => this.withWrite(async () => {
          const current = await this.loadSnapshot();
          const updates = jobs.filter(job => (current.state.processes[job.jobId]?.revision ?? 0) < job.revision);
          if (updates.length) await this.appendEvents(updates.map(job => ({type: 'process.updated' as const,
            sessionId: this.sessionId, runId: runId, callId: job.callId, payload: {job}})), current);
        }), error => {
          const processes = this.#processes;
          const settleWaitingRun = () => {
            if (this.#disposed || this.#loopFailure || this.#processes !== processes) return;
            if (this.#active) this.#active.controller.abort(error);
            else this.startLoop({ type: 'fail', runId, error });
          };
          const active = this.#active;
          if (active) {
            active.controller.abort(error);
            // The loop may already be returning a waiting result. Once it has
            // stopped, settle any still-owned feed through the same loop.
            void active.task.then(settleWaitingRun);
          } else settleWaitingRun();
        });
    }
  }

  private async closeProcesses(): Promise<void> {
    const processes = this.#processes;
    this.#processes = undefined;
    await processes?.close();
  }

  private async finalizeRunRuntime(
    snapshot: LoopSnapshot,
    runId: string,
    settlement: RunSettlement,
  ): Promise<boolean> {
    await this.closeProcesses();
    snapshot = await this.loadSnapshot();
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    if (!runtime) throw new Error('run_runtime_snapshot_missing');
    if (snapshot.state.runRuntimeReleases[runId]) {
      const tools = await terminalToolEvents(snapshot, runId, this.#composition.kernel, settlement);
      await this.appendLifecycleEvents([...tools, {
        type: 'run.settled',
        sessionId: this.sessionId,
        runId,
        payload: cloneSettlement(settlement),
      }]);
      return true;
    }
    let released;
    try {
      const cleanup = await Promise.allSettled([
        this.#agents?.cancel(runId) ?? Promise.resolve(),
        this.#composition.runPreparation.release({ sessionId: this.sessionId, runId,
          kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef }),
      ]);
      const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'run_runtime_cleanup_failed');
      const ownRelease = cleanup[1]!;
      if (ownRelease.status !== 'fulfilled') throw new Error('run_runtime_release_missing');
      released = ownRelease.value;
    } catch (error) {
      await this.appendLifecycleEvents([{
        type: 'run.runtime.release_failed',
        sessionId: this.sessionId,
        runId,
        payload: {
          runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef,
          extensionGenerationRef: runtime.extensionGenerationRef,
          kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
          providerRuntimeRef: runtime.provider.providerRuntimeRef,
          error: errorFact(error),
        },
      }]);
      return false;
    }
    const tools = await terminalToolEvents(
      await this.loadSnapshot(), runId, this.#composition.kernel, settlement,
    );
    await this.appendLifecycleEvents([
      {
        type: 'run.runtime.released',
        sessionId: this.sessionId,
        runId,
        payload: {
          runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef,
          extensionGenerationRef: runtime.extensionGenerationRef,
          kernelCatalogSnapshotRef: released.kernelCatalogSnapshotRef,
          providerRuntimeRef: runtime.provider.providerRuntimeRef,
          pluginInstanceRefs: (snapshot.state.runToolViews[runId] ?? runtime).selectedPlugins.plugins.map((plugin) => (
            plugin.pluginInstanceRef
          )),
          alreadyReleased: released.alreadyReleased,
        },
      },
      ...tools,
      {
        type: 'run.settled',
        sessionId: this.sessionId,
        runId,
        payload: cloneSettlement(settlement),
      },
    ]);
    return true;
  }

  private async appendLifecycleEvents(events: readonly NewSessionEvent[]): Promise<void> {
    await this.withWrite(async () => this.appendEvents(events, await this.loadSnapshot()));
  }

  private async appendEvents(events: readonly NewSessionEvent[], current: LoopSnapshot): Promise<void> {
    admitSessionEvents(current, events);
    const previousDraft = this.#assistantDraft;
    const closesDraft = current.state.run && closesAssistantDraft(events, current.state.run.runId);
    if (closesDraft) this.#assistantDraft = null;
    try {
      const committed = events.length === 1
        ? [await this.#journal.append(events[0]!)]
        : await this.#journal.appendBatch(events);
      this.publishEvents(committed);
      for (const event of committed) await this.observe(event);
    } catch (error) {
      if (closesDraft) this.#assistantDraft = previousDraft;
      await this.recoverFailedWrite(error);
      throw error;
    }
  }

  private async commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply> {
    return await this.withWrite(() => this.commitCommandWithinWrite(command, events, reply));
  }

  private async commitCommandWithinWrite(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply> {
    const current = await this.loadSnapshot();
    admitSessionEvents(current, events, { input: command, reply });
    try {
      const committed = await this.#journal.commitCommand(command, events, reply);
      this.publishEvents(committed.events);
      for (const event of committed.events) await this.observe(event);
      return committed.reply;
    } catch (error) {
      await this.recoverFailedWrite(error);
      throw error;
    }
  }

  private async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(operation, operation);
    this.#writes = result.then(() => undefined, () => undefined);
    return await result;
  }

  private publishEvents(added: readonly SessionEvent[]): void {
    const current = this.#snapshot!;
    if (added.some((event, index) => event.sessionId !== this.sessionId
      || event.sequence !== current.state.revision + index + 1)) throw new Error('journal_publication_sequence_invalid');
    this.#snapshot = !added.length ? current : added.some(event => event.type === 'conversation.revised')
      ? loopSnapshot(this.sessionId, [...current.journalEvents, ...added])
      : { journalEvents: [...current.journalEvents, ...added], events: [...current.events, ...added],
        state: added.reduce(reduceSession, current.state) };
    this.#snapshot = { ...this.#snapshot, state: { ...this.#snapshot.state, publishedPermissions: this.#publishedPermissions } };
  }

  private async loadSnapshot(): Promise<LoopSnapshot> {
    if (this.#snapshot) return this.#snapshot;
    this.#initialSnapshot ??= (async () => {
      const events: SessionEvent[] = [...this.#initialEvents ?? []];
      if (!this.#initialEvents) for await (const event of this.#journal.read(this.sessionId)) events.push(event);
      this.#initialEvents = undefined;
      const snapshot = loopSnapshot(this.sessionId, events);
      snapshot.state.publishedPermissions = this.#publishedPermissions;
      return this.#snapshot = snapshot;
    })();
    return this.#initialSnapshot;
  }

  /** A failed transport can hide a successful durable commit. Recover at the
   * failed write boundary, before admitting another command, never on reads. */
  private async recoverFailedWrite(original: unknown): Promise<void> {
    const revision = this.#snapshot?.state.revision ?? 0;
    this.#snapshot = undefined;
    this.#initialEvents = undefined;
    this.#initialSnapshot = undefined;
    try {
      const recovered = await this.loadSnapshot();
      for (const event of recovered.journalEvents) if (event.sequence > revision) await this.observe(event);
    } catch (error) {
      this.#loopFailure = new AggregateError([original, error], 'session_commit_recovery_failed');
      throw this.#loopFailure;
    }
  }

  private async observe(event: SessionEvent): Promise<void> {
    if (event.type.startsWith('wake.') || event.type === 'run.finishing' || event.type === 'run.settled') {
      this.restoreWakeTimers(await this.loadSnapshot());
    }
    for (const wake of this.#changes) wake();
    if (event.type === 'tool.completed' || event.type === 'tool.interrupted' || event.type === 'tool.input-rejected' || event.type === 'tool.not-executed') {
      this.#liveToolOutput.delete(event.callId);
    }
    if (event.type === 'run.settled') this.#liveToolOutput.clear();
  }

  private async recordRejection(
    command: ConversationCommand,
    code: string,
    message: string,
  ): Promise<CommandReply> {
    return await this.commitCommand(command, [], {
      schemaVersion: COMMAND_REPLY_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      status: 'rejected',
      error: { code, message },
    });
  }

  private reject(command: ConversationCommand, code: string, message: string): CommandReply {
    return {
      schemaVersion: COMMAND_REPLY_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      status: 'rejected',
      revision: 0,
      error: { code, message },
    };
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mailbox.then(operation, operation);
    this.#mailbox = result.then(() => undefined, () => undefined);
    return await result;
  }

  private assertOperational(): void {
    if (this.#loopFailure) {
      throw new Error(`session_loop_failed:${this.#loopFailure.message}`, {
        cause: this.#loopFailure,
      });
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validInteractionResponse(interaction: InteractionProjection, response: string): boolean {
  if (!response) return false;
  return interaction.allowFreeform || Boolean(interaction.options?.some((option) => (
    option.id === response || option.label === response
  )));
}

function acceptedReply(command: ConversationCommand): Omit<CommandReply, 'revision'> {
  return {
    schemaVersion: COMMAND_REPLY_VERSION,
    commandId: command.commandId,
    sessionId: command.sessionId,
    status: 'accepted',
  };
}

function validWorkspaceBinding(value: unknown): value is {
  workspaceId: string;
  displayName: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).every((key) => ['workspaceId', 'displayName'].includes(key))
    && typeof binding.workspaceId === 'string'
    && validProfileId(binding.workspaceId)
    && typeof binding.displayName === 'string'
    && Boolean(binding.displayName.trim())
    && binding.displayName.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(binding.displayName);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function errorCode(message: string): string {
  const [candidate] = message.split(':', 1);
  return candidate && /^[a-z][a-z0-9_.-]{0,127}$/u.test(candidate)
    ? candidate
    : 'run_runtime_recovery_failed';
}

function sortJsonValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('command_requires_safe_integer_numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, sortJsonValue(source[key])]),
    );
  }
  return value;
}

function isTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function recoveryPluginSelection(
  snapshot: LoopSnapshot,
  runId: string,
  runtime: LoopSnapshot['state']['runRuntimeSnapshots'][string],
): {
  pluginCatalogRevision?: string;
  pluginSelections?: Extract<ConversationCommand, { type: 'message.submit' }>['pluginSelections'];
} {
  const started = snapshot.events.find((event): event is Extract<
    SessionEvent,
    { type: 'run.started' }
  > => event.type === 'run.started' && event.runId === runId);
  if (!started) throw new Error('run_started_event_missing');
  const input = snapshot.events.find((event): event is Extract<
    SessionEvent,
    { type: 'input.accepted' }
  > => (
    event.type === 'input.accepted'
    && event.payload.messageId === started.payload.inputMessageId
  ));
  const active = snapshot.state.runToolViews[runId]?.selectedPlugins ?? runtime.selectedPlugins;
  const selections = active.plugins.map((plugin, index) => (
    input?.payload.pluginSelections?.find(selection => selection.uri === plugin.uri)
    ?? { selectionId: `plugin-selection:${runId}:${index}`, uri: plugin.uri, label: plugin.uri.slice(0, 160) }
  ));
  if (selections.length === 0) return {};
  return {
    pluginCatalogRevision: active.catalogRevision,
    pluginSelections: selections.map((selection) => ({ ...selection })),
  };
}

function cloneSettlement(settlement: RunSettlement): RunSettlement {
  if (settlement.outcome === 'completed') return { ...settlement };
  if (settlement.outcome === 'failed' || settlement.outcome === 'indeterminate') {
    return { outcome: settlement.outcome, error: { ...settlement.error } };
  }
  return { outcome: 'cancelled' };
}

function closesAssistantDraft(
  events: readonly (NewSessionEvent | SessionEvent)[],
  runId: string,
): boolean {
  return events.some((event) => (
    'runId' in event
    && event.runId === runId
    && (
      event.type === 'narrative.committed'
      || event.type === 'provider.turn.settled'
      || event.type === 'interaction.requested'
      || event.type === 'plan.published'
      || event.type === 'tool.requested'
      || event.type === 'run.finishing'
      || event.type === 'run.settled'
      || event.type === 'message.committed' && event.payload.role === 'assistant'
    )
  ));
}

function validProfileId(value: string): boolean {
  return typeof value === 'string' && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validReasoningOverride(value: unknown): boolean {
  return value === null || isLlmReasoningEffort(value);
}

function validateFilesystemReferences(
  references: Extract<ConversationCommand, { type: 'message.submit' }>['filesystemReferences'],
): string | null {
  if (references === undefined) return null;
  if (!Array.isArray(references) || references.length > MAX_FILESYSTEM_REFERENCE_COUNT) {
    return `单次消息最多附加 ${MAX_FILESYSTEM_REFERENCE_COUNT} 个文件系统引用。`;
  }
  const referenceIds = new Set<string>();
  const targets = new Set<string>();
  for (const reference of references) {
    if (
      !reference
      || typeof reference !== 'object'
      || typeof reference.referenceId !== 'string'
      || !validProfileId(reference.referenceId)
      || referenceIds.has(reference.referenceId)
      || !validWorkspaceBinding({
        workspaceId: reference.workspaceId,
        displayName: reference.displayName,
      })
      || typeof reference.logicalPath !== 'string'
      || !validLogicalPath(reference.logicalPath)
      || targets.has(`${reference.workspaceId}\0${reference.logicalPath}`)
    ) {
      return '文件系统引用的 identity、workspace 或逻辑路径无效或重复。';
    }
    if (reference.kind === 'file') {
      if (
        reference.logicalPath === '.'
        || typeof reference.mediaType !== 'string'
        || !reference.mediaType.trim()
        || reference.mediaType.length > 128
        || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0
      ) return '文件引用的 kind、mediaType 或 byteLength 无效。';
    } else if (reference.kind === 'directory') {
      if (
        reference.logicalPath !== '.'
        || Object.hasOwn(reference, 'mediaType')
        || Object.hasOwn(reference, 'byteLength')
      ) return '目录引用必须指向 workspace 根且不能携带文件元数据。';
    } else {
      return '文件系统引用 kind 无效。';
    }
    referenceIds.add(reference.referenceId);
    targets.add(`${reference.workspaceId}\0${reference.logicalPath}`);
  }
  return null;
}

function validLogicalPath(value: string): boolean {
  if (!value || value.length > 4_096 || value.includes('\0') || value.includes('\\')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function defaultIdFactory(sessionId: string): (kind: string) => string {
  let next = 0;
  return (kind) => {
    next += 1;
    return `${sessionId}:${kind}:${Date.now().toString(36)}:${next.toString(36)}`;
  };
}
