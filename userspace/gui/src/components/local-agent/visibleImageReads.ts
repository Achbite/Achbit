// Only mounted, visible image controls may start a resource read. Scroll and unmount remove pending work.
const pendingPreviews = new Map<Element, () => Promise<void>>();
const visiblePreviews = new Set<Element>();
let previewObserver: IntersectionObserver | undefined;
let activeReads = 0;

function readVisiblePreviews() {
  for (const element of visiblePreviews) {
    if (activeReads >= 4) break;
    visiblePreviews.delete(element);
    const load = pendingPreviews.get(element);
    if (!load) continue;
    pendingPreviews.delete(element);
    previewObserver?.unobserve(element);
    activeReads++;
    void load().finally(() => { activeReads--; readVisiblePreviews(); });
  }
  if (!pendingPreviews.size) { previewObserver?.disconnect(); previewObserver = undefined; }
}

export function whenPreviewVisible(element: Element, load: () => Promise<void>) {
  previewObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && pendingPreviews.has(entry.target)) visiblePreviews.add(entry.target);
      else visiblePreviews.delete(entry.target);
    }
    readVisiblePreviews();
  });
  pendingPreviews.set(element, load);
  previewObserver.observe(element);
  return () => {
    visiblePreviews.delete(element);
    if (pendingPreviews.delete(element)) previewObserver?.unobserve(element);
    if (!pendingPreviews.size) { previewObserver?.disconnect(); previewObserver = undefined; }
  };
}
