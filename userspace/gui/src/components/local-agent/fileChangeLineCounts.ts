import { diffLines, structuredPatch } from 'diff';
import type { ChangeCounts } from './fileChangeSummary';

/** Runs in the statistics Worker, so the time budget covers computation, not timer waits. */
export function calculateChangedLines(before: string | null, after: string | null): ChangeCounts {
  const changes = diffLines(before ?? '', after ?? '', { timeout: 1_000 });
  if (!changes) throw new Error('修改行数计算超时');
  return changes.reduce((counts, change) => ({
    added: counts.added + (change.added ? change.count : 0),
    removed: counts.removed + (change.removed ? change.count : 0),
  }), { added: 0, removed: 0 });
}

export interface ChangePreview {
  counts: ChangeCounts;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  truncated: boolean;
}

/** Inline activity shows nearby changes; the Reader owns the full comparison. */
export function calculateChangePreview(before: string | null, after: string | null): ChangePreview {
  const patch = structuredPatch('', '', before ?? '', after ?? '', undefined, undefined, { context: 2, timeout: 1_000 });
  if (!patch) throw new Error('修改片段计算超时');
  const counts = { added: 0, removed: 0 };
  const hunks: ChangePreview['hunks'] = [];
  let remainingLines = 80, remainingCharacters = 16_000, truncated = false;
  for (const hunk of patch.hunks) {
    const lines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('+')) counts.added++;
      if (line.startsWith('-')) counts.removed++;
      if (line.startsWith('\\')) continue;
      if (remainingLines <= 0 || remainingCharacters <= 0) { truncated = true; continue; }
      const displayed = line.slice(0, remainingCharacters);
      lines.push(displayed);
      remainingLines--;
      remainingCharacters -= displayed.length;
      if (displayed.length < line.length) truncated = true;
    }
    if (lines.length) hunks.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines });
  }
  return { counts, hunks, truncated };
}
