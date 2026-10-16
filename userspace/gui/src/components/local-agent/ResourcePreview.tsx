import ResizeHandle from '../shared/ResizeHandle';
import { usePaneWidth } from '../shared/usePaneWidth';
import { PANE_GEOMETRY, boundedPaneWidth } from '../shared/paneGeometry';
import { readDocumentText } from './documentResources';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { AgentConversationPage } from './AgentTasksPanel';
import SshConnection from '../../deepcode-gui/layout/SshConnection';
import { ResourceTree } from './ResourceTree';
import { FileChangePreview } from './FileChanges';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import { restoredInterfaceView, takeRestoredInterfaceView, useInterfaceReloadView } from '../../services/interfaceReload';
import type { BrowserAnnotation, BrowserAnnotationDraft, BrowserReviewEdit } from './browserReview';
import { nextEnabledIndex } from '../shared/keyboardNavigation';
import { InterfaceLoadBoundary } from '../shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import { createPortal } from 'react-dom';
import { useId, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useConversationHost } from './ConversationHost';
import type { SourcePosition } from './resourceLinks';
import { t, type UiLanguage } from '../../i18n';
import {
  readConversationArtifact,
  type ConversationResourceReadResult,
} from '../../services/localAgentApi';
import { documentFormat, type DocumentFormat } from './documentResources';
import { READER_OPEN_EVENT, readViewState, saveViewState, reconcileReaderPages, type ReaderViewState, type ReaderTab, type ResolvedReaderTarget, type ReaderTarget, readerTargetKey as targetKey } from './readerState';
import { NativeBrowserPreview } from './NativeBrowserPreview';
import {
  hasNativeBrowser,
  listenNativeActivation,
  nativeBrowserCommand,
  nativeHostBinding,
  nativeNavigationInput,
  watchNativePages,
  type NativeHostBinding,
  type NativePage,
} from '../../services/nativeBrowser';
import { useSettingsStore } from '../../state/settingsStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import ProjectFolderDialog from '../workspace-open-dialog/ProjectFolderDialog';
import './documentPreview.css';
import type { ReaderNavigation } from './readerState';

const DocumentPreview = lazy(() =>
  loadInterfaceModule(() => import('./DocumentPreview').then((module) => ({ default: module.DocumentPreview }))),
);
const SourceFileView = lazy(() => loadInterfaceModule(() => import('./SourceFileView')));
type DocumentState =
  | { status: 'loading' }
  | { status: 'document'; blob: Blob; format: DocumentFormat | 'image' }
  | { status: 'source'; content: string }
  | { status: 'text'; result: ConversationResourceReadResult }
  | { status: 'error'; error: string };
export function readerFilename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || path
  );
}
export function readerPageName(url: string): string {
  try {
    const value = new URL(url);
    return value.protocol === 'file:'
      ? readerFilename(decodeURIComponent(value.pathname))
      : value.host || url;
  } catch {
    return url;
  }
}
function tabName(tab: ReaderTab, language: UiLanguage): string {
  if (tab.page) return readerPageName(tab.page.url);
  if (tab.target.kind === 'agent') return t(language, 'agent.page.title');
  if (tab.target.kind === 'diff') return readerFilename(tab.target.file.path) + ' · diff';
  if (tab.target.kind === 'resource') return tab.target.name;
  if (tab.target.kind === 'file') return readerFilename(tab.target.path);
  if (tab.target.kind === 'workspace') return readerFilename(tab.target.logicalPath);
  if (tab.target.kind === 'artifact') return readerFilename(tab.target.artifact.label);
  return tab.target.selfPreview
    ? 'DeepCode'
    : tab.target.filePath
      ? readerFilename(tab.target.filePath)
      : tab.target.url
        ? readerPageName(tab.target.url)
        : language === 'zh-CN' ? '浏览器' : 'Browser';
}

