import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

const status = (sessionId, revision, state, runId = 'run-1') => ({
  sessionId, revision, run: state ? { runId, status: state } : null,
});

test('completion reminders observe each successful run once, including background and fast subsequent runs', async t => {
  const { CompletionNotifications } = await loadGuiModule(t, '/src/deepcode-gui/layout/completionNotifications.ts');
  const tracker = new CompletionNotifications();
  const ids = ['history', 'active', 'background'];
  const update = rows => tracker.update(Object.fromEntries(rows.map(row => [row.sessionId, row])), ids).map(row => row.sessionId);
  assert.deepEqual(update([status('history', 20, 'completed'), status('active', 1, null), status('background', 3, 'running')]), []);
  assert.deepEqual(update([status('history', 21, 'completed'), status('active', 2, 'completed'), status('background', 4, 'releasing')]), ['active']);
  assert.deepEqual(update([status('active', 2, 'completed'), status('background', 5, 'completed')]), ['background']);
  assert.deepEqual(update([status('active', 4, 'completed', 'run-2')]), ['active'], 'a new run can finish between snapshots');
  assert.deepEqual(update([status('active', 3, 'running', 'run-2')]), [], 'ignore stale observations');
  assert.deepEqual(update([status('active', 5, 'completed', 'run-2')]), [], 'revision or title changes do not replay completion');
  assert.deepEqual(update([]), [], 'temporary status read failure is not a reset');
  assert.deepEqual(update([status('active', 5, 'completed', 'run-2')]), []);
});

test('failed and cancelled runs do not ring; a recovered successful transition still rings and deleted histories are forgotten', async t => {
  const { CompletionNotifications } = await loadGuiModule(t, '/src/deepcode-gui/layout/completionNotifications.ts');
  const tracker = new CompletionNotifications();
  for (const state of ['failed', 'cancelled', 'releaseFailed', 'indeterminate', 'waiting', 'releasing']) {
    tracker.update({ s: status('s', 1, 'running') }, ['s']);
    assert.deepEqual(tracker.update({ s: status('s', 2, state) }, ['s']), []);
    tracker.update({}, []);
  }
  tracker.update({ s: status('s', 1, 'waiting') }, ['s']);
  tracker.update({}, ['s']);
  assert.equal(tracker.update({ s: status('s', 2, 'completed') }, ['s']).length, 1);
  tracker.update({}, []);
  assert.deepEqual(tracker.update({ s: status('s', 3, 'completed', 'another') }, ['s']), [], 'reloaded history is a new baseline');
});

test('desktop completion uses the local native bridge even for a remote host and reports native errors', async t => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    location: new URL('deepcode-gui://localhost/index.html'),
    __DEEPCODE_HOST_BOOT__: { schemaVersion: 'deepcode.host-ui-bootstrap', host: '127.0.0.1', port: '49123', uiToken: `dcui_${'a'.repeat(64)}`, windowChrome: 'custom', remote: true },
    __TAURI__: { core: { invoke: async (...args) => calls.push(args) } },
  };
  t.after(() => { globalThis.window = previousWindow; });
  const { hasDesktopNotifications, notifyTaskCompleted, getCompletionSound, setCompletionSound, previewCompletionSound, onCompletionOpen } = await loadGuiModule(t, '/src/services/runtimeAdapter.ts');
  assert.equal(hasDesktopNotifications(), true);
  const reminder = { sessionId: 'session', title: '任务已完成', body: '会话标题', openLabel: '查看会话', dismissLabel: '关闭提醒' };
  await notifyTaskCompleted(reminder);
  assert.deepEqual(calls, [['deepcode_notify_completed', { reminder }]]);
  await getCompletionSound(); await setCompletionSound([82, 73]); await previewCompletionSound(); await setCompletionSound(null);
  assert.deepEqual(calls.slice(1), [['deepcode_completion_sound'], ['deepcode_set_completion_sound', { data: [82, 73] }], ['deepcode_preview_completion_sound'], ['deepcode_set_completion_sound', { data: null }]]);
  let observed = null, unlistened = false;
  window.__TAURI__.event = { listen: async (name, callback) => {
    assert.equal(name, 'deepcode:completion-open'); callback({ payload: 'session' });
    return () => { unlistened = true; };
  } };
  const stop = await onCompletionOpen(id => { observed = id; });
  assert.equal(observed, 'session'); stop(); assert.equal(unlistened, true);
  window.__TAURI__.core.invoke = async () => { throw new Error('audio_device_unavailable'); };
  await assert.rejects(notifyTaskCompleted(reminder), /audio_device_unavailable/);
  window.__DEEPCODE_BROWSER_PREVIEW__ = true;
  assert.equal(hasDesktopNotifications(), false);
  await assert.rejects(notifyTaskCompleted(reminder), /desktop_notifications_unavailable/);
});

test('background active polling remains timely while idle polling stays quiet and cleanup cancels the timer', async t => {
  const { startProjectionPolling } = await loadGuiModule(t, '/src/components/local-agent/useProjectionPolling.ts');
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const timers = new Map(), listeners = new Map(); let sequence = 0;
  globalThis.window = { setTimeout(fn, delay) { timers.set(++sequence, { fn, delay }); return sequence; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { visibilityState: 'hidden', addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const stop = startProjectionPolling(true, async () => {}, true);
  assert.equal(timers.size, 1);
  const activeDelay = [...timers.values()][0].delay;
  assert.ok(activeDelay > 0 && activeDelay <= 1000);
  stop(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
  const stopIdle = startProjectionPolling(false, async () => {}, true);
  assert.ok([...timers.values()][0].delay > activeDelay);
  stopIdle();
});
