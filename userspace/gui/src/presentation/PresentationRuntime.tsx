import React, { useCallback, useMemo } from 'react';
import { projectCommittedText } from '@achbit/presentation-core';
import type { SessionProjection } from '@achbit/protocol';
import { MarkdownContent } from '../components/local-agent/BufferedMarkdown';
import { UiPluginSlotView, useDisplayTheme, useUiPlugins } from '../ui-plugins/UiPlugins';

export interface PresentedCommittedContent {
  layoutKey: string;
  content(blockId: string): React.ReactNode;
}

export function usePresentedCommittedContent(projection: SessionProjection | null, locale: string): PresentedCommittedContent {
  const theme = useDisplayTheme();
  const { entries } = useUiPlugins();
  const blocks = useMemo(() => projection ? projectCommittedText(projection) : new Map(), [projection?.sessionId, projection?.revision]);
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
  return { layoutKey: `${projection?.sessionId ?? 'empty'}:${projection?.revision ?? 0}:${locale}`, content };
}
