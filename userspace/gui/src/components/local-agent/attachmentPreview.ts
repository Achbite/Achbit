import type { FilesystemReference } from '@achbit/protocol';
import type { ConversationHost } from './ConversationHost';
import { documentFormat, imageMediaType, readDocumentText } from './documentResources';
import { loadInterfaceModule } from '../../services/interfaceUpdates';

/** A picker selection has no Session authority. A retained reference never becomes a picker path. */
export type AttachmentSource = { path: string } | { sessionId: string | null; workspaceId: string; logicalPath: string };
export const retainedAttachment = (sessionId: string | null, ref: FilesystemReference): AttachmentSource =>
  ({ sessionId, workspaceId: ref.workspaceId, logicalPath: ref.logicalPath });
export const attachmentPath = (source: AttachmentSource) => 'path' in source ? source.path : source.logicalPath;
export const attachmentName = (path: string) => path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || path;

export const isImageAttachment = (ref: FilesystemReference) => ref.kind === 'file'
  && (ref.mediaType.startsWith('image/') || !!imageMediaType(ref.logicalPath));

export type ThumbnailFormat = 'text' | 'html' | 'pdf' | 'binary';
export function thumbnailFormat(path: string, mediaType = ''): ThumbnailFormat {
  const format = documentFormat(path, mediaType);
  if (format === 'pdf' || format === 'html') return format;
  if (format === 'markdown' || mediaType.startsWith('text/')) return 'text';
  if (/\.(?:zip|7z|gz|tar|rar|exe|dll|dylib|wasm|woff2?|ttf|mp[34]|mov|docx?|xlsx?|pptx?)$/iu.test(path)
    || /^(?:audio|video|font)\//u.test(mediaType)) return 'binary';
  return 'text'; // Let the bounded, strict decoder decide for unknown and extensionless files.
}

export type AttachmentThumbnail = { kind: 'text'; text: string } | { kind: 'page'; image: string }
  | { kind: 'large' | 'unsupported' };

function textExcerpt(source: string, format: ThumbnailFormat): string {
  if (format === 'html') {
    // Template contents are inert (including images, styles and custom elements).
    // Only text leaves this fragment; never attach the uploaded DOM to the composer.
    const template = document.createElement('template');
    template.innerHTML = source;
    template.content.querySelectorAll('script,style,noscript,template,iframe,svg,[hidden]').forEach(n => n.remove());
    template.content.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,br,title,section').forEach(n => n.after('\n'));
    source = template.content.textContent ?? '';
  }
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(source)) throw new Error('file_encoding_unsupported');
  return source.trimStart().slice(0, 1200);
}

/** Budget automatic previews separately from an explicit open. Known large/binary files need no read. */
export async function readAttachmentThumbnail(host: ConversationHost, source: AttachmentSource, format: ThumbnailFormat,
  byteLength: number | undefined, signal: AbortSignal): Promise<AttachmentThumbnail> {
  signal.throwIfAborted();
  if (format === 'binary') return { kind: 'unsupported' };
  const limit = format === 'pdf' ? 2 * 1024 * 1024 : 256 * 1024;
  if (byteLength !== undefined && byteLength > limit) return { kind: 'large' };
  let blob: Blob;
  if ('path' in source) {
    if (!host.readLocalFile) throw new Error('Local file reading requires the desktop Host.');
    blob = await host.readLocalFile(source.path);
  } else {
    if (!source.sessionId) throw new Error('conversation_session_required');
    const ref = { workspaceId: source.workspaceId, logicalPath: source.logicalPath };
    if (format === 'text') {
      const result = await host.resources.readResourceReference(source.sessionId, ref, signal);
      signal.throwIfAborted();
      return { kind: 'text', text: textExcerpt(result.content, format) };
    }
    blob = await host.resources.readResourceBlob(source.sessionId, ref, 'document', signal);
  }
  signal.throwIfAborted();
  if (blob.size > limit) return { kind: 'large' };
  if (format === 'pdf') {
    const { pdfFirstPage } = await loadInterfaceModule(() => import('./pdfPageThumbnail'));
    return { kind: 'page', image: await pdfFirstPage(blob, signal) };
  }
  const text = await readDocumentText(blob);
  signal.throwIfAborted();
  return { kind: 'text', text: textExcerpt(text, format) };
}
