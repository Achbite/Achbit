import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkMath from 'remark-math';
import type { Nodes as MarkdownNode } from 'mdast';

export const markdownGrammar = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCjkFriendly);

/** Block math may put TeX beside its dollar fences; keep those delimiters on their own lines for remark-math. */
export function displayMathFences(text: string): string {
  if (!text.includes('$$')) return text;
  for (;;) {
    const breaks: number[] = [];
    // Let Markdown identify blocks so code fences and inline code remain literal.
    for (const node of markdownGrammar.parse(text).children) {
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
  visit(markdownGrammar.parse(text));
  for (const { start, end, value } of replacements.reverse()) text = text.slice(0, start) + value + text.slice(end);
  return text;
}
