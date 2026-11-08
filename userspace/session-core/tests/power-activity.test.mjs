import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionActor } from '../dist/index.js';
import { SessionNotifications } from '../dist/sessionNotifications.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent,
  readEvents, waitForProjection, waitUntil } from './local-agent-fixtures.mjs';

for (const mode of ['inbox', 'deadline', 'schedule']) test(`power activity follows actual ${mode} waiting and cancellation`, async t => {
  const sessionId = `session:power-${mode}`;
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  let requests = 0, invalidations = 0;
  const actor = new SessionActor(sessionId, journal, {
    kernel: emptyKernel(), runPreparation: fakeRunPreparation({ contextWindowTokens: 16000 }).port,
    async dispose() {},
    provider: { async *stream(request) {
      requests++;
      const schedule = mode === 'schedule' && requests === 1;
      yield providerEvent(request.requestId, 'tool.call', { callId: `call:${requests}`, name: 'session',
        input: schedule ? { action: 'schedule', afterSeconds: 60, text: 'Review this task later.' }
          : { action: 'wait', ...(mode === 'deadline' ? { timeoutSeconds: 60 } : {}) } });
      yield providerEvent(request.requestId, 'completed', {});
    } },
  }, { observation: { accept() {}, failed(_id, error) { throw error; }, activityChanged() { invalidations++; } } });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Wait for the required event.'));
  await waitUntil(async () => (await readEvents(journal, sessionId)).some(event =>
    event.type === 'session.control.completed' && event.payload.operation.action === 'wait'), 'accepted event wait');
  await waitUntil(() => invalidations >= 2, 'actual wait invalidation');
  assert.deepEqual(await actor.activity(), { active: true, keepAwake: mode !== 'inbox' });
  const waitingRequests = requests;
  await delay(30);
  assert.equal(requests, waitingRequests, 'passive waiting never requests the model');
  const { run } = await actor.snapshot();
  await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', sessionId,
    commandId: 'command:cancel', runId: run.runId });
  await waitForProjection(actor, value => value.run?.status === 'cancelled');
  await waitUntil(async () => !(await actor.activity()).active, 'cancelled Loop releases activity');
  assert.deepEqual(await actor.activity(), { active: false, keepAwake: false });
  assert.ok(invalidations >= 4, 'entering/leaving waits and ending the Loop invalidate activity');
});

test('a pending human question keeps Host bindings without keeping the system awake', async t => {
  const sessionId = 'session:power-human';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  let requests = 0;
  const actor = new SessionActor(sessionId, journal, {
    kernel: emptyKernel(), runPreparation: fakeRunPreparation({ contextWindowTokens: 16000 }).port,
    async dispose() {},
    provider: { async *stream(request) {
      if (++requests === 1) yield providerEvent(request.requestId, 'tool.call', { callId: 'question', name: 'interaction_request',
        input: { kind: 'question', mode: 'continue', prompt: 'Which direction should I take?', allowFreeform: true } });
      else yield providerEvent(request.requestId, 'text.delta', { text: 'Independent work finished; awaiting your decision.' });
      yield providerEvent(request.requestId, 'completed', {});
    } },
  });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:question', 'Ask before choosing the direction.'));
  await waitForProjection(actor, value => value.run?.status === 'waiting');
  assert.deepEqual(await actor.activity(), { active: true, keepAwake: false });
  assert.equal(requests, 2);
});

test('in-memory activity invalidates the existing change stream without a settlement fact', async () => {
  const frames = [];
  const notifications = new SessionNotifications(async frame => { frames.push(frame); });
  notifications.activityChanged('session:power');
  await notifications.close();
  assert.deepEqual(frames.map(frame => frame.notification), [{ kind: 'change', sessionId: 'session:power' }]);
});

for (const phase of ['prepare', 'release']) test(`power stays owned until pending ${phase} physically finishes`, async t => {
  const sessionId = `session:power-${phase}`;
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  let entered = false, finish;
  const held = new Promise(resolve => { finish = resolve; });
  const preparation = fakeRunPreparation();
  const actor = new SessionActor(sessionId, journal, {
    kernel: emptyKernel(), async dispose() {},
    runPreparation: { ...preparation.port, async [phase](request) {
      entered = true;
      await held;
      return preparation.port[phase](request);
    } },
    provider: { async *stream(request) {
      yield providerEvent(request.requestId, 'text.delta', { text: 'Finished.' });
      yield providerEvent(request.requestId, 'completed', {});
    } },
  });
  t.after(async () => { finish(); await actor.dispose(); });
  const submitted = actor.submit(messageCommand(sessionId, 'command:start', 'Complete this task.'));
  await waitUntil(() => entered, `${phase} entered`);
  assert.deepEqual(await actor.activity(), { active: true, keepAwake: true });
  if (phase === 'prepare') assert.equal((await actor.snapshot()).run, null);
  else assert.equal((await actor.snapshot()).run.status, 'releasing');
  finish();
  await submitted;
  await waitForProjection(actor, value => value.run?.status === 'completed');
  await waitUntil(async () => !(await actor.activity()).active, 'physical lifecycle released');
  assert.deepEqual(await actor.activity(), { active: false, keepAwake: false });
});
