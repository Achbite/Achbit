import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  ConversationProject,
  ConversationSessionSummary,
  ConversationSessionStatus,
} from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitBrand from './AchbitBrand';
import AchbitShellIcon from '../../components/shared/AchbitShellIcon';
import { SessionRunStatus } from '../../components/local-agent/SessionRunStatus';
import { runReadMarker } from './useReadRunMarkers';
import { canDropSidebarItem, type SidebarDragItem, type SidebarDropEdge } from './sidebarOrder';

interface AchbitSidebarProps {
  language: UiLanguage;
  projects: ConversationProject[];
  sessions: ConversationSessionSummary[];
  sessionStatuses: Readonly<Record<string, ConversationSessionStatus>>;
  statusError: string | null;
  readRunMarkers: Readonly<Record<string, string>>;
  collapsedProjectIds: ReadonlySet<string>;
  activeSessionId: string | null;
  draftProjectId: string | null;
  busy: boolean;
  reorderDisabled: boolean;
  reorderError: string | null;
  onReorder: (source: SidebarDragItem, target: SidebarDragItem, edge: SidebarDropEdge) => void;
  projectCreateMenuOpen: boolean;
  onCreatePrimarySession: () => void;
  onOpenProjectCreateMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleProject: (projectId: string) => void;
  onCreateProjectSession: (project: ConversationProject) => void;
  onActivateSession: (session: ConversationSessionSummary) => void;
  onOpenProjectContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    project: ConversationProject,
  ) => void;
  onOpenSessionContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    session: ConversationSessionSummary,
  ) => void;
  onOpenSettings: () => void;
}

const PROJECT_SESSION_PREVIEW_LIMIT = 6;

