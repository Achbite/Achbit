import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService, loopSnapshot } from '../../session-core/dist/index.js';
import { assertRuntimeContract } from '../../session-core/tests/support/runtimeContract.mjs';
import { DEFAULT_USER_SETTINGS } from '../../protocol/dist/index.js';
import {
  decodeGuiProjection,
  findReactElement,
  inputCacheMetric,
  lastCallInputCacheMetric,
  loadGuiModelStore,
  loadGuiModule,
  loadGuiModules,
  installGuiFetch,
} from './gui-projection-contract.mjs';
import {
  workspaceBinding,
  actorWith,
  fakeRunPreparation,
  emptyKernel,
  completedExecutionReply,
  providerEvent,
  messageCommand,
  jsonMessagePayload,
  createSession,
  readEvents,
  singleEvent,
  assertEventOrder,
  waitForProjection,
  waitUntil,
} from '../../session-core/tests/local-agent-fixtures.mjs';

for (const withOutput of [false, true]) test(`cancelled Shell preserves its terminal fact and optional output (${withOutput}) across Session, GUI and continuation`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:shell-cancel-${withOutput}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'binding:shell-cancel', name: 'bash', description: 'Run a Shell command.',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
    possibleEffects: ['process', 'workspaceMutation', 'external'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  let execution, finishExecution, record, turns = 0;
  const waiting = new Promise(resolve => { finishExecution = resolve; });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) {
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider:shell-cancel', name: request.tools.find(tool => tool.inputSchema.properties?.command).name,
        input: { workspace: 'primary', command: 'printf started; sleep 120; printf completed' },
      });
    } else {
      const result = request.messages.map(jsonMessagePayload).find(value => value?.outcome === 'cancelled');
      assert.ok(result, 'the next run must see the cancellation fact');
      assert.equal(result.recordId, record.recordId);
      assert.equal(result.error, undefined);
      if (withOutput) {
        assert.equal(result.output.stdout, 'started');
        assert.equal(result.output.success, false);
        assert.equal(result.output.exitCode, null);
        assert.deepEqual(result.output.fullOutput, record.output.fullOutput);
        assert.equal(result.output.environment, undefined, 'existing Shell diagnostics filtering still applies');
      } else assert.equal(result.output, undefined);
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:continued', content: 'The Shell was cancelled.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({
    async execute(request) { execution = request; return await waiting; },
    async cancel(callId, attemptId) {
      assert.equal(callId, execution.callId);
      assert.equal(attemptId, execution.attemptId);
      const reply = completedExecutionReply(execution, {
        workspaceId: execution.input.workspaceId, command: execution.input.command, cwd: '.',
        workspaceMode: 'read', executionScope: 'workspace', terminal: false,
        stdout: 'started', stderr: '', exitCode: null, success: false, timedOut: false,
        truncated: false, capturedBytes: 7, durationMs: 100,
        fullOutput: { stdout: { path: '/kernel/archive/stdout.log', bytes: 7 } },
        environment: { shell: '/bin/bash', interactive: false, executionScope: 'workspace', terminal: false,
          pathSource: 'preparedRunEnvironment', writeScope: 'authorizedResources', homeWritable: true, networkAccess: false },
      });
      reply.status = reply.record.outcome = 'cancelled';
      if (!withOutput) delete reply.record.output;
      reply.record.preparedEffect.logicalTargets = ['.'];
      Object.assign(reply.record.preparedEffect.canonicalInvocation.arguments, { workspaceMode: 'read', executionScope: 'workspace' });
      record = reply.record;
      assertRuntimeContract('ToolExecutionRecord', record);
      assert.throws(() => assertRuntimeContract('ToolExecutionRecord', {
        ...record, error: { code: 'unexpected_error', message: 'Cancelled must not carry an error.' },
      }));
      finishExecution(reply);
      return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.cancelled', requestId: 'cancel:shell',
        callId, attemptId, status: 'cancelled', record };
    },
    async readRecord() { return record ?? null; },
  }), preparation.port, `shell-cancel-${withOutput}`);
  t.after(async () => { finishExecution(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:shell-start', 'Run the long Shell command.'));
  await waitUntil(() => execution !== undefined, 'Shell execution');
  const runId = (await actor.snapshot()).run.runId;
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel', sessionId, runId, commandId: 'command:shell-stop' });
  const projection = await waitForProjection(actor, state => state.run?.status === 'cancelled');
  assert.equal(projection.terminalError, null);
  const activity = projection.activities.find(item => item.callId === execution.callId);
  assert.equal(activity.status, 'cancelled');
  assert.equal(activity.tool.error, undefined);
  assert.equal(activity.tool.projectionError, undefined);
  assert.equal(activity.tool.shell.result?.stdout, withOutput ? 'started' : undefined);
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  if (withOutput) {
    const malformed = structuredClone(projection);
    malformed.activities.find(item => item.callId === execution.callId).tool.shell.result.exitCode = 'invalid';
    await assert.rejects(() => decodeGuiProjection(malformed));
  }
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(singleEvent(events, 'tool.completed').payload.record, record);
  assert.equal(singleEvent(events, 'run.settled').payload.outcome, 'cancelled');
  assert.equal(singleEvent(events, 'run.finishing').payload.outcome, 'cancelled');
  await actor.submit(messageCommand(sessionId, 'command:shell-continue', 'Explain what happened.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  assert.equal(turns, 2);
});

test('Pane resizing follows the grabbed edge and stops at the usable width limits', async t => {
  const { PANE_GEOMETRY, resizedPaneWidth, boundedPaneWidth } = await loadGuiModule(t, '/src/components/shared/paneGeometry.ts');
  const nav = PANE_GEOMETRY.navigation;
  const tree = PANE_GEOMETRY.fileTree;
  assert.equal(resizedPaneWidth(nav.initial, 60, 1, 1, nav.min, nav.max), 304, 'moving the left navigation edge right widens it');
  assert.equal(resizedPaneWidth(tree.initial, -60, -1, 1, tree.min, tree.max), 270, 'moving the right tree edge left widens it');
  assert.equal(resizedPaneWidth(nav.initial, -1000, 1, 1, nav.min, nav.max), nav.min);
  assert.equal(resizedPaneWidth(tree.initial, -1000, -1, 1, tree.min, tree.max), tree.max);
  assert.equal(boundedPaneWidth(360, tree.min, 240), 240, 'a narrower reader retains room for the document');
  assert.equal(resizedPaneWidth(240, 32, -1, 1, tree.min, 240), 208, 'a subsequent drag starts at the displayed width');
});

test('Preview resizing uses its container width for percentage units', async t => {
  const { PANE_GEOMETRY, resizedPaneWidth } = await loadGuiModule(t, '/src/components/shared/paneGeometry.ts');
  const preview = PANE_GEOMETRY.preview;
  assert.equal(resizedPaneWidth(55, -120, -1, 12, preview.min, preview.max), 65, '120px in a 1200px workspace adds ten percentage points');
  assert.equal(resizedPaneWidth(55, 120, -1, 12, preview.min, preview.max), 45);
  assert.equal(resizedPaneWidth(55, -1200, -1, 12, preview.min, preview.max), 75);
});

test('Workbench view history deduplicates locations and branches after navigating back', async (t) => {
  const { visitLocation, locationKey } = await loadGuiModule(t, '/src/deepcode-gui/layout/navigationHistory.ts');
  const conversation = { sessionId: 'session:view', draftProjectId: null, settingsOpen: false,
    reader: { sessionId: 'session:view', target: null, visible: false, expanded: false } };
  const file = { ...conversation, reader: { ...conversation.reader, visible: true,
    target: { kind: 'workspace', workspaceId: 'workspace:view', logicalPath: 'main.ts', line: 12 } } };
  const settings = { ...file, settingsOpen: true };
  let history = visitLocation({ entries: [], cursor: -1 }, conversation);
  history = visitLocation(history, file);
  assert.equal(visitLocation(history, { ...file }), history);
  history = visitLocation(history, settings);
  history = visitLocation({ ...history, cursor: 1 }, { ...conversation, draftProjectId: 'project:new', sessionId: null,
    reader: { ...conversation.reader, sessionId: null } });
  assert.equal(history.cursor, 2);
  assert.equal(history.entries.length, 3);
  assert.equal(history.entries[1], file);
  assert.equal(history.entries[2].settingsOpen, false);
  assert.equal(history.entries[2].draftProjectId, 'project:new');
  assert.notEqual(locationKey(file), locationKey({ ...file, reader: { ...file.reader, target: { ...file.reader.target, line: 40 } } }));
});

test('Workbench history cannot reactivate a closed native browser page', async (t) => {
  const { visitLocation, forgetClosedBrowser } = await loadGuiModule(t, '/src/deepcode-gui/layout/navigationHistory.ts');
  const conversation = { sessionId: 'session:view', draftProjectId: null, settingsOpen: false,
    reader: { sessionId: 'session:view', target: null, visible: true, expanded: false } };
  const browser = { ...conversation, reader: { ...conversation.reader, target: { kind: 'browser', previewId: 'page:closed' } } };
  const file = { ...conversation, reader: { ...conversation.reader, target: { kind: 'file', path: '/workspace/main.ts' } } };
  let history = [conversation, browser, file].reduce(visitLocation, { entries: [], cursor: -1 });
  assert.equal(forgetClosedBrowser(history, 'session:other', 'browser:page:closed'), history);
  history = forgetClosedBrowser(history, 'session:view', 'browser:page:closed');
  assert.deepEqual(history.entries, [conversation, file]);
  assert.equal(history.cursor, 1);
  assert.equal(forgetClosedBrowser(history, 'session:view', 'file:/workspace/main.ts'), history);
});

test('Shell history diagnostics are read without applying current execution policy', async (t) => {
  const { isShellExecutionEnvironment } = await loadGuiModule(t, '/src/services/shellActivityCodec.ts');
  const environment = {
    shell: '/bin/bash', interactive: false, executionScope: 'workspace', terminal: false,
    pathSource: 'recordedPath', writeScope: 'kernelTemporaryOnly', homeWritable: false, networkAccess: false,
  };
  for (const writeScope of ['kernelTemporaryOnly', 'workspaceAndKernelTemporary', 'recordedScope']) {
    assert.equal(isShellExecutionEnvironment({ ...environment, writeScope }), true);
  }
  assert.equal(isShellExecutionEnvironment({ ...environment, writeScope: '' }), false);
  assert.equal(isShellExecutionEnvironment({ ...environment, homeWritable: 'false' }), false);
  assert.equal(isShellExecutionEnvironment({ ...environment, networkAccess: null }), false);
});

test('GUI message editing submits a revision-bound Session command and reconciles its projection', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-message-edit';
  await createSession(journal, sessionId, [workspaceBinding]);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'text.delta', { text: 'Completed answer.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'gui-message-edit');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:original', 'Original message.'));
  const initial = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  const commands = [];
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body);
      commands.push(command);
      return Response.json({ ok: true, data: await actor.submit(command) });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: initial, loading: false });
  await store.getState().editMessage(initial.messages[0].messageId, 'Edited text.', initial.revision);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'message.edit');
  assert.equal(commands[0].messageId, initial.messages[0].messageId);
  assert.equal(commands[0].expectedRevision, initial.revision);
  assert.equal(commands[0].text, 'Edited text.');
  assert.deepEqual(store.getState().projection.messages.filter((message) => message.role === 'user').map((message) => message.content), ['Edited text.']);
  assert.equal(store.getState().submitting, false);
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
});

test('permissions stay in their continuous activity group before and after the tool completes', async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:permission-history';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'binding:permission', name: 'web.fetch', description: 'Fetch', origin: 'coreBuiltin', availability: 'callable',
    possibleEffects: ['network'], inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  }] });
  let calls = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:permission',
      name: request.tools.find((tool) => tool.inputSchema.properties?.url).name, input: { url: 'https://example.test' } });
    else yield providerEvent(request.requestId, 'text.delta', { text: 'Finished.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    if (!request.nonWorkspaceAuthority) return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution',
      requestId: request.requestId, callId: request.callId, status: 'approvalRequired', approvalId: 'approval:history',
      preview: { summary: 'Allow access to https://example.test?', effects: ['external'], logicalTargets: ['https://example.test'] } };
    const reply = completedExecutionReply(request, { content: 'Result' });
    reply.record.preparedEffect.logicalTargets = [request.input.url];
    return reply;
  } }), preparation.port, 'permission-history');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Fetch the page.'));
  const waiting = await waitForProjection(actor, (state) => state.pendingApproval !== null);
  const { projectionItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const pendingRows = projectionItems(await decodeGuiProjection(waiting));
  const record = pendingRows.find(row => row.type === 'toolGroup').values.find(activity => activity.kind === 'approval');
  assert.equal(record.label, 'Allow access to https://example.test?');
  assert.equal(record.status, 'waiting');
  assert.equal(pendingRows.at(-1).type, 'toolGroup');
  const { approvalId, callId, runId } = waiting.pendingApproval;
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'approval.respond', commandId: 'command:allow',
    sessionId, approvalId, callId, runId, decision: 'allow' });
  const completed = await waitForProjection(actor, (state) => state.run?.status === 'completed');
  const rows = projectionItems(await decodeGuiProjection(completed));
  const accepted = rows.find(row => row.type === 'toolGroup').values.find(activity => activity.kind === 'approval');
  assert.equal(accepted.activityId, record.activityId);
  assert.equal(accepted.status, 'completed');
  assert.equal(completed.pendingApproval, null);
  assert.equal(rows.filter(row => row.type === 'toolGroup').length, 1);
  assert.deepEqual(rows.find(row => row.type === 'toolGroup').values.map(activity => activity.kind), ['approval', 'tool']);
  assert.equal(rows.at(-1).type, 'message');
});

test('UI plugin replacement releases styles and effects and retires failed renderers', async (t) => {
  const { UiPluginRuntime } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const styles = new Set();
  const signals = [];
  const disposed = [];
  const renderer = () => ({ update() {}, dispose() {} });
  const runtime = new UiPluginRuntime(async (code) => {
    if (code === 'broken') throw new Error('original module syntax failure');
    return { apply(ctx) {
      signals.push(ctx.signal);
      ctx.addStyle(code);
      ctx.onDispose(() => disposed.push(code));
      ctx.register('message.markdown', renderer);
    } };
  }, (css) => { styles.add(css); return () => styles.delete(css); });
  t.after(() => runtime.dispose());
  const file = (source) => ({ path: '/plugins/reader', enabled: true, manifest: { id: 'reader', name: 'Reader', entry: 'index.js', slots: ['message.markdown'] }, source, error: null });
  await runtime.replace([file('first')]);
  assert.equal(runtime.getSnapshot()[0].renderers.get('message.markdown'), renderer);
  const firstGeneration = runtime.getSnapshot()[0].generation;
  await runtime.replace([file('second')]);
  assert.deepEqual([...styles], ['second']);
  assert.deepEqual(disposed, ['first']);
  assert.equal(signals[0].aborted, true);
  assert.ok(runtime.getSnapshot()[0].generation > firstGeneration);
  await runtime.replace([file('broken')]);
  assert.equal(styles.size, 0);
  assert.equal(runtime.getSnapshot()[0].status, 'error');
  assert.match(runtime.getSnapshot()[0].error, /original module syntax failure/);
  assert.equal(runtime.getSnapshot()[0].renderers.size, 0);
  await runtime.replace([file('third')]);
  await runtime.report(runtime.getSnapshot()[0], new Error('view update failed'));
  assert.equal(styles.size, 0);
  assert.match(runtime.getSnapshot()[0].error, /view update failed/);
  await runtime.replace([{ ...file(null), enabled: false }]);
  assert.equal(runtime.getSnapshot()[0].status, 'disabled');
});

test('UI module imports finishing late cannot replace a newer generation', async (t) => {
  const { UiPluginRuntime } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const activated = [];
  let finishOld;
  const runtime = new UiPluginRuntime((source) => source === 'old' ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ apply() { activated.push(source); } }), () => () => {});
  t.after(() => runtime.dispose());
  const file = (source) => ({ path: '/plugins/theme', enabled: true, manifest: { id: 'theme', name: 'Theme', entry: 'index.js', slots: ['theme'] }, source, error: null });
  const oldLoad = runtime.replace([file('old')]);
  await waitUntil(() => Boolean(finishOld));
  const newLoad = runtime.replace([file('new')]);
  finishOld({ apply() { activated.push('old'); } });
  await Promise.all([oldLoad, newLoad]);
  assert.deepEqual(activated, ['new']);
  assert.equal(runtime.getSnapshot()[0].status, 'active');
  await runtime.replace([]);
  assert.deepEqual(runtime.getSnapshot(), []);
});

test('UI plugin scopes release all resources even if one disposer fails', async (t) => {
  const { createPluginScope } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const calls = [];
  const scope = createPluginScope((css) => () => calls.push(css), (error) => { throw error; });
  scope.addStyle('stylesheet');
  scope.onDispose(() => { throw new Error('dispose failure'); });
  scope.onDispose(() => calls.push('event listener'));
  await assert.rejects(scope.dispose(), /dispose failure/);
  assert.equal(scope.signal.aborted, true);
  assert.deepEqual(calls, ['event listener', 'stylesheet']);
  await assert.rejects(scope.dispose(), /dispose failure/);
});

test('UI replacement waits for asynchronous views and module disposal', async (t) => {
  const { UiPluginRuntime } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const order = []; let releaseView;
  const runtime = new UiPluginRuntime(async source => ({ apply(ctx) {
    order.push(`apply:${source}`); ctx.onDispose(async () => { await Promise.resolve(); order.push(`dispose:${source}`); });
  } }), () => () => {});
  t.after(() => runtime.dispose());
  const file = source => ({path:'/plugins/theme',enabled:true,manifest:{id:'theme',name:'Theme',entry:'index.js',slots:['theme']},source,error:null});
  await runtime.replace([file('first')]);
  runtime.attachView(runtime.getSnapshot()[0], () => new Promise(resolve => {releaseView = () => {order.push('view:disposed');resolve();};}));
  const replacement = runtime.replace([file('second')]);
  await waitUntil(() => Boolean(releaseView));
  assert.deepEqual(order, ['apply:first']);
  releaseView(); await replacement;
  assert.deepEqual(order, ['apply:first','view:disposed','dispose:first','apply:second']);
});

test('conflicting display slots are explicit and unload when the selection changes', async (t) => {
  const { UiPluginRuntime } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const runtime = new UiPluginRuntime(async () => ({ apply(ctx) { ctx.register('document.html', () => ({ update() {}, dispose() {} })); } }), () => () => {});
  t.after(() => runtime.dispose());
  const file = (id) => ({ path: `/plugins/${id}`, enabled: true, manifest: { id, name: id, entry: 'index.js', slots: ['document.html'] }, source: 'module', error: null });
  await runtime.replace([file('a')]);
  await runtime.replace([file('a'), file('b')]);
  assert.ok(runtime.getSnapshot().every((entry) => entry.status === 'error'));
  await runtime.replace([file('b')]);
  assert.equal(runtime.getSnapshot()[0].status, 'active');
});

test('document preview requests preserve workspace identity, full bytes and read failures', async (t) => {
  const { readResourceBlob } = await loadGuiModule(t, '/src/services/conversationResources.ts');
  let failure = false;
  const body = '<!doctype html><h1>中文报告</h1>';
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/conversation/sessions/session%3Adoc/resources/read');
    assert.deepEqual(JSON.parse(init.body), { workspaceId: 'workspace:docs', logicalPath: '报告.html', format: 'document' });
    return failure ? Response.json({ ok: false, error: 'conversation_document_read_failed', message: 'original read error' })
      : new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  assert.equal(await (await readResourceBlob('session:doc', { workspaceId: 'workspace:docs', logicalPath: '报告.html' }, 'document')).text(), body);
  failure = true;
  await assert.rejects(readResourceBlob('session:doc', { workspaceId: 'workspace:docs', logicalPath: '报告.html' }, 'document'), /original read error/);
});

test('multi-workspace links resolve exact targets and never guess through read errors', async t => {
  const { resolveLocalTargets, parseLocalTarget } = await loadGuiModule(t, '/src/components/local-agent/resourceLinks.ts');
  const roots = [{ workspaceId: 'main', root: '/project' }, { workspaceId: 'drafts', root: '/session' }];
  const missing = Object.assign(new Error('canonicalize /session/README.md: No such file'), { code: 'host_inspection_path_not_found' });
  const calls = [];
  const one = await resolveLocalTargets(parseLocalTarget('README.md:12:3'), roots, async (workspace, path) => {
    calls.push([workspace, path]);
    if (workspace === 'drafts') throw missing;
    return { path: `/project/${path}`, kind: 'file' };
  });
  assert.deepEqual(calls, [['main', 'README.md'], ['drafts', 'README.md']]);
  assert.deepEqual(one, [{ workspaceId: 'main', logicalPath: 'README.md', path: '/project/README.md', line: 12, column: 3 }]);
  const multiple = await resolveLocalTargets(parseLocalTarget('README.md'), roots, async (workspace, path) => ({ path: `${roots.find(root => root.workspaceId === workspace).root}/${path}`, kind: 'file' }));
  assert.equal(multiple.length, 2, 'the UI must offer both targets');
  const denied = Object.assign(new Error('permission denied'), { code: 'host_inspection_path_unavailable' });
  await assert.rejects(resolveLocalTargets(parseLocalTarget('README.md'), roots, async workspace => {
    if (workspace === 'drafts') throw denied;
    return { path: '/project/README.md', kind: 'file' };
  }), error => error === denied);
  await assert.rejects(resolveLocalTargets(parseLocalTarget('README.md'), roots, async () => { throw missing; }), /canonicalize.*No such file/);
  const { ResourceLinkChoices } = await loadGuiModule(t, '/src/components/local-agent/ResourceLinkChoices.tsx');
  let selected;
  const dialog = ResourceLinkChoices({ targets: multiple, language: 'zh-CN', onSelect: target => { selected = target; }, onClose() {} });
  const list = dialog.props.children.find(child => child.type === 'ul');
  list.props.children[1].props.children.props.onClick();
  assert.equal(selected, multiple[1]);
});

test('error dismissal clears only its owner and allows the next error to appear', async t => {
  const { DismissibleError } = await loadGuiModule(t, '/src/components/local-agent/DismissibleError.tsx');
  const store = await loadGuiModelStore(t);
  const projection = { retained: 'failed execution facts' };
  store.setState({ sessionId: 'session:error', error: 'command failed', errorSource: 'command', projection });
  const view = DismissibleError({ language: 'zh-CN', children: store.getState().error, onDismiss: store.getState().clearError });
  assert.equal(view.props.role, 'alert');
  const close = view.props.children.find(child => child.type === 'button');
  assert.equal(close.props['aria-label'], '关闭提示');
  close.props.onClick();
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().projection, projection);
  store.setState({ error: 'new failure', errorSource: 'command' });
  const next = DismissibleError({ language: 'en-US', children: store.getState().error, onDismiss: store.getState().clearError });
  assert.equal(next.props.children[0].props.children, 'new failure');
  assert.equal(next.props.children[1].props['aria-label'], 'Dismiss message');
});

test('document links retain Unicode paths and choose the appropriate reader', async (t) => {
  const { documentFormat, workspaceResourceLink } = await loadGuiModule(t, '/src/components/local-agent/documentResources.ts');
  assert.equal(documentFormat('Reports/REPORT.PDF'), 'pdf');
  assert.equal(documentFormat('报告.html'), 'html');
  assert.equal(documentFormat('notes.markdown'), 'markdown');
  assert.equal(documentFormat('src/main.rs'), null);
  assert.deepEqual(workspaceResourceLink('workspace://workspace%3Adoc/reports%2F%E6%8A%A5%E5%91%8A%20a.pdf'), { workspaceId: 'workspace:doc', logicalPath: 'reports/报告 a.pdf' });
  assert.equal(workspaceResourceLink('https://example.com/report.pdf'), null);
  assert.equal(workspaceResourceLink('workspace://workspace:doc/%FF'), null);
});

test('reader text decoding preserves Unicode BOM documents and rejects unsupported bytes', async (t) => {
  const { readDocumentText } = await loadGuiModule(t, '/src/components/local-agent/documentResources.ts');
  assert.equal(await readDocumentText(new Blob(['# 中文文档\n正文'])), '# 中文文档\n正文');
  assert.equal(await readDocumentText(new Blob([Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])])), '中文');
  assert.equal(await readDocumentText(new Blob([Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87])])), '中文');
  await assert.rejects(readDocumentText(new Blob([Uint8Array.from([0xff, 0x00, 0xa1])])));
  await assert.rejects(readDocumentText(new Blob(['text\0binary'])), /file_encoding_unsupported/);
});

test('local links preserve locations, workspace roots and unambiguous readable labels', async (t) => {
  const { parseLocalTarget, bindLocalTarget, readableResourceLinks } = await loadGuiModule(t, '/src/components/local-agent/resourceLinks.ts');
  const roots = [{ workspaceId: 'workspace:main', root: '/project/测试 项目' }];
  const root = parseLocalTarget('deepcode-gui://localhost/project/%E6%B5%8B%E8%AF%95%20%E9%A1%B9%E7%9B%AE');
  assert.equal(bindLocalTarget(root, roots).logicalPath, '.');
  assert.deepEqual(parseLocalTarget('file:///project/测试%20项目/src/main.rs#L12C3'), { path: '/project/测试 项目/src/main.rs', absolute: true, line: 12, column: 3 });
  assert.equal(bindLocalTarget(parseLocalTarget('README.md:12'), roots).logicalPath, 'README.md');
  assert.equal(bindLocalTarget(parseLocalTarget('./src/../README.md'), roots).logicalPath, 'README.md');
  assert.equal(bindLocalTarget(parseLocalTarget('/project/测试 项目-other/file'), roots), null);
  assert.equal(bindLocalTarget(parseLocalTarget('file:///c:/Work'), [{ workspaceId: 'windows', root: 'C:\\Work' }]).logicalPath, '.');
  assert.equal(bindLocalTarget(parseLocalTarget('/usr/local/bin/c++'), roots), null);
  assert.throws(() => bindLocalTarget(parseLocalTarget('README.md'), [...roots, { workspaceId: 'second', root: '/other' }]), /unambiguous/);
  for (const href of ['https://example.com/path', '#section', 'file://remote/path', 'javascript:alert(1)']) assert.equal(parseLocalTarget(href), null);
  const a = (href, text = href) => ({ type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: text }] });
  const tree = readableResourceLinks({ type: 'root', children: [a('/one/src/main.rs:12'), a('/two/lib/main.rs'), a('/project/测试 项目', '项目根目录'),
    { type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'text', value: '/one/src/main.rs' }] }] });
  assert.equal(tree.children[0].children[0].value, 'src/main.rs:12');
  assert.equal(tree.children[1].children[0].value, 'lib/main.rs');
  assert.equal(tree.children[2].children[0].value, '项目根目录');
  assert.equal(tree.children[0].properties.title, '/one/src/main.rs:12');
  assert.equal(tree.children[3].children[0].value, '/one/src/main.rs');
});

test('document Plan scope and completed artifacts pass through Session to the GUI reader', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:document-artifact';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tool = {
    toolBindingRef: 'tool-binding:document:g1', name: 'document.render', description: 'Render a document.',
    inputSchema: { type: 'object', required: ['path', 'format', 'content'], properties: {
      path: { type: 'string' }, format: { type: 'string', enum: ['pdf'] }, content: { type: 'string' },
    } }, possibleEffects: ['workspaceMutation'], availability: 'callable', origin: 'coreBuiltin',
  };
  const artifact = { artifactId: 'artifact:document', label: '报告.pdf', workspaceId: workspaceBinding.workspaceId, logicalPath: '报告.pdf', contentType:'application/pdf', contentMode:'fixed' };
  let calls = 0;
  let documentRecordId;
  let documentRecord;
  const provider = { async *stream(request) {
    if (++calls === 1) {
      const plan = request.tools.find((entry) => entry.inputSchema.properties?.mutationManifest);
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:document-plan', name: plan.name, input: {
        title: 'Document', summary: 'Publish the requested report.', steps: [{ stepId: 'report', title: 'Report', details: 'Render the report.' }],
        mutationManifest: [{ workspace: 'primary', operation: 'document.render', target: '报告.pdf' }],
      } });
    } else if (calls === 2) {
      const renderer = request.tools.find((entry) => entry.inputSchema.properties?.format?.enum?.includes('pdf'));
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:document-render', name: renderer.name,
        input: { workspace: 'primary', path: '报告.pdf', format: 'pdf', content: '<h1>Report</h1>' } });
    } else if (calls === 3) {
      const current = await actor.snapshot();
      assert.equal(current.todoList, null, 'confirmation and file execution do not manufacture progress');
      const progress = request.tools.find((entry) => entry.name === 'todo_update');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:document-progress', name: progress.name,
        input: { items: [{ text: 'Report', status: 'completed' }] } });
    } else {
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'provider-message:document-done', content: 'Report is ready.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const kernel = emptyKernel({ async execute(request) {
    assert.equal(request.toolName, 'document.render');
    assert.equal(request.input.workspaceId, workspaceBinding.workspaceId);
    assert.deepEqual(request.planAuthorities[0].coveredOperations, [{ workspaceId: workspaceBinding.workspaceId, operation: 'document.render', target: '报告.pdf' }]);
    const reply = completedExecutionReply(request, { artifacts: [artifact] });
    documentRecordId = reply.record.recordId;
    documentRecord = reply.record;
    return reply;
  } });
  const actor = actorWith(journal, sessionId, provider, kernel, fakeRunPreparation({ tools: [tool], contextWindowTokens: 8192 }).port, 'document-artifact');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:document-start', 'Render a report.'));
  const waiting = await waitForProjection(actor, (value) => value.pendingPlan !== null);
  assert.equal(waiting.pendingPlan.mutationManifest[0].operation, 'document.render');
  const { planOperationDetail } = await loadGuiModule(t, '/src/components/local-agent/planReview.ts');
  assert.equal(planOperationDetail(waiting.pendingPlan.mutationManifest[0], 'zh-CN'), '生成文档 · 报告.pdf');
  assert.equal(planOperationDetail(waiting.pendingPlan.mutationManifest[0], 'en-US'), 'Render document · 报告.pdf');
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond', commandId: 'command:document-confirm', sessionId,
    runId: waiting.run.runId, planId: waiting.pendingPlan.planId, revision: waiting.pendingPlan.revision, response: { kind: 'confirm' } });
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual((await decodeGuiProjection(completed)).artifacts, [{ ...artifact,
    sessionId, runId:documentRecord.runId, callId:documentRecord.callId,
    recordId:documentRecord.recordId, createdAt:documentRecord.completedAt,
  }]);
  assert.equal(completed.activities.find((activity) => activity.kind === 'tool').status, 'completed');
});

test('sidebar reordering preserves project ownership and ignores stale drag targets', async (t) => {
  const { moveSidebarItem } = await loadGuiModule(t, '/src/deepcode-gui/layout/sidebarOrder.ts');
  const projects = [{ id: 'p:a' }, { id: 'p:b' }, { id: 'p:c' }];
  const sessions = [
    { id: 's:a', projectId: 'p:a' }, { id: 's:b', projectId: 'p:a' },
    { id: 's:c', projectId: 'p:b' }, { id: 's:d' }, { id: 's:e' },
  ];
  const original = structuredClone({ projects, sessions });
  const project = (id) => ({ kind: 'project', id });
  const session = (id) => ({ kind: 'session', ...sessions.find((entry) => entry.id === id) });
  const empty = { projects: [], sessions: [] };
  const first = moveSidebarItem(empty, projects, sessions, project('p:c'), project('p:a'), 'before');
  assert.deepEqual(first.projects, ['p:c', 'p:a', 'p:b']);
  assert.deepEqual(moveSidebarItem(first, projects, sessions, project('p:c'), project('p:b'), 'after').projects, ['p:a', 'p:b', 'p:c']);
  const nested = moveSidebarItem(first, projects, sessions, session('s:b'), session('s:a'), 'before');
  assert.deepEqual(nested.sessions, ['s:b', 's:a', 's:c', 's:d', 's:e']);
  assert.deepEqual(nested.projects, first.projects);
  const standalone = moveSidebarItem(nested, projects, sessions, session('s:e'), session('s:d'), 'before');
  assert.deepEqual(standalone.sessions, ['s:b', 's:a', 's:c', 's:e', 's:d']);
  assert.equal(moveSidebarItem(standalone, projects, sessions, session('s:a'), session('s:c'), 'before'), null);
  assert.equal(moveSidebarItem(standalone, projects, sessions, session('s:a'), session('s:d'), 'after'), null);
  assert.equal(moveSidebarItem(standalone, projects, sessions, project('p:a'), session('s:a'), 'after'), null);
  assert.equal(moveSidebarItem(standalone, projects, sessions, project('p:deleted'), project('p:a'), 'before'), null);
  const changed = sessions.map((entry) => entry.id === 's:b' ? { ...entry, projectId: 'p:b' } : entry);
  assert.equal(moveSidebarItem(standalone, projects, changed, session('s:b'), session('s:a'), 'after'), null);
  assert.deepEqual({ projects, sessions }, original);
});

test('sidebar manual order survives catalog updates while new and deleted entries remain correct', async (t) => {
  const { orderSidebarItems, readSidebarOrder } = await loadGuiModule(t, '/src/deepcode-gui/layout/sidebarOrder.ts');
  const saved = readSidebarOrder(JSON.stringify({ projects: ['p:b', 'p:deleted', 'p:a'], sessions: [] }));
  const updatedCatalog = [{ id: 'p:a', updatedAt: 'later' }, { id: 'p:new' }, { id: 'p:b', updatedAt: 'earlier' }];
  assert.deepEqual(orderSidebarItems(updatedCatalog, saved.projects).map((entry) => entry.id), ['p:new', 'p:b', 'p:a']);
  assert.deepEqual(orderSidebarItems([], saved.projects), []);
  assert.deepEqual(orderSidebarItems(updatedCatalog, []).map((entry) => entry.id), updatedCatalog.map((entry) => entry.id));
  assert.throws(() => readSidebarOrder('{broken'), SyntaxError);
  assert.throws(() => readSidebarOrder('{"projects":false,"sessions":[]}'), /gui.sidebarOrder/);
});

test('sidebar order uses the shared settings store and failed saves retain the saved order', async (t) => {
  const [{ useSettingsStore }, { SIDEBAR_ORDER_SETTING, readSidebarOrder }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/deepcode-gui/layout/sidebarOrder.ts',
  ]);
  let persisted = { 'gui.colorTheme': 'dark' };
  let fail = false;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      assert.deepEqual(Object.keys(patches), [SIDEBAR_ORDER_SETTING]);
      if (fail) return Response.json({ ok: false, message: 'settings write failed' });
      persisted = { ...persisted, ...patches };
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, overriddenKeys: Object.keys(persisted), storePath: '/test/user-settings.json' } });
  });
  await useSettingsStore.getState().loadUserSettings();
  assert.deepEqual(readSidebarOrder(useSettingsStore.getState().effectiveSettings[SIDEBAR_ORDER_SETTING]), { projects: [], sessions: [] });
  const order = { projects: ['p:b', 'p:a'], sessions: ['s:b', 's:a'] };
  assert.equal(await useSettingsStore.getState().patchUserSetting(SIDEBAR_ORDER_SETTING, JSON.stringify(order)), 'immediate');
  const [{ useSettingsStore: reloaded }] = await loadGuiModules(t, ['/src/state/settingsStore.ts']);
  await reloaded.getState().loadUserSettings();
  assert.deepEqual(readSidebarOrder(reloaded.getState().effectiveSettings[SIDEBAR_ORDER_SETTING]), order);
  assert.equal(reloaded.getState().effectiveSettings['gui.colorTheme'], 'dark');
  fail = true;
  assert.equal(await reloaded.getState().patchUserSetting(SIDEBAR_ORDER_SETTING, '{"projects":[],"sessions":[]}'), null);
  assert.match(reloaded.getState().errorMessage, /settings write failed/);
  assert.deepEqual(readSidebarOrder(reloaded.getState().effectiveSettings[SIDEBAR_ORDER_SETTING]), order);
});

