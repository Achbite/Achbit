import { UsageWidget } from '../../ui-plugins/UsageWidget';
import { ComputerTargetPreview } from './ComputerTargetPreview';
import type { ConversationReaderLayout } from '../../components/local-agent/LocalAgentPanel';
import { UiRegion } from '../../ui-plugins/UiRegion';
import ProjectEnvironmentSettings from '../../components/settings-center/sections/ProjectEnvironmentSettings';
import { restoredInterfaceView, useInterfaceReloadView } from '../../services/interfaceReload';
import DeepCodeNavigationBox from './DeepCodeNavigationBox';
import ResizeHandle from '../../components/shared/ResizeHandle';
import { usePaneWidth } from '../../components/shared/usePaneWidth';
import { PANE_GEOMETRY } from '../../components/shared/paneGeometry';
import { InterfaceLoadBoundary } from '../../components/shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import ModalDialog from '../../components/shared/ModalDialog';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationProject,
  ConversationSessionSummary,
} from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import DeepCodeConversationShell from './DeepCodeConversationShell';
import DeepCodeSidebar from './DeepCodeSidebar';
import { useReadRunMarkers } from './useReadRunMarkers';
import { useSidebarOrder } from './useSidebarOrder';
import DeepCodeTaskPanel from './DeepCodeTaskPanel';
import DeepCodeTitlebar from './DeepCodeTitlebar';
import type { ReaderLocation, ReaderNavigationRequest } from '../../components/local-agent/readerState';
import { forgetClosedBrowser, locationKey, visitLocation, type NavigationHistory, type WorkbenchLocation } from './navigationHistory';
import DeepCodeShellIcon from '../../components/shared/DeepCodeShellIcon';
import ProjectFolderDialog from '../../components/workspace-open-dialog/ProjectFolderDialog';
import '../styles/deepcodeShell.css';
import '../styles/deepcodeWorkbench.css';

interface DeepCodeWorkbenchLayoutProps {
  apiStatus: string;
  serverVersion?: string;
  kernelStartBusy?: boolean;
  kernelStartMessage?: string | null;
  onRetryKernelStart?: () => void | Promise<void>;
}

const SettingsCenter = lazy(
  () => loadInterfaceModule(() => import('../../components/settings-center/SettingsCenter')),
);

type PositionedMenu<T> = { value: T; x: number; y: number };
type FolderAction =
  | { kind: 'create' }
  | {
      kind: 'bind';
      project: ConversationProject;
      startAfterBinding: boolean;
      reopenManager: boolean;
    };
type TextDialog =
  | { kind: 'createProject'; title: string; value: string }
  | { kind: 'renameProject'; title: string; value: string; project: ConversationProject }
  | { kind: 'renameSession'; title: string; value: string; session: ConversationSessionSummary };
type ManagedWorkspace = { workspaceId: string; displayName: string; canonicalRoot: string };

