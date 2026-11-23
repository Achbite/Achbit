import type { ConversationReadingWindow, ConversationSessionStatus, ProjectionMessage, SessionProjection } from '@achbit/protocol';
import type { CachedSessionView } from './contextWindowReading';

const MiB = 1024 * 1024;
/** Admission accounting, not a measurement of a JS engine's heap. One active canonical view is exempt. */
const FULL = { count: 6, perEntry: 8 * MiB, total: 24 * MiB, timelineEntries: 32768 };
const WINDOWS = { count: 2, perEntry: 256 * 1024, total: 384 * 1024, perEntryRows: 24, totalRows: 36 };

// Charge string storage in UTF-16 bytes and every scalar, object key and array slot. Bounded walk:
// no serialization/encoding of a jumbo message, and no whole-history scratch buffer to size it.
function charge(value: unknown, limit: number, depth = 0): number {
  if (limit < 0 || depth > 96) return Infinity;
  if (typeof value === 'string') return 16 + 2 * value.length;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 32;
  if (Array.isArray(value)) {
    bytes += value.length * 8;
    for (let i = 0; i < value.length && bytes <= limit; i++) bytes += charge(value[i], limit - bytes, depth + 1);
  } else {
    for (const key in value) {
      if (bytes > limit) break;
      bytes += 16 + 2 * key.length;
      bytes += charge((value as Record<string, unknown>)[key], limit - bytes, depth + 1);
    }
  }
  return bytes > limit ? Infinity : bytes;
}

/** Optional presentation-only geometry and a compact navigation index. Both are charged
 * to the same byte budget as the rows; neither can grant access to an unseen message. */
export interface ReadingWindowSurface {
  before: number; after: number;
  navigation: { keys: string[]; labels: string[] };
}
export interface ReadingWindowRange {
  firstRowKey: string;
  lastRowKey: string;
  surface?: ReadingWindowSurface;
  anchorKey: string;
  offset: number;
}
export interface RememberedReadingAnchor { key: string; offset: number }
export interface OpeningReadingWindow {
  readonly source?: 'revisionWindow';
  readonly startIndex?: number;
  readonly totalRows?: number;
  readonly sessionId: string;
  readonly revision: number;
  readonly anchorKey: string;
  readonly offset: number;
  readonly surface?: ReadingWindowSurface;
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
  readonly rows: readonly { key: string; timelineId: string; sequence: number; streamId?: string; message: ProjectionMessage }[];
}
export function openingFromRevisionWindow(sessionId: string, revision: number,
  data: Extract<ConversationReadingWindow, {kind: 'ready'}>, offset: number): OpeningReadingWindow {
  const after = data.totalRows - data.startIndex - data.rows.length;
  return { source: 'revisionWindow', sessionId, revision, anchorKey: data.anchorKey, offset,
    startIndex: data.startIndex, totalRows: data.totalRows, rows: data.rows,
    hasBefore: data.startIndex > 0, hasAfter: after > 0,
    surface: { before: data.startIndex * 120, after: after * 120, navigation: data.navigation } };
}

interface Candidate {
  readonly sessionId: string;
  readonly revision: number;
  readonly run: ConversationSessionStatus['run'];
  readonly weak?: WeakRef<CachedSessionView>;
  readonly window?: OpeningReadingWindow;
  readonly bytes: number;
  readonly windowBytes: number;
  readonly used: number;
}
export function matchesReadingStatus(saved: Candidate, status?: ConversationSessionStatus) {
  return !!status && status.sessionId === saved.sessionId && status.revision === saved.revision && status.run?.runId === saved.run?.runId
    && status.run?.status === saved.run?.status;
}

function independent(p: SessionProjection) {
  return p.revision > 0 && !p.assistantDraft && (!p.run || ['completed', 'failed', 'cancelled', 'indeterminate'].includes(p.run.status))
    && !p.agentContext && !p.agentChildren?.length && !p.agentTasks?.length && !p.pendingAgentDecisions?.length
    && !p.pendingApproval && !p.pendingApprovals?.length && !p.pendingPlan && !p.pendingInteraction;
}