test('runtime file visibility is a searchable shared GUI preference and failed saves retain its value', async (t) => {
  const [{ useSettingsStore, shellPreferenceSettingDefinitions }, { GuiSettingsSection, settingsSearchDefinitions }, { matchesSettingsQuery }] = await loadGuiModules(t, [
    '/src/state/settingsStore.ts', '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
    '/src/components/settings-center/settingsSearch.tsx',
  ]);
  const key = 'gui.showRuntimeFiles';
  const definition = shellPreferenceSettingDefinitions('gui').find(item => item.key === key);
  assert.equal(definition.control, 'boolean');
  assert.deepEqual(definition.catalog.shellSurface, ['gui']);
  let persisted = { 'workbench.language': 'en-US', 'gui.defaultFileOpen': 'reader' };
  let fail = false;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      assert.deepEqual(Object.keys(patches), [key]);
      if (fail) return Response.json({ ok: false, message: 'settings write failed' });
      persisted = { ...persisted, ...patches };
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: [key], activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, overriddenKeys: Object.keys(persisted), storePath: '/test/user-settings.json' } });
  });
  await useSettingsStore.getState().loadUserSettings();
  assert.equal(useSettingsStore.getState().effectiveSettings[key], false);
  assert.equal(await useSettingsStore.getState().patchUserSetting(key, true), 'immediate');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const initial = useSettingsStore.getInitialState();
  const original = initial.effectiveSettings;
  t.after(() => { initial.effectiveSettings = original; });
  initial.effectiveSettings = useSettingsStore.getState().effectiveSettings;
  const html = renderToStaticMarkup(createElement(GuiSettingsSection, { category: 'general', apiStatus: 'ready' }));
  assert.match(html, /aria-label="Show runtime files"[^>]*checked=""/);
  assert.match(html, /aria-label="Open text files with"/, 'the destination page retains its complete settings');
  for (const [language, label] of [['zh-CN', '显示运行环境文件'], ['en-US', 'Show runtime files']]) {
    const search = settingsSearchDefinitions(language, 'macos').find(item => item.id === key);
    assert.equal(search.category, 'general');
    assert.equal(search.title, label);
    assert.equal(matchesSettingsQuery('runtime', search.title, search.keywords), true);
    const fileOpen = settingsSearchDefinitions(language, 'macos').find(item => item.id === 'gui.defaultFileOpen');
    assert.equal(matchesSettingsQuery('runtime', fileOpen.title, fileOpen.keywords), false);
  }
  const { useSettingsStore: reloaded } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  await reloaded.getState().loadUserSettings();
  assert.equal(reloaded.getState().effectiveSettings[key], true);
  assert.equal(reloaded.getState().effectiveSettings['gui.defaultFileOpen'], 'reader');
  fail = true;
  assert.equal(await reloaded.getState().patchUserSetting(key, false), null);
  assert.equal(reloaded.getState().effectiveSettings[key], true);
  assert.match(reloaded.getState().errorMessage, /settings write failed/);
});

test('native path selection preserves OS paths, cancellation and dialog errors', async (t) => {
  const previousWindow = globalThis.window;
  const [{ pickNativePath, hasNativePathPicker }] = await loadGuiModules(t, ['/src/services/runtimeAdapter.ts']);
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const calls = [];
  let selected = null;
  let failure = null;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (failure) throw failure;
    return selected;
  };
  globalThis.window = { __TAURI__: { core: { invoke } }, __TAURI_INTERNALS__: { invoke } };
  assert.equal(hasNativePathPicker(), true);
  for (const path of [String.raw`C:\Users\开发者\My Skills`, String.raw`\\server\team share\Skills`]) {
    selected = path;
    assert.deepEqual(await pickNativePath({ kind: 'directory', title: 'Choose a Skill folder' }), { path, kind: 'directory' });
    assert.equal(calls.at(-1).command, 'plugin:dialog|open');
    assert.equal(calls.at(-1).args.options.directory, true);
    assert.equal(calls.at(-1).args.options.multiple, false);
  }
  selected = '/Users/developer/My Skills/SKILL.md';
  const filters = [{ name: 'Skill', extensions: ['md'] }];
  assert.deepEqual(await pickNativePath({ kind: 'file', title: 'Choose SKILL.md', filters }), { path: selected, kind: 'file' });
  assert.equal(calls.at(-1).args.options.directory, false);
  assert.deepEqual(calls.at(-1).args.options.filters, filters);
  selected = null;
  assert.equal(await pickNativePath({ kind: 'directory', title: 'Choose folder' }), null);
  failure = new Error('dialog could not open');
  await assert.rejects(pickNativePath({ kind: 'file', title: 'Choose file' }), (error) => error === failure);
  globalThis.window = {};
  assert.equal(hasNativePathPicker(), false);
  const callCount = calls.length;
  await assert.rejects(pickNativePath({ kind: 'directory', title: 'Choose folder' }), /native_path_picker_unavailable/);
  assert.equal(calls.length, callCount);
});

test('Windows sandbox initialization uses the injected Host origin and preserves setup failures', async (t) => {
  const previousWindow = globalThis.window;
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const uiToken = `dcui_${'12'.repeat(32)}`;
  globalThis.window = {
    location: { protocol: 'http:', hostname: 'deepcode-gui.localhost', origin: 'http://deepcode-gui.localhost' },
    __DEEPCODE_HOST_BOOT__: { schemaVersion: 'deepcode.host-ui-bootstrap', host: '127.0.0.1', port: '49123', uiToken, windowChrome: 'custom' },
  };
  const [{ initializeWorkspaceSandbox }] = await loadGuiModules(t, ['/src/services/apiClient.ts']);
  let calls = 0;
  installGuiFetch(t, (url, init) => {
    calls += 1;
    assert.equal(url.href, 'http://127.0.0.1:49123/api/user-settings/workspace-sandbox');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-deepcode-host-ui-token'], uiToken);
    assert.deepEqual(JSON.parse(init.body), {});
    return Response.json({ ok: false, error: 'workspace_sandbox_setup_failed', message: 'administrator request declined' });
  });
  const result = await initializeWorkspaceSandbox();
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workspace_sandbox_setup_failed');
  assert.equal(result.message, 'administrator request declined');
});

test('Host workspace initialization preserves the current workspace or opens the native default directory', async (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const { initializeHostWorkspace } = await loadGuiModule(t, '/src/services/workspaceInitialization.ts');
  globalThis.document = { documentElement: { dataset: { product: 'deepcode-gui' } } };
  let defaultPath = '/Users/developer/DeepCode workspace';
  const calls = [];
  globalThis.window = { __TAURI__: { core: { invoke: async (command) => {
    calls.push(command);
    assert.equal(command, 'deepcode_default_workspace_path');
    return defaultPath;
  } } } };
  const workspace = { id: 'workspace:current', name: 'Existing', source: 'directory', sourcePath: null,
    folders: [{ id: 'folder:current', name: 'Existing', absolutePath: '/existing', originalPath: '/existing', isAbsolute: true }],
    unsupportedFields: [], openedAt: '2026-09-18T00:00:00Z' };
  let current = workspace;
  installGuiFetch(t, (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === '/api/workspaces/current') return Response.json({ ok: true, data: { current, fallbackUsed: false, lastError: null } });
    assert.equal(url.pathname, '/api/workspaces/open');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { path: defaultPath });
    return Response.json({ ok: true, data: { workspace } });
  });
  await initializeHostWorkspace();
  assert.deepEqual(calls.splice(0), ['/api/workspaces/current']);
  current = null;
  await initializeHostWorkspace();
  assert.deepEqual(calls.splice(0), ['/api/workspaces/current', 'deepcode_default_workspace_path', '/api/workspaces/open']);
  defaultPath = null;
  await initializeHostWorkspace();
  assert.deepEqual(calls, ['/api/workspaces/current', 'deepcode_default_workspace_path']);
});

test('Host workspace initialization propagates the failing request without opening or retrying', async (t) => {
  const previousDocument = globalThis.document;
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  globalThis.document = { documentElement: { dataset: {} } };
  const { initializeHostWorkspace } = await loadGuiModule(t, '/src/services/workspaceInitialization.ts');
  const paths = ['/api/workspaces/current', '/api/workspaces/default-path', '/api/workspaces/open'];
  const replies = [
    { ok: true, data: { current: null, fallbackUsed: false, lastError: null } },
    { ok: true, data: { path: '/workspace/default' } },
  ];
  let failureAt;
  let invalidSuccess;
  let calls;
  installGuiFetch(t, (url) => {
    const index = calls.length;
    calls.push(url.pathname);
    assert.equal(url.pathname, paths[index]);
    return Response.json(index === failureAt
      ? invalidSuccess ? { ok: true } : { ok: false, error: 'workspace_failed', message: `Original failure: ${paths[index]}` }
      : replies[index]);
  });
  for (failureAt = 0; failureAt < paths.length; failureAt += 1) {
    calls = [];
    invalidSuccess = false;
    await assert.rejects(initializeHostWorkspace(), { message: `Original failure: ${paths[failureAt]}` });
    assert.deepEqual(calls, paths.slice(0, failureAt + 1));
    calls = [];
    invalidSuccess = true;
    await assert.rejects(initializeHostWorkspace());
    assert.deepEqual(calls, paths.slice(0, failureAt + 1));
  }
});

test('one native reference request returns the actual file or folder kind', async (t) => {
  const previousWindow = globalThis.window;
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const [{ pickNativePath, pickNativePaths }] = await loadGuiModules(t, ['/src/services/runtimeAdapter.ts']);
  const options = { kind: 'path', title: 'Files and folders', selectLabel: 'Attach', cancelLabel: 'Cancel' };
  let selection;
  let failure;
  let calls = 0;
  globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => {
    calls += 1;
    assert.equal(command, 'deepcode_pick_path');
    assert.equal(args.options.title, options.title);
    assert.equal(args.options.selectLabel, 'Attach');
    assert.equal(args.options.cancelLabel, 'Cancel');
    if (failure) throw failure;
    return selection;
  } } } };
  const references = [
    { path: String.raw`C:\Users\开发者\project\README.md`, kind: 'file' },
    // A dot in a directory name must not turn it into a file reference.
    { path: String.raw`\\server\team share\source.v2`, kind: 'directory' },
    { path: '/Users/developer/project/src', kind: 'directory' },
    { path: '/Users/developer/project/Makefile', kind: 'file' },
  ];
  for (const reference of references) {
    selection = [reference];
    assert.deepEqual(await pickNativePath(options), reference);
  }
  selection = [references[0], references[3]];
  assert.deepEqual(await pickNativePaths({ ...options, multiple: true }), selection);
  await assert.rejects(pickNativePath(options), /native_path_selection_count_invalid/);
  selection = null;
  assert.equal(await pickNativePath(options), null);
  failure = new Error('native selection failed');
  await assert.rejects(pickNativePath(options), (error) => error === failure);
  assert.equal(calls, references.length + 4);
});

test('Skill settings read mounted guidance from the live plugin catalog', async (t) => {
  const catalog = { revision: 'catalog:skills', plugins: [{ uri: 'plugin://example@local',
    displayName: 'Example', shortDescription: 'A text Skill.', source: 'mounted',
    category: 'reference', contributionKind: 'skill', discovery: 'default',
    activationMediaTypes: [], enabled: true, available: true,
    management: { key: 'skills.mounts', id: 'skill:example' } }] };
  installGuiFetch(t, async (url, init) => {
    assert.equal(url.pathname, '/api/conversation/plugins');
    assert.equal(init.method ?? 'GET', 'GET');
    return Response.json({ ok: true, data: catalog });
  });
  const { getPluginCatalog } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  assert.deepEqual(await getPluginCatalog(), catalog);
});

test('GUI receives and renders live tool output at the same journal revision before completion', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:live-output-gui';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tool = { toolBindingRef: 'tool-binding:progress:g1', name: 'fs.read', description: 'Read tool output.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' };
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  let publish;
  let calls = 0;
  const provider = { async *stream(request) {
    if (calls++ === 0) yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:progress', name: request.tools.find((entry) => entry.description === tool.description).name, input: { workspace: 'primary', path: 'output.log' } });
    else yield providerEvent(request.requestId, 'assistant.message', { messageId: 'provider-message:done', content: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const kernel = emptyKernel({ execute: async (request, onProgress) => {
    let offset = 0;
    publish = async (text) => {
      const bytes = [...new TextEncoder().encode(text)];
      await onProgress({ type: 'output', stream: 'stdout', offset, bytes });
      offset += bytes.length;
    };
    await onProgress({ type: 'started', startedAt: String(Date.now()) });
    await publish('first line\n');
    await held;
    return completedExecutionReply(request, { value: 'finished' });
  } });
  const actor = actorWith(journal, sessionId, provider, kernel, fakeRunPreparation({ tools: [tool] }).port, 'live-output-gui');
  t.after(async () => { finish(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:progress', 'Run the tool.'));
  const base = await waitForProjection(actor, (value) => value.activities.some((entry) => entry.liveOutput?.stdout === 'first line\n'));
  await publish('second line\n');
  const latest = await actor.snapshot();
  assert.equal(latest.revision, base.revision);
  assert.deepEqual(await decodeGuiProjection(latest), latest);
  installGuiFetch(t, async (url) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [{
      sessionId, revision: latest.revision, run: { runId: latest.run.runId, status: latest.run.status },
    }] });
    assert.ok(url.pathname.endsWith('/projection'));
    return Response.json({ ok: true, data: latest });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: base });
  await store.getState().refresh();
  assert.equal(store.getState().error, null);
  const activity = store.getState().projection.activities.find((entry) => entry.liveOutput);
  assert.equal(activity.liveOutput.stdout, 'first line\nsecond line\n');
  assert.equal(activity.status, 'active');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx',
  ]);
  const layout = { state: new Map() };
  const renderActivity = (current = activity) => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'live-progress', eager: true, virtualizer: { layout: () => layout },
    children: () => createElement(ToolActivityGroup, { sessionId, activities: [current], language: 'zh-CN', onExpand() {}, onOpenWorkspaceResource() {} }),
  }));
  assert.equal(renderActivity().includes('<pre>'), false, 'output arriving does not expand details');
  assert.match(renderActivity(), /正在调用 1 个工具/);
  layout.state.set('tool-group:expanded', true);
  layout.state.set(`tool:${activity.activityId}:expanded`, true);
  const html = renderActivity();
  assert.match(html, /<pre>first line\nsecond line\n<\/pre>/);
  assert.equal(html.includes('退出码'), false, 'active output does not fabricate a final result');
  layout.state.set(`tool:${activity.activityId}:expanded`, false);
  assert.equal(renderActivity().includes('<pre>'), false, 'a user can keep an active tool collapsed');
  layout.state.set(`tool:${activity.activityId}:expanded`, true);
  finish();
  const final = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(final.activities.some((entry) => entry.liveOutput), false);
  const completed = final.activities.find((entry) => entry.activityId === activity.activityId);
  assert.match(renderActivity(completed), /<button\b(?=[^>]*class="[^"]*\blocal-agent__tool-entry-heading\b)(?=[^>]*aria-expanded="true")[^>]*>/,
    'completion does not collapse details the user opened');
  assert.deepEqual(await decodeGuiProjection(final), final);
  assert.deepEqual((await readEvents(journal, sessionId)).filter((event) => event.type.startsWith('tool.')).map((event) => event.type), ['tool.requested', 'tool.started', 'tool.completed']);
});

test('scope-only Plan review foregrounds additions and keeps the complete confirmed phases available', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: PlanCard, PlanCardContent } = await loadGuiModule(t, '/src/components/local-agent/PlanCard.tsx');
  const { planScopeAddition } = await loadGuiModule(t, '/src/components/local-agent/planReview.ts');
  const { ConversationComposer } = await loadGuiModule(t, '/src/components/local-agent/ConversationComposer.tsx');
  const previous = {
    planId: 'plan:scope-review', revision: 1, runId: 'run:scope', callId: 'call:initial', status: 'confirmed',
    title: 'Implement pool', summary: 'Build and verify the pool.',
    steps: [{ stepId: 'core', title: 'Implement core', details: 'Maintain mutual exclusion.', verification: ['Run `--werror`'] }],
    mutationManifest: [{ workspaceId: 'workspace:pool', operation: 'fs.write', target: 'src' , targetKind: 'directoryTree' }],
  };
  const current = { ...previous, revision: 2, status: 'published', callId: 'call:extra',
    summary: `${previous.summary}\n\nExpose the shared options in \`include/pool/demo.hpp\`.`,
    mutationManifest: [...previous.mutationManifest, { workspaceId: 'workspace:pool', operation: 'fs.write', target: 'include/pool/demo.hpp' }],
  };
  const addition = planScopeAddition(previous, current);
  assert.equal(addition.operations.length, 1);
  assert.equal(addition.reason, 'Expose the shared options in `include/pool/demo.hpp`.');
  const html = renderToStaticMarkup(createElement(PlanCardContent, { plan: current, previousPlan: previous, language: 'zh-CN' }));
  const disclosure = html.indexOf('<details');
  assert.ok(disclosure > 0);
  assert.ok(html.slice(0, disclosure).includes('include/pool/demo.hpp'));
  assert.ok(html.slice(0, disclosure).includes('Expose the shared options'));
  assert.equal(html.slice(0, disclosure).includes('Maintain mutual exclusion'), false);
  assert.equal(html.includes('新增 0 步'), false);
  assert.match(html.slice(disclosure), /^<details[^>]*><summary>查看完整方案与全部范围/);
  assert.ok(html.slice(disclosure).includes('Maintain mutual exclusion'));
  assert.ok(html.slice(disclosure).includes('--werror'));
  assert.equal(planScopeAddition(previous, { ...current, steps: [{ ...current.steps[0], verification: [] }] }), null);
  assert.equal(planScopeAddition(previous, { ...current, mutationManifest: current.mutationManifest.slice(1) }), null);
  assert.equal(planScopeAddition(previous, { ...current, summary: 'A different objective.' }), null);
  const decision = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', uiActionError: null, composer: {
    pendingPlan: current, pendingScopeAddition: addition, textareaRef: { current: null }, draft: '', submitting: false,
    profiles: [], selectedProfileId: null, pastedTexts: [], failedDrafts: [], pendingFilesystemPaths: [],
    pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textDecision: true,
  } }));
  assert.match(decision, />确认新增范围<\/b>/);
  assert.ok(decision.includes('Expose the shared options'));
  assert.ok(decision.includes('include/pool/demo.hpp'));
  assert.ok(decision.includes('保留已有进度'));
  assert.equal((decision.match(/<textarea\b/g) ?? []).length, 1);
  const adjustment = renderToStaticMarkup(createElement(PlanCard, { plan: current, previousPlan: previous, active: false, language: 'zh-CN' }));
  assert.ok(adjustment.includes('计划范围调整'));
  assert.equal(adjustment.includes('local-agent__plan-card'), false, 'a scope adjustment is a compact record, not a second Plan card');
  assert.equal(adjustment.includes(previous.summary), false);
});

test('last-call, per-run, and Session cache rates use their own input token totals', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cache-scopes';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const usages = [
    { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 75, cacheMissInputTokens: 25 },
    { inputTokens: 300, outputTokens: 90, cacheReadInputTokens: 25, cacheMissInputTokens: 275 },
  ];
  let callIndex = 0;
  const provider = {
    async *stream(request) {
      const usage = usages[callIndex++];
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:cache-${callIndex}`,
        content: `Answer ${callIndex}.`,
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { ...usage, contextWindowTokens: 4_096 },
      });
    },
  };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'cache-scopes');
  t.after(() => actor.dispose());
  let projection;
  for (let index = 0; index < usages.length; index += 1) {
    await actor.submit(messageCommand(sessionId, `command:cache-${index}`, `Question ${index}.`));
    projection = await waitForProjection(actor, (value) => (
      value.run?.status === 'completed' && value.tokenUsage.providerCallCount === index + 1
    ));
  }
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const sessionCache = inputCacheMetric(projection.tokenUsage);
  const lastCallCache = lastCallInputCacheMetric(projection.contextUsage);
  assert.equal(sessionCache.inputTokens, 400);
  assert.equal(sessionCache.hitTokens, 100);
  assert.equal(sessionCache.hitPercent, 25);
  assert.equal(lastCallCache.inputTokens, 300);
  assert.equal(lastCallCache.hitTokens, 25);
  assert.equal(lastCallCache.hitPercent, 25 / 300 * 100);
  assert.deepEqual(projection.tokenUsageHistory.map((round) => ({
    input: round.inputTokens,
    hit: round.cacheReadInputTokens,
    miss: round.cacheMissInputTokens,
    ratio: round.cacheHitRatio,
  })), [
    { input: 300, hit: 25, miss: 275, ratio: 25 / 300 },
    { input: 100, hit: 75, miss: 25, ratio: 75 / 100 },
  ]);
  const lastReceipt = projection.contextCompositions.find((receipt) => (
    receipt.providerRequestId === projection.contextUsage.providerRequestId
  ));
  assert.ok(lastReceipt);
  assert.equal(lastReceipt.partitions.reduce((sum, part) => sum + part.estimatedInputTokens, 0), 300);
  assert.equal(lastCallInputCacheMetric(null), null);
  assert.equal(lastCallInputCacheMetric({
    inputTokens: 0, outputTokens: 0, contextWindowTokens: 4_096,
    cacheReadInputTokens: 0, cacheMissInputTokens: 0,
  }), null);
});

test('compaction preserves Agent usage and an unreported Agent call clears it without losing Session totals', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cache-latest';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  let releaseLastCall;
  const lastCallHeld = new Promise((resolve) => { releaseLastCall = resolve; });
  let callCount = 0;
  const requests = [];
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      const index = ++callCount;
      if (index === 3) await lastCallHeld;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:cache-latest-${index}`,
        content: request.purpose === 'contextCompaction' ? 'Keep the established facts.' : `Answer ${index}.`,
      });
      yield providerEvent(request.requestId, 'completed', index === 3 ? {} : {
        usage: {
          inputTokens: index === 1 ? 100 : 200,
          outputTokens: 10,
          cacheReadInputTokens: index === 1 ? 75 : 20,
          cacheMissInputTokens: index === 1 ? 25 : 180,
          contextWindowTokens: 4_096,
        },
      });
    },
  };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'cache-latest');
  t.after(async () => { releaseLastCall(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:cache-latest-seed', 'Establish the facts.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'context.focus',
    commandId: 'command:cache-latest-focus',
    sessionId,
    task: 'Preserve the established facts.',
  });
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'running' && callCount === 3
  ));
  assert.deepEqual(requests.map((request) => request.purpose), ['agent', 'contextCompaction', 'agent']);
  assert.equal(waiting.contextUsage.providerRequestId, requests[0].requestId);
  assert.equal(lastCallInputCacheMetric(waiting.contextUsage).hitPercent, 75);
  const compactedReceipt = waiting.contextCompositions.find((receipt) => (
    receipt.providerRequestId === waiting.contextUsage.providerRequestId
  ));
  assert.equal(compactedReceipt.purpose, 'agent');
  assert.equal(compactedReceipt.partitions.reduce((sum, part) => sum + part.estimatedInputTokens, 0), 100);
  assert.deepEqual(await decodeGuiProjection(waiting), waiting);
  releaseLastCall();
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.contextUsage, null);
  assert.equal(lastCallInputCacheMetric(completed.contextUsage), null);
  assert.equal(completed.contextCompositions.at(-1).providerRequestId, requests[2].requestId);
  assert.equal(completed.contextCompositions.length, 1);
  const historyService = new SessionService(journal, {
    async create() { throw new Error('historical_read_must_not_open_actor'); },
  });
  const historical = await historyService.contextComposition(sessionId, requests[0].requestId);
  assert.equal(historical.providerRequestId, requests[0].requestId);
  historical.messages.length = 0;
  assert.ok((await historyService.contextComposition(sessionId, requests[0].requestId)).messages.length > 0);
  await assert.rejects(historyService.contextComposition(sessionId, 'provider-request:missing'), /context_composition_not_found/u);
  assert.equal(completed.tokenUsage.inputTokens, 300);
  assert.equal(completed.tokenUsage.cacheReadInputTokens, 95);
  assert.equal(completed.tokenUsage.cacheHitRatio, 95 / 300);
  assert.equal(completed.tokenUsage.providerCallCount, 3);
  assert.equal(completed.tokenUsage.reportedCallCount, 2);
  assert.equal(completed.tokenUsage.cacheComplete, false);
  assert.equal(inputCacheMetric(completed.tokenUsage).complete, false);
  assert.deepEqual(await decodeGuiProjection(completed), completed);
});


test('GUI consumes complete phase plans and Todo beyond the former item count', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:many-phases';
  await createSession(journal, sessionId, [workspaceBinding]);
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const provider = { async *stream(request) {
    if (++calls === 1) {
      const tool = request.tools.find((entry) => entry.inputSchema.properties?.mutationManifest);
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:phase-plan', name: tool.name, input: {
        title: 'Current task phases', summary: 'Many file targets can belong to a phase.',
        steps: Array.from({ length: 13 }, (_, index) => ({ stepId: `phase-${index}`, title: `Phase ${index}`, details: 'Deliver the outcome.' })),
        mutationManifest: Array.from({ length: 129 }, (_, index) => ({ workspace: 'primary', operation: 'fs.write', target: `src/file-${index}.ts` })),
      } });
    } else if (calls === 2) {
      assert.equal((await actor.snapshot()).todoList, null, 'confirmed Plan keeps Todo optional');
      const progress = request.tools.find(entry => entry.name === 'todo_update');
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:phase-progress', name: progress.name,
        input: { items: Array.from({ length: 13 }, (_, index) => ({ text: `Phase ${index}`, status: 'pending' })) } });
    } else {
      await held;
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'provider-message:stop', content: 'Work remains pending.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation({ contextWindowTokens: 100_000 }).port, 'many-phases');
  t.after(async () => { finish(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:phase-plan', 'Plan the requested work.'));
  const waiting = await waitForProjection(actor, (value) => value.pendingPlan !== null);
  assert.deepEqual(await decodeGuiProjection(waiting), waiting);
  assert.equal(waiting.pendingPlan.steps.length, 13);
  assert.equal(waiting.pendingPlan.mutationManifest.length, 129);
  assert.equal(waiting.todoList, null, 'a proposal cannot seed the active Todo');
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond', commandId: 'command:phase-confirm', sessionId,
    runId: waiting.run.runId, planId: waiting.pendingPlan.planId, revision: 1, response: { kind: 'confirm' } });
  const confirmed = await waitForProjection(actor, (value) => value.todoList?.items.length === 13);
  assert.deepEqual(await decodeGuiProjection(confirmed), confirmed);
  assert.deepEqual(confirmed.todoList.items.map((item) => item.text), waiting.pendingPlan.steps.map((step) => step.title));
});

test('Provider status separates request elapsed time from the last observed content', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: Status } = await loadGuiModule(t, '/src/components/local-agent/ProviderStageStatus.tsx');
  const now = Date.parse('2026-09-12T12:00:30Z');
  t.mock.method(Date, 'now', () => now);
  const props = { run: { runId: 'run:status', status: 'running' }, language: 'zh-CN', toolPending: false };
  assert.ok(renderToStaticMarkup(createElement(Status, props)).includes('已接收，正在准备'));
  const activity = { purpose: 'agent', phase: 'waitingResponse', startedAt: '2026-09-12T12:00:00Z' };
  const waiting = renderToStaticMarkup(createElement(Status, { ...props, activity }));
  assert.ok(waiting.includes('等待模型响应'));
  assert.ok(waiting.includes('本次请求已用时 30 秒'));
  assert.ok(waiting.includes('title="尚未收到模型内容"'));
  const reasoning = renderToStaticMarkup(createElement(Status, { ...props, activity: {
    ...activity, phase: 'reasoning', lastContentAt: '2026-09-12T12:00:28Z',
  } }));
  assert.ok(reasoning.includes('本次请求已用时 30 秒'));
  assert.ok(reasoning.includes('title="最近内容输出距今 2 秒"'));
});

test('snapshot-scoped wire tool resolves to exact Kernel bindings, durable ToolRecord, and continuation', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read one fixture path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  let releaseTool;
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      await toolGate;
      return completedExecutionReply(request, { content: 'fixture file contents' });
    },
  });
  const providerRequests = [];
  let wireToolName;
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.path !== undefined
        ));
        assert.ok(definition, 'prepared Kernel tool must be exposed to Provider');
        wireToolName = definition.name;
        assert.notEqual(wireToolName, preparedTool.name);
        assert.match(wireToolName, /^[A-Za-z0-9_-]{1,64}$/u);
        assert.deepEqual(definition.inputSchema.required, ['path']);
        assert.ok(definition.inputSchema.properties.workspace);
        assert.equal(definition.inputSchema.properties.workspaceId, undefined);
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'I will inspect the fixture before answering.',
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:read',
          name: wireToolName,
          input: { workspace: 'primary', path: 'README.md' },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            contextWindowTokens: 4_096,
            cacheReadInputTokens: 40,
            cacheMissInputTokens: 60,
          },
        });
        return;
      }

      const definition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
      ));
      assert.equal(definition?.name, wireToolName);
      const assistantToolCall = request.messages
        .flatMap((entry) => entry.toolCalls ?? [])
        .find((call) => call.name === wireToolName);
      assert.ok(assistantToolCall, 'continuation must include the previous tool call');
      assert.equal(assistantToolCall.input, '{"workspace":"primary","path":"README.md"}');
      assert.notEqual(assistantToolCall.callId, 'provider-call:read');
      assert.equal(assistantToolCall.providerCallId, 'provider-call:read');
      assert.ok(request.messages.some((entry) => (
        entry.role === 'tool'
        && entry.toolCallId === assistantToolCall.callId
        && entry.providerCallId === 'provider-call:read'
      )), 'continuation must include the ToolRecord result');

      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:tool-answer',
        content: 'Tool continuation completed.',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          contextWindowTokens: 4_096,
        },
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'tool-chain',
  );
  t.after(async () => { releaseTool(); await actor.dispose(); });

  await actor.submit(messageCommand(sessionId, 'command:tool', 'Use the available fixture tool.'));
  await waitUntil(() => kernelRequests.length === 1, 'pending tool execution');
  try {
    const pending = await actor.snapshot();
    const activity = pending.activities.find((item) => item.kind === 'tool');
    assert.equal(activity.status, 'requested');
    assert.equal(activity.tool, undefined, 'requested tools have no execution record yet');
    assert.deepEqual(await decodeGuiProjection(pending), pending);
  } finally {
    releaseTool();
  }
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'tool runtime release');

  assert.equal(providerRequests.length, 2);
  assert.equal(kernelRequests.length, 1);
  assert.deepEqual(projection.tokenUsage, {
    providerCallCount: 2,
    reportedCallCount: 1,
    inputTokens: 150,
    outputTokens: 15,
    cacheReadInputTokens: 40,
    cacheMissInputTokens: 60,
    cacheAvailable: true,
    cacheComplete: false,
    cacheHitRatio: 40 / 150,
  });
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  assert.equal(inputCacheMetric(projection.tokenUsage).inputTokens, 150);
  assert.equal(lastCallInputCacheMetric(projection.contextUsage), null);
  const missingToolRecord = structuredClone(projection);
  delete missingToolRecord.activities.find((item) => item.kind === 'tool').tool;
  await assert.rejects(decodeGuiProjection(missingToolRecord), /conversation_projection_invalid/u);
  assert.deepEqual(projection.timeline.map((item) => item.kind), [
    'message',
    'narrative',
    'toolGroup',
    'message',
  ]);
  assert.equal(projection.narratives[0].content, 'I will inspect the fixture before answering.');
  assert.deepEqual(projection.timeline[2].activityIds, [projection.activities
    .find((activity) => activity.kind === 'tool').activityId]);
  const execution = kernelRequests[0];
  const runtime = preparation.snapshots[0];
  assert.deepEqual({
    sessionId: execution.sessionId,
    runId: execution.runId,
    extensionGenerationRef: execution.extensionGenerationRef,
    kernelCatalogSnapshotRef: execution.kernelCatalogSnapshotRef,
    toolBindingRef: execution.toolBindingRef,
    toolName: execution.toolName,
    input: execution.input,
  }, {
    sessionId,
    runId: projection.run.runId,
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: preparedTool.toolBindingRef,
    toolName: preparedTool.name,
    input: { workspaceId: workspaceBinding.workspaceId, path: 'README.md' },
  });

  const events = await readEvents(journal, sessionId);
  const requested = singleEvent(events, 'tool.requested');
  const toolCompleted = singleEvent(events, 'tool.completed');
  const completions = events.filter((event) => event.type === 'provider.turn.settled');
  assert.equal(completions.length, 2);
  assert.deepEqual(completions[0].payload.orderedCallIds, [requested.callId]);
  assert.notEqual(requested.callId, requested.payload.providerCallId);
  assert.equal(requested.payload.toolName, preparedTool.name);
  assert.deepEqual({
    extensionGenerationRef: toolCompleted.payload.record.extensionGenerationRef,
    kernelCatalogSnapshotRef: toolCompleted.payload.record.kernelCatalogSnapshotRef,
    toolBindingRef: toolCompleted.payload.record.toolBindingRef,
    callId: toolCompleted.payload.record.callId,
    attemptId: toolCompleted.payload.record.attemptId,
    toolName: toolCompleted.payload.record.toolName,
  }, {
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: preparedTool.toolBindingRef,
    callId: requested.callId,
    attemptId: requested.payload.attemptId,
    toolName: preparedTool.name,
  });
  assertEventOrder(requested, completions[0], toolCompleted, completions[1]);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: projection.run.runId,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
  }]);
});





