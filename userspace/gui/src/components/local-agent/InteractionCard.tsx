import type { InteractionProjection } from '@deepcode/protocol';
import { useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { MarkdownContent } from './BufferedMarkdown';
import { useConversationRowState } from './ConversationVirtualRow';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { InteractionOptions } from './InteractionOptions';
import { interactionResponseLabel } from './interactionPresentation';

/** Answers identify the journal question, even while another Provider turn runs. */
export function InteractionCard({ interaction, language, answerInComposer = false }: {
  interaction: InteractionProjection; language: UiLanguage; answerInComposer?: boolean;
}) {
  const respond = useLocalAgentStore(state => state.respondInteraction);
  const [text, setText] = useConversationRowState(`question:${interaction.interactionId}:draft`, '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = interaction.status === 'pending' && !answerInComposer;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (textareaRef.current) resizeReplyInput(textareaRef.current);
  }, [text, pending, interaction.allowFreeform]);
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
  }, [pending, interaction.allowFreeform]);
  const answer = async (response: string) => {
    if (!pending || sending || !response.trim()) return;
    setSending(true); setError(null);
    try { await respond(response, interaction.interactionId); setText(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };
  if (answerInComposer && interaction.status === 'pending') {
    return <button type="button" className="local-agent__question-link" aria-controls="conversation-interaction"
      onClick={() => document.getElementById('conversation-interaction')?.focus({ preventScroll: true })}>
      <DeepCodeShellIcon name="question" size={16} />{t(language, 'agent.question.open')}
    </button>;
  }
  return <article className="local-agent__question" aria-label={t(language, 'agent.question.title')} aria-busy={sending}>
    <header>
      <span>{t(language, pending ? interaction.kind === 'confirmation' ? 'agent.interaction.confirmation' : 'agent.interaction.question' : `agent.question.${interaction.status}`)}</span>
      {pending && interaction.allowFreeform && <button className="local-agent__question-skip" type="button" disabled={sending}
        onClick={() => { void answer(t(language, 'agent.interaction.skip')); }}>{t(language, 'agent.interaction.skip')}</button>}
    </header>
    <MarkdownContent decisionProse>{interaction.prompt}</MarkdownContent>
    {pending && <>
      <InteractionOptions options={interaction.options} disabled={sending} onAnswer={response => { void answer(response); }} />
      {interaction.allowFreeform && <form className="local-agent__question-form" onSubmit={event => { event.preventDefault(); void answer(text); }}>
        <span className="local-agent__question-input-mark" aria-hidden="true"><DeepCodeShellIcon name="compose" size={16} /></span>
        <textarea ref={textareaRef} aria-label={t(language, 'agent.question.answer')} placeholder={t(language, 'agent.composer.placeholder.interaction')} value={text} disabled={sending}
          onChange={event => setText(event.target.value)} rows={1} />
        <button type="submit" disabled={sending || !text.trim()}>{t(language, 'agent.question.answer')}</button>
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