const DeepCodeWorkbenchLayout: React.FC<DeepCodeWorkbenchLayoutProps> = ({
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
  const [readerLocation, setReaderLocation] = useState<ReaderLocation | null>(null);
  const [readerRequest, setReaderRequest] = useState<ReaderNavigationRequest | null>(null);
  const [history, setHistory] = useState<NavigationHistory>({ entries: [], cursor: -1 });
  const [navigationPending, setNavigationPending] = useState<{ index: number; location: WorkbenchLocation } | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigationRequestId = useRef(0);
  const [readerLayout, setReaderLayout] = useState<ConversationReaderLayout>({ visible: false, expanded: false, conversationBounds: null });
  useInterfaceReloadView('settingsOpen', settingsOpen);
  useInterfaceReloadView('conversation', { sessionId: activeSessionId, draftProjectId });
  const [settingsNavigation, setSettingsNavigation] = useState<HTMLDivElement | null>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const settingsOpener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (settingsOpen) {
      settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      settingsClose.current?.focus({ preventScroll: true });
    } else if (settingsOpener.current?.isConnected) {
      settingsOpener.current.focus({ preventScroll: true });
      settingsOpener.current = null;
    }
  }, [settingsOpen]);
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
  const busy = loading || submitting || catalogBusy || !!navigationPending;
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
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
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
      x: Math.max(8, Math.min(rect.right - 218, window.innerWidth - 226)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 110)),
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
    setProjectMenu(positioned(event, project, 204, 160));
  };

  const openSessionMenu = (
    event: React.MouseEvent<HTMLElement>,
    session: ConversationSessionSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectCreateMenu(null);
    setProjectMenu(null);
    const height = 166 + Math.min(catalog.projects.length, 6) * 32;
    setSessionMenu(positioned(event, session, 218, height));
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
      const title = basename(folderPath) || t(language, 'deepcodeGui.project.defaultName');
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
    if (action.reopenManager) await openWorkspaceManager(action.project);
    if (action.startAfterBinding) startNewSession(action.project.id);
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
      t(language, 'deepcodeGui.project.deleteConfirm', { title: project.title }),
    );
    if (confirmed) await deleteProject(project.id);
  };

  return (
    <div className={`deepcode-gui-workbench${settingsOpen ? ' deepcode-gui-workbench--settings' : ''}${navigationCollapsed ? ' deepcode-gui-workbench--navigation-collapsed' : ''}`}
      ref={workbench} style={{ '--dc-navigation-width': `${navigationWidth.width}px` } as React.CSSProperties}
      onKeyDown={(event) => {
        if (settingsOpen && event.key !== 'Escape') event.stopPropagation();
      }}>
      <UiRegion slot="workbench.layout" regions={{
        titlebar: <><DeepCodeTitlebar sessionHeaderRef={setSessionHeader} language={language} settings={settingsOpen ? <>
        <strong>{t(language, 'settings.title')}</strong>
        <button type="button" ref={settingsClose} className="deepcode-local-agent-settings__close" onClick={() => setSettingsOpen(false)}>
          {t(language, 'deepcodeGui.settings.close')} <kbd>esc</kbd>
        </button>
      </> : undefined} /></>,
        navigation: <UiRegion slot="navigation" data={{ kind: 'navigation', projects: sidebarOrder.projects, sessions: sidebarOrder.sessions, activeSessionId, busy }}
          actions={{ activateSession: async (id: string) => { if (!busy && catalog.sessions.some(session => session.id === id)) await activateSession(id); } }}><DeepCodeNavigationBox settingsOpen={settingsOpen} settingsTargetRef={setSettingsNavigation} collapsed={navigationCollapsed}
          resizeHandle={<ResizeHandle className="deepcode-gui-navigation-resize" label={t(language, 'deepcodeGui.navigation.resize')}
            value={navigationWidth.width} min={navigationWidth.min} max={navigationWidth.max} step={PANE_GEOMETRY.navigation.step}
            direction={1} onResize={navigationWidth.setWidth} />} toolbar={<>
            <button type="button" aria-label={t(language, 'deepcodeGui.navigation.back')} title={t(language, 'deepcodeGui.navigation.back')} disabled={busy || history.cursor <= 0} onClick={() => void navigate(-1)}><DeepCodeShellIcon name="chevronLeft" /></button>
            <button type="button" aria-label={t(language, 'deepcodeGui.navigation.forward')} title={t(language, 'deepcodeGui.navigation.forward')} disabled={busy || history.cursor >= history.entries.length - 1} onClick={() => void navigate(1)}><DeepCodeShellIcon name="chevronRight" /></button>
            <button type="button" className="deepcode-gui-navigation-toggle" aria-label={t(language, navigationCollapsed ? 'deepcodeGui.navigation.expand' : 'deepcodeGui.navigation.collapse')} title={t(language, navigationCollapsed ? 'deepcodeGui.navigation.expand' : 'deepcodeGui.navigation.collapse')} aria-expanded={!navigationCollapsed} aria-controls="deepcode-navigation-content" onClick={() => setNavigationCollapsed(value => !value)}><DeepCodeShellIcon name="sidebar" /></button>
            {navigationError && <p className="deepcode-gui-navigation-error" role="alert">{navigationError}</p>}
          </>}>
        <DeepCodeSidebar
          language={language}
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
      </DeepCodeNavigationBox></UiRegion>,
        main: <><div
        className={`deepcode-gui-shell${showContextRail ? '' : ' deepcode-gui-shell--no-context'}`}
        data-navigation-density={navigationDensity}
      >
        <div className="deepcode-gui-main-surfaces" inert={settingsOpen} aria-hidden={settingsOpen || undefined}>
          <DeepCodeConversationShell headerTarget={sessionHeader} onReaderLayoutChange={setReaderLayout} readerNavigation={{
            request: readerRequest, onChange: setReaderLocation,
            onTabClosed: (sessionId, tabId) => setHistory(current => forgetClosedBrowser(current, sessionId, tabId)),
          }} />
          {showContextRail && <DeepCodeTaskPanel language={language} projection={projection} />}
        </div>
        <UsageWidget readerLayout={readerLayout} hidden={settingsOpen} />
        <ComputerTargetPreview readerLayout={readerLayout} language={language} hidden={settingsOpen} />
      </div></>,
      }} />

      {projectCreateMenu && (
        <div
          id="deepcode-project-create-menu"
          className="deepcode-gui-project-create-menu"
          style={{ left: projectCreateMenu.x, top: projectCreateMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setTextDialog({
                kind: 'createProject',
                title: t(language, 'deepcodeGui.project.newBlank'),
                value: t(language, 'deepcodeGui.project.defaultName'),
              });
            }}
          >
            <DeepCodeShellIcon name="plus" className="deepcode-gui-menu-icon" />
            <span>{t(language, 'deepcodeGui.project.newBlank')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setFolderAction({ kind: 'create' });
            }}
          >
            <DeepCodeShellIcon name="folder" />
            <span>{t(language, 'deepcodeGui.project.fromFolder')}</span>
          </button>
        </div>
      )}

      {sessionMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="deepcode-gui-session-context-menu__title">
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
                className="deepcode-gui-session-context-menu__danger"
                onClick={() => requestDeleteSession(sessionMenu.value)}
              >
                {t(language, 'agent.session.delete')}
              </button>
              {catalog.projects.length > 0 && (
                <div className="deepcode-gui-session-context-menu__section">
                  <div className="deepcode-gui-session-context-menu__section-title">
                    {t(language, 'deepcodeGui.session.addToProject')}
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
                  {t(language, 'deepcodeGui.session.removeFromProject')}
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
            {t(language, 'deepcodeGui.session.copyId')}
          </button>
        </div>
      )}

      {projectMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="deepcode-gui-session-context-menu__title">{projectMenu.value.title}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectMenu(null);
              setTextDialog({
                kind: 'renameProject',
                title: t(language, 'deepcodeGui.project.rename'),
                value: projectMenu.value.title,
                project: projectMenu.value,
              });
            }}
          >
            {t(language, 'deepcodeGui.project.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const project = projectMenu.value;
              void openWorkspaceManager(project);
            }}
          >
            {t(language, 'deepcodeGui.project.manageWorkspaces')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="deepcode-gui-session-context-menu__danger"
            onClick={() => void confirmDeleteProject(projectMenu.value)}
          >
            {t(language, 'deepcodeGui.project.delete')}
          </button>
        </div>
      )}

      {textDialog && (
        <ModalDialog className="deepcode-gui-text-dialog-backdrop" aria-label={textDialog.title} busy={catalogBusy} onClose={() => setTextDialog(null)}>
          <form
            className="deepcode-gui-text-dialog"
            onSubmit={(event) => void submitTextDialog(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{textDialog.title}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                onClick={() => setTextDialog(null)}
              ><DeepCodeShellIcon name="close" size={14} /></button>
            </header>
            <label>
              <span>{t(language, 'deepcodeGui.nameLabel')}</span>
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
        <ModalDialog className="deepcode-gui-text-dialog-backdrop" aria-labelledby="deepcode-delete-session-title" busy={catalogBusy} onClose={() => setDeleteSessionCandidate(null)}>
          <div className="deepcode-gui-text-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2 id="deepcode-delete-session-title">{t(language, 'agent.session.delete')}</h2>
              <button
                type="button"
                aria-label={t(language, 'agent.session.cancel')}
                disabled={catalogBusy}
                onClick={() => setDeleteSessionCandidate(null)}
              ><DeepCodeShellIcon name="close" size={14} /></button>
            </header>
            <p className="deepcode-gui-text-dialog__message">
              {t(language, 'deepcodeGui.session.deleteConfirm', {
                title: deleteSessionCandidate.title || t(language, 'agent.session.newTitle'),
              })}
            </p>
            {deleteSessionError && (
              <p className="deepcode-gui-text-dialog__error" role="alert">
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
                className="deepcode-gui-text-dialog__danger"
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
        <ModalDialog className="deepcode-gui-text-dialog-backdrop" aria-label={t(language, 'deepcodeGui.project.workspacesTitle')} busy={workspaceManager.loading} onClose={() => setWorkspaceManager(null)}>
          <div className="deepcode-gui-text-dialog deepcode-gui-workspace-manager" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>{workspaceManager.project.title} · {t(language, 'deepcodeGui.project.workspacesTitle')}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                disabled={workspaceManager.loading}
                onClick={() => setWorkspaceManager(null)}
              ><DeepCodeShellIcon name="close" size={14} /></button>
            </header>
            <p className="deepcode-gui-text-dialog__message">
              {t(language, 'deepcodeGui.project.workspaceTemplateHint')}
            </p>
            <h3 className="deepcode-gui-workspace-manager__heading">{language === 'zh-CN' ? '源文件夹' : 'Source folders'}</h3>
            <div className="deepcode-gui-workspace-manager__list" onMouseDown={(event) => event.stopPropagation()}>
              {!workspaceManager.loading && workspaceManager.records.length === 0 && (
                <div className="deepcode-gui-workspace-manager__empty">
                  {t(language, 'deepcodeGui.project.noWorkspaces')}
                </div>
              )}
              {workspaceManager.records.map((record) => (
                <div className="deepcode-gui-workspace-manager__row" key={record.workspaceId}>
                  <DeepCodeShellIcon name="folder" size={18} />
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
                className="deepcode-gui-workspace-manager__add"
                disabled={workspaceManager.loading}
                onClick={() => {
                  const project = workspaceManager.project;
                  setFolderAction({
                    kind: 'bind',
                    project,
                    startAfterBinding: false,
                    reopenManager: true,
                  });
                }}
              >
                <DeepCodeShellIcon name="plus" size={18} />{t(language, 'deepcodeGui.project.addFolder')}
              </button>
            </div>
            <ProjectEnvironmentSettings key={workspaceManager.project.id} projectId={workspaceManager.project.id} chinese={language === 'zh-CN'} />
            {workspaceManager.error && (
              <p className="deepcode-gui-text-dialog__error" role="alert">{workspaceManager.error}</p>
            )}
            <footer>
              <button type="button" onClick={() => setWorkspaceManager(null)}>
                {t(language, 'deepcodeGui.common.done')}
              </button>

            </footer>
          </div>
        </ModalDialog>
      )}

      {settingsOpen && (
        <section className="deepcode-local-agent-overlay" aria-label={t(language, 'settings.title')}>
          <div className="deepcode-local-agent-settings" onMouseDown={(event) => event.stopPropagation()}>
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
  width: number,
  height: number,
): PositionedMenu<T> {
  const rect = event.currentTarget.getBoundingClientRect();
  const rawX = event.clientX || rect.right;
  const rawY = event.clientY || rect.bottom;
  return {
    value,
    x: Math.max(8, Math.min(rawX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(rawY, window.innerHeight - height - 8)),
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

export default DeepCodeWorkbenchLayout;
