import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, completedExecutionReply, readEvents, waitUntil } from './local-agent-fixtures.mjs';

const pluginTool = 'mcp.fixture.analyze';
const businessResult = { content: [{ type: 'text', text: 'PLUGIN_RESULT_DONE' }],
  structuredContent: { count: 7, rows: [{ id: 'row:1', status: 'accepted' }] },
  metadata: { producer: 'fixture-mcp', format: 'business-record' }, isError: false };
const tools = [
  { name: 'process', origin: 'coreBuiltin', inputSchema: { type: 'object', required: ['action'], properties: {
    action: { type: 'string', enum: ['start', 'wait', 'status', 'cancel'] },
    tool: { type: 'string', enum: [pluginTool] }, input: { type: 'object' }, jobId: { type: 'string' } } } },
  { name: 'fs.read', origin: 'coreBuiltin', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: pluginTool, origin: 'extension', pluginUri: 'plugin://fixture@mcp', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
].map(tool => ({ ...tool, toolBindingRef: `binding:${tool.name}`, description: tool.name,
  availability: 'callable', possibleEffects: [] }));

test('a background MCP result appends its business content once while independent work and cached context remain intact', async t => {
  const sessionId = 'session:managed-plugin-result', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const independentGate = Promise.withResolvers(), answerGate = Promise.withResolvers();
  const requests = [];
  let job, duplicate, duplicated = 0, wake = () => {}, independentReads = 0, closed = false;
  const update = status => {
    job = { ...job, revision: job.revision + 1, status,
      ...(status === 'active' ? { lastOutputAt: String(Date.now()),
        output: { ...job.output, stdout: 'PRIVATE_PROGRESS_ONLY', stdoutBytes: 21 } }
        : { completedAt: String(Date.now()), result: structuredClone(businessResult) }) };
    wake();
  };
  const kernel = emptyKernel({
    async execute(request) {
      if (request.toolName === 'fs.read') {
        assert.equal(job.status, 'active', 'independent read executes before the plugin finishes');
        independentReads++;
        return completedExecutionReply(request, { content: 'INDEPENDENT_READ_DONE' });
      }
      assert.equal(request.toolName, 'process');
      assert.deepEqual(request.input, { action: 'start', tool: pluginTool, input: { query: 'seven records' } });
      job = { jobId: 'job:plugin', sessionId, runId: request.runId, callId: request.callId, revision: 1,
        toolName: pluginTool, command: pluginTool, targets: [], status: 'active', startedAt: String(Date.now()),
        output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
      const reply = completedExecutionReply(request, { job });
      reply.record.preparedEffect.providerRef = 'achbit:processes';
      reply.record.preparedEffect.operation = pluginTool;
      wake();
      return reply;
    },
    async readProcesses(request, signal) {
      if (request.cancel) closed = true;
      const changed = () => job && job.runId === request.runId && request.revisions?.[job.jobId] !== job.revision;
      if (request.waitMs && !changed() && !duplicate && !signal?.aborted) await new Promise(resolve => {
        const release = () => { if (wake === release) wake = () => {}; signal?.removeEventListener('abort', release); resolve(); };
        wake = release; signal?.addEventListener('abort', release, { once: true });
      });
      if (duplicate) { const replay = duplicate; duplicate = undefined; duplicated++; return [replay]; }
      return changed() ? [structuredClone(job)] : [];
    },
  });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const turn = requests.length;
    const call = (name, input) => providerEvent(request.requestId, 'tool.call', { callId: `call:${turn}`, name, input });
    if (turn === 1) yield call('process', { action: 'start', tool: pluginTool, input: { query: 'seven records' } });
    else if (turn === 2) {
      await independentGate.promise;
      yield call('fs_read', { path: 'independent.txt' });
    } else if (turn === 3) {
      assert.equal(independentReads, 1);
      assert.equal(job.status, 'active');
      yield providerEvent(request.requestId, 'text.delta', { text: 'Independent work finished; awaiting the plugin result.' });
    } else {
      assert.equal(turn, 4, 'one terminal result creates only one continuation');
      const processResults = request.messages.filter(message => message.role === 'user').flatMap(message => {
        try { const content = JSON.parse(message.content); return content.process ? [content.process] : []; } catch { return []; }
      });
      assert.deepEqual(processResults, [{ jobId: 'job:plugin', status: 'completed', tool: pluginTool, result: businessResult }]);
      assert.equal('stdout' in processResults[0], false, 'plugin business content is not Shell output');
      assert.equal('exitCode' in processResults[0], false, 'plugin business content is not a Shell exit record');
      await answerGate.promise;
      yield providerEvent(request.requestId, 'text.delta', { text: 'Plugin and independent work completed.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const preparation = fakeRunPreparation({ tools, contextWindowTokens: 40000 });
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'managed-plugin');
  t.after(async () => { independentGate.resolve(); answerGate.resolve(); wake(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Analyze in the background and read an independent file.'));
  await waitUntil(async () => {
    const snapshot = await actor.snapshot();
    assert.notEqual(snapshot.run?.status, 'failed', JSON.stringify(snapshot.failureSnapshot ?? snapshot.terminalError));
    return requests.length === 2;
  }, 'independent request starts while MCP is active');
  update('active'); update('active');
  await waitUntil(async () => (await readEvents(journal, sessionId)).some(event => event.type === 'process.updated' && event.payload.job.revision === 3), 'MCP progress reaches journal');
  independentGate.resolve();
  await waitUntil(async () => requests.length === 3 && (await readEvents(journal, sessionId)).some(event => event.type === 'process.wait.changed' && event.payload.phase === 'waiting'), 'parent waits after independent work');
  assert.equal(independentReads, 1);
  for (const request of requests) assert.equal(JSON.stringify(request.messages).includes('PRIVATE_PROGRESS_ONLY'), false);
  await setImmediate(); await setImmediate();
  assert.equal(requests.length, 3, 'progress does not create model polling');
  update('completed');
  await waitUntil(() => requests.length === 4, 'MCP completion enters the next model request');
  duplicate = structuredClone(job); wake();
  await waitUntil(() => duplicated === 1, 'duplicate MCP terminal snapshot is delivered');
  answerGate.resolve();
  await waitUntil(async () => (await actor.snapshot()).run?.status === 'completed', 'run completes after plugin result');
  assert.equal(requests.length, 4);
  for (let index = 1; index < requests.length; index++) {
    assert.deepEqual(requests[index].tools, requests[0].tools, 'capacity and progress do not mutate the schema prefix');
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages,
      'later requests preserve the exact already-sent message prefix');
  }
  const final = await actor.snapshot();
  const activity = final.activities.find(item => item.tool?.process?.jobId === 'job:plugin');
  assert.equal(activity.status, 'completed');
  assert.equal(activity.tool.operation, pluginTool);
  assert.equal(activity.tool.projectionError, undefined, 'MCP result must not be decoded as a Shell exit result');
  assert.equal(activity.tool.process.result, undefined);
  assert.equal(activity.liveOutput, undefined);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'process.updated' && event.payload.job.status === 'completed').length, 1);
  assert.deepEqual(events.find(event => event.type === 'process.updated' && event.payload.job.status === 'completed').payload.job.result, businessResult);
  assert.equal(preparation.released.length, 1);
  assert.equal(closed, true);
});
