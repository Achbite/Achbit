// Check the actual link target and viewport, not just identical link labels.
export async function checkMarkdownNavigation({ navigate, evaluate, until, click, record }) {
  await navigate('messages', { 'markdown-notes': '1' });
  const second = '[data-message-id="message:3"]';
  const citation = second + ' sup:nth-of-type(2) a[data-footnote-ref]';
  // The long message can finish parsing one frame before its viewport follows the tail.
  // Send one real click only after the intended citation is actually under its coordinates.
  await until(`(() => { const a=document.querySelector('${citation}');
    if (!a?.closest('.conversation-markdown[aria-busy="false"]')) return false;
    const r=a.getBoundingClientRect();return a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`);
  await click(citation);
  const forward = await evaluate(`(() => {const target=document.querySelector(':target'); return {owner:target?.closest('[data-message-id]')?.dataset.messageId,text:target?.textContent};})()`);
  await click(second + ' a[data-footnote-backref]:last-child');
  const back = await evaluate(`document.querySelector(':target') === document.querySelector('${citation}')`);
  const labels = await evaluate(`(() => {const items=[...document.querySelectorAll('${second} li')].slice(0,3);return items.map(n=>[...n.querySelectorAll('strong')].map(s=>s.textContent));})()`);
  await record('markdown-message-local-footnotes', {forward,back,labels}, forward.owner==='message:3' && forward.text?.includes('第二条') && back &&
    JSON.stringify(labels)===JSON.stringify([['字体与对比度：'],['阴影与层级：'],['按钮与容器：','实际窗格宽度']]));

  await navigate('messages', { mode: 'question', 'markdown-option': '1' });
  const option = '.local-agent__question-choice[data-ui-target*="desktop"]';
  await until(`document.querySelector('${option}')`);
  const compact = await evaluate(`(() => {const b=document.querySelector('${option}');return {text:b.querySelector('.local-agent__question-description').innerText,nested:b.querySelectorAll('button,a,img').length};})()`);
  await click(option);
  await until(`document.querySelector('.fixture-result').textContent.includes('question:preview')`);
  const answer = await evaluate(`JSON.parse(document.querySelector('.fixture-result').textContent)`);
  await record('markdown-question-visible-option-and-id', {compact,answer}, /第一段\s+第二段含 图示说明 结束。/.test(compact.text) && !compact.nested && answer.response==='desktop');

  await navigate('reader-workbench');
  await until(`document.querySelector('.reader-pane:not([hidden]) .document-preview__markdown h1')?.textContent.includes('Agent.md')`);
  const doc='.reader-pane:not([hidden]) .document-preview__markdown', source=doc+' sup:nth-of-type(2) a[data-footnote-ref]';
  const isVisible = selector => evaluate(`(() => {
    const n = document.querySelector(${JSON.stringify(selector)}), r = n.getBoundingClientRect();
    const pane = n.closest('.local-agent__resource-body').getBoundingClientRect();
    const toolbar = n.closest('.document-preview').querySelector('.document-preview__file-toolbar').getBoundingClientRect();
    return r.bottom <= Math.min(pane.bottom, innerHeight) + 1 && r.top >= Math.max(pane.top, toolbar.bottom) - 1 &&
      n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })()`);
  const sizes=[];
  for (const folder of ['notes','other']) {
    await evaluate(`window.readerWorkbench.openDocument('${folder}/illustrated.md')`);
    await until(`document.querySelector('${doc} [data-reading-image="ready"] img')?.naturalWidth===${folder==='notes'?120:200}`);
    sizes.push(await evaluate(`document.querySelector('${doc} img').naturalWidth`));
  }
  const target=doc+' li[data-footnote-anchor]';
  await click(source); const definitionVisible=await isVisible(target);
  await click(doc+' a[data-footnote-backref]:last-child'); const citationVisible=await isVisible(source);
  const focused=await evaluate(`document.activeElement === document.querySelector('${source}')`);
  const reads=await evaluate('window.readerWorkbench.imageReads');
  await record('markdown-reader-sibling-images-and-return', {sizes,reads,definitionVisible,citationVisible,focused},
    sizes.join()==='120,200' && ['notes/fig one.svg','other/fig one.svg'].every(p=>reads.includes(p)) && definitionVisible && citationVisible && focused);
}
