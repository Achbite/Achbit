// Interactive integration of the packaged desktop plugin. See plugins/computer-use/README.md.
// The only target is our own WPF window. The Responses server is a deterministic local fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [pkgArg, dirArg, option] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(pkgArg && dirArg && (!option || option === '--baseline'));
const pkg = resolve(pkgArg), root = resolve(dirArg), baseline = option === '--baseline';
assert.equal(JSON.parse(await readFile(join(pkg, 'BUILDINFO.json'))).buildKind, 'debug');
await mkdir(root); // Refuse reuse, especially a live state directory.
const state = join(root, 'state'), ws = join(root, 'workspace');
await mkdir(ws);
const env = { ...process.env, ACHBIT_USER_ROOT: state, ACHBIT_RUNTIME_DIR: pkg,
  ACHBIT_KERNEL_BIN: join(pkg, 'achbit-kernel.exe'), ACHBIT_PORT: '0', NO_PROXY: '127.0.0.1,localhost' };
for (const k of Object.keys(env)) {
  if (/^(?:ACHBIT_(?:API_URL|API_PORT|HOST_DATA_DIR|HOST_SHELL_TOKEN|SESSION_SERVICE_MODULE)|(?:http|https|all)_proxy)$/i.test(k)) delete env[k];
}
const report = { baseline, calls: [], runs: [] };
let firstError, session, owned = false, target, clickView, archivePath, rejections = 0, turn = 0;
const json = async (name, data) => {
  const file = join(root, `${name}.json`);
  await writeFile(file, JSON.stringify(data));
  return file;
};
const samePath = (a, b) => toNamespacedPath(resolve(a)).toLowerCase() === toNamespacedPath(resolve(b)).toLowerCase();

