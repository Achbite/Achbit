import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useInteractionFocus } from '../shared/interactionFocus';

type HelpAnchor = { kind: 'pointer'; x: number; y: number } | { kind: 'focus'; rect: DOMRect };

/** Pointer help follows the cursor; keyboard help stays anchored to its control. */
export function useSettingsHelp(description: string | undefined) {
  const interaction = useInteractionFocus();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HelpAnchor | null>(null);
  const [open, setOpen] = useState(false);
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
    anchor.current = { kind: 'pointer', x: event.clientX, y: event.clientY };
    if (open) position();
    else setOpen(true);
  };
  useLayoutEffect(() => {
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
      onMouseMove: (event: React.MouseEvent<HTMLElement>) => {
        if (open && anchor.current?.kind === 'pointer') {
          anchor.current = { kind: 'pointer', x: event.clientX, y: event.clientY };
          position();
        }
      },
      onMouseLeave: () => setOpen(false),
      onPointerDown: () => setOpen(false),
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (description && interaction?.keyboard !== false) {
          anchor.current = { kind: 'focus', rect: event.target.getBoundingClientRect() };
          if (open) position();
          else setOpen(true);
        }
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); },
      onKeyDownCapture: (event: React.KeyboardEvent) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } },
    },
    help: description ? <div id={id} ref={ref} role="tooltip" popover="manual" className="settings-help-tooltip">{description}</div> : null,
  };
}
