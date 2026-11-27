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

test('a confirmed follow-up is actionable in full mode without relaxing other limits', () => {
  const runtime = { permissions: settings('allow') };
  const full = workspacePermissionInstruction(runtime, tools, interactionControl).text;
  assert.match(full, /review without editing/i);
  assert.match(full, /explicitly confirms a proposed fix, apply that fix in the same conversation/i);
  assert.match(full, /other constraints and tool permissions/i);
  for (const [run, view, controls] of [
    [{ ...runtime, codingTools: true }, tools, new Map()],
    [{ ...runtime, planMode: 'manual' }, tools, planControl],
    [{ permissions: settings('review') }, tools, planControl],
    [{ permissions: settings('plan') }, tools, planControl],
    [runtime, [{ possibleEffects: ['workspaceRead'] }], interactionControl],
  ]) {
    assert.doesNotMatch(workspacePermissionInstruction(run, view, controls)?.text ?? '', /apply that fix/i);
  }
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
