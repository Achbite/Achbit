import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

const reason = '需要用户确认本轮修改的目录与范围。\n计划尚未获得执行授权，确认前保留这段原始说明。';
const rootPath = '/projects/团队共享工作区/待确认的计划与验收资料/本轮允许访问的目录';
const plan = { planId: 'plan:review', runId: 'run:review', revision: 2, status: 'pending',
  title: '整理工作区报告', steps: [], mutationManifest: [],
  review: { status: 'completed', decision: 'ask', reason } };

function composerFor(pendingPlan) {
  return { pendingPlan, pendingScopeAddition: null, pendingApproval: null, pendingInteraction: null,
    profiles: [], selectedProfileId: null, draft: '保留现有报告', pastedTexts: [], pastedImages: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    submitting: false, canSend: true, showStopAction: false, textDecision: true,
    projection: { sessionId: 'session:review', pendingPlan, plans: [pendingPlan], interactions: [], workspaceBindings: [], contextCompositions: [], queuedInputs: [],
      run: { runId: pendingPlan.runId, status: 'waiting', waitingReason: 'plan' },
      effectivePermissions: { 'agent.permissions.workspaceMutation': 'review' } },
  };
}

function capturePanels(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

function button(tree, label) {
  return findReactElement(tree, node => node.type === 'button' && renderToStaticMarkup(node).includes(label));
}

test('completed Plan reviews retain their reason, workspace paths and independent revision input', async t => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ ConversationComposer }] = await loadGuiModules(t, ['/src/components/local-agent/ConversationComposer.tsx']);
  for (const pendingPlan of [plan, { ...plan, workspaceRequests: [{ workspaceId: 'workspace:extra', rootPath }] }]) {
    const composer = composerFor(pendingPlan), before = structuredClone(composer);
    const html = renderToStaticMarkup(createElement(ConversationComposer, { language: 'zh-CN', composer, uiActionError: null }));
    assert.equal(html.split(reason).length - 1, 1, 'the complete recorded reason is displayed once');
    assert.match(html, /需要你决定的原因/);
    assert.match(html, /确认执行|加入工作区并确认计划/);
    assert.match(html, /aria-label="关闭方案确认"/);
    assert.match(html, /取消并停止/);
    assert.match(html, /aria-label="提交修改意见"/);
    assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
    assert.match(html, /保留现有报告<\/textarea>/);
    assert.doesNotMatch(html, /工具权限|允许本会话/);
    if (pendingPlan.workspaceRequests) {
      assert.ok(html.includes(rootPath));
      assert.match(html, /不加入并取消计划/);
      assert.doesNotMatch(html, /workspace:extra/);
    }
    assert.deepEqual(composer, before, 'rendering does not resolve the Plan or alter its projection');
  }
});

test('Plan confirmation and workspace rejection keep their original decision routes and submitting state', async t => {
  const [{ ComposerDecisionPanels, ComposerQuestionPrompt }] = await loadGuiModules(t,
    ['/src/components/local-agent/ComposerDecisionPanels.tsx']);
  for (const pendingPlan of [plan, { ...plan, workspaceRequests: [{ workspaceId: 'workspace:extra', rootPath }] }]) {
    const decisions = [], composer = { ...composerFor(pendingPlan), submitPlanDecision: async response => { decisions.push(response); },
      respondApproval: () => assert.fail('a Plan control must not approve a tool'),
      respondInteraction: () => assert.fail('a Plan control must not answer a question') };
    const before = structuredClone(composer.projection);
    const tree = capturePanels(ComposerDecisionPanels, { language: 'zh-CN', composer });
    assert.deepEqual(decisions, [], 'display alone does not authorize anything');
    const confirmLabel = pendingPlan.workspaceRequests ? '加入工作区并确认计划' : '确认执行';
    const confirm = button(tree, confirmLabel);
    assert.equal(confirm.props.disabled, false);
    confirm.props.onClick();
    if (pendingPlan.workspaceRequests) button(tree, '不加入并取消计划').props.onClick();
    else {
      const prompt = ComposerQuestionPrompt({ language: 'zh-CN', composer });
      findReactElement(prompt, node => node.props['aria-label'] === '关闭方案确认').props.onClick();
    }
    assert.deepEqual(decisions, [{ kind: 'confirm' }, { kind: 'cancel' }]);
    assert.deepEqual(composer.projection, before, 'only a Session reply may update the authoritative Plan');
    const busy = capturePanels(ComposerDecisionPanels, { language: 'zh-CN', composer: { ...composer, submitting: true } });
    assert.equal(button(busy, confirmLabel).props.disabled, true);
    if (pendingPlan.workspaceRequests) assert.equal(button(busy, '不加入并取消计划').props.disabled, true);
  }
});

