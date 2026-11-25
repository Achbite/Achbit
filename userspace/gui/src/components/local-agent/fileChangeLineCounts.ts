import { diffLines, structuredPatch } from 'diff';
import type { ChangeCounts } from './fileChangeSummary';

/** Runs in the statistics Worker, so the time budget covers computation, not timer waits. */
export function calculateChangedLines(before: string | null, after: string | null): ChangeCounts {
  const changes = diffLines(before ?? '', after ?? '', { timeout: 1_000 });
  if (!changes) throw new Error('change_counts_timeout');
  return changes.reduce((counts, change) => ({
    added: counts.added + (change.added ? change.count : 0),
    removed: counts.removed + (change.removed ? change.count : 0),
  }), { added: 0, removed: 0 });
}

export type ChangedRange = { fromA: number; toA: number; fromB: number; toB: number };

interface Anchor { a: number; b: number; length: number; previous: number }

// Patience diff uses complete lines that occur once on both sides. The longest ordered subset
// separates independent edits without searching across an entire rewritten or reordered file.
function orderedLineAnchors(a: string, b: string): Anchor[] {
  const shorterIsA = a.length <= b.length;
  const shorter = shorterIsA ? a : b, other = shorterIsA ? b : a;
  const tokens = /[^\n]*\n|[^\n]+$/g;
  const keys = new Map<string, number>();
  const offsets: number[] = [];
  for (const match of shorter.matchAll(tokens)) {
    const line = match[0];
    if (keys.has(line)) { keys.set(line, -1); continue; }
    keys.set(line, offsets.length);
    offsets.push(match.index!);
  }
  const otherOffsets = new Int32Array(offsets.length).fill(-1);
  for (const match of other.matchAll(tokens)) {
    const key = keys.get(match[0]);
    if (key === undefined || key < 0) continue;
    otherOffsets[key] = otherOffsets[key] === -1 ? match.index! : -2;
  }

  const anchors: Anchor[] = [], tails: number[] = [];
  for (const [line, key] of keys) {
    if (key < 0 || otherOffsets[key] < 0) continue;
    const offset = offsets[key], otherOffset = otherOffsets[key];
    let low = 0, high = tails.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const previous = anchors[tails[mid]];
      if ((shorterIsA ? previous.b : previous.a) < otherOffset) low = mid + 1;
      else high = mid;
    }
    const previous = low ? tails[low - 1] : -1;
    tails[low] = anchors.length;
    anchors.push({ a: shorterIsA ? offset : otherOffset, b: shorterIsA ? otherOffset : offset, length: line.length, previous });
  }
  const ordered: Anchor[] = [];
  for (let i = tails.at(-1) ?? -1; i !== -1; i = anchors[i].previous) ordered.push(anchors[i]);
  return ordered.reverse();
}


// Trim equal complete outer lines before looking for anchors inside the changed region.
function changedLineWindow(a: string, b: string) {
  let matched = 0;
  while (matched < a.length && matched < b.length && a.charCodeAt(matched) === b.charCodeAt(matched)) matched++;
  const start = matched ? a.lastIndexOf('\n', matched - 1) + 1 : 0;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  // A shared suffix beginning inside either side's line must retain that partial line in the comparison.
  if ((endA > 0 && a[endA - 1] !== '\n') || (endB > 0 && b[endB - 1] !== '\n')) {
    const newline = a.indexOf('\n', endA);
    const remainder = (newline < 0 ? a.length : newline + 1) - endA;
    endA += remainder;
    endB += remainder;
  }
  return { start, endA, endB };
}

/** Whole unchanged lines anchor the character comparison, including its end-of-file newline. */
export function calculateChangedRanges(before: string, after: string): ChangedRange[] {
  if (before === after) return [];
  const { start, endA, endB } = changedLineWindow(before, after);
  const a = before.slice(start, endA), b = after.slice(start, endB);
  const ranges: ChangedRange[] = [];
  let fromA = start, fromB = start;
  const gap = (toA: number, toB: number) => {
    if (before.slice(fromA, toA) !== after.slice(fromB, toB)) ranges.push({ fromA, toA, fromB, toB });
  };
  for (const anchor of orderedLineAnchors(a, b)) {
    const toA = start + anchor.a, toB = start + anchor.b;
    gap(toA, toB);
    fromA = toA + anchor.length;
    fromB = toB + anchor.length;
  }
  gap(endA, endB);
  return ranges;
}

export interface ChangePreview {
  counts: ChangeCounts;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  truncated: boolean;
}

/** Inline activity shows nearby changes; the Reader owns the full comparison. */
export function calculateChangePreview(before: string | null, after: string | null): ChangePreview {
  const patch = structuredPatch('', '', before ?? '', after ?? '', undefined, undefined, { context: 2, timeout: 1_000 });
  if (!patch) throw new Error('change_preview_timeout');
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
