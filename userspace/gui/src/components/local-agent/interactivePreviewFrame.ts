/** Display-only reference: archived bytes and identity remain owned by Kernel/Session. */
export function previewArtifactId(source: string): string | null {
  return /^artifact:\/\/([^\s/?#]+)$/u.exec(source.trim())?.[1] ?? null;
}

/** Runs inside the preview frame. No Host APIs, settings or model messages cross this bridge. */
function installPreviewBridge() {
  const send = (message: Record<string, unknown>) => parent.postMessage({ type: 'achbit:preview', ...message }, '*');
  let scheduled = 0, previousHeight = 0;
  const measure = () => {
    scheduled = 0;
    if (!document.body || !innerWidth || !innerHeight) return;
    const style = getComputedStyle(document.body);
    const height = Math.ceil(document.body.getBoundingClientRect().height
      + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
    if (height !== previousHeight) { previousHeight = height; send({ kind: 'resize', height }); }
  };
  const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(measure); };
  addEventListener('error', event => { if (event.message) send({ kind: 'error', message: event.message }); });
  addEventListener('unhandledrejection', event => send({ kind: 'error', message: String(event.reason) }));
  for (const name of ['pointerdown', 'keydown', 'input']) document.addEventListener(name, () => send({ kind: 'interaction' }), { passive: true });
  const start = () => {
    new ResizeObserver(schedule).observe(document.body);
    addEventListener('resize', schedule);
    send({ kind: 'ready' });
    schedule();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export function interactivePreviewDocument(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html');
  const bridge = document.createElement('script');
  bridge.textContent = `(${installPreviewBridge.toString()})();`;
  document.head.prepend(bridge);
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}
