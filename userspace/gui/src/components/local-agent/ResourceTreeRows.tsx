import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { ResourceEntry } from '../../services/conversationResources';

const margin = 6;

type RevealRow = (id: string) => void;

/** Each item keeps its tree identity, keyboard state and ARIA sibling position when its row leaves the viewport. */
export function ResourceTreeRows<T extends { entry?: ResourceEntry }>({ tree, items, label, activeDepth, menuId, reveal, children }: {
  tree: TreeInstance<T>; items: ItemInstance<T>[]; label: string; activeDepth: number; menuId?: string;
  reveal: RefObject<RevealRow | null>; children(item: ItemInstance<T>, top: number): ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    tree.registerElement(element);
  }, [tree]);
  const [metrics, setMetrics] = useState({ height: 30, gap: 10 });
  const [range, setRange] = useState({ first: 0, count: 1 });
  const offsets = useMemo(() => {
    let top = 0;
    return items.map(item => {
      if (item.getItemData().entry?.category) top += metrics.gap;
      const position = top;
      top += metrics.height;
      return position;
    });
  }, [items, metrics]);
  useLayoutEffect(() => {
    const container = viewport.current!;
    const padding = parseFloat(getComputedStyle(container).paddingTop) || 0;
    const update = () => {
      if (!container.clientHeight) return;
      let low = 0, high = offsets.length;
      const top = container.scrollTop - padding;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (offsets[middle] + metrics.height <= top) low = middle + 1;
        else high = middle;
      }
      const first = Math.max(0, low - margin);
      const count = Math.ceil(container.clientHeight / metrics.height) + 2 * margin + 1;
      setRange(previous => previous.first === first && previous.count === count ? previous : { first, count });
    };
    reveal.current = id => {
      const index = items.findIndex(item => item.getId() === id);
      if (index < 0 || !container.clientHeight) return;
      const top = offsets[index] + padding;
      if (top < container.scrollTop) container.scrollTop = top;
      else if (top + metrics.height > container.scrollTop + container.clientHeight) container.scrollTop = top + metrics.height - container.clientHeight;
      update();
    };
    const measure = () => {
      const row = container.querySelector<HTMLElement>('[role=treeitem]');
      const height = row && parseFloat(getComputedStyle(row).height);
      const gap = parseFloat(getComputedStyle(container).getPropertyValue('--resource-tree-group-gap'));
      if (height && Number.isFinite(gap)) setMetrics(previous => previous.height === height && previous.gap === gap ? previous : { height, gap });
      update();
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(container);
    const row = container.querySelector<HTMLElement>('[role=treeitem]');
    if (row) resize.observe(row);
    container.addEventListener('scroll', update, { passive: true });
    return () => { container.removeEventListener('scroll', update); resize.disconnect(); reveal.current = null; };
  }, [items, metrics, offsets, reveal]);
  const first = Math.min(range.first, Math.max(0, items.length - range.count));
  const end = Math.min(items.length, first + range.count);
  const indices = Array.from({ length: end - first }, (_, index) => first + index);
  const focusedId = tree.getFocusedItem()?.getId();
  const retained = useMemo(() => [focusedId, menuId].map(id => id ? items.findIndex(item => item.getId() === id) : -1), [items, focusedId, menuId]);
  for (const index of retained) {
    if (index >= 0 && (index < first || index >= end) && !indices.includes(index)) indices.push(index);
  }
  return <div className="resource-tree__items" {...tree.getContainerProps(label)} ref={attach} style={{ '--resource-tree-active-depth': activeDepth } as CSSProperties}>
    <div className="resource-tree__rows" role="presentation" style={{ height: offsets.length ? offsets[offsets.length - 1] + metrics.height : 0 }}>
      {indices.sort((a, b) => a - b).map(index => children(items[index], offsets[index]))}
    </div>
  </div>;
}
