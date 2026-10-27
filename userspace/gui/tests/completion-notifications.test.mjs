import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

const settled = (sessionId, eventSequence, outcome = 'completed', runId = 'run-1') => ({
  type: 'settled', sessionId, runId, eventSequence, outcome,
});

test('completion reminders use new settlement events without requiring an earlier running snapshot', async t => {
  const { CompletionNotifications } = await loadGuiModule(t, '/src/achbit-gui/layout/completionNotifications.ts');
  const tracker = new CompletionNotifications();
  assert.equal(tracker.accept({ type: 'ready' }), false, 'a history baseline is never a completion');
  assert.equal(tracker.accept({ type: 'change', sessionId: 'history' }), false, 'projection invalidation does not imply completion');
  assert.equal(tracker.accept(settled('external-fast', 20)), true, 'an unseen external Session can finish before any status read');
  assert.equal(tracker.accept(settled('external-fast', 20)), false, 'the same run rings once');
  assert.equal(tracker.accept(settled('external-fast', 21)), false, 'a repeated run identity cannot ring twice');
  assert.equal(tracker.accept(settled('external-fast', 40, 'completed', 'run-2')), true, 'later real runs ring independently');
  assert.equal(tracker.accept(settled('external-fast', 19, 'completed', 'run-old')), false, 'ignore older event deliveries');
  assert.equal(tracker.accept({ type: 'ready' }), false, 'reconnecting does not reset deduplication or replay history');
  assert.equal(tracker.accept(settled('external-fast', 40, 'completed', 'run-2')), false);
});

test('failed and cancelled settlement events do not ring and another successful Session still does', async t => {
  const { CompletionNotifications } = await loadGuiModule(t, '/src/achbit-gui/layout/completionNotifications.ts');
  const tracker = new CompletionNotifications();
  for (const outcome of ['failed', 'cancelled', 'indeterminate']) {
    assert.equal(tracker.accept(settled(outcome, 3, outcome)), false);
  }
  assert.equal(tracker.accept(settled('successful', 9)), true);
  assert.equal(tracker.accept(settled('failed', 40, 'completed', 'run-recovered')), true);
});

test('desktop completion uses the local native bridge even for a remote host and reports native errors', async t => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    location: new URL('achbit-gui://localhost/index.html'),
    __ACHBIT_HOST_BOOT__: { schemaVersion: 'achbit.host-ui-bootstrap', host: '127.0.0.1', port: '49123', uiToken: `acui_${'a'.repeat(64)}`, windowChrome: 'custom', remote: true },
    __TAURI__: { core: { invoke: async (...args) => calls.push(args) } },
  };
  t.after(() => { globalThis.window = previousWindow; });
  const { hasDesktopNotifications, notifyTaskCompleted, getCompletionSound, setCompletionSound, previewCompletionSound, onCompletionOpen } = await loadGuiModule(t, '/src/services/runtimeAdapter.ts');
  assert.equal(hasDesktopNotifications(), true);
  const reminder = { sessionId: 'session', title: '任务已完成', body: '会话标题', openLabel: '查看会话', dismissLabel: '关闭提醒' };
  await notifyTaskCompleted(reminder);
  assert.deepEqual(calls, [['achbit_notify_completed', { reminder }]]);
  await getCompletionSound(); await setCompletionSound([82, 73]); await previewCompletionSound(); await setCompletionSound(null);
  assert.deepEqual(calls.slice(1), [['achbit_completion_sound'], ['achbit_set_completion_sound', { data: [82, 73] }], ['achbit_preview_completion_sound'], ['achbit_set_completion_sound', { data: null }]]);
  let observed = null, unlistened = false;
  window.__TAURI__.event = { listen: async (name, callback) => {
    assert.equal(name, 'achbit:completion-open'); callback({ payload: 'session' });
    return () => { unlistened = true; };
  } };
  const stop = await onCompletionOpen(id => { observed = id; });
  assert.equal(observed, 'session'); stop(); assert.equal(unlistened, true);
  window.__TAURI__.core.invoke = async () => { throw new Error('audio_device_unavailable'); };
  await assert.rejects(notifyTaskCompleted(reminder), /audio_device_unavailable/);
  window.__ACHBIT_BROWSER_PREVIEW__ = true;
  assert.equal(hasDesktopNotifications(), false);
  await assert.rejects(notifyTaskCompleted(reminder), /desktop_notifications_unavailable/);
});

test('background conversation changes refresh immediately without visibility timers and unmount releases observation', async t => {
  const { startConversationUpdates } = await loadGuiModule(t, '/src/components/local-agent/useConversationUpdates.ts');
  const { watchConversationChanges } = await loadGuiModule(t, '/src/services/conversationEvents.ts');
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const timers = new Map(), listeners = new Map(); let sequence = 0;
  globalThis.window = { setTimeout(fn, delay) { timers.set(++sequence, { fn, delay }); return sequence; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { visibilityState: 'hidden', addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  let receive, signal, reads = 0;
  const watch = (sessionId, abort, refresh) => watchConversationChanges(sessionId, abort, refresh, async (sourceSignal, callback) => {
    receive = callback; signal = sourceSignal;
    await new Promise(resolve => sourceSignal.addEventListener('abort', resolve, { once: true }));
  });
  const stop = startConversationUpdates(async () => { reads++; }, true, error => assert.fail(error), watch);
  t.after(stop);
  receive({ type: 'ready' }); await Promise.resolve();
  assert.equal(reads, 1);
  receive({ type: 'change', sessionId: 'background-task' }); await Promise.resolve();
  assert.equal(reads, 2, 'hidden windows consume pushed changes immediately');
  await Promise.resolve(); assert.equal(reads, 2, 'idle produces no new read');
  assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
  stop(); assert.equal(signal.aborted, true);
});
