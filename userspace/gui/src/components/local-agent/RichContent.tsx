import { ContentImageSave } from './ContentImageSave';
import { elementImage, readContentImage } from './contentImage';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import type { CodeSpan } from './codeLanguage';
import { memo, useContext, useEffect, useRef, useState } from 'react';
import { useConversationSessionId } from './ConversationSessionScope';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { ImageReview } from './ImageReview';
import { RichContentScope } from './RichContentIdentity';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

export const CodeContent = memo(function CodeContent({ code, language, streaming = false }: { code: string; language: string; streaming?: boolean }) {
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
      <button {...(target ? identity.action('copy', 'click') : {})} type="button" className="conversation-copy-button" aria-label={t(uiLanguage, copied ? 'content.code.copied' : 'content.code.copy')} onClick={() => {
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

export function ImageContent({ source, alt }: { source: string; alt: string }) {
  const uiLanguage = useUiLanguage();
  const { loadImage } = useConversationHost();
  const sessionId = useConversationSessionId();
  const [result, setResult] = useState<{ source: string; url?: string; error?: string; decodeFailed?: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadImage(sessionId, source, controller.signal).then((image) => {
      if (controller.signal.aborted) { image.release?.(); return; }
      release = image.release;
      setResult({ source, url: image.url });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setResult({ source, error: String(error) }); });
    return () => { controller.abort(); release?.(); };
  }, [loadImage, sessionId, source]);
  if (result?.source !== source) return <span role="status">{t(uiLanguage, 'content.image.loading')}</span>;
  return result.url ? <span className="conversation-image-review">
    <ImageReview source={result.url} alt={alt} onError={() => setResult({ source, decodeFailed: true })} />
    <ContentImageSave createImage={signal => readContentImage(result.url!, alt || 'image', signal)} />
  </span>
    : <span role="status">{alt} · {result.decodeFailed ? t(uiLanguage, 'content.image.decodeError') : result.error}</span>;
}
