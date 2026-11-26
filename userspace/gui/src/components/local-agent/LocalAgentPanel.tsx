import { UiRegion } from '../../ui-plugins/UiRegion';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeUiLanguage, t } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import useAppStatusStore from '../../state/appStatusStore';
import { usePresentedCommittedContent } from '../../presentation/PresentationRuntime';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import ProjectFolderDialog from '../workspace-open-dialog/ProjectFolderDialog';
import { projectionItems, assistantDraftItems } from './conversationItems';
import { useConversationViewport } from './useConversationViewport';
import { useConversationUpdates, useProfilesUpdated } from './useConversationUpdates';
import { DismissibleError } from './DismissibleError';
import { useAgentComposer } from './useAgentComposer';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { useDisplayedConversation } from './ConversationDisplayProvider';
import { ConversationComposer } from './ConversationComposer';
import { blockingShells } from './shellProgress';
import { ComposerDecisionPanels } from './ComposerDecisionPanels';
import { isAutomaticApproval, isAutomaticPlanReview } from './composerDecisions';
import { ConversationBodies } from './ConversationBodies';
import { ConversationTranscript } from './ConversationTranscript';
import { ConversationLayoutCache } from './conversationVirtualizer';
import { ReaderControls, ResourcePreview, useResourcePreview } from './ResourcePreview';
import { ArtifactLinks, ArtifactShortcuts } from './ArtifactLinks';
import './localAgentPanel.css';
import { AgentNavigationScope, requestAgentOverview } from './agentNavigation';
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
  const projection = useLocalAgentStore((state) => state.projection);
  const current = projection;
  const content = projection;
  const rememberAnchor = useLocalAgentStore(state => state.rememberReadingAnchor);
  const loading = useLocalAgentStore((state) => state.loading);
  const runtimeReady = useLocalAgentStore((state) => state.runtimeReady);
  const loadingPurpose = useLocalAgentStore((state) => state.loadingPurpose);
  const refresh = useLocalAgentStore((state) => state.refresh);
  const hostReady = useAppStatusStore((state) => state.apiStatus === 'connected');
  const refreshProfiles = useLocalAgentStore((state) => state.refreshProfiles);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  const conversationLayouts = useRef(new ConversationLayoutCache());
  useEffect(() => setUiActionError(null), [sessionId]);
  const presentation = usePresentedCommittedContent(projection, language);
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || projection?.display.creationTitle.trim()
    || t(language, 'agent.session.newTitle');
  const conversationItems = projectionItems(content);
  const foregroundShells = useMemo(() => current && content && current.sessionId === sessionId ? blockingShells({run: current.run, activities: content.activities}) : [], [sessionId, current, content]);
  const assistantDraft = current?.assistantDraft ?? null;
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
  const timelineExtentKey = useMemo(() => content?.timeline.map((item) => (
    item.kind === 'toolGroup' ? `${item.timelineId}:${item.activityIds.length}` : item.timelineId
  )).join('|') ?? '', [content?.timeline]);
  const hasConversationContent = conversationItems.length > 0
    || Boolean(assistantDraft)
    || Boolean(projection?.pendingInteraction)
    || Boolean(projection?.pendingApproval)
    || Boolean(projection?.pendingPlan)
    || Boolean(projection?.terminalError);
  useProfilesUpdated(refreshProfiles);
  const updates = useConversationUpdates(refresh, hostReady);
  const viewport = useConversationViewport({
    sessionId,
    loading,
    projection: content,
    createdAt: activeSummary?.createdAt, rememberAnchor, presentationLayoutKey: presentation.layoutKey,
    assistantDraftLayoutKey,
    timelineExtentKey,
  });
  const { bodyRef, showJumpToLatest, scrollToLatest } = viewport;
  const composer = useAgentComposer(language, viewport.setLatestFollowMode);
  const hasQuestionDraft = current?.interactions.some(question => question.status === 'pending');
  const hasUnappliedInput = current?.queuedInputs.some(input => input.status === 'notApplied');
  const automaticApproval = isAutomaticApproval(current?.pendingApproval ?? null, current?.run) ? current!.pendingApproval : null;
  const automaticPlan = isAutomaticPlanReview(current?.pendingPlan ?? null, current?.effectivePermissions) ? current!.pendingPlan : null;
  const automaticReview = automaticApproval || automaticPlan ? <ComposerDecisionPanels language={language} composer={{
    ...composer, pendingApproval: automaticApproval, pendingPlan: automaticPlan, pendingInteraction: null, pendingScopeAddition: null,
  }} /> : null;
  const resourcePreview = useResourcePreview(sessionId, readerNavigation, sessionId ? undefined : composer.conversationKey);
  const readerAvailable = !!sessionId || resourcePreview.tabs.length > 0;
  const activeReader = resourcePreview.tabs.find(tab => tab.id === resourcePreview.activeId)?.target;
  const activeAgent = resourcePreview.visible && activeReader?.kind === 'agent' ? activeReader : null;
  const [readerHeader, setReaderHeader] = useState<HTMLDivElement | null>(null);
  const [conversationBounds, setConversationBounds] = useState<HTMLDivElement | null>(null);
  const [readerTreeWidth, setReaderTreeWidth] = useState(0);
  const readerLayout = { '--reader-width-percent': resourcePreview.width, '--reader-tree-width': `${readerTreeWidth}px` } as React.CSSProperties;
  useLayoutEffect(() => {
    onReaderLayoutChange?.({ visible: resourcePreview.visible, expanded: resourcePreview.expanded, conversationBounds });
  }, [onReaderLayoutChange, resourcePreview.visible, resourcePreview.expanded, conversationBounds]);

  const header = (
      <header key={`header:${sessionId}`} className={`local-agent__header${resourcePreview.visible ? ' local-agent__header--reading' : ''}${resourcePreview.expanded ? ' local-agent__header--expanded' : ''}`} style={readerLayout}>
        <UiRegion slot="conversation.header" data={{
          kind: 'conversationHeader', sessionId, title,
          project: activeProject ? { id: activeProject.id, title: activeProject.title } : null,
          reader: { visible: resourcePreview.visible, expanded: resourcePreview.expanded,
            treeVisible: resourcePreview.treeVisible, canOpen: readerAvailable },
        }} debugActions={{
          toggleReader: { unavailableReason: readerAvailable ? null : 'reader_session_required' },
          toggleReaderExpanded: { unavailableReason: resourcePreview.visible ? null : 'reader_not_visible' },
          toggleTree: { unavailableReason: null },
        }} actions={{
          toggleReader: () => { if (readerAvailable) resourcePreview.toggle(); },
          toggleReaderExpanded: () => { if (resourcePreview.visible) resourcePreview.expand(); },
          toggleTree: resourcePreview.toggleTree,
        }} regions={{ heading: <div className="local-agent__header-conversation">
        <div className="local-agent__heading">
          <span className="local-agent__heading-mark"><AchbitShellIcon name="session" /></span>
          <div>
            <strong>{title}</strong>
            {!headerTarget && activeProject && <span>{activeProject.title}</span>}
          </div>
        </div>
        </div>, reader: <div className="local-agent__header-preview">
          {resourcePreview.visible && <div className="reader-header-tabs" ref={setReaderHeader} />}
          <div className="local-agent__header-actions">
          <ReaderControls sessionId={sessionId} language={language} preview={resourcePreview} disabled={!readerAvailable} />
          </div>
        </div> }} />
      </header>
  );

  return (
    <AgentNavigationScope sessionId={sessionId} activeAgent={activeAgent} onCloseAgent={() => { if (activeAgent) requestAgentOverview(activeAgent.parentSessionId); }} tasks={current?.agentTasks} pendingDecisions={current?.pendingAgentDecisions}><section className={`local-agent local-agent--${mode}${headerTarget ? ' local-agent--external-header' : ''}${hasConversationContent || (sessionId && (loading || !projection)) ? '' : ' local-agent--empty'}${resourcePreview.visible ? ' local-agent--reading' : ''}${resourcePreview.expanded ? ' local-agent--expanded' : ''}`} style={readerLayout}>
      {headerTarget ? createPortal(header, headerTarget) : header}
      <div className="local-agent__viewport">
      <ConversationBodies sessionId={sessionId} createdAt={activeSummary?.createdAt} projection={projection} viewport={viewport}>
        <ConversationTranscript
          layoutCache={conversationLayouts.current}
          displaySettledRunIds={display.displaySettledRunIds}
          onDisplayed={display.onDisplayed}
          showReasoning={showReasoning}
          language={language}
          loading={loading && loadingPurpose === 'session'}
          projection={projection}
          activeProject={activeProject}
          hasConversationContent={hasConversationContent}
          conversationItems={conversationItems}
          draftItems={draftItems}
          presentation={presentation}
          viewport={viewport.reading}
          openWorkspaceResource={resourcePreview.openWorkspaceResource}
          openAttachment={resourcePreview.openAttachment}
          setUiActionError={setUiActionError}
          canEditMessage={composer.canEditMessage}
          onEditMessage={composer.beginMessageEdit}
          unappliedRecovery={hasUnappliedInput ? composer.unappliedRecovery : undefined}
          automaticReview={automaticReview}
          foregroundShells={foregroundShells}
          foregroundInteractionId={composer.foregroundInteractionId}
          onFocusInteraction={hasQuestionDraft ? composer.focusInteraction : undefined}
          readInteractionDraft={hasQuestionDraft ? composer.readInteractionDraft : undefined}
          onInteractionDraftChange={hasQuestionDraft ? composer.updateInteractionDraft : undefined}
        />
        {mode === 'panel' && !!display.artifacts.length && <ArtifactLinks location="conversation" artifacts={display.artifacts} onOpen={resourcePreview.openWorkspaceResource} />}
        {mode !== 'panel' && !!display.artifacts.length && <ArtifactShortcuts location="shortcuts"
          title={t(language, 'achbitGui.outputs.title')} artifacts={display.artifacts}
          onOpen={resourcePreview.openWorkspaceResource} />}
      </ConversationBodies>
      {showJumpToLatest && hasConversationContent && (
          <button
            type="button"
            className="local-agent__jump-latest"
            aria-label={t(language, 'agent.jumpLatest')}
            title={t(language, 'agent.jumpLatest')}
            onClick={scrollToLatest}
          >
            <AchbitShellIcon name="chevronDown" />
          </button>
        )}
      </div>

      {updates.error && <DismissibleError language={language} onDismiss={updates.dismiss}>{updates.error}
        <button type="button" onClick={updates.retry}>{t(language, 'achbitGui.statusAction.retry')}</button>
      </DismissibleError>}
      <ConversationComposer key={`composer:${sessionId}`}
        showChildDecisions={hostReady && current?.sessionId === sessionId}
        foregroundShells={foregroundShells}
        conversationBodyRef={bodyRef}
        readerExpanded={resourcePreview.visible}
        onEditBrowserReview={resourcePreview.editBrowserReview}
        onOpenAttachment={async (...args) => {
          try { setUiActionError(null); await resourcePreview.openAttachment(...args); }
          catch (reason) { setUiActionError(reason instanceof Error ? reason.message : String(reason)); }
        }}
        changeBar={showChangeBar && <FileChanges key={`${sessionId}:${projection.run!.runId}`} activities={roundChangeActivities(projection, projection.run!.runId)} compact />}
        language={language}
        composer={composer}
        uiActionError={uiActionError}
        onDismissUiActionError={() => setUiActionError(null)}
      />
      <ResourcePreview key={`reader:${sessionId}`} ready={runtimeReady} language={language} preview={resourcePreview} tabsTarget={readerHeader} onReview={composer.appendBrowserReview}
        onTreeWidthChange={setReaderTreeWidth}
        onAttach={async selections => {
          if (useLocalAgentStore.getState().sessionId !== sessionId) throw new Error('conversation_session_changed');
          await composer.selectMessageAttachments(selections);
        }} />
      {onReaderLayoutChange && <div ref={setConversationBounds} className="local-agent__conversation-overlay-bounds" aria-hidden="true" />}
      {composer.attachmentDialogOpen && (
        <ProjectFolderDialog key={`attachments:${sessionId}`}
          language={language}
          selectionMode="messageAttachment"
            onSelectMany={paths => void composer.selectMessageAttachments(paths)}
          onCancel={() => composer.setAttachmentDialogOpen(false)}
          onSelect={(absolutePath, type) => {
            void composer.selectMessageAttachments([{ path: absolutePath, kind: type }]);
          }}
        />
      )}
    </section></AgentNavigationScope>
  );
};

export default LocalAgentPanel;
