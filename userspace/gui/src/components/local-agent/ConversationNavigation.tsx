import { useEffect, useState } from 'react';
import type { ConversationNavigationEntry } from './conversationWindow';
import type { ConversationViewport } from './useConversationViewport';
import type { UiLanguage } from '../../i18n';
import { activeConversationAnchor } from './conversationNavigationPosition';

export function ConversationNavigation({ entries, viewport, onNavigate, language }: {
  entries: ConversationNavigationEntry[];
  viewport: ConversationViewport;
  onNavigate(entry: ConversationNavigationEntry): void;
  language: UiLanguage;
}) {
  const [active, setActive] = useState<string>();
  const [preview, setPreview] = useState<ConversationNavigationEntry | null>(null);
  useEffect(() => {
    const body = viewport.bodyRef.current;
    if (!body) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const top = body.getBoundingClientRect().top + 40;
      const index = viewport.anchors.read(body);
      const anchors = entries.flatMap(entry => {
        const node = index.byKey.get(entry.key);
        return node && !node.hidden ? [{ key: entry.key, get top() { return node.getBoundingClientRect().top; } }] : [];
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
  }, [entries, viewport.anchors, viewport.bodyRef, viewport.transcriptRef]);
  if (entries.length < 2) return null;
  const zh = language === 'zh-CN';
  return <nav className="conversation-navigation" aria-label={zh ? '对话导航' : 'Conversation navigation'}>
    <div className="conversation-navigation__ticks">
      {entries.map((entry, index) => <button
        type="button" key={entry.key}
        aria-current={active === entry.key ? 'location' : undefined}
        aria-label={`${zh ? '跳至消息' : 'Go to message'} ${index + 1}: ${entry.label}`}
        onMouseEnter={() => setPreview(entry)} onMouseLeave={() => setPreview(null)}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setPreview(entry); }} onBlur={() => setPreview(null)}
        onClick={() => onNavigate(entry)}
      ><span /></button>)}
    </div>
    {preview && <div className="conversation-navigation__preview" role="tooltip">{preview.label}</div>}
  </nav>;
}
