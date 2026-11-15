import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { captureFocusReturn, focusOpenedPanel, useInteractionFocus } from '../../components/shared/interactionFocus';
import { useDismissibleLayer } from '../../components/shared/useDismissibleLayer';
import { nextEnabledIndex } from '../../components/shared/keyboardNavigation';

/** Sidebar menus share viewport coordinates with the pointer, outside pane clipping. */
export default function SidebarMenu({ x, y, className, id, children, onClose }: {
  x: number; y: number; className: string; id?: string; children: ReactNode; onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const interaction = useInteractionFocus();
  const trigger = useRef((interaction ? interaction.capture() : captureFocusReturn()).target);
  useDismissibleLayer({ open: true, roots: [menu, trigger], trigger, onDismiss: onClose });
  useLayoutEffect(() => {
    if (menu.current) focusOpenedPanel(menu.current, menu.current.querySelector('button:not(:disabled)'), interaction);
  }, [interaction]);
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
  return createPortal(<div ref={menu} id={id} className={className} role="menu" tabIndex={-1} data-native-overlay
    style={{ left: x, top: y }} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = nextEnabledIndex(buttons.map(() => true), index, event.key);
      buttons[next]?.focus();
    }}>
    {children}
  </div>, document.body);
}
