import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import './imageReview.css';

/** Reuse the loaded image; fitting and zooming are local presentation state. */
export function ImageReview({ source, alt, children, className = '', imageClassName, title, onError }: {
  source?: string; alt: string; children?: ReactNode; className?: string; imageClassName?: string;
  title?: string; onError?(): void;
}) {
  const language = useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [imageSize, setImageSize] = useState<{ source: string; width: number; height: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const size = imageSize?.source === source ? imageSize : null;
  const fit = size && viewportSize.width && viewportSize.height
    ? Math.min(viewportSize.width / size.width, viewportSize.height / size.height) : null;
  const scale = zoom ?? fit;
  const minScale = Math.min(fit ?? 0.1, 0.1), maxScale = Math.max(fit ?? 8, 8);
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
    const container = viewport.current!;
    container.scrollLeft = Math.max(0, (container.scrollWidth - container.clientWidth) / 2);
    container.scrollTop = Math.max(0, (container.scrollHeight - container.clientHeight) / 2);
  }, [scale, viewportSize.width, viewportSize.height, source]);
  const changeZoom = (factor: number) => {
    if (scale !== null) setZoom(Math.min(maxScale, Math.max(minScale, scale * factor)));
  };
  const frameless = !className && typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
  return <>
    <button type="button" className={className || 'conversation-image-review__open'} disabled={!source}
      data-frameless={frameless || undefined}
      aria-label={`${t(language, 'content.image.expand')}${alt ? ` · ${alt}` : ''}`} title={title}
      onClick={() => { setZoom(null); dialog.current?.showModal(); setOpen(true); }}>
      {children ?? <img className={imageClassName} src={source} alt={alt} loading="lazy" onError={onError} />}
    </button>
    <dialog ref={dialog} className="conversation-image-review__dialog" aria-label={alt || t(language, 'content.image.expand')}
      onClose={() => setOpen(false)}
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
            disabled={scale === null || scale <= minScale} onClick={() => changeZoom(1 / 1.25)}>−</button>
          <output aria-label={t(language, 'content.image.zoom')}>{scale === null ? '—' : `${Math.round(scale * 100)}%`}</output>
          <button type="button" aria-label={t(language, 'content.image.zoomIn')} title={t(language, 'content.image.zoomIn')}
            disabled={scale === null || scale >= maxScale} onClick={() => changeZoom(1.25)}>+</button>
          <button type="button" aria-pressed={zoom === null} onClick={() => setZoom(null)}>{t(language, 'content.image.fit')}</button>
        </div>
        <button type="button" className="conversation-image-review__close" onClick={() => dialog.current?.close()}>{t(language, 'content.image.close')}</button>
      </div>
      <div ref={viewport} className="conversation-image-review__scroll" tabIndex={0}>
        <div className="conversation-image-review__canvas">{source && <img src={source} alt={alt} onError={onError}
          onLoad={event => setImageSize({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={size && scale !== null ? { width: size.width * scale, height: size.height * scale } : undefined} />}</div>
      </div>
    </dialog>
  </>;
}
