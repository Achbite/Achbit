// Exercise the separately built desktop document. Only the two shell actions are substituted.
export async function checkCompletionWindow({ navigateEntry, evaluate, cmd, click, until, key, record }) {
  const { identifier } = await cmd('Page.addScriptToEvaluateOnNewDocument', {source: `window.reminderCalls=[];window.__TAURI__={core:{invoke:async(command,args)=>{window.reminderCalls.push([command,args]);if(window.failOpen&&command==='achbit_open_completion')throw Error('fixture_open_failed')}}};`});
  try {
    await cmd('Emulation.setDeviceMetricsOverride', { width:360, height:116, deviceScaleFactor:1, mobile:false });
    for (const dark of [false,true]) {
      const subject=dark?'Review the shared frontend design guidelines and all settings pages':'整理前端构建与界面规范';
      const session='session:design-review-7f1a';
      const params={ session, body:subject, title:dark?'Task completed':'任务已完成', open:dark?'Open conversation':'查看会话', dismiss:dark?'Dismiss':'关闭提醒', appearance:JSON.stringify({dark,language:dark?'en-US':'zh-CN',scale:dark?18/14:1}) };
      await navigateEntry('/built-reminder/completion.html', params);
      await until('document.querySelector("#open")');
      const visual=await evaluate(`(()=>{const open=document.querySelector('#open'),close=document.querySelector('#dismiss'),r=close.getBoundingClientRect();return {theme:document.documentElement.dataset.theme,lang:document.documentElement.lang,subject:document.querySelector('#body').textContent,identity:document.querySelector('#id').title,openedWithFocus:document.activeElement===open||document.activeElement===close,initialCalls:window.reminderCalls.length,size:[r.width,r.height],fits:r.right<=innerWidth&&r.bottom<=innerHeight&&document.documentElement.scrollWidth===innerWidth&&document.documentElement.scrollHeight<=innerHeight+1,contextColor:getComputedStyle(document.querySelector('.reminder-context')).color,background:getComputedStyle(document.body).backgroundColor}})()`);
      await key('Tab'); const focus=await evaluate('document.activeElement.id'); await key('Enter');
      await key('Escape'); await click('#dismiss'); const calls=await evaluate('window.reminderCalls');
      await evaluate('document.activeElement.blur()'); await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
      await record('completion-window-'+(dark?'dark':'light'),{...visual,focus,calls},visual.theme===(dark?'dark':'light')&&visual.lang===(dark?'en-US':'zh-CN')&&visual.fits&&visual.size.every(n=>n>=24)&&!visual.openedWithFocus&&!visual.initialCalls&&visual.subject===subject&&visual.identity===session&&focus==='open'&&calls.length===3&&calls[0][0]==='achbit_open_completion'&&calls[0][1].sessionId===session&&calls[1][0]==='achbit_dismiss_completion'&&calls[2][0]==='achbit_dismiss_completion');
      await evaluate('window.failOpen=true'); await click('#open'); await until('document.querySelector("#error").textContent.includes("fixture_open_failed")');
    }
  } finally { await cmd('Page.removeScriptToEvaluateOnNewDocument',{identifier}); }
}

// Cross the production settings navigation and measure the active pane, not the window width.
export async function checkSettingsPages({ navigate, evaluate, cmd, click, until, frame, record }) {
  const pages = ['general', 'gui', 'agent', 'environment', 'permissions', 'llm', 'plugins', 'about'];
  for (const [mode, viewport, language, font] of [['light',1120,'zh-CN','normal'], ['dark',620,'en-US','large']]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: viewport, height: 780, deviceScaleFactor: 1, mobile: false });
    await navigate('settings-layout', { fullSettings: '1', theme: mode, lang: language, font });
    for (const [index, page] of pages.entries()) {
      const nav = `.settings-nav-group > button:nth-of-type(${index + 1})`;
      await click(nav);
      await until(`document.querySelector('#setting-page-${page}:not([hidden]) h2')`);
      if (page === 'llm') await until(`document.querySelector('#setting-page-llm .model-connection-open')`);
      if (page === 'plugins') await until(`document.querySelector('#setting-page-plugins .plugin-manager__summary')`);
      await frame();
      const actual = await evaluate(`(()=>{const page=document.querySelector('#setting-page-${page}'), body=page.closest('.settings-body'), r=body.getBoundingClientRect();const all=[...page.querySelectorAll('button,input:not([hidden]),select,textarea,a[href],summary')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0);return {title:page.querySelector('h2').innerText, headingSize:getComputedStyle(page.querySelector('h2')).fontSize, navSelected:document.querySelector('${nav}').getAttribute('aria-current'), visiblePages:document.querySelectorAll('.settings-page:not([hidden])').length, bodyWidth:body.clientWidth, overflow:body.scrollWidth-body.clientWidth, navOverflow:document.querySelector('.settings-nav').scrollWidth-document.querySelector('.settings-nav').clientWidth, actions:all.length, outside:all.filter(e=>{const q=e.getBoundingClientRect();return q.left<r.left-1||q.right>r.right+1}).map(e=>e.getAttribute('aria-label')||e.textContent.slice(0,40)), alerts:[...page.querySelectorAll('[role=alert]')].map(e=>e.innerText.trim()).filter(Boolean)};})()`);
      // The current page uses a shaded row, not an accent strip. Check the painted
      // pixels just inside the left edge against the same row's empty right inset.
      if (page === 'permissions') {
        const box = await evaluate(`(() => {const r=document.querySelector('${nav}').getBoundingClientRect();return {x:Math.ceil(r.left),y:Math.floor(r.top+r.height/2),width:Math.floor(r.width)-1,height:1,scale:1}})()`);
        const {data} = await cmd('Page.captureScreenshot',{format:'png',clip:box});
        actual.uniformSelection = await evaluate(`(async()=>{const img=new Image();img.src='data:image/png;base64,${data}';await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const pixel=x=>ctx.getImageData(x,0,1,1).data.join(',');const selected=document.querySelector('${nav}'),other=document.querySelector('.settings-nav-item:not([aria-current])');return pixel(2)===pixel(img.width-6) && getComputedStyle(selected).backgroundColor!==getComputedStyle(other).backgroundColor})()`);
      }
      await record(`settings-${page}-${mode}`,actual,actual.uniformSelection!==false && !!actual.title && actual.navSelected==='page' && actual.visiblePages===1 && actual.actions>0 && actual.overflow<=1 && actual.navOverflow<=1 && !actual.outside.length && !actual.alerts.length);
    }
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width:1200, height:900, deviceScaleFactor:1, mobile:false });
}
