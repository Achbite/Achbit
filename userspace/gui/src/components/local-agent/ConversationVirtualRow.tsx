import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationVirtualizer } from './conversationVirtualizer';

const RowState = createContext<Map<string, unknown> | null>(null);
const RetainPreview = createContext<() => void>(() => {});
export const useRetainConversationPreview = () => useContext(RetainPreview);

/** Only presentation state is retained when a row leaves the viewport. */
export function useConversationRowState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const cache = useContext(RowState);
  const [value, setValue] = useState<T>(() => cache?.has(key) ? cache.get(key) as T : initial);
  const update = useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    setValue((previous) => {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      cache?.set(key, value);
      return value;
    });
  }, [cache, key]);
  return [value, update];
}

export function ConversationVirtualRow({ rowKey, sequence, virtualizer, virtualize = true, hidden = false, eager = false, live = false, transient = false, children }: {
  rowKey: string;
  sequence?: number;
  virtualize?: boolean;
  virtualizer: ConversationVirtualizer;
  hidden?: boolean;
  eager?: boolean;
  live?: boolean;
  transient?: boolean;
  children(): React.ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  // A permanently rendered row keeps its own state even after its cache entry ages out.
  // Virtual rows still read their latest measured height when they reappear.
  const mountedLayout = useMemo(() => virtualize ? null : virtualizer.layout(rowKey), [virtualize, virtualizer, rowKey]);
  const layout = mountedLayout ?? virtualizer.layout(rowKey);
  const rendered = !hidden && (!virtualize || visible || live);
  const retain = useCallback(() => virtualizer.retainPreview(rowKey), [virtualizer, rowKey]);
  useLayoutEffect(() => virtualize && !hidden ? virtualizer.register(rowKey, node.current!, setVisible) : undefined, [virtualize, virtualizer, rowKey, hidden]);
  useLayoutEffect(() => { if (virtualize && !hidden) virtualizer.measure(node.current!); }, [virtualize, hidden, virtualizer, rowKey, rendered]);
  return <div ref={node} className="conversation-virtual-row" data-conversation-anchor={transient ? undefined : rowKey} data-transcript-sequence={sequence}
    data-virtual-rendered={rendered} hidden={hidden}
    style={!hidden && !rendered ? { height: layout.height ?? 120 } : undefined}>
    {rendered && <RowState.Provider value={layout.state}><RetainPreview.Provider value={retain}>{children()}</RetainPreview.Provider></RowState.Provider>}
  </div>;
}
