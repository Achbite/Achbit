#!/usr/bin/env node
/** Focused real Debug Host/Session/Kernel test with a loopback Responses fixture.
 * Usage: node scripts/tests/provider-stages-debug.mjs --artifact ABS_DEBUG_PACKAGE --work-root ABS_NEW_DIRECTORY
 * No real credentials, external Provider, ordinary Host or database edits are used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
assert.ok(args.get('--artifact') && args.get('--work-root'), 'Supply --artifact and a new --work-root');
const artifact = resolve(args.get('--artifact')), root = resolve(args.get('--work-root'));
const macos = process.platform === 'darwin';
const contents = join(artifact, 'Achbit-Debug.app', 'Contents');
const runtime = macos ? join(contents, 'Resources') : artifact;
const executables = macos ? join(contents, 'MacOS') : artifact;
const build = JSON.parse(await readFile(join(runtime, 'BUILDINFO.json'), 'utf8'));
assert.equal(build.buildKind, 'debug');
assert.equal(build.debugControl, true);
// Validate the classifier shipped with this runtime, not the source checkout.
const { runFailureKind } = await import(pathToFileURL(join(runtime, 'node_modules', '@achbit', 'protocol', 'dist', 'errorDiagnostics.js')).href);
assert.equal(typeof runFailureKind, 'function');
await mkdir(root); // Refuse to reuse another test's state or receipts.
const stateRoot = join(root, 'state'), workspace = join(root, 'workspace');
await mkdir(workspace);
const windows = process.platform === 'win32';
const cli = join(executables, windows ? 'achbit-cli.exe' : 'achbit-cli');
const env = { ...process.env, ACHBIT_RUNTIME_DIR: runtime,
  ACHBIT_KERNEL_BIN: join(executables, windows ? 'achbit-kernel.exe' : 'achbit-kernel'),
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of Object.keys(env)) if (/^(?:https?|all)_proxy$/i.test(key)) delete env[key];
let fileId = 0;
async function jsonFile(label, value) {
  const path = join(root, `${++fileId}-${label}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}
async function run(argv, onFrame, expectedExit = 0) {
  const child = spawn(cli, argv, { cwd: artifact, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', tail = '', frameError;
  const handlers = [];
  const timer = setTimeout(() => { frameError ??= new Error(`CLI timeout: ${argv.slice(0, 3).join(' ')}`); child.kill(); }, 180000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
    if (!onFrame) return;
    tail += text;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines.filter(line => line.trim())) {
      try { handlers.push(Promise.resolve(onFrame(JSON.parse(line))).catch(error => { frameError ??= error; child.kill(); })); }
      catch (error) { frameError ??= error; child.kill(); }
    }
  });
  child.stderr.on('data', text => { stderr += text; });
  let code;
  try {
    code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
    await Promise.all(handlers);
  } finally { clearTimeout(timer); }
  await writeFile(join(root, `${++fileId}-cli.json`), JSON.stringify({ argv, code, stdout, stderr }, null, 2));
  if (frameError) throw frameError;
  assert.equal(code, expectedExit, `${argv.slice(0, 3).join(' ')}: ${stderr.slice(-3000)}\n${stdout.slice(-3000)}`);
  return stdout;
}
const debug = (words, onFrame, expectedExit = 0) => run(['debug', ...words, '--state-root', stateRoot], onFrame, expectedExit);
const command = async (words, params) => JSON.parse(await debug([...words, '--params', '@' + await jsonFile(words.join('-'), params)]));
const sessions = new Set(), requests = [], fixtureErrors = [];
let responseId = 0, launched = false;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), tools = body.tools ?? [];
    if (body.model === 'error-http-503' || body.model === 'error-incomplete') {
      requests.push({ model: body.model, errorFixture: true });
      assert.equal(requests.filter(item => item.model === body.model).length, 1, 'Failure must not be retried');
      if (body.model === 'error-http-503') {
        res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Fixture high demand' } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(`data: ${JSON.stringify({ type: 'response.incomplete', response: {
          id: 'fixture-incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        } })}\n\n`);
      }
      return;
    }
    const functions = tools.filter(tool => tool.type === 'function');
    const hosted = tools.filter(tool => tool.type === 'web_search');
    const content = JSON.stringify(body.input);
    const reading = functions.length === 1 && functions[0].name === 'session_read';
    const planning = content.includes('Use the available readers to prepare the plan.');
    const summary = content.includes('Summarize the supplied conversation into a factual handoff');
    const expectedHosted = body.model !== 'stage-disabled' && !reading && !planning;
    assert.equal(hosted.length, expectedHosted ? 1 : 0, 'request stage leaked or lost hosted search');
    if (summary) assert.equal(body.tool_choice, 'none', 'compaction must prohibit execution');
    const record = { model: body.model, reading, planning, summary, hosted: hosted.length,
      tools: functions.map(tool => tool.name), toolChoice: body.tool_choice };
    requests.push(record);
    assert.ok(requests.length <= 20, 'Unexpected repeated Provider requests');
    const id = `fixture-${++responseId}`;
    let item;
    if (reading) {
      const sessionId = functions[0].parameters.properties.sessionId.const;
      assert.equal(typeof sessionId, 'string');
      item = { type: 'function_call', id, call_id: `call-${id}`, name: 'session_read',
        arguments: JSON.stringify({ sessionId, view: 'summary' }), status: 'completed' };
    } else if (planning) {
      assert.ok(functions.some(tool => tool.name === 'plan_publish'));
      item = { type: 'function_call', id, call_id: `call-${id}`, name: 'plan_publish', status: 'completed',
        arguments: JSON.stringify({ title: 'Read-only stage validation', summary: 'Confirm the test plan, then answer.',
          steps: [{ stepId: 'answer', title: 'Answer', details: 'Return the fixture completion marker.' }], mutationManifest: [] }) };
    } else item = { type: 'message', id, role: 'assistant', phase: 'final_answer', status: 'completed',
      content: [{ type: 'output_text', text: summary ? 'Checkpoint: stage validation; no project mutations.' : 'stage-complete', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${id}`, status: 'completed',
      usage: { input_tokens: Math.ceil(text.length / 3), output_tokens: 25 } } })}\n\n`);
  } catch (error) {
    fixtureErrors.push(String(error.stack ?? error));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const recipe = { productComponents: [],
  tools: { kernel: ['session.read', 'fs.read', 'web.search'], controls: ['plan.publish', 'interaction.request'], plugins: false },
  permissions: { 'agent.permissions.networkRead': 'allow', 'agent.permissions.workspaceMutation': 'plan' } };

async function task(label, params, expected = 'completed', confirmPlan = false) {
  const frames = [], decisions = new Set();
  let sessionId = params.sessionId;
  const onFrame = async frame => {
    frames.push(frame);
    if (frame.submission) { sessionId = frame.sessionId; sessions.add(sessionId); }
    for (const item of frame.items ?? []) {
      if (item.eventType !== 'plan.published') continue;
      assert.ok(confirmPlan, 'Unexpected Plan decision');
      assert.deepEqual(item.payload.mutationManifest, [], 'Only this read-only test Plan is authorized');
      if (decisions.has(item.payload.planId)) continue;
      decisions.add(item.payload.planId);
      await command(['task', 'respond'], { sessionId, command: { type: 'plan.respond', runId: item.runId,
        planId: item.payload.planId, revision: item.payload.revision, response: { kind: 'confirm' } } });
    }
  };
  const before = requests.length;
  const expectedExit = expected === 'failed' ? 4 : 0;
  if (params.command) {
    // Debug task.submit sends literal text. Shell /plan and /focus shortcuts
    // become typed Session commands, delivered through the existing respond port.
    const subscription = await command(['observe', 'subscribe'], { sessionId });
    await command(['task', 'respond'], { sessionId, command: params.command });
    await debug(['observe', '--subscription-id', subscription.subscriptionId, '--follow'], onFrame, expectedExit);
  } else await debug(['task', 'submit', '--params', '@' + await jsonFile(label, params), '--follow'], onFrame, expectedExit);
  assert.ok(sessionId);
  const projection = await command(['task', 'inspect'], { sessionId });
  assert.equal(projection.run.status, expected, JSON.stringify(projection.terminalError));
  assert.ok(frames.some(frame => frame.items?.some(item => item.eventType === 'run.settled')), 'Follow did not observe settlement');
  assert.deepEqual(fixtureErrors, []);
  if (confirmPlan) assert.equal(decisions.size, 1);
  await writeFile(join(root, `${label}-projection.json`), JSON.stringify(projection, null, 2));
  console.log(`[provider-stages-debug] observed ${label}: ${expected}, Provider requests=${requests.length - before}`);
  return { sessionId, projection, requests: requests.slice(before) };
}

try {
  await debug(['launch', '--artifact', artifact, '--workspace', workspace, '--headless']);
  launched = true;
  const keyFile = join(root, 'fixture-key.txt'); await writeFile(keyFile, 'local-fixture-not-a-real-credential');
  const connection = { id: 'stage-fixture', name: 'Local stage fixture', adapterId: 'custom', billingMode: 'metered',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialKind: 'apiKey' };
  await run(['--host-data-dir', join(stateRoot, 'data'), 'connections', 'set', '--input',
    await jsonFile('connection', { connection }), '--api-key-file', keyFile]);
  for (const id of ['stage-a', 'stage-b', 'stage-disabled', 'stage-small', 'error-http-503', 'error-incomplete']) {
    await run(['--host-data-dir', join(stateRoot, 'data'), 'models', 'set', '--input', await jsonFile(id, {
      id, connectionId: connection.id, name: id, model: id, kind: 'responses', providerFlavor: 'openai',
      enabled: true, contextWindowTokens: id === 'stage-small' ? 4096 : 200000, maxOutputTokens: 512,
      ...(id === 'stage-disabled' ? {} : { hostedWebSearch: 'web_search' }),
    })]);
  }
  const first = await task('ordinary', { text: 'Start stage validation.', profileId: 'stage-a', recipe });
  assert.equal(first.requests.length, 1);
  const switched = await task('handoff', { sessionId: first.sessionId, text: 'Continue using the new model.', profileId: 'stage-b' });
  assert.deepEqual(switched.requests.map(item => [item.reading, item.hosted]), [[true, 0], [false, 1]]);
  assert.equal(switched.projection.contextHandoff.status, 'ready');
  const plan = await task('manual-plan', { sessionId: first.sessionId,
    command: { type: 'message.submit', text: 'Validate the stage with a read-only plan.', planMode: 'manual', profileId: 'stage-b' } }, 'completed', true);
  assert.deepEqual(plan.requests.map(item => [item.planning, item.hosted]), [[true, 0], [false, 1]]);
  const focus = await task('compaction', { sessionId: first.sessionId,
    command: { type: 'context.focus', task: 'Retain the validation result.' } });
  assert.ok(focus.requests.some(item => item.summary && item.hosted === 1 && item.toolChoice === 'none'));
  const disabled = await task('no-hosted-search', { sessionId: first.sessionId, text: 'Continue without hosted search.', profileId: 'stage-disabled' });
  assert.ok(disabled.requests.length >= 2 && disabled.requests.every(item => item.hosted === 0));
  // Stay below the Host's 32 KiB pasted-text attachment threshold, while
  // exceeding this model's 4096-token input/output budget as inline text.
  const oversized = await task('handoff-budget', { sessionId: first.sessionId, text: 'Uncompressible new input. '.repeat(600), profileId: 'stage-small' }, 'failed');
  assert.equal(oversized.projection.terminalError.code, 'context_input_budget_exceeded');
  assert.equal(oversized.requests.length, 0, 'Over-budget handoff reached the Provider');
  assert.equal(oversized.projection.contextHandoff.status, 'reading');
  const errorCases = [];
  for (const [profileId, expectedKind] of [['error-http-503', 'unavailable'], ['error-incomplete', 'providerIncomplete']]) {
    const result = await task(profileId, { text: 'Exercise the local Provider failure fixture.', profileId, recipe }, 'failed');
    assert.equal(result.requests.length, 1, 'Failure must make exactly one Provider request');
    const error = result.projection.terminalError;
    assert.equal(error.diagnostics.source, 'providerTransport');
    assert.equal(error.diagnostics.category, 'provider');
    assert.equal(error.diagnostics.retryable, false);
    if (profileId === 'error-http-503') {
      assert.equal(error.code, 'provider_http_failed');
      assert.deepEqual(error.diagnostics.providerError, { code: '503', status: 'UNAVAILABLE', httpStatus: 503 });
      assert.match(error.message, /Fixture high demand/);
    } else {
      assert.equal(error.code, 'provider_response_failed');
      assert.equal(error.diagnostics.providerError.type, 'response.incomplete');
      assert.match(error.message, /max_output_tokens/);
    }
    const kind = runFailureKind(error);
    assert.equal(kind, expectedKind);
    errorCases.push({ profileId, kind, requestCount: result.requests.length, error });
  }
  await writeFile(join(root, 'report.json'), JSON.stringify({ build, artifact, runtime, cases: 8,
    stageCases: 6, errorCases, requestCount: requests.length, requests, fixtureErrors }, null, 2));
  console.log('[provider-stages-debug] PASS all eight scenarios through the packaged Debug runtime; no real Provider was called.');
} finally {
  await writeFile(join(root, 'requests.json'), JSON.stringify({ requests, fixtureErrors }, null, 2));
  try {
    if (launched) {
      for (const sessionId of sessions) {
        const projection = await command(['task', 'inspect'], { sessionId });
        if (['running', 'waiting'].includes(projection.run?.status)) {
          await command(['task', 'cancel'], { sessionId, runId: projection.run.runId });
        }
      }
      await debug(['stop']);
    }
  } finally { await new Promise(resolveClose => server.close(resolveClose)); }
}
