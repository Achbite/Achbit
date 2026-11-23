import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { ConversationRound } from './conversationItems';
import type { ConversationViewport } from './useConversationViewport';
import type { ConversationVirtualizer, PageMeasurements } from './conversationVirtualizer';
import { readingPages, ReadingGeometry, type ReadingRange } from './conversationReadingPages';

const typography = ['--ac-font-ui', '--ac-font-reading', '--ac-font-code', '--ac-ui-font-scale', '--ac-font-reading-size', '--ac-font-code-size'];
// Computed font family alone does not distinguish the fallback seen before font load.
function fontGeometry(doc: Document) {
  return Array.from(doc.fonts ?? []).filter(face => face.status === 'loaded').map(face => `${face.family}/${face.weight}/${face.style}`).join('|');
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, i) => value === b[i]);
function pageOf(node: Node | null | undefined, root: HTMLElement) {
  const el = node?.nodeType === 1 ? node as Element : node?.parentElement;
  const page = el?.closest<HTMLElement>('[data-reading-page]');
  return page && root.contains(page) ? Number(page.dataset.readingPage) : undefined;
}

/** Only the active transcript has a window or observers. Gaps are noninteractive scroll geometry,
 * not copies of text or disabled copies of controls. Navigation mounts its addressed page first. */
