import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { ResourceTreeMenu, type AttachTreeResource } from './ResourceTreeMenu';
import { asyncDataLoaderFeature, hotkeysCoreFeature, createTree, type TreeConfig, type ItemInstance } from '@headless-tree/core';
import { useConversationHost } from './ConversationHost';
import { resourceKey, type ResourceEntry, type ResourceReference } from '../../services/conversationResources';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import type { UiLanguage } from '../../i18n';
import type { ReaderTarget } from './readerState';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { returnFocusTo, useInteractionFocus } from '../shared/interactionFocus';

type Node = { name: string; parentId?: string; entry?: ResourceEntry; children?: ResourceEntry[]; childIds?: string[]; error?: string };

// A Headless Tree instance owns its item handles for its entire lifetime. When a
// directory withdraws an item, reproject only the still-reachable snapshots.
function useResourceTree(config: TreeConfig<Node>) {
  const [tree, setTree] = useState(() => createTree<Node>(config));
  const [, render] = useReducer(value => value + 1, 0);
  tree.setConfig(previous => ({ ...previous, ...config, setState: render }));
  useEffect(() => {
    tree.setMounted(true);
    tree.rebuildTree();
    return () => tree.setMounted(false);
  }, [tree]);
  const replace = (nodes: Map<string, Node>) => {
    const { expandedItems, focusedItem } = tree.getState();
    const next = createTree<Node>({ ...config, initialState: {
      expandedItems: expandedItems.filter(id => nodes.has(id)),
      focusedItem: focusedItem && nodes.has(focusedItem) ? focusedItem : null,
    } });
    for (const [id, node] of nodes) {
      const item = next.getItemInstance(id);
      item.updateCachedData(node, true);
      if (node.childIds) item.updateCachedChildrenIds(node.childIds, true);
    }
    setTree(next);
  };
  return { tree, replace };
}

type ResourceTreeProps = { sessionId: string; language: UiLanguage; visible: boolean; activeTarget?: ReaderTarget; openTarget(target: ReaderTarget): void; onAttach?: AttachTreeResource };

export function ResourceTree(props: ResourceTreeProps) {
  const [opened, setOpened] = useState(props.visible);
  useEffect(() => { if (props.visible) setOpened(true); }, [props.visible]);
  // Lazily create the loader on first use; keep it afterwards so hiding Reader
  // does not discard folder expansion, filtering or focus state.
  return opened || props.visible ? <ResourceTreeContents {...props} /> : null;
}

