import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentRecipe, inheritAgentRecipe } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest, messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { environmentInstruction } from '../dist/local-agent/sessionEnvironment.js';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

const selection = { kernel: ['fs.read'], controls: [], plugins: false };
test('task recipes inherit omitted groups and reject child tool expansion', () => {
  const parent = decodeAgentRecipe({ tools: selection });
  assert.deepEqual(inheritAgentRecipe(parent, {}).tools, selection);
  assert.deepEqual(inheritAgentRecipe(parent, { tools: { kernel: [] } }).tools,
    { kernel: [], controls: [], plugins: false });
  for (const tools of [{ kernel: ['bash'] }, { controls: ['agent'] }, { plugins: true }]) {
    assert.throws(() => inheritAgentRecipe(parent, { tools }), /agent_tools_not_grantable/u);
  }
  for (const tools of [{ kernel: ['fs.read', 'fs.read'] }, { controls: 'agent' }, { plugins: 'false' }, { unknown: [] }]) {
    assert.throws(() => decodeAgentRecipe({ tools }), /agent_tools_invalid/u);
  }
});

test('a read task declares only its read tool and omits framework configuration and absent capabilities', async () => {
  const runtime = runtimeSnapshot('run:read-task', { tools: [{ toolBindingRef: 'binding:read',
    name: 'fs.read', description: 'Read a known text file.', origin: 'coreBuiltin', availability: 'callable',
    possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }] });
  runtime.toolSelection = selection;
  runtime.agentToolsEnabled = true;
  runtime.instructions.push(environmentInstruction(runtime.environment));
  runtime.instructions.push({ id: 'achbit.workspace-autonomy', text: 'Mutation permission policy.' });
  const result = await buildAgentProviderRequest({ sessionId: 'session:read-task', runId: 'run:read-task', runtime,
    events: [], workspaceBindings: [workspaceBinding], providerRequestId: 'request:read-task', responseConstraint: 'normal' });
  assert.deepEqual(result.request.tools.map(tool => tool.name), ['fs_read']);
  assert.ok(!result.receipt.messages.some(message => message.contributionId === 'session:controls'));
  assert.doesNotMatch(JSON.stringify(result.request.messages), /Mutation permission|Command environment|executionPath|workspaceSandbox|permissionPolicy|agentComposition|Runtime setting|Loaded plugin|delegation|plugin_activate|plan_publish|bash/u);
  assert.ok(result.request.messages.some(message => message.content.includes('primary')), 'file addressing remains actionable');
});

test('a mutation task describes only its selected controls and readers', async () => {
  const runtime = runtimeSnapshot('run:limited', { tools: [
    { name: 'fs.write', toolBindingRef: 'binding:write', description: 'Write a file.', origin: 'coreBuiltin',
      availability: 'callable', possibleEffects: ['workspaceMutation'], inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'session.read', toolBindingRef: 'binding:history', description: 'Read history.', origin: 'coreBuiltin',
      availability: 'blocked', possibleEffects: ['localRead'], inputSchema: { type: 'object', properties: {}, required: [] } },
  ], permissions: { 'agent.permissions.workspaceMutation': 'plan' } });
  runtime.toolSelection = { controls: [], plugins: false };
  runtime.instructions.push({ id: 'achbit.workspace-autonomy', text: 'Use plan_publish and interaction_request.' });
  const { request, receipt } = await buildAgentProviderRequest({ sessionId: 'session:limited', runId: 'run:limited',
    runtime, events: [], workspaceBindings: [workspaceBinding], providerRequestId: 'request:limited', responseConstraint: 'normal' });
  assert.deepEqual(request.tools.map(tool => tool.name), ['fs_write']);
  assert.equal(receipt.messages.some(message => message.contributionId === 'session:images'), false);
  const guidance = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.match(guidance, /confirmed scope/u);
  assert.doesNotMatch(guidance, /plan_publish|interaction_request|session_read/u);
});

