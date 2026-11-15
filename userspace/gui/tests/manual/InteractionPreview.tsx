import React, { useEffect, useMemo, type ReactNode } from 'react';
import { createInteractionFocus, installInteractionFocus, InteractionFocusContext } from '../../src/components/shared/interactionFocus';
import { installTextSelectionBoundary } from '../../src/components/shared/textSelection';

/** Manual fixtures use the same document-level input policy as the desktop GUI. */
export function InteractionPreview({ children }: { children: ReactNode }) {
  const interaction = useMemo(createInteractionFocus, []);
  useEffect(() => {
    const stopFocus = installInteractionFocus(document, interaction);
    const stopSelection = installTextSelectionBoundary(document);
    return () => { stopFocus(); stopSelection(); };
  }, [interaction]);
  return <InteractionFocusContext.Provider value={interaction}>{children}</InteractionFocusContext.Provider>;
}
