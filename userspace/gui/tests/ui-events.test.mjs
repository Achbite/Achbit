import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, installGuiFetch, loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent,
  waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';

// SSR normally skips effects. Capture the production callbacks while leaving all
// other hooks with the renderer, then exercise setup/cleanup with controlled time.
function captureEffects(render, effects) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = internals.H;
  internals.H = { ...dispatcher, useEffect: callback => { effects.push(callback); } };
  try { return render(); } finally { internals.H = dispatcher; }
}

test('one key refreshes a notice instead of stacking duplicates, and the stack stays bounded', async t => {
  const { UiEvents, UI_EVENT_TTL_MS } = await loadGuiModule(t, '/src/state/uiEvents.ts');
  const events = new UiEvents();
  t.after(() => events.clear());
  const first = events.publish({ key: 'handoff:one', text: '已切换至 HY4', tone: 'success' });
  assert.equal(first.ttlMs, UI_EVENT_TTL_MS, 'notification-type UI owns a default lifetime');
  const refreshed = events.publish({ key: 'handoff:one', text: '已切换至 HY4 · 重试' });
  assert.equal(refreshed.id, first.id, 'the same fact keeps its notice');
  assert.deepEqual(events.snapshot().map(event => event.text), ['已切换至 HY4 · 重试']);
  for (const key of ['a', 'b', 'c', 'd']) events.publish({ key, text: key });
  assert.deepEqual(events.snapshot().map(event => event.key), ['b', 'c', 'd'], 'older notices do not grow the stack');
  events.dismiss('c');
  assert.deepEqual(events.snapshot().map(event => event.key), ['b', 'd']);
  events.clear();
  assert.deepEqual(events.snapshot(), []);
});

