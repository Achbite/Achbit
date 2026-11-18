import { useEffect, useState } from 'react';
import type { FilesystemReference } from '@achbit/protocol';
import { Button, DisclosureSummary, UiIcon } from '../../ui-components';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost, type ConversationHost } from './ConversationHost';
import { useConversationRowState } from './ConversationVirtualRow';
import { ImageReview } from './ImageReview';
import { loadComposerImage } from './ComposerImageAttachment';
import { browserAnnotationCapture } from './browserReview';
import { formatBytes } from './conversationFormatting';

type Identity = Readonly<Record<`data-ui-${string}`, string>>;
const isAnnotation = (reference: FilesystemReference) => reference.kind === 'file'
  && reference.source === 'pastedText' && ['浏览器批注', 'Browser annotation'].includes(reference.displayName);

type AttachmentImage = { kind: 'text' } | { kind: 'image'; url: string; release?(): void };

/** Read through the message's resource handles, never through the quoted capture path. */
export async function loadMessageAttachmentImage(sessionId: string, reference: FilesystemReference,
  references: FilesystemReference[], host: ConversationHost, signal: AbortSignal): Promise<AttachmentImage> {
  signal.throwIfAborted();
  let capture = reference;
  if (isAnnotation(reference)) {
    const text = await host.resources.readResourceReference(sessionId,
      { workspaceId: reference.workspaceId, logicalPath: reference.logicalPath }, signal);
    signal.throwIfAborted();
    const associated = browserAnnotationCapture(text.content, references);
    if (!associated) return { kind: 'text' };
    capture = associated;
  }
  return { kind: 'image', ...await loadComposerImage({ sessionId, workspaceId: capture.workspaceId, logicalPath: capture.logicalPath }, host, signal) };
}

function AttachmentPreview({ sessionId, reference, references, language, label, identity, onOpen }: {
  sessionId: string; reference: FilesystemReference; references: FilesystemReference[]; language: UiLanguage;
  label?: string; identity: Identity; onOpen(): void;
}) {
  const host = useConversationHost();
  const key = JSON.stringify([sessionId, reference,
    label ? references.filter(item => item.kind === 'file' && item.mediaType.startsWith('image/')) : null]);
  // Retain only the failed read, not blobs/permissions. Scrolling a virtual row back
  // into view must not retry a stale path or interrupt the current composer.
  const [failure, setFailure] = useConversationRowState<{ key: string; reason: string } | null>(`attachment:${reference.referenceId}:failure`, null);
  const error = failure?.key === key ? failure.reason : undefined;
  const [result, setResult] = useState<{ key: string; image: AttachmentImage } | null>(null);
  useEffect(() => {
    if (error !== undefined) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadMessageAttachmentImage(sessionId, reference, references, host, controller.signal).then(image => {
      if (controller.signal.aborted) { if (image.kind === 'image') image.release?.(); return; }
      if (image.kind === 'image') release = image.release;
      setResult({ key, image });
    }).catch(reason => {
      if (!controller.signal.aborted) {
        setResult(null); setFailure({ key, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    });
    return () => { controller.abort(); release?.(); };
    // Streaming and unrelated projection updates must not restart resource reads.
  }, [host, key, error, setFailure]);
  const current = result?.key === key ? result : null;
  const className = label ? 'local-agent__message-note' : 'local-agent__message-image';
  const note = label ? <><UiIcon name="compose" size={12} /><span>{label}</span></> : undefined;
  if (current?.image?.kind === 'text') return <Button {...identity} size="compact" className={className}
    title={reference.displayName} onClick={onOpen}>{note}</Button>;
  if (error !== undefined) return <details className="local-agent__attachment-unavailable">
    <DisclosureSummary title={reference.displayName}>{label ?? reference.displayName} · {language === 'zh-CN' ? '预览不可用' : 'Preview unavailable'}</DisclosureSummary>
    <p>{error}</p>
    <Button size="compact" onClick={() => setFailure(null)}>{language === 'zh-CN' ? '重试预览' : 'Retry preview'}</Button>
    <Button {...identity} size="compact" onClick={onOpen}>{language === 'zh-CN' ? '打开原引用' : 'Open original reference'}</Button>
  </details>;
  const url = current?.image.kind === 'image' ? current.image.url : undefined;
  const decodeError = () => { setResult(null); setFailure({ key, reason: t(language, 'content.image.decodeError') }); };
  return <ImageReview triggerIdentity={identity} source={url} alt={label ?? reference.displayName}
    className={className} title={label ?? reference.displayName} onError={decodeError}>
    {note ?? (url ? <img src={url} alt={reference.displayName} loading="lazy" onError={decodeError} />
      : <UiIcon name="artifact" size={14} />)}
  </ImageReview>;
}

export function MessageAttachments({ sessionId, references, language, onOpen, onError, identity }: {
  sessionId: string; references: FilesystemReference[]; language: UiLanguage; identity(reference: FilesystemReference): Identity;
  onOpen(workspaceId: string, logicalPath: string): Promise<void>; onError(error: string): void;
}) {
  const annotations = references.filter(isAnnotation);
  return <div className="local-agent__message-attachments">
    {references.map(reference => {
      const open = () => { void onOpen(reference.workspaceId, reference.logicalPath).catch(error => onError(String(error))); };
      const annotation = isAnnotation(reference);
      return annotation || reference.kind === 'file' && reference.mediaType.startsWith('image/')
        ? <AttachmentPreview key={reference.referenceId} sessionId={sessionId} reference={reference} references={references}
            label={annotation ? `${language === 'zh-CN' ? '标注' : 'Annotation'} ${annotations.indexOf(reference) + 1}` : undefined}
            language={language} identity={identity(reference)} onOpen={open} />
        : <Button key={reference.referenceId} {...identity(reference)} size="compact"
            className={`local-agent__message-file${reference.kind === 'directory' ? ' local-agent__message-directory' : ''}`}
            title={reference.displayName} onClick={open}>
            <UiIcon name={reference.kind === 'directory' ? 'folder' : 'artifact'} size={14} /><span>{reference.displayName}</span>
            {reference.kind === 'file' && <small>{reference.source === 'pastedText' ? 'TXT · ' : ''}{formatBytes(reference.byteLength, language)}</small>}
          </Button>;
    })}
  </div>;
}
