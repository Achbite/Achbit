import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentRecipe, inheritAgentRecipe } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
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
  runtime.instructions.push({ id: 'deepcode.workspace-autonomy', text: 'Mutation permission policy.' });
  const result = await buildAgentProviderRequest({ sessionId: 'session:read-task', runId: 'run:read-task', runtime,
    events: [], workspaceBindings: [workspaceBinding], providerRequestId: 'request:read-task', responseConstraint: 'normal' });
  assert.deepEqual(result.request.tools.map(tool => tool.name), ['fs_read']);
  assert.doesNotMatch(JSON.stringify(result.request.messages), /Mutation permission|Command environment|executionPath|workspaceSandbox|permissionPolicy|agentComposition|Runtime setting|Loaded plugin|delegation|plugin_activate|plan_publish|bash/u);
  assert.ok(result.request.messages.some(message => message.content.includes('primary')), 'file addressing remains actionable');
});
