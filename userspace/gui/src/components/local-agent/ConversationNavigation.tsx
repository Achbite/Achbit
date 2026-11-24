import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ConversationNavigationEntry } from './conversationWindow';
import type { ConversationViewport } from './useConversationViewport';
import type { UiLanguage } from '../../i18n';
import { activeConversationAnchor } from './conversationNavigationPosition';

export function ConversationNavigation({ sessionId, entries, viewport, onNavigate, language }: {
  sessionId: string;
  entries: ConversationNavigationEntry[];
  viewport: ConversationViewport['reading'];
  onNavigate(entry: ConversationNavigationEntry): void;
  language: UiLanguage;
}) {
  const identity = useUiOwner('conversation.navigation', undefined, { sessionId });
  const ticksRef = useRef<HTMLDivElement>(null);
  const selectedTick = useRef<{ key: string; index: number } | null>(null);
  const [active, setActive] = useState<string>();
  const [preview, setPreview] = useState<ConversationNavigationEntry | null>(null);
  const [pointerInRail, setPointerInRail] = useState(false);
  const indices = useMemo(() => new Map(entries.map((entry, i) => [entry.key, i])), [entries]);
  const paged = entries.length > 64;
  // A tail restore can identify the same tick twice: first by follow mode, then by
  // measuring the transcript. Only a different destination may take back the rail.
  const markerIndex = (active ? indices.get(active) : undefined)
    ?? (paged && viewport.followingLatest ? entries.length - 1 : undefined);
  const markerKey = markerIndex === undefined ? active : entries[markerIndex]?.key;
  const hasRail = entries.length >= 2;
  const tick = 14; // The rail's 14 CSS-pixel controls are independent of transcript row heights.
  const [start, setStart] = useState(() => paged ? Math.max(0, entries.length - 40) : 0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const first = paged ? Math.min(start, Math.max(0, entries.length - 40)) : 0;
  const last = paged ? Math.min(entries.length, first + 40) : entries.length;
  const mounted = Array.from({ length: last - first }, (_, i) => first + i);
  if (paged && focusedIndex !== null && entries[focusedIndex] && (focusedIndex < first || focusedIndex >= last)) {
    mounted.push(focusedIndex); mounted.sort((a,b) => a-b);
  }
  const windowAt = (y: number) => Math.max(0, Math.floor(y/tick) - 6);
  const spacer = (count: number, key: string) => count > 0 ? <div aria-hidden="true" key={key} style={{ flex: `0 0 ${count * tick}px` }} /> : null;
  useEffect(() => {
    const body = viewport.bodyRef.current;
    if (!body) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const top = body.getBoundingClientRect().top + 40;
      const index = viewport.anchors.read(body);
      const anchors = index.nodes.flatMap(node => {
        const key = node.dataset.conversationAnchor!;
        return indices.has(key) ? [{ key, get top() { return node.getBoundingClientRect().top; } }] : [];
      });
      setActive(activeConversationAnchor(anchors, top, {
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        latestKey: entries.at(-1)?.key,
      }));
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    schedule();
    body.addEventListener('scroll', schedule, { passive: true });
    // Virtual rows and streamed content can move an anchor without a scroll event.
    // This observer derives the marker only; the viewport still owns all scrolling.
    const resize = new ResizeObserver(schedule);
    resize.observe(body);
    if (viewport.transcriptRef.current) resize.observe(viewport.transcriptRef.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
    return () => {
      body.removeEventListener('scroll', schedule);
      resize.disconnect();
      mutations.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [entries, indices, viewport.anchors, viewport.bodyRef, viewport.transcriptRef]);
  useLayoutEffect(() => {
    const ticks = ticksRef.current;
    if (!ticks) return;
    const reveal = () => {
      const height = ticks.clientHeight;
      if (pointerInRail || markerIndex === undefined || height <= 0) return;
      const top = ticks.scrollTop;
      const center = (markerIndex + 0.5) * tick;
      const inset = Math.min(2 * tick, height / 2);
      // Keep neighboring messages visible at a clipped edge. Only the real ends
      // of the conversation belong against the first or last visible tick.
      if (center < top + inset || center > top + height - inset) {
        const target = Math.max(0, Math.min(center - height / 2, entries.length * tick - height));
        if (Math.abs(target - top) > 0.5) ticks.scrollTop = target;
      }
      if (paged) setStart(windowAt(ticks.scrollTop));
    };
    const selected = selectedTick.current;
    selectedTick.current = null;
    // This tick was already visible when clicked. A delayed transcript measurement
    // confirms the location, but must not undo browsing for the *next* jump.
    if (paged && selected && selected.key === markerKey && selected.index === markerIndex) {
      setStart(windowAt(ticks.scrollTop));
    } else reveal();
    let height = ticks.clientHeight;
    // Hover widens the rail. That animation must not keep scrolling back to the
    // current transcript marker underneath someone wheeling toward an older message.
    const resize = new ResizeObserver(() => {
      if (ticks.clientHeight !== height) { height = ticks.clientHeight; reveal(); }
    });
    resize.observe(ticks);
    return () => resize.disconnect();
  }, [markerKey, markerIndex, entries.length, hasRail, paged, pointerInRail]);
  if (!hasRail) return null;
  const zh = language === 'zh-CN';
  return <nav className="conversation-navigation" aria-label={zh ? '对话导航' : 'Conversation navigation'}
    onPointerEnter={() => setPointerInRail(true)} onPointerLeave={() => setPointerInRail(false)}>
    <div ref={ticksRef} className="conversation-navigation__ticks"
      onScroll={paged ? e => setStart(windowAt(e.currentTarget.scrollTop)) : undefined}
      onKeyDown={paged ? event => {
        const el = (event.target as Element).closest<HTMLElement>('[data-navigation-index]');
        if (!el || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
        const i = Number(el.dataset.navigationIndex), k = event.key;
        const target = k === 'Home' ? 0 : k === 'End' ? entries.length-1 : k === 'ArrowDown' ? i+1 : k === 'ArrowUp' ? i-1
          : k === 'Tab' ? i+(event.shiftKey ? -1 : 1) : -1;
        if (target < 0 || target >= entries.length || (k === 'Tab' && mounted.includes(target))) return;
        event.preventDefault(); const rail = event.currentTarget;
        rail.scrollTop = Math.max(0, target*tick - (rail.clientHeight - tick)/2);
        flushSync(() => setStart(windowAt(rail.scrollTop)));
        rail.querySelector<HTMLElement>(`[data-navigation-index="${target}"]`)?.focus({ preventScroll:true });
      } : undefined}>
      {mounted.flatMap((index, i) => { const entry = entries[index]!; return [spacer(index - (mounted[i-1] ?? -1) - 1, `gap:${index}`), <button
        data-navigation-index={index}
        {...identity.action('jump', 'click', { rowKey: entry.key })} type="button" key={entry.key}
        aria-current={active === entry.key ? 'location' : undefined}
        aria-label={`${zh ? '跳至消息' : 'Go to message'} ${index + 1}: ${entry.label}`}
        onMouseEnter={() => setPreview(entry)} onMouseLeave={() => setPreview(null)}
        onFocus={event => { if (paged) setFocusedIndex(index); if (event.currentTarget.matches(':focus-visible')) setPreview(entry); }}
        onBlur={() => { if (paged) setFocusedIndex(null); setPreview(null); }}
        onClick={() => {
          selectedTick.current = paged && entry.key !== markerKey ? { key: entry.key, index } : null;
          onNavigate(entry);
        }}
      ><span /></button>]; })}{spacer(entries.length - (mounted.at(-1) ?? -1) - 1, 'gap:end')}
    </div>
    {preview && <div className="conversation-navigation__preview" role="tooltip">{preview.label}</div>}
  </nav>;
}
