import { useCallback, useEffect, useRef, useState } from 'react';
import { ResourceTreeMenu, type AttachTreeResource } from './ResourceTreeMenu';
import { asyncDataLoaderFeature, hotkeysCoreFeature, type ItemInstance } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { useConversationHost } from './ConversationHost';
import { resourceKey, type ResourceEntry, type ResourceReference } from '../../services/conversationResources';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import type { UiLanguage } from '../../i18n';
import type { ReaderTarget } from './readerState';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { UiRegion } from '../../ui-plugins/UiRegion';

type Node = { name: string; parentId?: string; entry?: ResourceEntry; children?: ResourceEntry[]; error?: string };

type ResourceTreeProps = { sessionId: string; language: UiLanguage; visible: boolean; activeTarget?: ReaderTarget; openTarget(target: ReaderTarget): void; onAttach?: AttachTreeResource };

export function ResourceTree(props: ResourceTreeProps) {
  const [opened, setOpened] = useState(props.visible);
  useEffect(() => { if (props.visible) setOpened(true); }, [props.visible]);
  // Lazily create the loader on first use; keep it afterwards so hiding Reader
  // does not discard folder expansion, filtering or focus state.
  return opened || props.visible ? <ResourceTreeContents {...props} /> : null;
}

function ResourceTreeContents({ sessionId, language, openTarget, visible, activeTarget, onAttach }: ResourceTreeProps) {
  const { resources } = useConversationHost();
  const chinese = language === 'zh-CN';
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ entry: ResourceEntry; x: number; y: number } | null>(null);
  const [actionError, setActionError] = useState('');
  const menuAnchor = useRef<HTMLElement | null>(null);
  const treeAnchor = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => { setMenu(null); menuAnchor.current?.focus(); }, []);
  const openMenu = (entry: ResourceEntry | undefined, anchor: HTMLElement, x: number, y: number) => {
    if (!entry) return;
    menuAnchor.current = anchor; setActionError(''); setMenu({ entry, x, y });
  };
  useEffect(() => { setMenu(null); setActionError(''); }, [sessionId, visible]);
  const showRuntime = useSettingsStore(state => state.effectiveSettings['gui.showRuntimeFiles'] === true);
  const [watchError, setWatchError] = useState('');
  const setShowRuntime = async (visible: boolean) => {
    const activation = await useSettingsStore.getState().patchUserSetting('gui.showRuntimeFiles', visible);
    if (activation === null) setWatchError(useSettingsStore.getState().errorMessage ?? 'settings_write_failed');
  };
  const [selected, setSelected] = useState<string>();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const nodes = useRef(new Map<string, Node>([['root', { name: chinese ? '文件' : 'Files' }]]));
  const lifetime = useRef<AbortController | undefined>(undefined);
  const displayedItems = useRef<ItemInstance<Node>[]>([]);
  const focusItem = (index: number) => {
    displayedItems.current[index]?.setFocused();
    tree.updateDomFocus();
  };
  const moveFocus = (offset: number) => {
    const index = displayedItems.current.findIndex(item => item.isFocused());
    focusItem(Math.max(0, Math.min(index + offset, displayedItems.current.length - 1)));
  };
  const projectionKey = useLocalAgentStore(state => JSON.stringify([
    state.projection?.workspaceBindings, state.projection?.shellAuthorizations,
  ]));
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const open = (entry?: ResourceEntry) => {
    if (entry?.kind === 'file') openTarget({ kind: 'resource', resource: entry.resource, name: entry.name });
  };
  const tree = useTree<Node>({
    rootItemId: 'root',
    getItemName: item => item.getItemData().name,
    isItemFolder: item => item.getId() === 'root' || !!item.getItemData().children || item.getItemData().entry?.kind === 'directory',
    onPrimaryAction: item => open(item.getItemData().entry),
    createLoadingItemData: () => ({ name: chinese ? '正在读取…' : 'Loading…' }),
    hotkeys: {
      focusNextItem: { hotkey: 'ArrowDown', handler: () => moveFocus(1) },
      focusPreviousItem: { hotkey: 'ArrowUp', handler: () => moveFocus(-1) },
      focusFirstItem: { hotkey: 'Home', handler: () => focusItem(0) },
      focusLastItem: { hotkey: 'End', handler: () => focusItem(displayedItems.current.length - 1) },
      expandOrDown: { hotkey: 'ArrowRight', handler: () => {
        const item = tree.getFocusedItem();
        if (item.isExpanded() || !item.isFolder()) moveFocus(1);
        else item.expand();
      } },
    },
    dataLoader: {
      getItem: id => {
        const node = nodes.current.get(id);
        if (!node) throw new Error('resource_tree_item_missing');
        return node;
      },
      getChildrenWithData: async id => {
        try {
          const node = nodes.current.get(id);
          const children = id === 'root'
            ? await resources.listResourceRoots(sessionId, lifetime.current?.signal)
            : node?.children ?? await resources.listResourceDirectory(sessionId, node!.entry!.resource, lifetime.current?.signal);
          const result: { id: string; data: Node }[] = [];
          const add = (child: ResourceEntry) => {
            const childId = resourceKey(child.resource);
            const data: Node = { entry: child, parentId: id, name: child.category === 'session' ? (chinese ? '会话文件' : 'Session files') : child.name, error: child.error };
            nodes.current.set(childId, data);
            result.push({ id: childId, data });
          };
          if (id === 'root') {
            children.filter(child => child.category === 'project').forEach(add);
            for (const [category, label] of [['reference', chinese ? '引用目录' : 'Referenced folders'], ['attachment', chinese ? '会话附件' : 'Attachments'], ['resource', chinese ? '已授权资源' : 'Granted resources'], ['agent', chinese ? '子代理文件' : 'Agent files']] as const) {
              const entries = children.filter(child => child.category === category);
              if (!entries.length) continue;
              const groupId = 'group:' + category;
              const data: Node = { name: label, parentId: 'root', children: entries };
              nodes.current.set(groupId, data);
              result.push({ id: groupId, data });
            }
            children.filter(child => child.category === 'session').forEach(add);
          } else children.forEach(add);
          return result;
        } catch (error) {
          if (lifetime.current?.signal.aborted) return [];
          const data = { name: String(error), error: String(error) };
          nodes.current.set(`${id}:error`, data);
          return [{ id: `${id}:error`, data }];
        }
      },
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });
  useEffect(() => { if (visible) void tree.getRootItem().invalidateChildrenIds(true); }, [projectionKey, visible, tree]);
  const targetReference: ResourceReference | undefined = activeTarget?.kind === 'workspace'
    ? { workspaceId: activeTarget.workspaceId, logicalPath: activeTarget.logicalPath }
    : activeTarget?.kind === 'resource' ? activeTarget.resource : undefined;
  const targetId = targetReference && resourceKey(targetReference);
  useEffect(() => {
    let cancelled = false;
    setSelected(undefined);
    if (!visible) return;
    void (async () => {
      const rootIds = await tree.loadChildrenIds('root');
      if (cancelled) return;
      for (const id of rootIds) if (nodes.current.get(id)?.entry?.category === 'project') tree.getItemInstance(id).expand();
      if (!targetReference || 'change' in targetReference) return;
      const candidates = [...rootIds];
      for (const id of rootIds) {
        if (nodes.current.get(id)?.children) candidates.push(...await tree.loadChildrenIds(id));
        if (cancelled) return;
      }
      const sameRoot = (resource: ResourceReference) => resourceKey({ ...resource, logicalPath: '' }) === resourceKey({ ...targetReference, logicalPath: '' });
      const rootId = candidates.find(id => { const entry = nodes.current.get(id)?.entry; return entry && sameRoot(entry.resource); });
      if (!rootId) return;
      const parent = nodes.current.get(rootId)?.parentId;
      if (parent && parent !== 'root') tree.getItemInstance(parent).expand();
      let current = rootId;
      const parts = targetReference.logicalPath.split('/').filter(Boolean);
      if (parts.some(part => part === '..')) return;
      for (let index = 0; index < parts.length; index++) {
        if (cancelled) return;
        tree.getItemInstance(current).expand();
        const children = await tree.loadChildrenIds(current);
        if (cancelled) return;
        const next = resourceKey({ ...targetReference, logicalPath: parts.slice(0, index + 1).join('/') });
        if (!children.includes(next)) return;
        current = next;
      }
      if (!cancelled) { setSelected(current); setFilter(''); }
    })().catch(error => { if (!cancelled) setWatchError(String(error)); });
    return () => { cancelled = true; };
  }, [targetId, visible, projectionKey, tree]);
  useEffect(() => {
    if (!visible || !selected) return;
    const frame = requestAnimationFrame(() => rows.current.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected, visible]);
  const items = tree.getItems();
  const runtimeRoots = items.filter(item => item.getItemData().entry?.category === 'session').map(item => item.getId());
  const hidden = new Set<string>();
  const visibleItems = items.filter(item => {
    const entry = item.getItemData().entry;
    if (!showRuntime && entry?.resource.logicalPath === 'home' && runtimeRoots.includes(item.getParent()?.getId() ?? '')) hidden.add(item.getId());
    return ![...hidden].some(id => item.getId() === id || item.isDescendentOf(id));
  });
  const matched = new Set<string>();
  for (const [id, node] of nodes.current) {
    if (!node.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) continue;
    for (let ancestor: string | undefined = id; ancestor; ancestor = nodes.current.get(ancestor)?.parentId) matched.add(ancestor);
  }
  const displayed = visibleItems.filter(item => !filter || matched.has(item.getId()));
  displayedItems.current = displayed;
  const watched = displayed.filter(item => item.isExpanded() && item.getItemData().entry?.kind === 'directory');
  const watchKey = JSON.stringify(watched.map(item => item.getId()).sort());
  useEffect(() => {
    const ids = JSON.parse(watchKey) as string[];
    if (!visible || !ids.length) return;
    const controller = new AbortController();
    setWatchError('');
    void resources.watchResources(sessionId, ids.map(id => nodes.current.get(id)!.entry!.resource), controller.signal, indices => {
      for (const index of indices) void tree.getItemInstance(ids[index]).invalidateChildrenIds(true);
    }).catch(error => { if (!controller.signal.aborted) setWatchError(String(error)); });
    return () => controller.abort();
  }, [sessionId, watchKey, tree, resources, visible]);
  const displayedItem = (id: string) => {
    const item = displayed.find(item => item.getId() === id);
    if (!item) throw new Error('resource_tree_item_unavailable');
    return item;
  };
  return <aside ref={treeAnchor} className="resource-tree" hidden={!visible} aria-label={chinese ? '文件树' : 'File tree'}>
    {actionError && <p className="local-agent__resource-error" role="alert">{actionError}</p>}
    {visible && menu && <ResourceTreeMenu {...menu} sessionId={sessionId} language={language}
      onOpen={() => open(menu.entry)} onAttach={onAttach} onClose={closeMenu} onError={setActionError} />}
    <UiRegion slot="reader.tree" data={{ kind: 'resourceTree', visible, filter, showRuntime, watchError,
      selectedId: selected ?? null, items: displayed.map(item => {
        const data = item.getItemData();
        return { id: item.getId(), parentId: data.parentId, name: data.name,
          kind: data.entry?.kind ?? (item.isFolder() ? 'directory' : 'unavailable'),
          depth: item.getItemMeta().level, expanded: item.isExpanded(), selected: item.getId() === selected,
          ...(data.error ? { error: data.error } : {}),
        };
      }),
    }} actions={{ setTreeFilter: setFilter, setTreeRuntimeVisible: setShowRuntime,
      setTreeItemExpanded: (id, expanded) => {
        const item = displayedItem(id);
        if (!item.isFolder()) throw new Error('resource_tree_item_not_directory');
        if (expanded) item.expand(); else item.collapse();
      },
      openTreeItem: id => open(displayedItem(id).getItemData().entry),
      openTreeItemMenu: id => {
        const focused = document.activeElement;
        const anchor = rows.current.get(id) ?? (focused instanceof HTMLElement && treeAnchor.current?.contains(focused) ? focused : treeAnchor.current);
        if (!anchor) throw new Error('resource_tree_item_unavailable');
        const rect = anchor.getBoundingClientRect();
        openMenu(displayedItem(id).getItemData().entry, anchor, rect.left, rect.bottom);
      },
    }}>
    <label className="resource-tree__filter"><AchbitShellIcon name="search" /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={chinese ? '筛选已加载文件…' : 'Filter loaded files…'} aria-label={chinese ? '筛选文件' : 'Filter files'} /></label>
    {watchError && <p className="local-agent__resource-error" role="alert">{watchError}</p>}
    <div className="resource-tree__items" {...tree.getContainerProps(chinese ? '文件' : 'Files')}>
      {displayed.map(item => {
        const data = item.getItemData();
        return <button key={item.getId()} {...item.getProps()} aria-current={item.getId() === selected ? 'true' : undefined} type="button" title={data.error ?? data.entry?.resource.logicalPath ?? data.name}
          onContextMenu={event => { if (data.entry) { event.preventDefault(); event.stopPropagation(); openMenu(data.entry, event.currentTarget, event.clientX, event.clientY); } }}
          onKeyDownCapture={event => {
            if ((event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && data.entry) {
              event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect();
              openMenu(data.entry, event.currentTarget, rect.left, rect.bottom);
            }
          }}
          className={`resource-tree__item${item.getId() === selected ? ' is-selected' : ''}${data.entry?.category ? ' is-root' : ''}`}
          style={{ paddingLeft: 8 + item.getItemMeta().level * 12 }}>
          <AchbitShellIcon name={item.isFolder() ? (item.isExpanded() ? 'chevronDown' : 'chevronRight') : 'artifact'} />
          <span ref={element => { if (element?.parentElement) rows.current.set(item.getId(), element.parentElement as HTMLButtonElement); else rows.current.delete(item.getId()); }} className={data.error ? 'local-agent__resource-error' : ''}>{data.name}</span>
        </button>;
      })}
    </div>
    </UiRegion>
  </aside>;
}
