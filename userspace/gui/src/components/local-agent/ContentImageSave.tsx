import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { IconButton } from '../../ui-components';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import type { ContentImage } from './contentImage';
import './contentImage.css';

async function waitForCompleteContent(control: HTMLElement, signal: AbortSignal): Promise<void> {
  const surface = control.closest<HTMLElement>('.conversation-markdown[aria-busy]');
  if (!surface) return;
  await new Promise<void>((resolve, reject) => {
    const stop = () => { observer.disconnect(); signal.removeEventListener('abort', check); };
    const check = () => {
      if (signal.aborted || !control.isConnected || control.closest('[hidden]')) {
        stop(); reject(signal.reason ?? new DOMException('Document closed', 'AbortError')); return;
      }
      if (surface.getAttribute('aria-busy') !== 'true') {
        stop();
        const error = surface.querySelector(':scope > [role="alert"]');
        if (error) reject(new Error(error.textContent ?? 'markdown_render_failed'));
        else resolve();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(surface.ownerDocument.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'hidden'] });
    signal.addEventListener('abort', check, { once: true });
    check();
  });
}

/** One local save operation per control; cancellation is a normal Host completion. */
export function ContentImageSave({ createImage, disabled, ...props }: {
  createImage(signal: AbortSignal): Promise<ContentImage>; disabled?: boolean;
} & Omit<ComponentProps<typeof IconButton>, 'icon' | 'aria-label' | 'onClick'>) {
  const language = useUiLanguage();
  const host = useConversationHost();
  const mounted = useRef(true);
  const control = useRef<HTMLSpanElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  const save = async () => {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    try {
      if (control.current) await waitForCompleteContent(control.current, controller.signal);
      const image = await createImage(controller.signal);
      controller.signal.throwIfAborted();
      await host.saveImage(image);
    }
    catch (reason) { if (mounted.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = null; if (mounted.current) setBusy(false); }
  };
  return <span ref={control} className="content-image-action" data-image-export-exclude="">
    <IconButton {...props} icon="download" size="compact" disabled={disabled || busy} aria-busy={busy}
      aria-label={t(language, busy ? 'content.image.saving' : 'content.image.save')} onClick={() => { void save(); }} />
    {error && <small className="content-image-error" role="alert">{t(language, 'content.image.saveError', { error })}</small>}
  </span>;
}
