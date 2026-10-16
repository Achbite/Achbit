import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ConversationReaderLayout } from '../../components/local-agent/LocalAgentPanel';
import type { UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { hasNativeBrowser, nativeBrowserCommand, nativeHostBinding, type NativeHostBinding } from '../../services/nativeBrowser';
import { acceptPreview, activateDesktopPreview, computerPreviewSources, constrainPreviewPosition, previewPlacement, previewRailElements, readDesktopPreview, targetIdentity,
  type BrowserPreviewTarget, type ComputerPreview, type DesktopPreviewTarget } from '../../services/computerPreview';
import './computerTargetPreview.css';

const copy = {
  'zh-CN': { title: '正在操作', open: '显示目标', move: '拖动预览窗口，或用方向键移动', active: '实时预览', starting: '正在连接', updating: '正在更新', stopping: '正在结束', stopped: '已结束', inactive: '目标未连接', closed: '目标已关闭', failed: '预览失败', browser: '浏览器' },
  'en-US': { title: 'Working in', open: 'Show target', move: 'Drag preview, or move with arrow keys', active: 'Live preview', starting: 'Connecting', updating: 'Updating', stopping: 'Finishing', stopped: 'Finished', inactive: 'Target disconnected', closed: 'Target closed', failed: 'Preview failed', browser: 'Browser' },
};

/** Live Host view only: it never adds preview frames to the conversation. */
export function ComputerTargetPreview({ readerLayout, language, hidden }: {
  readerLayout: ConversationReaderLayout; language: UiLanguage; hidden: boolean;
}) {
  const sessionId = useLocalAgentStore(state => state.sessionId);
  const run = useLocalAgentStore(state => state.projection?.run);
  const runId = run && ['running', 'waiting'].includes(run.status) ? run.runId : null;
  const owner = `${sessionId}:${runId}`;
  const [views, setViews] = useState<{ owner: string; desktop: ComputerPreview | null; browser: ComputerPreview<BrowserPreviewTarget> | null }>({ owner, desktop: null, browser: null });
  const binding = useRef<NativeHostBinding | undefined>(undefined);
  const overlay = useRef<HTMLDivElement>(null);
  const [frontTarget, setFrontTarget] = useState<string | null>(null);
  const label = copy[language === 'zh-CN' ? 'zh-CN' : 'en-US'];
  const sources = computerPreviewSources(navigator.platform);

  useEffect(() => {
    setViews({ owner, desktop: null, browser: null }); setFrontTarget(null); binding.current = undefined;
    if (!sessionId || !runId || !hasNativeBrowser() || !sources.desktop) return;
    const abort = new AbortController();
    let desktopTimer: ReturnType<typeof setTimeout> | undefined;
    let browserTimer: ReturnType<typeof setTimeout> | undefined;
    let desktop: ComputerPreview | null = null;
    let browser: ComputerPreview<BrowserPreviewTarget> | null = null;
    let browserPreviewId: string | undefined;
    const publish = () => { if (!abort.signal.aborted) setViews({ owner, desktop, browser }); };
    const pollDesktop = async () => {
      if (abort.signal.aborted) return;
      try {
        if (!document.hidden) {
          const next = await readDesktopPreview(sessionId, runId, desktop?.frame?.sequence, abort.signal);
          if (abort.signal.aborted) return;
          desktop = acceptPreview(desktop, next); publish();
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        desktop = { state: 'failed', reason: String(error) }; publish();
      }
      desktopTimer = setTimeout(pollDesktop, 250);
    };
    const pollBrowser = async () => {
      if (abort.signal.aborted) return;
      try {
        if (!document.hidden && binding.current) {
          const next = await nativeBrowserCommand<ComputerPreview<BrowserPreviewTarget>>(binding.current,
            { action: 'controlPreview', runId, expectedPreviewId: browserPreviewId });
          if (abort.signal.aborted) return;
          if (next.target) browserPreviewId = next.target.previewId;
          browser = acceptPreview(browser, next); publish();
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        browser = { state: 'failed', reason: String(error) }; publish();
      }
      browserTimer = setTimeout(pollBrowser, 500);
    };
    void pollDesktop();
    if (sources.browser) void nativeHostBinding().then(value => {
      if (abort.signal.aborted || !value) return;
      binding.current = { ...value, sessionId }; void pollBrowser();
    }).catch(error => { if (!abort.signal.aborted) { browser = { state: 'failed', reason: String(error) }; publish(); } });
    return () => { abort.abort(); clearTimeout(desktopTimer); clearTimeout(browserTimer); };
  }, [owner, sessionId, runId, sources.desktop, sources.browser]);

  const live = views.owner === owner ? views : { desktop: null, browser: null };
  const cards = [live.desktop, live.browser].filter((view): view is ComputerPreview | ComputerPreview<BrowserPreviewTarget> => Boolean(view && (view.target || view.reason || view.frameError) && !(view.state === 'inactive' && !view.reason)));
  const concealed = hidden || readerLayout.expanded || !runId;
  return <div ref={overlay} className="computer-target-preview" hidden={concealed || cards.length === 0} aria-label={label.title}>
    {cards.map((view, index) => {
      const identity = `${owner}:${targetIdentity(view.target) ?? index}`;
      return <FloatingComputerPreview key={identity} view={view} sessionId={sessionId} runId={runId} language={language}
        readerLayout={readerLayout} concealed={concealed} index={index} overlay={overlay}
        raised={frontTarget === identity} onRaise={() => setFrontTarget(identity)} />;
    })}
  </div>;
}

/** Each exact target owns its position, bounds and activation state. */
function FloatingComputerPreview({ view, sessionId, runId, language, readerLayout, concealed, index, overlay, raised, onRaise }: {
  view: ComputerPreview<DesktopPreviewTarget | BrowserPreviewTarget>; sessionId: string | null; runId: string | null; language: UiLanguage;
  readerLayout: ConversationReaderLayout; concealed: boolean; index: number; overlay: RefObject<HTMLDivElement | null>;
  raised: boolean; onRaise(): void;
}) {
  const boundary = useRef<HTMLDivElement>(null);
  const manualPosition = useRef<{ left: number; top: number } | null>(null);
  const alignPreview = useRef<(() => void) | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = boundary.current;
    const shell = overlay.current?.parentElement;
    const conversation = readerLayout.conversationBounds ?? shell?.querySelector<HTMLElement>('.deepcode-gui-session-main');
    if (!element || !shell || !conversation) return;
    const rail = readerLayout.visible ? null : shell.querySelector<HTMLElement>('.deepcode-gui-context-panel');
    const composer = conversation.querySelector<HTMLElement>('.local-agent__composer-shell');
    let content: Element[] = [];
    const align = () => {
      const railRect = rail?.getBoundingClientRect();
      const cardsBottom = content.length ? Math.max(...content.map(child => child.getBoundingClientRect().bottom)) : railRect?.top ?? 0;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const composerTop = composer?.getBoundingClientRect().top ?? window.innerHeight;
      let position = previewPlacement(conversation.getBoundingClientRect(), railRect?.width ? railRect : null, cardsBottom, viewport, composerTop, index);
      if (manualPosition.current) {
        const bounds = (readerLayout.visible ? conversation : shell).getBoundingClientRect();
        const available = constrainPreviewPosition(manualPosition.current, { width: 240, height: 0 }, bounds, viewport, composerTop);
        element.style.width = `${available.width}px`;
        element.style.maxHeight = `${available.maxHeight}px`;
        position = constrainPreviewPosition(manualPosition.current, element.getBoundingClientRect(), bounds, viewport, composerTop);
      }
      Object.assign(element.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, maxHeight: `${position.maxHeight}px`, visibility: position.maxHeight < 64 ? 'hidden' : '' });
    };
    const observer = new ResizeObserver(align);
    for (const target of [shell, conversation, rail, composer, element]) if (target) observer.observe(target);
    const refreshContent = () => {
      const next = rail ? previewRailElements(rail) : [];
      for (const target of content) if (!next.includes(target)) observer.unobserve(target);
      for (const target of next) if (!content.includes(target)) observer.observe(target);
      content = next;
      align();
    };
    refreshContent();
    alignPreview.current = align;
    const mutation = new MutationObserver(refreshContent);
    if (rail) mutation.observe(rail, { childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'], subtree: true });
    window.addEventListener('resize', align); rail?.addEventListener('scroll', align);
    return () => {
      alignPreview.current = null;
      observer.disconnect(); mutation.disconnect(); window.removeEventListener('resize', align); rail?.removeEventListener('scroll', align);
    };
  }, [readerLayout.visible, readerLayout.expanded, readerLayout.conversationBounds, concealed, index, overlay]);

  async function activate() {
    const target = view.target;
    if (!sessionId || !runId || !target || view.state !== 'active' || activating) return;
    setActivationError(null);
    setActivating(true);
    try {
      if ('previewId' in target) {
        await nativeBrowserCommand(target, { action: 'activateControlPreview', runId, previewId: target.previewId });
      } else {
        await activateDesktopPreview(sessionId, runId, target, new AbortController().signal);
      }
    } catch (error) { if (mounted.current) setActivationError(String(error)); }
    finally { if (mounted.current) setActivating(false); }
  }

  return <div ref={boundary} className="computer-target-preview__card" style={{ zIndex: raised ? 1 : 0 }}
    onPointerDownCapture={onRaise} onFocusCapture={onRaise}>
    <ComputerPreviewTarget view={view} language={language} activating={activating} onActivate={() => void activate()}
      getPosition={() => boundary.current?.getBoundingClientRect() ?? null}
      onMove={position => { manualPosition.current = position; alignPreview.current?.(); }} />
    {(view.reason || view.frameError) && <p className="computer-target-preview__error" role="status">{view.frameError || view.reason}</p>}
    {activationError && <p className="computer-target-preview__error" role="alert">{activationError}</p>}
  </div>;
}

/** The preview image is one control: a drag moves it, a click reveals its exact bound target. */
export function ComputerPreviewTarget({ view, language, activating, onActivate, getPosition, onMove }: {
  view: ComputerPreview<DesktopPreviewTarget | BrowserPreviewTarget>; language: UiLanguage; activating: boolean;
  onActivate(): void; getPosition(): { left: number; top: number } | null; onMove(position: { left: number; top: number }): void;
}) {
  const label = copy[language === 'zh-CN' ? 'zh-CN' : 'en-US'];
  const target = view.target;
  const title = target && ('previewId' in target ? target.url : target.title || target.app);
  const stateLabel = label[view.state as keyof typeof label] ?? view.state;
  const pointer = view.pointer;
  const canActivate = view.state === 'active' && Boolean(target) && !activating;
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; handle: HTMLButtonElement } | null>(null);
  const moved = useRef(false);
  useEffect(() => () => {
    const current = drag.current;
    drag.current = null;
    if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }, []);
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const position = getPosition();
    if (event.button !== 0 || !event.isPrimary || !position) return;
    moved.current = false;
    drag.current = { left: position.left, top: position.top, pointerId: event.pointerId, x: event.clientX, y: event.clientY, handle: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!moved.current && Math.hypot(dx, dy) < 4) return;
    moved.current = true;
    event.preventDefault();
    event.currentTarget.dataset.dragging = 'true';
    onMove({ left: current.left + dx, top: current.top + dy });
  }
  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <button type="button" className="computer-target-preview__target" aria-disabled={!canActivate}
    aria-label={`${label.open} · ${label.move} · ${stateLabel}${title ? ` · ${title}` : ''}`} title={`${label.open} · ${label.move}${title ? ` · ${title}` : ''}`}
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onClick={event => {
      const wasDragged = moved.current;
      moved.current = false;
      if (wasDragged && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); return; }
      if (canActivate) onActivate();
    }}
    onKeyDown={event => {
      const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      const position = getPosition();
      if (!offset || event.altKey || event.ctrlKey || event.metaKey || !position) return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 10;
      onMove({ left: position.left + offset[0] * step, top: position.top + offset[1] * step });
    }}>
    {view.frame ? <span className="computer-target-preview__image" style={{ aspectRatio: `${view.frame.width} / ${view.frame.height}` }}>
      <img src={view.frame.dataUrl} alt={title || label.title} draggable={false} />
      {pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y) && <span className={`computer-target-preview__pointer${pointer.pulse ? ' computer-target-preview__pointer--pulse' : ''}`}
        style={{ left: `${Math.max(0, Math.min(1, pointer.x)) * 100}%`, top: `${Math.max(0, Math.min(1, pointer.y)) * 100}%` }} />}
    </span> : <span className="computer-target-preview__placeholder">{stateLabel}</span>}
    <span aria-hidden="true" className={`computer-target-preview__status computer-target-preview__status--${view.state}`} />
  </button>;
}
