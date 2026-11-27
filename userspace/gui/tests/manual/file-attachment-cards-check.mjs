import assert from 'node:assert/strict';

// Real file/image/HTML/PDF views, with only filesystem/OS operations replaced by an isolated Host.
export async function checkFileAttachmentCards({ navigate, evaluate, cmd, until, frame, frameContent, click, key, record }) {
  const input = '.local-agent__composer > textarea', pane = '.reader-pane:not([hidden])', closeReader = '[data-ui-action="reader.controls.toggle"]';
  const folder='Achbit', text='任务说明.txt', html='阅读样例.HTM', pdf='两页.PDF', picture='示意.svg';
  const card = name => `.attachment-card__open[aria-label*="${name} ·"]`, dialog = 'dialog[open][data-lightbox]';
  const untilVisible = sel => until(`document.querySelector(${JSON.stringify(sel)})?.getClientRects().length`);
  const visible = sel => evaluate(`!!document.querySelector(${JSON.stringify(sel)})?.getClientRects().length`);
  const texts = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent`);
  const pref = value => evaluate(`window.attachmentFixture.preference('${value}')`);
  const hit = async selector => {
    await untilVisible(selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`); await frame();
    const seen = await evaluate(`(() => {const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
    assert.ok(seen, 'real pointer hits '+selector); await click(selector);
  };
  const selection = () => evaluate(`(() => {const e=document.querySelector('${input}');return [e===window.testDraft,e.value,e.selectionStart,e.selectionEnd,e.selectionDirection]})()`);
  await cmd('Emulation.setDeviceMetricsOverride',{width:1350,height:900,deviceScaleFactor:1,mobile:false});
  for (const mode of ['draft','recovered','sent']) {
    await navigate('reader-workbench', { attachmentCards:mode, ...(mode === 'recovered' && {changeOverlay:'wide'}) });
    await untilVisible(card(folder));
    const owner = mode === 'draft' ? '/fixture/所选项目/' : '/retained/';
    await evaluate(`window.testDraft=document.querySelector('${input}');window.testDraft.focus();window.testDraft.setSelectionRange(2,8,'backward');true`);
    const original = await selection(); assert.equal(original[2],2); assert.equal(original[3],8);
    const showRail = async () => {const summary='.local-agent__attachment-summary';if(await visible(summary) && !await visible(card(folder))) await hit(summary);};
    const editor = await evaluate('window.readerWorkbench.opened.length'), folders = await evaluate('window.readerWorkbench.folders.length');
    for (const setting of ['reader','vscode']) {
      await pref(setting); await hit(card(folder)); await until(`window.readerWorkbench.folders.at(-1)===${JSON.stringify(owner+folder)}`);
      const img = mode === 'sent' ? '.local-agent__message-image' : '.local-agent__image-attachment .conversation-image-review__open';
      await evaluate(`document.querySelector('${img}').scrollIntoView({inline:'nearest',block:'nearest'})`); await until(`document.querySelector('${img} img')?.naturalWidth===120`);
      await hit(img); await untilVisible(dialog+' .conversation-image-review__canvas img');
      const box = await evaluate(`(() => {const r=document.querySelector('${dialog}').getBoundingClientRect();return [r.width,r.height,innerWidth,innerHeight]})()`);
      assert.deepEqual(box.slice(0,2),box.slice(2));
      const zoom = dialog+' output', before = await texts(zoom); await key('+'); assert.notEqual(await texts(zoom),before); await key('0');
      if (mode==='draft' && setting==='reader') {
        await hit(dialog+' button[aria-busy]'); await until('attachmentFixture.savedImages.at(-1)===true');
        await hit(dialog+' .conversation-image-review__zoom button:nth-of-type(2)'); assert.notEqual(await texts(zoom),before);
        const closePosition = () => evaluate(`(() => {
          const el=document.querySelector('${dialog} .conversation-image-review__close'), bar=el.closest('.conversation-image-review__toolbar');
          const r=el.getBoundingClientRect(), b=bar.getBoundingClientRect(), save=bar.querySelector('button[aria-busy]').getBoundingClientRect();
          return {width:innerWidth, rightGap:b.right-r.right, sameRow:r.top<save.bottom && r.bottom>save.top, afterSave:r.left>=save.right,
            hittable:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
        })()`);
        const atRight = p => Math.abs(p.rightGap)<=1 && p.sameRow && p.afterSave && p.hittable;
        const wide = await closePosition();
        await record('in-place-image-lightbox',{bounds:box,savedOriginal:true,close:wide},atRight(wide));
        await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:720,deviceScaleFactor:1,mobile:false}); await frame();
        const narrow = await closePosition();
        await record('image-lightbox-narrow-close',{close:narrow},atRight(narrow));
        await hit(dialog+' .conversation-image-review__close');
        await cmd('Emulation.setDeviceMetricsOverride',{width:1350,height:900,deviceScaleFactor:1,mobile:false}); await frame();
      } else await key('Escape');
      assert.equal(await visible(dialog),false); assert.equal(await visible('.local-agent__reader'),false);
    }
    assert.deepEqual(await evaluate('window.readerWorkbench.folders.slice('+folders+')'), [owner+folder,owner+folder]);
    assert.equal(await evaluate('window.readerWorkbench.opened.length'),editor,'folder and image never launch VS Code');
    for (const file of [text,html,pdf]) { await hit(card(file)); await until(`window.readerWorkbench.opened.at(-1)===${JSON.stringify(owner+file)}`); }
    assert.deepEqual(await evaluate('window.readerWorkbench.opened.slice('+editor+')'),[text,html,pdf].map(n=>owner+n));
    assert.equal(await visible('.local-agent__reader'),false,'VS Code must not also open a tab');
    await pref('reader');
    // A thumbnail may be outside the horizontally scrolling attachment rail.
    for (const [name,state] of [[text,'text'],[html,'text'],[pdf,'page'],['损坏.pdf','error'],['不可读.bin','error'],['较大.txt','large']]) {
      const b = card(name); await evaluate(`document.querySelector('${b}').scrollIntoView({block:'nearest',inline:'nearest'})`);
      try { await until(`document.querySelector('${b}').parentElement.dataset.previewState==='${state}'`); }
      catch (error) { throw new Error(`${mode}/${name}: `+await evaluate(`document.querySelector('${b}').title`), {cause:error}); }
    }
    const pageFits=await evaluate(`(() => {const b=document.querySelector('${card(pdf)}'), p=b.querySelector('.attachment-card__page').getBoundingClientRect(), label=b.querySelector('.attachment-card__caption').getBoundingClientRect();return p.height>0 && p.bottom<=label.top+0.5})()`);
    assert.ok(pageFits,'PDF raster stays above the filename');
    assert.ok(!(await texts(card(html))).includes('unexpected')); assert.match(await texts(card(html)),/只读 HTML 正例/);
    await record('attachment-cards-'+mode,{mode,folder:owner+folder,vscode:[text,html,pdf],thumbnails:['text','inert HTML','PDF first page','decode/size error'],lightbox:true},true);
    await hit(card(text)); await until(`document.querySelector('${pane} .cm-content')?.textContent.includes('保留输入区原文')`);
    await showRail(); await hit(card(html)); await untilVisible(pane+' iframe[sandbox=""]');
    const markup = await evaluate(`document.querySelector('${pane} iframe').srcdoc`); assert.match(markup,/<h1>只读 HTML 正例<\/h1>/);
    // The iframe swaps processes when its sandboxed srcdoc commits. Re-observe the
    // exact attached node after that swap; never replay the click or relax the content assertion.
    const deadline=Date.now()+6000; let actual, problem;
    do {
      try { actual=await frameContent(pane+' iframe', '[document.querySelector("h1")?.innerText,document.body?.dataset.ran??null]'); }
      catch (error) { problem=error; }
      if (!actual?.[0]) await frame();
    } while (!actual?.[0] && Date.now()<deadline);
    if (!actual?.[0] && problem) throw problem;
    assert.deepEqual(actual,['只读 HTML 正例',null]);
    await showRail(); await hit(card(pdf));
    const pageNo = pane+' .document-pdf__controls input', canvas = pane+' .pdfViewer .page[data-page-number="1"] canvas';
    await until(`document.querySelector('${pageNo}')?.max==='2' && document.querySelector('${canvas}')?.width>10`);
    const color = number => `(() => {const c=document.querySelector('${pane} .page[data-page-number="${number}"] canvas'); if(!c?.width)return null;const a=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return Array.from(a)})()`;
    await until(`(v=>v && v[0]>v[2]+40)(${color(1)})`);
    const first = await evaluate(color(1)); await hit(pane+' .document-pdf__controls button:nth-of-type(2)');
    await until(`document.querySelector('${pageNo}').value==='2' && (v=>v && v[2]>v[0]+40)(${color(2)})`);
    await record('attachment-document-'+mode,{html:actual,pages:2,first,second:await evaluate(color(2)),session:await evaluate('attachmentFixture.session()')},true);
    await showRail(); await hit(card('损坏.pdf')); await untilVisible(pane+' [role=alert]'); assert.ok((await texts(pane+' [role=alert]')).trim());
    await hit(closeReader); await until(`!document.querySelector('.local-agent__reader').getClientRects().length`);
    assert.deepEqual(await selection(),original, 'selection, direction, mounted textarea and draft survive opening/closing: '+mode);
    assert.deepEqual(await evaluate('attachmentFixture.writes'),[]);
    if (mode==='draft') assert.equal(await evaluate('attachmentFixture.session()'),null);
    if (mode!=='sent') {
      const remove = card(text)+' + .attachment-card__remove';
      await evaluate(`document.querySelector('${card(text)}').focus()`); await key('Tab');
      assert.ok(await evaluate(`document.activeElement.matches('${remove}')`)); await key('Enter'); await until(`!document.querySelector('${card(text)}')`);
      assert.equal(await evaluate('attachmentFixture.draft().draft'),original[1]);
    }
  }
}