test('taking over Plan review only requests manual Plan approval and retains the pending Plan', async t => {
  const [{ ComposerDecisionPanels }] = await loadGuiModules(t, ['/src/components/local-agent/ComposerDecisionPanels.tsx']);
  const pendingPlan = { ...plan, review: { status: 'reviewing', providerRequestId: 'provider:plan-review' } };
  const composer = composerFor(pendingPlan), patches = [];
  composer.projection.run = { runId: pendingPlan.runId, status: 'running' };
  composer.submitPlanDecision = () => assert.fail('takeover is not a Plan decision');
  composer.respondApproval = () => assert.fail('takeover is not tool approval');
  const before = structuredClone(composer.projection);
  const props = { language: 'zh-CN', composer, onSetPermissions: async patch => { patches.push(patch); } };
  const tree = capturePanels(ComposerDecisionPanels, props);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /role="status">正在审批计划/);
  assert.doesNotMatch(html, /需要你决定的原因|确认执行|工具权限/);
  assert.deepEqual(patches, []);
  button(tree, '改为询问').props.onClick();
  assert.deepEqual(patches, [{ 'agent.permissions.workspaceMutation': 'plan' }]);
  assert.deepEqual(composer.projection, before);
  const busy = capturePanels(ComposerDecisionPanels, { ...props, composer: { ...composer, submitting: true } });
  assert.equal(button(busy, '改为询问').props.disabled, true);
  const manual = capturePanels(ComposerDecisionPanels, { ...props, composer: { ...composer,
    projection: { ...composer.projection, effectivePermissions: { 'agent.permissions.workspaceMutation': 'plan' } },
  } });
  assert.match(renderToStaticMarkup(manual), /确认执行/);
  assert.doesNotMatch(renderToStaticMarkup(manual), /正在审批计划/);
  assert.deepEqual(patches, [{ 'agent.permissions.workspaceMutation': 'plan' }], 'rendering the new mode submits no extra command');
});

test('a revision after Plan review sends the original text as a Plan response rather than a message or approval', async t => {
  const draft = '只整理已确认的目录。\n保留原始报告，不执行额外命令。';
  const previousStorage = globalThis.sessionStorage, previousDocument = globalThis.document;
  globalThis.sessionStorage = { getItem: key => key.startsWith('achbit:composer:')
    ? JSON.stringify({ draft, pastedTexts: [], pastedImages: [], filesystemPaths: [], pluginSelections: [] }) : null, setItem() {}, removeItem() {} };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const [{ useLocalAgentStore: store }, { useAgentComposer }] = await loadGuiModules(t,
    ['/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts']);
  globalThis.document = { activeElement: null };
  const projection = composerFor(plan).projection, before = structuredClone(projection), responses = [];
  store.setState({ sessionId: projection.sessionId, projection, loading: false, submitting: false, catalogBusy: false,
    profiles: [], selectedProfileId: null, respondPlan: async response => { responses.push(response); },
    respondApproval: () => assert.fail('revision must not approve a tool'),
    respondInteraction: () => assert.fail('revision must not answer a question'),
    sendMessage: () => assert.fail('revision must not become an ordinary message') });
  Object.assign(store.getInitialState(), store.getState());
  let composer;
  function Probe() { composer = useAgentComposer('zh-CN', () => {}); return null; }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(composer.canSend, true);
  await composer.submitDraft();
  assert.deepEqual(responses, [{ kind: 'requestRevision', text: draft }]);
  assert.deepEqual(projection, before);
});
