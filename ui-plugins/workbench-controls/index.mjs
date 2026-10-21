// Optional example: each control calls the existing Host view owner.
export default {
  apply(context) {
    context.addStyle(`
      .example-header, .example-navigation, .example-tree { display:flex; gap:8px; }
      .example-header { align-items:center; min-width:0; }
      .example-header strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .example-navigation, .example-tree { flex-direction:column; min-height:0; padding:8px; }
      .example-navigation > div { display:flex; flex-direction:column; gap:4px; }
      .example-tree { flex:1; }
      .example-navigation button, .example-tree button { text-align:start; }
      .example-navigation [aria-current], .example-tree [aria-current] { font-weight:700; }
      .example-tree__items { overflow:auto; min-height:0; }
      .example-tree__items button { display:block; width:100%; }
      .example-tree__error { color:var(--dc-danger); white-space:pre-wrap; }
    `);
    const element = (tag, className) => {
      const value = document.createElement(tag);
      if (className) value.className = className;
      return value;
    };
    const button = (label, action) => {
      const value = element('button'); value.type = 'button'; value.textContent = label;
      value.onclick = action; return value;
    };
    context.register('conversation.header', (container, input, scope) => {
      container.style.display = 'contents';
      const heading = element('div', 'local-agent__header-conversation example-header');
      const title = element('strong');
      const reader = button('', () => scope.actions.toggleReader());
      heading.append(title, reader); container.append(heading);
      // Preserve the existing Reader tabs portal and Reader controls.
      scope.regions.mount('reader', container);
      const update = next => {
        if (next.kind !== 'region' || next.data?.kind !== 'conversationHeader') return;
        title.textContent = next.data.title;
        title.title = next.data.project?.title ?? '';
        reader.textContent = next.locale === 'zh-CN' ? '浏览器与预览' : 'Browser and preview';
        reader.disabled = !next.data.reader.canOpen;
        reader.setAttribute('aria-pressed', String(next.data.reader.visible));
      };
      update(input);
      return { update, dispose() { heading.remove(); } };
    });
    context.register('settings.navigation', (container, input, scope) => {
      container.style.display = 'contents';
      const root = element('nav', 'settings-nav example-navigation');
      const search = element('input');
      search.oninput = () => scope.actions.setSettingsSearch(search.value);
      const pages = element('div'); root.append(search, pages); container.append(root);
      const update = next => {
        if (next.kind !== 'region' || next.data?.kind !== 'settingsNavigation') return;
        const data = next.data;
        search.value = data.searchQuery;
        search.placeholder = next.locale === 'zh-CN' ? '搜索设置' : 'Search settings';
        search.setAttribute('aria-label', search.placeholder);
        pages.replaceChildren(...data.pages.map(page => {
          const item = button(page.label, () => scope.actions.selectSettingsPage(page.id));
          if (!data.searchQuery.trim() && page.id === data.activePage) item.setAttribute('aria-current', 'page');
          return item;
        }));
      };
      update(input);
      return { update, dispose() { root.remove(); } };
    });
    context.register('reader.tree', (container, input, scope) => {
      container.style.display = 'contents';
      const root = element('div', 'example-tree');
      const filter = element('input');
      filter.oninput = () => scope.actions.setTreeFilter(filter.value);
      const runtimeLabel = element('label');
      const runtime = element('input'); runtime.type = 'checkbox';
      runtime.onchange = () => scope.actions.setTreeRuntimeVisible(runtime.checked);
      const runtimeText = element('span'); runtimeLabel.append(runtime, runtimeText);
      const error = element('p', 'example-tree__error'); error.setAttribute('role', 'alert');
      const items = element('div', 'example-tree__items');
      root.append(filter, error, items, runtimeLabel); container.append(root);
      const update = next => {
        if (next.kind !== 'region' || next.data?.kind !== 'resourceTree') return;
        const data = next.data;
        filter.value = data.filter;
        filter.placeholder = next.locale === 'zh-CN' ? '筛选已加载文件' : 'Filter loaded files';
        filter.setAttribute('aria-label', filter.placeholder);
        runtime.checked = data.showRuntime;
        runtimeText.textContent = next.locale === 'zh-CN' ? '显示运行环境文件' : 'Show runtime files';
        error.textContent = data.watchError; error.hidden = !data.watchError;
        items.replaceChildren(...data.items.map(item => {
          const row = button(`${item.kind === 'directory' ? (item.expanded ? '▾ ' : '▸ ') : ''}${item.name}`, () => {
            if (item.kind === 'directory') scope.actions.setTreeItemExpanded(item.id, !item.expanded);
            else scope.actions.openTreeItem(item.id);
          });
          const openMenu = event => {
            if (!scope.actions.openTreeItemMenu) return;
            event.preventDefault(); event.stopPropagation(); row.focus();
            scope.actions.openTreeItemMenu(item.id);
          };
          row.oncontextmenu = openMenu;
          row.onkeydown = event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event); };
          row.style.paddingLeft = `${8 + item.depth * 12}px`;
          row.disabled = item.kind === 'unavailable';
          row.title = item.error ?? item.name;
          if (item.selected) row.setAttribute('aria-current', 'true');
          return row;
        }));
      };
      update(input);
      return { update, dispose() { root.remove(); } };
    });
  },
};
