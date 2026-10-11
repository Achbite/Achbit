import { formatBrowserAnnotation, type BrowserAnnotation } from './browserReview';
import { localizePlugin } from '../../pluginLocalization';
import { nextEnabledIndex } from '../shared/keyboardNavigation';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlanResponse, PluginSelectionInput, ProjectionMessage } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { shouldOfferFocusCommand, shouldSubmitComposerKey } from './composerKeyboard';
import { planScopeAddition } from './planReview';
import { isLongPastedText } from '../../services/pastedText';
import { cloneComposerState, composerStateIsEmpty, emptyComposerState, submitComposerState, type ComposerState } from './composerSubmission';

function readComposerDraft(key:string):ComposerState {
  const saved=sessionStorage.getItem(`deepcode:composer:${key}`);
  if(!saved)return emptyComposerState();
  try{return cloneComposerState(JSON.parse(saved) as ComposerState);}
  catch(error){console.error('Cannot read the saved composer draft.',error);return emptyComposerState();}
}
function saveComposerDraft(key:string,state:ComposerState):void {
  try{sessionStorage.setItem(`deepcode:composer:${key}`,JSON.stringify(state));}
  catch(error){console.error('Cannot preserve the composer draft across a window reload.',error);}
}

type PastedTextDraft = ComposerState['pastedTexts'][number];

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

