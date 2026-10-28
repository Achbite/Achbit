import assert from 'node:assert/strict';
import test from 'node:test';
import { stableCoreInstructions } from '../dist/local-agent/coreInstructions.js';
import { agentOperationDefinitions, sessionControlInstructions, sessionControlToolDefinitions } from '../dist/local-agent/sessionControls.js';
import { permissionInstructionText } from '../dist/local-agent/skillPlugins.js';

const names = {
  interactionRequest: 'ask_user_wire', planPublish: 'publish_plan_wire',
  todoUpdate: 'update_todo_wire', pluginActivate: 'activate_plugin_wire',
  artifactPresent: 'present_artifact_wire',
};
const capabilities = { messaging: true, delegation: true, continuation: true };

test('stable core stays separate from dynamic control syntax', () => {
  assert.equal(stableCoreInstructions.length, 1);
  const text = stableCoreInstructions[0].text;
  assert.doesNotMatch(text, /plan_publish|interaction_request|workspaceId|mutationManifest|\[DONE:|\[PLAN MODE ACTIVE\]/u,
    'tool syntax, dynamic identities and mode-specific formats do not belong in the stable core');
});

test('agent operation discovery respects delegation and coordinator boundaries', () => {
  const agent = sessionControlToolDefinitions(capabilities).find(tool => tool.name === 'agent');
  assert.ok(agent);
  const definitions = agentOperationDefinitions(capabilities, { fullConfiguration: true });
  const disabled = agentOperationDefinitions(capabilities, { canSpawn: false });
  assert.equal(disabled.some(operation => ['spawn', 'assign'].includes(operation.action)), false);
  assert.ok(disabled.some(operation => operation.action === 'send'));
  assert.ok(definitions.some(operation => operation.action === 'assign'));
  const member = agentOperationDefinitions(capabilities, { coordinator: false });
  assert.equal(member.some(operation => ['assign', 'close'].includes(operation.action)), false);
  const memberSpawn = member.find(operation => operation.action === 'spawn').inputSchema.properties;
  assert.ok(memberSpawn.preset);
  for (const field of ['permissions', 'permissionPolicy', 'runner', 'workspaceSandbox', 'loop', 'context', 'capabilities']) assert.equal(memberSpawn[field], undefined, field);
});

test('messaging-only agents can send without receiving a spawn operation', () => {
  const restricted = { messaging: 'parent', delegation: false, continuation: false };
  const operations = agentOperationDefinitions(restricted);
  assert.equal(operations.some(operation => operation.action === 'spawn'), false);
  assert.ok(operations.some(operation => operation.action === 'send'));
});

test('runtime guidance follows selected control aliases and permission modes', () => {
  const full = sessionControlInstructions(names, true, true);
  for (const alias of Object.values(names)) assert.ok(full.includes(alias), alias);
  const minimal = sessionControlInstructions(names, true, false, []);
  for (const alias of [names.todoUpdate, names.artifactPresent, names.pluginActivate]) {
    assert.equal(minimal.includes(alias), false, alias);
  }
  assert.ok(minimal.includes(names.planPublish));
  assert.ok(minimal.includes(names.interactionRequest));
  const ask = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.engineeringDecisions': 'ask' }, names.interactionRequest, names.planPublish);
  assert.ok(ask.includes(names.planPublish));
  assert.ok(ask.includes(names.interactionRequest));
  const delegated = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate' }, names.interactionRequest, names.planPublish);
  assert.ok(delegated.includes(names.interactionRequest));
  assert.equal(delegated.includes(names.planPublish), false);
  const review = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'review' }, names.interactionRequest, names.planPublish);
  assert.ok(review.includes(names.planPublish));
  assert.ok(review.includes(names.interactionRequest));
  const noPlan = sessionControlInstructions(names, true, true, undefined, false);
  assert.equal(noPlan.includes(names.planPublish), false);
});
