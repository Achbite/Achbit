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
export async function checkSettingsPages(controls) {
  const { navigate, evaluate, cmd, click, until, frame, record } = controls;
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
      const choices = {gui: '.settings-theme-card', plugins: '.plugin-manager__nav button'}[page];
      if (choices) actual.sameSelection = await evaluate(`(async()=>{const a=document.querySelector('${choices}[aria-pressed=true]'),b=document.querySelector('${nav}');
        await Promise.all([a,b].flatMap(el=>el.getAnimations().map(t=>t.finished)));return getComputedStyle(a).backgroundColor===getComputedStyle(b).backgroundColor})()`);
      await record(`settings-${page}-${mode}`,actual,actual.sameSelection!==false && actual.uniformSelection!==false && !!actual.title && actual.navSelected==='page' && actual.visiblePages===1 && actual.actions>0 && actual.overflow<=1 && actual.navOverflow<=1 && !actual.outside.length && !actual.alerts.length);
      if (page === 'llm') await checkModelSourceSelection(controls, mode, nav);
    }
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width:1200, height:900, deviceScaleFactor:1, mobile:false });
}

async function checkModelSourceSelection({ evaluate, cmd, click, key, until, frame, record }, mode, nav) {
  const catalog = '[data-ui-action="settings.model-picker.catalog"]', custom = '[data-ui-action="settings.model-picker.custom"]';
  const option = '.model-picker-list [role=option]', reduced = {name:'prefers-reduced-motion',value:'reduce'};
  await cmd('Emulation.setEmulatedMedia', {features:[reduced]});
  try {
    await click('#setting-page-llm .model-connection-open'); await until('document.querySelector(".model-heading.model-divider button")');
    await click('.model-heading.model-divider button'); await until(`document.querySelectorAll('${option}').length===2`);
    // Sample empty insets on the actual painted control. A bottom or side accent fails even when the computed fill matches.
    const surface = async (selected, other) => {
      const state = await evaluate(`(() => {const el=document.querySelector('${selected}'), s=getComputedStyle(el), r=el.getBoundingClientRect();
        return {selected:el.getAttribute('aria-pressed'),other:document.querySelector('${other}').getAttribute('aria-pressed'),
          fill:s.backgroundColor,otherFill:getComputedStyle(document.querySelector('${other}')).backgroundColor,navFill:getComputedStyle(document.querySelector('${nav}')).backgroundColor,
          radius:parseFloat(s.borderRadius),padding:[parseFloat(s.paddingLeft),parseFloat(s.paddingRight)],
          clip:{x:Math.ceil(r.left),y:Math.ceil(r.top),width:Math.floor(r.right)-Math.ceil(r.left),height:Math.floor(r.bottom)-Math.ceil(r.top),scale:1}}})()`);
      const {data} = await cmd('Page.captureScreenshot',{format:'png',clip:state.clip});
      state.flat = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${data}';await image.decode();
        const c=document.createElement('canvas'), w=c.width=image.width,h=c.height=image.height,ctx=c.getContext('2d');ctx.drawImage(image,0,0);
        const painted=ctx.getImageData(0,0,w,h).data;
        ctx.fillStyle=${JSON.stringify(state.fill)};ctx.fillRect(0,0,1,1);const expected=ctx.getImageData(0,0,1,1).data;
        const matches=(x,y)=>expected.every((v,i)=>painted[(y*w+x)*4+i]===v), inset=Math.ceil(${state.radius})+1;
        // Check the straight portions of all four painted edges, excluding only their rounded corners.
        for(let x=inset;x<w-inset;x++) if(![0,1,h-2,h-1].every(y=>matches(x,y)))return false;
        for(let y=inset;y<h-inset;y++) if(![0,1,2,w-3,w-2,w-1].every(x=>matches(x,y)))return false;
        // Probe inside the padding, not at its boundary where the keyboard underline ends.
        return [Math.floor(${state.padding[0]}/2),w-1-Math.floor(${state.padding[1]}/2)].every(x=>matches(x,h-3))})()`);
      return state;
    };
    const correct = s => s.selected==='true' && s.other==='false' && s.fill!==s.otherFill && s.fill===s.navFill && s.flat;
    await click(catalog); const initial = await surface(catalog, custom); // includes the selected-hover state
    await click(option); await key('End');
    const row = await evaluate(`(()=>{const el=document.querySelector('${option}[aria-selected=true]');return {name:el.querySelector('code').textContent,
      focused:document.activeElement===el,checked:getComputedStyle(el.querySelector('.model-picker-candidate__check')).visibility==='visible',
      fill:getComputedStyle(el).backgroundColor}})()`);
    await record('model-source-catalog-'+mode,{initial,row},correct(initial) && row.focused && row.checked && row.fill===initial.fill && row.name==='reference-large');
    await click(catalog); await key('Tab'); await key('Enter');
    const switched = await surface(custom,catalog), keyboard = await evaluate(`document.activeElement===document.querySelector('${custom}') && document.activeElement.matches(':focus-visible') && !!document.querySelector('.model-picker-body.model-services:not([hidden])')`);
    await record('model-source-custom-'+mode,{switched,keyboard},correct(switched) && keyboard);
    if (mode==='light') {
      await cmd('Emulation.setEmulatedMedia',{features:[reduced,{name:'forced-colors',value:'active'}]}); await frame();
      const contrast = await evaluate(`(()=>{const el=document.querySelector('${custom}'),s=getComputedStyle(el),other=getComputedStyle(document.querySelector('${catalog}'));
        return {active:matchMedia('(forced-colors:active)').matches,fill:s.backgroundColor,otherFill:other.backgroundColor,ink:s.color,navFill:getComputedStyle(document.querySelector('${nav}')).backgroundColor,focus:s.outlineStyle,width:s.outlineWidth}})()`);
      await record('model-source-forced-colors',contrast,contrast.active && contrast.fill===contrast.navFill && contrast.fill!==contrast.otherFill && contrast.ink!==contrast.fill && contrast.focus!=='none' && parseFloat(contrast.width)>0);
    } else {
      await cmd('Emulation.setDeviceMetricsOverride',{width:320,height:780,deviceScaleFactor:1,mobile:false}); await frame();
      const narrow=await evaluate(`(() => {const group=document.querySelector('.model-picker-tabs'),box=group.getBoundingClientRect();
        return [...group.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {label:b.innerText,
          inside:r.left>=box.left && r.right<=Math.min(box.right,innerWidth),hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});})()`);
      await record('model-source-narrow-large-type',narrow,narrow.length===2 && narrow.every(b=>b.inside && b.hit));
      await cmd('Emulation.setDeviceMetricsOverride',{width:620,height:780,deviceScaleFactor:1,mobile:false}); await frame();
    }
    await key('Escape'); await until('!document.querySelector(".model-picker-backdrop[open]")');
  } finally { await cmd('Emulation.setEmulatedMedia',{features:[]}); }
}
