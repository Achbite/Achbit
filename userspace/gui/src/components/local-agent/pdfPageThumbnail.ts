import { openPdfBytes } from './pdfDocument';

/** Rasterize just page one into a bounded bitmap; no viewer, forms or links in the composer. */
export async function pdfFirstPage(blob: Blob, signal: AbortSignal): Promise<string> {
  const data = await blob.arrayBuffer();
  signal.throwIfAborted();
  const loading = openPdfBytes(data);
  let disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= loading.destroy();
  const cancel = () => { void dispose().catch(console.error); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const doc = await loading.promise;
    signal.throwIfAborted();
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(256 / natural.width, 320 / natural.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    const render = page.render({ canvas, viewport });
    await render.promise;
    signal.throwIfAborted();
    return canvas.toDataURL('image/png');
  } finally {
    signal.removeEventListener('abort', cancel);
    await dispose();
  }
}
