import { UiRegion } from '../../ui-plugins/UiRegion';
import { MarkdownInline } from '../../components/local-agent/BufferedMarkdown';
import React from 'react';
import { useDisplayedConversation } from '../../components/local-agent/ConversationDisplayProvider';
import { ArtifactLinks } from '../../components/local-agent/ArtifactLinks';
import { AgentOverview } from '../../components/local-agent/AgentOverview';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useAgentDeliveries } from '../../components/local-agent/useAgentDeliveries';
import { requestWorkspacePreview } from '../../components/local-agent/readerState';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../../components/shared/AchbitShellIcon';
import { focusOpenedPanel, useInteractionFocus } from '../../components/shared/interactionFocus';

interface AchbitTaskPanelProps {
  language: UiLanguage;
  projection: SessionProjection | null;
}

const AchbitTaskPanel: React.FC<AchbitTaskPanelProps> = ({ language, projection }) => {
  // Session publishes the latest version and ordering of explicit deliveries.
  const display = useDisplayedConversation();
  const [showAllArtifacts, setShowAllArtifacts] = React.useState(false);
  const childDeliveries = useAgentDeliveries(projection);
  const sessionId = useLocalAgentStore(s => s.sessionId);
  React.useEffect(() => { setShowAllArtifacts(false); }, [sessionId]);
  const artifacts = [...new Map([...display.artifacts, ...childDeliveries.artifacts].map(artifact => [artifact.artifactId, artifact])).values()];
  const waitingForChildren = !!projection?.agentTasks?.some(task => task.childRunId) && childDeliveries.sessionId !== sessionId;
  const todoList = projection?.todoList;
  const todos = todoList?.items ?? [];
  const todoRun = projection?.tokenUsageHistory.find(run => run.runId === todoList?.runId);
  const remaining = todos.filter(todo => todo.status !== 'completed').length;
  const ended = Boolean(todoRun?.outcome);
  return (
    <aside className={`achbit-gui-context-panel${showAllArtifacts ? ' achbit-gui-context-panel--outputs' : ''}`}>
      {!showAllArtifacts && <UiRegion slot="task.panel" data={{ kind: 'tasks', todoList: todoList ?? null, run: todoRun ?? null }}><section className="achbit-gui-task-list-card">
        <div className="achbit-gui-task-list-card__title">
          <span>{t(language, 'achbitGui.tasks.title')}</span>
        </div>
        {todos.length === 0 ? (
          <div className="achbit-gui-task-list-card__empty">
            {t(language, 'achbitGui.tasks.empty')}
          </div>
        ) : (
          <div className="achbit-gui-task-list">
            {todos.map((todo, index) => (
              <div
                className={`achbit-gui-task-item achbit-gui-task-item--${todo.status === 'inProgress' ? ended ? 'pending' : 'active' : todo.status}`}
                key={index}
              >
                <span className="achbit-gui-task-item__dot" aria-hidden="true" />
                <div>
                  <div className="achbit-gui-task-item__title"><MarkdownInline>{todo.text}</MarkdownInline></div>
                </div>
                <strong>{ended && todo.status === 'inProgress' ? t(language, 'achbitGui.tasks.lastInProgress') : todoStatus(todo.status, language)}</strong>
              </div>
            ))}
          </div>
        )}
        {ended && remaining > 0 && <small className="achbit-gui-task-list-card__note">
          {t(language, 'achbitGui.tasks.endedRemaining', { count: remaining })}
        </small>}
      </section></UiRegion>}

      <UiRegion slot="artifact.panel" data={{ kind: 'artifacts', artifacts, expanded: showAllArtifacts }} actions={{ setExpanded: setShowAllArtifacts }}>
        <ConversationOutputs key={sessionId} artifacts={artifacts} language={language}
          loading={waitingForChildren} expanded={showAllArtifacts} onExpandedChange={setShowAllArtifacts}
          onOpen={(workspaceId, path) => requestWorkspacePreview(sessionId!, workspaceId, path)} />
      </UiRegion>
      {childDeliveries.error && <p role="alert" className="local-agent__resource-error">{childDeliveries.error}</p>}
      {!showAllArtifacts && projection && <AgentOverview projection={projection} language={language} />}
    </aside>
  );
};

/** The full list replaces the contents of this rail, leaving the conversation width unchanged. */
export function ConversationOutputs({ artifacts, language, expanded, onExpandedChange, onOpen, loading = false }: {
  loading?: boolean; artifacts: readonly ArtifactProjection[]; language: UiLanguage; expanded: boolean; onExpandedChange(value: boolean): void;
  onOpen(workspaceId: string, logicalPath: string): Promise<void>;
}) {
  const navigation = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLElement>(null);
  const interaction = useInteractionFocus();
  const previousExpanded = React.useRef(expanded);
  const navigationRequested = React.useRef(false);
  const navigate = (value: boolean) => { navigationRequested.current = true; onExpandedChange(value); };
  React.useLayoutEffect(() => {
    if (previousExpanded.current !== expanded) {
      if (navigationRequested.current && panel.current) focusOpenedPanel(panel.current, navigation.current, interaction);
      navigationRequested.current = false;
    }
    previousExpanded.current = expanded;
  }, [expanded, interaction]);
  return <section ref={panel} tabIndex={-1} className={expanded ? 'achbit-gui-output-page' : 'achbit-gui-task-list-card achbit-gui-output-card'}
    aria-label={t(language, 'achbitGui.outputs.title')} onKeyDown={event => {
      if (expanded && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); navigate(false); }
    }}>
    <div className="achbit-gui-task-list-card__title">
      {expanded && <button ref={navigation} type="button" className="achbit-gui-output-back"
        aria-label={t(language, 'achbitGui.outputs.back')} onClick={() => navigate(false)}><AchbitShellIcon name="chevronLeft" /></button>}
      <span>{t(language, 'achbitGui.outputs.title')}</span>
      {expanded && <small>{artifacts.length}</small>}
    </div>
    {loading ? <div role="status" className="achbit-gui-task-list-card__empty">{language === 'zh-CN' ? '正在读取产出…' : 'Loading outputs…'}</div>
      : artifacts.length === 0 ? <div className="achbit-gui-task-list-card__empty">{t(language, 'achbitGui.outputs.empty')}</div> : <>
      <div className="achbit-gui-output-list">
        <ArtifactLinks location="outputs" artifacts={expanded ? artifacts : artifacts.slice(0, 3)} onOpen={onOpen} />
      </div>
      {!expanded && artifacts.length > 3 && <button ref={navigation} type="button" className="achbit-gui-output-more" onClick={() => navigate(true)}>
        <AchbitShellIcon name="chevronRight" />{t(language, 'achbitGui.outputs.showAll', { count: artifacts.length })}
      </button>}
    </>}
  </section>;
}

function todoStatus(status: 'pending' | 'inProgress' | 'completed' | 'blocked', language: UiLanguage): string {
  return t(language, `achbitGui.tasks.status.${status}`);
}

export default AchbitTaskPanel;
