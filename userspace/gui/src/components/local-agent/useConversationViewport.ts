import { registerInterfaceReloadView, restoredInterfaceView } from '../../services/interfaceReload';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionProjection } from '@deepcode/protocol';
import { ConversationAnchors, firstReadingAnchor } from './conversationAnchors';

const LATEST_TOLERANCE = 2;

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
  anchor?: { key: string; offset: number };
}

interface ConversationViewportInput {
  sessionId: string | null;
  loading: boolean;
  projection: SessionProjection | null;
  presentationLayoutKey: string;
  assistantDraftLayoutKey: string;
  timelineExtentKey: string;
}

export function useConversationViewport({
  sessionId,
  loading,
  projection,
  presentationLayoutKey,
  assistantDraftLayoutKey,
  timelineExtentKey,
}: ConversationViewportInput) {
  const [followingLatest, setFollowingLatest] = useState(true);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  const [latestRequest, setLatestRequest] = useState(0);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const sessionViewportsRef = useRef(new Map<string, SessionViewport>(restoredInterfaceView<[string, SessionViewport][]>('conversationViewports', [])));
  const pendingViewportRestoreRef = useRef<string | null>(null);
  const followingLatestRef = useRef(true);
  // Every programmatic write records its actual, browser-clamped position.
  const observedScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);
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
    return { scrollTop: body.scrollTop, ...(node ? { anchor: { key: node.dataset.conversationAnchor!, offset: node.getBoundingClientRect().top - top } } : {}) };
  }, [anchors]);
  useEffect(() => registerInterfaceReloadView('conversationViewports', () => {
    const id = activeViewRef.current;
    if (id) sessionViewportsRef.current.set(id, { mode: followingLatestRef.current ? 'following' : 'detached', ...capturePosition() });
    return [...sessionViewportsRef.current];
  }), [capturePosition]);
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
    const node = anchor ? anchors.read(body).byKey.get(anchor.key) : undefined;
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
    }
  }, [applyLatestFollowMode, capturePosition]);

  const anchorDisclosure = useCallback((node: HTMLElement) => {
    const body = bodyRef.current;
    const id = activeViewRef.current;
    const key = node.dataset.conversationAnchor;
    if (!body || !id || !key) return;
    applyLatestFollowMode(false);
    observedScrollTopRef.current = body.scrollTop;
    // The clicked disclosure owns this layout change, not the answer below it.
    // Retain the anchor through virtual-row measurements until the reader moves.
    sessionViewportsRef.current.set(id, {
      mode: 'detached', scrollTop: body.scrollTop,
      anchor: { key, offset: node.getBoundingClientRect().top - body.getBoundingClientRect().top },
    });
  }, [applyLatestFollowMode]);

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
    if (activeViewRef.current !== sessionId) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      pendingViewportRestoreRef.current = sessionId;
      activeViewRef.current = sessionId;
      const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
      applyLatestFollowMode(saved?.mode !== 'detached');
    }
  }, [applyLatestFollowMode, sessionId]);

  useLayoutEffect(() => {
    if (!sessionId || !loading || projection !== null) return;
    if (pendingViewportRestoreRef.current === sessionId) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    pendingViewportRestoreRef.current = sessionId;
  }, [loading, projection, sessionId]);

  useLayoutEffect(() => {
    if (
      !sessionId
      || pendingViewportRestoreRef.current !== sessionId
      || loading
      || projection?.sessionId !== sessionId
    ) return;
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
    const targetSessionId = sessionId;
    viewportRestoreFrameRef.current = window.requestAnimationFrame(() => {
      viewportRestoreFrameRef.current = null;
      if (
        activeViewRef.current !== targetSessionId
        || pendingViewportRestoreRef.current !== targetSessionId
      ) return;
      const body = bodyRef.current;
      if (!body) return;
      const saved = sessionViewportsRef.current.get(targetSessionId);
      const following = saved?.mode !== 'detached';
      applyLatestFollowMode(following);
      if (following) writeScrollTop(body.scrollHeight);
      else restorePosition(saved!);
      pendingViewportRestoreRef.current = null;
    });
  }, [
    applyLatestFollowMode,
    loading,
    presentationLayoutKey,
    restorePosition,
    projection?.sessionId,
    sessionId,
    timelineExtentKey,
    writeScrollTop,
  ]);

  useEffect(() => {
    if (followingLatest) scheduleScrollToLatest();
  }, [
    assistantDraftLayoutKey,
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
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
  }, []);

  const scrollToLatest = () => {
    setLatestRequest((value) => value + 1);
    setLatestFollowMode(true);
    scheduleScrollToLatest();
  };

  const scrollToAnchor = useCallback((key: string) => {
    const body = bodyRef.current;
    const node = body && anchors.read(body).byKey.get(key);
    if (!body || !node) return;
    applyLatestFollowMode(false);
    const target = node.getClientRects().length ? node : node.closest('.conversation-round')!;
    writeScrollTop(body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12);
    if (activeViewRef.current) sessionViewportsRef.current.set(activeViewRef.current, {
      mode: 'detached', ...capturePosition(),
    });
  }, [anchors, applyLatestFollowMode, capturePosition, writeScrollTop]);

  const beginReading = (target: EventTarget | null) => {
    const body = bodyRef.current;
    if (!body || !followingLatestRef.current || body.scrollTop <= 0 || pendingViewportRestoreRef.current !== null) return;
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
      if (event.target !== event.currentTarget || (loading && projection === null)) return;
      if (followingLatestRef.current) scheduleScrollToLatest();
      else sampleReaderPosition();
      updateContentBelow();
    },
  };

  return { bodyRef, transcriptRef, messageEndRef, anchors, bodyHandlers, followingLatest, showJumpToLatest: !followingLatest && hasContentBelow,
    setLatestFollowMode, anchorDisclosure, scrollToLatest, scrollToAnchor, latestRequest, preserveReadingPosition };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
