import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useInteractionFocus } from '../shared/interactionFocus';
import { useDismissibleLayer } from '../shared/useDismissibleLayer';
import './settingsHelp.css';

type HelpAnchor = { kind: 'pointer'; x: number; y: number } | { kind: 'control'; rect: DOMRect };
type HelpSource = 'pointer' | 'focus' | 'keyboard' | 'activation' | 'layout' | 'lifecycle';
const pointerGap = 12;

/** Pointer help keeps its opening position; keyboard help stays anchored to its control. */
export function useSettingsHelp(description: React.ReactNode, { compact = false, showOnClick = false } = {}) {
  const interaction = useInteractionFocus();
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const anchor = useRef<HelpAnchor | null>(null);
  const opening = useRef({ source: 'focus' as HelpSource, reason: 'focus' });
  const closing = useRef<{ source: HelpSource; reason: string } | null>(null);
  const crossingGap = useRef(false);
  const focused = useRef(false);
  const [open, setOpen] = useState(false);
  const hasHelp = !!description;
  const close = (source: HelpSource, reason: string) => {
    crossingGap.current = false;
    closing.current = { source, reason };
    setOpen(false);
  };
  useDismissibleLayer({ open: open && hasHelp, roots: [trigger, ref], escapeCapture: true,
    onDismiss: reason => close(reason === 'escape' ? 'keyboard' : reason === 'focus-outside' ? 'focus' : 'pointer', reason) });
  const position = () => {
    const tooltip = ref.current;
    const target = anchor.current;
    if (!tooltip || !target) return;
    const box = tooltip.getBoundingClientRect();
    const margin = 8;
    let left: number;
    let top: number;
    if (target.kind === 'pointer') {
      left = target.x + pointerGap;
      top = target.y + pointerGap;
      if (left + box.width + margin > window.innerWidth) left = target.x - box.width - pointerGap;
      if (top + box.height + margin > window.innerHeight) top = target.y - box.height - pointerGap;
    } else {
      left = target.rect.left;
      top = target.rect.bottom + 6;
      if (top + box.height + margin > window.innerHeight) top = target.rect.top - box.height - 6;
    }
    tooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - box.width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - box.height - margin))}px`;
  };
  const show = (element: HTMLElement, next: HelpAnchor, source: HelpSource, reason: string) => {
    if (!hasHelp) return;
    trigger.current = element;
    anchor.current = next;
    crossingGap.current = false;
    opening.current = { source, reason };
    closing.current = null;
    if (open) position();
    else setOpen(true);
  };
  const checkPointer = (event: { relatedTarget: EventTarget | null; clientX: number; clientY: number }) => {
    if (focused.current) return;
    const tooltip = ref.current;
    if (tooltip && event.relatedTarget instanceof Node) {
      if (trigger.current?.contains(event.relatedTarget) || tooltip.contains(event.relatedTarget)) {
        crossingGap.current = false;
        return;
      }
      const rect = tooltip.getBoundingClientRect();
      // Keep the short gap traversable at any speed without putting a pointer-catching box over neighbors.
      if (event.clientX >= rect.left - pointerGap && event.clientX <= rect.right + pointerGap
        && event.clientY >= rect.top - pointerGap && event.clientY <= rect.bottom + pointerGap) {
        crossingGap.current = true;
        return;
      }
    }
    close('pointer', 'pointer-leave');
  };
  useLayoutEffect(() => {
    if (!hasHelp) { setOpen(false); return; }
    const tooltip = ref.current;
    if (!tooltip || !open) return;
    tooltip.showPopover();
    position();
    window.__ACHBIT_DEBUG_UI__?.observe?.('settings.help', 'help.opened', { instanceId: id, ...opening.current });
    const resize = () => close('layout', 'resize');
    const scroll = (event: Event) => {
      if (!tooltip.contains(event.target instanceof Node ? event.target : null)) close('layout', 'scroll');
    };
    const move = (event: MouseEvent) => {
      if (crossingGap.current) checkPointer({ relatedTarget: event.target, clientX: event.clientX, clientY: event.clientY });
    };
    const leaveDocument = (event: MouseEvent) => {
      if (event.relatedTarget === null && !focused.current) close('pointer', 'pointer-leave');
    };
    const owner = tooltip.ownerDocument;
    owner.addEventListener('mousemove', move, true);
    owner.addEventListener('mouseout', leaveDocument, true);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      owner.removeEventListener('mousemove', move, true);
      owner.removeEventListener('mouseout', leaveDocument, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
      tooltip.hidePopover();
      window.__ACHBIT_DEBUG_UI__?.observe?.('settings.help', 'help.closed',
        { instanceId: id, ...(closing.current ?? { source: 'lifecycle', reason: 'surface-removed' }) });
    };
  }, [open, hasHelp, id]);
  return {
    helpId: hasHelp ? id : undefined,
    helpEvents: {
      'data-escape-layer': open ? 'open' : undefined,
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        show(event.currentTarget, { kind: 'pointer', x: event.clientX, y: event.clientY }, 'pointer', 'pointer-enter');
      },
      onMouseLeave: checkPointer,
      ...(showOnClick ? { onClick: (event: React.MouseEvent<HTMLElement>) => {
        show(event.currentTarget, { kind: 'control', rect: event.currentTarget.getBoundingClientRect() }, 'activation', 'activate');
      } } : { onPointerDown: () => close('pointer', 'trigger-press') }),
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (interaction?.keyboard !== false) {
          focused.current = true;
          show(event.currentTarget, { kind: 'control', rect: event.target.getBoundingClientRect() }, 'focus', 'focus');
        }
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focused.current = false;
          close('focus', 'focus-outside');
        }
      },
    },
    help: hasHelp ? <span id={id} ref={ref} role="tooltip" popover="manual"
      className={`settings-help-tooltip${compact ? ' settings-help-tooltip--compact' : ''}`}
      onMouseLeave={checkPointer} onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}>{description}</span> : null,
  };
}
