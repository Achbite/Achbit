import React, { createContext, memo, startTransition, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { CodeContent, ImageContent } from './RichContent';
import { MathContent } from './MathContent';
import { MermaidContent } from './MermaidContent';
import { MarkdownTable } from './MarkdownTable';
import { formatDecisionProse, cachedMarkdown, completeMarkdown, StreamingMarkdownParser, type MarkdownBlock } from './streamingMarkdown';
import { StreamingTextBuffer } from './streamingText';
import { scopeFootnotes } from './markdownFootnotes';
import { parseMarkdownDocument } from './markdownParseQueue';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import './richContent.css';
import { parseLocalTarget, readableResourceLinks } from './resourceLinks';
import { ConversationBodyLinkScope } from './useConversationBodyLinks';
import { defaultUrlTransform } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { InlineInteractivePreview } from './InteractivePreview';

import { RichContentScope } from './RichContentIdentity';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';

const FootnoteScope = createContext<string | undefined>(undefined);

function useFootnoteScope(text: string) {
  const id = useId();
  return text.includes('[^') ? `achbit-md-${id}-` : undefined;
}

const MarkdownBlockScope = createContext<{ key: string; start: number | undefined; streaming: boolean; copyPending: boolean } | null>(null);

/** Nested tables/fences share a parsed block, but have distinct source positions within it. */
function MarkdownNodeScope({ node, children }: { node?: Element; children: React.ReactNode }) {
  const content = useContext(RichContentScope);
  const block = useContext(MarkdownBlockScope);
  const start = node?.position?.start.offset;
  const target = content && block && block.start !== undefined && start !== undefined
    ? { ...content, blockKey: block.key, nodeOffset: String(start - block.start) } : null;
  return <RichContentScope.Provider value={target}>{children}</RichContentScope.Provider>;
}
const COMPONENTS = {
  pre: function MarkdownCode({ node, children }: { node?: Element; children?: React.ReactNode }) {
    const block = useContext(MarkdownBlockScope);
    const streaming = block?.streaming ?? false;
    const child = React.Children.toArray(children)[0];
    if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) return <pre>{children}</pre>;
    const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '';
    const code = String(child.props.children ?? '');
    return <MarkdownNodeScope node={node}>{language === 'achbit-preview'
      ? <InlineInteractivePreview source={code} pending={streaming} />
      : language === 'mermaid' && !streaming
        ? <MermaidContent source={code} /> : <CodeContent code={code} language={language} streaming={streaming} copyPending={block?.copyPending} />}</MarkdownNodeScope>;
  },
  table: function ScopedMarkdownTable({ node, children }: { node?: Element; children?: React.ReactNode }) {
    return <MarkdownNodeScope node={node}><MarkdownTable>{children}</MarkdownTable></MarkdownNodeScope>;
  },
  img: function MarkdownImage({ src, alt, width, height }: React.ComponentPropsWithoutRef<'img'>) {
    return <ImageContent source={src ?? ''} alt={alt ?? ''} width={Number(width)} height={Number(height)} />;
  },
  span: function MarkdownSpan({ node, children, ...attributes }: React.ComponentPropsWithoutRef<'span'> & { node?: Element }) {
    if (attributes.className === 'conversation-math__pending') return <MarkdownStatus math />;
    const span = <span {...attributes}>{children}</span>;
    return attributes.className?.split(' ').includes('katex-display')
      ? <MarkdownNodeScope node={node}><MathContent>{span}</MathContent></MarkdownNodeScope> : span;
  },
  a: ScopedMarkdownLink,
};

function ScopedMarkdownLink({ href, children, node: _node, ...attributes }: React.ComponentPropsWithoutRef<'a'> & { node?: Element }) {
  const open = useContext(ConversationBodyLinkScope);
  const target = !open && href && parseLocalTarget(href) ? defaultUrlTransform(href) : href;
  return <a {...attributes} href={target} onClick={open ?? undefined} onAuxClick={open ?? undefined}>{children}</a>;
}

const RenderedBlock = memo(function RenderedBlock({ block, provisional }: { block: MarkdownBlock; provisional: boolean }) {
  const scope = useContext(FootnoteScope);
  const tree = useMemo(() => readableResourceLinks(scopeFootnotes(block.tree, scope)), [block.tree, scope]);
  return <MarkdownBlockScope.Provider value={{ key: block.key, start: block.tree.children[0]?.position?.start.offset,
    streaming: block.streaming, copyPending: provisional && block.streaming }}>
    {toJsxRuntime(tree, { Fragment, jsx, jsxs, components: COMPONENTS, passNode: true })}
  </MarkdownBlockScope.Provider>;
});

