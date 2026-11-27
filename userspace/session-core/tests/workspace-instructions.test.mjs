import assert from 'node:assert/strict';
import test from 'node:test';
import { workspacePermissionInstruction } from '../dist/local-agent/workspaceInstructions.js';

const interactionControl = new Map([['interaction.request', 'interaction.request']]);
const planControl = new Map([['plan.publish', 'plan.publish']]);
const tools = [{ possibleEffects: ['workspaceMutation'] }];
const settings = (mutation, engineering = 'ask') => ({
  'agent.permissions.workspaceMutation': mutation,
  'agent.permissions.engineeringDecisions': engineering,
});

test('plan mode off keeps Plan out of the assembled instructions', () => {
  const policy = workspacePermissionInstruction(
    { permissions: settings('allow'), planMode: undefined }, tools, interactionControl);
  assert.match(policy.text, /Work within the bound workspaces and the user's authorized scope\./);
  assert.match(policy.text, /interaction\.request/);
  assert.doesNotMatch(policy.text, /Plan/);
});

test('plan mode off with delegated engineering adds no instructions at all', () => {
  const policy = workspacePermissionInstruction(
    { permissions: settings('allow', 'delegate'), planMode: undefined }, tools, new Map());
  assert.equal(policy, undefined);
});

test('requested plan keeps the confirmed-scope wording', () => {
  const policy = workspacePermissionInstruction(
    { permissions: settings('allow'), planMode: 'manual' }, tools, new Map());
  assert.match(policy.text, /Work within the confirmed project scope\./);
  assert.match(policy.text, /Plan confirmation, execution permission and engineering decisions remain separate\./);
});

test('confirmed plan mode points at the publish control', () => {
  const policy = workspacePermissionInstruction(
    { permissions: settings('plan'), planMode: undefined }, tools, planControl);
  assert.match(policy.text, /call plan\.publish and wait for confirmation/);
  assert.match(policy.text, /Plan confirmation, execution permission and engineering decisions remain separate\./);
});

test('review plan mode delegates review and keeps the decisions separate', () => {
  const policy = workspacePermissionInstruction(
    { permissions: settings('review'), planMode: undefined }, tools, planControl);
  assert.match(policy.text, /An independent Plan reviewer decides the proposed scope/);
  assert.match(policy.text, /Plan confirmation/);
});
