import assert from 'node:assert/strict';

// Sample every painted frame, not just two identical endpoints after the popup closes.
function watchReading() {
  const body = document.querySelector('.local-agent__body'), input = document.querySelector('.local-agent__composer > textarea');
  const box = body.getBoundingClientRect();
  const line = [...body.querySelectorAll('[data-message-id="overlay:answer"] p')].find(p => {
    const r = p.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom;
  });
  if (!line || body.scrollHeight <= body.clientHeight) throw Error('Expected scrollable, visible conversation text');
  const read = () => ({ body: body.clientHeight, scroll: body.scrollTop, line: line.getBoundingClientRect().top,
    input: input.getBoundingClientRect().top, trigger: document.querySelector('.conversation-change-dock button').getBoundingClientRect().top });
  const before = read(), peak = Object.fromEntries(Object.keys(before).map(k => [k, 0]));
  let frame, frames = 0;
  function sample() {
    for (const [k, value] of Object.entries(read())) peak[k] = Math.max(peak[k], Math.abs(value - before[k]));
    frames++; frame = requestAnimationFrame(sample);
  }
  sample();
  window.endOverlayMeasurement = () => { cancelAnimationFrame(frame); return { before, peak, frames, pane: box.width,
    following: body.hasAttribute('data-following-tail'), sameInput: input.isConnected && line.isConnected }; };
}

