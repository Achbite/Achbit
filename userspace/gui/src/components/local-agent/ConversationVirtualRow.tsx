import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
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

export function ConversationVirtualRow({ rowKey, virtualizer, hidden = false, eager = false, live = false, children }: {
  rowKey: string;
  virtualizer: ConversationVirtualizer;
  hidden?: boolean;
  eager?: boolean;
  live?: boolean;
  children(): React.ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const layout = virtualizer.layout(rowKey);
  const rendered = !hidden && (visible || live);
  const retain = useCallback(() => virtualizer.retainPreview(rowKey), [virtualizer, rowKey]);
  useLayoutEffect(() => virtualizer.register(rowKey, node.current!, setVisible), [virtualizer, rowKey, hidden]);
  useLayoutEffect(() => { virtualizer.measure(node.current!); }, [virtualizer, rowKey, rendered]);
  return <div ref={node} className="conversation-virtual-row" data-conversation-anchor={rowKey}
    data-virtual-rendered={rendered} hidden={hidden}
    style={!hidden && !rendered ? { height: layout.height ?? 120 } : undefined}>
    {rendered && <RowState.Provider value={layout.state}><RetainPreview.Provider value={retain}>{children()}</RetainPreview.Provider></RowState.Provider>}
  </div>;
}
