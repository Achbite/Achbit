import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { createProviderToolAliases, decodeProviderToolInput } from '../dist/local-agent/providerToolCodec.js';
import { toolResultContent } from '../dist/local-agent/modelToolResult.js';
import { runtimeSnapshot } from './local-agent-fixtures.mjs';

const string = { type: 'string', minLength: 1 }, lines = { type: 'integer', minimum: 1, maximum: 5000 };
const tool = (name, effect, required, properties) => ({ name, origin: 'coreBuiltin', availability: 'callable',
  toolBindingRef: `binding:${name}`, description: `${name} captured operation.`, possibleEffects: [effect],
  inputSchema: { type: 'object', additionalProperties: false, required, properties } });
const tools = [
  tool('fs.read', 'workspaceRead', ['path'], { path: string, startLine: lines, maxLines: lines,
    startByte: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1024 } }),
  tool('bash', 'process', ['command'], { command: { ...string, maxLength: 16384 }, timeout: { type: 'integer', minimum: 1 },
    requestFileAccess: { type: 'object', properties: { read: { type: 'array', items: string } } },
    requestHostPermission: string, requestNetworkPermission: string, terminal: { type: 'object' } }),
  tool('fs.edit', 'workspaceMutation', ['path', 'edits'], { path: string, edits: { type: 'array', minItems: 1, maxItems: 128,
    items: { type: 'object', required: ['oldText', 'newText'], properties: { oldText: string, newText: { type: 'string' } } } } }),
  tool('fs.write', 'workspaceMutation', ['path', 'content'], { path: string, content: { type: 'string' }, executable: { type: 'boolean' } }),
];
const first = { workspaceId: 'bound:primary', displayName: 'Project' }, other = { workspaceId: 'bound:other', displayName: 'Reference' };
const bindings = [first, other];
async function view({ coding = true, dirs = bindings, forbidHost = false, custom = false } = {}) {
  const runtime = runtimeSnapshot('run:surface', { tools, permissions: { 'agent.permissions.shellAccess': 'full' } });
  if (coding) runtime.codingTools = true;
  runtime.toolSelection = { kernel: tools.map(t => t.name), controls: [], plugins: custom };
  runtime.providerToolAliases = createProviderToolAliases(runtime.toolSelection.kernel, [], coding);
  if (forbidHost) runtime.environment.agentComposition = { policyConstraints: { allowHostExecution: false } };
  return buildAgentProviderRequest({ runtime, events: [], sessionId: 'session:surface', runId: 'run:surface',
    providerRequestId: 'request:surface', workspaceBindings: bindings, directoryBindings: dirs, responseConstraint: 'normal' });
}
const find = (view, name) => view.request.tools.find(t => t.name === name);

test('a closed coding surface describes only its callable tools and real Shell route', async () => {
  const closed = await view(), custom = await view({ custom: true }), full = await view({ coding: false });
  const text = closed.request.messages.find(m => m.content.startsWith('<tools>')).content;
  assert.deepEqual(closed.request.tools.map(t => t.name), ['read', 'bash', 'edit', 'write']);
  assert.doesNotMatch(text, /Additional tools may be available|automatically managed|wait deadline/iu);
  assert.doesNotMatch(find(closed, 'read').description, /\b(?:maxBytes|startLine)\b/u);
  assert.match(find(closed, 'bash').description, /as the host user/u);
  assert.match(find(closed, 'bash').description, /Command environment: bash on fixture/u);
  assert.doesNotMatch(find(closed, 'bash').description, /Use ls, rg or find when the target path is unknown\./u, 'lookup is already in the shared rules');
  for (const open of [custom, full]) assert.match(find(open, 'bash').description, /Use ls, rg or find when the target path is unknown\./u);
  assert.deepEqual(find(full, 'fs_read').description, tools[0].description);
  assert.ok(find(full, 'fs_read').inputSchema.properties.maxBytes);
  assert.ok(find(full, 'bash').inputSchema.properties.terminal);
  assert.deepEqual(Object.keys(find(closed, 'bash').inputSchema.properties).sort(), ['command', 'timeout', 'workspace']);
  const mixed = find(await view({ dirs: [first] }), 'bash');
  assert.match(mixed.description, /workspace2/u);
  assert.ok(mixed.inputSchema.properties.requestFileAccess && mixed.inputSchema.properties.requestNetworkPermission);
  assert.equal(mixed.inputSchema.properties.requestHostPermission, undefined);
  const sandbox = find(await view({ forbidHost: true }), 'bash');
  assert.equal(sandbox.inputSchema.properties.requestHostPermission, undefined);
  assert.ok(sandbox.inputSchema.properties.requestFileAccess && sandbox.inputSchema.properties.requestNetworkPermission);
  assert.match(sandbox.inputSchema.properties.command.description, /TMPDIR/u);
});

test('coding wire parameters still dispatch to the selected binding and replay actual cursors', async () => {
  const { request, toolCodec } = await view();
  const decode = (tool, args) => decodeProviderToolInput(toolCodec, toolCodec.canonicalByWire.get(tool), args);
  const read = request.tools.find(t => t.name === 'read').inputSchema;
  assert.deepEqual(Object.keys(read.properties).sort(), ['limit', 'offset', 'path', 'startByte', 'workspace']);
  assert.equal(read.properties.limit.maximum, 5000);
  const path = 'notes.txt';
  assert.deepEqual(decode('read', { path, offset: 2, limit: 1, workspace: 'workspace2' }),
    { path, startLine: 2, maxLines: 1, maxBytes: 51200, workspaceId: other.workspaceId });
  assert.deepEqual(decode('read', { path, startByte: 51200 }), { path, startByte: 51200, maxBytes: 51200, workspaceId: first.workspaceId });
  const edits = [{ oldText: 'Alpha', newText: 'A' }, { oldText: '\nOmega', newText: '' }];
  assert.deepEqual(decode('edit', { path, edits }), { path, edits, workspaceId: first.workspaceId });
  assert.deepEqual(decode('write', { path, content: 'bytes' }), { path, content: 'bytes', workspaceId: first.workspaceId });
  assert.deepEqual(decode('bash', { command: 'exit 7', timeout: 9 }), { command: 'exit 7', timeout: 9, workspaceId: first.workspaceId });
  const render = output => toolResultContent({ toolName: 'fs.read', input: { path }, outcome: 'completed',
    preparedEffect: { origin: 'coreBuiltin' }, output }, undefined, toolCodec.workspaceHandleById, true);
  assert.deepEqual(JSON.parse(render({ content: 'part', truncated: true, nextByte: 51200 })), { content: 'part', nextByte: 51200 });
  assert.match(render({ content: 'line\n', truncated: true, nextByte: 10, nextStartLine: 3 }), /offset=3/u);
  assert.match(render({ entries: [{ name: 'folder', kind: 'directory' }], truncated: true, nextStartLine: 2 }), /folder\/[\s\S]*offset=2/u);
});
