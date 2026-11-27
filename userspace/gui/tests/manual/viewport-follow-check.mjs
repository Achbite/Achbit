// TCR: T-033-Conversation_Opening-20261126. Read the actual scroll container, not just the arrow.
export async function checkViewportFollow({ navigate, evaluate, cmd, until, click, record }) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate('viewport');
  const state = `(()=>{ const body=document.querySelector('.local-agent__body'), r=body.getBoundingClientRect();
    return {range:body.scrollHeight-body.clientHeight, top:body.scrollTop, gap:body.scrollHeight-body.clientHeight-body.scrollTop,
      following:document.querySelector('.fixture-main').dataset.following==='true', arrow:!!document.querySelector('.local-agent__jump-latest'),
      x:r.left+r.width*.8, y:r.top+r.height*.65}; })()`;
  const atTail = `s.following && !s.arrow && Math.abs(s.gap)<=2`;
  const wait = condition => until(`(s=>${condition})(${state})`);
  const wheel = async deltaY => {
    const {x,y} = await evaluate(state);
    await cmd('Input.dispatchMouseEvent', {type:'mouseWheel',x,y,deltaX:0,deltaY});
  };
  const button = n => `.fixture-toolbar button:nth-of-type(${n})`;
  await wait(`s.range>200 && ${atTail}`);
  const initial = await evaluate(state);
  await click(button(5)); // reduce the viewport using its own fixture control
  await wait(`s.range>${initial.range+150} && ${atTail}`);
  await wheel(-120); await wait('!s.following && s.arrow && s.gap>40');
  const history = await evaluate(state);
  await click(button(1)); // new output below a reader in history
  await wait(`!s.following && s.arrow && s.range>${history.range+40} && Math.abs(s.top-${history.top})<=3`);
  await wheel(10000); await wait(atTail);
  const reached = await evaluate(state);
  await wheel(-100); await wait('!s.following && s.arrow && s.gap>40 && s.gap<180');
  await click(button(5)); // enlarge the pane; browser clamps to the end of a *still scrollable* transcript
  await wait(`s.range>0 && ${atTail}`);
  const clamped = await evaluate(state);
  await click(button(1)); await wait(`s.range>${clamped.range+50} && ${atTail}`);
  const growth = await evaluate(state);
  await record('viewport-bottom-without-reverse-gesture', {initial,history,reached,clamped,growth}, true);
  await click(button(3)); // all transcript content fits on screen
  await wait(`s.range<=2 && ${atTail}`);
  const summary='[data-conversation-anchor="tools"] .local-agent__tool-group-summary';
  await click(summary); await wait(`s.range<=2 && ${atTail}`);
  await click(summary); await wait(`s.range<=2 && ${atTail}`);
  await wheel(-100); await wait(atTail);
  const short = await evaluate(state);
  await click(button(2)); await wait(`s.range>20 && ${atTail}`);
  await record('viewport-fitting-disclosure-follows-output', {short, overflowing:await evaluate(state)}, true);
}
