import { UsageWidget } from '../../ui-plugins/UsageWidget';
import { ComputerTargetPreview } from './ComputerTargetPreview';
import type { ConversationReaderLayout } from '../../components/local-agent/LocalAgentPanel';
import { UiRegion } from '../../ui-plugins/UiRegion';
import ProjectEnvironmentSettings from '../../components/settings-center/sections/ProjectEnvironmentSettings';
import { restoredInterfaceView, useInterfaceReloadView } from '../../services/interfaceReload';
import AchbitNavigationBox from './AchbitNavigationBox';
import ResizeHandle from '../../components/shared/ResizeHandle';
import { usePaneWidth } from '../../components/shared/usePaneWidth';
import { PANE_GEOMETRY } from '../../components/shared/paneGeometry';
import { InterfaceLoadBoundary } from '../../components/shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import ModalDialog from '../../components/shared/ModalDialog';
import { captureFocusReturn, returnInteractionFocus, useInteractionFocus, type FocusReturn } from '../../components/shared/interactionFocus';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationProject,
  ConversationSessionSummary,
} from '@achbit/protocol';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import AchbitSidebar from './AchbitSidebar';
import SidebarMenu from './SidebarMenu';
import { useReadRunMarkers } from './useReadRunMarkers';
import { useCompletionNotifications } from './useCompletionNotifications';
import { onCompletionOpen } from '../../services/runtimeAdapter';
import { DismissibleError } from '../../components/local-agent/DismissibleError';
import { useSidebarOrder } from './useSidebarOrder';
import AchbitTitlebar from './AchbitTitlebar';
import type { ReaderLocation, ReaderNavigationRequest } from '../../components/local-agent/readerState';
import { forgetClosedBrowser, locationKey, visitLocation, type NavigationHistory, type WorkbenchLocation } from './navigationHistory';
import AchbitShellIcon from '../../components/shared/AchbitShellIcon';
import ProjectFolderDialog from '../../components/workspace-open-dialog/ProjectFolderDialog';
import '../styles/achbitShell.css';
import '../styles/achbitWorkbench.css';

interface AchbitWorkbenchLayoutProps {
  apiStatus: string;
  serverVersion?: string;
}

// Navigation commits without waiting for Markdown, Reader or task rendering.
// React starts these imports independently of the selected Session's request.
const AchbitConversationShell = lazy(
  () => loadInterfaceModule(() => import('./AchbitConversationShell')),
);
const AchbitTaskPanel = lazy(
  () => loadInterfaceModule(() => import('./AchbitTaskPanel')),
);

const SettingsCenter = lazy(
  () => loadInterfaceModule(() => import('../../components/settings-center/SettingsCenter')),
);

type PositionedMenu<T> = { value: T; x: number; y: number };
type FolderAction =
  | { kind: 'create' }
  | {
      kind: 'bind';
      project: ConversationProject;
    };
type TextDialog =
  | { kind: 'createProject'; title: string; value: string }
  | { kind: 'renameProject'; title: string; value: string; project: ConversationProject }
  | { kind: 'renameSession'; title: string; value: string; session: ConversationSessionSummary };
type ManagedWorkspace = { workspaceId: string; displayName: string; canonicalRoot: string };

