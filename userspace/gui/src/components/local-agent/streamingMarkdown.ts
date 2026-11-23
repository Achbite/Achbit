import { unified } from 'unified';
import { markdownGrammar as parser, displayMathFences } from './markdownGrammar';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { defaultUrlTransform } from 'react-markdown';
import { parseLocalTarget } from './resourceLinks';
import type { Root as MarkdownRoot } from 'mdast';
import type { Element, Root, RootContent } from 'hast';

declare module 'hast' { interface ElementData { formulaSource?: string; formulaError?: string } }

export { formatDecisionProse } from './markdownGrammar';

const converter = unified().use(remarkRehype, { allowDangerousHtml: true });
// rehype-katex reports the actual parser error on VFile even when its recovery pass
// can draw a red fragment. Keep that diagnostic on the exact original formula, rather
// than presenting a partially typeset expression as a successful, exportable one.
const typesetter = unified().use(rehypeKatex).use(() => (_tree, file) => {
  for (const diagnostic of file.messages) {
    const input = diagnostic.ancestors?.at(-1);
    if (diagnostic.source !== 'rehype-katex' || input?.type !== 'element') continue;
    const element = input as Element;
    element.data = { ...element.data, formulaError: diagnostic.cause instanceof Error ? diagnostic.cause.message : diagnostic.reason };
  }
});
export interface MarkdownBlock { key: string; tree: Root; streaming: boolean }

// The Markdown parser determines the math scope (including quoted/list items and math code fences).
// At EOF it also accepts an implicit close: while streaming this is not yet a finished equation.
function openMathTail(position: Element['position'], source: string) {
  const start = position?.start.offset, end = position?.end.offset;
  if (start === undefined || end === undefined || end < source.trimEnd().length) return false;
  const span = source.slice(start, end), fence = /^(\${2,}|`{3,}|~{3,})/u.exec(span)?.[0];
  if (!fence) return false;
  const close = /[\r\n][ \t>]*(\${2,}|`{3,}|~{3,})[ \t]*$/u.exec(span)?.[1];
  return !close || close[0] !== fence[0] || close.length < fence.length;
}

function typesetMath(tree: Root, liveSource?: string) {
  const math: { parent: Element | Root; index: number; code: Element; position: Element['position']; source: string }[] = [];
  const visit = (parent: Element | Root) => parent.children.forEach((node, index) => {
    if (node.type !== 'element') return;
    const code = node.tagName === 'pre' ? node.children[0] : node;
    if (code?.type !== 'element' || code.tagName !== 'code' || !Array.isArray(code.properties.className) || !code.properties.className.includes('language-math')) {
      visit(node); return;
    }
    if (node.tagName === 'pre' && liveSource !== undefined && openMathTail(node.position, liveSource)) {
      parent.children[index] = { type: 'element', tagName: 'span', position: node.position,
        properties: { className: ['conversation-math__pending'] }, children: [] };
      return;
    }
    math.push({ parent, index, code, position: node.position, source: code.children.map(n => n.type === 'text' ? n.value : '').join('') });
  });
  visit(tree);
  if (!math.length) return;
  // rehype-katex replaces each original scope with a single span. Keep its parser location
  // for stable save actions, and a single textual representation for inline-only controls.
  typesetter.runSync(tree);
  for (const { parent, index, code, position, source } of math) {
    const error = code.data?.formulaError;
    if (error) {
      parent.children[index] = { type: 'element', tagName: 'span', position, data: { formulaSource: source },
        properties: { className: ['katex-error'], title: error, ariaLabel: error }, children: [{ type: 'text', value: source }] };
      continue;
    }
    const result = parent.children[index];
    if (result?.type === 'element') { result.position = position; result.data = { ...result.data, formulaSource: source }; }
  }
}

function renderTree(root: MarkdownRoot, liveSource?: string) {
  let nodes = 0;
  const tree = converter.runSync(root) as Root;
  typesetMath(tree, liveSource);
  // Preserve react-markdown's literal HTML and URL policy with the same grammar.
  const clean = (node: Root | RootContent): void => {
    nodes++;
    if (node.type === 'raw') { Object.assign(node, { type: 'text' }); return; }
    if (node.type === 'element') {
      for (const name of ['href', 'src']) {
        const value = node.properties[name];
        if (typeof value !== 'string' || /^(?:workspace:\/\/[^/]+\/.+|artifact:\/\/.+)/.test(value)) continue;
        const url = defaultUrlTransform(value);
        const target = !url && node.tagName === 'a' && name === 'href' ? parseLocalTarget(value) : null;
        // A relative filename followed by a line number looks like a URL scheme.
        node.properties[name] = target ? (target.absolute ? value : './' + value) : url;
      }
    }
    if ('children' in node) node.children.forEach(clean);
  };
  clean(tree);
  return { tree, nodes };
}