async function cli(args, onFrame, expected = 0) {
  const child = spawn(join(pkg, 'achbit-cli.exe'), args, { cwd: pkg, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let text = '', stderr = '', tail = '', frameError;
  const handlers = [];
  child.stdout.setEncoding('utf8').on('data', chunk => {
    text += chunk;
    if (!onFrame) return;
    tail += chunk;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines.filter(s => s.trim())) {
      handlers.push(Promise.resolve().then(() => onFrame(JSON.parse(line))).catch(e => { frameError ??= e; child.kill(); }));
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { frameError ??= Error('Timed out: ' + args.slice(0,3).join(' ')); child.kill(); }, 85_000);
  try {
    const code = await new Promise((ok, no) => { child.once('error', no); child.once('close', ok); });
    await Promise.all(handlers);
    if (frameError) throw frameError;
    if (firstError && onFrame) throw firstError;
    if (expected !== null) assert.equal(code, expected, `${args.slice(0,3).join(' ')}: ${stderr.slice(-700)} ${text.slice(-700)}`);
    return { code, text };
  } finally { clearTimeout(timer); }
}
const debug = (args, onFrame, expected) => cli(['debug', ...args, '--state-root', state], onFrame, expected);
const local = args => cli(['--host-data-dir', join(state,'data'), ...args]);
const windowScript = join(dirname(fileURLToPath(import.meta.url)), 'observation-window.ps1');
const fixture = spawn('powershell.exe', ['-NoProfile','-STA','-File',windowScript,root], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let windowError = '';
fixture.stderr.on('data', chunk => { windowError += chunk; });
const windowExit = new Promise((ok,no) => { fixture.once('error',no); fixture.once('close',ok); });

// Only the preselected file in this disposable run can receive a read approval. Never approve
// desktop calls, arbitrary paths or a persistent permission in response to a frame.
const seenApprovals = new Set();
async function observe(frame) {
  if (frame.submission) session = frame.sessionId;
  for (const f of frame.items ?? []) {
    if (f.eventType !== 'approval.requested' || seenApprovals.has(f.payload.approvalId)) continue;
    assert.ok(!baseline && session && archivePath && turn === 5);
    seenApprovals.add(f.payload.approvalId);
    const { pendingApproval: a } = JSON.parse((await debug(['task','inspect','--session-id',session])).text);
    assert.equal(a.runId, f.runId); assert.equal(a.callId, f.callId); assert.equal(a.approvalId, f.payload.approvalId);
    const p = a.preview;
    assert.equal(p.operation.toolName, 'fs.read'); assert.equal(p.operation.arguments.maxBytes, 1024);
    assert.deepEqual(p.effects, ['workspaceRead']); assert.deepEqual(p.logicalTargets, [archivePath]);
    assert.equal(p.fileAccess.read.length, 1); assert.ok(samePath(p.fileAccess.read[0], archivePath)); assert.deepEqual(p.fileAccess.write, []);
    const cmd = { type:'approval.respond', approvalId:a.approvalId, runId:a.runId, callId:a.callId, decision:'allow' };
    await debug(['task','respond','--session-id',session,'--command','@'+await json('one-file-read',cmd)]);
  }
}
async function submit(params) {
  const r = await debug(['task','submit','--params','@'+await json('task',params),'--follow'], observe, null);
  assert.ok(session);
  const p = JSON.parse((await debug(['task','inspect','--session-id',session])).text);
  assert.equal(p.run.status, baseline ? 'failed' : 'completed', JSON.stringify(p.terminalError));
  if (baseline) assert.match(p.terminalError.message, /Controlled rejection/);
  else assert.equal(r.code, 0);
  report.runs.push(p.run.status);
}

async function reply(req, res) {
  assert.equal(req.url, '/v1/responses');
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks), body = JSON.parse(raw);
  assert.equal(body.model,'computer-qa'); assert.ok(++turn <= 7, 'No polling or repeated effects');
  const outputs = new Map(body.input.filter(i => i.type === 'function_call_output').map(i => [i.call_id, JSON.parse(i.output)]));
  const value = id => { const o = outputs.get(id); assert.ok(o, `Missing ${id}`); assert.ok(!o.error, JSON.stringify(o.error)); return o.result ?? o; };
  const bytes = Object.fromEntries([...outputs].map(([k,v]) => [k,Buffer.byteLength(JSON.stringify(v))]));
  const images = body.input.flatMap(i => Array.isArray(i.content) ? i.content : []).filter(p => p.type === 'input_image').length;
  report.calls.push({ turn, textBytes:bytes, images });
  function call(id, input, name = 'computer_control') {
    assert.ok(body.tools.some(t => t.name === name));
    return { type:'function_call', id:'item-'+id, call_id:id, name, arguments:JSON.stringify(input), status:'completed' };
  }
  const finish = () => ({ type:'message', id:'answer-'+turn, role:'assistant', status:'completed',
    content:[{ type:'output_text',text:'Controlled plugin check complete.',annotations:[] }] });
  let item;
  if (turn === 1) item = call('status',{ action:'status' });
  else if (turn === 2) {
    const status = value('status'); assert.equal(status.platform,'windows');
    assert.ok(samePath(status.executor.executable,join(pkg,'Achbit-Computer-Use.exe')));
    report.helper = status.executor.executable;
    item = call('observe',{ action:'observe', app:target.app, windowId:target.windowId, mode:'foreground' });
  } else if (turn === 3) {
    const o = value('observe'); assert.equal(o.window.windowId,target.windowId); assert.ok(o.modelImages?.length && images > 0);
    const b = o.elements.find(e => e.title === 'Reveal synthetic history' && e.role === 'Button')?.bounds;
    assert.ok(b); item = call('click',{ action:'click',app:target.app,observationId:o.observationId,x:b.x+b.width/2,y:b.y+b.height/2 });
  } else {
    const o = value('click'); assert.equal(o.dispatched,true); assert.equal(o.window.windowId,target.windowId);
    assert.notEqual(o.observationId,value('observe').observationId); assert.ok(o.modelImages?.length);
    if (baseline) {
      assert.ok(bytes.click > 1024*1024, `Baseline did not reproduce: ${bytes.click}`);
      assert.ok(o.elements.some(e => e.title?.endsWith(':ROW-END')));
      rejections++; res.writeHead(400,{'content-type':'application/json'});
      res.end(JSON.stringify({ error:{ code:'context_length_exceeded',message:'Controlled rejection: oversized desktop observation.' } })); return;
    }
    assert.ok(bytes.click < 40*1024, 'Limit includes some extra Host artifact metadata');
    assert.equal(o.observationView.truncated,true);
    const detail = o.observationView.fullOutput;
    if (turn === 4) {
      const archiveRoot = await realpath(join(state,'data','agent-runtime','tool-record.outputs'));
      assert.ok(toNamespacedPath(await realpath(detail.path)).toLowerCase().startsWith(toNamespacedPath(archiveRoot).toLowerCase()+'\\'));
      archivePath = detail.path;
      const saved = await readFile(archivePath); assert.equal(detail.bytes,saved.length); assert.ok(saved.length > 1024*1024);
      const full = JSON.parse(saved); assert.equal(full.dispatched,true); assert.equal(full.observationId,o.observationId);
      assert.equal(full.window.windowId,target.windowId); assert.equal(full.elements.length,o.observationView.totalElements);
      assert.ok(full.elements.some(e => e.title?.endsWith(':ROW-END'))); assert.ok(images > 0);
      report.archivedBytes = detail.bytes; clickView = JSON.stringify(o);
      const button = o.elements.find(e => e.title === 'Verify retained control' && e.actions?.includes('invoke'));
      assert.ok(button); assert.equal(full.elements.find(e => e.elementId === button.elementId)?.title,button.title);
      item = call('press',{ action:'press',app:target.app,observationId:o.observationId,elementId:button.elementId });
    } else {
      assert.equal(JSON.stringify(o),clickView,'The frozen result was not replayed unchanged');
      const p = value('press'); assert.equal(p.dispatched,true); assert.notEqual(p.observationId,o.observationId); assert.ok(bytes.press < 40*1024);
      if (turn === 5) item = call('detail-page',{ path:archivePath,maxBytes:1024 },'fs_read');
      else {
        const page = value('detail-page'); assert.ok(page.nextByte > 0 && page.nextByte <= 1024 && page.nextByte < detail.bytes);
        assert.equal(page.content,(await readFile(archivePath)).subarray(0,page.nextByte).toString('utf8'));
        report.pageBytes = page.nextByte; if (turn === 7) assert.equal(images,0,'New run replayed observation pixels');
        item = finish();
      }
    }
  }
  res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});
  res.write(`data: ${JSON.stringify({ type:'response.output_item.done',output_index:0,item })}\n\n`);
  res.end(`data: ${JSON.stringify({ type:'response.completed',response:{ id:'r-'+turn,status:'completed',usage:{ input_tokens:Math.max(50,Math.ceil(raw.length/5)),output_tokens:32 } } })}\n\n`);
}
const http = createServer((req,res) => reply(req,res).catch(e => {
  firstError ??= e; res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({ error:{ message:String(e).slice(0,800) } }));
}));
try {
  for (let i=0; i<100 && !target; i++) {
    if (fixture.exitCode !== null) throw Error('Window exited: '+windowError);
    try { target = JSON.parse(await readFile(join(root,'target.json'))); } catch { await sleep(100); }
  }
  assert.ok(target); assert.equal(target.pid,fixture.pid); assert.ok(target.windowId > 0);
  await new Promise(ok => http.listen(0,'127.0.0.1',ok));
  await debug(['launch','--artifact',pkg,'--workspace',ws,'--headless']); owned=true;
  const key = join(root,'fixture-key'); await writeFile(key,'local-only');
  await local(['connections','set','--input',await json('connection',{ connection:{ id:'computer-local',name:'Computer QA',adapterId:'custom',
    billingMode:'metered',credentialKind:'apiKey',baseUrl:`http://127.0.0.1:${http.address().port}/v1` } }),'--api-key-file',key]);
  await rm(key);
  await local(['models','set','--input',await json('profile',{ id:'computer-qa',name:'Computer QA',model:'computer-qa',connectionId:'computer-local',
    kind:'responses',providerFlavor:'openai',enabled:true,imageInput:true,contextWindowTokens:4_000_000,maxOutputTokens:4096 })]);
  await submit({ text:'Exercise only the disposable desktop window.',profileId:'computer-qa',
    recipe:{ productComponents:[],tools:{ kernel:['fs.read'],controls:[],plugins:true },permissions:{ 'agent.permissions.external':'allow' } },
    pluginSelections:[{ selectionId:'qa-computer',uri:'plugin://computer-use@builtin',label:'Computer Use' }] });
  await submit({ sessionId:session,text:'Read the previous result; do not repeat desktop actions.' });
  assert.equal(turn,baseline?5:7); assert.equal(rejections,baseline?2:0);
  report.effects=JSON.parse(await readFile(join(root,'counts.json')));
  assert.deepEqual(report.effects,{ clicks:1, presses:baseline?0:1 });
} catch(e) { firstError ??= e; }
finally {
  try {
    if (owned) {
      const stop=JSON.parse((await debug(['stop'])).text); assert.equal(stop.cleanupComplete,true); report.hostStopped=true;
    }
  } catch(e) { firstError ??= e; }
  await new Promise(ok => http.close(ok)); await writeFile(join(root,'stop-window'),'');
  const watchdog = setTimeout(() => fixture.kill(),5000);
  try { assert.equal(await windowExit,0); report.windowClosed=true; } catch(e) { firstError ??= e; } finally { clearTimeout(watchdog); }
  report.passed=!firstError; if(firstError) report.error=String(firstError.stack??firstError).slice(0,2000);
  await json('report',report); console.log(JSON.stringify(report));
}
if(firstError) process.exitCode=1;
