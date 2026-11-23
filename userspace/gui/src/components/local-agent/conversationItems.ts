import { CONTROL_TURN_ISSUE, type ActivityProjection, type AssistantDraftBlockProjection, type SessionProjection } from '@achbit/protocol';

export interface BatchConflictSummary { providerRequestId: string; sources: number; peers: number }

export function batchConflictRole(activity: ActivityProjection): 'source' | 'peer' | undefined {
  if (activity.kind !== 'tool' || activity.status !== 'rejected') return;
  const issue = activity.inputRejection?.issues.find(issue => issue.rule === CONTROL_TURN_ISSUE.source || issue.rule === CONTROL_TURN_ISSUE.peer);
  if (issue) return issue.rule === CONTROL_TURN_ISSUE.source ? 'source' : 'peer';
}

export type ProjectionItem =
  | {
      type: 'message';
      sequence: number;
      streamId?: string;
      value: SessionProjection['messages'][number];
    }
  | {
      type: 'narrative';
      sequence: number;
      streamId: string;
      value: SessionProjection['narratives'][number];
    }
  | { type: 'plan'; sequence: number; value: SessionProjection['plans'][number] }
  | { type: 'interaction'; sequence: number; value: SessionProjection['interactions'][number] }
  | {
      type: 'toolGroup';
      sequence: number;
      groupId: string;
      values: ActivityProjection[];
      batchConflicts?: BatchConflictSummary[];
      /** Shared lookup for this snapshot; a Provider call ID is scoped to its request. */
      hostedKeys?: ReadonlyMap<string, string>;
    };

export type HostedBlock = Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
export type HostedDraftGroup = { type: 'providerHostedGroup'; runId: string; turnId: string; blocks: HostedBlock[] };
export const hostedEntryKey = (runId: string, turnId: string, callId: string): string =>
  `hosted:${JSON.stringify([runId, turnId, callId])}`;

const decisionActivity = (a: ActivityProjection) => a.kind === 'plan' || a.kind === 'interaction' || a.status === 'waiting'
  || (a.kind === 'approval' && (a.status === 'active' || a.status === 'requested')) || a.notExecuted?.reason === 'approvalRequired';

export type AssistantDraftItem =
  | { type: 'planPreview'; value: NonNullable<NonNullable<SessionProjection['assistantDraft']>['planPreview']>; key: string }
  | {
      type: 'text';
      block: Exclude<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
    }
  | HostedDraftGroup;

export function assistantDraftItems(
  draft: SessionProjection['assistantDraft'],
): AssistantDraftItem[] {
  if (!draft) return [];
  const items: AssistantDraftItem[] = [];
  let plan = draft.planPreview;
  const appendPlan = () => {
    if (plan) items.push({ type: 'planPreview', value: plan, key: `${draft.turnId}:plan:${plan.providerCallId}` });
    plan = undefined;
  };
  for (const block of draft.blocks) {
    // Insert the plan before grouping: it can fall between two searches.
    if (plan?.outputIndex !== undefined && block.outputIndex !== undefined && block.outputIndex > plan.outputIndex) appendPlan();
    if (block.kind !== 'providerHosted') {
      if ((block.displayContent ?? block.content).trim()) items.push({ type: 'text', block });
    } else {
      const last = items.at(-1);
      if (last?.type === 'providerHostedGroup') last.blocks.push(block);
      else items.push({ type: 'providerHostedGroup', runId: draft.runId, turnId: draft.turnId, blocks: [block] });
    }
  }
  appendPlan();
  return items;
}

