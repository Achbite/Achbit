import { useEffectEvent, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { bindViewerZoom, captureZoomAnchor, centeredZoom, restoreZoomAnchor, type ZoomPoint } from './viewerZoom';
import './imageReview.css';

/** Reuse the loaded image; fitting and zooming are local presentation state. */
export function ImageReview({ source, alt, triggerIdentity, children, className = '', imageClassName, title, onError, diagram, triggerRef, hideTrigger }: {
  triggerIdentity?: Readonly<Record<`data-ui-${string}`, string>>;
  source?: string; alt: string; children?: ReactNode; className?: string; imageClassName?: string;
  title?: string; onError?(): void;
  diagram?: { width: number; height: number; entryX: number };
  triggerRef?: Ref<HTMLButtonElement>; hideTrigger?: boolean;
}) {
  const language = useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fullImage = useRef<HTMLImageElement>(null);
  const [open, setOpen] = useState(false);
  const [imageSize, setImageSize] = useState<{ source: string; width: number; height: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const size = diagram ?? (imageSize?.source === source ? imageSize : null);
  const anchor = useRef(centeredZoom);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const fit = size && viewportSize.width && viewportSize.height
    ? Math.min(viewportSize.width / size.width, viewportSize.height / size.height) : null;
  const scale = zoom ?? fit;
  const minScale = Math.min(fit ?? 0.1, 0.1);
  const maxScale = Math.max(fit ?? 1, 1) * 8; // Small images can still zoom in from their fitted size.
  useLayoutEffect(() => {
    if (!open) return;
    const container = viewport.current!;
    const measure = () => setViewportSize({ width: container.clientWidth, height: container.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open]);
  useLayoutEffect(() => {
    if (scale !== null && open && fullImage.current) restoreZoomAnchor(viewport.current!, fullImage.current, anchor.current);
  }, [open, scale, viewportSize.width, viewportSize.height, size, source]);
  const changeZoom = (factor: number, origin?: ZoomPoint) => {
    if (fit === null || !fullImage.current) return;
    anchor.current = captureZoomAnchor(viewport.current!, fullImage.current, origin);
    setZoom(previous => Math.min(maxScale, Math.max(minScale, (previous ?? fit) * factor)));
  };
  const gestureZoom = useEffectEvent(changeZoom);
  const ready = open && fit !== null;
  useLayoutEffect(() => {
    if (ready) return bindViewerZoom(viewport.current!, 'direct', gestureZoom);
  }, [ready, source]);
  const show = (event?: MouseEvent<HTMLButtonElement>) => {
    dialog.current?.showModal();
    anchor.current = centeredZoom;
    if (diagram) {
      const box = viewport.current!;
      const thumb = event?.currentTarget.querySelector('img')?.getBoundingClientRect();
      anchor.current = event?.detail && thumb?.width && thumb.height
        ? { ...centeredZoom, x: Math.max(0, Math.min(1, (event.clientX - thumb.left) / thumb.width)),
            y: Math.max(0, Math.min(1, (event.clientY - thumb.top) / thumb.height)) }
        : { ...centeredZoom, x: diagram.entryX, y: 0 };
      const fitView = Math.min(box.clientWidth / diagram.width, box.clientHeight / diagram.height);
      setZoom(Math.max(1, fitView, (thumb?.width ?? 0) / diagram.width * 1.4));
    } else { setZoom(null); }
    setOpen(true);
  };
  const frameless = !className && typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
  return <>
    <button {...triggerIdentity} ref={triggerRef} hidden={hideTrigger} type="button" className={className || 'conversation-image-review__open'} disabled={!source}
      data-frameless={frameless || undefined}
      aria-label={`${t(language, 'content.image.expand')}${alt ? ` · ${alt}` : ''}`} title={title}
      onClick={show}>
      {children ?? <img className={imageClassName} src={source} alt={alt} loading="lazy" onError={onError} />}
    </button>
    <dialog ref={dialog} data-diagram={diagram ? true : undefined} className="conversation-image-review__dialog" aria-label={alt || t(language, 'content.image.expand')}
      onClose={() => { setOpen(false); drag.current = null; }}
      onCancel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
        else if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25); }
        else if (event.key === '0') { event.preventDefault(); setZoom(null); }
      }}>
      <div className="conversation-image-review__toolbar">
        <span className="conversation-image-review__title" title={alt}>{alt}</span>
        <div className="conversation-image-review__zoom" role="group" aria-label={t(language, 'content.image.zoom')}>
          <button type="button" aria-label={t(language, 'content.image.zoomOut')} title={t(language, 'content.image.zoomOut')}
            disabled={scale === null || scale <= minScale} onClick={() => changeZoom(1 / 1.25)}>{diagram ? <AchbitShellIcon name="minus" /> : '−'}</button>
          <output aria-label={t(language, 'content.image.zoom')}>{scale === null ? '—' : `${Math.round(scale * 100)}%`}</output>
          <button type="button" aria-label={t(language, 'content.image.zoomIn')} title={t(language, 'content.image.zoomIn')}
            disabled={scale === null || scale >= maxScale} onClick={() => changeZoom(1.25)}>{diagram ? <AchbitShellIcon name="plus" /> : '+'}</button>
          <button type="button" aria-pressed={zoom === null} onClick={() => setZoom(null)}>{t(language, 'content.image.fit')}</button>
        </div>
        <button type="button" className="conversation-image-review__close" aria-label={t(language, 'content.image.close')} onClick={() => dialog.current?.close()}>
          {diagram ? <AchbitShellIcon name="close" /> : t(language, 'content.image.close')}</button>
      </div>
      <div ref={viewport} className="conversation-image-review__scroll" tabIndex={0} data-pannable={fit !== null && scale !== null && scale > fit || undefined}
        onPointerDown={event => {
          if (event.pointerType === 'touch' || event.button !== 0 || !event.isPrimary) return;
          const box = event.currentTarget;
          if (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight) return;
          drag.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
          box.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (start) event.currentTarget.scrollTo(start.left + start.x - event.clientX, start.top + start.y - event.clientY);
        }}
        onLostPointerCapture={() => { drag.current = null; }}>
        <div className="conversation-image-review__canvas">{source && <img ref={fullImage} src={source} alt={alt} onError={onError} draggable={false}
          onLoad={event => setImageSize({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={size && scale !== null ? { width: size.width * scale, height: size.height * scale } : undefined} />}</div>
      </div>
    </dialog>
  </>;
}