/** View state owns open tabs; a collapsed panel keeps their content and native pages mounted. */
export function useResourcePreview(sessionId: string | null, navigation?: ReaderNavigation) {
  const host = useConversationHost();
  const [state, setState] = useState<ReaderViewState>({ sessionId, tabs: [], activeId: null, visible: false, expanded: false });
  useInterfaceReloadView('reader', { ...state, tabs: state.tabs.map(tab => tab.page ? { ...tab, target: { kind: 'browser', previewId: tab.page.previewId } } : tab) });
  const [treeVisible, setTreeVisible] = useState(() => readViewState('file-tree', true));
  const [width, setWidth] = useState(() => readViewState<number>('panel-width', PANE_GEOMETRY.preview.initial));
  const [error, setError] = useState<string | null>(null);
  const [reviewEdit, setReviewEdit] = useState<(BrowserReviewEdit & { sessionId: string | null }) | null>(null);
  const bindings = useRef(new Map<string, NativeHostBinding>());
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const live =
    state.sessionId === sessionId
      ? state
      : { sessionId, tabs: [], activeId: null, visible: false, expanded: false };
  const selectTarget = useCallback(
    (target: ResolvedReaderTarget) => {
      if (!sessionId) return;
      const key = targetKey(target);
      setState((old) => {
        const tabs = old.sessionId === sessionId ? old.tabs : [];
        const existing = tabs.find(
          (tab) =>
            tab.id === key ||
            (target.kind === 'browser' &&
              target.previewId &&
              tab.page?.previewId === target.previewId),
        );
        return {
          sessionId,
          tabs: existing ? tabs.map((tab) => tab === existing && (target.kind === 'workspace' || target.kind === 'agent') ? { ...tab, target } : tab) : [...tabs, { id: key, target }],
          activeId: existing?.id ?? key,
          visible: true,
          expanded: old.sessionId === sessionId && old.expanded,
        };
      });
      saveViewState(sessionId + ':selection', target);
      setError(null);
    },
    [sessionId],
  );
  const openTarget = useCallback((target: ReaderTarget) => {
    if (!sessionId) return;
    if (target.kind !== 'browser') {
      selectTarget(target);
      return;
    }
    if (target.previewId) {
      selectTarget({ ...target, previewId: target.previewId });
      return;
    }
    const open = async () => {
      const binding = await nativeHostBinding();
      if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
      const page = await nativeBrowserCommand<NativePage>({ ...binding, sessionId }, target.selfPreview
        ? { action: 'openSelf' }
        : { action: 'open', ...(target.filePath ? { filePath: target.filePath } : nativeNavigationInput(target.url ?? '')) });
      if (currentSession.current === sessionId) selectTarget({ kind: 'browser', previewId: page.previewId });
    };
    void open().catch((reason) => { if (currentSession.current === sessionId) setError(String(reason)); });
  }, [sessionId, selectTarget]);
  useEffect(() => {
    bindings.current.clear();
    setState(current => current.sessionId === sessionId ? current : { sessionId, tabs: [], activeId: null, visible: false, expanded: false });
    setError(null);
    if (!sessionId) return;
    const saved = readViewState<ReaderTarget | null>(sessionId + ':selection', null);
    const restored = restoredInterfaceView<typeof state | null>('reader', null);
    if (restored?.sessionId === sessionId) takeRestoredInterfaceView('reader', null);
    if (restored?.sessionId === sessionId) setState(restored);
    else if (saved && saved.kind !== 'browser') openTarget(saved);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; target: ReaderTarget }>).detail;
      if (detail.sessionId === sessionId) openTarget(detail.target);
      // A child result opens in the main view, retaining its own file/archive identity.
      else if (detail.target.kind !== 'browser') openTarget({ ...detail.target, sourceSessionId: detail.sessionId });
    };
    window.addEventListener(READER_OPEN_EVENT, listener);
    return () => window.removeEventListener(READER_OPEN_EVENT, listener);
  }, [sessionId, openTarget]);
  const request = navigation?.request;
  useEffect(() => {
    if (!request || request.location.sessionId !== sessionId) return;
    const { target, visible, expanded } = request.location;
    if (target) selectTarget(target);
    else saveViewState(sessionId + ':selection', null);
    setState(old => ({ ...old, sessionId, activeId: target ? old.activeId : null, visible, expanded }));
  }, [request, sessionId, selectTarget]);
  const selectedTarget = live.tabs.find(tab => tab.id === live.activeId)?.target ?? null;
  const onNavigationChange = navigation?.onChange;
  useEffect(() => {
    // Wait for this session's reader state to settle before reporting a location.
    if (state.sessionId === sessionId) onNavigationChange?.({ sessionId, target: selectedTarget, visible: live.visible, expanded: live.expanded });
  }, [sessionId, state.sessionId, selectedTarget, live.visible, live.expanded, onNavigationChange]);
  useEffect(() => {
    if (!sessionId || !hasNativeBrowser()) return;
    let ended = false;
    let dispose: (() => void) | undefined;
    let savedSelection = readViewState<ReaderTarget | null>(sessionId + ':selection', null);
    void (async () => {
      const binding = await nativeHostBinding();
      if (ended || !binding) return;
      dispose = await watchNativePages({ ...binding, sessionId }, pages => {
        if (ended) return;
        const selection = savedSelection;
        savedSelection = null;
        setState(current => current.sessionId === sessionId ? reconcileReaderPages(current, pages, selection) : current);
      });
      if (ended) dispose();
    })().catch(reason => { if (!ended) setError(String(reason)); });
    return () => { ended = true; dispose?.(); };
  }, [sessionId]);
  const activationTarget = useRef(openTarget); activationTarget.current = openTarget;
  useEffect(() => {
    if (!hasNativeBrowser()) return;
    let ended = false;
    let unlisten: (() => void) | undefined;
    void listenNativeActivation(page => {
      if (ended) return;
      if (page.sessionId !== currentSession.current) {
        void nativeBrowserCommand(page, { action: 'activationResult', previewId: page.previewId,
          activationId: page.surface.activationId, reason: 'sessionNotSelected' }).catch(reason => setError(String(reason)));
        return;
      }
      activationTarget.current({ kind: 'browser', previewId: page.previewId });
      window.dispatchEvent(new CustomEvent('deepcode:browser-layout', { detail: page }));
    }).then(dispose => { if (ended) dispose(); else unlisten = dispose; })
      .catch(reason => { if (!ended) setError(String(reason)); });
    return () => { ended = true; unlisten?.(); };
  }, []);
  const openWorkspaceResource = async (workspaceId: string, logicalPath: string, position?: SourcePosition) => {
    if (!sessionId) return;
    const resource = await host.resolveResource(sessionId, workspaceId, logicalPath);
    if (currentSession.current !== sessionId) return;
    if (resource.kind === 'directory') {
      if (!host.locatePath) throw new Error('Directory opening requires the desktop Host.');
      await host.locatePath(resource.path);
      return;
    }
    if (
      useSettingsStore.getState().effectiveSettings['gui.defaultFileOpen'] === 'vscode' &&
      !/\.(pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(logicalPath)
    ) {
      if (!host.openFile) throw new Error('Open in VS Code is unavailable in this Host.');
      await host.openFile(resource.path, position);
      return;
    }
    openTarget({ kind: 'workspace', workspaceId, logicalPath, line: position?.line, column: position?.column });
  };
  const removeTab = (id: string) => {
    navigation?.onTabClosed(sessionId, id);
    bindings.current.delete(id);
    setState((old) => {
      const tabs = old.tabs.filter((tab) => tab.id !== id);
      const activeId = old.activeId === id ? (tabs.at(-1)?.id ?? null) : old.activeId;
      saveViewState(
        sessionId + ':selection',
        tabs.find((tab) => tab.id === activeId)?.target ?? null,
      );
      return { ...old, tabs, activeId };
    });
  };
  const closeTab = async (id: string) => {
    if (!sessionId) return;
    const tab = live.tabs.find((tab) => tab.id === id);
    try {
      if (tab?.target.kind === 'browser') {
        const binding = bindings.current.get(id) ?? await nativeHostBinding();
        if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
        await nativeBrowserCommand({ ...binding, sessionId }, { action: 'close', previewId: tab.target.previewId });
      }
      if (currentSession.current === sessionId) removeTab(id);
    } catch (reason) {
      if (currentSession.current === sessionId) setError(String(reason));
    }
  };
  const ready = (id: string, page: NativePage, binding: NativeHostBinding) => {
    bindings.current.set(id, binding);
    setState((old) => ({
      ...old,
      tabs: old.tabs.map((tab) => (tab.id === id ? { ...tab, page } : tab)),
    }));
  };
  const resize = (value: number) => {
    const next = boundedPaneWidth(value, PANE_GEOMETRY.preview.min, PANE_GEOMETRY.preview.max);
    setWidth(next);
    saveViewState('panel-width', next);
  };
  const toggle = () =>
    setState((old) => ({ ...old, sessionId, visible: !old.visible, expanded: false }));
  const expand = () => setState((old) => ({ ...old, expanded: !old.expanded }));
  const selectTab = (id: string) =>
    setState((old) => {
      saveViewState(
        sessionId + ':selection',
        old.tabs.find((tab) => tab.id === id)?.target ?? null,
      );
      return { ...old, activeId: id };
    });
  const newPage = () => setState((old) => ({ ...old, activeId: null, visible: true }));
  return {
    ...live,
    width,
    treeVisible,
    toggleTree() { setTreeVisible(value => { saveViewState('file-tree', !value); return !value; }); },
    error,
    openTarget,
    openWorkspaceResource,
    closeTab,
    removeTab,
    ready,
    resize,
    toggle,
    expand,
    selectTab,
    newPage,
    reviewEdit: reviewEdit?.sessionId === sessionId ? reviewEdit : null,
    editBrowserReview(review: BrowserAnnotationDraft) {
      openTarget({ kind: 'browser', previewId: review.previewId, url: review.annotation.url });
      setReviewEdit({ requestId: crypto.randomUUID(), sessionId, previewId: review.previewId, annotation: review.annotation });
    },
  };
}