const projectionItemCache = new WeakMap<SessionProjection, ProjectionItem[]>();
export function projectionItems(projection: SessionProjection | null): ProjectionItem[] {
  if (!projection) return [];
  const cached = projectionItemCache.get(projection);
  if (cached) return cached;
  const messages = new Map(projection.messages.map((value) => [value.messageId, value]));
  const narratives = new Map(projection.narratives.map((value) => [value.narrativeId, value]));
  const plans = new Map(projection.plans.map((value) => [`${value.planId}:${value.revision}`, value]));
  const activities = new Map(projection.activities.map((value) => [value.activityId, value]));
  const interactions = new Map(projection.interactions.map(value => [value.callId, value]));
  const hostedKeys = new Map<string, string>();
  // A request can span narrative rows, and consecutive requests share disclosures.
  // Count only Session's explicit per-call roles; anchor each request's notice once.
  const batchCounts = new Map<string, BatchConflictSummary>();
  const batchAtActivity = new Map<string, BatchConflictSummary>();
  const items = projection.timeline.map((item): ProjectionItem => {
    switch (item.kind) {
      case 'message':
        return {
          type: 'message',
          sequence: item.sequence,
          ...(item.streamId !== undefined ? { streamId: item.streamId } : {}),
          value: requiredProjectionValue(
            messages.get(item.messageId),
            'conversation_timeline_message_missing',
          ),
        };
      case 'narrative':
        return {
          type: 'narrative',
          sequence: item.sequence,
          streamId: item.streamId,
          value: requiredProjectionValue(
            narratives.get(item.narrativeId),
            'conversation_timeline_narrative_missing',
          ),
        };
      case 'plan':
        return {
          type: 'plan',
          sequence: item.sequence,
          value: requiredProjectionValue(
            plans.get(`${item.planId}:${item.revision}`),
            'conversation_timeline_plan_missing',
          ),
        };
      case 'toolGroup': {
        const values = item.activityIds.map(id => requiredProjectionValue(activities.get(id), 'conversation_timeline_activity_missing'));
        for (const a of values) {
          if (!item.providerRequestId) continue;
          if (a.providerHosted) hostedKeys.set(a.activityId, hostedEntryKey(a.runId, item.providerRequestId, a.providerHosted.providerCallId));
          const role = batchConflictRole(a);
          if (!role) continue;
          let batch = batchCounts.get(item.providerRequestId);
          if (!batch) {
            batch = { providerRequestId: item.providerRequestId, sources: 0, peers: 0 };
            batchCounts.set(item.providerRequestId, batch);
            batchAtActivity.set(a.activityId, batch);
          }
          if (role === 'source') batch.sources++; else batch.peers++;
        }
        return { type: 'toolGroup', sequence: item.sequence, groupId: item.timelineId, values, hostedKeys };
      }
    }
  });
  const grouped: ProjectionItem[] = [];
  const displayItems = items.flatMap((item): ProjectionItem[] => {
    if (item.type === 'narrative' && !(item.value.displayContent ?? item.value.content).trim()
      && !item.value.sourceReferences?.citations.length && !item.value.sourceReferences?.unresolved) return [];
    if (item.type !== 'toolGroup' || !item.values.some((activity) => activity.kind === 'interaction')) return [item];
    const rows: ProjectionItem[] = [];
    for (const activity of item.values) {
      if (activity.kind === 'interaction') {
        const interaction = requiredProjectionValue(interactions.get(activity.callId!), 'conversation_interaction_missing');
        rows.push({ type: 'interaction', sequence: interaction.sequence, value: interaction });
      }
      else {
        const previous = rows.at(-1);
        if (previous?.type === 'toolGroup') previous.values.push(activity);
        else rows.push({ ...item, groupId: `${item.groupId}:${activity.activityId}`, values: [activity] });
      }
    }
    return rows;
  });
  // Keep one disclosure anchored to the first child event in an uninterrupted segment.
  // Later notices can pass ordinary tools into that disclosure; tools never change order.
  let agents: Extract<ProjectionItem, { type: 'toolGroup' }> | undefined;
  for (const item of displayItems) {
    if (item.type !== 'toolGroup') { agents = undefined; grouped.push(item); continue; }
    for (const [i, a] of item.values.entries()) {
      if (agents?.values[0]?.runId !== a.runId) agents = undefined;
      if (a.agent) {
        if (agents) agents.values.push(a);
        else {
          agents = { ...item, groupId: `agent-fold:${a.activityId}`, sequence: a.sequence, values: [a] };
          grouped.push(agents);
        }
        continue;
      }
      const barrier = decisionActivity(a);
      if (barrier) agents = undefined;
      const previous = grouped.at(-1);
      if (!barrier && previous?.type === 'toolGroup' && !previous.values[0]?.agent
        && previous.values[0]?.runId === a.runId && !decisionActivity(previous.values.at(-1)!)) previous.values.push(a);
      else grouped.push({ ...item, groupId: i ? `${item.groupId}:${a.activityId}` : item.groupId, sequence: a.sequence, values: [a] });
    }
  }
  if (batchAtActivity.size) for (const item of grouped) {
    if (item.type !== 'toolGroup') continue;
    const batches = item.values.flatMap(a => batchAtActivity.get(a.activityId) ?? []);
    if (batches.length) item.batchConflicts = batches;
  }
  projectionItemCache.set(projection, grouped);
  return grouped;
}

