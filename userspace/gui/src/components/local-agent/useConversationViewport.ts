import { registerInterfaceReloadView, restoredInterfaceView } from '../../services/interfaceReload';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OpeningHistoryPage } from '../../services/localAgentApi';
import type { SessionProjection } from '@achbit/protocol';
import type { OpeningReadingWindow } from '../../state/recentSessionViews';
import { ConversationAnchors, firstReadingAnchor } from './conversationAnchors';
import { firstConversationFrameReady } from './firstConversationFrame';

const LATEST_TOLERANCE = 2;

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
  anchor?: { key: string; offset: number; rowKey?: string };
}

interface ConversationViewportInput {
  sessionId: string | null;
  loading: boolean;
  projection: SessionProjection | null;
  openingWindow?: OpeningReadingWindow | null;
  opening?: OpeningHistoryPage | null;
  rememberAnchor?(sessionId: string, anchor: { key: string; offset: number } | null): void;
  presentationLayoutKey: string;
  assistantDraftLayoutKey: string;
  timelineExtentKey: string;
}

export function useConversationViewport({
  sessionId,
  loading,
  projection,
  openingWindow,
  rememberAnchor,
  opening,
  presentationLayoutKey,
  assistantDraftLayoutKey,
  timelineExtentKey,
}: ConversationViewportInput) {
  const [followingLatest, setFollowingLatest] = useState(true);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  const [latestRequest, setLatestRequest] = useState(0);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const mountReadingPage = useRef<((key: string | null) => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const sessionViewportsRef = useRef(new Map<string, SessionViewport>(restoredInterfaceView<[string, SessionViewport][]>('conversationViewports', [])));
  const pendingViewportRestoreRef = useRef<string | null>(null);
  const timelineRef = useRef(projection?.timeline);
  timelineRef.current = projection?.timeline;
  const entryView = useMemo(() => sessionId ? sessionViewportsRef.current.get(sessionId) : undefined, [sessionId]);
  // Never flash the tail in place of an older saved reading position. A reader
  // who detached inside the opening messages keeps that area until handoff.
  const allowOpeningTail = entryView?.mode !== 'detached' || !!entryView.anchor?.key.startsWith('opening:');
  const openingVisible = !!sessionId && opening?.sessionId === sessionId && !projection && allowOpeningTail
    && opening.messages.some(message => !message.truncated && message.content.trim());
  const surface = projection?.sessionId === sessionId && projection ? 'timeline' : openingWindow?.sessionId === sessionId && openingWindow ? 'window' : openingVisible ? 'opening' : null;
  const followingLatestRef = useRef(true);
  // Every programmatic write records its actual, browser-clamped position.
  const observedScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const touchYRef = useRef<number | null>(null);
  const anchors = useRef(new ConversationAnchors()).current;
  useLayoutEffect(() => { anchors.invalidate(); });
  const updateContentBelow = useCallback(() => {
    const body = bodyRef.current;
    setHasContentBelow(Boolean(body && body.scrollHeight - body.clientHeight - Math.max(0, body.scrollTop) > LATEST_TOLERANCE));
  }, []);
  const capturePosition = useCallback((): Pick<SessionViewport, 'scrollTop' | 'anchor'> => {
    const body = bodyRef.current;
    if (!body) return { scrollTop: observedScrollTopRef.current };
    const top = body.getBoundingClientRect().top;
    const node = firstReadingAnchor(anchors.read(body).nodes, top);
    const bounds = node?.getBoundingClientRect();
    // Between a disclosure and the next message the next ordered row can lie below
    // the viewport. Its offset is still the reader's reference when the disclosure grows.
    return { scrollTop: body.scrollTop, ...(node && bounds
      ? { anchor: { key: node.dataset.conversationAnchor!, offset: bounds.top - top } } : {}) };
  }, [anchors]);
  useEffect(() => registerInterfaceReloadView('conversationViewports', () => {
    const id = activeViewRef.current;
    const body = bodyRef.current;
    // Don't replace a known reading position with placeholder geometry on
    // interface reload. This check never controls visibility or interaction.
    if (id && body && pendingViewportRestoreRef.current === null && firstConversationFrameReady(body, anchors.read(body).nodes)) {
      sessionViewportsRef.current.set(id, { mode: followingLatestRef.current ? 'following' : 'detached', ...capturePosition() });
    }
    return [...sessionViewportsRef.current];
  }), [anchors, capturePosition]);
  const writeScrollTop = useCallback((top: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const target = Math.max(0, Math.min(top, body.scrollHeight - body.clientHeight));
    if (Math.abs(body.scrollTop - target) > 0.5) body.scrollTop = target;
    observedScrollTopRef.current = body.scrollTop;
    updateContentBelow();
  }, [updateContentBelow]);
  const restorePosition = useCallback((saved: SessionViewport) => {
    const body = bodyRef.current;
    if (!body) return;
    const anchor = saved.anchor;
    let node = anchor ? anchors.read(body).byKey.get(anchor.key) : undefined;
    if (!node && anchor?.key.startsWith('opening:')) {
      const id = anchor.key.slice('opening:'.length);
      const row = timelineRef.current?.find(item => item.kind === 'message' && item.messageId === id);
      if (row?.kind === 'message') {
        const key = row.streamId ?? id;
        node = anchors.read(body).byKey.get(key);
        if (node) anchor.key = key;
      }
    }
    writeScrollTop(node && !node.hidden && anchor
      ? body.scrollTop + node.getBoundingClientRect().top - body.getBoundingClientRect().top - anchor.offset
      : saved.scrollTop);
  }, [anchors, writeScrollTop]);
  const applyLatestFollowMode = useCallback((following: boolean) => {
    followingLatestRef.current = following;
    setFollowingLatest(following);
  }, []);

  const setLatestFollowMode = useCallback((following: boolean) => {
    applyLatestFollowMode(following);
    const activeSessionId = activeViewRef.current;
    if (activeSessionId && pendingViewportRestoreRef.current !== activeSessionId) {
      const position = capturePosition();
      observedScrollTopRef.current = position.scrollTop;
      sessionViewportsRef.current.set(activeSessionId, {
        mode: following ? 'following' : 'detached',
        ...position,
      });
      if (following) rememberAnchor?.(activeSessionId, null);
      else if (position.anchor) rememberAnchor?.(activeSessionId, position.anchor);
    }
  }, [applyLatestFollowMode, capturePosition, rememberAnchor]);

  const anchorDisclosure = useCallback((node: HTMLElement) => {
    const body = bodyRef.current;
    const id = activeViewRef.current;
    const key = node.dataset.conversationDisclosure ?? node.dataset.conversationAnchor;
    if (!body || !id || !key) return;
    anchors.invalidate();
    applyLatestFollowMode(false);
    observedScrollTopRef.current = body.scrollTop;
    // The clicked disclosure owns this layout change, not the answer below it.
    // Retain the anchor through virtual-row measurements until the reader moves.
    sessionViewportsRef.current.set(id, {
      mode: 'detached', scrollTop: body.scrollTop,
      anchor: { key, offset: node.getBoundingClientRect().top - body.getBoundingClientRect().top,
        rowKey: node.dataset.conversationAnchor ?? node.parentElement?.closest<HTMLElement>('[data-conversation-anchor]')?.dataset.conversationAnchor },
    });
  }, [anchors, applyLatestFollowMode]);

  // Only a reader action can leave follow mode. Layout can clamp scrollTop more
  // than once before an observer runs (composer replacement, then text growth).
  // Once detached, consume native movement before restoring the reading anchor,
  // including keyboard/inertial movement whose scroll callback has not arrived.
  const sampleReaderPosition = useCallback(() => {
    const body = bodyRef.current;
    const activeSessionId = activeViewRef.current;
    if (!body || !activeSessionId || followingLatestRef.current || pendingViewportRestoreRef.current !== null) return false;
    const floor = Math.max(0, body.scrollHeight - body.clientHeight);
    const expectedTop = Math.min(observedScrollTopRef.current, floor);
    if (Math.abs(body.scrollTop - expectedTop) <= 0.5) {
      observedScrollTopRef.current = body.scrollTop;
      return false;
    }
    const following = floor - body.scrollTop <= LATEST_TOLERANCE;
    setLatestFollowMode(following);
    return true;
  }, [setLatestFollowMode]);

  // Layout observers, including virtual rows, share this one position owner.
  // Ordinary React renders do not restore a previously saved reading position.
  const preserveReadingPosition = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateContentBelow();
      if (activeViewRef.current !== sessionId || pendingViewportRestoreRef.current !== null || sampleReaderPosition()) return;
      if (followingLatestRef.current) {
        if (bodyRef.current) writeScrollTop(bodyRef.current.scrollHeight);
        return;
      }
      const saved = activeViewRef.current ? sessionViewportsRef.current.get(activeViewRef.current) : undefined;
      if (saved?.mode === 'detached') restorePosition(saved);
    });
  }, [restorePosition, sampleReaderPosition, sessionId, updateContentBelow, writeScrollTop]);
  const scheduleScrollToLatest = useCallback(() => {
    if (followingLatestRef.current && pendingViewportRestoreRef.current === null) preserveReadingPosition();
  }, [preserveReadingPosition]);

  useLayoutEffect(() => {
    pendingViewportRestoreRef.current = sessionId;
    if (activeViewRef.current !== sessionId) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      activeViewRef.current = sessionId;
      const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
      applyLatestFollowMode(saved?.mode !== 'detached');
    }
  }, [applyLatestFollowMode, sessionId]);

  useLayoutEffect(() => {
    if (!sessionId || !loading || surface) return;
    if (pendingViewportRestoreRef.current === sessionId) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    pendingViewportRestoreRef.current = sessionId;
  }, [loading, surface, sessionId]);

  useLayoutEffect(() => {
    if (!sessionId || !surface) return;
    const body = bodyRef.current;
    if (!body) return;
    const saved = sessionViewportsRef.current.get(sessionId);
    const following = saved?.mode !== 'detached';
    applyLatestFollowMode(following);
    // Position the available rows once. Later virtual-row and rich-content
    // resizes use the ordinary anchor owner, which yields to reader input.
    pendingViewportRestoreRef.current = null;
    anchors.invalidate();
    if (following) writeScrollTop(body.scrollHeight);
    else restorePosition(saved!);
  }, [sessionId, surface, applyLatestFollowMode, anchors, restorePosition, writeScrollTop]);

  useEffect(() => {
    if (followingLatest) scheduleScrollToLatest();
  }, [
    assistantDraftLayoutKey,
    presentationLayoutKey,
    followingLatest,
    scheduleScrollToLatest,
    timelineExtentKey,
  ]);

  useEffect(() => {
    const body = bodyRef.current;
    const transcript = transcriptRef.current;
    if (typeof ResizeObserver === 'undefined' || !body || !transcript) return undefined;
    const observer = new ResizeObserver(preserveReadingPosition);
    observer.observe(transcript);
    observer.observe(body);
    return () => observer.disconnect();
  }, [preserveReadingPosition, sessionId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const scrollToLatest = () => {
    mountReadingPage.current?.(null);
    setLatestRequest((value) => value + 1);
    setLatestFollowMode(true);
    scheduleScrollToLatest();
  };

  const scrollToAnchor = useCallback((key: string) => {
    const body = bodyRef.current;
    if (!body) return;
    if (!anchors.read(body).byKey.has(key)) mountReadingPage.current?.(key);
    const node = anchors.read(body).byKey.get(key);
    if (!node) return;
    const target = node.getClientRects().length ? node : node.closest('.conversation-round');
    if (!target) return;
    applyLatestFollowMode(false);
    writeScrollTop(body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12);
    // Anchor the addressed message, not the last few pixels of the preceding row.
    // Offscreen placeholders above the jump may resolve or change height next frame.
    if (activeViewRef.current) {
      const anchor = { key, offset: target.getBoundingClientRect().top - body.getBoundingClientRect().top };
      sessionViewportsRef.current.set(activeViewRef.current, { mode: 'detached', scrollTop: body.scrollTop, anchor });
      rememberAnchor?.(activeViewRef.current, anchor);
    }
  }, [anchors, applyLatestFollowMode, rememberAnchor, writeScrollTop]);

  const beginReading = (target: EventTarget | null) => {
    const body = bodyRef.current;
    if (!body || !followingLatestRef.current || pendingViewportRestoreRef.current !== null
      || body.scrollHeight <= body.clientHeight || (body.scrollTop <= 0 && observedScrollTopRef.current <= 0)) return;
    // A passive wheel listener may run after the compositor has already reached zero.
    // The last position we wrote still proves this was an upward reading gesture.
    // Code blocks and expanded documents may consume this gesture themselves.
    for (let node = target as HTMLElement | null; node && node !== body; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight) continue;
      const style = window.getComputedStyle(node);
      if (!['auto', 'scroll'].includes(style.overflowY)) continue;
      if (node.scrollTop > 0 || ['contain', 'none'].includes(style.overscrollBehaviorY)) return;
    }
    setLatestFollowMode(false);
  };

  const bodyHandlers: React.HTMLAttributes<HTMLDivElement> = {
    tabIndex: 0,
    onWheel: (event) => {
      if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0) beginReading(event.target);
    },
    onTouchStart: (event) => { touchYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null; },
    onTouchMove: (event) => {
      const y = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (!event.defaultPrevented && y !== null && touchYRef.current !== null && y > touchYRef.current) beginReading(event.target);
      touchYRef.current = y;
    },
    onTouchEnd: () => { touchYRef.current = null; },
    onTouchCancel: () => { touchYRef.current = null; },
    onKeyDown: (event) => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)
        || (event.key === ' ' && event.shiftKey && event.target === event.currentTarget)) beginReading(event.target);
    },
    onPointerDown: (event) => {
      const body = event.currentTarget;
      if (event.target !== body || event.button !== 0) return;
      const rect = body.getBoundingClientRect();
      if (body.offsetWidth > body.clientWidth && event.clientX >= rect.left + body.clientWidth) beginReading(body);
    },
    onScroll: (event) => {
      if (event.target !== event.currentTarget || (loading && !surface)) return;
      if (followingLatestRef.current) scheduleScrollToLatest();
      else sampleReaderPosition();
      updateContentBelow();
    },
  };

  const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
  const openingAnchor = saved?.mode === 'detached' ? saved.anchor?.rowKey ?? saved.anchor?.key : undefined;
  return { bodyRef, transcriptRef, messageEndRef, anchors, bodyHandlers, followingLatest, mountReadingPage, openingAnchor, allowOpeningTail, showJumpToLatest: !followingLatest && hasContentBelow,
    setLatestFollowMode, anchorDisclosure, scrollToLatest, scrollToAnchor, latestRequest, preserveReadingPosition };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