test('notification-type UI leaves on its own until it is dismissed or republished', async t => {
  const { UiEvents, UI_EVENT_TTL_MS } = await loadGuiModule(t, '/src/state/uiEvents.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new UiEvents();
  t.after(() => events.clear());
  events.publish({ key: 'switched', text: '已切换至 HY4' });
  t.mock.timers.tick(UI_EVENT_TTL_MS - 1);
  assert.equal(events.snapshot().length, 1);
  events.publish({ key: 'switched', text: '已切换至 HY4' });
  t.mock.timers.tick(1);
  assert.equal(events.snapshot().length, 1, 'the old expiry cannot remove the refreshed notice');
  t.mock.timers.tick(UI_EVENT_TTL_MS - 1);
  assert.deepEqual(events.snapshot(), [], 'expiry removes the notice without any user action');
  const observed = [];
  const unsubscribe = events.subscribe(() => observed.push(events.snapshot()));
  events.publish({ key: 'sticky', text: 'x', ttlMs: 0 });
  assert.deepEqual(events.snapshot(), [], 'a zero lifetime publishes nothing observable');
  assert.deepEqual(observed, []);
  unsubscribe();
});

test('notice identity, capacity and cleanup belong to each Session', async t => {
  const { UiEvents } = await loadGuiModule(t, '/src/state/uiEvents.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');
  const events = new UiEvents();
  t.after(() => events.clear());
  const a = events.publish({ key: 'saved', sessionId: 'a', text: 'Saved A' });
  const b = events.publish({ key: 'saved', sessionId: 'b', text: 'Saved B' });
  assert.notEqual(a.id, b.id, 'the same producer key cannot replace another Session');
  for (const key of ['one', 'two', 'three']) events.publish({ key, sessionId: 'b', text: key });
  assert.ok(events.snapshot().some(event => event.id === a.id), 'activity elsewhere cannot evict A');
  assert.deepEqual(events.snapshot().filter(event => event.sessionId === 'b').map(event => event.key), ['one', 'two', 'three']);
  assert.equal(clearTimer.mock.callCount(), 1, 'eviction releases the old timer');
  events.dismiss('saved', 'a');
  assert.equal(clearTimer.mock.callCount(), 2);
  const global = events.publish({ key: 'saved', text: 'Global' });
  events.clear('b');
  assert.deepEqual(events.snapshot().map(event => event.id), [global.id]);
  assert.equal(clearTimer.mock.callCount(), 5, 'clearing one Session releases only its timers');
  events.clear();
  assert.equal(clearTimer.mock.callCount(), 6);
  let changes = 0;
  const unsubscribe = events.subscribe(() => changes++);
  t.mock.timers.tick(60_000);
  assert.equal(changes, 0, 'dismissed notices cannot come back through an old timer');
  unsubscribe();
});

test('the notice is rendered where the conversation ends and stays scoped to its Session', async t => {
  const [{ uiEvents }, { UiEventStack }, { CloseButton }] = await loadGuiModules(t, [
    '/src/state/uiEvents.ts', '/src/components/local-agent/UiEventStack.tsx', '/src/ui-components/index.ts',
  ]);
  t.after(() => uiEvents.clear());
  uiEvents.publish({ key: 'handoff:session:1:run:2', sessionId: 'session:1', tone: 'success', text: '已切换至 HY4' });
  const html = renderToStaticMarkup(createElement(UiEventStack, { sessionId: 'session:1', language: 'zh-CN' }));
  assert.match(html, /local-agent__ui-event--success/);
  assert.match(html, /已切换至 HY4/);
  assert.match(html, /aria-label="关闭提示"/);
  assert.match(html, /data-ui-component="CloseButton"/);
  assert.match(html, /data-ui-owner="conversation.notices"/);
  assert.equal(renderToStaticMarkup(createElement(UiEventStack, { sessionId: 'session:2', language: 'zh-CN' })), '',
    'another conversation never shows this notice');
  assert.equal(renderToStaticMarkup(createElement(UiEventStack, { language: 'zh-CN' })), '',
    'a view without a Session must not expose all conversations');
  let view;
  function Probe() { view = UiEventStack({ sessionId: 'session:1', language: 'zh-CN' }); return null; }
  renderToStaticMarkup(createElement(Probe));
  findReactElement(view, node => node.type === CloseButton).props.onClick();
  assert.equal(renderToStaticMarkup(createElement(UiEventStack, { sessionId: 'session:1', language: 'zh-CN' })), '');
});

test('a completed model handoff is a notice, not a permanent conversation state', async t => {
  const [{ runHandoffNotice }, { RunFailureDetails }] = await loadGuiModules(t, [
    '/src/state/handoffNotice.ts', '/src/components/local-agent/RunFailureDetails.tsx',
  ]);
  const projection = { sessionId: 'session:1', revision: 2, run: { runId: 'run:2', status: 'completed' }, providerAttempts: [],
    contextHandoff: { status: 'ready', runId: 'run:2', profileId: 'profile:hy4' } };
  const previous = { ...projection, revision: 1, contextHandoff: { ...projection.contextHandoff, status: 'reading' } };
  assert.deepEqual(runHandoffNotice(previous, projection, 'HY4', 'zh-CN'), { key: 'handoff:session:1:run:2', sessionId: 'session:1',
    tone: 'success', text: '已切换至 HY4' });
  assert.equal(runHandoffNotice(previous, projection, 'HY4', 'en-US').text, 'Switched to HY4');
  assert.equal(runHandoffNotice(previous, projection, undefined, 'zh-CN').text, '已切换至 profile:hy4',
    'the profile id identifies the target while the model name is still loading');
  assert.equal(runHandoffNotice(previous, { ...projection, run: { runId: 'run:3', status: 'completed' } }, 'HY4', 'zh-CN'), null,
    'a later run never inherits the earlier notice');
  assert.equal(runHandoffNotice(undefined, projection, 'HY4', 'zh-CN'), null, 'initial history is a baseline');
  assert.equal(runHandoffNotice({ ...previous, sessionId: 'other' }, projection, 'HY4', 'zh-CN'), null);
  assert.equal(runHandoffNotice(previous, previous, 'HY4', 'zh-CN'), null);
  assert.equal(runHandoffNotice(projection, { ...projection, revision: 3 }, 'Renamed HY4', 'en-US'), null);
  assert.equal(renderToStaticMarkup(createElement(RunFailureDetails, { language: 'zh-CN', onError() {}, projection })), '',
    'the transcript no longer keeps the switch line after the run continues');
});

test('GUI projection reads publish a handoff once without replaying history, navigation or expired notices', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:notice';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    yield providerEvent(request.requestId, 'text.delta', { text: 'Finished.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'notice');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:notice', 'Test notice ownership.'));
  const base = await waitForProjection(actor, projection => projection.run?.status === 'completed');
  const [{ useLocalAgentStore: store }, { uiEvents, UI_EVENT_TTL_MS }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/uiEvents.ts',
  ]);
  t.after(() => uiEvents.clear());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = { ...base, contextHandoff: { runId: base.run.runId, historyThroughSequence: 1,
    previousProfileId: 'profile:old', profileId: base.run.profileId, status: 'ready' } };
  const other = { ...base, sessionId: 'session:other' };
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [current, other].map(projection => ({
      sessionId: projection.sessionId, revision: projection.revision,
      run: { runId: projection.run.runId, status: projection.run.status },
    })) });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true,
      data: decodeURIComponent(url.pathname).includes(other.sessionId) ? other : current });
    throw new Error(`unexpected_request:${url.pathname}`);
  });
  store.setState({ runtimeReady: true, catalog: { projects: [], sessions: [current, other].map(projection => ({
    id: projection.sessionId, projectId: null, title: projection.sessionId, profileId: base.run.profileId,
  })) }, profiles: [{ id: base.run.profileId, name: 'HY4' }] });
  await store.getState().activateSession(sessionId);
  assert.equal(store.getState().error, null);
  assert.deepEqual(uiEvents.snapshot(), [], 'loading a completed handoff does not notify');
  current = { ...current, revision: current.revision + 1, run: { ...base.run, runId: 'run:next' },
    contextHandoff: { ...current.contextHandoff, runId: 'run:next', status: 'reading' } };
  await store.getState().refresh();
  assert.deepEqual(uiEvents.snapshot(), []);
  current = { ...current, revision: current.revision + 1, contextHandoff: { ...current.contextHandoff, status: 'ready' } };
  await store.getState().refresh();
  assert.equal(store.getState().error, null);
  assert.deepEqual(uiEvents.snapshot().map(event => event.text), ['已切换至 HY4']);
  uiEvents.dismiss(uiEvents.snapshot()[0].id);
  store.setState({ profiles: [{ id: base.run.profileId, name: 'Renamed HY4' }] });
  await store.getState().activateSession(other.sessionId);
  await store.getState().activateSession(sessionId);
  current = { ...current, revision: current.revision + 1 };
  await store.getState().refresh();
  assert.deepEqual(uiEvents.snapshot(), [], 'a dismissed transition is not republished by navigation or later reads');
  current = { ...current, revision: current.revision + 1, run: { ...base.run, runId: 'run:fast' },
    contextHandoff: { ...current.contextHandoff, runId: 'run:fast' } };
  await store.getState().refresh();
  assert.equal(uiEvents.snapshot().length, 1, 'a new handoff is recognized even if its reading stage was brief');
  t.mock.timers.tick(UI_EVENT_TTL_MS);
  await store.getState().activateSession(other.sessionId);
  await store.getState().activateSession(sessionId);
  assert.deepEqual(uiEvents.snapshot(), [], 'expiration also survives returning to the conversation');
});

