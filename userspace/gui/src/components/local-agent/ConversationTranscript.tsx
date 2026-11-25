import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { parseLocalTarget, type SourcePosition } from './resourceLinks';
import { ConversationBodyLinkScope, useConversationBodyLinks } from './useConversationBodyLinks';
import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageFeedback, SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost } from './ConversationHost';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { PresentedCommittedContent } from '../../presentation/PresentationRuntime';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { useDismissibleLayer } from '../shared/useDismissibleLayer';
import { focusOpenedPanel, useInteractionFocus } from '../shared/interactionFocus';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ReasoningHistory } from './ReasoningDetails';
import { PlanPreviewCard } from './PlanPreviewCard';
import ProviderStageStatus from './ProviderStageStatus';
import { RunTiming } from './RunTiming';
import { SourceReferences } from './SourceReferences';
import { BufferedMarkdown, MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { ToolActivityGroup } from './ToolActivityDetails';
import type { BlockingShell } from './shellProgress';
import { openingRows } from './openingRows';
import { conversationRounds, type ProjectionItem, type AssistantDraftItem, type ConversationRow, type ConversationRound } from './conversationItems';
import type { ConversationViewport } from './useConversationViewport';
import { ConversationNavigation } from './ConversationNavigation';
import { ReadingBodyActive } from './ConversationBodies';
import { useConversationSessionId } from './ConversationSessionScope';
import { conversationNavigation } from './conversationWindow';
import { ConversationLayoutCache, ConversationVirtualizer } from './conversationVirtualizer';
import { ConversationVirtualRow, useConversationRowState } from './ConversationVirtualRow';
import { MessageActions } from './MessageActions';
import { MessageAttachments } from './MessageAttachments';
import { RunFailureDetails, StoppedRunStatus, providerRetryAttempt, ProviderRetryStatus } from './RunFailureDetails';
import { UiEventStack } from './UiEventStack';
import { InteractionCard } from './InteractionCard';
import { UnappliedInputs, type UnappliedRecovery } from './UnappliedInputs';
import { messageDisplayText } from './interactionPresentation';
import { isAutomaticApproval } from './composerDecisions';
import { PreviewArtifactsScope } from './InteractivePreview';
import { RichContentScope } from './RichContentIdentity';

// Session switching preserves message objects. Bind their operations once per visible state.
const TranscriptMessageActions = React.memo(function TranscriptMessageActions({ message, onCopy, onFeedback, onEdit, ...state }:
  Omit<React.ComponentProps<typeof MessageActions>, 'onCopy' | 'onFeedback' | 'onEdit'> & {
    onCopy(message: SessionProjection['messages'][number]): void;
    onFeedback(messageId: string, feedback: MessageFeedback | null): void;
    onEdit(message: SessionProjection['messages'][number]): void;
  }) {
  return <MessageActions {...state} message={message} onCopy={() => onCopy(message)}
    onFeedback={feedback => onFeedback(message.messageId, feedback)} onEdit={() => onEdit(message)} />;
});

interface ConversationTranscriptProps {
  layoutCache: ConversationLayoutCache;
  language: UiLanguage;
  loading: boolean;
  showReasoning?: boolean;
  automaticReview?: React.ReactNode;
  foregroundShells?: readonly BlockingShell[];
  foregroundInteractionId?: string | null;
  onFocusInteraction?: () => void;
  readInteractionDraft?: (interactionId: string) => string;
  onInteractionDraftChange?: (interactionId: string, text: string) => void;
  displaySettledRunIds: Set<string>;
  onDisplayed(identity: string, text: string): void;
  projection: SessionProjection | null;
  activeProject: { title: string } | undefined;
  hasConversationContent: boolean;
  conversationItems: ProjectionItem[];
  draftItems: AssistantDraftItem[];
  presentation: PresentedCommittedContent;
  viewport: ConversationViewport['reading'];
  openWorkspaceResource: (workspaceId: string, logicalPath: string, position?: SourcePosition) => Promise<void>;
  setUiActionError: React.Dispatch<React.SetStateAction<string | null>>;
  unappliedRecovery?: UnappliedRecovery;
  canEditMessage?: boolean;
  onEditMessage?: (message: SessionProjection['messages'][number], restored?: SessionProjection) => void;
}

export const ConversationTranscript = React.memo(function ConversationTranscript({
  layoutCache,
  language,
  showReasoning = false,
  automaticReview,
  foregroundShells = [],
  foregroundInteractionId,
  onFocusInteraction,
  readInteractionDraft,
  onInteractionDraftChange,
  displaySettledRunIds,
  onDisplayed,
  loading,
  projection,
  activeProject,
  hasConversationContent,
  conversationItems,
  draftItems,
  presentation,
  viewport,
  openWorkspaceResource,
  setUiActionError,
  canEditMessage = false,
  unappliedRecovery,
  onEditMessage,
}: ConversationTranscriptProps) {
  const active = useContext(ReadingBodyActive);
  const host = useConversationHost();
  const content = projection;
  const runView = projection;
  const sessionKey = projection?.sessionId ?? '';
  const interaction = useInteractionFocus();
  const referencesIdentity = useUiOwner('conversation.references', undefined, { sessionId: sessionKey });
  const { transcriptRef, messageEndRef, setLatestFollowMode } = viewport;
  const onPlanToggle = (card: HTMLElement, expanded: boolean) => {
    const body = viewport.bodyRef.current;
    if (body && !expanded) {
      // Bring the summary back into view before removing the long document.
      const cardTop = body.scrollTop + card.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTop = Math.min(body.scrollTop, Math.max(0, cardTop));
    }
    setLatestFollowMode(false);
  };
  const selectedSession = useConversationSessionId();
  const assistantDraft = runView?.assistantDraft ?? null;
  const submitting = useLocalAgentStore(state => state.sessionId === sessionKey && state.submitting);
  const welcomeIndex = useLocalAgentStore((state) => state.welcomeIndex);
  const welcomeSuffix = welcomeIndex === 0 ? '' : `.${welcomeIndex}`;
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const [copyFeedback, setCopyFeedback] = useState<{ messageId: string } | null>(null);
  const copiedMessageId = copyFeedback?.messageId ?? null;
  useAutoDismiss(copyFeedback, () => setCopyFeedback(null), 1500);
  const [pathMenu, setPathMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const pathMenuRef = useRef<HTMLDivElement>(null);
  const pathTriggerRef = useRef<HTMLAnchorElement>(null);
  const bodyLinks = useConversationBodyLinks(active ? projection : null, language, setUiActionError, true);
  const activeId = active ? sessionKey : null;
  const currentSessionRef = useRef({ sessionId: activeId });
  if (currentSessionRef.current.sessionId !== activeId) currentSessionRef.current = { sessionId: activeId };
  useLayoutEffect(() => {
    setCopyFeedback(null);
    setPathMenu(null);
  }, [activeId]);
  useEffect(() => {
    if (!pathMenu) return;
    const menu = pathMenuRef.current;
    if (menu) focusOpenedPanel(menu, menu.querySelector<HTMLButtonElement>('[role="menuitem"]'), interaction);
    const dismiss = () => setPathMenu(null);
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [pathMenu, interaction]);
  useDismissibleLayer({ open: !!pathMenu, roots: [pathMenuRef], trigger: pathTriggerRef, onDismiss: () => setPathMenu(null) });
  const committedProviderContent = (identity: string | undefined, content: string, committed: React.ReactNode): React.ReactNode => {
    if (!identity) throw new Error('conversation_timeline_stream_missing');
    // Custom presentation renderers retain their output; the builtin Markdown keeps its stream node.
    if (!React.isValidElement(committed) || committed.type !== MarkdownContent) return <CommittedPresentation identity={identity} text={content} onDisplayed={onDisplayed}>{committed}</CommittedPresentation>;
    return <BufferedMarkdown text={content} streamIdentity={identity} streaming={false} onDisplayed={onDisplayed} />;
  };

  const copyMessage = useCallback(async (messageId: string, content: string) => {
    const requestedView = currentSessionRef.current;
    try {
      await host.copyText(content);
      if (currentSessionRef.current !== requestedView) return;
      setCopyFeedback({ messageId });
      setUiActionError(null);
    } catch (copyError) {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }, [host, setUiActionError]);

  const copyVisibleMessage = useCallback((message: SessionProjection['messages'][number]) => {
    void copyMessage(message.messageId, messageDisplayText(message, content?.interactions ?? []));
  }, [copyMessage, content?.interactions]);

  const editAction = useRef(onEditMessage);
  useLayoutEffect(() => { editAction.current = onEditMessage; }, [onEditMessage]);
  const editMessage = useCallback((message: SessionProjection['messages'][number]) => editAction.current?.(message), []);

  const updateMessageFeedback = useCallback(async (
    messageId: string,
    feedback: MessageFeedback | null,
  ) => {
    const requestedView = currentSessionRef.current;
    try {
      await setMessageFeedback(messageId, feedback);
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(null);
    } catch (feedbackError) {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(feedbackError instanceof Error
        ? feedbackError.message
        : String(feedbackError));
    }
  }, [setMessageFeedback, setUiActionError]);

  const renderItem = (item: Exclude<ProjectionItem, { type: 'toolGroup' }>): React.ReactNode => item.type === 'message' ? (
        <article
          data-message-id={item.value.messageId}
          className={`local-agent__message local-agent__message--${item.value.role}`}
        >
          <div className="local-agent__message-content">
            {(item.value.content.trim() || item.value.replyToInteraction) && (
              <div className="local-agent__message-text">
                {item.value.replyToInteraction && <InteractionReplyQuote sessionId={sessionKey} interactionId={item.value.replyToInteraction.interactionId} prompt={item.value.replyToInteraction.prompt} language={language} />}
                {item.value.role === 'assistant'
                  ? committedProviderContent(
                      item.streamId,
                      item.value.displayContent ?? item.value.content,
                      presentation.content(`message:${item.value.messageId}:content`),
                    )
                  : item.value.replyToInteraction ? <MarkdownContent>{messageDisplayText(item.value, content?.interactions ?? [])}</MarkdownContent>
                  : presentation.content(`message:${item.value.messageId}:content`)}
              </div>
            )}
            <SourceReferences references={item.value.sourceReferences} language={language} />
            {item.value.filesystemReferences.length > 0 && (
              <MessageAttachments sessionId={sessionKey} references={item.value.filesystemReferences} language={language}
                identity={reference => referencesIdentity.action('open', 'click', { messageId: item.value.messageId, referenceId: reference.referenceId })}
                onOpen={openWorkspaceResource} onError={setUiActionError} />
            )}
          </div>
          {(item.value.role === 'assistant' || item.value.role === 'user') && (
            <TranscriptMessageActions message={item.value} language={language} copied={copiedMessageId === item.value.messageId}
              busy={submitting} canEdit={canEditMessage} onCopy={copyVisibleMessage}
              onFeedback={updateMessageFeedback} onEdit={editMessage} />
          )}
        </article>
      ) : item.type === 'narrative' ? (
        <article className="local-agent__narrative">
          <div>
            {committedProviderContent(
              item.streamId,
              item.value.displayContent ?? item.value.content,
              presentation.content(`narrative:${item.value.narrativeId}`),
            )}
            <SourceReferences references={item.value.sourceReferences} language={language} />
          </div>
        </article>
      ) : item.type === 'plan' ? (
        <PlanCard
          key={`plan:${item.value.planId}:${item.value.revision}`}
          plan={item.value}
          previousPlan={content?.plans.find((plan) => plan.planId === item.value.planId && plan.revision === item.value.revision - 1)}
          workspaceBindings={content?.workspaceBindings}
          active={samePlanReference(projection?.activePlanRef, item.value)}
          language={language}
          onToggle={onPlanToggle}
        />
      ) : (
        <InteractionCard interaction={item.value} language={language}
          answerInComposer={item.value.interactionId === foregroundInteractionId}
          onFocusComposer={onFocusInteraction} draft={readInteractionDraft?.(item.value.interactionId)}
          onDraftChange={onInteractionDraftChange} />
      );
  const renderDraft = (item: Exclude<AssistantDraftItem, { type: 'providerHostedGroup' }>): React.ReactNode => item.type === 'text' ? (
        <article
          className={item.block.kind === 'narrative'
            ? 'local-agent__narrative local-agent__narrative--draft'
            : 'local-agent__message local-agent__message--assistant local-agent__message--draft'}
        >
          <div className={item.block.kind === 'narrative'
            ? undefined
            : 'local-agent__message-content'}
          >
            {item.block.kind === 'narrative' ? <BufferedMarkdown
              text={item.block.displayContent ?? item.block.content} streamIdentity={item.block.streamId} />
              : <div className="local-agent__message-text"><BufferedMarkdown
                text={item.block.displayContent ?? item.block.content} streamIdentity={item.block.streamId} /></div>}
          </div>
        </article>
      ) : <PlanPreviewCard preview={item.value} key={item.key} language={language} onToggle={onPlanToggle} />;
  const renderRow = ({ item, draft }: ConversationRow) => {
    if (item?.type === 'toolGroup' || draft?.type === 'providerHostedGroup') {
      const group = item?.type === 'toolGroup' ? item : undefined;
      return <ToolActivityGroup activities={group?.values ?? []} foregroundShells={foregroundShells} hostedKeys={group?.hostedKeys} batchConflicts={group?.batchConflicts}
        hostedDraft={draft?.type === 'providerHostedGroup' ? draft : undefined} artifacts={content?.artifacts}
        pendingApproval={runView?.pendingApproval} reviewingApproval={isAutomaticApproval(runView?.pendingApproval ?? null, projection?.run)}
        language={language} onExpand={node => node ? viewport.anchorDisclosure(node) : setLatestFollowMode(false)}
        onOpenWorkspaceResource={openWorkspaceResource} />;
    }
    return item ? renderItem(item) : renderDraft(draft!);
  };
  const currentActivity = assistantDraft?.runId === runView?.run?.runId ? assistantDraft?.activity : undefined;
  const providerStatus = <>
      {automaticReview}
      {runView && providerRetryAttempt(runView, currentActivity) !== null
        ? <ProviderRetryStatus projection={runView} language={language} activity={currentActivity} />
        : runView?.run && runView.run.status !== 'completed'
          && !(foregroundShells.length && !currentActivity && runView.run.status === 'running') && (
        <ProviderStageStatus run={runView.run} language={language}
          reasoning={showReasoning && assistantDraft ? { sessionId: runView.sessionId, requestId: assistantDraft.turnId } : undefined}
          key={`${runView.run.runId}:${assistantDraft?.turnId ?? 'idle'}`}
          activity={assistantDraft?.runId === runView.run.runId ? assistantDraft.activity : undefined}
          toolPending={!!content?.activities.some((activity) => activity.runId === runView.run?.runId
            && activity.kind === 'tool' && ['requested', 'active', 'waiting'].includes(activity.status))} />
      )}
</>;
  const items = conversationItems;
  const rounds = useMemo(() => conversationRounds(items, draftItems, runView?.run?.runId), [items, draftItems, runView?.run?.runId]);
  const timingsByRun = useMemo(() => {
    const timings = new Map<string, NonNullable<SessionProjection['runTimings']>[number]>();
    for (const timing of content?.runTimings ?? []) {
      if (!timings.has(timing.runId)) timings.set(timing.runId, timing);
    }
    return timings;
  }, [content?.runTimings]);
  const preservePosition = useRef(viewport.preserveReadingPosition);
  useLayoutEffect(() => { preservePosition.current = viewport.preserveReadingPosition; }, [viewport.preserveReadingPosition]);
  const virtualizer = useMemo(() => new ConversationVirtualizer(layoutCache.session(sessionKey), () => preservePosition.current()), [layoutCache, sessionKey]);
  const navigation = useMemo(() => conversationNavigation(rounds, projection?.interactions), [rounds, projection?.interactions]);
  const latestUserRow = navigation.at(-1)?.key;
  useEffect(() => {
    const diagnostics = globalThis.window?.__ACHBIT_DEBUG_UI__;
    const body = viewport.bodyRef.current;
    if (!diagnostics?.observe || !active || !body || !latestUserRow) return;
    const row = viewport.anchors.read(body).byKey.get(latestUserRow);
    const article = row?.querySelector<HTMLElement>('article[data-message-id]');
    if (!row || !article) return;
    const view = body.getBoundingClientRect();
    const content = article.getBoundingClientRect();
    diagnostics.observe('conversation.transcript', 'reading.latest-user-dom', {
      sessionId: sessionKey, messageId: article.dataset.messageId, rowKey: latestUserRow, sequence: Number(row.dataset.transcriptSequence),
      inViewport: content.height > 0 && content.bottom > view.top && content.top < view.bottom,
      documentVisible: document.visibilityState === 'visible',
    });
  }, [active, latestUserRow, sessionKey, viewport.anchors, viewport.bodyRef]);
  const eagerRows = useMemo(() => openingRows(rounds, viewport.openingAnchor), [rounds, viewport.openingAnchor]);
  // The scroll body belongs to a parent host node; its ref is attached after
  // child layout effects on a fresh mount (including cached session switches).
  useEffect(() => {
    if (!active) return;
    if (viewport.bodyRef.current) virtualizer.connect(viewport.bodyRef.current);
    return () => virtualizer.disconnect();
  }, [active, virtualizer, viewport.bodyRef]);

  const renderRound = (round: ConversationRound, eager = eagerRows) => {
    const current = runView?.run?.runId === round.runId;
    const displaySettled = displaySettledRunIds.has(round.runId);
    const terminal = current && ['failed', 'cancelled', 'indeterminate'].includes(runView!.run!.status);
    const timing = timingsByRun.get(round.runId);
    const rows = round.rows.map((row) => ({
      key: row.key, sequence: row.item?.sequence,
      process: row.item ? row.item.type !== 'message' : row.draft?.type !== 'text' || row.draft.block.kind === 'narrative',
      required: row.item?.type === 'plan' && samePlanReference(runView?.pendingPlan, row.item.value)
        || row.item?.type === 'interaction' && row.item.value.status === 'pending',
      live: Boolean(row.draft) || (current && !displaySettled && row.item?.type === 'message' && row.item.value.role === 'assistant'),
      content: () => <RichContentScope.Provider value={row.item?.type === 'message' || row.item?.type === 'narrative' || row.draft?.type === 'text'
        ? { sessionId: sessionKey, rowKey: row.key, contentKey: 'body' } : null}>{renderRow(row)}</RichContentScope.Provider>,
    }));
    if (showReasoning && content) rows.push({ key: `${round.key}:reasoning-history`, sequence: undefined, process: true, required: false,
      live: current && !displaySettled, content: () => <ReasoningHistory sessionId={content.sessionId} runId={round.runId}
        activeTurnId={current ? assistantDraft?.turnId : undefined} throughTimelineId={current ? content.timeline.at(-1)?.timelineId : undefined} /> });
    if (current && !displaySettled) rows.push({ key: `${round.key}:provider-status`, sequence: undefined, process: true, required: false, live: true, content: () => providerStatus });
    const changeActivities = displaySettled || terminal
      ? roundChangeActivities(content, round.runId)
      : [];
    return <ConversationRoundView sessionId={sessionKey} language={language} key={`${sessionKey}:${round.key}`} roundKey={round.key} virtualizer={virtualizer} eagerRows={eager}
      displaySettled={displaySettled} timing={timing} onToggleProcess={viewport.anchorDisclosure} rows={rows}
      eagerFooter={(current && !viewport.openingAnchor && round === rounds.at(-1)) || eager.has(`${round.key}:file-changes`)}>
      {changeActivities.some(activity => activity.tool?.fileChanges?.length) ? <FileChanges activities={changeActivities} /> : null}
    </ConversationRoundView>;
  };

  return (
    <ConversationBodyLinkScope.Provider value={bodyLinks.open}><PreviewArtifactsScope.Provider value={projection}>
    {bodyLinks.selection}
    {active && <ConversationNavigation key={sessionKey} sessionId={sessionKey} entries={navigation} viewport={viewport} language={language}
      onNavigate={entry => viewport.scrollToAnchor(entry.key)} />}
    <div
      ref={active ? transcriptRef : undefined}
      className="local-agent__transcript"
      onClick={bodyLinks.open}
      onAuxClick={bodyLinks.open}
      onContextMenu={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
        const target = anchor && parseLocalTarget(anchor.getAttribute('href') ?? '');
        if (!target) return;
        event.preventDefault();
        pathTriggerRef.current = anchor;
        setPathMenu({ path: target.path, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 50)) });
      }}
    >
      {pathMenu && <div ref={pathMenuRef} className="local-agent__path-menu" role="menu" tabIndex={-1} style={{ left: pathMenu.x, top: pathMenu.y }}>
        <button type="button" role="menuitem" onClick={() => {
          const requestedView = currentSessionRef.current;
          void host.copyText(pathMenu.path).catch((reason) => { if (currentSessionRef.current === requestedView) setUiActionError(String(reason)); });
          setPathMenu(null);
        }}>{language === 'zh-CN' ? '复制路径' : 'Copy path'}</button>
      </div>}
      {loading && !content && <div role="status" className="local-agent__empty">{t(language, 'agent.chat.opening')}</div>}
      {!hasConversationContent && !loading && (!selectedSession || content) && (
        <div className="local-agent__empty local-agent__empty--welcome">
          <strong>
            {activeProject
              ? t(language, `agent.chat.welcomeProject${welcomeSuffix}`, { project: activeProject.title })
              : t(language, `agent.chat.welcomeDefault${welcomeSuffix}`)}
          </strong>
        </div>
      )}
      {rounds.map(round => renderRound(round))}
      {content && <UiEventStack sessionId={content.sessionId} language={language} />}
      {runView && <StoppedRunStatus projection={runView} language={language} onError={setUiActionError} />}
      {runView && <RunFailureDetails key={runView.run?.runId} projection={runView} language={language} onError={setUiActionError} />}
      {runView && <UnappliedInputs key={`unapplied:${runView.sessionId}`} sessionId={runView.sessionId} inputs={runView.queuedInputs} language={language} recovery={unappliedRecovery}
        copiedId={copiedMessageId} onCopy={(id, text) => void copyMessage(id, text)}
        onOpenReference={reference => { void openWorkspaceResource(reference.workspaceId, reference.logicalPath).catch(reason => setUiActionError(String(reason))); }} />}
      <div ref={active ? messageEndRef : undefined} />
    </div>
    </PreviewArtifactsScope.Provider></ConversationBodyLinkScope.Provider>
  );
});

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}