export function ResourcePreview({
  language,
  preview,
  tabsTarget,
  onReview,
}: {
  language: UiLanguage;
  preview: ReturnType<typeof useResourcePreview>;
  tabsTarget?: HTMLElement | null;
  onReview?: (annotation: BrowserAnnotation, previewId: string, screenshot?: string) => void;
}) {
  const chinese = language === 'zh-CN';
  const activeTarget = preview.tabs.find(tab => tab.id === preview.activeId)?.target;
  const sourceSessionId = (target?: ReaderTarget) =>
    target && target.kind !== 'browser' ? target.sourceSessionId ?? preview.sessionId : preview.sessionId;
  const activeSessionId = sourceSessionId(activeTarget);
  const openFileTarget = (sessionId: string | null, target: ReaderTarget) => preview.openTarget(
    sessionId && sessionId !== preview.sessionId && target.kind !== 'browser' ? { ...target, sourceSessionId: sessionId } : target,
  );
  const readerData = { kind: 'reader' as const, tabs: preview.tabs.map(tab => ({ id: tab.id, title: tabName(tab, language) })),
    activeId: preview.activeId, visible: preview.visible, expanded: preview.expanded, treeVisible: preview.treeVisible };
  const readerActions = { toggleTree: preview.toggleTree, toggleReaderExpanded: preview.expand,
    selectReaderTab: (id: string) => { if (preview.tabs.some(tab => tab.id === id)) preview.selectTab(id); } };
  const tabsId = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const treeWidth = usePaneWidth('fileTreeWidth', PANE_GEOMETRY.fileTree, workspace);
  const tabs = (
        <header className="reader-tabs">
          <div
            className="reader-tabs__list"
            role="tablist"
            aria-label={chinese ? '打开的预览' : 'Open previews'}
          >
            {preview.tabs.map((tab, index) => (
              <div
                className={
                  'reader-tab' + (tab.id === preview.activeId ? ' reader-tab--active' : '')
                }
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  id={`${tabsId}-tab-${index}`}
                  aria-controls={`${tabsId}-panel-${index}`}
                  tabIndex={tab.id === preview.activeId || (!preview.activeId && index === 0) ? 0 : -1}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = nextEnabledIndex(preview.tabs.map(() => true), index, event.key);
                    preview.selectTab(preview.tabs[next].id);
                    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
                  }}
                  aria-selected={tab.id === preview.activeId}
                  onClick={() => preview.selectTab(tab.id)}
                  title={tabName(tab, language)}
                >
                  <DeepCodeShellIcon name={tab.target.kind === 'agent' ? 'subagents' : 'artifact'} />
                  <span>{tab.target.kind === 'diff' ? readerFilename(tab.target.file.path) : tabName(tab, language)}</span>
                  {tab.target.kind === 'diff' && <small className="reader-tab__kind">· diff</small>}
                </button>
                <button
                  type="button"
                  onClick={() => void preview.closeTab(tab.id)}
                  aria-label={(chinese ? '关闭 ' : 'Close ') + tabName(tab, language)}
                >
                  <DeepCodeShellIcon name="close" />
                </button>
              </div>
            ))}
          </div>
          <button
            className="reader-icon-button"
            type="button"
            onClick={preview.newPage}
            aria-label={chinese ? '打开预览' : 'Open preview'}
            title={chinese ? '打开预览' : 'Open preview'}
          >
            <DeepCodeShellIcon name="plus" />
          </button>
          <div className="reader-tabs__actions">
            <UiRegion slot="reader.toolbar" data={readerData} actions={readerActions}>
              <ReaderFileActions sessionId={activeSessionId} target={activeTarget} language={language} />
            </UiRegion>
          </div>
        </header>
  );
  return (
    <>
      {preview.visible && !preview.expanded && (
        <ResizeHandle className="reader-resize" label={chinese ? '调整预览宽度' : 'Resize preview'}
          value={preview.width} min={PANE_GEOMETRY.preview.min} max={PANE_GEOMETRY.preview.max} step={PANE_GEOMETRY.preview.step}
          direction={-1} onResize={preview.resize} pixelsPerUnit={element => element.parentElement!.getBoundingClientRect().width / 100} />
      )}
      <aside
        className="local-agent__reader"
        hidden={!preview.visible}
        aria-label={t(language, 'agent.resource.preview')}
      >
        {tabsTarget ? createPortal(tabs, tabsTarget) : tabs}
        {preview.error && (
          <p role="alert" className="local-agent__resource-error">
            {preview.error}
          </p>
        )}
        <div className="reader-workspace" ref={workspace}><UiRegion slot="reader.layout" data={readerData} actions={readerActions}>
        <div className="reader-panes">
          {preview.tabs.map((tab, index) => (
            <div
              className="reader-pane"
              key={preview.sessionId + ':' + tab.id}
              hidden={preview.activeId !== tab.id}
              role="tabpanel" id={`${tabsId}-panel-${index}`} aria-labelledby={`${tabsId}-tab-${index}`}
            >
              {tab.target.kind === 'browser' && preview.sessionId ? (
                <NativeBrowserPreview
                  sessionId={preview.sessionId}
                  active={preview.visible && preview.activeId === tab.id}
                  onReady={(page, binding) => preview.ready(tab.id, page, binding)}
                  onClose={() => preview.removeTab(tab.id)}
                  previewId={tab.target.previewId}
                  onReview={onReview}
                  reviewEdit={preview.reviewEdit?.previewId === (tab.page?.previewId ?? tab.target.previewId) ? preview.reviewEdit : null}
                />
              ) : tab.target.kind === 'agent' ? (
                <AgentConversationPage key={tab.target.parentSessionId} target={tab.target} language={language}
                  active={preview.visible && preview.activeId === tab.id} />
              ) : tab.target.kind === 'diff' && preview.sessionId ? (
                <FileChangePreview sessionId={sourceSessionId(tab.target)!} file={tab.target.file} />
              ) : (
                preview.sessionId && (
                  <ReaderDocument
                    key={tab.target.kind === 'workspace' ? `${tab.id}:${tab.target.line ?? ''}:${tab.target.column ?? ''}` : tab.id}
                    sessionId={sourceSessionId(tab.target)!}
                    target={tab.target as Exclude<ReaderTarget, { kind: 'browser' | 'diff' | 'agent' }>}
                    language={language}
                    openTarget={target => openFileTarget(sourceSessionId(tab.target), target)}
                  />
                )
              )}
            </div>
          ))}
          {preview.activeId === null && preview.sessionId && (
            <ReaderStart
              language={language}
              openTarget={preview.openTarget}
              pages={preview.tabs.flatMap(tab => tab.page ? [tab.page] : [])}
            />
          )}
        </div>
        {activeSessionId && activeTarget?.kind !== 'agent' && <div className="reader-tree-panel" hidden={!preview.visible || !preview.treeVisible} style={{ width: treeWidth.width }}>
          {preview.visible && preview.treeVisible && <ResizeHandle className="reader-tree-resize" label={chinese ? '调整文件树宽度' : 'Resize file tree'}
            value={treeWidth.width} min={treeWidth.min} max={treeWidth.max} step={PANE_GEOMETRY.fileTree.step}
            direction={-1} onResize={treeWidth.setWidth} />}
          <ResourceTree key={activeSessionId} sessionId={activeSessionId} visible={preview.visible && preview.treeVisible} activeTarget={activeTarget} language={language} openTarget={target => openFileTarget(activeSessionId, target)} /></div>}
        </UiRegion></div>
      </aside>
    </>
  );
}

