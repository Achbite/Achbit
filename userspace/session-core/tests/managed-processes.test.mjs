import { messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, waitForProjection, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const processTool = { toolBindingRef: 'binding:process', name: 'process', description: 'Manage a command',
  origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['process'],
  inputSchema: {type: 'object', required: ['action'], properties: {action: {type: 'string'}, input: {type: 'object'}}} };

for (const ending of ['completed', 'cancelled', 'watch-failed']) test(`managed command: ${ending}`, async t => {
  const stop = ending !== 'completed';
  const watchFailure = ending === 'watch-failed';
  const journal = new InMemoryCommandJournal();
  const sessionId = `session:managed-${ending}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  let job;
  let wake = () => {};
  let failWatch;
  const watchError = new Error('managed process feed disconnected');
  let calls = 0;
  let closed = false;
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', {callId: 'process-start', name: 'process',
      input: {action: 'start', tool: 'bash', input: {command: 'build'}}});
    else yield providerEvent(request.requestId, 'text.delta', {text: calls === 2 ? 'Premature answer.' : 'Build result received.'});
    yield providerEvent(request.requestId, 'completed', {});
  }};
  const finish = status => {
    if (!job || job.status !== 'active') return;
    job = {...job, revision: job.revision + 1, status, completedAt: String(Date.now()),
      result: {exitCode: status === 'completed' ? 0 : null, durationMs: 20, timedOut: false},
      ...(status === 'cancelled' ? {error:{code:'tool_execution_cancelled',message:'Cancelled by run owner'}} : {})};
    wake();
  };
  const kernel = emptyKernel({
    async execute(request) {
      job = {jobId: 'job:one', sessionId, runId: request.runId, callId: request.callId, revision: 1,
        toolName: 'bash', command: 'build', targets: ['.'], status: 'active', startedAt: String(Date.now()),
        output: {stdout: 'building\n', stderr: '', stdoutBytes: 9, stderrBytes: 0, truncated: false}};
      wake();
      const reply = completedExecutionReply(request, {job});
      reply.record.preparedEffect.providerRef = 'achbit:processes';
      reply.record.preparedEffect.operation = 'bash';
      reply.record.preparedEffect.logicalTargets = ['.'];
      return reply;
    },
    async readProcesses(request, signal) {
      if (request.cancel) { closed = true; finish('cancelled'); }
      const changed = () => job && job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision;
      if (request.waitMs && !changed()) {
        await new Promise((resolve, reject) => {
          const release = () => { if (wake === release) wake = () => {}; signal?.removeEventListener('abort', release); resolve(); };
          failWatch = () => { reject(watchError); release(); };
          wake = release; signal?.addEventListener('abort', release, {once:true});
          if (signal?.aborted) release();
        });
      }
      return changed() ? [structuredClone(job)] : [];
    },
  });
  const preparation = fakeRunPreparation({tools: [processTool], contextWindowTokens: 20000});
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, `managed-${stop}`);
  t.after(async () => { finish('cancelled'); wake(); await actor.dispose(); });
  const message = messageCommand(sessionId, 'command:start', 'Build with a managed process.');
  await actor.submit(message);
  const active = await waitForProjection(actor, p => p.activities.some(a => a.tool?.process && a.status === 'active'));
  while (calls < 2) await delay(5);
  await delay(50);
  assert.equal(calls, 2, 'waiting for a process does not keep requesting the model');
  assert.equal((await actor.snapshot()).messages.some(m => m.content === 'Premature answer.'), true, 'valid generated text persists while the process still prevents settlement');
  assert.equal((await actor.snapshot()).run.status, 'running');
  if (watchFailure) failWatch();
  else if (stop) await actor.submit({schemaVersion:'achbit.command.v3', type:'run.cancel', commandId:'command:stop', sessionId, runId:active.run.runId});
  else finish('completed');
  const final = await waitForProjection(actor, p => ['completed','cancelled','failed'].includes(p.run?.status));
  assert.equal(final.run.status, watchFailure ? 'failed' : ending);
  const activity = final.activities.find(a => a.tool?.process);
  assert.equal(activity.status, stop ? 'cancelled' : 'completed');
  assert.equal(activity.liveOutput, undefined);
  assert.equal(activity.tool.process.output.stdout, 'building\n');
  assert.equal(closed, true);
  if (!stop) {
    assert.equal(calls, 3);
    assert.deepEqual(requests[2].messages.slice(0, requests[1].messages.length), requests[1].messages,
      'a process update must append facts without rewriting the previous request');
    const updates = requests[2].messages.slice(requests[1].messages.length)
      .filter(m => m.role === 'user').map(m => JSON.parse(m.content));
    assert.ok(updates.some(m => m.type === 'process.updated' && m.process.status === 'completed'));
  }
  const updates = (await readEvents(journal,sessionId)).filter(e => e.type === 'process.updated');
  assert.equal(updates.filter(e => e.payload.job.status !== 'active').length,1);
  assert.equal(preparation.released.length,1);
  if (watchFailure) {
    const settled = (await readEvents(journal, sessionId)).find(e => e.type === 'run.settled');
    assert.equal(settled.payload.error.message, watchError.message);
    const reply = await actor.submit(messageCommand(sessionId, 'command:next', 'Continue after the failed run.'));
    assert.equal(reply.status, 'accepted');
    await waitForProjection(actor, p => p.run?.runId !== active.run.runId && p.run?.status === 'completed');
    assert.equal(preparation.released.length, 2);
  }
});

function activeJobReply(request) {
  const job = { jobId: 'job:question', sessionId: request.sessionId, runId: request.runId, callId: request.callId, revision: 1,
    toolName: 'bash', command: 'prepare', targets: ['.'], status: 'active', startedAt: String(Date.now()),
    output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
  const reply = completedExecutionReply(request, { job });
  reply.record.preparedEffect.providerRef = 'achbit:processes';
  reply.record.preparedEffect.operation = 'bash';
  reply.record.preparedEffect.logicalTargets = ['.'];
  return { job, reply };
}

test('managed process feed failure during a question settles the run and accepts the next input', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:waiting-process-failure';
  await createSession(journal, sessionId, [workspaceBinding]);
  const watchError = new Error('waiting process feed disconnected');
  let failWatch, job, calls = 0, closures = 0;
  const preparation = fakeRunPreparation({ tools: [processTool], contextWindowTokens: 20000 });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'process:start', name: 'process', input: { action: 'start', tool: 'bash', input: { command: 'prepare' } } });
    else if (calls === 2) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:question', name: 'interaction_request',
      input: { kind: 'question', prompt: 'Choose the next action.', allowFreeform: true } });
    else yield providerEvent(request.requestId, 'text.delta', {text: 'Next run completed.'});
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { const started = activeJobReply(request); job = started.job; return started.reply; },
    async readProcesses(request, signal) {
    if (request.cancel) { closures++; job = { ...job, revision: job.revision + 1, status: 'cancelled', completedAt: String(Date.now()), error: { code: 'tool_execution_cancelled', message: 'Cancelled' } }; }
    const changed = () => job && job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision;
    if (request.waitMs && !changed() && !signal.aborted) await new Promise((resolve, reject) => {
      const stop = () => { signal.removeEventListener('abort', stop); resolve(); };
      signal.addEventListener('abort', stop, { once: true });
      failWatch = () => { reject(watchError); stop(); };
    });
    return changed() ? [structuredClone(job)] : [];
  } }), preparation.port, 'waiting-process-failure');
  t.after(() => actor.dispose());
  const message = messageCommand(sessionId, 'command:start', 'Ask before the next step.');
  await actor.submit(message);
  const waiting = await waitForProjection(actor, p => p.run?.status === 'waiting');
  failWatch();
  await waitForProjection(actor, p => p.run?.status === 'failed');
  assert.equal(closures, 1);
  assert.equal(preparation.released.length, 1);
  const settled = (await readEvents(journal, sessionId)).find(e => e.type === 'run.settled');
  assert.equal(settled.payload.error.message, watchError.message);
  assert.equal((await actor.submit(messageCommand(sessionId, 'command:next', 'Continue.'))).status, 'accepted');
  await waitForProjection(actor, p => p.run?.runId !== waiting.run.runId && p.run?.status === 'completed');
  assert.equal(preparation.released.length, 2);
});

test('Actor disposal releases its composition when managed process closure fails and preserves both errors', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:dispose-process-failure';
  await createSession(journal, sessionId, [workspaceBinding]);
  const closeError = new Error('Managed process closure failed.');
  const compositionError = new Error('Composition disposal failed.');
  let compositionDisposals = 0, disposed = false, job, calls = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'process:start', name: 'process', input: { action: 'start', tool: 'bash', input: { command: 'prepare' } } });
    else yield providerEvent(request.requestId, 'tool.call', { callId: 'native:question', name: 'interaction_request',
      input: { kind: 'question', prompt: 'Choose the next action.', allowFreeform: true } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { const started = activeJobReply(request); job = started.job; return started.reply; },
    async readProcesses(request, signal) {
    if (request.cancel) throw closeError;
    const changed = () => job && request.revisions?.[job.jobId] !== job.revision;
    if (request.waitMs && !changed() && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return changed() ? [structuredClone(job)] : [];
  } }), fakeRunPreparation({ tools: [processTool], contextWindowTokens: 20000 }).port,
  'dispose-process-failure', () => { compositionDisposals++; throw compositionError; });
  t.after(async () => { if (!disposed) await actor.dispose(); });
  const message = messageCommand(sessionId, 'command:start', 'Ask before the next step.');
  await actor.submit(message);
  await waitForProjection(actor, projection => projection.run?.status === 'waiting');
  disposed = true;
  await assert.rejects(actor.dispose(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'session_actor_dispose_failed');
    assert.deepEqual(error.errors, [closeError, compositionError]);
    return true;
  });
  assert.equal(compositionDisposals, 1);
});


test('process heartbeats retain journal facts without repeating unchanged model context', () => {
  const events = [], sessionId = 'session:process-heartbeat', runId = 'run:process-heartbeat';
  const add = (type, payload) => events.push({ type, payload, sessionId, runId,
    eventId: `event:${events.length + 1}`, sequence: events.length + 1, occurredAt: '2026-10-26T00:00:00Z' });
  let job = { jobId: 'job:heartbeat', sessionId, runId, callId: 'call:heartbeat', revision: 1,
    toolName: 'bash', command: 'build', targets: ['.'], status: 'active', startedAt: '1',
    output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
  const freeze = contributions => {
    const seen = new Set(events.filter(event => event.type === 'context.composed')
      .flatMap(event => event.payload.modelView.additions.map(value => value.contributionId)));
    add('context.composed', { purpose: 'agent', modelView: { throughSequence: events.length,
      additions: structuredClone(contributions.filter(value => !seen.has(value.contributionId))) } });
  };
  const render = () => messagesFromJournal(events, runId, []);
  add('process.updated', { job });
  const initial = render();
  assert.equal(initial.length, 1);
  freeze(initial);
  job = { ...job, revision: 2 };
  add('process.updated', { job });
  assert.deepEqual(render(), initial, 'a heartbeat-only revision does not append a user message');
  freeze(render());
  job = { ...job, revision: 3, lastOutputAt: '2', output: { ...job.output, stdout: 'compiled 1 file', stdoutBytes: 15 } };
  add('process.updated', { job });
  const progress = render();
  assert.deepEqual(progress.slice(0, initial.length), initial, 'the previously observed process snapshot is immutable');
  assert.equal(progress.length, 2);
  assert.equal(JSON.parse(progress.at(-1).message.content).process.output.stdout, 'compiled 1 file');
  freeze(progress);
  job = { ...job, revision: 4 };
  add('process.updated', { job });
  add('message.committed', { messageId: 'message:user', role: 'user', content: 'Please also report the compiler version.' });
  const withInput = render();
  assert.equal(withInput.length, 3, 'real user input remains present while the duplicate process update is omitted');
  assert.equal(withInput.at(-1).message.content, 'Please also report the compiler version.');
  freeze(withInput);
  job = { ...job, revision: 5, status: 'failed', completedAt: '3',
    error: { code: 'build_failed', message: 'Compiler exited with status 1.' }, result: { exitCode: 1, durationMs: 2000, timedOut: false } };
  add('process.updated', { job });
  const failed = render();
  assert.equal(failed.length, 4);
  assert.equal(JSON.parse(failed.at(-1).message.content).process.status, 'failed');
  assert.equal(JSON.parse(failed.at(-1).message.content).process.error.message, 'Compiler exited with status 1.');
  freeze(failed);
  add('process.updated', { job: { ...job, revision: 6 } });
  assert.deepEqual(render(), failed, 'a terminal heartbeat does not erase or repeat the failure');
  assert.equal(events.filter(event => event.type === 'process.updated').length, 6, 'all canonical heartbeat facts remain in the journal');
});
