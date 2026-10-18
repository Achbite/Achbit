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

// These assertions cover delivered guidance, not whether a real model follows it.
test('core guidance supports autonomous work while retaining evidence and execution boundaries', () => {
  assert.equal(stableCoreInstructions.length, 1);
  const text = stableCoreInstructions[0].text;
  assert.match(text, /Work autonomously within the authorized task/u);
  assert.match(text, /Kernel enforces execution scope/u);
  assert.match(text, /Rejected input was not executed/u);
  assert.match(text, /completion claims with evidence/u);
  assert.match(text, /declared build\/test entrypoints and required environment/u);
});

test('delegation guidance describes opportunities, direct work and context needed by the child', () => {
  const agent = sessionControlToolDefinitions(capabilities).find(tool => tool.name === 'agent');
  assert.ok(agent);
  for (const phrase of ['When enabled', 'No user reminder is needed', 'context-heavy exploration',
    'independent review', 'short or tightly coupled', 'continue independent work',
    'verify results', 'disabling blocks new tasks', 'action=models']) {
    assert.ok(agent.description.includes(phrase), phrase);
  }
  const operations = agentOperationDefinitions(capabilities, { fullConfiguration: true });
  const spawn = operations.find(operation => operation.action === 'spawn');
  assert.ok(spawn.inputSchema.properties.task.description.includes('not the parent conversation'));
  assert.match(spawn.inputSchema.properties.delivery.description, /async.*overlap.*wait.*depends/u);
  assert.match(spawn.inputSchema.properties.preset.description, /does not define a fixed agent type/u);
  assert.match(spawn.inputSchema.properties.permissions.description, /Cannot grant new authority/u);
  assert.equal(agentOperationDefinitions(capabilities, { canSpawn: false }).some(operation => operation.action === 'spawn'), false);
});

test('messaging-only agents receive contact guidance instead of encouragement to delegate', () => {
  const restricted = { messaging: 'parent', delegation: false, continuation: false };
  const agent = sessionControlToolDefinitions(restricted).find(tool => tool.name === 'agent');
  assert.match(agent.description, /Contact your parent/u);
  assert.doesNotMatch(agent.description, /proactively delegate/u);
  const operations = agentOperationDefinitions(restricted);
  assert.equal(operations.some(operation => operation.action === 'spawn'), false);
  assert.ok(operations.some(operation => operation.action === 'send'));
});

test('concise session guidance preserves aliases, pending decisions and optional control selection', () => {
  const full = sessionControlInstructions(names, true, true);
  for (const alias of Object.values(names)) assert.ok(full.includes(alias), alias);
  assert.match(full, /Confirmations always wait/u);
  assert.match(full, /unanswered question stays pending/u);
  assert.match(full, /execution approval is separate/u);
  assert.match(full, /each be the only call/u);
  assert.match(full, /Archiving alone does not deliver/u);
  const minimal = sessionControlInstructions(names, true, false, []);
  for (const alias of [names.todoUpdate, names.artifactPresent, names.pluginActivate]) {
    assert.equal(minimal.includes(alias), false, alias);
  }
  assert.ok(minimal.includes(names.planPublish));
  assert.ok(minimal.includes(names.interactionRequest));
  const ask = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.engineeringDecisions': 'ask' }, names.interactionRequest, names.planPublish);
  assert.ok(ask.includes(names.planPublish));
  assert.ok(ask.includes(names.interactionRequest));
  assert.match(ask, /Choose local implementation details/u);
  assert.match(ask, /before materially changing requirements/u);
  const delegated = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate' });
  assert.match(delegated, /confirmed automatically/u);
  assert.match(delegated, /Execution permissions still apply/u);
});
