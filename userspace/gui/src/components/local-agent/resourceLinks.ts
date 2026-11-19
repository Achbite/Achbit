import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface SourcePosition { line?: number; column?: number; fragment?: string }
export interface LocalTarget extends SourcePosition { path: string; absolute: boolean }

/** Parse URI delimiters before decoding file data. Static file reads have no query parameters. */
export function fileLinkLocation(reference: string): ({ path: string } & SourcePosition) | null {
  const [rawPath, rawFragment] = /^([^?#]*)(?:\?[^#]*)?(?:#([\s\S]*))?$/u.exec(reference)!.slice(1);
  try {
    const fragment = decodeURIComponent(rawFragment ?? '');
    const atLine = fragment ? /^L([1-9]\d*)(?:C([1-9]\d*))?$/u.exec(fragment)
      : /:([1-9]\d*)(?::([1-9]\d*))?$/u.exec(rawPath);
    const path = decodeURIComponent(!fragment && atLine ? rawPath.slice(0, atLine.index) : rawPath);
    if (!atLine) return fragment ? { path, fragment } : { path };
    const line = Number(atLine[1]), column = Number(atLine[2] ?? 1);
    return Number.isSafeInteger(line) && Number.isSafeInteger(column) ? { path, line, column } : null;
  } catch { return null; }
}

export function parseLocalTarget(href: string, allowRelative = true, sameDocument = false): LocalTarget | null {
  let reference = href.replace(/^\\\\\?\\(?=[a-z]:[\\/])/iu, '');
  if (/^(file|achbit-gui):\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return null;
      reference = url.pathname.replace(/^\/(?=[a-z]:\/)/iu, '') + url.search + url.hash;
    } catch { return null; }
  }
  const location = fileLinkLocation(reference);
  if (!location) return null;
  const { path } = location;
  const absolute = /^(?:\/(?!\/)|[A-Za-z]:[\\/])/u.test(path);
  if (!path && !(sameDocument && /^[?#]/u.test(href))) return null;
  if (!absolute && (!allowRelative || /^[a-z][a-z\d+.-]*:|^\/\//iu.test(path))) return null;
  return { ...location, absolute };
}

export function canonicalFileKey(path: string): string {
  // The Host resolves the actual file. Preserve filename case on case-sensitive volumes.
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, '')
      .replace(/\\/g, '/').replace(/^[a-z]:/i, drive => drive.toUpperCase());
  }
  return path;
}

function normalizedPath(path: string): string {
  const portable = canonicalFileKey(path);
  const root = /^(?:\/\/[^/]+\/[^/]+(?:\/|$)|[a-z]:\/|\/)/iu.exec(portable)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of portable.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return root + parts.join('/');
}

/** Resolve a relative href against the displayed file, keeping its source position. */
export function relativeToDocument(target: LocalTarget, path: string): LocalTarget {
  const file = canonicalFileKey(path);
  if (!target.path) return { ...target, absolute: true, path: file };
  const slash = file.lastIndexOf('/');
  if (slash < 0) throw new Error('The document has no local directory.');
  return { ...target, absolute: true, path: normalizedPath(file.slice(0, slash + 1) + target.path) };
}

function joinFolder(folder: string, path: string): string {
  return folder.replace(/[\\/]+$/u, '') + '/' + path;
}

/** Longest matching workspace, including its root. No filesystem access during rendering. */
export function bindLocalTarget(target: LocalTarget, roots: { workspaceId: string; root: string }[]) {
  if (!target.absolute) {
    if (roots.length !== 1) throw new Error('Relative path requires one unambiguous workspace.');
    return bindLocalTarget({ ...target, absolute: true, path: joinFolder(roots[0].root, target.path) }, roots);
  }
  const path = normalizedPath(target.path);
  const sorted = roots.map(binding => ({ ...binding, root: normalizedPath(binding.root) })).sort((a, b) => b.root.length - a.root.length);
  const contains = (root: string, candidate: string) =>
    candidate === root || candidate.startsWith(root.endsWith('/') ? root : root + '/');
  // Use the Host's exact spelling first, including Windows case-sensitive directories.
  const binding = sorted.find(({ root }) => contains(root, path)) ??
    sorted.find(({ root }) => /^(?:[a-z]:|\/\/)/iu.test(root) && contains(root.toLowerCase(), path.toLowerCase()));
  if (!binding) return null;
  return { workspaceId: binding.workspaceId, logicalPath: path.slice(binding.root.length).replace(/^\//u, '') || '.',
    line: target.line, column: target.column, ...(target.fragment && { fragment: target.fragment }) };
}
export interface ResolvedLocalTarget extends SourcePosition {
  workspaceId: string;
  logicalPath: string;
  path: string;
  kind: 'file' | 'directory';
}

/** Probe exact bound paths; absence is not a transport or permission failure. */
export async function resolveLocalTargets(
  target: LocalTarget,
  roots: { workspaceId: string; root: string }[],
  resolve: (workspaceId: string, logicalPath: string) => Promise<{ path: string; kind: 'file' | 'directory' }>,
): Promise<ResolvedLocalTarget[]> {
  const candidates = target.absolute ? [bindLocalTarget(target, roots)] : roots.map(root =>
    bindLocalTarget({ ...target, absolute: true, path: joinFolder(root.root, target.path) }, roots));
  const seen = new Set<string>();
  const matches = new Map<string, ResolvedLocalTarget>();
  const missing: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = JSON.stringify([candidate.workspaceId, candidate.logicalPath]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const resolved = await resolve(candidate.workspaceId, candidate.logicalPath);
      const identity = canonicalFileKey(resolved.path);
      if (!matches.has(identity)) matches.set(identity, { ...candidate, ...resolved });
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error)
        || !['host_inspection_path_not_found', 'conversation_resource_not_found'].includes(String(error.code))) throw error;
      missing.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!matches.size) throw new Error(missing.length ? missing.join('\n') : `No bound workspace contains: ${target.path}`);
  return [...matches.values()];
}

/** Display only; navigation and tool facts retain the original path. */
export function resourceFilename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || path
  );
}
function locationLabel(target: LocalTarget, name = resourceFilename(target.path)): string {
  return name + (target.line ? `:${target.line}${target.column && target.column > 1 ? `:${target.column}` : ''}` : '');
}

/** Only links synthesized from physical paths need their URI delimiters escaped. */
function physicalPathHref(raw: string): string {
  if (/^(?:file|achbit-gui):\/\//iu.test(raw)) return raw;
  const path = raw.replace(/^\\\\\?\\(?=[a-z]:[\\/])/iu, '');
  return path.replace(/[%?]|#(?!L[1-9]\d*(?:C[1-9]\d*)?$)/gu, encodeURIComponent);
}

/** Format references only. Original message text and tool records remain untouched. */
export function readableResourceLinks(tree: Root): Root {
  const shortened: { node: Element; target: LocalTarget }[] = [];
  const shortLink = (raw: string): Element | null => {
    const href = physicalPathHref(raw);
    const target = parseLocalTarget(href, false);
    if (!target) return null;
    const node: Element = { type: 'element', tagName: 'a', properties: { href, title: raw },
      children: [{ type: 'text', value: locationLabel(target) }] };
    shortened.push({ node, target });
    return node;
  };
  const visit = (node: RootContent): RootContent[] => {
    if (node.type === 'text') {
      const expression =
        /(?<![\w:/])(?:file:\/\/\/|\/(?=[^/\s]+\/)|[A-Za-z]:[\\/])[^\s<>"`，。；）)]+/gu;
      const result: RootContent[] = [];
      let start = 0;
      for (const match of node.value.matchAll(expression)) {
        const path = match[0].replace(/[.,;]+$/u, '');
        if (match.index! > start)
          result.push({ type: 'text', value: node.value.slice(start, match.index) });
        result.push(shortLink(path) ?? { type: 'text', value: path });
        start = match.index! + path.length;
      }
      if (!result.length) return [node];
      if (start < node.value.length) result.push({ type: 'text', value: node.value.slice(start) });
      return result;
    }
    if (node.type !== 'element' || node.tagName === 'pre') return [node];
    if (node.tagName === 'a') {
      const href = String(node.properties.href ?? '');
      const target = parseLocalTarget(href);
      if (!target) return [node];
      const result = { ...node, properties: { ...node.properties, title: href } };
      const text = node.children.every(child => child.type === 'text')
        ? node.children.map(child => child.type === 'text' ? child.value : '').join('') : null;
      if (text === href || text === target.path) {
        result.children = [{ type: 'text', value: locationLabel(target) }];
        shortened.push({ node: result, target });
      }
      return [result];
    }
    if (node.tagName === 'code') {
      const raw =
        node.children.length === 1 && node.children[0].type === 'text'
          ? node.children[0].value
          : '';
      return [shortLink(raw) ?? node];
    }
    return [{ ...node, children: node.children.flatMap(visit) as ElementContent[] }];
  };
  const result = { ...tree, children: tree.children.flatMap(visit) };
  for (const entry of shortened) {
    const peers = shortened.filter(({ target }) => resourceFilename(target.path) === resourceFilename(entry.target.path) && target.path !== entry.target.path);
    if (!peers.length) continue;
    const parts = entry.target.path.replace(/\\/gu, '/').split('/').filter(Boolean);
    let count = 2;
    while (count < parts.length && peers.some(({ target }) => target.path.replace(/\\/gu, '/').split('/').slice(-count).join('/') === parts.slice(-count).join('/'))) count++;
    entry.node.children = [{ type: 'text', value: locationLabel(entry.target, parts.slice(-count).join('/')) }];
  }
  return result;
}