function ConversationRoundView({ sessionId, language, roundKey, virtualizer, eagerRows, eagerFooter, displaySettled, timing, onToggleProcess, rows, children }: {
  sessionId: string; language: UiLanguage; roundKey: string; virtualizer: ConversationVirtualizer; eagerRows: Set<string>;
  eagerFooter: boolean; displaySettled: boolean; onToggleProcess(node: HTMLElement): void;
  timing: NonNullable<SessionProjection['runTimings']>[number] | undefined;
  rows: Array<{ key: string; sequence?: number; process: boolean; required: boolean; live: boolean; content(): React.ReactNode }>;
  children: React.ReactNode;
}) {
  const identity = useUiOwner('conversation.round', undefined, { sessionId, roundKey });
  const [disclosure, updateDisclosure] = useState(() =>
    (virtualizer.layout(`${roundKey}:disclosure`).state.get('process') as { displaySettled: boolean; open: boolean } | undefined)
      ?? { displaySettled, open: false });
  const setDisclosure = (value: typeof disclosure) => {
    virtualizer.layout(`${roundKey}:disclosure`).state.set('process', value);
    updateDisclosure(value);
  };
  // Wait for the existing display acknowledgement; never collapse while final text is still arriving.
  if (disclosure.displaySettled !== displaySettled) setDisclosure({ displaySettled, open: false });
  const expanded = !displaySettled || disclosure.open;
  const firstProcess = rows.find(row => row.process)?.key;
  return <section className="conversation-round" data-transcript-sequence={rows.find(row => row.sequence)?.sequence}>
    {rows.map(row => <React.Fragment key={row.key}>
      {displaySettled && row.key === firstProcess && <div className="conversation-process-heading"><button {...identity.action('toggle-process', 'click')} className="conversation-process-toggle" type="button"
        data-conversation-anchor={`${roundKey}:disclosure`} data-transcript-sequence={row.sequence} aria-expanded={expanded} onClick={(event) => {
        onToggleProcess(event.currentTarget);
        setDisclosure({ displaySettled, open: !expanded });
      }}>
        <AchbitShellIcon name="tool" /><span>{t(language, expanded ? 'agent.process.expanded' : 'agent.process.open')}</span>
        <AchbitShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
      </button><RunTiming timing={timing} language={language} /></div>}
      <ConversationVirtualRow rowKey={row.key} sequence={row.sequence} virtualizer={virtualizer} virtualize={row.process && !row.required} hidden={row.process && !expanded && !row.required}
        eager={eagerRows.has(row.key)} live={row.live || row.required}>{row.content}</ConversationVirtualRow>
    </React.Fragment>)}
    {children && <ConversationVirtualRow rowKey={`${roundKey}:file-changes`} sequence={rows.findLast(row => row.sequence !== undefined)?.sequence} eager={eagerFooter} virtualizer={virtualizer} virtualize={false}>
      {() => children}
    </ConversationVirtualRow>}
  </section>;
}

