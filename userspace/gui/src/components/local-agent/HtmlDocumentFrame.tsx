import { useRef } from 'react';
import { usePreviewSurfaceSize } from './usePreviewSurfaceSize';
import type { BrowserViewport } from '../../services/nativeBrowser';
import { fitBrowserViewport } from './browserViewport';

export function HtmlDocumentFrame({ content, title, viewport }: { content: string; title: string; viewport: BrowserViewport }) {
  const surface = useRef<HTMLDivElement>(null);
  const size = usePreviewSurfaceSize(surface);
  const layout = fitBrowserViewport(viewport, size.width, size.height);
  return <div className="document-preview__html-surface" ref={surface}>
    <iframe className="document-preview__html" title={title} sandbox="" srcDoc={content}
      style={viewport.mode === 'adaptive' ? { width: '100%', height: '100%' } : {
        width: layout.width, height: layout.height, left: layout.left, transform: `scale(${layout.scale})`,
      }} />
  </div>;
}
