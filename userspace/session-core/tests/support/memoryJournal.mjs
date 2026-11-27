import { SESSION_EVENT_VERSION } from '@achbit/protocol';
import { assertRuntimeContract } from './runtimeContract.mjs';
import { projectAgentLifecycleEvent } from '../../dist/local-agent/agentLifecycle.js';
import { projectRunLifecycleEvent } from '../../dist/local-agent/runLifecycle.js';
import { projectResourceEvent } from '../../dist/local-agent/resourceProjection.js';

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

  async assertSessionsDeletable() {} // This in-memory adapter owns no physical runtime.

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

  async readTranscriptFacts(sessionId, around, knownTip) {
    const all = this.#events.get(sessionId);
    if (!all?.length) throw new Error('session_not_found');
    const revision = all.at(-1).sequence, anchor = around ?? revision;
    if (!Number.isSafeInteger(anchor) || anchor < 1 || anchor > revision) throw new Error('conversation_read_anchor_not_found');
    const tip = revision + ':' + all.at(-1).eventId;
    if (knownTip === tip) return null;
    const edits = all.filter(e => e.type === 'conversation.revised').map(e => e.payload);
    const user = all.filter(e => e.type === 'message.committed' && e.payload.role === 'user'
      && !edits.some(r => r.fromSequence <= e.sequence && e.sequence <= r.throughSequence));
    const starts = user.filter(e => !e.runId).map(e => e.sequence);
    const index = Math.max(0, starts.findLastIndex(sequence => sequence <= anchor));
    const start = index ? starts[index] : 1, next = starts[index+1] ?? null, end = next === null ? revision : next-1;
    const within = e => e.sequence >= start && e.sequence <= end;
    const committed = new Set(user.map(e => e.payload.messageId));
    const pageUsers = new Set(user.filter(within).map(e => e.payload.messageId));
    const queued = all.filter(e => next === null && e.sequence < start && e.type === 'input.queued'
      && !committed.has(e.payload.messageId) && !edits.some(r => r.fromSequence <= e.sequence && e.sequence <= r.throughSequence));
    const queuedRuns = new Set(queued.map(e => e.runId));
    return { tip, sessionId, revision, start, end, previous: starts[index-1] ?? null, next,
      navigation: user.map(e => ({key:e.payload.messageId,sequence:e.sequence,label:e.payload.content?.trim().slice(0,180) || e.payload.filesystemReferences?.[0]?.displayName || ''})),
      compositions: all.filter(e => within(e) && e.type === 'context.composed').map(e => ({sequence:e.sequence,runId:e.runId,providerRequestId:e.payload.providerRequestId,purpose:e.payload.purpose})),
      events: structuredClone(all.filter(e => e.type !== 'context.composed' && (within(e) || e.type === 'session.created' || e.type === 'conversation.revised'
        || (e.sequence < start && e.type === 'input.accepted' && pageUsers.has(e.payload.messageId))
        || queued.includes(e) || (e.sequence < start && e.type === 'run.settled' && queuedRuns.has(e.runId))
        || e.type.startsWith('plan.') || projectAgentLifecycleEvent(e) || e.type === 'message.feedback.updated'
        || (e.sequence < start && ['session.workspaces.updated','session.directory-index.attached','session.directory-index.detached','session.model-settings.updated','session.subagent-settings.updated','session.mode.updated'].includes(e.type))))),
    };
  }

  async readOverviewFacts(sessionId) {
    const all = this.#events.get(sessionId);
    if (!all?.length) throw new Error('session_not_found');
    const events = all.flatMap(e => {
      switch (e.type) {
        case 'context.updated': case 'conversation.revised': case 'todo.updated': case 'artifacts.presented': return [e];
        case 'provider.turn.settled': return [{...e,payload:{providerRequestId:e.payload.providerRequestId,purpose:e.payload.purpose,
          hosted:!!(e.payload.hostedWebSearchCalls?.length || e.payload.orderedOutputBlocks?.some(b=>b.item.type==='web_search_call'))}}];
        case 'message.committed':return e.payload.role==='assistant' ? [{...e,payload:{}}] : [];
        case 'tool.completed':return e.payload.record.output?.artifacts ? [e] : [];
        case 'run.started':return [{...e,payload:{boundary:e.payload.contextStart?.historyThroughSequence ?? null}}];
        case 'run.settled':return [{...e,payload:{outcome:e.payload.outcome}}];
        default:return [];
      }
    });
    return {sessionId,revision:all.at(-1).sequence,events:structuredClone(events)};
  }

  async readRunInput(sessionId, startSequence) {
    const events = this.#events.get(sessionId) ?? [];
    const start = events.find(e => e.sequence === startSequence && e.type === 'run.started');
    const message = events.findLast(e => e.sequence < startSequence && e.type === 'message.committed'
      && e.payload.role === 'user' && e.payload.messageId === start?.payload.inputMessageId);
    if (!message) throw new Error('run_input_message_missing');
    const {messageId, content, filesystemReferences=[]} = message.payload;
    return {messageId, content, filesystemReferences:filesystemReferences.map(({displayName})=>({displayName}))};
  }

  async readWindowPartitions(sessionId, sequence) {
    const all = this.#events.get(sessionId), usage = all?.find(e=>e.sequence===sequence && e.type==='context.updated');
    const receipt = usage && all.find(e=>e.type==='context.composed' && e.sequence<sequence && e.runId===usage.runId && e.payload.providerRequestId===usage.payload.providerRequestId);
    if (!receipt) throw new Error('provider_request_receipt_missing');
    return {sequence:receipt.sequence,partitions:structuredClone(receipt.payload.partitions)};
  }

  async readAgentLifecycle(sessionId) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    return { sessionId, revision: events.at(-1)?.sequence ?? 0,
      events: events.flatMap(event => { const value = projectAgentLifecycleEvent(event); return value ? [value] : []; }) };
  }

  async readResources(sessionId, recordIds = []) {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    return { sessionId, revision: events.at(-1)?.sequence ?? 0,
      events: events.flatMap(event => { const value = projectResourceEvent(event, recordIds); return value ? [value] : []; }) };
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
