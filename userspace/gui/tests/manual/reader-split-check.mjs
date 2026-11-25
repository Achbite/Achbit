import assert from 'node:assert/strict';
import { checkMarkdownNavigation } from './markdown-navigation-check.mjs';

export async function checkReaderFileMenu({ navigate, evaluate, until, click, key, record }) {
  // Use a fresh workbench so these external opens do not feed other routing scenarios.
  await navigate('reader-workbench');
  const menu = '.reader-external-open', summary = menu + ' summary';
  const tab = '.reader-tab--active [role=tab]';
  await until(`document.querySelector('${tab}')?.textContent.includes('Agent.md')`);
  const actions = [];
  for (const [index, calls] of [[1, 'opened'], [2, 'folders']]) {
    await click(summary);
    const item = `${menu} [role=menuitem]:nth-child(${index})`;
    // macOS WebKit may blur the summary without focusing the pressed button.
    await evaluate(`(() => { const trigger = document.querySelector('${summary}'); trigger.focus();
      document.querySelector('${item}').addEventListener('mousedown', event => {
        event.preventDefault(); trigger.blur();
      }, { once: true }); })()`);
    await click(item);
    const targets = await evaluate(`window.readerWorkbench.${calls}`);
    assert.deepEqual(targets, ['/fixture/Agent.md'], 'activate exactly the selected action on the current file');
    assert.equal(await evaluate(`document.querySelector('${menu}').open`), false);
    actions.push({ calls, targets });
  }
  await click(summary); await click(tab);
  assert.equal(await evaluate(`document.querySelector('${menu}').open`), false, 'outside click closes the menu');
  await evaluate(`document.querySelector('${summary}').focus()`); await key('Enter');
  assert.equal(await evaluate(`document.querySelector('${menu}').open`), true);
  await key('Escape');
  assert.equal(await evaluate(`document.querySelector('${menu}').open`), false, 'Escape closes the keyboard-opened menu');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${summary}')`), true);
  await record('reader-file-menu-dispatch', actions, true);
}

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
  // Capture a real Reader during its first DOM commit, including actions queued before the worker completes.
  const sample = await evaluate(`new Promise((resolve,reject) => {
    const deadline = setTimeout(() => { observe.disconnect(); reject(Error('progressive Reader timeout')); }, 8000);
    const observe = new MutationObserver(() => {
      const view = document.querySelector('.reader-pane:not([hidden]) .conversation-markdown[aria-busy="true"]');
      const jump = view?.querySelector('a[href="#last-section"]'), save = view?.querySelector('.content-image-action button');
      if (!jump || !save) return;
      observe.disconnect(); clearTimeout(deadline);
      const found = window.find('FINAL-READER-MARKER'), selection = String(getSelection());
      getSelection().removeAllRanges();
      const source = fetch(view.closest('.reader-pane').querySelector('a[download]').href).then(response => response.text());
      save.click(); jump.click();
      source.then(text => resolve({ found, selection, correctFile: text === window.readerWorkbench.progressiveSource,
        first: view.querySelector('tbody tr')?.textContent, savesBeforeReady: window.readerWorkbench.saves.length }));
    });
    observe.observe(document.body, { childList:true, subtree:true });
    window.readerWorkbench.openDocument('notes/progressive.md');
  })`);
  await until("document.querySelector('.reader-pane:not([hidden]) .conversation-markdown[aria-busy=false] a[href=\"../Agent.md\"]') && window.readerWorkbench.saves.length === 1");
  const targetVisible = await headingVisible('Last section');
  const finalDocument = await evaluate(`(() => {
    const view = document.querySelector('.reader-pane:not([hidden]) .conversation-markdown');
    const row = view.querySelector('tbody tr');
    const range = new Range(); range.selectNodeContents(row);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString(); selection.removeAllRanges();
    return { end: view.querySelector('.katex math annotation')?.textContent, selected, image: window.readerWorkbench.saves[0] };
  })()`);
  await record('reader-progressive-document', { sample, finalDocument, targetVisible },
    sample.found && sample.selection === 'FINAL-READER-MARKER' && sample.correctFile && sample.first.includes('A & B') &&
    sample.savesBeforeReady === 0 && targetVisible && finalDocument.selected.includes('©') && finalDocument.end === 'x^2' &&
    finalDocument.image.type === 'image/png' && finalDocument.image.width > 0 && finalDocument.image.height > 0);
  for (const [file, expected, token] of [['long-code.md', 'longCode', 'BOUNDARYMARKER'], ['many-lines.md', 'manyCodeLines', 'source line 999']]) {
    const copy = await evaluate(`new Promise((resolve,reject) => {
      const end = setTimeout(() => { observe.disconnect(); reject(Error('code action timed out')); }, 8000);
      const fixture = window.readerWorkbench, initial = fixture.copies.length;
      let temporary;
      const observe = new MutationObserver(() => {
        const view = document.querySelector('.reader-pane:not([hidden]) .conversation-markdown[aria-busy]');
        if (!view) return;
        const button = view.querySelector('.conversation-copy-button');
        if (view.ariaBusy === 'true' && temporary === undefined) {
          const found = window.find(${JSON.stringify(token)}); getSelection().removeAllRanges();
          button?.click();
          temporary = { found, withheld: !button || button.disabled, unchanged: fixture.copies.length === initial };
        } else if (view.ariaBusy === 'false' && temporary && button && !button.disabled) {
          observe.disconnect(); clearTimeout(end); button.click();
          resolve({ temporary, canonical: fixture.copies.at(-1) === fixture[${JSON.stringify(expected)}] + '\\n',
            delivered: fixture.copies.at(-1)?.length, completeSearch: window.find(${JSON.stringify(token)}) });
          getSelection().removeAllRanges();
        }
      });
      observe.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['aria-busy'] });
      fixture.openDocument(${JSON.stringify('notes/' + file)});
    })`);
    await record('reader-whole-code-copy-' + file, copy, copy.temporary.found && copy.temporary.withheld &&
      copy.temporary.unchanged && copy.canonical && copy.completeSearch);
  }
  await evaluate('window.readerWorkbench.openDiff()');
  const diff = '.reader-pane:not([hidden]) .reader-diff';
  await until(`document.querySelector('${diff} .cm-collapsedLines') && document.querySelector('${diff}').textContent.includes('NEW 🦊 row 1 value 1')`);
  const endings = await evaluate(`(() => {const view=document.querySelector('${diff}');return {
    originalLoneCR: [...view.querySelectorAll('.cm-deletedChunk')].some(n=>n.textContent.includes('OLD 🧪 row 1 value 1\\rOLD-CR-ONE')),
    currentLoneCR: [...view.querySelectorAll('.cm-line')].some(n=>n.textContent === 'NEW-CR-ONE')};})()`);
  await click(diff + ' .cm-collapsedLines');
  await until(`[...document.querySelectorAll('${diff} .cm-line')].some(line => line.textContent === 'unchanged 🧭 row 10 value 100' && !line.matches('.cm-changedLine,.cm-insertedLine'))`);
  await evaluate(`document.querySelector('${diff} .cm-scroller').scrollTop = document.querySelector('${diff} .cm-scroller').scrollHeight`);
  await until(`[...document.querySelectorAll('${diff} .cm-line')].some(line => line.textContent === 'NEW 🦊 row 6000 value 36000000')`);
  const finalChange = await evaluate(`(() => {const pane=document.querySelector('${diff}');return {
    deleted:pane.textContent.includes('OLD 🧪 row 6000 value 36000000'), inserted:pane.textContent.includes('NEW 🦊 row 6000 value 36000000')};})()`);
  await click(close);
  await until("!document.querySelector('.reader-diff .cm-editor')");
  await record('reader-large-unified-diff', { ...finalChange, ...endings }, finalChange.deleted && finalChange.inserted && endings.originalLoneCR && endings.currentLoneCR);
  const actions = await evaluate("({ folders: window.readerWorkbench.folders, external: window.readerWorkbench.external })");
  await record('reader-document-link-routing', { count, after, ...actions }, count === after &&
    actions.folders[0] === '/fixture/notes' && actions.external[0] === 'https://example.org/reader');
  await evaluate('sessionStorage.clear()');
  await navigate('reader-workbench', { files: '5000' });
  await until("document.querySelector('[data-ui-action$=\"toggle-tree\"]')");
  await click('[data-ui-action$="toggle-tree"]');
  const box = '.resource-tree:not([hidden]) [role=tree]';
  const firstFile = box + ' [title="large-00001.md"]';
  await until(`document.querySelector('${firstFile}')?.getAttribute('aria-setsize') === '5000'`);
  const rowCount = () => evaluate(`document.querySelectorAll('${box} [role=treeitem]').length`);
  const initial = await rowCount();
  async function press(key, code, modifiers = 0) {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers, windowsVirtualKeyCode: code });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers, windowsVirtualKeyCode: code });
    await frame();
  }
  const activeTitle = 'document.activeElement.title';
  await evaluate(`document.querySelector('${firstFile}').focus()`);
  await press('End', 35);
  await until(`${activeTitle} === 'large-05000.md'`);
  const last = await evaluate(`({ position: document.activeElement.getAttribute('aria-posinset'), scrollTop: document.querySelector('${box}').scrollTop })`);
  await press('ArrowUp', 38); await until(`${activeTitle} === 'large-04999.md'`);
  await press('ArrowDown', 40); await until(`${activeTitle} === 'large-05000.md'`);
  await press('F10', 121, 8); await until("document.querySelector('.resource-tree-menu [role=menuitem], .resource-tree-menu button')");
  await press('Escape', 27); await until(`${activeTitle} === 'large-05000.md'`);
  await press('Home', 36); await until(`${activeTitle} === '' && document.activeElement.getAttribute('aria-level') === '1'`);
  const input = '.resource-tree__filter input';
  await click(input); await cmd('Input.insertText', { text: 'large-05000' }); await until(`document.querySelectorAll('${box} [role=treeitem]').length === 2`);
  await evaluate(`document.querySelector('${input}').select()`); await press('Backspace', 8);
  await until(`document.querySelector('${firstFile}')`);
  await evaluate("window.readerWorkbench.openDocument('large-04500.md')");
  const revealedFile = box + ' [title="large-04500.md"]';
  await until(`document.querySelector('${revealedFile}')?.getAttribute('aria-current') === 'true'`);
  const revealed = await evaluate(`(()=>{const r=document.querySelector('${revealedFile}').getBoundingClientRect(),b=document.querySelector('${box}').getBoundingClientRect();return { inView:r.top>=b.top-1 && r.bottom<=b.bottom+1, title:document.querySelector('.reader-tab--active')?.textContent }})()`);
  const finalRows = await rowCount();
  await record('reader-large-tree-viewport-actions', { initial, finalRows, last, revealed }, initial < 100 && finalRows < 100 && last.position === '5000' && last.scrollTop > 0 && revealed.inView && revealed.title.includes('large-04500.md'));
  await checkMarkdownNavigation({ navigate, evaluate, until, click, record });
}
