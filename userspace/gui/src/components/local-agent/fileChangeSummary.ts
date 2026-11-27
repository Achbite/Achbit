import type { ActivityProjection, FileChangeProjection, TranscriptContent } from '@achbit/protocol';
import { isBinaryFileChange, type readFileChange } from '../../services/localAgentApi';
import type { ChangedRange, ChangePreview } from './fileChangeLineCounts';

export type Change = { change: FileChangeProjection; index: number; recordId: string };
export type ChangedFile = { key: string; path: string; changes: Change[] };
export type ChangeCounts = { added: number; removed: number };

/** Content statistics follow displayed rows, not the entire archived round. */
export function displayedChangedFiles(files: readonly ChangedFile[], open: boolean, showAll: boolean): readonly ChangedFile[] {
  if (!open) return [];
  return showAll ? files : files.slice(0, 3);
}

/** Net lines depend on immutable first-before/last-after receipts, not transient edits in between. */
export function changeStatisticsRevision(file: ChangedFile): string {
  const first = file.changes[0]!, last = file.changes.at(-1)!;
  return JSON.stringify([first.recordId, first.index, last.recordId, last.index]);
}
export type FileChangeStatistics = { kind: 'text'; counts: ChangeCounts } | { kind: 'binary' };

// Only immutable, successfully classified revisions are retained; aborted and failed reads are not cached.
const statisticsCaches = new WeakMap<typeof readFileChange, Map<string, FileChangeStatistics>>();
const MAX_CACHED_STATISTICS = 512;

export async function readChangeStatistics(
  read: typeof readFileChange, sessionId: string, file: ChangedFile, signal: AbortSignal,
  count = countChangedLines,
): Promise<FileChangeStatistics> {
  signal.throwIfAborted();
  let cache = statisticsCaches.get(read);
  if (!cache) { cache = new Map(); statisticsCaches.set(read, cache); }
  const key = JSON.stringify([sessionId, file.key, changeStatisticsRevision(file)]);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  let result: FileChangeStatistics;
  try {
    const change = await readRoundChange(read, sessionId, file, signal);
    result = { kind: 'text', counts: await count(change.before, change.after, signal) };
  } catch (error) {
    if (!isBinaryFileChange(error)) throw error;
    result = { kind: 'binary' };
  }
  signal.throwIfAborted();
  cache.set(key, result);
  if (cache.size > MAX_CACHED_STATISTICS) cache.delete(cache.keys().next().value!);
  return result;
}

// Session projections are immutable. Build all round memberships once per projection.
const roundChangesCache = new WeakMap<TranscriptContent, Map<string, ActivityProjection[]>>();

export function roundChangeActivities(projection: TranscriptContent | null, runId: string): ActivityProjection[] {
  if (!projection) return [];
  let rounds = roundChangesCache.get(projection);
  if (!rounds) {
    rounds = new Map();
    const recordRounds = new Map<string, Set<ActivityProjection[]>>();
    for (const round of projection.fileChangeRounds ?? []) {
      if (rounds.has(round.runId)) continue;
      const activities: ActivityProjection[] = [];
      rounds.set(round.runId, activities);
      for (const recordId of round.recordIds) {
        let owners = recordRounds.get(recordId);
        if (!owners) { owners = new Set(); recordRounds.set(recordId, owners); }
        owners.add(activities);
      }
    }
    for (const activity of projection.activities) {
      const recordId = activity.tool?.recordId;
      if (recordId) for (const activities of recordRounds.get(recordId) ?? []) activities.push(activity);
    }
    roundChangesCache.set(projection, rounds);
  }
  return rounds.get(runId) ?? [];
}

export type FileChangeActivity = Pick<ActivityProjection, 'activityId'> & { tool?: Pick<NonNullable<ActivityProjection['tool']>, 'recordId' | 'fileChanges'> };

export function changedFiles(activities: FileChangeActivity[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  // Most paths change once. Allocate a membership set only when a path recurs.
  const seen = new Map<string, Set<string>>();
  for (const activity of activities) {
    const recordId = activity.tool?.recordId;
    if (!recordId) continue;
    for (const [index, change] of (activity.tool?.fileChanges ?? []).entries()) {
      const key = JSON.stringify([change.workspaceId, change.path]);
      const file = files.get(key);
      if (!file) { files.set(key, { key, path: change.path, changes: [{ change, recordId, index }] }); continue; }
      let pairs = seen.get(key);
      if (!pairs) {
        const first = file.changes[0]!;
        pairs = new Set([JSON.stringify([first.recordId, first.index])]); seen.set(key, pairs);
      }
      const pair = JSON.stringify([recordId, index]);
      if (!pairs.has(pair)) { pairs.add(pair); file.changes.push({ change, recordId, index }); }
    }
  }
  return [...files.values()];
}

export async function readRoundChange(read: typeof readFileChange, sessionId: string, file: ChangedFile, signal: AbortSignal) {
  const first = file.changes[0]!;
  const last = file.changes.at(-1)!;
  const before = await read(sessionId, first.recordId, first.index, signal);
  const after = first === last ? before : await read(sessionId, last.recordId, last.index, signal);
  if (before.workspaceId !== after.workspaceId || before.path !== after.path
    || before.workspaceId !== first.change.workspaceId || before.path !== file.path) throw new Error('file_change_identity_mismatch');
  return { ...after, before: before.before };
}

export function countChangedLines(before: string | null, after: string | null, signal?: AbortSignal): Promise<ChangeCounts> {
  return computeChange<ChangeCounts>(before, after, 'counts', signal);
}

export function previewChangedLines(before: string | null, after: string | null, signal?: AbortSignal): Promise<ChangePreview> {
  return computeChange<ChangePreview>(before, after, 'preview', signal);
}

export function readChangedRanges(before: string, after: string, signal: AbortSignal) {
  return computeChange<ChangedRange[]>(before, after, 'ranges', signal);
}

export type ChangeComputation = 'counts' | 'preview' | 'ranges';

function computeChange<T>(before: string | null, after: string | null, operation: ChangeComputation, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./fileChangeSummary.worker.ts', import.meta.url), { type: 'module' });
    const dispose = () => { signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { dispose(); reject(signal?.reason); };
    worker.onmessage = ({ data }: MessageEvent<{ result: T } | { error: string }>) => {
      dispose();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = (event) => { dispose(); reject(new Error(event.message)); };
    worker.onmessageerror = () => { dispose(); reject(new Error('change_counts_result_unreadable')); };
    signal?.addEventListener('abort', abort, { once: true });
    try { worker.postMessage({ before, after, operation }); }
    catch (error) { dispose(); reject(error); }
  });
}
