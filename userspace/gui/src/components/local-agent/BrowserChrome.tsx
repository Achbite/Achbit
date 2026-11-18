import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '../../ui-components';
import { t, type UiLanguage } from '../../i18n';
import { listenNativeBrowserChrome, nativeNavigationInput, type NativePage } from '../../services/nativeBrowser';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { BrowserViewportControl } from './BrowserViewportControl';

export function browserAddressError(error: unknown, language: UiLanguage): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = { browser_address_empty: 'reader.address.empty', browser_address_invalid: 'reader.address.invalid',
    browser_address_scheme: 'reader.address.scheme' }[message];
  return key ? t(language, key) : message;
}
export function browserAddressLabel(page: Pick<NativePage, 'url' | 'kind'> | null): string {
  if (!page) return '';
  if (page.kind === 'achbit') return 'Achbit';
  try { const url = new URL(page.url); return url.protocol === 'file:' ? decodeURIComponent(url.pathname).split('/').at(-1) || page.url : page.url; }
  catch { return page.url; }
}
export function nextBrowserZoom(zoom: number, direction: number): number {
  return Math.max(0.25, Math.min(3, Math.round((zoom + direction * 0.1) * 100) / 100));
}

/** Select the DOM destination before restoring its native WebView focus. This
 * prevents the previously focused page surface from sending focus back. */
export function focusBrowserChromeInput(input: HTMLInputElement | null, focusChrome: () => Promise<unknown>, onError: (message: string) => void): void {
  if (!input) return;
  input.focus(); input.select();
  void focusChrome().catch(error => onError(String(error)));
}

