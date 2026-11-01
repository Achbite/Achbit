import type { MessageFeedback, ProjectionMessage } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useConversationSessionId } from './ConversationSessionScope';

/** Shared message chrome; clipboard and Session commands stay with their owner. */
export function MessageActions({ message, language, copied, busy, canEdit, onCopy, onFeedback, onEdit }: {
  message: ProjectionMessage;
  language: UiLanguage;
  copied: boolean;
  busy: boolean;
  canEdit: boolean;
  onCopy(): void;
  onFeedback(feedback: MessageFeedback | null): void;
  onEdit(): void;
}) {
  const identity = useUiOwner('conversation.message-actions', undefined, {
    sessionId: useConversationSessionId(), messageId: message.messageId,
  });
  const copyLabel = t(language, copied ? 'agent.message.copied'
    : message.role === 'user' ? 'agent.message.copyMessage' : 'agent.message.copyResponse');
  return <div className="local-agent__message-actions" role="group" aria-label={t(language, 'agent.message.actions')}>
    <button {...identity.action('copy', 'click')} type="button" className="conversation-copy-button" aria-label={copyLabel} title={copyLabel} onClick={onCopy}>
      <AchbitShellIcon name={copied ? 'check' : 'copy'} />
      <span className="conversation-copy-hint" role="status">{t(language, copied ? 'agent.message.copied' : 'agent.message.copy')}</span>
    </button>
    {message.role === 'user' && !message.replyToInteraction && !message.runId && <button {...identity.action('edit', 'click')} type="button"
      aria-label={t(language, 'agent.message.edit')} title={t(language, canEdit ? 'agent.message.edit' : 'agent.message.editWait')}
      disabled={!canEdit} onClick={onEdit}>
      <AchbitShellIcon name="compose" />
    </button>}
    {message.role === 'assistant' && (['up', 'down'] as const).map((feedback) => {
      const label = t(language, feedback === 'up' ? 'agent.message.helpful' : 'agent.message.notHelpful');
      return <button {...identity.action('feedback', 'click', { feedback })} key={feedback} type="button" className={message.feedback === feedback ? 'is-selected' : ''}
        aria-pressed={message.feedback === feedback} aria-label={label} title={label} disabled={busy}
        onClick={() => onFeedback(message.feedback === feedback ? null : feedback)}>
        <AchbitShellIcon name={feedback === 'up' ? 'thumbUp' : 'thumbDown'} />
      </button>;
    })}
  </div>;
}
