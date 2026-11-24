import { whenPreviewVisible } from './visibleImageReads';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { ContentImageSave } from './ContentImageSave';
import { elementImage, readContentImage } from './contentImage';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import type { CodeSpan } from './codeLanguage';
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useConversationSessionId } from './ConversationSessionScope';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { ImageReview } from './ImageReview';
import { RichContentScope } from './RichContentIdentity';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

export const CodeContent = memo(function CodeContent({ code, language, streaming = false, copyPending = false }: { code: string; language: string; streaming?: boolean; copyPending?: boolean }) {
  const target = useContext(RichContentScope);
  const identity = useUiOwner('conversation.code', undefined, { ...target });
  const uiLanguage = useUiLanguage();
  const host = useConversationHost();
  const content = useRef<HTMLDivElement>(null);
  const [highlightError, setHighlightError] = useState('');
  const [rendered, setRendered] = useState<{ code: string; spans: CodeSpan[] } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ code: string } | null>(null);
  const copied = copyFeedback?.code === code;
  const [copyError, setCopyError] = useState('');
  useAutoDismiss(copyFeedback, () => setCopyFeedback(null), 1500);
  useEffect(() => {
    if (streaming) return;
    let current = true;
    void import('./codeLanguage').then(({ highlightCode }) => highlightCode(code, language)).then((spans) => {
      if (current) { setRendered({ code, spans }); setHighlightError(''); }
    }).catch((error: unknown) => { if (current) { setRendered(null); setHighlightError(String(error)); } });
    return () => { current = false; };
  }, [code, language, streaming]);
  return <div className="conversation-code" ref={content}>
    <header data-image-export-exclude=""><span>{language || 'text'}</span>
      <ContentImageSave {...(target ? identity.action('save', 'click') : {})} disabled={streaming}
        createImage={() => elementImage(content.current?.querySelector('pre') ?? null, language || 'code')} />
      <button {...(target ? identity.action('copy', 'click') : {})} type="button" disabled={copyPending} className="conversation-copy-button" aria-label={t(uiLanguage, copied ? 'content.code.copied' : 'content.code.copy')} onClick={() => {
      setCopyFeedback(null); setCopyError('');
      void host.copyText(code).then(() => setCopyFeedback({ code })).catch((error: unknown) => setCopyError(String(error)));
    }}><AchbitShellIcon name={copied ? 'check' : 'copy'} /><span className="conversation-copy-hint" role="status">{t(uiLanguage, copied ? 'content.code.copied' : 'content.code.copy')}</span></button></header>
    {copyError && <small className="conversation-copy-error" role="alert">{copyError}</small>}
    {highlightError && <small role="status">{t(uiLanguage, 'content.code.highlightError', { error: highlightError })}</small>}
    {!streaming && rendered?.code === code
      ? <pre><code>{rendered.spans.map((span, index) => span.className ? <span key={index} className={span.className}>{span.text}</span> : span.text)}</code></pre>
      : <pre><code>{code}</code></pre>}
  </div>;
});

export function ImageContent({ source, alt, width, height }: { source: string; alt: string; width?: number; height?: number }) {
  const uiLanguage = useUiLanguage();
  const { loadImage } = useConversationHost();
  const slot = useRef<HTMLSpanElement>(null);
  // Archived tool images are owned by the execution record store.
  const available = useLocalAgentStore(state => !source.startsWith('artifact://') || state.runtimeReady);
  const sessionId = useConversationSessionId();
  // Each request owns its result, even when A → B → A reuses the same source spelling.
  const request = useMemo(() => ({ sessionId, source, loadImage }), [sessionId, source, loadImage]);
  const [result, setResult] = useState<{ request: typeof request; url?: string; error?: string; decodeFailed?: boolean } | null>(null);
  const current = result?.request === request ? result : null;
  const [decoded, setDecoded] = useState<typeof current>(null);
  const size = width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined;
  useEffect(() => {
    if (!slot.current || !available) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const unobserve = whenPreviewVisible(slot.current, () => request.loadImage(request.sessionId, request.source, controller.signal).then((image) => {
      if (controller.signal.aborted) { image.release?.(); return; }
      release = image.release;
      setResult({ request, url: image.url });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setResult({ request, error: String(error) }); }));
    return () => { unobserve(); controller.abort(); release?.(); };
  }, [request, available]);
  // Resolving the Host URL, decoding and failure all occupy the same slot. Never size
  // it from a late naturalWidth/Height: that would move the text the reader already sees.
  const url = current?.url;
  const outcome = current?.error || current?.decodeFailed ? 'error' : current && decoded === current ? 'ready' : 'loading';
  return <span ref={slot} className="conversation-image-review" data-reading-image={outcome} style={size ? {
    width: `min(100%, ${Math.min(size.width, 640, 320 * size.width / size.height)}px)`, aspectRatio: `${size.width} / ${size.height}`,
  } : undefined}>
    {url && <>
      <ImageReview key={url} source={url} alt={alt} intrinsicSize={size} thumbnailPending={outcome !== 'ready'} onThumbnailReady={image => {
        // A completed decode belongs to this visible thumbnail and source.
        const ready = () => { if (image.isConnected && image.naturalWidth > 0) setDecoded(current); };
        if (typeof image.decode === 'function') void image.decode().then(ready, () => {
          if (image.isConnected) setResult(previous => previous === current ? { request, decodeFailed: true } : previous);
        }); else ready();
      }} onError={() => setResult(previous =>
        previous === current ? { request, decodeFailed: true } : previous)} />
      <ContentImageSave disabled={outcome !== 'ready'} createImage={signal => readContentImage(url, alt || 'image', signal)} />
    </>}
    {outcome !== 'ready' && <span role="status">{outcome === 'loading' ? t(uiLanguage, 'content.image.loading')
      : `${alt} · ${current?.decodeFailed ? t(uiLanguage, 'content.image.decodeError') : current?.error}`}</span>}
  </span>;
}
