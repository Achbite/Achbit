import { registerInterfaceReloadView, restoredInterfaceView } from '../../services/interfaceReload';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { readPosition } from '../../state/readingPosition';
import { ConversationAnchors, firstReadingAnchor } from './conversationAnchors';

const LATEST_TOLERANCE = 2;
function rowSequence(node: HTMLElement | undefined) {
  const value = node?.closest<HTMLElement>('[data-transcript-sequence]')?.dataset.transcriptSequence;
  return value === undefined ? undefined : Number(value);
}

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
  visibleOffset?: number;
  anchor?: { key: string; offset: number; rowKey?: string };
}

interface ConversationViewportInput {
  sessionId: string | null;
  loading: boolean;
  projection: Pick<SessionProjection, 'sessionId' | 'timeline'> | null;
  createdAt?: string;
  rememberAnchor?(sessionId: string, anchor: { key: string; offset: number } | null, sequence?: number): void;
  presentationLayoutKey: string;
  assistantDraftLayoutKey: string;
  timelineExtentKey: string;
}

export function useConversationViewport({
  sessionId,
  loading,
  projection,
  createdAt,
  rememberAnchor,
  presentationLayoutKey,
  assistantDraftLayoutKey,
  timelineExtentKey,
}: ConversationViewportInput) {
  const [followingLatest, setFollowingLatest] = useState(true);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const sessionViewportsRef = useRef(new Map<string, SessionViewport>(restoredInterfaceView<[string, SessionViewport][]>('conversationViewports', [])));
  const pendingViewportRestoreRef = useRef<string | null>(null);
  // Explicit navigation and disk restoration retain their row until the next reader gesture.
  const placedFor = useRef<string | null>(null);
  if (sessionId && !sessionViewportsRef.current.has(sessionId)) {
    const anchor = readPosition(sessionId, createdAt);
    if (anchor) {
      placedFor.current = sessionId;
      sessionViewportsRef.current.set(sessionId, { mode: 'detached', scrollTop: 0, anchor });
    }
  }
  const surface = !!projection && projection.sessionId === sessionId;
  const followingLatestRef = useRef(true);
  // Every programmatic write records its actual, browser-clamped position.
  const observedScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const touchYRef = useRef<number | null>(null);
  const mouseScrollTop = useRef<number | null>(null);
  const anchors = useRef(new ConversationAnchors()).current;
  useLayoutEffect(() => { anchors.invalidate(); });
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
    if (id && body && pendingViewportRestoreRef.current === null && anchors.read(body).nodes.length) {
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
  }, []);
  const restorePosition = useCallback((saved: SessionViewport) => {
    const body = bodyRef.current;
    if (!body) return;
    const anchor = saved.anchor;
    const node = anchor ? anchors.read(body).byKey.get(anchor.key) : undefined;
    if (!node || node.hidden || !anchor) { writeScrollTop(saved.scrollTop); return; }
    const targetTop = body.scrollTop + node.getBoundingClientRect().top - body.getBoundingClientRect().top;
    writeScrollTop(targetTop - anchor.offset);
    const offset = targetTop - observedScrollTopRef.current;
    if (saved.visibleOffset !== undefined && Math.abs(offset - saved.visibleOffset) > 0.5 && activeViewRef.current) {
      saved.visibleOffset = offset;
      rememberAnchor?.(activeViewRef.current, { key: anchor.key, offset }, rowSequence(node));
    }
  }, [anchors, writeScrollTop, rememberAnchor]);
  const applyLatestFollowMode = useCallback((following: boolean) => {
    followingLatestRef.current = following;
    setFollowingLatest(following);
  }, []);

  const setLatestFollowMode = useCallback((following: boolean) => {
    placedFor.current = null;
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
      else if (position.anchor) rememberAnchor?.(activeSessionId, position.anchor,
        rowSequence(anchors.read(bodyRef.current!).byKey.get(position.anchor.key)));
    }
  }, [applyLatestFollowMode, capturePosition, rememberAnchor, anchors]);

  const anchorDisclosure = useCallback((node: HTMLElement) => {
    const body = bodyRef.current;
    const id = activeViewRef.current;
    const key = node.dataset.conversationDisclosure ?? node.dataset.conversationAnchor;
    if (!body || !id || !key) return;
    placedFor.current = null;
    anchors.invalidate();
    applyLatestFollowMode(false);
    observedScrollTopRef.current = body.scrollTop;
    // The clicked disclosure owns this layout change, not the answer below it.
    // Retain the anchor through virtual-row measurements until the reader moves.
    const anchor = { key, offset: node.getBoundingClientRect().top - body.getBoundingClientRect().top,
      rowKey: node.dataset.conversationAnchor ?? node.parentElement?.closest<HTMLElement>('[data-conversation-anchor]')?.dataset.conversationAnchor };
    sessionViewportsRef.current.set(id, { mode: 'detached', scrollTop: body.scrollTop, anchor });
    rememberAnchor?.(id, { key, offset: anchor.offset }, rowSequence(node));
  }, [anchors, applyLatestFollowMode, rememberAnchor]);

  // Only a reader action can leave follow mode. Layout can clamp scrollTop more
  // than once before an observer runs (composer replacement, then text growth).
  // Once detached, consume native movement before restoring the reading anchor,
  // including keyboard/inertial movement whose scroll callback has not arrived.
  const sampleReaderPosition = useCallback(() => {
    const body = bodyRef.current;
    const activeSessionId = activeViewRef.current;
    // During process restoration the new WebView can clamp and scroll while rows mount.
    // Reader input releases this anchor. Ordinary detached scrolling keeps its native momentum.
    if (placedFor.current === activeSessionId || !body || !activeSessionId || followingLatestRef.current || pendingViewportRestoreRef.current !== null) return false;
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

  const placeFollowing = useCallback(() => {
    const body = bodyRef.current;
    if (body) writeScrollTop(body.scrollHeight);
  }, [writeScrollTop]);

  // Layout observers, including virtual rows, share this one position owner.
  // Ordinary React renders do not restore a previously saved reading position.
  const preserveReadingPosition = useCallback(() => {
    if (placedFor.current && placedFor.current === activeViewRef.current && pendingViewportRestoreRef.current === null) {
      const saved = sessionViewportsRef.current.get(placedFor.current);
      if (saved) restorePosition(saved);
      return;
    }
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (activeViewRef.current !== sessionId || pendingViewportRestoreRef.current !== null || sampleReaderPosition()) return;
      if (followingLatestRef.current) {
        placeFollowing();
        return;
      }
      const saved = activeViewRef.current ? sessionViewportsRef.current.get(activeViewRef.current) : undefined;
      if (saved?.mode === 'detached') restorePosition(saved);
    });
  }, [placeFollowing, restorePosition, sampleReaderPosition, sessionId]);
  const scheduleScrollToLatest = useCallback(() => {
    if (followingLatestRef.current && pendingViewportRestoreRef.current === null) preserveReadingPosition();
  }, [preserveReadingPosition]);

  useLayoutEffect(() => {
    pendingViewportRestoreRef.current = sessionId;
    mouseScrollTop.current = null;
    if (activeViewRef.current !== sessionId) {
      if (placedFor.current !== sessionId) placedFor.current = null;
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
    if (following) placeFollowing();
    else restorePosition(saved!);
  }, [sessionId, surface, applyLatestFollowMode, anchors, restorePosition, placeFollowing]);

  // New output follows the tail only while the reader is following.
  useLayoutEffect(() => {
    if (followingLatestRef.current && pendingViewportRestoreRef.current === null) placeFollowing();
  }, [projection, assistantDraftLayoutKey, presentationLayoutKey, followingLatest, placeFollowing, timelineExtentKey]);

  useEffect(() => {
    const body = bodyRef.current;
    const transcript = transcriptRef.current;
    if (typeof ResizeObserver === 'undefined' || !body || !transcript) return undefined;
    const observer = new ResizeObserver(() => {
      if (followingLatestRef.current && pendingViewportRestoreRef.current === null) placeFollowing();
      else preserveReadingPosition();
    });
    observer.observe(transcript);
    observer.observe(body);
    return () => observer.disconnect();
  }, [placeFollowing, preserveReadingPosition, sessionId, surface]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    const release = () => {
      mouseScrollTop.current = null;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  const scrollToLatest = useCallback(() => {
    setLatestFollowMode(true);
    placeFollowing();
  }, [setLatestFollowMode, placeFollowing]);

  const scrollToAnchor = useCallback((key: string, offset = 12) => {
    const body = bodyRef.current;
    if (!body) return;
    const node = anchors.read(body).byKey.get(key);
    if (!node) return;
    const target = node.getClientRects().length ? node : node.closest('.conversation-round');
    if (!target) return;
    applyLatestFollowMode(false);
    const targetTop = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    writeScrollTop(targetTop - offset);
    // Anchor the addressed message, not the last few pixels of the preceding row.
    // Offscreen placeholders above the jump may resolve or change height next frame.
    if (activeViewRef.current) {
      placedFor.current = activeViewRef.current;
      // A short page can clamp the jump. Keep the row where the reader first sees it when more content arrives.
      const visibleOffset = targetTop - observedScrollTopRef.current;
      const anchor = { key, offset: visibleOffset };
      sessionViewportsRef.current.set(activeViewRef.current, { mode: 'detached', scrollTop: body.scrollTop, anchor, visibleOffset });
      rememberAnchor?.(activeViewRef.current, anchor, rowSequence(node));
    }
  }, [anchors, applyLatestFollowMode, rememberAnchor, writeScrollTop]);

  const innerConsumesScroll = (target: EventTarget | null, direction: number) => {
    const body = bodyRef.current;
    for (let node = target as HTMLElement | null; node && node !== body; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight) continue;
      const style = window.getComputedStyle(node);
      if (!['auto', 'scroll'].includes(style.overflowY)) continue;
      if (['contain', 'none'].includes(style.overscrollBehaviorY)) return true;
      if (direction < 0 ? node.scrollTop > 0 : node.scrollHeight - node.clientHeight - node.scrollTop > 0) return true;
    }
    return false;
  };

  const beginReading = () => {
    const body = bodyRef.current;
    if (!body || !followingLatestRef.current || pendingViewportRestoreRef.current !== null
      || body.scrollHeight <= body.clientHeight || (body.scrollTop <= 0 && observedScrollTopRef.current <= 0)) return;
    // A passive wheel listener may run after the compositor has already reached zero.
    // The last position we wrote still proves this was an upward reading gesture.
    setLatestFollowMode(false);
  };

  function finishTouch() {
    touchYRef.current = null;
  }
  const bodyHandlers: React.HTMLAttributes<HTMLDivElement> = {
    tabIndex: 0,
    onWheel: (event) => {
      if (event.defaultPrevented || event.ctrlKey) return;
      if (!event.deltaY || innerConsumesScroll(event.target, event.deltaY)) return;
      placedFor.current = null;
      if (event.deltaY < 0) beginReading();
    },
    onTouchStart: (event) => { placedFor.current = null; touchYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null; },
    onTouchMove: (event) => {
      const y = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (!event.defaultPrevented && y !== null && touchYRef.current !== null) {
        const direction = Math.sign(touchYRef.current - y);
        if (!innerConsumesScroll(event.target, direction)) {
          if (direction < 0) beginReading();
        }
      }
      touchYRef.current = y;
    },
    onTouchEnd: finishTouch,
    onTouchCancel: finishTouch,
    onKeyDown: (event) => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      let direction: number;
      if (event.key === ' ') direction = event.shiftKey ? -1 : 1;
      else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) direction = -1;
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) direction = 1;
      else return;
      placedFor.current = null;
      if (innerConsumesScroll(event.target, direction)) return;
      if (direction < 0 && (event.key !== ' ' || event.target === event.currentTarget)) beginReading();
    },
    onPointerDown: (event) => {
      if (event.target === event.currentTarget && event.pointerType === 'mouse' && event.button === 0) {
        mouseScrollTop.current = event.currentTarget.scrollTop;
      }
    },
    onScroll: (event) => {
      const body = event.currentTarget;
      if (event.target !== body || (loading && !surface)) return;
      const previous = mouseScrollTop.current;
      if (previous !== null && body.scrollTop !== previous) {
        mouseScrollTop.current = body.scrollTop;
        if (Math.abs(body.scrollTop - observedScrollTopRef.current) > 0.5) {
          placedFor.current = null;
          if (body.scrollTop < previous) beginReading();
        }
      }
      if (followingLatestRef.current) scheduleScrollToLatest();
      else if (placedFor.current === activeViewRef.current) preserveReadingPosition();
      else sampleReaderPosition();
    },
  };

  const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
  const openingAnchor = saved?.mode === 'detached' ? saved.anchor?.rowKey ?? saved.anchor?.key : undefined;
  const reading = useMemo(() => ({
    bodyRef, transcriptRef, messageEndRef, anchors, followingLatest, openingAnchor,
    setLatestFollowMode, anchorDisclosure, scrollToLatest, scrollToAnchor, preserveReadingPosition,
  }), [anchors, followingLatest, openingAnchor, setLatestFollowMode, anchorDisclosure, scrollToLatest, scrollToAnchor, preserveReadingPosition]);
  return { ...reading, reading, bodyHandlers, showJumpToLatest: !followingLatest };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
