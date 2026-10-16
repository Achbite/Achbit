import { UiRegion } from '../../ui-plugins/UiRegion';
import type { BrowserAnnotationDraft } from './browserReview';
import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import SessionModelSelector from './SessionModelSelector';
import TotalCacheUsage from './TotalCacheUsage';
import { ComposerDecisionPanels, ComposerQuestionPrompt } from './ComposerDecisionPanels';
import { ComposerPermissionControl } from './ComposerPermissionControl';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { AgentComposer } from './useAgentComposer';
import { pastedTextTitle } from '../../services/pastedText';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { DismissibleError } from './DismissibleError';
import { HostRebind } from './HostRebind';

interface ConversationComposerProps {
  changeBar?: React.ReactNode;
  language: UiLanguage;
  composer: AgentComposer;
  uiActionError: string | null;
  onDismissUiActionError(): void;
  onEditBrowserReview(review: BrowserAnnotationDraft): void;
}

export function ConversationComposer({
  changeBar,
  language,
  composer,
  uiActionError,
  onDismissUiActionError,
  onEditBrowserReview,
}: ConversationComposerProps) {
  const connections = useLocalAgentStore(state => state.connections);
  const {
    pendingPlan,
    pendingInteraction,
    pendingApproval,
    projection,
    loading,
    submitting,
    catalogBusy,
    error,
    profiles,
    selectedProfileId,
    reasoningEffortOverride,
    modelSettingsBusy,
    cancelRun,
    selectModel,
    modelSelectionConfirmed,
    draft,
    setDraft,
    pendingFilesystemPaths,
    setPendingFilesystemPaths,
    pluginSelections,
    setPluginSelections,
    pluginPickerOpen,
    pluginActiveIndex,
    setPluginActiveIndex,
    attachmentError,
    attachmentMenuOpen,
    setAttachmentMenuOpen,
    setAttachmentDialogOpen,
    setPermissionMenuOpen,
    attachmentControlRef,
    pluginPickerRef,
    textareaRef,
    recordComposerElementState,
    beginComposition,
    endComposition,
    submitOnComposerEnter,
    filteredPlugins,
    pluginQuery,
    setPluginQuery,
    selectPlugin,
    commandSuggestions,
    commandActiveIndex,
    setCommandActiveIndex,
    selectCommand,
    updateDraft,
    openPluginPicker,
    insertFocusCommand,
    submitDraft,
    canSend,
    showStopAction,
  } = composer;
  const regionData = { kind: 'composer' as const, draft, canSend, canStop: showStopAction, attachments: pendingFilesystemPaths };
  const regionActions = {
    updateDraft: (text: string) => updateDraft(text, text.length),
    submitDraft,
    stopRun: async () => { if (showStopAction) await cancelRun(); },
    pickAttachments: () => setAttachmentDialogOpen(true),
    addAttachments: composer.selectMessageAttachments,
  };
  const pickerId = useId();
  const commandMenuId = useId();
  const [pressFeedback, setPressFeedback] = useState<'a' | 'b' | null>(null);
  const editedDraft = useRef<string | null>(null);
  // Alternating names restarts the surface pulse, including rapid repeat clicks.
  const playPressFeedback = () => setPressFeedback(current => current === 'a' ? 'b' : 'a');
  const draftEmpty = !draft && !pendingFilesystemPaths.length
    && !composer.pastedTexts.length && !pluginSelections.length;
  useLayoutEffect(() => {
    // Sending clears the draft; deleting the last character is still editing.
    if (draftEmpty && editedDraft.current !== draft) setPressFeedback(null);
    editedDraft.current = null;
  }, [draftEmpty, draft]);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    commandMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [commandActiveIndex, draft]);
  const annotations = composer.pastedTexts.filter(item => item.browserReview);
  const attachmentRail = useRef<HTMLDivElement>(null);
  const previousAttachments = useRef(new Set<string>());
  const inputMode = pendingApproval ? 'approval' : pendingPlan ? 'plan' : pendingInteraction ? 'interaction' : 'message';
  const compactInput = inputMode !== 'message';
  const currentRequest = projection?.contextCompositions.filter((item)=>item.runId===projection.run?.runId).at(-1);
  const readyPlugins = new Set(currentRequest?.tools.filter((tool)=>tool.availability==='callable').map((tool)=>tool.pluginUri));

  useLayoutEffect(() => {
    const rail = attachmentRail.current;
    const items = [...(rail?.querySelectorAll<HTMLElement>('[data-attachment-id]') ?? [])];
    const added = items.filter(item => !previousAttachments.current.has(item.dataset.attachmentId!));
    previousAttachments.current = new Set(items.map(item => item.dataset.attachmentId!));
    const latest = added.at(-1);
    if (!rail || !latest) return;
    const bounds = rail.getBoundingClientRect(), item = latest.getBoundingClientRect();
    if (item.left < bounds.left) rail.scrollLeft -= bounds.left - item.left + 13;
    else if (item.right > bounds.right) rail.scrollLeft += item.right - bounds.right + 13;
  }, [composer.pastedTexts, pendingFilesystemPaths, pluginSelections]);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [draft, inputMode, textareaRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    let previousWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width;
      if (width === previousWidth) return;
      previousWidth = width;
      resizeComposerTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [inputMode, textareaRef]);

  useAutoDismiss(error, composer.clearError);
  useAutoDismiss(attachmentError, composer.clearAttachmentError);
  useAutoDismiss(uiActionError, onDismissUiActionError);

  return (
    <UiRegion slot="composer.layout" data={regionData} actions={regionActions}><footer className={`local-agent__composer-shell${pendingPlan || pendingInteraction || pendingApproval
      ? ' local-agent__composer-shell--decision'
      : ''}`} onKeyDown={(event) => {
          if (composer.editingMessage && event.key === 'Escape' && !event.repeat
            && !event.nativeEvent.isComposing && !event.defaultPrevented) {
            event.preventDefault();
            composer.cancelMessageEdit();
          }
          if (pendingPlan && event.target !== textareaRef.current && event.key === 'Escape'
            && !event.repeat && !event.nativeEvent.isComposing && !event.defaultPrevented) {
            event.preventDefault();
            void composer.submitPlanDecision({ kind: 'cancel' });
          }
        }}>
      {error && <DismissibleError language={language} onDismiss={composer.clearError}>{error}</DismissibleError>}
      {attachmentError && <DismissibleError language={language} onDismiss={composer.clearAttachmentError}>{attachmentError}</DismissibleError>}
      {uiActionError && <DismissibleError language={language} onDismiss={onDismissUiActionError}>{uiActionError.includes('\n')
        ? <details><summary>{uiActionError.split('\n')[0]}</summary><pre>{uiActionError.slice(uiActionError.indexOf('\n') + 1)}</pre></details>
        : uiActionError}</DismissibleError>}
      <HostRebind run={projection?.run ?? null} />
      {composer.failedDrafts.map((failed, index) => <details className="local-agent__failed-draft" key={index}>
        <summary>{language === 'zh-CN' ? '未发送草稿已保留' : 'Unsent draft saved'}</summary>
        <pre>{[failed.draft, ...failed.pastedTexts.map((item) => item.text)].filter(Boolean).join('\n\n')}</pre>
        {failed.filesystemPaths.map((item) => <div key={item.path}>{item.path}</div>)}
        {failed.pluginSelections.map((item) => <div key={item.selectionId}>@{item.label}</div>)}
        <button type="button" disabled={!composer.canRestoreFailedDraft} onClick={() => composer.restoreFailedDraft(index)}>
          {language === 'zh-CN' ? '恢复到输入框' : 'Restore draft'}
        </button>
        {!composer.canRestoreFailedDraft && <small>{language === 'zh-CN' ? '发送或清空当前草稿后可恢复。' : 'Send or clear the current draft to restore this one.'}</small>}
      </details>)}
      <div className="conversation-change-dock" aria-live="polite">{changeBar}</div>
      {projection?.queuedInputs.map((input) => <div className="local-agent__queued-input" key={input.commandId} role="status">
        <strong>{input.status === 'queued'
          ? (language === 'zh-CN' ? '等待加入当前任务' : 'Waiting to join this run')
          : (language === 'zh-CN' ? '未加入本轮' : 'Not applied to this run')}</strong>
        <span>{input.text}{input.filesystemReferences.length ? ` · ${input.filesystemReferences.map((item) => item.displayName).join(', ')}` : ''}</span>
      </div>)}
      <ComposerQuestionPrompt language={language} composer={composer} />
      <div
        className={`local-agent__composer local-agent__composer--${inputMode}`}
        data-press-feedback={pressFeedback ?? undefined}
        onMouseDown={(event) => {
          const textarea = textareaRef.current;
          if (event.button !== 0 || !textarea || textarea.disabled) return;
          const target = event.target as HTMLElement;
          if (target === textarea) {
            playPressFeedback();
            return;
          }
          if (target.closest('button, input, select, textarea, label, a, [role="button"], .local-agent__interaction-panel, .local-agent__decision')) return;
          event.preventDefault();
          textarea.focus();
          playPressFeedback();
        }}
      >
        <ComposerDecisionPanels language={language} composer={composer} />
        {!pendingApproval && <>
        {composer.editingMessage && !composer.textDecision && <>
          <div className="local-agent__message-edit-notice">
            <div><strong>{t(language, 'agent.message.edit')}</strong><p>{t(language, 'agent.message.editDescription')}</p></div>
            <button type="button" disabled={submitting} onClick={composer.cancelMessageEdit} aria-keyshortcuts="Escape">
              {t(language, 'agent.message.cancelEdit')}
            </button>
          </div>
          <div className="local-agent__message-edit-references">
            {composer.editingMessage.message.filesystemReferences.map((reference) => <span key={reference.referenceId}>{reference.displayName}</span>)}
          </div>
        </>}
        {pluginPickerOpen && (
          <div
            ref={pluginPickerRef}
            className="local-agent__plugin-picker"
            role="group"
            aria-label={t(language, 'agent.plugin.picker')}
            data-native-overlay
          >
            <div className="local-agent__plugin-picker-heading">
              {t(language, 'agent.plugin.picker')}
            </div>
            <input className="local-agent__plugin-search" aria-label={language === 'zh-CN' ? '搜索工具' : 'Search tools'} placeholder={language === 'zh-CN' ? '搜索工具' : 'Search tools'} value={pluginQuery} onChange={(event) => setPluginQuery(event.target.value)} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={pickerId} aria-activedescendant={pluginActiveIndex >= 0 ? `${pickerId}-${pluginActiveIndex}` : undefined} onKeyDown={(event) => composer.handlePluginPickerKey(event)} />
            <div id={pickerId} role="listbox" aria-label={t(language, 'agent.plugin.picker')}>
            {filteredPlugins.length ? filteredPlugins.map((plugin, index) => (
              <button
                type="button"
                role="option"
                id={`${pickerId}-${index}`} tabIndex={-1}
                data-active={index === pluginActiveIndex}
                aria-selected={pluginSelections.some((selection) => selection.uri === plugin.uri)}
                key={plugin.uri}
                disabled={!plugin.enabled || !plugin.available}
                onClick={() => selectPlugin(plugin)}
                onMouseEnter={() => { if (plugin.enabled && plugin.available) setPluginActiveIndex(index); }}
              >
                <DeepCodeShellIcon name="extension" />
                <span>
                  <b>{plugin.displayName}</b>
                  <small>{plugin.shortDescription}</small>
                  {(!plugin.enabled || !plugin.available) && <small>{plugin.error
                    ? `${plugin.error.code}: ${plugin.error.message}`
                    : language === 'zh-CN' ? '插件未启用' : 'Plugin disabled'}</small>}
                </span>
                <span className="plugin-selection-mark" title={readyPlugins.has(plugin.uri) ? (language==='zh-CN'?'当前任务已就绪':'Ready in this task') : pluginSelections.some(selection=>selection.uri===plugin.uri) ? (language==='zh-CN'?'已选择，发送后加入任务':'Selected; prepared on send') : undefined}>{pluginSelections.some(selection=>selection.uri===plugin.uri)||readyPlugins.has(plugin.uri)? <DeepCodeShellIcon name="check" size={14} /> : null}</span>
              </button>
            )) : (
              <div className="local-agent__plugin-picker-empty">
                {t(language, 'agent.plugin.empty')}
              </div>
            )}
            </div>
          </div>
        )}
        {commandSuggestions.length > 0 && (
          <div
            id={commandMenuId}
            ref={commandMenuRef}
            className="local-agent__command-suggestions"
            role="listbox"
            aria-label={t(language, 'agent.commands.title')}
          >
            {commandSuggestions.map((command, index) => <button
              key={command.id}
              id={`${commandMenuId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === commandActiveIndex}
              disabled={!command.enabled}
              onMouseEnter={() => { if (command.enabled) setCommandActiveIndex(index); }}
              onMouseDown={event => event.preventDefault()}
              onClick={() => void selectCommand(command.id)}
            >
              <DeepCodeShellIcon name={command.icon} />
              <span>
                <b>{t(language, command.id === 'focus' ? 'agent.context.focusCommand' : `agent.commands.${command.id}`)}</b>
                <small>{t(language, command.id === 'focus' ? 'agent.context.focusCommandDescription' : `agent.commands.${command.id}Description`)}</small>
              </span>
              <kbd>/{command.id}</kbd>
            </button>)}
          </div>
        )}
        {selectedProfileId && !profiles.some((profile) => profile.id === selectedProfileId && profile.enabled) && (
          <p className="local-agent__profile-notice" role="status">{t(language, 'agent.profile.boundUnavailable')}</p>
        )}
        {(composer.pastedTexts.length > 0 || pendingFilesystemPaths.length > 0 || pluginSelections.length > 0) && (
          <div ref={attachmentRail} className="local-agent__draft-attachments" role="group" tabIndex={0}
            aria-label={language === 'zh-CN' ? '消息附件，可左右滚动查看' : 'Message attachments, scroll horizontally to browse'}>
            {composer.pastedTexts.map(paste => paste.browserReview ? (
              <div className="local-agent__browser-annotation" key={paste.inputId} data-attachment-id={paste.inputId}>
                <button type="button" className="local-agent__annotation-edit"
                  title={`${paste.browserReview.annotation.title || paste.browserReview.annotation.url}\n\n${paste.browserReview.annotation.comment}`}
                  onClick={() => onEditBrowserReview(paste.browserReview!)}>
                  <DeepCodeShellIcon name="compose" />
                  <span><strong>{language === 'zh-CN' ? '批注' : 'Annotation'} {annotations.indexOf(paste) + 1} · {paste.browserReview.annotation.title || paste.browserReview.annotation.url}</strong><small>{paste.browserReview.annotation.comment}</small></span>
                </button>
                <button type="button" aria-label={language === 'zh-CN' ? '移除批注' : 'Remove annotation'} onClick={() => composer.removeBrowserReview(paste.inputId)}><DeepCodeShellIcon name="close" size={14} /></button>
              </div>
            ) : (
              <div className="local-agent__pasted-text" key={paste.inputId} data-attachment-id={paste.inputId}>
                <div className="local-agent__pasted-text-header">
                  <DeepCodeShellIcon name="artifact" />
                  <span><strong>{pastedTextTitle(paste.text)}</strong><small>TXT · {(new TextEncoder().encode(paste.text).byteLength / 1024).toFixed(1)} KiB</small></span>
                  <button type="button" aria-label={t(language, 'agent.paste.remove')} onClick={() => composer.setPastedTexts((current) => current.filter((item) => item.inputId !== paste.inputId))}><DeepCodeShellIcon name="close" size={14} /></button>
                </div>
                <button type="button" className="local-agent__paste-toggle" aria-expanded={paste.expanded} onClick={() => composer.setPastedTexts((current) => current.map((item) => item.inputId === paste.inputId ? { ...item, expanded: !item.expanded } : item))}>
                  {t(language, paste.expanded ? 'agent.paste.collapse' : 'agent.paste.expand')}
                </button>
                {paste.expanded && <textarea aria-label={t(language, 'agent.paste.original')} value={paste.text} onChange={(event) => composer.editPastedText(paste.inputId, event.target.value)} rows={8} />}
              </div>
            ))}
            {pluginSelections.map((selection) => (
              <span className="local-agent__draft-plugin" key={selection.selectionId} data-attachment-id={selection.selectionId}>
                <DeepCodeShellIcon name="extension" />
                <span className="local-agent__attachment-name" title={selection.label}>@{selection.label}</span>
                <button
                  type="button"
                  aria-label={t(language, 'agent.plugin.remove', { name: selection.label })}
                  onClick={() => {
                    setPluginSelections((current) => current.filter((item) => (
                      item.selectionId !== selection.selectionId
                    )));
                    setDraft((current) => current.replace(`@${selection.label}`, '').trimStart());
                  }}
                ><DeepCodeShellIcon name="close" size={14} /></button>
              </span>
            ))}
            {pendingFilesystemPaths.filter(reference => !composer.pastedTexts.some(paste => paste.browserReview?.screenshot === reference.path)).map((reference) => (
              <span
                className={reference.kind === 'directory'
                  ? 'local-agent__draft-directory'
                  : undefined}
                key={`${reference.kind}:${reference.path}`}
                data-attachment-id={`${reference.kind}:${reference.path}`}
              >
                <DeepCodeShellIcon name={reference.kind === 'directory'
                  ? 'folder'
                  : 'artifact'} />
                <span className="local-agent__attachment-name" title={reference.path}>
                  {reference.kind === 'directory' ? `${t(language, 'agent.attachment.folder')} · ` : ''}
                  {filesystemPathDisplayName(reference.path)}
                </span>
                <button
                  type="button"
                  aria-label={t(language, 'agent.attachment.remove', {
                    name: filesystemPathDisplayName(reference.path),
                  })}
                  onClick={() => setPendingFilesystemPaths((current) => current.filter((item) => (
                    item.path !== reference.path || item.kind !== reference.kind
                  )))}
                ><DeepCodeShellIcon name="close" size={14} /></button>
              </span>
            ))}
          </div>
        )}
        {composer.textDecision && <span className="local-agent__decision-input-mark" aria-hidden="true"><DeepCodeShellIcon name="compose" size={16} /></span>}
        <textarea
          ref={textareaRef}
          value={draft}
          aria-controls={commandSuggestions.length ? commandMenuId : undefined}
          aria-activedescendant={commandSuggestions.length && commandActiveIndex >= 0 ? `${commandMenuId}-${commandActiveIndex}` : undefined}
          rows={compactInput ? 1 : 3}
          placeholder={t(language, pendingPlan ? 'agent.composer.placeholder.plan'
            : pendingInteraction ? 'agent.composer.placeholder.interaction' : 'agent.composer.placeholder.task')}
          disabled={Boolean(pendingInteraction && !pendingInteraction.allowFreeform || composer.editingMessage && submitting)}
          onChange={(event) => {
            // Typing after a send re-engages the surface even when focus was retained.
            editedDraft.current = event.target.value;
            setPressFeedback(current => current ?? 'a');
            updateDraft(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onFocus={(event) => {
            setPressFeedback(current => current ?? 'a');
            recordComposerElementState(event.currentTarget, true);
          }}
          onBlur={(event) => {
            setPressFeedback(null);
            recordComposerElementState(event.currentTarget, false);
          }}
          onSelect={(event) => recordComposerElementState(
            event.currentTarget,
            document.activeElement === event.currentTarget,
          )}
          onCompositionStart={beginComposition}
          onCompositionEnd={endComposition}
          onKeyDown={submitOnComposerEnter}
          onPaste={composer.pasteText}
        />
        <div className="local-agent__composer-footer">
          {!composer.textDecision && !composer.editingMessage && <UiRegion slot="composer.attachments" data={regionData} actions={regionActions}><div className="local-agent__composer-tools">
            <div ref={attachmentControlRef} className="local-agent__attachment-control">
              <button
                type="button"
                className="local-agent__attach"
                aria-label={t(language, 'agent.attachment.menu')}
                title={t(language, 'agent.attachment.menu')}
                aria-expanded={attachmentMenuOpen}
                aria-haspopup="menu"
                disabled={catalogBusy}
                onClick={() => {
                  setAttachmentMenuOpen((open) => !open);
                  setPermissionMenuOpen(false);
                }}
              >
                <DeepCodeShellIcon name="plus" />
              </button>
              {attachmentMenuOpen && (
                <div className="local-agent__attachment-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAttachmentMenuOpen(false);
                      setAttachmentDialogOpen(true);
                    }}
                  >
                    <DeepCodeShellIcon name="paperclip" />
                    <span>
                      <b>{t(language, 'agent.attachment.filesAndFolders')}</b>
                      <small>{t(language, 'agent.attachment.pickerDescription')}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openPluginPicker}
                  >
                    <DeepCodeShellIcon name="extension" />
                    <span>
                      <b>{t(language, 'agent.plugin.menu')}</b>
                      <small>{t(language, 'agent.plugin.menuDescription')}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={insertFocusCommand}
                  >
                    <DeepCodeShellIcon name="activity" />
                    <span>
                      <b>{t(language, 'agent.context.focusCommand')}</b>
                      <small>{t(language, 'agent.context.focusCommandDescription')}</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <ComposerPermissionControl language={language} composer={composer} />
          </div></UiRegion>}
          <UiRegion slot="composer.actions" data={regionData} actions={regionActions}><div className="local-agent__composer-actions">
            {!composer.textDecision && !composer.editingMessage && <SessionModelSelector
              key={composer.conversationKey}
              language={language}
              profiles={profiles}
              connections={connections}
              selectedProfileId={selectedProfileId}
              reasoningEffortOverride={reasoningEffortOverride}
              contextUsage={projection?.contextUsage ?? null}
              contextCompositions={projection?.contextCompositions ?? []}
              busy={loading || submitting || modelSettingsBusy}
              requestedPanel={composer.modelPanelRequest}
              confirmed={modelSelectionConfirmed}
              onSelect={selectModel}
            />}
            <div className="local-agent__composer-primary-actions">
              {(pendingPlan || pendingInteraction?.allowFreeform) && <button
                type="button"
                className="local-agent__interaction-secondary"
                disabled={submitting}
                aria-keyshortcuts={pendingPlan ? 'Escape' : undefined}
                onClick={async () => {
                  if (pendingPlan) {
                    await composer.submitPlanDecision({ kind: 'cancel' });
                  } else {
                    try {
                      await composer.respondInteraction(t(language, 'agent.interaction.skip'));
                    } catch {
                      // The store retains the command error and the current answer.
                    }
                  }
                }}
              >
                <span>{t(language, pendingPlan ? 'agent.plan.ignoreAndStop' : 'agent.interaction.skip')}</span>
              </button>}
              {showStopAction && <button
                type="button"
                className="local-agent__send local-agent__send--stop"
                aria-label={t(language, 'agent.composer.stopCurrentRun')}
                title={t(language, 'agent.composer.stop')}
                onClick={() => void cancelRun()}
              ><DeepCodeShellIcon name="stop" /></button>}
              {!showStopAction && <button
                type="button"
                className={`local-agent__send${composer.textDecision || composer.editingMessage ? ' local-agent__send--decision' : ''}`}
                aria-label={submitting
                    ? t(language, 'agent.composer.sending')
                    : pendingInteraction ? (language === 'zh-CN' ? '回答' : 'Answer')
                      : pendingPlan ? (language === 'zh-CN' ? '提交修改意见' : 'Request changes')
                        : t(language, composer.editingMessage ? 'agent.message.regenerate' : 'agent.composer.send')}
                title={t(language, 'agent.composer.sendEnter')}
                disabled={!canSend}
                onClick={() => void submitDraft()}
              >
                {composer.editingMessage ? t(language, 'agent.message.regenerate') : composer.textDecision ? t(language, 'agent.composer.send') : <DeepCodeShellIcon name="arrowUp" />}
              </button>}
            </div>
          </div></UiRegion>
        </div>
        </>}
      </div>
      {!pendingPlan && !pendingInteraction && !pendingApproval && (
        <div className="local-agent__composer-hint">
          <TotalCacheUsage projection={projection} language={language} />
        </div>
      )}
    </footer></UiRegion>
  );
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function filesystemPathDisplayName(absolutePath: string): string {
  const normalized = absolutePath.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || absolutePath;
}