test('controller state stays in the journal while actual user content and current tool contracts are preserved', async () => {
  const runId = 'run:boundaries', sessionId = 'session:boundaries';
  const reader = name => ({ name, description: 'Read text.', toolBindingRef: 'binding:' + name, origin: 'coreBuiltin',
    availability: 'callable', possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } });
  const view = name => runtimeSnapshot(runId, { tools: [reader(name)], toolPromptContributions: [{
    canonicalToolName: name, preparedToolBindingRef: 'binding:' + name, origin: 'coreBuiltin',
    promptSnippet: 'Read text.', usageGuidelines: ['Guidance for ' + name], contributionRef: 'guidance:' + name,
  }] });
  const old = view('old.read'), current = view('fs.read');
  current.toolSelection = { controls: [], plugins: false };
  const event = (type, payload, sequence) => ({ type, payload, sequence, runId, sessionId, eventId: 'e:' + sequence });
  const user = event('message.committed', { role: 'user', messageId: 'm:one', content: 'Explain the literal string run.waiting.' }, 1);
  const start = event('run.started', { inputMessageId: 'm:one', workspaceBindings: [workspaceBinding], runtimeSnapshot: old }, 2);
  const changes = event('run.tools.prepared', { toolView: current }, 3);
  const noise = [
    event('run.waiting', { reason: 'approval', approvalId: 'internal-queue' }, 4),
    event('todo.updated', { revision: 1, items: [{ text: 'internal-progress', status: 'inProgress' }] }, 5),
    event('run.timing.updated', { clockDomain: 'internal-clock', totalMs: 37999 }, 6),
    event('provider.attempt.updated', { phase: 'completed', providerAttemptId: 'internal-attempt' }, 7),
  ];
  const compose = events => buildAgentProviderRequest({ sessionId, runId, events, runtime: current,
    workspaceBindings: [workspaceBinding], providerRequestId: 'request:state', responseConstraint: 'normal' });
  const expected = (await compose([user, start])).request;
  const actual = (await compose([user, start, changes, ...noise])).request;
  assert.deepEqual(actual.messages, expected.messages);
  assert.deepEqual(actual.tools.map(tool => tool.name), ['fs_read']);
  assert.deepEqual(actual.messages.filter(message => message.role === 'user').map(message => message.content), [user.payload.content]);
  assert.match(actual.messages.map(message => message.content).join(' '), /Guidance for fs.read/);
  assert.doesNotMatch(JSON.stringify(actual.messages), /old.read|plugins.tools.updated|internal-queue|internal-progress|internal-clock|internal-attempt/);
});

test('Host Shell declarations follow effective permissions and retain grants for file-only handles', async () => {
  const tool = { name: 'bash', toolBindingRef: 'binding:shell', origin: 'coreBuiltin', availability: 'callable',
    description: 'Use the workspace sandbox.', possibleEffects: ['process'],
    inputSchema: { type: 'object', required: ['command'], properties: {
      command: { type: 'string', description: 'In the sandbox, HOME is the session directory.' },
      timeout: { type: 'integer' }, terminal: { type: 'object' },
      requestHostPermission: { type: 'string' }, requestFileAccess: { type: 'object' }, requestNetworkPermission: { type: 'string' },
    } } };
  const runtime = runtimeSnapshot('run:shell', { tools: [tool], permissions: { 'agent.permissions.shellAccess': 'full' } });
  const input = { sessionId: 'session:shell', runId: 'run:shell', runtime, events: [], workspaceBindings: [workspaceBinding],
    directoryBindings: [workspaceBinding], providerRequestId: 'request:shell', responseConstraint: 'normal' };
  const declared = async input => (await buildAgentProviderRequest(input)).request.tools.find(item => item.name === 'bash');
  const host = await declared(input);
  assert.match(host.description, /as the host user/u);
  assert.deepEqual(Object.keys(host.inputSchema.properties).sort(), ['command', 'terminal', 'timeout', 'workspace']);
  assert.doesNotMatch(host.inputSchema.properties.command.description, /sandbox/u);

  const mixed = await declared({ ...input, workspaceBindings: [...input.workspaceBindings, { workspaceId: 'input:one', displayName: 'note.txt' }] });
  assert.match(mixed.description, /workspace2/u);
  assert.ok(mixed.inputSchema.properties.requestFileAccess && mixed.inputSchema.properties.requestNetworkPermission);
  assert.equal(mixed.inputSchema.properties.requestHostPermission, undefined);
  runtime.permissions['agent.permissions.shellAccess'] = 'workspace';
  const sandbox = await declared(input);
  assert.equal(sandbox.description, tool.description);
  assert.ok(sandbox.inputSchema.properties.requestHostPermission);
});

