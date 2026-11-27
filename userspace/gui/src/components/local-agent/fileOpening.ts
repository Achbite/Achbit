import { useSettingsStore } from '../../state/settingsStore';
import type { AttachmentSource } from './attachmentPreview';
import type { ConversationHost } from './ConversationHost';
import type { ReaderFileTarget } from './readerState';
import type { SourcePosition } from './resourceLinks';

export type OpenAttachment = (source: AttachmentSource, kind: 'directory' | 'file', mediaType?: string) => Promise<void>;

export async function openDirectory(host: ConversationHost, path: string) {
  if (!host.locatePath) throw new Error('Directory opening requires the desktop Host.');
  await host.locatePath(path);
}

export async function openPreferredFile(host: ConversationHost, path: string, target: ReaderFileTarget,
  openReader: (target: ReaderFileTarget) => void, position?: SourcePosition, readerOnly = false) {
  if (!readerOnly && useSettingsStore.getState().effectiveSettings['gui.defaultFileOpen'] === 'vscode') {
    if (!host.openFile) throw new Error('Open in VS Code is unavailable in this Host.');
    await host.openFile(path, position);
  } else openReader(target);
}

/** Resolve only a clicked original. Never turn a retained logical path into a physical picker read. */
export async function openFilesystemAttachment(host: ConversationHost, source: AttachmentSource, kind: 'file' | 'directory',
  openReader: (target: ReaderFileTarget) => void, current: () => boolean, mediaType?: string) {
  if (!current()) return;
  if ('path' in source) {
    if (kind === 'directory') return openDirectory(host, source.path);
    const path = await host.selectedFilePath(source.path);
    if (current()) await openPreferredFile(host, path, { kind: 'file', path: source.path, canonicalPath: path }, openReader);
  } else {
    const { sessionId, workspaceId, logicalPath } = source;
    if (!sessionId) throw new Error('conversation_session_required');
    const resource = await host.resolveResource(sessionId, workspaceId, logicalPath);
    if (!current()) return;
    if (resource.kind !== kind) throw new Error('attachment_kind_changed: ' + logicalPath);
    if (kind === 'directory') return openDirectory(host, resource.path);
    await openPreferredFile(host, resource.path, { kind: 'workspace', workspaceId, logicalPath,
      canonicalPath: resource.path, ...(mediaType && { mediaType }) }, openReader);
  }
}
