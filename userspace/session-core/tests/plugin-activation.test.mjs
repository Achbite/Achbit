import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { SessionActor, runAgentLoop, sessionControlToolDefinitions } from '../dist/index.js';
import {
  actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, waitUntil, workspaceBinding,
} from './local-agent-fixtures.mjs';

const discoveryTool = { toolBindingRef: 'binding:plugin-search', name: 'plugin.search', description: 'Discover plugins.',
  inputSchema: { type: 'object', properties: {} }, possibleEffects: ['localRead'], availability: 'callable', origin: 'coreBuiltin' };

test('Agent plugin activation and explicit user mentions coexist across request boundaries', async t => {
  for (const surface of ['aggregate', 'responses']) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:plugins-${surface}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const browserUri = 'plugin://browser@local';
    const mentioned = { selectionId: 'selection:notes', uri: 'plugin://notes@local', label: 'Notes' };
    const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
    const port = { ...preparation.port, async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = `catalog:plugins:${preparation.prepared.length}`;
      if (request.pluginSelections?.some(selection => selection.uri === browserUri)) {
        runtime.tools.push({ toolBindingRef: `binding:${runtime.kernelCatalogSnapshotRef}`, name: 'browser.observe',
          description: 'Observe the internal browser.', inputSchema: { type: 'object', properties: {} },
          possibleEffects: ['localRead'], availability: 'callable', origin: 'extension', pluginUri: browserUri });
      }
      runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
        ...sessionControlToolDefinitions().map(tool => tool.name)]);
      return prepared;
    } };
    let turns = 0, executing = false, finishTool;
    const gate = new Promise(resolve => { finishTool = resolve; });
    const provider = { async *stream(request) {
      assert.ok(++turns <= 3);
      const emit = (name, input) => surface === 'responses'
        ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
          type: 'function_call', call_id: `native:${turns}`, name, arguments: JSON.stringify(input), status: 'completed' } })
        : providerEvent(request.requestId, 'tool.call', { callId: `native:${turns}`, name, input });
      if (turns === 1) {
        assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
        yield emit('plugin_activate', { pluginUris: [browserUri] });
      } else if (turns === 2) {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(browserUri)));
        yield emit('browser_observe', {});
      } else {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        yield providerEvent(request.requestId, 'text.delta', { text: 'Preview inspected.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = actorWith(journal, sessionId, provider, emptyKernel({ async execute(request) {
      assert.equal(request.toolName, 'browser.observe');
      executing = true; await gate;
      const reply = completedExecutionReply(request, { content: 'Visible preview.' });
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = `instance:${browserUri}`;
      return reply;
    } }), port, `plugin-${surface}`);
    t.after(async () => { finishTool(); await actor.dispose(); });
    await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the preview using my notes.'),
      pluginSelections: [mentioned] });
    await waitUntil(() => executing, 'activated browser executing');
    await actor.submit(messageCommand(sessionId, 'command:guidance', 'Check the button too.'));
    finishTool();
    const done = await waitForProjection(actor, state => state.run?.status === 'completed');
    const events = await readEvents(journal, sessionId);
    const userMessages = events.filter(event => event.type === 'message.committed' && event.payload.role === 'user');
    assert.deepEqual(userMessages[0].payload.pluginSelections, [mentioned]);
    assert.equal(userMessages[1].payload.pluginSelections, undefined);
    assert.deepEqual(events.find(event => event.type === 'session.plugins.activated').payload.pluginUris, [browserUri]);
    assert.deepEqual(new Set(preparation.prepared.at(-1).pluginSelections.map(selection => selection.uri)),
      new Set([mentioned.uri, browserUri]));
    assert.equal(done.messages.at(-1).content, 'Preview inspected.');
    const activation = done.activities.filter(activity => activity.label === 'plugin.activate');
    assert.deepEqual(activation.map(activity => [activity.callId, activity.status, activity.tool?.recordId]),
      [[events.find(event => event.type === 'session.plugins.activated').callId, 'completed', undefined]],
      'one completed Session activation must not invent a Kernel tool record');
    assert.equal(preparation.released.length, 1);
  }
});

