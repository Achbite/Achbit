import { useLayoutEffect } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { ConversationViewport } from './useConversationViewport';
import type { ConversationNavigationEntry } from './conversationWindow';

/** Only the real, currently readable rows can become an opening window. A soft cache may
 * keep the small result after GC, never this callback/DOM/projection. Ordinary small views do
 * not need a second snapshot. Keep normal navigation keys (never excerpt-derived action IDs). */
export function useRememberReadingWindow(projection: SessionProjection | null, viewport: ConversationViewport,
  entries: ConversationNavigationEntry[], showReasoning: boolean) {
  const { bodyRef, transcriptRef, anchors } = viewport;
  useLayoutEffect(() => {
    if (!projection || !anchors) return;
    const state = useLocalAgentStore.getState();
    if (!state.shouldRememberReadingWindow(projection)) return;
    // Do not drop a real reasoning control or build an unbounded second navigation index.
    const remember = state.rememberReadingWindow;
    if (showReasoning || entries.length > 768) { remember(projection, null); return; }
    const body = bodyRef.current, transcript = transcriptRef.current;
    if (!body || !transcript) return;
    const navigation = { keys: entries.map(e => e.key), labels: entries.map(e => e.label) };
    let frame: number | null = null;
    const capture = () => {
      frame = null;
      if (body.inert || !body.isConnected || document.visibilityState === 'hidden' || useLocalAgentStore.getState().projection !== projection) return;
      anchors.invalidate();
      const bounds = body.getBoundingClientRect();
      const nodes = anchors.read(body).nodes;
      let first = -1, last = -1;
      for (let i=0;i<nodes.length;i++) {
        const r = nodes[i]!.getBoundingClientRect();
        if (!r.height || r.bottom <= bounds.top || r.top >= bounds.bottom) continue;
        if (first < 0) first = i; last = i;
      }
      const message = (node: HTMLElement) => node.dataset.virtualRendered === 'true' && node.firstElementChild?.matches('article.local-agent__message');
      if (first < 0 || last-first >= 20 || nodes.slice(first,last+1).some(n=>!message(n))) { remember(projection, null); return; }
      const anchor = nodes[first]!;
      // A few fully measured neighbors give native wheel/keyboard movement room during recovery.
      for (let extra=0;extra<2 && first>0 && message(nodes[first-1]!);extra++) first--;
      for (let extra=0;extra<2 && last+1<nodes.length && message(nodes[last+1]!);extra++) last++;
      const start = nodes[first]!, end = nodes[last]!;
      const col = transcript.getBoundingClientRect(), css = getComputedStyle(transcript);
      remember(projection, { firstRowKey:start.dataset.conversationAnchor!, lastRowKey:end.dataset.conversationAnchor!,
        anchorKey:anchor.dataset.conversationAnchor!, offset:anchor.getBoundingClientRect().top-bounds.top,
        surface:{ before:Math.max(0,start.getBoundingClientRect().top-col.top-parseFloat(css.paddingTop || '0')),
          after:Math.max(0,col.bottom-end.getBoundingClientRect().bottom-parseFloat(css.paddingBottom || '0')), navigation } });
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(capture); };
    schedule(); body.addEventListener('scrollend',schedule); body.addEventListener('scroll',schedule,{passive:true});
    const observer = new ResizeObserver(schedule); observer.observe(body); observer.observe(transcript);
    return () => { if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); body.removeEventListener('scrollend',schedule); body.removeEventListener('scroll',schedule); };
  }, [projection, bodyRef, transcriptRef, anchors, entries, showReasoning]);
}