test('Session model choices reconcile complete settings and preserve acknowledged values on command failure', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-settings';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream() { throw new Error('settings must not call Provider'); } }, emptyKernel(), fakeRunPreparation().port, 'gui-settings');
  t.after(() => actor.dispose());
  let commands = 0;
  let failSave = false;
  const profiles = [
    { id: 'profile:one', name: 'My fast model', model: 'configured-model', enabled: true, thinking: 'enabled' },
    { id: 'profile:two', name: 'My other model', model: 'configured-model', enabled: true, thinking: 'enabled' },
    { id: 'profile:off', name: 'No reasoning', model: 'configured-model', enabled: true, thinking: 'disabled' },
  ];
  const defaultProfileId = profiles[0].id;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname === '/api/llm/profiles') {
      if (init.method === 'PATCH') {
        const update = JSON.parse(init.body);
        assert.deepEqual(Object.keys(update), ['profile']);
        const index = profiles.findIndex(profile => profile.id === update.profile.id);
        assert.ok(index >= 0);
        profiles[index] = update.profile;
      }
      return Response.json({ ok: true, data: { profiles, defaultProfileId } });
    }
    const sessionPath = `/api/conversation/sessions/${encodeURIComponent(sessionId)}`;
    if (url.pathname === `${sessionPath}/commands` && init.method === 'POST') {
      commands += 1;
      if (failSave) {
        return Response.json({ ok: false, error: 'fixture_settings_save_failed' }, { status: 500 });
      }
      return Response.json({ ok: true, data: await actor.submit(JSON.parse(init.body)) });
    }
    if (url.pathname === `${sessionPath}/projection` && (init.method ?? 'GET') === 'GET') {
      return Response.json({ ok: true, data: await actor.snapshot() });
    }
    throw new Error(`unexpected_gui_request:${init.method ?? 'GET'}:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  await store.getState().refreshProfiles();
  store.setState({ sessionId, projection: await actor.snapshot() });
  assert.equal(await store.getState().selectModel('profile:one', 'low'), true);
  assert.equal(commands, 1, 'the complete model choice is one Session command');
  assert.deepEqual(store.getState().projection.modelSettings, { profileId: 'profile:one', reasoningEffortOverride: 'low' });
  assert.equal(await store.getState().selectModel('profile:two', 'medium'), true);
  assert.equal(store.getState().selectedProfileId, 'profile:two');
  assert.equal(store.getState().reasoningEffortOverride, 'medium');
  assert.equal((await actor.snapshot()).modelSettings.profileId, 'profile:two');
  assert.equal(store.getState().defaultProfileId, 'profile:one', 'selecting a model does not change the last actually used model');
  failSave = true;
  assert.equal(await store.getState().selectModel('profile:two', 'high'), false);
  assert.equal(store.getState().reasoningEffortOverride, 'medium');
  assert.equal((await actor.snapshot()).modelSettings.reasoningEffortOverride, 'medium');
  assert.match(store.getState().error, /fixture_settings_save_failed/);
  assert.equal(store.getState().modelSettingsBusy, false);
  failSave = false;
  assert.equal(await store.getState().selectModel('profile:off', null), true);
  assert.equal(store.getState().reasoningEffortOverride, null);
  assert.equal((await actor.snapshot()).run, null);
  store.getState().startNewSession();
  assert.equal(store.getState().selectedProfileId, 'profile:one');
  assert.equal(store.getState().reasoningEffortOverride, 'low');
});

test('draft model choices remember per-model effort and preserve saved preferences on failure', async (t) => {
  let profiles = [
    { id: 'profile:one', name: 'One', enabled: true, thinking: 'enabled' },
    { id: 'profile:two', name: 'Two', enabled: true, thinking: 'enabled' },
    { id: 'profile:off', name: 'Off', enabled: true, thinking: 'disabled' },
  ];
  let failSave = false;
  installGuiFetch(t, async (url, init) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    if (init.method === 'PATCH') {
      if (failSave) return Response.json({ ok: false, error: 'fixture_preference_save_failed' });
      const { profile } = JSON.parse(init.body);
      profiles = profiles.map(item => item.id === profile.id ? profile : item);
    }
    return Response.json({ ok: true, data: { profiles, defaultProfileId: 'profile:one' } });
  });
  const store = await loadGuiModelStore(t);
  await store.getState().refreshProfiles();
  assert.equal(await store.getState().selectModel('profile:one', 'high'), true);
  assert.equal(profiles[0].reasoningEffort, 'high');
  store.getState().startNewSession();
  assert.equal(store.getState().selectedProfileId, 'profile:one');
  assert.equal(store.getState().reasoningEffortOverride, 'high');
  assert.equal(await store.getState().selectModel('profile:two', 'low'), true);
  store.getState().startNewSession('project:another');
  assert.equal(store.getState().reasoningEffortOverride, 'high');
  assert.equal(store.getState().profiles.find(profile => profile.id === 'profile:two').reasoningEffort, 'low');
  const reopened = await loadGuiModelStore(t);
  await reopened.getState().refreshProfiles();
  assert.equal(reopened.getState().reasoningEffortOverride, 'high');
  assert.equal(reopened.getState().profiles.find(profile => profile.id === 'profile:two').reasoningEffort, 'low');
  assert.equal(await reopened.getState().selectModel('profile:one', null), true);
  assert.equal(reopened.getState().reasoningEffortOverride, null, 'inheritance remains an absent Session override');
  assert.equal(profiles[0].reasoningEffort, 'high', 'inheriting does not erase the configured Profile effort');
  failSave = true;
  assert.equal(await reopened.getState().selectModel('profile:one', 'max'), false);
  assert.match(reopened.getState().error, /fixture_preference_save_failed/);
  assert.equal(profiles[0].reasoningEffort, 'high');
  assert.equal(reopened.getState().reasoningEffortOverride, null, 'failed explicit selection preserves inheritance');
  assert.equal(reopened.getState().modelSettingsBusy, false);
  failSave = false;
  assert.equal(await reopened.getState().selectModel('profile:off', null), true);
  assert.equal(reopened.getState().reasoningEffortOverride, null);
});

test('composer accepts inherited effort and never enables a new run with a blank level', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ useLocalAgentStore: store }, { useAgentComposer }, { default: Selector }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
    '/src/components/local-agent/SessionModelSelector.tsx',
  ]);
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => JSON.stringify({ draft: 'Continue', pastedTexts: [], filesystemPaths: [], pluginSelections: [] }) };
  t.after(() => { if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage; });
  const profiles = [
    { id: 'profile:one', name: 'One', enabled: true, thinking: 'enabled', reasoningEffort: 'high' },
    { id: 'profile:two', name: 'Two', enabled: true, thinking: 'enabled' },
    { id: 'profile:off', name: 'Off', enabled: true, thinking: 'disabled' },
  ];
  store.setState({ profiles, defaultProfileId: 'profile:one' });
  store.getState().startNewSession();
  let composer;
  function Probe() { composer = useAgentComposer('zh-CN', () => {}); return null; }
  const render = () => {
    // Zustand's server snapshot is captured by its internal API.
    Object.assign(store.getInitialState(), store.getState());
    renderToStaticMarkup(createElement(Probe));
    return renderToStaticMarkup(createElement(Selector, { language: 'zh-CN', profiles,
      selectedProfileId: composer.selectedProfileId, reasoningEffortOverride: composer.reasoningEffortOverride,
      contextUsage: null, contextCompositions: [], confirmed: composer.modelSelectionConfirmed, onSelect: composer.selectModel }));
  };
  assert.match(render(), /One · 高/);
  assert.equal(composer.canSend, true, 'inherited settings need no per-conversation confirmation');
  store.getState().startNewSession('project:another');
  render();
  assert.equal(composer.canSend, true);
  store.setState({ selectedProfileId: 'profile:one', reasoningEffortOverride: null,
    sessionId: 'session:from-cli', projection: { plans: [], modelSettings: { profileId: 'profile:one', reasoningEffortOverride: null } } });
  assert.match(render(), /One · 高/);
  assert.equal(composer.canSend, true, 'a CLI Session can inherit its configured Profile without a GUI-only confirmation');
  assert.equal(store.getState().reasoningEffortOverride, null, 'rendering must not manufacture a Session override');
  store.setState({ selectedProfileId: 'profile:two', reasoningEffortOverride: null,
    sessionId: 'session:existing', projection: { plans: [], modelSettings: { profileId: 'profile:two', reasoningEffortOverride: null } } });
  assert.match(render(), /Two · 选择强度/);
  assert.equal(composer.canSend, false, 'a saved Session binding with no effort is not an explicit level');
  store.setState({ selectedProfileId: 'profile:off', reasoningEffortOverride: null });
  assert.match(render(), /Off · 不适用/);
  assert.equal(composer.canSend, true);
  const label = renderToStaticMarkup(createElement(Selector, { language: 'en-US', profiles,
    selectedProfileId: 'profile:two', reasoningEffortOverride: null, confirmed: true,
    contextUsage: null, contextCompositions: [], onSelect: async () => {} }));
  assert.match(label, /Two · Choose level/, 'even an inconsistent caller cannot render a blank level');
});

test('viewport hook resumes once on Plan confirmation and preserves later reader input with simulated dimensions', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ useLocalAgentStore: store }, { useAgentComposer }, { useConversationViewport }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
    '/src/components/local-agent/useConversationViewport.ts',
  ]);
  const previousWindow = globalThis.window, previousStorage = globalThis.sessionStorage;
  const frames = new Map(); let frameId = 0;
  globalThis.window = { requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } };
  globalThis.sessionStorage = { getItem: () => null };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage;
  });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  let release;
  const reply = new Promise(resolve => { release = resolve; });
  const projection = { sessionId: 'session:confirm', plans: [], pendingPlan: { planId: 'plan:confirm', revision: 1 } };
  store.setState({ sessionId: projection.sessionId, projection, respondPlan: async () => reply });
  Object.assign(store.getInitialState(), store.getState());
  let composer, viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: projection.sessionId, loading: false, projection,
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    composer = useAgentComposer('zh-CN', viewport.setLatestFollowMode);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const body = { scrollTop: 600, scrollHeight: 1600, clientHeight: 500,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }) };
  viewport.bodyRef.current = body;
  viewport.setLatestFollowMode(false);
  const confirmation = composer.submitPlanDecision({ kind: 'confirm' });
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 1100, 'confirmation resumes from a detached history position before the reply');
  viewport.bodyHandlers.onWheel({ target: body, deltaY: -200 });
  body.scrollTop = 900;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  release(); await confirmation;
  body.scrollHeight += 300;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 900, 'a late reply and further output do not override subsequent reader intent');
  await composer.submitPlanDecision({ kind: 'cancel' });
  body.scrollHeight += 100;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 900, 'cancel does not force latest');
});

test('starting a draft during initialization preserves navigation and still loads usable model configuration', async (t) => {
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  const catalog = { projects: [{
    id: 'project:boot', title: 'Project', workspaceBindings: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }], sessions: [] };
  const pluginCatalog = { revision: 'plugin-catalog:boot', plugins: [] };
  const profile = { id: 'profile:boot', name: 'My model', model: 'configured-model', enabled: true, thinking: 'enabled' };
  installGuiFetch(t, async (url, init) => {
    assert.equal(init.method ?? 'GET', 'GET');
    if (url.pathname === '/api/conversation/catalog') {
      return Response.json({ ok: true, data: await catalogReady });
    }
    if (url.pathname === '/api/conversation/plugins') {
      return Response.json({ ok: true, data: pluginCatalog });
    }
    if (url.pathname === '/api/llm/profiles') {
      return Response.json({ ok: true, data: { profiles: [profile], defaultProfileId: profile.id } });
    }
    throw new Error(`new draft must not restore a Session:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const initialization = store.getState().initialize();
  assert.equal(store.getState().loading, true);
  store.getState().startNewSession('project:boot');
  releaseCatalog(catalog);
  await initialization;
  const state = store.getState();
  assert.equal(state.draftProjectId, 'project:boot');
  assert.equal(state.sessionId, null);
  assert.equal(state.projection, null);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.deepEqual(state.catalog, catalog);
  assert.deepEqual(state.pluginCatalog, pluginCatalog);
  assert.deepEqual(state.profiles, [profile]);
  assert.equal(state.defaultProfileId, profile.id);
  assert.equal(state.selectedProfileId, profile.id);
});


test('independent views own navigation, errors and pending commands separately', async (t) => {
  const { createLocalAgentStore } = await loadGuiModule(t, '/src/state/localAgentStore.ts');
  const first = createLocalAgentStore();
  const second = createLocalAgentStore();
  first.setState({ sessionId: 'session:one', error: 'old failure', submitting: true });
  second.setState({ sessionId: 'session:two', error: null, submitting: false });
  first.getState().startNewSession();
  assert.equal(first.getState().sessionId, null);
  assert.equal(first.getState().submitting, false);
  assert.equal(second.getState().sessionId, 'session:two');
  assert.equal(second.getState().error, null);
  second.setState({ submitting: true });
  assert.equal(first.getState().submitting, false);
});

test('cached navigation displays immediately and another session read cannot block it', async (t) => {
  const journal = new InMemoryCommandJournal();
  const actors = [];
  const projections = {};
  for (const id of ['one', 'two']) {
    const sessionId = `session:${id}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const actor = actorWith(journal, sessionId, { async *stream() {} }, emptyKernel(), fakeRunPreparation().port, id);
    actors.push(actor);
    projections[sessionId] = await actor.snapshot();
  }
  t.after(() => Promise.all(actors.map((actor) => actor.dispose())));
  const store = await loadGuiModelStore(t);
  store.setState({ catalog: { projects: [], sessions: Object.keys(projections).map((id) => ({ id })) } });
  let releaseSlow;
  let slowId;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let requests = 0;
  let readSignal;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: Object.values(projections).map((p) => ({ sessionId: p.sessionId, revision: p.revision, run: p.run })) });
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    assert.ok(projections[id]);
    requests += 1;
    if (id === slowId) { readSignal = init.signal; await slow; }
    return Response.json({ ok: true, data: projections[id] });
  });
  await store.getState().activateSession('session:one');
  const cached = store.getState().projection;
  slowId = 'session:two';
  const openingTwo = store.getState().activateSession('session:two');
  await waitUntil(() => readSignal !== undefined);
  const openingOne = store.getState().activateSession('session:one');
  assert.equal(store.getState().projection, cached);
  assert.equal(store.getState().loading, false);
  assert.equal(readSignal.aborted, true, 'only the previous view read is cancelled');
  await openingOne;
  assert.equal(requests, 2, 'cached idle history is not fetched again when its revision is unchanged');
  await store.getState().refresh();
  assert.equal(requests, 2, 'idle polling reads status, not full history');
  const count = requests;
  await store.getState().activateSession('session:one');
  assert.equal(requests, count, 'selecting the active session does not reopen it');
  releaseSlow();
  await openingTwo;
  assert.equal(store.getState().sessionId, 'session:one');
  assert.equal(store.getState().projection.sessionId, 'session:one');
  const changed = await actors[0].submit({ schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', commandId: 'command:cache-profile', sessionId: 'session:one', settings: { profileId: 'profile:test', reasoningEffortOverride: 'low' } });
  assert.equal(changed.status, 'accepted');
  projections['session:one'] = await actors[0].snapshot();
  await store.getState().refresh();
  assert.equal(requests, 3, 'a newer server revision invalidates the cached snapshot');
  assert.equal(store.getState().projection.modelSettings.reasoningEffortOverride, 'low');
  await store.getState().activateSession('session:two');
  assert.equal(requests, 4, 'an aborted late response was not installed in the recent-session cache');
});

test('continuous conversation keeps every message anchor while mounting nearby content', async (t) => {
  const { conversationNavigation } = await loadGuiModule(t, '/src/components/local-agent/conversationWindow.ts');
  const rows = Array.from({ length: 75 }, (_, index) => ({
    key: `row:${index}`,
    item: { type: 'message', value: { role: index === 0 || index === 65 ? 'user' : 'assistant', content: `Message ${index}`, filesystemReferences: [] } },
  }));
  const rounds = [{ key: 'run:long', runId: 'run:long', rows }];
  const navigation = conversationNavigation(rounds);
  assert.deepEqual(navigation.map((entry) => entry.key), ['row:0', 'row:65']);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConversationNavigation } = await loadGuiModule(t, '/src/components/local-agent/ConversationNavigation.tsx');
  const html = renderToStaticMarkup(createElement(ConversationNavigation, { entries: navigation, viewport: { bodyRef: { current: null } }, onNavigate() {}, language: 'zh-CN' }));
  assert.match(html, /aria-label="对话导航"/);
  assert.match(html, /跳至消息 1: Message 0/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);

  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ ConversationTranscript }, { ConversationLayoutCache }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx', '/src/components/local-agent/conversationVirtualizer.ts',
  ]);
  const props = {
    layoutCache: new ConversationLayoutCache(),
    language: 'zh-CN', loading: false, displaySettledRunIds: new Set(), artifacts: [], onDisplayed() {},
    projection: { sessionId: 'session:long', run: null, plans: [], activities: [], fileChangeRounds: [], artifacts:[] },
    hasConversationContent: true, draftItems: [],
    conversationItems: rows.map((row, index) => ({ ...row.item, sequence: index, streamId: `stream:${index}`, value: { ...row.item.value, messageId: row.key, runId: 'run:long' } })),
    presentation: { content: (id) => id },
    viewport: { bodyRef: { current: null }, transcriptRef: { current: null }, messageEndRef: { current: null }, followingLatest: true, setLatestFollowMode() {}, preserveReadingPosition() {}, scrollToAnchor() {} },
    openWorkspaceResource() {}, setUiActionError() {},
  };
  const transcript = renderToStaticMarkup(createElement(ConversationTranscript, props));
  const anchors = [...transcript.matchAll(/data-conversation-anchor="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(anchors, rows.map((_, index) => `stream:${index}`), 'all earlier anchors remain in the continuous scroll surface in original order');
  assert.equal(transcript.includes('查看较早的内容'), false);
  assert.equal(transcript.includes('查看较新的内容'), false);
  assert.ok((transcript.match(/data-virtual-rendered="false"/g) ?? []).length > 0, 'offscreen rows retain placeholders instead of mounting all content');
  assert.ok((transcript.match(/data-virtual-rendered="true"/g) ?? []).length > 0, 'the recent tail is mounted immediately');
  const withChanges = renderToStaticMarkup(createElement(ConversationTranscript, { ...props,
    displaySettledRunIds: new Set(['run:long']), projection: { ...props.projection,
      fileChangeRounds: [{ runId: 'run:long', recordIds: ['record:old'] }],
      activities: [{ tool: { recordId: 'record:old', fileChanges: [{ workspaceId: 'workspace:session', path: 'old-history.txt',
        kind: 'create', before: { exists: false }, after: { exists: true, sizeBytes: 5 } }] } }],
    } }));
  assert.match(withChanges, /data-conversation-anchor="run:long:file-changes"[^>]*data-virtual-rendered="false"/);
  assert.equal(withChanges.includes('old-history.txt'), false, 'historical file reads mount through the same virtual surface');
  const withMembers = renderToStaticMarkup(createElement(ConversationTranscript, { ...props,
    displaySettledRunIds: new Set(['run:long']), projection: { ...props.projection,
      agentTasks: [{ taskId: 'task:old', agentSessionId: 'session:child', displayName: 'History member', parentRunId: 'run:long', status: 'completed' }],
    } }));
  assert.equal((withMembers.match(/data-conversation-anchor=/g) ?? []).length, rows.length, 'members do not add a duplicate round footer');
  assert.doesNotMatch(withMembers, /History member/);
  const starting = renderToStaticMarkup(createElement(ConversationTranscript, { ...props, conversationItems: [], projection: { ...props.projection, run: { runId: 'run:starting', status: 'running' } } }));
  assert.match(starting, /data-conversation-anchor="run:starting:provider-status"/, 'a starting run retains its live status slot');
});

test('virtual rows preserve measured height, reading layout and per-session presentation state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ConversationLayoutCache, ConversationVirtualizer } = await loadGuiModule(t, '/src/components/local-agent/conversationVirtualizer.ts');
  const previousIntersection = globalThis.IntersectionObserver;
  const previousResize = globalThis.ResizeObserver;
  let intersections; let resizes;
  class Observer {
    observed = new Set();
    observe(node) { this.observed.add(node); }
    unobserve(node) { this.observed.delete(node); }
    disconnect() { this.observed.clear(); }
  }
  globalThis.IntersectionObserver = class extends Observer { constructor(callback, options) { super(); this.callback = callback; this.options = options; intersections = this; } };
  globalThis.ResizeObserver = class extends Observer { constructor(callback) { super(); this.callback = callback; resizes = this; } };
  t.after(() => { globalThis.IntersectionObserver = previousIntersection; globalThis.ResizeObserver = previousResize; });
  const cache = new ConversationLayoutCache();
  let corrections = 0;
  const virtual = new ConversationVirtualizer(cache.session('one'), () => corrections++);
  const listeners = new Map();
  const root = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  root.ownerDocument = root;
  let height = 285;
  const node = { dataset: { conversationAnchor: 'row:old', virtualRendered: 'true' }, hidden: false, getBoundingClientRect: () => ({ height }), contains: () => false, ownerDocument: { activeElement: null, getSelection: () => null } };
  const visibility = [];
  const unregister = virtual.register('row:old', node, (value) => visibility.push(value));
  virtual.connect(root);
  assert.equal(intersections.options.root, root);
  assert.ok(intersections.observed.has(node));
  assert.equal(virtual.layout('row:old').height, 285);
  intersections.callback([{ target: node, isIntersecting: false }]);
  assert.deepEqual(visibility, [], 'leaving the viewport retains recently read content');
  t.mock.timers.tick(30_000);
  assert.deepEqual(visibility, [false]);
  node.dataset.virtualRendered = 'false'; height = 120;
  resizes.callback([{ target: node }]);
  assert.equal(virtual.layout('row:old').height, 285, 'placeholder estimates never overwrite measured content height');
  intersections.callback([{ target: node, isIntersecting: true }]);
  assert.deepEqual(visibility, [false, true], 'scrolling back mounts history without a button');
  node.dataset.virtualRendered = 'true'; height = 410;
  resizes.callback([{ target: node }]);
  assert.equal(virtual.layout('row:old').height, 410);
  assert.equal(corrections, 2, 'initial measurement and later media layout notify the existing anchor owner');
  virtual.layout('row:old').state.set('expanded', true);
  unregister(); virtual.disconnect();
  assert.equal(intersections.observed.size, 0); assert.equal(resizes.observed.size, 0);
  assert.equal(listeners.size, 0);
  intersections.callback([{ target: node, isIntersecting: true }]);
  assert.equal(visibility.length, 2, 'late observer results cannot affect an unmounted session');
  const other = new ConversationVirtualizer(cache.session('two'), () => {});
  assert.equal(other.layout('row:old').state.has('expanded'), false);
  const revisit = new ConversationVirtualizer(cache.session('one'), () => {});
  assert.equal(revisit.layout('row:old').height, 410);
  assert.equal(revisit.layout('row:old').state.get('expanded'), true);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConversationVirtualRow, useConversationRowState } = await loadGuiModule(t, '/src/components/local-agent/ConversationVirtualRow.tsx');
  const Disclosure = () => {
    const [expanded] = useConversationRowState('expanded', false);
    return createElement('span', null, expanded ? 'still open' : 'closed');
  };
  const markup = (owner) => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'row:old', virtualizer: owner, eager: true, children: () => createElement(Disclosure),
  }));
  assert.match(markup(revisit), /still open/, 'the remounted component consumes its saved disclosure state');
  assert.match(markup(other), /closed/, 'another session never inherits it');
});

test('recent virtual rows cancel release on return and keep focus until interaction ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ConversationLayoutCache, ConversationVirtualizer } = await loadGuiModule(t, '/src/components/local-agent/conversationVirtualizer.ts');
  const previousIntersection = globalThis.IntersectionObserver, previousResize = globalThis.ResizeObserver;
  let intersection;
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersection = callback; }
    observe() {} unobserve() {} disconnect() {}
  };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  t.after(() => { globalThis.IntersectionObserver = previousIntersection; globalThis.ResizeObserver = previousResize; });
  const listeners = new Map();
  const document = { activeElement: null, getSelection: () => null,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const root = { ...document, ownerDocument: document };
  const node = { dataset: { conversationAnchor: 'recent', virtualRendered: 'true' }, hidden: false,
    ownerDocument: document, contains: target => target === node, getBoundingClientRect: () => ({ height: 240 }) };
  const virtual = new ConversationVirtualizer(new ConversationLayoutCache().session('recent'), () => {});
  const visibility = [];
  const unregister = virtual.register('recent', node, visible => visibility.push(visible));
  virtual.connect(root);
  const leave = () => intersection([{ target: node, isIntersecting: false }]);
  const enter = () => intersection([{ target: node, isIntersecting: true }]);
  leave(); t.mock.timers.tick(29_000);
  assert.deepEqual(visibility, [], 'content is still mounted during the retention window');
  enter(); t.mock.timers.tick(2_000);
  assert.deepEqual(visibility, [true], 'returning cancels the old release deadline');
  leave(); t.mock.timers.tick(29_999);
  assert.deepEqual(visibility, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(visibility, [true, false], 'a subsequent departure gets a fresh retention window');
  enter(); leave();
  document.activeElement = node;
  t.mock.timers.tick(30_000);
  assert.deepEqual(visibility, [true, false, true], 'focused offscreen content stays mounted after expiry');
  document.activeElement = null;
  listeners.get('focusout')(); await Promise.resolve();
  t.mock.timers.tick(30_000);
  assert.deepEqual(visibility, [true, false, true, false]);
  enter(); leave();
  document.getSelection = () => ({ isCollapsed: false, anchorNode: node, focusNode: node });
  t.mock.timers.tick(30_000);
  assert.equal(visibility.at(-1), true, 'selected offscreen content also stays mounted');
  document.getSelection = () => null;
  listeners.get('selectionchange')(); await Promise.resolve();
  unregister(); t.mock.timers.tick(30_000);
  assert.equal(visibility.at(-1), true, 'unregister cancels pending row release');
  const unmount = virtual.register('recent', node, visible => visibility.push(visible));
  leave(); virtual.disconnect(); t.mock.timers.tick(30_000);
  assert.equal(visibility.at(-1), true, 'disconnect cancels pending releases without changing unmounted rows');
  assert.equal(listeners.size, 0);
  unmount();
});

test('Markdown keeps archived artifact links and image sources in streaming and final answers', async (t) => {
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const artifact = 'artifact://artifact:session:review:attempt:final';
  const source = `[Report](${artifact})\n\n![Review image](${artifact})\n\n[Unsafe](javascript:alert)\n\n![Workspace image](workspace://workspace:review/review.png)`;
  const parser = new StreamingMarkdownParser();
  for (const streaming of [true, false]) {
    const references = [];
    const visit = node => {
      if (node.type === 'element' && ['a', 'img'].includes(node.tagName)) references.push([node.tagName, node.properties.href ?? node.properties.src]);
      node.children?.forEach(visit);
    };
    parser.update(source, streaming).forEach(block => visit(block.tree));
    assert.deepEqual(references, [['a', artifact], ['img', artifact], ['a', ''], ['img', 'workspace://workspace:review/review.png']]);
  }
});

test('completed Markdown is reused across remounts while changed and streaming text stay current', async (t) => {
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const text = '# Cached answer\n\nA **completed** paragraph.';
  const first = new StreamingMarkdownParser().update(text, false);
  assert.equal(new StreamingMarkdownParser().update(text, false), first);
  const changed = new StreamingMarkdownParser().update(text + '\n\nNew evidence.', false);
  assert.notEqual(changed, first);
  assert.ok(JSON.stringify(changed).includes('New evidence.'));
  const live = new StreamingMarkdownParser();
  assert.ok(live.update(text, true).some((block) => block.streaming));
  assert.equal(live.update(text, false), first);
});

test('paste detection preserves Unicode text and derives only a display title', async (t) => {
  const { isLongPastedText, pastedTextTitle } = await loadGuiModule(t, '/src/services/pastedText.ts');
  assert.equal(isLongPastedText('ordinary question'), false);
  const text = '文档标题\n' + '原文🙂\n'.repeat(5000);
  assert.equal(isLongPastedText(text), true);
  assert.equal(pastedTextTitle(text), '文档标题');
  assert.ok(text.endsWith('原文🙂\n'));
});

test('large GUI input uploads the complete text and submits only the resulting resource reference', async (t) => {
  const api = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const content = '  完整输入🙂\n'.repeat(10000);
  const reference = { referenceId: 'input:one', workspaceId: 'workspace:input', logicalPath: 'user-input.txt', displayName: '完整输入🙂', kind: 'file', mediaType: 'text/plain', byteLength: Buffer.byteLength(content), source: 'pastedText' };
  const seen = [];
  installGuiFetch(t, (url, init) => {
    seen.push(url.pathname);
    if (url.pathname.includes('/input-resources/')) {
      assert.equal(init.body, content);
      return Response.json({ ok: true, data: { text: '', reference } });
    }
    const command = JSON.parse(init.body);
    assert.equal(command.text, '', 'transport guidance must not replace the displayed user message');
    assert.deepEqual(command.filesystemReferences, [reference]);
    assert.ok(Buffer.byteLength(init.body) < 2000);
    return Response.json({ ok: true, data: { schemaVersion: 'deepcode.command-reply.v3', commandId: command.commandId, sessionId: command.sessionId, status: 'accepted', revision: 1 } });
  });
  await api.submitLocalAgentCommand({ schemaVersion: 'deepcode.command.v3', type: 'message.submit', commandId: 'command:upload', sessionId: 'session:upload', text: content });
  assert.equal(seen.length, 2);
});

test('GUI submits an image-only message and keeps its bound attachment', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:image-only-gui';
  await createSession(journal, sessionId, [workspaceBinding]);
  const image = { referenceId: 'reference:screen', workspaceId: 'workspace:screen', logicalPath: 'screen.png',
    displayName: 'screen.png', kind: 'file', mediaType: 'image/png', byteLength: 8 };
  const requests = [], commands = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    yield providerEvent(request.requestId, 'text.delta', { text: 'Image received.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'image-only-gui');
  t.after(() => actor.dispose());
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/filesystem-references/resolve')) return Response.json({ ok: true, data: [image] });
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body); commands.push(command);
      return Response.json({ ok: true, data: await actor.submit(command) });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:images', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: await actor.snapshot(), selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }] });
  await store.getState().sendMessage('', [{ path: '/pictures/screen.png', kind: 'file' }]);
  assert.equal(commands[0].text, '');
  assert.deepEqual(commands[0].filesystemReferences, [image]);
  const completed = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.deepEqual(completed.messages[0].filesystemReferences, [image]);
  assert.equal(requests[0].messages.find(message => message.images)?.images[0].workspaceId, image.workspaceId);
  await assert.rejects(store.getState().sendMessage(''), /message_empty/);
});

test('GUI submission keeps the ordinary message separate from pasted text references', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:pasted-message';
  await createSession(journal, sessionId, [workspaceBinding]);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'assistant.message', { messageId: 'answer:pasted', content: 'Received.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'pasted');
  t.after(() => actor.dispose());
  const reference = { referenceId: 'reference:pasted', workspaceId: 'workspace:pasted', logicalPath: 'user-input.txt',
    displayName: '长文标题', kind: 'file', mediaType: 'text/plain', byteLength: 40000, source: 'pastedText' };
  const content = '长文内容'.repeat(10000);
  const commands = [];
  const catalog = { projects: [], sessions: [] };
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.includes('/input-resources/')) {
      assert.equal(init.body, content);
      return Response.json({ ok: true, data: { text: '', reference } });
    }
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body);
      commands.push(command);
      return Response.json({ ok: true, data: await actor.submit(command) });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: catalog });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:pasted', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: await actor.snapshot(), catalog,
    selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }] });
  await store.getState().sendMessage('这份协议说了什么', [], [], [{ inputId: 'paste:one', text: content }]);
  const command = commands.find((command) => command.type === 'message.submit');
  assert.equal(command.text, '这份协议说了什么');
  assert.deepEqual(command.filesystemReferences, [reference]);
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  const message = projection.messages.find((message) => message.role === 'user');
  assert.equal(message.content, '这份协议说了什么');
  assert.deepEqual(message.filesystemReferences, [reference]);
});

