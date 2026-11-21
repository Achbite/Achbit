import type { ActivityProjection, AssistantDraftBlockProjection, SessionProjection } from '@achbit/protocol';

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
      /** Shared lookup for this snapshot; a Provider call ID is scoped to its request. */
      hostedKeys?: ReadonlyMap<string, string>;
    };

export type HostedBlock = Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
export type HostedDraftGroup = { type: 'providerHostedGroup'; runId: string; turnId: string; blocks: HostedBlock[] };
export const hostedEntryKey = (runId: string, turnId: string, callId: string): string =>
  `hosted:${JSON.stringify([runId, turnId, callId])}`;

const hasMemberNotice = (values: ActivityProjection[]) => values.some(a => a.agent && a.agent.phase !== 'started');

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
          if (a.providerHosted && item.providerRequestId) hostedKeys.set(a.activityId, hostedEntryKey(a.runId, item.providerRequestId, a.providerHosted.providerCallId));
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
  for (const item of displayItems) {
    const previous = grouped.at(-1);
    if (item.type === 'toolGroup' && previous?.type === 'toolGroup'
      && item.values[0]?.runId === previous.values[0]?.runId
      // An arriving member notification belongs at its event position, after preceding tools.
      && !hasMemberNotice(item.values) && !hasMemberNotice(previous.values)) {
      previous.values.push(...item.values);
    } else grouped.push(item);
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

/** Stream identity keeps a text row in place when Session commits it to the timeline. */
export function conversationRounds(items: ProjectionItem[], drafts: AssistantDraftItem[], currentRunId?: string): ConversationRound[] {
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
      else if (last?.item?.type === 'toolGroup' && !hasMemberNotice(last.item.values)) last.draft = { ...draft, blocks };
      else append(currentRunId, { key: keyOf(blocks[0]!), draft: { ...draft, blocks } });
    }
    if (rounds.at(-1)?.runId !== currentRunId) rounds.push({ key: currentRunId, runId: currentRunId, rows: [] });
  }
  return rounds;
}
