import { SESSION_EVENT_VERSION } from '@deepcode/protocol';
import { assertRuntimeContract } from './runtimeContract.mjs';
import { projectRunLifecycleEvent } from '../../dist/local-agent/runLifecycle.js';

/** Test storage adapter. SQLite atomicity is verified by the store tests. */
export class InMemoryCommandJournal {
  #events = new Map();
  #commands = new Map();
  #tail = Promise.resolve();
  #eventCounter = 0;

  async createSession(input) {
    return await this.serial(async () => {
      if (this.#events.has(input.sessionId)) throw new Error('session_already_exists');
      this.#events.set(input.sessionId, []);
      return this.appendNow({
        type: 'session.created',
        sessionId: input.sessionId,
        payload: {
          displayTitle: input.displayTitle,
          workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
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

  async commitCommand(
    command,
    events,
    reply,
  ) {
    return await this.serial(async () => {
      const key = commandKey(command.sessionId, command.commandId);
      if (this.#commands.has(key)) throw new Error('command_already_recorded');
      if (reply.status !== 'rejected') assertRuntimeContract('ConversationCommand', command);
      for (const event of events) this.appendNow(event);
      const revision = this.#events.get(command.sessionId)?.at(-1)?.sequence ?? 0;
      const admitted = { ...reply, revision };
      this.#commands.set(key, {
        command: structuredClone(command),
        reply: structuredClone(admitted),
      });
      return admitted;
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
