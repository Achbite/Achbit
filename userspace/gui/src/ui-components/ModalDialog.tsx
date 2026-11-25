import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './modalDialog.css';
import { captureFocusReturn, focusOpenedPanel, returnInteractionFocus, useInteractionFocus } from '../components/shared/interactionFocus';

/** The native top layer owns focus containment, nested dialogs and background inertness. */
export default function ModalDialog({ children, onClose, busy = false, className = '', ...label }: {
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const interaction = useInteractionFocus();
  // Capture before children with autoFocus mount, including mouse triggers on macOS.
  const origin = useRef(interaction ? interaction.capture() : captureFocusReturn());
  const ref = useRef<HTMLDialogElement>(null);
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const active = dialog.ownerDocument.activeElement;
    if (interaction?.keyboard === false && active instanceof HTMLElement
      && active.matches('button, summary, a[href], select, input[type="checkbox"], input[type="radio"], input[type="range"], [role="button"], [role="tab"]')) {
      focusOpenedPanel(dialog, null, interaction);
    }
    return () => {
      dialog.close();
      if (interaction) interaction.restore(origin.current);
      else returnInteractionFocus(origin.current, true);
    };
  }, []);
  const dismiss = () => { if (!state.current.busy) state.current.onClose(); };
  return createPortal(<dialog ref={ref} {...label} className={`app-modal ${className}`} aria-modal="true" tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
    onKeyDown={(event) => { event.stopPropagation(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    {children}
  </dialog>, document.body);
}
