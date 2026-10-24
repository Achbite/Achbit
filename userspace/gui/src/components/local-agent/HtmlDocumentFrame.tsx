import { useEffect, useRef, useState } from 'react';
import type { BrowserViewport } from '../../services/nativeBrowser';
import { fitBrowserViewport } from './browserViewport';

export function HtmlDocumentFrame({ content, title, viewport }: { content: string; title: string; viewport: BrowserViewport }) {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const measure = () => setSize(previous => {
      const width = element.clientWidth, height = element.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    measure();
    return () => resize.disconnect();
  }, []);
  const layout = fitBrowserViewport(viewport, size.width, size.height);
  return <div className="document-preview__html-surface" ref={surface}>
    <iframe className="document-preview__html" title={title} sandbox="" srcDoc={content}
      style={viewport.mode === 'adaptive' ? { width: '100%', height: '100%' } : {
        width: layout.width, height: layout.height, left: layout.left, transform: `scale(${layout.scale})`,
      }} />
  </div>;
}