test('tool rows accumulate across adjacent requests without crossing message or run boundaries', async (t) => {
  const { projectionItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const activities = [1, 2, 3, 4].map((id) => ({ activityId: `a${id}`, runId: id === 4 ? 'run:two' : 'run:one' }));
  const group = (id) => ({ kind: 'toolGroup', timelineId: `group:${id}`, sequence: id, activityIds: [`a${id}`] });
  const projection = { interactions: [], activities, narratives: [], plans: [], messages: [{ messageId: 'message:boundary', runId: 'run:one', role: 'user' }], timeline: [group(1), group(2), { kind: 'message', sequence: 3, messageId: 'message:boundary' }, group(3), group(4)] };
  const items = projectionItems(projection);
  assert.deepEqual(items.map((item) => item.type), ['toolGroup', 'message', 'toolGroup', 'toolGroup']);
  assert.equal(items[0].groupId, 'group:1');
  assert.deepEqual(items[0].values.map((activity) => activity.activityId), ['a1', 'a2']);
  assert.equal(projection.timeline.length, 5, 'presentation grouping leaves the canonical timeline intact');
  assert.equal(projectionItems(projection), items, 'revisiting the same snapshot reuses display rows');
});

test('plan preview occupies its native output position and has no confirmation identity', async (t) => {
  const { assistantDraftItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const preview = { callIndex: 1, providerCallId: 'call:plan', outputIndex: 1, title: 'Plan', summary: '', steps: ['Inspect'], truncated: false };
  const draft = { runId: 'run:one', turnId: 'request:one', planPreview: preview, blocks: [
    { kind: 'narrative', streamId: 'stream:before', outputIndex: 0, content: 'Before' },
    { kind: 'message', streamId: 'stream:after', outputIndex: 2, content: 'After' },
  ] };
  const items = assistantDraftItems(draft);
  assert.deepEqual(items.map((item) => item.type), ['text', 'planPreview', 'text']);
  assert.deepEqual(items[1].value, preview);
  assert.equal(items[1].value.planId, undefined);
  assert.equal(items[1].value.revision, undefined);
});

test('Plan documents and previews render Markdown entities, code names and verification consistently', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: PlanCard, PlanCardContent } = await loadGuiModule(t, '/src/components/local-agent/PlanCard.tsx');
  const { PlanPreviewCard, PlanPreviewContent } = await loadGuiModule(t, '/src/components/local-agent/PlanPreviewCard.tsx');
  const { MarkdownInline } = await loadGuiModule(t, '/src/components/local-agent/BufferedMarkdown.tsx');
  const { ComposerDecisionPanels, ComposerQuestionPrompt } = await loadGuiModule(t, '/src/components/local-agent/ComposerDecisionPanels.tsx');
  const [{ InteractionReplyQuote }, { ConversationVirtualRow }, { ConversationLayoutCache, ConversationVirtualizer }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx',
    '/src/components/local-agent/ConversationVirtualRow.tsx',
    '/src/components/local-agent/conversationVirtualizer.ts',
  ]);
  const plan = {
    planId: 'plan:document', revision: 1, runId: 'run:document', callId: 'call:document', status: 'published',
    title: '对象池 ObjectPool&lt;T,N&gt; 升级', summary: '保留 **互斥访问** 与 `C++17`。',
    steps: [{ stepId: 'write', title: '实现 `ObjectPool<T,N>`', details: '修改 `src/pool.hpp`。\n\n- 构造对象\n- 归还对象', verification: ['编译 **通过**；`exit 0`。'] }],
    mutationManifest: [{ workspaceId: 'workspace:private-id', operation: 'bash', writablePaths: [{ path: 'build', kind: 'directory' }] }],
  };
  const published = renderToStaticMarkup(createElement(PlanCard, { plan, active: false, language: 'zh-CN' }));
  assert.ok(published.includes('aria-expanded="false"'), 'published plans wait for the reader to expand');
  assert.ok(published.includes('ObjectPool&lt;T,N&gt;'));
  const html = renderToStaticMarkup(createElement(PlanCardContent, { plan, language: 'zh-CN' }));
  assert.ok(html.includes('ObjectPool&lt;T,N&gt;'));
  assert.equal(html.includes('&amp;lt;'), false, 'entities must be interpreted once by the Markdown parser');
  assert.match(html, /<code>ObjectPool&lt;T,N&gt;<\/code>/);
  assert.match(html, /<strong>通过<\/strong>/);
  assert.match(html, /<code>exit 0<\/code>/);
  assert.equal(html.includes('undefined'), false, 'optional command examples must not leak undefined');
  assert.equal(html.includes('workspace:private-id'), false, 'single-workspace review does not need internal IDs');
  assert.ok(html.includes('写入范围'));
  assert.ok(html.includes('build/'));
  const revisedPlan = { ...plan, revision: 2,
    steps: [{ ...plan.steps[0], verification: ['ctest 通过'] }],
    mutationManifest: [{ workspaceId: 'workspace:private-id', operation: 'fs.edit', target: 'src', targetKind: 'directoryTree' }],
  };
  const beforeRevision = { ...plan, steps: [{ ...plan.steps[0], verification: ['`--werror` 通过'] }] };
  const revisionHtml = renderToStaticMarkup(createElement(PlanCardContent, { plan: revisedPlan, previousPlan: beforeRevision, language: 'zh-CN' }));
  assert.ok(revisionHtml.includes('新增范围：'));
  assert.ok(revisionHtml.includes('移除范围：'));
  assert.ok(revisionHtml.includes('目录内文件，含新建'));
  assert.match(revisionHtml, /移除验收：[\s\S]*<code>--werror<\/code>/);
  assert.match(revisionHtml, /新增验收：[\s\S]*ctest 通过/);
  const englishRevision = renderToStaticMarkup(createElement(PlanCardContent, { plan: revisedPlan, previousPlan: beforeRevision, language: 'en-US' }));
  assert.ok(englishRevision.includes('Removed verification:'));
  const previewProps = { language: 'zh-CN', preview: {
    callIndex: 0, providerCallId: 'call:preview', title: plan.title, summary: plan.summary, steps: plan.steps.map((step) => step.title), truncated: false,
  } };
  const previewCard = renderToStaticMarkup(createElement(PlanPreviewCard, previewProps));
  assert.ok(previewCard.includes('aria-expanded="false"'));
  assert.equal(previewCard.includes('确认执行'), false);
  const preview = renderToStaticMarkup(createElement(PlanPreviewContent, previewProps));
  for (const rendered of [html, preview]) {
    assert.match(rendered, /<code>ObjectPool&lt;T,N&gt;<\/code>/);
  }
  assert.equal(preview.includes('确认执行'), false, 'a display-only preview cannot authorize execution');
  const inline = renderToStaticMarkup(createElement(MarkdownInline, { children: '**对象池** [文档](https://example.com) `T<N>`' }));
  assert.match(inline, /<strong>对象池<\/strong>/);
  assert.equal(inline.includes('<a '), false, 'summary buttons cannot contain nested interactive links');
  const collapsed = renderToStaticMarkup(createElement(PlanCard, { plan: { ...plan, status: 'confirmed' }, active: true, language: 'zh-CN' }));
  assert.equal(collapsed.includes('&amp;lt;'), false);
  assert.ok(collapsed.includes('aria-expanded="false"'));
  const Decision = props => createElement('div', null, createElement(ComposerQuestionPrompt, props), createElement(ComposerDecisionPanels, props));
  const initialDecision = renderToStaticMarkup(createElement(Decision, { language: 'zh-CN', composer: {
    pendingPlan: plan, pendingScopeAddition: null, submitting: false,
  } }));
  assert.ok(initialDecision.includes('ObjectPool&lt;T,N&gt;'));
  assert.ok(initialDecision.includes('确认执行'));
  const workspaceDecision = renderToStaticMarkup(createElement(Decision, { language: 'zh-CN', composer: {
    pendingPlan: { ...plan, workspaceRequests: [{ workspaceId: 'workspace:join-private', rootPath: '/projects/benchmark' }] },
    pendingScopeAddition: null, submitting: false,
  } }));
  assert.ok(workspaceDecision.includes('将以下目录加入工作区？'));
  assert.ok(workspaceDecision.includes('/projects/benchmark'));
  assert.ok(workspaceDecision.includes('加入工作区并确认计划'));
  assert.ok(workspaceDecision.includes('不加入并取消计划'));
  assert.equal(workspaceDecision.includes('workspace:join-private'), false);
  const workspaceEnglish = renderToStaticMarkup(createElement(Decision, { language: 'en-US', composer: {
    pendingPlan: { ...plan, workspaceRequests: [{ workspaceId: 'workspace:join-private', rootPath: '/projects/benchmark' }] },
    pendingScopeAddition: null, submitting: false,
  } }));
  assert.ok(workspaceEnglish.includes('Add folders and confirm Plan'));
  assert.ok(workspaceEnglish.includes('Cancel without adding folders'));
  assert.equal(initialDecision.includes('互斥访问'), false, 'the complete Plan body belongs only to its document card');
  const prompt = '保留 **容器环境** 吗？\n\n- 保留 `Dockerfile`\n- 删除演示产物';
  const question = renderToStaticMarkup(createElement(Decision, { language: 'zh-CN', composer: {
    pendingInteraction: { prompt, allowFreeform: true, options: [{ id: 'keep', label: '**保留**环境', description: '保留 `Makefile`，参见[说明](https://example.com)。' }] },
    textareaRef: { current: null }, draft: '',
    submitting: true,
  } }));
  assert.match(question, /<strong>容器环境<\/strong>/);
  assert.match(question, /<code>Dockerfile<\/code>/);
  assert.match(question, /<code>Makefile<\/code>/);
  const optionButton = [...question.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map(([button]) => button).find((button) => button.includes('Makefile'));
  assert.ok(optionButton, 'the option remains a native action button');
  assert.match(optionButton, /disabled=""/);
  assert.match(optionButton, /<code>Makefile<\/code>/, 'the description is part of the option hit target and accessible name');
  assert.ok(optionButton.includes('说明'));
  assert.equal(optionButton.includes('<a '), false, 'an option cannot contain a second interactive link');
  const virtualizer = new ConversationVirtualizer(new ConversationLayoutCache().session('session:reply'), () => {});
  const renderReply = () => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'message:reply', virtualizer, eager: true,
    children: () => createElement(InteractionReplyQuote, { prompt, language: 'zh-CN' }),
  }));
  const reply = renderReply();
  assert.match(reply, /aria-expanded="false"/);
  assert.match(reply, /<strong>容器环境<\/strong>/);
  assert.equal(reply.includes('Dockerfile'), false, 'the collapsed quote only mounts its first-paragraph preview');
  virtualizer.layout('message:reply').state.set('interaction-reply:expanded', true);
  const expandedReply = renderReply();
  assert.match(expandedReply, /aria-expanded="true"/);
  assert.match(expandedReply, /aria-label="收起问题"/);
  assert.equal(expandedReply.match(/容器环境/g)?.length, 1, 'expanding replaces the preview instead of repeating the question');
  assert.match(expandedReply, /<li>保留 <code>Dockerfile<\/code><\/li>/, 'the full question retains its Markdown after answering');
  assert.ok(expandedReply.includes('删除演示产物'));
  virtualizer.layout('message:reply').state.set('interaction-reply:expanded', false);
  assert.equal(renderReply(), reply, 'collapsing restores the original preview');
});

test('reasoning details are a default-off shell preference in the real Settings catalog', async (t) => {
  const { SETTING_DEFINITIONS } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  const definition = SETTING_DEFINITIONS.find((definition) => definition.key === 'gui.showReasoning');
  assert.ok(definition);
  const { DEFAULT_USER_SETTINGS } = await import('../../protocol/dist/index.js');
  assert.equal(DEFAULT_USER_SETTINGS['gui.showReasoning'], false);
  assert.equal(definition.control, 'boolean');
  assert.equal(definition.group, 'gui');
});

test('response language uses the shared Settings catalog and a compact labelled control', async (t) => {
  const { SETTING_DEFINITIONS, agentSettingDefinitions } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  const { DEFAULT_USER_SETTINGS, shellPreferenceSettingsIndex } = await import('../../protocol/dist/index.js');
  const definition = SETTING_DEFINITIONS.find((item) => item.key === 'agent.responseLanguage');
  const registered = agentSettingDefinitions().find((item) => item.key === definition.key);
  assert.ok(registered);
  const { catalog, ...registeredDefinition } = registered;
  assert.equal(catalog.domain, 'agent');
  assert.deepEqual(registeredDefinition, definition);
  assert.equal(DEFAULT_USER_SETTINGS[definition.key], 'auto');
  assert.equal(shellPreferenceSettingsIndex('gui').some((item) => item.key === definition.key), false);
  assert.deepEqual(definition.options.map((option) => option.value), ['auto', 'zh-CN', 'en-US']);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: SettingsField } = await loadGuiModule(t, '/src/components/settings-center/SettingsField.tsx');
  const html = renderToStaticMarkup(createElement(SettingsField, {
    definition, value: 'zh-CN', source: 'user', language: 'en-US', compact: true, onChange() {},
  }));
  assert.match(html, /<select[^>]+aria-label="Response language"/);
  assert.match(html, /<option value="zh-CN" selected="">简体中文<\/option>/);
  assert.equal(html.includes('agent.responseLanguage'), false, 'the user control does not expose the internal setting key');
});

test('GUI refresh accepts plan preview changes without a new journal revision or activity timestamp', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-plan-preview';
  await createSession(journal, sessionId);
  const provider = { async *stream(_request, signal) {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'gui-plan-preview');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:gui-preview', 'Plan the work.'));
  const base = structuredClone(await waitForProjection(actor, (value) => Boolean(value.assistantDraft)));
  base.assistantDraft.activity.phase = 'generatingOutput';
  let incoming = structuredClone(base);
  installGuiFetch(t, async (url) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [] });
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(sessionId)}/projection`);
    return Response.json({ ok: true, data: incoming });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: base });
  incoming.assistantDraft.planPreview = { callIndex: 0, providerCallId: 'call:plan-preview', title: 'Inspect source', summary: '', steps: [], truncated: false };
  await store.getState().refresh();
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().projection.assistantDraft.planPreview.title, 'Inspect source');
  incoming.assistantDraft.planPreview.steps.push('Read the current implementation');
  await store.getState().refresh();
  assert.deepEqual(store.getState().projection.assistantDraft.planPreview.steps, ['Read the current implementation']);
  assert.equal(store.getState().projection.pendingPlan, null);
  assert.equal(store.getState().projection.revision, base.revision);
  delete incoming.assistantDraft.planPreview;
  await store.getState().refresh();
  assert.equal(store.getState().projection.assistantDraft.planPreview, undefined);
});

test('decision prose displays escaped paragraphs without rewriting code or raw content', async (t) => {
  const { formatDecisionProse } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const source = '请确认范围。\\n\\n保留源码。';
  assert.equal(formatDecisionProse(source), '请确认范围。\n\n保留源码。');
  assert.equal(source, '请确认范围。\\n\\n保留源码。');
  const protectedText = [
    '`printf "\\n\\n"`', '```sh\nprintf "\\n\\n"\n```',
    '    printf "\\n\\n"', '[path](https://example.test/\\n\\n)',
    'C:\\new\\next', 'Actual\n\nparagraph', String.raw`Literal \\n\\n`,
  ];
  for (const text of protectedText) assert.equal(formatDecisionProse(text), text);
  assert.equal(formatDecisionProse('Before\\n\\n`\\n\\n` and **after**'), 'Before\n\n`\\n\\n` and **after**');
  const { MarkdownContent } = await loadGuiModule(t, '/src/components/local-agent/BufferedMarkdown.tsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const render = (decisionProse) => renderToStaticMarkup(createElement(MarkdownContent, { children: source, decisionProse }));
  assert.equal((render(true).match(/<p>/g) ?? []).length, 2);
  assert.match(render(false), /\\n\\n/);
});

test('browser annotations preserve the exact preview identity and separate the user comment', async (t) => {
  const { formatBrowserAnnotation } = await loadGuiModule(t, '/src/components/local-agent/browserReview.ts');
  const annotation = { id: 'annotation:1', mode: 'element', url: 'file:///input/interactive-test.html',
    title: 'Page', selector: '#btn', text: 'Page content', rect: { x: 1, y: 2, width: 3, height: 4 },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, comment: 'Make this button white.' };
  for (const chinese of [true, false]) {
    const text = formatBrowserAnnotation(annotation, 'preview-12', chinese);
    const evidence = JSON.parse(text.split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2)).join('\n'));
    assert.equal(evidence.previewId, 'preview-12');
    assert.equal(evidence.url, annotation.url);
    assert.equal(evidence.selector, '#btn');
    assert.ok(text.endsWith('\n\n' + annotation.comment));
  }
});

test('streaming Markdown retains stable blocks and reconciles GFM and references on completion', async (t) => {
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const parser = new StreamingMarkdownParser();
  const prefix = '# Result\n\nFirst paragraph.\n\nSecond paragraph.\n\n';
  const first = parser.update(prefix + 'Last', true);
  const next = parser.update(prefix + 'Last paragraph.\n\n```cpp\nint value', true);
  assert.equal(next[0], first[0], 'already displayed heading must retain its render block');
  const text = prefix + 'Last paragraph.\n\n```cpp\nint value = 1;\n```\n\n[Guide][guide]\n\n[guide]: https://example.com\n';
  const complete = parser.update(text, false);
  assert.equal(complete[0].key, first[0].key, 'completion must retain source keys');
  assert.deepEqual(complete, new StreamingMarkdownParser().update(text, false));
  assert.match(JSON.stringify(complete), /https:\/\/example.com/);
  const replacement = parser.update('Replacement\n\n| A | B |\n| - | - |\n| 1 | 2 |', true);
  assert.doesNotMatch(JSON.stringify(replacement), /First paragraph/);
  assert.match(JSON.stringify(replacement), /"tagName":"table"/);
});

test('Markdown table reading preserves streaming cells, source links and GFM alignment', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const { MarkdownContent } = await loadGuiModule(t, '/src/components/local-agent/BufferedMarkdown.tsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const prefix = '# 参考实现\n\n第一段说明。\n\n第二段说明。\n\n';
  const header = '| 项目 | 许可 | 机制 | 对齐 |\n| :--- | --- | --- | ---: |\n';
  const row = '| [ObjectPool](https://example.com/pool) | BSD | `create/validate/destroy`，**原始语义** | 12 |\n';
  const end = '| Recycler | Apache-2.0 | `Recycler<T,Size,Align>` | 23 |\n\n公式 $i$ 与 [完整来源](https://example.com/reference)。';
  const parser = new StreamingMarkdownParser();
  const start = parser.update(prefix + header, true);
  const partial = parser.update(prefix + header + row.slice(0, row.indexOf('destroy') + 3), true);
  const streamed = parser.update(prefix + header + row + end, true);
  assert.equal(partial[0], start[0], 'table growth must retain the frozen heading');
  assert.equal(streamed[0], start[0], 'later prose must retain the frozen heading');
  const tableKey = (blocks) => blocks.find((block) => block.tree.children.some((node) => node.type === 'element' && node.tagName === 'table')).key;
  assert.equal(tableKey(start), tableKey(partial));
  assert.equal(tableKey(start), tableKey(streamed));
  const text = prefix + header + row + end;
  const final = parser.update(text, false);
  assert.equal(tableKey(final), tableKey(start));
  assert.deepEqual(final, new StreamingMarkdownParser().update(text, false));
  const settled = renderToStaticMarkup(createElement(MarkdownContent, { children: text }));
  const received = renderToStaticMarkup(createElement(MarkdownContent, { children: text, streaming: true }));
  const tableHtml = (html) => html.match(/<table>[\s\S]*?<\/table>/)[0];
  assert.equal(tableHtml(received), tableHtml(settled), 'a complete streamed table and its settled view contain identical cells');
  assert.equal((settled.match(/<table>/g) ?? []).length, 1, 'a closed expanded view must not duplicate the table');
  assert.equal((settled.match(/<tr>/g) ?? []).length, 3);
  assert.equal((settled.match(/<td[ >]/g) ?? []).length, 8);
  assert.match(settled, /style="text-align:right"/);
  assert.match(settled, /href="https:\/\/example.com\/pool"/);
  assert.match(settled, /<code>create\/<wbr\/>validate\/<wbr\/>destroy<\/code>/);
  assert.match(settled.replaceAll('<wbr/>', ''), /<code>create\/validate\/destroy<\/code>/);
  assert.match(settled, /<code>Recycler&lt;T,Size,Align&gt;<\/code>/);
  assert.match(settled, /<strong>原始语义<\/strong>/);
  assert.match(settled, /class="katex"/);
});

test('draft and committed provider text occupy the same round and row identity', async (t) => {
  const { conversationRounds } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const user = { type: 'message', sequence: 1, value: { messageId: 'user:1', role: 'user', content: 'Continue' } };
  const draft = { type: 'text', block: { streamId: 'stream:answer', kind: 'message', content: 'Answer', outputIndex: 0 } };
  const before = conversationRounds([user], [draft], 'run:1');
  const answer = { type: 'message', sequence: 5, streamId: 'stream:answer', value: { messageId: 'answer:1', role: 'assistant', runId: 'run:1', content: 'Answer' } };
  const after = conversationRounds([user, answer], [draft], 'run:1');
  assert.equal(after.at(-1).key, before.at(-1).key);
  assert.equal(after.at(-1).rows[0].key, before.at(-1).rows[0].key);
  assert.equal(after.at(-1).rows.length, 1, 'commit and residual draft must not duplicate text');
});

test('streamed text advances between snapshots and catches up without a character-rate backlog', async (t) => {
  const { StreamingTextBuffer } = await loadGuiModule(t, '/src/components/local-agent/streamingText.ts');
  const buffer = new StreamingTextBuffer();
  let source = 'A received paragraph. '.repeat(80);
  buffer.update(source, 0);
  let previous = '';
  for (const time of [16, 32, 48, 64, 80, 96]) {
    if (time === 64) { source += 'More received text. '.repeat(40); buffer.update(source, time); }
    const shown = buffer.advance(time);
    assert.ok(shown.startsWith(previous) && shown.length > previous.length);
    assert.ok(source.startsWith(shown) && shown.length < source.length);
    previous = shown;
  }
  assert.equal(buffer.advance(120), source, 'new arrivals must not extend the pending display deadline');
  assert.equal(buffer.complete, true);
  buffer.update(source + ' Next chunk.', 200);
  assert.equal(buffer.advance(320), source + ' Next chunk.');
  buffer.update('Authoritative replacement.', 330);
  assert.equal(buffer.text, 'Authoritative replacement.');
  assert.equal(buffer.advance(400), 'Authoritative replacement.', 'replacement must discard the previous tail');
});

test('streamed text keeps Unicode pairs intact and settled history displays immediately', async (t) => {
  const { StreamingTextBuffer } = await loadGuiModule(t, '/src/components/local-agent/streamingText.ts');
  const text = '中文🙂🚀，代码与公式。';
  const buffer = new StreamingTextBuffer();
  buffer.update(text, 0);
  for (let time = 1; time <= 120; time += 1) {
    const shown = buffer.advance(time);
    assert.equal(shown, [...shown].filter((character) => !/^[\uD800-\uDFFF]$/u.test(character)).join(''));
    assert.ok(text.startsWith(shown));
  }
  assert.equal(buffer.text, text);
  const history = new StreamingTextBuffer(text);
  assert.equal(history.text, text);
  assert.equal(history.complete, true);
});

