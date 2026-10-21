(() => {
  // Only an image document is an image target. A white HTML region is content,
  // not a heuristic crop boundary. Inspection never resizes or scrolls the page.
  if (!document.contentType?.startsWith('image/')) return { contentKind: 'viewport', rect: null };
  const image = document.querySelector('img') ?? (document.documentElement?.localName === 'svg' ? document.documentElement : null);
  if (!image || ('complete' in image && (!image.complete || !image.naturalWidth || !image.naturalHeight))) throw new Error('native_browser_preview_image_not_ready');
  const bounds = image.getBoundingClientRect();
  const x = Math.max(0, bounds.left), y = Math.max(0, bounds.top);
  const width = Math.min(innerWidth, bounds.right) - x;
  const height = Math.min(innerHeight, bounds.bottom) - y;
  if (width <= 0 || height <= 0) throw new Error('native_browser_preview_image_not_visible');
  return { contentKind: 'image', rect: [x / innerWidth, y / innerHeight, width / innerWidth, height / innerHeight] };
})()