function ResourceTreeContents({ sessionId, language, openTarget, visible, activeTarget, onAttach }: ResourceTreeProps) {
  const interaction = useInteractionFocus();
  const { resources } = useConversationHost();
  const chinese = language === 'zh-CN';
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ entry: ResourceEntry; x: number; y: number } | null>(null);
  const [actionError, setActionError] = useState('');
  const menuAnchor = useRef<HTMLElement | null>(null);
  const treeAnchor = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback((closing: HTMLElement | null) => { setMenu(null); returnFocusTo(menuAnchor.current, interaction, closing); }, [interaction]);
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
  const activeTree = useRef<ReturnType<typeof createTree<Node>> | null>(null);
  const { tree, replace } = useResourceTree({
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
        const project = (children: { id: string; data: Node }[]) => {
          const current = nodes.current;
          const parent = current.get(id);
          if (activeTree.current !== tree || !parent || lifetime.current?.signal.aborted) return [];
          const nextIds = children.map(child => child.id);
          const retained = new Set(nextIds);
          let withdrawn = parent.childIds?.some(child => !retained.has(child));
          parent.childIds = nextIds;
          for (const child of children) {
            const old = current.get(child.id);
            if (old?.childIds) {
              if (old.entry?.kind === child.data.entry?.kind && JSON.stringify(old.children) === JSON.stringify(child.data.children)) {
                child.data.childIds = old.childIds;
              } else withdrawn = true;
            }
            current.set(child.id, child.data);
          }
          if (withdrawn) {
            const reachable = new Map<string, Node>();
            const pending = ['root'];
            while (pending.length) {
              const key = pending.pop()!;
              const node = current.get(key);
              if (!node || reachable.has(key)) continue;
              reachable.set(key, node);
              if (node.childIds) for (const child of node.childIds) pending.push(child);
            }
            for (const [key, data] of current) {
              const item = tree.getItemInstance(key);
              item.updateCachedData(undefined, true);
              if (data.childIds) item.updateCachedChildrenIds([], true);
            }
            current.clear();
            nodes.current = reachable;
            activeTree.current = null;
            replace(reachable);
            return [];
          }
          return children;
        };
        try {
          const node = nodes.current.get(id);
          const children = id === 'root'
            ? await resources.listResourceRoots(sessionId, lifetime.current?.signal)
            : node?.children ?? await resources.listResourceDirectory(sessionId, node!.entry!.resource, lifetime.current?.signal);
          const result: { id: string; data: Node }[] = [];
          const add = (child: ResourceEntry) => {
            const childId = resourceKey(child.resource);
            const data: Node = { entry: child, parentId: id, name: child.category === 'session' ? (chinese ? '会话文件' : 'Session files') : child.name, error: child.error };
            result.push({ id: childId, data });
          };
          if (id === 'root') {
            children.filter(child => child.category === 'project').forEach(add);
            for (const [category, label] of [['reference', chinese ? '引用目录' : 'Referenced folders'], ['attachment', chinese ? '会话附件' : 'Attachments'], ['resource', chinese ? '已授权资源' : 'Granted resources'], ['agent', chinese ? '子代理文件' : 'Agent files']] as const) {
              const entries = children.filter(child => child.category === category);
              if (!entries.length) continue;
              const groupId = 'group:' + category;
              const data: Node = { name: label, parentId: 'root', children: entries };
              result.push({ id: groupId, data });
            }
            children.filter(child => child.category === 'session').forEach(add);
          } else children.forEach(add);
          return project(result);
        } catch (error) {
          if (lifetime.current?.signal.aborted) return [];
          const data = { name: String(error), error: String(error) };
          return project([{ id: `${id}:error`, data }]);
        }
      },
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });
  activeTree.current = tree;
  useEffect(() => { if (visible) void tree.getRootItem().invalidateChildrenIds(true); }, [projectionKey, visible, tree]);
  const targetReference: ResourceReference | undefined = activeTarget?.kind === 'workspace'
    ? { workspaceId: activeTarget.workspaceId, logicalPath: activeTarget.logicalPath }
    : activeTarget?.kind === 'resource' ? activeTarget.resource : undefined;
  const targetId = targetReference && resourceKey(targetReference);
  const completedReveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) { completedReveal.current = undefined; return; }
    const reveal = JSON.stringify([sessionId, projectionKey, targetId]);
    if (completedReveal.current === reveal) {
      setSelected(previous => previous && nodes.current.has(previous) ? previous : undefined);
      return;
    }
    completedReveal.current = undefined;
    let cancelled = false;
    setSelected(undefined);
    void (async () => {
      const rootIds = await tree.loadChildrenIds('root');
      if (cancelled) return;
      for (const id of rootIds) if (nodes.current.get(id)?.entry?.category === 'project') tree.getItemInstance(id).expand();
      if (!targetReference || 'change' in targetReference) { completedReveal.current = reveal; return; }
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
      if (!cancelled) { completedReveal.current = reveal; setSelected(current); setFilter(''); }
    })().catch(error => { if (!cancelled) setWatchError(String(error)); });
    return () => { cancelled = true; };
  }, [sessionId, targetId, visible, projectionKey, tree]);
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
  if (filter) for (const [id, node] of nodes.current) {
    if (!node.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) continue;
    for (let ancestor: string | undefined = id; ancestor; ancestor = nodes.current.get(ancestor)?.parentId) matched.add(ancestor);
  }
  const displayed = visibleItems.filter(item => !filter || matched.has(item.getId()));
  displayedItems.current = displayed;
  const selectedItem = displayed.find(item => item.getId() === selected);
  const selectedParentId = selectedItem && selectedItem.getItemMeta().level > 0 ? selectedItem.getParent()?.getId() : undefined;
  const watched = visibleItems.filter(item => item.isExpanded() && item.getItemData().entry?.kind === 'directory');
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
    <div className="resource-tree__items" {...tree.getContainerProps(chinese ? '文件' : 'Files')}
      style={{ '--resource-tree-active-depth': selectedItem?.getItemMeta().level ?? 0 } as CSSProperties}>
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
          data-current-branch={selectedParentId && item.isDescendentOf(selectedParentId) ? '' : undefined}
          className={`resource-tree__item${item.getId() === selected ? ' is-selected' : ''}${data.entry?.category ? ' is-root' : ''}`}
          style={{ '--resource-tree-depth': item.getItemMeta().level } as CSSProperties}>
          <AchbitShellIcon name={item.isFolder() ? (item.isExpanded() ? 'chevronDown' : 'chevronRight') : 'artifact'} />
          <span ref={element => { if (element?.parentElement) rows.current.set(item.getId(), element.parentElement as HTMLButtonElement); else rows.current.delete(item.getId()); }} className={data.error ? 'local-agent__resource-error' : ''}>{data.name}</span>
        </button>;
      })}
    </div>
    </UiRegion>
  </aside>;
}
