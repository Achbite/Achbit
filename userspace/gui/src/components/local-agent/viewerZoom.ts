export type ZoomPoint = { x: number; y: number };
type GestureEvent = Event & { scale: number; clientX?: number; clientY?: number };

const fraction = (value: number) => Math.min(1, Math.max(0, value));
export const centeredZoom = { x: .5, y: .5, viewX: .5, viewY: .5 };

/** Record the point in both coordinate systems, including any centered margins around the content. */
export function captureZoomAnchor(viewport: HTMLElement, content: Element, point?: ZoomPoint) {
  const view = viewport.getBoundingClientRect(), rect = content.getBoundingClientRect();
  if (!rect.width || !rect.height || !viewport.clientWidth || !viewport.clientHeight) return centeredZoom;
  const left = view.left + viewport.clientLeft, top = view.top + viewport.clientTop;
  const x = point?.x ?? left + viewport.clientWidth / 2, y = point?.y ?? top + viewport.clientHeight / 2;
  return { x: fraction((x - rect.left) / rect.width), y: fraction((y - rect.top) / rect.height),
    viewX: fraction((x - left) / viewport.clientWidth), viewY: fraction((y - top) / viewport.clientHeight) };
}

export function restoreZoomAnchor(viewport: HTMLElement, content: Element, anchor: typeof centeredZoom) {
  const view = viewport.getBoundingClientRect(), rect = content.getBoundingClientRect();
  viewport.scrollLeft += rect.left + anchor.x * rect.width - view.left - viewport.clientLeft - anchor.viewX * viewport.clientWidth;
  viewport.scrollTop += rect.top + anchor.y * rect.height - view.top - viewport.clientTop - anchor.viewY * viewport.clientHeight;
}

/** Image canvases use a bare wheel; readers keep ordinary scrolling for navigating their content. */
export function bindViewerZoom(viewport: HTMLElement, wheel: 'direct' | 'modified',
  zoom: (factor: number, origin: ZoomPoint) => void) {
  const listeners = new AbortController();
  const options = { passive: false, signal: listeners.signal };
  let gestureScale: number | null = null;
  let frame = 0, pendingFactor = 1;
  let origin: ZoomPoint;
  const consume = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const queue = (factor: number, x?: number, y?: number) => {
    if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return;
    const rect = viewport.getBoundingClientRect();
    origin = { x: x ?? rect.left + rect.width / 2, y: y ?? rect.top + rect.height / 2 };
    pendingFactor *= factor;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const combined = pendingFactor;
      pendingFactor = 1;
      if (combined !== 1) zoom(combined, origin);
    });
  };
  viewport.addEventListener('wheel', event => {
    if (event.defaultPrevented || !event.deltaY) return;
    const modified = event.ctrlKey || event.metaKey;
    if (!modified && (wheel === 'modified' || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) return;
    consume(event);
    if (gestureScale !== null) return; // A WebKit pinch already owns this movement.
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
    const delta = event.deltaY * unit * (modified ? .01 : .0025);
    queue(Math.exp(-Math.max(-.3, Math.min(.3, delta))), event.clientX, event.clientY);
  }, options);
  viewport.addEventListener('gesturestart', event => {
    if (event.defaultPrevented) return;
    consume(event);
    gestureScale = (event as GestureEvent).scale || 1;
  }, options);
  viewport.addEventListener('gesturechange', event => {
    if (gestureScale === null) return;
    consume(event);
    const { scale, clientX, clientY } = event as GestureEvent;
    if (!Number.isFinite(scale) || scale <= 0) return;
    queue(scale / gestureScale, clientX, clientY);
    gestureScale = scale;
  }, options);
  viewport.addEventListener('gestureend', event => {
    if (gestureScale !== null) consume(event);
    gestureScale = null;
  }, options);
  return () => { listeners.abort(); cancelAnimationFrame(frame); };
}
