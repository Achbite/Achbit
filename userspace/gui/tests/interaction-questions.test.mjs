import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

test('foreground questions retain their full history card and both answer entrances use the original question', async t => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ InteractionCard }, { ComposerQuestionPrompt }] = await loadGuiModules(t, [
    '/src/components/local-agent/InteractionCard.tsx', '/src/components/local-agent/ComposerDecisionPanels.tsx',
  ]);
  const interaction = { interactionId: 'question:one', status: 'pending', kind: 'question',
    prompt: 'Which scope should we inspect?', allowFreeform: true, options: [{ id: 'narrow', label: 'This window' }] };
  const render = (Component, props) => renderToStaticMarkup(createElement(Component, { language: 'en-US', ...props }));
  const foreground = render(ComposerQuestionPrompt, { composer: { pendingInteraction: interaction } });
  assert.match(foreground, /Which scope should we inspect\?/);
  assert.match(foreground, /id="conversation-interaction"/);
  const deferred = render(InteractionCard, { interaction });
  assert.match(deferred, /Which scope should we inspect\?/);
  assert.match(deferred, /This window/);
  assert.equal((deferred.match(/<textarea/g) ?? []).length, 1);
  const answered = render(InteractionCard, { interaction: { ...interaction, status: 'answered', response: 'narrow' } });
  assert.match(answered, /This window/);
  assert.doesNotMatch(answered, /<textarea/);
});

test('all current unanswered questions come forward only at the user-input wait and withdraw when work resumes', async t => {
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  t.after(() => { if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage; });
  const [{ useLocalAgentStore: store }, { useAgentComposer }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
  ]);
  const questions = Array.from({ length: 5 }, (_, index) => ({ interactionId: `question:${index}`, runId: 'run:current',
    kind: 'question', mode: 'continue', status: 'pending', prompt: `Question ${index + 1}`, allowFreeform: true }));
  const interactions = [
    { ...questions[0], interactionId: 'question:previous-run', runId: 'run:previous' },
    { ...questions[0], interactionId: 'question:answered', status: 'answered', response: 'Already answered' },
    { ...questions[0], interactionId: 'question:closed', status: 'closed' },
    ...questions,
  ];
  let composer;
  function Probe() { composer = useAgentComposer('en-US', () => {}); return null; }
  const render = (run, currentInteractions = interactions) => {
    const projection = { sessionId: 'session:questions', interactions: currentInteractions, pendingInteraction: questions[0], plans: [], run };
    const before = structuredClone(projection);
    store.setState({ sessionId: projection.sessionId, projection, loading: false, submitting: false });
    Object.assign(store.getInitialState(), store.getState());
    renderToStaticMarkup(createElement(Probe));
    assert.deepEqual(projection, before, 'presentation does not rewrite pending questions or the run');
    return composer;
  };
  for (const run of [
    { runId: 'run:current', status: 'running' },
    { runId: 'run:current', status: 'waiting', waitingReason: 'approval' },
    { runId: 'run:current', status: 'waiting', waitingReason: 'plan' },
  ]) {
    assert.equal(render(run).pendingInteraction, null);
    assert.equal(composer.interactionNavigation, null);
    assert.equal(composer.textDecision, false, 'open questions alone never take over the ordinary composer');
  }
  const waiting = { runId: 'run:current', status: 'waiting', waitingReason: 'userInput' };
  assert.equal(render(waiting).pendingInteraction.interactionId, questions[0].interactionId);
  assert.equal(composer.interactionNavigation.count, 5, 'the total is not capped at the example count of three');
  assert.equal(composer.textDecision, true);
  const updated = interactions.map(item => item.interactionId === questions[0].interactionId ? { ...item, status: 'answered' } : item);
  assert.equal(render(waiting, updated).pendingInteraction.interactionId, questions[1].interactionId);
  assert.equal(composer.interactionNavigation.count, 4);
  assert.equal(render({ runId: 'run:current', status: 'running' }, updated).pendingInteraction, null);
  assert.equal(render({ runId: 'run:current', status: 'cancelled' }, updated).pendingInteraction, null);
});

