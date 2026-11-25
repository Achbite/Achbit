import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement } from 'react';
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
  const [{ nextReview, planAndApprovalReviews, matchesAgentPlanReview, AgentPlanReview }] = await loadGuiModules(t,
    ['/src/components/local-agent/AgentPlanReview.tsx']);
  const first = { agentSessionId: 'session:writer', displayName: 'Writer', runId: 'run:writer',
    plan: { planId: 'plan:report', revision: 1 }, interactionIds: [] };
  const second = { ...first, agentSessionId: 'session:reviewer', runId: 'run:reviewer' };
  const question = { agentSessionId: 'session:question', runId: 'run:question', interactionIds: ['question:1'] };
  const decisions = [question, first, second];
  const original = structuredClone(decisions), dismissed = new Set();
  const review = nextReview(planAndApprovalReviews(decisions), dismissed);
  assert.equal(review.decision, first);
  let mounted;
  function Probe() {
    mounted = AgentPlanReview({ decisions, language: 'en-US', refresh: async () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(mountedRoute(mounted).props.decision, first, 'the parent entry mounts the pending review without opening child history');
  dismissed.add(review.key);
  assert.equal(nextReview(planAndApprovalReviews(decisions), dismissed).decision, second);
  dismissed.add(nextReview(planAndApprovalReviews(decisions), dismissed).key);
  assert.equal(nextReview(planAndApprovalReviews(decisions), dismissed), null, 'polling the same revisions does not reopen deferred reviews');
  const revised = { ...first, plan: { ...first.plan, revision: 2 } };
  assert.equal(nextReview(planAndApprovalReviews([revised, second]), dismissed).decision, revised);
  assert.equal(nextReview(planAndApprovalReviews([]), dismissed), null, 'resolved or cancelled child routes leave no review');
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
  const [{ AgentPlanReview, nextReview, planAndApprovalReviews }] = await loadGuiModules(t, ['/src/components/local-agent/AgentPlanReview.tsx']);
  const decision = { agentSessionId: 'session:worker', displayName: 'Worker', runId: 'run:worker', interactionIds: [],
    approval: { callId: 'call:read', approvalId: 'approval:read' } };
  const later = new Set();
  const approval = nextReview(planAndApprovalReviews([decision]), later);
  assert.ok(approval, 'an approval-only route immediately has a main-conversation entry');
  let mounted;
  function Probe() { mounted = AgentPlanReview({ decisions: [decision], language: 'en-US', refresh: async () => {} }); return null; }
  renderToStaticMarkup(createElement(Probe));
  const active = mountedRoute(mounted);
  assert.equal(active.props.decision, decision);
  assert.equal(active.key, approval.key);
  later.add(approval.key);
  const both = { ...decision, plan: { planId: 'plan:worker', revision: 1 } };
  const plan = nextReview(planAndApprovalReviews([both]), later);
  assert.ok(plan, 'deferring permission leaves the same child Plan available');
  assert.equal(plan.key, nextReview(planAndApprovalReviews([{ ...both, approval: undefined }]), new Set()).key);
  assert.equal(nextReview(planAndApprovalReviews([both]), new Set([plan.key])).key, approval.key, 'deferring the Plan leaves the approval');
  later.add(plan.key);
  assert.equal(nextReview(planAndApprovalReviews([both]), later), null);
  for (const updated of [{ ...decision, agentSessionId: 'session:other' }, { ...decision, runId: 'run:next' },
    { ...decision, approval: { ...decision.approval, callId: 'call:next' } },
    { ...decision, approval: { ...decision.approval, approvalId: 'approval:new' } }]) {
    assert.ok(nextReview(planAndApprovalReviews([updated]), later), 'a different identity has not been deferred');
  }
});

function viewOf(render) {
  let result;
  function Probe() { result = render(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return result;
}

function mountedRoute(view) {
  return findReactElement(view, e => e.props.decision && typeof e.props.onResolved === 'function');
}

function includesElement(root, predicate) {
  return Children.toArray(root).some(node => isValidElement(node)
    && (predicate(node) || includesElement(node.props.children, predicate)));
}

function inlineRegion(surface, ModalDialog, title) {
  assert.ok(surface, 'the verified child is available in the parent');
  assert.equal(includesElement(surface, e => e.type === ModalDialog || e.type === 'dialog'
    || e.props.role === 'dialog' || e.props['aria-modal'] === true || e.props['aria-modal'] === 'true'),
    false, 'showing a forwarded child permission or question must not open a modal');
  return findReactElement(surface, e => e.type === 'section' && e.props['aria-label'] === title);
}

function laterButton(surface) {
  return findReactElement(surface, e => typeof e.props.onClick === 'function' && e.props.children === 'Review later');
}

function pressEscape(target) {
  const event = { key: 'Escape', nativeEvent: {}, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  target.props.onKeyDown(event);
  return event;
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

test('the direct child Reader offers only the actionable sibling and submits its exact identity', async t => {
  const [{ ChildDecisions }, { ComposerDecisionPanels }, { pendingChildApproval }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentTasksPanel.tsx', '/src/components/local-agent/ComposerDecisionPanels.tsx',
    '/src/components/local-agent/useAgentChildConversation.ts']);
  const { target, other, projection } = childApprovalFixture();
  const reviewing = { ...other, preview: { ...other.preview, approvalReviewer: 'agent' } };
  const waiting = { ...projection, run: { ...projection.run, status: 'waiting', waitingReason: 'approval' },
    pendingPlan: null, interactions: [], pendingApproval: reviewing, pendingApprovals: [reviewing, target] };
  const calls = [];
  const render = p => findReactElement(viewOf(() => ChildDecisions({ projection: p, language: 'en-US',
    child: { projection: p, submitting: false, readError: null, submit: async cmd => { calls.push(cmd); } } })), e => e.type === ComposerDecisionPanels);
  const panel = render(waiting);
  assert.equal(panel.props.composer.pendingApproval, target);
  const controls = viewOf(() => ComposerDecisionPanels(panel.props));
  findReactElement(controls, e => e.props['data-ui-action'] === 'composer.decision.allow').props.onClick();
  assert.deepEqual(calls.map(({ sessionId, runId, callId, approvalId }) => ({ sessionId, runId, callId, approvalId })),
    [{ sessionId: waiting.sessionId, runId: target.runId, callId: target.callId, approvalId: target.approvalId }]);
  assert.equal(pendingChildApproval(waiting, reviewing), null, 'the submit preflight rejects a model-owned call, even without a parent dialog');
  assert.equal(pendingChildApproval(waiting, calls[0]), target);
  const withdrawn = { ...waiting, pendingApprovals: [reviewing] };
  assert.equal(pendingChildApproval(withdrawn, calls[0]), null, 'a stale B must never fall back to A');
  assert.doesNotMatch(renderToStaticMarkup(render(withdrawn)), /composer\.decision\.(allow|deny)/);
});

test('a directly opened conversation cannot retarget the visible human approval after withdrawal or navigation', async t => {
  const oldStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, removeItem() {} };
  t.after(() => { if (oldStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldStorage; });
  const [{ useAgentComposer }, { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentComposer.ts', '/src/state/localAgentStore.ts']);
  const { target, other, projection } = childApprovalFixture();
  const reviewer = { ...other, preview: { ...other.preview, approvalReviewer: 'agent' } };
  const p = { ...projection, contextCompositions: [], queuedInputs: [], pendingPlan: null, interactions: [],
    run: { ...projection.run, status: 'waiting', waitingReason: 'approval' }, pendingApproval: reviewer, pendingApprovals: [reviewer, target] };
  store.setState({ sessionId: p.sessionId, projection: p });
  Object.assign(store.getInitialState(), store.getState());
  const composer = viewOf(() => useAgentComposer('en-US', () => {}));
  assert.equal(composer.pendingApproval, target);
  const noTransport = () => assert.fail('must not send a stale approval command');
  const oldFetch = globalThis.fetch; globalThis.fetch = noTransport; t.after(() => { globalThis.fetch = oldFetch; });
  store.setState({ projection: { ...p, pendingApprovals: [reviewer] } });
  await assert.rejects(composer.respondApproval('allow'), /approval_response_missing/);
  store.setState({ sessionId: 'session:other', projection: { ...p, sessionId: 'session:other' } });
  await assert.rejects(composer.respondApproval('allow'), /approval_response_missing/);
});

test('the inline composer acts on just the advertised child approval; only a child Plan opens a modal', async t => {
  const [{ AgentReviewSurface }, { ChildDecisions }, { ComposerDecisionPanels }, { ModalDialog }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx', '/src/components/local-agent/ComposerDecisionPanels.tsx', '/src/ui-components/index.ts',
  ]);
  const { decision, target, projection } = childApprovalFixture(), calls = [];
  let deferred = 0;
  const child = { projection, submitting: false, readError: null, submit: async command => { calls.push(command); } };
  const surface = kind => viewOf(() => AgentReviewSurface({ kind, decision, language: 'en-US', child,
    onDismiss: () => { deferred++; }, onResolved: () => assert.fail('observing a decision cannot resolve it') }));
  const permission = surface('approval'), region = inlineRegion(permission, ModalDialog, 'Tool permission');
  const selected = findReactElement(region, e => e.type === ChildDecisions);
  const html = renderToStaticMarkup(permission);
  assert.doesNotMatch(html, /<dialog\b|role="dialog"|aria-modal="true"/);
  assert.ok(html.includes(target.preview.summary));
  assert.doesNotMatch(html, /Unrelated operation|Unrelated Plan|Unrelated question/);
  const modal = findReactElement(surface('plan'), e => e.type === ModalDialog);
  assert.ok(modal.props['aria-label'] || modal.props['aria-labelledby'], 'the retained Plan dialog has an accessible name');
  const planOnly = renderToStaticMarkup(findReactElement(modal, e => e.type === ChildDecisions));
  assert.match(planOnly, /Unrelated Plan/);
  assert.doesNotMatch(planOnly, /Inspect the requested directory|Unrelated operation|Unrelated question/);

  const panel = findReactElement(viewOf(() => ChildDecisions(selected.props)), e => e.type === ComposerDecisionPanels);
  const controls = viewOf(() => ComposerDecisionPanels(panel.props));
  const action = name => findReactElement(controls, e => e.props['data-ui-action'] === `composer.decision.${name}`);
  const section = findReactElement(controls, e => e.type === 'section' && e.props['aria-labelledby']);
  // The shared approval control may leave Escape to the enclosing inline region, but it must never deny here.
  const key = pressEscape(section);
  if (!key.defaultPrevented) region.props.onKeyDown(key);
  laterButton(region).props.onClick();
  assert.equal(deferred, 2); assert.deepEqual(calls, [], 'Escape and Review later neither grant nor deny');
  assert.notEqual(action('deny').props['aria-keyshortcuts'], 'Escape', 'the child must not advertise a denial shortcut it does not perform');
  action('allow').props.onClick(); action('allow-session').props.onClick(); action('deny').props.onClick();
  const common = { schemaVersion: 'achbit.command.v3', sessionId: 'session:worker', type: 'approval.respond', runId: decision.runId, ...decision.approval };
  assert.deepEqual(calls.map(({ commandId, ...command }) => command), [
    { ...common, decision: 'allow', authorizationScope: 'runCommand' },
    { ...common, decision: 'allow', authorizationScope: 'sessionCommand' }, { ...common, decision: 'deny' },
  ]);
  assert.equal(new Set(calls.map(c => c.commandId)).size, 3);
});

test('the parent waits for the child model handoff and never opens a stale or resolved approval', async t => {
  const [{ AgentPlanReview, AgentReviewSurface }, { ChildDecisions }, { ComposerDecisionPanels }, { pendingChildApproval }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx',
    '/src/components/local-agent/ComposerDecisionPanels.tsx', '/src/components/local-agent/useAgentChildConversation.ts',
  ]);
  const { decision, target, other, projection } = childApprovalFixture(), calls = [];
  const show = (snapshot, route = decision) => viewOf(() => AgentReviewSurface({ kind: 'approval', decision: route, language: 'en-US',
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
  assert.equal(show(observed(delegated)), null, 'no actionable surface during automatic review');
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

function childInteractionFixture() {
  const { projection } = childApprovalFixture();
  const question = { interactionId: 'question:output', runId: projection.run.runId, status: 'pending', kind: 'question',
    mode: 'continue', prompt: 'Where should the report go?', allowFreeform: true };
  const confirmation = { ...question, interactionId: 'question:publish', kind: 'confirmation', mode: 'wait',
    prompt: 'Publish this report?', allowFreeform: false, options: [{ id: 'publish', label: 'Publish now' }, { id: 'keep', label: 'Keep private' }] };
  const decision = { agentSessionId: projection.sessionId, displayName: 'Writer', runId: question.runId,
    interactionIds: [question.interactionId, confirmation.interactionId] };
  return { decision, question, confirmation, projection: { ...projection, interactions: [question, confirmation] } };
}

test('parent-routed child interaction: pure requests mount and deferring one preserves its siblings', async t => {
  const [{ AgentPlanReview, nextReview, agentReviews }] = await loadGuiModules(t, ['/src/components/local-agent/AgentPlanReview.tsx']);
  const { decision, question, confirmation } = childInteractionFixture();
  const mount = decisions => viewOf(() => AgentPlanReview({ decisions, language: 'en-US', refresh: async () => {} }));
  assert.equal(mount([]), null, 'messages without a user decision route have no review');
  const entry = mountedRoute(mount([decision]));
  assert.ok(entry, 'a pure interaction route is offered in the parent composer');
  assert.equal(entry.props.decision, decision);
  assert.equal(entry.props.interactionId, question.interactionId);
  const approval = call => ({ ...decision, approval: { callId: `call:${call}`, approvalId: `approval:${call}` } });
  const firstApproval = approval('one'), secondApproval = approval('two');
  const routes = [decision, firstApproval, secondApproval], later = new Set(), before = structuredClone(routes);
  const take = () => { const item = nextReview(agentReviews(routes), later); assert.ok(item); later.add(item.key); return item; };
  assert.equal(take().decision, firstApproval, 'a question cannot displace an existing Plan or permission review');
  assert.equal(take().decision, secondApproval, 'two routes for one child are not collapsed');
  assert.equal(take().key, entry.key);
  assert.equal(take().interactionId, confirmation.interactionId);
  assert.equal(nextReview(agentReviews(routes), later), null, 'duplicates and republished identities stay deferred');
  for (const changed of [{ ...decision, agentSessionId: 'session:sibling' }, { ...decision, runId: 'run:next' },
    { ...decision, interactionIds: ['question:new'] }]) assert.ok(nextReview(agentReviews([changed]), later));
  assert.deepEqual(routes, before, 'deferral does not rewrite Session facts');
});

test('parent-routed child interaction: free text and confirmation choices submit to the exact child', async t => {
  const [{ AgentReviewSurface }, { ChildDecisions }, { ComposerQuestionPrompt, ComposerDecisionPanels }, { InteractionOptions }, { ModalDialog }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/AgentTasksPanel.tsx',
    '/src/components/local-agent/ComposerDecisionPanels.tsx', '/src/components/local-agent/InteractionOptions.tsx', '/src/ui-components/index.ts',
  ]);
  const { decision, question, confirmation, projection } = childInteractionFixture();
  const calls = [], text = 'Put it in the shared reports directory.';
  let draft = 'A reply already in progress', deferred = 0;
  const controls = (interaction, snapshot, title) => {
    const surface = viewOf(() => AgentReviewSurface({ kind: 'interaction', decision, interactionId: interaction.interactionId,
      language: 'en-US', child: { projection: snapshot, submitting: false, readError: null, submit: async cmd => { calls.push(cmd); } },
      draft: interaction === question ? draft : '', onDraftChange: value => { draft = value; },
      onDismiss: () => { deferred++; }, onResolved: () => assert.fail('render is not a resolution') }));
    const region = inlineRegion(surface, ModalDialog, title);
    const html = renderToStaticMarkup(surface);
    assert.ok(html.includes(interaction.prompt));
    assert.ok(!html.includes(interaction === question ? confirmation.prompt : question.prompt));
    assert.doesNotMatch(html, /Unrelated operation|Unrelated Plan|<dialog\b|role="dialog"|aria-modal="true"/);
    const selected = findReactElement(region, e => e.type === ChildDecisions);
    const content = viewOf(() => ChildDecisions(selected.props));
    const prompt = findReactElement(content, e => e.type === ComposerQuestionPrompt);
    const panel = findReactElement(content, e => e.type === ComposerDecisionPanels);
    assert.equal(prompt.props.composer.pendingInteraction, interaction);
    assert.equal(panel.props.composer.pendingInteraction, interaction);
    const owner = findReactElement(content, e => typeof e.type === 'function' && e.props.question === interaction && typeof e.props.onAnswer === 'function');
    return { region, prompt: viewOf(() => ComposerQuestionPrompt(prompt.props)), panel: viewOf(() => ComposerDecisionPanels(panel.props)),
      form: viewOf(() => owner.type(owner.props)) };
  };
  const free = controls(question, projection, 'Question'); // The child can still be running.
  const input = findReactElement(free.form, e => e.type === 'textarea');
  assert.equal(input.props.value, draft);
  input.props.onChange({ target: { value: text } });
  assert.equal(draft, text, 'editing updates this child reply without answering');
  findReactElement(free.prompt, e => e.props['data-ui-action'] === 'composer.question.close').props.onClick();
  pressEscape(free.region);
  const choice = controls(confirmation, { ...projection, run: { ...projection.run, status: 'waiting', waitingReason: 'userInput' } }, 'Confirmation');
  assert.equal(includesElement(choice.form, e => e.type === 'textarea'), false, 'choice-only confirmation cannot submit free text');
  laterButton(choice.region).props.onClick();
  pressEscape(choice.region);
  assert.equal(deferred, 4);
  assert.deepEqual(calls, [], 'typing, closing and deferring neither answer nor stop the child');
  const returned = controls(question, projection, 'Question');
  assert.equal(findReactElement(returned.form, e => e.type === 'textarea').props.value, text);
  findReactElement(returned.form, e => e.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  const options = findReactElement(choice.panel, e => e.type === InteractionOptions);
  assert.equal(options.props.surface, 'composer');
  assert.equal(options.props.interactionId, confirmation.interactionId);
  findReactElement(viewOf(() => InteractionOptions(options.props)), e => e.props.title === 'Keep private').props.onClick();
  const common = { schemaVersion: 'achbit.command.v3', sessionId: decision.agentSessionId, runId: decision.runId, type: 'interaction.respond' };
  assert.deepEqual(calls.map(({ commandId, ...command }) => command), [
    { ...common, interactionId: question.interactionId, response: text },
    { ...common, interactionId: confirmation.interactionId, response: 'keep' },
  ]);
  assert.equal(new Set(calls.map(c => c.commandId)).size, 2);
  assert.equal(question.status, 'pending', 'only the child Session records the answer');
});

test('parent-routed child interaction: stale or unadvertised targets never substitute another pending item', async t => {
  const [{ AgentReviewSurface }, { pendingChildInteraction }] = await loadGuiModules(t, [
    '/src/components/local-agent/AgentPlanReview.tsx', '/src/components/local-agent/useAgentChildConversation.ts',
  ]);
  const { decision, question, confirmation, projection } = childInteractionFixture();
  const show = (snapshot, route) => viewOf(() => AgentReviewSurface({ kind: 'interaction', decision: route,
    interactionId: question.interactionId, language: 'en-US', child: { projection: snapshot, readError: null, submitting: false },
    onDismiss() {}, onResolved() {} }));
  assert.equal(show(null, decision), null, 'an unverified child snapshot does not interrupt the parent');
  assert.ok(show(projection, decision), 'an exact pending continue question is actionable in a running child');
  for (const [snapshot, route] of [
    [projection, { ...decision, agentSessionId: 'session:sibling' }], [projection, { ...decision, runId: 'run:next' }],
    [projection, { ...decision, interactionIds: [confirmation.interactionId] }],
    [{ ...projection, run: { ...projection.run, runId: 'run:new' } }, decision],
    [{ ...projection, run: { ...projection.run, status: 'completed' } }, decision],
    ...[{ ...question, runId: 'run:old' }, { ...question, status: 'answered' }, { ...question, status: 'closed' }]
      .map(stale => [{ ...projection, interactions: [confirmation, stale] }, decision]),
    [{ ...projection, interactions: [confirmation] }, decision],
  ]) {
    assert.equal(show(snapshot, route), null);
    assert.equal(pendingChildInteraction(snapshot, question, route), null, 'the same stale item fails the child submit preflight');
  }
  assert.equal(pendingChildInteraction(projection, question, decision), question);
});

test('a parent decision keeps its composer by default; the user may select and defer the advertised child item', async t => {
  const [{ AgentPlanReview }] = await loadGuiModules(t, ['/src/components/local-agent/AgentPlanReview.tsx']);
  const { decision, question } = childInteractionFixture();
  const readOnly = { decisions: [decision], language: 'en-US', preferParent: true,
    refresh: () => assert.fail('switching between offers must not resolve a decision') };
  let frames = 0;
  const resting = [];
  function Probe() {
    const frame = frames++;
    const view = AgentPlanReview(readOnly);
    if (frame === 1) {
      const active = mountedRoute(view);
      assert.equal(active.props.decision, decision);
      assert.equal(active.props.interactionId, question.interactionId);
      active.props.onDismiss();
    } else {
      const opener = findReactElement(view, e => typeof e.props.onClick === 'function' && e.props['aria-expanded'] === false);
      resting.push(opener);
      if (!frame) opener.props.onClick();
    }
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(frames, 3);
  for (const opener of resting) {
    assert.match(renderToStaticMarkup(opener), /Pending decisions/);
    assert.notEqual(opener.props['aria-haspopup'], 'dialog');
  }
  const plan = { ...decision, plan: { planId: 'plan:upgrade', revision: 3 } };
  assert.equal(mountedRoute(viewOf(() => AgentPlanReview({ ...readOnly, decisions: [plan] }))).props.kind, 'plan',
    'the normal child Plan review remains available even while the parent has a pending item');
});

test('the actual parent composer isolates a forwarded answer draft by parent, child, run and question', async t => {
  const previousStorage = globalThis.sessionStorage, saved = new Map();
  globalThis.sessionStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  t.after(() => { if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage; });
  const [{ useLocalAgentStore: store }, { useAgentComposer }, { ConversationComposer }, { AgentPlanReview }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts', '/src/components/local-agent/ConversationComposer.tsx',
    '/src/components/local-agent/AgentPlanReview.tsx',
  ]);
  const { decision, question } = childInteractionFixture();
  const child = { ...decision, interactionIds: [question.interactionId] }, parent = 'session:parent';
  function route(sessionId, item) {
    const projection = { sessionId, run: null, interactions: [], plans: [], contextCompositions: [], queuedInputs: [], pendingAgentDecisions: [item] };
    store.setState({ sessionId, projection, loading: false, submitting: false });
    Object.assign(store.getInitialState(), store.getState());
    const composer = viewOf(() => useAgentComposer('en-US', () => {}));
    const tree = viewOf(() => ConversationComposer({ composer, showChildDecisions: true, language: 'en-US', uiActionError: null }));
    const entry = findReactElement(tree, e => e.type === AgentPlanReview);
    assert.equal(composer.draft, '', 'the parent ordinary message draft is not a forwarded answer');
    return mountedRoute(viewOf(() => AgentPlanReview(entry.props))).props;
  }
  route(parent, child).onDraftChange('Only this child should receive this answer.');
  for (const [owner, item] of [[parent, { ...child, agentSessionId: 'session:sibling' }], [parent, { ...child, runId: 'run:later' }],
    [parent, { ...child, interactionIds: ['question:other'] }], ['session:another-parent', child]]) {
    assert.equal(route(owner, item).draft, '', 'a different published target never inherits the previous answer');
  }
  assert.equal(route(parent, child).draft, 'Only this child should receive this answer.', 'returning to the exact offer restores the controlled draft');
});

test('deferred child decisions reopen from the main view without reviving a stale or withdrawn item', async t => {
  const [{ AgentPlanReview }] = await loadGuiModules(t, ['/src/components/local-agent/AgentPlanReview.tsx']);
  const { decision } = childInteractionFixture();
  const approval = id => ({ ...decision, interactionIds: [], approval: { callId: `call:${id}`, approvalId: `approval:${id}` } });
  const first = approval('first'), second = approval('second');
  const invitations = [];
  let frame = 0, refreshed = 0;
  // Re-render the same hook owner after its real local actions. No key change or Reader navigation.
  function Probe() {
    const step = frame++;
    const view = AgentPlanReview({ decisions: step === 6 ? [second] : [first, second], language: 'en-US',
      refresh: async () => { refreshed++; } });
    if (step === 2 || step === 4) {
      assert.ok(view, 'all deferred is a non-modal invitation, not a dead end');
      const open = findReactElement(view, e => typeof e.props.onClick === 'function' && e.props['aria-expanded'] === false);
      assert.notEqual(open.props['aria-haspopup'], 'dialog', 'reopening an approval is not a dialog action');
      invitations.push({ view, open });
      open.props.onClick();
    } else if (step === 6) {
      assert.equal(view, null, 'the parent withdrew the first route; the child already reported the second stale');
    } else {
      const active = mountedRoute(view);
      assert.equal(active.props.decision, step === 0 || step === 3 ? first : second);
      if (step === 5) active.props.onResolved(); else active.props.onDismiss();
    }
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(frame, 7);
  assert.equal(refreshed, 1, 'reviewing later or reopening is not a resolution');
  // A nested SSR render clears React's current hook owner; render captured markup after its action sequence.
  assert.equal(invitations.length, 2);
  for (const { view, open } of invitations) {
    assert.doesNotMatch(renderToStaticMarkup(view), /<dialog\b|role="dialog"|aria-modal|aria-haspopup="dialog"/);
    assert.match(renderToStaticMarkup(open), /Pending decisions/);
  }
});
