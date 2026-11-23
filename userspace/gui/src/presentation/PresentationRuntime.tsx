import React, { useCallback, useMemo } from 'react';
import { projectCommittedText } from './projectCommittedText';
import type { SessionProjection } from '@achbit/protocol';
import type { OpeningReadingWindow } from '../state/recentSessionViews';
import { MarkdownContent } from '../components/local-agent/BufferedMarkdown';
import { UiPluginSlotView, useDisplayTheme, useUiPlugins } from '../ui-plugins/UiPlugins';

export interface PresentedCommittedContent {
  layoutKey: string;
  content(blockId: string): React.ReactNode;
}

// The store already owns the recent snapshots. Keep text indices only as long as
// their exact snapshot is reachable; rendered/plugin elements remain local to the mount.
const committedBySnapshot = new WeakMap<SessionProjection, ReturnType<typeof projectCommittedText>>();
const emptyBlocks: ReturnType<typeof projectCommittedText> = new Map();
function committedBlocks(projection: SessionProjection | null) {
  if (!projection) return emptyBlocks;
  let blocks = committedBySnapshot.get(projection);
  if (!blocks) {
    blocks = projectCommittedText(projection);
    committedBySnapshot.set(projection, blocks);
  }
  return blocks;
}

export function usePresentedCommittedContent(projection: SessionProjection | null, locale: string, reading?: OpeningReadingWindow | null): PresentedCommittedContent {
  const theme = useDisplayTheme();
  const { entries } = useUiPlugins();
  // For a continuously displayed live run the committed prefix is journal-owned:
  // draft/tool deltas at the same revision must not rebuild it on every update.
  const live = projection?.assistantDraft || ['running', 'waiting', 'releasing'].includes(projection?.run?.status ?? '');
  const blocks = useMemo(() => !projection && reading ? projectCommittedText({ messages: reading.rows.map(row => row.message), narratives: [] })
    : committedBlocks(projection), [projection?.sessionId, projection?.revision, live ? null : projection, reading]);
  const rendered = useMemo(() => new Map<string, React.ReactNode>(), [blocks, locale, theme, entries]);
  const content = useCallback((blockId: string) => {
    if (!rendered.has(blockId)) {
      const block = blocks.get(blockId);
      if (!block) throw new Error(`presentation_text_missing:${blockId}`);
      const slot = block.format === 'plain' ? 'message.plain' : 'message.markdown';
      const builtin = block.format === 'plain'
        ? <div className="conversation-plain">{block.text}</div>
        : <MarkdownContent>{block.text}</MarkdownContent>;
      rendered.set(blockId, entries.some((entry) => entry.status !== 'disabled' && entry.manifest?.slots.includes(slot))
        ? <UiPluginSlotView slot={slot} input={{ kind: 'message', text: block.text, format: block.format, locale, theme }}>{builtin}</UiPluginSlotView>
        : builtin);
    }
    return rendered.get(blockId);
  }, [blocks, rendered, locale, theme, entries]);
  const rendererKey = useMemo(() => JSON.stringify(entries.map(entry => [entry.path, entry.generation, entry.status])), [entries]);
  return { layoutKey: `${projection?.sessionId ?? reading?.sessionId ?? 'empty'}:${projection?.revision ?? reading?.revision ?? 0}:${locale}:${theme}:${rendererKey}`, content };
}