/** Shared header controls stay mounted at the same position in split and expanded views. */
export function ReaderControls({ language, preview, disabled }: {
  language: UiLanguage;
  preview: ReturnType<typeof useResourcePreview>;
  disabled: boolean;
}) {
  const chinese = language === 'zh-CN';
  const expandLabel = preview.expanded ? (chinese ? '返回并排' : 'Restore split view') : (chinese ? '铺满工作区' : 'Expand preview');
  const sidebarLabel = chinese ? '浏览器与预览' : 'Browser and preview';
  return <>
    {preview.visible && preview.tabs.find(tab => tab.id === preview.activeId)?.target.kind !== 'agent' && <button type="button" className="reader-icon-button" aria-label={chinese ? '文件树' : 'File tree'} title={chinese ? '文件树' : 'File tree'} aria-pressed={preview.treeVisible} onClick={preview.toggleTree}><DeepCodeShellIcon name="folder" /></button>}
    {preview.visible && <button type="button" className="reader-icon-button" onClick={preview.expand} aria-label={expandLabel} title={expandLabel}>
      <DeepCodeShellIcon name={preview.expanded ? 'collapse' : 'expand'} />
    </button>}
    <SshConnection language={language} />
    <button type="button" className="reader-icon-button" disabled={disabled} aria-label={sidebarLabel} title={sidebarLabel} aria-pressed={preview.visible} onClick={preview.toggle}>
      <DeepCodeShellIcon name="sidebar" />
    </button>
  </>;
}