type TimelineItem = SessionProjection['timeline'][number];
const keyOf = (item: TimelineItem) => item.kind === 'message' ? item.streamId ?? item.messageId : undefined;
function capture(p: SessionProjection, range: ReadingWindowRange): OpeningReadingWindow | undefined {
  if (!independent(p) || !Number.isFinite(range.offset) || !range.firstRowKey || !range.lastRowKey || !range.anchorKey) return;
  // Only complete contiguous message rows are supported. An interaction/plan/tool/reference that
  // needs other projection facts is not replaced with a text approximation.
  if (p.queuedInputs.length || p.terminalError || p.deliverables.length || p.artifacts.length || p.fileChangeRounds?.length) return;
  let start = -1, end = -1, anchor = -1;
  for (let i = 0; i < p.timeline.length; i++) {
    const key = keyOf(p.timeline[i]!);
    if (key === range.firstRowKey) { if (start !== -1) return; start = i; }
    if (key === range.lastRowKey) { if (end !== -1) return; end = i; }
    if (key === range.anchorKey) { if (anchor !== -1) return; anchor = i; }
  }
  if (start < 0 || end < start || anchor < start || anchor > end || end - start >= WINDOWS.perEntryRows) return;
  const items = p.timeline.slice(start, end + 1);
  const wanted = new Map<string, ProjectionMessage | undefined>();
  for (const item of items) { if (item.kind !== 'message') return; wanted.set(item.messageId, undefined); }
  let missing = wanted.size;
  for (let i = p.messages.length - 1; i >= 0 && missing; i--) {
    const msg = p.messages[i]!;
    if (!wanted.has(msg.messageId)) continue;
    if (msg.replyToInteraction || (msg.role !== 'assistant' && msg.role !== 'user')) return;
    wanted.set(msg.messageId, msg); missing--;
  }
  if (missing) return;
  const rows: OpeningReadingWindow['rows'][number][] = [];
  for (const item of items) if (item.kind === 'message') rows.push({ key: keyOf(item)!, timelineId: item.timelineId, sequence: item.sequence,
    ...(item.streamId === undefined ? {} : { streamId: item.streamId }), message: wanted.get(item.messageId)! });
  const surface = range.surface;
  if (surface && (!Number.isFinite(surface.before) || surface.before < 0 || !Number.isFinite(surface.after) || surface.after < 0
    || surface.navigation.keys.length !== surface.navigation.labels.length || surface.navigation.keys.length > 768)) return;
  return { sessionId: p.sessionId, revision: p.revision, anchorKey: range.anchorKey, offset: range.offset,
    ...(surface ? { surface } : {}), hasBefore: start > 0, hasAfter: end < p.timeline.length - 1, rows };
}

/** Only for an action begun on the bounded opening window. Recheck the actual targets against
 * the returned canonical view, not just a numeric revision or a label from a previous screen. */
export function currentReadingTargets(p: SessionProjection, w: OpeningReadingWindow) {
  if (p.sessionId !== w.sessionId || p.revision !== w.revision || !w.rows.length) return false;
  if (w.source === 'revisionWindow' && (p.timeline.length !== w.totalRows || w.startIndex === undefined
    || p.timeline[w.startIndex]?.timelineId !== w.rows[0]!.timelineId)) return false;
  const fresh = capture(p, { firstRowKey: w.rows[0]!.key, lastRowKey: w.rows.at(-1)!.key, anchorKey: w.anchorKey, offset: w.offset });
  return !!fresh && fresh.hasBefore === w.hasBefore && fresh.hasAfter === w.hasAfter && sameWireValue(fresh.rows, w.rows);
}

// Field order is not data. A sparse HTTP transport and the full snapshot may order JSON keys differently.
function sameWireValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k)
    && sameWireValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** One store/Host. Soft entries hold no strong reference to the decoded view, callbacks or node trees. */
export class RecentSessionViews {
  private strong = new Map<string, CachedSessionView>();
  private soft = new Map<string, Candidate>();
  private sizes = new WeakMap<SessionProjection, number>();
  private recency = new WeakMap<CachedSessionView, number>();
  private clock = 0;
  // If a renderer still holds the exact projection, its measured context reading travels
  // with it. An ephemeron does not keep either object alive after the key is unreachable.
  private viewsByProjection = new WeakMap<SessionProjection, CachedSessionView>();
  // At most one requested capture belongs to the active complete view; transfer it only on eviction.
  private capture: { sessionId: string; revision: number; window: OpeningReadingWindow; bytes: number } | null = null;

  get(id: string) { return this.strong.get(id); }
  has(id: string) { return this.strong.has(id); }
  *keys() { yield* this.strong.keys(); yield* this.soft.keys(); }
  candidate(id: string) { return this.soft.get(id); }
  forgetReading(id: string) {
    this.soft.delete(id);
    if (this.capture?.sessionId === id) this.capture = null;
  }
  delete(id: string) { this.strong.delete(id); this.forgetReading(id); }

  promote(view: CachedSessionView, saved: Candidate) {
    this.put(view, saved.sessionId);
    if (saved.window) this.capture = { sessionId: saved.sessionId, revision: saved.revision, window: saved.window, bytes: saved.windowBytes };
    this.trim(saved.sessionId);
  }

