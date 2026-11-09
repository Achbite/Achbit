import { useEffect, useState } from 'react';
import { IconButton } from '../../ui-components';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost, type ConversationHost } from './ConversationHost';
import { ImageReview } from './ImageReview';

export type ComposerImageSource = { dataUrl: string } | { path: string }
  | { sessionId: string | null; workspaceId: string; logicalPath: string };

/** Preview reads retain the original attachment route; submission remains with the composer. */
export async function loadComposerImage(source: ComposerImageSource, host: ConversationHost, signal: AbortSignal): Promise<{ url: string; release?(): void }> {
  signal.throwIfAborted();
  if ('dataUrl' in source) return { url: source.dataUrl };
  let blob: Blob;
  if ('path' in source) {
    if (!host.readLocalFile) throw new Error('Local file reading requires the desktop Host.');
    blob = await host.readLocalFile(source.path);
  } else {
    if (!source.sessionId) throw new Error('conversation_session_required');
    blob = await host.resources.readResourceBlob(source.sessionId,
      { workspaceId: source.workspaceId, logicalPath: source.logicalPath }, 'image', signal);
  }
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}

export function ComposerImageAttachment({ attachmentId, name, source, language, onRemove, openIdentity, removeIdentity }: {
  attachmentId: string; name: string; source: ComposerImageSource; language: UiLanguage; onRemove(): void;
  openIdentity: Readonly<Record<`data-ui-${string}`, string>>;
  removeIdentity: Readonly<Record<`data-ui-${string}`, string>>;
}) {
  const host = useConversationHost();
  const key = 'dataUrl' in source ? source.dataUrl : 'path' in source ? source.path
    : JSON.stringify([source.sessionId, source.workspaceId, source.logicalPath]);
  const [result, setResult] = useState<{ key: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if ('dataUrl' in source) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadComposerImage(source, host, controller.signal).then(image => {
      if (controller.signal.aborted) { image.release?.(); return; }
      release = image.release;
      setResult({ key, url: image.url });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { controller.abort(); release?.(); };
    // Source identity keeps typing in the draft from restarting image reads.
  }, [host, key]);
  const current = result?.key === key ? result : null;
  const url = current?.error ? undefined : 'dataUrl' in source ? source.dataUrl : current?.url;
  return <div className="local-agent__image-attachment" data-attachment-id={attachmentId}
    data-preview-state={current?.error ? 'error' : url ? 'ready' : 'loading'} title={name}>
    <ImageReview source={url} alt={name} title={name} triggerIdentity={openIdentity}
      onError={() => setResult({ key, error: t(language, 'content.image.decodeError') })}>
      {url ? <img src={url} alt={name} loading="lazy" onError={() => setResult({ key, error: t(language, 'content.image.decodeError') })} />
        : <span className="local-agent__image-attachment-status" role={current?.error ? 'alert' : 'status'} title={current?.error}>
          {current?.error ?? t(language, 'content.image.loading')}
        </span>}
    </ImageReview>
    <IconButton className="local-agent__image-attachment-remove" size="compact" variant="secondary" icon="close"
      {...removeIdentity} aria-label={t(language, 'agent.attachment.remove', { name })} onClick={onRemove} />
  </div>;
}
