import { contentImage, type ContentImage } from './contentImage';

/** A single request completes through the existing frame's message channel. */
export function previewImage(frame: Window | null, title: string, signal: AbortSignal): Promise<ContentImage> {
  if (!frame) return Promise.reject(new Error('The preview is no longer available.'));
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('message', receive);
      signal.removeEventListener('abort', abort);
      clearTimeout(timeout);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame || data?.type !== 'achbit:preview' || data.kind !== 'export' || data.requestId !== requestId) return;
      cleanup();
      if (typeof data.error === 'string') reject(new Error(data.error));
      else {
        try {
          if (!(data.blob instanceof Blob) || data.blob.type !== 'image/png') throw new Error('The preview returned no PNG image.');
          resolve(contentImage(data.blob, title));
        } catch (error) { reject(error); }
      }
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Preview image export timed out.')); }, 30_000);
    window.addEventListener('message', receive);
    signal.addEventListener('abort', abort, { once: true });
    try { frame.postMessage({ type: 'achbit:preview-export', requestId }, '*'); }
    catch (error) { cleanup(); reject(error); }
  });
}
