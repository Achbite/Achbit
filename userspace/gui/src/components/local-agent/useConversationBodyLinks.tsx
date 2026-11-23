import { createContext, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import { useConversationHost, type ConversationHost } from './ConversationHost';
import { documentFormat, imageMediaType, workspaceResourceLink } from './documentResources';
import { bindLocalTarget, parseLocalTarget, relativeToDocument, resolveLinkRoots, resolveLocalTargets, type ResolvedLocalTarget, type SourcePosition } from './resourceLinks';
import { artifactReaderTarget, requestReader, type ReaderTarget } from './readerState';
import type { ResourceReference } from '../../services/conversationResources';
import { getLocalAgentProjection } from '../../services/localAgentApi';
import { ResourceLinkChoices } from './ResourceLinkChoices';

export const ConversationBodyLinkScope = createContext<((event: MouseEvent<HTMLElement>) => void) | null>(null);

export async function openBoundResource(host: ConversationHost, sessionId: string, workspaceId: string,
  logicalPath: string, position: SourcePosition | undefined, current: () => boolean, openReader: (target: ReaderTarget) => void) {
  const resource = await host.resolveResource(sessionId, workspaceId, logicalPath);
  if (current()) return openResolvedResource(host, { ...resource, workspaceId, logicalPath, ...position }, openReader);
}

async function openResolvedResource(host: ConversationHost, resource: ResolvedLocalTarget, openReader: (target: ReaderTarget) => void) {
  const { workspaceId, logicalPath, line, column } = resource;
  if (resource.kind === 'directory') {
    if (!host.locatePath) throw new Error('Directory opening requires the desktop Host.');
    return host.locatePath(resource.path);
  }
  if (useSettingsStore.getState().effectiveSettings['gui.defaultFileOpen'] === 'vscode' &&
      documentFormat(logicalPath) !== 'pdf' && !imageMediaType(logicalPath)) {
    if (!host.openFile) throw new Error('Open in VS Code is unavailable in this Host.');
    return host.openFile(resource.path, { line, column });
  }
  openReader({ kind: 'workspace', workspaceId, logicalPath, canonicalPath: resource.path, line, column,
    ...(resource.fragment && { fragment: resource.fragment }) });
}

type ReaderLinkSource = { sessionId: string; document: { path?: string; reference?: ResourceReference } };

type WindowLinkSource = { sessionId: string; resolveProjection(): Promise<SessionProjection> };
export function useConversationBodyLinks(source: SessionProjection | ReaderLinkSource | WindowLinkSource | null, language: UiLanguage,
  setError: (message: string | null) => void, revealUnbound = false) {
  const host = useConversationHost();
  const document = source && 'document' in source ? source.document : null;
  const projection = source && 'workspaceBindings' in source ? source : null;
  const requestId = useRef(0);
  const [choices, setChoices] = useState<{ sessionId: string; id: number; targets: ResolvedLocalTarget[] } | null>(null);
  useLayoutEffect(() => {
    setChoices(null);
    return () => { requestId.current++; };
  }, [source?.sessionId, document?.path, document?.reference?.logicalPath]);

  const openBound = (sessionId: string, workspaceId: string, logicalPath: string, id: number, position?: SourcePosition) =>
    openBoundResource(host, sessionId, workspaceId, logicalPath, position, () => id === requestId.current,
      target => requestReader(sessionId, target));
  const failure = (id: number, error: unknown, path?: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (id === requestId.current) setError(path ? [t(language, 'agent.link.unableToOpen'), path, message].join('\n') : message);
  };
  const open = (event: MouseEvent<HTMLElement>) => {
    if (!source || event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href.trim()) { event.preventDefault(); return; }
    const local = parseLocalTarget(href, true, !!document);
    const resource = workspaceResourceLink(href);
    if (!local && !resource && !href.startsWith('artifact://') && !/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    const id = ++requestId.current;
    const { sessionId } = source;
    setChoices(null);
    setError(null); // Withdraw the previous click's feedback; the new Host operation has not completed.
    const displayed = useLocalAgentStore.getState().projection;
    const navigate = async () => {
      const owner = projection ?? (displayed?.sessionId === sessionId ? displayed :
        'resolveProjection' in source && (local || href.startsWith('artifact://')) ? await source.resolveProjection() : null);
      if (id !== requestId.current) return;
      if (local) {
        const reference = document?.reference;
        let target = local;
        if (document && !local.absolute) {
          const path = document.path ?? (reference && (await host.resources.resolveResourceReference(sessionId, reference)).path);
          if (!path) throw new Error('The document has no local directory.');
          target = relativeToDocument(local, path);
        }
        const workspaces = new Set(owner?.workspaceBindings.map(binding => binding.workspaceId));
        for (const message of owner?.messages ?? []) {
          for (const ref of message.filesystemReferences) workspaces.add(ref.workspaceId);
        }
        if (reference && 'workspaceId' in reference) workspaces.add(reference.workspaceId);
        else if (document && !owner) {
          const accessible = await host.resources.listResourceRoots(sessionId);
          for (const entry of accessible) {
            if (entry.kind !== 'file' && 'workspaceId' in entry.resource) workspaces.add(entry.resource.workspaceId);
          }
        }
        const roots = await resolveLinkRoots(target, workspaces, async workspaceId =>
          (await host.resolveResource(sessionId, workspaceId, '.')).path);
        if (id !== requestId.current) return;
        if (revealUnbound && target.absolute && !bindLocalTarget(target, roots)) {
          if (!host.locatePath) throw new Error('Manual file location requires the desktop Host.');
          return host.locatePath(target.path);
        }
        const targets = await resolveLocalTargets(target, roots, (workspaceId, path) => host.resolveResource(sessionId, workspaceId, path));
        if (id !== requestId.current) return;
        if (targets.length > 1) setChoices({ sessionId, id, targets });
        else await openResolvedResource(host, targets[0], target => requestReader(sessionId, target));
      } else if (resource) {
        await openBound(sessionId, resource.workspaceId, resource.logicalPath, id, resource);
      } else if (href.startsWith('artifact://')) {
        const artifacts = owner?.artifacts ?? (await getLocalAgentProjection(sessionId)).artifacts;
        if (id !== requestId.current) return;
        const artifact = artifacts.find(item => item.artifactId === href.slice('artifact://'.length));
        if (!artifact) throw new Error(t(language, 'reader.artifactMissing'));
        if (artifact.contentMode === 'fixed') requestReader(sessionId, artifactReaderTarget(artifact));
        else if (artifact.uri && /^https?:\/\//i.test(artifact.uri)) await host.openExternalLink(artifact.uri);
        else if (artifact.workspaceId && artifact.logicalPath) await openBound(sessionId, artifact.workspaceId, artifact.logicalPath, id);
      } else await host.openExternalLink(href);
    };
    return navigate().catch(error => failure(id, error, local?.path));
  };
  const selection = choices && choices.sessionId === source?.sessionId && <ResourceLinkChoices
    language={language} targets={choices.targets} onClose={() => setChoices(null)}
    onSelect={target => {
      setChoices(null);
      if (choices.id !== requestId.current) return;
      void openResolvedResource(host, target, resolved => requestReader(choices.sessionId, resolved))
        .catch(error => failure(choices.id, error, target.path));
    }} />;
  return { open, selection };
}
