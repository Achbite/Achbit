import React, { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { CodeContent, ImageContent, MermaidContent } from './RichContent';
import { MarkdownTable } from './MarkdownTable';
import { formatDecisionProse, StreamingMarkdownParser, type MarkdownBlock } from './streamingMarkdown';
import { StreamingTextBuffer } from './streamingText';
import type { ElementContent, Root, RootContent } from 'hast';
import './richContent.css';
import { readableResourceLinks } from './resourceLinks';
import { ConversationSessionScope } from './ConversationSessionScope';
import { useConversationHost } from './ConversationHost';
import { workspaceResourceLink } from './documentResources';
import { requestWorkspacePreview } from './readerState';
import 'katex/dist/katex.min.css';

const StreamingContext = createContext(false);
const COMPONENTS = {
  pre: function MarkdownCode({ children }: { children?: React.ReactNode }) {
    const streaming = useContext(StreamingContext);
    const child = React.Children.toArray(children)[0];
    if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) return <pre>{children}</pre>;
    const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '';
    const code = String(child.props.children ?? '');
    return language === 'mermaid' && !streaming
      ? <MermaidContent source={code} /> : <CodeContent code={code} language={language} streaming={streaming} />;
  },
  table: MarkdownTable,
  img: function MarkdownImage({ src, alt }: { src?: string; alt?: string }) { return <ImageContent source={src ?? ''} alt={alt ?? ''} />; },
  a: ScopedMarkdownLink,
};

function ScopedMarkdownLink({ href, children, ...attributes }: React.ComponentPropsWithoutRef<'a'>) {
  const childSession = useContext(ConversationSessionScope);
  const host = useConversationHost();
  const [error, setError] = useState<string | null>(null);
  if (!childSession) return <a {...attributes} href={href}>{children}</a>;
  const resource = workspaceResourceLink(href ?? '');
  if (!href || !resource && !/^https?:\/\//i.test(href)) return <span title={href}>{children}</span>;
  const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setError(null);
    void (resource ? requestWorkspacePreview(childSession, resource.workspaceId, resource.logicalPath) : host.openExternalLink(href))
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return <><a {...attributes} href={href} onClick={open} onAuxClick={open}>{children}</a>{error && <span role="alert">{error}</span>}</>;
}

const RenderedBlock = memo(function RenderedBlock({ block }: { block: MarkdownBlock }) {
  return <StreamingContext.Provider value={block.streaming}>{toJsxRuntime(readableResourceLinks(block.tree), { Fragment, jsx, jsxs, components: COMPONENTS })}</StreamingContext.Provider>;
});

export const MarkdownContent = memo(function MarkdownContent({ children, streaming = false, decisionProse = false }: { children: string; streaming?: boolean; decisionProse?: boolean }) {
  const parser = useRef(new StreamingMarkdownParser());
  const blocks = useMemo(() => parser.current.update(decisionProse ? formatDecisionProse(children) : children, streaming), [children, streaming, decisionProse]);
  return <div className="conversation-markdown">{blocks.map((block) => <RenderedBlock key={block.key} block={block} />)}</div>;
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