test('desktop activation and explicit selection carry execution availability without a GUI or shell probe', async t => {
  for (const explicit of [false, true]) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:desktop-${explicit}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const uri = 'plugin://computer-use@builtin';
    const desktop = { toolBindingRef: 'binding:desktop', name: 'computer.control', description: 'Native desktop control.',
      inputSchema: { type: 'object', properties: {} }, possibleEffects: ['external'], availability: 'callable',
      origin: 'extension', pluginUri: uri, runtimeStatus: { platform: 'macos', accessibility: true } };
    const browser = { ...desktop, toolBindingRef: 'binding:browser', name: 'browser.observe', availability: 'blocked',
      availabilityReason: { code: 'gui_browser_unavailable', message: 'This run has no GUI window for embedded browser tools.' } };
    delete browser.runtimeStatus;
    const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
    const port = { ...preparation.port, async prepare(request) {
      assert.equal(request.hostBinding, undefined);
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = `catalog:desktop:${preparation.prepared.length}`;
      if (request.pluginSelections?.some(selection => selection.uri === uri)) runtime.tools.push(desktop, browser);
      runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
        ...sessionControlToolDefinitions().map(tool => tool.name)]);
      return prepared;
    } };
    let turns = 0, executions = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      turns += 1;
      assert.ok(turns <= (explicit ? 2 : 3));
      if (!explicit && turns === 1) {
        yield providerEvent(request.requestId, 'tool.call', { callId: 'native:activate', name: 'plugin_activate', input: { pluginUris: [uri] } });
      } else {
        assert.ok(request.tools.some(tool => tool.name === 'computer_control'));
        assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
        const capabilities = request.messages.find(message => message.role === 'system' && message.content.includes('Execution-layer tool status'));
        assert.equal(capabilities, undefined);
        assert.doesNotMatch(JSON.stringify(request.messages), /gui_browser_unavailable|accessibility|runtimeStatus/u);
        if (!explicit) {
          const result = request.messages.filter(message => message.role === 'tool')
            .map(message => JSON.parse(message.content)).find(result => result.activated);
          assert.deepEqual(result.activated, [uri]);
          assert.deepEqual(result.tools, [{ name: desktop.name }]);
        }
        if (!executions) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:desktop', name: 'computer_control', input: { action: 'status' } });
        else yield providerEvent(request.requestId, 'text.delta', { text: 'Native desktop inspection complete.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } }, emptyKernel({ async execute(request) {
      assert.equal(request.toolName, 'computer.control');
      executions += 1;
      const reply = completedExecutionReply(request, { status: 'ready' });
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = 'instance:desktop';
      return reply;
    } }), port, `desktop-${explicit}`);
    t.after(() => actor.dispose());
    await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the native desktop status.'),
      ...(explicit ? { pluginSelections: [{ selectionId: 'selection:desktop', uri, label: 'Computer Use' }] } : {}) });
    await waitForProjection(actor, state => state.run?.status === 'completed');
    assert.equal(executions, 1);
    assert.equal(preparation.released.length, 1);
    const canonical = (await readEvents(journal, sessionId)).flatMap(event => event.type === 'run.started'
      ? event.payload.runtimeSnapshot.tools : event.type === 'run.tools.prepared' ? event.payload.toolView.tools : []);
    assert.ok(canonical.some(tool => tool.availabilityReason?.code === 'gui_browser_unavailable'));
    assert.ok(canonical.some(tool => tool.runtimeStatus?.accessibility === true));
    if (!explicit) {
      const events = await readEvents(journal, sessionId);
      const activated = events.find(event => event.type === 'session.plugins.activated');
      assert.equal(activated.payload.kernelCatalogSnapshotRef,
        events.find(event => event.type === 'run.tools.prepared' && event.sequence > activated.sequence).payload.toolView.kernelCatalogSnapshotRef);
    }
  }
});