test('question header shows the dynamic page count and navigation never submits an answer', async t => {
  const [{ ComposerQuestionPrompt }] = await loadGuiModules(t, ['/src/components/local-agent/ComposerDecisionPanels.tsx']);
  const moves = [], answers = [];
  for (const index of [0, 3, 6]) {
    const composer = { pendingInteraction: { interactionId: `question:${index}`, prompt: `Question ${index + 1}` },
      interactionNavigation: { index, count: 7, previous: () => moves.push(index - 1), next: () => moves.push(index + 1) },
      respondInteraction: answer => answers.push(answer) };
    const tree = ComposerQuestionPrompt({ language: 'en-US', composer });
    const html = renderToStaticMarkup(tree);
    assert.match(html, new RegExp(`${index + 1}/7`));
    const previous = findReactElement(tree, node => node.props['aria-label'] === 'Previous question');
    const next = findReactElement(tree, node => node.props['aria-label'] === 'Next question');
    assert.equal(previous.props.disabled, index === 0);
    assert.equal(next.props.disabled, index === 6);
    if (!previous.props.disabled) previous.props.onClick();
    if (!next.props.disabled) next.props.onClick();
  }
  assert.deepEqual(moves, [1, 2, 4, 5]);
  assert.deepEqual(answers, []);
});

test('shared question choices send stable IDs even when labels match and never invent Markdown choices', async t => {
  const [{ InteractionOptions }] = await loadGuiModules(t, ['/src/components/local-agent/InteractionOptions.tsx']);
  const answers = [];
  const choices = InteractionOptions({ options: [{ id: 'first', label: 'Continue' }, { id: 'second', label: 'Continue' }],
    disabled: false, onAnswer: id => answers.push(id) });
  choices.props.children[1].props.onClick();
  assert.deepEqual(answers, ['second']);
  assert.equal(InteractionOptions({ options: undefined, disabled: false, onAnswer() {} }), null);
});

test('concurrent approval and text decisions expose separate views without mixing their controls', async t => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ ConversationComposer }] = await loadGuiModules(t, ['/src/components/local-agent/ConversationComposer.tsx']);
  const base = {
    profiles: [], selectedProfileId: null, draft: 'Keep the existing configuration', pastedTexts: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    textDecision: true, canSend: true, showStopAction: false,
    pendingApproval: { approvalId: 'approval:build', preview: { summary: 'Build the Debug application', effects: [], logicalTargets: [] } },
  };
  for (const decision of [
    { pendingInteraction: { interactionId: 'question:scope', kind: 'question', prompt: 'Which test scope?', allowFreeform: true,
      options: [{ id: 'full', label: 'Full pipeline' }] } },
    { pendingPlan: { planId: 'plan:scope', revision: 1, title: 'Prepare the test workspace' } },
  ]) {
    const composer = { ...base, ...decision }, before = structuredClone({ draft: composer.draft, ...decision, pendingApproval: composer.pendingApproval });
    const html = renderToStaticMarkup(createElement(ConversationComposer, { language: 'en-US', composer, uiActionError: null }));
    assert.match(html, /aria-label="Pending decisions"/);
    assert.match(html, /aria-pressed="true"[^>]*>[\s\S]*?Tool permission/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /Build the Debug application/);
    assert.doesNotMatch(html, /Which test scope\?|Full pipeline|Prepare the test workspace|<textarea/);
    assert.deepEqual({ draft: composer.draft, ...decision, pendingApproval: composer.pendingApproval }, before);
    const remaining = renderToStaticMarkup(createElement(ConversationComposer, {
      language: 'en-US', composer: { ...composer, pendingApproval: null }, uiActionError: null,
    }));
    assert.doesNotMatch(remaining, /Build the Debug application|aria-label="Pending decisions"/);
    assert.match(remaining, /Keep the existing configuration<\/textarea>/);
    assert.ok(remaining.includes(decision.pendingPlan?.title ?? decision.pendingInteraction.prompt));
  }
});

test('reply text and navigation use the answered question label without rewriting recorded responses', async t => {
  const [{ messageDisplayText }, { conversationNavigation }] = await loadGuiModules(t, [
    '/src/components/local-agent/interactionPresentation.ts', '/src/components/local-agent/conversationWindow.ts',
  ]);
  const questions = [
    { interactionId: 'earlier', options: [{ id: 'same-id', label: 'Wrong question' }] },
    { interactionId: 'current', options: [{ id: 'same-id', label: 'Inspect this window' }] },
  ];
  const message = { role: 'user', content: 'same-id', replyToInteraction: { interactionId: 'current', prompt: 'Choose' }, filesystemReferences: [] };
  assert.equal(messageDisplayText(message, questions), 'Inspect this window');
  assert.equal(messageDisplayText({ ...message, content: 'My own answer' }, questions), 'My own answer');
  const rounds = [{ rows: [{ key: 'reply', item: { type: 'message', value: message } }] }];
  assert.equal(conversationNavigation(rounds, questions)[0].label, 'Inspect this window');
  assert.equal(message.content, 'same-id');
});
