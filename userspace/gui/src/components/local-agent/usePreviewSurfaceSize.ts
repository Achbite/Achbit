import { useLayoutEffect, useState, type RefObject } from 'react';

/** Display size only; resizing a surface must not replace its live iframe. */
export function usePreviewSurfaceSize(ref: RefObject<HTMLDivElement | null>, enabled = true) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return size;
}
