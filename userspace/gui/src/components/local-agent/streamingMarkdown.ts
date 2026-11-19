import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { defaultUrlTransform } from 'react-markdown';
import { parseLocalTarget } from './resourceLinks';
import type { Root as MarkdownRoot, Nodes as MarkdownNode } from 'mdast';
import type { Root, RootContent } from 'hast';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const converter = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKatex);
export interface MarkdownBlock { key: string; tree: Root; streaming: boolean }

/** Block math may put TeX beside its dollar fences; keep those delimiters on their own lines for remark-math. */
function displayMathFences(text: string): string {
  if (!text.includes('$$')) return text;
  for (;;) {
    const breaks: number[] = [];
    // Let Markdown identify blocks so code fences and inline code remain literal.
    for (const node of parser.parse(text).children) {
      if (node.type !== 'math' || !node.position) continue;
      const start = node.position.start.offset!;
      const source = text.slice(start, node.position.end.offset!);
      const fence = /^\${2,}/u.exec(source)![0];
      if (node.meta) breaks.push(start + fence.length);
      const closing = /\${2,}[ \t]*(?=\r?$)/gm;
      closing.lastIndex = fence.length;
      for (let match; (match = closing.exec(source));) {
        const escapes = /\\+$/u.exec(source.slice(0, match.index))?.[0].length ?? 0;
        if (escapes % 2 || match[0].trim().length < fence.length) continue;
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        if (source.slice(lineStart, match.index).trim()) breaks.push(start + match.index);
        break;
      }
    }
    if (!breaks.length) return text;
    for (const offset of breaks.reverse()) text = text.slice(0, offset) + '\n' + text.slice(offset);
    // A formerly unterminated block may have hidden later formulas from the parser.
  }
}

/** Display escaped paragraph separators only in decision prose; preserve the source and code. */
export function formatDecisionProse(text: string): string {
  if (!text.includes('\\n\\n')) return text;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset!, end = node.position.end.offset!;
      const raw = text.slice(start, end);
      const value = raw.replace(/(?<!\\)(?:\\n){2,}/g, (separator) => '\n'.repeat(separator.length / 2));
      if (value !== raw) replacements.push({ start, end, value });
    } else if ('children' in node && node.type !== 'link' && node.type !== 'linkReference') {
      node.children.forEach(visit);
    }
  };
  visit(parser.parse(text));
  for (const { start, end, value } of replacements.reverse()) text = text.slice(0, start) + value + text.slice(end);
  return text;
}

function renderTree(root: MarkdownRoot): Root {
  const tree = converter.runSync(root) as Root;
  // Preserve react-markdown's literal HTML and URL policy with the same grammar.
  const clean = (node: Root | RootContent): void => {
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
  return tree;
}

const completedDocuments = new Map<string, MarkdownBlock[]>();
let completedCharacters = 0;

function fullBlocks(text: string, cache = true): MarkdownBlock[] {
  const cached = cache ? completedDocuments.get(text) : undefined;
  if (cached) {
    completedDocuments.delete(text);
    completedDocuments.set(text, cached);
    return cached;
  }
  const blocks = renderTree(parser.parse(text)).children.flatMap((node, index) => {
    if (node.type === 'text' && !node.value.trim()) return [];
    return [{ key: String(node.position?.start.offset ?? `generated:${index}`), tree: { type: 'root' as const, children: [node] }, streaming: false }];
  });
  // Cache parsed display content across component remounts, with a bounded LRU.
  // Live tails bypass this cache; reference-bearing streams reconcile separately.
  if (cache && text.length <= 500_000) {
    completedDocuments.set(text, blocks);
    completedCharacters += text.length;
    while (completedDocuments.size > 128 || completedCharacters > 500_000) {
      const oldest = completedDocuments.keys().next().value!;
      completedCharacters -= oldest.length;
      completedDocuments.delete(oldest);
    }
  }
  return blocks;
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
      tree: renderTree({ type: 'root', children: [node] }),
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
