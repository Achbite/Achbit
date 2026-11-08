import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { SessionService } from '../dist/index.js';
import { inputAfter } from '../dist/local-agent/sessionWake.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { completedExecutionReply, emptyKernel, fakeRunPreparation, messageCommand,
  providerEvent, readEvents, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

const tools = ['process', 'fs.read'].map(name => ({ toolBindingRef: `binding:${name}`, name,
  origin: 'coreBuiltin', description: name, availability: 'callable', possibleEffects: [],
  inputSchema: { type: 'object', additionalProperties: true, properties: {} } }));
const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 2,
  maxCallsPerRun: 4, maxMembersPerSession: 2, allowMemberAnalysis: false, allowFullConfiguration: false, presets: '[]' };
const model = { profileId: 'profile:default', name: 'Fixture', model: 'fixture-model', reasoningEfforts: ['low', 'medium', 'high'],
  parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 40000,
    maxOutputTokens: 512, imageInput: false, temperature: null, hostedWebSearch: null } };

test('dependency wake consumes only a new terminal process fact in the current run', () => {
  const fact = (sequence, runId, status) => ({ sequence, runId, type: 'process.updated', payload: { job: { status } } });
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(inputAfter([fact(8, 'run:current', status)], 'run:current', 7), true);
    assert.equal(inputAfter([fact(8, 'run:current', status)], 'run:current', 8), false, 'the request boundary has consumed the result');
    assert.equal(inputAfter([fact(9, 'run:old', status)], 'run:current', 7), false, 'another run cannot resume this wait');
  }
  assert.equal(inputAfter([fact(9, 'run:current', 'active')], 'run:current', 7), false, 'output and heartbeat snapshots are not completion');
});

