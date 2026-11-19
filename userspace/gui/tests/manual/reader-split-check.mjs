import assert from 'node:assert/strict';

export async function checkReaderSplit({ navigate, evaluate, cmd, until, frame, click, record }) {
  const separator = '.reader-resize';
  const expand = '.local-agent__header-actions [data-ui-action$="toggle-expanded"]';
  const tab = '.reader-tab--active [role=tab]';
  const close = '.reader-tab--active [data-ui-component="CloseButton"]';
  const metrics = async (width, deviceScaleFactor = 1) => {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor, mobile: false });
    await frame();
  };
  const drag = async (selector, offset) => {
    const start = await evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + offset, y: start.y, button: 'left', buttons: 1 });
    await frame();
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + offset, y: start.y, button: 'left', clickCount: 1 });
    await frame();
  };
  const measure = () => evaluate(`(() => {
    const rect = s => document.querySelector(s).getBoundingClientRect();
    const head = rect('.local-agent__header-preview'), body = rect('.local-agent__reader');
    const chrome = rect('.window-controls'), list = rect('.reader-tabs__list');
    const active = document.querySelector('.reader-tab--active');
    const actions = document.querySelectorAll('.reader-tabs > button, .reader-external-open summary, .local-agent__header-actions button:not(:disabled), .window-control');
    const missed = [...actions].filter(button => {
      const r = button.getBoundingClientRect();
      return r.width && !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }).map(button => button.getAttribute('aria-label'));
    const blank = rect('.achbit-gui-titlebar');
    const hit = document.elementFromPoint(blank.left + blank.width / 6, blank.top + 3);
    return { header: head.left, body: body.left, delta: head.left - body.left,
      tabsBeginInside: list.left >= body.left - 1,
      activeInside: !active || Math.max(active.getBoundingClientRect().left, list.left) >= body.left - 1,
      controlsFit: !chrome.width || head.right <= chrome.left + 1,
      hasDragArea: !!hit?.closest('[data-tauri-drag-region]') && !hit.closest('button,summary,[role=tab]'),
      tabWidth: list.width, missed, scroll: document.querySelector('.reader-tabs__list').scrollWidth > list.width + 1,
      ratio: Number(document.querySelector('.reader-resize')?.getAttribute('aria-valuenow')),
      scale: devicePixelRatio };
  })()`);
  const aligned = r => Math.abs(r.delta) <= 1 && r.tabsBeginInside && r.activeInside && r.controlsFit && r.tabWidth > 0 && !r.missed.length;
  await metrics(1440);
  await navigate('reader-workbench');
  await until(`document.querySelector('${tab}')?.textContent.includes('Agent.md')`);
  const split = [await measure()];
  for (const ratio of [40, 70, 55]) {
    const width = await evaluate("document.querySelector('.local-agent').getBoundingClientRect().width");
    await drag(separator, (split.at(-1).ratio - ratio) * width / 100);
    const row = await measure();
    assert.equal(row.ratio, ratio, 'the Reader drag must move its real separator');
    split.push(row);
  }
  await record('reader-split-ratios', split, split.every(r => aligned(r) && r.hasDragArea));
  await drag('.achbit-gui-navigation-resize', 70);
  const navigation = [await measure()];
  await click('[data-ui-action="navigation.sidebar.collapse"]');
  await until("document.querySelector('.achbit-gui-workbench--navigation-collapsed')");
  navigation.push(await measure());
  for (const [width, scale] of [[1152, 1.25], [960, 1.5]]) {
    await metrics(width, scale);
    navigation.push(await measure());
  }
  await record('reader-split-navigation-scale', navigation, navigation.every(aligned));
  await metrics(1100);
  for (let i = 0; i < 5; i++) {
    await evaluate(`window.readerWorkbench.open('Long-file-name-for-the-reader-${i}-with-extra-context.md')`);
    await until(`document.querySelectorAll('.reader-tab').length === ${i + 2}`);
  }
  const many = await measure();
  await click('.reader-external-open summary');
  await click('.reader-external-open [role=menuitem]');
  assert.match(await evaluate('window.readerWorkbench.opened.at(-1)'), /Long-file-name-for-the-reader-4/u);
  await click(close);
  await until("document.querySelectorAll('.reader-tab').length === 5");
  await click('.reader-tabs > .reader-icon-button');
  await until("document.querySelector('.reader-start') && !document.querySelector('.reader-tab--active')");
  await click('.reader-tab [role=tab]');
  await until("document.querySelector('.reader-tab--active')");
  await record('reader-split-long-tabs', many, aligned(many) && many.scroll);
  await metrics(1120);
  await click('[data-ui-action="navigation.toolbar.toggle-sidebar"]');
  await drag('.achbit-gui-navigation-resize', 100);
  assert.equal(await evaluate("document.querySelector('.achbit-gui-navigation-resize').getAttribute('aria-valuenow')"), '400');
  const span = await evaluate("document.querySelector('.local-agent').getBoundingClientRect().width");
  await drag(separator, 0.15 * span);
  const smallSplit = await measure();
  assert.equal(smallSplit.ratio, 40);
  await metrics(850);
  const narrow = await measure();
  const autoStacked = await evaluate("document.querySelector('.local-agent__reader').getBoundingClientRect().top >= document.querySelector('.local-agent__viewport').getBoundingClientRect().bottom - 1");
  await record('reader-split-constrained', { smallSplit, narrow, autoStacked }, aligned(smallSplit) && aligned(narrow) && autoStacked);
  await click('[data-ui-action="navigation.sidebar.collapse"]');
  await metrics(1100);
  await click(expand);
  await until("document.querySelector('.local-agent--expanded')");
  const expanded = await measure();
  await click(expand);
  await metrics(590);
  const stacked = await measure();
  const stackedBelow = await evaluate("document.querySelector('.local-agent__reader').getBoundingClientRect().top >= document.querySelector('.local-agent__viewport').getBoundingClientRect().bottom - 1");
  await metrics(1440);
  await evaluate(`(() => {
    window.shellCalls = [];
    window.__TAURI__ = { core: { invoke: async command => { window.shellCalls.push(command); } } };
    window.addEventListener('achbit:app-close-request', () => window.shellCalls.push('close-request'), { once: true });
  })()`);
  for (const action of ['minimize', 'maximize', 'close']) await click('.window-control--' + action);
  assert.deepEqual(await evaluate('window.shellCalls'), ['achbit_window_minimize', 'achbit_window_toggle_maximize', 'close-request']);
  // Native-overlay shells omit these controls. Remove their box to check the same workbench geometry.
  await evaluate("document.querySelector('.window-controls').style.display = 'none'");
  const overlay = await measure();
  await record('reader-split-other-layouts', { expanded, stacked, stackedBelow, overlay },
    [expanded, stacked, overlay].every(aligned) && stackedBelow);
  await metrics(1200);
  const links = '.reader-pane:not([hidden]) .document-preview__markdown a';
  const openIndex = async () => {
    await evaluate('window.readerWorkbench.openDocument()');
    await until(`document.querySelectorAll('${links}').length === 5`);
  };
  await openIndex();
  const count = await evaluate("document.querySelectorAll('.reader-tab').length");
  await click(links + '[href="../notes/"]');
  await until("window.readerWorkbench?.folders.at(-1) === '/fixture/notes'");
  await click(links + '[href="https://example.org/reader"]');
  await until("window.readerWorkbench.external.length === 1");
  await click(links + '[href="../Agent.md"]');
  await until("document.querySelector('.reader-tab--active [role=tab]')?.textContent.includes('Agent.md')");
  const after = await evaluate("document.querySelectorAll('.reader-tab').length");
  const headingVisible = text => evaluate(`(() => {
    const doc = document.querySelector('.reader-pane:not([hidden]) .document-preview__markdown');
    const h = [...(doc?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [])].findLast(el => el.textContent.trim() === ${JSON.stringify(text)});
    if (!h) return false;
    const r = h.getBoundingClientRect(), viewport = doc.closest('.reader-pane').getBoundingClientRect();
    return r.top >= viewport.top - 1 && r.bottom <= Math.min(viewport.bottom, innerHeight) + 1;
  })()`);
  async function follow(href, heading) {
    const sel = links + '[href="' + href + '"]';
    await until(`document.querySelector(${JSON.stringify(sel)})`);
    const point = await evaluate(`(() => {
      const link = document.querySelector(${JSON.stringify(sel)});
      link.scrollIntoView({ block: 'center', inline: 'nearest' });
      for (const box of link.getClientRects()) {
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        if (link.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      throw Error('Link has no visible click target: ' + link.getAttribute('href'));
    })()`);
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    for (let frameCount = 0; frameCount < 120; frameCount++) {
      if (await headingVisible(heading)) return;
      await frame();
    }
    const details = await evaluate(`(() => {
      const pane = document.querySelector('.reader-pane:not([hidden])'), body = pane.querySelector('.local-agent__resource-body');
      return { tab: document.querySelector('.reader-tab--active')?.textContent, error: pane.querySelector('[role=alert]')?.textContent,
        scrollTop: body?.scrollTop, height: body?.clientHeight, innerHeight, pane: pane.getBoundingClientRect().toJSON(),
        headings: [...pane.querySelectorAll('h1,h2,h3')].map(e => [e.textContent, e.getBoundingClientRect().y]) };
    })()`);
    assert.fail('Heading not visible after clicking ' + href + ': ' + JSON.stringify(details));
  }
  await openIndex();
  await follow('../README.md#build-from-source', 'Build from source');
  await follow('docs/development.md#windows-authenticode-signing', 'Windows Authenticode signing');
  const docsTabs = await evaluate("document.querySelectorAll('.reader-tab').length");
  await follow('../README.md#build-from-source', 'Build from source');
  await follow('#quick-start', 'Quick start');
  const reused = await evaluate("document.querySelectorAll('.reader-tab').length");
  await openIndex();
  await follow('encoded%23%3F.md?v=1#same-1', 'Same');
  await record('reader-document-anchors', { docsTabs, reused, headings: ['Build from source', 'Windows Authenticode signing', 'Quick start', 'Same'] }, docsTabs === reused);
  await openIndex();
  await click(close);
  await until("!window.readerWorkbench.watching.has('notes/index.md')");
  await click('[data-ui-action$="toggle-tree"]');
  const treeRows = '.resource-tree:not([hidden]) .resource-tree__items button';
  const hasRow = name => `[...document.querySelectorAll('${treeRows}')].some(row => row.textContent === ${JSON.stringify(name)})`;
  await until(hasRow('generation-0.md'));
  const filterInput = '.resource-tree__filter input';
  const filterBy = async text => {
    await click(filterInput);
    await evaluate("document.querySelector('.resource-tree__filter input').select()");
    await cmd('Input.insertText', { text });
    await frame();
  };
  await click(treeRows + '[title="Agent.md"]');
  await until(`document.querySelector('${treeRows}[title="Agent.md"]')?.getAttribute('aria-current') === 'true'`);
  await filterBy('generation-1.md');
  await until(`!document.querySelector('${treeRows}')`);
  await evaluate('window.readerWorkbench.changeDirectory()');
  await until(hasRow('generation-1.md'));
  const matched = await evaluate(`({ filter: document.querySelector('${filterInput}').value, watching: window.readerWorkbench.watching.has('') })`);
  const root = treeRows + '[title=""]';
  await click(root);
  await until("!window.readerWorkbench.watching.has('')");
  const before = await evaluate('window.readerWorkbench.directoryMemory().reads');
  await evaluate('window.readerWorkbench.changeDirectory()');
  await frame();
  const afterCollapse = await evaluate('window.readerWorkbench.directoryMemory().reads');
  await click(root);
  await until("window.readerWorkbench.watching.has('')");
  await filterBy('generation-');
  await until(hasRow('generation-2.md'));
  await record('reader-filtered-directory-lifetime', { matched, before, afterCollapse },
    matched.filter === 'generation-1.md' && matched.watching && before === afterCollapse);
  for (let index = 3; index <= 12; index++) {
    await evaluate('window.readerWorkbench.changeDirectory()');
    await until(hasRow('generation-' + index + '.md'));
  }
  await filterBy('generation-0.md');
  const staleMatches = await evaluate(`document.querySelectorAll('${treeRows}').length`);
  await cmd('HeapProfiler.collectGarbage');
  await frame();
  await cmd('HeapProfiler.collectGarbage');
  const memory = await evaluate('window.readerWorkbench.directoryMemory()');
  await record('reader-directory-withdrawn-files', { ...memory, staleMatches }, memory.removed >= 12 && memory.retained.length === 0 && staleMatches === 0);
  const physical = [['/fixture/2026%232.md', 'Physical number sign'], ['/fixture/draft%3Fagain.md', 'Physical question mark'],
    ['/fixture/literal%2523.md', 'Physical percent sequence']];
  for (const [href, heading] of physical) {
    await evaluate("window.readerWorkbench.openDocument('notes/paths.md')");
    await until("document.querySelector('.reader-tab--active')?.textContent.includes('paths.md') && document.querySelectorAll('.reader-pane:not([hidden]) .document-preview__markdown a').length === 3");
    await follow(href, heading);
  }
  await record('reader-physical-filenames', physical, true);
  const actions = await evaluate("({ folders: window.readerWorkbench.folders, external: window.readerWorkbench.external })");
  await record('reader-document-link-routing', { count, after, ...actions }, count === after &&
    actions.folders[0] === '/fixture/notes' && actions.external[0] === 'https://example.org/reader');
}