test('projection polling stays serial through visibility changes and stops after unmount', async (t) => {
  const { startProjectionPolling } = await loadGuiModule(t, '/src/components/local-agent/useProjectionPolling.ts');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const timers = new Map();
  const listeners = new Set();
  let nextId = 0;
  globalThis.window = { setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { visibilityState: 'visible', addEventListener(_event, callback) { listeners.add(callback); }, removeEventListener(_event, callback) { listeners.delete(callback); } };
  let stop = () => {};
  let stopIdle = () => {};
  t.after(() => { stop(); stopIdle(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const fire = () => { assert.equal(timers.size, 1); const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
  const visibility = (state) => { document.visibilityState = state; for (const listener of listeners) listener(); };
  let calls = 0;
  let release;
  const stopDisconnected = startProjectionPolling(true, async () => { calls += 1; }, false);
  visibility('hidden'); visibility('visible');
  assert.equal(calls, 0, 'authentication and disconnected Hosts must not read session status');
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  stopDisconnected();
  stop = startProjectionPolling(true, () => { calls += 1; return new Promise((resolve) => { release = resolve; }); }, true);
  const activeDelay = timers.values().next().value.delay;
  assert.ok(Number.isFinite(activeDelay) && activeDelay > 0, 'connected active sessions schedule a finite positive delay');
  fire();
  visibility('hidden'); visibility('visible');
  assert.equal(calls, 1);
  assert.equal(timers.size, 0, 'a slow refresh must not accumulate polling timers');
  release(); await Promise.resolve();
  assert.equal(timers.size, 1);
  visibility('hidden');
  const hiddenDelay = timers.values().next().value.delay;
  assert.ok(Number.isFinite(hiddenDelay) && hiddenDelay > activeDelay, 'hidden sessions poll less frequently');
  visibility('visible');
  assert.equal(calls, 2);
  stop(); release(); await Promise.resolve();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  stopIdle = startProjectionPolling(false, async () => {}, true);
  const idleDelay = timers.values().next().value.delay;
  assert.ok(Number.isFinite(idleDelay) && idleDelay > activeDelay, 'idle sessions poll less frequently');
  stopIdle();
});

test('unchanged status snapshots do not publish redundant GUI state updates', async (t) => {
  installGuiFetch(t, async (url) => {
    assert.equal(url.pathname, '/api/conversation/statuses');
    return Response.json({ ok: true, data: [] });
  });
  const store = await loadGuiModelStore(t);
  let publications = 0;
  const unsubscribe = store.subscribe(() => { publications += 1; });
  t.after(unsubscribe);
  await store.getState().refresh();
  await store.getState().refresh();
  assert.equal(publications, 0);
  store.setState({ statusError: 'Status request failed', error: 'Retained command failure', errorSource: 'command' });
  await store.getState().refresh();
  assert.equal(store.getState().statusError, null, 'a successful refresh clears only its previous status error');
  assert.equal(store.getState().error, 'Retained command failure');
  assert.equal(publications, 2);
});

test('background titles use the existing status refresh independently of Session revision', async (t) => {
  const summary = { id: 'session:title', title: '新对话', workspaceBindings: [],
    createdAt: '2026-10-18', updatedAt: '2026-10-18' };
  let statuses = [{ sessionId: summary.id, revision: 1, run: null }];
  let requests = 0;
  installGuiFetch(t, async (url) => {
    assert.equal(url.pathname, '/api/conversation/statuses');
    requests += 1;
    return Response.json({ ok: true, data: statuses });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ catalog: { projects: [], sessions: [summary] } });
  await store.getState().refresh();
  assert.equal(store.getState().catalog.sessions[0].title, '新对话', 'missing title does not invent a replacement');
  statuses = [{ ...statuses[0], title: '修复会话标题' },
    { sessionId: 'session:uncatalogued', revision: 1, run: null, title: 'Not a new catalog entry' }];
  await store.getState().refresh();
  assert.equal(store.getState().catalog.sessions[0].title, '修复会话标题');
  assert.equal(store.getState().catalog.sessions.length, 1);
  assert.equal(store.getState().sessionStatuses[summary.id].revision, 1);
  let publications = 0;
  const unsubscribe = store.subscribe(() => { publications += 1; });
  t.after(unsubscribe);
  await store.getState().refresh();
  assert.equal(publications, 0, 'unchanged title and status do not republish the catalog');
  statuses = [{ sessionId: summary.id, revision: 1, run: null }];
  await store.getState().refresh();
  assert.equal(store.getState().catalog.sessions[0].title, '修复会话标题');
  statuses = [{ ...statuses[0], title: 7 }];
  await store.getState().refresh();
  assert.equal(store.getState().statusError, 'conversation_statuses_invalid');
  assert.equal(store.getState().catalog.sessions[0].title, '修复会话标题');
  assert.equal(requests, 5, 'each existing refresh makes only its status request');
});

test('background title replies do not overwrite a concurrent manual rename', async (t) => {
  const summary = { id: 'session:rename', title: '新对话', workspaceBindings: [],
    createdAt: '2026-10-18', updatedAt: '2026-10-18' };
  let releaseStatus, releaseRename;
  let deferStatus = true, deferRename = false;
  let statusTitle = '模型标题';
  installGuiFetch(t, async (url, init) => {
    if (url.pathname === '/api/conversation/statuses') {
      const result = { ok: true, data: [{ sessionId: summary.id, revision: 2,
        run: { runId: 'run:title', status: 'completed' }, title: statusTitle }] };
      if (deferStatus) await new Promise(resolve => { releaseStatus = resolve; });
      return Response.json(result);
    }
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(summary.id)}`);
    assert.equal(init.method, 'PATCH');
    const { title } = JSON.parse(init.body);
    if (deferRename) await new Promise(resolve => { releaseRename = resolve; });
    return Response.json({ ok: true, data: { projects: [], sessions: [{ ...summary, title }] } });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ catalog: { projects: [], sessions: [summary] } });
  const oldRefresh = store.getState().refresh();
  await waitUntil(() => releaseStatus, 'status request started');
  await store.getState().updateSession(summary.id, { title: '用户标题' });
  releaseStatus();
  await oldRefresh;
  assert.equal(store.getState().catalog.sessions[0].title, '用户标题');
  assert.equal(store.getState().sessionStatuses[summary.id].run.status, 'completed', 'late status still carries valid run facts');

  deferStatus = false;
  deferRename = true;
  const renaming = store.getState().updateSession(summary.id, { title: '用户再次改名' });
  await waitUntil(() => releaseRename, 'rename request started');
  await store.getState().refresh();
  assert.equal(store.getState().catalog.sessions[0].title, '用户标题', 'pending rename owns the title mutation');
  releaseRename();
  await renaming;
  statusTitle = '用户再次改名';
  await store.getState().refresh();
  assert.equal(store.getState().catalog.sessions[0].title, '用户再次改名');
});

test('round change totals use first before and final after, without summing repeated edits', async (t) => {
  const { changedFiles, readRoundChange } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const { calculateChangedLines: countChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const change = { workspaceId: 'workspace:1', path: 'src/pool.cpp', kind: 'modify', before: { exists: true }, after: { exists: true } };
  const activity = (recordId) => ({ tool: { recordId, fileChanges: [change] } });
  const files = changedFiles([activity('edit:1'), activity('edit:2'), activity('edit:2')]);
  assert.equal(files.length, 1);
  assert.equal(files[0].changes.length, 2);
  const read = async (_session, recordId) => ({ workspaceId: change.workspaceId, path: change.path,
    before: recordId === 'edit:1' ? 'original\n' : 'temporary\n',
    after: recordId === 'edit:1' ? 'temporary\n' : 'original\nadded\n',
  });
  const round = await readRoundChange(read, 'session:1', files[0], new AbortController().signal);
  assert.deepEqual(await countChangedLines(round.before, round.after), { added: 1, removed: 0 });
  assert.deepEqual(await countChangedLines(null, 'new\nfile\n'), { added: 2, removed: 0 });
  assert.deepEqual(await countChangedLines('removed\n', null), { added: 0, removed: 1 });
});

test('binary changes do not interrupt text totals and immutable line statistics are cached per revision', async (t) => {
  const { readFileChange } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const { changedFiles, readChangeStatistics } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const { calculateChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const calls = [];
  let unavailable = true;
  installGuiFetch(t, (_url, init) => {
    const { recordId } = JSON.parse(init.body);
    calls.push(recordId);
    if (recordId === 'binary') return Response.json({ ok: false, error: 'file_change_binary_content', message: 'bin/demo 是二进制文件。' });
    if (recordId === 'missing' && unavailable) return Response.json({ ok: false, error: 'file_change_content_unavailable', message: 'snapshot missing' });
    return Response.json({ ok: true, data: { workspaceId: 'workspace:1', path: `${recordId}.txt`, before: null, after: 'one\ntwo\n' } });
  });
  const files = changedFiles(['first', 'binary', 'last', 'missing'].map((recordId) => ({ tool: { recordId, fileChanges: [{ workspaceId: 'workspace:1', path: `${recordId}.txt`, kind: 'create', before: { exists: false }, after: { exists: true } }] } })));
  const count = async (before, after) => calculateChangedLines(before, after);
  const signal = new AbortController().signal;
  const values = [];
  for (const file of files.slice(0, 3)) values.push(await readChangeStatistics(readFileChange, 'session:counts', file, signal, count));
  assert.deepEqual(values, [{ kind: 'text', counts: { added: 2, removed: 0 } }, { kind: 'binary' }, { kind: 'text', counts: { added: 2, removed: 0 } }]);
  for (const file of files.slice(0, 3)) await readChangeStatistics(readFileChange, 'session:counts', file, signal, count);
  assert.deepEqual(calls, ['first', 'binary', 'last'], 'switching cards reuses classifications without reading or diffing again');
  await assert.rejects(readChangeStatistics(readFileChange, 'session:counts', files[3], signal, count), /snapshot missing/);
  unavailable = false;
  assert.equal((await readChangeStatistics(readFileChange, 'session:counts', files[3], signal, count)).kind, 'text', 'failed reads are not cached as success');
  await readChangeStatistics(readFileChange, 'session:other', files[0], signal, count);
  assert.equal(calls.at(-1), 'first', 'separate sessions do not share results');
});

test('line statistics compute full-file creation, deletion and replacement without per-edit timers', async (t) => {
  const { calculateChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const source = Array.from({ length: 1200 }, (_, index) => `line ${index}\n`).join('');
  const replacement = Array.from({ length: 400 }, (_, index) => `replacement ${index}\n`).join('');
  assert.deepEqual(calculateChangedLines(null, source), { added: 1200, removed: 0 });
  assert.deepEqual(calculateChangedLines(source, null), { added: 0, removed: 1200 });
  assert.deepEqual(calculateChangedLines(source, source), { added: 0, removed: 0 });
  assert.deepEqual(calculateChangedLines(source, replacement), { added: 400, removed: 1200 });
  assert.deepEqual(calculateChangedLines(null, ''), { added: 0, removed: 0 });
  assert.deepEqual(calculateChangedLines(null, 'first\r\nsecond'), { added: 2, removed: 0 });
  assert.deepEqual(calculateChangedLines('first\r\nsecond\r\n', null), { added: 0, removed: 2 });
  assert.deepEqual(calculateChangedLines('unchanged', 'unchanged\n'), { added: 1, removed: 1 });
});


test('disabled model bindings survive catalog refresh and cannot submit a new run', async (t) => {
  const profiles = [
    { id: 'profile:bound', name: 'Bound model', enabled: false, thinking: 'enabled' },
    { id: 'profile:available', name: 'Available model', enabled: true, thinking: 'enabled' },
  ];
  installGuiFetch(t, async (url) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    return Response.json({ ok: true, data: { profiles, defaultProfileId: profiles[0].id } });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId: 'session:bound', selectedProfileId: profiles[0].id });
  await store.getState().refreshProfiles();
  assert.equal(store.getState().selectedProfileId, profiles[0].id);
  assert.equal(store.getState().defaultProfileId, profiles[0].id);
  assert.deepEqual(store.getState().profiles, profiles);
  await assert.rejects(store.getState().sendMessage('Continue.'), /llm_profile_unavailable/);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: Selector } = await loadGuiModule(t, '/src/components/local-agent/SessionModelSelector.tsx');
  const html = renderToStaticMarkup(createElement(Selector, {
    language: 'zh-CN', profiles, selectedProfileId: profiles[0].id,
    contextUsage: null, contextCompositions: [], reasoningEffortOverride: null,
  }));
  assert.match(html, /Bound model · 已停用/);
  store.getState().startNewSession();
  assert.equal(store.getState().selectedProfileId, profiles[0].id, 'an invalid configured default remains visible');
});

test('polling and command reconciliation read draft snapshots in order at the same revision', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-draft';
  await createSession(journal, sessionId);
  const provider = { async *stream(_request, signal) {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'ordered-draft');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:ordered-start', 'Plan the work.'));
  const base = structuredClone(await waitForProjection(actor, (value) => Boolean(value.assistantDraft)));
  base.assistantDraft.planPreview = { callIndex: 0, providerCallId: 'call:ordered-plan', title: 'Plan', summary: '', steps: ['Read source'], truncated: false };
  const latest = structuredClone(base);
  latest.assistantDraft.planPreview.steps.push('Verify behavior');
  let releaseOld;
  const held = new Promise((resolve) => { releaseOld = resolve; });
  let releaseCommand;
  const commandHeld = new Promise((resolve) => { releaseCommand = resolve; });
  t.after(releaseCommand);
  let reads = 0;
  let commands = 0;
  installGuiFetch(t, async (url, init) => {
    if (url.pathname === '/api/llm/profiles' && init.method === 'PATCH') {
      assert.deepEqual(Object.keys(JSON.parse(init.body)), ['profile']);
      return Response.json({ ok: true, data: {} });
    }
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [
      { sessionId, revision: base.revision, run: { runId: base.run.runId, status: base.run.status } },
    ] });
    if (url.pathname.endsWith('/commands')) {
      assert.equal(init.signal, undefined, 'view navigation does not own command cancellation');
      commands += 1;
      if (commands === 2) await commandHeld;
      return Response.json({ ok: true, data: { schemaVersion: 'deepcode.command-reply.v3', sessionId, commandId: 'command:setting', status: 'accepted', revision: base.revision } });
    }
    assert.ok(url.pathname.endsWith('/projection'));
    reads += 1;
    if (reads === 1) { await held; return Response.json({ ok: true, data: base }); }
    return Response.json({ ok: true, data: latest });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: base, selectedProfileId: 'profile:test', profiles: [
    { id: 'profile:test', enabled: true, thinking: 'enabled' },
  ] });
  const polling = store.getState().refresh();
  await waitUntil(() => reads === 1);
  const saving = store.getState().selectModel('profile:test', 'low');
  await waitUntil(() => commands === 1);
  assert.equal(reads, 1, 'the post-command read waits for the earlier in-flight read');
  releaseOld();
  await Promise.all([polling, saving]);
  assert.equal(store.getState().error, null);
  assert.equal(reads, 2);
  assert.deepEqual(store.getState().projection.assistantDraft.planPreview.steps, ['Read source', 'Verify behavior']);
  assert.equal(store.getState().projection.revision, base.revision);
  await store.getState().refresh();
  assert.equal(reads, 3, 'running drafts are read even when the status revision matches the cache');
  const savingWhileLeaving = store.getState().selectModel('profile:test', 'high');
  await waitUntil(() => commands === 2);
  store.getState().startNewSession();
  releaseCommand();
  await savingWhileLeaving;
  assert.equal(reads, 4, 'the command finishes its own reconciliation after the view leaves');
  assert.equal(store.getState().sessionId, null);
  assert.equal(store.getState().projection, null, 'the command reply cannot restore the departed view');
});

test('desktop startup diagnostics render the Host failure and log reference verbatim', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HostStartupDiagnostic } = await loadGuiModule(t, '/src/components/shared/HostStartupDiagnostic.tsx');
  const status = { phase: 'failed', code: 'host_startup_process_exited',
    message: 'Kernel exited: exit status: 71', diagnosticRef: '/runtime/logs/startup.log' };
  const html = renderToStaticMarkup(createElement(HostStartupDiagnostic, { status, language: 'zh-CN' }));
  assert.match(html, /Kernel exited: exit status: 71/);
  assert.match(html, /\/runtime\/logs\/startup.log/);
  assert.equal(renderToStaticMarkup(createElement(HostStartupDiagnostic, { status: { ...status, phase: 'ready' }, language: 'zh-CN' })), '');
  const workspaceFailure = renderToStaticMarkup(createElement(HostStartupDiagnostic, {
    status: { ...status, phase: 'ready' }, workspaceError: 'Workspace open denied: /workspace/default',
    language: 'zh-CN', onRetry() {},
  }));
  assert.match(workspaceFailure, /Workspace open denied: \/workspace\/default/);
  assert.match(workspaceFailure, /role="alert"/);
  assert.doesNotMatch(workspaceFailure, /host_startup_process_exited|startup.log|<button/);
});

test('conversation batches layout corrections and samples reader movement before restoring', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const previousWindow = globalThis.window;
  const frames = new Map(); let sequence = 0;
  globalThis.window = { requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); } };
  t.after(() => { globalThis.window = previousWindow; });
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'batch', projection: { sessionId: 'batch' }, loading: false,
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let anchorTop = 400;
  const body = { scrollTop: 500, scrollHeight: 2000, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [anchor] };
  const anchor = { dataset: { conversationAnchor: 'reading' }, hidden: false,
    getBoundingClientRect: () => ({ top: anchorTop - body.scrollTop, bottom: anchorTop + 1000 - body.scrollTop }) };
  viewport.bodyRef.current = body;
  viewport.setLatestFollowMode(false);
  anchorTop += 100;
  for (let i = 0; i < 20; i++) viewport.preserveReadingPosition();
  assert.equal(frames.size, 1, 'all changed rows and the transcript share one correction frame');
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  flush();
  assert.equal(body.scrollTop, 600, 'the saved reading anchor keeps its offset after growth above it');
  viewport.preserveReadingPosition();
  body.scrollTop = 720;
  flush();
  assert.equal(body.scrollTop, 720, 'native reader movement during the pending frame wins');
  assert.equal(frames.size, 0);
});

test('process disclosure keeps its clicked location through expansion and collapse', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const previousWindow = globalThis.window;
  const frames = new Map(); let sequence = 0;
  globalThis.window = { requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); } };
  t.after(() => { globalThis.window = previousWindow; });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'disclosure', projection: { sessionId: 'disclosure' }, loading: false,
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let processHeight = 0, disclosureTop = 600;
  const body = { scrollTop: 500, scrollHeight: 2000, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [toggle, answer] };
  const toggle = { dataset: { conversationAnchor: 'round:disclosure' }, hidden: false,
    getBoundingClientRect: () => ({ top: disclosureTop - body.scrollTop, bottom: disclosureTop + 30 - body.scrollTop }) };
  const answer = { dataset: { conversationAnchor: 'answer' }, hidden: false,
    getBoundingClientRect: () => ({ top: 650 + processHeight - body.scrollTop, bottom: 2000 + processHeight - body.scrollTop }) };
  viewport.bodyRef.current = body;
  viewport.anchorDisclosure(toggle);
  processHeight = 900; body.scrollHeight += 900;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 500, 'expanding puts the process below its button rather than preserving the final answer');
  disclosureTop += 40; body.scrollHeight += 40;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100, 'late layout measurements retain the clicked anchor');
  viewport.anchorDisclosure(toggle);
  body.scrollHeight -= processHeight; processHeight = 0;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100, 'collapsing keeps the same control visible');
  viewport.anchorDisclosure(toggle);
  processHeight = 800; body.scrollHeight += 800;
  viewport.preserveReadingPosition(); flush();
  body.scrollTop += 180;
  viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  processHeight += 50; body.scrollHeight += 50;
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 770, 'after scrolling, the new reading anchor replaces the disclosure');
});

test('conversation reading intent survives native scroll deliveries and layout growth', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const previousWindow = globalThis.window;
  const frames = new Map();
  let nextFrame = 0;
  globalThis.window = {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'session:reading', loading: false,
      projection: { sessionId: 'session:reading' }, presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let top = 1_000;
  let height = 1_500;
  let anchorTop = 900;
  const anchor = {
    dataset: { conversationAnchor: 'plan:reading' },
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: anchorTop - top, bottom: anchorTop - top + 800 }),
  };
  const body = {
    clientHeight: 500,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, height - this.clientHeight)); },
    get scrollHeight() { return height; },
    set scrollHeight(value) { height = value; this.scrollTop = top; },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [anchor],
  };
  viewport.bodyRef.current = body;
  const deliverScroll = () => viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  viewport.setLatestFollowMode(true);
  viewport.preserveReadingPosition();
  viewport.bodyHandlers.onWheel({ target: body, deltaY: -140 });
  body.scrollTop = 860;
  flushFrames();
  assert.equal(top, 860, 'a pending follow frame yields to native movement even before its scroll callback arrives');

  body.scrollTop = 790;
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 790, 'continued keyboard or inertial movement cannot be restored to the previous sample');
  anchorTop += 160;
  body.scrollHeight += 160;
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 950, 'growth above the reader compensates layout using the latest reader anchor');
  assert.equal(anchor.getBoundingClientRect().top, 110);
  deliverScroll();
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 950, 'a delayed callback from the programmatic correction does not become reader movement');

  body.scrollTop = 990;
  deliverScroll();
  anchorTop += 80;
  body.scrollHeight += 80;
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 1_070, 'a native scroll callback records the next reading position without wheel or touch flags');

  body.scrollTop = body.scrollHeight - body.clientHeight;
  deliverScroll();
  body.scrollHeight += 100;
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 1_340, 'reader arrival at the actual tail resumes following new content');
  body.scrollHeight = 1_500;
  deliverScroll();
  body.scrollHeight += 60;
  viewport.preserveReadingPosition();
  flushFrames();
  assert.equal(top, 1_060, 'browser shrink clamping preserves existing follow ownership');

  viewport.setLatestFollowMode(false);
  body.scrollTop = 800;
  deliverScroll();
  viewport.scrollToLatest();
  flushFrames();
  assert.equal(top, 1_060, 'the explicit latest action resumes following after detached reading');
  assert.equal(frames.size, 0);
});

test('conversation follows decision layout changes and final output until the reader moves away', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const previousWindow = globalThis.window;
  const frames = new Map();
  let nextFrame = 0;
  globalThis.window = {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle(node) { return node.style; },
  };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const flushFrames = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'session:decisions', loading: false,
      projection: { sessionId: 'session:decisions' }, presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let top = 1_000, height = 1_500, writes = 0;
  const body = { clientHeight: 500,
    get scrollTop() { return top; },
    set scrollTop(value) { writes++; top = Math.max(0, Math.min(value, height - this.clientHeight)); },
    get scrollHeight() { return height; },
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [], closest: () => null,
  };
  viewport.bodyRef.current = body;
  viewport.setLatestFollowMode(true);
  const deliverScroll = () => viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  for (const decision of ['permission', 'plan', 'question']) {
    // Removing a decision first grows the viewport and clamps native scrollTop;
    // restoring the input and appending output then changes the extent again.
    body.clientHeight = 700; top = height - body.clientHeight;
    body.clientHeight = 500; height += 100;
    deliverScroll();
    viewport.preserveReadingPosition(); viewport.preserveReadingPosition();
    assert.equal(frames.size, 1, `${decision}: resize and scroll share one frame`);
    flushFrames();
    assert.equal(top, height - body.clientHeight, `${decision}: layout clamping cannot detach the reader`);
  }
  height += 800;
  viewport.preserveReadingPosition(); flushFrames();
  assert.equal(top, height - body.clientHeight, 'final output remains visible after completion');
  const completedWrites = writes;
  deliverScroll(); viewport.preserveReadingPosition(); flushFrames();
  assert.equal(writes, completedWrites, 'programmatic feedback does not rewrite an already clamped tail');
  assert.equal(frames.size, 0, 'idle layout does not keep scheduling itself');

  const code = { parentElement: body, clientHeight: 100, scrollHeight: 400, scrollTop: 100,
    style: { overflowY: 'auto' } };
  viewport.bodyHandlers.onWheel({ target: code, deltaY: -20 });
  height += 100; viewport.preserveReadingPosition(); flushFrames();
  assert.equal(top, height - body.clientHeight, 'scrolling a code block does not detach the conversation');

  viewport.preserveReadingPosition();
  viewport.bodyHandlers.onKeyDown({ target: body, currentTarget: body, key: 'PageUp' });
  top -= 200; const readingTop = top;
  flushFrames();
  assert.equal(top, readingTop, 'keyboard intent wins over an already queued follow frame');
  height += 100; viewport.preserveReadingPosition(); flushFrames();
  assert.equal(top, readingTop, 'new final content does not steal the history position');
  viewport.scrollToLatest(); flushFrames();
  assert.equal(top, height - body.clientHeight, 'explicit latest resumes the tail');

  viewport.bodyHandlers.onTouchStart({ touches: [{ clientY: 200 }] });
  viewport.bodyHandlers.onTouchMove({ target: body, touches: [{ clientY: 250 }] });
  top -= 50; deliverScroll(); height += 100; viewport.preserveReadingPosition(); flushFrames();
  assert.equal(top, height - body.clientHeight - 150, 'touch reading is retained through further output');
  assert.equal(frames.size, 0);
});

test('composer submission receipts preserve newer text and retain the complete failed draft', async (t) => {
  const { submitComposerState, emptyComposerState } = await loadGuiModule(t, '/src/components/local-agent/composerSubmission.ts');
  const original = { ...emptyComposerState(), draft: 'First request',
    pastedTexts: [{ inputId: 'paste:one', text: 'Complete pasted content', expanded: false,
      browserReview: { previewId: 'preview:one', screenshot: '/project/capture.png', annotation: {
        id: 'annotation:one', mode: 'element', url: 'https://example.test', title: 'Example', selector: 'h1', text: 'Heading',
        rect: { x: 10, y: 20, width: 120, height: 40 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, comment: '调整标题间距',
      } } }],
    filesystemPaths: [{ path: '/project/one.txt', kind: 'file' }, { path: '/project/capture.png', kind: 'file' }],
    pluginSelections: [{ selectionId: 'selection:one', uri: 'plugin://example@1', label: 'Example' }] };
  for (const fails of [false, true]) {
    let current = original;
    const retained = [];
    let complete;
    const pending = new Promise((resolve, reject) => { complete = () => fails ? reject(new Error('command failed')) : resolve(); });
    const submission = submitComposerState('session:one', original, {
      read: () => current,
      write: (key, value) => { assert.equal(key, 'session:one'); current = value; },
      retainFailed: (key, value) => retained.push({ key, value }),
      send: () => pending,
    });
    assert.deepEqual(current, emptyComposerState(), 'the submitted text and attachments move together');
    current = { ...emptyComposerState(), draft: 'Second request', filesystemPaths: [{ path: '/project/two.txt', kind: 'file' }] };
    complete();
    assert.equal(await submission, !fails);
    assert.equal(current.draft, 'Second request');
    assert.equal(current.filesystemPaths[0].path, '/project/two.txt');
    assert.deepEqual(retained, fails ? [{ key: 'session:one', value: original }] : []);
  }
  let current = original;
  await submitComposerState('session:one', original, {
    read: () => current, write: (_key, value) => { current = value; },
    retainFailed: () => assert.fail('an untouched composer restores in place'),
    send: async () => { throw new Error('rejected'); },
  });
  assert.deepEqual(current, original);
});

test('artifact delivery waits for final text display and keeps historical or interrupted output available', async (t) => {
  const { conversationDisplay } = await loadGuiModule(t, '/src/components/local-agent/conversationDisplay.ts');
  const artifacts = [{ artifactId: 'image:old', runId: 'run:old', presentationRunId: 'run:old' }, { artifactId: 'image:new', runId: 'run:new', presentationRunId: 'run:new' }];
  const resources = [...artifacts, { artifactId: 'image:observation', runId: 'run:old' }];
  const projection = { run: { runId: 'run:new', status: 'running' }, messages: [], timeline: [], artifacts: resources, deliverables: artifacts,
    assistantDraft: { runId: 'run:new', blocks: [{ content: 'Still writing' }] } };
  const live = new Set(['run:new']);
  const shown = new Map();
  assert.deepEqual(conversationDisplay(projection, live, shown).artifacts, [artifacts[0]]);
  const committed = { ...projection, assistantDraft: null, run: { ...projection.run, status: 'completed' },
    messages: [{ messageId: 'final', runId: 'run:new', role: 'assistant', content: 'The complete final answer.' }],
    timeline: [{ kind: 'message', messageId: 'final', streamId: 'stream:final' }],
  };
  shown.set('stream:final', 'The complete');
  assert.deepEqual(conversationDisplay(committed, live, shown).artifacts, [artifacts[0]], 'settlement must not skip the UI display buffer');
  assert.deepEqual(conversationDisplay({ ...committed, run: { runId: 'run:next', status: 'running' } }, live, shown).artifacts,
    [artifacts[0]], 'starting the next run does not bypass the previous answer display');
  shown.set('stream:final', 'The complete final answer.');
  assert.deepEqual(conversationDisplay(committed, live, shown).artifacts, artifacts);
  assert.deepEqual(conversationDisplay({ ...committed, run: { ...committed.run, status: 'releasing' } }, live, shown).artifacts, [artifacts[0]], 'showing text does not invent a settled run');
  assert.deepEqual(conversationDisplay(committed, new Set(), new Map()).artifacts, artifacts, 'settled history does not replay a reveal animation');
  const interrupted = { ...projection, assistantDraft: null, run: { ...projection.run, status: 'cancelled' } };
  assert.deepEqual(conversationDisplay(interrupted, live, shown).artifacts, artifacts, 'actual output is retained after cancellation without a final answer');
  assert.deepEqual(projection.artifacts, resources, 'observations remain archived without becoming deliverables');
});

test('pending approvals replace ordinary input while preserving its draft for return', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConversationComposer } = await loadGuiModule(t, '/src/components/local-agent/ConversationComposer.tsx');
  const composer = {
    pendingApproval: { approvalId: 'approval:one', preview: { summary: 'Write the requested file', effects: [], logicalTargets: [] } },
    projection: { contextCompositions:[], queuedInputs: [{ commandId: 'queued:one', text: 'Keep the public API unchanged', status: 'queued', filesystemReferences: [] }] },
    profiles: [], selectedProfileId: null, draft: 'Second request', pastedTexts: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], showStopAction: false, canSend: false, submitting: true,
    textareaRef: { current: null }, respondApproval() {},
  };
  const html = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer, uiActionError: null }));
  assert.match(html, /Write the requested file/);
  assert.doesNotMatch(html, /<textarea|aria-label="发送"/);
  assert.match(html, /aria-label="拒绝" aria-keyshortcuts="Escape"/);
  assert.match(html, /aria-label="允许" aria-keyshortcuts="Enter"/);
  const resumed = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer: { ...composer, pendingApproval: null }, uiActionError: null }));
  assert.match(resumed, /<textarea[^>]*>Second request<\/textarea>/);
  const browser = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer: { ...composer,
    pendingApproval: { ...composer.pendingApproval, preview: { ...composer.pendingApproval.preview, authorizationScope: 'sessionBrowser' } },
  }, uiActionError: null }));
  assert.match(browser, /允许当前对话使用内置浏览器/);
  assert.match(browser, /aria-label="允许本会话"/);
  const runPreview = { ...composer.pendingApproval.preview, authorizationScope: 'runHostShell', authorizationScopes: ['runCommand', 'sessionCommand', 'runHostShell', 'sessionHostShell'], authorizationContext: { workspaceId: 'workspace:one', workspaceRoot: '/project' } };
  const run = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer: { ...composer,
    pendingApproval: { ...composer.pendingApproval, preview: runPreview },
  }, uiActionError: null }));
  assert.match(run, /title="本会话允许 Host Shell"[^>]*>允许本会话<\/button>/);
  assert.match(run, /aria-label="允许本轮" title="本次任务允许 Host Shell" aria-keyshortcuts="Enter"/);
  assert.doesNotMatch(run, /<option value="(?:runCommand|sessionHostShell)"/);
  const perCall = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer: { ...composer,
    pendingApproval: { ...composer.pendingApproval, preview: { ...runPreview, authorizationScopes: [] } },
  }, uiActionError: null }));
  assert.doesNotMatch(perCall, /允许本轮|允许本会话/);
  assert.match(perCall, /aria-label="允许" aria-keyshortcuts="Enter"/);
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const wire = projectSession(emptySessionState('session:browser-wire'));
  wire.pendingApproval = { ...composer.pendingApproval, runId: 'run:browser', callId: 'call:browser', sequence: 3,
    createdAt: '2026-09-16T00:00:00Z', preview: { ...composer.pendingApproval.preview, authorizationScope: 'sessionBrowser' },
  };
  assert.deepEqual(await decodeGuiProjection(wire), wire, 'explicit scope survives the strict GUI wire decoder');
  wire.pendingApproval.preview = runPreview;
  assert.deepEqual(await decodeGuiProjection(wire), wire, 'run grant and Kernel context survive the GUI decoder');
  const invalidScope = structuredClone(wire);
  invalidScope.pendingApproval.preview.authorizationScope = 'unknown';
  await assert.rejects(decodeGuiProjection(invalidScope), /conversation_projection_invalid/);
  assert.match(html, /等待加入当前任务/);
  assert.match(html, /Keep the public API unchanged/);
});

test('questions and Plan revisions share the main input and render a single primary action', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConversationComposer } = await loadGuiModule(t, '/src/components/local-agent/ConversationComposer.tsx');
  const base = { profiles: [], selectedProfileId: null, draft: '保留构建配置', pastedTexts: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    canSend: true, showStopAction: false, textDecision: true };
  for (const decision of [
    { pendingInteraction: { interactionId: 'question:one', prompt: '需要保留什么？', allowFreeform: true, options: [] } },
    { pendingPlan: { planId: 'plan:one', revision: 1, title: '清理工作区', summary: '清理已确认文件，保留构建配置。' } },
  ]) {
    const html = renderToStaticMarkup(createElement(ConversationComposer, {
      language: 'zh-CN', composer: { ...base, ...decision }, uiActionError: null,
    }));
    assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
    const primaryLabel = decision.pendingPlan ? '提交修改意见' : '回答';
    assert.equal(html.split(`aria-label="${primaryLabel}"`).length - 1, 1);
    assert.match(html, /aria-label="关闭(?:方案确认|问题)"/);
    assert.match(html, /保留构建配置<\/textarea>/);
    assert.doesNotMatch(html, /aria-label="停止当前运行"/);
    const secondaryLabel = decision.pendingPlan ? '取消并停止' : '跳过';
    assert.equal(html.split(`<span>${secondaryLabel}</span>`).length - 1, 1);
  }
  const running = renderToStaticMarkup(createElement(ConversationComposer, {
    language: 'zh-CN', composer: { ...base, textDecision: false, draft: '', canSend: false, showStopAction: true }, uiActionError: null,
  }));
  assert.match(running, /aria-label="停止当前运行"/);
  const editing = renderToStaticMarkup(createElement(ConversationComposer, {
    language: 'zh-CN', composer: { ...base, textDecision: false }, uiActionError: null,
  }));
  assert.match(editing, /保留构建配置<\/textarea>/);
  assert.match(editing, /aria-label="发送"/);
  assert.doesNotMatch(editing, /aria-label="停止当前运行"/);
  const plan = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', uiActionError: null,
    composer: { ...base, draft: '', canSend: false, pendingPlan: { planId: 'plan:one', revision: 1, title: '清理工作区', summary: '清理已确认文件，保留构建配置。' } },
  }));
  assert.equal((plan.match(/<textarea\b/g) ?? []).length, 1);
  assert.match(plan, />确认执行<\/b>/);
  assert.match(plan, /<button[^>]*aria-label="提交修改意见"[^>]*disabled=""/);
  assert.doesNotMatch(plan, /aria-label="添加"/);
});

test('resource preview keeps expansion beside the shared sidebar control while committed content projects only displayed text', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ResourcePreview, ReaderControls } = await loadGuiModule(t, '/src/components/local-agent/ResourcePreview.tsx');
  const html = renderToStaticMarkup(createElement(ResourcePreview, { language: 'zh-CN', preview: {
    sessionId:'session:reader', tabs:[{id:'readme',target:{kind:'workspace',workspaceId:'workspace:one',logicalPath:'README.md'}}],
    activeId:'readme', visible:true, expanded:false, width:55, error:null,
    selectTab(){},closeTab(){},newPage(){},expand(){},resize(){},openTarget(){},
  } }));
  assert.match(html, /role="separator"/);
  assert.doesNotMatch(html, /aria-label="铺满工作区"|aria-label="浏览器与预览"/);
  for (const expanded of [false, true]) {
    const controls = renderToStaticMarkup(createElement(ReaderControls, { language: 'zh-CN', disabled: false,
      preview: { tabs: [], activeId: null, visible: true, expanded, expand() {}, toggle() {} } }));
    const label = expanded ? '返回并排' : '铺满工作区';
    assert.ok(controls.includes(`aria-label="${label}"`));
    assert.match(controls, /aria-label="浏览器与预览"/);
    assert.match(controls, /aria-pressed="true"/);
  }
  assert.doesNotMatch(html, /<dialog\b/);
  assert.match(html, /README.md/);
  const { projectCommittedText } = await import('../../presentation-core/dist/index.js');
  const projection = { messages: [
    { messageId: 'user:one', role: 'user', content: '<plain>' },
    { messageId: 'assistant:one', role: 'assistant', content: '**Answer**' },
    { messageId: 'tool:one', role: 'tool', content: 'Tool internal output' },
  ], narratives: [{ narrativeId: 'narrative:one', content: 'Checking.' }] };
  assert.deepEqual([...projectCommittedText(projection).values()], [
    { blockId: 'message:user:one:content', text: '<plain>', format: 'plain' },
    { blockId: 'message:assistant:one:content', text: '**Answer**', format: 'markdown' },
    { blockId: 'narrative:narrative:one', text: 'Checking.', format: 'markdown' },
  ]);
});

test('unavailable plugins preserve their source error and cannot be selected in the picker', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const plugin = { uri: 'plugin://broken@1', displayName: 'Broken plugin', shortDescription: 'Optional extension',
    source:'mounted',category:'functional',contributionKind:'mcp',discovery:'default',
    activationMediaTypes: [], enabled: true, available: false, error: { code: 'plugin_load_failed', message: 'Manifest cannot be read' } };
  installGuiFetch(t, () => Response.json({ ok: true, data: { revision: 'catalog:one', plugins: [plugin] } }));
  const { getPluginCatalog } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  assert.deepEqual((await getPluginCatalog()).plugins, [plugin]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConversationComposer } = await loadGuiModule(t, '/src/components/local-agent/ConversationComposer.tsx');
  const html = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', uiActionError: null, composer: {
    profiles: [], selectedProfileId: null, draft: '@', pastedTexts: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [plugin], commandSuggestions: [], pluginPickerOpen: true,
    textareaRef: { current: null },
  } }));
  assert.match(html, /role="option"[^>]*disabled=""/);
  assert.match(html, /plugin_load_failed: Manifest cannot be read/);
});

test('collapsed tool failures retain their original errors in manual details', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx',
  ]);
  const layout = { state: new Map() };
  const render = () => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'tool-failure', eager: true, virtualizer: { layout: () => layout },
    children: () => createElement(ToolActivityGroup, { activities: [{
      activityId: 'activity:one', runId: 'run:one', status: 'failed', kind: 'tool', label: 'read',
      tool: { operation: 'fs.read', resources: [], error: { code: 'path_not_directory', message: 'a.txt is not a directory' },
        projectionError: { code: 'tool_error_diagnostics_invalid', message: 'Original record retained.' } },
    }], language: 'zh-CN', onExpand() {}, onOpenWorkspaceResource() {} }),
  }));
  assert.equal(render().includes('path_not_directory'), false);
  assert.doesNotMatch(render(), /失败/);
  layout.state.set('tool-group:expanded', true);
  assert.match(render(), /失败/);
  layout.state.set('tool:activity:one:expanded', true);
  const html = render();
  assert.match(html, /path_not_directory/);
  assert.match(html, /a.txt is not a directory/);
  assert.match(html, /tool_error_diagnostics_invalid/);
  assert.match(html, /Original record retained/);
});

test('GUI consumes Session-normalized tool errors and record-local detail failures', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:projection-details';
  await createSession(journal, sessionId, [workspaceBinding]);
  let turns = 0;
  let executions = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) {
      for (const callId of ['denied', 'details']) yield providerEvent(request.requestId, 'tool.call', {
        callId, name: request.tools[0].name, input: { path: 'README.md' },
      });
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'Final answer remains readable.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    const reply = completedExecutionReply(request, { artifacts: [{ artifactId: 'bad' }] });
    if (++executions === 1) {
      reply.record.outcome = 'denied';
      delete reply.record.output;
      reply.record.error = { code: 'plan_scope_required', message: 'Original refusal.' };
    }
    return reply;
  } }), fakeRunPreparation({ tools: [{
    toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read a file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] }).port, 'projection-details');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:projection-details', 'Inspect files.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  assert.ok(projection.messages.some((message) => message.content === 'Final answer remains readable.'));
  assert.deepEqual(projection.activities.find((activity) => activity.status === 'denied').tool.error,
    { code: 'plan_scope_required', message: 'Original refusal.' });
  assert.equal(projection.activities.find((activity) => activity.tool?.projectionError).status, 'completed');
  const before = await readEvents(journal, sessionId);
  const service = new SessionService({ async *read() { yield* before; } }, { async create() { throw new Error('Read only'); } });
  assert.deepEqual(await decodeGuiProjection(await service.snapshot(sessionId)), projection);
  assert.deepEqual(await readEvents(journal, sessionId), before);
  const inputRejected = structuredClone(projection);
  const activity = inputRejected.activities.find((item) => item.status === 'denied');
  delete activity.tool;
  activity.status = 'rejected';
  activity.inputRejection = { code: 'tool_input_invalid', message: 'Original input error.',
    diagnostics: { source: 'kernel', phase: 'prepare', category: 'input', retryable: false, causes: [] },
    issues: [{ path: '$.path', rule: 'type', message: 'Expected a string.' }] };
  assert.deepEqual(await decodeGuiProjection(inputRejected), inputRejected);
  assert.deepEqual(await decodeGuiProjection({ ...projection, pendingApprovals: [] }), { ...projection, pendingApprovals: [] });
  await assert.rejects(decodeGuiProjection({ ...projection, pendingApprovals: [{ approvalId: 'invalid' }] }), /conversation_projection_invalid/);
  const { toolActivitySummary } = await loadGuiModule(t, '/src/components/local-agent/ToolActivityDetails.tsx');
  for (const [reason, status, zh, en] of [
    ['cancelled', 'cancelled', '未执行：已取消', 'Not executed: cancelled'],
    ['dependencyFailed', 'rejected', '未执行：前序调用未成功', 'Not executed: predecessor did not succeed'],
  ]) {
    const notExecuted = structuredClone(inputRejected);
    const item = notExecuted.activities.find((entry) => entry.activityId === activity.activityId);
    delete item.inputRejection;
    item.status = status;
    item.notExecuted = { reason, ...(reason === 'dependencyFailed' ? { predecessorCallId: 'call:predecessor' } : {}) };
    assert.deepEqual(await decodeGuiProjection(notExecuted), notExecuted);
    assert.ok(toolActivitySummary(item, 'zh-CN').includes(zh));
    assert.ok(toolActivitySummary(item, 'en-US').includes(en));
    item.notExecuted.reason = 'unknown';
    await assert.rejects(decodeGuiProjection(notExecuted), /conversation_projection_invalid/);
    item.notExecuted.reason = reason;
    item.inputRejection = activity.inputRejection;
    await assert.rejects(decodeGuiProjection(notExecuted), /conversation_projection_invalid/);
  }
});

test('GUI ordinary input queues during a decision without answering it or changing the active model', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-queued-decision';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'tool.call', {
      callId: 'question:gui', name: request.tools.find((tool) => tool.inputSchema.properties?.prompt).name,
      input: { kind: 'question', prompt: 'Which option?', allowFreeform: true },
    });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'gui-queued-decision');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:gui-decision-start', 'Ask a question.'));
  const waiting = await waitForProjection(actor, (value) => value.pendingInteraction !== null);
  const commands = [];
  const catalog = { projects: [], sessions: [] };
  let delayReply = false;
  let releaseReply;
  let receivedMessage;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const messageReceived = new Promise((resolve) => { receivedMessage = resolve; });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body);
      commands.push(command);
      const reply = await actor.submit(command);
      if (delayReply && command.type === 'message.submit') {
        receivedMessage();
        await replyGate;
      }
      return Response.json({ ok: true, data: reply });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: catalog });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:queued', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: waiting, catalog,
    selectedProfileId: 'profile:next-run', reasoningEffortOverride: 'high', profiles: [] });
  await store.getState().sendMessage('Keep the original file layout.');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'message.submit');
  assert.equal(commands[0].runId, waiting.run.runId);
  assert.equal(commands[0].profileId, undefined);
  assert.equal(commands[0].reasoningEffortOverride, undefined);
  const queued = store.getState().projection;
  assert.deepEqual(queued.pendingInteraction, waiting.pendingInteraction);
  assert.equal(queued.run.runId, waiting.run.runId);
  assert.equal(queued.queuedInputs[0].text, 'Keep the original file layout.');
  assert.equal(queued.queuedInputs[0].status, 'queued');
  assert.equal(queued.messages.some((message) => message.content === 'Keep the original file layout.'), false);
  delayReply = true;
  const sending = store.getState().sendMessage('Preserve this second supplement too.');
  await messageReceived;
  assert.equal(store.getState().submitting, true);
  await Promise.all([store.getState().cancelRun(), store.getState().cancelRun()]);
  assert.equal(commands.filter((command) => command.type === 'run.cancel').length, 1, 'repeated stop uses the existing command flight');
  assert.equal(store.getState().projection.run.status, 'cancelled');
  assert.equal(store.getState().submitting, true, 'a pending ordinary submission retains its own lifecycle');
  releaseReply();
  await sending;
  assert.equal(store.getState().submitting, false);
  assert.deepEqual(store.getState().projection.queuedInputs.map((input) => input.status), ['notApplied', 'notApplied']);
  store.setState({ projection: waiting });
  await assert.rejects(store.getState().sendMessage('A supplement sent from the older snapshot.'), /queued_input_run_unavailable/);
  assert.equal(store.getState().projection.run.runId, waiting.run.runId);
  assert.equal(store.getState().projection.run.status, 'cancelled');
});

test('new-session submission identifies the draft destination before publishing the session', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-created-draft';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'assistant.message', { messageId: 'answer:created', content: 'Received.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'gui-created-draft');
  t.after(() => actor.dispose());
  const catalog = { projects: [], sessions: [] };
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/sessions')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/commands')) return Response.json({ ok: true, data: await actor.submit(JSON.parse(init.body)) });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: catalog });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:created', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId: null, projection: null, catalog,
    selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }] });
  const destinations = [];
  await store.getState().sendMessage('Start the task.', [], [], [], (createdSessionId) => {
    assert.equal(store.getState().sessionId, null);
    destinations.push(createdSessionId);
  });
  assert.deepEqual(destinations, [sessionId]);
  assert.equal(store.getState().sessionId, sessionId);
});

test('model settings distinguish a failed read from a successfully empty catalog and retain loaded profiles', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ default: LlmSection }, api] = await loadGuiModules(t, [
    '/src/components/settings-center/sections/LlmSection.tsx', '/src/services/apiClient.ts',
  ]);
  const initial = renderToStaticMarkup(createElement(LlmSection));
  assert.match(initial, /role="status"/);
  assert.doesNotMatch(initial, /暂无连接|No connections/, 'unread connections are not an empty catalog');
  let unavailable = true;
  installGuiFetch(t, (url) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    if (unavailable) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true, data: { profiles: [], connections: [] } });
  });
  const failed = await api.getLlmProfiles();
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Failed to fetch/);
  const profiles = [
    { id: 'profile:existing', name: 'Existing model', enabled: true },
    { id: 'profile:disabled', name: 'Disabled model', enabled: false },
  ];
  const store = await loadGuiModelStore(t);
  store.setState({ profiles, defaultProfileId: profiles[0].id, selectedProfileId: profiles[0].id });
  await store.getState().refreshProfiles();
  assert.deepEqual(store.getState().profiles, profiles);
  assert.equal(store.getState().defaultProfileId, profiles[0].id);
  assert.equal(store.getState().selectedProfileId, profiles[0].id);
  assert.match(store.getState().error, /Failed to fetch/);
  unavailable = false;
  const empty = await api.getLlmProfiles();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.data.profiles, []);
  await store.getState().refreshProfiles();
  assert.deepEqual(store.getState().profiles, []);
  assert.equal(store.getState().defaultProfileId, null);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().selectedProfileId, profiles[0].id, 'reading an empty catalog does not silently change the selected model');
});

test('compact display math fences retain aligned formulas and following Markdown in streamed and settled views', async (t) => {
  const [{ StreamingMarkdownParser }, { MarkdownContent }] = await loadGuiModules(t, [
    '/src/components/local-agent/streamingMarkdown.ts', '/src/components/local-agent/BufferedMarkdown.tsx',
  ]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const formula = String.raw`$$\begin{aligned}
\text{buy1}_i &= \max_{i_1 \le i}(-p_{i_1})\\
\text{sell1}_i &= \max_{i_1 \le j_1 \le i}(p_{j_1}-p_{i_1})
\end{aligned}$$`;
  const following = '\n\n## Verification\n\n- **Result** stays outside math.\n\n| Cost | Space |\n| --- | --- |\n| $O(n)$ | $O(1)$ |';
  const text = '# Proof\n\n' + formula + following;
  const render = (source, streaming) => renderToStaticMarkup(createElement(MarkdownContent, { children: source, streaming }));
  const completed = render(text, false);
  assert.doesNotMatch(completed, /katex-error/);
  assert.match(completed, /class="katex-display"/);
  assert.match(completed, /<h2>Verification<\/h2>/);
  assert.match(completed, /<strong>Result<\/strong>/);
  assert.match(completed, /<table>/);
  assert.equal(render(text, true), completed);
  const stream = new StreamingMarkdownParser();
  for (const end of [text.indexOf('sell1'), text.indexOf('aligned}$$') + 9, text.indexOf('## Verification'), text.length]) {
    stream.update(text.slice(0, end), true);
  }
  assert.deepEqual(stream.update(text, false), new StreamingMarkdownParser().update(text, false));
  const fencedCode = render('```tex\n' + formula + '\n```', false);
  assert.doesNotMatch(fencedCode, /class="katex/);
  assert.match(fencedCode, /\$\$\\begin\{aligned\}/);
  const inlineCode = render('`$$\\begin{aligned} a &= b \\end{aligned}$$`', false);
  assert.doesNotMatch(inlineCode, /class="katex/);
  assert.match(render('$$\na &= b\n$$\n\n## Original error', false), /katex-error/);
});

test('invalid default profiles retain editable settings and do not prevent reading conversation history', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:profile-error-history';
  await createSession(journal, sessionId, [workspaceBinding]);
  const provider = { async *stream(request) {
    yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:history', content: 'Saved conversation response.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'profile-error-history');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:history', 'Keep this conversation.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.ok(projection.messages.some((message) => message.role === 'assistant'));
  const profile = { id: 'profile:kept', name: 'My configured model', kind: 'responses', model: 'configured-model', enabled: true, secretRef: 'local-secret:profile:kept' };
  const editable = { profiles: [profile], defaultProfileId: 'profile:missing', storePath: '/config/settings/llm-profiles.json' };
  const failure = { ok: false, error: 'invalid_llm_profile_store_schema', message: 'defaultProfileId: profile:missing', data: editable };
  const catalog = { projects: [], sessions: [{ id: sessionId, title: 'Saved conversation', workspaceBindings: [workspaceBinding], profileId: profile.id,
    createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' }] };
  installGuiFetch(t, (url, init) => {
    assert.equal(init.method ?? 'GET', 'GET');
    if (url.pathname === '/api/llm/profiles') return Response.json(failure);
    if (url.pathname === '/api/conversation/catalog') return Response.json({ ok: true, data: catalog });
    if (url.pathname === '/api/conversation/plugins') return Response.json({ ok: true, data: { revision: 'plugin-catalog:empty', plugins: [] } });
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [{ sessionId, revision: projection.revision,
      run: { runId: projection.run.runId, status: projection.run.status } }] });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: projection });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const api = await loadGuiModule(t, '/src/services/apiClient.ts');
  assert.deepEqual(await api.getLlmProfiles(), failure);
  const store = await loadGuiModelStore(t);
  await store.getState().initialize();
  assert.deepEqual(store.getState().catalog, catalog);
  await store.getState().activateSession(sessionId);
  assert.equal(store.getState().loading, false);
  assert.deepEqual(store.getState().projection.messages, projection.messages);
  await assert.rejects(store.getState().sendMessage('Start a new run.'), /llm_profile_unavailable/);
  assert.deepEqual((await actor.snapshot()).messages, projection.messages);
});

test('saving valid profiles enables an unbound draft and clears its profile error', async (t) => {
  const profile = { id: 'profile:configured', name: 'Configured model', kind: 'responses', model: 'configured-model', enabled: true };
  let profileResponse = { ok: false, error: 'invalid_llm_profile_store_schema', message: 'defaultProfileId: profile:missing',
    data: { profiles: [profile], defaultProfileId: 'profile:missing' } };
  installGuiFetch(t, (url) => {
    if (url.pathname === '/api/llm/profiles') return Response.json(profileResponse);
    if (url.pathname === '/api/conversation/catalog') return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname === '/api/conversation/plugins') return Response.json({ ok: true, data: { revision: 'plugin-catalog:empty', plugins: [] } });
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  await store.getState().initialize();
  assert.equal(store.getState().sessionId, null);
  assert.equal(store.getState().selectedProfileId, null);
  assert.equal(store.getState().defaultProfileId, null);
  assert.equal(store.getState().error, profileResponse.message);
  profileResponse = { ok: true, data: { profiles: [profile], defaultProfileId: profile.id } };
  await store.getState().refreshProfiles();
  assert.equal(store.getState().selectedProfileId, profile.id);
  assert.deepEqual(store.getState().profiles, [profile]);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().errorSource, null);
});

test('settings drafts survive refreshes and failed saves without converting an empty number to zero', async (t) => {
  const [{ reconcileSettingDraft, parseSettingDraft }, { useSettingsStore }] = await loadGuiModules(t, ['/src/components/settings-center/settingDraft.ts', '/src/state/settingsStore.ts']);
  let draft = { saved: 'old prompt', text: 'new prompt\nwith a second line' };
  const saved = draft.saved;
  useSettingsStore.setState({ effectiveSettings: { ...useSettingsStore.getState().effectiveSettings, 'agent.systemPrompt': saved } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installGuiFetch(t, async (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    assert.equal(init.method, 'PATCH');
    assert.equal(JSON.parse(init.body).patches['agent.systemPrompt'], draft.text);
    await gate;
    return Response.json({ ok: false, message: 'settings_write_failed: read-only directory' });
  });
  const saving = useSettingsStore.getState().patchUserSetting('agent.systemPrompt', draft.text);
  assert.equal(useSettingsStore.getState().effectiveSettings['agent.systemPrompt'], saved);
  release();
  assert.equal(await saving, null);
  assert.equal(useSettingsStore.getState().errorMessage, 'settings_write_failed: read-only directory');
  assert.equal(useSettingsStore.getState().effectiveSettings['agent.systemPrompt'], saved);
  draft = reconcileSettingDraft(draft, saved);
  assert.equal(draft.text, 'new prompt\nwith a second line');
  draft = reconcileSettingDraft(draft, 'updated by another window');
  assert.equal(draft.text, 'new prompt\nwith a second line');
  assert.equal(draft.saved, 'updated by another window');
  assert.deepEqual(reconcileSettingDraft({ saved: 'old', text: 'old' }, 'new'), { saved: 'new', text: 'new' });
  assert.equal(parseSettingDraft('', true), null);
  assert.equal(parseSettingDraft('12', true), 12);
  assert.equal(parseSettingDraft('', false), '');
});

test('settings search matches words across field and model metadata without order dependence', async (t) => {
  const { matchesSettingsQuery } = await loadGuiModule(t, '/src/components/settings-center/settingsSearch.tsx');
  assert.equal(matchesSettingsQuery('PDF Python', 'PDF 生成环境', 'WeasyPrint Python'), true);
  assert.equal(matchesSettingsQuery('flash deepseek', 'DeepSeek Flash', 'deepseek-v4-flash'), true);
  assert.equal(matchesSettingsQuery('shell windows', 'Windows Shell'), true);
  assert.equal(matchesSettingsQuery('github python', 'GitHub', 'Read repositories'), false);
});

test('environment settings use the Host platform for Windows controls without changing persisted values', async (t) => {
  const [{ AgentSettingsSection }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/components/settings-center/sections/CategorizedSettingsSections.tsx',
    '/src/state/settingsStore.ts',
  ]);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const settings = { ...useSettingsStore.getState().effectiveSettings, 'agent.windows.shell': 'gitBash', 'agent.windows.gitBashPath': 'C:\\Git\\bin\\bash.exe' };
  // React's server renderer reads Zustand's initial snapshot, not getState().
  const initialSnapshot = useSettingsStore.getInitialState();
  const original = { effectiveSettings: initialSnapshot.effectiveSettings, environment: initialSnapshot.environment };
  t.after(() => { Object.assign(initialSnapshot, original); });
  Object.assign(initialSnapshot, { effectiveSettings: settings, environment: { os: 'macos' } });
  useSettingsStore.setState({ effectiveSettings: settings, environment: initialSnapshot.environment });
  const mac = renderToStaticMarkup(React.createElement(AgentSettingsSection, { category: 'environment' }));
  assert.doesNotMatch(mac, /aria-label="Windows Shell"/);
  assert.doesNotMatch(mac, /aria-label="Git Bash (路径|path)"/);
  assert.match(mac, /WeasyPrint/);
  initialSnapshot.environment = { os: 'windows' };
  useSettingsStore.setState({ environment: initialSnapshot.environment });
  const windows = renderToStaticMarkup(React.createElement(AgentSettingsSection, { category: 'environment' }));
  assert.match(windows, /aria-label="Windows Shell"/);
  assert.match(windows, /aria-label="Git Bash (路径|path)"/);
  assert.equal(useSettingsStore.getState().effectiveSettings, settings);
});

test('picker navigation skips unavailable tools and supports wrapping and tab endpoints', async (t) => {
  const { nextEnabledIndex } = await loadGuiModule(t, '/src/components/shared/keyboardNavigation.ts');
  const tools = [false, true, false, true];
  assert.equal(nextEnabledIndex(tools, -1, 'ArrowDown'), 1);
  assert.equal(nextEnabledIndex(tools, 1, 'ArrowDown'), 3);
  assert.equal(nextEnabledIndex(tools, 3, 'ArrowDown'), 1);
  assert.equal(nextEnabledIndex(tools, 1, 'ArrowUp'), 3);
  assert.equal(nextEnabledIndex([false], 0, 'Home'), -1);
  assert.equal(nextEnabledIndex([true, true], 1, 'Home'), 0);
  assert.equal(nextEnabledIndex([true, true], 0, 'End'), 1);
});

test('UI update detection compares entry resources and retains the original load failure', async (t) => {
  const { interfaceResourcesChanged, interfaceUpdateSnapshot, reportInterfaceLoadError, subscribeInterfaceUpdates } = await loadGuiModule(t, '/src/services/interfaceUpdates.ts');
  assert.equal(interfaceResourcesChanged(['entry-a.js', 'style-a.css'], ['style-a.css', 'entry-a.js']), false);
  assert.equal(interfaceResourcesChanged(['entry-a.js'], ['entry-b.js']), true);
  assert.equal(interfaceResourcesChanged(['entry-a.js'], ['entry-a.js', 'style-b.css']), true);
  let notifications = 0;
  const unsubscribe = subscribeInterfaceUpdates(() => notifications++);
  reportInterfaceLoadError(new Error('Importing a module script failed: SettingsCenter-old.js'));
  assert.equal(interfaceUpdateSnapshot().error, 'Importing a module script failed: SettingsCenter-old.js');
  assert.equal(interfaceUpdateSnapshot().available, false);
  assert.equal(notifications, 1);
  unsubscribe();
  reportInterfaceLoadError(new Error('second failure'));
  assert.equal(notifications, 1);
});

test('interface refresh preserves view state and leaves unsaved settings for the user', async (t) => {
  const previous = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  const saved = new Map();
  const scheduled = [];
  let reloads = 0;
  globalThis.sessionStorage = { getItem: key => saved.get(key) ?? null, removeItem: key => saved.delete(key), setItem: (key, value) => saved.set(key, value) };
  globalThis.window = { setTimeout: callback => scheduled.push(callback), location: { reload: () => reloads++ } };
  t.after(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key];
    }
  });
  const { refreshInterface, registerInterfaceReloadGuard, registerInterfaceReloadView } = await loadGuiModule(t, '/src/services/interfaceReload.ts');
  let guard = { label: 'External tool connection', busy: false };
  const releaseGuard = registerInterfaceReloadGuard(() => guard);
  const importGuard = { label: 'Import theme', busy: false };
  const releaseImport = registerInterfaceReloadGuard(() => importGuard);
  const releaseView = registerInterfaceReloadView('reader', () => ({ previewId: 'preview-7', scroll: 42 }));
  t.after(() => { releaseGuard(); releaseImport(); releaseView(); });
  assert.deepEqual(refreshInterface(), { status: 'needsUser', guards: [guard, importGuard] });
  guard = { ...guard, busy: true };
  assert.deepEqual(refreshInterface(), { status: 'needsUser', guards: [guard, importGuard] });
  releaseImport();
  assert.deepEqual(refreshInterface(), { status: 'needsUser', guards: [guard] });
  assert.equal(saved.size, 0);
  assert.equal(scheduled.length, 0);
  releaseGuard();
  assert.deepEqual(refreshInterface(), { status: 'scheduled', guards: [] });
  assert.deepEqual(JSON.parse(saved.get('deepcode:interface-reload')), { reader: { previewId: 'preview-7', scroll: 42 } });
  assert.equal(reloads, 0);
  scheduled.shift()();
  assert.equal(reloads, 1);
});

test('custom light and dark palettes persist through the shared settings owner and reset independently', async (t) => {
  const [{ useSettingsStore }, palette] = await loadGuiModules(t, ['/src/state/settingsStore.ts', '/src/theme/palette.ts']);
  let persisted = { 'gui.colorTheme': 'system', 'gui.accentColor': 'purple' };
  let fail = false;
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      if (fail) return Response.json({ ok: false, message: 'palette write failed' });
      for (const [key, value] of Object.entries(patches)) {
        if (value === null) delete persisted[key]; else persisted[key] = value;
      }
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, overriddenKeys: Object.keys(persisted), storePath: '/test/user-settings.json' } });
  });
  await useSettingsStore.getState().loadUserSettings();
  const custom = { '--dc-theme-light-background': '#f5f1ea', '--dc-theme-dark-background': '#202124', '--dc-custom-dark-accent': '#aaccee' };
  assert.equal(await useSettingsStore.getState().patchUserSetting(palette.PALETTE_SETTING, JSON.stringify(custom)), 'immediate');
  const [{ useSettingsStore: reloaded }] = await loadGuiModules(t, ['/src/state/settingsStore.ts']);
  await reloaded.getState().loadUserSettings();
  const read = () => palette.decodePaletteOverrides(reloaded.getState().effectiveSettings[palette.PALETTE_SETTING]);
  assert.deepEqual(read(), custom);
  assert.equal(palette.paletteColor(read(), 'dark', 'accent', 'purple'), '#aaccee');
  assert.equal(palette.paletteColor(read(), 'light', 'accent', 'purple'), palette.UI_PALETTE.tokens['--dc-accent-purple-light']);
  fail = true;
  assert.equal(await reloaded.getState().patchUserSetting(palette.PALETTE_SETTING, '{}'), null);
  assert.match(reloaded.getState().errorMessage, /palette write failed/);
  assert.deepEqual(read(), custom);
  fail = false;
  const lightOnly = palette.resetPaletteTheme(read(), 'dark');
  assert.equal(await reloaded.getState().patchUserSetting(palette.PALETTE_SETTING, JSON.stringify(lightOnly)), 'immediate');
  await reloaded.getState().loadUserSettings();
  assert.deepEqual(read(), { '--dc-theme-light-background': '#f5f1ea' });
  assert.equal(reloaded.getState().effectiveSettings['gui.colorTheme'], 'system');
  assert.equal(reloaded.getState().effectiveSettings['gui.accentColor'], 'purple');
  assert.equal(await reloaded.getState().resetUserSetting(palette.PALETTE_SETTING), 'immediate');
  await reloaded.getState().loadUserSettings();
  assert.deepEqual(read(), {});
});

test('palette rejects incomplete input and reset removes custom colors and derived contrast', async (t) => {
  const { decodePaletteOverrides, paletteOverrideCss, resetPaletteTheme } = await loadGuiModule(t, '/src/theme/palette.ts');
  for (const encoded of ['{broken', '[]', 'null', '{"unknown":"#112233"}', '{"--dc-theme-dark-background":"#12"}', '{"--dc-theme-dark-background":null}']) {
    assert.throws(() => decodePaletteOverrides(encoded));
    assert.throws(() => paletteOverrideCss(encoded));
  }
  const custom = { '--dc-custom-dark-accent': '#aabbcc', '--dc-theme-light-border': '#11223322' };
  const css = paletteOverrideCss(JSON.stringify(custom));
  assert.match(css, /--dc-custom-dark-accent-contrast:var\(--dc-shadow-color\)/);
  const reset = paletteOverrideCss(JSON.stringify(resetPaletteTheme(custom, 'dark')));
  assert.doesNotMatch(reset, /custom-dark/);
  assert.match(reset, /--dc-theme-light-border:#11223322/);
  assert.equal(paletteOverrideCss('{}'), ':root{}');
});

test('named themes validate before import and select light and dark palettes independently', async (t) => {
  const library = await loadGuiModule(t, '/src/theme/themeLibrary.ts');
  const palette = await loadGuiModule(t, '/src/theme/palette.ts');
  const imported = library.importTheme(JSON.stringify({ name: 'Review Theme', light: { background: '#F4F2ED' }, dark: { accent: '#BBAADD' } }));
  assert.equal(imported.light.background, '#f4f2ed');
  const themes = [...library.builtinThemes(), { id: 'review', ...imported }];
  let applied = library.applyThemePalette({}, imported, 'light');
  assert.equal(library.selectedThemeId(themes, applied, 'light'), 'review');
  assert.equal(library.selectedThemeId(themes, applied, 'dark'), 'default');
  applied = library.applyThemePalette(applied, themes[0], 'dark');
  assert.equal(applied['--dc-theme-light-background'], '#f4f2ed');
  assert.equal(library.selectedThemeId(themes, applied, 'dark'), themes[0].id);
  const edited = { ...applied, '--dc-custom-dark-accent': '#abcdef' };
  assert.equal(library.selectedThemeId(themes, edited, 'dark'), 'custom');
  assert.deepEqual(library.applyThemePalette(applied, null, 'dark'), { '--dc-theme-light-background': '#f4f2ed' });
  for (const theme of themes) palette.decodePaletteOverrides(JSON.stringify(library.themeOverrides(theme)));
  for (const document of [null, [], { name: 'Empty' }, { name: 'Bad', dark: { unknown: '#112233' } }, { name: 'Bad', dark: { accent: '#12' } }]) {
    assert.throws(() => library.importTheme(JSON.stringify(document)));
  }
  assert.throws(() => library.decodeThemeLibrary(JSON.stringify([{ id: 'same', ...imported }, { id: 'same', ...imported }])));
});

test('theme library and UI fonts persist without changing active colors or appearance mode', async (t) => {
  const [{ useSettingsStore }, library, fonts, i18n] = await loadGuiModules(t, ['/src/state/settingsStore.ts', '/src/theme/themeLibrary.ts', '/src/theme/typography.ts', '/src/i18n.ts']);
  let persisted = { 'gui.colorTheme': 'system', 'workbench.styleTokenOverrides': '{"--dc-custom-dark-accent":"#ccbbaa"}' };
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings');
    if (init.method === 'PATCH') {
      const { patches } = JSON.parse(init.body);
      for (const [key, value] of Object.entries(patches)) { if (value === null) delete persisted[key]; else persisted[key] = value; }
      return Response.json({ ok: true, data: { settings: persisted, changedKeys: Object.keys(patches), activation: 'immediate' } });
    }
    return Response.json({ ok: true, data: { settings: persisted, runtimeSettings: persisted, overriddenKeys: Object.keys(persisted), storePath: '/test/user-settings.json' } });
  });
  const saved = [{ id: 'user-theme', name: 'User theme', dark: { background: '#202022' } }];
  await useSettingsStore.getState().patchUserSetting(library.THEME_LIBRARY_SETTING, JSON.stringify(saved));
  await useSettingsStore.getState().patchUserSettingsBatch({ [fonts.UI_FONT_FAMILY_SETTING]: 'PingFang SC', [fonts.UI_FONT_SIZE_SETTING]: 16, [fonts.CODE_FONT_SIZE_SETTING]: 11 });
  const [{ useSettingsStore: reloaded }] = await loadGuiModules(t, ['/src/state/settingsStore.ts']);
  await reloaded.getState().loadUserSettings();
  const settings = reloaded.getState().effectiveSettings;
  assert.deepEqual(library.decodeThemeLibrary(settings[library.THEME_LIBRARY_SETTING]), saved);
  assert.equal(settings['gui.colorTheme'], 'system');
  assert.equal(settings['workbench.styleTokenOverrides'], '{"--dc-custom-dark-accent":"#ccbbaa"}');
  assert.match(fonts.uiFontFamily(settings[fonts.UI_FONT_FAMILY_SETTING]), /^"PingFang SC",/);
  assert.equal(fonts.uiFontSize(settings[fonts.UI_FONT_SIZE_SETTING]), 16);
  assert.equal(fonts.codeFontSize(settings[fonts.CODE_FONT_SIZE_SETTING]), 11);
  await reloaded.getState().patchUserSettingsBatch({
    [fonts.UI_FONT_FAMILY_SETTING]: 'warm',
    [fonts.INTERFACE_FONT_FAMILY_SETTING]: 'inherit',
    [fonts.CONTENT_FONT_FAMILY_SETTING]: 'system',
    [fonts.TERMINAL_FONT_FAMILY_SETTING]: 'compact',
    [fonts.CONTENT_FONT_SIZE_SETTING]: 14,
  });
  await reloaded.getState().loadUserSettings();
  const mixed = fonts.typographyStyles(reloaded.getState().effectiveSettings);
  assert.match(mixed['--dc-font-ui'], /DeepCode Quiet Reading SC/);
  assert.equal(mixed['--dc-font-reading'], fonts.UI_FONT_PRESETS.system);
  assert.match(mixed['--dc-font-code'], /DeepCode Quiet Mono SC/);
  assert.equal(mixed['--dc-font-reading-size'], '14px');
  assert.equal(mixed['--dc-font-code-size'], '11px');
  assert.equal(mixed['--dc-ui-font-scale'], String(16 / 14));
  await reloaded.getState().patchUserSettingsBatch({
    [fonts.CONTENT_FONT_FAMILY_SETTING]: 'warm-sans',
    [fonts.TERMINAL_FONT_FAMILY_SETTING]: 'compact-kai',
  });
  await reloaded.getState().loadUserSettings();
  const variants = fonts.typographyStyles(reloaded.getState().effectiveSettings);
  assert.equal(variants['--dc-font-ui'], mixed['--dc-font-ui']);
  assert.match(variants['--dc-font-reading'], /^"DeepCode Quiet Reading Sans SC",/);
  assert.match(variants['--dc-font-code'], /^"DeepCode Quiet Mono Kai SC",/);
  assert.equal(variants['--dc-font-reading-size'], '14px');
  assert.equal(variants['--dc-font-code-size'], '11px');
  assert.equal(reloaded.getState().effectiveSettings['workbench.styleTokenOverrides'], '{"--dc-custom-dark-accent":"#ccbbaa"}');
  for (const [choice, chinese, english] of [
    ['warm', '温和阅读 · 文楷', 'Gentle reading · Kai'],
    ['warm-sans', '温和阅读 · 无衬线', 'Gentle reading · Sans'],
    ['compact-kai', '紧凑终端 · 文楷', 'Compact terminal · Kai'],
    ['compact', '紧凑终端 · 无衬线', 'Compact terminal · Sans'],
  ]) {
    assert.equal(i18n.t('zh-CN', `settings.font.${choice}`), chinese);
    assert.equal(i18n.t('en-US', `settings.font.${choice}`), english);
  }
  await reloaded.getState().patchUserSettingsBatch({
    [fonts.UI_FONT_FAMILY_SETTING]: 'system',
    [fonts.INTERFACE_FONT_FAMILY_SETTING]: null,
    [fonts.CONTENT_FONT_FAMILY_SETTING]: null,
    [fonts.TERMINAL_FONT_FAMILY_SETTING]: null,
    [fonts.CONTENT_FONT_SIZE_SETTING]: null,
  });
  const unified = fonts.typographyStyles(reloaded.getState().effectiveSettings);
  assert.equal(unified['--dc-font-ui'], fonts.UI_FONT_PRESETS.system);
  assert.equal(unified['--dc-font-reading'], fonts.UI_FONT_PRESETS.system);
  assert.match(unified['--dc-font-code'], /^ui-monospace/);
  assert.equal(fonts.codeFontSize(undefined), 12);
  assert.throws(() => fonts.codeFontSize(9));
  assert.throws(() => fonts.codeFontSize(19));
  assert.throws(() => fonts.codeFontSize(12.5));
  assert.throws(() => fonts.uiFontFamily(''));
  assert.throws(() => fonts.uiFontFamily('bad; family'));
  assert.throws(() => fonts.uiFontSize(0));
  assert.throws(() => fonts.uiFontSize(14.5));
  await reloaded.getState().patchUserSettingsBatch({ [fonts.UI_FONT_FAMILY_SETTING]: null, [fonts.UI_FONT_SIZE_SETTING]: null, [fonts.CODE_FONT_SIZE_SETTING]: null });
  assert.equal(reloaded.getState().effectiveSettings[fonts.UI_FONT_FAMILY_SETTING], 'warm-sans');
  const defaultFonts = fonts.typographyStyles(reloaded.getState().effectiveSettings);
  for (const key of ['--dc-font-ui', '--dc-font-reading', '--dc-font-code']) {
    assert.equal(defaultFonts[key], fonts.UI_FONT_PRESETS['warm-sans']);
  }
  assert.equal(fonts.uiFontFamily(undefined), fonts.UI_FONT_PRESETS['warm-sans']);
  assert.equal(reloaded.getState().effectiveSettings[fonts.UI_FONT_SIZE_SETTING], 14);
  assert.equal(reloaded.getState().effectiveSettings[fonts.CODE_FONT_SIZE_SETTING], 12);
  assert.deepEqual(library.decodeThemeLibrary(reloaded.getState().effectiveSettings[library.THEME_LIBRARY_SETTING]), saved);
});

test('GUI consumes diagnostic attempts and failure snapshots while rejecting malformed facts', async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:gui-diagnostic';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'failed', { code: 'provider_http_failed', message: 'HTTP 401', diagnostics: {
      source: 'providerTransport', phase: 'response', category: 'http', retryable: false,
      causes: [{ message: 'Authentication rejected' }], archivePath: '/test/attempt/timeline.jsonl',
    } });
  } }, emptyKernel(), fakeRunPreparation().port, 'gui-diag');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:diag', 'Test failure.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  assert.equal(projection.providerAttempts.length, 1);
  assert.equal(projection.failureSnapshot.error.diagnostics.retryable, false);
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  for (const mutate of [
    (p) => { p.providerAttempts[0].attempt = 6; },
    (p) => { p.terminalError.diagnostics.retryable = 'yes'; },
    (p) => { p.failureSnapshot.error.diagnostics.causes[0].osCode = 'unknown'; },
    (p) => { p.failureSnapshot.revision = -1; },
  ]) {
    const malformed = structuredClone(projection); mutate(malformed);
    await assert.rejects(decodeGuiProjection(malformed), /conversation_projection_invalid/);
  }
});

test('startup opens a new draft even when history exists, and status failure does not erase the reader', async (t) => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const history = projectSession(emptySessionState('session:history'));
  let statusFailed = false;
  const requests = [];
  installGuiFetch(t, async (url) => {
    requests.push(url.pathname);
    if (url.pathname === '/api/conversation/catalog') return Response.json({ ok: true, data: { projects: [], sessions: [{
      id: 'session:history', title: 'Existing history', workspaceBindings: [], createdAt: '2026-09-01', updatedAt: '2026-09-01',
    }] } });
    if (url.pathname === '/api/conversation/plugins') return Response.json({ ok: true, data: { revision: 'catalog:test', plugins: [] } });
    if (url.pathname === '/api/llm/profiles') return Response.json({ ok: true, data: { profiles: [] } });
    if (url.pathname === '/api/conversation/statuses') {
      statusFailed = true;
      throw new Error('original_status_failure');
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: history });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  await store.getState().initialize();
  await waitUntil(() => statusFailed, 'status response');
  await store.getState().refresh();
  assert.equal(store.getState().sessionId, null);
  assert.equal(store.getState().projection, null);
  assert.equal(requests.some((path) => path.endsWith('/projection')), false);
  store.setState({ sessionId: history.sessionId, projection: history, error: 'command_failure', errorSource: 'command' });
  await store.getState().refresh();
  assert.equal(store.getState().statusError, 'original_status_failure');
  assert.equal(store.getState().error, 'command_failure');
  assert.deepEqual(store.getState().projection, history);
});


test('usage revision advances with every provider response inside a run', async (t) => {
  const { usageRevision } = await loadGuiModule(t, '/src/ui-plugins/UsageWidget.tsx');
  assert.equal(usageRevision(undefined), 0);
  assert.equal(usageRevision([]), 0);
  const round = { providerCallCount: 1, inputTokens: 900, outputTokens: 120 };
  const first = usageRevision([round]);
  assert.equal(first, 1021);
  assert.notEqual(usageRevision([{ ...round, outputTokens: 260 }]), first, 'a later response in the same run changes the revision');
  assert.notEqual(usageRevision([{ ...round, providerCallCount: 2 }]), first, 'a completion without usage still changes the revision');
});

async function createUsageWidgetHarness(t, savedPositions = new Map()) {
  const { default: plugin } = await import('../src/ui-plugins/builtinUsage.mjs');
  const { usageWidgetLabels } = await loadGuiModule(t, '/src/ui-plugins/usageWidgetLabels.ts');
  class Element {
    children = []; dataset = {}; hidden = false; attrs = {}; clientWidth = 800; clientHeight = 600;
    listeners = new Map(); captures = new Set();
    style = { setProperty() {} };
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
    replaceChildren() { for (const child of this.children) child.parentElement = null; this.children = []; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    closest(selector) { return selector === '[data-usage-drag]' && 'usageDrag' in this.dataset ? this : this.parentElement?.closest(selector); }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelectorAll(selector) {
      const classes = selector.split(',').map(value => value.slice(1));
      return this.children.flatMap(child => [...(classes.includes(child.className) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    getBoundingClientRect() {
      const collapsed = this.children.some(child => child.className === 'dc-usage__handle');
      return { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0, width: collapsed ? 18 : 200, height: collapsed ? 28 : 80 };
    }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  }
  const listeners = new Map();
  let view, disposed = false;
  const old = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = {
    createElement: () => new Element(),
    addEventListener(type, listener, capture = false) { listeners.set(type, { listener, capture }); },
    removeEventListener(type, listener, capture = false) {
      assert.deepEqual(listeners.get(type), { listener, capture }); listeners.delete(type);
    },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: key => savedPositions.get(key) ?? null, setItem: (key, value) => savedPositions.set(key, value) } };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => {
    try { if (view && !disposed) view.dispose(); }
    finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
  });
  let renderer;
  plugin.apply({ addStyle() {}, register(slot, render) { assert.equal(slot, 'usage.widget'); renderer = render; } });
  const container = new Element();
  return {
    Element, listeners, container, usageWidgetLabels,
    mount(input, scope) { view = renderer(container, input, scope); return view; },
    dispose() { view.dispose(); disposed = true; },
  };
}

test('usage widget preserves outside dismissal and docks collapsed dragging to the nearest edge', async (t) => {
  const { Element, listeners, container, usageWidgetLabels, mount, dispose } = await createUsageWidgetHarness(t);
  const changes = [];
  let view;
  let input = { visibility: 'summary', expanded: true, locale: 'zh-CN', revision: 0, modelId: 'codex',
    labels: usageWidgetLabels('zh-CN'), costDisplay: { currency: 'USD', usdRate: 1 },
    connection: { id: 'connection:quota', name: 'Codex', billingMode: 'subscription' } };
  let reads = 0;
  const actions = {
    setExpanded(value) { changes.push(value); input = { ...input, expanded: value }; view.update(input); },
    setUsageVisibility() { assert.fail('outside dismissal must not hide the summary or change its preference'); },
  };
  view = mount(input, { signal: new AbortController().signal,
    quota: { async read() { reads++; return { windows: [{ label: 'Codex', usedPercent: 21, windowDurationSeconds: 300 }] }; } },
    actions,
  });
  await Promise.resolve();
  const root = container.children[0];
  const pointer = target => listeners.get('pointerdown').listener({ target });
  assert.equal(listeners.get('pointerdown').capture, true, 'dismissal also observes outside controls that stop bubbling');
  assert.equal(root.querySelectorAll('.dc-usage__details').length, 1);
  let detail = root.querySelectorAll('.dc-usage__details')[0];
  pointer(detail);
  assert.deepEqual(changes, [], 'inside details are not an outside click');
  assert.equal(detail.children.some(child => child.textContent === '刷新'), false, 'the details no longer offer a manual refresh');
  input = { ...input, locale: 'en-US', labels: usageWidgetLabels('en-US') }; view.update(input);
  assert.ok(root.querySelectorAll('.dc-usage__details')[0].children.some(child => child.textContent === usageWidgetLabels('en-US').remaining));
  assert.equal(root.querySelectorAll('.dc-usage__details')[0].children.some(child => child.textContent === usageWidgetLabels('zh-CN').remaining), false);
  assert.equal(reads, 1, 'language changes redraw without another quota request');
  input = { ...input, revision: 1 }; view.update(input);
  assert.equal(reads, 2, 'every provider response refreshes usage without a manual action');
  await Promise.resolve();
  pointer(new Element());
  assert.deepEqual(changes, [false]);
  assert.equal(root.querySelectorAll('.dc-usage__details').length, 0);
  assert.equal(root.querySelectorAll('.dc-usage__summary').length, 1, 'outside click restores the summary card');
  pointer(new Element());
  assert.deepEqual(changes, [false], 'collapsed details do not emit repeated updates');
  root.querySelectorAll('.dc-usage__body')[0].onclick();
  assert.equal(reads, 3, 'reopening the details fetches current usage');
  assert.equal(root.querySelectorAll('.dc-usage__details').length, 1, 'the card can be reopened');
  root.oncontextmenu({ preventDefault() {} });
  assert.equal(root.querySelectorAll('.dc-usage__menu').length, 1);
  pointer(new Element());
  assert.equal(root.querySelectorAll('.dc-usage__menu').length, 0);
  assert.equal(root.querySelectorAll('.dc-usage__details').length, 0, 'closing an outside menu does not expose stale expanded details');
  root.querySelectorAll('.dc-usage__body')[0].onclick();
  listeners.get('keydown').listener({ key: 'Escape' });
  assert.equal(root.querySelectorAll('.dc-usage__details').length, 0);

  const visibilityChanges = [];
  actions.setUsageVisibility = visibility => {
    visibilityChanges.push(visibility); input = { ...input, visibility }; view.update(input);
  };
  input = { ...input, visibility: 'collapsed' }; view.update(input);
  let handle = root.querySelectorAll('.dc-usage__handle')[0];
  const before = root.getBoundingClientRect();
  const down = (x, y) => root.listeners.get('pointerdown')({ target: handle, button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y });
  down(before.left + 9, before.top + 14);
  listeners.get('pointermove').listener({ pointerId: 1, clientX: before.left - 591, clientY: before.top - 86, preventDefault() {} });
  assert.equal(parseFloat(root.style.left), before.left - 600, 'collapsed handle follows the pointer before release');
  listeners.get('pointerup').listener({ pointerId: 1 });
  assert.equal(parseFloat(root.style.left), 0, 'release near the left edge docks left');
  assert.equal(parseFloat(root.style.top), before.top - 100, 'collapsed handle moves vertically');
  assert.equal(handle.textContent, '›', 'left-docked handle points into the panel');
  assert.equal(root.captures.size, 0, 'ending a drag releases pointer capture');
  let blocked = false;
  root.listeners.get('click')({ detail: 1, preventDefault() { blocked = true; }, stopPropagation() {} });
  if (!blocked) handle.onclick();
  assert.equal(blocked, true, 'drag completion must not expand the handle');
  assert.deepEqual(visibilityChanges, []);

  const moved = root.getBoundingClientRect();
  down(moved.left + 9, moved.top + 14);
  blocked = false;
  root.listeners.get('click')({ detail: 1, preventDefault() { blocked = true; }, stopPropagation() {} });
  if (!blocked) handle.onclick();
  assert.deepEqual(visibilityChanges, ['summary'], 'a subsequent ordinary click still expands');
  assert.equal(parseFloat(root.style.left), 8, 'left-docked form expands inside the panel');
  input = { ...input, visibility: 'collapsed' }; view.update(input);
  handle = root.querySelectorAll('.dc-usage__handle')[0];
  assert.equal(parseFloat(root.style.left), 0, 'collapsing keeps the chosen edge');
  root.listeners.get('keydown')({ target: handle, key: 'ArrowRight', preventDefault() {} });
  assert.equal(parseFloat(root.style.left), 782, 'keyboard movement can select the right edge');
  root.listeners.get('keydown')({ target: handle, key: 'ArrowUp', preventDefault() {} });
  assert.equal(parseFloat(root.style.top), moved.top - 10, 'keyboard vertical movement keeps the edge');
  const right = root.getBoundingClientRect();
  down(right.left + 9, right.top + 14);
  listeners.get('pointermove').listener({ pointerId: 1, clientX: right.left - 191, clientY: right.top + 54, preventDefault() {} });
  listeners.get('pointerup').listener({ pointerId: 1 });
  assert.equal(parseFloat(root.style.left), 782, 'release near the right edge docks right');
  assert.equal(parseFloat(root.style.top), right.top + 40, 'docking preserves the chosen height');
  assert.equal(handle.textContent, '‹', 'right-docked handle points into the panel');
  down(0, 0);
  listeners.get('pointermove').listener({ pointerId: 1, clientX: -2000, clientY: -2000, preventDefault() {} });
  listeners.get('pointercancel').listener({ pointerId: 1 });
  assert.equal(parseFloat(root.style.left), 0);
  assert.equal(parseFloat(root.style.top), 8, 'movement stays inside the existing boundary');
  assert.equal(root.captures.size, 0, 'cancelling a drag releases pointer capture');
  dispose();
  assert.equal(listeners.size, 0, 'capture listeners and existing drag listeners are all removed');
  assert.equal(container.children.length, 0);
});

test('usage updates preserve controls, coalesce in-flight reads, and keep the last confirmed snapshot', async t => {
  const { container, usageWidgetLabels, mount } = await createUsageWidgetHarness(t);
  const requests = [];
  let input = { visibility: 'summary', expanded: false, locale: 'en-US', revision: 0, modelId: 'test',
    labels: usageWidgetLabels('en-US'), costDisplay: { currency: 'USD', usdRate: 1 },
    connection: { id: 'connection:usage', name: 'Usage', billingMode: 'metered' } };
  const view = mount(input, { signal: new AbortController().signal,
    usage: { query: (_query, signal) => new Promise(resolve => requests.push({ resolve, signal })) },
    actions: { setExpanded(expanded) { input = { ...input, expanded }; view.update(input); } },
  });
  const result = value => ({ totals: { estimatedCost: value, calls: 1, pricedCalls: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
    coverageFrom: 0, query: { from: 0 }, buckets: [] });
  requests[0].resolve(result(1)); await Promise.resolve();
  const root = container.children[0], body = root.querySelectorAll('.dc-usage__body')[0];
  const contents = element => [element.textContent ?? '', ...element.children.map(contents)].join(' ');
  root.listeners.get('pointerdown')({ target: body, button: 0, isPrimary: true, pointerId: 1, clientX: 610, clientY: 520 });
  view.update({ ...input });
  assert.equal(root.querySelectorAll('.dc-usage__body')[0], body, 'unrelated stream renders cannot detach the click target');
  input = { ...input, revision: 1 }; view.update(input);
  input = { ...input, revision: 2 }; view.update(input);
  assert.equal(root.querySelectorAll('.dc-usage__body')[0], body, 'starting a usage read also preserves the button');
  body.onclick();
  assert.equal(input.expanded, true);
  assert.equal(requests.length, 2, 'opening and repeated responses share the in-flight read');
  assert.equal(requests[1].signal.aborted, false);
  assert.ok(contents(root).includes('$1.00'), 'the last confirmed amount remains visible during the read');
  const detail = root.querySelectorAll('.dc-usage__details')[0];
  detail.scrollTop = 17;
  requests[1].resolve(result(2)); await Promise.resolve();
  assert.equal(requests.length, 3, 'one follow-up read covers the newest response revision');
  assert.equal(root.querySelectorAll('.dc-usage__details')[0], detail);
  assert.equal(detail.scrollTop, 17);
  requests[2].resolve(result(3)); await Promise.resolve();
  assert.ok(contents(root).includes('$3.00'));
  assert.equal(root.querySelectorAll('.dc-usage__body')[0], body);
  body.onclick(); assert.equal(input.expanded, false, 'the same button remains interactive after completion');
});

test('usage widget remembers a moved position across remounts without saving temporary layout constraints', async t => {
  const saved = new Map();
  const { container, usageWidgetLabels, mount, dispose } = await createUsageWidgetHarness(t, saved);
  const input = { visibility: 'summary', expanded: false, locale: 'en-US', revision: 0, modelId: 'codex',
    labels: usageWidgetLabels('en-US'), costDisplay: { currency: 'USD', usdRate: 1 },
    connection: { id: 'connection:quota', name: 'Codex', billingMode: 'subscription' } };
  const scope = { signal: new AbortController().signal, quota: { async read() { return { windows: [] }; } }, actions: {} };
  const view = mount(input, scope); await Promise.resolve();
  const root = container.children[0];
  root.listeners.get('keydown')({ target: root.querySelectorAll('.dc-usage__body')[0], key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
  const moved = root.getBoundingClientRect();
  assert.equal(saved.size, 1);
  const stored = [...saved.values()][0];
  container.clientWidth = 360;
  view.update({ ...input, visibility: 'collapsed' });
  assert.equal([...saved.values()][0], stored);
  dispose(); container.clientWidth = 800;
  const restored = mount(input, scope); await Promise.resolve();
  assert.equal(container.children[0].getBoundingClientRect().left, moved.left);
  assert.equal(container.children[0].getBoundingClientRect().top, moved.top);
  restored.dispose();
});

test('output overview remains compact while the sidebar page shows all deliveries', async t => {
  const { ConversationOutputs } = await loadGuiModule(t, '/src/deepcode-gui/layout/DeepCodeTaskPanel.tsx');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const artifacts = Array.from({ length: 5 }, (_, index) => ({ artifactId: `artifact:${index}`, sessionId: 'session:outputs',
    label: `Report ${index + 1}`, contentType: 'text/plain', contentMode: 'live', workspaceId: 'workspace:outputs', logicalPath: `report-${index + 1}.md` }));
  const before = structuredClone(artifacts);
  const props = { artifacts, language: 'en-US', onExpandedChange() {}, onOpen: async () => {} };
  const overview = renderToStaticMarkup(React.createElement(ConversationOutputs, { ...props, expanded: false }));
  const page = renderToStaticMarkup(React.createElement(ConversationOutputs, { ...props, expanded: true }));
  assert.equal((overview.match(/document-artifacts__item/g) ?? []).length, 3);
  assert.match(overview, /View all|Show all/);
  assert.doesNotMatch(overview, /Report 4/);
  assert.equal((page.match(/document-artifacts__item/g) ?? []).length, 5);
  assert.match(page, /Back to overview/);
  assert.match(page, /deepcode-gui-output-page/);
  assert.doesNotMatch(page, /deepcode-gui-output-more/);
  assert.deepEqual(artifacts, before);
});

test('usage widget restores the summary position after temporary Reader docking', async (t) => {
  const { container, usageWidgetLabels, mount, dispose } = await createUsageWidgetHarness(t);
  let input = { visibility: 'summary', expanded: false, locale: 'en-US', revision: 0, modelId: 'codex',
    labels: usageWidgetLabels('en-US'), costDisplay: { currency: 'USD', usdRate: 1 },
    connection: { id: 'connection:quota', name: 'Codex', billingMode: 'subscription' } };
  const view = mount(input, { signal: new AbortController().signal,
    quota: { async read() { return { windows: [] }; } }, actions: {},
  });
  await Promise.resolve();
  const root = container.children[0];
  const original = root.getBoundingClientRect();
  const toggleReader = () => {
    input = { ...input, visibility: 'collapsed' }; view.update(input);
    container.clientWidth = 360; view.update(input);
    assert.equal(parseFloat(root.style.left), 342, 'the handle docks at the narrower conversation edge');
    // Visibility and ResizeObserver layout notifications can arrive separately.
    input = { ...input, visibility: 'summary' }; view.update(input);
    container.clientWidth = 800; view.update(input);
  };
  toggleReader();
  assert.equal(parseFloat(root.style.left), original.left, 'default summary returns to the right edge');
  assert.equal(parseFloat(root.style.top), original.top, 'temporary docking preserves its height');

  root.listeners.get('keydown')({ target: root.querySelectorAll('.dc-usage__body')[0],
    key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
  const moved = root.getBoundingClientRect();
  assert.equal(moved.left, original.left - 40);
  toggleReader();
  assert.equal(parseFloat(root.style.left), moved.left, 'layout constraints do not overwrite a user-chosen position');
  assert.equal(parseFloat(root.style.top), moved.top);
  dispose();
});

test('usage widget mounted with Reader open expands at the full boundary right edge', async (t) => {
  const { container, usageWidgetLabels, mount, dispose } = await createUsageWidgetHarness(t);
  container.clientWidth = 360;
  const input = { visibility: 'collapsed', expanded: false, locale: 'en-US', revision: 0, modelId: 'codex',
    labels: usageWidgetLabels('en-US'), costDisplay: { currency: 'USD', usdRate: 1 },
    connection: { id: 'connection:quota', name: 'Codex', billingMode: 'subscription' } };
  const view = mount(input, { signal: new AbortController().signal,
    quota: { async read() { return { windows: [] }; } }, actions: {},
  });
  await Promise.resolve();
  assert.equal(parseFloat(container.children[0].style.left), 342);
  container.clientWidth = 800;
  view.update({ ...input, visibility: 'summary' });
  assert.equal(parseFloat(container.children[0].style.left), 584, 'initial compact geometry is not a saved summary position');
  dispose();
});

for (const billingMode of ['subscription', 'metered']) {
  test(`usage widget preserves ${billingMode} read failures until a reopened request succeeds`, async (t) => {
    const { container, usageWidgetLabels, mount, dispose, listeners } = await createUsageWidgetHarness(t);
    const requests = [];
    const read = signal => new Promise((resolve, reject) => requests.push({ resolve, reject, signal }));
    let input = { visibility: 'summary', expanded: true, locale: 'en-US', revision: 0, modelId: 'test-model',
      labels: usageWidgetLabels('en-US'), costDisplay: { currency: 'USD', usdRate: 1 },
      connection: { id: 'connection:usage', name: 'Usage', billingMode } };
    const view = mount(input, { signal: new AbortController().signal, actions: {},
      quota: { read }, usage: { query: (_query, signal) => read(signal) } });
    const root = container.children[0];
    const text = element => [element.textContent ?? '', ...element.children.map(text)].join(' ');
    const update = patch => { input = { ...input, ...patch }; view.update(input); };
    const response = value => billingMode === 'subscription'
      ? { windows: [{ label: 'Quota', usedPercent: 100 - value, windowDurationSeconds: 300 }] }
      : { totals: { estimatedCost: value / 100, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, calls: 1, pricedCalls: 1 },
          coverageFrom: 0, query: { from: 0 }, buckets: [] };
    const oldValue = billingMode === 'subscription' ? '79%' : '$0.79';
    const newValue = billingMode === 'subscription' ? '42%' : '$0.42';

    requests[0].resolve(response(79));
    await Promise.resolve();
    assert.ok(text(root).includes(oldValue));
    update({ expanded: false });
    update({ expanded: true });
    assert.equal(requests.length, 2);
    requests[1].reject(new Error('original_usage_read_failure'));
    await Promise.resolve();
    assert.equal(root.querySelectorAll('.dc-usage__error')[0]?.textContent, 'original_usage_read_failure');
    assert.equal(text(root).includes(oldValue), false);

    update({ expanded: false });
    update({ expanded: true });
    assert.equal(requests.length, 3);
    assert.equal(root.querySelectorAll('.dc-usage__error')[0]?.textContent, 'original_usage_read_failure',
      'reopening must not erase the failure while the new request is pending');
    assert.equal(text(root).includes(oldValue), false, 'a pending request cannot reinstate the old successful value');
    if (billingMode === 'metered') assert.ok(text(root).includes(input.labels.unavailable));
    requests[2].resolve(response(42));
    await Promise.resolve();
    assert.equal(root.querySelectorAll('.dc-usage__error').length, 0, 'only a successful result clears the failure');
    assert.ok(text(root).includes(newValue));

    update({ expanded: false });
    update({ expanded: true });
    assert.equal(text(root).includes(newValue), true, 'same-query background refresh keeps the last confirmed value until a result arrives');
    requests[3].reject(new Error('previous_connection_failure'));
    await Promise.resolve();
    update({ connection: { ...input.connection, id: 'connection:other' } });
    assert.equal(root.querySelectorAll('.dc-usage__error').length, 0, 'a different query must not inherit the previous connection failure');
    assert.equal(text(root).includes(newValue), false);
    dispose();
    assert.equal(requests.at(-1).signal.aborted, true);
    assert.equal(listeners.size, 0);
    assert.equal(container.children.length, 0);
  });
}

test('settings contributions compose while tool renderers match their declared operation', async (t) => {
  const { UiPluginRuntime } = await loadGuiModule(t, '/src/ui-plugins/runtime.ts');
  const runtime = new UiPluginRuntime(async source => ({ apply(ctx) {
    ctx.register(source, () => ({ update() {}, dispose() {} }));
  } }), () => () => {});
  t.after(() => runtime.dispose());
  const file = (id, slot, toolId) => ({ path: `/plugins/${id}`, enabled: true,
    manifest: { id, name:id, entry:'index.js', slots:[slot], ...(toolId ? {toolId} : {}) }, source:slot, error:null });
  await runtime.replace([file('cost','settings.usage.panel'), file('counts','settings.usage.panel'),
    file('reader','tool.result','fs.read'), file('shell','tool.result','bash')]);
  assert.equal(runtime.getSnapshot().length, 4);
  assert.ok(runtime.getSnapshot().every(item => item.status === 'active'));
});

test('image attachments reach the Provider as bound visual inputs without embedding bytes in the journal', async (t) => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:image-input';
  await createSession(journal, sessionId, [workspaceBinding]);
  let request;
  const actor = actorWith(journal, sessionId, { async *stream(value) {
    request = value;
    yield providerEvent(value.requestId, 'text.delta', {text:'Image received.'});
    yield providerEvent(value.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'image-input');
  t.after(() => actor.dispose());
  const command = messageCommand(sessionId, 'command:image', 'Describe the attached picture.');
  command.filesystemReferences = [{ referenceId:'reference:image', workspaceId:workspaceBinding.workspaceId,
    logicalPath:'picture.png',displayName:'picture.png',kind:'file',mediaType:'image/png',byteLength:100 }];
  await actor.submit(command);
  const projection = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.equal(request.messages.find(item => item.role === 'user').images, undefined);
  assert.match(request.messages.find(item => item.role === 'user').content, /reference:image/);
  assert.deepEqual(request.messages.at(-1).images,
    [{workspaceId:workspaceBinding.workspaceId,logicalPath:'picture.png',mediaType:'image/png'}]);
  assert.match(request.messages.at(-1).content, /Current visual inputs/);
  assert.deepEqual(projection.messages[0].filesystemReferences, command.filesystemReferences);
});


test('reader identities separate current files, roots and each recorded diff', async (t) => {
  const { readerTargetKey } = await loadGuiModule(t, '/src/components/local-agent/readerState.ts');
  const current = { kind: 'workspace', workspaceId: 'workspace:project', logicalPath: 'same.cpp' };
  assert.equal(readerTargetKey(current), readerTargetKey({kind: 'resource', resource: {workspaceId: current.workspaceId, logicalPath: current.logicalPath}, name: 'same.cpp'}));
  const round = (recordId) => ({ kind: 'diff', file: { path: 'same.cpp', changes: [{ recordId, index: 0 }] } });
  assert.notEqual(readerTargetKey(current), readerTargetKey({ ...current, workspaceId: 'workspace:session' }));
  assert.notEqual(readerTargetKey(current), readerTargetKey(round('record:one')));
  assert.notEqual(readerTargetKey(round('record:one')), readerTargetKey(round('record:two')));
  assert.equal(readerTargetKey(round('record:one')), readerTargetKey(round('record:one')));
  const child = { ...current, sourceSessionId: 'session:child' };
  assert.notEqual(readerTargetKey(current), readerTargetKey(child), 'session work directories may use the same logical path');
  assert.equal(readerTargetKey(child), readerTargetKey({kind: 'resource', sourceSessionId: 'session:child',
    resource: {workspaceId: current.workspaceId, logicalPath: current.logicalPath}, name: 'same.cpp'}));
  assert.notEqual(readerTargetKey(child), readerTargetKey({ ...child, sourceSessionId: 'session:other-child' }));
});

test('GUI accepts child capability presets and places navigation only beside their history activities', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ AgentTasksPanel }, { AgentGroupSummary }] = await loadGuiModules(t, ['/src/components/local-agent/AgentTasksPanel.tsx', '/src/components/local-agent/agentNavigation.tsx']);
  const projection = projectSession(emptySessionState('session:parent'));
  projection.agentChildren = [
    { agentSessionId: 'session:one-shot', displayName: 'One-shot review', closed: true,
      capabilities: { messaging: 'parent', continuation: false, delegation: false } },
    { agentSessionId: 'session:continuing', displayName: 'Continuing work', closed: false,
      capabilities: { messaging: true, continuation: true, delegation: true } },
    { agentSessionId: 'session:custom', displayName: 'Custom scope', closed: false,
      capabilities: { messaging: false, continuation: true, delegation: false } },
  ];
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  assert.equal(renderToStaticMarkup(createElement(AgentTasksPanel, { projection, language: 'en-US' })), '');
  const activities = projection.agentChildren.map((child, index) => ({
    activityId: `agent:task:${index}:completed`, kind: 'agent', runId: 'run:one', sequence: index,
    label: child.displayName, status: 'completed', agent: { taskId: `task:${index}`, agentSessionId: child.agentSessionId, phase: 'completed' },
  }));
  const html = renderToStaticMarkup(createElement(AgentGroupSummary, { activities: activities.slice(0, 2), language: 'en-US' }));
  for (const child of projection.agentChildren.slice(0, 2)) assert.ok(html.includes(child.displayName));
  assert.ok(!html.includes('Custom scope'), 'Other turns must not follow the current activity group');
  for (const mutate of [
    p => { delete p.agentChildren[0].capabilities; },
    p => { p.agentChildren[1].capabilities.messaging = 'yes'; },
    p => { p.agentChildren[2].capabilities.unknown = true; },
  ]) {
    const malformed = structuredClone(projection); mutate(malformed);
    await assert.rejects(decodeGuiProjection(malformed), /conversation_projection_invalid/);
  }
});

test('GUI reads the shared child instance configuration without dropping model or Loop facts', async () => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const state = emptySessionState('session:configured-child');
  state.agentContext = {
    capabilities: { messaging: 'parent', continuation: true, delegation: false },
    ownerSessionId: 'session:owner', parentSessionId: 'session:owner', parentRunId: 'run:owner', parentCallId: 'call:spawn',
    configuration: { context: { id: 'journal' }, compaction: { id: 'summary', parameters: { pressureRatio: 0.8 } },
      controls: { id: 'standard', parameters: { optionalTools: [] } } },
    model: { profileId: 'profile:configured', model: 'configured-model', reasoningEffort: 'low', thinking: 'enabled',
      parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 128000,
        maxOutputTokens: 4096, imageInput: true, temperature: null, hostedWebSearch: null } },
  };
  const projection = projectSession(state);
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const missingParameter = structuredClone(projection);
  delete missingParameter.agentContext.model.parameters.adapterId;
  await assert.rejects(decodeGuiProjection(missingParameter), /conversation_projection_invalid/);
  const unknownField = structuredClone(projection);
  unknownField.agentContext.unknown = true;
  await assert.rejects(decodeGuiProjection(unknownField), /conversation_projection_invalid/);
});

test('child file changes render with the scoped Session even when no main Session is selected', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ FileChanges }, { ConversationSessionScope }] = await loadGuiModules(t, [
    '/src/components/local-agent/FileChanges.tsx', '/src/components/local-agent/ConversationSessionScope.tsx',
  ]);
  const activities = [{ tool: { recordId: 'record:child-write', fileChanges: [{ workspaceId: 'workspace:session',
    path: 'child-work.txt', kind: 'create', before: { exists: false }, after: { exists: true, sizeBytes: 3 } }] } }];
  assert.equal(renderToStaticMarkup(createElement(FileChanges, { activities })), '');
  const html = renderToStaticMarkup(createElement(ConversationSessionScope.Provider, { value: 'session:child' },
    createElement(FileChanges, { activities })));
  assert.match(html, /child-work\.txt/);
  assert.match(html, /conversation-change-file/);
});

test('child decisions use lightweight references without mounting collapsed history', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ AgentTasksPanel }, { AgentNavigationScope, AgentGroupSummary }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentTasksPanel.tsx', '/src/components/local-agent/agentNavigation.tsx',
  ]);
  const projection = projectSession(emptySessionState('session:root'));
  projection.pendingAgentDecisions = [{ agentSessionId: 'session:grandchild', displayName: 'Writer', runId: 'run:child',
    plan: { planId: 'plan:child', revision: 2 }, interactionIds: [], approval: { approvalId: 'approval:child', callId: 'call:child' } }];
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const task = { taskId: 'task:child', agentSessionId: 'session:grandchild', displayName: 'Writer', childRunId: 'run:child', status: 'running' };
  const activity = { activityId: 'activity:child', kind: 'agent', label: 'Writer', status: 'active',
    agent: { taskId: task.taskId, agentSessionId: task.agentSessionId, phase: 'started' } };
  const html = renderToStaticMarkup(createElement(AgentNavigationScope, { tasks: [task], pendingDecisions: projection.pendingAgentDecisions },
    createElement(AgentGroupSummary, { activities: [activity], language: 'en-US' }), createElement(AgentTasksPanel, { projection, language: 'en-US' })));
  assert.match(html, /Writer/);
  assert.match(html, /Needs your input/);
  assert.doesNotMatch(html, /Loading conversation|agent-tasks__drawer|<article/);
  const malformed = structuredClone(projection);
  malformed.pendingAgentDecisions[0].plan.revision = 0;
  await assert.rejects(decodeGuiProjection(malformed), /conversation_projection_invalid/);
  delete malformed.pendingAgentDecisions[0].plan;
  delete malformed.pendingAgentDecisions[0].approval;
  await assert.rejects(decodeGuiProjection(malformed), /conversation_projection_invalid/, 'an empty decision reference is not a pending question');
});

test('child entries stay beside ordinary tool folds with one shared status and no extra agent fold', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup }, { AgentNavigationScope }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/agentNavigation.tsx',
    '/src/components/local-agent/ConversationVirtualRow.tsx',
  ]);
  const tasks = [
    { taskId: 'task:a1', agentSessionId: 'session:a', displayName: 'Frontend', parentRunId: 'run:one', status: 'completed' },
    { taskId: 'task:a2', agentSessionId: 'session:a', displayName: 'Frontend', parentRunId: 'run:one', status: 'completed' },
    { taskId: 'task:b', agentSessionId: 'session:b', displayName: 'Tests', parentRunId: 'run:two', status: 'completed' },
  ];
  const agent = { activityId: 'activity:agent', kind: 'agent', label: 'Frontend', status: 'completed',
    agent: { taskId: 'task:a2', agentSessionId: 'session:a', phase: 'completed' } };
  const read = { activityId: 'activity:read', kind: 'tool', label: 'fs.read', status: 'completed', tool: { operation: 'fs.read', resources: [] } };
  const layout = { state: new Map() };
  const renderGroup = activities => renderToStaticMarkup(createElement(AgentNavigationScope, { tasks },
    createElement(ConversationVirtualRow, { rowKey: 'test', eager: true, virtualizer: { layout: () => layout },
      children: () => createElement(ToolActivityGroup, { activities, language: 'zh-CN', onExpand() {}, onOpenWorkspaceResource() {} }) })));
  const onlyAgent = renderGroup([agent]);
  assert.match(onlyAgent, /Frontend/);
  assert.doesNotMatch(onlyAgent, /已调用子代理|aria-expanded|local-agent__tool-group-summary/);
  const mixed = renderGroup([read, agent]);
  assert.match(mixed, /已读取文件/);
  assert.match(mixed, /Frontend/);
  layout.state.set('tool-group:expanded', true);
  const expanded = renderGroup([read, agent]);
  assert.equal(expanded.match(/>Frontend</g)?.length, 1, 'expanding tool calls does not repeat a child control');
  const secondAgent = { ...agent, activityId: 'activity:second', label: 'Tests',
    agent: { taskId: 'task:b', agentSessionId: 'session:b', phase: 'completed' } };
  const twoMembers = renderGroup([agent, secondAgent]);
  assert.equal(twoMembers.match(/>已完成</g)?.length, 1, 'members in the same state share one compact status label');
  assert.equal(twoMembers.match(/aria-pressed="false"/g)?.length, 2, 'each member retains its own clickable history entry');
});

test('member updates stay at their arrival position and remain distinct from completed tasks', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ projectionItems }, { AgentNavigationScope, AgentGroupSummary }] = await loadGuiModules(t, [
    '/src/components/local-agent/conversationItems.ts', '/src/components/local-agent/agentNavigation.tsx',
  ]);
  const projection = projectSession(emptySessionState('session:parent'));
  projection.revision = 3;
  const update = { activityId: 'activity:update', kind: 'agent', label: 'Frontend', status: 'completed', runId: 'run:one', sequence: 2,
    agent: { agentSessionId: 'session:frontend', phase: 'updated' } };
  const finished = { ...update, activityId: 'activity:finished', sequence: 3, agent: { ...update.agent, phase: 'completed', taskId: 'task:frontend' } };
  const read = { activityId: 'activity:read', kind: 'tool', label: 'fs.read', status: 'completed', runId: 'run:one', sequence: 1,
    tool: { operation: 'fs.read', resources: [] } };
  projection.activities = [read, update, finished];
  projection.timeline = projection.activities.map(activity => ({ kind: 'toolGroup', timelineId: activity.activityId,
    sequence: activity.sequence, activityIds: [activity.activityId],
    ...(activity.kind === 'tool' ? { providerRequestId: 'provider-request:read' } : {}) }));
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const before = structuredClone(projection);
  const rows = projectionItems(projection);
  assert.deepEqual(rows.map(row => row.values.map(value => value.activityId)), [['activity:read'], ['activity:update'], ['activity:finished']]);
  const html = renderToStaticMarkup(createElement(AgentNavigationScope, { tasks: [{ taskId: 'task:frontend', status: 'completed' }] },
    createElement(AgentGroupSummary, { activities: [update, finished], language: 'zh-CN' })));
  assert.match(html, /已更新/); assert.match(html, /已完成/);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
  assert.deepEqual(projection, before);
});

test('a reused child keeps historical task outcomes while only the matching live task needs input', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentNavigationScope, AgentGroupSummary } = await loadGuiModule(t, '/src/components/local-agent/agentNavigation.tsx');
  const tasks = [
    { taskId: 'task:old', agentSessionId: 'session:reused', childRunId: 'run:old', status: 'completed' },
    { taskId: 'task:current', agentSessionId: 'session:reused', childRunId: 'run:current', status: 'running' },
  ];
  const decision = { agentSessionId: 'session:reused', displayName: 'North', runId: 'run:current',
    plan: { planId: 'plan:current', revision: 1 }, interactionIds: [] };
  const render = task => renderToStaticMarkup(createElement(AgentNavigationScope, { tasks, pendingDecisions: [decision] },
    createElement(AgentGroupSummary, { language: 'en-US', activities: [{ activityId: `activity:${task.taskId}`, kind: 'agent',
      label: 'North', status: task.status === 'running' ? 'active' : task.status,
      agent: { taskId: task.taskId, agentSessionId: task.agentSessionId, phase: 'started' } }] })));
  assert.match(render(tasks[0]), />Completed</);
  assert.doesNotMatch(render(tasks[0]), /Needs your input/);
  assert.match(render(tasks[1]), />Needs your input</);
  const contiguous = renderToStaticMarkup(createElement(AgentNavigationScope, { tasks, pendingDecisions: [decision] },
    createElement(AgentGroupSummary, { language: 'en-US', activities: tasks.map(task => ({
      activityId: `activity:${task.taskId}`, kind: 'agent', label: 'North',
      status: task.status === 'running' ? 'active' : task.status,
      agent: { taskId: task.taskId, agentSessionId: task.agentSessionId, phase: 'started' },
    })) })));
  assert.equal(contiguous.match(/aria-pressed="false"/g)?.length, 2, 'contiguous tasks on one Session keep separate history entries');
  assert.match(contiguous, />Completed</);
  assert.match(contiguous, />Needs your input</);
  tasks[1].childRunId = 'run:other';
  assert.doesNotMatch(render(tasks[1]), /Needs your input/, 'Session identity alone does not match a current decision');
});

test('the side overview counts latest members without history reads or a panel for an empty Session', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentOverview, agentOverviewMembers } = await loadGuiModule(t, '/src/components/local-agent/AgentOverview.tsx');
  const projection = projectSession(emptySessionState('session:overview'));
  assert.equal(renderToStaticMarkup(createElement(AgentOverview, { projection, language: 'en-US' })), '');
  projection.agentTasks = [
    { taskId: 'task:old', agentSessionId: 'session:a', displayName: 'North', status: 'completed' },
    { taskId: 'task:b', agentSessionId: 'session:b', displayName: 'South', status: 'completed' },
    { taskId: 'task:latest', agentSessionId: 'session:a', displayName: 'North', childRunId: 'run:current', status: 'running' },
  ];
  projection.pendingAgentDecisions = [{ agentSessionId: 'session:a', displayName: 'North', runId: 'run:current',
    plan: { planId: 'plan:current', revision: 1 }, interactionIds: [] }];
  const before = structuredClone(projection);
  assert.deepEqual(agentOverviewMembers(projection).map(member => [member.name, member.status]), [['North', 'needsInput'], ['South', 'completed']]);
  const html = renderToStaticMarkup(createElement(AgentOverview, { projection, language: 'en-US' }));
  assert.match(html, /1 Needs your input/);
  assert.match(html, /1 Completed/);
  assert.match(html, /aria-label="View all subagents"/);
  assert.doesNotMatch(html, /<article|Loading conversation/);
  assert.deepEqual(projection, before);
});

test('child decision positioning follows the current decision identity, not every projection update', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const { agentDecisionKey } = await loadGuiModule(t, '/src/components/local-agent/AgentTasksPanel.tsx');
  const projection = projectSession(emptySessionState('session:decision'));
  assert.equal(agentDecisionKey(projection), null);
  projection.pendingPlan = { planId: 'plan:review', revision: 1 };
  const key = agentDecisionKey(projection);
  assert.ok(key);
  projection.revision += 10;
  assert.equal(agentDecisionKey(projection), key, 'ordinary polling must not scroll the reader again');
  projection.pendingPlan.revision = 2;
  assert.notEqual(agentDecisionKey(projection), key);
  projection.pendingPlan = null;
  projection.pendingApproval = { approvalId: 'approval:review', preview: { approvalReviewer: 'agent' } };
  projection.run = { status: 'running' };
  assert.equal(agentDecisionKey(projection), null, 'automatic review does not request a human reply');
  projection.run.status = 'waiting';
  assert.ok(agentDecisionKey(projection));
});

test('a parent accepts changed child decision references at the same journal revision', async t => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const base = projectSession(emptySessionState('session:parent-pending'));
  const decision = { agentSessionId: 'session:child', displayName: 'Writer', runId: 'run:child',
    plan: { planId: 'plan:child', revision: 1 }, interactionIds: [] };
  let incoming = { ...base, pendingAgentDecisions: [decision] };
  installGuiFetch(t, (url) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [] });
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(base.sessionId)}/projection`, 'no child history is needed to show a pending entry');
    return Response.json({ ok: true, data: incoming });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId: base.sessionId, projection: base });
  await store.getState().refresh();
  assert.deepEqual(store.getState().projection.pendingAgentDecisions, [decision]);
  incoming = base;
  await store.getState().refresh();
  assert.equal(store.getState().projection.pendingAgentDecisions, undefined, 'a replied decision disappears without fabricating a parent event');
  assert.equal(store.getState().projection.revision, base.revision);
});

test('child conversation details mount their canonical messages only when expanded', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentConversationHistory } = await loadGuiModule(t, '/src/components/local-agent/AgentTasksPanel.tsx');
  const base = { name: 'Writer', language: 'en-US', onExpandedChange() {} };
  const closed = renderToStaticMarkup(createElement(AgentConversationHistory, { ...base, expanded: false,
    projection: { get timeline() { throw new Error('closed history must not be traversed'); },
      get assistantDraft() { throw new Error('closed draft must not be traversed'); } } }));
  assert.equal(closed, '');
  assert.equal(closed.includes('<article'), false);
  const projection = { messages: [
    { messageId: 'second', role: 'assistant', content: 'Second answer' },
    { messageId: 'first', role: 'user', content: 'First request' },
  ], narratives: [], timeline: [
    { kind: 'message', timelineId: 'timeline:1', messageId: 'first' },
    { kind: 'message', timelineId: 'timeline:2', messageId: 'second' },
  ], assistantDraft: { blocks: [{ kind: 'text', streamId: 'draft:1', content: 'Live continuation' }] } };
  Object.assign(projection, { narratives: [], plans: [], activities: [], interactions: [], sessionId: 'session:child' });
  const before = structuredClone(projection);
  const expanded = renderToStaticMarkup(createElement(AgentConversationHistory, { ...base, projection, expanded: true }));
  assert.ok(expanded.indexOf('First request') < expanded.indexOf('Second answer'));
  assert.match(expanded, /Live continuation/);
  assert.deepEqual(projection, before, 'presentation must not rewrite the Session projection');
});

test('historical file change content waits for its virtual row to become visible', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ConversationVirtualRow }, { FileChanges }, { ConversationSessionScope }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationVirtualRow.tsx', '/src/components/local-agent/FileChanges.tsx',
    '/src/components/local-agent/ConversationSessionScope.tsx',
  ]);
  const activities = [{ tool: { recordId: 'record:history', fileChanges: [{ workspaceId: 'workspace:session',
    path: 'history.txt', kind: 'create', before: { exists: false }, after: { exists: true, sizeBytes: 5 } }] } }];
  let mounts = 0;
  const render = eager => renderToStaticMarkup(createElement(ConversationSessionScope.Provider, { value: 'session:history' },
    createElement(ConversationVirtualRow, { rowKey: 'run:history:file-changes', eager,
      virtualizer: { layout: () => ({ height: 80, state: new Map() }) }, children: () => {
        mounts++; return createElement(FileChanges, { activities });
      } })));
  const offscreen = render(false);
  assert.equal(mounts, 0);
  assert.match(offscreen, /data-conversation-anchor="run:history:file-changes"/);
  assert.equal(offscreen.includes('history.txt'), false);
  const visible = render(true);
  assert.equal(mounts, 1);
  assert.match(visible, /history\.txt/);
});

