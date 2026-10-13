/** The transcript owns anchor membership; row content can mount without changing it. */
export class ConversationAnchors {
  private body: HTMLElement | null = null;
  private snapshot: { nodes: HTMLElement[]; byKey: Map<string, HTMLElement> } | null = null;

  // The viewport invalidates this after a React commit, before any scheduled reads.
  invalidate(): void { this.snapshot = null; }

  read(body: HTMLElement) {
    if (body !== this.body || !this.snapshot) {
      this.body = body;
      const nodes = [...body.querySelectorAll<HTMLElement>('[data-conversation-anchor]')];
      this.snapshot = {
        nodes: nodes.filter(node => !node.hidden),
        byKey: new Map(nodes.map(node => [node.dataset.conversationAnchor!, node])),
      };
    }
    return this.snapshot;
  }
}

/** Rows are in normal document flow, including the measured offscreen placeholders. */
export function firstReadingAnchor(nodes: HTMLElement[], top: number): HTMLElement | undefined {
  let left = 0, right = nodes.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (nodes[middle].getBoundingClientRect().bottom <= top) left = middle + 1;
    else right = middle;
  }
  return nodes[left];
}
