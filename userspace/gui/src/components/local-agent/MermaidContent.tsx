import { useContext, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { t } from '../../i18n';
import { useDisplayTheme } from '../../ui-plugins/UiPlugins';
import { useUiLanguage } from '../../useUiLanguage';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useAutoDismiss } from '../shared/useAutoDismiss';
import { useConversationHost } from './ConversationHost';
import { ImageReview } from './ImageReview';
import { renderMermaidImage } from './mermaidImage';
import { CodeContent } from './RichContent';
import { RichContentScope } from './RichContentIdentity';
import './mermaidContent.css';

type DiagramImage = Awaited<ReturnType<typeof renderMermaidImage>> & { url: string };
type DiagramResult = { source: string; theme: string } & ({ image: DiagramImage } | { error: string });

export function MermaidContent({ source }: { source: string }) {
  const language = useUiLanguage();
  const theme = useDisplayTheme();
  const host = useConversationHost();
  const id = 'diagram-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const target = useContext(RichContentScope);
  const identity = useUiOwner('conversation.diagram', undefined, { ...target });
  const control = (part: string) => target ? identity.action(part, 'click') : {};
  const figure = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<DiagramResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  useAutoDismiss(copied, () => setCopied(false), 1500);
  useEffect(() => {
    let current = true;
    let url: string | undefined;
    setActionError(''); setCopied(false); setMenu(false);
    void renderMermaidImage(id, source, theme).then(rendered => {
      if (!current) return;
      url = URL.createObjectURL(new Blob([rendered.svg], { type: 'image/svg+xml;charset=utf-8' }));
      setResult({ source, theme, image: { ...rendered, url } });
    }).catch(reason => { if (current) setResult({ source, theme, error: String(reason) }); });
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [id, source, theme]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  const current = result?.source === source && result.theme === theme ? result : null;
  const image = current && 'image' in current ? current.image : null;
  const preceding = figure.current?.previousElementSibling;
  const title = image?.title || (preceding?.matches('h1,h2,h3,h4,h5,h6') ? preceding.textContent : '') || t(language, 'content.diagram.title');
  const label = t(language, showSource ? 'content.diagram.view' : 'content.diagram.source');
  const closeMenu = () => { setMenu(false); more.current?.focus({ preventScroll: true }); };
  return <figure ref={figure} className="conversation-diagram" aria-label={title} style={image?.size ? {
    '--diagram-width': image.size.width + 'px', '--diagram-min-width': Math.min(550, image.size.width * .75) + 'px',
  } as CSSProperties : undefined}>
    <div className="conversation-diagram__actions" role="group" aria-label={t(language, 'content.diagram.more')}>
      <button {...control('source')} type="button" className="reader-icon-button" aria-label={label} title={label}
        aria-pressed={showSource} aria-controls={id + '-content'} onClick={() => { setShowSource(!showSource); setMenu(false); }}><AchbitShellIcon name="code" /></button>
      <div className="conversation-diagram__more" ref={popup} onKeyDown={event => {
        if (event.key === 'Tab' && menu) { closeMenu(); return; }
        if (event.key === 'Escape' && menu) { event.stopPropagation(); closeMenu(); }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (!menu) { setMenu(true); return; }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:enabled')];
        const next = items.findIndex(item => item === document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
        items[(next + items.length) % items.length]?.focus();
      }}>
        <button {...control('more')} ref={more} type="button" className="reader-icon-button" aria-haspopup="menu" aria-expanded={menu} aria-controls={id + '-menu'}
          aria-label={t(language, 'content.diagram.more')} title={t(language, copied ? 'content.code.copied' : 'content.diagram.more')}
          onClick={() => setMenu(!menu)}><AchbitShellIcon name={copied ? 'check' : 'more'} /></button>
        {menu && <div id={id + '-menu'} className="conversation-diagram__menu" role="menu" aria-label={t(language, 'content.diagram.more')}>
          <button {...control('copy')} type="button" role="menuitem" autoFocus onClick={() => {
            closeMenu(); setActionError(''); setCopied(false);
            void host.copyText(source).then(() => setCopied(true)).catch(reason => setActionError(String(reason)));
          }}><AchbitShellIcon name="code" />{t(language, 'content.diagram.copy')}</button>
          <button {...control('download')} type="button" role="menuitem" disabled={!image} onClick={() => {
            if (!image) return;
            closeMenu(); setActionError('');
            void host.saveDiagramSvg(image).catch(reason => setActionError(String(reason)));
          }}><AchbitShellIcon name="download" />{t(language, 'content.diagram.download')}<small>SVG</small></button>
        </div>}
      </div>
      <button {...control('expand')} type="button" className="reader-icon-button" disabled={!image} aria-haspopup="dialog"
        aria-label={t(language, 'content.diagram.expand')} title={t(language, 'content.diagram.expand')}
        onClick={() => trigger.current?.click()}><AchbitShellIcon name="expand" /></button>
    </div>
    {actionError && <small className="conversation-copy-error" role="alert">{actionError}</small>}
    {current && 'error' in current && <span role="status">{t(language, 'content.diagram.error', { error: current.error })}</span>}
    <div id={id + '-content'}>
      {showSource && <CodeContent code={source} language="mermaid" />}
      {!showSource && !current && <span role="status">{t(language, 'content.diagram.loading')}</span>}
      {image && <div className="conversation-diagram__viewport">
        <ImageReview source={image.url} alt={title} className="conversation-diagram__open" title={t(language, 'content.diagram.expand')}
          triggerRef={trigger} triggerIdentity={control('view')} hideTrigger={showSource} diagram={image.size} />
      </div>}
    </div>
  </figure>;
}
