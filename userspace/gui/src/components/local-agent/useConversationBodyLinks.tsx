import { createContext, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useConversationHost, type ConversationHost } from './ConversationHost';
import { documentFormat, imageMediaType, workspaceResourceLink } from './documentResources';
import { bindLocalTarget, parseLocalTarget, resolveLocalTargets, type ResolvedLocalTarget, type SourcePosition } from './resourceLinks';
import { artifactReaderTarget, requestReader, type ReaderTarget } from './readerState';
import { ResourceLinkChoices } from './ResourceLinkChoices';

export const ConversationBodyLinkScope = createContext<((event: MouseEvent<HTMLElement>) => void) | null>(null);

export async function openBoundResource(host: ConversationHost, sessionId: string, workspaceId: string,
  logicalPath: string, position: SourcePosition | undefined, current: () => boolean, openReader: (target: ReaderTarget) => void) {
  const resource = await host.resolveResource(sessionId, workspaceId, logicalPath);
  if (!current()) return;
  if (resource.kind === 'directory') {
    if (!host.locatePath) throw new Error('Directory opening requires the desktop Host.');
    return host.locatePath(resource.path);
  }
  if (useSettingsStore.getState().effectiveSettings['gui.defaultFileOpen'] === 'vscode' &&
      documentFormat(logicalPath) !== 'pdf' && !imageMediaType(logicalPath)) {
    if (!host.openFile) throw new Error('Open in VS Code is unavailable in this Host.');
    return host.openFile(resource.path, position);
  }
  openReader({ kind: 'workspace', workspaceId, logicalPath, canonicalPath: resource.path, line: position?.line, column: position?.column });
}

export function useConversationBodyLinks(projection: SessionProjection | null, language: UiLanguage,
  setError: (message: string | null) => void, revealUnbound = false) {
  const host = useConversationHost();
  const requestId = useRef(0);
  const [choices, setChoices] = useState<{ sessionId: string; id: number; targets: ResolvedLocalTarget[] } | null>(null);
  useLayoutEffect(() => {
    setChoices(null);
    return () => { requestId.current++; };
  }, [projection?.sessionId]);

  const openBound = (sessionId: string, workspaceId: string, logicalPath: string, id: number, position?: SourcePosition) =>
    openBoundResource(host, sessionId, workspaceId, logicalPath, position, () => id === requestId.current,
      target => requestReader(sessionId, target));
  const failure = (id: number, error: unknown, path?: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (id === requestId.current) setError(path ? [t(language, 'agent.link.unableToOpen'), path, message].join('\n') : message);
  };
  const open = (event: MouseEvent<HTMLElement>) => {
    if (!projection || event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    const local = parseLocalTarget(href);
    const resource = workspaceResourceLink(href);
    if (!local && !resource && !href.startsWith('artifact://') && !/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    const id = ++requestId.current;
    const { sessionId } = projection;
    setChoices(null);
    const navigate = async () => {
      if (local) {
        const workspaces = new Set([...projection.workspaceBindings.map(binding => binding.workspaceId),
          ...projection.messages.flatMap(message => message.filesystemReferences.map(reference => reference.workspaceId))]);
        const roots = await Promise.all([...workspaces].map(async workspaceId => ({ workspaceId,
          root: (await host.resolveResource(sessionId, workspaceId, '.')).path })));
        if (id !== requestId.current) return;
        if (revealUnbound && local.absolute && !bindLocalTarget(local, roots)) {
          if (!host.locatePath) throw new Error('Manual file location requires the desktop Host.');
          return host.locatePath(local.path);
        }
        const targets = await resolveLocalTargets(local, roots, (workspaceId, path) => host.resolveResource(sessionId, workspaceId, path));
        if (id !== requestId.current) return;
        if (targets.length > 1) setChoices({ sessionId, id, targets });
        else await openBound(sessionId, targets[0].workspaceId, targets[0].logicalPath, id, targets[0]);
      } else if (resource) {
        await openBound(sessionId, resource.workspaceId, resource.logicalPath, id);
      } else if (href.startsWith('artifact://')) {
        const artifact = projection.artifacts.find(item => item.artifactId === href.slice('artifact://'.length));
        if (!artifact) throw new Error(t(language, 'reader.artifactMissing'));
        if (artifact.contentMode === 'fixed') requestReader(sessionId, artifactReaderTarget(artifact));
        else if (artifact.uri && /^https?:\/\//i.test(artifact.uri)) await host.openExternalLink(artifact.uri);
        else if (artifact.workspaceId && artifact.logicalPath) await openBound(sessionId, artifact.workspaceId, artifact.logicalPath, id);
      } else await host.openExternalLink(href);
    };
    void navigate().then(() => { if (id === requestId.current) setError(null); }).catch(error => failure(id, error, local?.path));
  };
  const selection = choices && choices.sessionId === projection?.sessionId && <ResourceLinkChoices
    language={language} targets={choices.targets} onClose={() => setChoices(null)}
    onSelect={target => {
      setChoices(null);
      if (choices.id !== requestId.current) return;
      void openBound(choices.sessionId, target.workspaceId, target.logicalPath, choices.id, target)
        .catch(error => failure(choices.id, error, target.path));
    }} />;
  return { open, selection };
}
