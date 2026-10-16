import { InterfaceLoadBoundary } from '../shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import type { UiLanguage } from '../../i18n';
import { MarkdownContent } from './BufferedMarkdown';
import { readDocumentText, type DocumentFormat } from './documentResources';
import './documentPreview.css';
import { UiPluginSlotView, useDisplayTheme } from '../../ui-plugins/UiPlugins';
import SourceFileView from './SourceFileView';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { ImageReview } from './ImageReview';

const PdfDocumentPreview = lazy(() => loadInterfaceModule(() => import('./PdfDocumentPreview')));

export function DocumentPreview({ blob, format, filename, language, readingKey, actions }: { blob: Blob; format: DocumentFormat | 'image'; filename: string; language: UiLanguage; readingKey?: string; actions?: React.ReactNode }) {
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
        {format !== 'pdf' && format !== 'image' && <button className="reader-icon-button" type="button" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}
          aria-label={showSource ? (chinese ? '返回预览' : 'Return to preview') : (chinese ? '查看源码' : 'View source')}
          title={showSource ? (chinese ? '返回预览' : 'Return to preview') : (chinese ? '查看源码' : 'View source')}>
          <DeepCodeShellIcon name="code" />
        </button>}
        <a className="reader-icon-button" href={download || undefined} download={filename.split(/[\\/]/).at(-1)} aria-label={chinese ? '下载文档' : 'Download'} title={chinese ? '下载文档' : 'Download'}>
          <DeepCodeShellIcon name="download" />
        </a>
      </div>
    </div>
    {error ? <p role="alert" className="local-agent__resource-error">{error}</p>
      : showSource ? (content === null ? loading : <SourceFileView content={content} filename={filename} viewKey={`${readingKey ?? filename}:source`} wrap />)
        : format === 'image' ? <ImageReview source={download || undefined} alt={filename} imageClassName="document-preview__image" /> : <UiPluginSlotView slot={`document.${format}`} input={{ kind: 'document', blob, format, filename, locale: language, theme }}>
          {format === 'pdf' ? <InterfaceLoadBoundary><Suspense fallback={loading}><PdfDocumentPreview blob={blob} language={language} readingKey={readingKey} /></Suspense></InterfaceLoadBoundary>
            : content === null ? loading
            : format === 'html' ? <iframe className="document-preview__html" title={filename} sandbox="" srcDoc={content} />
              : <div className="document-preview__markdown"><MarkdownContent>{content}</MarkdownContent></div>}
          </UiPluginSlotView>}
  </div>;
}
