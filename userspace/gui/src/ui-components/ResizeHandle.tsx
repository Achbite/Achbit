import { useEffect, useRef } from 'react';
import { boundedPaneWidth, resizedPaneWidth } from '../components/shared/paneGeometry';
import './resizeHandle.css';

interface ResizeHandleProps {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  direction: 1 | -1;
  onResize(value: number): void;
  pixelsPerUnit?: (element: HTMLElement) => number;
}

/** The same pointer lifetime and keyboard behavior for every vertical pane boundary. */
export default function ResizeHandle({ className, label, value, min, max, step, direction, onResize, pixelsPerUnit }: ResizeHandleProps) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startX: number; value: number; scale: number } | null>(null);
  const end = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (handle.current?.hasPointerCapture(current.id)) handle.current.releasePointerCapture(current.id);
    document.body.classList.remove('pane-resizing');
  };
  useEffect(() => {
    window.addEventListener('blur', end);
    return () => { window.removeEventListener('blur', end); end(); };
  }, []);
  return <div ref={handle} className={`pane-resize ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      document.getSelection()?.removeAllRanges();
      drag.current = { id: event.pointerId, startX: event.clientX, value, scale: pixelsPerUnit?.(event.currentTarget) ?? 1 };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('pane-resizing');
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || event.pointerId !== current.id) return;
      onResize(resizedPaneWidth(current.value, event.clientX - current.startX, direction, current.scale, min, max));
    }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? min : event.key === 'End' ? max
        : value + (event.key === 'ArrowRight' ? step : -step) * direction;
      onResize(boundedPaneWidth(next, min, max));
    }} />;
}
