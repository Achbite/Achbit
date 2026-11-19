export async function checkPluginMarketplace({ navigate, evaluate, cmd, until, click, frame, key, type, selectFixture, record }) {
  const root = 'https://github.com/example/achbit-market-fixture', commit = 'a'.repeat(40);
  const source = root + '/tree/' + commit, license = root + '/blob/' + commit + '/LICENSE';
  const download = root + '/releases/download/1.0.0/echo.zip';
  for (const [lang, width, viewport, all, enabled, installed, discover] of [
    ['zh-CN', 900, 1040, '全部', '已启用', '已安装', '插件市场'], ['en-US', 380, 412, 'All', 'Enabled', 'Installed', 'Marketplace'],
  ]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate('settings-layout');
    await selectFixture('Language', lang);
    await selectFixture('Panel width', String(width));
    await selectFixture('Page', 'plugins');
    const nav = '.plugin-manager__nav button', active = nav + '[aria-pressed="true"]';
    const allButton = nav + ':nth-of-type(1)', enabledButton = nav + ':nth-of-type(2)', marketButton = '#setting-plugin-marketplace';
    const market = `section[aria-label="${discover}"]`, target = JSON.stringify(market);
    const current = () => evaluate(`document.querySelector('${active}')?.textContent.trim().replace(/ [0-9]+$/, '')`);
    const matches = () => evaluate(`Array.from(document.querySelector(${target}).querySelectorAll('article h3'), item => item.innerText)`);
    const inventoryRows = () => evaluate("[...document.querySelectorAll('.plugin-manager__summary strong')].map(e=>e.textContent)");
    const tabNames = () => evaluate(`[...document.querySelectorAll('${nav}')].map(button=>button.textContent.trim())`);
    await until("document.querySelectorAll('.plugin-manager__summary').length === 2");
    const labels = await tabNames(), allRows = await inventoryRows();
    const defaultAll = await current() === all && await evaluate('window.marketplaceFixture.requests === 0');
    const showsAdd = () => evaluate("!!document.querySelector('.plugin-manager__add')?.getClientRects().length");
    const allAdd = await showsAdd();
    await record(`plugin-inventory-all-${lang}-${width}`, {labels, allRows, defaultAll, allAdd},
      defaultAll && allAdd && labels.join('|') === [all + ' 2', enabled + ' 1', discover].join('|') && allRows.includes('Layout preview plugin'));
    await click(enabledButton);
    const enabledRows = await inventoryRows();
    await record(`plugin-inventory-enabled-${lang}-${width}`, {enabledRows}, await current() === enabled
      && await showsAdd() && enabledRows.length === 1 && allRows.includes(enabledRows[0]) && !enabledRows.includes('Layout preview plugin'));
    await click(marketButton);
    await until(`document.querySelector(${target})?.querySelector('[role=alert]')?.textContent.includes('503')`);
    const failedOnce = await evaluate('window.marketplaceFixture.requests === 1');
    await click(market + ' [role="alert"] + button');
    await until(`document.querySelector(${target})?.querySelectorAll('details').length === 2`);
    const retried = await evaluate('window.marketplaceFixture.requests === 2');
    const summary = await evaluate(`(() => {
      const section = document.querySelector(${target}), first = section.querySelector('article');
      const text = first.innerText;
      const controls = [...section.querySelectorAll('a, button, input, summary')].filter(e => e.getClientRects().length);
      const fits = controls.every(e => {const r=e.getBoundingClientRect(), p=section.getBoundingClientRect(); return r.left>=p.left-1 && r.right<=p.right+1;});
      return { text, fits, button: first.querySelector('button')?.textContent, paginated: !!section.querySelector('nav'), contribute:section.querySelector('.plugin-market__tools a').href };
    })()`);
    const installLabel = lang === 'zh-CN' ? '安装并启用' : 'Install & enable';
    const description = lang === 'zh-CN' ? '按原格式返回输入文本。' : 'Return supplied text in a consistent format.';
    await record('plugin-market-overview-' + lang + '-' + width, summary, summary.fits && !summary.paginated && summary.button === installLabel &&
      summary.text.includes(description) && summary.text.includes(lang === 'zh-CN' ? '技能' : 'Skill') && summary.text.includes('Anya') && summary.text.includes('1.0.0') && !summary.text.includes(commit) &&
      summary.contribute.endsWith(lang === 'zh-CN' ? '/CONTRIBUTING.zh-CN.md' : '/CONTRIBUTING.md'));
    await click(market + ' input[type="checkbox"]');
    const verified = await matches();
    await evaluate(`document.querySelector(${JSON.stringify(market + ' summary')}).focus()`);
    await key('Enter');
    const detail = async () => evaluate(`(() => {
      const page = document.querySelector(${target}), opened = page.querySelector('details[open]');
      const links = [...opened.querySelectorAll('a')].map(a => ({ text: a.innerText, href: a.href, title: a.title, accessibleName: a.getAttribute('aria-label') }));
      const panel = document.querySelector('.fixture-panel').getBoundingClientRect();
      const fits = [...opened.querySelectorAll('a, code')].every(e => {
        const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= panel.left - 1 && r.right <= panel.right + 1;
      });
      return { links, text: opened.innerText, width: panel.width, fits };
    })()`);
    const echo = await detail();
    await click(market + ` a[href="${download}"]`);
    const urls = await evaluate('window.marketplaceFixture.externalUrls.slice()');
    const hasLink = (entry, href, text) => entry.links.some(item => item.href === href && item.text === text);
    const hasSource = entry => entry.links.some(item => item.href === source && item.text === commit.slice(0, 12) &&
      item.title?.includes(commit) && item.accessibleName?.includes(commit));
    const echoOkay = defaultAll && !await showsAdd() && failedOnce && retried && verified.length === 1 && verified[0] === 'Echo Tools'
      && hasSource(echo) && hasLink(echo, license, 'MIT') && echo.fits && echo.width === width && echo.text.includes('macos-arm64')
      && echo.text.includes(lang === 'zh-CN' ? '开源' : 'Open source')
      && urls.length === 1 && urls[0] === download && await current() === discover;
    await record(`plugin-market-verified-${lang}-${width}`, { defaultAll, failedOnce, retried, verified, echo, urls }, echoOkay);

    await click(market + ' input[type="checkbox"]');
    await type(market + ' input[type="search"]', 'Lee');
    const filtered = await matches();
    await click(market + ' summary');
    const theme = await detail();
    const kind = lang === 'zh-CN' ? '源码可查' : 'Source available';
    const themeOkay = filtered.length === 1 && filtered[0] === 'Quiet Theme' && hasLink(theme, license, 'Fixture Community License')
      && theme.text.includes(kind) && hasSource(theme) && theme.fits;
    await record(`plugin-market-author-${lang}-${width}`, { filtered, theme }, themeOkay);
    await click(allButton);
    await frame();
    const returned = await current() === all && await evaluate(`!document.querySelector(${target})`);
    const writes = await evaluate('window.marketplaceFixture.installations.slice()');
    await record(`plugin-market-return-${lang}-${width}`, { returned, writes }, returned && writes.length === 0);
    await click(marketButton);
    await type(market + ' input[type="search"]', 'Echo');
    const echoRow = market + ' article[aria-label="Echo Tools"]';
    const echoBtn = echoRow + ' button';
    await until(`document.querySelector(${JSON.stringify(echoBtn)})?.textContent === ${JSON.stringify(installLabel)} && !document.querySelector(${JSON.stringify(echoBtn)}).disabled`);
    const attempt = async () => {
      await evaluate(`(() => {window.marketplaceFixture.holdNext=true;const b=document.querySelector(${JSON.stringify(echoBtn)});b.click();b.click();})()`);
      await until('!!window.marketplaceFixture.finish');
    };
    await attempt();
    const queued = await evaluate(`({busy:document.querySelector(${JSON.stringify(echoBtn)}).disabled,writes:window.marketplaceFixture.commands.slice()})`);
    await click(enabledButton); await click(marketButton);
    await until(`document.querySelector(${JSON.stringify(echoBtn)})?.getAttribute('aria-busy')==='true'`);
    const persisted = await evaluate('window.marketplaceFixture.commands.length===1');
    let retriedInstall = false;
    if (lang === 'en-US') {
      await evaluate("window.marketplaceFixture.finish('reject')");
      await until(`document.querySelector(${JSON.stringify(echoRow + ' [role="alert"]')})?.innerText.includes('Archive checksum mismatch')`);
      await attempt();
      retriedInstall = await evaluate('window.marketplaceFixture.commands.length===2');
    }
    await evaluate("window.marketplaceFixture.finish('" + (lang === 'en-US' ? 'activation-failed' : 'success') + "')");
    const manage = lang === 'zh-CN' ? '管理' : 'Manage';
    await until(`document.querySelector(${JSON.stringify(echoBtn)})?.textContent === ${JSON.stringify(manage)}`);
    const success = await evaluate(`document.querySelector(${JSON.stringify(echoRow + ' [role="status"]')})?.innerText || ''`);
    const error = await evaluate(`document.querySelector(${JSON.stringify(echoRow + ' [role="alert"]')})?.innerText || ''`);
    await click(echoBtn);
    await until("[...document.querySelectorAll('.plugin-manager__summary[aria-expanded=true]')].some(b=>b.textContent.includes('Echo Tools'))");
    const managed = await current() === all;
    const first = queued.writes[0]?.marketplace;
    await record('plugin-market-install-' + lang + '-' + width, { queued, persisted, retriedInstall, error, success, managed },
      queued.busy && queued.writes.length === 1 && first?.id === 'echo' && first.version === '1.0.0' && first.kind === 'guidance' && first.manifestId === 'Echo Demonstration' && first.sha256 === 'b'.repeat(64)
      && managed && persisted && (lang === 'en-US' ? retriedInstall && error.includes('Fixture startup failed') && !success : error === '' && success === installed));
  }
  await navigate('settings-layout', {largeMarket:'1'});
  await selectFixture('Language','en-US');
  await selectFixture('Page','plugins');
  await click('#setting-plugin-marketplace');
  await until("document.querySelector('.plugin-market [role=alert]')?.innerText.includes('503')");
  await click('.plugin-market [role="alert"] + button');
  const titles = () => evaluate("[...document.querySelectorAll('.plugin-market article h3')].map(e => e.innerText)");
  await until("document.querySelector('.plugin-market nav button:last-child')");
  const first = await titles();
  await click('.plugin-market nav button:last-child');
  const second = await titles();
  const filter = async label => {
    await evaluate(`[...document.querySelectorAll('.plugin-market__categories button')].find(b=>b.textContent === ${JSON.stringify(label)}).click()`);
    await frame();
  };
  await filter('Services');
  const service = await titles(), servicePage = await evaluate("!!document.querySelector('.plugin-market nav')");
  const fallback = await evaluate("document.querySelector('.plugin-market article a[href*=zip]')?.textContent");
  await click('.plugin-market article a[href*=zip]');
  const fallbackDownload = await evaluate("({urls:window.marketplaceFixture.externalUrls, writes:window.marketplaceFixture.installations})");
  await filter('All');
  const reset = await titles();
  await click('.plugin-market nav button:last-child');
  await type('.plugin-market input[type=search]', 'Text');
  const searched = await titles();
  await type('.plugin-market input[type=search]', 'palette');
  await until("document.querySelector('.plugin-market article button')?.textContent==='Manage'");
  await click('.plugin-market article button');
  await until("document.querySelector('.plugin-manager__summary[aria-expanded=true]')?.textContent.includes('Layout preview plugin')");
  await record('plugin-market-categories-pagination', {first,second,service,servicePage,fallback,fallbackDownload,reset,searched,managed:true},
    first.length > 0 && second.length > 0 && first.length + second.length === 15 && !first.some(name=>second.includes(name)) && service.length === 1 && !servicePage &&
    fallback === 'Download' && fallbackDownload.urls.length === 1 && fallbackDownload.urls[0].endsWith('/extra-0.zip') && fallbackDownload.writes.length === 0 && first.join() === reset.join() && searched.join() === 'Echo Tools');
  await click('#setting-plugin-marketplace');
  await type('.plugin-market input[type=search]', 'Echo');
  const echoButton = '.plugin-market article[aria-label="Echo Tools"] button';
  await until(`document.querySelector(${JSON.stringify(echoButton)})?.textContent === 'Install & enable'`);
  const requests = await evaluate('window.marketplaceFixture.requests');
  await evaluate('window.marketplaceFixture.installElsewhere()');
  await click(echoButton);
  await until(`document.querySelector(${JSON.stringify(echoButton)})?.textContent === 'Manage'`);
  const conflict = await evaluate("({error:document.querySelector('.plugin-market article [role=alert]')?.innerText,commands:window.marketplaceFixture.commands.length,requests:window.marketplaceFixture.requests})");
  await record('plugin-market-concurrent-install', conflict, conflict.error?.includes('Plugin already registered') && conflict.commands === 1 && conflict.requests === requests);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate('settings-layout', {fullSettings:'1'});
  await evaluate("[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent.trim()==='插件').click()");
  await until("document.querySelectorAll('.plugin-manager__summary').length===2");
  await click('.plugin-manager__nav button:nth-of-type(2)');
  await type('.plugin-manager__tools input', 'GitHub');
  const selectResult = async title => {
    await type('.settings-search input', title);
    const result = `[...document.querySelectorAll('.settings-search-result')].find(button=>button.querySelector('strong')?.innerText===${JSON.stringify(title)})`;
    await until(result);
    await evaluate(result + '.click()');
    await frame();
  };
  await selectResult('Layout preview plugin');
  const revealed = await evaluate(`({
    title:document.activeElement?.querySelector('strong')?.innerText,
    view:document.querySelector('.plugin-manager__nav [aria-pressed=true]')?.textContent.trim(),
    query:document.querySelector('.plugin-manager__tools input')?.value
  })`);
  await selectResult('插件市场');
  const marketFocused = await evaluate("document.activeElement?.id==='setting-plugin-marketplace' && document.activeElement.getAttribute('aria-pressed')==='true'");
  await record('plugin-inventory-search-navigation', {revealed, marketFocused},
    revealed.title === 'Layout preview plugin' && revealed.view === '全部 2' && revealed.query === '' && marketFocused);
}