interface MarkdownContentProps { children: string; streaming?: boolean; decisionProse?: boolean; active?: boolean; documentPreview?: boolean }

function MarkdownBlocks({ blocks, provisional = false }: { blocks: MarkdownBlock[]; provisional?: boolean }) {
  return <>{blocks.map(block => <RenderedBlock key={block.key} block={block} provisional={provisional} />)}</>;
}

function MarkdownStatus({ math = false }: { math?: boolean }) {
  return <span role="status">{t(useUiLanguage(), math ? 'content.math.composing' : 'agent.chat.preparingText')}</span>;
}

// Bound synchronous work by both lines and characters, including unbroken paragraphs.
function firstPage(text: string): string {
  const prefix = text.slice(0, 4096);
  const lines = prefix.match(/^(?:[^\n]*\n){32}/u)?.[0];
  if (lines) return lines;
  // Keep unbroken source on one side of the boundary for native selection and find.
  return prefix.slice(0, prefix.lastIndexOf('\n') + 1);
}

// Only the file Reader offers a provisional, searchable source view. In a
// conversation even the first paragraph can depend on definitions at EOF.
function DocumentMarkdownBlocks({ text, decisionProse, blocks }: { text: string; decisionProse: boolean; blocks?: MarkdownBlock[] }) {
  const first = useMemo(() => blocks ? '' : firstPage(text), [blocks, text]);
  const visible = useMemo(() => blocks ?? new StreamingMarkdownParser().update(decisionProse ? formatDecisionProse(first) : first, true), [blocks, first, decisionProse]);
  // Keep completed prefix blocks mounted so an action started during parsing can finish.
  return <><MarkdownBlocks blocks={visible} provisional={!blocks} />{!blocks && <pre className="conversation-markdown__pending-source">{text.slice(first.length)}</pre>}</>;
}

