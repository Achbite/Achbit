import type { InteractionProjection } from '@achbit/protocol';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { Button } from '../../ui-components';
import { useConversationRowState } from './ConversationVirtualRow';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { InteractionOptions } from './InteractionOptions';
import { interactionResponseLabel } from './interactionPresentation';
import { submitReplyOnEnter } from './replyKeyboard';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useConversationSessionId } from './ConversationSessionScope';

/** Answers identify the journal question, even while another Provider turn runs. */
export function InteractionCard({ interaction, language, onRespond, disabled = false,
  answerInComposer = false, onFocusComposer, onToggle }: {
  interaction: InteractionProjection; language: UiLanguage;
  onRespond?: (response: string, interactionId: string) => Promise<unknown>;
  disabled?: boolean;
  answerInComposer?: boolean;
  onFocusComposer?: () => void;
  onToggle?: (card: HTMLElement, expanded: boolean) => void;
}) {
  const identity = useUiOwner('conversation.question', undefined, {
    sessionId: useConversationSessionId(), interactionId: interaction.interactionId,
  });
  const respond = useLocalAgentStore(state => state.respondInteraction);
  const [text, setText] = useConversationRowState(`question:${interaction.interactionId}:draft`, '');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const pending = interaction.status === 'pending';
  const foreground = pending && answerInComposer;
  const [expanded, setExpanded] = useConversationRowState(`question:${interaction.interactionId}:expanded`, false);
  const articleRef = useRef<HTMLElement>(null);
  const detailsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (textareaRef.current) resizeReplyInput(textareaRef.current);
  }, [text, pending, interaction.allowFreeform, foreground]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    let previousWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width;
      if (width === previousWidth) return;
      previousWidth = width;
      resizeReplyInput(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [pending, interaction.allowFreeform, foreground]);
  const answer = async (response: string) => {
    if (!pending || sendingRef.current || disabled || !response.trim()) return;
    sendingRef.current = true;
    setSending(true); setError(null);
    try { await (onRespond ?? respond)(response, interaction.interactionId); setText(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { sendingRef.current = false; setSending(false); }
  };
  return <article ref={articleRef} className={`local-agent__question${foreground ? ' local-agent__question--foreground' : ''}`} aria-label={t(language, 'agent.question.title')} aria-busy={sending}>
    {foreground ? <header className="local-agent__question-summary">
      <Button {...identity.action('toggle', 'click')} size="compact" className="local-agent__question-toggle"
        aria-expanded={expanded} aria-controls={detailsId} aria-label={t(language, expanded ? 'agent.question.collapse' : 'agent.question.expand')}
        onClick={() => {
          if (articleRef.current) onToggle?.(articleRef.current, !expanded);
          setExpanded(value => !value);
        }}>
        <AchbitShellIcon name="question" size={16} />
        <span><MarkdownInline>{interaction.prompt}</MarkdownInline></span>
        <AchbitShellIcon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
      </Button>
      <Button {...identity.action('focus-answer', 'click')} size="compact" onClick={onFocusComposer}>
        {t(language, 'agent.question.answerInComposer')}
      </Button>
    </header> : <header>
      <span>{t(language, pending ? interaction.kind === 'confirmation' ? 'agent.interaction.confirmation' : 'agent.interaction.question' : `agent.question.${interaction.status}`)}</span>
      {pending && interaction.allowFreeform && <button {...identity.action('skip', 'click')} className="local-agent__question-skip" type="button" disabled={sending || disabled}
        onClick={() => { void answer(t(language, 'agent.interaction.skip')); }}>{t(language, 'agent.interaction.skip')}</button>}
    </header>}
    <div id={detailsId} hidden={foreground && !expanded}>
      <MarkdownContent decisionProse>{interaction.prompt}</MarkdownContent>
      {foreground && !!interaction.options?.length && <ol className="local-agent__question-readonly-options">
        {interaction.options.map(option => <li key={option.id}>
          <MarkdownInline>{option.label}</MarkdownInline>
          {option.description && <span className="local-agent__question-description"><MarkdownInline>{option.description}</MarkdownInline></span>}
        </li>)}
      </ol>}
    </div>
    {pending && !foreground && <>
      <InteractionOptions interactionId={interaction.interactionId} surface="card" options={interaction.options} disabled={sending || disabled} onAnswer={response => { void answer(response); }} />
      {interaction.allowFreeform && <form className="local-agent__question-form" onSubmit={event => { event.preventDefault(); void answer(text); }}>
        <span className="local-agent__question-input-mark" aria-hidden="true"><AchbitShellIcon name="compose" size={16} /></span>
        <textarea {...identity.action('input', 'type')} ref={textareaRef} aria-label={t(language, 'agent.question.answer')} placeholder={t(language, 'agent.composer.placeholder.interaction')} value={text} disabled={sending || disabled}
          onChange={event => setText(event.target.value)} onKeyDown={submitReplyOnEnter} rows={1} />
        <button {...identity.action('submit', 'click')} type="submit" disabled={sending || disabled || !text.trim()}>{t(language, 'agent.question.answer')}</button>
      </form>}
    </>}
    {interaction.status === 'answered' && <p className="local-agent__question-answer">{interactionResponseLabel(interaction, interaction.response ?? '')}</p>}
    {error && <p role="alert">{error}</p>}
  </article>;
}

function resizeReplyInput(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}
