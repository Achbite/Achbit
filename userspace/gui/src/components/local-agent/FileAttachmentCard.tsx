import { useEffect, useRef, useState } from 'react';
import { Button, CloseButton, UiIcon } from '../../ui-components';
import { localizedError, t, type UiLanguage } from '../../i18n';
import { useConversationHost } from './ConversationHost';
import { useConversationRowState } from './ConversationVirtualRow';
import { whenPreviewVisible } from './visibleImageReads';
import { attachmentPath, readAttachmentThumbnail, thumbnailFormat, type AttachmentSource, type AttachmentThumbnail } from './attachmentPreview';
import { formatBytes } from './conversationFormatting';
import './fileAttachmentCard.css';

type Identity = Readonly<Record<`data-ui-${string}`, string>>;
interface FileAttachmentProps {
  attachmentId: string; source: AttachmentSource; kind: 'file' | 'directory'; name: string;
  language: UiLanguage; mediaType?: string; byteLength?: number; openIdentity: Identity; removeIdentity?: Identity;
  onClick(): void; onRemove?(): void;
}

/** The thumbnail and the separate remove action share a frame, never a button. */
export function FileAttachmentCard({ attachmentId, source, kind, name, language, mediaType, byteLength,
  openIdentity, removeIdentity, onClick, onRemove }: FileAttachmentProps) {
  const host = useConversationHost(), trigger = useRef<HTMLButtonElement>(null);
  const path = attachmentPath(source), format = thumbnailFormat(path, mediaType), folder = kind === 'directory';
  const key = JSON.stringify([source, kind, format, byteLength]);
  const [loaded, setLoaded] = useState<{ key: string; thumbnail: AttachmentThumbnail } | null>(null);
  const [failed, setFailed] = useConversationRowState<{ key: string; reason: string } | null>(`file-card:${attachmentId}:failure`, null);
  const failure = failed?.key === key ? failed : null;
  useEffect(() => {
    if (folder || failure || !trigger.current) return;
    const controller = new AbortController();
    const stop = whenPreviewVisible(trigger.current, async () => {
      try {
        const thumbnail = await readAttachmentThumbnail(host, source, format, byteLength, controller.signal);
        if (!controller.signal.aborted) setLoaded({ key, thumbnail });
      } catch (reason) {
        if (!controller.signal.aborted) setFailed({ key, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    });
    return () => { stop(); controller.abort(); };
  }, [host, key, failure, setFailed]);
  const thumbnail = loaded?.key === key ? loaded.thumbnail : null;
  const zh = language === 'zh-CN';
  const type = folder ? (zh ? '文件夹' : 'Folder') : format === 'pdf' ? 'PDF' : format === 'html' ? 'HTML'
    : /\.([a-z\d]{1,10})$/iu.exec(path)?.[1].toUpperCase() ?? (mediaType === 'text/plain' ? 'TXT' : zh ? '文件' : 'File');
  const status = failure ? (zh ? '无法预览' : 'Preview unavailable') : thumbnail?.kind === 'large' ? (zh ? '文件较大' : 'Large file')
    : thumbnail?.kind === 'unsupported' ? (zh ? '无缩略图' : 'No thumbnail') : thumbnail?.kind === 'text' && !thumbnail.text ? (zh ? '无可预览文本' : 'No text to preview') : null;
  const detail = [type, byteLength !== undefined ? formatBytes(byteLength, language) : null].filter(Boolean).join(' · ');
  const title = [path || name, detail, failure ? localizedError(language, failure.reason) : status].filter(Boolean).join('\n');
  return <div className="attachment-card" data-attachment-id={attachmentId} data-kind={kind} data-format={folder ? undefined : format}
    data-preview-state={folder ? undefined : failure ? 'error' : thumbnail?.kind ?? 'loading'}>
    <Button ref={trigger} {...openIdentity} className="attachment-card__open" onClick={onClick} title={title}
      aria-label={`${zh ? '打开' : 'Open'} ${name} · ${detail}${status ? ' · ' + status : ''}`}>
      {folder ? <span className="attachment-card__folder"><UiIcon name="folder" size={22} /></span>
        : <span className="attachment-card__page" aria-hidden="true">
          {thumbnail?.kind === 'page' ? <img alt="" src={thumbnail.image} /> : thumbnail?.kind === 'text' && thumbnail.text ? <span className="attachment-card__excerpt">{thumbnail.text}</span>
            : <span className="attachment-card__placeholder"><UiIcon name="file" size={20} /><small>{status ?? (zh ? '读取预览…' : 'Loading preview…')}</small></span>}
        </span>}
      <span className="attachment-card__caption">{!folder && <UiIcon name="file" size={14} />}<strong dir="auto">{name}</strong>
        {folder && <small>{type}</small>}</span>
    </Button>
    {onRemove && <CloseButton {...removeIdentity} className="attachment-card__remove" size="compact" variant="secondary"
      aria-label={t(language, 'agent.attachment.remove', { name })} onClick={onRemove} />}
  </div>;
}
