import { InterfaceLoadBoundary } from '../shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import React, { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiLanguage } from '../../i18n';
import { fileLinkLocation, type SourcePosition } from './resourceLinks';
import { MarkdownContent } from './BufferedMarkdown';
import { readDocumentText, type DocumentFormat } from './documentResources';
import './documentPreview.css';
import { UiPluginSlotView, useDisplayTheme } from '../../ui-plugins/UiPlugins';
import SourceFileView from './SourceFileView';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { ImageReview } from './ImageReview';
import { HtmlDocumentFrame } from './HtmlDocumentFrame';
import { BrowserViewportControl } from './BrowserViewportControl';
import { DEFAULT_BROWSER_VIEWPORT } from './browserViewport';
import type { BrowserViewport } from '../../services/nativeBrowser';

const PdfDocumentPreview = lazy(() => loadInterfaceModule(() => import('./PdfDocumentPreview')));

function scrollToHeading(document: HTMLElement, fragment: string): boolean {
  const used = new Set<string>();
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = (heading.textContent ?? '').toLowerCase().trim()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /gu, '-');
    let id = base, occurrence = 0;
    while (used.has(id)) id = base + '-' + ++occurrence;
    if (id === fragment) { heading.scrollIntoView({ block: 'start' }); return true; }
    used.add(id);
  }
  return false;
}

function MarkdownDocument({ content, location, active }: { content: string; location?: SourcePosition; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const pending = useRef<MutationObserver | null>(null);
  const follow = (fragment?: string) => {
    pending.current?.disconnect();
    pending.current = null;
    const surface = container.current;
    if (!fragment || !surface || scrollToHeading(surface, fragment)
      || !surface.querySelector('[aria-busy="true"]')) return;
    const observe = new MutationObserver(() => {
      if (scrollToHeading(surface, fragment) || !surface.querySelector('[aria-busy="true"]')) {
        observe.disconnect();
        pending.current = null;
      }
    });
    observe.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
    pending.current = observe;
  };
  useLayoutEffect(() => {
    if (active) follow(location?.fragment);
    return () => pending.current?.disconnect();
  }, [location, content, active]);
  const followHeading = (event: React.MouseEvent<HTMLDivElement>) => {
    const href = event.target instanceof Element ? event.target.closest('a[href]')?.getAttribute('href') : null;
    if (!href || !/^[?#]/u.test(href) || event.defaultPrevented) return;
    const fragment = fileLinkLocation(href)?.fragment;
    if (!fragment) return;
    event.preventDefault();
    follow(fragment);
  };
  return <div className="document-preview__markdown" ref={container} onClickCapture={followHeading} onAuxClickCapture={followHeading}>
    <MarkdownContent active={active} documentPreview>{content}</MarkdownContent>
  </div>;
}

export function DocumentPreview({ blob, format, filename, language, readingKey, location, actions, active = true }: { active?: boolean; blob: Blob; format: DocumentFormat | 'image'; filename: string; language: UiLanguage; readingKey?: string; location?: SourcePosition; actions?: React.ReactNode }) {
  const [viewport, setViewport] = useState<BrowserViewport>(DEFAULT_BROWSER_VIEWPORT);
  useEffect(() => setViewport(DEFAULT_BROWSER_VIEWPORT), [readingKey, filename]);
  const chinese = language === 'zh-CN';
  const theme = useDisplayTheme();
  const [source, setSource] = useState<{ blob: Blob; text: string } | null>(null);
  const [download, setDownload] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null); setShowSource(false);
    const url = URL.createObjectURL(blob);
    setDownload(url);
    if (format !== 'pdf' && format !== 'image') void readDocumentText(blob).then((text) => { if (active) setSource({ blob, text }); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; URL.revokeObjectURL(url); };
  }, [blob, format]);
  const content = source?.blob === blob ? source.text : null;
  const loading = <p role="status">{chinese ? '正在读取文档…' : 'Loading document…'}</p>;
  return <div className="document-preview">
    <div className="document-preview__toolbar document-preview__file-toolbar" aria-label={chinese ? '文档操作' : 'Document actions'}>
      <span className="document-preview__format">{format === 'markdown' ? 'Markdown' : format === 'image' ? (chinese ? '图片' : 'Image') : format.toUpperCase()}</span>
      <div className="document-preview__actions">
        {actions}
        {format === 'html' && !showSource && <BrowserViewportControl value={viewport} onChange={setViewport} language={language} />}
        {format !== 'pdf' && format !== 'image' && <button className="reader-icon-button" type="button" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}
          aria-label={showSource ? (chinese ? '返回预览' : 'Return to preview') : (chinese ? '查看源码' : 'View source')}
          title={showSource ? (chinese ? '返回预览' : 'Return to preview') : (chinese ? '查看源码' : 'View source')}>
          <AchbitShellIcon name="code" />
        </button>}
        <a className="reader-icon-button" href={download || undefined} download={filename.split(/[\\/]/).at(-1)} aria-label={chinese ? '下载文档' : 'Download'} title={chinese ? '下载文档' : 'Download'}>
          <AchbitShellIcon name="download" />
        </a>
      </div>
    </div>
    {error ? <p role="alert" className="local-agent__resource-error">{error}</p>
      : showSource ? (content === null ? loading : <SourceFileView content={content} filename={filename} viewKey={`${readingKey ?? filename}:source`} wrap />)
        : format === 'image' ? <ImageReview source={download || undefined} alt={filename} imageClassName="document-preview__image"
              onError={() => setError(chinese ? '无法解码图片：' + filename : 'Could not decode the image: ' + filename)} /> : <UiPluginSlotView slot={`document.${format}`} input={{ kind: 'document', blob, format, filename, locale: language, theme }}>
          {format === 'pdf' ? <InterfaceLoadBoundary><Suspense fallback={loading}><PdfDocumentPreview blob={blob} language={language} readingKey={readingKey} /></Suspense></InterfaceLoadBoundary>
            : content === null ? loading
            : format === 'html' ? <HtmlDocumentFrame content={content} title={filename} viewport={viewport} />
              : <MarkdownDocument content={content} location={location} active={active} />}
          </UiPluginSlotView>}
  </div>;
}
