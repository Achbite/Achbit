import type { SessionProjection } from '@achbit/protocol';

export interface CommittedTextBlock {
  blockId: string;
  text: string;
  format: 'plain' | 'markdown';
}

/** Content only: Session owns order and facts; each shell owns layout and interaction. */
export function projectCommittedText(projection: SessionProjection): Map<string, CommittedTextBlock> {
  const blocks = new Map<string, CommittedTextBlock>();
  for (const message of projection.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const blockId = `message:${message.messageId}:content`;
    blocks.set(blockId, { blockId, text: message.displayContent ?? message.content, format: message.role === 'assistant' ? 'markdown' : 'plain' });
  }
  for (const narrative of projection.narratives) {
    const blockId = `narrative:${narrative.narrativeId}`;
    blocks.set(blockId, { blockId, text: narrative.displayContent ?? narrative.content, format: 'markdown' });
  }
  return blocks;
}