test('the main request only offers referenced history or actual image evidence, with matching target and view boundaries', async () => {
  const { sessionReadAllowed } = await import('../dist/local-agent/sessionReading.js');
  const { preparePluginActivation } = await import('../dist/local-agent/pluginActivation.js');
  const runtime = runtimeSnapshot('run:reader', { tools: [{ name: 'session.read', description: 'History',
    origin: 'coreBuiltin', toolBindingRef: 'binding:history', availability: 'callable', possibleEffects: ['localRead'],
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, view: { type: 'string' } }, required: ['sessionId'] } }] });
  const input = { sessionId: 'session:current', runId: 'run:reader', runtime, workspaceBindings: [],
    providerRequestId: 'request:reader', responseConstraint: 'normal' };
  const msg = (content, extra = {}) => ({type: 'message.committed', eventId: 'e:input', sequence: 1, sessionId: input.sessionId,
    payload: {messageId: 'm:input', role: 'user', content, ...extra}});
  const project = events => buildAgentProviderRequest({...input, events});
  const ordinary = await project([msg('Repair the ledger.')]);
  assert.ok(!ordinary.request.tools.some(tool => tool.name === 'session_read'));
  assert.ok(!ordinary.receipt.messages.some(message => message.contributionId === 'session:images'));
  const referenced = await project([msg('Read `session:saved` and sessionId="custom-archive".')]);
  const history = referenced.request.tools.find(tool => tool.name === 'session_read');
  assert.deepEqual(history.inputSchema.properties.sessionId.enum, ['session:saved', 'custom-archive']);
  assert.ok(sessionReadAllowed(referenced.toolCodec.sessionReadScope, { sessionId: 'session:saved', view: 'context' }));
  assert.ok(!sessionReadAllowed(referenced.toolCodec.sessionReadScope, { sessionId: input.sessionId, view: 'context' }));
  const withImage = msg('Compare this to session:saved.', {filesystemReferences: [{kind: 'file', mediaType: 'image/png',
    referenceId: 'image:1', workspaceId: 'workspace:file', logicalPath: 'image.png', displayName: 'image.png', byteLength: 2}]});
  const mixed = await project([withImage]);
  assert.ok(mixed.receipt.messages.some(message => message.contributionId === 'session:images'));
  assert.ok(sessionReadAllowed(mixed.toolCodec.sessionReadScope, { sessionId: input.sessionId, view: 'images' }));
  for (const view of ['summary','context','reasoning']) assert.ok(!sessionReadAllowed(mixed.toolCodec.sessionReadScope, { sessionId: input.sessionId, view }));
  const parent = await project([{type:'agent.task.created', payload:{createsAgent:true, agentSessionId:'session:child', taskId:'task:one'}, runId: input.runId,
    sessionId: input.sessionId, sequence: 1}]);
  assert.ok(sessionReadAllowed(parent.toolCodec.sessionReadScope, { sessionId:'session:child', view:'resources' }));
  assert.ok(!sessionReadAllowed(parent.toolCodec.sessionReadScope, { sessionId:'session:child', view:'context' }));
  assert.throws(() => preparePluginActivation({runtime, pluginUris:['plugin://session-diagnostics@builtin']}),
    error => error.code === 'plugin_user_selection_required');
});

