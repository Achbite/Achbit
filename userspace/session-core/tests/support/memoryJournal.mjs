import { SESSION_EVENT_VERSION } from '@deepcode/protocol';
import { assertRuntimeContract } from './runtimeContract.mjs';
import { projectAgentLifecycleEvent } from '../../dist/local-agent/agentLifecycle.js';
import { projectRunLifecycleEvent } from '../../dist/local-agent/runLifecycle.js';

/** Test storage adapter. SQLite atomicity is verified by the store tests. */
export class InMemoryCommandJournal {
  #events = new Map();
  #commands = new Map();
  #tail = Promise.resolve();
  #eventCounter = 0;

  subscribePermissions() { return () => {}; }

  async createSession(input) {
    return await this.serial(async () => {
      if (this.#events.has(input.sessionId)) throw new Error('session_already_exists');
      this.#events.set(input.sessionId, []);
      return this.appendNow({
        type: 'session.created',
        sessionId: input.sessionId,
        payload: {
          displayTitle: input.displayTitle,
          ...(input.subagentSettings ? { subagentSettings: structuredClone(input.subagentSettings) } : {}),
          workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
          ...(input.recipe ? { recipe: structuredClone(input.recipe) } : {}),
          ...(input.profileId ? { profileId: input.profileId } : {}),
          ...(input.agentContext ? { agentContext: structuredClone(input.agentContext) } : {}),
        },
      });
    });
  }

  async deleteSession(sessionId) {
    await this.serial(async () => {
      if (!this.#events.delete(sessionId)) throw new Error('session_not_found');
      for (const key of [...this.#commands.keys()]) {
        if (key.startsWith(`${sessionId}\u0000`)) this.#commands.delete(key);
      }
    });
  }

  async append(event) {
    return await this.serial(async () => this.appendNow(event));
  }

  async appendBatch(events) {
    return await this.serial(async () => events.map((event) => this.appendNow(event)));
  }

  async *read(sessionId, afterSequence = 0) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    for (const event of events) {
      if (event.sequence > afterSequence) yield structuredClone(event);
    }
  }

  async readCommand(sessionId, commandId) {
    const stored = this.#commands.get(commandKey(sessionId, commandId));
    return stored ? structuredClone(stored) : null;
  }

  async readRunLifecycle(sessionId, afterSequence = 0) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    return { sessionId, revision: events.at(-1)?.sequence ?? 0,
      events: events.filter(event => event.sequence > afterSequence).flatMap(event => {
        const projected = projectRunLifecycleEvent(event);
        return projected ? [projected] : [];
      }),
    };
  }

  async readAgentLifecycle(sessionId) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    return { sessionId, revision: events.at(-1)?.sequence ?? 0,
      events: events.flatMap(event => { const value = projectAgentLifecycleEvent(event); return value ? [value] : []; }) };
  }

  async readProviderUsage(sessionId) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    return { sessionId, revision: events.at(-1)?.sequence ?? 0, events: events.flatMap(event => {
      if (!['provider.turn.settled', 'context.updated'].includes(event.type)) return [];
      return [{ sessionId, sequence: event.sequence, runId: event.runId, type: event.type,
        payload: event.type === 'context.updated' ? structuredClone(event.payload)
          : { providerRequestId: event.payload.providerRequestId } }];
    }) };
  }

  async commitCommand(
    command,
    events,
    reply,
  ) {
    return await this.serial(async () => {
      const key = commandKey(command.sessionId, command.commandId);
      if (this.#commands.has(key)) throw new Error('command_already_recorded');
      if (reply.status !== 'rejected') assertRuntimeContract('ConversationCommand', command);
      const committed = events.map(event => this.appendNow(event));
      const revision = this.#events.get(command.sessionId)?.at(-1)?.sequence ?? 0;
      const admitted = { ...reply, revision };
      this.#commands.set(key, {
        command: structuredClone(command),
        reply: structuredClone(admitted),
      });
      return { reply: admitted, events: committed };
    });
  }

  appendNow(event) {
    const events = this.#events.get(event.sessionId);
    if (!events) throw new Error('session_not_found');
    const sequence = events.length + 1;
    this.#eventCounter += 1;
    const committed = {
      ...event,
      schemaVersion: SESSION_EVENT_VERSION,
      eventId: `event:${this.#eventCounter}`,
      sequence,
      occurredAt: new Date().toISOString(),
    };
    assertRuntimeContract('SessionEvent', committed);
    events.push(committed);
    return structuredClone(committed);
  }

  async serial(operation) {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function commandKey(sessionId, commandId) {
  return `${sessionId}\u0000${commandId}`;
}