const AchbitSidebar: React.FC<AchbitSidebarProps> = ({
  language,
  projects,
  sessions,
  sessionStatuses,
  statusError,
  readRunMarkers,
  collapsedProjectIds,
  activeSessionId,
  draftProjectId,
  busy,
  reorderDisabled,
  reorderError,
  onReorder,
  projectCreateMenuOpen,
  onCreatePrimarySession,
  onOpenProjectCreateMenu,
  onToggleProject,
  onCreateProjectSession,
  onActivateSession,
  onOpenProjectContextMenu,
  onOpenSessionContextMenu,
  onOpenSettings,
}) => {
  const listRef = useRef<HTMLElement>(null);
  const projectListId = useId();
  const [expandedProjectLists, setExpandedProjectLists] = useState<ReadonlySet<string>>(() => new Set());
  const projectGroups = useMemo(() => projects.map((project) => {
    const projectSessions = sessions.filter((session) => session.projectId === project.id);
    const expanded = expandedProjectLists.has(project.id);
    const activeIndex = projectSessions.findIndex((session) => session.id === activeSessionId);
    const visibleSessions = expanded ? projectSessions
      : activeIndex >= PROJECT_SESSION_PREVIEW_LIMIT
        ? [...projectSessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT - 1), projectSessions[activeIndex]]
        : projectSessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
    return { project, projectSessions, visibleSessions, expanded };
  }), [activeSessionId, expandedProjectLists, projects, sessions]);
  const activeProjectId = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)?.projectId
    : draftProjectId;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const dragSource = useRef<{
    item: SidebarDragItem; x: number; y: number; pointerId: number; element: HTMLElement;
  } | null>(null);
  const dragged = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: SidebarDropEdge } | null>(null);
  const endDrag = useCallback(() => {
    const source = dragSource.current;
    dragSource.current = null;
    if (source?.element.hasPointerCapture(source.pointerId)) source.element.releasePointerCapture(source.pointerId);
    setDraggingId(null);
    setDropTarget(null);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') endDrag(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', endDrag);
    };
  }, [endDrag]);
  const targetAt = (source: SidebarDragItem, x: number, y: number) => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[data-sidebar-kind='${source.kind}']`);
    if (!element) return null;
    const id = element.dataset.sidebarId;
    const record = source.kind === 'project' ? projects.find((item) => item.id === id) : sessions.find((item) => item.id === id);
    if (!record) return null;
    const item: SidebarDragItem = source.kind === 'project'
      ? { kind: 'project', id: record.id }
      : { kind: 'session', id: record.id, projectId: (record as ConversationSessionSummary).projectId };
    if (!canDropSidebarItem(source, item)) return null;
    const rect = element.getBoundingClientRect();
    const edge: SidebarDropEdge = y < rect.top + rect.height / 2 ? 'before' : 'after';
    return { item, edge };
  };
  const movePointer = (event: React.PointerEvent<HTMLElement>) => {
    const source = dragSource.current;
    if (!source || source.pointerId !== event.pointerId) return;
    if (!dragged.current && Math.hypot(event.clientX - source.x, event.clientY - source.y) < 5) return;
    dragged.current = true;
    event.preventDefault();
    setDraggingId(source.item.id);
    const list = listRef.current;
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 24) list.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 24) list.scrollTop += 12;
    }
    const target = targetAt(source.item, event.clientX, event.clientY);
    setDropTarget(target ? { id: target.item.id, edge: target.edge } : null);
  };
  const dropPointer = (event: React.PointerEvent<HTMLElement>) => {
    const source = dragSource.current;
    if (!source || source.pointerId !== event.pointerId) return;
    const target = dragged.current ? targetAt(source.item, event.clientX, event.clientY) : null;
    endDrag();
    if (target && !busy && !reorderDisabled) onReorder(source.item, target.item, target.edge);
  };
  const dragProps = (item: SidebarDragItem) => ({
    'data-sidebar-kind': item.kind,
    'data-sidebar-id': item.id,
    'data-dragging': draggingId === item.id || undefined,
    'data-drop-edge': dropTarget?.id === item.id ? dropTarget.edge : undefined,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || busy || reorderDisabled || (event.target as HTMLElement).closest(
        '.achbit-gui-project-archive-group__actions, .achbit-gui-session-row__menu',
      )) return;
      event.stopPropagation();
      const element = (event.target as HTMLElement).closest('button') ?? event.currentTarget;
      dragged.current = false;
      dragSource.current = { item, x: event.clientX, y: event.clientY, pointerId: event.pointerId, element };
      element.setPointerCapture(event.pointerId);
    },
  });
  const renderStatus = (sessionId: string) => {
    const run = sessionStatuses[sessionId]?.run;
    const marker = runReadMarker(run ?? null);
    if (!run || (marker && readRunMarkers[sessionId] === marker)) return null;
    return <SessionRunStatus run={run} language={language} compact />;
  };
  const standalone = sessions.filter((session) => !session.projectId);
  const [commandPressed, setCommandPressed] = useState(false);
  const shortcutSessions = useMemo(() => [
    ...projectGroups.flatMap(({ project, visibleSessions }) => (
      collapsedProjectIds.has(project.id)
        ? []
        : visibleSessions
    )),
    ...sessions.filter((session) => !session.projectId),
  ].slice(0, 9), [collapsedProjectIds, projectGroups, sessions]);
  const shortcutBySessionId = useMemo(
    () => new Map(shortcutSessions.map((session, index) => [session.id, index + 1])),
    [shortcutSessions],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Meta' || event.metaKey) setCommandPressed(true);
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || busy) return;
      const match = /^Digit([1-9])$/u.exec(event.code);
      if (!match) return;
      const session = shortcutSessions[Number(match[1]) - 1];
      if (!session) return;
      event.preventDefault();
      onActivateSession(session);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || !event.metaKey) setCommandPressed(false);
    };
    const reset = () => setCommandPressed(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
    };
  }, [busy, onActivateSession, shortcutSessions]);

  const renderSession = (session: ConversationSessionSummary) => {
    const shortcut = shortcutBySessionId.get(session.id);
    return (
      <div
        className={`achbit-gui-session-row${session.id === activeSessionId ? ' achbit-gui-session-row--active' : ''}`}
        key={session.id}
        {...dragProps({ kind: 'session', id: session.id, projectId: session.projectId })}
      >
        <button
          type="button"
          className={session.id === activeSessionId ? 'active' : ''}
          onClick={() => onActivateSession(session)}
          onContextMenu={(event) => onOpenSessionContextMenu(event, session)}
          disabled={busy}
          title={session.title || session.id}
          aria-keyshortcuts={shortcut ? `Meta+${shortcut}` : undefined}
        >
          <span className="achbit-gui-session-row__title">{sessionTitle(session, language)}</span>
          {renderStatus(session.id)}
          {commandPressed && shortcut && <kbd>⌘{shortcut}</kbd>}
        </button>
        <button
          type="button"
          className="achbit-gui-session-row__menu"
          onClick={(event) => onOpenSessionContextMenu(event, session)}
          aria-label={t(language, 'achbitGui.session.actions')}
        >
          <AchbitShellIcon name="more" />
        </button>
      </div>
    );
  };

  return (
    <div
      className="achbit-gui-left-rail"
      onPointerMove={movePointer}
      onPointerUp={dropPointer}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDragStart={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="achbit-gui-sidebar-brand">
        <AchbitBrand />
      </div>
      <div className="achbit-gui-sidebar-actions">
        <button
          type="button"
          className="achbit-gui-sidebar-action achbit-gui-sidebar-action--primary"
          onClick={() => {
            if (activeProject) onCreateProjectSession(activeProject);
            else onCreatePrimarySession();
          }}
          disabled={busy}
        >
          <AchbitShellIcon name="compose" className="achbit-gui-sidebar-icon" />
          <span>{t(language, 'achbitGui.nav.newChat')}</span>
        </button>
      </div>

      {reorderError && (
        <div className="achbit-gui-sidebar-error" role="alert">
          {t(language, 'achbitGui.sidebar.orderError', { detail: reorderError })}
        </div>
      )}
      {statusError && (
        <div className="achbit-gui-sidebar-error" role="alert">
          {t(language, 'achbitGui.sidebar.statusError', { detail: statusError })}
        </div>
      )}

      <section ref={listRef} className="achbit-gui-sidebar-section">
        <div className="achbit-gui-sidebar-section__heading achbit-gui-sidebar-section__heading--project">
          <div className="achbit-gui-sidebar-section__label">
            {t(language, 'achbitGui.sidebar.project')}
          </div>
          <button
            type="button"
            className="achbit-gui-sidebar-text-action achbit-gui-sidebar-reveal-action"
            onClick={onOpenProjectCreateMenu}
            onPointerDown={(event) => event.stopPropagation()}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={projectCreateMenuOpen}
            aria-controls="deepcode-project-create-menu"
            aria-label={t(language, 'achbitGui.project.new')}
            title={t(language, 'achbitGui.project.new')}
          >
            <AchbitShellIcon name="plus" />
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="achbit-gui-sidebar-empty">
            {t(language, 'achbitGui.project.empty')}
          </div>
        ) : (
          <div className="achbit-gui-project-archive-list">
            {projectGroups.map(({ project, projectSessions, visibleSessions, expanded }) => {
              const collapsed = collapsedProjectIds.has(project.id);
              const sessionsId = `${projectListId}-${project.id}`;
              const current = draftProjectId === project.id
                || projectSessions.some((session) => session.id === activeSessionId);
              return (
                <div
                  key={project.id}
                  className={`achbit-gui-project-archive-group${current ? ' achbit-gui-project-archive-group--current' : ''}`}
                  {...dragProps({ kind: 'project', id: project.id })}
                >
                  <div
                    className="achbit-gui-project-archive-group__title"
                    onContextMenu={(event) => onOpenProjectContextMenu(event, project)}
                  >
                    <button
                      type="button"
                      className="achbit-gui-project-archive-group__select"
                      onClick={() => onToggleProject(project.id)}
                      aria-expanded={!collapsed}
                      title={project.title}
                    >
                      <span className={`achbit-gui-project-chevron${collapsed ? '' : ' achbit-gui-project-chevron--expanded'}`}>
                        <AchbitShellIcon name="chevronRight" />
                      </span>
                      <AchbitShellIcon name="folder" className="achbit-gui-sidebar-icon" />
                      <span>{project.title}</span>
                    </button>
                    <div className="achbit-gui-project-archive-group__actions">
                      <button
                        type="button"
                        className="achbit-gui-project-archive-group__compose"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateProjectSession(project);
                        }}
                        disabled={busy}
                        aria-label={t(language, 'achbitGui.project.newChat')}
                        title={t(language, 'achbitGui.project.newChat')}
                      >
                        <AchbitShellIcon name="compose" />
                      </button>
                      <button
                        type="button"
                        className="achbit-gui-project-archive-group__menu"
                        onClick={(event) => onOpenProjectContextMenu(event, project)}
                        aria-label={t(language, 'achbitGui.project.actions')}
                        title={t(language, 'achbitGui.project.actions')}
                      >
                        <AchbitShellIcon name="more" />
                      </button>
                    </div>
                  </div>
                  {!collapsed && (
                    <div className="achbit-gui-project-archive-group__sessions">
                      <div
                        id={sessionsId}
                        className="achbit-gui-project-session-list"
                        data-expanded={expanded || undefined}
                        style={{ '--dc-project-session-limit': PROJECT_SESSION_PREVIEW_LIMIT } as React.CSSProperties}
                      >
                        {projectSessions.length === 0 ? (
                          <div className="achbit-gui-sidebar-empty achbit-gui-sidebar-empty--nested">
                            {t(language, 'achbitGui.sidebar.noChats')}
                          </div>
                        ) : visibleSessions.map(renderSession)}
                      </div>
                      {projectSessions.length > PROJECT_SESSION_PREVIEW_LIMIT && (
                        <button
                          type="button"
                          className="achbit-gui-project-sessions-toggle"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => setExpandedProjectLists((current) => {
                            const next = new Set(current);
                            if (next.has(project.id)) next.delete(project.id);
                            else next.add(project.id);
                            return next;
                          })}
                          aria-expanded={expanded}
                          aria-controls={sessionsId}
                        >
                          {t(language, expanded ? 'achbitGui.sidebar.showLess' : 'achbitGui.sidebar.showMore', {
                            count: projectSessions.length - visibleSessions.length,
                          })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="achbit-gui-sidebar-section__heading">
          <div className="achbit-gui-sidebar-section__label achbit-gui-sidebar-section__label--nested">
            {t(language, 'achbitGui.sidebar.chats')}
          </div>
          <button
            type="button"
            className="achbit-gui-sidebar-new-chat"
            onClick={onCreatePrimarySession}
            disabled={busy}
            aria-label={t(language, 'achbitGui.nav.newChat')}
            title={t(language, 'achbitGui.nav.newChat')}
          >
            <AchbitShellIcon name="compose" />
          </button>
        </div>
        {standalone.length === 0 ? (
          <div className="achbit-gui-sidebar-empty">
            {t(language, 'achbitGui.sidebar.noChats')}
          </div>
        ) : (
          <div className="achbit-gui-session-list">
            {standalone.map(renderSession)}
          </div>
        )}
      </section>

      <footer className="achbit-gui-sidebar-footer">
      <button type="button" className="achbit-gui-sidebar-settings" onClick={onOpenSettings}>
        <span className="achbit-gui-sidebar-settings__icon">
          <AchbitShellIcon name="settings" />
        </span>
        <span>{t(language, 'achbitGui.settings.entry')}</span>
      </button>
      </footer>
    </div>
  );
};

function sessionTitle(session: ConversationSessionSummary, language: UiLanguage): string {
  return session.title.trim() || t(language, 'agent.session.newTitle');
}

export default AchbitSidebar;