  put(view: CachedSessionView, selectedId: string | null) {
    const { sessionId } = view.projection;
    this.viewsByProjection.set(view.projection, view);
    this.recency.set(view, ++this.clock);
    if (this.strong.get(sessionId) !== view && this.capture?.sessionId === sessionId) this.capture = null;
    this.soft.delete(sessionId);
    this.strong.delete(sessionId); this.strong.set(sessionId, view);
    this.trim(selectedId);
  }

  private size(view: CachedSessionView) {
    const p = view.projection;
    let bytes = this.sizes.get(p);
    if (bytes === undefined) { bytes = charge(p, FULL.perEntry); this.sizes.set(p, bytes); }
    return bytes + charge(view.contextWindowReading, FULL.perEntry - bytes);
  }

  shouldRemember(p: SessionProjection) {
    const active = this.strong.get(p.sessionId);
    if (active?.projection !== p || !independent(p) || p.queuedInputs.length || p.terminalError
      || p.deliverables.length || p.artifacts.length || p.fileChangeRounds?.length) return false;
    // At most six already-sized views. The exact same projection is never walked again for sizing.
    let bytes = this.size(active), rows = p.timeline.length;
    if (bytes > FULL.perEntry || rows > FULL.timelineEntries) return true;
    for (const other of this.strong.values()) if (other !== active) {
      bytes += this.size(other); rows += other.projection.timeline.length;
    }
    return bytes > FULL.total || rows > FULL.timelineEntries;
  }

  remember(p: SessionProjection, range: ReadingWindowRange | null) {
    if (this.strong.get(p.sessionId)?.projection !== p) return false;
    if (!range || !this.shouldRemember(p)) { this.capture = null; return false; }
    const old = this.capture;
    // Layout/scroll can repeatedly report the same span. Do not rescan its history or rebuild rows.
    if (old?.sessionId === p.sessionId && old.window.rows[0]?.key === range.firstRowKey
      && old.window.rows.at(-1)?.key === range.lastRowKey && old.window.anchorKey === range.anchorKey && Number.isFinite(range.offset)) {
      if (range.surface?.navigation === old.window.surface?.navigation) {
        if (old.window.offset !== range.offset || old.window.surface?.before !== range.surface?.before || old.window.surface?.after !== range.surface?.after) {
          this.capture = { ...old, window: { ...old.window, offset: range.offset, ...(range.surface ? { surface: range.surface } : {}) } };
        }
        return true;
      }
    }
    // Failure withdraws the older anchor; it must not fill an unsupported/oversized screen.
    this.capture = null;
    const window = capture(p, range);
    if (!window) return false;
    const bytes = charge(window, WINDOWS.perEntry);
    if (bytes > WINDOWS.perEntry) return false;
    this.capture = { sessionId: p.sessionId, revision: p.revision, window, bytes };
    this.trim(p.sessionId);
    return true;
  }

  trim(selectedId: string | null) {
    let bytes = 0, rows = 0, count = selectedId && this.strong.has(selectedId) ? 1 : 0;
    for (const [id, view] of [...this.strong].reverse()) {
      if (id === selectedId) continue;
      const p = view.projection;
      const size = this.size(view);
      if (count < FULL.count && size <= FULL.perEntry && bytes + size <= FULL.total && rows + p.timeline.length <= FULL.timelineEntries) {
        count++; bytes += size; rows += p.timeline.length; continue;
      }
      this.strong.delete(id);
      // A count-only eviction of old small views follows the original six-item policy.
      if (!independent(p) || count >= FULL.count) continue;
      const captured = this.capture?.sessionId === id && this.capture.revision === p.revision ? this.capture : null;
      const weak = typeof WeakRef === 'function' ? new WeakRef(view) : undefined;
      if (!weak && !captured) continue;
      const identity = { sessionId: id, revision: p.revision, run: p.run && { runId: p.run.runId, status: p.run.status } };
      const windowBytes = captured?.bytes ?? 0, retainedBytes = charge(identity, WINDOWS.perEntry) + windowBytes + 48;
      if (retainedBytes > WINDOWS.perEntry) continue;
      this.soft.set(id, { ...identity, weak, window: captured?.window, windowBytes, bytes: retainedBytes, used: this.recency.get(view)! });
    }
    if (this.capture?.sessionId !== selectedId) this.capture = null;
    let windowBytes = this.capture?.bytes ?? 0, windowRows = this.capture?.window.rows.length ?? 0, entries = 0;
    for (const [id, x] of [...this.soft].sort((a, b) => b[1].used - a[1].used)) {
      if (++entries > WINDOWS.count || windowBytes + x.bytes > WINDOWS.total || windowRows + (x.window?.rows.length ?? 0) > WINDOWS.totalRows) this.soft.delete(id);
      else { windowBytes += x.bytes; windowRows += x.window?.rows.length ?? 0; }
    }
  }
}