test('plugin preparation failure is returned without changing the callable tool view', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plugin-disabled';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
  const port = { ...preparation.port, async prepare(request) {
    if (request.pluginSelections?.length) throw new Error('plugin_selection_disabled: Plugin is disabled.');
    return preparation.port.prepare(request);
  } };
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:disabled', name: 'plugin_activate', input: { pluginUris: ['plugin://disabled@local'] },
    });
    else {
      assert.equal(turns, 2);
      assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('plugin_selection_disabled')));
      assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
      yield providerEvent(request.requestId, 'text.delta', { text: 'The selected plugin is disabled.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), port, 'plugin-disabled');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Use the plugin.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some(event => event.type === 'session.plugins.activated' || event.type === 'run.tools.prepared'), false);
});

test('pending plugin refresh admits input and process completion before cancellation drains preparation', { timeout: 5_000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:pending-plugin-refresh';
  await createSession(journal, sessionId, [workspaceBinding]);
  const processTool = { toolBindingRef: 'binding:process', name: 'process', description: 'Manage a command',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['process'],
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string' }, input: { type: 'object' } } } };
  const preparation = fakeRunPreparation({ tools: [discoveryTool, processTool], contextWindowTokens: 8192 });
  const preparing = Promise.withResolvers(), drain = Promise.withResolvers();
  const processCommitted = Promise.withResolvers(), aborted = Promise.withResolvers();
  let preparations = 0, job, wake = () => {}, closed = false;
  const port = { ...preparation.port, async prepare(request) {
    preparations += 1;
    if (preparations === 3) { preparing.resolve(); await drain.promise; }
    const prepared = await preparation.port.prepare(request);
    prepared.runtimeSnapshot.kernelCatalogSnapshotRef = `catalog:refresh:${preparations}`;
    return prepared;
  } };
  const originalAppend = journal.append.bind(journal);
  journal.append = async event => {
    const committed = await originalAppend(event);
    if (event.type === 'process.updated' && event.payload.job.status === 'completed') processCommitted.resolve();
    return committed;
  };
  const kernel = emptyKernel({
    async execute(request) {
      assert.equal(request.toolName, 'process');
      job = { jobId: 'job:refresh', sessionId, runId: request.runId, callId: request.callId, revision: 1,
        toolName: 'bash', command: 'independent analysis', targets: ['.'], status: 'active', startedAt: String(Date.now()),
        output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
      wake();
      return completedExecutionReply(request, { job });
    },
    async readProcesses(request, signal) {
      if (request.cancel) closed = true;
      const changed = () => job && request.revisions?.[job.jobId] !== job.revision;
      if (request.waitMs && !changed() && !signal?.aborted) await new Promise(resolve => {
        const release = () => { if (wake === release) wake = () => {}; signal?.removeEventListener('abort', release); resolve(); };
        wake = release;
        signal?.addEventListener('abort', release, { once: true });
      });
      return changed() ? [structuredClone(job)] : [];
    },
  });
  const requests = [];
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    requests.push(request);
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    yield providerEvent(request.requestId, 'tool.call', { callId: 'start:refresh', name: 'process',
      input: { action: 'start', tool: 'bash', input: { command: 'independent analysis' } } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, kernel, port, 'pending-refresh');
  t.after(async () => { drain.resolve(); wake(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:refresh-start', 'Start independent analysis.'));
  await preparing.promise;
  const boundary = (await readEvents(journal, sessionId)).at(-1).sequence;
  assert.equal((await actor.submit(messageCommand(sessionId, 'command:during-refresh', 'Keep this instruction.'))).status, 'accepted');
  job = { ...job, revision: 2, status: 'completed', completedAt: String(Date.now()),
    result: { exitCode: 0, durationMs: 1, timedOut: false } };
  wake();
  await processCommitted.promise;
  let cancelFinished = false;
  const cancellation = actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId,
    commandId: 'command:cancel-refresh', runId: job.runId }).then(reply => { cancelFinished = true; return reply; });
  await aborted.promise;
  assert.equal((await journal.readCommand(sessionId, 'command:cancel-refresh')).reply.status, 'accepted');
  assert.equal(cancelFinished, false, 'the admitted preparation still owns run resources');
  assert.equal(preparation.released.length, 0);
  assert.equal(requests.length, 1);
  drain.resolve();
  assert.equal((await cancellation).status, 'accepted');
  const state = await actor.snapshot();
  assert.equal(state.run.status, 'cancelled');
  assert.deepEqual(state.queuedInputs.map(({ text, status }) => ({ text, status })), [{ text: 'Keep this instruction.', status: 'notApplied' }]);
  const events = await readEvents(journal, sessionId);
  assert.ok(events.some(event => event.sequence > boundary && event.type === 'process.updated' && event.payload.job.status === 'completed'));
  assert.equal(events.some(event => event.sequence > boundary && event.type === 'run.tools.prepared'), false);
  assert.equal(events.some(event => event.type === 'input.accepted' && event.payload.commandId === 'command:during-refresh'), false);
  assert.equal(requests.length, 1, 'cancellation must not start another Provider request');
  assert.equal(preparation.released.length, 1);
  assert.equal(closed, true);
  assert.ok(events.find(event => event.type === 'run.runtime.released').sequence < events.find(event => event.type === 'run.settled').sequence);
});

test('input captured before refresh is applied once and later input waits for the following request', { timeout: 5_000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:refresh-input-boundary';
  await createSession(journal, sessionId, [workspaceBinding]);
  const readTool = { ...discoveryTool, toolBindingRef: 'binding:read', name: 'fs.read' };
  const preparation = fakeRunPreparation({ tools: [discoveryTool, readTool], contextWindowTokens: 8192 });
  const firstRequest = Promise.withResolvers(), finishFirst = Promise.withResolvers();
  const preparing = Promise.withResolvers(), drain = Promise.withResolvers();
  let preparations = 0;
  const port = { ...preparation.port, async prepare(request) {
    preparations += 1;
    if (preparations === 3) { preparing.resolve(); await drain.promise; }
    return preparation.port.prepare(request);
  } };
  const requests = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      firstRequest.resolve(); await finishFirst.promise;
      yield providerEvent(request.requestId, 'tool.call', { callId: 'read:boundary', name: 'fs_read', input: { path: 'notes.md' } });
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'Applied the current instructions.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { return completedExecutionReply(request, { content: 'Independent notes.' }); } }), port, 'refresh-inputs');
  t.after(async () => { finishFirst.resolve(); drain.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:boundary-start', 'Read the notes.'));
  await firstRequest.promise;
  await actor.submit(messageCommand(sessionId, 'command:before-refresh', 'Captured before preparation.'));
  finishFirst.resolve();
  await preparing.promise;
  assert.equal((await actor.submit(messageCommand(sessionId, 'command:after-refresh', 'Arrived during preparation.'))).status, 'accepted');
  assert.equal(requests.length, 1);
  drain.resolve();
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(requests.length, 3);
  const userText = request => request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  assert.match(userText(requests[1]), /Captured before preparation\./u);
  assert.doesNotMatch(userText(requests[1]), /Arrived during preparation\./u);
  assert.match(userText(requests[2]), /Arrived during preparation\./u);
  const events = await readEvents(journal, sessionId);
  for (const commandId of ['command:before-refresh', 'command:after-refresh']) {
    assert.equal(events.filter(event => event.type === 'input.accepted' && event.payload.commandId === commandId).length, 1);
  }
});

test('a directory attached while preparation waits replaces the pending view before the first Provider request', { timeout: 5000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:binding-during-prepare';
  await createSession(journal, sessionId, [workspaceBinding]);
  const extra = { workspaceId: 'workspace:added', displayName: 'Added' };
  const prep = fakeRunPreparation({ tools: [discoveryTool] });
  const waiting = Promise.withResolvers(), resume = Promise.withResolvers();
  const wanted = [workspaceBinding.workspaceId, extra.workspaceId];
  const seen = [];
  const port = { ...prep.port, async prepare(input) {
    seen.push(input.workspaceBindingIds);
    if (seen.length === 2) { waiting.resolve(); await resume.promise; }
    const prepared = await prep.port.prepare(input);
    prepared.runtimeSnapshot.kernelCatalogSnapshotRef = `catalog:directories:${seen.length}`;
    return prepared;
  } };
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    turns++; assert.deepEqual(seen.at(-1), wanted);
    yield providerEvent(request.requestId, 'text.delta', { text:'Both directories are available.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), port, 'binding-change');
  t.after(async () => { resume.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:begin', 'Check the directories.'));
  await waiting.promise;
  const reply = await actor.submit({schemaVersion:'achbit.command.v3',type:'session.directory-index.attach',sessionId,commandId:'command:add',workspaceBinding:extra});
  assert.equal(reply.status, 'accepted'); resume.resolve();
  await waitForProjection(actor, p => p.run?.status === 'completed');
  assert.equal(turns, 1);
  assert.deepEqual(seen, [[workspaceBinding.workspaceId],[workspaceBinding.workspaceId],wanted]);
  const views = (await readEvents(journal, sessionId)).filter(e => e.type === 'run.tools.prepared');
  assert.deepEqual(views.map(e => e.payload.toolView.kernelCatalogSnapshotRef), ['catalog:directories:3']);
});

test('cancelled explicit plugin activation drains preparation without committing its tool view', { timeout: 5_000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:cancel-plugin-activation';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
  const preparing = Promise.withResolvers(), drain = Promise.withResolvers(), aborted = Promise.withResolvers();
  const port = { ...preparation.port, async prepare(request) {
    if (request.pluginSelections?.length) { preparing.resolve(); await drain.promise; }
    const prepared = await preparation.port.prepare(request);
    if (request.pluginSelections?.length) prepared.runtimeSnapshot.kernelCatalogSnapshotRef = 'catalog:cancelled-activation';
    return prepared;
  } };
  let requests = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    requests += 1;
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    yield providerEvent(request.requestId, 'tool.call', { callId: 'activate:cancel', name: 'plugin_activate',
      input: { pluginUris: ['plugin://pending@local'] } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), port, 'cancel-activation');
  t.after(async () => { drain.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:activate-start', 'Activate the plugin.'));
  await preparing.promise;
  const { run } = await actor.snapshot();
  const cancellation = actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId,
    commandId: 'command:cancel-activation', runId: run.runId });
  await aborted.promise;
  assert.equal(preparation.released.length, 0);
  drain.resolve();
  await cancellation;
  assert.equal((await actor.snapshot()).run.status, 'cancelled');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some(event => event.type === 'session.plugins.activated' || event.type === 'run.tools.prepared'), false);
  const failed = events.filter(event => event.type === 'session.plugins.failed');
  assert.deepEqual(failed.map(event => event.payload.outcome), ['indeterminate'], 'preparation crossed the effect boundary, no publication was committed');
  assert.ok(events.find(event => event.type === 'run.runtime.released').sequence < failed[0].sequence);
  assert.equal(requests, 1);
  assert.equal(preparation.released.length, 1);
});

test('an in-flight activation keeps the directories captured for its request', { timeout: 5000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:captured-activation-directories';
  await createSession(journal, sessionId, [workspaceBinding]);
  const attached = { workspaceId: 'workspace:in-flight', displayName: 'In-flight directory' };
  const uri = 'plugin://shifted@project';
  const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    turns += 1;
    if (turns === 1) {
      assert.deepEqual(request.workspaceBindings.map(b => b.workspaceId), [workspaceBinding.workspaceId]);
      assert.deepEqual(preparation.prepared.at(-1).workspaceBindingIds, [workspaceBinding.workspaceId]);
      // Accepted while this request is unanswered: it applies from the next request.
      const reply = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.attach',
        sessionId, commandId: 'command:in-flight-attach', workspaceBinding: attached });
      assert.equal(reply.status, 'accepted');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:in-flight', name: 'plugin_activate',
        input: { pluginUris: [uri] } });
    } else {
      assert.equal(turns, 2);
      assert.deepEqual(preparation.prepared.at(-1).workspaceBindingIds, [workspaceBinding.workspaceId, attached.workspaceId]);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Activated against the captured directories.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), preparation.port, 'captured-activation');
  t.after(async () => { await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:start', 'Use the project skill.'));
  const done = await waitForProjection(actor, state => state.run?.status === 'completed');
  const activations = preparation.prepared.filter(request => request.modelActivation === true);
  assert.equal(activations.length, 1);
  assert.equal(activations[0].pluginSelections[0].uri, uri);
  assert.deepEqual(activations[0].workspaceBindingIds, [workspaceBinding.workspaceId],
    'activation adopted a directory attached after its request was issued');
  assert.deepEqual(done.run.workspaceBindings.map(binding => binding.workspaceId),
    [workspaceBinding.workspaceId, attached.workspaceId]);
  assert.equal(done.messages.at(-1).content, 'Activated against the captured directories.');
});

test('detaching a directory during a Provider request changes the next view, not its activation', { timeout: 5000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:in-flight-detach';
  await createSession(journal, sessionId, [workspaceBinding]);
  const extra = { workspaceId: 'workspace:removable', displayName: 'Removable project' };
  const before = [workspaceBinding.workspaceId, extra.workspaceId], after = [workspaceBinding.workspaceId];
  const prep = fakeRunPreparation({ tools: [discoveryTool] });
  const uri = 'plugin://removable@project';
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) {
      assert.deepEqual(request.workspaceBindings.map(b => b.workspaceId), before);
      assert.deepEqual(prep.prepared.at(-1).workspaceBindingIds, before);
      const detached = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.detach',
        sessionId, commandId: 'command:detach', workspaceId: extra.workspaceId });
      assert.equal(detached.status, 'accepted');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'native:detach', name: 'plugin_activate', input: { pluginUris: [uri] } });
    } else {
      assert.equal(turns, 2);
      assert.deepEqual(request.workspaceBindings.map(b => b.workspaceId), after);
      assert.deepEqual(prep.prepared.at(-1).workspaceBindingIds, after);
      yield providerEvent(request.requestId, 'text.delta', { text: 'Completed after detachment.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), prep.port, 'in-flight-detach');
  t.after(() => actor.dispose());
  assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.attach',
    sessionId, commandId: 'command:attach', workspaceBinding: extra })).status, 'accepted');
  await actor.submit(messageCommand(sessionId, 'command:start', 'Use the removable project skill.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.deepEqual(prep.prepared.filter(p => p.modelActivation).map(p => p.workspaceBindingIds), [before]);
  assert.equal(turns, 2);
});

test('activity synchronization cannot mix a newly attached directory into an already prepared catalog', { timeout: 5000 }, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:directory-after-view';
  await createSession(journal, sessionId, [workspaceBinding]);
  const extra = { workspaceId: 'workspace:during-sync', displayName: 'During sync' };
  const before = [workspaceBinding.workspaceId], after = [...before, extra.workspaceId];
  const prep = fakeRunPreparation({ tools: [discoveryTool] });
  let attached = false, turns = 0;
  const issuedViews = [];
  const actor = new SessionActor(sessionId, journal, {
    kernel: emptyKernel(), runPreparation: prep.port, async dispose() {},
    runner: { run: (initial, command, deps, signal) => runAgentLoop(initial, command, { ...deps, activity: {
      async waitPending() {}, checkpoint() {}, needsContinuation: () => false, async wait() {},
      async sync() {
        if (attached) return;
        assert.deepEqual(prep.prepared.at(-1).workspaceBindingIds, before);
        attached = true;
        assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'session.directory-index.attach',
          sessionId, commandId: 'command:during-sync', workspaceBinding: extra })).status, 'accepted');
      },
    } }, signal) },
    provider: { async *stream(request) {
      assert.ok(++turns <= 2 && attached);
      // The edit won admission before this request: reprepare instead of sending an old catalog.
      issuedViews.push(prep.prepared.at(-1).workspaceBindingIds);
      assert.deepEqual(request.workspaceBindings.map(b => b.workspaceId), after);
      assert.deepEqual(issuedViews.at(-1), after);
      if (turns === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'native:sync', name: 'plugin_activate',
        input: { pluginUris: ['plugin://existing@project'] } });
      else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
      yield providerEvent(request.requestId, 'completed', {});
    } },
  });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Check the prepared view.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.deepEqual(prep.prepared.filter(p => p.modelActivation).map(p => p.workspaceBindingIds), [after]);
  assert.deepEqual(issuedViews, [after, after]);
  assert.equal((await readEvents(journal, sessionId)).filter(e => e.type === 'context.composed').length, 2);
  assert.equal(turns, 2);
});
