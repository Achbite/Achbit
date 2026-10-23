import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Sidebar menus share viewport coordinates with the pointer, outside pane clipping. */
export default function SidebarMenu({ x, y, className, id, children }: {
  x: number; y: number; className: string; id?: string; children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    const position = () => {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [x, y]);
  return createPortal(<div ref={menu} id={id} className={className} role="menu" data-native-overlay
    style={{ left: x, top: y }} onPointerDown={event => event.stopPropagation()}>
    {children}
  </div>, document.body);
}