for (const ending of ['completed', 'failed', 'cancelled']) test(`managed ${ending} resumes agent wait before the child finishes, without progress or replay polling`, async t => {
  const ownerId = `session:mixed-wake-${ending}`, journal = new InMemoryCommandJournal();
  const childGate = Promise.withResolvers(), childEntered = Promise.withResolvers();
  let service, job, duplicate, deliveredDuplicates = 0, wake = () => {}, independentReads = 0;
  const requests = [], releases = new Map();
  const update = status => {
    job = { ...job, revision: job.revision + 1, status,
      ...(status === 'active' ? { lastOutputAt: String(Date.now()), output: { ...job.output, stdout: 'still running', stdoutBytes: 13 } }
        : { completedAt: String(Date.now()), result: { exitCode: status === 'completed' ? 0 : null, durationMs: 10, timedOut: false },
          ...(status === 'completed' ? {} : { error: { code: status === 'cancelled' ? 'tool_execution_cancelled' : 'tool_execution_failed', message: `Owned command ${status}` } }) }) };
    wake();
  };
  const kernel = emptyKernel({
    async execute(request) {
      if (request.toolName === 'fs.read') {
        independentReads++;
        return completedExecutionReply(request, { content: 'Independent work used the Shell result.' });
      }
      assert.equal(request.toolName, 'process');
      assert.equal(request.input.action, 'start');
      job = { jobId: `job:${ending}`, sessionId: ownerId, runId: request.runId, callId: request.callId, revision: 1,
        toolName: 'bash', command: 'owned command', targets: ['.'], status: 'active', startedAt: String(Date.now()),
        output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
      wake();
      return completedExecutionReply(request, { job });
    },
    async readProcesses(request, signal) {
      if (request.cancel && job?.status === 'active') update('cancelled');
      const changed = () => job && job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision;
      if (request.waitMs && !changed() && !duplicate && !signal?.aborted) await new Promise(resolve => {
        const done = () => { if (wake === done) wake = () => {}; signal?.removeEventListener('abort', done); resolve(); };
        wake = done; signal?.addEventListener('abort', done, { once: true });
      });
      if (duplicate) { const replay = duplicate; duplicate = undefined; deliveredDuplicates++; return [replay]; }
      return changed() ? [structuredClone(job)] : [];
    },
  });
  service = new SessionService(journal, { async create({ sessionId }) {
    const preparation = fakeRunPreparation({ tools: sessionId === ownerId ? tools : [], contextWindowTokens: 40000 });
    return { composition: {
      kernel: sessionId === ownerId ? kernel : emptyKernel(),
      runPreparation: { ...preparation.port,
        async prepare(input) {
          const prepared = await preparation.port.prepare(input);
          prepared.runtimeSnapshot.agentToolsEnabled = true;
          const creation = (await readEvents(journal, sessionId))[0];
          if (creation.payload.agentContext) prepared.runtimeSnapshot.agentCapabilities = creation.payload.agentContext.capabilities;
          return prepared;
        },
        async release(input) { releases.set(sessionId, (releases.get(sessionId) ?? 0) + 1); return preparation.port.release(input); },
      },
      provider: { async *stream(request, signal) {
        if (sessionId !== ownerId) {
          childEntered.resolve(sessionId);
          const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          await Promise.race([childGate.promise, aborted]);
          signal.throwIfAborted();
          yield providerEvent(request.requestId, 'text.delta', { text: 'Child analysis completed.' });
        } else {
          requests.push(request);
          const turn = requests.length;
          const call = (name, input) => providerEvent(request.requestId, 'tool.call', { callId: `root:${turn}`, name, input });
          if (turn === 1) yield call('process', { action: 'start', tool: 'bash', input: { command: 'owned command' } });
          else if (turn === 2) yield call('agent', { action: 'spawn', name: 'Analyst', task: 'Return independent analysis.', delivery: 'async' });
          else if (turn === 3 || turn === 5) yield call('agent', { action: 'wait' });
          else if (turn === 4) {
            assert.equal((await service.snapshot(ownerId)).agentTasks[0].status, 'running', 'Shell completion must resume the parent before child completion');
            const processResults = request.messages.filter(message => message.role === 'user').flatMap(message => {
              try { const content = JSON.parse(message.content); return content.process ? [content.process] : []; } catch { return []; }
            });
            assert.equal(processResults.filter(result => result.status === ending).length, 1, 'the new terminal result is delivered once');
            yield call('fs_read', { path: 'independent.txt' });
          } else {
            assert.equal(turn, 6, 'no extra model requests while either dependency is unchanged');
            yield providerEvent(request.requestId, 'text.delta', { text: 'Both independent results consumed.' });
          }
        }
        yield providerEvent(request.requestId, 'completed', {});
      } },
      async dispose() {},
    } };
  } }, { async settings() { return settings; }, async models() { return [model]; },
    async createSession(input) { return service.createSession(input); } });
  t.after(async () => { childGate.resolve(); if (job?.status === 'active') update('cancelled'); wake(); await service.dispose(); });
  await service.createSession({ sessionId: ownerId, displayTitle: 'Mixed resource wake', workspaceBindings: [workspaceBinding] });
  await service.submit(messageCommand(ownerId, 'command:start', 'Run a Shell task and child analysis independently.'));
  const childId = await childEntered.promise;
  const hasWait = async turn => (await readEvents(journal, ownerId)).some(event => event.type === 'agent.control.completed'
    && event.payload.providerCallId === `root:${turn}` && event.payload.operation.action === 'wait');
  await waitUntil(() => hasWait(3), 'first child dependency wait');
  update('active');
  update('active');
  await waitUntil(async () => (await readEvents(journal, ownerId)).some(event => event.type === 'process.updated' && event.payload.job.revision === 3), 'active progress reaches the journal');
  await setImmediate(); await setImmediate();
  assert.equal(requests.length, 3, 'active/progress/heartbeat facts do not request the model');
  update(ending);
  await waitUntil(() => hasWait(5), 'Shell result consumed and the child dependency re-entered');
  assert.equal(independentReads, 1, 'parent performs independent work while the child remains active');
  assert.equal((await service.snapshot(ownerId)).agentTasks[0].status, 'running');
  const beforeReplay = (await readEvents(journal, ownerId)).filter(event => event.type === 'process.updated').length;
  duplicate = structuredClone(job); wake();
  await waitUntil(() => deliveredDuplicates === 1, 'duplicate terminal snapshot delivered');
  await setImmediate(); await setImmediate();
  assert.equal(requests.length, 5, 'consumed completion does not spin the Loop');
  assert.equal((await readEvents(journal, ownerId)).filter(event => event.type === 'process.updated').length, beforeReplay,
    'duplicate revision does not become another journal fact');
  childGate.resolve();
  await waitUntil(async () => (await service.snapshot(ownerId)).run?.status === 'completed', 'parent completion after child result');
  assert.equal(requests.length, 6);
  assert.equal(releases.get(ownerId), 1);
  assert.equal(releases.get(childId), 1);
  const events = await readEvents(journal, ownerId);
  assert.equal(events.filter(event => event.type === 'process.updated' && event.payload.job.status !== 'active').length, 1);
  assert.equal(events.filter(event => event.type === 'agent.task.completed').length, 1);
});
