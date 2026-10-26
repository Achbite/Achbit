import type { SessionObservationSink } from './observation.js';
import { decodeAgentRecipe, decodeAgentSettings } from '@achbit/protocol';
import { agentPresets } from './agentConfiguration.js';
import { reduceAgentLifecycle } from './agentLifecycle.js';
import { AgentManager, type AgentManagementSnapshot } from './agentManager.js';
import { admitSessionEvents } from './admission.js';
import { loopSnapshot } from './loop.js';
import type {
  AgentHostPort,
  AgentSettings,
  SessionCreationInput,
  CommandJournalPort,
  CommandReply,
  ContextCompositionProjection,
  ConversationCommand,
  ConversationPort,
  ConversationReadResult,
  ConversationSessionStatus,
  SessionProjection,
  SessionResourceProjection,
  PendingAgentDecision,
  WorkspaceBindingDisplay,
} from '@achbit/protocol';
import { SessionActor } from './actor.js';
import type { AgentComposition, SessionCapabilities } from './plugins.js';
import { decodeConversationReadQuery, readConversation, readSessionEvents } from './conversationRead.js';
import { combineTokenUsage, projectSession, projectResourceTool, providerUsageFromEvents, recoverSession } from './reducer.js';
import { projectSessionResources } from './resourceProjection.js';
import { activeConversationEvents } from './conversationHistory.js';
import { emptyRunLifecycle, reduceRunLifecycle, type RunLifecycleState } from './runLifecycle.js';
import { SessionConfigurationRegistry } from './sessionConfiguration.js';
import { AgentLoopRegistry } from './loopRegistry.js';
import { LoopFailure } from './loopFailure.js';

function isMissingSession(error: unknown): boolean {
  // HTTP Journal errors carry a code separate from their localized message.
  return (error instanceof LoopFailure ? error.code : error instanceof Error ? error.message.split(':', 1)[0] : null)
    === 'session_not_found';
}

export interface SessionCompositionFactory {
  create(input: {
    sessionId: string;
    workspaceBindings: readonly WorkspaceBindingDisplay[];
  }): Promise<{
    composition: AgentComposition;
  }>;
}

/** Complete Host-facing surface; a service implementation is selected only at startup. */
export interface SessionServicePort extends ConversationPort {
  createSession: SessionService['createSession'];
  deleteSession: SessionService['deleteSession'];
  snapshot: SessionService['snapshot'];
  statuses: SessionService['statuses'];
  activity: SessionService['activity'];
  contextComposition: SessionService['contextComposition'];
  read: SessionService['read'];
  replaceCapabilities: SessionService['replaceCapabilities'];
  dispose(): Promise<void>;
}

export type SessionServiceFactory = (input: {
  journal: CommandJournalPort;
  compositions: SessionCompositionFactory;
  agentHost?: AgentHostPort;
  configurations?: SessionConfigurationRegistry;
  loops?: AgentLoopRegistry;
  observation?: SessionObservationSink;
}) => Promise<SessionServicePort>;

export const createSessionService: SessionServiceFactory = async ({ journal, compositions, agentHost, configurations, loops, observation }) => (
  new SessionService(journal, compositions, agentHost, configurations, loops, observation)
);

export class SessionDeletionError extends AggregateError {
  readonly details: { deletedSessionIds: string[]; remainingSessionIds: string[] };
  constructor(error: unknown, deletedSessionIds: readonly string[], remainingSessionIds: readonly string[]) {
    super([error], `session_delete_partial:${error instanceof Error ? error.message : String(error)}`);
    this.details = { deletedSessionIds: [...deletedSessionIds], remainingSessionIds: [...remainingSessionIds] };
  }
}