function CommittedPresentation({ identity, text, onDisplayed, children }: { identity: string; text: string; onDisplayed(identity: string, text: string): void; children: React.ReactNode }) {
  useLayoutEffect(() => onDisplayed(identity, text), [identity, text, onDisplayed]);
  return <>{children}</>;
}

export function InteractionReplyQuote({ sessionId, interactionId, prompt, language }: {
  sessionId: string | undefined; interactionId: string; prompt: string; language: UiLanguage;
}) {
  const contentTarget = useContext(RichContentScope);
  const identity = useUiOwner('conversation.answered-question', undefined, { sessionId, interactionId });
  const [expanded, setExpanded] = useConversationRowState('interaction-reply:expanded', false);
  const toggleLabel = language === 'zh-CN'
    ? (expanded ? '收起问题' : '展开问题')
    : (expanded ? 'Collapse question' : 'Expand question');
  return <div className="conversation-answered-question">
    <button type="button" {...identity.action('toggle', 'click')} className="conversation-answered-question-toggle" aria-expanded={expanded}
      aria-label={toggleLabel} title={toggleLabel} onClick={() => setExpanded((value) => !value)}>
      {!expanded && <span><MarkdownInline>{prompt.split(/\n\s*\n/)[0]!}</MarkdownInline></span>}
      <AchbitShellIcon name="chevronDown" />
    </button>
    {expanded && <div className="conversation-answered-question-body"><RichContentScope.Provider value={contentTarget ? { ...contentTarget, contentKey: 'interaction-reply' } : null}><MarkdownContent>{prompt}</MarkdownContent></RichContentScope.Provider></div>}
  </div>;
}
