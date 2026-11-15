import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionActor, loopSnapshot, projectSession } from '../dist/index.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { AgentLoopRegistry } from '../dist/local-agent/loopRegistry.js';
import { corePromptInstructions } from '../dist/local-agent/coreInstructions.js';
import { productDocumentation } from '../dist/local-agent/productInstructions.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { fakeRunPreparation, runtimeSnapshot, createSession, workspaceBinding, emptyKernel, completedExecutionReply,
  failedExecutionReply, providerEvent, messageCommand, waitForProjection, waitUntil, readEvents } from './local-agent-fixtures.mjs';

const tools = ['fs.read', 'bash', 'fs.edit', 'fs.write'].map(name => ({
  name, toolBindingRef: `binding:${name}`, origin: 'coreBuiltin', availability: 'callable', description: name,
  possibleEffects: [name === 'fs.read' ? 'workspaceRead' : name === 'bash' ? 'process' : 'workspaceMutation'],
  inputSchema: { type: 'object', additionalProperties: false, required: name === 'bash' ? ['command'] : ['path'], properties: {
    path: { type: 'string' }, command: { type: 'string' }, content: { type: 'string' }, edits: { type: 'array' },
    startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 5000 }, timeout: { type: 'integer', minimum: 1 },
  } },
}));
const permissions = { 'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate',
  'agent.permissions.shell': 'allow', 'agent.permissions.shellAccess': 'full' };