export class SessionService implements ConversationPort {
  readonly #actors = new Map<string, Promise<SessionActor>>();
  readonly #actorUsers = new Map<string, number>();
  readonly #retirements = new Map<string, Promise<void>>();
  readonly #statusStates = new Map<string, { revision: number; lifecycle: RunLifecycleState }>();
  readonly #historyReads = new Map<string, Promise<SessionProjection>>();
  readonly #resourceReads = new Map<string, Promise<SessionResourceProjection>>();
  readonly #deletingSessionIds = new Set<string>();
  readonly #submissions = new Map<string, Set<Promise<CommandReply>>>();
  readonly #lifetime = new AbortController();
  #disposeTask?: Promise<void>;
  #defaultWrites: Promise<void> = Promise.resolve();
  readonly #agents?: AgentManager;

  constructor(
    readonly journal: CommandJournalPort,
    readonly compositions: SessionCompositionFactory,
    readonly agentHost?: AgentHostPort,
    readonly configurations = new SessionConfigurationRegistry(),
    readonly loops = new AgentLoopRegistry(),
    readonly observation?: SessionObservationSink,
  ) {
    if (agentHost) this.#agents = new AgentManager(agentHost, {
      withActor: (id, operation) => this.withActor(id, operation),
      read: id => this.agentManagement(id),
    }, configurations, loops);
  }

  async createSession(input: SessionCreationInput): Promise<SessionProjection> {
    this.assertOpen();
    if (input.agentContext && !input.subagentSettings) throw new Error('agent_settings_missing');
    const selectedSettings = input.subagentSettings ?? (this.agentHost ? await this.agentHost.settings() : undefined);
    if (selectedSettings !== undefined) {
      const subagentSettings = decodeAgentSettings(selectedSettings);
      agentPresets(subagentSettings);
      input = { ...input, subagentSettings };
    }
    if (input.recipe) {
      const recipe = decodeAgentRecipe(input.recipe);
      if (input.profileId && recipe.profileId && input.profileId !== recipe.profileId) throw new Error('agent_recipe_model_conflict');
      if (recipe.configuration) this.configurations.resolve(recipe.configuration, {}, true);
      if (recipe.runner) this.loops.validate(recipe.runner);
      if (input.agentContext?.configuration && recipe.configuration
        && JSON.stringify(input.agentContext.configuration) !== JSON.stringify(recipe.configuration)) throw new Error('session_configuration_owner_conflict');
      input = { ...input, recipe, profileId: input.profileId ?? recipe.profileId };
    }
    admitSessionEvents(loopSnapshot(input.sessionId, []), [{
      type: 'session.created', sessionId: input.sessionId,
      payload: { displayTitle: input.displayTitle, workspaceBindings: input.workspaceBindings,
        ...(input.subagentSettings ? { subagentSettings: input.subagentSettings } : {}),
        ...(input.recipe ? { recipe: input.recipe } : {}),
        ...(input.agentContext ? { agentContext: input.agentContext } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}) },
    }]);
    await this.journal.createSession({
      sessionId: input.sessionId,
      displayTitle: input.displayTitle,
      ...(input.subagentSettings ? { subagentSettings: input.subagentSettings } : {}),
      ...(input.recipe ? { recipe: input.recipe } : {}),
      workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
      ...(input.agentContext ? { agentContext: structuredClone(input.agentContext) } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
    });
    try {
      return await this.withActor(input.sessionId, actor => actor.snapshot(), false);
    } catch (error) {
      try {
        await this.deleteSession(input.sessionId, { unstartedOnly: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          `session_creation_rollback_failed:${error instanceof Error ? error.message : String(error)}; cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw error;
    }
  }

  private publishSubagentDefaults(settings: AgentSettings): Promise<void> {
    const task = this.#defaultWrites.then(() => this.agentHost!.saveDefaults(structuredClone(settings)));
    this.#defaultWrites = task.catch(() => undefined);
    return task.catch(error => {
      throw new Error(`subagent_defaults_update_failed: Session settings were saved; new-session defaults were not updated. Submit a new explicit settings command to try again. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
  }

  async deleteSession(sessionId: string, options?: { unstartedOnly?: boolean }): Promise<{ deletedSessionIds: string[] }> {
    this.assertOpen();
    if (this.#deletingSessionIds.has(sessionId)) throw new Error('session_delete_in_progress');
    const claimed = new Set<string>([sessionId]);
    this.#deletingSessionIds.add(sessionId);
    let releaseOwner: (() => void) | undefined;
    const deletedSessionIds: string[] = [];
    const deletionOrder: string[] = [];
    const readStored = async (id: string, required: boolean): Promise<SessionProjection | undefined> => {
      let events;
      try { events = await readSessionEvents(this.journal, id); }
      catch (error) {
        if (!required && isMissingSession(error)) return;
        throw error;
      }
      if (!events.length) {
        if (required) throw new Error('session_not_found');
        return;
      }
      return projectSession(recoverSession(id, events));
    };
    try {
      if (options?.unstartedOnly) {
        await Promise.allSettled(this.#submissions.get(sessionId) ?? []);
        const events = await readSessionEvents(this.journal, sessionId);
        if (events.some(event => event.type === 'run.started'
          || event.type.startsWith('agent.task.') || event.type === 'agent.closed')) {
          throw new Error('session_rollback_already_started');
        }
        deletionOrder.push(sessionId);
      } else {
        const initial = (await readStored(sessionId, true))!;
        const ownerId = initial.agentContext?.ownerSessionId ?? sessionId;
        releaseOwner = await this.#agents?.blockOwner(ownerId);
        const visited = new Set<string>();
        const visit = async (id: string, parentId?: string): Promise<void> => {
          if (visited.has(id)) return;
          const projection = await readStored(id, id === sessionId);
          // A failed creation can leave a task fact without ever creating a child Session.
          if (!projection) return;
          if (parentId && (projection.agentContext?.parentSessionId !== parentId
            || projection.agentContext.ownerSessionId !== ownerId)) return;
          visited.add(id);
          if (!claimed.has(id)) {
            if (this.#deletingSessionIds.has(id)) throw new Error('session_delete_in_progress');
            this.#deletingSessionIds.add(id);
            claimed.add(id);
          }
          const children = new Set((projection.agentChildren ?? []).map(child => child.agentSessionId));
          for (const childId of children) await visit(childId, id);
          deletionOrder.push(id);
        };
        await visit(sessionId);
        await Promise.allSettled(deletionOrder.flatMap(id => [...(this.#submissions.get(id) ?? [])]));
        for (const id of deletionOrder) {
          const projection = (await readStored(id, true))!;
          if (projection.run && ['running', 'waiting', 'releasing', 'releaseFailed'].includes(projection.run.status)) {
            throw new Error(`session_delete_active_run:${id}`);
          }
        }
      }
      for (const id of deletionOrder) {
        const actorPromise = this.#actors.get(id);
        if (actorPromise) {
          let actor: SessionActor | undefined;
          try { actor = await actorPromise; }
          catch (error) {
            if (this.#actors.get(id) === actorPromise) this.#actors.delete(id);
            if (isActorOpenRollbackFailure(error)) throw error;
          }
          if (actor) {
            await actor.dispose();
            if (this.#actors.get(id) === actorPromise) this.#actors.delete(id);
          }
        }
        this.assertOpen();
        await this.journal.deleteSession(id);
        this.#statusStates.delete(id);
        deletedSessionIds.push(id);
      }
      return { deletedSessionIds };
    } catch (error) {
      if (!deletedSessionIds.length) throw error;
      const remainingSessionIds = deletionOrder.filter(id => !deletedSessionIds.includes(id));
      throw new SessionDeletionError(error, deletedSessionIds, remainingSessionIds);
    } finally {
      releaseOwner?.();
      for (const id of claimed) this.#deletingSessionIds.delete(id);
    }
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    if (command.type === 'session.subagent-settings.set' && !this.agentHost) throw new Error('agent_settings_host_unavailable');
    if (this.#deletingSessionIds.has(command.sessionId)) throw new Error('session_delete_in_progress');
    return this.withActor(command.sessionId, async actor => {
      this.assertOpen();
      const projection = await actor.agentSnapshot();
      if (projection.agentContext && ['message.submit', 'message.edit', 'context.focus', 'session.model-settings.set', 'run.host.rebind'].includes(command.type)) {
        throw new Error('agent_session_requires_managed_task');
      }
      if (this.#deletingSessionIds.has(command.sessionId)) throw new Error('session_delete_in_progress');
      const pending = actor.submit(command);
      let submissions = this.#submissions.get(command.sessionId);
      if (!submissions) {
        submissions = new Set();
        this.#submissions.set(command.sessionId, submissions);
      }
      submissions.add(pending);
      try {
        const reply = await pending;
        if (command.type === 'session.subagent-settings.set' && reply.status === 'accepted') {
          await this.publishSubagentDefaults(command.settings);
        }
        return reply;
      }
      finally {
        submissions.delete(pending);
        if (!submissions.size) this.#submissions.delete(command.sessionId);
      }
    });
  }

  /** Same-process operator API; control calls and conversation commands cannot install code. */
  async replaceCapabilities(sessionId: string, implementation: SessionCapabilities): Promise<void> {
    await this.withActor(sessionId, actor => actor.replaceCapabilities(implementation));
  }

  async resourceSnapshot(sessionId: string, recordIds: readonly string[] = []): Promise<SessionResourceProjection> {
    const key = JSON.stringify([sessionId, recordIds]);
    let pending = this.#resourceReads.get(key);
    if (!pending) {
      pending = (async () => {
        const read = await this.journal.readResources(sessionId, recordIds);
        if (read.sessionId !== sessionId) throw new Error('session_event_identity_mismatch');
        return projectSessionResources(read, recordIds, projectResourceTool);
      })();
      this.#resourceReads.set(key, pending);
    }
    // Share overlapping previews only; later reads must see fresh facts/errors.
    try { return structuredClone(await pending); }
    finally { if (this.#resourceReads.get(key) === pending) this.#resourceReads.delete(key); }
  }

  async snapshot(sessionId: string): Promise<SessionProjection> {
    const projection = await this.ownSnapshot(sessionId);
    const ownerSessionId = projection.agentContext?.ownerSessionId ?? sessionId;
    const seen = new Set<string>([sessionId]);
    let totalTokenUsage = projection.tokenUsage;
    const visit = async (parent: { sessionId: string; agentChildren?: AgentManagementSnapshot['agentChildren'];
      agentTasks?: AgentManagementSnapshot['agentTasks'] }): Promise<void> => {
      for (const member of parent.agentChildren ?? []) {
        if (seen.has(member.agentSessionId)) continue;
        seen.add(member.agentSessionId);
        let child: AgentManagementSnapshot;
        try { child = await this.agentManagement(member.agentSessionId); }
        catch (error) {
          // A task reservation precedes child creation; failed creation can leave no Session.
          const started = parent.agentTasks?.some(task => task.agentSessionId === member.agentSessionId && task.childRunId);
          if (!started && isMissingSession(error)) continue;
          throw error;
        }
        if (child.agentContext?.parentSessionId !== parent.sessionId
          || child.agentContext.ownerSessionId !== ownerSessionId) throw new Error('agent_lineage_mismatch');
        // Each own aggregate already accounts for each Provider request exactly once.
        // Follow creation identities, never tasks or recursively aggregated snapshots.
        const read = await this.journal.readProviderUsage(child.sessionId);
        if (read.sessionId !== child.sessionId) throw new Error('session_event_identity_mismatch');
        totalTokenUsage = combineTokenUsage(totalTokenUsage, providerUsageFromEvents(read));
        await visit(child);
      }
    };
    await visit(projection);
    const pendingAgentDecisions = await this.agentDecisionRoutes(projection);
    return { ...projection, totalTokenUsage, ...(pendingAgentDecisions.length ? { pendingAgentDecisions } : {}) };
  }

  private async ownSnapshot(sessionId: string): Promise<SessionProjection> {
    if (this.#retirements.has(sessionId)) await this.#retirements.get(sessionId);
    const live = this.#actors.get(sessionId);
    if (live) return await this.withActor(sessionId, actor => actor.snapshot());
    let pending = this.#historyReads.get(sessionId);
    if (!pending) {
      pending = (async () => {
        // Coalesce overlapping Reader roots/watch/read requests only. Once this
        // read finishes the next request returns to the journal, preserving read
        // errors and malformed-history diagnostics rather than trusting old data.
        return projectSession(recoverSession(sessionId, await readSessionEvents(this.journal, sessionId)));
      })();
      this.#historyReads.set(sessionId, pending);
    }
    try { return structuredClone(await pending); }
    finally { if (this.#historyReads.get(sessionId) === pending) this.#historyReads.delete(sessionId); }
  }

  private async agentDecisionRoutes(parent: Pick<SessionProjection, 'sessionId' | 'agentContext' | 'agentTasks'>): Promise<PendingAgentDecision[]> {
    const decisions: PendingAgentDecision[] = [];
    const ownerSessionId = parent.agentContext?.ownerSessionId ?? parent.sessionId;
    const seen = new Set<string>([parent.sessionId]);
    const visit = async (owner: { sessionId: string; agentTasks?: AgentManagementSnapshot['agentTasks'] }) => {
      for (const task of owner.agentTasks ?? []) {
        if (task.status !== 'running' || !task.childRunId || seen.has(task.agentSessionId)) continue;
        seen.add(task.agentSessionId);
        const child = await this.agentManagement(task.agentSessionId);
        if (child.agentContext?.ownerSessionId !== ownerSessionId) throw new Error('agent_lineage_mismatch');
        // A continuation can be assigned by an ancestor other than the creating parent.
        // The current task/run owns its decision route; the creation tree still owns archival.
        if (child.run?.runId !== task.childRunId) continue;
        const lifecycle = this.#statusStates.get(child.sessionId)!.lifecycle;
        const plan = child.run.status === 'waiting' && lifecycle.pendingPlan?.runId === task.childRunId ? lifecycle.pendingPlan : null;
        const approval = lifecycle.pendingApproval?.runId === task.childRunId ? lifecycle.pendingApproval : null;
        const interactionIds = lifecycle.pendingInteractions.filter(item => item.runId === task.childRunId).map(item => item.interactionId);
        if (plan || approval || interactionIds.length) decisions.push({ agentSessionId: child.sessionId,
          displayName: task.displayName, runId: task.childRunId, interactionIds,
          ...(plan ? { plan: { planId: plan.planId, revision: plan.revision } } : {}),
          ...(approval ? { approval: { approvalId: approval.approvalId, callId: approval.callId } } : {}) });
        await visit(child);
      }
    };
    await visit(parent);
    return decisions;
  }

  async activity(): Promise<{ active: boolean }> {
    // Observe existing objects only; an idle read must never reopen a retiring child.
    const activity = await Promise.all([...this.#actors.values()].map(async pending =>
      (await pending).hasActiveWork()));
    return { active: activity.some(Boolean) };
  }

  async statuses(sessionIds: readonly string[]): Promise<ConversationSessionStatus[]> {
    return await Promise.all(sessionIds.map(async (sessionId) => {
      // This cache contains no message, tool result, runtime or Actor state.
      const previous = this.#statusStates.get(sessionId);
      let read = await this.journal.readRunLifecycle(sessionId, previous?.revision ?? 0);
      let lifecycle = previous?.lifecycle ?? emptyRunLifecycle();
      if (read.events.some(event => event.type === 'conversation.revised')) {
        if (previous) read = await this.journal.readRunLifecycle(sessionId);
        lifecycle = emptyRunLifecycle();
      }
      if (read.sessionId !== sessionId) throw new Error('session_event_identity_mismatch');
      for (const event of activeConversationEvents(read.events)) {
        if (event.sessionId !== sessionId) throw new Error('session_event_identity_mismatch');
        lifecycle = reduceRunLifecycle(lifecycle, event);
      }
      const state = { revision: read.revision, lifecycle };
      if (state.revision === 0) throw new Error('session_not_found');
      if (state.revision >= (this.#statusStates.get(sessionId)?.revision ?? 0)) {
        this.#statusStates.set(sessionId, state);
      }
      return {
        sessionId, revision: state.revision,
        run: lifecycle.run ? { ...lifecycle.run } : null,
      };
    }));
  }

  async contextComposition(sessionId: string, providerRequestId: string): Promise<ContextCompositionProjection> {
    const state = recoverSession(sessionId, await readSessionEvents(this.journal, sessionId));
    const receipt = state.contextCompositions.find((item) => item.providerRequestId === providerRequestId);
    if (!receipt) throw new Error('context_composition_not_found');
    return structuredClone(receipt);
  }

  async read(input: unknown): Promise<ConversationReadResult> {
    const query = decodeConversationReadQuery(input);
    if (query.view === 'reasoning' && query.providerRequestId && this.#actors.has(query.sessionId)) {
      const actor = await this.#actors.get(query.sessionId)!;
      const projection = await actor.snapshot();
      if (projection.assistantDraft?.turnId === query.providerRequestId) {
        return { sessionId: query.sessionId, revision: projection.revision, view: 'reasoning',
          items: [actor.liveReasoning.read(query.providerRequestId)], nextBefore: null };
      }
    }
    return await readConversation(this.journal, query);
  }

  dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    this.#lifetime.abort(new Error('session_service_disposed'));
    this.#disposeTask = this.disposeActors();
    return this.#disposeTask;
  }

  private async disposeActors(): Promise<void> {
    let agentError: unknown;
    try { await this.#agents?.dispose(); } catch (error) { agentError = error; }
    const actorPromises = [...this.#actors.values()];
    const results = await Promise.allSettled(actorPromises.map(async pending => {
      let actor: SessionActor;
      try {
        actor = await pending;
      } catch (error) {
        if (error !== this.#lifetime.signal.reason) throw error;
        return;
      }
      await actor.dispose();
    }));
    await this.#defaultWrites;
    this.#actors.clear();
    this.#statusStates.clear();
    const errors = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (agentError) errors.unshift(agentError);
    if (errors.length > 0) throw new AggregateError(errors, 'session_service_dispose_failed');
  }

  /** Journal-only management reads do not activate Providers, tools or Actors. */
  private async agentManagement(sessionId: string): Promise<AgentManagementSnapshot> {
    const read = await this.journal.readAgentLifecycle(sessionId);
    if (read.sessionId !== sessionId || read.events.some(event => event.sessionId !== sessionId)) {
      throw new Error('session_event_identity_mismatch');
    }
    if (read.events[0]?.type !== 'session.created') throw new Error('session_creation_event_missing');
    let relations = { agentTasks: [], agentChildren: [] } as import('./agentLifecycle.js').AgentLifecycleState;
    for (const event of read.events) if (event.type !== 'session.created') relations = reduceAgentLifecycle(relations, event);
    const [status] = await this.statuses([sessionId]);
    return { sessionId, agentContext: read.events[0].payload.agentContext, ...relations, run: status!.run };
  }

  /** Physical references only; durable ownership remains in the Session journal. */
  private async withActor<T>(sessionId: string, operation: (actor: SessionActor) => Promise<T>, retire = true): Promise<T> {
    while (this.#retirements.has(sessionId)) await this.#retirements.get(sessionId);
    this.#actorUsers.set(sessionId, (this.#actorUsers.get(sessionId) ?? 0) + 1);
    let failure: unknown;
    try {
      const actor = await (this.#actors.get(sessionId) ?? this.actor(sessionId));
      return await operation(actor);
    } catch (error) { failure = error; throw error; }
    finally {
      const users = this.#actorUsers.get(sessionId)! - 1;
      if (users) this.#actorUsers.set(sessionId, users);
      else {
        this.#actorUsers.delete(sessionId);
        const pending = this.#actors.get(sessionId);
        if (pending && retire) {
          const retirement = (async () => {
            const actor = await pending;
            if (await actor.retireIfSettledChild() && this.#actors.get(sessionId) === pending) this.#actors.delete(sessionId);
          })();
          this.#retirements.set(sessionId, retirement);
          try { await retirement; }
          catch (error) {
            if (failure) throw new AggregateError([failure, error], 'session_actor_operation_cleanup_failed');
            throw error;
          } finally {
            if (this.#retirements.get(sessionId) === retirement) this.#retirements.delete(sessionId);
          }
        }
      }
    }
  }

  private async actor(sessionId: string): Promise<SessionActor> {
    this.assertOpen();
    let actor = this.#actors.get(sessionId);
    if (!actor) {
      actor = this.openActor(sessionId);
      this.#actors.set(sessionId, actor);
      void actor.catch(() => {
        if (this.#actors.get(sessionId) === actor) this.#actors.delete(sessionId);
      });
    }
    return await actor;
  }

  private async openActor(sessionId: string): Promise<SessionActor> {
    this.assertOpen();
    const events = await readSessionEvents(this.journal, sessionId);
    this.assertOpen();
    const first = events[0];
    if (!first) throw new Error('session_not_found');
    if (first.type !== 'session.created') throw new Error('session_creation_event_missing');
    const profileId = first.payload.profileId;
    const installed = await this.compositions.create({
      sessionId,
      workspaceBindings: first.payload.workspaceBindings.map((binding) => ({ ...binding })),
    });
    const configuration = first.payload.recipe?.configuration ?? first.payload.agentContext?.configuration;
    try {
      if (configuration) {
        if (installed.composition.capabilities) throw new Error('session_configuration_owner_conflict');
        installed.composition.capabilities = await this.configurations.create(configuration);
      }
      if (first.payload.recipe?.runner) {
        if (installed.composition.runner) throw new Error('session_loop_owner_conflict');
        installed.composition.runner = this.loops.create(first.payload.recipe.runner);
      }
    } catch (error) {
      const cleanup = await Promise.allSettled([installed.composition.capabilities?.dispose(),
        installed.composition.runner?.dispose?.(), installed.composition.dispose()]);
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], 'session_configuration_initialization_failed');
      throw error;
    }
    const actor = new SessionActor(sessionId, this.journal, installed.composition, {
      initialEvents: events,
      ...(this.observation ? { observation: {
        accept: input => this.observation!.accept({ ...input, parentSessionId: first.payload.agentContext?.parentSessionId ?? null }),
        failed: (id, error) => this.observation!.failed(id, error),
      } satisfies SessionObservationSink } : {}),
      ...(this.#agents ? { agents: this.#agents.forSession(sessionId) } : {}),
      ...(profileId ? { profileId } : {}),
    });
    try {
      this.assertOpen();
      await actor.recover(this.#lifetime.signal);
      this.assertOpen();
      return actor;
    } catch (error) {
      try {
        await actor.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'session_actor_open_rollback_failed',
        );
      }
      throw error;
    }
  }

  private assertOpen(): void {
    this.#lifetime.signal.throwIfAborted();
  }
}

function isActorOpenRollbackFailure(error: unknown): boolean {
  return error instanceof AggregateError && error.message === 'session_actor_open_rollback_failed';
}
