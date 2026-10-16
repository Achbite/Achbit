import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';

test('waiting questions have one full prompt while deferred and answered cards retain their content', async t => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ InteractionCard }, { ComposerQuestionPrompt }] = await loadGuiModules(t, [
    '/src/components/local-agent/InteractionCard.tsx', '/src/components/local-agent/ComposerDecisionPanels.tsx',
  ]);
  const interaction = { interactionId: 'question:one', status: 'pending', kind: 'question',
    prompt: 'Which scope should we inspect?', allowFreeform: true, options: [{ id: 'narrow', label: 'This window' }] };
  const render = (Component, props) => renderToStaticMarkup(createElement(Component, { language: 'en-US', ...props }));
  const waiting = render(InteractionCard, { interaction, answerInComposer: true })
    + render(ComposerQuestionPrompt, { composer: { pendingInteraction: interaction } });
  assert.equal(waiting.split(interaction.prompt).length - 1, 1);
  assert.match(waiting, /aria-controls="conversation-interaction"/);
  assert.match(waiting, /id="conversation-interaction"/);
  assert.doesNotMatch(waiting, /<textarea/);
  const deferred = render(InteractionCard, { interaction });
  assert.match(deferred, /Which scope should we inspect\?/);
  assert.match(deferred, /This window/);
  assert.equal((deferred.match(/<textarea/g) ?? []).length, 1);
  const answered = render(InteractionCard, { interaction: { ...interaction, status: 'answered', response: 'narrow' } });
  assert.match(answered, /This window/);
  assert.doesNotMatch(answered, /<textarea/);
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