function ReaderStart({
  language,
  openTarget,
  pages,
}: {
  language: UiLanguage;
  openTarget(target: ReaderTarget): void;
  pages: NativePage[];
}) {
  const addressId = useId();
  const browserButton = useRef<HTMLButtonElement>(null);
  const [enteringAddress, setEnteringAddress] = useState(false);
  const [url, setUrl] = useState(''),
    [error, setError] = useState<string | null>(null),
    [choosing, setChoosing] = useState<'file' | 'browser' | null>(null);
  return (
    <div className="reader-start">
      <button type="button" className="reader-start__entry" onClick={() => setChoosing('file')}>
        <DeepCodeShellIcon name="folder" />
        <span>{language === 'zh-CN' ? '打开文件' : 'Open file'}</span>
        <DeepCodeShellIcon name="chevronRight" />
      </button>
      {hasNativeBrowser() ? (
        <>
          <div className="reader-start__entries">
            <button
              ref={browserButton}
              type="button"
              className="reader-start__entry"
              aria-expanded={enteringAddress}
              aria-controls={addressId}
              onClick={() => setEnteringAddress((value) => !value)}
            >
              <DeepCodeShellIcon name="browser" />
              <span>{t(language, 'reader.start.browser')}</span>
              <DeepCodeShellIcon name={enteringAddress ? 'chevronDown' : 'chevronRight'} />
            </button>
          </div>
          {enteringAddress && <button type="button" className="settings-button" onClick={() => setChoosing('browser')}>
            {language === 'zh-CN' ? '在浏览器中打开本地 HTML' : 'Open local HTML in browser'}
          </button>}
          {enteringAddress && (
            <form
              id={addressId}
              onSubmit={(event) => {
                event.preventDefault();
                if (url.trim()) openTarget({ kind: 'browser', url: url.trim() });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEnteringAddress(false);
                  browserButton.current?.focus();
                }
              }}
            >
              <input
                autoFocus
                aria-label={t(language, 'reader.address')}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
              <button className="settings-button" disabled={!url.trim()}>
                {t(language, 'reader.open')}
              </button>
            </form>
          )}
          {pages.length > 0 && (
            <section className="reader-start__pages">
              <h3>{t(language, 'reader.start.openPages')}</h3>
              {pages.map((page) => (
                <button
                  type="button"
                  className="reader-start__entry"
                  key={page.previewId}
                  title={page.url}
                  onClick={() => openTarget({ kind: 'browser', previewId: page.previewId })}
                >
                  <DeepCodeShellIcon name="browser" />
                  <span>{readerPageName(page.url)}</span>
                  <DeepCodeShellIcon name="chevronRight" />
                </button>
              ))}
            </section>
          )}
        </>
      ) : null}
      {error && (
        <p role="alert" className="local-agent__resource-error">
          {error}
        </p>
      )}
      {choosing && (
        <ProjectFolderDialog
          language={language}
          selectionMode="file"
          filters={choosing === 'browser' ? [{ name: 'HTML', extensions: ['html', 'htm'] }] : undefined}
          title={language === 'zh-CN' ? (choosing === 'browser' ? '选择要运行的 HTML' : '打开文件') : 'Open file'}
          onCancel={() => setChoosing(null)}
          onSelect={(path, kind) => {
            if (kind !== 'file') { setError(language === 'zh-CN' ? '请选择文件。' : 'Select a file.'); setChoosing(null); return; }
            setChoosing(null);
            openTarget(choosing === 'browser' ? { kind: 'browser', filePath: path } : { kind: 'file', path });
          }}
        />
      )}
    </div>
  );
}

