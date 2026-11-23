import { registerInterfaceReloadView, restoredInterfaceView } from '../../services/interfaceReload';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { SessionProjection } from '@achbit/protocol';
import type { OpeningReadingWindow } from '../../state/recentSessionViews';
import { ConversationAnchors, firstReadingAnchor } from './conversationAnchors';
import { firstConversationFrameReady } from './firstConversationFrame';
import { syncConversationComposerBoundary } from './conversationComposerBoundary';

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
  rememberAnchor?(sessionId: string, anchor: { key: string; offset: number } | null): void;
  demandFullView?(window: OpeningReadingWindow): Promise<SessionProjection>;
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
  demandFullView,
  presentationLayoutKey,
  assistantDraftLayoutKey,
  timelineExtentKey,
}: ConversationViewportInput) {
  const readingId = projection?.sessionId ?? openingWindow?.sessionId;
  const waitingForRows = loading && !openingWindow;
  const previousOpening = useRef<OpeningReadingWindow | null>(null);
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
  const [shownSession, setShownSession] = useState<string | null>(null);
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
    setShownSession(null);
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
    if (!readingId) setShownSession(null);
    if (!sessionId || !waitingForRows || readingId) return;
    if (pendingViewportRestoreRef.current === sessionId) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    pendingViewportRestoreRef.current = sessionId;
  }, [waitingForRows, readingId, sessionId]);

  useLayoutEffect(() => {
    const old = previousOpening.current;
    previousOpening.current = openingWindow ?? null;
    if (old && projection && old.sessionId === sessionId && projection.sessionId === sessionId) {
      // Keep the exact reader-owned point across the sparse → canonical handoff. If
      // they scrolled into a gap, the last sampled scroll position remains authoritative.
      pendingViewportRestoreRef.current = sessionId;
      setShownSession(null);
    }
  }, [openingWindow, projection, sessionId]);

  useLayoutEffect(() => {
    if (
      !sessionId
      || pendingViewportRestoreRef.current !== sessionId
      || waitingForRows
      || readingId !== sessionId
    ) return;
    const body = bodyRef.current;
    if (!body) return;
    const saved = sessionViewportsRef.current.get(sessionId);
    const following = saved?.mode !== 'detached';
    applyLatestFollowMode(following);
    let frame: number | null = null;
    let waitingForComposer = false;
    const boundary = body.parentElement;
    const check = () => {
      if (pendingViewportRestoreRef.current !== sessionId || activeViewRef.current !== sessionId) return true;
      waitingForComposer = !syncConversationComposerBoundary(boundary);
      if (waitingForComposer) return false;
      anchors.invalidate();
      if (following) writeScrollTop(body.scrollHeight);
      else restorePosition(saved!);
      // Sparse spacers have geometry, not readable content. A remote restore is ready only
      // when a requested row is inside the viewport and its regular rich renderer is settled.
      const mounted = anchors.read(body);
      if (openingWindow?.source === 'revisionWindow') {
        const wanted = following ? openingWindow.anchorKey : saved?.anchor?.rowKey ?? saved?.anchor?.key ?? openingWindow.anchorKey;
        const node = mounted.byKey.get(wanted);
        const bounds = body.getBoundingClientRect(), rect = node?.getBoundingClientRect();
        if (!rect || !rect.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return false;
      }
      if (!firstConversationFrameReady(body, mounted.nodes)) return false;
      pendingViewportRestoreRef.current = null;
      setShownSession(sessionId);
      return true;
    };
    // A cached/simple viewport can be positioned and revealed in this commit.
    if (check()) return;
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; if (check()) dispose(); });
    };
    // The layout renderer can attach the composer's portal after React's commit but
    // before paint. Consume that actual attachment now; waiting for ResizeObserver
    // and then another animation frame flashes the opening status on a ready return.
    const panel = boundary?.parentElement;
    const attachment = waitingForComposer && panel ? new MutationObserver(() => {
      if (!syncConversationComposerBoundary(boundary)) return;
      attachment?.disconnect();
      flushSync(() => { if (check()) dispose(); });
    }) : null;
    if (attachment && panel) attachment.observe(panel, { childList: true, subtree: true });
    boundary?.addEventListener('achbit:conversation-boundary-ready', schedule);
    const changes = new MutationObserver(schedule);
    changes.observe(body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-conversation-pending', 'data-reading-image', 'data-virtual-rendered', 'hidden'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(body);
    if (transcriptRef.current) resize.observe(transcriptRef.current);
    const dispose = () => {
      attachment?.disconnect(); changes.disconnect(); resize.disconnect(); boundary?.removeEventListener('achbit:conversation-boundary-ready', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
    return dispose;
  }, [
    applyLatestFollowMode,
    waitingForRows,
    anchors,
    presentationLayoutKey,
    restorePosition,
    readingId,
    openingWindow,
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
  }, []);

  const requestFullOnMovement = () => {
    if (openingWindow?.source === 'revisionWindow' && (openingWindow.hasAfter || openingWindow.hasBefore)) {
      // The store owns cancellation/errors. The gesture is not replayed as a synthetic click.
      void demandFullView?.(openingWindow).catch(() => {});
    }
  };
  const scrollToLatest = () => {
    requestFullOnMovement();
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
      if (!event.defaultPrevented && !event.ctrlKey && event.deltaY !== 0) requestFullOnMovement();
      if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0) beginReading(event.target);
    },
    onTouchStart: (event) => { touchYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null; },
    onTouchMove: (event) => {
      const y = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (!event.defaultPrevented && y !== null && touchYRef.current !== null && y !== touchYRef.current) requestFullOnMovement();
      if (!event.defaultPrevented && y !== null && touchYRef.current !== null && y > touchYRef.current) beginReading(event.target);
      touchYRef.current = y;
    },
    onTouchEnd: () => { touchYRef.current = null; },
    onTouchCancel: () => { touchYRef.current = null; },
    onKeyDown: (event) => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) requestFullOnMovement();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)
        || (event.key === ' ' && event.shiftKey && event.target === event.currentTarget)) beginReading(event.target);
    },
    onPointerDown: (event) => {
      const body = event.currentTarget;
      if (event.target !== body || event.button !== 0) return;
      const rect = body.getBoundingClientRect();
      if (body.offsetWidth > body.clientWidth && event.clientX >= rect.left + body.clientWidth) { requestFullOnMovement(); beginReading(body); }
    },
    onScroll: (event) => {
      if (event.target !== event.currentTarget || (waitingForRows && projection === null)) return;
      if (followingLatestRef.current) scheduleScrollToLatest();
      else sampleReaderPosition();
      updateContentBelow();
    },
  };

  const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
  const openingAnchor = saved?.mode === 'detached' ? saved.anchor?.rowKey ?? saved.anchor?.key : undefined;
  return { bodyRef, transcriptRef, messageEndRef, anchors, bodyHandlers, followingLatest, mountReadingPage, openingAnchor, preparingViewport: !!sessionId && !!readingId && shownSession !== sessionId, showJumpToLatest: !followingLatest && hasContentBelow,
    setLatestFollowMode, anchorDisclosure, scrollToLatest, scrollToAnchor, latestRequest, preserveReadingPosition };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
