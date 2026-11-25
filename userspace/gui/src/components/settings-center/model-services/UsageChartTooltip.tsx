import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

export type UsageAnchor = { index: number; bar: HTMLButtonElement; pointerY?: number };
const gap = 8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** The card and the plot share a local coordinate system. If neither side fits,
 * use space above/below the plot rather than clamping the card across its bar. */
export default function UsageChartTooltip({ anchor, plotRef, id, children }: {
  anchor: UsageAnchor; plotRef: RefObject<HTMLDivElement | null>; id: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = ref.current, plot = plotRef.current;
    if (!card || !plot) return;
    const { bar } = anchor;
    const scroller = plot.closest('.settings-body');
    let pointerY = anchor.pointerY;
    const place = () => {
      const chart = plot.getBoundingClientRect(), column = bar.getBoundingClientRect();
      const clip = scroller?.getBoundingClientRect();
      const left = Math.max(chart.left, clip?.left ?? 0, 0), right = Math.min(chart.right, clip?.right ?? innerWidth, innerWidth);
      const top = Math.max(clip?.top ?? 0, 0), bottom = Math.min(clip?.bottom ?? innerHeight, innerHeight);
      const visible = column.width > 0 && column.right > left && column.left < right && column.top < bottom && column.bottom > top;
      card.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      card.style.maxWidth = `${right - left}px`;
      const box = card.getBoundingClientRect();
      const before = column.left - left - gap, after = right - column.right - gap;
      const above = chart.top - top - gap, below = bottom - chart.bottom - gap;
      let x, y;
      if (Math.max(before, after) >= box.width) {
        x = after >= before ? column.right + gap : column.left - gap - box.width;
        const barTop = bar.firstElementChild?.getBoundingClientRect().top ?? column.top;
        y = clamp((pointerY ?? barTop) - box.height / 2, Math.max(top, column.top), Math.min(bottom, column.bottom) - box.height);
        y = clamp(y, top, bottom - box.height);
      } else {
        x = clamp((column.left + column.right - box.width) / 2, left, right - box.width);
        y = above >= box.height && (below < box.height || above > below) ? chart.top - gap - box.height : chart.bottom + gap;
      }
      // A short, narrow pane may have no space on screen: keep the card in the
      // scrollable layout below the chart instead of obscuring the active column.
      const inline = y >= chart.bottom;
      card.toggleAttribute('data-inline', inline);
      card.style.left = `${x - chart.left}px`;
      card.style.top = inline ? '' : `${y - chart.top}px`;
    };
    const move = (event: MouseEvent) => { pointerY = event.clientY; place(); };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(plot); observer.observe(card); observer.observe(bar);
    if (scroller) observer.observe(scroller);
    if (anchor.pointerY !== undefined) bar.addEventListener('mousemove', move);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect(); bar.removeEventListener('mousemove', move);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    };
  }, [anchor, plotRef]);
  return <div ref={ref} id={id} className="model-chart-tooltip" role="tooltip">{children}</div>;
}
