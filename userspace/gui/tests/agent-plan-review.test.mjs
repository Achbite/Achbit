import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

test('the sidebar clears a read cancellation without hiding unread or active runs', async t => {
  const [{ default: Sidebar }, { runReadMarker }] = await loadGuiModules(t, [
    '/src/achbit-gui/layout/AchbitSidebar.tsx', '/src/achbit-gui/layout/useReadRunMarkers.ts',
  ]);
  const sessionId = 'session:report';
  const run = { runId: 'run:report', status: 'cancelled' };
  const props = { language: 'en-US', catalogStatus: 'ready', projects: [], sessions: [{ id: sessionId, title: 'Report' }],
    collapsedProjectIds: new Set(), activeSessionId: sessionId, readRunMarkers: {},
    sessionStatuses: { [sessionId]: { sessionId, revision: 12, run } } };
  const render = () => renderToStaticMarkup(createElement(Sidebar, props));
  assert.match(render(), /aria-label="Cancelled"/);
  const marker = runReadMarker(run);
  assert.ok(marker, 'a cancelled run can be marked as read');
  props.readRunMarkers[sessionId] = marker;
  assert.doesNotMatch(render(), /aria-label="Cancelled"/);
  props.sessionStatuses[sessionId].run = { ...run, runId: 'run:next' };
  assert.match(render(), /aria-label="Cancelled"/, 'another cancelled run has its own unread indicator');
  props.sessionStatuses[sessionId].run = { ...run, status: 'running' };
  assert.match(render(), /aria-label="Running"/);
  props.sessionStatuses[sessionId].run = { ...run, status: 'waiting', waitingReason: 'plan' };
  assert.match(render(), /role="status"/);
  assert.equal(runReadMarker(props.sessionStatuses[sessionId].run), null, 'a pending decision is not read away');
  assert.equal(run.status, 'cancelled', 'display acknowledgement never rewrites the run');
});

test('child Plan reviews advance independently and a revised scope can prompt again', async t => {
  const [{ nextAgentPlanReview, matchesAgentPlanReview, AgentPlanReview }] = await loadGuiModules(t,
    ['/src/components/local-agent/AgentPlanReview.tsx']);
  const first = { agentSessionId: 'session:writer', displayName: 'Writer', runId: 'run:writer',
    plan: { planId: 'plan:report', revision: 1 }, interactionIds: [] };
  const second = { ...first, agentSessionId: 'session:reviewer', runId: 'run:reviewer' };
  const question = { agentSessionId: 'session:question', runId: 'run:question', interactionIds: ['question:1'] };
  const decisions = [question, first, second];
  const original = structuredClone(decisions), dismissed = new Set();
  const review = nextAgentPlanReview(decisions, dismissed);
  assert.equal(review.decision, first);
  let mounted;
  function Probe() {
    mounted = AgentPlanReview({ decisions, language: 'en-US', refresh: async () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(mounted.props.decision, first, 'the parent entry mounts the pending review without opening child history');
  dismissed.add(review.key);
  assert.equal(nextAgentPlanReview(decisions, dismissed).decision, second);
  dismissed.add(nextAgentPlanReview(decisions, dismissed).key);
  assert.equal(nextAgentPlanReview(decisions, dismissed), null, 'polling the same revisions does not reopen deferred reviews');
  const revised = { ...first, plan: { ...first.plan, revision: 2 } };
  assert.equal(nextAgentPlanReview([revised, second], dismissed).decision, revised);
  assert.equal(nextAgentPlanReview([], dismissed), null, 'resolved or cancelled child routes leave no review');
  assert.deepEqual(decisions, original, 'deferring a dialog does not resolve or rewrite a Plan');
  const child = { sessionId: first.agentSessionId, pendingPlan: { ...first.plan, runId: first.runId } };
  assert.equal(matchesAgentPlanReview(first, child), true);
  assert.equal(matchesAgentPlanReview(second, child), false);
  assert.equal(matchesAgentPlanReview(first, { ...child, pendingPlan: { ...child.pendingPlan, runId: 'run:later' } }), false);
  assert.equal(matchesAgentPlanReview(revised, child), false);
  assert.equal(matchesAgentPlanReview(first, { ...child, pendingPlan: null }), false);
});

test('the shared child review sends each user decision to the original child Plan', async t => {
  const [{ ChildDecisions }] = await loadGuiModules(t, ['/src/components/local-agent/AgentTasksPanel.tsx']);
  const plan = { planId: 'plan:child', runId: 'run:child', revision: 3, title: 'Add report output',
    summary: 'Write the requested report.', steps: [], mutationManifest: [], status: 'pending' };
  const projection = { sessionId: 'session:child', pendingPlan: plan, plans: [plan], interactions: [], workspaceBindings: [] };
  const calls = [];
  let decide;
  function Probe() {
    const view = ChildDecisions({ projection, language: 'en-US', child: { submitting: false, readError: null,
      submit: async command => { calls.push(command); return { status: 'accepted' }; } } });
    decide = findReactElement(view, node => typeof node.props.composer?.submitPlanDecision === 'function')
      .props.composer.submitPlanDecision;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const responses = [{ kind: 'confirm' }, { kind: 'requestRevision', text: 'Only write report.md.' }, { kind: 'cancel' }];
  for (const response of responses) await decide(response);
  assert.deepEqual(calls.map(({ commandId, ...command }) => command), responses.map(response => ({
    schemaVersion: 'deepcode.command.v3', type: 'plan.respond', sessionId: 'session:child', runId: 'run:child',
    planId: 'plan:child', revision: 3, response,
  })));
  assert.equal(new Set(calls.map(command => command.commandId)).size, responses.length);
  assert.equal(projection.pendingPlan.status, 'pending', 'only the child Session can record the decision outcome');
});
