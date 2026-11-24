import type { JournalPort, OverviewFact, ProviderUsageEvent, SessionProjection, TranscriptOverview } from '@achbit/protocol';
import { advanceDeliverables, compareDeliverables } from './deliverables.js';
import { advanceTodoList } from './todoState.js';
import { artifactsFromRecord, estimatePartitionTokens, providerUsageFromEvents, runInputTitle } from './reducer.js';

export async function ownOverview(journal: JournalPort, id: string, includeDetails: boolean) {
  const facts = await journal.readOverviewFacts(id);
  if (facts.sessionId !== id) throw new Error('session_event_identity_mismatch');
  const ranges: Array<{ fromSequence: number; throughSequence: number }> = [];
  const usage: ProviderUsageEvent[] = [];
  let last = 0;
  for (const event of facts.events) {
    if (event.sessionId !== id) throw new Error('session_event_identity_mismatch');
    if (event.sequence <= last || event.sequence > facts.revision) throw new Error('session_event_sequence_gap');
    last = event.sequence;
    if (event.type === 'conversation.revised') {
      if (event.payload.fromSequence < 2 || event.payload.fromSequence > event.payload.throughSequence
        || event.payload.throughSequence !== event.sequence - 1) throw new Error('conversation_revision_range_invalid');
      ranges.push(event.payload);
    }
    if (event.type === 'context.updated' || event.type === 'provider.turn.settled') usage.push(event);
  }
  const resources = { sessionId: id, artifacts: {} as Record<string, SessionProjection['artifacts'][number]>,
    deliverables: {} as Record<string, SessionProjection['deliverables'][number]> };
  const starts = new Map<string, Extract<OverviewFact, {type: 'run.started'}>>();
  const settlements = new Map<string, Extract<OverviewFact, {type: 'run.settled'}>>();
  const measured = new Set<string>(), answered = new Set<string>();
  let lastRun: string | null = null;
  let sample: Extract<OverviewFact, {type: 'context.updated'}> | undefined;
  let todoList: TranscriptOverview['todoList'] = null;
  for (const event of facts.events) {
    if (ranges.some(r => event.sequence >= r.fromSequence && event.sequence <= r.throughSequence)) continue;
    switch (event.type) {
      case 'todo.updated': todoList = advanceTodoList(todoList, event); break;
      case 'tool.completed':
        for (const artifact of artifactsFromRecord(event.payload.record)) resources.artifacts[artifact.artifactId] = artifact;
        break;
      case 'artifacts.presented': resources.deliverables = advanceDeliverables(resources, event); break;
      case 'run.settled': settlements.set(event.runId, event); break;
      case 'message.committed': answered.add(event.runId); break;
      case 'run.started':
        starts.set(event.runId, event);
        lastRun = event.runId;
        if (event.payload.boundary != null && sample && sample.sequence <= event.payload.boundary) sample = undefined;
        break;
      case 'provider.turn.settled':
        if (event.payload.purpose === 'agent' && !event.payload.hosted) measured.add(event.payload.providerRequestId);
        break;
      case 'context.updated':
        if (measured.has(event.payload.providerRequestId)) sample = event;
        break;
    }
  }
  let todoRun: TranscriptOverview['todoRun'] = null;
  if (includeDetails && todoList) {
    const start = starts.get(todoList.runId);
    if (!start) throw new Error('token_usage_run_missing');
    const input = await journal.readRunInput(id, start.sequence);
    const end = settlements.get(start.runId);
    const events = usage.filter(e => e.runId === start.runId && !ranges.some(r => e.sequence >= r.fromSequence && e.sequence <= r.throughSequence));
    todoRun = { ...providerUsageFromEvents({ ...facts, events }), runId: start.runId, inputMessageId: input.messageId,
      title: runInputTitle(input), sequence: start.sequence, startedAt: start.occurredAt,
      ...(end ? { outcome: end.payload.outcome, completedAt: end.occurredAt } : {}) };
  }
  const rawReceipt = sample && includeDetails ? await journal.readWindowPartitions(id, sample.sequence) : null;
  const measurement = sample && rawReceipt ? { usage: { ...sample.payload, sequence: sample.sequence, runId: sample.runId,
    updatedAt: sample.occurredAt }, receipt: { sequence: rawReceipt.sequence, partitions: estimatePartitionTokens(rawReceipt.partitions, sample.payload.inputTokens) } } : null;
  const deliverables = Object.values(resources.deliverables).sort(compareDeliverables);
  const surfaced = deliverables.filter(item => item.presentationRunId !== lastRun || (settlements.has(lastRun) && (settlements.get(lastRun)?.payload.outcome !== 'completed' || answered.has(lastRun))));
  return { sessionId: id, revision: facts.revision, measurement, deliverables, surfaced, todoList,
    todoRun,
    totalTokenUsage: providerUsageFromEvents({ ...facts, events: usage }) };
}
