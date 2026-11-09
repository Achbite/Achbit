import { useState } from 'react';
import type { QueuedInputProjection } from '@achbit/protocol';
import { Button, IconButton, UiIcon } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import type { UiLanguage } from '../../i18n';

export interface UnappliedRecovery {
  restoredIds: string[];
  resubmittedIds?: readonly string[];
  inDecision: boolean;
  canUndo: boolean;
  restore(inputs: readonly QueuedInputProjection[], append?: boolean): void;
  undo(): void;
}

/** History stays evidence. Recovery writes only the ordinary message draft. */
export function UnappliedInputs({ sessionId, inputs, language, copiedId, onCopy, onOpenReference, recovery }: {
  sessionId: string;
  inputs: readonly QueuedInputProjection[];
  language: UiLanguage;
  copiedId: string | null;
  onCopy(id: string, text: string): void;
  onOpenReference(reference: QueuedInputProjection['filesystemReferences'][number]): void;
  recovery?: UnappliedRecovery;
}) {
  const identity = useUiOwner('conversation.unapplied-inputs', undefined, { sessionId });
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState<QueuedInputProjection[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const history = inputs.filter(input => input.status === 'notApplied'
    && !recovery?.resubmittedIds?.includes(input.commandId)
    && !recovery?.restoredIds.includes(input.commandId));
  if (!history.length) return null;
  const zh = language === 'zh-CN';
  const restore = (items: QueuedInputProjection[], append = false) => {
    try {
      recovery?.restore(items, append);
      setConfirmation(null);
      setFeedback(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === 'composer_restore_append_confirmation') { setConfirmation(items); setFeedback(null); }
      else setFeedback(message === 'message_filesystem_reference_limit'
        ? (zh ? '追加后附件超过 8 个；请先整理草稿，未恢复任何内容。' : 'The merged draft exceeds 8 attachments. Nothing was restored.')
        : message === 'composer_restore_resource_conflict' ? (zh ? '附件的历史版本冲突；请逐条恢复，未追加任何内容。' : 'Attachment versions conflict. Restore messages separately; nothing was appended.') : message);
    }
  };
  return <details className="local-agent__unapplied-inputs" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary aria-label={zh ? '未加入任务的消息' : 'Messages not applied'}>
    <div className="local-agent__continuity-line">
      <UiIcon name="session" size={15} />
      <span>{zh ? `${history.length} 条消息未处理` : `${history.length} unapplied messages`}</span>
      {recovery && <Button size="compact" {...identity.action('restore-all', 'click')}
        onClick={event => { event.preventDefault(); restore(history); }}>{zh ? '恢复到草稿' : 'Restore to draft'}</Button>}
      <Button size="compact" {...identity.action('toggle', 'click')} aria-expanded={expanded}>
        {zh ? '详情' : 'Details'}<span style={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : undefined }}><UiIcon name="chevronDown" size={14} /></span>
      </Button>
    </div>
    {confirmation && <div className="local-agent__continuity-line" role="status">
      <span>{zh ? '草稿已有内容，要追加吗？' : 'The draft has content. Append these messages?'}</span>
      <Button size="compact" {...identity.action('confirm-append', 'click')} onClick={event => { event.preventDefault(); restore(confirmation, true); }}>{zh ? '追加' : 'Append'}</Button>
      <Button size="compact" onClick={event => { event.preventDefault(); setConfirmation(null); }}>{zh ? '取消' : 'Cancel'}</Button>
    </div>}
    {feedback && <div className="local-agent__continuity-line" role="status"><span>{feedback}</span></div>}
    </summary>
    <div>
      <p>{zh ? '原任务已结束。恢复保留文字和附件，不会自动发送。' : 'The original runs ended. Recovery keeps text and attachments without sending.'}</p>
      {history.map(input => <article key={input.commandId} className="local-agent__unapplied-input" data-queued-command={input.commandId}>
        <div className="local-agent__unapplied-input-text">
          {input.text && <pre>{input.text}</pre>}
          {!!input.filesystemReferences.length && <div className="local-agent__message-attachments">{input.filesystemReferences.map(reference => <Button key={reference.referenceId}
            {...identity.action('open-reference', 'click', { commandId: input.commandId, referenceId: reference.referenceId })}
            onClick={() => onOpenReference(reference)}><UiIcon name={reference.kind === 'directory' ? 'folder' : 'file'} size={14} />{reference.displayName}</Button>)}</div>}
          {!!input.pluginSelections.length && <div className="local-agent__unapplied-input-plugins">{input.pluginSelections.map(plugin => <span key={plugin.selectionId}>@{plugin.label}</span>)}</div>}
          {!!input.guidanceReferences?.length && <div className="local-agent__unapplied-input-plugins">{input.guidanceReferences.map(item => <span key={item.referenceId}>{item.label}</span>)}</div>}
        </div>
        <div className="local-agent__continuity-actions">
          {recovery && <Button size="compact"
            {...identity.action('restore', 'click', { commandId: input.commandId })} onClick={() => restore([input])}>{zh ? '恢复' : 'Restore'}</Button>}
          {input.text && <IconButton size="compact" icon={copiedId === `unapplied:${input.commandId}` ? 'check' : 'copy'}
            {...identity.action('copy', 'click', { commandId: input.commandId })}
            aria-label={zh ? '复制未处理消息' : 'Copy unapplied message'} onClick={() => onCopy(`unapplied:${input.commandId}`, input.text)} />}
        </div>
      </article>)}
    </div>
  </details>;
}
