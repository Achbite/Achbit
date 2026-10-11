import { admitSessionEvents } from './admission.js';
import { loopSnapshot } from './loop.js';
import type {
  CommandJournalPort,
  CommandReply,
  ContextCompositionProjection,
  ConversationCommand,
  ConversationPort,
  ConversationReadResult,
  ConversationSessionStatus,
  SessionProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { SessionActor } from './actor.js';
import type { AgentComposition, SessionCapabilities } from './plugins.js';
import { decodeConversationReadQuery, readConversation, readSessionEvents } from './conversationRead.js';
import { emptySessionState, projectSession, recoverSession, reduceSession, type SessionState } from './reducer.js';

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
}) => Promise<SessionServicePort>;

export const createSessionService: SessionServiceFactory = async ({ journal, compositions }) => (
  new SessionService(journal, compositions)
);

export class SessionService implements ConversationPort {
  readonly #actors = new Map<string, Promise<SessionActor>>();
  readonly #statusStates = new Map<string, SessionState>();
  readonly #lifetime = new AbortController();
  #disposeTask?: Promise<void>;

  constructor(
    readonly journal: CommandJournalPort,
    readonly compositions: SessionCompositionFactory,
  ) {}

  async createSession(input: {
    sessionId: string;
    displayTitle: string;
    workspaceBindings: WorkspaceBindingDisplay[];
    profileId?: string;
  }): Promise<SessionProjection> {
    this.assertOpen();
    admitSessionEvents(loopSnapshot(input.sessionId, []), [{
      type: 'session.created', sessionId: input.sessionId,
      payload: { displayTitle: input.displayTitle, workspaceBindings: input.workspaceBindings,
        ...(input.profileId ? { profileId: input.profileId } : {}) },
    }]);
    await this.journal.createSession({
      sessionId: input.sessionId,
      displayTitle: input.displayTitle,
      workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
      ...(input.profileId ? { profileId: input.profileId } : {}),
    });
    const actor = await this.actor(input.sessionId);
    return await actor.snapshot();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen();
    const actorPromise = this.#actors.get(sessionId);
    if (actorPromise) {
      let actor: SessionActor | undefined;
      try {
        actor = await actorPromise;
      } catch (error) {
        if (this.#actors.get(sessionId) === actorPromise) this.#actors.delete(sessionId);
        if (isActorOpenRollbackFailure(error)) throw error;
      }
      if (actor) {
        if (!actor.hasLoopFailure()) {
          const projection = await actor.snapshot();
          if (projection.run && ['running', 'waiting'].includes(projection.run.status)) {
            throw new Error('session_delete_active_run');
          }
        }
        await actor.dispose();
        if (this.#actors.get(sessionId) === actorPromise) this.#actors.delete(sessionId);
      }
    }
    this.assertOpen();
    await this.journal.deleteSession(sessionId);
    this.#statusStates.delete(sessionId);
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    const actor = await this.actor(command.sessionId);
    this.assertOpen();
    return await actor.submit(command);
  }

  /** Same-process operator API; control calls and conversation commands cannot install code. */
  async replaceCapabilities(sessionId: string, implementation: SessionCapabilities): Promise<void> {
    const actor = await this.actor(sessionId);
    this.assertOpen();
    await actor.replaceCapabilities(implementation);
  }

  async snapshot(sessionId: string): Promise<SessionProjection> {
    const live = this.#actors.get(sessionId);
    if (live) return (await live).snapshot();
    const events = await readSessionEvents(this.journal, sessionId);
    if (!events.length) throw new Error('session_not_found');
    return projectSession(recoverSession(sessionId, events));
  }

  async activity(): Promise<{ active: boolean }> {
    const actors = await Promise.all(this.#actors.values());
    const activity = await Promise.all(actors.map((actor) => actor.hasActiveWork()));
    return { active: activity.some(Boolean) };
  }

  async statuses(sessionIds: readonly string[]): Promise<ConversationSessionStatus[]> {
    return await Promise.all(sessionIds.map(async (sessionId) => {
      // Reuse the canonical reducer and read only new events after the first read.
      // Sidebar reads must not open Actors or resume waiting/running conversations.
      let state = this.#statusStates.get(sessionId) ?? emptySessionState(sessionId);
      for await (const event of this.journal.read(sessionId, state.revision)) {
        if (event.type === 'conversation.revised') {
          state = recoverSession(sessionId, await readSessionEvents(this.journal, sessionId));
          break;
        }
        state = reduceSession(state, event);
      }
      if (state.revision === 0) throw new Error('session_not_found');
      if (state.revision >= (this.#statusStates.get(sessionId)?.revision ?? 0)) {
        this.#statusStates.set(sessionId, state);
      }
      return {
        sessionId, revision: state.revision,
        run: state.run ? {
          runId: state.run.runId,
          status: state.run.status,
          ...(state.run.waitingReason ? { waitingReason: state.run.waitingReason } : {}),
        } : null,
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
    const actorPromises = [...this.#actors.values()];
    this.#actors.clear();
    this.#statusStates.clear();
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
    const errors = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (errors.length > 0) throw new AggregateError(errors, 'session_service_dispose_failed');
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
    const actor = new SessionActor(sessionId, this.journal, installed.composition, {
      initialEvents: events,
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