export function useAgentComposer(
  language: UiLanguage,
  setLatestFollowMode: (following: boolean) => void,
) {
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const pluginCatalog = useLocalAgentStore((state) => state.pluginCatalog);
  const profiles = useLocalAgentStore((state) => state.profiles);
  const selectedProfileId = useLocalAgentStore((state) => state.selectedProfileId);
  const projection = useLocalAgentStore((state) => state.projection);
  // Deferred questions stay answerable in their transcript cards while normal
  // steering and cancellation remain available in the running composer.
  const question = projection?.pendingInteraction ?? null;
  const pendingInteraction = question?.mode === 'continue' && projection?.run?.status === 'running' ? null : question;
  const pendingApproval = projection?.pendingApproval ?? null;
  const pendingPlan = projection?.pendingPlan ?? null;
  const pendingScopeAddition = pendingPlan ? planScopeAddition(projection?.plans.find((plan) => (
    plan.planId === pendingPlan.planId && plan.revision === pendingPlan.revision - 1
  )), pendingPlan) : null;
  const textDecision = Boolean(pendingPlan || pendingInteraction);
  const conversationKey = sessionId ?? `new:${draftProjectId ?? 'independent'}`;
  const [messageEdit, setMessageEdit] = useState<{ sessionId: string; message: ProjectionMessage; revision: number } | null>(null);
  const editingMessage = messageEdit?.sessionId === sessionId ? messageEdit : null;
  const composerStateKey = pendingPlan
    ? `${conversationKey}:plan:${pendingPlan.planId}:${pendingPlan.revision}`
    : pendingInteraction
      ? `${conversationKey}:interaction:${pendingInteraction.interactionId}`
      : editingMessage ? `${conversationKey}:edit:${editingMessage.message.messageId}` : conversationKey;
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const error = useLocalAgentStore((state) => state.error);
  const clearError = useLocalAgentStore((state) => state.clearError);
  const sendMessage = useLocalAgentStore((state) => state.sendMessage);
  const editMessage = useLocalAgentStore((state) => state.editMessage);
  const focusContext = useLocalAgentStore((state) => state.focusContext);
  const respondInteraction = useLocalAgentStore((state) => state.respondInteraction);
  const respondApproval = useLocalAgentStore((state) => state.respondApproval);
  const respondPlan = useLocalAgentStore((state) => state.respondPlan);
  const cancelRun = useLocalAgentStore((state) => state.cancelRun);
  const saveModelChoice = useLocalAgentStore(state => state.selectModel);
  const reasoningEffortOverride = useLocalAgentStore((state) => state.reasoningEffortOverride);
  const modelSettingsBusy = useLocalAgentStore((state) => state.modelSettingsBusy);
  const [initialComposer] = useState(()=>readComposerDraft(composerStateKey));
  const [draft, setDraft] = useState(initialComposer.draft);
  const [pastedTexts, setPastedTexts] = useState<PastedTextDraft[]>(initialComposer.pastedTexts);
  const [pendingFilesystemPaths, setPendingFilesystemPaths] = useState<
    PendingFilesystemPath[]
  >(initialComposer.filesystemPaths);
  const [pluginSelections, setPluginSelections] = useState<PluginSelectionInput[]>(initialComposer.pluginSelections);
  const [pluginPickerOpen, setPluginPickerOpen] = useState(false);
  const [pluginQuery, setPluginQuery] = useState('');
  const [pluginTriggerStart, setPluginTriggerStart] = useState<number | null>(null);
  const [pluginActiveIndex, setPluginActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const attachmentControlRef = useRef<HTMLDivElement | null>(null);
  const pluginPickerRef = useRef<HTMLDivElement | null>(null);
  const permissionControlRef = useRef<HTMLDivElement | null>(null);
  const permissionMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerStatesRef = useRef(new Map<string, ComposerState>());
  const [failedDrafts, setFailedDrafts] = useState<Record<string, ComposerState[]>>({});
  const currentComposerStateRef = useRef<ComposerState>(emptyComposerState());
  currentComposerStateRef.current = { draft, pastedTexts, filesystemPaths: pendingFilesystemPaths,
    pluginSelections, selectionStart: textareaRef.current?.selectionStart ?? draft.length,
    selectionEnd: textareaRef.current?.selectionEnd ?? draft.length,
    focused: typeof document !== 'undefined' && document.activeElement === textareaRef.current };
  const activeComposerStateKeyRef = useRef(composerStateKey);
  useEffect(()=>{
    saveComposerDraft(activeComposerStateKeyRef.current,currentComposerStateRef.current);
  },[draft,pastedTexts,pendingFilesystemPaths,pluginSelections,composerStateKey]);
  const pendingComposerRestoreRef = useRef<{
    key: string;
    state: ComposerState;
  } | null>(null);
  const compositionActiveRef = useRef(false);
  const compositionCommitPendingRef = useRef(false);
  const compositionGuardFrameRef = useRef<number | null>(null);
  const recordComposerElementState = (
    element: HTMLTextAreaElement,
    focused: boolean,
  ) => {
    composerStatesRef.current.set(activeComposerStateKeyRef.current, {
      draft: element.value,
      pastedTexts: pastedTexts.map((item) => ({ ...item })),
      filesystemPaths: pendingFilesystemPaths.map((item) => ({ ...item })),
      pluginSelections: pluginSelections.map((item) => ({ ...item })),
      selectionStart: element.selectionStart ?? element.value.length,
      selectionEnd: element.selectionEnd ?? element.value.length,
      focused,
    });
  };

  const setComposerStateForKey = (key: string, state: ComposerState) => {
    const copy = cloneComposerState(state);
    composerStatesRef.current.set(key, copy);
    saveComposerDraft(key,copy);
    if (activeComposerStateKeyRef.current !== key) return;
    currentComposerStateRef.current = copy;
    setDraft(copy.draft);
    setPastedTexts(copy.pastedTexts);
    setPendingFilesystemPaths(copy.filesystemPaths);
    setPluginSelections(copy.pluginSelections);
    pendingComposerRestoreRef.current = { key, state: copy };
  };

  const canEditMessage = Boolean(sessionId && projection && !loading && !submitting && !catalogBusy
    && !pendingPlan && !pendingInteraction && !pendingApproval
    && (!projection.run || ['completed', 'failed', 'cancelled', 'indeterminate'].includes(projection.run.status)));
  const beginMessageEdit = (message: ProjectionMessage) => {
    if (!canEditMessage || !sessionId || !projection || message.role !== 'user' || message.replyToInteraction || message.runId) return;
    const key = `${conversationKey}:edit:${message.messageId}`;
    // The ordinary composer keeps its own draft, attachments and selection.
    setComposerStateForKey(key, { ...emptyComposerState(), draft: message.content,
      selectionStart: message.content.length, selectionEnd: message.content.length, focused: true });
    setMessageEdit({ sessionId, message, revision: projection.revision });
  };
  const cancelMessageEdit = () => { if (!submitting) setMessageEdit(null); };

  useLayoutEffect(() => {
    const previousKey = activeComposerStateKeyRef.current;
    if (previousKey === composerStateKey) return;
    const textarea = textareaRef.current;
    const previous = composerStatesRef.current.get(previousKey);
    const outgoing: ComposerState = pendingComposerRestoreRef.current?.key === previousKey
      ? cloneComposerState(pendingComposerRestoreRef.current.state)
      : {
          draft: textarea?.value ?? draft,
          pastedTexts: pastedTexts.map((item) => ({ ...item })),
          filesystemPaths: pendingFilesystemPaths.map((item) => ({ ...item })),
          pluginSelections: pluginSelections.map((item) => ({ ...item })),
          selectionStart: textarea?.selectionStart ?? previous?.selectionStart ?? draft.length,
          selectionEnd: textarea?.selectionEnd ?? previous?.selectionEnd ?? draft.length,
          focused: document.activeElement === textarea || previous?.focused === true,
        };
    composerStatesRef.current.set(previousKey, outgoing);
    saveComposerDraft(previousKey,outgoing);

    const incoming = cloneComposerState(
      composerStatesRef.current.get(composerStateKey) ?? { ...readComposerDraft(composerStateKey), focused: outgoing.focused },
    );
    activeComposerStateKeyRef.current = composerStateKey;
    pendingComposerRestoreRef.current = { key: composerStateKey, state: incoming };
    setDraft(incoming.draft);
    setPastedTexts(incoming.pastedTexts);
    setPendingFilesystemPaths(incoming.filesystemPaths);
    setPluginSelections(incoming.pluginSelections);
    setPluginPickerOpen(false);
    setAttachmentMenuOpen(false);
    setAttachmentDialogOpen(false);
    setPermissionMenuOpen(false);
    setAttachmentError(null);
  }, [composerStateKey]);

  useEffect(() => {
    const pending = pendingComposerRestoreRef.current;
    if (!pending || pending.key !== activeComposerStateKeyRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== pending.state.draft) return;
    // Restore after the controlled value and the switching pointer event settle.
    const frame = window.requestAnimationFrame(() => {
      if (pendingComposerRestoreRef.current !== pending
        || activeComposerStateKeyRef.current !== pending.key
        || textareaRef.current !== textarea || textarea.value !== pending.state.draft) return;
      const selectionStart = Math.min(pending.state.selectionStart, textarea.value.length);
      const selectionEnd = Math.min(
        Math.max(selectionStart, pending.state.selectionEnd),
        textarea.value.length,
      );
      if (pending.state.focused && !textarea.disabled) textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selectionStart, selectionEnd);
      pendingComposerRestoreRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  });

  useEffect(() => () => {
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!permissionMenuOpen && !attachmentMenuOpen && !pluginPickerOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (permissionMenuOpen && !permissionControlRef.current?.contains(target) && !permissionMenuRef.current?.contains(target)) {
        setPermissionMenuOpen(false);
      }
      if (attachmentMenuOpen && !attachmentControlRef.current?.contains(target)) {
        setAttachmentMenuOpen(false);
      }
      if (
        pluginPickerOpen
        && !pluginPickerRef.current?.contains(target)
        && target !== textareaRef.current
      ) {
        setPluginPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [attachmentMenuOpen, permissionMenuOpen, pluginPickerOpen]);

  const submitDraft = async () => {
    const submittedText = draft;
    if (
      !canSend
      || compositionActiveRef.current
      || compositionCommitPendingRef.current
    ) return;
    const submittedComposerKey = activeComposerStateKeyRef.current;
    const submission = { key: submittedComposerKey };
    const onSessionCreated = (createdSessionId: string) => {
      const previousKey = submission.key;
      submission.key = createdSessionId;
      const cached = composerStatesRef.current.get(previousKey);
      if (cached) composerStatesRef.current.set(createdSessionId, cached);
      composerStatesRef.current.delete(previousKey);
      if (activeComposerStateKeyRef.current === previousKey) activeComposerStateKeyRef.current = createdSessionId;
      setFailedDrafts((current) => {
        if (!current[previousKey]) return current;
        const next = { ...current, [createdSessionId]: current[previousKey] };
        delete next[previousKey];
        return next;
      });
    };
    const submittedFilesystemPaths = pendingFilesystemPaths;
    const submittedPluginSelections = pluginSelections;
    const submittedTextarea = textareaRef.current;
    const submittedComposerState: ComposerState = {
      draft: submittedText,
      pastedTexts: pastedTexts.map((item) => ({ ...item })),
      filesystemPaths: submittedFilesystemPaths.map((item) => ({ ...item })),
      pluginSelections: submittedPluginSelections.map((item) => ({ ...item })),
      selectionStart: submittedTextarea?.selectionStart ?? submittedText.length,
      selectionEnd: submittedTextarea?.selectionEnd ?? submittedText.length,
      focused: document.activeElement === submittedTextarea,
    };
    setPluginPickerOpen(false);
    setLatestFollowMode(true);
    const sent = await submitComposerState(submittedComposerKey, submittedComposerState, {
      read: () => activeComposerStateKeyRef.current === submission.key
        ? { ...currentComposerStateRef.current, draft: textareaRef.current?.value ?? currentComposerStateRef.current.draft }
        : composerStatesRef.current.get(submission.key) ?? emptyComposerState(),
      write: (_key, state) => setComposerStateForKey(submission.key, state),
      retainFailed: (_key, state) => setFailedDrafts((current) => ({ ...current, [submission.key]: [...(current[submission.key] ?? []), state] })),
      send: async () => {
        if (editingMessage && !textDecision) {
          await editMessage(editingMessage.message.messageId, submittedText, editingMessage.revision);
          return;
        }
        if (pendingPlan) {
          await respondPlan({ kind: 'requestRevision', text: submittedText });
          return;
        }
        if (pendingInteraction) {
          await respondInteraction(submittedText, pendingInteraction.interactionId);
          return;
        }
        const focusMatch = submittedText.match(/^\/focus(?:\s+)([\s\S]+)$/u);
        if (focusMatch) {
          await focusContext(focusMatch[1]!.trim(), submittedFilesystemPaths, submittedPluginSelections, submittedComposerState.pastedTexts, onSessionCreated);
        } else {
          await sendMessage(submittedText, submittedFilesystemPaths, submittedPluginSelections, submittedComposerState.pastedTexts, onSessionCreated);
        }
      },
    });
    if (sent && activeComposerStateKeyRef.current === submission.key) {
      setAttachmentError(null);
      if (editingMessage) setMessageEdit(null);
    }
  };

  const beginComposition = () => {
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
      compositionGuardFrameRef.current = null;
    }
    compositionCommitPendingRef.current = false;
    compositionActiveRef.current = true;
  };

  const endComposition = () => {
    compositionActiveRef.current = false;
    compositionCommitPendingRef.current = true;
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
    compositionGuardFrameRef.current = window.requestAnimationFrame(() => {
      compositionGuardFrameRef.current = null;
      compositionCommitPendingRef.current = false;
    });
  };

  const insertFocusCommand = () => {
    const nextDraft = /^\/focus(?:\s|$)/u.test(draft)
      ? draft
      : `/focus ${draft}`;
    focusComposerDraft(nextDraft);
  };

  const selectFocusCommand = () => {
    focusComposerDraft('/focus ');
  };

  const focusComposerDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    setAttachmentMenuOpen(false);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  };

  const filteredPlugins = useMemo(() => {
    const query = pluginQuery.trim().toLocaleLowerCase();
    return pluginCatalog.plugins.map((plugin) => localizePlugin(plugin, language)).filter((plugin) => {
      if (!query) return plugin.discovery !== 'searchOnly';
      return [plugin.displayName, plugin.shortDescription, plugin.uri]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [pluginCatalog.plugins, pluginQuery, language]);

  useEffect(() => {
    setPluginActiveIndex((current) => filteredPlugins[current]?.enabled && filteredPlugins[current]?.available ? current : nextEnabledIndex(filteredPlugins.map((plugin) => plugin.enabled && plugin.available), -1, 'Home'));
  }, [filteredPlugins]);

  const openPluginPicker = () => {
    setAttachmentMenuOpen(false);
    setPluginTriggerStart(null);
    setPluginQuery('');
    setPluginActiveIndex(0);
    setPluginPickerOpen(true);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const updateDraft = (value: string, cursor: number) => {
    pendingComposerRestoreRef.current = null;
    setDraft(value);
    if (textDecision || editingMessage) return;
    setPluginSelections((current) => current.filter((selection) => (
      value.includes(`@${selection.label}`)
    )));
    const prefix = value.slice(0, cursor);
    const match = prefix.match(/(^|\s)@([^\s@/]*)$/u);
    if (!match) {
      setPluginPickerOpen(false);
      setPluginTriggerStart(null);
      setPluginQuery('');
      setPluginActiveIndex(0);
      return;
    }
    setPluginTriggerStart(cursor - match[2]!.length - 1);
    setPluginQuery(match[2]!);
    setPluginActiveIndex(0);
    setPluginPickerOpen(true);
  };

  const selectPlugin = (plugin: (typeof pluginCatalog.plugins)[number]) => {
    if (!plugin.enabled || !plugin.available) return;
    const cursor = textareaRef.current?.selectionStart ?? draft.length;
    const mention = `@${plugin.displayName}`;
    const alreadySelected = pluginSelections.some((selection) => selection.uri === plugin.uri);
    const insertionStart = pluginTriggerStart ?? (
      draft.length + (draft && !/\s$/u.test(draft) ? 1 : 0)
    );
    const nextDraft = alreadySelected
      ? (pluginTriggerStart === null
          ? draft
          : `${draft.slice(0, pluginTriggerStart)}${draft.slice(cursor)}`)
      : pluginTriggerStart === null
        ? `${draft}${draft && !/\s$/u.test(draft) ? ' ' : ''}${mention} `
        : `${draft.slice(0, pluginTriggerStart)}${mention} ${draft.slice(cursor)}`;
    const nextCursor = alreadySelected
      ? insertionStart
      : insertionStart + mention.length + 1;
    setDraft(nextDraft);
    setPluginSelections((current) => (
      current.some((selection) => selection.uri === plugin.uri)
        ? current
        : [...current, {
            selectionId: nextPanelId('plugin-selection'),
            uri: plugin.uri,
            label: plugin.displayName,
          }]
    ));
    setPluginPickerOpen(false);
    setPluginTriggerStart(null);
    setPluginQuery('');
    setPluginActiveIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const focusCommandSuggestionVisible = !textDecision && shouldOfferFocusCommand(draft);

  const handlePluginPickerKey = (event: React.KeyboardEvent<HTMLElement>, allowTab = false): boolean => {
    if (!pluginPickerOpen || event.nativeEvent.isComposing || compositionActiveRef.current || compositionCommitPendingRef.current) return false;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setPluginPickerOpen(false); textareaRef.current?.focus(); return true;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setPluginActiveIndex((current) => nextEnabledIndex(filteredPlugins.map((plugin) => plugin.enabled && plugin.available), current, event.key));
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || (allowTab && event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      const plugin = filteredPlugins[pluginActiveIndex];
      if (plugin?.enabled && plugin.available) selectPlugin(plugin);
      return true;
    }
    return false;
  };
  const submitOnComposerEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handlePluginPickerKey(event, true)) return;
    if (pendingPlan && event.key === 'Escape' && !event.repeat
      && !event.nativeEvent.isComposing && !compositionActiveRef.current
      && !compositionCommitPendingRef.current) {
      event.preventDefault();
      void submitPlanDecision({ kind: 'cancel' });
      return;
    }
    if (!shouldSubmitComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    }, {
      active: compositionActiveRef.current,
      commitPending: compositionCommitPendingRef.current,
    })) return;
    event.preventDefault();
    if (focusCommandSuggestionVisible) {
      selectFocusCommand();
      return;
    }
    void submitDraft();
  };

  const submitPlanDecision = useCallback(async (
    response: Extract<PlanResponse, { kind: 'confirm' | 'cancel' }>,
  ) => {
    if (!pendingPlan || submitting) return;
    // Resume at the user's confirmation, not after the asynchronous reply:
    // scrolling up while the command is pending must still detach the viewport.
    if (response.kind === 'confirm') setLatestFollowMode(true);
    try {
      await respondPlan(response);
    } catch {
      // The store preserves the authoritative command error for the shared error panel.
    }
  }, [pendingPlan, respondPlan, setLatestFollowMode, submitting]);

  const selectMessageAttachments = async (
    selections: { path: string; kind: 'directory' | 'file' }[],
  ) => {
    setAttachmentDialogOpen(false);
    try {
      const unique = selections.filter((item, index) => selections.findIndex(other => other.path === item.path && other.kind === item.kind) === index);
      if (unique.length > 1 && unique.some(item => item.kind === 'directory')) throw new Error(language === 'zh-CN' ? '请选择多个文件或一个文件夹。' : 'Select multiple files or one folder.');
      const additions = unique.filter(item => !pendingFilesystemPaths.some(current => current.path === item.path && current.kind === item.kind));
      if (pendingFilesystemPaths.length + pastedTexts.length + additions.length > 8) {
        throw new Error(t(language, 'agent.attachment.error.maxFiles'));
      }
      if (additions.some(item => item.kind === 'file' && mediaTypeForPath(item.path) === 'application/pdf')) {
        const matches = pluginCatalog.plugins.filter((plugin) => (
          plugin.activationMediaTypes.includes('application/pdf')
        ));
        if (matches.length !== 1) {
          throw new Error('plugin_selection_unavailable:application/pdf');
        }
        const plugin = matches[0]!;
        if (!plugin.enabled || !plugin.available) {
          throw new Error(plugin.error ? `${plugin.error.code}: ${plugin.error.message}` : `plugin_selection_unavailable:${plugin.uri}`);
        }
        setPluginSelections((current) => (
          current.some((selection) => selection.uri === plugin.uri)
            ? current
            : [...current, {
                selectionId: nextPanelId('plugin-selection'),
                uri: plugin.uri,
                label: plugin.displayName,
              }]
        ));
        setDraft((current) => {
          const mention = `@${plugin.displayName}`;
          return current.includes(mention)
            ? current
            : `${current}${current && !/\s$/u.test(current) ? ' ' : ''}${mention} `;
        });
      }
      setPendingFilesystemPaths(current => [...current, ...additions.filter(item => !current.some(other => other.path === item.path && other.kind === item.kind))]);
      setAttachmentError(null);
    } catch (selectionError) {
      setAttachmentError(selectionError instanceof Error
        ? selectionError.message
        : String(selectionError));
    }
  };

  const canCancel = Boolean(
    projection?.run && ['running', 'waiting'].includes(projection.run.status),
  );
  const appendBrowserReview = (annotation: BrowserAnnotation, previewId: string, screenshot?: string) => {
    if (!sessionId) throw new Error('请先打开对话再添加批注。');
    // An annotation belongs to the normal message draft, including during a pending decision.
    const key = sessionId;
    const current = activeComposerStateKeyRef.current === key
      ? currentComposerStateRef.current : composerStatesRef.current.get(key) ?? readComposerDraft(key);
    const next = cloneComposerState(current);
    const previous = next.pastedTexts.find(item => item.browserReview?.annotation.id === annotation.id);
    next.pastedTexts = next.pastedTexts.filter(item => item !== previous);
    if (previous?.browserReview?.screenshot)
      next.filesystemPaths = next.filesystemPaths.filter(item => item.path !== previous.browserReview!.screenshot);
    if (next.filesystemPaths.length + next.pastedTexts.length + (screenshot ? 2 : 1) > 8)
      throw new Error(t(language, 'agent.attachment.error.maxFiles'));
    next.pastedTexts.push({ inputId: nextPanelId('annotation'), text: formatBrowserAnnotation(annotation, previewId, language === 'zh-CN'),
      expanded: false, browserReview: { annotation, previewId, screenshot } });
    if (screenshot) next.filesystemPaths.push({ path: screenshot, kind: 'file' });
    setComposerStateForKey(key, next);
  };
  const removeBrowserReview = (inputId: string) => {
    const paste = pastedTexts.find(item => item.inputId === inputId);
    setPastedTexts(current => current.filter(item => item.inputId !== inputId));
    if (paste?.browserReview?.screenshot)
      setPendingFilesystemPaths(current => current.filter(item => item.path !== paste.browserReview!.screenshot));
  };
  const pasteText = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    pendingComposerRestoreRef.current = null;
    if (textDecision || editingMessage) return;
    const text = event.clipboardData.getData('text/plain');
    if (!isLongPastedText(text)) return;
    event.preventDefault();
    if (pendingFilesystemPaths.length + pastedTexts.length >= 8) {
      setAttachmentError(t(language, 'agent.attachment.error.maxFiles'));
      return;
    }
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setDraft(element.value.slice(0, start) + element.value.slice(end));
    setPastedTexts((current) => [...current, { inputId: nextPanelId('paste'), text, expanded: false }]);
    setAttachmentError(null);
  };
  const editPastedText = (inputId: string, text: string) => setPastedTexts((current) => current.map((item) => (
    item.inputId === inputId ? { ...item, inputId: nextPanelId('paste'), text } : item
  )));
  const selectedProfile = profiles.find(profile => profile.id === selectedProfileId);
  // A null Session override inherits the Profile, as it does in Provider binding.
  // Only a missing effective effort requires an explicit selection.
  const modelSelectionConfirmed = Boolean(selectedProfile?.enabled
    && (selectedProfile.thinking === 'disabled' || (reasoningEffortOverride ?? selectedProfile.reasoningEffort)));
  const selectModel = async (profileId: string, effort: import('@deepcode/protocol').LlmReasoningEffort | null) => {
    await saveModelChoice(profileId, effort);
  };
  const canSend = !loading && !submitting && (!editingMessage || canEditMessage) && (textDecision
    ? Boolean(draft.trim()) && (!pendingInteraction || pendingInteraction.allowFreeform)
    : Boolean(draft.trim() || pastedTexts.length || pendingFilesystemPaths.length || editingMessage?.message.filesystemReferences.length)
      && !modelSettingsBusy && !catalogBusy
      && Boolean(canCancel || (modelSelectionConfirmed && profiles.some((profile) => profile.id === selectedProfileId && profile.enabled))));
  const showStopAction = canCancel && !textDecision && !draft.trim() && !pastedTexts.length && !pendingFilesystemPaths.length;
  const canRestoreFailedDraft = composerStateIsEmpty(currentComposerStateRef.current);
  const restoreFailedDraft = (index: number) => {
    const saved = failedDrafts[composerStateKey]?.[index];
    if (!saved || !composerStateIsEmpty(currentComposerStateRef.current)) return;
    setComposerStateForKey(composerStateKey, { ...saved, focused: true });
    setFailedDrafts((current) => ({ ...current, [composerStateKey]: current[composerStateKey]!.filter((_, candidate) => candidate !== index) }));
  };

  return {
    conversationKey,
    editingMessage,
    canEditMessage,
    beginMessageEdit,
    cancelMessageEdit,
    textDecision,
    pendingPlan,
    pendingScopeAddition,
    pendingInteraction,
    pendingApproval,
    projection,
    loading,
    submitting,
    catalogBusy,
    error,
    clearError,
    profiles,
    selectedProfileId,
    reasoningEffortOverride,
    modelSettingsBusy,
    respondInteraction,
    respondApproval,
    respondPlan,
    cancelRun,
    selectModel,
    modelSelectionConfirmed,
    appendBrowserReview,
    removeBrowserReview,
    draft,
    pastedTexts,
    setPastedTexts,
    pasteText,
    editPastedText,
    setDraft,
    pendingFilesystemPaths,
    setPendingFilesystemPaths,
    pluginSelections,
    setPluginSelections,
    pluginPickerOpen,
    pluginActiveIndex,
    setPluginActiveIndex,
    attachmentError,
    clearAttachmentError: () => setAttachmentError(null),
    attachmentMenuOpen,
    setAttachmentMenuOpen,
    attachmentDialogOpen,
    setAttachmentDialogOpen,
    permissionMenuOpen,
    setPermissionMenuOpen,
    attachmentControlRef,
    pluginPickerRef,
    permissionControlRef,
    permissionMenuRef,
    textareaRef,
    recordComposerElementState,
    beginComposition,
    endComposition,
    submitOnComposerEnter,
    handlePluginPickerKey,
    submitPlanDecision,
    filteredPlugins,
    pluginQuery,
    setPluginQuery,
    selectPlugin,
    focusCommandSuggestionVisible,
    selectFocusCommand,
    updateDraft,
    openPluginPicker,
    insertFocusCommand,
    submitDraft,
    selectMessageAttachments,
    canSend,
    showStopAction,
    failedDrafts: failedDrafts[composerStateKey] ?? [],
    canRestoreFailedDraft,
    restoreFailedDraft,
  };
}

export type AgentComposer = ReturnType<typeof useAgentComposer>;

function nextPanelId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

function mediaTypeForPath(absolutePath: string): string {
  return absolutePath.toLocaleLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : 'application/octet-stream';
}
