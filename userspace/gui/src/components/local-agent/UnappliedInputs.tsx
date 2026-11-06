import type { QueuedInputProjection } from '@achbit/protocol';
import { Button, IconButton, UiIcon } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import type { UiLanguage } from '../../i18n';

/** Terminal inputs remain journal evidence, not an active composer queue or new messages. */
export function UnappliedInputs({ sessionId, inputs, language, copiedId, onCopy, onOpenReference }: {
  sessionId: string;
  inputs: readonly QueuedInputProjection[];
  language: UiLanguage;
  copiedId: string | null;
  onCopy(id: string, text: string): void;
  onOpenReference(reference: QueuedInputProjection['filesystemReferences'][number]): void;
}) {
  const identity = useUiOwner('conversation.unapplied-inputs', undefined, { sessionId });
  const history = inputs.filter(input => input.status === 'notApplied');
  if (!history.length) return null;
  const chinese = language === 'zh-CN';
  return <details className="local-agent__unapplied-inputs">
    <summary {...identity.action('toggle', 'click')}>
      <UiIcon name="session" size={15} />
      <span>{chinese ? '未加入任务的消息' : 'Messages not applied'}</span>
      <small>{history.length}</small>
      <UiIcon name="chevronDown" size={14} />
    </summary>
    <p>{chinese ? '原任务已结束，以下内容未被处理。内容和附件仍保留，不会自动发送。' : 'The original runs ended before these inputs were applied. Their text and attachments are retained; nothing is sent automatically.'}</p>
    {history.map(input => <article key={input.commandId} className="local-agent__unapplied-input" data-queued-command={input.commandId}>
      <div className="local-agent__unapplied-input-text">
        {input.text && <pre>{input.text}</pre>}
        {!!input.filesystemReferences.length && <div className="local-agent__message-attachments">{input.filesystemReferences.map(reference => <Button key={reference.referenceId}
          {...identity.action('open-reference', 'click', { commandId: input.commandId, referenceId: reference.referenceId })}
          onClick={() => onOpenReference(reference)}><UiIcon name={reference.kind === 'directory' ? 'folder' : 'file'} size={14} />{reference.displayName}</Button>)}</div>}
        {!!input.pluginSelections.length && <div className="local-agent__unapplied-input-plugins">{input.pluginSelections.map(plugin => <span key={plugin.selectionId}>@{plugin.label}</span>)}</div>}
      </div>
      {input.text && <IconButton size="compact" icon={copiedId === `unapplied:${input.commandId}` ? 'check' : 'copy'}
        {...identity.action('copy', 'click', { commandId: input.commandId })}
        aria-label={chinese ? '复制未处理消息' : 'Copy unapplied message'} onClick={() => onCopy(`unapplied:${input.commandId}`, input.text)} />}
    </article>)}
  </details>;
}
