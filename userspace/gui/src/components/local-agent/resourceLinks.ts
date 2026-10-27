import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface SourcePosition { line?: number; column?: number }
export interface LocalTarget extends SourcePosition { path: string; absolute: boolean }

export function parseLocalTarget(href: string, allowRelative = true): LocalTarget | null {
  let path = href;
  if (/^(file|achbit-gui):\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = decodeURIComponent(url.pathname) + url.hash;
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  } else {
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  const absolute = /^(?:\/(?!\/)|[A-Za-z]:[\\/])/u.test(path);
  const location = /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/u.exec(path);
  const line = location ? Number(location[1] ?? location[3]) : undefined;
  const column = location ? Number(location[2] ?? location[4] ?? 1) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || !Number.isSafeInteger(column))) return null;
  path = location ? path.slice(0, location.index) : path;
  if (!path || (!absolute && (!allowRelative || /^[a-z][a-z\d+.-]*:|^[#?]|^\/\//iu.test(path)))) return null;
  return { path, absolute, ...(line ? { line, column } : {}) };
}

export function localReference(href: string): string | null {
  return parseLocalTarget(href, false)?.path ?? null;
}

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/gu, '/').split('/')) {
    if (part === '.' || (part === '' && parts.length)) continue;
    if (part === '..') { if (parts.length > 1) parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/').replace(/\/+$/u, '') || '/';
}

/** Longest matching workspace, including its root. No filesystem access during rendering. */
export function bindLocalTarget(target: LocalTarget, roots: { workspaceId: string; root: string }[]) {
  if (!target.absolute) {
    if (roots.length !== 1) throw new Error('Relative path requires one unambiguous workspace.');
    return bindLocalTarget({ ...target, absolute: true, path: `${roots[0].root}/${target.path}` }, roots);
  }
  const path = normalizedPath(target.path);
  for (const binding of [...roots].sort((a, b) => b.root.length - a.root.length)) {
    const root = normalizedPath(binding.root), prefix = root.endsWith('/') ? root : root + '/';
    const fold = (text: string) => /^[A-Za-z]:/.test(root) ? text.toLowerCase() : text;
    if (fold(path) === fold(root) || fold(path).startsWith(fold(prefix))) {
      return { workspaceId: binding.workspaceId, logicalPath: fold(path) === fold(root) ? '.' : path.slice(prefix.length) || '.', line: target.line, column: target.column };
    }
  }
  return null;
}
export interface ResolvedLocalTarget extends SourcePosition {
  workspaceId: string;
  logicalPath: string;
  path: string;
}

/** Probe exact bound paths; absence is not a transport or permission failure. */
export async function resolveLocalTargets(
  target: LocalTarget,
  roots: { workspaceId: string; root: string }[],
  resolve: (workspaceId: string, logicalPath: string) => Promise<{ path: string; kind: 'file' | 'directory' }>,
): Promise<ResolvedLocalTarget[]> {
  const candidates = target.absolute ? [bindLocalTarget(target, roots)] : roots.map(root =>
    bindLocalTarget({ ...target, absolute: true, path: `${root.root}/${target.path}` }, roots));
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
      const path = normalizedPath(resolved.path);
      const identity = /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path;
      if (!matches.has(identity)) matches.set(identity, { ...candidate, path: resolved.path });
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error)
        || !['host_inspection_path_not_found', 'conversation_resource_not_found'].includes(String(error.code))) throw error;
      missing.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!matches.size) throw new Error(missing.length ? missing.join('\n') : `No bound workspace contains: ${target.path}`);
  return [...matches.values()];
}

function label(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || path
  );
}
function link(path: string): Element {
  const target = parseLocalTarget(path);
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: path, title: path },
    children: [{ type: 'text', value: target ? label(target.path) + (target.line ? `:${target.line}${target.column && target.column > 1 ? `:${target.column}` : ''}` : '') : label(path) }],
  };
}

/** Format references only. Original message text and tool records remain untouched. */
export function readableResourceLinks(tree: Root): Root {
  const shortened: { node: Element; target: LocalTarget }[] = [];
  const shortLink = (href: string): Element => {
    const node = link(href), target = parseLocalTarget(href);
    if (target) shortened.push({ node, target });
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
        result.push(shortLink(path));
        start = match.index! + path.length;
      }
      if (!result.length) return [node];
      if (start < node.value.length) result.push({ type: 'text', value: node.value.slice(start) });
      return result;
    }
    if (node.type !== 'element' || node.tagName === 'pre') return [node];
    if (node.tagName === 'a') {
      const href = String(node.properties.href ?? ''),
        path = parseLocalTarget(href)?.path;
      const raw = node.children.every((child) => child.type === 'text')
        ? node.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
        : '';
      const result: Element = {
          ...node,
          properties: { ...node.properties, ...(path ? { title: href } : {}) },
          children:
            path && (raw === href || raw === path) ? link(href).children : node.children,
        };
      if (path && (raw === href || raw === path)) shortened.push({ node: result, target: parseLocalTarget(href)! });
      return [result];
    }
    if (node.tagName === 'code') {
      const raw =
        node.children.length === 1 && node.children[0].type === 'text'
          ? node.children[0].value
          : '';
      return localReference(raw) ? [shortLink(raw)] : [node];
    }
    return [{ ...node, children: node.children.flatMap(visit) as ElementContent[] }];
  };
  const result = { ...tree, children: tree.children.flatMap(visit) };
  for (const entry of shortened) {
    const peers = shortened.filter(({ target }) => label(target.path) === label(entry.target.path) && target.path !== entry.target.path);
    if (!peers.length) continue;
    const parts = entry.target.path.replace(/\\/gu, '/').split('/').filter(Boolean);
    let count = 2;
    while (count < parts.length && peers.some(({ target }) => target.path.replace(/\\/gu, '/').split('/').slice(-count).join('/') === parts.slice(-count).join('/'))) count++;
    entry.node.children = [{ type: 'text', value: parts.slice(-count).join('/') + (entry.target.line ? `:${entry.target.line}${entry.target.column && entry.target.column > 1 ? `:${entry.target.column}` : ''}` : '') }];
  }
  return result;
}
