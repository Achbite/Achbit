import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const operations = readFileSync(new URL('../../../docs/product/operations.md', import.meta.url), 'utf8');
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
  assert.match(text, /Read relevant product guidance when needed/u);
  assert.ok(text.length < 1200, 'stable guidance remains compact; procedures live in product docs');
});

test('delegation guidance describes opportunities, direct work and context needed by the child', () => {
  const agent = sessionControlToolDefinitions(capabilities).find(tool => tool.name === 'agent');
  assert.ok(agent);
  for (const phrase of ['independent work when enabled', 'keep coupled work local', 'context, scope and expected evidence',
    'coordinate shared edits', 'verify final results', 'release execution without close', 'Disabling blocks new tasks', 'action=models']) {
    assert.ok(agent.description.includes(phrase), phrase);
  }
  assert.match(operations, /Use collaboration/);
  assert.match(operations, /one writer per shared file/);
  assert.match(operations, /Await final results and verify/);
  const definitions = agentOperationDefinitions(capabilities, { fullConfiguration: true });
  const spawn = definitions.find(operation => operation.action === 'spawn');
  assert.ok(spawn.inputSchema.properties.task.description.includes('not the parent conversation'));
  assert.match(spawn.inputSchema.properties.delivery.description, /async.*overlap.*wait.*depends/u);
  assert.match(spawn.inputSchema.properties.preset.description, /does not define a fixed agent type/u);
  assert.match(spawn.inputSchema.properties.permissions.description, /Cannot grant new authority/u);
  const disabled = agentOperationDefinitions(capabilities, { canSpawn: false });
  assert.equal(disabled.some(operation => ['spawn', 'assign'].includes(operation.action)), false);
  assert.ok(disabled.some(operation => operation.action === 'send'));
  assert.ok(definitions.some(operation => operation.action === 'assign'));
  const member = agentOperationDefinitions(capabilities, { coordinator: false });
  assert.equal(member.some(operation => ['assign', 'close'].includes(operation.action)), false);
  const memberSpawn = member.find(operation => operation.action === 'spawn').inputSchema.properties;
  assert.ok(memberSpawn.preset);
  for (const field of ['permissions', 'permissionPolicy', 'runner', 'workspaceSandbox', 'loop', 'context', 'capabilities']) assert.equal(memberSpawn[field], undefined, field);
  assert.match(definitions.find(operation => operation.action === 'send').description, /not agreement.*Does not start tasks/u);
  assert.match(definitions.find(operation => operation.action === 'close').description, /idle retained agent.*rejected without cancellation.*final task results/u);
  const peer = sessionControlToolDefinitions({ messaging: true, delegation: false, continuation: true }).find(tool => tool.name === 'agent');
  assert.match(peer.description, /final answer and evidence, not an indefinite wait/u);
});

test('messaging-only agents receive contact guidance instead of encouragement to delegate', () => {
  const restricted = { messaging: 'parent', delegation: false, continuation: false };
  const agent = sessionControlToolDefinitions(restricted).find(tool => tool.name === 'agent');
  assert.match(agent.description, /Contact your current task owner/u);
  assert.doesNotMatch(agent.description, /proactively delegate/u);
  const operations = agentOperationDefinitions(restricted);
  assert.equal(operations.some(operation => operation.action === 'spawn'), false);
  assert.ok(operations.some(operation => operation.action === 'send'));
});

test('concise session guidance preserves aliases, pending decisions and optional control selection', () => {
  const full = sessionControlInstructions(names, true, true);
  for (const alias of Object.values(names)) assert.ok(full.includes(alias), alias);
  const contracts = sessionControlToolDefinitions(capabilities).map(tool => tool.description).join(' ');
  assert.match(contracts, /Confirmations always wait/u);
  assert.match(contracts, /unanswered question stays pending/u);
  assert.match(contracts, /execution approval is separate/u);
  assert.match(full, /each be the only call/u);
  assert.match(contracts, /Archiving alone does not deliver/u);
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
  assert.match(delegated, /Work directly within the bound workspaces/u);
  assert.match(delegated, /execution permissions still apply/u);
  assert.doesNotMatch(delegated, /confirmed automatically/u);
  const review = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'review' }, names.interactionRequest, names.planPublish);
  assert.match(review, /independent Plan reviewer/u);
  assert.match(review, /you do not approve your own Plan/u);
  const noPlan = sessionControlInstructions(names, true, true, undefined, false);
  assert.equal(noPlan.includes(names.planPublish), false);
});
