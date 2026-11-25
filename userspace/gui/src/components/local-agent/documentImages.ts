import { createContext } from 'react';
import type { UiLanguage } from '../../i18n';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import type { ConversationHost } from './ConversationHost';
import type { ReaderTarget } from './readerState';
import { bindLocalTarget, resolveLinkRoots } from './resourceLinks';

export const ReaderImageScope = createContext<ConversationHost['loadImage'] | null>(null);

type DocumentTarget = Extract<ReaderTarget, { kind: 'file' | 'workspace' | 'resource' | 'artifact' }>;

// A picker selection names one file, not its siblings. Match the document (not
// just its image) to an independently authorized directory before resolving URLs.
async function boundPickedDocument(host: ConversationHost, session: string, path: string, signal: AbortSignal) {
  const roots = (await host.resources.listResourceRoots(session, signal)).filter(r => r.kind === 'directory' && !('change' in r.resource));
  const sources = new Map(roots.map(root => [resourceKey(root.resource), root.resource]));
  const file = { path, absolute: true };
  const located = await resolveLinkRoots(file, sources.keys(), async key =>
    (await host.resources.resolveResourceReference(session, sources.get(key)!, signal)).path);
  signal.throwIfAborted();
  const bound = bindLocalTarget(file, located);
  return bound ? { ...sources.get(bound.workspaceId)!, logicalPath: bound.logicalPath } : undefined;
}

/** Resolve within the displayed file's original Session and resource grant. Never call the physical file picker reader from Markdown. */
export function documentImageLoader(host: ConversationHost, session: string, target: DocumentTarget, language: UiLanguage): ConversationHost['loadImage'] {
  let origin: ResourceReference | undefined = target.kind === 'workspace' ? { workspaceId: target.workspaceId, logicalPath: target.logicalPath }
    : target.kind === 'resource' ? target.resource : undefined;
  const unavailable = () => new Error(language === 'zh-CN' ? '相对图片需要位于文档获准读取的目录中。' : 'A relative image must be inside a directory this document can read.');
  return async (_session, source, signal) => {
    signal.throwIfAborted();
    if (/^(?:https?|workspace|artifact):\/\//iu.test(source)) return host.loadImage(session, source, signal);
    // Split URI punctuation before decoding. A literal %23 in a filename is not a fragment.
    let relative: string;
    try { relative = decodeURIComponent(source.split(/[?#]/u, 1)[0]); } catch { throw unavailable(); }
    if (!relative || /^(?:\/|[a-z][a-z\d+.-]*:)|[\\\u0000-\u001f]/iu.test(relative)) throw unavailable();
    if (!origin && target.kind === 'file') origin = await boundPickedDocument(host, session, target.canonicalPath ?? target.path, signal);
    if (!origin?.logicalPath || 'change' in origin) throw unavailable();
    const parts = origin.logicalPath.split('/').slice(0, -1);
    for (const part of relative.split('/')) {
      if (!part || part === '.') continue;
      if (part !== '..') parts.push(part);
      else if (!parts.length) throw unavailable();
      else parts.pop();
    }
    signal.throwIfAborted();
    const blob = await host.resources.readResourceBlob(session, { ...origin, logicalPath: parts.join('/') }, 'image', signal);
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob), hash = source.indexOf('#');
    return { url: hash < 0 ? url : url + source.slice(hash), release: () => URL.revokeObjectURL(url) };
  };
}
