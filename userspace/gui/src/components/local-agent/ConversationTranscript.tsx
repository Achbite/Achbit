import { parseLocalTarget, bindLocalTarget, resolveLocalTargets, type ResolvedLocalTarget, type SourcePosition } from './resourceLinks';
import { ResourceLinkChoices } from './ResourceLinkChoices';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageFeedback, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost } from './ConversationHost';
import { workspaceResourceLink } from './documentResources';
import { requestReader } from './readerState';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { PresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ReasoningHistory } from './ReasoningDetails';
import { PlanPreviewCard } from './PlanPreviewCard';
import ProviderStageStatus from './ProviderStageStatus';
import { RunTiming } from './RunTiming';
import { SourceReferences } from './SourceReferences';
import { BufferedMarkdown, MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { ToolActivityGroup, ProviderHostedDraftGroup } from './ToolActivityDetails';
import { conversationRounds, type ProjectionItem, type AssistantDraftItem } from './conversationItems';
import type { ConversationViewport } from './useConversationViewport';
import { formatBytes } from './conversationFormatting';
import { ConversationNavigation } from './ConversationNavigation';
import { conversationNavigation } from './conversationWindow';
import { ConversationLayoutCache, ConversationVirtualizer } from './conversationVirtualizer';
import { ConversationVirtualRow, useConversationRowState } from './ConversationVirtualRow';
import { MessageActions } from './MessageActions';
import { RunFailureDetails, providerRetryAttempt, ProviderRetryStatus } from './RunFailureDetails';
import { InteractionCard } from './InteractionCard';
import { messageDisplayText } from './interactionPresentation';
import { isAutomaticApproval } from './composerDecisions';

interface ConversationTranscriptProps {
  layoutCache: ConversationLayoutCache;
  language: UiLanguage;
  loading: boolean;
  showReasoning?: boolean;
  automaticReview?: React.ReactNode;
  displaySettledRunIds: Set<string>;
  onDisplayed(identity: string, text: string): void;
  projection: SessionProjection | null;
  activeProject: { title: string } | undefined;
  hasConversationContent: boolean;
  conversationItems: ProjectionItem[];
  draftItems: AssistantDraftItem[];
  presentation: PresentedCommittedContent;
  viewport: ConversationViewport;
  openWorkspaceResource: (workspaceId: string, logicalPath: string, position?: SourcePosition) => Promise<void>;
  setUiActionError: React.Dispatch<React.SetStateAction<string | null>>;
  canEditMessage?: boolean;
  onEditMessage?: (message: SessionProjection['messages'][number]) => void;
}

export function ConversationTranscript({
  layoutCache,
  language,
  showReasoning = false,
  automaticReview,
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
  onEditMessage,
}: ConversationTranscriptProps) {
  const host = useConversationHost();
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
  const assistantDraft = projection?.assistantDraft ?? null;
  const submitting = useLocalAgentStore((state) => state.submitting);
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [pathMenu, setPathMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const linkRequest = useRef(0);
  const [linkChoices, setLinkChoices] = useState<{ sessionId: string; request: number; targets: ResolvedLocalTarget[] } | null>(null);
  const currentSessionRef = useRef({ sessionId: projection?.sessionId });
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (currentSessionRef.current.sessionId !== projection?.sessionId) currentSessionRef.current = { sessionId: projection?.sessionId };
  useLayoutEffect(() => {
    setCopiedMessageId(null);
    setPathMenu(null);
    setLinkChoices(null);
    linkRequest.current += 1;
    return () => clearTimeout(copyTimerRef.current);
  }, [projection?.sessionId]);
  useEffect(() => {
    if (!pathMenu) return;
    const dismiss = () => setPathMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('click', dismiss); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', dismiss); };
  }, [pathMenu]);
  const committedProviderContent = (identity: string | undefined, content: string, committed: React.ReactNode): React.ReactNode => {
    if (!identity) throw new Error('conversation_timeline_stream_missing');
    // Custom presentation renderers retain their output; the builtin Markdown keeps its stream node.
    if (!React.isValidElement(committed) || committed.type !== MarkdownContent) return <CommittedPresentation identity={identity} text={content} onDisplayed={onDisplayed}>{committed}</CommittedPresentation>;
    return <BufferedMarkdown text={content} streamIdentity={identity} streaming={false} onDisplayed={onDisplayed} />;
  };

  const copyMessage = async (messageId: string, content: string) => {
    const requestedView = currentSessionRef.current;
    try {
      await host.copyText(content);
      if (currentSessionRef.current !== requestedView) return;
      setCopiedMessageId(messageId);
      setUiActionError(null);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) => current === messageId ? null : current);
      }, 1_500);
    } catch (copyError) {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const updateMessageFeedback = async (
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
  };

  const openTranscriptLink = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[href]')
      : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('artifact://')) {
      event.preventDefault();
      const artifact = projection?.artifacts.find(item => item.artifactId === href.slice('artifact://'.length));
      if (!artifact) { setUiActionError(t(language, 'reader.artifactMissing')); return; }
      if (artifact.contentMode === 'fixed') requestReader(artifact.sessionId, { kind: 'artifact', artifact });
      else if (artifact.uri && /^https?:\/\//i.test(artifact.uri)) {
        void host.openExternalLink(artifact.uri).catch(reason => setUiActionError(String(reason)));
      } else if (artifact.workspaceId && artifact.logicalPath) {
        void openWorkspaceResource(artifact.workspaceId, artifact.logicalPath).catch(reason => setUiActionError(String(reason)));
      }
      return;
    }
    const resource = workspaceResourceLink(href);
    if (resource) {
      event.preventDefault();
      void openWorkspaceResource(resource.workspaceId, resource.logicalPath).catch(reason=>setUiActionError(String(reason)));
      return;
    }
    const localTarget=parseLocalTarget(href);
    if(localTarget&&projection) {
      event.preventDefault();
      const requestedView = currentSessionRef.current;
      const request = ++linkRequest.current;
      const current = () => currentSessionRef.current === requestedView && linkRequest.current === request;
      setLinkChoices(null);
      void (async () => {
        const ids = [...new Set([...projection.workspaceBindings.map(binding => binding.workspaceId),
          ...projection.messages.flatMap(message => message.filesystemReferences.map(reference => reference.workspaceId))])];
        const roots = await Promise.all(ids.map(async workspaceId => ({ workspaceId,
          root: (await host.resolveResource(projection.sessionId, workspaceId, '.')).path })));
        if (!current()) return;
        if (localTarget.absolute && !bindLocalTarget(localTarget, roots)) {
          if (!host.locatePath) throw new Error('Manual file location requires the desktop Host.');
          await host.locatePath(localTarget.path);
        } else {
          const targets = await resolveLocalTargets(localTarget, roots,
            (workspaceId, path) => host.resolveResource(projection.sessionId, workspaceId, path));
          if (!current()) return;
          if (targets.length > 1) setLinkChoices({ sessionId: projection.sessionId, request, targets });
          else await openWorkspaceResource(targets[0].workspaceId, targets[0].logicalPath, targets[0]);
        }
        if (current()) setUiActionError(null);
      })().catch(reason => {
        if (current()) setUiActionError(`${t(language, 'agent.link.unableToOpen')}\n${localTarget.path}\n${reason instanceof Error ? reason.message : String(reason)}`);
      });
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    const requestedView = currentSessionRef.current;
    void host.openExternalLink(href).then(() => {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(null);
    }).catch((error: unknown) => {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const renderItem = (item: ProjectionItem): React.ReactNode => item.type === 'message' ? (
        <article
          className={`local-agent__message local-agent__message--${item.value.role}`}
        >
          <div className="local-agent__message-content">
            {(item.value.content.trim() || item.value.replyToInteraction) && (
              <div className="local-agent__message-text">
                {item.value.replyToInteraction && <InteractionReplyQuote prompt={item.value.replyToInteraction.prompt} language={language} />}
                {item.value.role === 'assistant'
                  ? committedProviderContent(
                      item.streamId,
                      item.value.displayContent ?? item.value.content,
                      presentation.content(`message:${item.value.messageId}:content`),
                    )
                  : item.value.replyToInteraction ? <MarkdownContent>{messageDisplayText(item.value, projection?.interactions ?? [])}</MarkdownContent>
                  : presentation.content(`message:${item.value.messageId}:content`)}
              </div>
            )}
            <SourceReferences references={item.value.sourceReferences} language={language} />
            {item.value.filesystemReferences.length > 0 && (
              <div className="local-agent__message-attachments">
                {item.value.filesystemReferences.map((reference) => (
                  <button type="button"
                    onClick={() => { void openWorkspaceResource(reference.workspaceId, reference.logicalPath).catch(reason => setUiActionError(String(reason))); }}
                    className={reference.kind === 'directory'
                      ? 'local-agent__message-directory'
                      : undefined}
                    key={reference.referenceId}
                  >
                    <DeepCodeShellIcon name={reference.kind === 'directory'
                      ? 'folder'
                      : 'artifact'} />
                    {reference.displayName}
                    {reference.kind === 'file' && (
                      <small>{reference.source === 'pastedText' ? 'TXT · ' : ''}{formatBytes(reference.byteLength, language)}</small>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {(item.value.role === 'assistant' || item.value.role === 'user') && (
            <MessageActions message={item.value} language={language} copied={copiedMessageId === item.value.messageId}
              busy={submitting} canEdit={canEditMessage} onCopy={() => void copyMessage(item.value.messageId, messageDisplayText(item.value, projection?.interactions ?? []))}
              onFeedback={(feedback) => void updateMessageFeedback(item.value.messageId, feedback)}
              onEdit={() => onEditMessage?.(item.value)} />
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
          previousPlan={projection?.plans.find((plan) => plan.planId === item.value.planId && plan.revision === item.value.revision - 1)}
          workspaceBindings={projection?.workspaceBindings}
          active={samePlanReference(projection?.activePlanRef, item.value)}
          language={language}
          onToggle={onPlanToggle}
        />
      ) : item.type === 'interaction' ? (
        <InteractionCard interaction={item.value} language={language} />
      ) : (
        <ToolActivityGroup
          activities={item.values}
          artifacts={projection?.artifacts}
          pendingApproval={projection?.pendingApproval}
          reviewingApproval={isAutomaticApproval(projection?.pendingApproval ?? null, projection?.run)}
          key={item.groupId}
          language={language}
          onExpand={node => node ? viewport.anchorDisclosure(node) : setLatestFollowMode(false)}
          onOpenWorkspaceResource={openWorkspaceResource}
        />
      );
  const renderDraft = (item: AssistantDraftItem): React.ReactNode => item.type === 'text' ? (
        <article
          className={item.block.kind === 'narrative'
            ? 'local-agent__narrative local-agent__narrative--draft'
            : 'local-agent__message local-agent__message--assistant local-agent__message--draft'}
        >
          <div className={item.block.kind === 'narrative'
            ? undefined
            : 'local-agent__message-content'}
          >
            <BufferedMarkdown
              text={item.block.displayContent ?? item.block.content}
              streamIdentity={item.block.streamId}
            />
          </div>
        </article>
      ) : item.type === 'planPreview' ? <PlanPreviewCard preview={item.value} key={item.key} language={language} onToggle={onPlanToggle} /> : (
        <ProviderHostedDraftGroup
          blocks={item.blocks}
          key={item.groupId}
          language={language}
          onExpand={node => node ? viewport.anchorDisclosure(node) : setLatestFollowMode(false)}
        />
      );
  const currentActivity = assistantDraft?.runId === projection?.run?.runId ? assistantDraft?.activity : undefined;
  const providerStatus = <>
      {automaticReview}
      {projection && providerRetryAttempt(projection, currentActivity) !== null
        ? <ProviderRetryStatus projection={projection} language={language} activity={currentActivity} />
        : projection?.run && projection.run.status !== 'completed' && (
        <ProviderStageStatus run={projection.run} language={language}
          reasoning={showReasoning && assistantDraft ? { sessionId: projection.sessionId, requestId: assistantDraft.turnId } : undefined}
          key={`${projection.run.runId}:${assistantDraft?.turnId ?? 'idle'}`}
          activity={assistantDraft?.runId === projection.run.runId ? assistantDraft.activity : undefined}
          toolPending={projection.activities.some((activity) => activity.runId === projection.run?.runId
            && activity.kind === 'tool' && ['requested', 'active', 'waiting'].includes(activity.status))} />
      )}
</>;
  const rounds = useMemo(() => conversationRounds(conversationItems, draftItems, projection?.run?.runId), [conversationItems, draftItems, projection?.run?.runId]);
  const sessionKey = projection?.sessionId ?? '';
  const virtualizer = useMemo(() => new ConversationVirtualizer(layoutCache.session(sessionKey), viewport.preserveReadingPosition), [layoutCache, sessionKey, viewport.preserveReadingPosition]);
  const navigation = useMemo(() => conversationNavigation(rounds, projection?.interactions), [rounds, projection?.interactions]);
  const eagerRows = useMemo(() => new Set(rounds.flatMap((round) => round.rows).slice(-12).map((row) => row.key)), [rounds]);
  // The scroll body belongs to a parent host node; its ref is attached after
  // child layout effects on a fresh mount (including cached session switches).
  useEffect(() => {
    if (viewport.bodyRef.current) virtualizer.connect(viewport.bodyRef.current);
    return () => virtualizer.disconnect();
  }, [virtualizer, viewport.bodyRef]);

  return (
    <>
    {linkChoices && linkChoices.sessionId === projection?.sessionId && <ResourceLinkChoices
      language={language} targets={linkChoices.targets} onClose={() => setLinkChoices(null)}
      onSelect={target => {
        const selection = linkChoices;
        const requestedView = currentSessionRef.current;
        setLinkChoices(null);
        if (selection.request !== linkRequest.current) return;
        void openWorkspaceResource(target.workspaceId, target.logicalPath, target).catch(reason => {
          if (currentSessionRef.current === requestedView && linkRequest.current === selection.request)
            setUiActionError(`${t(language, 'agent.link.unableToOpen')}\n${target.path}\n${reason instanceof Error ? reason.message : String(reason)}`);
        });
      }} />}
    <ConversationNavigation key={sessionKey} entries={navigation} viewport={viewport} language={language}
      onNavigate={(entry) => viewport.scrollToAnchor(entry.key)} />
    <div
      ref={transcriptRef}
      className="local-agent__transcript"
      onClick={openTranscriptLink}
      onAuxClick={openTranscriptLink}
      onContextMenu={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
        const target = anchor && parseLocalTarget(anchor.getAttribute('href') ?? '');
        if (!target) return;
        event.preventDefault();
        setPathMenu({ path: target.path, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 50)) });
      }}
    >
      {pathMenu && <div className="local-agent__path-menu" role="menu" style={{ left: pathMenu.x, top: pathMenu.y }}>
        <button type="button" role="menuitem" autoFocus onClick={() => {
          const requestedView = currentSessionRef.current;
          void host.copyText(pathMenu.path).catch((reason) => { if (currentSessionRef.current === requestedView) setUiActionError(String(reason)); });
        }}>{language === 'zh-CN' ? '复制路径' : 'Copy path'}</button>
      </div>}
      {loading && !projection && (
        <div className="local-agent__empty">{t(language, 'agent.chat.opening')}</div>
      )}
      {!hasConversationContent && !loading && (
        <div className="local-agent__empty local-agent__empty--welcome">
          <strong>
            {activeProject
              ? t(language, 'agent.chat.welcomeProject', { project: activeProject.title })
              : t(language, 'agent.chat.welcomeDefault')}
          </strong>
        </div>
      )}
      {rounds.map((round) => {
        const current = projection?.run?.runId === round.runId;
        const displaySettled = displaySettledRunIds.has(round.runId);
        const terminal = current && ['failed', 'cancelled', 'indeterminate'].includes(projection!.run!.status);
        const timing = projection?.runTimings?.find(timing => timing.runId === round.runId);
        const rows = round.rows.map((row) => ({
          key: row.key,
          process: row.item ? row.item.type !== 'message' : row.draft?.type !== 'text' || row.draft.block.kind === 'narrative',
          required: row.item?.type === 'plan' && samePlanReference(projection?.pendingPlan, row.item.value)
            || row.item?.type === 'interaction' && row.item.value.status === 'pending',
          live: Boolean(row.draft) || (current && !displaySettled && row.item?.type === 'message' && row.item.value.role === 'assistant'),
          content: () => row.item ? renderItem(row.item) : renderDraft(row.draft!),
        }));
        if (current && !displaySettled) rows.push({ key: `${round.key}:provider-status`, process: true, required: false, live: true, content: () => providerStatus });
        if (showReasoning && projection && displaySettled) rows.push({ key: `${round.key}:reasoning-history`, process: true, required: false, live: false, content: () => <ReasoningHistory sessionId={projection.sessionId} runId={round.runId} /> });
        const changeActivities = displaySettled || terminal ? roundChangeActivities(projection, round.runId) : [];
        const hasFileChanges = changeActivities.some(activity => activity.tool?.fileChanges?.length);
        return <ConversationRoundView language={language} key={`${projection?.sessionId}:${round.key}`} roundKey={round.key} virtualizer={virtualizer} eagerRows={eagerRows}
          displaySettled={displaySettled} timing={timing} onToggleProcess={viewport.anchorDisclosure} rows={rows}>
          {hasFileChanges ? <FileChanges activities={changeActivities} /> : null}
        </ConversationRoundView>;
      })}
      {projection && <RunFailureDetails projection={projection} language={language} onError={setUiActionError} />}
      <div ref={messageEndRef} />
    </div>
    </>
  );
}

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}

function ConversationRoundView({ language, roundKey, virtualizer, eagerRows, displaySettled, timing, onToggleProcess, rows, children }: {
  language: UiLanguage; roundKey: string; virtualizer: ConversationVirtualizer; eagerRows: Set<string>;
  displaySettled: boolean; onToggleProcess(node: HTMLElement): void;
  timing: NonNullable<SessionProjection['runTimings']>[number] | undefined;
  rows: Array<{ key: string; process: boolean; required: boolean; live: boolean; content(): React.ReactNode }>;
  children: React.ReactNode;
}) {
  const state = virtualizer.layout(`${roundKey}:disclosure`).state;
  const [disclosure, updateDisclosure] = useState(() => (state.get('process') as { displaySettled: boolean; open: boolean } | undefined) ?? { displaySettled, open: false });
  const setDisclosure = (value: typeof disclosure) => { state.set('process', value); updateDisclosure(value); };
  // Wait for the existing display acknowledgement; never collapse while final text is still arriving.
  if (disclosure.displaySettled !== displaySettled) setDisclosure({ displaySettled, open: false });
  const expanded = !displaySettled || disclosure.open;
  const firstProcess = rows.find(row => row.process)?.key;
  return <section className="conversation-round">
    {rows.map(row => <React.Fragment key={row.key}>
      {displaySettled && row.key === firstProcess && <div className="conversation-process-heading"><button className="conversation-process-toggle" type="button"
        data-conversation-anchor={`${roundKey}:disclosure`} aria-expanded={expanded} onClick={(event) => {
        onToggleProcess(event.currentTarget);
        setDisclosure({ displaySettled, open: !expanded });
      }}>
        <DeepCodeShellIcon name="tool" /><span>{t(language, expanded ? 'agent.process.expanded' : 'agent.process.open')}</span>
        <DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
      </button><RunTiming timing={timing} language={language} /></div>}
      <ConversationVirtualRow rowKey={row.key} virtualizer={virtualizer} hidden={row.process && !expanded && !row.required}
        eager={eagerRows.has(row.key)} live={row.live || row.required}>{row.content}</ConversationVirtualRow>
    </React.Fragment>)}
    {children && <ConversationVirtualRow rowKey={`${roundKey}:file-changes`} virtualizer={virtualizer}>
      {() => children}
    </ConversationVirtualRow>}
  </section>;
}

function CommittedPresentation({ identity, text, onDisplayed, children }: { identity: string; text: string; onDisplayed(identity: string, text: string): void; children: React.ReactNode }) {
  useLayoutEffect(() => onDisplayed(identity, text), [identity, text, onDisplayed]);
  return <>{children}</>;
}

export function InteractionReplyQuote({ prompt, language }: { prompt: string; language: UiLanguage }) {
  const [expanded, setExpanded] = useConversationRowState('interaction-reply:expanded', false);
  const toggleLabel = language === 'zh-CN'
    ? (expanded ? '收起问题' : '展开问题')
    : (expanded ? 'Collapse question' : 'Expand question');
  return <div className="conversation-answered-question">
    <button type="button" className="conversation-answered-question-toggle" aria-expanded={expanded}
      aria-label={toggleLabel} title={toggleLabel} onClick={() => setExpanded((value) => !value)}>
      {!expanded && <span><MarkdownInline>{prompt.split(/\n\s*\n/)[0]!}</MarkdownInline></span>}
      <DeepCodeShellIcon name="chevronDown" />
    </button>
    {expanded && <div className="conversation-answered-question-body"><MarkdownContent>{prompt}</MarkdownContent></div>}
  </div>;
}
