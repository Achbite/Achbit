// TCR: T-031-UI_System-20261126/message-send-implementation. Real controls, independently gated facts.
import assert from 'node:assert/strict';

export async function checkSendEcho({ navigate, evaluate, until, frame, click, key, type, record, cmd }) {
  const input = '[data-ui-action="composer.controls.input"]', send = '[data-ui-action="composer.controls.submit"]';
  const body = '.local-agent__body:not([hidden])', local = body + ' [data-local-command]';
  const committed = body + ' article.local-agent__message--user[data-message-id]';
  const queued = '[data-ui-action="composer.queued-input.open"]';
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const count = selector => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  const f = 'window.echoFixture'; const text = '同一句话';
  const open = async scene => { await navigate('send-echo', { scene }); await until(q(input)); await evaluate('document.fonts.ready.then(()=>true)'); };
  const bubbleRect = () => evaluate(`(()=>{const b=window.echoNode.querySelector('.local-agent__message-text').getBoundingClientRect();return [b.x,b.y,b.width,b.height]})()`);
  const submit = async (value, enter = false) => { await type(input, value); if (enter) await key('Enter'); else await click(send); };
  const holdNode = () => evaluate(`void(window.echoNode=${q(local)})`);
  const checkAdopted = async label => {
    await until('window.echoNode?.hasAttribute("data-message-id")');
    const info = await evaluate(`(()=>{const n=window.echoNode,r=n.getBoundingClientRect(),b=n.closest('.local-agent__body').getBoundingClientRect();return {
      same:n.isConnected && n===${q('[data-message-id="server:1"]')},id:n.dataset.messageId,anchor:n.closest('[data-conversation-anchor]')?.dataset.conversationAnchor,
      count:${count(committed)},local:${count(local)},inView:r.bottom>b.top&&r.top<b.bottom}})()`);
    await record(label, info, info.same && info.count===1 && !info.local && info.anchor===info.id && info.inView);
    assert.ok(info.same && info.inView);
  };
  await open('folders');
  const picker = async () => {
    await click('[data-ui-action="composer.controls.attachments"]');
    await click('[data-ui-action="composer.controls.choose-files"]');
    await until('document.querySelector(".ws-open-dialog__entry-action")');
  };
  const box = name => `.ws-open-dialog__entry input[aria-label="${name}"]`;
  const attach = '.ws-open-dialog__btn--primary';
  await picker();
  assert.ok(await evaluate(q(box('source.v2')) + ' !== null'), 'folders must be selectable without entering them');
  await click(box('source.v2')); await click(box('资料 甲'));
  await click(box('source.v2')); await key(' ', 'Space'); // re-add using the focused checkbox
  await click(attach);
  const storedPaths = `JSON.parse(sessionStorage.getItem('achbit:composer:session:folder-picker')).filesystemPaths`;
  const folders = ['资料 甲', 'source.v2'].map(name => ({ path: '/fixture/' + name, kind: 'directory' }));
  assert.deepEqual(await evaluate(storedPaths), folders, 'one confirmation appends both directory references in selection order');
  await picker(); await click(box('资料 甲')); await click(attach);
  assert.deepEqual(await evaluate(storedPaths), folders, 'selecting an attached directory again must not duplicate it');
  await picker(); await click(box('one.bin')); await key('Escape');
  assert.deepEqual(await evaluate(storedPaths), folders, 'cancelling does not change the draft');
  await picker(); await click(box('one.bin')); await click(box('two.bin')); await click(attach);
  const expected = [...folders, ...['one.bin', 'two.bin'].map(name => ({ path: '/fixture/' + name, kind: 'file' }))];
  assert.deepEqual(await evaluate(storedPaths), expected, 'ordinary multi-file selection still works');
  // The desktop adapter test and Rust tests own the OS result. Here drive that result through the real composer.
  const nativePick = async selection => {
    await evaluate(`window.__TAURI__ = {core:{invoke:async (name, {options}) => {
      if (name !== 'achbit_pick_path' || options.kind !== 'path' || !options.multiple) throw Error('wrong attachment dialog');
      return ${JSON.stringify(selection)};
    }}}; window.__ACHBIT_BROWSER_PREVIEW__ = false;`);
    await click('[data-ui-action="composer.controls.attachments"]'); await click('[data-ui-action="composer.controls.choose-files"]');
    await frame();
  };
  const extra = Array.from({length: 4}, (_, i) => ({path: '/fixture/extra-' + i, kind: 'directory'}));
  await nativePick([extra[0], expected[2]]);
  assert.match(await evaluate(q('.local-agent__error-content') + '.textContent'), /分两次选择/);
  assert.deepEqual(await evaluate(storedPaths), expected, 'mixed picker result adds nothing');
  await nativePick(extra);
  expected.push(...extra);
  assert.deepEqual(await evaluate(storedPaths), expected, 'one native result may fill the remaining four slots with directories');
  await nativePick([{path:'/fixture/overflow',kind:'directory'}]);
  assert.match(await evaluate(q('.local-agent__error-content') + '.textContent'), /8/);
  assert.deepEqual(await evaluate(storedPaths), expected, 'ninth reference cannot partially change the draft');
  await nativePick(null);
  assert.deepEqual(await evaluate(storedPaths), expected);
  await evaluate('delete window.__TAURI__;');
  await submit('引用所选目录与文件'); await until(`${f}.command()`);
  const sentRefs = await evaluate(`${f}.command().filesystemReferences.map(({displayName,kind,logicalPath})=>({displayName,kind,logicalPath}))`);
  assert.deepEqual(sentRefs, expected.map(({path, kind}) => ({ displayName: path.split('/').at(-1), kind, logicalPath: kind === 'directory' ? '.' : path.split('/').at(-1) })));
  await record('folder-multiselect-to-message', sentRefs, true);
  await evaluate(`${f}.reply()`);

  const firstText = '请把刚才讨论的修改整理成三点。';
  await open('new'); await submit(firstText);
  await until(q(local)); await holdNode();
  assert.equal(await evaluate(`${f}.selected()`), null);
  assert.equal(await evaluate(`${count(committed)}+${count(local+' button')}`), 0);
  assert.equal(await evaluate(`${q(local)}.innerText.trim()`), firstText);
  await evaluate('document.fonts.ready.then(()=>true)'); await frame();
  const initialBubble = await bubbleRect();
  await record('send-instant-before-session', { text:firstText, rect:initialBubble, committed:0 }, initialBubble[2]>0 && initialBubble[3]>0);
  await evaluate(`${f}.create()`); await until(`${f}.command()`);
  assert.ok(await evaluate(`window.echoNode===${q(local)}`), 'first Session adopts the draft body without replacing the article');
  await evaluate(`${f}.holdRead();${f}.commit();${f}.reply()`); await frame();
  assert.ok(await evaluate(`window.echoNode===${q(local)} && !${q('.local-agent__submission')}`));
  await evaluate(`${f}.releaseRead()`); await checkAdopted('send-new-receipt-first');
  const finalBubble = await bubbleRect();
  assert.ok(finalBubble.every((v,i)=>Math.abs(v-initialBubble[i])<=1), 'bubble stays in place: '+JSON.stringify({initialBubble,finalBubble}));

  await open('idle'); await submit(text, true); await until(`${f}.command()`); await holdNode();
  await evaluate(`${f}.foreign();${f}.refresh()`); await until(`${count(committed)}===2`);
  assert.ok(await evaluate(`window.echoNode===${q(local)}`), 'an identical remote message cannot adopt this draft');
  await evaluate(`${f}.commit();${f}.refresh()`); await until(`${count(committed)}===3`);
  const early = await evaluate(`({same:window.echoNode===${q('[data-message-id="server:3"]')},local:${count(local)},ids:[...document.querySelectorAll('${committed}')].map(n=>n.dataset.messageId)})`);
  await evaluate(`${f}.reply()`); await frame();
  await record('send-same-text-projection-first', early, early.same && !early.local && new Set(early.ids).size===3);

  await open('queue'); const supplement='补充第一行\n第二行\n';
  for (let n=1;n<=2;n++) {
    await submit(supplement); await until(`${f}.command()`);
    assert.equal(await evaluate(count(local)),0); assert.equal(await evaluate(count(queued)),n-1);
    await evaluate(`${f}.commit();${f}.reply()`); await until(`${count(queued)}===${n}`);
  }
  assert.equal(await evaluate(count(committed)),1);
  await click(queued); assert.equal(await evaluate(`${q('dialog[open] pre')}.textContent`),supplement); await key('Escape');
  await evaluate(`${f}.consume()`); await until(`${count(queued)}===1`); await evaluate(`${f}.consume()`);
  const queue = await evaluate(`({ids:[...document.querySelectorAll('${committed}')].map(n=>n.dataset.messageId),labels:${count('.local-agent__queued-input > strong')},left:${count(queued)}})`);
  await record('send-queue-fifo',queue, JSON.stringify(queue.ids)===JSON.stringify(['server:1','queued:2','queued:3'])&&!queue.labels&&!queue.left);

  await open('failure'); await submit('保留我的原文'); await until(`${f}.command()`); await type(input,'不要覆盖的新草稿');
  await evaluate(`${f}.reply(true)`); await until(q('.local-agent__failed-draft'));
  const failure=await evaluate(`({draft:${q(input)}.value,original:${q('.local-agent__failed-draft pre')}.textContent,local:${count(local)},committed:${count(committed)}})`);
  await record('send-rejection-preserves-new-draft',failure,failure.draft==='不要覆盖的新草稿'&&failure.original==='保留我的原文'&&!failure.local&&failure.committed===1);

  await open('switch'); await submit('只属于原会话'); await until(`${f}.command()`);
  const other = '[data-ui-action="navigation.sidebar.open-session"][data-ui-target*=other]';
  assert.equal(await evaluate(`${q(other)}.disabled`),true,'ordinary selection stays locked during transport');
  await evaluate(`${f}.openOther()`); await until(`${f}.selected()==='session:other'`);
  await evaluate(`${f}.commit();${f}.reply()`); await frame();
  const switched = await evaluate(`({local:${count(local)},committed:${count(committed)},draft:${q(input)}.value})`);
  await record('send-late-reply-isolated',switched,!switched.local&&!switched.committed&&!switched.draft);

  await open('switch-after-accept'); await submit('后台刷新不能带走新会话'); await until(`${f}.command()`);
  await evaluate(`${f}.holdRead();${f}.commit();${f}.reply()`); await until(`!${q(other)}.disabled`);
  await click(other); await until(`${f}.selected()==='session:other'`); await evaluate(`${f}.releaseRead()`); await frame();
  assert.equal(await evaluate(`${count(local)}+${count(committed)}`),0,'late projection remains in the originating Session');

  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:760,deviceScaleFactor:1,mobile:false});
  try { await open('narrow');
    if (!await evaluate(`!!${q('.achbit-gui-workbench--navigation-collapsed')}`)) await click('[data-ui-action="navigation.sidebar.collapse"]');
    await submit('窄窗也能看到原文'); await until(q(local));
    const bounds=await evaluate(`(()=>{const r=${q(local)}.getBoundingClientRect(),b=${q(body)}.getBoundingClientRect();return {visible:r.bottom>b.top&&r.top<b.bottom,overflow:document.documentElement.scrollWidth-innerWidth,within:r.left>=0&&r.right<=innerWidth+1}})()`);
    await record('send-narrow-transcript',bounds,bounds.visible&&bounds.within&&bounds.overflow===0);
  } finally {await cmd('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});}
}
