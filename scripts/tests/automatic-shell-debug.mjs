#!/usr/bin/env node
/** Windows packaged Loop regression: ordinary Shell auto-management + independent files.
 * node scripts/tests/automatic-shell-debug.mjs --artifact ABS_DEBUG_DIR --work-root ABS_NEW_DIR [--container achbit-dev]
 * Uses a loopback Responses fixture and real packaged tools; no real Provider, database reads or ordinary Host.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
assert.equal(process.platform, 'win32', 'This fixture exercises the Windows packaged PowerShell entrypoint.');
assert.ok(args.get('--artifact') && args.get('--work-root'));
const artifact = resolve(args.get('--artifact')), root = resolve(args.get('--work-root'));
const build = JSON.parse(await readFile(join(artifact, 'BUILDINFO.json'), 'utf8'));
assert.equal(build.buildKind, 'debug'); assert.equal(build.debugControl, true);
await mkdir(root); // A new root is mandatory: never attach to another instance.
const stateRoot = join(root, 'state'), workspace = join(root, 'workspace');
await mkdir(workspace);
const cli = join(artifact, 'achbit-cli.exe');
const env = { ...process.env, ACHBIT_RUNTIME_DIR: artifact, ACHBIT_KERNEL_BIN: join(artifact, 'achbit-kernel.exe'),
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
let ordinal = 0, launched = false;
const sessions = new Set(), states = new Map(), fixtureErrors = [], cases = [];
const quote = value => `'${value.replaceAll("'", "''")}'`;
async function jsonFile(label, value) {
  const path = join(root, `${++ordinal}-${label}.json`);
  await writeFile(path, JSON.stringify(value, null, 2)); return path;
}
async function run(argv, onFrame, expectedExit = 0) {
  const child = spawn(cli, argv, { cwd: artifact, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', tail = '', frameError;
  const handlers = [];
  const timer = setTimeout(() => { frameError ??= new Error(`CLI deadline: ${argv.slice(0, 3).join(' ')}`); child.kill(); }, 180_000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
    if (!onFrame) return;
    tail += text; const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines.filter(line => line.trim())) {
      try { handlers.push(Promise.resolve(onFrame(JSON.parse(line))).catch(error => { frameError ??= error; child.kill(); })); }
      catch (error) { frameError ??= error; child.kill(); }
    }
  });
  child.stderr.on('data', text => { stderr += text; });
  let code;
  try {
    code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    await Promise.all(handlers);
  } finally { clearTimeout(timer); }
  await jsonFile('cli', { argv, code, stdout, stderr });
  if (frameError) throw frameError;
  if (expectedExit !== null) assert.equal(code, expectedExit, `${stderr}\n${stdout.slice(-3000)}`);
  return { code, stdout, stderr };
}
const debug = (words, onFrame, exit = 0) => run(['debug', ...words, '--state-root', stateRoot], onFrame, exit);
const command = async (words, params = {}) => JSON.parse((await debug([...words, '--params', '@' + await jsonFile(words.join('-'), params)])).stdout);
function decode(text) { try { return JSON.parse(text); } catch { return text; } }
function outputs(body) {
  return new Map((body.input ?? []).filter(item => item.type === 'function_call_output').map(item => [item.call_id, decode(item.output)]));
}
function completions(body) {
  const values = [];
  for (const item of body.input ?? []) if (item.role === 'user') {
    const text = typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join('');
    const value = decode(text); if (value?.process) values.push(value.process);
  }
  return values;
}
function functionName(body, canonical) {
  const name = canonical.replaceAll('.', '_');
  const short = { 'fs.read': 'read', 'fs.write': 'write', 'fs.edit': 'edit' }[canonical];
  const found = body.tools.find(tool => tool.type === 'function' && (tool.name === name || tool.name === short));
  assert.ok(found, `Tool missing: ${canonical}`); return found.name;
}
function shellCommand(mode, which) {
  const marker = `${mode}-${which}`, gate = join(workspace, `${mode}-release`);
  const container = args.get('--container');
  let extra = '';
  if (mode === 'container' && which === 'a') {
    assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    extra = `& wsl --exec docker exec -w /workspace ${container} node --test userspace/session-core/tests/managed-wait.test.mjs\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`;
  }
  return `$ErrorActionPreference='Stop'\nWrite-Output ${quote('BEGIN:' + marker)}\n${extra}`
    + `$deadline=[DateTime]::UtcNow.AddSeconds(40)\nwhile (-not (Test-Path -LiteralPath ${quote(gate)})) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Fixture gate deadline' }; Start-Sleep -Milliseconds 40 }\n`
    + `Write-Output ${quote('DONE:' + marker)}\nexit ${mode === 'failure' && which === 'a' ? 7 : 0}`;
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), state = states.get(body.model);
    assert.ok(state, `Unexpected profile ${body.model}`);
    const n = ++state.requests;
    await jsonFile(`${state.mode}-request-${n}`, body);
    assert.ok(n <= 5, 'Unexpected model polling or duplicate continuation');
    const results = outputs(body), items = [];
    const call = (id, name, input) => items.push({ type: 'function_call', id: `item-${id}`, call_id: id,
      name: functionName(body, name), arguments: JSON.stringify(input), status: 'completed' });
    const answer = text => items.push({ type: 'message', id: `answer-${state.mode}-${n}`, role: 'assistant', phase: 'final_answer',
      status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    if (n === 1) {
      for (const which of ['a', 'b']) call(`${state.mode}-shell-${which}`, 'powershell', {
        command: shellCommand(state.mode, which), timeout: 50,
        requestHostPermission: 'Run this bounded fixture-owned command; only the isolated gate and optional approved test container are accessed.',
      });
      call(`${state.mode}-read-a`, 'fs.read', { path: 'a.txt' });
      call(`${state.mode}-read-b`, 'fs.read', { path: 'b.txt' });
    } else if (n === 2) {
      for (const which of ['a', 'b']) {
        const receipt = results.get(`${state.mode}-shell-${which}`);
        const job = receipt?.result ?? receipt;
        assert.equal(job?.status, 'active', 'ordinary Shell must return a managed receipt without an explicit process call');
        state.jobs.push(job.jobId);
        assert.match(JSON.stringify(results.get(`${state.mode}-read-${which}`)), new RegExp(`input-${which}`));
      }
      assert.doesNotMatch(JSON.stringify([...results.values()]), /dependencyPending/);
      call(`${state.mode}-edit-1`, 'fs.edit', { path: `${state.mode}.txt`, edits: [{ oldText: 'before', newText: 'middle' }] });
      call(`${state.mode}-write`, 'fs.write', { path: `${state.mode}-independent.txt`, content: 'independent write' });
      call(`${state.mode}-edit-2`, 'fs.edit', { path: `${state.mode}.txt`, edits: [{ oldText: 'middle', newText: 'after' }] });
    } else if (n === 3) {
      for (const id of ['edit-1', 'write', 'edit-2']) {
        assert.ok(results.has(`${state.mode}-${id}`));
        assert.doesNotMatch(JSON.stringify(results.get(`${state.mode}-${id}`)), /notExecuted|"error"/);
      }
      assert.equal(await readFile(join(workspace, `${state.mode}.txt`), 'utf8'), 'after');
      assert.equal(await readFile(join(workspace, `${state.mode}-independent.txt`), 'utf8'), 'independent write');
      assert.equal(completions(body).length, 0, 'independent edits must finish before either command gate opens');
      answer(`INDEPENDENT-DONE:${state.mode}`);
    } else {
      const received = completions(body).filter(job => state.jobs.includes(job.jobId));
      for (const job of received) {
        assert.ok(['completed', 'failed'].includes(job.status));
        assert.match(job.stdout, /DONE:/);
        state.received.set(job.jobId, job);
      }
      assert.ok(received.length > 0, 'wake must carry actual command results, not ask the model to query status');
      answer(state.received.size === 2 ? `COLLECTED:${state.mode}` : `PARTIAL:${state.mode}`);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    for (const [output_index, item] of items.entries()) res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index, item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${state.mode}-${n}`, status: 'completed', usage: { input_tokens: Math.ceil(raw.length / 3), output_tokens: 50 } } })}\n\n`);
  } catch (error) {
    fixtureErrors.push(String(error.stack ?? error));
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const recipe = { productComponents: [], tools: { kernel: ['powershell', 'process', 'fs.read', 'fs.write', 'fs.edit'], controls: [], plugins: false },
  permissions: { 'agent.permissions.shell': 'allow', 'agent.permissions.shellAccess': 'full', 'agent.permissions.workspaceMutation': 'allow' } };
let cleanup, failure;
try {
  await writeFile(join(workspace, 'a.txt'), 'input-a\n'); await writeFile(join(workspace, 'b.txt'), 'input-b\n');
  await debug(['launch', '--artifact', artifact, '--workspace', workspace, '--headless']); launched = true;
  await jsonFile('runtime-inspect', await command(['inspect']));
  const keyFile = join(root, 'fixture-key.txt'); await writeFile(keyFile, 'local-fixture-only');
  await run(['--host-data-dir', join(stateRoot, 'data'), 'connections', 'set', '--input', await jsonFile('connection', { connection: {
    id: 'shell-fixture', name: 'Local Shell fixture', adapterId: 'custom', billingMode: 'metered',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialKind: 'apiKey',
  } }), '--api-key-file', keyFile]);
  for (const mode of ['success', 'failure', 'cancel', ...(args.get('--container') ? ['container'] : [])]) {
    const profileId = `shell-${mode}`;
    const state = { mode, requests: 0, jobs: [], received: new Map() }; states.set(profileId, state);
    await writeFile(join(workspace, `${mode}.txt`), 'before');
    await run(['--host-data-dir', join(stateRoot, 'data'), 'models', 'set', '--input', await jsonFile(profileId, {
      id: profileId, connectionId: 'shell-fixture', name: profileId, model: profileId, kind: 'responses', providerFlavor: 'openai',
      enabled: true, contextWindowTokens: 200000, maxOutputTokens: 2048,
    })]);
    let sessionId, released = false;
    const frames = [], onFrame = async frame => {
      frames.push(frame);
      if (frame.submission) { sessionId = frame.sessionId; sessions.add(sessionId); }
      for (const item of frame.items ?? []) if (!released && (item.eventType === 'message.committed' && item.payload.content === `INDEPENDENT-DONE:${mode}`
        || item.kind === 'text' && item.text.includes(`INDEPENDENT-DONE:${mode}`))) {
        released = true;
        if (mode === 'cancel') await command(['task', 'cancel'], { sessionId, runId: item.runId });
        else await writeFile(join(workspace, `${mode}-release`), 'continue');
      }
    };
    const result = await debug(['task', 'submit', '--params', '@' + await jsonFile(`${mode}-task`, {
      text: `Scenario ${mode}: run two independent long commands and read files; edit unrelated files while commands are managed; collect actual results without polling.`,
      profileId, recipe,
    }), '--follow'], onFrame, mode === 'cancel' ? null : 0);
    assert.ok(sessionId && released, 'follow must observe the independent-work boundary');
    const projection = await command(['task', 'inspect'], { sessionId });
    assert.equal(projection.run.status, mode === 'cancel' ? 'cancelled' : 'completed', JSON.stringify(projection.terminalError));
    assert.deepEqual(fixtureErrors, []);
    assert.ok(frames.some(frame => frame.items?.some(item => item.eventType === 'run.settled')));
    const jobs = projection.activities.filter(activity => activity.tool?.process);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(job => job.status !== 'active' && !job.tool.projectionError));
    assert.equal(projection.activities.some(activity => activity.notExecuted), false);
    if (mode === 'cancel') {
      assert.equal(state.requests, 3);
      assert.ok(jobs.every(job => job.status === 'cancelled'));
    } else {
      assert.ok(state.requests === 4 || state.requests === 5, 'only partial and final completion may add a model round');
      assert.equal(state.received.size, 2);
      assert.equal([...state.received.values()].filter(job => job.status === 'failed').length, mode === 'failure' ? 1 : 0);
      if (mode === 'failure') assert.ok([...state.received.values()].some(job => job.exitCode === 7));
    }
    const events = frames.flatMap(frame => frame.items ?? []);
    // A streamed Shell record references its output instead of repeating it.
    // The Provider assertions above established these are managed receipts.
    const receipts = events.filter(item => item.eventType === 'tool.completed' && item.payload.record?.toolName === 'powershell');
    const reads = events.filter(item => item.eventType === 'tool.completed' && item.payload.record?.toolName === 'fs.read');
    assert.equal(receipts.length, 2);
    assert.equal(reads.length, 2);
    assert.ok(Math.max(...reads.map(item => item.eventSequence)) < Math.min(...receipts.map(item => item.eventSequence)), 'file reads complete before Shell foreground receipts');
    await jsonFile(`${mode}-projection`, projection); await jsonFile(`${mode}-frames`, frames);
    cases.push({ mode, sessionId, status: projection.run.status, providerRequests: state.requests, followExit: result.code,
      fileReadsBeforeShellReceipt: true, independentEditsBeforeCommandCompletion: true, terminalJobs: jobs.map(job => ({ status: job.status, result: job.tool.process.result })) });
    console.log(`PASS ${mode}: ${state.requests} model requests; independent file effects preserved; both owned jobs terminal`);
  }
  const beyond = await debug(['tools', 'call', '--tool', 'fs.read', '--input', JSON.stringify({ path: 'a.txt', startLine: 1200 })], undefined, null);
  assert.notEqual(beyond.code, 0);
  assert.match(beyond.stdout + beyond.stderr, /startLine 1200 exceeds file length 2 lines/);
  cases.push({ mode: 'reader-range', followExit: beyond.code, passed: true });
} catch (error) { failure = error; }
finally {
  try {
    if (launched) {
      for (const sessionId of sessions) {
        const projection = await command(['task', 'inspect'], { sessionId });
        if (['running', 'waiting'].includes(projection.run?.status)) await command(['task', 'cancel'], { sessionId, runId: projection.run.runId });
      }
      cleanup = JSON.parse((await debug(['stop'])).stdout);
      assert.equal(cleanup.cleanupComplete, true, 'owned Debug Host cleanup must complete');
    }
  } catch (error) { failure = failure ? new AggregateError([failure, error], 'Fixture and cleanup failed') : error; }
  await new Promise(done => server.close(done));
  await writeFile(join(root, 'report.json'), JSON.stringify({ passed: !failure, build, artifact, cases, fixtureErrors, cleanup,
    ...(failure ? { error: String(failure.stack ?? failure) } : {}) }, null, 2));
}
if (failure) throw failure;
console.log('PASS packaged Windows Shell/file Loop fixture; no real Provider or ordinary instance was used.');
