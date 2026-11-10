import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { IconButton } from '../../ui-components';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import type { ContentImage } from './contentImage';
import './contentImage.css';

/** One local save operation per control; cancellation is a normal Host completion. */
export function ContentImageSave({ createImage, disabled, ...props }: {
  createImage(signal: AbortSignal): Promise<ContentImage>; disabled?: boolean;
} & Omit<ComponentProps<typeof IconButton>, 'icon' | 'aria-label' | 'onClick'>) {
  const language = useUiLanguage();
  const host = useConversationHost();
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  const save = async () => {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    try {
      const image = await createImage(controller.signal);
      controller.signal.throwIfAborted();
      await host.saveImage(image);
    }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = null; if (mounted.current) setBusy(false); }
  };
  return <span className="content-image-action" data-image-export-exclude="">
    <IconButton {...props} icon="download" size="compact" disabled={disabled || busy} aria-busy={busy}
      aria-label={t(language, busy ? 'content.image.saving' : 'content.image.save')} onClick={() => { void save(); }} />
    {error && <small className="content-image-error" role="alert">{t(language, 'content.image.saveError', { error })}</small>}
  </span>;
}
