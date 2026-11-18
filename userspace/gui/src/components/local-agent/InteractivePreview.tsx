import { IconButton } from '../../ui-components';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { useDismissibleLayer } from '../shared/useDismissibleLayer';
import { focusOpenedPanel, returnFocusTo, useInteractionFocus } from '../shared/interactionFocus';
import { ContentImageSave } from './ContentImageSave';
import { previewImage } from './previewImage';
import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { useUiLanguage } from '../../useUiLanguage';
import { useConversationHost } from './ConversationHost';
import { useConversationRowState, useRetainConversationPreview } from './ConversationVirtualRow';
import { readDocumentText } from './documentResources';
import { requestReader } from './readerState';
import { CodeContent } from './RichContent';
import { interactivePreviewDocument, previewArtifactId } from './interactivePreviewFrame';
import './interactivePreview.css';
import { usePreviewSurfaceSize } from './usePreviewSurfaceSize';
import { RichContentScope } from './RichContentIdentity';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

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
  const language = useUiLanguage(), chinese = language === 'zh-CN';
  const host = useConversationHost();
  const contentTarget = useContext(RichContentScope);
  const target = { ...(inline ? contentTarget : null), sessionId, artifactId: artifact.artifactId, location: inline ? 'inline' as const : 'reader' as const };
  const identity = useUiOwner('conversation.preview', undefined, target);
  const frame = useRef<HTMLIFrameElement>(null);
  const retain = useRetainConversationPreview();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [height, setHeight] = useConversationRowState<number | null>(`preview:${artifact.artifactId}:flowHeight`, null);
  const [page, setPage] = useConversationRowState(`preview:${artifact.artifactId}:viewportPage`, false);
  const [widths, setWidths] = useConversationRowState(`preview:${artifact.artifactId}:widths`, { preferred: 0, minimum: 0 });
  const surface = useRef<HTMLDivElement>(null);
  const available = usePreviewSurfaceSize(surface, !page && !showSource && widths.minimum > 0);
  const scale = !page && available.width > 0 && widths.minimum > available.width ? available.width / widths.minimum : 1;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [frameFocused, setFrameFocused] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), tools = useRef<HTMLDivElement>(null);
  const toolsId = useId(), interaction = useInteractionFocus();
  useDismissibleLayer({ open: toolsOpen, roots: [trigger, tools], trigger, onDismiss: () => setToolsOpen(false) });
  useLayoutEffect(() => {
    if (toolsOpen && tools.current) focusOpenedPanel(tools.current, tools.current.querySelector('button:not(:disabled)'), interaction);
  }, [toolsOpen, interaction]);
  const finishTool = () => {
    if (!toolsOpen) return;
    setToolsOpen(false); returnFocusTo(trigger.current, interaction, tools.current);
  };
  const [previouslyLoaded, setPreviouslyLoaded] = useConversationRowState(`preview:${artifact.artifactId}:loaded`, false);
  const [reloaded, setReloaded] = useState(previouslyLoaded);
  useAutoDismiss(reloaded && ready, () => setReloaded(false));
  const title = artifact.label.split(/[\\/]/u).at(-1) || (chinese ? '交互预览' : 'Interactive preview');
  useEffect(() => {
    const controller = new AbortController();
    setContent(null); setError(null); setReady(false); setFrameFocused(false);
    void host.readArtifact(sessionId, artifact.artifactId, controller.signal).then(readDocumentText).then(text => {
      if (!controller.signal.aborted) setContent(text);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, [host, sessionId, artifact.artifactId, revision]);
  const document = useMemo(() => content === null ? undefined : interactivePreviewDocument(content, inline), [content, inline]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.data?.type !== 'achbit:preview') return;
      const data = event.data;
      if (data.kind === 'resize' && Number.isFinite(data.height) && data.height >= 0) {
        setPage(data.viewport === true);
        const preferred = Number.isFinite(data.preferredWidth) && data.preferredWidth > 0 ? data.preferredWidth : 0;
        const minimum = Number.isFinite(data.minimumWidth) && data.minimumWidth > 0 ? Math.min(preferred, data.minimumWidth) : 0;
        setWidths(old => old.preferred === preferred && old.minimum === minimum ? old : { preferred, minimum });
        // A 100vh page can simply echo its viewport. Leave responsive sizing in
        // charge; content shorter or longer than the frame supplies a real height.
        if (data.viewport !== true && data.height > 0 && data.height !== data.viewportHeight) setHeight(data.height);
      } else if (data.kind === 'ready') {
        setReady(true); setPreviouslyLoaded(true); retain();
      } else if (data.kind === 'focus' && inline) {
        setFrameFocused(data.focused === true && frame.current.ownerDocument.activeElement === frame.current);
      } else if (data.kind === 'interaction') {
        retain(); setReloaded(false); setToolsOpen(false);
      } else if (data.kind === 'error' && typeof data.message === 'string') setError(data.message);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [inline, retain, setPage, setHeight, setWidths, setPreviouslyLoaded]);
  const sourceLabel = chinese ? (showSource ? '返回预览' : '查看源码') : (showSource ? 'Return to preview' : 'View source');
  const reloadLabel = chinese ? '重新载入预览' : 'Reload preview';
  const openLabel = chinese ? '在侧栏打开' : 'Open in sidebar';
  const moreLabel = chinese ? '更多预览操作' : 'More preview actions';
  const actions = <>
      <IconButton {...identity.action('toggle-source', 'click')} icon="code" size={inline ? 'compact' : 'standard'}
        aria-label={sourceLabel} aria-pressed={showSource} disabled={content === null}
        onClick={() => { setShowSource(value => !value); retain(); finishTool(); }} />
      <ContentImageSave {...identity.action('save', 'click')} disabled={!ready || showSource}
        createImage={signal => previewImage(frame.current?.contentWindow ?? null, title, signal)} />
      <IconButton {...identity.action('reload', 'click')} icon="refresh" size={inline ? 'compact' : 'standard'} aria-label={reloadLabel}
        onClick={() => { setRevision(value => value + 1); setReloaded(false); retain(); finishTool(); }} />
  </>;
  return <section {...identity.part('frame')} aria-label={title} tabIndex={inline ? 0 : undefined}
    data-frame-focused={inline && frameFocused || undefined} data-preview-ready={ready} data-preview-revision={revision}
    className={`interactive-preview interactive-preview${inline ? '--inline' : '--reader'}`} data-preview-artifact={artifact.artifactId}
    style={!page && !showSource && widths.preferred > 0 ? { '--preview-ideal-width': `${widths.preferred + (inline ? 2 : 0)}px` } as React.CSSProperties : undefined}
    data-viewport-page={inline && page || undefined} data-show-source={showSource || undefined}>
    {inline ? <div className="interactive-preview__controls" role="group" aria-label={title}>
      <div ref={tools} id={toolsId} className="interactive-preview__options" role="group" aria-label={moreLabel} tabIndex={-1} hidden={!toolsOpen}>{actions}</div>
      <IconButton {...identity.action('more', 'click')} ref={trigger} icon="more" size="compact" aria-label={moreLabel}
        aria-expanded={toolsOpen} aria-controls={toolsId} onClick={() => setToolsOpen(open => !open)} />
      <IconButton {...identity.action('open-reader', 'click')} icon="expand" size="compact" aria-label={openLabel}
        onClick={() => { setToolsOpen(false); requestReader(sessionId, { kind: 'artifact', artifact, interactive: true }); }} />
    </div> : <header className="interactive-preview__toolbar"><strong>{title}</strong>{actions}</header>}
    <div className="interactive-preview__body">
      {error && <p className="interactive-preview__status" role="alert">{error}</p>}
      {!error && !ready && <p className="interactive-preview__status" role="status">{chinese ? '正在加载预览…' : 'Loading preview…'}</p>}
      {reloaded && ready && <small className="interactive-preview__status" role="status">{chinese ? '预览已重新载入' : 'Preview reloaded'}</small>}
      <div className="interactive-preview__source" hidden={!showSource}>{showSource && content !== null && <RichContentScope.Provider value={{ ...target, contentKey: 'preview-source' }}><CodeContent code={content} language="html" /></RichContentScope.Provider>}</div>
      <div ref={surface} className="interactive-preview__surface" hidden={showSource || document === undefined}
        data-preview-layout={page ? 'adaptive' : 'flow'}
        style={!page && height !== null ? { '--preview-flow-height': `${height * scale}px` } as React.CSSProperties : undefined}>
        {document !== undefined && <iframe ref={frame} key={revision} className="interactive-preview__frame" aria-label={title} sandbox="allow-scripts"
          srcDoc={document} style={scale < 1 ? { position: 'absolute', inset: '0 auto auto 0', width: widths.minimum,
            height: `${100 / scale}%`, transformOrigin: 'top left', transform: `scale(${scale})` } : undefined} />}
      </div>
    </div>
  </section>;
}
