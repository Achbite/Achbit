import imageRenderer from 'html-to-image/dist/html-to-image.js?raw';
import { renderElementPng, rasterizeSvg } from './contentImage';

/** Display-only reference: archived bytes and identity remain owned by Kernel/Session. */
export function previewArtifactId(source: string): string | null {
  return /^artifact:\/\/([^\s/?#]+)$/u.exec(source.trim())?.[1] ?? null;
}

/** Runs inside the preview frame. No Host APIs, settings or model messages cross this bridge. */
function installPreviewBridge(exportElement: typeof renderElementPng, toSvg: typeof import('html-to-image').toSvg, rasterize: typeof rasterizeSvg, inline: boolean) {
  const send = (message: Record<string, unknown>) => parent.postMessage({ type: 'achbit:preview', ...message }, '*');
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'achbit:preview-export' || typeof event.data.requestId !== 'string') return;
    const requestId = event.data.requestId;
    void exportElement(document.body, toSvg, rasterize).then(blob => send({ kind: 'export', requestId, blob }))
      .catch(error => send({ kind: 'export', requestId, error: error instanceof Error ? error.message : String(error) }));
  });
  let scheduled = 0, previous = '';
  let lastViewport = 0, lastNatural = 0, preferredWidth = 0;
  // scrollWidth includes the live viewport floor. Ask CSS for the actual
  // preferred and minimum contributions; restore before paint, without cloning
  // the page, remounting its controls, or changing the archived document.
  const intrinsicWidths = (root: HTMLElement) => {
    const style = root.style, width = style.getPropertyValue('width'), priority = style.getPropertyPriority('width');
    const authoredBox = root.getBoundingClientRect().width, viewportWidth = root.clientWidth;
    try {
      style.setProperty('width', 'max-content', 'important');
      const natural = Math.ceil(Math.abs(authoredBox - viewportWidth) > 1 ? authoredBox : root.getBoundingClientRect().width);
      style.setProperty('width', 'min-content', 'important');
      const minimum = Math.ceil(Math.max(root.getBoundingClientRect().width, authoredBox > innerWidth + 1 ? authoredBox : 0));
      return { natural, minimum };
    } finally {
      if (width) style.setProperty('width', width, priority); else style.removeProperty('width');
    }
  };
  const measure = () => {
    scheduled = 0;
    if (!document.body || !innerWidth || !innerHeight) return;
    const body = document.body, root = document.documentElement, style = getComputedStyle(body);
    const bodyHeight = body.getBoundingClientRect().height;
    const box = Math.ceil(bodyHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
    const clipped = [style.overflowY, getComputedStyle(root).overflowY].some(value => value === 'hidden' || value === 'clip');
    // App shells scroll inside a viewport-sized (or fixed-position) root. Feeding
    // that height back as intrinsic content permanently pins the initial frame.
    const viewport = clipped && (Math.abs(bodyHeight - innerHeight) <= 1 || bodyHeight === 0);
    const extent = Math.max(body.scrollHeight, root.scrollHeight);
    const height = Math.max(box, extent > innerHeight + 1 ? extent : 0);
    let minimumWidth = 0;
    if (inline && !viewport) {
      const { natural, minimum } = intrinsicWidths(root);
      // A viewport-dependent length is not an intrinsic cap. Avoid feeding
      // shrinking vw units or breakpoint changes back into the same layout.
      if (innerWidth !== lastViewport || natural !== lastNatural) {
        const viewportDriven = lastViewport > 0 && innerWidth !== lastViewport && natural !== lastNatural;
        preferredWidth = viewportDriven || !preferredWidth && Math.abs(natural - innerWidth) <= 1 ? 0 : natural;
        lastViewport = innerWidth; lastNatural = natural;
      }
      minimumWidth = Math.min(minimum, preferredWidth);
    } else { preferredWidth = 0; lastViewport = 0; }
    const next = [viewport ? 'viewport' : height, preferredWidth, minimumWidth].join(':');
    if (next !== previous && (viewport || height > 0)) {
      previous = next; send({ kind: 'resize', viewport, height, viewportHeight: innerHeight, preferredWidth, minimumWidth });
    }
  };
  const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(measure); };
  addEventListener('error', event => { if (event.message) send({ kind: 'error', message: event.message }); });
  addEventListener('unhandledrejection', event => send({ kind: 'error', message: String(event.reason) }));
  for (const name of ['pointerdown', 'keydown', 'input']) document.addEventListener(name, () => send({ kind: 'interaction' }), { passive: true });
  const start = () => {
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body); observer.observe(document.documentElement);
    document.addEventListener('load', schedule, true);
    addEventListener('resize', schedule);
    send({ kind: 'ready' });
    schedule();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export function interactivePreviewDocument(content: string, inline = false): string {
  const document = new DOMParser().parseFromString(content, 'text/html');
  const bridge = document.createElement('script');
  bridge.textContent = imageRenderer + ';\n(' + installPreviewBridge.toString() + ')(' + renderElementPng.toString() + ',htmlToImage.toSvg,' + rasterizeSvg.toString() + ',' + inline + ');';
  document.head.prepend(bridge);
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}
