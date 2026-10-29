import { useEffect, useRef, type ComponentProps } from 'react';
import { finishPointerFocus } from './interactionFocus';

/** Keep the native picker, but end pointer selection instead of leaving editing focus behind. */
export default function NativeSelect({ onChange, onPointerDown, onKeyDown, onClick, onBlur, ...props }: ComponentProps<'select'>) {
  const pointerSelection = useRef(false);
  const frame = useRef<number | null>(null);
  const stop = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  useEffect(() => stop, []);
  const finish = (select: HTMLSelectElement) => {
    finishPointerFocus(select, pointerSelection.current);
  };
  return <select {...props}
    onPointerDown={event => {
      onPointerDown?.(event);
      if (event.defaultPrevented || event.button !== 0) return;
      pointerSelection.current = true;
      stop();
      const select = event.currentTarget;
      // Native pickers emit neither change nor a closing click when the existing
      // value is selected. Observe only this focused picker's open lifetime.
      const closed = () => {
        frame.current = null;
        if (!pointerSelection.current || !select.isConnected || select.ownerDocument.activeElement !== select) return;
        if (select.matches(':open')) frame.current = requestAnimationFrame(closed);
        else finish(select);
      };
      frame.current = requestAnimationFrame(closed);
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape') { pointerSelection.current = false; stop(); }
      onKeyDown?.(event);
    }}
    onChange={event => { onChange?.(event); finish(event.currentTarget); }}
    onClick={onClick}
    onBlur={event => { pointerSelection.current = false; stop(); onBlur?.(event); }}
  />;
}
