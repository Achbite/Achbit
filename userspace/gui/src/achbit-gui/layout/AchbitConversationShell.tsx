import React from 'react';
import LocalAgentPanel, { type ConversationReaderLayout } from '../../components/local-agent/LocalAgentPanel';
import type { ReaderNavigation } from '../../components/local-agent/readerState';

const AchbitConversationShell: React.FC<{
  headerTarget: HTMLElement | null;
  onReaderLayoutChange?: (layout: ConversationReaderLayout) => void;
  readerNavigation?: ReaderNavigation;
}> = ({ headerTarget, onReaderLayoutChange, readerNavigation }) => (
  <main className="achbit-gui-session-main">
    <LocalAgentPanel mode="workbench" headerTarget={headerTarget} onReaderLayoutChange={onReaderLayoutChange} readerNavigation={readerNavigation} />
  </main>
);

export default AchbitConversationShell;
