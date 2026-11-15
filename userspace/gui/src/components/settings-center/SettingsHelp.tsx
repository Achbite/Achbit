import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useInteractionFocus } from '../shared/interactionFocus';
import { useDismissibleLayer } from '../shared/useDismissibleLayer';
import './settingsHelp.css';

type HelpAnchor = { kind: 'pointer'; x: number; y: number } | { kind: 'focus'; rect: DOMRect };

/** Pointer help keeps its opening position; keyboard help stays anchored to its control. */
export function useSettingsHelp(description: string | undefined, { compact = false }: { compact?: boolean } = {}) {
  const interaction = useInteractionFocus();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const anchor = useRef<HelpAnchor | null>(null);
  const [open, setOpen] = useState(false);
  useDismissibleLayer({ open: open && !!description, roots: [trigger, ref], escapeCapture: true, onDismiss: () => setOpen(false) });
  const position = () => {
    const tooltip = ref.current;
    const target = anchor.current;
    if (!tooltip || !target) return;
    const box = tooltip.getBoundingClientRect();
    const margin = 8;
    const gap = 12;
    let left: number;
    let top: number;
    if (target.kind === 'pointer') {
      left = target.x + gap;
      top = target.y + gap;
      if (left + box.width + margin > window.innerWidth) left = target.x - box.width - gap;
      if (top + box.height + margin > window.innerHeight) top = target.y - box.height - gap;
    } else {
      left = target.rect.left;
      top = target.rect.bottom + 6;
      if (top + box.height + margin > window.innerHeight) top = target.rect.top - box.height - 6;
    }
    tooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - box.width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - box.height - margin))}px`;
  };
  const showPointer = (event: React.MouseEvent<HTMLElement>) => {
    if (!description) return;
    trigger.current = event.currentTarget;
    anchor.current = { kind: 'pointer', x: event.clientX, y: event.clientY };
    if (open) position();
    else setOpen(true);
  };
  useLayoutEffect(() => {
    if (!description) { setOpen(false); return; }
    const tooltip = ref.current;
    if (!tooltip || !open) return;
    tooltip.showPopover();
    position();
    const hide = () => setOpen(false);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => { tooltip.hidePopover(); window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true); };
  }, [open, description]);
  return {
    helpId: description ? id : undefined,
    helpEvents: {
      'data-escape-layer': open ? 'open' : undefined,
      onMouseEnter: showPointer,
      onMouseLeave: () => setOpen(false),
      onPointerDown: () => setOpen(false),
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (description && interaction?.keyboard !== false) {
          trigger.current = event.currentTarget;
          anchor.current = { kind: 'focus', rect: event.target.getBoundingClientRect() };
          if (open) position();
          else setOpen(true);
        }
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); },
    },
    help: description ? <div id={id} ref={ref} role="tooltip" popover="manual" className={`settings-help-tooltip${compact ? ' settings-help-tooltip--compact' : ''}`}>{description}</div> : null,
  };
}
