import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, installGuiFetch } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent,
  waitForAbort, waitForProjection, waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

test('recovery consumes the successful Session receipt, retaining failed drafts and the original session across view changes', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:recovery';
  await createSession(journal, sessionId, []);
  let hold = true, providerStarted = false;
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    providerStarted = true;
    if (hold) { await waitForAbort(signal); return; }
    assert.equal(request.messages.filter(message => message.role === 'user').at(-1).content, history[0].text);
    assert.doesNotMatch(JSON.stringify(request.messages), /submissionId|restoredInputIds|恢复次数/);
    yield providerEvent(request.requestId, 'text.delta', { text: 'Recovery received.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'recovery');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Begin original work.'));
  await waitUntil(() => providerStarted, 'original provider');
  const runId = (await actor.snapshot()).run.runId;
  await actor.submit({ ...messageCommand(sessionId, 'command:old', 'Recover this exact message.'), runId });
  await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId, runId, commandId: 'command:stop' });
  const original = await waitForProjection(actor, value => value.run?.status === 'cancelled');
  assert.equal(original.queuedInputs[0].status, 'notApplied');
  const history = structuredClone(original.queuedInputs);
  hold = false;

  const [{ useAgentComposer }, { useLocalAgentStore: store }, { readResubmittedInputs }, { UnappliedInputs }] = await loadGuiModules(t, [
    '/src/components/local-agent/useAgentComposer.ts', '/src/state/localAgentStore.ts',
    '/src/components/local-agent/composerRecovery.ts', '/src/components/local-agent/UnappliedInputs.tsx',
  ]);
  const previous = { storage: globalThis.sessionStorage, document: globalThis.document }, saved = new Map();
  globalThis.sessionStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  globalThis.document = { activeElement: null };
  t.after(() => { globalThis.sessionStorage = previous.storage; globalThis.document = previous.document; });
  let failed = true, releaseReply, commandAccepted = false;
  const receiptGate = new Promise(resolve => { releaseReply = resolve; });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) {
      if (failed) return Response.json({ ok: false, error: 'original_send_failure', message: 'Connection unavailable.' });
      const command = JSON.parse(init.body), reply = await actor.submit(command);
      assert.equal(command.sessionId, sessionId);
      assert.equal(command.text, history[0].text);
      assert.equal('submissionId' in command, false);
      assert.equal('restoredInputIds' in command, false);
      assert.equal(reply.status, 'accepted', JSON.stringify(reply.error));
      commandAccepted = true;
      await receiptGate;
      return Response.json({ ok: true, data: reply });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'plugins:recovery', plugins: [] } });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  store.setState({ sessionId, projection: original, loading: false, runtimeReady: true, catalogBusy: false,
    selectedProfileId: original.run.profileId, profiles: [{ id: original.run.profileId, enabled: true, thinking: 'disabled' }] });
  let composer;
  function Probe() { composer = useAgentComposer('zh-CN', () => {}); return null; }
  function render() { Object.assign(store.getInitialState(), store.getState()); renderToStaticMarkup(createElement(Probe)); return composer; }
  const html = recovery => renderToStaticMarkup(createElement(UnappliedInputs, { sessionId, inputs: history,
    language: 'zh-CN', copiedId: null, onCopy() {}, onOpenReference() {}, recovery }));
  render().unappliedRecovery.restore(history);
  assert.deepEqual(readResubmittedInputs(sessionId), [], 'draft restoration has no success receipt');
  render();
  assert.equal(html(composer.unappliedRecovery), '', 'restoration itself removes the old reminder without an acceptance receipt');
  assert.equal(composer.canSend, true);
  await composer.submitDraft();
  assert.match(store.getState().error, /original_send_failure/);
  render();
  assert.equal(composer.draft, history[0].text);
  assert.deepEqual(composer.unappliedRecovery.restoredIds, ['command:old']);
  assert.deepEqual(readResubmittedInputs(sessionId), [], 'failed send keeps recovery available');
  assert.equal(html(composer.unappliedRecovery), '', 'failed resubmission retains the recovered draft instead of reopening its old reminder');
  const failedSubmissionId = composer.recoveredContent.submissionId;
  assert.ok(failedSubmissionId);
  assert.deepEqual(store.getState().errorSource, { kind: 'input', submissionId: failedSubmissionId });
  const originalError = store.getState().error;
  store.getState().clearInputError('submission:unrelated');
  assert.equal(store.getState().error, originalError, 'restoring another send must not clear this error');
  store.getState().clearInputError(failedSubmissionId);
  assert.equal(store.getState().error, null, 'only the matching send owner can clear the recovered error');
  const terminalError = { code: 'provider_failed', message: 'Original provider failure' };
  store.setState({ projection: { ...original, terminalError }, error: 'model_settings_failure', errorSource: 'command' });
  store.getState().clearInputError(failedSubmissionId);
  assert.equal(store.getState().error, 'model_settings_failure', 'configuration failures retain their own owner');
  assert.deepEqual(store.getState().projection.terminalError, terminalError, 'draft recovery cannot erase a canonical run failure');
  store.setState({ projection: original });

  failed = false;
  assert.equal(composer.canSend, true);
  const sending = composer.submitDraft();
  try { await waitUntil(() => commandAccepted, 'accepted recovery command'); }
  catch (error) { t.diagnostic(JSON.stringify({error:store.getState().error,submitting:store.getState().submitting})); throw error; }
  assert.deepEqual(readResubmittedInputs(sessionId), [], 'no success is displayed before its receipt arrives');
  const otherSessionId = 'session:other';
  store.setState({ sessionId: otherSessionId, projection: { ...original, sessionId: otherSessionId } });
  releaseReply();
  await sending;
  assert.equal(store.getState().sessionId, otherSessionId);
  assert.deepEqual(readResubmittedInputs(sessionId), ['command:old']);
  assert.deepEqual(readResubmittedInputs(otherSessionId), []);
  assert.match(html(render().unappliedRecovery), /条消息未处理/, 'another session does not consume this receipt');
  const completed = await waitForProjection(actor, value => value.run?.status === 'completed');
  assert.deepEqual(completed.queuedInputs, history, 'resubmission leaves original notApplied facts unchanged');
  store.setState({ sessionId, projection: completed });
  assert.equal(html(render().unappliedRecovery), '', 'a fresh hook/window reload consumes the saved successful receipt');
});


