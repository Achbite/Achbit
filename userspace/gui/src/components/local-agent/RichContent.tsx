import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import { highlightCode, type CodeSpan } from './codeLanguage';
import { memo, useEffect, useId, useState, useRef } from 'react';
import { useConversationSessionId } from './ConversationSessionScope';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

export const CodeContent = memo(function CodeContent({ code, language, streaming = false }: { code: string; language: string; streaming?: boolean }) {
  const uiLanguage = useUiLanguage();
  const host = useConversationHost();
  const [highlightError, setHighlightError] = useState('');
  const [rendered, setRendered] = useState<{ code: string; spans: CodeSpan[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (streaming) return;
    let current = true;
    void highlightCode(code, language).then((spans) => {
      if (current) { setRendered({ code, spans }); setHighlightError(''); }
    }).catch((error: unknown) => { if (current) { setRendered(null); setHighlightError(String(error)); } });
    return () => { current = false; };
  }, [code, language, streaming]);
  return <div className="conversation-code">
    <header><span>{language || 'text'}</span><button type="button" className="conversation-copy-button" aria-label={t(uiLanguage, copied ? 'content.code.copied' : 'content.code.copy')} onClick={() => {
      setCopied(false); setCopyError('');
      void host.copyText(code).then(() => setCopied(true)).catch((error: unknown) => setCopyError(String(error)));
    }}><DeepCodeShellIcon name="copy" /><span className="conversation-copy-hint" role="status">{t(uiLanguage, copied ? 'content.code.copied' : 'content.code.copy')}</span></button></header>
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
  const dialog = useRef<HTMLDialogElement>(null);
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
    <button type="button" className="conversation-image-review__open" aria-label={t(uiLanguage, 'content.image.expand')} onClick={() => dialog.current?.showModal()}>
      <img src={result.url} alt={alt} loading="lazy" onError={() => setResult({ source, decodeFailed: true })} />
    </button>
    <dialog ref={dialog} className="conversation-image-review__dialog" aria-label={alt || t(uiLanguage, 'content.image.expand')}>
      <button type="button" className="conversation-image-review__close" onClick={() => dialog.current?.close()}>{t(uiLanguage, 'content.image.close')}</button>
      <span className="conversation-image-review__scroll"><img src={result.url} alt={alt} /></span>
    </dialog>
  </span>
    : <span role="status">{alt} · {result.decodeFailed ? t(uiLanguage, 'content.image.decodeError') : result.error}</span>;
}

export function MermaidContent({ source }: { source: string }) {
  const uiLanguage = useUiLanguage();
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
      const { svg } = await mermaid.render(id, source);
      if (current) setResult({ source, svg });
    }).catch((error: unknown) => { if (current) setResult({ source, error: String(error) }); });
    return () => { current = false; };
  }, [id, source]);
  return <figure className="conversation-diagram">
    {result?.source !== source ? <span role="status">{t(uiLanguage, 'content.diagram.loading')}</span>
      : result.svg ? <div dangerouslySetInnerHTML={{ __html: result.svg }} />
        : <span role="status">{t(uiLanguage, 'content.diagram.error', { error: result.error })}</span>}
    <details><summary>{t(uiLanguage, 'content.diagram.source')}</summary><pre>{source}</pre></details>
  </figure>;
}