test('local feedback shares the notice lifetime and releases its timer on replacement or unmount', async t => {
  const effects = [];
  let dismissed = 0;
  const [{ useAutoDismiss }, { UI_EVENT_TTL_MS }] = await loadGuiModules(t, [
    '/src/components/shared/useAutoDismiss.ts', '/src/state/uiEvents.ts',
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  function Probe({ feedback, delay }) {
    captureEffects(() => useAutoDismiss(feedback, () => dismissed++, delay), effects);
    return null;
  }
  const mount = (feedback, delay) => { renderToStaticMarkup(createElement(Probe, { feedback, delay })); return effects.pop()(); };
  let cleanup = mount('Saved');
  t.mock.timers.tick(UI_EVENT_TTL_MS - 1); assert.equal(dismissed, 0);
  t.mock.timers.tick(1); assert.equal(dismissed, 1); cleanup();
  cleanup = mount({ copied: 'same item' }, 1500);
  t.mock.timers.tick(1000); cleanup();
  cleanup = mount({ copied: 'same item' }, 1500);
  t.mock.timers.tick(500); assert.equal(dismissed, 1, 'a repeated copy receives a fresh lifetime');
  t.mock.timers.tick(1000); assert.equal(dismissed, 2); cleanup();
  cleanup = mount('Saved'); cleanup();
  t.mock.timers.tick(UI_EVENT_TTL_MS); assert.equal(dismissed, 2, 'unmounted feedback cannot dismiss a later owner');
  assert.equal(mount(null), undefined);
});

test('composer failures stay with their owner until explicitly dismissed', async t => {
  const effects = [], dismissed = [];
  const [{ ConversationComposer }, { DismissibleError }, { useAutoDismiss }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationComposer.tsx', '/src/components/local-agent/DismissibleError.tsx',
    '/src/components/shared/useAutoDismiss.ts',
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  function TimerProbe() { captureEffects(() => useAutoDismiss('copied', () => {}), effects); return null; }
  renderToStaticMarkup(createElement(TimerProbe));
  assert.equal(effects.length, 1, 'this harness observes real effects rather than relying on SSR to skip them');
  effects.length = 0;
  const composer = { recoveredContent: { filesystemReferences: [], guidanceReferences: [] },
    profiles: [], draft: '', pastedTexts: [], pastedImages: [], failedDrafts: [],
    pendingFilesystemPaths: [], pluginSelections: [], filteredPlugins: [], commandSuggestions: [], textareaRef: { current: null },
    error: 'original_send_failure', attachmentError: 'original_attachment_failure',
    clearError: () => dismissed.push('send'), clearAttachmentError: () => dismissed.push('attachment') };
  let view;
  function Probe() {
    view = captureEffects(() => ConversationComposer({ composer, language: 'zh-CN', uiActionError: 'original_copy_failure',
      onDismissUiActionError: () => dismissed.push('copy') }), effects);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const cleanups = effects.map(effect => effect());
  t.after(() => cleanups.forEach(cleanup => cleanup?.()));
  t.mock.timers.tick(60_000);
  assert.deepEqual(dismissed, [], 'elapsed time cannot clear real failures');
  for (const message of ['original_send_failure', 'original_attachment_failure', 'original_copy_failure']) {
    findReactElement(view, node => node.type === DismissibleError && node.props.children === message).props.onDismiss();
  }
  assert.deepEqual(dismissed, ['send', 'attachment', 'copy'], 'explicit dismissal keeps each error owner');
});
