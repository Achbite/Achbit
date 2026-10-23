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
    };

export type AssistantDraftItem =
  | { type: 'planPreview'; value: NonNullable<NonNullable<SessionProjection['assistantDraft']>['planPreview']>; key: string }
  | {
      type: 'text';
      block: Exclude<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
    }
  | {
      type: 'providerHostedGroup';
      groupId: string;
      blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
    };

export function assistantDraftItems(
  draft: SessionProjection['assistantDraft'],
): AssistantDraftItem[] {
  if (!draft) return [];
  const items: AssistantDraftItem[] = [];
  let hostedBlocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>> = [];
  const flushHostedBlocks = (): void => {
    if (hostedBlocks.length === 0) return;
    items.push({
      type: 'providerHostedGroup',
      groupId: `draft-hosted:${draft.turnId}:${hostedBlocks[0]!.outputIndex}`,
      blocks: hostedBlocks,
    });
    hostedBlocks = [];
  };
  for (const block of draft.blocks) {
    if (block.kind !== 'providerHosted') {
      flushHostedBlocks();
      items.push({ type: 'text', block });
      continue;
    }
    hostedBlocks.push(block);
  }
  flushHostedBlocks();
  if (draft.planPreview) {
    const preview = draft.planPreview;
    const index = preview.outputIndex === undefined ? -1 : items.findIndex((item) => {
      const outputIndex = item.type === 'text' ? item.block.outputIndex : item.type === 'providerHostedGroup' ? item.blocks[0]?.outputIndex : undefined;
      return outputIndex !== undefined && outputIndex > preview.outputIndex!;
    });
    items.splice(index < 0 ? items.length : index, 0, { type: 'planPreview', value: preview, key: `${draft.turnId}:plan:${preview.providerCallId}` });
  }
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
      case 'toolGroup':
        return {
          type: 'toolGroup',
          sequence: item.sequence,
          groupId: item.timelineId,
          values: item.activityIds.map((activityId) => requiredProjectionValue(
            activities.get(activityId),
            'conversation_timeline_activity_missing',
          )),
        };
    }
  });
  const grouped: ProjectionItem[] = [];
  const displayItems = items.flatMap((item): ProjectionItem[] => {
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
      && !item.values.some(activity => activity.agent && activity.agent.phase !== 'started')
      && !previous.values.some(activity => activity.agent && activity.agent.phase !== 'started')) {
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
  for (const item of items) {
    const streamId = item.type === 'message' || item.type === 'narrative' ? item.streamId : undefined;
    if (streamId) committedStreams.add(streamId);
    const key = streamId ?? (item.type === 'message' ? item.value.messageId : item.type === 'toolGroup' ? item.groupId : `${item.type}:${item.sequence}`);
    append(item.type === 'toolGroup' ? item.values[0]!.runId : item.value.runId ?? '', { key, item });
  }
  if (currentRunId) {
    for (const draft of drafts) {
      if (draft.type === 'text' && committedStreams.has(draft.block.streamId)) continue;
      const key = draft.type === 'text' ? draft.block.streamId : draft.type === 'planPreview' ? draft.key : draft.groupId;
      append(currentRunId, { key, draft });
    }
    if (rounds.at(-1)?.runId !== currentRunId) rounds.push({ key: currentRunId, runId: currentRunId, rows: [] });
  }
  return rounds;
}