const AchbitWorkbenchLayout: React.FC<AchbitWorkbenchLayoutProps> = ({
  apiStatus,
  serverVersion,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const navigationDensity = effectiveSettings['gui.navigationDensity'] === 'compact'
    ? 'compact'
    : 'comfortable';
  const showContextRail = effectiveSettings['gui.showContextRail'] !== false;
  const projection = useLocalAgentStore((state) => state.projection);
  const activeSessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const catalogStatus = useLocalAgentStore((state) => state.catalogStatus);
  const catalogWatchError = useLocalAgentStore(state => state.catalogWatchError);
  const sidebarOrder = useSidebarOrder(catalog.projects, catalog.sessions);
  const sessionStatuses = useLocalAgentStore((state) => state.sessionStatuses);
  const statusError = useLocalAgentStore((state) => state.statusError);
  const sidebarStatuses = useMemo(() => {
    if (!projection || (sessionStatuses[projection.sessionId]?.revision ?? -1) > projection.revision) {
      return sessionStatuses;
    }
    return {
      ...sessionStatuses,
      [projection.sessionId]: {
        sessionId: projection.sessionId, revision: projection.revision, run: projection.run,
      },
    };
  }, [projection, sessionStatuses]);
  const completionNotification = useCompletionNotifications(catalog.sessions, language);
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const startNewSession = useLocalAgentStore((state) => state.startNewSession);
  const activateSession = useLocalAgentStore((state) => state.activateSession);
  const createProject = useLocalAgentStore((state) => state.createProject);
  const updateProject = useLocalAgentStore((state) => state.updateProject);
  const addProjectWorkspace = useLocalAgentStore((state) => state.addProjectWorkspace);
  const removeProjectWorkspace = useLocalAgentStore((state) => state.removeProjectWorkspace);
  const getProjectWorkspacePaths = useLocalAgentStore((state) => state.getProjectWorkspacePaths);
  const deleteProject = useLocalAgentStore((state) => state.deleteProject);
  const updateSession = useLocalAgentStore((state) => state.updateSession);
  const deleteSession = useLocalAgentStore((state) => state.deleteSession);

  const [settingsOpen, setSettingsOpen] = useState(() => restoredInterfaceView('settingsOpen', false));
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => restoredInterfaceView('navigationCollapsed', false));
  const workbench = useRef<HTMLDivElement>(null);
  const navigationWidth = usePaneWidth('navigationWidth', PANE_GEOMETRY.navigation, workbench);
  useInterfaceReloadView('navigationCollapsed', navigationCollapsed);
  const [readerLocation, setReaderLocation] = useState<ReaderLocation | null>(() => (
    activeSessionId === null && !restoredInterfaceView('conversation', null) && !restoredInterfaceView('reader', null)
      ? { sessionId: null, target: null, visible: false, expanded: false } : null
  ));
  const [readerRequest, setReaderRequest] = useState<ReaderNavigationRequest | null>(null);
  // Record the initial draft before a user can select history while the body
  // module is loading. Reload restoration waits for the Reader's saved location.
  const [history, setHistory] = useState<NavigationHistory>(() => readerLocation
    ? { entries: [{ sessionId: activeSessionId, draftProjectId, settingsOpen, reader: readerLocation }], cursor: 0 }
    : { entries: [], cursor: -1 });
  const [navigationPending, setNavigationPending] = useState<{ index: number; location: WorkbenchLocation } | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigationRequestId = useRef(0);
  const [readerLayout, setReaderLayout] = useState<ConversationReaderLayout>({ visible: false, expanded: false, conversationBounds: null });
  useInterfaceReloadView('settingsOpen', settingsOpen);
  useInterfaceReloadView('conversation', { sessionId: activeSessionId, draftProjectId });
  const [settingsNavigation, setSettingsNavigation] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onCompletionOpen(sessionId => {
      setSettingsOpen(false);
      void activateSession(sessionId);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(error => setNavigationError(String(error)));
    return () => { disposed = true; unlisten?.(); };
  }, [activateSession]);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const interaction = useInteractionFocus();
  const settingsOpener = useRef<FocusReturn | null>(null);
  useLayoutEffect(() => {
    if (settingsOpen) {
      settingsOpener.current = interaction ? interaction.capture() : captureFocusReturn();
      settingsClose.current?.focus({ preventScroll: true });
    } else if (settingsOpener.current) {
      returnInteractionFocus(settingsOpener.current, interaction?.keyboard ?? true);
      settingsOpener.current = null;
    }
  }, [settingsOpen, interaction]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Blank-area clicks can focus body, outside the React workbench subtree.
      // An inner dialog or control that consumes Escape retains priority.
      if (event.defaultPrevented || event.isComposing
        || document.querySelector('dialog[open]')) return;
      if (event.key !== 'Escape') {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen]);
  const [sessionHeader, setSessionHeader] = useState<HTMLDivElement | null>(null);
  const readRunMarkers = useReadRunMarkers(projection, !loading && !settingsOpen);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [projectCreateMenu, setProjectCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<PositionedMenu<ConversationProject> | null>(null);
  const [sessionMenu, setSessionMenu] = useState<PositionedMenu<ConversationSessionSummary> | null>(null);
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [textDialog, setTextDialog] = useState<TextDialog | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<ConversationSessionSummary | null>(null);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const [workspaceManager, setWorkspaceManager] = useState<{
    project: ConversationProject;
    records: ManagedWorkspace[];
    loading: boolean;
    error: string | null;
  } | null>(null);
  const selectionBusy = submitting || catalogBusy || !!navigationPending;
  const runtimeReady = useLocalAgentStore(state => state.runtimeReady);
  const busy = !runtimeReady || loading || selectionBusy;
  useEffect(() => {
    if (loading || !readerLocation || readerLocation.sessionId !== activeSessionId) return;
    const location: WorkbenchLocation = { sessionId: activeSessionId, draftProjectId, settingsOpen, reader: readerLocation };
    if (navigationPending) {
      if (locationKey(location) !== locationKey(navigationPending.location)) return;
      setHistory(current => ({ ...current, cursor: navigationPending.index }));
      setNavigationPending(null);
      setReaderRequest(null);
    } else setHistory(current => visitLocation(current, location));
  }, [activeSessionId, draftProjectId, settingsOpen, readerLocation, loading, navigationPending]);

  const navigate = async (direction: -1 | 1) => {
    const index = history.cursor + direction;
    const location = history.entries[index];
    if (busy || !location) return;
    setNavigationError(null);
    setNavigationPending({ index, location });
    try {
      if (location.sessionId && location.sessionId !== activeSessionId) {
        await activateSession(location.sessionId);
        const state = useLocalAgentStore.getState();
        if (state.error || state.sessionId !== location.sessionId) throw new Error(state.error ?? 'conversation_session_not_found');
      } else if (!location.sessionId && (activeSessionId || draftProjectId !== location.draftProjectId)) {
        startNewSession(location.draftProjectId);
      }
      setSettingsOpen(location.settingsOpen);
      setReaderRequest({ id: ++navigationRequestId.current, location: location.reader });
    } catch (error) {
      setNavigationError(String(error));
      setNavigationPending(null);
    }
  };
  const collapsedSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);

  useEffect(() => {
    if (!projectCreateMenu && !projectMenu && !sessionMenu) return;
    const close = () => {
      setProjectCreateMenu(null);
      setProjectMenu(null);
      setSessionMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [projectCreateMenu, projectMenu, sessionMenu]);

  const createPrimarySession = () => {
    startNewSession(null);
  };

  const createProjectSession = (project: ConversationProject) => {
    startNewSession(project.id);
  };

  const openProjectCreateMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setSessionMenu(null);
    setProjectMenu(null);
    setProjectCreateMenu((current) => current ? null : ({
      x: rect.left,
      y: rect.bottom + 6,
    }));
  };

  const openProjectMenu = (
    event: React.MouseEvent<HTMLElement>,
    project: ConversationProject,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectCreateMenu(null);
    setSessionMenu(null);
    setProjectMenu(positioned(event, project));
  };

  const openSessionMenu = (
    event: React.MouseEvent<HTMLElement>,
    session: ConversationSessionSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectCreateMenu(null);
    setProjectMenu(null);
    setSessionMenu(positioned(event, session));
  };

  const submitTextDialog = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!textDialog) return;
    const value = textDialog.value.trim();
    if (!value) return;
    const dialog = textDialog;
    setTextDialog(null);
    if (dialog.kind === 'createProject') {
      await createProject(value);
    } else if (dialog.kind === 'renameProject') {
      await updateProject(dialog.project.id, { title: value });
    } else {
      await updateSession(dialog.session.id, { title: value });
    }
  };

  const selectProjectFolder = async (folderPath: string) => {
    const action = folderAction;
    setFolderAction(null);
    if (!action) return;
    if (action.kind === 'create') {
      const title = basename(folderPath) || t(language, 'achbitGui.project.defaultName');
      const existingIds = new Set(
        useLocalAgentStore.getState().catalog.projects.map((project) => project.id),
      );
      await createProject(title, [folderPath]);
      const created = useLocalAgentStore.getState().catalog.projects.find((project) => (
        !existingIds.has(project.id)
      ));
      if (created) startNewSession(created.id);
      return;
    }
    await addProjectWorkspace(action.project.id, folderPath);
    await openWorkspaceManager(action.project);
  };

  const openWorkspaceManager = async (project: ConversationProject) => {
    setProjectMenu(null);
    setWorkspaceManager({ project, records: [], loading: true, error: null });
    try {
      const records = await getProjectWorkspacePaths(project.id);
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, records, loading: false }
        : current);
    } catch (error) {
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
        : current);
    }
  };

  const removeManagedWorkspace = async (workspaceId: string) => {
    if (!workspaceManager) return;
    const project = workspaceManager.project;
    setWorkspaceManager({ ...workspaceManager, loading: true, error: null });
    try {
      await removeProjectWorkspace(project.id, workspaceId);
      await openWorkspaceManager(project);
    } catch (error) {
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
        : current);
    }
  };

  const requestDeleteSession = (session: ConversationSessionSummary) => {
    setSessionMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionCandidate(session);
  };

  const confirmDeleteSession = async () => {
    if (!deleteSessionCandidate) return;
    setDeleteSessionError(null);
    try {
      await deleteSession(deleteSessionCandidate.id);
      setDeleteSessionCandidate(null);
    } catch (error) {
      setDeleteSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDeleteProject = async (project: ConversationProject) => {
    setProjectMenu(null);
    const confirmed = window.confirm(
      t(language, 'achbitGui.project.deleteConfirm', { title: project.title }),
    );
    if (confirmed) await deleteProject(project.id);
  };

  return (
    <div className={`achbit-gui-workbench${settingsOpen ? ' achbit-gui-workbench--settings' : ''}${navigationCollapsed ? ' achbit-gui-workbench--navigation-collapsed' : ''}`}
      ref={workbench} data-host-status={apiStatus} style={{ '--ac-navigation-width': `${navigationWidth.width}px` } as React.CSSProperties}
      onKeyDown={(event) => {
        if (settingsOpen && event.key !== 'Escape') event.stopPropagation();
      }}>
      <UiRegion slot="workbench.layout" regions={{
        titlebar: <><AchbitTitlebar sessionHeaderRef={setSessionHeader} language={language} settings={settingsOpen ? <>
        <strong>{t(language, 'settings.title')}</strong>
        <button type="button" ref={settingsClose} className="achbit-local-agent-settings__close" onClick={() => setSettingsOpen(false)}>
          {t(language, 'achbitGui.settings.close')} <kbd>esc</kbd>
        </button>
      </> : undefined} /></>,
        navigation: <UiRegion slot="navigation" data={{ kind: 'navigation', projects: sidebarOrder.projects, sessions: sidebarOrder.sessions, activeSessionId, busy: selectionBusy }}
          debugActions={{ activateSession: { unavailableReason: selectionBusy ? 'conversation_navigation_busy' : null, completion: 'session-loaded' } }}
          actions={{ activateSession: async (id: string) => {
            if (selectionBusy) throw new Error('conversation_navigation_busy');
            await activateSession(id);
            const state = useLocalAgentStore.getState();
            if (state.error) throw new Error(state.error);
            if (state.sessionId !== id || state.projection?.sessionId !== id || state.loading) throw new Error('conversation_session_not_loaded');
          } }}><AchbitNavigationBox settingsOpen={settingsOpen} settingsTargetRef={setSettingsNavigation} collapsed={navigationCollapsed}
          resizeHandle={<ResizeHandle className="achbit-gui-navigation-resize" label={t(language, 'achbitGui.navigation.resize')}
            value={navigationWidth.width} min={navigationWidth.min} max={navigationWidth.max} step={PANE_GEOMETRY.navigation.step}
            direction={1} onResize={navigationWidth.setWidth} />} toolbar={<>
            <button type="button" aria-label={t(language, 'achbitGui.navigation.back')} title={t(language, 'achbitGui.navigation.back')} disabled={busy || history.cursor <= 0} onClick={() => void navigate(-1)}><AchbitShellIcon name="chevronLeft" /></button>
            <button type="button" aria-label={t(language, 'achbitGui.navigation.forward')} title={t(language, 'achbitGui.navigation.forward')} disabled={busy || history.cursor >= history.entries.length - 1} onClick={() => void navigate(1)}><AchbitShellIcon name="chevronRight" /></button>
            <button type="button" className="achbit-gui-navigation-toggle" aria-label={t(language, navigationCollapsed ? 'achbitGui.navigation.expand' : 'achbitGui.navigation.collapse')} title={t(language, navigationCollapsed ? 'achbitGui.navigation.expand' : 'achbitGui.navigation.collapse')} aria-expanded={!navigationCollapsed} aria-controls="achbit-navigation-content" onClick={() => setNavigationCollapsed(value => !value)}><AchbitShellIcon name="sidebar" /></button>
            {navigationError && <p className="achbit-gui-navigation-error" role="alert">{navigationError}</p>}
            {catalogWatchError && <p className="achbit-gui-navigation-error" role="alert">{catalogWatchError}
              <button type="button" onClick={() => useLocalAgentStore.getState().retryCatalogWatch()}>{t(language, 'achbitGui.statusAction.retry')}</button>
            </p>}
          </>}>
        <AchbitSidebar
          language={language}
          catalogStatus={catalogStatus}
          projects={sidebarOrder.projects}
          sessions={sidebarOrder.sessions}
          reorderDisabled={sidebarOrder.disabled}
          reorderError={sidebarOrder.error}
          onReorder={(source, target, edge) => void sidebarOrder.move(source, target, edge)}
          sessionStatuses={sidebarStatuses}
          statusError={statusError}
          readRunMarkers={readRunMarkers}
          collapsedProjectIds={collapsedSet}
          activeSessionId={activeSessionId}
          draftProjectId={draftProjectId}
          busy={busy}
          activationBusy={selectionBusy}
          projectCreateMenuOpen={Boolean(projectCreateMenu)}
          onCreatePrimarySession={createPrimarySession}
          onOpenProjectCreateMenu={openProjectCreateMenu}
          onToggleProject={(projectId) => setCollapsedProjectIds((current) => (
            current.includes(projectId)
              ? current.filter((id) => id !== projectId)
              : [...current, projectId]
          ))}
          onCreateProjectSession={createProjectSession}
          onActivateSession={(session) => void activateSession(session.id)}
          onOpenProjectContextMenu={openProjectMenu}
          onOpenSessionContextMenu={openSessionMenu}
          onOpenSettings={() => {
            setProjectMenu(null); setProjectCreateMenu(null); setSessionMenu(null); setSettingsOpen(true);
          }}
        />
      </AchbitNavigationBox></UiRegion>,
        main: <>{completionNotification.error && <div className="achbit-gui-notification-error">
          <DismissibleError language={language} onDismiss={completionNotification.dismiss}>{completionNotification.error}
            {completionNotification.canRetry && <button type="button" onClick={completionNotification.retry}>{t(language, 'achbitGui.statusAction.retry')}</button>}
          </DismissibleError>
        </div>}<div
        className={`achbit-gui-shell${showContextRail ? '' : ' achbit-gui-shell--no-context'}`}
        data-navigation-density={navigationDensity}
      >
        <div className="achbit-gui-main-surfaces" inert={settingsOpen} aria-hidden={settingsOpen || undefined}>
          <InterfaceLoadBoundary><Suspense fallback={<main className="achbit-gui-session-main" aria-busy="true" />}>
          <AchbitConversationShell headerTarget={sessionHeader} onReaderLayoutChange={setReaderLayout} readerNavigation={{
            request: readerRequest, onChange: setReaderLocation,
            onTabClosed: (sessionId, tabId) => setHistory(current => forgetClosedBrowser(current, sessionId, tabId)),
          }} />
          </Suspense></InterfaceLoadBoundary>
          {showContextRail && <InterfaceLoadBoundary><Suspense fallback={null}>
            <AchbitTaskPanel language={language} projection={projection} />
          </Suspense></InterfaceLoadBoundary>}
        </div>
        <UsageWidget readerLayout={readerLayout} hidden={settingsOpen} />
        <ComputerTargetPreview readerLayout={readerLayout} language={language} hidden={settingsOpen} />
      </div></>,
      }} />

      {projectCreateMenu && (
        <SidebarMenu
          id="achbit-project-create-menu"
          className="achbit-gui-project-create-menu"
          x={projectCreateMenu.x} y={projectCreateMenu.y}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setTextDialog({
                kind: 'createProject',
                title: t(language, 'achbitGui.project.newBlank'),
                value: t(language, 'achbitGui.project.defaultName'),
              });
            }}
          >
            <AchbitShellIcon name="plus" className="achbit-gui-menu-icon" />
            <span>{t(language, 'achbitGui.project.newBlank')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setFolderAction({ kind: 'create' });
            }}
          >
            <AchbitShellIcon name="folder" />
            <span>{t(language, 'achbitGui.project.fromFolder')}</span>
          </button>
        </SidebarMenu>
      )}

      {sessionMenu && (
        <SidebarMenu
          className="achbit-gui-session-context-menu"
          x={sessionMenu.x} y={sessionMenu.y}
        >
          <div className="achbit-gui-session-context-menu__title">
            {sessionMenu.value.title || t(language, 'agent.session.newTitle')}
          </div>
          <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSessionMenu(null);
                  setTextDialog({
                    kind: 'renameSession',
                    title: t(language, 'agent.session.rename'),
                    value: sessionMenu.value.title || t(language, 'agent.session.newTitle'),
                    session: sessionMenu.value,
                  });
                }}
              >
                {t(language, 'agent.session.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="achbit-gui-session-context-menu__danger"
                onClick={() => requestDeleteSession(sessionMenu.value)}
              >
                {t(language, 'agent.session.delete')}
              </button>
              {catalog.projects.length > 0 && (
                <div className="achbit-gui-session-context-menu__section">
                  <div className="achbit-gui-session-context-menu__section-title">
                    {t(language, 'achbitGui.session.addToProject')}
                  </div>
                  {catalog.projects.slice(0, 6).map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      role="menuitem"
                      disabled={sessionMenu.value.projectId === project.id}
                      onClick={() => {
                        const session = sessionMenu.value;
                        setSessionMenu(null);
                        void updateSession(session.id, { projectId: project.id });
                      }}
                    >
                      {project.title}
                    </button>
                  ))}
                </div>
              )}
              {sessionMenu.value.projectId && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const session = sessionMenu.value;
                    setSessionMenu(null);
                    void updateSession(session.id, { projectId: null });
                  }}
                >
                  {t(language, 'achbitGui.session.removeFromProject')}
                </button>
              )}
          </>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = sessionMenu.value.id;
              setSessionMenu(null);
              void copyText(id);
            }}
          >
            {t(language, 'achbitGui.session.copyId')}
          </button>
        </SidebarMenu>
      )}

      {projectMenu && (
        <SidebarMenu
          className="achbit-gui-session-context-menu"
          x={projectMenu.x} y={projectMenu.y}
        >
          <div className="achbit-gui-session-context-menu__title">{projectMenu.value.title}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectMenu(null);
              setTextDialog({
                kind: 'renameProject',
                title: t(language, 'achbitGui.project.rename'),
                value: projectMenu.value.title,
                project: projectMenu.value,
              });
            }}
          >
            {t(language, 'achbitGui.project.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const project = projectMenu.value;
              void openWorkspaceManager(project);
            }}
          >
            {t(language, 'achbitGui.project.manageWorkspaces')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="achbit-gui-session-context-menu__danger"
            onClick={() => void confirmDeleteProject(projectMenu.value)}
          >
            {t(language, 'achbitGui.project.delete')}
          </button>
        </SidebarMenu>
      )}

      {textDialog && (
        <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-label={textDialog.title} busy={catalogBusy} onClose={() => setTextDialog(null)}>
          <form
            className="achbit-gui-text-dialog"
            onSubmit={(event) => void submitTextDialog(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{textDialog.title}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                onClick={() => setTextDialog(null)}
              ><AchbitShellIcon name="close" size={14} /></button>
            </header>
            <label>
              <span>{t(language, 'achbitGui.nameLabel')}</span>
              <input
                autoFocus
                value={textDialog.value}
                maxLength={120}
                onChange={(event) => setTextDialog({ ...textDialog, value: event.target.value })}
              />
            </label>
            <footer>
              <button type="button" onClick={() => setTextDialog(null)}>
                {t(language, 'agent.session.cancel')}
              </button>
              <button type="submit" disabled={!textDialog.value.trim() || catalogBusy}>
                {t(language, 'agent.session.save')}
              </button>
            </footer>
          </form>
        </ModalDialog>
      )}

      {deleteSessionCandidate && (
        <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-labelledby="achbit-delete-session-title" busy={catalogBusy} onClose={() => setDeleteSessionCandidate(null)}>
          <div className="achbit-gui-text-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2 id="achbit-delete-session-title">{t(language, 'agent.session.delete')}</h2>
              <button
                type="button"
                aria-label={t(language, 'agent.session.cancel')}
                disabled={catalogBusy}
                onClick={() => setDeleteSessionCandidate(null)}
              ><AchbitShellIcon name="close" size={14} /></button>
            </header>
            <p className="achbit-gui-text-dialog__message">
              {t(language, 'achbitGui.session.deleteConfirm', {
                title: deleteSessionCandidate.title || t(language, 'agent.session.newTitle'),
              })}
            </p>
            {deleteSessionError && (
              <p className="achbit-gui-text-dialog__error" role="alert">
                {deleteSessionError}
              </p>
            )}
            <footer>
              <button
                type="button"
                disabled={catalogBusy}
                onClick={() => setDeleteSessionCandidate(null)}
              >
                {t(language, 'agent.session.cancel')}
              </button>
              <button
                type="button"
                className="achbit-gui-text-dialog__danger"
                disabled={catalogBusy}
                onClick={() => void confirmDeleteSession()}
              >
                {t(language, 'agent.session.delete')}
              </button>
            </footer>
          </div>
        </ModalDialog>
      )}

      {folderAction && (
        <ProjectFolderDialog
          language={language}
          onCancel={() => setFolderAction(null)}
          onSelect={(path) => void selectProjectFolder(path)}
        />
      )}

      {workspaceManager && (
        <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-label={t(language, 'achbitGui.project.workspacesTitle')} busy={workspaceManager.loading} onClose={() => setWorkspaceManager(null)}>
          <div className="achbit-gui-text-dialog achbit-gui-workspace-manager" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>{workspaceManager.project.title} · {t(language, 'achbitGui.project.workspacesTitle')}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                disabled={workspaceManager.loading}
                onClick={() => setWorkspaceManager(null)}
              ><AchbitShellIcon name="close" size={14} /></button>
            </header>
            <h3 className="achbit-gui-workspace-manager__heading">{language === 'zh-CN' ? '源文件夹' : 'Source folders'}</h3>
            <div className="achbit-gui-workspace-manager__list" onMouseDown={(event) => event.stopPropagation()}>
              {!workspaceManager.loading && workspaceManager.records.length === 0 && (
                <div className="achbit-gui-workspace-manager__empty">
                  {t(language, 'achbitGui.project.noWorkspaces')}
                </div>
              )}
              {workspaceManager.records.map((record) => (
                <div className="achbit-gui-workspace-manager__row" key={record.workspaceId}>
                  <AchbitShellIcon name="folder" size={18} />
                  <span>
                    <strong>{record.displayName}</strong>
                    <small>{record.canonicalRoot}</small>
                  </span>
                  <button
                    type="button"
                    disabled={workspaceManager.loading}
                    onClick={() => void removeManagedWorkspace(record.workspaceId)}
                  >
                    {t(language, 'settings.common.remove')}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="achbit-gui-workspace-manager__add"
                disabled={workspaceManager.loading}
                onClick={() => {
                  const project = workspaceManager.project;
                  setFolderAction({
                    kind: 'bind',
                    project,
                  });
                }}
              >
                <AchbitShellIcon name="plus" size={18} />{t(language, 'achbitGui.project.addFolder')}
              </button>
            </div>
            <ProjectEnvironmentSettings key={workspaceManager.project.id} projectId={workspaceManager.project.id} chinese={language === 'zh-CN'} />
            {workspaceManager.error && (
              <p className="achbit-gui-text-dialog__error" role="alert">{workspaceManager.error}</p>
            )}
            <footer>
              <button type="button" onClick={() => setWorkspaceManager(null)}>
                {t(language, 'achbitGui.common.done')}
              </button>

            </footer>
          </div>
        </ModalDialog>
      )}

      {settingsOpen && (
        <section className="achbit-local-agent-overlay" aria-label={t(language, 'settings.title')}>
          <div className="achbit-local-agent-settings" onMouseDown={(event) => event.stopPropagation()}>
            <InterfaceLoadBoundary><Suspense fallback={null}>
              <SettingsCenter
                apiStatus={apiStatus}
                serverVersion={serverVersion}
                navigationTarget={settingsNavigation}
              />
            </Suspense></InterfaceLoadBoundary>
          </div>
        </section>
      )}
    </div>
  );
};

function positioned<T>(
  event: React.MouseEvent<HTMLElement>,
  value: T,
): PositionedMenu<T> {
  const rect = event.currentTarget.getBoundingClientRect();
  const rawX = event.clientX || rect.right;
  const rawY = event.clientY || rect.bottom;
  return {
    value,
    x: rawX,
    y: rawY,
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default AchbitWorkbenchLayout;