export const MarkdownContent = memo(function MarkdownContent({ children: text, streaming = false, decisionProse = false, active = true, documentPreview = false }: MarkdownContentProps) {
  const scope = useFootnoteScope(text);
  const surface = useRef<HTMLDivElement>(null);
  const parser = useRef<StreamingMarkdownParser | null>(null);
  const lastLive = useRef<{ text: string; decisionProse: boolean; blocks: MarkdownBlock[] } | null>(null);
  const deferred = !streaming && text.length > 24_000;
  const parsed = useMemo(() => {
    if (deferred) { parser.current = null; return decisionProse ? undefined : cachedMarkdown(text); }
    parser.current ??= new StreamingMarkdownParser();
    return parser.current.update(decisionProse ? formatDecisionProse(text) : text, streaming);
  }, [deferred, text, decisionProse, streaming]);
  const [result, setResult] = useState<{ text: string; decisionProse: boolean; blocks?: MarkdownBlock[]; error?: string } | null>(null);
  const current = deferred && result?.text === text && result.decisionProse === decisionProse ? result : null;
  const blocks = current?.blocks ?? parsed;
  // Only retain what this mount actually committed, and only for that exact final text.
  const prior = lastLive.current;
  const displayed = blocks ?? (!documentPreview && prior?.text === text && prior.decisionProse === decisionProse ? prior.blocks : undefined);
  useLayoutEffect(() => {
    if (streaming && blocks) lastLive.current = { text, decisionProse, blocks };
    else if (blocks || !displayed) lastLive.current = null;
  }, [streaming, text, decisionProse, blocks, displayed]);
  useEffect(() => {
    if (!deferred || !active || blocks || current?.error) return;
    const controller = new AbortController();
    void parseMarkdownDocument(text, decisionProse, controller.signal).then(root => {
      if (controller.signal.aborted) return;
      const completed = completeMarkdown(root, decisionProse ? undefined : text);
      const publish = () => {
        const selection = document.getSelection();
        const replacingReadableText = documentPreview || !!displayed;
        if (replacingReadableText && surface.current && selection && !selection.isCollapsed && selection.containsNode(surface.current, true)) return;
        document.removeEventListener('selectionchange', publish);
        const show = () => setResult({ text, decisionProse, blocks: completed });
        // The only content of a cold row is waiting for this result. Do not leave its
        // first formal tree on a transition lane behind scroll and resize work.
        if (replacingReadableText) startTransition(show); else show();
      };
      // A selection in the provisional view remains usable until the reader releases it.
      document.addEventListener('selectionchange', publish, { signal: controller.signal });
      publish();
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setResult({ text, decisionProse, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [deferred, text, decisionProse, active, blocks, current?.error, displayed, documentPreview]);
  const pending = deferred && !blocks && !current?.error;
  return <FootnoteScope.Provider value={scope}><div className="conversation-markdown" ref={surface} aria-busy={deferred ? pending : undefined} data-conversation-pending={pending && !displayed && !documentPreview || undefined}>
    {documentPreview ? <DocumentMarkdownBlocks text={text} decisionProse={decisionProse} blocks={displayed} />
      : displayed ? <MarkdownBlocks blocks={displayed} /> : pending && <MarkdownStatus />}
    {current?.error && <p role="alert">{current.error}</p>}
  </div></FootnoteScope.Provider>;
});

// An opening page carries text, not resource or action authority. Use the same
// parsed blocks without mounting link handlers, plugins, viewers or image requests.
export const ReadingMarkdown = memo(function ReadingMarkdown({ text }: { text: string }) {
  const scope = useFootnoteScope(text);
  const blocks = useMemo(() => new StreamingMarkdownParser().update(text, false), [text]);
  return <div className="conversation-markdown">{blocks.map(block => <Fragment key={block.key}>
    {toJsxRuntime(scopeFootnotes(block.tree, scope), { Fragment, jsx, jsxs, components: {
      a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span>,
      input: ({ checked }) => <span>{checked ? '☑' : '☐'}</span>,
    } })}</Fragment>)}</div>;
});

/** Inline fields share the Markdown grammar, without nested links or block layout in buttons/headings. */
export const MarkdownInline = memo(function MarkdownInline({ children }: { children: string }) {
  const tree = useMemo(() => {
    const blocks = new StreamingMarkdownParser().update(children, false);
    const inline = (node: RootContent): ElementContent[] => {
      if (node.type === 'text') return [node];
      if (node.type !== 'element') return [];
      if (node.data?.formulaSource !== undefined) return [{ type: 'text', value: node.data.formulaSource }];
      if (node.tagName === 'img') return [{ type: 'text', value: String(node.properties.alt ?? '') }];
      const descendants = node.children.flatMap(inline);
      return ['strong', 'em', 'del', 'code', 'br'].includes(node.tagName)
        ? [{ ...node, children: descendants }] : descendants;
    };
    const content: ElementContent[] = [];
    for (const block of blocks) {
      const parts = block.tree.children.flatMap(inline);
      if (!parts.length) continue;
      if (content.length) content.push({ type: 'text', value: ' ' });
      content.push(...parts);
    }
    return { type: 'root', children: content } as Root;
  }, [children]);
  return <span className="conversation-markdown-inline">{toJsxRuntime(tree, { Fragment, jsx, jsxs })}</span>;
});

/** Smooth snapshot-sized deltas over a short, bounded window without a character-rate backlog. */
export const BufferedMarkdown = memo(function BufferedMarkdown({ text, streamIdentity, streaming = true, onDisplayed }: {
  text: string;
  streamIdentity: string;
  streaming?: boolean;
  onDisplayed?(identity: string, text: string): void;
}) {
  // Mounting a row (including a restored live draft) is not a text delta.
  // Only additions observed by this mounted stream should animate.
  const [playback] = useState(() => ({ identity: streamIdentity, buffer: new StreamingTextBuffer(text) }));
  const [visible, setVisible] = useState(() => ({ identity: streamIdentity, text }));
  useLayoutEffect(() => {
    if (playback.identity !== streamIdentity) {
      playback.identity = streamIdentity;
      playback.buffer = new StreamingTextBuffer(text);
    }
    const { buffer } = playback;
    buffer.update(text, performance.now());
    let frame: number | null = null;
    const publish = () => setVisible((current) => current.identity === streamIdentity && current.text === buffer.text
      ? current : { identity: streamIdentity, text: buffer.text });
    const tick = (now: number) => {
      buffer.advance(now);
      publish();
      frame = buffer.complete ? null : requestAnimationFrame(tick);
    };
    publish();
    if (!buffer.complete) frame = requestAnimationFrame(tick);
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [playback, streamIdentity, text]);
  const displayed = visible.identity === streamIdentity && text.startsWith(visible.text) ? visible.text : text;
  const caughtUp = displayed === text;
  useLayoutEffect(() => {
    if (!streaming && caughtUp) onDisplayed?.(streamIdentity, displayed);
  }, [streaming, caughtUp, streamIdentity, displayed, onDisplayed]);
  return <MarkdownContent key={streamIdentity} streaming={streaming || !caughtUp}>{displayed}</MarkdownContent>;
});
