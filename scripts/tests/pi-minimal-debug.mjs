#!/usr/bin/env node
/** Packaged minimal-mode acceptance through real Host/Session/Kernel and a local Responses fixture.
 * node scripts/tests/pi-minimal-debug.mjs --artifact ABS_PACKAGE --work-root ABS_NEW_DIRECTORY
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
assert.ok(args.get('--artifact') && args.get('--work-root'));
const artifact = resolve(args.get('--artifact')), root = resolve(args.get('--work-root'));
const mac = process.platform === 'darwin', win = process.platform === 'win32';
const contents = join(artifact, 'Achbit-Debug.app', 'Contents');
const runtime = mac ? join(contents, 'Resources') : artifact, binaries = mac ? join(contents, 'MacOS') : artifact;
const build = JSON.parse(await readFile(join(runtime, 'BUILDINFO.json'), 'utf8'));
assert.equal(build.buildKind, 'debug'); assert.equal(build.debugControl, true);
await mkdir(root);
const state = join(root, 'state'), workspace = join(root, 'workspace'); await mkdir(workspace);
const cli = join(binaries, win ? 'achbit-cli.exe' : 'achbit-cli');
const env = { ...process.env, ACHBIT_RUNTIME_DIR: runtime, ACHBIT_KERNEL_BIN: join(binaries, win ? 'achbit-kernel.exe' : 'achbit-kernel'),
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of Object.keys(env)) if (/^(?:https?|all)_proxy$/i.test(key)) delete env[key];
let ordinal = 0, launched = false, cleanup, failure;
const sessions = new Set(), requests = [], fixtureErrors = [], cases = [], counts = new Map();
async function save(label, data) { const path = join(root, `${++ordinal}-${label}.json`); await writeFile(path, JSON.stringify(data, null, 2)); return path; }
async function run(argv, onFrame, expected = 0) {
  const child = spawn(cli, argv, { cwd: artifact, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', tail = '', error;
  const timer = setTimeout(() => { error = new Error('Bounded CLI wait exceeded'); child.kill(); }, 90000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { stdout += text; tail += text; const lines = tail.split('\n'); tail = lines.pop();
    if (onFrame) for (const line of lines.filter(Boolean)) { try { onFrame(JSON.parse(line)); } catch (err) { error ??= err; child.kill(); } } });
  child.stderr.on('data', text => { stderr += text; });
  let code;
  try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
  finally { clearTimeout(timer); }
  await save('cli', { argv, code, stdout, stderr });
  if (error) throw error;
  if (expected !== null) assert.equal(code, expected, `${stderr}\n${stdout.slice(-3000)}`);
  return { code, stdout, stderr };
}
const debug = (words, onFrame, expected = 0) => run(['debug', ...words, '--state-root', state], onFrame, expected);
const command = async (words, params = {}) => JSON.parse((await debug([...words, '--params', '@' + await save(words.join('-'), params)])).stdout);
const exists = async path => access(path).then(() => true, () => false);
const outputs = body => new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]));
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), turn = (counts.get(body.model) ?? 0) + 1; counts.set(body.model, turn);
    await save(`${body.model}-wire-${turn}`, body); requests.push({ model: body.model, turn });
    assert.ok(turn <= 4, 'No model polling or unbounded recovery');
    const names = body.tools.map(tool => tool.name), shell = win ? 'powershell' : 'bash';
    assert.deepEqual(names, ['read', shell, 'edit', 'write']);
    assert.equal(body.input[0].role, 'developer'); assert.equal(body.store, false);
    assert.equal(body.reasoning.summary, 'auto'); assert.ok(body.include.includes('reasoning.encrypted_content'));
    assert.ok(body.prompt_cache_key);
    const prompt = body.input[0].content;
    assert.equal(typeof prompt, 'string');
    assert.match(prompt, /^You are a coding assistant running inside Achbit/u);
    // A blank minimal recipe has no product-operations component, project rules or user addendum.
    assert.deepEqual([...prompt.matchAll(/^<(tools|rules|docs|project_context|skills|response|environment|cwd)>$/gmu)]
      .map(match => match[1]), ['tools', 'rules', 'cwd']);
    assert.doesNotMatch(prompt, /<docs>|productDocsPath|debug-control\.md/u);
    assert.doesNotMatch(prompt, /<response>|<environment>|outputs table|plan_publish|PI_\*/u);
    const results = outputs(body), items = [];
    const call = (id, name, input) => items.push({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(input), status: 'completed' });
    const answer = () => items.push({ type: 'message', id: `answer-${body.model}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'minimal-complete', annotations: [] }] });
    let truncate = false;
    if (body.model === 'minimal-normal') {
      if (turn === 1) {
        call('read-seed', 'read', { path: 'seed.txt' });
        call('edit-fails', 'edit', { path: 'seed.txt', edits: [{ oldText: 'absent', newText: 'wrong' }] });
        call('edit-succeeds', 'edit', { path: 'seed.txt', edits: [{ oldText: 'before', newText: 'after' }] });
        call('write-independent', 'write', { path: 'independent.txt', content: 'one\ntwo\nthree\n' });
        call('shell-fails', shell, { command: win ? 'Write-Output "evidence"; exit 7' : 'printf evidence; exit 7' });
      } else if (turn === 2) {
        assert.deepEqual([...results.keys()], ['read-seed', 'edit-fails', 'edit-succeeds', 'write-independent', 'shell-fails']);
        assert.match(results.get('edit-fails'), /not found/u);
        assert.match(results.get('edit-succeeds'), /Successfully replaced/u);
        assert.match(results.get('shell-fails'), /evidence[\s\S]*code 7/u);
        assert.equal(await readFile(join(workspace, 'seed.txt'), 'utf8'), 'after\n');
        call('read-window', 'read', { path: 'independent.txt', limit: 1 });
      } else { assert.match(results.get('read-window'), /one[\s\S]*offset=2/u); answer(); }
    } else if (body.model === 'minimal-truncated') {
      if (turn === 1) { call('must-not-write', 'write', { path: 'forbidden-partial.txt', content: 'never' }); truncate = true; }
      else if (turn === 2) {
        assert.equal(await exists(join(workspace, 'forbidden-partial.txt')), false);
        assert.equal(await readFile(join(workspace, 'seed.txt'), 'utf8'), 'after\n');
        assert.deepEqual([...results.keys()], ['must-not-write', 'partial-edit']);
        assert.ok([...results.values()].every(text => /not executed.*output token limit/u.test(text)));
        call('reissued-write', 'write', { path: 'recovered.txt', content: 'complete' });
      } else { assert.equal(await readFile(join(workspace, 'recovered.txt'), 'utf8'), 'complete'); answer(); }
    } else if (body.model === 'minimal-text-truncated') { assert.equal(turn, 1); truncate = true; }
    else throw new Error(`Unknown fixture ${body.model}`);
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    for (const [output_index, item] of items.entries()) res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index, item })}\n\n`);
    if (truncate) {
      if (body.model === 'minimal-truncated') {
        res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item-partial', call_id: 'partial-edit', name: 'edit' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"seed.txt","edits":[' })}\n\n`);
      }
      res.end(`data: ${JSON.stringify({ type: 'response.incomplete', response: { id: 'incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`);
    } else res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${body.model}-${turn}`, status: 'completed', usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 30 } } })}\n\n`);
  } catch (error) {
    fixtureErrors.push(String(error.stack ?? error));
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  await writeFile(join(workspace, 'seed.txt'), 'before\n');
  await debug(['launch', '--artifact', artifact, '--workspace', workspace, '--headless']); launched = true;
  const identity = await command(['inspect']); await save('identity', identity);
  const connection = JSON.parse(await readFile(join(state, 'data', 'agent-runtime', 'host-connection.json'), 'utf8'));
  const settingsResponse = await fetch(`${connection.identity.address}/api/user-settings`, { method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-achbit-host-shell-token': connection.shellToken },
    body: JSON.stringify({ patches: { 'agent.minimalMode': true } }) });
  const settings = await settingsResponse.json(); assert.equal(settings.ok, true, JSON.stringify(settings));
  await save('settings-minimal', settings);
  const key = join(root, 'fixture-key.txt'); await writeFile(key, 'fixture-only');
  await run(['--host-data-dir', join(state, 'data'), 'connections', 'set', '--input', await save('connection', { connection: {
    id: 'minimal-fixture', name: 'Minimal fixture', adapterId: 'custom', billingMode: 'metered',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialKind: 'apiKey',
  } }), '--api-key-file', key]); await rm(key);
  for (const model of ['minimal-normal', 'minimal-truncated', 'minimal-text-truncated']) {
    await run(['--host-data-dir', join(state, 'data'), 'models', 'set', '--input', await save('profile', {
      id: model, name: model, model, connectionId: 'minimal-fixture', kind: 'responses', providerFlavor: 'openai', enabled: true,
      contextWindowTokens: 100000, maxOutputTokens: 4096, reasoningEffort: 'high', thinking: 'enabled',
    })]);
    let sessionId; const frames = [];
    await debug(['task', 'submit', '--params', '@' + await save('task', { text: 'Exercise the minimal coding task.', profileId: model }), '--follow'], frame => {
      frames.push(frame); if (frame.submission) { sessionId = frame.sessionId; sessions.add(sessionId); }
    }, model === 'minimal-text-truncated' ? 4 : 0);
    assert.ok(sessionId); const projection = await command(['task', 'inspect'], { sessionId });
    assert.equal(projection.run.status, model === 'minimal-text-truncated' ? 'failed' : 'completed', JSON.stringify(projection.terminalError));
    assert.deepEqual(fixtureErrors, []);
    assert.equal(counts.get(model), model === 'minimal-text-truncated' ? 1 : 3);
    if (model === 'minimal-truncated') {
      assert.equal(projection.providerAttempts.filter(attempt => attempt.phase === 'failed').length, 1);
      assert.equal(projection.activities.filter(activity => activity.status === 'rejected').length, 2);
    }
    const events = frames.flatMap(frame => frame.items ?? []);
    assert.ok(events.some(item => item.eventType === 'run.runtime.released'));
    assert.ok(events.some(item => item.eventType === 'run.settled'));
    await save(`${model}-projection`, projection); await save(`${model}-frames`, frames);
    cases.push({ model, sessionId, status: projection.run.status, providerRequests: counts.get(model) });
    console.log(`PASS ${model}: actual minimal setting, ${counts.get(model)} requests, runtime released`);
  }
  const before = requests.length, sessionId = cases[0].sessionId;
  const plan = await debug(['task', 'respond', '--params', '@' + await save('plan', { sessionId,
    command: { type: 'message.submit', text: 'Prepare a Plan.', planMode: 'manual', profileId: 'minimal-normal' } })], undefined, null);
  assert.notEqual(plan.code, 0, 'bare minimal must reject manual Plan');
  assert.equal(requests.length, before); cases.push({ model: 'manual-plan', rejected: true, providerRequests: 0 });
} catch (error) { failure = String(error.stack ?? error); throw error; }
finally {
  try {
    if (launched) {
      for (const sessionId of sessions) {
        const projection = await command(['task', 'inspect'], { sessionId });
        if (['running', 'waiting'].includes(projection.run?.status)) await command(['task', 'cancel'], { sessionId, runId: projection.run.runId });
      }
      cleanup = JSON.parse((await debug(['stop'])).stdout);
    }
  } finally {
    await new Promise(done => server.close(done));
    await writeFile(join(root, 'report.json'), JSON.stringify({ build, artifact, cases, requests, fixtureErrors, cleanup, failure }, null, 2));
  }
}
