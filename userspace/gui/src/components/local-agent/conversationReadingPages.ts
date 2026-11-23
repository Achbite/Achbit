import type { ConversationRound } from './conversationItems';

/** The index holds keys and numbers, never a second copy of messages, grants or DOM. */
export interface ReadingPage { key: string; start: number; end: number; rows: number }
export class ReadingPages {
  readonly pages: ReadingPage[] = [];
  readonly byAnchor = new Map<string, number>();
  constructor(rounds: readonly ConversationRound[]) {
    // Whole rounds preserve their process disclosure, timing and file-change footer. A very
    // large single round still uses the existing row virtualizer inside the mounted page.
    for (const [index, round] of rounds.entries()) {
      const count = Math.max(1, round.rows.length);
      let page = this.pages.at(-1);
      if (!page || page.rows + count > 12) {
        page = { key: round.key, start: index, end: index, rows: 0 }; this.pages.push(page);
      }
      page.end = index + 1; page.rows += count;
      const n = this.pages.length - 1;
      for (const row of round.rows) this.byAnchor.set(row.key, n);
      for (const suffix of ['disclosure','reasoning-history','provider-status','file-changes']) this.byAnchor.set(`${round.key}:${suffix}`, n);
    }
  }
}

export interface ReadingRange { first: number; last: number }
/** Prefix sums are in CSS pixels. Only an actual mounted page may replace an estimate. */
export class ReadingGeometry {
  readonly offsets: number[] = [0];
  constructor(readonly index: ReadingPages, heights: ReadonlyMap<string, number>) {
    this.reset(heights);
  }
  reset(heights: ReadonlyMap<string, number>) {
    this.offsets.length = 1;
    for (const page of this.index.pages) this.offsets.push(this.offsets.at(-1)! + (heights.get(page.key) ?? 120 * page.rows));
  }
  measure(n: number, height: number): boolean {
    if (!Number.isFinite(height) || height < 0 || n < 0 || n >= this.index.pages.length) return false;
    const delta = height - (this.offsets[n + 1]! - this.offsets[n]!);
    if (Math.abs(delta) < .1) return false;
    for (let k = n + 1; k < this.offsets.length; k++) this.offsets[k] = this.offsets[k]! + delta;
    return true;
  }
  get extent(): number { return this.offsets[this.index.pages.length]!; }
  pageAt(pixel: number) {
    let lo = 0, hi = this.index.pages.length - 1;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (this.offsets[m + 1]! <= pixel) lo = m + 1; else hi = m; }
    return lo;
  }
  range(top: number, height: number): ReadingRange {
    const margin = Math.min(750, Math.max(320, height * .7));
    return { first: this.pageAt(top - margin), last: this.pageAt(top + height + margin) };
  }
}

/** Cache indexes by the actual immutable array; dropping the projection also releases its index. */
const pageIndexes = new WeakMap<ConversationRound[], ReadingPages>();
export function readingPages(rounds: ConversationRound[]): ReadingPages {
  const found = pageIndexes.get(rounds);
  if (found) return found;
  const index = new ReadingPages(rounds); pageIndexes.set(rounds, index); return index;
}