export function ConversationReadingWindow({ rounds, viewport, virtualizer, dimensions, renderRound, environment }: {
  rounds: ConversationRound[]; viewport: ConversationViewport; virtualizer: ConversationVirtualizer;
  dimensions: PageMeasurements; environment: string; renderRound(round: ConversationRound, eager?: Set<string>): ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const index = useMemo(() => readingPages(rounds), [rounds]);
  const geometry = useMemo(() => new ReadingGeometry(index, dimensions.heights), [index, dimensions]);
  const last = index.pages.length - 1;
  const around = (n: number): ReadingRange => ({ first: Math.max(0, n - 1), last: Math.min(last, n + 1) });
  const origin = viewport.openingAnchor;
  const [range, setRange] = useState(() => around(origin ? index.byAnchor.get(origin) ?? last : last));
  const [retained, setRetained] = useState<number[]>([]);
  const [, resized] = useState(0);
  const visible = new Set(retained.filter(p => p >= 0 && p <= last));
  for (let i = Math.min(range.first, last); i <= Math.min(range.last, last); i++) visible.add(i);
  const pages = [...visible].sort((a,b) => a-b), membership = pages.join(',');
  const { anchors, mountReadingPage, preserveReadingPosition } = viewport;
  // A page is small by construction; giant individual rounds retain inner row virtualization.
  const eager = useMemo(() => {
    const result = new Set<string>();
    for (const n of pages) {
      const page = index.pages[n]!;
      for (const round of rounds.slice(page.start, page.end)) {
        if (round.rows.length <= 36) for (const row of round.rows) result.add(row.key);
        else {
          const lastRow = origin ? round.rows.findIndex(row => row.key === origin) : -1;
          const k = lastRow < 0 ? round.rows.length - 1 : lastRow;
          for (const row of round.rows.slice(Math.max(0,k-10), k+11)) result.add(row.key);
        }
      }
    }
    return result;
  }, [rounds, index, membership, origin]);
  useLayoutEffect(() => {
    const root = holder.current; const body = root?.closest<HTMLElement>('.local-agent__body');
    if (!root || !body) return;
    const position = () => {
      // Until the viewport owner reveals its saved anchor, pixel offsets can still
      // describe the previous layout. Keep the requested page (and its parser) alive.
      if (body.inert || !body.clientHeight || !root.isConnected) return;
      const top = body.getBoundingClientRect().top - root.getBoundingClientRect().top;
      const next = geometry.range(top, body.clientHeight);
      const selection = root.ownerDocument.getSelection();
      const pins = new Set<number>();
      for (const node of [root.ownerDocument.activeElement, selection && !selection.isCollapsed ? selection.anchorNode : null,
        selection && !selection.isCollapsed ? selection.focusNode : null]) {
        const p = pageOf(node, root); if (p !== undefined) pins.add(p);
      }
      // Honor the existing four-preview lifetime; a new session gets a new virtualizer.
      for (const key of virtualizer.previewKeys()) { const p = index.byAnchor.get(key); if (p !== undefined) pins.add(p); }
      const keep = [...pins].sort((a,b) => a-b);
      setRetained(old => same(old,keep) ? old : keep);
      setRange(old => old.first === next.first && old.last === next.last ? old : next);
    };
    const onScroll = () => position();
    const onSelection = () => { if (!body.inert) position(); };
    // This is called only by explicit navigation/jump controls. The scroll owner immediately
    // needs the real target bounds, not the approximate location of a spacer.
    const mount = (key: string | null) => {
      const n = key === null ? last : index.byAnchor.get(key);
      if (n === undefined) return;
      flushSync(() => setRange(around(n))); anchors.invalidate();
    };
    mountReadingPage.current = mount;
    body.addEventListener('scroll', onScroll, { passive:true });
    root.ownerDocument.addEventListener('selectionchange', onSelection);
    root.addEventListener('focusout', onSelection);
    const resize = new ResizeObserver(() => position()); resize.observe(body);
    return () => {
      if (mountReadingPage.current === mount) mountReadingPage.current = null;
      body.removeEventListener('scroll', onScroll); root.removeEventListener('focusout', onSelection);
      root.ownerDocument.removeEventListener('selectionchange', onSelection); resize.disconnect();
    };
  }, [index, geometry, last, virtualizer, anchors, mountReadingPage]);
  useLayoutEffect(() => {
    const root = holder.current; if (!root) return;
    anchors.invalidate();
    const children = Array.from(root.querySelectorAll<HTMLElement>(':scope > [data-reading-page]'));
    const doc = root.ownerDocument;
    let loaded = fontGeometry(doc);
    const measure = () => {
      if (!root.isConnected || root.clientWidth <= 0) return;
      const style = getComputedStyle(root);
      const key = JSON.stringify([environment, root.clientWidth, devicePixelRatio, window.visualViewport?.scale ?? 1,
        doc.documentElement.dataset.theme, loaded, ...typography.map(name => style.getPropertyValue(name))]);
      let changed = !dimensions.validate(key);
      if (changed) geometry.reset(dimensions.heights);
      for (const el of children) {
        const n = Number(el.dataset.readingPage), h = el.getBoundingClientRect().height;
        if (h > 0) { dimensions.record(index.pages[n]!.key, h); if (geometry.measure(n,h)) changed = true; }
      }
      if (changed) { resized(s => s+1); preserveReadingPosition(); }
    };
    measure();
    const observer = new ResizeObserver(measure); children.forEach(el => observer.observe(el));
    const fontChanged = () => { loaded = fontGeometry(doc); measure(); };
    doc.fonts?.addEventListener('loadingdone', fontChanged); doc.fonts?.addEventListener('loadingerror', fontChanged);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure);
      doc.fonts?.removeEventListener('loadingdone', fontChanged); doc.fonts?.removeEventListener('loadingerror', fontChanged); };
  }, [index, dimensions, geometry, membership, environment, anchors, preserveReadingPosition]);
  const children: ReactNode[] = [];
  let next = 0;
  const addGap = (end: number) => {
    if (end > next) children.push(<div key={`gap:${next}`} aria-hidden="true" data-reading-gap="" style={{ height: geometry.offsets[end]! - geometry.offsets[next]! }} />);
  };
  for (const n of pages) {
    addGap(n);
    const page = index.pages[n]!;
    children.push(<div key={`page:${n}`} data-reading-page={n} style={{ display: 'flow-root' }}>
      {rounds.slice(page.start,page.end).map(round => renderRound(round, eager))}
    </div>);
    next = n + 1;
  }
  addGap(last + 1);
  // Pages and their equivalent gaps are separate DOM mutations. Preserve the total
  // scroll range throughout the swap so WebKit cannot clamp an in-progress jump to
  // an intermediate, shorter document. Real page measurements can still shrink it.
  return <div ref={holder} className="conversation-reading-window" style={{ minHeight: geometry.extent }}>{children}</div>;
}