test('editable text and decision replies keep GUI recovery error ownership without changing their wire commands', async t => {
  const [{ createLocalAgentStore }] = await loadGuiModules(t, ['/src/state/localAgentStore.ts']);
  const store = createLocalAgentStore();
  const sessionId = 'session:reply-recovery';
  const interaction = { interactionId: 'interaction:reply', runId: 'run:reply', status: 'pending' };
  store.setState({ sessionId, projection: { sessionId, revision: 3,
    messages: [{ messageId: 'message:editable', role: 'user', content: 'Original text' }],
    pendingPlan: { runId: 'run:reply', planId: 'plan:reply', revision: 1 },
    interactions: [interaction], pendingInteraction: interaction,
  } });
  const commands = [];
  installGuiFetch(t, async (url, init) => {
    assert.ok(url.pathname.endsWith('/commands'));
    const command = JSON.parse(init.body);
    assert.equal('submissionId' in command, false);
    assert.equal('restoredInputIds' in command, false);
    commands.push(command);
    return Response.json({ ok: false, error: 'reply_send_failed', message: 'Connection unavailable.' });
  });
  const cases = [
    { type: 'message.edit', send: id => store.getState().editMessage('message:editable', 'Edited text', 3, id),
      check: command => assert.equal(command.text, 'Edited text') },
    { type: 'plan.respond', send: id => store.getState().respondPlan({ kind: 'requestRevision', text: 'Revise this step' }, id),
      check: command => assert.deepEqual(command.response, { kind: 'requestRevision', text: 'Revise this step' }) },
    { type: 'interaction.respond', send: id => store.getState().respondInteraction('My answer', interaction.interactionId, id),
      check: command => assert.equal(command.response, 'My answer') },
  ];
  for (const scenario of cases) {
    const submissionId = `submission:${scenario.type}`;
    await assert.rejects(scenario.send(submissionId), /reply_send_failed/);
    const command = commands.at(-1);
    assert.equal(command.type, scenario.type);
    scenario.check(command);
    assert.deepEqual(store.getState().errorSource, { kind: 'input', submissionId });
    store.getState().clearInputError('submission:another-draft');
    assert.match(store.getState().error, /reply_send_failed/);
    store.getState().clearInputError(submissionId);
    assert.equal(store.getState().error, null);
    assert.equal(store.getState().errorSource, null);
  }
  await assert.rejects(store.getState().respondPlan({ kind: 'confirm' }), /reply_send_failed/);
  assert.deepEqual(commands.at(-1).response, { kind: 'confirm' });
  assert.equal(store.getState().errorSource, 'command', 'non-text decisions retain their existing owner');
  store.getState().clearInputError('submission:plan.respond');
  assert.match(store.getState().error, /reply_send_failed/);
});
