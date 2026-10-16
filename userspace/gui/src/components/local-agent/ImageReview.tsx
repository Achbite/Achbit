import { useRef, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import './imageReview.css';

/** Reuse the already-loaded image for the native modal's original-size view. */
export function ImageReview({ source, alt, children, className = '', imageClassName, title, onError }: {
  source?: string; alt: string; children?: ReactNode; className?: string; imageClassName?: string;
  title?: string; onError?(): void;
}) {
  const language = useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const frameless = !className && typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
  return <>
    <button type="button" className={className || 'conversation-image-review__open'} disabled={!source}
      data-frameless={frameless || undefined}
      aria-label={`${t(language, 'content.image.expand')}${alt ? ` · ${alt}` : ''}`} title={title}
      onClick={() => dialog.current?.showModal()}>
      {children ?? <img className={imageClassName} src={source} alt={alt} loading="lazy" onError={onError} />}
    </button>
    <dialog ref={dialog} className="conversation-image-review__dialog" aria-label={alt || t(language, 'content.image.expand')}>
      <button type="button" className="conversation-image-review__close" onClick={() => dialog.current?.close()}>{t(language, 'content.image.close')}</button>
      <span className="conversation-image-review__scroll">{source && <img src={source} alt={alt} onError={onError} />}</span>
    </dialog>
  </>;
}
