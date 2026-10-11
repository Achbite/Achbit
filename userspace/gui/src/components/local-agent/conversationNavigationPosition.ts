interface NavigationViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  latestKey?: string;
}

/** At the actual end, the latest message owns the position even if its title cannot reach the top. */
export function activeConversationAnchor(
  anchors: Array<{ key: string; top: number }>,
  readingTop: number,
  viewport?: NavigationViewport,
): string | undefined {
  if (viewport && viewport.clientHeight > 0
    && viewport.scrollHeight - viewport.clientHeight - Math.max(0, viewport.scrollTop) <= 2) {
    return viewport.latestKey ?? anchors.at(-1)?.key;
  }
  let selected = anchors[0]?.key;
  for (const anchor of anchors) {
    if (anchor.top > readingTop) break;
    selected = anchor.key;
  }
  return selected;
}
