// Real-browser regressions; TCR: .task-artifacts/frontend-fixes-20261113/TCR.md.
// Run in Docker after the manual Vite build. Supply UI_FIXTURE_ROOT and UI_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
assert.ok(process.env.UI_FIXTURE_ROOT && process.env.UI_EVIDENCE_DIR);
const preview = resolve(process.env.UI_FIXTURE_ROOT), out = resolve(process.env.UI_EVIDENCE_DIR);
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(preview, '.' + new URL(req.url, 'http://localhost').pathname);
    assert.ok(path.startsWith(preview + '/'));
    const data = await readFile(path); res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(data);
  } catch (error) { res.writeHead(404); res.end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`, profile = await mkdtemp(join(tmpdir(), 'achbit-interactions-'));
let browser, ws, id = 0;
const pending = new Map(), listeners = new Map(), results = [];
try {
  browser = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  const endpoint = await new Promise((done, reject) => {
    browser.stderr.on('data', data => { logs += data; const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(logs); if (match) done(match[1]); });
    browser.once('error', reject); browser.once('exit', code => reject(Error('Browser exited ' + code)));
  });
  ws = new WebSocket(endpoint); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const task = pending.get(value.id);
      if (task) { pending.delete(value.id); clearTimeout(task.timer); value.error ? task.reject(Error(JSON.stringify(value.error))) : task.resolve(value.result); }
    } else listeners.get(value.sessionId + ':' + value.method)?.(value.params);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error(method + ' deadline')); }, 20_000);
    pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params) => call(method, params, sessionId);
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const value = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const until = condition => evaluate(`new Promise((done,reject)=>{const end=performance.now()+8000;const check=()=>{if(${condition})done();else if(performance.now()>end)reject(Error('condition timeout'));else setTimeout(check,25)};check()})`);
  const navigate = async name => {
    let timer;
    const loaded = new Promise((done, reject) => { timer = setTimeout(() => reject(Error('load timeout')), 20000); listeners.set(sessionId + ':Page.loadEventFired', () => { clearTimeout(timer); done(); }); });
    await cmd('Page.navigate', { url: `${base}/tests/manual/${name}.html` }); await loaded;
    await until('document.querySelector("#root")?.childElementCount>0'); await frame();
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing element');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await frame();
  };
  const key = async (key, code = key, modifiers = 0) => {
    const keyCodes = { Tab: 9, Escape: 27, Enter: 13, a: 65, ' ': 32 };
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCodes[key] ?? 0 });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); await frame();
  };
  const type = async (selector, text) => { await click(selector); await key('a', 'KeyA', 2); await cmd('Input.insertText', { text }); await frame(); };
  const record = async (name, actual, pass) => {
    results.push({ name, actual, pass }); await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
    const image = await cmd('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
  };
  await navigate('composer');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="检查模式"]');select.value='message';select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await frame();
  await evaluate(`(()=>{const input=document.querySelector('[data-ui-action="composer.controls.input"]');input.focus();const data=new DataTransfer();data.setData('text/plain',Array.from({length:80},(_,n)=>'line '+n+' alpha beta gamma delta').join('\\n'));input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()`); await frame();
  await until('document.querySelector(".local-agent__paste-toggle")'); await click('.local-agent__paste-toggle'); await click('.local-agent__pasted-text textarea');
  const draftId = await evaluate(`JSON.parse(sessionStorage.getItem('achbit:composer:session:composer-preview')).pastedTexts[0].inputId`);
  await evaluate('void (window.__oldTextarea=document.querySelector(".local-agent__pasted-text textarea"))');
  await cmd('Input.insertText', { text: 'X' }); await frame(); await cmd('Input.insertText', { text: 'Y' }); await frame();
  const pasted = await evaluate(`(()=>{const input=document.querySelector('.local-agent__pasted-text textarea');const draft=JSON.parse(sessionStorage.getItem('achbit:composer:session:composer-preview')).pastedTexts[0];return {sameNode:input===window.__oldTextarea,oldConnected:window.__oldTextarea.isConnected,focusRetained:document.activeElement===input,edited:input.value.includes('XY'),inputId:draft.inputId,viewId:draft.viewId}})()`);
  await record('pasted-text-identity', pasted, pasted.sameNode && pasted.oldConnected && pasted.focusRetained && pasted.edited && pasted.inputId !== draftId && pasted.viewId === draftId);
  await click('[data-ui-action="composer.controls.attachments"]');
  await key('Escape');
  const menu = await evaluate(`(()=>{const trigger=document.querySelector('[data-ui-action="composer.controls.attachments"]');return {expanded:trigger.getAttribute('aria-expanded'),focusReturned:document.activeElement===trigger}})()`);
  await record('attachment-menu-escape', menu, menu.expanded === 'false' && menu.focusReturned);
  await navigate('approval-model');
  await until('document.querySelector(".model-connection-open")'); await click('.model-connection-open');
  await until('document.querySelector(".model-editor > summary")'); await click('.model-editor > summary');
  const numberSelector = '.model-editor[open] input[type="number"]';
  const savedNumber = await evaluate(`document.querySelector(${JSON.stringify(numberSelector)}).value`);
  await type(numberSelector, String(Number(savedNumber) + 1)); await key('Escape');
  const number = await evaluate(`({detailPresent:Boolean(document.querySelector('.model-breadcrumb')),value:document.querySelector(${JSON.stringify(numberSelector)})?.value,focusRetained:document.activeElement===document.querySelector(${JSON.stringify(numberSelector)})})`);
  await record('number-escape', number, number.detailPresent && number.value === savedNumber && number.focusRetained);
  const open = async mode => { await navigate('path-picker'); await click('#open-' + mode); await until('window.__sharedControlsAudit.observe().address==="/audit/A" && !window.__sharedControlsAudit.snapshot().requests.some(x=>x.status==="pending")'); await frame(); };
  const go = async path => { await type('.ws-open-dialog__address', path); await key('Enter'); await frame(); };
  await open('directory'); await go('/audit/missing/child'); await until('Boolean(window.__sharedControlsAudit.observe().error)');
  const failed = await evaluate('window.__sharedControlsAudit.check()'); await click('.ws-open-dialog__btn--primary');
  const failedAfter = await evaluate('window.__sharedControlsAudit.snapshot()');
  await record('failed-navigation', { before: failed, after: failedAfter }, failed.dom.confirmDisabled && failedAfter.confirmations.length === 0);
  await open('directory'); await go('/audit/slow-B');
  const waiting = await evaluate('window.__sharedControlsAudit.check()'); await click('.ws-open-dialog__btn--primary');
  const waitingAfter = await evaluate('window.__sharedControlsAudit.snapshot()');
  await record('pending-navigation', { before: waiting, after: waitingAfter }, waiting.dom.confirmDisabled && waitingAfter.confirmations.length === 0);
  await go('/audit/C'); await until('!window.__sharedControlsAudit.snapshot().requests.some(x=>x.path==="/audit/C"&&x.status==="pending")');
  await evaluate(`(()=>{const row=window.__sharedControlsAudit.snapshot().requests.find(x=>x.path==='/audit/slow-B'&&x.status==='pending');window.__sharedControlsAudit.release(row.id)})()`); await frame();
  const race = await evaluate('window.__sharedControlsAudit.check()'); await record('latest-navigation-wins', race, race.dom.address === '/audit/C');
  await open('file'); const focus = [];
  for (let index = 0; index < 18; index++) {
    await key('Tab'); const item = await evaluate('window.__sharedControlsAudit.observe().activeElement'); focus.push(item);
    if (item.isFileEntry && item.text.trim() === 'one.txt') break;
  }
  await key(' ', 'Space'); const selected = await evaluate('window.__sharedControlsAudit.observe()');
  await key('Enter'); const confirmed = await evaluate('window.__sharedControlsAudit.snapshot()');
  await record('file-keyboard-selection', { focus, selected, confirmed }, focus.some(item => item.isFileEntry && item.text.trim() === 'one.txt') && selected.confirmDisabled === false && confirmed.confirmations.at(-1)?.path === '/audit/A/one.txt');
  assert.ok(results.every(result => result.pass), 'see the retained browser result for failed invariants');
  await call('Browser.close');
} finally {
  ws?.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await once(browser, 'exit'); }
  await new Promise(done => server.close(done)); await rm(profile, { recursive: true, force: true });
}
