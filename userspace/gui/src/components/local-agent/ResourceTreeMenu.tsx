import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './resourceTreeMenu.css';
import { createPortal } from 'react-dom';
import type { UiLanguage } from '../../i18n';
import type { ResourceEntry } from '../../services/conversationResources';
import { useConversationHost, type ConversationHost } from './ConversationHost';

export type AttachTreeResource = (selections: { path: string; kind: 'file' | 'directory' }[]) => Promise<void>;
export type TreeResourceAction = 'preview' | 'name' | 'relativePath' | 'absolutePath' | 'folder' | 'editor' | 'attach';

/** Resolve authority-bearing references at the existing Host boundary, never from labels. */
export async function runTreeResourceAction(action: TreeResourceAction, entry: ResourceEntry, sessionId: string,
  host: ConversationHost, open: () => void, attach?: AttachTreeResource) {
  if (action === 'name') return host.copyText(entry.name);
  if (action === 'relativePath') return host.copyText(entry.resource.logicalPath || (entry.kind === 'directory' ? '.' : entry.name));
  if (action === 'preview') { if (entry.kind !== 'file') throw new Error('resource_not_file'); open(); return; }
  const { path, kind } = await host.resources.resolveResourceReference(sessionId, entry.resource);
  if (action === 'absolutePath') return host.copyText(path);
  if (action === 'folder') {
    if (!host.locatePath) throw new Error('resource_locate_unavailable');
    return host.locatePath(path);
  }
  if (action === 'editor') {
    if (!host.openFile) throw new Error('resource_editor_unavailable');
    return host.openFile(path);
  }
  if (!attach) throw new Error('resource_attachment_unavailable');
  return attach([{ path, kind }]);
}

export function ResourceTreeMenu({ entry, sessionId, language, x, y, onOpen, onAttach, onClose, onError }: {
  entry: ResourceEntry; sessionId: string; language: UiLanguage; x: number; y: number;
  onOpen(): void; onAttach?: AttachTreeResource; onClose(closing: HTMLElement | null): void; onError(message: string): void;
}) {
  const host = useConversationHost();
  const menu = useRef<HTMLDivElement>(null);
  const close = () => onClose(menu.current);
  const [busy, setBusy] = useState(false);
  const zh = language === 'zh-CN';
  const items: { action: TreeResourceAction; label: string; disabled?: boolean }[] = [
    ...(entry.kind === 'file' ? [{ action: 'preview' as const, label: zh ? '预览' : 'Preview' }] : []),
    { action: 'name', label: zh ? '复制名称' : 'Copy name' },
    { action: 'relativePath', label: zh ? '复制相对路径' : 'Copy relative path' },
    { action: 'absolutePath', label: zh ? '复制绝对路径' : 'Copy absolute path' },
    { action: 'folder', label: zh ? '显示所在位置' : 'Show in folder', disabled: !host.locatePath },
    { action: 'editor', label: zh ? '在 VS Code 中打开' : 'Open in VS Code', disabled: !host.openFile },
    { action: 'attach', label: zh ? '加入输入框引用' : 'Add reference to message', disabled: !onAttach },
  ];
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', close); };
  }, [onClose]);
  return createPortal(<div ref={menu} className="resource-tree-menu" role="menu" data-native-overlay
    aria-label={zh ? '文件操作' : 'File actions'} aria-busy={busy} style={{ left: x, top: y }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {items.map(item => <button type="button" role="menuitem" key={item.action} disabled={busy || item.disabled}
      onClick={() => {
        setBusy(true);
        void runTreeResourceAction(item.action, entry, sessionId, host, onOpen, onAttach)
          .then(close).catch(error => { onError(error instanceof Error ? error.message : String(error)); close(); });
      }}>{item.label}</button>)}
  </div>, document.body);
}
