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
  assert.doesNotMatch(JSON.stringify(result.request.messages), /Mutation permission|Command environment|executionPath|workspaceSandbox|permissionPolicy|agentComposition|Runtime setting|Loaded plugin|delegation|plugin_activate|plan_publish|bash/u);
  assert.ok(result.request.messages.some(message => message.content.includes('primary')), 'file addressing remains actionable');
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