test('coding tool feedback separates complete results from continuation and audit data', () => {
  const result = (toolName, input, output, error, origin = 'coreBuiltin') => {
    const base = { sessionId: 'session:feedback', runId: 'run:feedback', callId: 'call:one' };
    const record = { recordId: 'record:one', toolName, input, output, preparedEffect: { operation: toolName, origin },
      outcome: error ? 'failed' : 'completed', ...(error ? { error } : {}) };
    const events = [
      { ...base, eventId: 'event:1', sequence: 1, type: 'tool.requested', payload: { providerCallId: 'provider:one', toolName, input } },
      { ...base, eventId: 'event:2', sequence: 2, type: 'tool.completed', payload: { record } },
    ];
    const raw = structuredClone(record);
    const item = messagesFromJournal(events, base.runId, []).find(item => item.message.role === 'tool');
    assert.deepEqual(record, raw, 'model feedback must not change the durable tool record');
    return JSON.parse(item.message.content);
  };
  const fullOutput = { stdout: { path: '/archive/stdout.log', bytes: 9000 } };
  const shell = { command: 'build', stdout: 'output', stderr: '', exitCode: 0, truncated: false,
    executionScope: 'host', environment: { writeScope: 'hostUser' }, fullOutput };
  const complete = result('bash', { command: 'build' }, shell);
  assert.equal(complete.output.stdout, 'output');
  assert.equal(complete.output.exitCode, 0);
  assert.equal(complete.output.executionScope, 'host');
  assert.equal(complete.output.writeScope, 'hostUser');
  assert.equal(complete.output.fullOutput, undefined);
  assert.equal(complete.output.command, undefined);
  const error = { code: 'powershell_exit_nonzero', message: 'Native command failed.' };
  assert.deepEqual(result('bash', { command: 'build' }, { ...shell, truncated: true }).output.fullOutput, fullOutput);
  assert.deepEqual(result('bash', { command: 'build' }, { ...shell, exitCode: 7 }, error).output.fullOutput, fullOutput);
  const failed = result('powershell', { command: 'other' }, { ...shell, truncated: true, stderr: 'failure', exitCode: 7 }, error);
  assert.deepEqual(failed.error, error);
  assert.equal(failed.output.exitCode, 7);
  assert.equal(failed.output.stderr, 'failure');
  assert.equal(failed.output.command, 'build');
  assert.deepEqual(failed.output.fullOutput, fullOutput);

  const text = { path: 'x', content: 'hi', binary: false, startByte: 0, endByte: 2, startLine: 1, endLine: 1,
    maxBytes: 1024, maxLines: 5, sizeBytes: 2, fileSizeBytes: 2, byteTruncated: false, truncated: false,
    fileClassification: { kind: 'text', readableText: true, binary: false, executable: false, sizeBytes: 2 } };
  const read = result('fs.read', { path: 'x' }, text).output;
  assert.equal(read.content, text.content);
  assert.equal(read.fileSizeBytes, 2);
  assert.deepEqual(read.fileClassification, { kind: 'text', executable: false });
  assert.equal(read.maxBytes, undefined);
  const page = { ...text, truncated: true, byteTruncated: true, nextByte: 2, fileSizeBytes: 5 };
  assert.deepEqual(result('fs.read', { path: 'x' }, page).output, page);
  const last = { ...text, startByte: 3, endByte: 5, fileSizeBytes: 5 };
  assert.deepEqual(result('fs.read', { path: 'x', startByte: 3 }, last).output, last);
  assert.deepEqual(result('fs.read', {}, text, undefined, 'extension').output, text);

  const edit = { path: 'x', patched: true, editCount: 1, editPreview: { hunks: [{ after: 'hi' }] },
    changedRanges: [{ startByte: 0, endByte: 2 }], fileChanges: [] };
  const edited = result('fs.edit', {}, edit).output;
  assert.equal(edited.editCount, 1);
  assert.equal(edited.changed, false);
  assert.equal(edited.editPreview, undefined);
  assert.equal(edited.changedRanges, undefined);
  assert.equal(result('fs.write', {}, { saved: true, fileChanges: [{ path: 'x' }] }).output.changed, true);
  assert.deepEqual(result('fs.edit', {}, edit, { code: 'file_attributes_failed', message: 'Mode read failed' }).output.editPreview, edit.editPreview);
});