// Formula expansion and rich tables can produce large trees from short source text.
const maximumCachedNodes = 24_000;
const maximumCachedCharacters = 500_000;
const completedDocuments = new Map<string, { blocks: MarkdownBlock[]; nodes: number }>();
let completedCharacters = 0;
let completedNodes = 0;

function markdownBlocks(root: MarkdownRoot, liveSource?: string): { blocks: MarkdownBlock[]; nodes: number } {
  const { tree, nodes } = renderTree(root, liveSource);
  const blocks = tree.children.flatMap((node, index) => {
    if (node.type === 'text' && !node.value.trim()) return [];
    return [{ key: String(node.position?.start.offset ?? `generated:${index}`), tree: { type: 'root' as const, children: [node] }, streaming: false }];
  });
  return { blocks, nodes };
}

export function cachedMarkdown(text: string): MarkdownBlock[] | undefined {
  const entry = completedDocuments.get(text);
  if (entry) {
    completedDocuments.delete(text);
    completedDocuments.set(text, entry);
  }
  return entry?.blocks;
}

export function completeMarkdown(root: MarkdownRoot, cacheKey?: string): MarkdownBlock[] {
  const cached = cacheKey === undefined ? undefined : cachedMarkdown(cacheKey);
  if (cached) return cached;
  const { blocks, nodes } = markdownBlocks(root);
  // Cache parsed display content across component remounts, with a bounded LRU.
  // Live tails bypass this cache; reference-bearing streams reconcile separately.
  if (cacheKey !== undefined && cacheKey.length <= maximumCachedCharacters && nodes <= maximumCachedNodes) {
    completedDocuments.set(cacheKey, { blocks, nodes });
    completedCharacters += cacheKey.length;
    completedNodes += nodes;
    while (completedDocuments.size > 128 || completedCharacters > maximumCachedCharacters || completedNodes > maximumCachedNodes) {
      const [oldest, entry] = completedDocuments.entries().next().value!;
      completedCharacters -= oldest.length;
      completedNodes -= entry.nodes;
      completedDocuments.delete(oldest);
    }
  }
  return blocks;
}

function fullBlocks(text: string, cache = true): MarkdownBlock[] {
  if (cache) {
    const existing = cachedMarkdown(text);
    if (existing) return existing;
  }
  return completeMarkdown(parser.parse(text), cache ? text : undefined);
}

/** Only the parser-confirmed prefix freezes. Lists, tables and open fences stay in the tail. */
export class StreamingMarkdownParser {
  private text = '';
  private offset = 0;
  private frozen: MarkdownBlock[] = [];
  private blocks: MarkdownBlock[] = [];
  private streaming = true;
  private documentReferences = false;

  update(text: string, streaming: boolean): MarkdownBlock[] {
    text = displayMathFences(text);
    if (this.text === text && this.streaming === streaming) return this.blocks;
    // A committed document owns its final tree; the streaming prefix can now be released.
    if (!streaming || !text.startsWith(this.text)) {
      this.offset = 0; this.frozen = []; this.documentReferences = false;
    }
    this.text = text; this.streaming = streaming;
    if (!streaming) { this.blocks = fullBlocks(text); return this.blocks; }
    const source = text.slice(this.offset);
    const root = parser.parse(source);
    // Definitions have document-wide meaning. Reconcile those documents as a whole.
    if (root.children.some((node) => node.type === 'definition' || node.type === 'footnoteDefinition')) this.documentReferences = true;
    if (this.documentReferences) {
      const document = this.offset ? parser.parse(text) : root;
      this.offset = 0; this.frozen = [];
      this.blocks = markdownBlocks(document, text).blocks.map((block) => ({ ...block, streaming: true }));
      return this.blocks;
    }
    const base = this.offset;
    const freezeCount = Math.max(0, root.children.length - 2);
    const tail = root.children.map((node, index): MarkdownBlock => ({
      key: String(base + node.position!.start.offset!),
      tree: renderTree({ type: 'root', children: [node] }, index >= freezeCount ? source : undefined).tree,
      streaming: index >= freezeCount,
    }));
    this.blocks = [...this.frozen, ...tail];
    if (freezeCount > 0) {
      this.frozen = [...this.frozen, ...tail.slice(0, freezeCount)];
      this.offset = base + root.children[freezeCount - 1]!.position!.end.offset!;
    }
    return this.blocks;
  }
}
