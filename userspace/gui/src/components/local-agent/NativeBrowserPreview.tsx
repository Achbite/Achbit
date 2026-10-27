import { BrowserViewportControl } from './BrowserViewportControl';
import { measureBrowserSurface } from './nativeBrowserLayout';
import { NativeBrowserControl } from './NativeBrowserControl';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  nativeBrowserCommand,
  nativeHostBinding,
  listenNativePages,
  nativeNavigationInput,
  type NativeHostBinding,
  type NativePage,
} from '../../services/nativeBrowser';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { type BrowserAnnotation, type BrowserReviewEdit } from './browserReview';

export function NativeBrowserPreview({
  sessionId,
  active,
  onClose,
  onReady,
  previewId,
  onReview,
  reviewEdit,
}: {
  sessionId: string;
  active: boolean;
  onClose(): void;
  onReady(page: NativePage, binding: NativeHostBinding): void;
  previewId: string;
  onReview?: (annotation: BrowserAnnotation, previewId: string, screenshot?: string) => void;
  reviewEdit?: BrowserReviewEdit | null;
}) {
  const callbacks = useRef({ onClose, onReady, onReview });
  callbacks.current = { onClose, onReady, onReview };
  const surface = useRef<HTMLDivElement>(null);
  const owner = useRef<{ binding: NativeHostBinding; page: NativePage; sequence: number; layoutKey?: string; pending?: Promise<NativePage> } | null>(
    null,
  );
  const language = useUiLanguage();
  const [page, setPage] = useState<NativePage | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewOptions, setReviewOptions] = useState<{ annotation?: BrowserAnnotation }>({});
  const handledEdit = useRef<string | null>(null);
  const startReview = () => { setError(null); setReviewOptions({}); setReviewing(true); };
  useEffect(() => {
    if (!reviewEdit || !active || page?.status !== 'ready' || handledEdit.current === reviewEdit.requestId) return;
    handledEdit.current = reviewEdit.requestId;
    setError(null);
    setReviewOptions({ annotation: reviewEdit.annotation });
    setReviewing(true);
  }, [reviewEdit?.requestId, active, page?.status]);
  const shortAddress = () => {
    try {
      const address = new URL(url);
      return address.protocol === 'file:'
        ? (decodeURIComponent(address.pathname).split('/').at(-1) ?? url)
        : page?.kind === 'achbit'
          ? 'Achbit'
          : url;
    } catch {
      return url;
    }
  };
  const command = async (input: Record<string, unknown>) => {
    if (!owner.current) throw new Error('Browser page is not ready.');
    return nativeBrowserCommand<NativePage>(owner.current.binding, {
      previewId: owner.current.page.previewId,
      ...input,
    });
  };
  const updateLayout = useCallback(async () => {
    const current = owner.current;
    if (!surface.current || !current) return null;
    const layout = measureBrowserSurface(surface.current, active);
    const key = JSON.stringify([layout, current.page.surface.activationId]);
    if (current.layoutKey === key && current.pending) return current.pending;
    current.layoutKey = key;
    const input = { action: 'layout', previewId: current.page.previewId, ...layout,
      surfaceGeneration: current.page.surface.generation, sequence: ++current.sequence,
      activationId: current.page.surface.activationId };
    const next = nativeBrowserCommand<NativePage>(current.binding, input);
    current.pending = next;
    try { return await next; }
    catch (error) { if (current.pending === next) current.layoutKey = undefined; throw error; }

  }, [active]);
  useEffect(() => {
    let ended = false;
    const create = async () => {
      const binding = await nativeHostBinding();
      if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
      binding.sessionId = sessionId;
      const page = await nativeBrowserCommand<NativePage>(
        binding,
        { action: 'bindSurface', previewId },
      );
      if (ended) {
        await nativeBrowserCommand(binding, { action: 'layout', previewId, visible: false, reason: 'unmounted', surfaceGeneration: page.surface.generation, sequence: 1 });
        return;
      }
      owner.current = { binding, page, sequence: 0 };
      setPage(page);
      setUrl(page.url);
      callbacks.current.onReady(page, binding);
    };
    void create().catch((reason: unknown) => {
      if (!ended) setError(String(reason));
    });
    return () => {
      ended = true;
      const current = owner.current;
      owner.current = null;
      if (current)
        void nativeBrowserCommand(current.binding, {
          action: 'layout',
          previewId: current.page.previewId,
          visible: false, reason: 'unmounted', surfaceGeneration: current.page.surface.generation, sequence: ++current.sequence,
        }).catch(console.error);
    };
  }, [sessionId, previewId]);
  useEffect(() => {
    let ended = false;
    let unlisten: (() => void) | undefined;
    void listenNativePages((next) => {
      if (ended || next.previewId !== owner.current?.page.previewId) return;
      owner.current.page = { ...next, surface: { ...next.surface, generation: owner.current.page.surface.generation } };
      setPage(next);
      setUrl(next.url);
      if (next.status === 'closed') {
        owner.current = null;
        callbacks.current.onClose();
      } else callbacks.current.onReady(next, owner.current.binding);
    })
      .then((dispose) => {
        if (ended) dispose();
        else unlisten = dispose;
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      ended = true;
      unlisten?.();
    };
  }, [sessionId]);
  useEffect(() => {
    if (!page || !surface.current) return;
    let ended = false;
    let scheduled = 0;
    const layout = () => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (ended || !surface.current || !owner.current) return;
        void updateLayout().catch((reason: unknown) => {
          if (!ended) setError(String(reason));
        });
      });
    };
    const resize = new ResizeObserver(layout);
    resize.observe(surface.current);
    const mutations = new MutationObserver(layout);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'aria-modal', 'class', 'hidden', 'style'],
    });
    const activate = (event: Event) => {
      const next = (event as CustomEvent<NativePage>).detail;
      if (next.previewId !== owner.current?.page.previewId) return;
      owner.current.page.surface.activationId = next.surface.activationId;
      layout();
    };
    window.addEventListener('achbit:browser-layout', activate);
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    layout();
    return () => {
      ended = true;
      cancelAnimationFrame(scheduled);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('achbit:browser-layout', activate);
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
    };
  }, [page?.previewId, page?.status, updateLayout]);
  const act = async (action: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await command(action);
      setPage(next);
      if (next.url) setUrl(next.url);
      if (owner.current) {
        owner.current.page = next;
        callbacks.current.onReady(next, owner.current.binding);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!reviewing || !active || page?.status !== 'ready' || !owner.current) return;
    const current = owner.current;
    let ended = false, timer = 0;
    const delivered = new Set<string>();
    const reviewId = crypto.randomUUID();
    const request = <T,>(input: Record<string, unknown>) => nativeBrowserCommand<T>(current.binding, { previewId: current.page.previewId, reviewId, ...input });
    const read = async () => {
      try {
        const state = await request<{ active: boolean; exitReason: string | null; pending: BrowserAnnotation | null }>({ action: 'reviewRead' });
        if (ended) return;
        if (!state.active) { if (state.exitReason === 'escape') setReviewing(false); return; }
        if (state.pending) {
          const note = state.pending;
          if (!delivered.has(note.id)) {
            const status = await request<{ captureAvailable: boolean }>({ action: 'hostStatus' });
            const screenshot = status.captureAvailable ? await request<{ contentRef: string }>({ action: 'capture' }) : null;
            if (ended) return;
            callbacks.current.onReview?.(note, current.page.previewId, screenshot?.contentRef);
            delivered.add(note.id);
          }
          await request({ action: 'reviewAcknowledge', id: note.id });
        }
        if (!ended) timer = window.setTimeout(read, 400);
      } catch (reason) {
        if (!ended) { setError(String(reason)); }
      }
    };
    const begin = async () => {
      // Reopening a draft can mount a hidden native page. Its layout must be
      // acknowledged before the review command checks visibility and geometry.
      const displayed = await updateLayout();
      if (ended) return;
      if (!displayed?.visible) throw new Error(t(language, 'reader.annotation.covered'));
      await request({ action: 'reviewStart', labels: Object.fromEntries(
        ['annotation', 'comment', 'placeholder', 'cancel', 'save', 'hint', 'pageChanged', 'viewportChanged', 'notVisible'].map(key => [key, t(language, `reader.annotation.${key}`)])), ...reviewOptions });
      if (!ended) void read();
      else void request({ action: 'reviewEnd' }).catch(console.error);
    };
    void begin()
      .catch(reason => { if (!ended) { setError(String(reason)); } });
    return () => {
      ended = true; clearTimeout(timer);
      void request({ action: 'reviewEnd' }).catch(console.error);
    };
  }, [reviewing, active, page?.previewId, page?.status, language, reviewOptions, updateLayout]);
  return (
    <section className="native-browser-preview">
      <form
        className="document-preview__toolbar native-browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          try { void act({ action: 'navigate', ...nativeNavigationInput(url) }); }
          catch (reason) { setError(String(reason)); }
        }}
      >
        <div className="native-browser-location"><input
          aria-label={t(language, 'reader.address')}
          title={url}
          value={editingAddress ? url : shortAddress()}
          onFocus={() => setEditingAddress(true)}
          onBlur={() => setEditingAddress(false)}
          readOnly={page?.kind === 'achbit'}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
        />
        {page?.control && owner.current && <NativeBrowserControl key={page.previewId}
          binding={owner.current.binding} previewId={page.previewId} language={language} onError={setError} />}
        </div>
        <button disabled={!page || busy || page.kind === 'achbit'} type="submit">
          {t(language, 'reader.open')}
        </button>
        <button
          disabled={!page || busy}
          type="button"
          onClick={() => void act({ action: 'reload' })}
          aria-label={t(language, 'reader.refresh')}
          title={t(language, 'reader.refresh')}
        >
          <AchbitShellIcon name="refresh" />
        </button>
        {page && <BrowserViewportControl value={page.viewport} language={language} disabled={busy}
          onChange={viewport => void act({ action: 'setViewport', viewport })} />}
        {page?.status === 'loading' && <small role="status">{t(language, 'reader.loading')}</small>}
        {reviewing ? <div className="native-browser-review-controls" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setReviewing(false); } }}>
          <span title={t(language, 'reader.annotation.hint')}>{t(language, 'reader.annotation.gesture')}</span>
          <kbd>esc</kbd><button type="button" aria-label={t(language, 'reader.annotation.exit')} onClick={() => setReviewing(false)}><AchbitShellIcon name="close" size={14} /></button>
        </div> : <button
          disabled={!page || page.status !== 'ready' || busy || !onReview}
          type="button"
          onClick={startReview}
          title={t(language, 'reader.annotation.hint')}
        >
          <AchbitShellIcon name="compose" />
          <span>{t(language, 'reader.annotation.annotation')}</span>
        </button>}
      </form>
      {error && (
        <p role="alert" className="local-agent__resource-error">
          {error}
        </p>
      )}
      <div
        className="native-browser-preview__surface"
        ref={surface}
        onFocus={() =>
          void command({ action: 'focus' }).catch((reason) => setError(String(reason)))
        }
        tabIndex={0}
      />
      {!page && !error && <small role="status">{t(language, 'reader.creating')}</small>}
    </section>
  );
}
