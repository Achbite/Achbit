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
    schemaVersion: 'achbit.command.v3', type: 'plan.respond', sessionId: 'session:child', runId: 'run:child',
    planId: 'plan:child', revision: 3, response,
  })));
  assert.equal(new Set(calls.map(command => command.commandId)).size, responses.length);
  assert.equal(projection.pendingPlan.status, 'pending', 'only the child Session can record the decision outcome');
});

test('the parent conversation offers a child permission directly and defers only that item', async t => {
  const [{ AgentPlanReview, nextAgentPlanReview }] = await loadGuiModules(t, ['/src/components/local-agent/AgentPlanReview.tsx']);
  const decision = { agentSessionId: 'session:worker', displayName: 'Worker', runId: 'run:worker', interactionIds: [],
    approval: { callId: 'call:read', approvalId: 'approval:read' } };
  const later = new Set();
  const approval = nextAgentPlanReview([decision], later);
  assert.ok(approval, 'an approval-only route immediately has a main-conversation entry');
  let mounted;
  function Probe() { mounted = AgentPlanReview({ decisions: [decision], language: 'en-US', refresh: async () => {} }); return null; }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(mounted.props.decision, decision);
  assert.equal(mounted.key, approval.key);
  later.add(approval.key);
  const both = { ...decision, plan: { planId: 'plan:worker', revision: 1 } };
  const plan = nextAgentPlanReview([both], later);
  assert.ok(plan, 'deferring permission leaves the same child Plan available');
  assert.equal(plan.key, nextAgentPlanReview([{ ...both, approval: undefined }], new Set()).key);
  assert.equal(nextAgentPlanReview([both], new Set([plan.key])).key, approval.key, 'deferring the Plan leaves the approval');
  later.add(plan.key);
  assert.equal(nextAgentPlanReview([both], later), null);
  for (const updated of [{ ...decision, agentSessionId: 'session:other' }, { ...decision, runId: 'run:next' },
    { ...decision, approval: { ...decision.approval, callId: 'call:next' } },
    { ...decision, approval: { ...decision.approval, approvalId: 'approval:new' } }]) {
    assert.ok(nextAgentPlanReview([updated], later), 'a different identity has not been deferred');
  }
});

function viewOf(render) {
  let result;
  function Probe() { result = render(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return result;
}

function childApprovalFixture() {
  const decision = { agentSessionId: 'session:worker', displayName: 'Worker', runId: 'run:worker',
    plan: { planId: 'plan:other', revision: 2 }, interactionIds: ['question:other'], approval: { approvalId: 'approval:target', callId: 'call:target' } };
  const target = { ...decision.approval, runId: decision.runId,
    preview: { summary: 'Inspect the requested directory', effects: ['shell'], logicalTargets: ['workspace:one'],
      approvalReviewer: 'user', authorizationScope: 'runCommand', authorizationScopes: ['runCommand', 'sessionCommand'] } };
  const other = { ...target, approvalId: 'approval:other', callId: 'call:other', preview: { ...target.preview, summary: 'Unrelated operation' } };
  const plan = { ...decision.plan, runId: decision.runId, title: 'Unrelated Plan', status: 'pending', steps: [], mutationManifest: [] };
  const projection = { sessionId: decision.agentSessionId, run: { runId: decision.runId, status: 'running' },
    pendingApproval: other, pendingApprovals: [other, target], pendingPlan: plan, plans: [plan], workspaceBindings: [],
    interactions: [{ interactionId: 'question:other', runId: decision.runId, status: 'pending', prompt: 'Unrelated question' }] };
  return { decision, target, other, projection };
}

test('the routed dialog acts on just the original child approval, even when it is not first', async t => {
  const [{ AgentReviewDialog }, { ChildDecisions }, { ComposerDecisionPanels }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx', '/src/components/local-agent/ComposerDecisionPanels.tsx',
  ]);
  const { decision, target, projection } = childApprovalFixture(), calls = [];
  let deferred = 0;
  const child = { projection, submitting: false, readError: null, submit: async command => { calls.push(command); } };
  const dialog = kind => viewOf(() => AgentReviewDialog({ kind, decision, language: 'en-US', child,
    onDismiss: () => { deferred++; }, onResolved: () => assert.fail('render cannot resolve a decision') }));
  const permission = dialog('approval'), selected = findReactElement(permission, e => e.type === ChildDecisions);
  const html = renderToStaticMarkup(selected);
  assert.ok(html.includes(target.preview.summary));
  assert.doesNotMatch(html, /Unrelated operation|Unrelated Plan|Unrelated question/);
  const planOnly = renderToStaticMarkup(findReactElement(dialog('plan'), e => e.type === ChildDecisions));
  assert.match(planOnly, /Unrelated Plan/);
  assert.doesNotMatch(planOnly, /Inspect the requested directory|Unrelated operation|Unrelated question/);

  const panel = findReactElement(viewOf(() => ChildDecisions(selected.props)), e => e.type === ComposerDecisionPanels);
  const controls = viewOf(() => ComposerDecisionPanels(panel.props));
  const action = name => findReactElement(controls, e => e.props['data-ui-action'] === `composer.decision.${name}`);
  const section = findReactElement(controls, e => e.type === 'section' && e.props['aria-labelledby']);
  section.props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault: () => assert.fail('leave Escape to the modal'), stopPropagation() {} });
  findReactElement(permission, e => e.props['aria-label'] === 'Tool permission').props.onClose();
  findReactElement(permission, e => e.type === 'button' && e.props.children === 'Review later').props.onClick();
  assert.equal(deferred, 2); assert.deepEqual(calls, [], 'neither closing nor deferring grants or denies');
  action('allow').props.onClick(); action('deny').props.onClick();
  const common = { schemaVersion: 'achbit.command.v3', sessionId: 'session:worker', type: 'approval.respond', runId: decision.runId, ...decision.approval };
  assert.deepEqual(calls.map(({ commandId, ...command }) => command), [
    { ...common, decision: 'allow', authorizationScope: 'runCommand' }, { ...common, decision: 'deny' },
  ]);
  assert.equal(new Set(calls.map(c => c.commandId)).size, 2);
});

