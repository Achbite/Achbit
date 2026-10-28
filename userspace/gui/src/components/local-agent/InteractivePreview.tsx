import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { useUiLanguage } from '../../useUiLanguage';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useConversationHost } from './ConversationHost';
import { useConversationRowState, useRetainConversationPreview } from './ConversationVirtualRow';
import { readDocumentText } from './documentResources';
import { requestReader } from './readerState';
import { CodeContent } from './RichContent';
import { interactivePreviewDocument, previewArtifactId } from './interactivePreviewFrame';
import './interactivePreview.css';

export const PreviewArtifactsScope = createContext<Pick<SessionProjection, 'sessionId' | 'artifacts'> | null>(null);

export function InlineInteractivePreview({ source, pending }: { source: string; pending: boolean }) {
  const scope = useContext(PreviewArtifactsScope);
  const chinese = useUiLanguage() === 'zh-CN';
  // Only conversation presentation opts in. Quoted code in a document remains code.
  if (!scope) return <CodeContent code={source} language="achbit-preview" streaming={pending} />;
  if (pending) return <div className="interactive-preview interactive-preview--pending" role="status">{chinese ? '正在准备预览…' : 'Preparing preview…'}</div>;
  const artifactId = previewArtifactId(source);
  const artifact = scope.artifacts.find(item => item.artifactId === artifactId);
  const error = !artifactId ? (chinese ? '预览引用格式无效。' : 'Invalid preview reference.')
    : !artifact ? (chinese ? '找不到此预览制品。' : 'Preview artifact not found.')
      : artifact.contentMode !== 'fixed' || artifact.contentType !== 'text/html'
        ? (chinese ? '正文预览需要已归档的 HTML。' : 'Inline previews require archived HTML.') : null;
  if (error) return <div className="interactive-preview" role="alert">{error}</div>;
  return <ArtifactInteractivePreview key={`${scope.sessionId}:${artifactId}`} sessionId={scope.sessionId} artifact={artifact!} inline />;
}

/** Both placements read the same immutable artifact; each view owns its temporary interaction state. */
export function ArtifactInteractivePreview({ sessionId, artifact, inline = false }: {
  sessionId: string; artifact: ArtifactProjection; inline?: boolean;
}) {
  const chinese = useUiLanguage() === 'zh-CN';
  const host = useConversationHost();
  const frame = useRef<HTMLIFrameElement>(null);
  const retain = useRetainConversationPreview();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [height, setHeight] = useConversationRowState(`preview:${artifact.artifactId}:height`, 360);
  const [previouslyLoaded, setPreviouslyLoaded] = useConversationRowState(`preview:${artifact.artifactId}:loaded`, false);
  const [reloaded, setReloaded] = useState(previouslyLoaded);
  const title = artifact.label.split(/[\\/]/u).at(-1) || (chinese ? '交互预览' : 'Interactive preview');
  useEffect(() => {
    const controller = new AbortController();
    setContent(null); setError(null); setReady(false);
    void host.readArtifact(sessionId, artifact.artifactId, controller.signal).then(readDocumentText).then(text => {
      if (!controller.signal.aborted) setContent(text);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, [host, sessionId, artifact.artifactId, revision]);
  const document = useMemo(() => content === null ? undefined : interactivePreviewDocument(content), [content]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.data?.type !== 'achbit:preview') return;
      const data = event.data;
      if (data.kind === 'resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0) {
        setHeight(Math.max(160, Math.min(720, data.height)));
      } else if (data.kind === 'ready') {
        setReady(true); setPreviouslyLoaded(true); retain();
      } else if (data.kind === 'interaction') {
        retain(); setReloaded(false);
      } else if (data.kind === 'error' && typeof data.message === 'string') setError(data.message);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [retain, setHeight, setPreviouslyLoaded]);
  const sourceLabel = chinese ? (showSource ? '返回预览' : '查看源码') : (showSource ? 'Return to preview' : 'View source');
  const reloadLabel = chinese ? '重新载入预览' : 'Reload preview';
  const openLabel = chinese ? '在侧栏打开' : 'Open in sidebar';
  return <section className={`interactive-preview interactive-preview${inline ? '--inline' : '--reader'}`} data-preview-artifact={artifact.artifactId}>
    <header className="interactive-preview__toolbar">
      <strong>{title}</strong>
      <button type="button" className="reader-icon-button" title={sourceLabel} aria-label={sourceLabel} aria-pressed={showSource}
        disabled={content === null} onClick={() => { setShowSource(value => !value); retain(); }}><AchbitShellIcon name="code" /></button>
      <button type="button" className="reader-icon-button" title={reloadLabel} aria-label={reloadLabel}
        onClick={() => { setRevision(value => value + 1); setReloaded(false); retain(); }}><AchbitShellIcon name="refresh" /></button>
      {inline && <button type="button" className="reader-icon-button" title={openLabel} aria-label={openLabel}
        onClick={() => requestReader(sessionId, { kind: 'artifact', artifact, interactive: true })}><AchbitShellIcon name="expand" /></button>}
    </header>
    {error && <p className="interactive-preview__status" role="alert">{error}</p>}
    {!error && !ready && <p className="interactive-preview__status" role="status">{chinese ? '正在加载预览…' : 'Loading preview…'}</p>}
    {reloaded && ready && <small className="interactive-preview__status" role="status">{chinese ? '预览已重新载入' : 'Preview reloaded'}</small>}
    <div className="interactive-preview__source" hidden={!showSource}>{showSource && content !== null && <CodeContent code={content} language="html" />}</div>
    {document !== undefined && <iframe ref={frame} key={revision} className="interactive-preview__frame" title={title} sandbox="allow-scripts"
      srcDoc={document} hidden={showSource} style={inline ? { height } : undefined} />}
  </section>;
}
