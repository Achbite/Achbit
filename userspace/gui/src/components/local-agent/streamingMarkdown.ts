import { unified } from 'unified';
import { markdownGrammar as parser, displayMathFences } from './markdownGrammar';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { defaultUrlTransform } from 'react-markdown';
import { parseLocalTarget } from './resourceLinks';
import type { Root as MarkdownRoot } from 'mdast';
import type { Root, RootContent } from 'hast';

export { formatDecisionProse } from './markdownGrammar';

const converter = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKatex);
export interface MarkdownBlock { key: string; tree: Root; streaming: boolean }

function renderTree(root: MarkdownRoot) {
  let nodes = 0;
  const tree = converter.runSync(root) as Root;
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

function markdownBlocks(root: MarkdownRoot): { blocks: MarkdownBlock[]; nodes: number } {
  const { tree, nodes } = renderTree(root);
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
    const root = parser.parse(text.slice(this.offset));
    // Definitions have document-wide meaning. Reconcile those documents as a whole.
    if (root.children.some((node) => node.type === 'definition' || node.type === 'footnoteDefinition')) this.documentReferences = true;
    if (this.documentReferences) {
      this.offset = 0; this.frozen = [];
      this.blocks = fullBlocks(text, false).map((block) => ({ ...block, streaming: true }));
      return this.blocks;
    }
    const base = this.offset;
    const freezeCount = Math.max(0, root.children.length - 2);
    const tail = root.children.map((node, index): MarkdownBlock => ({
      key: String(base + node.position!.start.offset!),
      tree: renderTree({ type: 'root', children: [node] }).tree,
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