export async function checkComposerOverlays({ navigate, evaluate, cmd, until, frame, click, key, record }) {
  const dock = '.conversation-change-dock', trigger = dock + ' .conversation-changes-heading', list = dock + ' .conversation-change-list';
  const input = '.local-agent__composer > textarea', row = list + ' .conversation-change-file';
  const point = selector => evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const hover = async selector => { await cmd('Input.dispatchMouseEvent', {type:'mouseMoved', ...await point(selector)}); await frame(); };
  const visible = selector => `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`;
  const watch = () => evaluate(`(${watchReading.toString()})()`);
  const steady = m => m.frames > 2 && m.sameInput && Object.values(m.peak).every(n => n <= 0.5);
  const open = async mode => {
    await cmd('Emulation.setDeviceMetricsOverride', {width:1200,height:900,deviceScaleFactor:1,mobile:false});
    await navigate('reader-workbench', { changeOverlay: mode });
    await until(`document.querySelector('${trigger}')?.textContent.includes('53') && document.querySelector('[data-message-id="overlay:answer"] p') && document.querySelector('.local-agent__body').scrollTop > 0`);
    await evaluate('document.fonts.ready.then(()=>true)'); await frame();
  };
  for (const mode of ['wide','split']) {
    await open(mode);
    if (mode === 'split') {
      await cmd('Input.dispatchMouseEvent', {type:'mouseWheel', ...await point('.local-agent__body'), deltaY:-350,deltaX:0});
      await until(`!document.querySelector('.local-agent__body').hasAttribute('data-following-tail')`);
      await frame(); await frame();
    }
    await watch(); await hover(trigger); await until(visible(list));
    await hover(row); assert.equal(await evaluate(`document.querySelectorAll('${row}').length`), 3);
    await hover(input); await until(`!(${visible(list)})`);
    await click(trigger); await hover(input); await until(visible(list)); // pinned list survives pointer leave
    await click(list + ' .conversation-change-more'); await until(`document.querySelectorAll('${row} .conversation-diff-counts').length === 53`);
    const fit = await evaluate(`(() => {const r=document.querySelector('${list}').getBoundingClientRect(),pane=document.querySelector('.local-agent__body').getBoundingClientRect();return {inside:r.left>=pane.left-1 && r.right<=pane.right+1,width:r.width,above:r.bottom<=document.querySelector('${trigger}').getBoundingClientRect().top+1};})()`);
    await cmd('Input.dispatchMouseEvent', {type:'mouseWheel', ...await point(list), deltaX:0,deltaY:2500});
    await until(`document.querySelector('${list}').scrollTop>0`);
    const last = row + '[title="src/file-53.ts"]';
    await until(`(() => {const b=document.querySelector('${last}'),r=b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
    const measured = await evaluate('window.endOverlayMeasurement()');
    await record('file-overlay-'+mode, {measured,fit}, steady(measured) && measured.following === (mode === 'wide') && fit.inside && fit.above && (mode !== 'split' || measured.pane < 480));
    if (mode === 'split') {
      await click(last); await until(`document.querySelector('.reader-tab--active')?.textContent.includes('file-53.ts') && document.querySelector('.reader-pane:not([hidden]) .cm-insertedLine')?.textContent.includes('after file-53.ts')`);
    } else {
      await click(input); await until(`!(${visible(list)})`);
      await key('Tab'); await evaluate(`document.querySelector('${trigger}').focus({preventScroll:true})`);
      await key('Enter'); await until(`document.activeElement===document.querySelector('${row}')`);
      await key('Escape'); await until(`!(${visible(list)}) && document.activeElement===document.querySelector('${trigger}')`);
    }
  }

  await open('wide'); await watch();
  const checked = [];
  for (const [name, opener, panel] of [
    ['模型','.achbit-session-model__selector','.achbit-session-model__menu'],
    ['上下文','.achbit-session-model__context','.achbit-session-model__context-popover'],
    ['权限','.local-agent__permission-summary','.local-agent__permission-menu'],
    ['附件','.local-agent__attach','.local-agent__attachment-menu'],
    ['插件','.local-agent__attach','.local-agent__plugin-picker'],
    ['斜杠命令',input,'.local-agent__command-suggestions'],
  ]) {
    await click(opener);
    if (name === '插件') await click('[data-ui-action="composer.controls.plugins"]');
    if (name === '斜杠命令') await cmd('Input.insertText', {text:'/'});
    await until(visible(panel)); await frame();
    const hit = await evaluate(`(() => {const p=document.querySelector('${panel}'),r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
    assert.ok(hit, `${name}: visible popup receives input`); checked.push(name);
    await key('Escape'); await until(`!(${visible(panel)})`);
  }
  const measured = await evaluate('window.endOverlayMeasurement()');
  await record('composer-sibling-overlays', {checked,measured}, steady(measured) && measured.following);

  // Nonempty draft and attachments: overlays stay out of flow, but editing itself still grows the row.
  await navigate('reader-workbench', {changeOverlay:'wide',attachmentCards:'recovered'});
  await until(visible(trigger)); await until(`document.querySelector('${input}')?.value.includes('第二行')`);
  const original = await evaluate(`(() => {const e=document.querySelector('${input}');window.editingNode=e;e.focus();e.setSelectionRange(2,8,'backward');return e.value})()`);
  await frame(); await watch(); await hover(trigger); await until(visible(list)); await hover(input); await until(`!(${visible(list)})`);
  const editing = await evaluate('window.endOverlayMeasurement()');
  assert.ok(await evaluate(`document.activeElement===editingNode && editingNode.selectionStart===2 && editingNode.selectionEnd===8 && editingNode.selectionDirection==='backward'`));
  const height = await evaluate('editingNode.clientHeight');
  await evaluate('editingNode.setSelectionRange(editingNode.value.length,editingNode.value.length)');
  await cmd('Input.insertText',{text:'\n再加一行'.repeat(6)}); await frame(); const grown=await evaluate('editingNode.clientHeight');
  assert.ok(grown>height,`textarea grows: ${height} → ${grown}`);
  await key('a','KeyA',2); await cmd('Input.insertText',{text:original}); await frame();
  assert.equal(await evaluate('editingNode.clientHeight'),height);
  const hits = await evaluate(`Object.fromEntries(['.local-agent__attach','.local-agent__permission-summary','.achbit-session-model__selector','.local-agent__send'].map(s=>{const b=document.querySelector(s),r=b.getBoundingClientRect();return [s,b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))]}))`);
  assert.ok(Object.values(hits).every(Boolean),JSON.stringify(hits));
  await click('.attachment-card__open[aria-label*="任务说明.txt"]');
  const summary='.local-agent__attachment-summary', popup='.local-agent__draft-attachments[data-reader-open]';
  await until(visible(summary)); await until(`document.querySelector('.reader-pane:not([hidden]) .cm-content')`); await frame();
  await watch(); await click(summary); await until(visible(popup)); await key('Escape'); await until(`!(${visible(popup)})`);
  const collapsed=await evaluate('window.endOverlayMeasurement()');
  await click('.local-agent__composer-disclosure'); await click(input); await cmd('Input.insertText',{text:'继续编辑'});
  assert.ok(await evaluate(`document.activeElement===editingNode && editingNode.value.includes('继续编辑') && attachmentFixture.writes.length===0`));
  await record('nonempty-draft-overlays',{editing,collapsed,inputHeight:height,grown,hits},steady(editing)&&steady(collapsed));
}
