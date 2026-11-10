import type { toSvg as domToSvg } from 'html-to-image';

export interface ContentImage { blob: Blob; filename: string }

export function contentImage(blob: Blob, title: string): ContentImage {
  if (!blob.size) throw new Error('The exported image is empty.');
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp',
    'image/tiff': 'tiff', 'image/x-icon': 'ico' } as Record<string, string>)[blob.type.split(';')[0]!];
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\.(png|jpe?g|svg|webp|gif|avif|bmp|tiff?|ico)$/i, '')
    .trim().replace(/^\.+|\.+$/g, '').slice(0, 120) || 'image';
  return { blob, filename: name + (extension ? '.' + extension : '') };
}

export async function readContentImage(source: string, title: string, signal?: AbortSignal): Promise<ContentImage> {
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error('Image read failed: HTTP ' + response.status);
  return contentImage(await response.blob(), title);
}

/** Also serialized into the preview frame; keep dependencies explicit. */
export async function rasterizeSvg(svg: string, width: number, height: number, background: string): Promise<Blob> {
  if (!(width > 0 && height > 0)) throw new Error('The rendered image has no dimensions.');
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * 2); canvas.height = Math.ceil(height * 2);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The image canvas is unavailable.');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob?.size ? resolve(blob)
    : reject(new Error('The image could not be encoded at this size.')), 'image/png'));
}

/** Render a complete block without changing its live scroll, zoom or interaction state.
 * The same implementation runs inside an interactive preview with its current DOM/canvas.
 */
export async function renderElementPng(node: HTMLElement, toSvg: typeof domToSvg,
  rasterize: typeof rasterizeSvg): Promise<Blob> {
  await node.ownerDocument.fonts.ready;
  const width = Math.ceil(Math.max(node.offsetWidth, node.scrollWidth));
  const height = Math.ceil(Math.max(node.offsetHeight, node.scrollHeight));
  if (!width || !height) throw new Error('The content is not ready to export.');
  let background = 'rgb(255, 255, 255)';
  for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
    const color = getComputedStyle(ancestor).backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break; }
  }
  let resourceError: Error | undefined;
  const source = await toSvg(node, {
    width, height, includeQueryParams: true, preferredFontFormat: 'woff2',
    style: { width: width + 'px', height: height + 'px', maxWidth: 'none', maxHeight: 'none',
      margin: '0', overflow: 'visible', transform: 'none', zoom: '1' },
    filter: element => !element.matches?.('[data-image-export-exclude], script'),
    // The library otherwise replaces failed resources with empty image data.
    get imagePlaceholder(): string {
      resourceError = new Error('An image or font could not be loaded for export.');
      throw resourceError;
    },
  });
  if (resourceError) throw resourceError;
  const svg = new DOMParser().parseFromString(decodeURIComponent(source.slice(source.indexOf(',') + 1)), 'image/svg+xml');
  for (const element of svg.querySelectorAll<HTMLElement>('[style]')) {
    if (element.style.position === 'sticky') {
      Object.assign(element.style, { position: 'static', inset: 'auto', boxShadow: 'none' });
    }
  }
  // Preserve live checkbox and select values as well as the library's canvas/text snapshots.
  const inputs = node.querySelectorAll('input');
  svg.querySelectorAll('input').forEach((input, index) => input.toggleAttribute('checked', inputs[index]?.checked ?? false));
  const options = node.querySelectorAll('option');
  svg.querySelectorAll('option').forEach((option, index) => option.toggleAttribute('selected', options[index]?.selected ?? false));
  return rasterize(new XMLSerializer().serializeToString(svg), width, height, background);
}

export async function elementImage(node: HTMLElement | null, title: string): Promise<ContentImage> {
  if (!node) throw new Error('The content is no longer available.');
  const { toSvg } = await import('html-to-image');
  return contentImage(await renderElementPng(node, toSvg, rasterizeSvg), title);
}

export async function diagramImage(svg: string, title: string, format: 'png' | 'svg', background: string): Promise<ContentImage> {
  if (format === 'svg') return contentImage(new Blob([svg], { type: 'image/svg+xml' }), title);
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
  const box = root.viewBox.baseVal;
  return contentImage(await rasterizeSvg(svg, box.width || root.width.baseVal.value,
    box.height || root.height.baseVal.value, background), title);
}
