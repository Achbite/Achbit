export async function checkPluginMarketplace({ navigate, evaluate, cmd, until, click, frame, type, selectFixture, record }) {
  const root = 'https://github.com/example/achbit-market-fixture', commit = 'a'.repeat(40);
  const source = root + '/tree/' + commit, license = root + '/blob/' + commit + '/LICENSE';
  const download = root + '/releases/download/1.0.0/echo.zip';
  for (const [lang, width, viewport, installed, discover] of [
    ['zh-CN', 900, 1040, '已安装', '插件市场'], ['en-US', 380, 412, 'Installed', 'Marketplace'],
  ]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate('settings-layout');
    await selectFixture('Language', lang);
    await selectFixture('Panel width', String(width));
    await selectFixture('Page', 'plugins');
    const nav = '.plugin-manager__nav button', active = nav + '[aria-pressed="true"]', other = nav + '[aria-pressed="false"]';
    const market = `section[aria-label="${discover}"]`, target = JSON.stringify(market);
    const current = () => evaluate(`document.querySelector('${active}')?.textContent.trim()`);
    const matches = () => evaluate(`Array.from(document.querySelector(${target}).querySelectorAll('summary strong'), item => item.innerText)`);
    const defaultInstalled = await current() === installed && await evaluate('window.marketplaceFixture.requests === 0');
    await click(other);
    await until(`document.querySelector(${target})?.querySelector('[role=alert]')?.textContent.includes('503')`);
    const failedOnce = await evaluate('window.marketplaceFixture.requests === 1');
    await click(market + ' [role="alert"] + button');
    await until(`document.querySelector(${target})?.querySelectorAll('details').length === 2`);
    const retried = await evaluate('window.marketplaceFixture.requests === 2');
    await click(market + ' input[type="checkbox"]');
    const verified = await matches();
    await click(market + ' summary');
    const detail = async () => evaluate(`(() => {
      const page = document.querySelector(${target}), opened = page.querySelector('details[open]');
      const links = [...opened.querySelectorAll('a')].map(a => ({ text: a.innerText, href: a.href }));
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
    const echoOkay = defaultInstalled && failedOnce && retried && verified.length === 1 && verified[0] === 'Echo Tools'
      && hasLink(echo, source, commit) && hasLink(echo, license, 'MIT') && echo.fits && echo.width === width && echo.text.includes('macos-arm64')
      && echo.text.includes(lang === 'zh-CN' ? '开源' : 'Open source')
      && urls.length === 1 && urls[0] === download && await current() === discover;
    await record(`plugin-market-verified-${lang}-${width}`, { defaultInstalled, failedOnce, retried, verified, echo, urls }, echoOkay);

    await click(market + ' input[type="checkbox"]');
    await type(market + ' input[type="search"]', 'Lee');
    const filtered = await matches();
    await click(market + ' summary');
    const theme = await detail();
    const kind = lang === 'zh-CN' ? '源码可查' : 'Source available';
    const themeOkay = filtered.length === 1 && filtered[0] === 'Quiet Theme' && hasLink(theme, license, 'Fixture Community License')
      && theme.text.includes(kind) && hasLink(theme, source, commit) && theme.fits;
    await record(`plugin-market-author-${lang}-${width}`, { filtered, theme }, themeOkay);
    await click(other);
    await frame();
    const returned = await current() === installed && await evaluate(`!document.querySelector(${target})`);
    const writes = await evaluate('window.marketplaceFixture.installations.slice()');
    await record(`plugin-market-return-${lang}-${width}`, { returned, writes }, returned && writes.length === 0);
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
}