/** Browser UI owns address/find drafts; native pages own navigation and zoom. */
export function BrowserChrome({ page, active, busy, language, control, reviewing, onAction, onFind, onEndFind,
  onClose, onFocusPage, onFocusChrome, onReview, onExitReview, onError }: {
  page: NativePage | null; active: boolean; busy: boolean; language: UiLanguage; control?: ReactNode; reviewing: boolean;
  onAction(input: Record<string, unknown>): Promise<NativePage | null>;
  onFind(text: string, backwards: boolean): Promise<{ found: boolean }>;
  onEndFind(): Promise<unknown>; onClose(): Promise<void>; onFocusPage(): void; onFocusChrome(): Promise<unknown>;
  onReview?: () => void; onExitReview(): void; onError(message: string): void;
}) {
  const identity = useUiOwner('reader.browser', undefined, { sessionId: page?.sessionId, previewId: page?.previewId });
  const address = useRef<HTMLInputElement>(null), find = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [addressFocused, setAddressFocused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false), [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState(''), [found, setFound] = useState<boolean | null>(null);
  const findSequence = useRef(0);
  const label = (key: string) => t(language, `reader.${key}`);
  const adaptive = page?.viewport.mode === 'adaptive';
  const focusAddress = () => focusBrowserChromeInput(address.current, onFocusChrome, onError);
  const openFind = () => { setFindOpen(true); setToolsOpen(false); if (findOpen) focusBrowserChromeInput(find.current, onFocusChrome, onError); };
  const zoom = (value: number) => { if (page && adaptive && !busy) void onAction({ action: 'setZoom', zoom: value }); };
  const callbacks = useRef({ page, active, focusAddress, openFind, onClose, onAction, onError, zoom });
  callbacks.current = { page, active, focusAddress, openFind, onClose, onAction, onError, zoom };
  useLayoutEffect(() => { if (addressFocused) address.current?.select(); }, [addressFocused]);
  useLayoutEffect(() => { if (findOpen) focusBrowserChromeInput(find.current, onFocusChrome, onError); }, [findOpen]);
  useEffect(() => {
    setDraft(null); setFound(null); setFindOpen(false); setToolsOpen(false); findSequence.current++;
  }, [page?.previewId]);
  useEffect(() => {
    let ended = false, dispose: (() => void) | undefined;
    void listenNativeBrowserChrome(event => {
      if (ended) return;
      const current = callbacks.current;
      if (event.previewId !== current.page?.previewId) return;
      if (event.error) { current.onError(event.error); return; }
      if (!current.active) return;
      if (event.action === 'address') current.focusAddress();
      else if (event.action === 'find') current.openFind();
      else if (event.action === 'reload') void current.onAction({ action: 'reload' });
      else if (event.action === 'close') void current.onClose().catch(error => current.onError(String(error)));
      else if (event.action === 'resetZoom') current.zoom(1);
      else if (event.action === 'zoomIn' || event.action === 'zoomOut') current.zoom(nextBrowserZoom(current.page.zoom, event.action === 'zoomIn' ? 1 : -1));
    }).then(value => { if (ended) value(); else dispose = value; }).catch(error => { if (!ended) callbacks.current.onError(String(error)); });
    return () => { ended = true; dispose?.(); findSequence.current++; };
  }, []);
  useEffect(() => { setFound(null); findSequence.current++; }, [page?.url, page?.status]);
  const submitAddress = async () => {
    if (!page || busy || composing.current) return;
    try {
      const result = await onAction({ action: 'navigate', ...nativeNavigationInput(draft ?? page.url) });
      if (result) { setDraft(null); onFocusPage(); }
    } catch (error) { onError(browserAddressError(error, language)); }
  };
  const findText = async (backwards = false) => {
    const sequence = ++findSequence.current;
    if (!query) { setFound(null); return; }
    try { const result = await onFind(query, backwards); if (findSequence.current === sequence) setFound(result.found); }
    catch (error) { if (findSequence.current === sequence) onError(String(error)); }
  };
  const closeFind = () => {
    setFindOpen(false); setFound(null); findSequence.current++;
    void onEndFind().catch(error => onError(String(error)));
    onFocusPage();
  };
  return <div className="native-browser-chrome" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && !['+', '='].includes(key)) return;
    if (!['l', 'f', 'r', '+', '=', '-', '0'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'l') focusAddress();
    else if (key === 'f') openFind();
    else if (key === 'r') void onAction({ action: 'reload' });
    else if (key === '0') zoom(1);
    else if (page) zoom(nextBrowserZoom(page.zoom, key === '-' ? -1 : 1));
  }}>
    <form className="native-browser-toolbar native-browser-address" aria-label={label('toolbar')}
      onSubmit={event => { event.preventDefault(); void submitAddress(); }}>
      <IconButton {...identity.action('back', 'click')} icon="chevronLeft" size="compact" aria-label={label('back')} title={label('back')}
        disabled={!page?.navigation.canGoBack || busy} onClick={() => void onAction({ action: 'back' })} />
      <IconButton {...identity.action('forward', 'click')} icon="chevronRight" size="compact" aria-label={label('forward')} title={label('forward')}
        disabled={!page?.navigation.canGoForward || busy} onClick={() => void onAction({ action: 'forward' })} />
      <IconButton {...identity.action(page?.status === 'loading' ? 'stop' : 'reload', 'click')} icon={page?.status === 'loading' ? 'close' : 'refresh'} size="compact"
        aria-label={label(page?.status === 'loading' ? 'stop' : 'refresh')} title={label(page?.status === 'loading' ? 'stop' : 'refresh')}
        disabled={!page || busy} onClick={() => void onAction({ action: page?.status === 'loading' ? 'stop' : 'reload' })} />
      <div className="native-browser-location">
        <input {...identity.action('address', 'type')} ref={address} type="text" aria-label={label('address')} title={page?.url}
          value={draft ?? browserAddressLabel(page)} readOnly={page?.kind === 'achbit'} placeholder="https://…" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onFocus={() => { setDraft(current => current ?? page?.url ?? ''); setAddressFocused(true); }}
          onBlur={() => { setAddressFocused(false); setDraft(current => current === page?.url ? null : current); }}
          onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setDraft(null); onFocusPage(); } }} />
        {control}
      </div>
      <IconButton {...identity.action('tools', 'click')} icon="more" size="compact" aria-label={label('tools')} title={label('tools')}
        aria-expanded={toolsOpen} disabled={!page} onClick={() => setToolsOpen(value => !value)} />
    </form>
    {page?.status === 'loading' && <span className="native-browser-load-status" role="status">{label('loading')}</span>}
    {page?.status === 'stopped' && <span className="native-browser-load-status" role="status">{label('stopped')}</span>}
    {toolsOpen && page && <div className="native-browser-tools" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setToolsOpen(false); } }}>
      <Button {...identity.action('find', 'click')} size="compact" onClick={openFind}>{label('find')}</Button>
      <div className="native-browser-zoom" role="group" aria-label={label('zoom')} title={adaptive ? label('zoom') : label('zoom.adaptive')}>
        <IconButton {...identity.action('zoom-out', 'click')} icon="minus" size="compact" aria-label={label('zoom.out')} disabled={!adaptive || busy || page.zoom <= 0.25} onClick={() => zoom(nextBrowserZoom(page.zoom, -1))} />
        <Button {...identity.action('zoom-reset', 'click')} size="compact" aria-label={label('zoom.reset')} disabled={!adaptive || busy} onClick={() => zoom(1)}>{adaptive ? `${Math.round(page.zoom * 100)}%` : label('viewport.fixed')}</Button>
        <IconButton {...identity.action('zoom-in', 'click')} icon="plus" size="compact" aria-label={label('zoom.in')} disabled={!adaptive || busy || page.zoom >= 3} onClick={() => zoom(nextBrowserZoom(page.zoom, 1))} />
      </div>
      <BrowserViewportControl value={page.viewport} language={language} disabled={busy} onChange={viewport => { void onAction({ action: 'setViewport', viewport }); }} />
      {onReview && <Button {...identity.action('review', 'click')} size="compact" disabled={page.status !== 'ready' || busy} onClick={() => { setToolsOpen(false); onReview(); }}>{t(language, 'reader.annotation.annotation')}</Button>}
    </div>}
    {findOpen && <form className="native-browser-find" role="search" onSubmit={event => { event.preventDefault(); void findText(); }}
      onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
        else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); void findText(true); } }}>
      <input {...identity.action('find-text', 'type')} ref={find} value={query} aria-label={label('find')} placeholder={label('find')}
        onChange={event => { setQuery(event.target.value); setFound(null); findSequence.current++; }} />
      <span role="status">{found === null ? '' : label(found ? 'find.found' : 'find.notFound')}</span>
      <IconButton {...identity.action('find-previous', 'click')} icon="chevronLeft" size="compact" aria-label={label('find.previous')} disabled={!query} onClick={() => void findText(true)} />
      <IconButton {...identity.action('find-next', 'click')} icon="chevronRight" size="compact" aria-label={label('find.next')} disabled={!query} onClick={() => void findText()} />
      <IconButton {...identity.action('find-close', 'click')} icon="close" size="compact" aria-label={label('find.close')} onClick={closeFind} />
    </form>}
    {reviewing && <div className="native-browser-review-controls" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onExitReview(); } }}>
      <span title={t(language, 'reader.annotation.hint')}>{t(language, 'reader.annotation.gesture')}</span><kbd>esc</kbd>
      <IconButton icon="close" size="compact" aria-label={t(language, 'reader.annotation.exit')} onClick={onExitReview} />
    </div>}
  </div>;
}
