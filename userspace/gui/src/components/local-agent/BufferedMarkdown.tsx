import React, { createContext, memo, startTransition, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { CodeContent, ImageContent } from './RichContent';
import { MathContent } from './MathContent';
import { MermaidContent } from './MermaidContent';
import { MarkdownTable } from './MarkdownTable';
import { formatDecisionProse, cachedMarkdown, completeMarkdown, StreamingMarkdownParser, type MarkdownBlock } from './streamingMarkdown';
import { StreamingTextBuffer } from './streamingText';
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
  img: function MarkdownImage({ src, alt }: { src?: string; alt?: string }) { return <ImageContent source={src ?? ''} alt={alt ?? ''} />; },
  span: function MarkdownSpan({ node, children, ...attributes }: React.ComponentPropsWithoutRef<'span'> & { node?: Element }) {
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
  return <MarkdownBlockScope.Provider value={{ key: block.key, start: block.tree.children[0]?.position?.start.offset,
    streaming: block.streaming, copyPending: provisional && block.streaming }}>
    {toJsxRuntime(readableResourceLinks(block.tree), { Fragment, jsx, jsxs, components: COMPONENTS, passNode: true })}
  </MarkdownBlockScope.Provider>;
});

interface MarkdownContentProps { children: string; streaming?: boolean; decisionProse?: boolean; active?: boolean; documentPreview?: boolean }

function MarkdownBlocks({ blocks, provisional = false }: { blocks: MarkdownBlock[]; provisional?: boolean }) {
  return <>{blocks.map(block => <RenderedBlock key={block.key} block={block} provisional={provisional} />)}</>;
}

function ImmediateMarkdown({ children, streaming = false, decisionProse = false }: MarkdownContentProps) {
  const parser = useRef(new StreamingMarkdownParser());
  const blocks = useMemo(() => parser.current.update(decisionProse ? formatDecisionProse(children) : children, streaming), [children, streaming, decisionProse]);
  return <div className="conversation-markdown"><MarkdownBlocks blocks={blocks} /></div>;
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
function SearchableDocumentPreview({ text, decisionProse }: { text: string; decisionProse: boolean }) {
  const first = useMemo(() => firstPage(text), [text]);
  const preview = useMemo(() => new StreamingMarkdownParser().update(decisionProse ? formatDecisionProse(first) : first, true), [first, decisionProse]);
  return <><MarkdownBlocks blocks={preview} provisional /><pre className="conversation-markdown__pending-source">{text.slice(first.length)}</pre></>;
}

function ProgressiveMarkdown({ children: text, decisionProse = false, active = true, documentPreview = false }: MarkdownContentProps) {
  const language = useUiLanguage();
  const surface = useRef<HTMLDivElement>(null);
  const cached = useMemo(() => decisionProse ? undefined : cachedMarkdown(text), [text, decisionProse]);
  const [result, setResult] = useState<{ text: string; decisionProse: boolean; blocks?: MarkdownBlock[]; error?: string } | null>(null);
  const current = result?.text === text && result.decisionProse === decisionProse ? result : null;
  const blocks = current?.blocks ?? cached;
  useEffect(() => {
    if (!active || blocks || current?.error) return;
    const controller = new AbortController();
    void parseMarkdownDocument(text, decisionProse, controller.signal).then(root => {
      if (controller.signal.aborted) return;
      const completed = completeMarkdown(root, decisionProse ? undefined : text);
      const publish = () => {
        const selection = document.getSelection();
        if (surface.current && selection && !selection.isCollapsed && selection.containsNode(surface.current, true)) return;
        document.removeEventListener('selectionchange', publish);
        startTransition(() => setResult({ text, decisionProse, blocks: completed }));
      };
      // A selection in the provisional view remains usable until the reader releases it.
      document.addEventListener('selectionchange', publish, { signal: controller.signal });
      publish();
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setResult({ text, decisionProse, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [text, decisionProse, active, blocks, current?.error]);
  const pending = !blocks && !current?.error;
  return <div className="conversation-markdown" ref={surface} aria-busy={pending} data-conversation-pending={pending && !documentPreview || undefined}>
    {blocks ? <MarkdownBlocks blocks={blocks} /> : documentPreview ? <SearchableDocumentPreview text={text} decisionProse={decisionProse} />
      : pending && <span role="status">{t(language, 'agent.chat.preparingText')}</span>}
    {current?.error && <p role="alert">{current.error}</p>}
  </div>;
}

export const MarkdownContent = memo(function MarkdownContent(props: MarkdownContentProps) {
  return !props.streaming && props.children.length > 24_000
    ? <ProgressiveMarkdown {...props} />
    : <ImmediateMarkdown {...props} />;
});

/** Inline fields share the Markdown grammar, without nested links or block layout in buttons/headings. */
export const MarkdownInline = memo(function MarkdownInline({ children }: { children: string }) {
  const tree = useMemo(() => {
    const blocks = new StreamingMarkdownParser().update(children, false);
    const inline = (node: RootContent): ElementContent[] => {
      if (node.type === 'text') return [node];
      if (node.type !== 'element') return [];
      const descendants = node.children.flatMap(inline);
      return ['strong', 'em', 'del', 'code', 'br'].includes(node.tagName)
        ? [{ ...node, children: descendants }] : descendants;
    };
    return { type: 'root', children: blocks.flatMap((block) => block.tree.children.flatMap(inline)) } as Root;
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
  const playback = useRef({ identity: streamIdentity, buffer: new StreamingTextBuffer(streaming ? '' : text) });
  const [visible, setVisible] = useState({ identity: streamIdentity, text: playback.current.buffer.text });
  useLayoutEffect(() => {
    if (playback.current.identity !== streamIdentity) {
      playback.current = { identity: streamIdentity, buffer: new StreamingTextBuffer(streaming ? '' : text) };
    }
    const { buffer } = playback.current;
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
  }, [streamIdentity, text, streaming]);
  const displayed = visible.identity === streamIdentity ? visible.text : streaming ? '' : text;
  const caughtUp = displayed === text;
  useLayoutEffect(() => {
    if (!streaming && caughtUp) onDisplayed?.(streamIdentity, displayed);
  }, [streaming, caughtUp, streamIdentity, displayed, onDisplayed]);
  return <MarkdownContent streaming={streaming || !caughtUp}>{displayed}</MarkdownContent>;
});
