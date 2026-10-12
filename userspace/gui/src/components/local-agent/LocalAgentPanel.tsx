import { UiRegion } from '../../ui-plugins/UiRegion';
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeUiLanguage, t } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import { usePresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import ProjectFolderDialog from '../workspace-open-dialog/ProjectFolderDialog';
import { projectionItems, assistantDraftItems } from './conversationItems';
import { useConversationViewport } from './useConversationViewport';
import { useProjectionPolling, useProfilesUpdated } from './useProjectionPolling';
import { useAgentComposer } from './useAgentComposer';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { useDisplayedConversation } from './ConversationDisplayProvider';
import { ConversationComposer } from './ConversationComposer';
import { ConversationTranscript } from './ConversationTranscript';
import { ReaderControls, ResourcePreview, useResourcePreview } from './ResourcePreview';
import { ArtifactLinks } from './ArtifactLinks';
import './localAgentPanel.css';
import { AgentTasksPanel } from './AgentTasksPanel';
import { AgentNavigationScope } from './agentNavigation';
import type { ReaderNavigation } from './readerState';

export interface ConversationReaderLayout {
  visible: boolean;
  expanded: boolean;
  conversationBounds: HTMLElement | null;
}

interface LocalAgentPanelProps {
  mode?: 'panel' | 'workbench';
  headerTarget?: HTMLElement | null;
  onReaderLayoutChange?: (layout: ConversationReaderLayout) => void;
  readerNavigation?: ReaderNavigation;
}

const LocalAgentPanel: React.FC<LocalAgentPanelProps> = ({ mode = 'panel', headerTarget, onReaderLayoutChange, readerNavigation }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const showReasoning = effectiveSettings['gui.showReasoning'] === true;
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const sessionStatuses = useLocalAgentStore((state) => state.sessionStatuses);
  const projection = useLocalAgentStore((state) => state.projection);
  const loading = useLocalAgentStore((state) => state.loading);
  const refresh = useLocalAgentStore((state) => state.refresh);
  const refreshProfiles = useLocalAgentStore((state) => state.refreshProfiles);
  const [agentSurface, setAgentSurface] = useState<HTMLElement | null>(null);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  useEffect(() => setUiActionError(null), [sessionId]);
  const presentation = usePresentedCommittedContent(projection, language);
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || projection?.display.creationTitle.trim()
    || t(language, 'agent.session.newTitle');
  const conversationItems = projectionItems(projection);
  const assistantDraft = projection?.assistantDraft ?? null;
  const display = useDisplayedConversation();
  const showChangeBar = projection?.run && !display.displaySettledRunIds.has(projection.run.runId)
    && !['failed', 'cancelled', 'indeterminate'].includes(projection.run.status);
  const draftItems = useMemo(
    () => assistantDraftItems(assistantDraft),
    [assistantDraft],
  );
  const assistantDraftLayoutKey = `${assistantDraft?.blocks.map((block) => (
    `${block.kind === 'providerHosted' ? block.outputIndex : block.streamId}:${block.kind}:${block.kind === 'providerHosted'
      ? block.status
      : block.content.length}`
  )).join('|') ?? ''}|${JSON.stringify(assistantDraft?.planPreview ?? null)}`;
  const projectionPollingActive = Boolean(
    projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status),
  ) || Object.values(sessionStatuses).some((item) => (
    item.run && ['running', 'releasing'].includes(item.run.status)
  ));
  const timelineExtentKey = projection?.timeline.map((item) => (
    item.kind === 'toolGroup'
      ? `${item.timelineId}:${item.activityIds.length}`
      : item.timelineId
  )).join('|') ?? '';
  const hasConversationContent = conversationItems.length > 0
    || Boolean(assistantDraft)
    || Boolean(projection?.pendingInteraction)
    || Boolean(projection?.pendingApproval)
    || Boolean(projection?.pendingPlan)
    || Boolean(projection?.terminalError);
  useProfilesUpdated(refreshProfiles);
  useProjectionPolling(sessionId, projectionPollingActive, refresh);
  const viewport = useConversationViewport({
    sessionId,
    loading,
    projection,
    presentationLayoutKey: presentation.layoutKey,
    assistantDraftLayoutKey,
    timelineExtentKey,
  });
  const { bodyRef, bodyHandlers, showJumpToLatest, scrollToLatest } = viewport;
  const composer = useAgentComposer(language, viewport.setLatestFollowMode);
  const resourcePreview = useResourcePreview(sessionId, readerNavigation);
  const [readerHeader, setReaderHeader] = useState<HTMLDivElement | null>(null);
  const [conversationBounds, setConversationBounds] = useState<HTMLDivElement | null>(null);
  const readerLayout = { '--reader-width': `${resourcePreview.width}%` } as React.CSSProperties;
  useLayoutEffect(() => {
    onReaderLayoutChange?.({ visible: resourcePreview.visible, expanded: resourcePreview.expanded, conversationBounds });
  }, [onReaderLayoutChange, resourcePreview.visible, resourcePreview.expanded, conversationBounds]);

  const header = (
      <header className={`local-agent__header${resourcePreview.visible ? ' local-agent__header--reading' : ''}${resourcePreview.expanded ? ' local-agent__header--expanded' : ''}`} style={readerLayout}>
        <UiRegion slot="conversation.header" data={{
          kind: 'conversationHeader', sessionId, title,
          project: activeProject ? { id: activeProject.id, title: activeProject.title } : null,
          reader: { visible: resourcePreview.visible, expanded: resourcePreview.expanded,
            treeVisible: resourcePreview.treeVisible, canOpen: !!sessionId },
        }} actions={{
          toggleReader: () => { if (sessionId) resourcePreview.toggle(); },
          toggleReaderExpanded: () => { if (resourcePreview.visible) resourcePreview.expand(); },
          toggleTree: resourcePreview.toggleTree,
        }} regions={{ heading: <div className="local-agent__header-conversation">
        <div className="local-agent__heading">
          <span className="local-agent__heading-mark"><DeepCodeShellIcon name="session" /></span>
          <div>
            <strong>{title}</strong>
            {!headerTarget && activeProject && <span>{activeProject.title}</span>}
          </div>
        </div>
        </div>, reader: <div className="local-agent__header-preview">
          {resourcePreview.visible && <div className="reader-header-tabs" ref={setReaderHeader} />}
          <div className="local-agent__header-actions">
          <ReaderControls language={language} preview={resourcePreview} disabled={!sessionId} />
          </div>
        </div> }} />
      </header>
  );

  return (
    <AgentNavigationScope key={sessionId} surface={agentSurface} tasks={projection?.agentTasks}><section ref={setAgentSurface} className={`local-agent local-agent--${mode}${headerTarget ? ' local-agent--external-header' : ''}${hasConversationContent ? '' : ' local-agent--empty'}${resourcePreview.visible ? ' local-agent--reading' : ''}${resourcePreview.expanded ? ' local-agent--expanded' : ''}`} style={readerLayout}>
      {headerTarget ? createPortal(header, headerTarget) : header}
      <div className="local-agent__viewport">
      <div ref={bodyRef} className="local-agent__body" aria-live="polite" {...bodyHandlers}>
        <ConversationTranscript
          displaySettledRunIds={display.displaySettledRunIds}
          onDisplayed={display.onDisplayed}
          showReasoning={showReasoning}
          language={language}
          loading={loading}
          projection={projection}
          activeProject={activeProject}
          hasConversationContent={hasConversationContent}
          conversationItems={conversationItems}
          draftItems={draftItems}
          presentation={presentation}
          viewport={viewport}
          openWorkspaceResource={resourcePreview.openWorkspaceResource}
          setUiActionError={setUiActionError}
          canEditMessage={composer.canEditMessage}
          onEditMessage={composer.beginMessageEdit}
          composerInteractionId={composer.pendingInteraction?.interactionId}
        />
        {mode === 'panel' && !!display.artifacts.length && <ArtifactLinks artifacts={display.artifacts} onOpen={resourcePreview.openWorkspaceResource} />}
        {mode !== 'panel' && !!display.artifacts.length && <details className="conversation-artifact-shortcuts">
          <summary>{t(language, 'deepcodeGui.outputs.title')}</summary>
          <ArtifactLinks artifacts={display.artifacts} onOpen={resourcePreview.openWorkspaceResource} />
        </details>}
      </div>
      {showJumpToLatest && hasConversationContent && (
          <button
            type="button"
            className="local-agent__jump-latest"
            aria-label={t(language, 'agent.jumpLatest')}
            title={t(language, 'agent.jumpLatest')}
            onClick={scrollToLatest}
          >
            <DeepCodeShellIcon name="chevronDown" />
          </button>
        )}
      </div>

      <ConversationComposer
        onEditBrowserReview={resourcePreview.editBrowserReview}
        changeBar={showChangeBar && <FileChanges key={`${sessionId}:${projection.run!.runId}`} activities={roundChangeActivities(projection, projection.run!.runId)} compact />}
        language={language}
        composer={composer}
        uiActionError={uiActionError}
        onDismissUiActionError={() => setUiActionError(null)}
      />
      <ResourcePreview language={language} preview={resourcePreview} tabsTarget={readerHeader} onReview={composer.appendBrowserReview} />
      {onReaderLayoutChange && <div ref={setConversationBounds} className="local-agent__conversation-overlay-bounds" aria-hidden="true" />}
      {composer.attachmentDialogOpen && (
        <ProjectFolderDialog
          language={language}
          selectionMode="messageAttachment"
            onSelectMany={paths => void composer.selectMessageAttachments(paths)}
          onCancel={() => composer.setAttachmentDialogOpen(false)}
          onSelect={(absolutePath, type) => {
            void composer.selectMessageAttachments([{ path: absolutePath, kind: type }]);
          }}
        />
      )}
      {projection && <AgentTasksPanel projection={projection} language={language} />}
    </section></AgentNavigationScope>
  );
};

export default LocalAgentPanel;
