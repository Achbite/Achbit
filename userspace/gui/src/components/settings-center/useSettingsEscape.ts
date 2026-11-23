import { useEffect, useRef } from 'react';

/** The active settings page handles Escape at document; only an unhandled key reaches the workbench at window. */
export function useSettingsEscape(active: boolean, back: () => void, layer: 'page' | 'workbench' = 'page') {
  const action = useRef(back);
  action.current = back;
  useEffect(() => {
    if (!active) return;
    const handle = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
        || document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('[data-escape-layer="open"]'))) return;
      event.preventDefault();
      event.stopPropagation();
      action.current();
    };
    const target = layer === 'page' ? document : window;
    target.addEventListener('keydown', handle);
    return () => target.removeEventListener('keydown', handle);
  }, [active, layer]);
}