function requiredProjectionValue<Value>(
  value: Value | undefined,
  error: string,
): Value {
  if (!value) throw new Error(error);
  return value;
}

export type ConversationRow = { key: string; item?: ProjectionItem; draft?: AssistantDraftItem };
export interface ConversationRound { key: string; runId: string; rows: ConversationRow[] }

// A settled snapshot may be revisited many times. Keys, ordering and indexes belong
// to this exact immutable item list; live draft rows are never cached here.
const settledRounds = new WeakMap<ProjectionItem[], { runId?: string; rounds: ConversationRound[] }>();

/** Stream identity keeps a text row in place when Session commits it to the timeline. */
export function conversationRounds(items: ProjectionItem[], drafts: AssistantDraftItem[], currentRunId?: string): ConversationRound[] {
  const previous = !drafts.length ? settledRounds.get(items) : undefined;
  if (previous && previous.runId === currentRunId) return previous.rounds;
  const rounds: ConversationRound[] = [];
  const append = (runId: string, row: ConversationRow) => {
    let round = rounds.at(-1);
    if (!round || round.runId !== runId) {
      round = { key: runId || row.key, runId, rows: [] };
      rounds.push(round);
    }
    round.rows.push(row);
  };
  const committedStreams = new Set<string>();
  const committedHosted = new Set<string>();
  const hasLiveSearch = drafts.some(draft => draft.type === 'providerHostedGroup');
  for (const item of items) {
    const streamId = item.type === 'message' || item.type === 'narrative' ? item.streamId : undefined;
    if (streamId) committedStreams.add(streamId);
    if (item.type === 'toolGroup') {
      const first = item.values[0]!;
      if (hasLiveSearch && first.runId === currentRunId) for (const a of item.values) {
        const key = item.hostedKeys?.get(a.activityId);
        if (key) committedHosted.add(key);
      }
      append(first.runId, { key: item.hostedKeys?.get(first.activityId) ?? item.groupId, item });
    } else append(item.value.runId ?? '', { key: streamId ?? (item.type === 'message' ? item.value.messageId : `${item.type}:${item.sequence}`), item });
  }
  if (currentRunId) {
    for (const draft of drafts) {
      if (draft.type === 'text' && committedStreams.has(draft.block.streamId)) continue;
      if (draft.type !== 'providerHostedGroup') {
        append(currentRunId, { key: draft.type === 'text' ? draft.block.streamId : draft.key, draft });
        continue;
      }
      if (draft.runId !== currentRunId) continue;
      const keyOf = (block: HostedBlock) => hostedEntryKey(draft.runId, draft.turnId, block.providerCallId);
      const blocks = draft.blocks.filter(block => !committedHosted.has(keyOf(block)));
      if (!blocks.length) continue;
      const round = rounds.at(-1);
      const last = round?.runId === currentRunId ? round.rows.at(-1) : undefined;
      if (last?.draft?.type === 'providerHostedGroup') last.draft = { ...draft, blocks: [...last.draft.blocks, ...blocks] };
      else if (last?.item?.type === 'toolGroup' && !last.item.values[0]?.agent && !decisionActivity(last.item.values.at(-1)!)) last.draft = { ...draft, blocks };
      else append(currentRunId, { key: keyOf(blocks[0]!), draft: { ...draft, blocks } });
    }
    if (rounds.at(-1)?.runId !== currentRunId) rounds.push({ key: currentRunId, runId: currentRunId, rows: [] });
  }
  if (!drafts.length) settledRounds.set(items, { runId: currentRunId, rounds });
  return rounds;
}
