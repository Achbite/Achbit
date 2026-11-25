import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMMAND_REPLY_VERSION } from '../../protocol/dist/index.js';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { findReactElement, installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

const input = id => ({ commandId: id, messageId: `message:${id}`, runId: 'run:ended', status: 'notApplied',
  text: `Unsent ${id}`, filesystemReferences: [], pluginSelections: [], sequence: 2, createdAt: '2026-11-15T00:00:00Z' });
function storage(t) {
  const previous = globalThis.sessionStorage, values = new Map();
  globalThis.sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
  t.after(() => { globalThis.sessionStorage = previous; });
  return values;
}
function mounted(Component, props) {
  const slots = []; let cursor = 0, tree;
  function Probe() {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, original = internals.H;
    cursor = 0;
    internals.H = { ...original, useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    } };
    try { tree = Component(props); return tree; } finally { internals.H = original; }
  }
  return { render: () => renderToStaticMarkup(createElement(Probe)), tree: () => tree,
    click(action) {
      const button = findReactElement(tree, node => node.props['data-ui-action'] === `conversation.unapplied-inputs.${action}`);
      let prevented = false;
      button.props.onClick({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true, 'an action suppresses unrelated default activation');
    } };
}
const propsFor = inputs => ({ sessionId: 'session:reminders', inputs, language: 'zh-CN', copiedId: null, onCopy() {}, onOpenReference() {} });

test('details toggles explicitly; restore confirmation and cancellation do not toggle the disclosure', async t => {
  storage(t);
  const [{ UnappliedInputs }] = await loadGuiModules(t, ['/src/components/local-agent/UnappliedInputs.tsx']);
  const inputs = [input('one')], before = structuredClone(inputs), calls = [];
  const props = { ...propsFor(inputs), recovery: { restoredIds: [], inDecision: false, canUndo: false, undo() {},
    restore(items, append) { calls.push({ items, append }); if (!append) throw Error('composer_restore_append_confirmation'); } } };
  const view = mounted(UnappliedInputs, props);
  const expanded = () => findReactElement(view.tree(), node => node.props['data-ui-action'] === 'conversation.unapplied-inputs.toggle').props['aria-expanded'];
  view.render(); assert.equal(expanded(), false);
  view.click('toggle'); view.render(); assert.equal(expanded(), true);
  view.click('toggle'); view.render(); assert.equal(expanded(), false);
  view.click('restore-all');
  assert.match(view.render(), /草稿已有内容，要追加吗/);
  assert.equal(expanded(), false);
  findReactElement(view.tree(), node => node.props.children === '取消').props.onClick({ preventDefault() {} });
  assert.doesNotMatch(view.render(), /草稿已有内容，要追加吗/);
  assert.equal(calls.length, 1);
  view.click('restore-all'); view.render(); view.click('confirm-append');
  assert.equal(calls.at(-1).append, true);
  assert.doesNotMatch(view.render(), /草稿已有内容，要追加吗/);
  assert.deepEqual(inputs, before);
});

test('dismissal survives remounts, stays session-scoped, and never hides later input identities', async t => {
  storage(t);
  const [{ UnappliedInputs }] = await loadGuiModules(t, ['/src/components/local-agent/UnappliedInputs.tsx']);
  const inputs = [input('one')], before = structuredClone(inputs), props = propsFor(inputs);
  const view = mounted(UnappliedInputs, props);
  assert.match(view.render(), /1 条消息未处理/);
  view.click('dismiss'); assert.equal(view.render(), '');
  assert.equal(renderToStaticMarkup(createElement(UnappliedInputs, props)), '', 'a refresh reads the saved UI receipt');
  assert.match(renderToStaticMarkup(createElement(UnappliedInputs, { ...props, sessionId: 'session:other' })), /1 条消息未处理/);
  const next = renderToStaticMarkup(createElement(UnappliedInputs, { ...props, inputs: [...inputs, input('later')] }));
  assert.match(next, /1 条消息未处理/); assert.match(next, /Unsent later/); assert.doesNotMatch(next, /Unsent one/);
  assert.deepEqual(inputs, before);
});

test('failed reminder storage retains the prompt and exposes the original error', async t => {
  storage(t);
  const [{ UnappliedInputs }] = await loadGuiModules(t, ['/src/components/local-agent/UnappliedInputs.tsx']);
  globalThis.sessionStorage.setItem = () => { throw Error('storage_unavailable'); };
  const view = mounted(UnappliedInputs, propsFor([input('one')]));
  view.render(); view.click('dismiss');
  assert.match(view.render(), /无法保存关闭状态: storage_unavailable/);
  assert.match(view.render(), /1 条消息未处理/);
});

test('only a successful send receipt closes its pre-existing reminders, even after switching sessions', async t => {
  storage(t);
  const [{ createLocalAgentStore }, reminders] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/unappliedInputReminders.ts']);
  const store = createLocalAgentStore(), sessionId = 'session:send-reminder';
  const observations = [];
  const priorWindow = globalThis.window;
  globalThis.window = { ...priorWindow, __ACHBIT_DEBUG_UI__: { observe: (_component, event, fields) => observations.push({ event, ...fields }) } };
  t.after(() => { if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow; });
  let projection = { ...projectSession(emptySessionState(sessionId)), queuedInputs: [input('old')] };
  const original = structuredClone(projection.queuedInputs), notified = [];
  const stop = reminders.subscribeUnappliedInputReminders(sessionId, ids => notified.push(ids)); t.after(stop);
  store.setState({ sessionId, projection, selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }],
    refreshCatalog: async () => {}, refreshPluginCatalog: async () => {} });
  let mode = 'failed', resolveReply, signalRequest;
  const seen = new Promise(resolve => { signalRequest = resolve; }), gate = new Promise(resolve => { resolveReply = resolve; });
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body);
      assert.equal(command.type, 'message.submit');
      assert.equal('dismissedIds' in command, false);
      if (mode === 'failed') return Response.json({ ok: false, error: 'send_failed', message: 'Original failure' });
      if (mode === 'rejected') return Response.json({ ok: true, data: { schemaVersion: COMMAND_REPLY_VERSION,
        status: 'rejected', sessionId, commandId: command.commandId, revision: projection.revision,
        error: { code: 'send_rejected', message: 'Original rejection' } } });
      signalRequest(); await gate;
      return Response.json({ ok: true, data: { schemaVersion: COMMAND_REPLY_VERSION,
        status: 'accepted', sessionId, commandId: command.commandId, revision: projection.revision } });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: projection });
    throw Error('Unexpected request ' + url.pathname);
  });
  await assert.rejects(store.getState().sendMessage('New message'), /send_failed/);
  assert.deepEqual(reminders.readDismissedUnappliedInputs(sessionId), []);
  mode = 'rejected';
  await assert.rejects(store.getState().sendMessage('Rejected message'), /send_rejected/);
  assert.deepEqual(reminders.readDismissedUnappliedInputs(sessionId), []);
  mode = 'accepted';
  const sending = store.getState().sendMessage('Successful message'); await seen;
  assert.deepEqual(reminders.readDismissedUnappliedInputs(sessionId), [], 'a request in flight is not a successful send');
  projection = { ...projection, queuedInputs: [...projection.queuedInputs, input('arrived-later')] };
  store.setState({ sessionId: 'session:other', projection: projectSession(emptySessionState('session:other')) });
  resolveReply(); const reply = await sending;
  assert.equal(reply.status, 'accepted');
  assert.deepEqual(reminders.readDismissedUnappliedInputs(sessionId), ['old']);
  assert.deepEqual(reminders.readDismissedUnappliedInputs('session:other'), []);
  assert.deepEqual(notified.at(-1), ['old'], 'mounted reminders receive the same close event');
  assert.deepEqual(projection.queuedInputs[0], original[0]);
  assert.equal(store.getState().sessionId, 'session:other');
  const traced = observations.filter(sample => sample.commandId === reply.commandId);
  assert.deepEqual(traced.map(sample => [sample.event, sample.phase]), [
    ['send.command', undefined], ['send.receipt', 'accepted'], ['send.projection', 'inactive'],
  ]);
  assert.ok(traced.every(sample => sample.sessionId === sessionId), 'late receipt stays with its originating session');
  assert.ok(observations.some(sample => sample.event === 'send.transport-failed'));
  assert.ok(observations.some(sample => sample.event === 'send.receipt' && sample.phase === 'rejected'));
});

test('reminder storage failure cannot turn an accepted message into a failed submission', async t => {
  storage(t);
  const [{ createLocalAgentStore }, { uiEvents }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/uiEvents.ts']);
  t.after(() => uiEvents.clear());
  const store = createLocalAgentStore(), sessionId = 'session:storage-send';
  const projection = { ...projectSession(emptySessionState(sessionId)), queuedInputs: [input('old')] };
  store.setState({ sessionId, projection, selectedProfileId: 'profile:test', profiles: [{ id: 'profile:test', enabled: true }],
    refreshCatalog: async () => {}, refreshPluginCatalog: async () => {} });
  globalThis.sessionStorage.setItem = () => { throw Error('storage_unavailable'); };
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/commands')) return Response.json({ ok: true, data: { schemaVersion: COMMAND_REPLY_VERSION,
      status: 'accepted', sessionId, commandId: JSON.parse(init.body).commandId, revision: projection.revision } });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: projection });
    throw Error('Unexpected request ' + url.pathname);
  });
  assert.equal((await store.getState().sendMessage('Accepted message')).status, 'accepted');
  assert.equal(store.getState().error, null);
  assert.match(uiEvents.snapshot().find(event => event.sessionId === sessionId).text, /storage_unavailable/);
});
