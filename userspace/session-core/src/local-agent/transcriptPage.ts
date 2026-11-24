import type { SessionTimelineItem, TranscriptFacts } from '@achbit/protocol';

export interface TimelineGroup {
  /** Earliest source of the group, usually the Provider request's composition. */
  sequence: number;
  runId?: string;
  items: SessionTimelineItem[];
}

const pageRows = 24;

/** A page boundary must preserve both the journal cursor and the Provider's display order.
 * Two interleaved groups stay together even if that takes the page over its row budget. */
export function selectTranscriptPage(groups: TimelineGroup[], turn: Pick<TranscriptFacts, 'start' | 'end'>, anchor: number) {
  const starts = [turn.start];
  const groupStarts = [0];
  const lastRowByRun = new Map<string, number>();
  let count = 0;
  let through = turn.start - 1;
  for (const [i, group] of groups.entries()) {
    if (count >= pageRows && group.sequence > through) {
      starts.push(group.sequence);
      groupStarts.push(i);
      count = 0;
    }
    count += group.items.length;
    for (const item of group.items) {
      through = Math.max(through, item.sequence);
      if (group.runId) lastRowByRun.set(group.runId, Math.max(lastRowByRun.get(group.runId) ?? 0, item.sequence));
    }
  }
  const index = starts.findLastIndex(sequence => sequence <= anchor);
  const start = starts[index]!;
  const end = (starts[index + 1] ?? turn.end + 1) - 1;
  const selected = groups.slice(groupStarts[index], groupStarts[index + 1]);
  return {
    start, end, timeline: selected.flatMap(g => g.items),
    runIds: new Set(selected.flatMap(g => g.runId ? [g.runId] : [])),
    lastRowByRun,
  };
}