test('resource notifications use explicit references and preserve stream failures', async (t) => {
  const { watchResources } = await loadGuiModule(t, '/src/services/conversationResources.ts');
  const reference = { fileGrant: { authorityId: 'grant:selected', access: 'read', index: 0 }, logicalPath: '' };
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/conversation/sessions/session%3Afiles/resources/watch');
    assert.deepEqual(JSON.parse(init.body), { resources: [reference] });
    return new Response('event: ready\ndata: {}\n\nevent: change\ndata: {"indices":[0]}\n\nevent: error\ndata: {"message":"watch failed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const changes = [];
  await assert.rejects(watchResources('session:files', [reference], new AbortController().signal, indices => changes.push(indices)), /watch failed/);
  assert.deepEqual(changes, [[0], [0]]);
});

test('GUI hosted search projections preserve omitted action and reject invalid action values', async () => {
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const projection = projectSession(emptySessionState('session:hosted-action'));
  const hosted = { providerCallId: 'ws_omitted', providerToolType: 'web_search' };
  projection.assistantDraft = { runId: 'run:search', turnId: 'turn:search', blocks: [
    { outputIndex: 0, kind: 'providerHosted', ...hosted, status: 'completed' },
  ] };
  projection.activities = [{ activityId: 'activity:search', kind: 'providerHosted', status: 'completed',
    label: 'web.search', runId: 'run:search', sequence: 1, providerHosted: hosted }];
  projection.revision = 1;
  projection.timeline = [{ kind: 'toolGroup', timelineId: 'timeline:search', sequence: 1,
    providerRequestId: 'request:search', activityIds: ['activity:search'] }];
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const explicit = structuredClone(projection);
  explicit.assistantDraft.blocks[0].action = { type: 'search', queries: ['compiler release'] };
  explicit.activities[0].providerHosted.action = structuredClone(explicit.assistantDraft.blocks[0].action);
  assert.deepEqual(await decodeGuiProjection(explicit), explicit);
  for (const select of [p => p.assistantDraft.blocks[0], p => p.activities[0].providerHosted]) {
    for (const invalid of [null, 'search', []]) {
      const malformed = structuredClone(projection);
      select(malformed).action = invalid;
      await assert.rejects(decodeGuiProjection(malformed), /conversation_projection_invalid/);
    }
  }
});

test('tool groups and nested details keep manual disclosure across output and settlement', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup, ProviderHostedDraftGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx',
  ]);
  const layout = {state:new Map()};
  const activities = ['A','B','C'].map((id,index) => ({activityId:id,runId:'run:manual',callId:id,sequence:index+1,
    kind:'tool',status:'active',label:id,startedAt:String(Date.now()),
    liveOutput:{stdout:`${id} output`,stderr:'',stdoutBytes:8,stderrBytes:0,truncated:false},
    tool:{operation:'process',resources:[]}}));
  const render = (hosted = false) => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey:'manual-tools', eager:true, virtualizer:{layout:()=>layout}, children:()=>hosted
      ? createElement(ProviderHostedDraftGroup, {blocks:activities.slice(0,2).map((a,index)=>({kind:'providerHosted',
        providerCallId:a.callId,providerToolType:'web_search',status:'completed',
        ...(index === 0 ? {} : {action:{query:a.label}})})),language:'en-US',onExpand(){}})
      : createElement(ToolActivityGroup,{activities,language:'en-US',onExpand(){},onOpenWorkspaceResource(){}}),
  }));
  assert.equal(render().includes('tool-entry-heading'),false);
  layout.state.set('tool-group:expanded',true);
  assert.equal((render().match(/tool-entry-heading/g)||[]).length,3);
  assert.equal(render().includes('<pre>'),false);
  layout.state.set('tool:C:expanded',true);
  assert.match(render(), /C output/);
  assert.equal(render().includes('A output'),false);
  activities[2].liveOutput.stdout = 'C second output';
  assert.match(render(), /C second output/);
  activities[2].status = 'failed';
  delete activities[2].liveOutput;
  activities[2].tool.error = {code:'exit_nonzero',message:'original failure'};
  assert.match(render(), /original failure/);
  assert.equal(layout.state.get('tool-group:expanded'),true);
  assert.equal(layout.state.get('tool:C:expanded'),true);
  layout.state.set('tool-group:expanded',false);
  assert.equal(render().includes('original failure'),false);
  assert.equal(render(true).includes('tool-entry-heading'),false);
  layout.state.set('hosted-group:expanded',true);
  assert.equal((render(true).match(/tool-entry-heading/g)||[]).length,2);
  layout.state.set('hosted:A:expanded',true);
  assert.match(render(true), /<code>A<\/code>/);
  assert.match(render(true), /<code>web_search<\/code>/);
});

