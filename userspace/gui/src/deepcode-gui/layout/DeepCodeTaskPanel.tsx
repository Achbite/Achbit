import { UiRegion } from '../../ui-plugins/UiRegion';
import { MarkdownInline } from '../../components/local-agent/BufferedMarkdown';
import React from 'react';
import { useDisplayedConversation } from '../../components/local-agent/ConversationDisplayProvider';
import { ArtifactLinks } from '../../components/local-agent/ArtifactLinks';
import { AgentOverview } from '../../components/local-agent/AgentOverview';
import { useAgentDeliveries } from '../../components/local-agent/useAgentDeliveries';
import { requestWorkspacePreview } from '../../components/local-agent/readerState';
import type { ArtifactProjection, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../../components/shared/DeepCodeShellIcon';

interface DeepCodeTaskPanelProps {
  language: UiLanguage;
  projection: SessionProjection | null;
}

const DeepCodeTaskPanel: React.FC<DeepCodeTaskPanelProps> = ({ language, projection }) => {
  // Session publishes the latest version and ordering of explicit deliveries.
  const display = useDisplayedConversation();
  const [showAllArtifacts, setShowAllArtifacts] = React.useState(false);
  React.useEffect(() => { setShowAllArtifacts(false); }, [projection?.sessionId]);
  const childDeliveries = useAgentDeliveries(projection);
  const artifacts = [...new Map([...display.artifacts, ...childDeliveries.artifacts].map(artifact => [artifact.artifactId, artifact])).values()];
  const todos = projection?.todoList?.items ?? [];
  const todoRun = projection?.todoList && projection.tokenUsageHistory.find(run => run.runId === projection.todoList!.runId);
  const remaining = todos.filter(todo => todo.status !== 'completed').length;
  const ended = Boolean(todoRun?.outcome);
  return (
    <aside className={`deepcode-gui-context-panel${showAllArtifacts ? ' deepcode-gui-context-panel--outputs' : ''}`}>
      {!showAllArtifacts && <UiRegion slot="task.panel" data={{ kind: 'tasks', todoList: projection?.todoList ?? null, run: todoRun ?? null }}><section className="deepcode-gui-task-list-card">
        <div className="deepcode-gui-task-list-card__title">
          <span>{t(language, 'deepcodeGui.tasks.title')}</span>
        </div>
        {todos.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.tasks.empty')}
          </div>
        ) : (
          <div className="deepcode-gui-task-list">
            {todos.map((todo, index) => (
              <div
                className={`deepcode-gui-task-item deepcode-gui-task-item--${todo.status === 'inProgress' ? ended ? 'pending' : 'active' : todo.status}`}
                key={index}
              >
                <span className="deepcode-gui-task-item__dot" aria-hidden="true" />
                <div>
                  <div className="deepcode-gui-task-item__title"><MarkdownInline>{todo.text}</MarkdownInline></div>
                </div>
                <strong>{ended && todo.status === 'inProgress' ? t(language, 'deepcodeGui.tasks.lastInProgress') : todoStatus(todo.status, language)}</strong>
              </div>
            ))}
          </div>
        )}
        {ended && remaining > 0 && <small className="deepcode-gui-task-list-card__note">
          {t(language, 'deepcodeGui.tasks.endedRemaining', { count: remaining })}
        </small>}
      </section></UiRegion>}

      <UiRegion slot="artifact.panel" data={{ kind: 'artifacts', artifacts, expanded: showAllArtifacts }} actions={{ setExpanded: setShowAllArtifacts }}>
        <ConversationOutputs key={projection?.sessionId} artifacts={artifacts} language={language}
          expanded={showAllArtifacts} onExpandedChange={setShowAllArtifacts}
          onOpen={(workspaceId, path) => requestWorkspacePreview(projection!.sessionId, workspaceId, path)} />
      </UiRegion>
      {childDeliveries.error && <p role="alert" className="local-agent__resource-error">{childDeliveries.error}</p>}
      {!showAllArtifacts && projection && <AgentOverview projection={projection} language={language} />}
    </aside>
  );
};

/** The full list replaces the contents of this rail, leaving the conversation width unchanged. */
export function ConversationOutputs({ artifacts, language, expanded, onExpandedChange, onOpen }: {
  artifacts: readonly ArtifactProjection[]; language: UiLanguage; expanded: boolean; onExpandedChange(value: boolean): void;
  onOpen(workspaceId: string, logicalPath: string): Promise<void>;
}) {
  const navigation = React.useRef<HTMLButtonElement>(null);
  const previousExpanded = React.useRef(expanded);
  React.useLayoutEffect(() => {
    if (previousExpanded.current !== expanded) navigation.current?.focus({ preventScroll: true });
    previousExpanded.current = expanded;
  }, [expanded]);
  return <section className={expanded ? 'deepcode-gui-output-page' : 'deepcode-gui-task-list-card deepcode-gui-output-card'}
    aria-label={t(language, 'deepcodeGui.outputs.title')} onKeyDown={event => {
      if (expanded && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onExpandedChange(false); }
    }}>
    <div className="deepcode-gui-task-list-card__title">
      {expanded && <button ref={navigation} type="button" className="deepcode-gui-output-back"
        aria-label={t(language, 'deepcodeGui.outputs.back')} onClick={() => onExpandedChange(false)}><DeepCodeShellIcon name="chevronLeft" /></button>}
      <span>{t(language, 'deepcodeGui.outputs.title')}</span>
      {expanded && <small>{artifacts.length}</small>}
    </div>
    {artifacts.length === 0 ? <div className="deepcode-gui-task-list-card__empty">{t(language, 'deepcodeGui.outputs.empty')}</div> : <>
      <div className="deepcode-gui-output-list">
        <ArtifactLinks artifacts={expanded ? artifacts : artifacts.slice(0, 3)} onOpen={onOpen} />
      </div>
      {!expanded && artifacts.length > 3 && <button ref={navigation} type="button" className="deepcode-gui-output-more" onClick={() => onExpandedChange(true)}>
        <DeepCodeShellIcon name="chevronRight" />{t(language, 'deepcodeGui.outputs.showAll', { count: artifacts.length })}
      </button>}
    </>}
  </section>;
}

function todoStatus(status: 'pending' | 'inProgress' | 'completed' | 'blocked', language: UiLanguage): string {
  return t(language, `deepcodeGui.tasks.status.${status}`);
}

export default DeepCodeTaskPanel;