function ReaderDocument({
  sessionId,
  target,
  language,
  openTarget,
}: {
  sessionId: string;
  target: Exclude<ReaderTarget, { kind: 'browser' | 'diff' | 'agent' }>;
  language: UiLanguage;
  openTarget(target: ReaderTarget): void;
}) {
  const host = useConversationHost(),
    chinese = language === 'zh-CN';
  const [state, setState] = useState<DocumentState>({ status: 'loading' }),
    [revision, setRevision] = useState(0),
    [startByte, setStartByte] = useState<number>();
  const [location, setLocation] = useState<string | null>(null),
    [locationError, setLocationError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const path = target.kind === 'resource' ? (target.resource.logicalPath || target.name) : target.kind === 'workspace' ? target.logicalPath : target.kind === 'file' ? target.path : target.artifact.label,
    key = sessionId + ':' + targetKey(target) + (target.kind === 'workspace' && target.line ? `:${target.line}:${target.column ?? 1}` : '');
  const sourceLine = target.kind === 'workspace' ? target.line : undefined;
  const sourceColumn = target.kind === 'workspace' ? target.column : undefined;
  const [wrap, setWrap] = useState(() => readViewState(key + ':wrap', true));
  useEffect(() => setWrap(readViewState(key + ':wrap', true)), [key]);
  const columnOffset = state.status === 'text' && sourceLine && sourceColumn && startByte === undefined
    ? Math.min(sourceColumn - 1, state.result.content.split('\n', 1)[0].length)
    : undefined;
  useEffect(() => { setStartByte(undefined); }, [key]);
  const reference = targetResource(target);
  const referenceId = reference && resourceKey(reference);
  const [watchError, setWatchError] = useState('');
  useEffect(() => {
    if (!reference) return;
    const controller = new AbortController();
    setWatchError('');
    // Keep the subscription for the lifetime of the open tab. Its ready event
    // starts the first read after the watch is installed, closing the read/watch gap.
    void host.resources.watchResources(sessionId, [reference], controller.signal, () => setRevision(value => value + 1))
      .catch(error => { if (!controller.signal.aborted) setWatchError(String(error)); });
    return () => controller.abort();
  }, [sessionId, referenceId, host]);
  useEffect(() => {
    if (reference && revision === 0) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      if (target.kind === 'file') {
        if (!host.readLocalFile) throw new Error('Local file reading requires the desktop Host.');
        const blob = await host.readLocalFile(target.path);
        if (documentFormat(path)) {
          const header = await blob.slice(0, 5).text();
          if (documentFormat(path) === 'pdf' && header !== '%PDF-') throw new Error('当前文件不是 PDF 文档。');
          if (!controller.signal.aborted) setState({ status: 'document', blob, format: documentFormat(path)! });
        } else {
          const content = await readDocumentText(blob);
          if (!controller.signal.aborted) setState({ status: 'source', content });
        }
        return;
      }
      if (target.kind === 'artifact') {
        const a = target.artifact,
          blob = await readConversationArtifact(sessionId, a.artifactId, controller.signal);
        const format = a.contentType.startsWith('image/')
          ? 'image'
          : a.contentType === 'text/html'
            ? 'html'
            : a.contentType === 'application/pdf'
              ? 'pdf'
              : a.contentType === 'text/markdown'
                ? 'markdown'
                : null;
        if (!format && (a.contentType.startsWith('text/') || a.contentType === 'application/json')) {
          const content = await readDocumentText(blob);
          if (!controller.signal.aborted) setState({ status: 'source', content });
          return;
        }
        if (!format) throw new Error('Unsupported artifact media type: ' + a.contentType);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format });
        return;
      }
      const format = startByte === undefined && sourceLine === undefined ? documentFormat(path) : null;
      if (startByte === undefined && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) {
        const blob = await host.resources.readResourceBlob(sessionId, reference!, 'image', controller.signal);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format: 'image' });
      } else if (format) {
        const blob = await host.resources.readResourceBlob(sessionId, reference!, 'document', controller.signal);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format });
      } else {
        const result = await host.resources.readResourceReference(sessionId, reference!, controller.signal, startByte, sourceLine);
        if (!controller.signal.aborted) setState({ status: 'text', result });
      }
    })().catch((reason) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: String(reason) });
    });
    return () => controller.abort();
  // Reselecting the same file may create a new target object; only its resource
  // identity/location or an explicit revision changes the content being read.
  }, [sessionId, key, host, path, startByte, sourceLine, revision]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = sourceLine ? 0 : readViewState(key + ':scroll', 0);
  }, [key, state.status, sourceLine]);
  const resolve = async () => {
    if (target.kind === 'file') return target.path;
    if (target.kind === 'artifact') return target.artifact.logicalPath ?? target.artifact.uri ?? target.artifact.artifactId;
    return (await host.resources.resolveResourceReference(sessionId, reference!)).path;
  };
  const actions = <>
        {(state.status === 'source' || state.status === 'text') && <button
          className="reader-wrap-button" type="button" aria-pressed={wrap}
          onClick={() => { const next = !wrap; setWrap(next); saveViewState(key + ':wrap', next); }}
          title={chinese ? '按面板宽度折行，保留原文与行号' : 'Wrap to panel width without changing the source'}
        >{chinese ? '自动换行' : 'Word wrap'}</button>}
        <details
          className="reader-location"
          data-native-overlay
          onToggle={(event) => {
            if (event.currentTarget.open) {
              setLocationError(null);
              void resolve()
                .then(setLocation)
                .catch((reason) => setLocationError(String(reason)));
            }
          }}
        >
          <summary className="reader-icon-button" aria-label={chinese ? '文件位置' : 'File location'} title={chinese ? '文件位置' : 'File location'}><DeepCodeShellIcon name="info" /></summary>
          <div className="reader-location-detail">
            <code>{locationError ?? location ?? (chinese ? '正在读取…' : 'Loading…')}</code>
            {location && !locationError && (
              <button
                type="button"
                className="settings-button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(location)
                    .catch((reason) => setLocationError(String(reason)))
                }
              >
                {chinese ? '复制位置' : 'Copy location'}
              </button>
            )}
          </div>
        </details>
        {target.kind !== 'artifact' && hasNativeBrowser() && /\.html?$/i.test(path) && (
          <button
            className="settings-button"
            onClick={() =>
              void resolve()
                .then((filePath) => openTarget({ kind: 'browser', filePath }))
                .catch((reason) => setLocationError(String(reason)))
            }
          >
            {chinese ? '在浏览器中打开' : 'Open in browser'}
          </button>
        )}
        <button
          className="reader-icon-button"
          disabled={state.status === 'loading'}
          onClick={() => setRevision((value) => value + 1)}
          aria-label={chinese ? '重新读取' : 'Reload'}
          title={chinese ? '重新读取' : 'Reload'}
        >
          <DeepCodeShellIcon name="refresh" />
        </button>
    </>;
  return (
    <>
      {state.status !== 'document' && <div className="document-preview__toolbar document-preview__file-toolbar">
        <div className="document-preview__actions">{actions}</div>
      </div>}
      {state.status !== 'error' && watchError && <p role="alert" className="local-agent__resource-error">{watchError}</p>}
      {locationError && (
        <p role="alert" className="local-agent__resource-error">
          {locationError}
        </p>
      )}
      <div
        ref={scroll}
        className={`local-agent__resource-body${state.status === 'source' || state.status === 'text' ? ' reader-source-body' : ''}`}
        onScroll={() => {
          if (scroll.current) saveViewState(key + ':scroll', scroll.current.scrollTop);
        }}
      >
        {state.status === 'loading' ? (
          <p>{t(language, 'agent.resource.reading')}</p>
        ) : state.status === 'error' ? (
          <p role="alert" className="local-agent__resource-error">
            {state.error}
          </p>
        ) : state.status === 'source' ? (
          <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
            <SourceFileView viewKey={key} content={state.content} filename={path} wrap={wrap} />
          </Suspense></InterfaceLoadBoundary>
        ) : state.status === 'document' ? (
          <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
            <DocumentPreview
              readingKey={key}
              blob={state.blob}
              format={state.format}
              filename={path}
              language={language}
              actions={actions}
            />
          </Suspense></InterfaceLoadBoundary>
        ) : (
          <>
            {sourceLine && <small>{chinese ? '起始行' : 'Starting line'} {state.result.startLine}{target.kind === 'workspace' && target.column ? ` · ${chinese ? '列' : 'column'} ${target.column}` : ''}</small>}
            <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
              <SourceFileView viewKey={key} content={state.result.content} filename={path} startLine={state.result.startLine} column={columnOffset === undefined ? 1 : columnOffset + 1} wrap={wrap} />
            </Suspense></InterfaceLoadBoundary>
            {state.result.truncated && (
              <small>{chinese ? '当前为部分内容。' : 'Partial content.'}</small>
            )}
            {state.result.nextByte !== undefined && (
              <button
                className="settings-button"
                onClick={() => setStartByte(state.result.nextByte)}
              >
                {chinese ? '读取下一段' : 'Read next section'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function targetResource(target: ReaderTarget): ResourceReference | undefined {
  if (target.kind === 'resource') return target.resource;
  if (target.kind === 'workspace') return { workspaceId: target.workspaceId, logicalPath: target.logicalPath };
  if (target.kind === 'diff') {
    const { recordId, index } = target.file.changes.at(-1)!;
    return { change: { recordId, index }, logicalPath: '' };
  }
}

function ReaderFileActions({ sessionId, target, language }: {
  sessionId: string | null; target?: ReaderTarget; language: UiLanguage;
}) {
  const host = useConversationHost();
  const [error, setError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const open = async (action: 'code' | 'folder') => {
    const callback = action === 'code' ? host.openFile : host.locatePath;
    if (!sessionId || !target || !callback) return;
    if (menu.current) menu.current.open = false;
    setError('');
    try {
      const reference = targetResource(target);
      const path = target.kind === 'file' ? target.path : reference ? (await host.resources.resolveResourceReference(sessionId, reference)).path : undefined;
      if (!path) throw new Error('resource_has_no_local_file');
      await callback(path);
    } catch (error) { setError(String(error)); }
  };
  useEffect(() => setError(''), [target]);
  if ((!host.openFile && !host.locatePath) || !sessionId || !target || target.kind === 'browser' || target.kind === 'artifact' || target.kind === 'agent') return null;
  return <div className="reader-file-actions">
      <details className="reader-external-open" ref={menu} data-native-overlay onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
      }}>
        <summary aria-label={language === 'zh-CN' ? '文件打开方式' : 'Open file with'}>{language === 'zh-CN' ? '打开' : 'Open'} <DeepCodeShellIcon name="chevronDown" /></summary>
        <div role="menu">
          {host.openFile && <button role="menuitem" onClick={() => void open('code')}>{language === 'zh-CN' ? '在 VS Code 中打开' : 'Open in VS Code'}</button>}
          {host.locatePath && <button role="menuitem" onClick={() => void open('folder')}>{language === 'zh-CN' ? '打开所在文件夹' : 'Show in folder'}</button>}
        </div>
      </details>
    {error && <p role="alert" className="reader-file-actions__error local-agent__resource-error" data-native-overlay>{error}</p>}
  </div>;
}
