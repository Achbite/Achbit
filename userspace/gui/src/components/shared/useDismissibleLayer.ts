import { useEffect, useRef, type RefObject } from 'react';
import { finishPointerFocus, returnFocusTo, useInteractionFocus } from './interactionFocus';

export type LayerDismissReason = 'pointer-outside' | 'focus-outside' | 'escape';
interface LayerBoundary {
  /** Include both the anchor and any portalled content. */
  regions: readonly (HTMLElement | null)[];
  /** Non-focusable hover help handles Escape before its parent panel. */
  escapeCapture?: boolean;
  dismiss(reason: LayerDismissReason): void;
}

/** Non-modal dismissal only. Native dialogs and persistent disclosures retain their owners. */
export function installDismissibleLayer(owner: Document, current: () => LayerBoundary) {
  let tabNavigation = false;
  const inside = (regions: LayerBoundary['regions'], target: EventTarget | null) =>
    target instanceof Node && regions.some(region => region?.contains(target));
  const blockedByDialog = (regions: LayerBoundary['regions']) =>
    [...owner.querySelectorAll('dialog[open]')].some(dialog => !regions.some(region => region && dialog.contains(region)));
  const pointer = (event: PointerEvent) => {
    tabNavigation = false;
    const { regions, dismiss } = current();
    if (blockedByDialog(regions) || event.composedPath().some(target => inside(regions, target))) return;
    const active = owner.activeElement;
    dismiss('pointer-outside');
    // A cancelled blank-space text selection may leave a hidden layer's action focused.
    if (active instanceof HTMLElement && inside(regions, active)) finishPointerFocus(active, true);
  };
  const focus = (event: FocusEvent) => {
    tabNavigation = false;
    const { regions, dismiss } = current();
    if (!blockedByDialog(regions) && !inside(regions, event.target)) dismiss('focus-outside');
  };
  const focusOut = (event: FocusEvent) => {
    // Tab can leave the last portalled item for browser chrome without any focusin.
    // A null target from a render/disabled control is not, by itself, user dismissal.
    if (!tabNavigation || event.relatedTarget !== null) return;
    tabNavigation = false;
    const { regions, dismiss } = current();
    if (!blockedByDialog(regions) && inside(regions, event.target)) dismiss('focus-outside');
  };
  const key = (event: KeyboardEvent) => {
    tabNavigation = event.key === 'Tab' && !event.defaultPrevented && !event.isComposing;
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing) return;
    const { regions, dismiss } = current();
    if (blockedByDialog(regions)) return;
    // Local page navigation, nested menus and tooltips handle Escape before this bubble listener.
    event.preventDefault(); event.stopPropagation();
    dismiss('escape');
  };
  const escapeCapture = current().escapeCapture ?? false;
  owner.addEventListener('pointerdown', pointer, true);
  owner.addEventListener('focusin', focus);
  owner.addEventListener('focusout', focusOut);
  owner.addEventListener('keydown', key, escapeCapture);
  return () => {
    owner.removeEventListener('pointerdown', pointer, true);
    owner.removeEventListener('focusin', focus);
    owner.removeEventListener('focusout', focusOut);
    owner.removeEventListener('keydown', key, escapeCapture);
  };
}

/** Shares dismissal without owning open state, geometry, business actions or a layer registry. */
export function useDismissibleLayer(options: {
  open: boolean;
  roots: readonly RefObject<HTMLElement | null>[];
  trigger?: RefObject<HTMLElement | null>;
  escapeCapture?: boolean;
  onDismiss(reason: LayerDismissReason): void;
}) {
  const interaction = useInteractionFocus();
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.open) return;
    const owner = latest.current.roots.find(root => root.current)?.current?.ownerDocument;
    if (!owner) return;
    return installDismissibleLayer(owner, () => ({
      regions: latest.current.roots.map(root => root.current),
      escapeCapture: latest.current.escapeCapture,
      dismiss(reason) {
        const { roots, trigger, onDismiss } = latest.current;
        const closing = roots.find(root => owner.activeElement && root.current?.contains(owner.activeElement))?.current;
        onDismiss(reason);
        if (reason === 'escape' && trigger) returnFocusTo(trigger.current, interaction, closing);
      },
    }));
  }, [options.open, options.escapeCapture, interaction]);
}
