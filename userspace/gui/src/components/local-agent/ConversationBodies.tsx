import { createContext, memo, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { SessionProjection } from '@achbit/protocol';
import { useShallow } from 'zustand/react/shallow';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { ConversationSessionScope } from './ConversationSessionScope';
import { AgentNavigation, useAgentNavigation } from './agentNavigation';
import type { ConversationViewport } from './useConversationViewport';

export const ReadingBodyActive = createContext(true);

interface ReadingBodyProps {
  sessionId: string | null;
  createdAt?: string;
  projection: SessionProjection | null;
  viewport: ConversationViewport;
  children: ReactNode;
}

type ReadingView = ReadingBodyProps & { agentNavigation: ReturnType<typeof useAgentNavigation> };

/** Keep the original DOM, including decoded thumbnails and sandboxed preview frames,
 * for visited histories that the Session store can still serve from memory. */
export function ConversationBodies(props: ReadingBodyProps) {
  const current = { ...props, agentNavigation: useAgentNavigation() };
  const retained = useLocalAgentStore(useShallow(state => state.retainedProjections()));
  const previous = useRef<ReadingView[]>([]);
  const views: ReadingView[] = [];
  for (const view of previous.current) {
    if (view.sessionId === current.sessionId) views.push(current);
    else if (view.projection && retained.includes(view.projection)) views.push(view);
  }
  if (!views.includes(current)) views.push(current);
  useLayoutEffect(() => { previous.current = views; });
  // Stable sibling order matters: moving an iframe in the DOM restarts its document.
  return views.map(view => <ReadingBody key={JSON.stringify([view.sessionId, view.createdAt])} view={view} active={view === current} />);
}

const ReadingBody = memo(function ReadingBody({ view, active }: { view: ReadingView; active: boolean }) {
  const { viewport } = view;
  const node = useRef<HTMLDivElement | null>(null);
  const { bodyRef } = viewport;
  const attach = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    if (element && active) {
      bodyRef.current = element;
      return () => { if (bodyRef.current === element) bodyRef.current = null; };
    }
  }, [active, bodyRef]);
  useLayoutEffect(() => {
    if (!active) for (const dialog of node.current?.querySelectorAll<HTMLDialogElement>('dialog[open]') ?? []) dialog.close();
  }, [active]);
  return <div ref={attach} className={active ? 'local-agent__body' : undefined} hidden={!active} inert={!active}
    data-following-tail={active && viewport.followingLatest || undefined} aria-live={active ? 'polite' : 'off'}
    {...(active ? viewport.bodyHandlers : undefined)}>
    <ReadingBodyActive.Provider value={active}>
      <AgentNavigation.Provider value={view.agentNavigation}>
        <ConversationSessionScope.Provider value={view.sessionId ?? undefined}>{view.children}</ConversationSessionScope.Provider>
      </AgentNavigation.Provider>
    </ReadingBodyActive.Provider>
  </div>;
});
