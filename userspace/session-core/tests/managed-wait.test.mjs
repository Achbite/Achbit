import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const tools = ['bash', 'process', 'fs.read'].map(name => ({toolBindingRef: `binding:${name}`, name,
  origin: 'coreBuiltin', description: name, availability: 'callable', possibleEffects: ['process'],
  inputSchema: {type: 'object', additionalProperties: true, required: [], properties: {}}}));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await setImmediate(); }
  assert.fail('Expected lifecycle boundary was not reached');
}

for (const scenario of ['normal', 'repair', 'user-cancel', 'completion-race', 'batch-yield', 'batch-start', 'explicit-timeout']) test(`dependency wait: ${scenario}`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:wait-${scenario}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const jobs = new Map(); let wake = () => {}, requests = [], commands = [];
  let releaseIndependent;
  const independent = new Promise(resolve => {releaseIndependent = resolve;});
  const update = (id, status) => { const job = jobs.get(id); if (!job || job.status !== 'active') return;
    jobs.set(id, {...job, revision: job.revision + 1, status,
      ...(status === 'active' ? {lastOutputAt: String(Date.now())} : {completedAt: String(Date.now()), result: {exitCode: 0, durationMs: 1, timedOut: false}, ...(status === 'cancelled' ? {error: {code: 'tool_execution_cancelled', message: 'Stopped by the owner'}} : {})})}); wake(); };
  const kernel = emptyKernel({
    async execute(request) {
      commands.push(request);
      if (request.toolName === 'bash' || request.toolName === 'process' && request.input.action === 'start') {
        const id = `job:${jobs.size + 1}`;
        const job = {jobId: id, sessionId, runId: request.runId, callId: request.callId, revision: 1,
          toolName: 'bash', command: 'long build', targets: ['.'], status: 'active', startedAt: String(Date.now()),
          output: {stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false}};
        jobs.set(id, job); wake(); return completedExecutionReply(request, {job});
      }
      if (request.toolName === 'process') {
        if (request.input.action === 'cancel') update(request.input.jobId, 'cancelled');
        const job = jobs.get(request.input.jobId);
        return completedExecutionReply(request, {job, ...(request.input.action === 'wait' ? {wait: {jobId: job.jobId, ...(request.input.timeoutSeconds === undefined ? {} : {timeoutSeconds: request.input.timeoutSeconds})}} : {})});
      }
      return completedExecutionReply(request, {content: 'independent information'});
    },
    async readProcesses(request, signal) {
      if (request.cancel) for (const id of jobs.keys()) update(id, 'cancelled');
      if (request.cancelJobId) update(request.cancelJobId, 'cancelled');
      const changed = () => [...jobs.values()].filter(job => job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision);
      if (request.waitMs && !changed().length && !signal?.aborted) await new Promise(resolve => {
        const done = () => { if (wake === done) wake = () => {}; signal?.removeEventListener('abort', done); resolve(); };
        wake = done; signal?.addEventListener('abort', done, {once: true});
      });
      return structuredClone(changed());
    },
  });
  const provider = {async *stream(request) {
    requests.push(request);
    const call = (name, input) => providerEvent(request.requestId, 'tool.call', {callId: `native:${requests.length}`, name, input});
    const n = requests.length;
    if (n === 1) {
      yield scenario === 'batch-start' ? call('process', {action: 'start', tool: 'bash', input: {command: 'long build'}}) : call('bash', {command: 'long build'});
      if (scenario.startsWith('batch-')) yield providerEvent(request.requestId, 'tool.call', {callId: 'native:peer', name: 'fs_read', input: {path: 'independent.md'}});
    }
    else if (n === 2) { await independent; yield call('fs_read', {path: 'independent.md'}); }
    else if (n === 3) yield call('process', {action: 'wait', jobId: 'job:1', ...(scenario === 'explicit-timeout' ? {timeoutSeconds: 5} : {})});
    else if (scenario === 'repair' && n === 4) yield call('process', {action: 'cancel', jobId: 'job:1'});
    else if (scenario === 'repair' && n === 5) yield call('process', {action: 'start', tool: 'bash', input: {command: 'retry'}});
    else if (scenario === 'repair' && n === 6) yield call('process', {action: 'wait', jobId: 'job:2'});
    else if (scenario === 'explicit-timeout' && n === 4) yield call('process', {action: 'cancel', jobId: 'job:1'});
    else yield providerEvent(request.requestId, 'text.delta', {text: 'Received the actual terminal result.'});
    yield providerEvent(request.requestId, 'completed', {});
  }};
  const actor = actorWith(journal, sessionId, provider, kernel,
    fakeRunPreparation({tools, contextWindowTokens: 40000}).port, `wait-${scenario}`);
  t.after(async () => {releaseIndependent(); for (const id of jobs.keys()) update(id, 'cancelled'); await actor.dispose();});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  await actor.submit(messageCommand(sessionId, 'command:begin', 'Build, inspect independent information, then await the dependency.'));
  await until(async () => { const p = await actor.snapshot(); if (p.run?.status === 'failed') assert.fail(JSON.stringify(p.failureSnapshot?.error)); return requests.length === 2; });
  t.mock.timers.tick(300_000);
  assert.equal(requests.length, 2, 'a long background command does not create a model review while the Loop is active');
  assert.equal((await readEvents(journal, sessionId)).some(e => e.type === 'process.wait.changed'), false);
  releaseIndependent();
  const waits = async () => (await readEvents(journal, sessionId)).filter(e => e.type === 'process.wait.changed');
  await until(async () => (await waits()).at(-1)?.payload.phase === 'waiting');
  const first = (await waits())[0].payload;
  assert.equal(first.reviewAt - first.startedAt, 120_000);
  assert.equal(first.reviewed, false);
  if (scenario === 'explicit-timeout') {
    t.mock.timers.tick(4_999); update('job:1', 'active'); await setImmediate();
    assert.equal(requests.length, 3, 'an explicit wait remains pending until its chosen deadline');
    t.mock.timers.tick(1);
  } else {
    t.mock.timers.tick(119_999); update('job:1', 'active'); await setImmediate();
    assert.equal(requests.length, 3, 'output or revisions do not request the model');
    if (scenario === 'user-cancel') {
      const job = jobs.get('job:1');
      const reply = await actor.submit({schemaVersion: 'achbit.command.v3', type: 'tool.cancel',
        sessionId, runId: job.runId, callId: job.callId, commandId: 'command:stop-tool'});
      assert.equal(reply.status, 'accepted');
    } else if (scenario === 'completion-race') {
      update('job:1', 'completed'); t.mock.timers.tick(1);
    } else {
      t.mock.timers.tick(1);
      await until(async () => (await waits()).at(-1)?.payload.reviewed === true);
      assert.equal((await waits()).at(-1).payload.phase, 'waiting');
      assert.equal(requests.length, 3, 'a healthy Host check does not wake the model');
      t.mock.timers.tick(600_000); update('job:1', 'active'); await setImmediate();
      assert.equal(requests.length, 3, 'healthy work continues without timed model reviews');
      if (scenario === 'repair') {
        const reply = await actor.submit(messageCommand(sessionId, 'command:repair', 'Cancel the current build and restart it, then wait for its result.'));
        assert.equal(reply.status, 'accepted');
        await until(async () => requests.length === 6 && (await waits()).at(-1)?.payload.phase === 'waiting');
        assert.equal((await waits()).at(-1).payload.waitId, first.waitId, 'a user-requested repair retains the logical wait identity');
      }
      update(scenario === 'repair' ? 'job:2' : 'job:1', 'completed');
    }
  }
  await until(async () => (await actor.snapshot()).run?.status === 'completed');
  assert.equal((await waits()).filter(e => e.payload.phase === 'review').length, 0);
  assert.ok(requests.every(request => request.messages.every(message => !message.content.includes('process.wait.review'))),
    'Host health checks never enter model context');
  assert.equal(requests.length, scenario === 'repair' ? 7 : scenario === 'explicit-timeout' ? 5 : 4);
  if (scenario === 'explicit-timeout') assert.equal(jobs.get('job:1').status, 'cancelled', 'an explicit timeout still resumes model decisions');
  if (scenario === 'user-cancel') assert.equal(jobs.get('job:1').status, 'cancelled');
  assert.equal(commands.filter(c => c.toolName === 'fs.read').length, scenario === 'batch-start' ? 2 : 1);
  if (scenario === 'batch-yield') {
    const skipped = (await readEvents(journal, sessionId)).filter(e => e.type === 'tool.not-executed');
    assert.equal(skipped.length, 1); assert.equal(skipped[0].payload.reason, 'dependencyPending');
    assert.equal(requests[1].messages.filter(m => m.role === 'tool').length, 2, 'every batch call has a paired result before the model resumes');
  }
});
