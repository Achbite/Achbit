import React, { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { normalizeUiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { RichContentScope } from './RichContentIdentity';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { bindViewerZoom, captureZoomAnchor, restoreZoomAnchor } from './viewerZoom';

type ContentElement = React.ReactElement<{ children?: React.ReactNode; 'data-column'?: string }>;
const isElement = (node: React.ReactNode): node is ContentElement => React.isValidElement(node);

function textContent(node: React.ReactNode): string {
  return React.Children.toArray(node).map((child) => isElement(child) ? textContent(child.props.children)
    : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
}

/** Only add line-break opportunities at existing separators; copied code stays verbatim. */
function readableCode(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!isElement(child)) return child;
    if (child.type === 'code' && typeof child.props.children === 'string') {
      const parts = child.props.children.split('/');
      if (parts.length < 2) return child;
      return React.cloneElement(child, {}, parts.map((part, index) => <React.Fragment key={index}>
        {part}{index < parts.length - 1 && <>/<wbr /></>}
      </React.Fragment>));
    }
    return React.cloneElement(child, {}, readableCode(child.props.children));
  });
}

export const MarkdownTable = memo(function MarkdownTable({ children }: { children?: React.ReactNode }) {
  const target = useContext(RichContentScope);
  const identity = useUiOwner('conversation.table', undefined, { ...target });
  const language = useSettingsStore((state) => normalizeUiLanguage(state.effectiveSettings['workbench.language']));
  const chinese = language === 'zh-CN';
  const titleId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogBody = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ element: Element; point: ReturnType<typeof captureZoomAnchor> } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const table = useMemo(() => {
    const sections = React.Children.toArray(children).filter(isElement);
    const rows = sections.flatMap((section) => React.Children.toArray(section.props.children).filter(isElement));
    const widths: number[] = [];
    for (const row of rows) {
      React.Children.toArray(row.props.children).filter(isElement).forEach((cell, column) => {
        widths[column] = Math.max(widths[column] ?? 0, textContent(cell.props.children).length);
      });
    }
    const content = sections.map((section) => React.cloneElement(section, {},
      React.Children.map(section.props.children, (row) => {
        if (!isElement(row)) return row;
        let column = 0;
        return React.cloneElement(row, {}, React.Children.map(row.props.children, (cell) => {
          if (!isElement(cell)) return cell;
          const length = widths[column++];
          return React.cloneElement(cell, { 'data-column': length <= 20 ? 'compact' : length <= 60 ? 'label' : 'prose' }, readableCode(cell.props.children));
        }));
      })));
    return { content, columns: widths.length, rows: Math.max(0, rows.length - 1) };
  }, [children]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(element.querySelector('table')!);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    if (expanded && !element.open) element.showModal();
    else if (!expanded && element.open) element.close();
    const body = dialogBody.current;
    if (!expanded || !body) return;
    return bindViewerZoom(body, 'modified', (factor, origin) => {
      const cell = document.elementFromPoint(origin.x, origin.y)?.closest('th, td');
      const content = cell && body.contains(cell) ? cell : body.querySelector('table')!;
      zoomAnchor.current = { element: content, point: captureZoomAnchor(body, content, origin) };
      setZoom(previous => Math.min(4, Math.max(.5, previous * factor)));
    });
  }, [expanded]);
  useLayoutEffect(() => {
    const captured = zoomAnchor.current;
    if (captured && dialogBody.current) restoreZoomAnchor(dialogBody.current, captured.element, captured.point);
    zoomAnchor.current = null;
  }, [zoom]);

  return <div className="conversation-table" data-wide={table.columns >= 4}>
    <div className="conversation-table-toolbar">
      <span className="conversation-table-hint" style={{ visibility: overflowing ? 'visible' : 'hidden' }} aria-hidden={!overflowing}>
        {chinese ? '横向滚动查看' : 'Scroll horizontally'}
      </span>
      <button {...(target ? identity.action('expand', 'click') : {})} type="button" aria-expanded={expanded} aria-haspopup="dialog" className="conversation-table-expand" onClick={() => setExpanded(true)}>
        <AchbitShellIcon name="expand" />
        {chinese ? '放大表格' : 'Expand table'}
      </button>
    </div>
    <div className="conversation-table-scroll" ref={viewport} tabIndex={0} role="region"
      aria-label={chinese ? '表格，可横向滚动' : 'Table, horizontally scrollable'} data-scrolled={scrolled}
      onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 1)}>
      <table>{table.content}</table>
    </div>
    <dialog {...(target ? identity.part('dialog') : {})} ref={dialog} className="conversation-table-dialog" aria-labelledby={titleId}
      onClose={() => { setExpanded(false); setZoom(1); zoomAnchor.current = null; }} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      {expanded && <>
        <header className="conversation-table-dialog-header">
          <div><strong id={titleId}>{chinese ? '表格' : 'Table'}</strong><small>{chinese ? `${table.rows} 行 · ${table.columns} 列` : `${table.rows} rows · ${table.columns} columns`}</small></div>
          {zoom !== 1 && <button type="button" className="conversation-table-zoom-reset" title={chinese ? '恢复 100% 缩放' : 'Reset zoom to 100%'}
            onClick={() => { zoomAnchor.current = null; setZoom(1); }}>{Math.round(zoom * 100)}%</button>}
          <button {...(target ? identity.action('close', 'click') : {})} type="button" className="conversation-table-close" aria-label={chinese ? '关闭表格' : 'Close table'} onClick={() => dialog.current?.close()}><AchbitShellIcon name="close" /></button>
        </header>
        <div ref={dialogBody} className="conversation-table-dialog-body" tabIndex={0}><table style={{ zoom }}>{table.content}</table></div>
      </>}
    </dialog>
  </div>;
});