test('settled managed processes render stored output without live output', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx',
  ]);
  const layout = { state: new Map([['tool-group:expanded', true], ['tool:managed:expanded', true]]) };
  const activity = {
    activityId: 'managed', runId: 'run:managed', callId: 'call:managed', sequence: 1,
    kind: 'tool', status: 'completed', label: 'bash', startedAt: '1',
    tool: { operation: 'bash', resources: [], process: {
      jobId: 'job:managed', command: 'make build',
      output: { stdout: 'Build finished', stderr: 'Build warning', stdoutBytes: 14, stderrBytes: 13, truncated: false },
      result: { exitCode: 0, durationMs: 100, timedOut: false },
    } },
  };
  const html = renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'managed-output', eager: true, virtualizer: { layout: () => layout },
    children: () => createElement(ToolActivityGroup, {
      activities: [activity], language: 'en-US', onExpand() {}, onOpenWorkspaceResource() {},
    }),
  }));
  assert.match(html, /Build finished/);
  assert.match(html, /Build warning/);
  assert.doesNotMatch(html, /No output yet/);
});


test('mixed tool results keep the group neutral and retain the original failure in details', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ ToolActivityGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx']);
  const layout = { state: new Map() };
  const activities = ['completed', 'failed'].map((status, index) => ({ activityId: String(index), runId: 'run:mix',
    kind: 'tool', status, label: 'browser.page', tool: { operation: 'browser.page', resources: [],
      ...(status === 'failed' ? { error: { code: 'native_browser_page_not_visible', message: 'reason=covered' } } : {}) } }));
  const render = () => renderToStaticMarkup(createElement(ConversationVirtualRow, { rowKey: 'mixed', eager: true,
    virtualizer: { layout: () => layout }, children: () => createElement(ToolActivityGroup, { activities, language: 'zh-CN', onExpand() {}, onOpenWorkspaceResource() {} }) }));
  assert.doesNotMatch(render(), /失败|reason=covered/);
  assert.match(render(), /2/);
  layout.state.set('tool-group:expanded', true); layout.state.set('tool:1:expanded', true);
  assert.match(render(), /reason=covered/);
  assert.match(render(), /失败/);
});

