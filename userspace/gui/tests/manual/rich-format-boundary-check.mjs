// Real built-in renderer inside a narrow pane of a desktop viewport, not a CSS rule check.
export async function checkRichFormatBoundaries({ navigate, evaluate, cmd, until, frame, record }) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await navigate('content-image-export', { boundaries: '1' });
  await until('document.querySelector("#rich-boundary .katex annotation") && document.querySelector("#rich-boundary tbody td")');
  await evaluate('document.fonts.ready.then(() => true)'); await frame();
  const math = await evaluate(`(() => {
    const pane = document.querySelector('#rich-boundary .local-agent__body'), equation = pane.querySelector('.katex');
    let scroller = equation.querySelector('.katex-html');
    while (scroller && scroller.closest('.conversation-markdown') && !(scroller.scrollWidth > scroller.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowX))) scroller = scroller.parentElement;
    if (scroller?.closest('.conversation-markdown')) scroller.scrollLeft = scroller.scrollWidth;
    return { pane: pane.clientWidth, extent: pane.scrollWidth, local: scroller?.closest('.conversation-markdown') ? scroller.scrollLeft : 0,
      source: equation.querySelector('annotation').textContent.length, trailing: pane.querySelector('strong').textContent === 'END' };
  })()`);
  const point = await evaluate(`(() => {
    const row = document.querySelector('#rich-boundary tbody tr'); row.scrollIntoView({block:'center'});
    const b = row.cells[0].getBoundingClientRect(), v = row.closest('.conversation-table-scroll');
    return { x:v.getBoundingClientRect().left+v.clientWidth/2, y:b.top+12, deltaX:v.scrollWidth+1 };
  })()`);
  await cmd('Input.dispatchMouseEvent', { type:'mouseWheel', ...point, deltaY:0 });
  await until('document.querySelector("#rich-boundary .conversation-table-scroll").scrollLeft > 0'); await frame();
  const table = await evaluate(`(() => {
    const v = document.querySelector('#rich-boundary .conversation-table-scroll'), row = v.querySelector('tbody tr'), last = row.cells[row.cells.length-1];
    const b = last.getBoundingClientRect(), button = document.querySelector('#rich-boundary footer button'), n = button.getBoundingClientRect();
    return { columns:row.cells.length, end:Math.abs(v.scrollLeft+v.clientWidth-v.scrollWidth)<=2,
      lastHit:last.contains(document.elementFromPoint(b.left+b.width/2,b.top+12)), lastValue:last.textContent==='LAST',
      neighborHit:button.contains(document.elementFromPoint(n.left+n.width/2,n.top+n.height/2)) };
  })()`);
  await record('rich-content-narrow-pane-boundaries', { math, table }, math.extent<=math.pane+1 && math.local>0 && math.source>400 && math.trailing && table.columns===6 && table.end && table.lastHit && table.lastValue && table.neighborHit);
}
