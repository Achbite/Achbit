import type {
  ContextCompositionReceipt,
  ProviderRequest,
  RunRuntimeSnapshot,
  SessionEvent,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  buildConversationProviderRequest,
  runInputMessageEvent,
} from './contextComposer.js';
import type { SessionState } from './reducer.js';

export type ContextCompactionRequestEvent = Extract<
  SessionEvent,
  { type: 'context.compaction.requested' }
>;

export interface PreparedContextCompaction {
  request: ProviderRequest;
  receipt: Extract<ContextCompositionReceipt, { purpose: 'agent' | 'contextCompaction' }>;
}

const COMPACTION_INSTRUCTIONS = `Summarize the supplied conversation into a factual handoff for continuing the user's task.
Preserve the user's goal, confirmed decisions and plans, constraints, unresolved questions, necessary identifiers, paths, commands, errors, completed and pending work, and relevant tool results.
Separate facts, inferences, and unknowns. Do not answer the task, call tools, or take action. Return only the concise Markdown summary; omit internal runtime phases, repeated progress snapshots, repetitive logs, and obsolete details.`;

export function prepareContextCompaction(input: {
  sessionId: string;
  runId: string;
  runtime: RunRuntimeSnapshot;
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  events: readonly SessionEvent[];
  requestEvent: ContextCompactionRequestEvent;
  optionalControlTools?: readonly string[];
}, signal?: AbortSignal): PreparedContextCompaction {
  signal?.throwIfAborted();
  const cutoff = input.requestEvent.payload.coveredThroughSequence;
  const sourceEvents = input.events.filter((event) => event.sequence <= cutoff);
  const focus = 'focus' in input.requestEvent.payload
    ? input.requestEvent.payload.focus
    : undefined;
  const { request, receipt } = buildConversationProviderRequest({
    sessionId: input.sessionId,
    runId: input.runId,
    runtime: input.runtime,
    events: sourceEvents,
    modelViewEvents: input.events,
    workspaceBindings: input.workspaceBindings,
    providerRequestId: input.requestEvent.payload.providerRequestId,
    purpose: 'contextCompaction',
    responseConstraint: 'answerOnly',
    optionalControlTools: input.optionalControlTools,
    summaryInstruction: COMPACTION_INSTRUCTIONS + (focus
      ? `\n\nPrioritize existing facts relevant to the following future-work focus, but do not answer it:\n${focus}` : ''),
  });
  signal?.throwIfAborted();
  return { request, receipt };
}

export function pendingContextCompaction(
  events: readonly SessionEvent[],
  runId: string,
): ContextCompactionRequestEvent | null {
  const completed = new Set(events
    .filter((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => (
      event.type === 'context.compacted' && event.runId === runId
    ))
    .map((event) => event.payload.compactionId));
  return [...events]
    .reverse()
    .find((event): event is ContextCompactionRequestEvent => (
      event.type === 'context.compaction.requested'
      && event.runId === runId
      && !completed.has(event.payload.compactionId)
    )) ?? null;
}

export function pressureCompactionCutoff(
  snapshot: { events: readonly SessionEvent[]; state: SessionState },
  runId: string,
  currentReceipt: ContextCompositionReceipt,
  runtime: RunRuntimeSnapshot,
): number | null {
  const latestCheckpoint = [...snapshot.events].reverse().find((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => event.type === 'context.compacted');
  if (estimateContextInput(snapshot, currentReceipt, runtime) + runtime.provider.maxOutputTokens < runtime.provider.contextWindowTokens) return null;
  const input = runInputMessageEvent(snapshot.events, runId);
  if (!input) return null;
  const coveredThrough = latestCheckpoint?.payload.coveredThroughSequence ?? 0;
  const priorRunCutoff = input.sequence - 1;
  const priorJournalFacts = snapshot.events.some((event) => (
    event.sequence <= priorRunCutoff
    && event.sequence > coveredThrough
    && (event.type === 'message.committed' || event.type === 'narrative.committed')
  ));
  if (priorRunCutoff >= 1 && priorJournalFacts) return priorRunCutoff;

  const sameRunCutoff = snapshot.state.revision;
  if (sameRunCutoff <= coveredThrough) return null;
  const sameRunProgress = snapshot.events.some((event) => (
    event.sequence > Math.max(coveredThrough, input.sequence)
    && event.sequence <= sameRunCutoff
    && closesModelContextPrefix(event)
  ));
  return sameRunProgress ? sameRunCutoff : null;
}

function closesModelContextPrefix(event: SessionEvent): boolean {
  return event.type === 'narrative.committed'
    || event.type === 'interaction.resolved'
    || event.type === 'plan.confirmed'
    || event.type === 'plan.revision.requested'
    || event.type === 'plan.cancelled'
    || event.type === 'plan.invalidated'
    || event.type === 'todo.updated'
    || event.type === 'artifacts.presented'
    || event.type === 'agent.control.completed'
    || event.type === 'session.control.completed'
    || event.type === 'wake.triggered'
    || event.type === 'agent.task.completed'
    || event.type === 'agent.message.received'
    || event.type === 'session.control.rejected'
    || event.type === 'tool.input-rejected'
    || event.type === 'tool.not-executed'
    || event.type === 'tool.completed';
}

function contextShapeUnits(
  partitions: readonly { requestShapeUnits: number }[],
): number {
  return partitions.reduce((total, partition) => total + partition.requestShapeUnits, 0);
}

/** Admission estimate only: never report this as Provider token usage. */
export function estimateContextInput(
  snapshot: { events: readonly SessionEvent[]; state: SessionState },
  receipt: ContextCompositionReceipt, runtime: RunRuntimeSnapshot,
): number {
  const units = contextShapeUnits(receipt.partitions);
  const usage = snapshot.state.contextUsage;
  const prior = usage && snapshot.state.contextCompositions.find((item) => item.providerRequestId === usage.providerRequestId);
  const checkpointAfterUsage = usage && snapshot.events.some((event) => event.type === 'context.compacted' && event.sequence > usage.sequence);
  if (usage && prior && !checkpointAfterUsage && usage.providerRuntimeRef === runtime.provider.providerRuntimeRef
    && usage.contextWindowTokens === runtime.provider.contextWindowTokens) {
    const priorUnits = contextShapeUnits(prior.partitions);
    if (priorUnits > 0) return Math.ceil(usage.inputTokens * units / priorUnits);
  }
  // No prior usage exists for a first request or after a checkpoint. Bound the
  // request shape, including schemas, instead of treating unavailable usage as zero.
  return Math.ceil(units / 3);
}
