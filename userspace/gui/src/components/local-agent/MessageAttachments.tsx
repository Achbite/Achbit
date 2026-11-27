import { whenPreviewVisible } from './visibleImageReads';
import { useEffect, useRef, useState } from 'react';
import type { FilesystemReference } from '@achbit/protocol';
import { Button, DisclosureSummary, UiIcon } from '../../ui-components';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost, type ConversationHost } from './ConversationHost';
import { useConversationRowState } from './ConversationVirtualRow';
import { ImageReview } from './ImageReview';
import { loadComposerImage } from './ComposerImageAttachment';
import { browserAnnotationCapture } from './browserReview';
import { FileAttachmentCard } from './FileAttachmentCard';
import { isImageAttachment, retainedAttachment } from './attachmentPreview';

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
    label ? references.filter(isImageAttachment) : null]);
  // Retain only the failed read, not blobs/permissions. Scrolling a virtual row back
  // into view must not retry a stale path or interrupt the current composer.
  const [failure, setFailure] = useConversationRowState<{ key: string; reason: string } | null>(`attachment:${reference.referenceId}:failure`, null);
  const error = failure?.key === key ? failure.reason : undefined;
  const [result, setResult] = useState<{ key: string; image: AttachmentImage } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error !== undefined || !trigger.current) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const unobserve = whenPreviewVisible(trigger.current, () => loadMessageAttachmentImage(sessionId, reference, references, host, controller.signal).then(image => {
      if (controller.signal.aborted) { if (image.kind === 'image') image.release?.(); return; }
      if (image.kind === 'image') release = image.release;
      setResult({ key, image });
    }).catch(reason => {
      if (!controller.signal.aborted) {
        setResult(null); setFailure({ key, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    }));
    return () => { unobserve(); controller.abort(); release?.(); };
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
  const preview = <ImageReview lightbox triggerRef={trigger} triggerIdentity={identity} source={url} alt={label ?? reference.displayName}
    className={className} title={label ?? reference.displayName} onError={decodeError}>
    {note ?? (url ? <img src={url} alt={reference.displayName} loading="lazy" decoding="async" onError={decodeError} /> : <UiIcon name="artifact" size={14} />)}
  </ImageReview>;
  return note ? preview : <div className="local-agent__message-image-slot">{preview}</div>;
}

export function MessageAttachments({ sessionId, references, language, onOpen, onError, identity }: {
  sessionId: string; references: FilesystemReference[]; language: UiLanguage; identity(reference: FilesystemReference): Identity;
  onOpen(reference: FilesystemReference): Promise<void>; onError(error: string): void;
}) {
  const annotations = references.filter(isAnnotation);
  const dense = references.filter(isImageAttachment).length > 4;
  return <div className="local-agent__message-attachments" data-dense-images={dense || undefined}>
    {references.map(reference => {
      const open = () => { void onOpen(reference).catch(error => onError(String(error))); };
      const annotation = isAnnotation(reference);
      return annotation || isImageAttachment(reference)
        ? <AttachmentPreview key={reference.referenceId} sessionId={sessionId} reference={reference} references={references}
            label={annotation ? `${language === 'zh-CN' ? '标注' : 'Annotation'} ${annotations.indexOf(reference) + 1}` : undefined}
            language={language} identity={identity(reference)} onOpen={open} />
        : <FileAttachmentCard key={reference.referenceId} attachmentId={reference.referenceId} kind={reference.kind} name={reference.displayName}
            source={retainedAttachment(sessionId, reference)} mediaType={reference.mediaType} byteLength={reference.byteLength}
            language={language} openIdentity={identity(reference)} onClick={open} />;
    })}
  </div>;
}