test('the parent waits for the child model handoff and never opens a stale or resolved approval', async t => {
  const [{ AgentPlanReview, AgentReviewDialog }, { ChildDecisions }, { ComposerDecisionPanels }, { pendingChildApproval }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx',
    '/src/components/local-agent/ComposerDecisionPanels.tsx', '/src/components/local-agent/useAgentChildConversation.ts',
  ]);
  const { decision, target, other, projection } = childApprovalFixture(), calls = [];
  const show = (snapshot, route = decision) => viewOf(() => AgentReviewDialog({ kind: 'approval', decision: route, language: 'en-US',
    child: { projection: snapshot, readError: null, submitting: false, submit: async command => { calls.push(command); } },
    onDismiss() {}, onResolved() {} }));
  assert.equal(show(null), null, 'the unverified loading state does not interrupt the parent');
  for (const invalid of [{ ...decision, agentSessionId: 'session:other' }, { ...decision, runId: 'run:old' },
    { ...decision, approval: { ...decision.approval, approvalId: 'approval:old' } },
    { ...decision, approval: { ...decision.approval, callId: 'call:old' } }]) assert.equal(show(projection, invalid), null);
  assert.equal(show({ ...projection, pendingApprovals: [other] }), null, 'resolution never selects the next approval by position');
  assert.equal(show({ ...projection, run: { ...projection.run, status: 'completed' } }), null);
  const delegated = { ...target, preview: { ...target.preview, approvalReviewer: 'agent' } };
  const observed = (approval, run = projection.run) => ({ ...projection, pendingApprovals: [other, approval], run });
  assert.equal(show(observed(delegated)), null, 'no modal during automatic review');
  const handoff = { ...delegated, preview: { ...delegated.preview, review: { decision: 'ask', reason: 'Review provider unavailable' } } };
  // The Session withholds this route during format recovery; the GUI cannot infer a handoff from child preview text alone.
  assert.equal(viewOf(() => AgentPlanReview({ decisions: [], language: 'en-US', refresh: async () => {} })), null);
  const waiting = { ...projection.run, status: 'waiting', waitingReason: 'approval' };
  assert.equal(show(observed(delegated, waiting)), null, 'waiting alone does not identify a completed review of this call');
  const visible = findReactElement(show(observed(handoff, waiting)), e => e.type === ChildDecisions);
  assert.match(renderToStaticMarkup(visible), /Review provider unavailable/);
  const activeHandoff = observed(handoff); // Another tool is still running after this exact call was handed off.
  const routed = findReactElement(show(activeHandoff), e => e.type === ChildDecisions);
  const panel = findReactElement(viewOf(() => ChildDecisions(routed.props)), e => e.type === ComposerDecisionPanels);
  assert.equal(panel.props.composer.projection.run.status, 'running', 'do not manufacture a waiting run');
  const allow = findReactElement(viewOf(() => ComposerDecisionPanels(panel.props)), e => e.props['data-ui-action'] === 'composer.decision.allow');
  assert.equal(allow.props.disabled, false);
  assert.deepEqual(calls, [], 'observation is not approval');
  allow.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(pendingChildApproval(activeHandoff, calls[0], decision), handoff, 'this routed ask also passes the child submit preflight');
  assert.equal(pendingChildApproval(observed(delegated), calls[0], decision), null, 'model-owned call cannot be sent from a stale control');
  assert.equal(pendingChildApproval({ ...activeHandoff, pendingApprovals: [other] }, calls[0], decision), null);
  assert.equal(pendingChildApproval(activeHandoff, calls[0], { ...decision, approval: other }), null, 'another route cannot authorize this response');
});
