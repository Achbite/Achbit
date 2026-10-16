import { createContext, useContext } from 'react';

const controls = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]';

export interface FocusReturn {
  target: HTMLElement | null;
  previous: Element | null;
}

export function captureFocusReturn(target?: HTMLElement | null): FocusReturn {
  const previous = document.activeElement;
  return { target: target ?? (previous instanceof HTMLElement ? previous : null), previous };
}

export function finishPointerFocus(element: HTMLElement, pointer: boolean) {
  if (pointer && element.ownerDocument.activeElement === element) element.blur();
}

/** Do not take focus back from a control the user reached while an editor was closing. */
export function returnInteractionFocus(origin: FocusReturn, keyboard: boolean) {
  const active = document.activeElement;
  if (active !== document.body && active !== origin.previous && active !== origin.target && active?.isConnected) return;
  if (keyboard) {
    if (origin.target?.isConnected && !origin.target.matches(':disabled')) origin.target.focus({ preventScroll: true });
  } else if (active instanceof HTMLElement) {
    finishPointerFocus(active, true);
  }
}

/** One interaction policy for settings controls, search targets and portalled editors. */
export function createInteractionFocus() {
  let keyboard = true;
  let pointerTarget: HTMLElement | null = null;
  let revealed: HTMLElement | null = null;
  const clearReveal = () => {
    revealed?.removeAttribute('data-settings-revealed');
    revealed = null;
  };
  return {
    get keyboard() { return keyboard; },
    pointerDown(target: EventTarget | null) {
      keyboard = false;
      pointerTarget = target instanceof Element ? target.closest<HTMLElement>(controls) : null;
      clearReveal();
    },
    keyDown(key: string) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;
      keyboard = true;
      pointerTarget = null;
      clearReveal();
    },
    capture(target?: HTMLElement | null) {
      return captureFocusReturn(target ?? (keyboard ? null : pointerTarget));
    },
    restore(origin: FocusReturn) { returnInteractionFocus(origin, keyboard); },
    reveal(element: HTMLElement) {
      clearReveal();
      revealed = element;
      element.setAttribute('data-settings-revealed', '');
      element.scrollIntoView({ block: 'center' });
      // Search location is visual state. Only keyboard navigation transfers focus.
      if (keyboard) (element.matches(controls) ? element : element.querySelector<HTMLElement>(controls) ?? element).focus({ preventScroll: true });
    },
    clearReveal,
  };
}

export const InteractionFocusContext = createContext<ReturnType<typeof createInteractionFocus> | null>(null);
export const useInteractionFocus = () => useContext(InteractionFocusContext);
