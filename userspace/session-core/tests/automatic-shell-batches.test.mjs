import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tools = ['powershell', 'bash', 'process', 'fs.read', 'fs.write'].map(name => ({
  name, toolBindingRef: `binding:${name}`, origin: 'coreBuiltin', description: name,
  availability: 'callable', possibleEffects: ['process'], inputSchema: { type: 'object', additionalProperties: true, required: [], properties: {} },
}));
async function until(predicate, diagnostic = async () => undefined) {
  for (let i = 0; i < 600; i++) { if (await predicate()) return; await setImmediate(); }
  assert.fail(`Expected event boundary was not reached: ${JSON.stringify(await diagnostic())}`);
}
function processes() {
  const jobs = new Map(); let wake = () => {};
  return {
    jobs,
    start(request) {
      const job = { jobId: `job:${request.input.command}`, sessionId: request.sessionId, runId: request.runId,
        callId: request.callId, revision: 1, toolName: request.toolName, command: request.input.command,
        targets: ['.'], status: 'active', startedAt: String(Date.now()),
        output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
      jobs.set(job.jobId, job); wake(); return completedExecutionReply(request, { job });
    },
    finish(id, status = 'completed') {
      const job = jobs.get(id); if (job?.status !== 'active') return;
      const stdout = `${id}:actual-result`;
      jobs.set(id, { ...job, status, revision: job.revision + 1, completedAt: String(Date.now()),
        output: { stdout, stderr: '', stdoutBytes: stdout.length, stderrBytes: 0, truncated: false },
        result: { exitCode: status === 'completed' ? 0 : 3, durationMs: 5000, timedOut: false },
        ...(status === 'completed' ? {} : { error: { code: 'shell_failed', message: 'Actual command failure' } }) });
      wake();
    },
    async readProcesses(request, signal) {
      if (request.cancel) for (const id of jobs.keys()) this.finish(id, 'cancelled');
      const changed = () => [...jobs.values()].filter(job => job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision);
      if (request.waitMs && !changed().length && !signal?.aborted) await new Promise(resolve => {
        const done = () => { if (wake === done) wake = () => {}; signal?.removeEventListener('abort', done); resolve(); };
        wake = done; signal?.addEventListener('abort', done, { once: true });
      });
      return structuredClone(changed());
    },
  };
}
const terminalResults = request => request.messages.filter(m => m.role === 'user' && m.content.startsWith('{'))
  .flatMap(m => { try { const p = JSON.parse(m.content).process; return p ? [p] : []; } catch { return []; } });

for (const phase of ['read', 'mutation']) for (const ending of ['completed', 'failed']) {
  test(`automatic Shell overlaps ${phase} calls and collects ${ending} without polling`, async t => {
    const journal = new InMemoryCommandJournal(), sessionId = `session:auto-${phase}-${ending}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const foreground = gate(), started = [], files = new Map(), requests = [], feed = processes();
    const shell = phase === 'read' ? 'powershell' : 'bash';
    const kernel = emptyKernel({
      async execute(request) {
        started.push(request);
        if (request.toolName === shell) { await foreground.promise; return feed.start(request); }
        assert.notEqual(request.toolName, 'process', 'normal execution needs no process start/status/wait calls');
        if (request.toolName === 'fs.write') {
          if (request.input.content === 'second') assert.equal(files.get('a'), 'first');
          files.set(request.input.path, request.input.content);
          return completedExecutionReply(request, { saved: true });
        }
        return completedExecutionReply(request, { content: `read:${request.input.path}` });
      },
      readProcesses: feed.readProcesses.bind(feed),
    });
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      requests.push(request);
      const n = requests.length;
      const call = (id, name, input) => providerEvent(request.requestId, 'tool.call', { callId: id, name, input });
      if (n === 1) {
        yield call('command', shell, { command: 'build' });
        if (phase === 'read') {
          yield call('a', 'fs_read', { path: 'a' });
          yield call('b', 'fs_read', { path: 'b' });
        } else {
          yield call('a', 'fs_write', { path: 'a', content: 'first' });
          yield call('b', 'fs_write', { path: 'b', content: 'independent' });
          yield call('a-again', 'fs_write', { path: 'a', content: 'second' });
        }
      } else if (n === 2) {
        assert.equal(request.messages.filter(m => m.role === 'tool').length, phase === 'read' ? 3 : 4);
        assert.doesNotMatch(JSON.stringify(request.messages), /dependencyPending/);
        assert.equal(feed.jobs.get('job:build').status, 'active');
        yield call('unrelated', 'fs_write', { path: 'unrelated', content: 'work while building' });
      } else if (n === 3) {
        assert.equal(files.get('unrelated'), 'work while building');
        yield providerEvent(request.requestId, 'text.delta', { text: 'Independent work complete; build results remain outstanding.' });
      } else {
        assert.equal(n, 4, 'only a real terminal result resumes automatic collection');
        const results = terminalResults(request);
        assert.equal(results.length, 1);
        assert.equal(results[0].status, ending);
        assert.equal(results[0].stdout, 'job:build:actual-result');
        assert.equal(results[0].exitCode, ending === 'completed' ? 0 : 3);
        yield providerEvent(request.requestId, 'text.delta', { text: `Build outcome received: ${ending}.` });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } }, kernel, fakeRunPreparation({ tools, contextWindowTokens: 80000 }).port, `auto-${phase}-${ending}`);
    t.after(async () => { foreground.resolve(); for (const id of feed.jobs.keys()) feed.finish(id, 'cancelled'); await actor.dispose(); });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    await actor.submit(messageCommand(sessionId, 'command:start', 'Build and operate on independent files.'));
    await until(async () => (await readEvents(journal, sessionId)).filter(e => e.type === 'tool.completed').length === (phase === 'read' ? 2 : 3),
      async () => { const p = await actor.snapshot(); return { run: p.run, error: p.terminalError, activities: p.activities }; });
    assert.equal(requests.length, 1);
    assert.equal(feed.jobs.size, 0, 'files complete even before Shell produces its foreground receipt');
    foreground.resolve();
    await until(async () => (await readEvents(journal, sessionId)).some(e => e.type === 'process.wait.changed' && e.payload.phase === 'waiting'));
    assert.equal(requests.length, 3);
    t.mock.timers.tick(600_000);
    await setImmediate();
    assert.equal(requests.length, 3, 'ten idle minutes never request a model status review');
    assert.equal((await actor.snapshot()).run.status, 'running');
    feed.finish('job:build', ending);
    await until(async () => (await actor.snapshot()).run?.status === 'completed');
    const events = await readEvents(journal, sessionId);
    assert.equal(events.some(e => e.type === 'tool.not-executed'), false);
    assert.equal(events.filter(e => e.type === 'process.updated' && e.payload.job.status !== 'active').length, 1);
    assert.equal(events.filter(e => e.type === 'run.settled').length, 1);
    assert.equal(started.filter(r => r.input.path === 'unrelated').length, 1);
  });
}

test('a completion during generation is delivered before waiting for the remaining job', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:auto-partial-completion';
  await createSession(journal, sessionId, [workspaceBinding]);
  const providerBusy = gate(), commands = [], requests = [], feed = processes();
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      for (const command of ['first', 'second']) yield providerEvent(request.requestId, 'tool.call', {
        callId: command, name: 'powershell', input: { command } });
    } else {
      if (requests.length === 2) await providerBusy.promise;
      if (requests.length === 3) {
        assert.deepEqual(terminalResults(request).map(job => job.jobId), ['job:first']);
        assert.equal(feed.jobs.get('job:second').status, 'active');
      }
      if (requests.length === 4) assert.deepEqual(terminalResults(request).map(job => job.jobId), ['job:first', 'job:second']);
      assert.ok(requests.length <= 4);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Current results processed.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { commands.push(request); return feed.start(request); },
    readProcesses: feed.readProcesses.bind(feed) }), fakeRunPreparation({ tools, contextWindowTokens: 80000 }).port, 'auto-partial');
  t.after(async () => { providerBusy.resolve(); for (const id of feed.jobs.keys()) feed.finish(id, 'cancelled'); await actor.dispose(); });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Build two independent modules.'));
  await until(() => requests.length === 2,
    async () => { const p = await actor.snapshot(); return { run: p.run, error: p.terminalError, activities: p.activities }; });
  feed.finish('job:first');
  providerBusy.resolve();
  await until(async () => requests.length === 3 && (await readEvents(journal, sessionId)).some(e => e.type === 'process.wait.changed' && e.payload.phase === 'waiting'));
  t.mock.timers.tick(600_000); await setImmediate();
  assert.equal(requests.length, 3);
  feed.finish('job:second');
  await until(async () => (await actor.snapshot()).run?.status === 'completed');
  assert.equal(requests.length, 4);
  assert.equal(commands.length, 2, 'no polling or duplicated executions');
});