function coding(runtime) {
  runtime.codingTools = true;
  runtime.instructions = corePromptInstructions(false);
  runtime.toolSelection = { kernel: tools.map(tool => tool.name), controls: [], plugins: false };
  runtime.providerToolAliases = createProviderToolAliases(tools.map(tool => tool.name), [], true);
  return runtime;
}
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(t, name, provider, kernel = emptyKernel(), codingContext = true) {
  const journal = new InMemoryCommandJournal(), sessionId = `session:pi-${name}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools, permissions, contextWindowTokens: 32000 });
  const capabilities = await new SessionConfigurationRegistry().create({ context: { id: 'coding' }, controls: { id: 'none' }, compaction: { id: 'none' } });
  const requests = [];
  const actor = new SessionActor(sessionId, journal, { capabilities,
    runner: new AgentLoopRegistry().create({ id: 'standard', parameters: { toolExecution: 'parallel' } }),
    runPreparation: { ...preparation.port, async prepare(input) {
      const result = await preparation.port.prepare(input);
      coding(result.runtimeSnapshot);
      if (!codingContext) delete result.runtimeSnapshot.codingTools;
      return result;
    } }, kernel, provider: { async *stream(request, signal) {
      assertRuntimeContract('ProviderRequest', request);
      requests.push(request);
      yield* provider(request, requests.length, signal);
    } }, async dispose() {} });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, `command:${name}`, 'Inspect and update the files.'));
  return { actor, journal, sessionId, requests, preparation };
}
const terminal = projection => ['completed', 'failed', 'cancelled'].includes(projection.run?.status);
const answer = request => providerEvent(request.requestId, 'assistant.message', { messageId: `answer:${request.requestId}`, content: 'Done.' });

test('coding prompt uses PI section order and actual declarations without product or environment leakage', async () => {
  const runtime = coding(runtimeSnapshot('run:pi-prompt', { tools, permissions, contextWindowTokens: 32000 }));
  runtime.environment.productDocsPath = '/bundle/docs/product';
  runtime.instructions.push(...productDocumentation(runtime.environment, false));
  runtime.environment.primaryWorkspaceDirectory = { workspaceId: workspaceBinding.workspaceId, path: '/project' };
  runtime.instructions.push({ id: 'achbit.reply-format', text: '<response>Full product format</response>' },
    { id: 'achbit.session-environment', text: '<environment>Full environment</environment>' },
    { id: 'achbit.project-instructions', text: 'Project-specific instructions and guidelines:\n\n<project_instructions path="/project/AGENTS.md">\nKeep the user files.\n</project_instructions>' });
  const { request, receipt } = await buildAgentProviderRequest({ runtime, sessionId: 'session:prompt', runId: 'run:pi-prompt', events: [],
    workspaceBindings: [workspaceBinding], directoryBindings: [workspaceBinding], providerRequestId: 'request:prompt', responseConstraint: 'normal' });
  assert.equal('codingContext' in request, false, 'context strategy must not select Provider wire policy');
  assert.deepEqual(request.tools.map(tool => tool.name), ['read', 'bash', 'edit', 'write']);
  const sections = request.messages.filter(message => message.role === 'system');
  const text = sections.map(message => message.content).join('\n');
  assert.match(sections[0].content, /^You are a coding assistant running inside Achbit/u);
  assert.deepEqual([...text.matchAll(/^<(tools|rules|docs|project_context|skills|cwd)>/gmu)].map(match => match[1]),
    ['tools', 'rules', 'docs', 'project_context', 'cwd']);
  assert.equal(sections.at(-1).content, '<cwd>\n/project\n</cwd>');
  assert.match(text, /<rules>[\s\S]*Use read to examine files instead of cat or sed/u);
  assert.doesNotMatch(sections.map(message => message.content).join('\n'), /PI_\*|inside pi|Full product|Full environment|outputs table|plan_publish/u);
  assert.match(request.tools[0].description, /50 KiB.*offset\/limit/u);
  assert.equal(request.tools[0].inputSchema.properties.limit.maximum, 5000, 'declared Kernel limits are not widened');
  assert.ok(receipt.messages.every(message => message.contributionId));
});

test('PI batch overlaps more than four reads and mutations, and a failed same-file predecessor does not skip its successor', async t => {
  const hold = gate(), reads = [], writes = [];
  t.after(() => hold.resolve());
  const { actor, journal, sessionId, requests } = await setup(t, 'parallel', async function* (request, turn) {
    if (turn === 1) {
      for (let i = 0; i < 5; i++) yield providerEvent(request.requestId, 'tool.call', { callId: `read:${i}`, name: 'read', input: { path: `file-${i}` } });
      for (const content of ['first', 'second']) yield providerEvent(request.requestId, 'tool.call', { callId: `write:${content}`, name: 'write', input: { path: 'same', content } });
    } else yield answer(request);
    yield providerEvent(request.requestId, 'completed', {});
  }, emptyKernel({ async execute(request) {
    if (request.toolName === 'fs.read') { reads.push(request.input.path); await hold.promise; }
    else {
      writes.push(request.input.content);
      if (request.input.content === 'first') return failedExecutionReply(request, {}, { code: 'fixture_write_failed', message: 'Original write failure' });
      assert.deepEqual(writes, ['first', 'second']);
    }
    return completedExecutionReply(request, { content: request.input.path, saved: true });
  } }));
  await waitUntil(() => reads.length === 5 && writes.length === 2, 'all reads and both same-file mutations before reads finish');
  assert.equal(requests.length, 1);
  hold.resolve();
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'completed');
  const results = requests[1].messages.filter(message => message.role === 'tool');
  assert.deepEqual(results.map(message => message.providerCallId), ['read:0', 'read:1', 'read:2', 'read:3', 'read:4', 'write:first', 'write:second']);
  assert.match(results[5].content, /Original write failure/);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'tool.not-executed').length, 0);
  assert.deepEqual(projectSession(loopSnapshot(sessionId, events).state), projection);
});

test('truncated raw calls are rejected without effects, preserve a failed attempt, and continue with complete calls', async t => {
  let effects = 0;
  const raw = '{"path":"out","content":"unfinished';
  const { actor, journal, sessionId, requests, preparation } = await setup(t, 'truncated', async function* (request, turn) {
    if (turn === 1) {
      yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'partial:write', name: 'write', argumentsDelta: raw });
      yield providerEvent(request.requestId, 'tool.call', { callId: 'complete:read', name: 'read', input: { path: 'input' } });
      yield providerEvent(request.requestId, 'failed', { code: 'provider_output_truncated', message: 'max_output_tokens' });
      return;
    }
    if (turn === 2) {
      assert.equal(effects, 0);
      const previous = request.messages.find(message => message.toolCalls?.some(call => call.providerCallId === 'partial:write'));
      assert.equal(previous.toolCalls[0].input, raw, 'never salvage or normalize partial input');
      const rejected = request.messages.filter(message => message.role === 'tool');
      assert.deepEqual(rejected.map(message => message.providerCallId), ['partial:write', 'complete:read']);
      assert.ok(rejected.every(message => /not executed.*output token limit/u.test(message.content)));
      yield providerEvent(request.requestId, 'tool.call', { callId: 'retry:write', name: 'write', input: { path: 'out', content: 'complete' } });
    } else yield answer(request);
    yield providerEvent(request.requestId, 'completed', {});
  }, emptyKernel({ async execute(request) { effects++; assert.equal(request.input.content, 'complete'); return completedExecutionReply(request, { saved: true }); } }));
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'completed', JSON.stringify(projection.terminalError));
  assert.equal(effects, 1); assert.equal(requests.length, 3);
  const events = await readEvents(journal, sessionId);
  const failure = events.find(event => event.type === 'provider.turn.settled' && event.payload.outcome === 'failed');
  assert.equal(failure.payload.error.code, 'provider_output_truncated');
  assert.equal(failure.payload.toolCallInputs.length, 2);
  assert.ok(failure.payload.toolCallInputs.every(call => call.error));
  assert.equal(events.filter(event => event.type === 'tool.requested').length, 1);
  assert.equal(projection.providerAttempts.filter(attempt => attempt.phase === 'failed').length, 1);
  assert.equal(projection.activities.filter(activity => activity.status === 'rejected').length, 2);
  assert.equal(preparation.released.length, 1);
  assert.deepEqual(projectSession(loopSnapshot(sessionId, events).state), projection);
});

for (const mode of ['text-only', 'full-context', 'other-failure']) test(`${mode} failure does not acquire truncated-call continuation`, async t => {
  const { actor, requests } = await setup(t, mode, async function* (request) {
    if (mode !== 'text-only') yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'incomplete', name: 'write', argumentsDelta: '{' });
    yield providerEvent(request.requestId, 'failed', { code: mode === 'other-failure' ? 'provider_response_failed' : 'provider_output_truncated', message: 'Original upstream error' });
  }, emptyKernel(), mode !== 'full-context');
  const projection = await waitForProjection(actor, terminal);
  assert.equal(projection.run.status, 'failed');
  assert.equal(projection.terminalError.message, 'Original upstream error');
  assert.equal(requests.length, 1);
});

test('PI parallel cancellation drains all admitted calls and does not execute a queued same-file successor', async t => {
  const running = new Map(), cancelled = [], all = gate();
  t.after(() => all.resolve());
  const { actor, journal, sessionId } = await setup(t, 'cancel', async function* (request) {
    for (let i = 0; i < 5; i++) yield providerEvent(request.requestId, 'tool.call', { callId: `c:${i}`, name: 'write', input: { path: `p${i}`, content: 'first' } });
    yield providerEvent(request.requestId, 'tool.call', { callId: 'successor', name: 'write', input: { path: 'p0', content: 'later' } });
    yield providerEvent(request.requestId, 'completed', {});
  }, emptyKernel({ async execute(request) { const hold = gate(); running.set(request.callId, { request, hold }); return hold.promise; },
    async cancel(callId, attemptId) {
      cancelled.push(callId); if (cancelled.length === 5) all.resolve(); await all.promise;
      const { request, hold } = running.get(callId), reply = completedExecutionReply(request, {});
      reply.status = reply.record.outcome = 'cancelled'; delete reply.record.output; hold.resolve(reply);
      return { schemaVersion: 'achbit.kernel-reply', type: 'tool.cancelled', requestId: 'cancel', callId, attemptId, status: 'cancelled', record: reply.record };
    } }));
  await waitUntil(() => running.size === 5, 'five owned calls');
  const { run } = await actor.snapshot();
  await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', commandId: 'cancel:pi', sessionId, runId: run.runId });
  assert.equal((await waitForProjection(actor, terminal)).run.status, 'cancelled');
  assert.equal(running.size, 5); assert.equal(new Set(cancelled).size, 5);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'tool.not-executed' && event.payload.reason === 'cancelled').length, 1);
});
