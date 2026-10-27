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
  // TCR: test-change-requests/TCR-20261027-approved-core-guidance.md in the parent workspace.
  // These are delivery contracts, not a word limit or a guarantee of model behavior.
  assert.match(text, /Work autonomously within the agreed scope/u);
  assert.match(text, /material decisions that affect correctness, scope or the agreed approach/u);
  assert.match(text, /preserve existing work and make focused changes/u);
  assert.match(text, /current tool schemas/u);
  assert.match(text, /rejected input was not executed/u);
  assert.match(text, /Preserve meaningful errors and successful results/u);
  assert.match(text, /Distinguish completed, failed and unverified work/u);
  assert.match(text, /declared entrypoints and required environment/u);
  assert.match(text, /relevant project or product guidance when needed/u);
  assert.match(text, /provide analysis, review or planning when requested/u);
  assert.match(text, /implement changes when authorized/u);
  assert.match(text, /first briefly tell the user what you are about to do and what it will establish/u);
  assert.match(text, /One explanation can cover a group of related operations/u);
  assert.match(text, /learn something useful, move to a new stage, change approach or encounter a blocker or substantial wait/u);
  assert.match(text, /ordinary prose addressed to the user/u);
  assert.match(text, /Keep them proportionate to the task; simple questions that need no action can be answered directly/u);
  assert.match(text, /task's named files, locations and existing evidence/u);
  assert.match(text, /Select checks that can affect the conclusion or next action, and reuse valid findings/u);
  assert.match(text, /concrete discrepancy, changed condition or missing fact/u);
  assert.match(text, /Distinguish observations, inferences and unresolved questions/u);
  assert.match(text, /Conclude when the evidence resolves the request/u);
  assert.match(text, /no change is needed is a valid result/u);
  assert.match(text, /If blocked, explain what remains/u);
  assert.match(text, /user's explicitly requested language for all user-facing text; otherwise use the response language specified by the session environment, or the user's language if neither is specified/u);
  assert.match(text, /opening explanation, updates between operations and the concluding answer/u);
  assert.match(text, /supplied environment and workspace information to choose the shell, command syntax, paths and execution target/u);
  assert.doesNotMatch(text, /plan_publish|interaction_request|workspaceId|mutationManifest|\[DONE:|\[PLAN MODE ACTIVE\]/u,
    'tool syntax, dynamic identities and mode-specific formats do not belong in the stable core');
});

test('delegation guidance describes opportunities, direct work and context needed by the child', () => {
  const agent = sessionControlToolDefinitions(capabilities).find(tool => tool.name === 'agent');
  assert.ok(agent);
  for (const phrase of ['Proactively delegate useful independent work', 'keep coupled work local', 'context, scope and expected evidence',
    'coordinate shared edits', 'verify final results', 'release execution without close', 'analysis for reading', 'action=models']) {
    assert.ok(agent.description.includes(phrase), phrase);
  }
  assert.doesNotMatch(agent.description, /Disabling|when enabled/u);
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
  assert.match(ask, /wait for confirmation/u);
  assert.match(ask, /without seeking approval again for ordinary implementation details/u);
  assert.match(ask, /Project reads need no Plan/u);
  assert.match(ask, /workspace bindings to select the task's project/u);
  assert.match(ask, /File and shell tools resolve relative paths from the selected workspace/u);
  assert.match(ask, /Product documentation and runtime paths locate Achbit's own resources/u);
  assert.match(ask, /Session working directory holds task drafts and previews, which need no Plan; tool execution permissions still apply/u);
  assert.match(contracts, /Todo grants no authority and unfinished items do not prevent answering/u);
  const delegated = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate' });
  assert.match(delegated, /Work directly within the bound workspaces/u);
  assert.match(delegated, /execution permissions still apply/u);
  assert.doesNotMatch(delegated, /confirmed automatically/u);
  assert.match(delegated, /no additional Plan approval is required/u);
  assert.doesNotMatch(delegated, /plan_publish|wait for confirmation|independent Plan reviewer/u);
  const review = permissionInstructionText({ 'agent.permissions.workspaceMutation': 'review' }, names.interactionRequest, names.planPublish);
  assert.match(review, /independent Plan reviewer/u);
  assert.match(review, /you do not approve your own Plan/u);
  assert.match(review, /new or expanded authorization is needed/u);
  assert.match(review, /Project reads need no Plan/u);
  assert.match(review, /task drafts and previews, which need no Plan; tool execution permissions still apply/u);
  assert.doesNotMatch(review, /wait for confirmation|no additional Plan approval/u);
  const noPlan = sessionControlInstructions(names, true, true, undefined, false);
  assert.equal(noPlan.includes(names.planPublish), false);
});