test('browser geometry clips to the viewport rather than shifting a full-width surface', async t => {
  const { clippedBrowserBounds } = await loadGuiModule(t, '/src/components/local-agent/nativeBrowserLayout.ts');
  assert.deepEqual(clippedBrowserBounds({ x: -20, y: 50, width: 900, height: 600 }, 800, 620), { x: 0, y: 50, width: 800, height: 570 });
  assert.deepEqual(clippedBrowserBounds({ x: 250, y: 120, width: 950, height: 580 }, 1200, 700), { x: 250, y: 120, width: 950, height: 580 });
});

test('browser page subscription retains updates during the initial snapshot and releases its listener', async t => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  let receive, resolveList, unsubscribed = 0;
  const snapshots = [], commands = [];
  globalThis.document = { documentElement: { dataset: { product: 'deepcode-gui' } } };
  globalThis.window = { location: { protocol: 'deepcode-gui:', hostname: 'localhost' }, __TAURI__: {
    core: { invoke: async (command, input) => {
      commands.push({ command, input });
      assert.ok(receive, 'events must be subscribed before requesting the snapshot');
      return new Promise(resolve => { resolveList = resolve; });
    } },
    event: { listen: async (_, listener) => { receive = listener; return () => { unsubscribed++; receive = null; }; } },
  } };
  const { watchNativePages } = await loadGuiModule(t, '/src/services/nativeBrowser.ts');
  const binding = { hostInstanceId: 'host:reader', windowLabel: 'main', sessionId: 'session:reader' };
  const page = (previewId, status = 'ready') => ({ ...binding, previewId, status, url: 'file:///preview.html' });
  const ready = watchNativePages(binding, pages => snapshots.push(pages));
  await waitUntil(() => Boolean(resolveList));
  receive({ payload: page('closed', 'closed') });
  receive({ payload: page('new', 'loading') });
  receive({ payload: { ...page('original'), control: { activeRuns: [] } } });
  receive({ payload: { ...page('foreign'), sessionId: 'session:other' } });
  resolveList({ pages: [page('closed'), { ...page('original'), control: { activeRuns: ['run:a'] } }] });
  const dispose = await ready;
  t.after(() => { if (receive) dispose(); });
  assert.deepEqual(snapshots.at(-1).map(page => [page.previewId, page.status]), [['original', 'ready'], ['new', 'loading']]);
  assert.deepEqual(snapshots.at(-1).find(page => page.previewId === 'original').control.activeRuns, [],
    'a completed run received during the initial snapshot cannot leave a stale control indicator');
  receive({ payload: { ...page('original'), control: { activeRuns: ['run:a', 'run:b'] } } });
  receive({ payload: { ...page('original'), control: { activeRuns: ['run:b'] } } });
  assert.deepEqual(snapshots.at(-1).find(page => page.previewId === 'original').control.activeRuns, ['run:b']);
  receive({ payload: page('new') });
  assert.equal(snapshots.at(-1).find(page => page.previewId === 'new').status, 'ready');
  receive({ payload: page('original', 'closed') });
  assert.deepEqual(snapshots.at(-1).map(page => page.previewId), ['new']);
  assert.deepEqual(commands[0], { command: 'deepcode_browser_command', input: { binding, input: { action: 'list' } } });
  dispose();
  assert.equal(unsubscribed, 1);
  assert.equal(receive, null);
});

test('Reader discovers Agent pages while preserving manual selection and panel state', async t => {
  const { reconcileReaderPages } = await loadGuiModule(t, '/src/components/local-agent/readerState.ts');
  const page = previewId => ({ previewId, sessionId: 'session:reader', status: 'ready', url: `file:///${previewId}.html` });
  const file = { id: 'file:source', target: { kind: 'file', path: '/source.ts' } };
  const initial = { sessionId: 'session:reader', tabs: [file], activeId: file.id, visible: false, expanded: false };
  const discovered = reconcileReaderPages(initial, [page('preview-1'), { ...page('other'), sessionId: 'session:other' }]);
  assert.deepEqual(discovered.tabs.map(tab => tab.id), ['file:source', 'browser:preview-1']);
  assert.equal(discovered.activeId, file.id);
  assert.equal(discovered.visible, false);
  const selected = { ...discovered, activeId: 'browser:preview-1', visible: true, expanded: true };
  const updated = reconcileReaderPages(selected, [page('preview-1'), page('preview-20')]);
  assert.equal(updated.activeId, 'browser:preview-1');
  assert.equal(updated.expanded, true);
  assert.deepEqual(updated.tabs.map(tab => tab.id), ['file:source', 'browser:preview-1', 'browser:preview-20']);
  const closed = reconcileReaderPages(updated, [page('preview-20')]);
  assert.equal(closed.activeId, null, 'a closed page is not silently replaced by another one');
  const empty = { ...initial, tabs: [], activeId: null };
  assert.equal(reconcileReaderPages(empty, [page('preview-20')], { kind: 'browser', previewId: 'preview-20' }).activeId, 'browser:preview-20');
  assert.equal(reconcileReaderPages(empty, [page('preview-20')], { kind: 'browser', previewId: 'closed' }).activeId, null);
});

test('queued tools and permission review never claim that execution has started', async (t) => {
  const [{ toolActivitySummary, toolGroupSummary }, { ApprovalActivity }, { ApprovalOperationDetails }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ApprovalActivity.tsx',
    '/src/components/local-agent/ApprovalOperationDetails.tsx',
  ]);
  const tool = { activityId: 'tool:queued', kind: 'tool', status: 'requested', label: 'bash', runId: 'run:test', sequence: 1,
    tool: { operation: 'bash', resources: [], shell: { command: 'git status', cwd: '/project', executionScope: 'workspace', terminal: false } } };
  assert.match(toolActivitySummary(tool, 'zh-CN'), /已请求/);
  assert.doesNotMatch(toolActivitySummary(tool, 'zh-CN'), /正在运行|已运行/);
  assert.match(toolActivitySummary({ ...tool, status: 'waiting' }, 'zh-CN'), /等待中/);
  assert.match(toolActivitySummary({ ...tool, status: 'active' }, 'zh-CN'), /正在运行/);
  const mixed = toolGroupSummary([{ ...tool, status: 'active' }, tool, tool, tool], 'zh-CN');
  assert.match(mixed, /4 个工具/);
  assert.match(mixed, /调用中 1/);
  assert.match(mixed, /已请求 3/);
  assert.doesNotMatch(mixed, /正在调用 4/);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const renderApproval = reviewing => renderToStaticMarkup(createElement(ApprovalActivity, {
    activity: { ...tool, kind: 'approval', status: 'waiting' }, pending: true, reviewing, language: 'zh-CN', onExpand() {},
  }));
  assert.match(renderApproval(true), /模型正在审查权限/);
  assert.match(renderApproval(false), /等待你决定/);
  const details = renderToStaticMarkup(createElement(ApprovalOperationDetails, { language: 'zh-CN', preview: {
    summary: 'Inspect git status', effects: ['shell'], logicalTargets: ['workspace'],
    operation: { toolName: 'bash', arguments: { command: 'git status' }, workspaceRoot: '/project', executionScope: 'workspace' },
  } }));
  assert.match(details, /git status/);
  assert.match(details, /\/project/);
  assert.match(details, /workspace/);
});

test('failure details count retries within each model request and retain source links', async (t) => {
  const [{ groupProviderAttempts, RunFailureDetails }, { SourceReferences }] = await loadGuiModules(t, [
    '/src/components/local-agent/RunFailureDetails.tsx', '/src/components/local-agent/SourceReferences.tsx',
  ]);
  const attempts = Array.from({ length: 6 }, (_, index) => ({ providerRequestId: `request:${index}`, providerAttemptId: `attempt:${index}`,
    attempt: 1, purpose: index === 2 ? 'approvalReview' : 'agent', phase: index === 5 ? 'failed' : 'completed' }));
  assert.equal(groupProviderAttempts(attempts).length, 6);
  assert.equal(groupProviderAttempts(attempts).reduce((sum, group) => sum + group.retries, 0), 0);
  const repeated = [...attempts, { ...attempts[5], providerAttemptId: 'attempt:retry', attempt: 2 }];
  assert.equal(groupProviderAttempts(repeated).at(-1).retries, 1);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const error = { code: 'provider_failed', message: 'Original upstream message' };
  const html = renderToStaticMarkup(createElement(RunFailureDetails, { language: 'zh-CN', onError() {}, projection: {
    sessionId: 'session:failure', run: { runId: 'run:test', status: 'failed' }, terminalError: error, providerAttempts: attempts,
    failureSnapshot: { revision: 1, phase: 'provider', error, providerRequestId: 'request:5', providerAttemptIds: attempts.map(a => a.providerAttemptId), toolRecordIds: [], pendingCallIds: [] },
  } }));
  assert.match(html, /6 个模型请求，发送 6 次/);
  assert.match(html, /权限审查/);
  assert.doesNotMatch(html, /重试 6 次/);
  const source = renderToStaticMarkup(createElement(SourceReferences, { language: 'zh-CN', references: {
    citations: [{ title: 'Actual documentation', url: 'https://example.test/docs' }], unresolved: true,
  } }));
  assert.match(source, /href="https:\/\/example.test\/docs"/);
  assert.match(source, /Actual documentation/);
  assert.match(source, /部分引用来源未返回/);
});

test('GUI consumes Session citation display, keeps original facts, and settles on displayed text', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-citations';
  await createSession(journal, sessionId, [workspaceBinding]);
  const raw = '网页来源。\uE200cite\uE202turn0search0\uE201 本地 [源码](/workspace/src/main.rs:42)。';
  const native = { type: 'message', id: 'native:citations', role: 'assistant', phase: 'final_answer', status: 'completed',
    content: [{ type: 'output_text', text: raw, annotations: [{ type: 'url_citation',
      title: '真实网页', url: 'https://example.test/article', start_index: 5, end_index: raw.indexOf(' 本地') }] }] };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'text.delta', { outputIndex: 0, text: raw });
    yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: native });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation({ apiSurface: 'responses' }).port, 'gui-citations');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:citations', 'Explain with sources.'));
  const projection = await decodeGuiProjection(await waitForProjection(actor, value => value.run?.status === 'completed'));
  const message = projection.messages.find(value => value.role === 'assistant');
  assert.equal(message.content, raw);
  const { projectCommittedText } = await import('../../presentation-core/dist/index.js');
  const text = projectCommittedText(projection).get(`message:${message.messageId}:content`).text;
  assert.equal(text, message.displayContent);
  assert.match(text, /\[真实网页\]\(<https:\/\/example.test\/article>\)/u);
  assert.match(text, /\[源码\]\(\/workspace\/src\/main.rs:42\)/u);
  assert.doesNotMatch(text, /turn0search0|\uE200/u);
  const [{ MarkdownContent }, { conversationDisplay }] = await loadGuiModules(t, [
    '/src/components/local-agent/BufferedMarkdown.tsx', '/src/components/local-agent/conversationDisplay.ts',
  ]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(createElement(MarkdownContent, null, text));
  assert.match(html, /href="https:\/\/example.test\/article"/u);
  const stream = projection.timeline.find(value => value.kind === 'message' && value.messageId === message.messageId).streamId;
  const live = new Set([message.runId]);
  assert.equal(conversationDisplay(projection, live, new Map([[stream, raw]])).displaySettledRunIds.has(message.runId), false);
  assert.equal(conversationDisplay(projection, live, new Map([[stream, text]])).displaySettledRunIds.has(message.runId), true);
});

test('workbench control examples use region data and Host actions while retaining Reader content', async t => {
  const { default: plugin } = await import('../../../ui-plugins/workbench-controls/index.mjs');
  class Element {
    children = []; style = {}; attributes = {};
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  }
  const oldDocument = globalThis.document;
  globalThis.document = { createElement() { return new Element(); } };
  const views = [], mounts = new Map(), calls = [];
  t.after(() => {
    for (const view of views) view.dispose();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  });
  plugin.apply({ addStyle() {}, register(slot, mount) { mounts.set(slot, mount); } });
  const input = data => ({ kind: 'region', data, locale: 'en-US' });
  const readerContent = new Element();
  const header = new Element();
  views.push(mounts.get('conversation.header')(header, input({ kind: 'conversationHeader', title: 'Current conversation',
    project: { id: 'project:one', title: 'Project' }, reader: { canOpen: true, visible: false } }), {
    regions: { mount(name, target) { assert.equal(name, 'reader'); target.append(readerContent); } },
    actions: { toggleReader() { calls.push('reader'); } },
  }));
  assert.equal(header.children[0].children[0].textContent, 'Current conversation');
  header.children[0].children[1].onclick();
  assert.equal(header.children[1], readerContent);
  views[0].update(input({ kind: 'conversationHeader', title: 'Renamed', project: null, reader: { canOpen: false, visible: true } }));
  assert.equal(header.children[0].children[0].textContent, 'Renamed');
  assert.equal(header.children[0].children[1].disabled, true);
  assert.equal(header.children[1], readerContent, 'updates retain the existing Reader portal target');

  const navigation = new Element();
  const navigationData = { kind: 'settingsNavigation', pages: [{ id: 'gui', label: 'Appearance' }, { id: 'agent', label: 'Agent' }], activePage: 'gui', searchQuery: '' };
  views.push(mounts.get('settings.navigation')(navigation, input(navigationData), { actions: {
    selectSettingsPage(id) { calls.push(['page', id]); }, setSettingsSearch(query) { calls.push(['search', query]); },
  } }));
  const [search, pages] = navigation.children[0].children;
  pages.children[1].onclick(); search.value = 'model'; search.oninput();
  views[1].update(input({ ...navigationData, searchQuery: 'model' }));
  assert.equal(navigation.children[0].children[0], search, 'search keeps its input node through owner updates');
  assert.equal(pages.children[0].attributes['aria-current'], undefined);

  const tree = new Element();
  views.push(mounts.get('reader.tree')(tree, input({ kind: 'resourceTree', filter: '', showRuntime: false, watchError: 'Original watch failure', items: [
    { id: 'directory:one', name: 'src', kind: 'directory', depth: 0, expanded: false, selected: false },
    { id: 'file:one', name: 'app.ts', kind: 'file', depth: 1, expanded: false, selected: true },
    { id: 'unavailable:one', name: 'Unavailable', kind: 'unavailable', depth: 1, error: 'Original read failure' },
  ] }), { actions: {
    setTreeFilter(value) { calls.push(['filter', value]); }, setTreeRuntimeVisible(value) { calls.push(['runtime', value]); },
    setTreeItemExpanded(id, value) { calls.push(['expand', id, value]); }, openTreeItem(id) { calls.push(['open', id]); },
  } }));
  const [filter, error, items, runtimeLabel] = tree.children[0].children;
  assert.equal(error.textContent, 'Original watch failure');
  items.children[0].onclick(); items.children[1].onclick();
  assert.equal(items.children[2].disabled, true);
  assert.equal(items.children[2].title, 'Original read failure');
  filter.value = 'app'; filter.oninput();
  runtimeLabel.children[0].checked = true; runtimeLabel.children[0].onchange();
  assert.deepEqual(calls, ['reader', ['page', 'agent'], ['search', 'model'], ['expand', 'directory:one', true],
    ['open', 'file:one'], ['filter', 'app'], ['runtime', true]]);
  for (const view of views.splice(0)) view.dispose();
  assert.deepEqual(header.children, [readerContent], 'scope owns the preserved Reader region');
  assert.equal(navigation.children.length, 0); assert.equal(tree.children.length, 0);
});

test('the context indicator renders shared Agent usage on each fresh mount', async (t) => {
  const { ContextUsageControl } = await loadGuiModule(t, '/src/components/local-agent/ContextUsageControl.tsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const props = { language: 'zh-CN', contextUsage: {
    providerRequestId: 'provider-request:agent', providerRuntimeRef: 'provider-runtime:main',
    runId: 'run:one', sequence: 1, updatedAt: '2026-09-23T00:00:00.000Z',
    inputTokens: 156863, outputTokens: 40, contextWindowTokens: 1000000,
  }, contextCompositions: [], contextOpen: false, setContextOpen() {}, rootRef: { current: null }, onToggle() {} };
  const first = renderToStaticMarkup(createElement(ContextUsageControl, props));
  assert.match(first, /16%/);
  assert.equal(renderToStaticMarkup(createElement(ContextUsageControl, props)), first);
  const unavailable = renderToStaticMarkup(createElement(ContextUsageControl, { ...props, contextUsage: null }));
  assert.doesNotMatch(unavailable, /16%/);
});

test('usage costs follow the saved display currency while unpriced usage stays unknown', async (t) => {
  const [{ Cost }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/components/settings-center/model-services/shared.tsx', '/src/state/settingsStore.ts',
  ]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const previous = { ...useSettingsStore.getInitialState() };
  t.after(() => { Object.assign(useSettingsStore.getInitialState(), previous); useSettingsStore.setState(previous, true); });
  const totals = { calls: 1, pricedCalls: 1, estimatedCost: 2 };
  const render = () => renderToStaticMarkup(createElement(Cost, { totals }));
  const setCurrency = currency => {
    const effectiveSettings = { ...previous.effectiveSettings, 'workbench.language': 'en-US', 'gui.usageWidget.currency': currency };
    Object.assign(useSettingsStore.getInitialState(), { effectiveSettings });
    useSettingsStore.setState({ effectiveSettings });
  };
  setCurrency('USD'); assert.ok(render().includes('$2.00'));
  setCurrency('CNY'); assert.ok(render().includes('14.00'));
  assert.equal(totals.estimatedCost, 2, 'currency selection cannot rewrite recorded USD cost');
  const unknown = renderToStaticMarkup(createElement(Cost, { totals: { calls: 1, pricedCalls: 0, estimatedCost: null } }));
  assert.ok(unknown.includes('—')); assert.equal(unknown.includes('0.00'), false);
});

test('approval operation details include file access while automated review is pending', async (t) => {
  const { ApprovalOperationDetails } = await loadGuiModule(t, '/src/components/local-agent/ApprovalOperationDetails.tsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(createElement(ApprovalOperationDetails, { language: 'en-US', preview: {
    summary: 'Inspect container availability', approvalReviewer: 'agent', effects: ['shell'], logicalTargets: ['host'],
    operation: { toolName: 'bash', workspaceRoot: '/workspace', executionScope: 'host', arguments: { command: 'docker ps' } },
    fileAccess: { read: ['/Applications/DeepCode.app'], write: [] },
  } }));
  for (const fact of ['docker ps', '/workspace', 'host', '/Applications/DeepCode.app']) assert.ok(html.includes(fact));
  assert.equal(html.includes('<button'), false, 'facts alone cannot approve an operation');
});


test('continuous actions include permissions and Agent events, separated only by visible text or decisions', async t => {
  const { projectionItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const { emptySessionState, projectSession } = await import('../../session-core/dist/index.js');
  const projection = projectSession(emptySessionState('session:actions'));
  projection.narratives = [1, 6].map(sequence => ({ narrativeId: `text:${sequence}`, runId: 'run:one', content: `Output ${sequence}`, sequence }));
  projection.activities = ['tool', 'approval', 'tool', 'agent', 'tool'].map((kind, index) => ({
    activityId: `action:${index}`, kind, status: 'completed', label: kind, runId: 'run:one', sequence: index + 2,
  }));
  projection.timeline = [
    { kind: 'narrative', narrativeId: 'text:1', streamId: 'stream:1', sequence: 1 },
    { kind: 'toolGroup', timelineId: 'group:1', activityIds: ['action:0'], sequence: 2 },
    { kind: 'toolGroup', timelineId: 'group:2', activityIds: ['action:1', 'action:2'], sequence: 3 },
    { kind: 'toolGroup', timelineId: 'group:3', activityIds: ['action:3'], sequence: 5 },
    { kind: 'narrative', narrativeId: 'text:6', streamId: 'stream:6', sequence: 6 },
    { kind: 'toolGroup', timelineId: 'group:4', activityIds: ['action:4'], sequence: 7 },
  ];
  const original = structuredClone(projection);
  const items = projectionItems(projection);
  assert.deepEqual(items.map(item => item.type), ['narrative', 'toolGroup', 'narrative', 'toolGroup']);
  assert.deepEqual(items[1].values.map(activity => activity.kind), ['tool', 'approval', 'tool', 'agent']);
  assert.deepEqual(projection, original);
});

const subagentFixture = () => ({ enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
  maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: false, presets: '[]' });
const userSettingsWithSubagents = settings => ({ ...DEFAULT_USER_SETTINGS,
  ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [`agent.subagents.${key}`, value])) });

test('subagent quick settings save the active Session, retain other Sessions and reconcile partial failures', async t => {
  const journal = new InMemoryCommandJournal(), actors = new Map();
  const initial = subagentFixture();
  for (const sessionId of ['session:settings-a', 'session:settings-b']) {
    await createSession(journal, sessionId);
    const actor = actorWith(journal, sessionId, { async *stream() { throw new Error('settings must not call Provider'); } }, emptyKernel(), fakeRunPreparation().port, sessionId);
    actors.set(sessionId, actor);
    await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'session.subagent-settings.set', sessionId,
      commandId: `${sessionId}:initial-settings`, settings: initial });
  }
  t.after(() => Promise.all([...actors.values()].map(actor => actor.dispose())));
  let defaults = initial, failure = null;
  const commands = [];
  installGuiFetch(t, async (url, init) => {
    if (url.pathname === '/api/user-settings') {
      assert.equal(init.method ?? 'GET', 'GET', 'the GUI must not independently patch global defaults');
      const settings = userSettingsWithSubagents(defaults);
      return Response.json({ ok: true, data: { settings, runtimeSettings: settings, overriddenKeys: [], storePath: 'fixture' } });
    }
    const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
    const actor = actors.get(sessionId);
    assert.ok(actor, `unexpected request ${url.pathname}`);
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    assert.ok(url.pathname.endsWith('/commands'));
    const command = JSON.parse(init.body);
    commands.push(command);
    if (failure === 'before') return Response.json({ ok: false, error: 'fixture_session_write_failed' }, { status: 500 });
    const reply = await actor.submit(command);
    if (failure === 'after') return Response.json({ ok: false, error: 'fixture_defaults_write_failed', message: 'Session saved; defaults write failed' }, { status: 500 });
    defaults = command.settings; // The Host owns the default update after accepting this command.
    return Response.json({ ok: true, data: reply });
  });
  const [{ useLocalAgentStore: store }, { useSettingsStore }, { default: Quick }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts', '/src/components/local-agent/SubagentQuickSettings.tsx',
  ]);
  const React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
  const render = () => {
    Object.assign(store.getInitialState(), store.getState());
    Object.assign(useSettingsStore.getInitialState(), useSettingsStore.getState());
    let tree;
    function Probe() { tree = Quick({ language: 'en-US', profiles: [], connections: [], mainProfileId: null }); return tree; }
    const html = renderToStaticMarkup(React.createElement(Probe));
    return { tree, html };
  };
  store.setState({ sessionId: 'session:settings-a', projection: await actors.get('session:settings-a').snapshot() });
  const enabledLabel = findReactElement(render().tree, node => node.type === 'label' && node.props.children[0].props.children === 'Enable subagents');
  findReactElement(enabledLabel, node => node.props.checked === true).props.onChange({ target: { checked: false } });
  await waitUntil(() => !store.getState().subagentSettingsBusy);
  assert.equal(store.getState().projection.subagentSettings.enabled, false);
  assert.equal((await actors.get('session:settings-b').snapshot()).subagentSettings.enabled, true);
  assert.equal(defaults.enabled, false, 'future Sessions receive the newly saved default');
  assert.equal(commands[0].type, 'session.subagent-settings.set');
  assert.equal(commands[0].sessionId, 'session:settings-a');
  assert.deepEqual(commands[0].settings, { ...initial, enabled: false });
  findReactElement(render().tree, node => node.props.profileId !== undefined && node.props.mainProfileId !== undefined)
    .props.onChange({ profileId: 'profile:chosen', reasoningEffort: 'low' });
  await waitUntil(() => !store.getState().subagentSettingsBusy);
  const fullLabel = findReactElement(render().tree, node => node.type === 'label' && node.props.children[0].props.children === 'Allow agents to fully configure subagents');
  findReactElement(fullLabel, node => node.props.checked === false).props.onChange({ target: { checked: true } });
  await waitUntil(() => !store.getState().subagentSettingsBusy);
  const saved = { ...initial, enabled: false, profileId: 'profile:chosen', reasoningEffort: 'low', allowFullConfiguration: true };
  assert.deepEqual(store.getState().projection.subagentSettings, saved);
  assert.deepEqual((await actors.get('session:settings-b').snapshot()).subagentSettings, initial);
  failure = 'before';
  assert.equal(await store.getState().setSubagentSettings({ ...saved, enabled: true }), false);
  assert.deepEqual(store.getState().projection.subagentSettings, saved);
  assert.match(store.getState().error, /fixture_session_write_failed/);
  failure = 'after';
  assert.equal(await store.getState().setSubagentSettings({ ...saved, enabled: true }), false);
  assert.equal(store.getState().projection.subagentSettings.enabled, true, 'a successful Session write remains visible when saving defaults fails');
  assert.match(store.getState().error, /Session saved; defaults write failed/);
  const projection = await actors.get('session:settings-a').snapshot();
  assert.deepEqual((await decodeGuiProjection(projection)).subagentSettings, projection.subagentSettings);
  await assert.rejects(decodeGuiProjection({ ...projection, subagentSettings: { ...saved, maxConcurrent: 0 } }), /conversation_projection_invalid/);
  const { subagentSettings: _settings, ...unconfigured } = projection;
  assert.equal((await decodeGuiProjection(unconfigured)).subagentSettings, undefined);
  store.setState({ projection: unconfigured });
  const missing = render();
  assert.match(missing.html, /Subagents have not been configured/);
  assert.doesNotMatch(missing.html, /role="switch"/, 'defaults must not appear as saved Session facts');
});

test('subagent draft edits update future defaults without starting a Session and travel with later Session creation', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:subagent-draft';
  const actor = actorWith(journal, sessionId, { async *stream() { throw new Error('fixture stops before Provider'); } }, emptyKernel(), fakeRunPreparation().port, 'draft');
  t.after(() => actor.dispose());
  const draft = { ...subagentFixture(), profileId: 'profile:draft', reasoningEffort: 'high' };
  let creation, defaults = subagentFixture();
  const calls = [];
  installGuiFetch(t, async (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === '/api/conversation/sessions') {
      creation = JSON.parse(init.body);
      await journal.createSession({ sessionId, displayTitle: 'Draft', workspaceBindings: [], subagentSettings: creation.subagentSettings });
      return Response.json({ ok: true, data: await actor.snapshot() });
    }
    if (url.pathname === '/api/user-settings') {
      if (init.method === 'PATCH') {
        const { patches } = JSON.parse(init.body);
        assert.deepEqual(patches, Object.fromEntries(Object.entries(draft).map(([key, value]) => [`agent.subagents.${key}`, value])));
        defaults = { ...draft };
        return Response.json({ ok: true, data: { settings: userSettingsWithSubagents(defaults), changedKeys: Object.keys(patches), activation: 'nextRun' } });
      }
      assert.equal(init.method ?? 'GET', 'GET');
      const settings = userSettingsWithSubagents(defaults);
      return Response.json({ ok: true, data: { settings, runtimeSettings: settings, overriddenKeys: [], storePath: 'fixture' } });
    }
    if (url.pathname === '/api/conversation/catalog') return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/commands')) return Response.json({ ok: false, error: 'fixture_message_not_submitted' }, { status: 500 });
    throw new Error(`unexpected request ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const profile = { id: 'profile:main', name: 'Main', enabled: true, thinking: 'disabled' };
  store.setState({ profiles: [profile], selectedProfileId: profile.id, draftProjectId: 'project:chosen' });
  assert.equal(await store.getState().setSubagentSettings(draft), true);
  assert.equal(store.getState().sessionId, null);
  assert.deepEqual(calls, ['/api/user-settings', '/api/user-settings'], 'editing saves and refreshes defaults without creating a Session or Loop');
  assert.deepEqual(defaults, draft);
  await assert.rejects(store.getState().sendMessage('Start after configuring.'), /fixture_message_not_submitted/);
  assert.deepEqual(creation, { projectId: 'project:chosen', subagentSettings: draft });
  assert.deepEqual(store.getState().projection.subagentSettings, draft);
  assert.equal(store.getState().draftSubagentSettings, null);
  store.getState().startNewSession();
  assert.equal(store.getState().draftSubagentSettings, null, 'a new draft does not reuse an earlier explicit override');
});
