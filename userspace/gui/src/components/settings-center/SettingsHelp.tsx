import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useInteractionFocus } from '../shared/interactionFocus';

/** Read-only help follows hover and keyboard focus without adding another disclosure row. */
export function useSettingsHelp(description: string | undefined) {
  const interaction = useInteractionFocus();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = (event: React.SyntheticEvent<HTMLElement>) => {
    if (description) setAnchor(event.currentTarget.getBoundingClientRect());
  };
  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!tooltip || !anchor) return;
    tooltip.showPopover();
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, anchor.bottom + box.height + 12 < window.innerHeight ? anchor.bottom + 6 : anchor.top - box.height - 6)}px`;
    const hide = () => setAnchor(null);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => { tooltip.hidePopover(); window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true); };
  }, [anchor]);
  return {
    helpId: description ? id : undefined,
    helpEvents: {
      'data-escape-layer': anchor ? 'open' : undefined,
      onMouseEnter: show,
      onMouseLeave: () => setAnchor(null),
      onPointerDown: () => setAnchor(null),
      onFocus: (event: React.FocusEvent<HTMLElement>) => { if (interaction?.keyboard !== false) show(event); },
      onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setAnchor(null); },
      onKeyDownCapture: (event: React.KeyboardEvent) => { if (event.key === 'Escape' && anchor) { event.preventDefault(); event.stopPropagation(); setAnchor(null); } },
    },
    help: description ? <div id={id} ref={ref} role="tooltip" popover="manual" className="settings-help-tooltip">{description}</div> : null,
  };
}
