import { useEffect, useRef, useState } from 'react';
import { AnnotationEditorType, AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { UiLanguage } from '../../i18n';
import { readViewState, saveViewState } from './readerState';
import { bindViewerZoom } from './viewerZoom';

GlobalWorkerOptions.workerSrc = workerUrl;
type ReadingPosition = { page: number; scale: string; left: number; top: number };
const initialPosition: ReadingPosition = { page: 1, scale: 'page-width', left: 0, top: 0 };
const fixedScales = ['0.5', '0.75', '1', '1.25', '1.5', '2'];

/** PDF.js owns page layout and its bounded render queue; this shell owns only reader controls. */
export default function PdfDocumentPreview({ blob, language, readingKey }: { blob: Blob; language: UiLanguage; readingKey?: string }) {
  const chinese = language === 'zh-CN';
  const viewport = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const changeScale = useRef<((value: string) => void) | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [scale, setScale] = useState('page-width');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPageDraft(String(page)), [page]);

  useEffect(() => {
    if (!viewport.current || !pages.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const container = viewport.current;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    // The installed PDF.js 6.3.289 supports abortSignal for its observer and scroll listener;
    // its generated declaration omits this constructor option.
    const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container, viewer: pages.current, eventBus, linkService, abortSignal: signal,
      annotationMode: AnnotationMode.ENABLE, annotationEditorMode: AnnotationEditorType.DISABLE, enableAutoLinking: false,
    };
    const reader = new PDFViewer(options);
    linkService.setViewer(reader);
    viewer.current = reader;
    let loading: ReturnType<typeof getDocument> | undefined;
    let initialized = false;
    let resizeFrame = 0;
    let position = readingKey ? readViewState<ReadingPosition>(readingKey + ':pdf', initialPosition) : initialPosition;
    let location: ReadingPosition | null = null;
    // PDF.js rounds numeric scales to hundredths. Carry the fraction across slow pinch updates.
    let remainder = 1;
    const stopZoom = bindViewerZoom(container, 'modified', (factor, origin) => {
      if (!initialized) return;
      const requested = reader.currentScale * factor * remainder;
      reader.updateScale({ scaleFactor: factor * remainder, origin: [origin.x, origin.y], drawingDelay: 150 });
      remainder = Math.round(requested * 100) / 100 === reader.currentScale ? requested / reader.currentScale : 1;
    });
    setCount(0); setError(null); setScale(position.scale);

    const restoreLocation = (saved: ReadingPosition) => {
      reader.scrollPageIntoView({ pageNumber: Math.max(1, Math.min(saved.page, reader.pagesCount)),
        destArray: [null, { name: 'XYZ' }, saved.left, saved.top, null], ignoreDestinationZoom: true });
    };
    changeScale.current = (value) => {
      remainder = 1;
      const currentPage = reader.currentPageNumber;
      const anchor = location;
      reader.currentScaleValue = value;
      // Fit-page means the page being read, even when the previous page's tail is visible.
      if (value === 'page-fit' || !anchor || anchor.page !== currentPage) reader.currentPageNumber = currentPage;
      else restoreLocation(anchor);
      reader.update();
    };
    const resize = () => {
      if (signal.aborted || !reader.pdfDocument || !reader.pagesCount || !container.clientWidth || !container.clientHeight) return;
      if (!initialized) {
        reader.currentScaleValue = position.scale;
        reader.currentPageNumber = Math.max(1, Math.min(position.page, reader.pagesCount));
        if (position.top || position.left) restoreLocation(position);
        initialized = true;
      } else if (reader.currentScaleValue === 'page-width' || reader.currentScaleValue === 'page-fit') {
        const anchor = location;
        reader.currentScaleValue = reader.currentScaleValue;
        if (anchor) restoreLocation(anchor);
      }
      reader.update();
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(container);
    eventBus.on('pagesinit', () => {
      if (signal.aborted) return;
      setCount(reader.pagesCount);
      resize();
    }, { signal });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (!signal.aborted) setPage(pageNumber);
    }, { signal });
    eventBus.on('scalechanging', ({ scale: value, presetValue }: { scale: number; presetValue?: string }) => {
      if (!signal.aborted) setScale(presetValue || String(value));
    }, { signal });
    eventBus.on('updateviewarea', ({ location: value }: { location: { pageNumber: number; left: number; top: number } }) => {
      if (signal.aborted || !initialized) return;
      position = { page: value.pageNumber, scale: reader.currentScaleValue, left: value.left, top: value.top };
      location = position;
      if (readingKey) saveViewState(readingKey + ':pdf', position);
    }, { signal });
    eventBus.on('pagerendered', ({ error: reason }: { error?: unknown }) => {
      if (!signal.aborted && reason) setError(reason instanceof Error ? reason.message : String(reason));
    }, { signal });
    void blob.arrayBuffer().then(async (data) => {
      if (signal.aborted) return;
      const assets = new URL('pdfjs/', window.document.baseURI).href;
      loading = getDocument({ data: new Uint8Array(data), cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` });
      const document = await loading.promise;
      if (signal.aborted) return;
      reader.setDocument(document);
      linkService.setDocument(document);
    }).catch((reason: unknown) => {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      stopZoom();
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      controller.abort();
      viewer.current = null;
      changeScale.current = null;
      // PDF.js uses null to cancel render tasks and detach a document; its declaration is narrower.
      (reader.setDocument as (document: PDFDocumentProxy | null) => void).call(reader, null);
      void loading?.destroy().catch(console.error);
    };
  }, [blob, readingKey]);

  const commitPage = () => {
    const next = Number(pageDraft);
    if (viewer.current && Number.isInteger(next) && next >= 1 && next <= count) viewer.current.currentPageNumber = next;
    else setPageDraft(String(page));
  };
  return <div className="document-pdf">
    <div className="document-preview__toolbar document-pdf__controls" aria-label={chinese ? 'PDF 阅读控制' : 'PDF reader controls'}>
      <button type="button" disabled={!count || page <= 1} onClick={() => { if (viewer.current) viewer.current.currentPageNumber = page - 1; }}>{chinese ? '上一页' : 'Previous'}</button>
      <label>{chinese ? '页码' : 'Page'} <input type="number" min={1} max={count || 1} value={pageDraft} disabled={!count}
        onChange={(event) => setPageDraft(event.target.value)} onBlur={commitPage} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } if (event.key === 'Escape') setPageDraft(String(page)); }} /></label>
      <span>/ {count || '—'}</span>
      <button type="button" disabled={!count || page >= count} onClick={() => { if (viewer.current) viewer.current.currentPageNumber = page + 1; }}>{chinese ? '下一页' : 'Next'}</button>
      <label>{chinese ? '缩放' : 'Zoom'} <select value={scale} disabled={!count} onChange={(event) => changeScale.current?.(event.target.value)}>
        <option value="page-width">{chinese ? '适合宽度' : 'Fit width'}</option>
        <option value="page-fit">{chinese ? '适合整页' : 'Fit page'}</option>
        {fixedScales.map((value) => <option key={value} value={value}>{Math.round(Number(value) * 100)}%</option>)}
        {!['page-width', 'page-fit', ...fixedScales].includes(scale) && <option value={scale}>{Math.round(Number(scale) * 100)}%</option>}
      </select></label>
      {!count && !error && <span role="status">{chinese ? '正在读取…' : 'Loading…'}</span>}
    </div>
    {error && <p role="alert" className="local-agent__resource-error">{error}</p>}
    <div className="document-pdf__surface">
      <div ref={viewport} className="document-pdf__viewport" tabIndex={0} aria-label={chinese ? 'PDF 连续阅读区域' : 'PDF continuous reader'}>
        <div ref={pages} className="pdfViewer" />
      </div>
    </div>
  </div>;
}
