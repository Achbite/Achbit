import type { ElementContent, Root, RootContent } from 'hast';

// remark-rehype generates these IDs per document. The parse cache is shared by
// text; assign the DOM namespace only when mounting each copy, never in the cache.
const generated = (value: unknown): value is string => typeof value === 'string'
  && (value === 'footnote-label' || /^user-content-fn(?:ref)?-/u.test(value));

export function scopeFootnotes(tree: Root, scope: string | undefined): Root {
  if (!scope) return tree;
  function visit(node: RootContent): RootContent {
    if (node.type !== 'element') return node;
    const props = node.properties;
    const id = props.id, target = typeof props.href === 'string' && props.href.startsWith('#') ? props.href.slice(1) : undefined;
    const labelled = Array.isArray(props.ariaDescribedBy) && props.ariaDescribedBy.includes('footnote-label');
    const scoped = generated(id) || generated(target) || labelled;
    const children = node.children.map(visit) as ElementContent[];
    if (!scoped && children.every((child, index) => child === node.children[index])) return node;
    return { ...node, children, properties: scoped ? { ...props,
      ...(generated(id) && { id: scope + id, dataFootnoteAnchor: id, ...(node.tagName === 'li' && { tabIndex: -1 }) }),
      // Upstream IDs may already contain percent escapes. A URL fragment must decode to that exact DOM ID.
      ...(generated(target) && { href: '#' + encodeURIComponent(scope + target) }),
      ...(labelled && { ariaDescribedBy: [scope + 'footnote-label'] }),
    } : props };
  }
  return { ...tree, children: tree.children.map(visit) };
}
