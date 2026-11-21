import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { SessionService } from '../dist/local-agent/service.js';
import { actorWith, runtimeSnapshot, fakeRunPreparation, createSession, readEvents, emptyKernel } from './local-agent-fixtures.mjs';

async function finishingRun(journal, sessionId, runId, beforeFinish) {
  await createSession(journal, sessionId);
  const runtime = runtimeSnapshot(runId);
  await journal.append({ type: 'message.committed', sessionId,
    payload: { messageId: 'message:original', role: 'user', content: 'Original task' } });
  await journal.append({ type: 'run.started', sessionId, runId,
    payload: { inputMessageId: 'message:original', workspaceBindings: [], runtimeSnapshot: runtime } });
  await beforeFinish?.();
  const settlement = { outcome: 'failed', error: { code: 'original_failure', message: 'Keep this error' } };
  await journal.append({ type: 'run.finishing', sessionId, runId, payload: settlement });
  return { runtime, settlement };
}

const noProvider = { async *stream() { assert.fail('Finishing must not call the Provider'); } };

async function recordReleaseFailure(journal, sessionId, runId, runtime) {
  const error = { code: 'previous_release_failed', message: 'Previous Host lost its binding' };
  await journal.append({ type: 'run.runtime.release_failed', sessionId, runId, payload: {
    runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef, extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef, providerRuntimeRef: runtime.provider.providerRuntimeRef, error,
  } });
  return error;
}

test('deleting failed cleanup history does not recover the run or fabricate settlement', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:delete-release-failed', runId = 'run:delete-release-failed';
  const { runtime } = await finishingRun(journal, sessionId, runId);
  const service = new SessionService(journal, { async create() { assert.fail('Delete must not open an Actor'); } });
  t.after(() => service.dispose());
  await assert.rejects(service.deleteSession(sessionId), { message: `session_delete_active_run:${sessionId}` }, 'releasing remains protected');
  const error = await recordReleaseFailure(journal, sessionId, runId, runtime);
  const history = await readEvents(journal, sessionId);
  assert.deepEqual(history.at(-1).payload.error, error);
  assert.equal(history.some(e => e.type === 'run.runtime.released' || e.type === 'run.settled'), false);
  const remove = journal.deleteSession.bind(journal);
  journal.deleteSession = async id => {
    assert.deepEqual(await readEvents(journal, id), history, 'admitting deletion must not rewrite history');
    await remove(id);
  };
  assert.deepEqual(await service.deleteSession(sessionId), { deletedSessionIds: [sessionId] });
  await assert.rejects(readEvents(journal, sessionId), /session_not_found/);
});

test('family deletion keeps every archive while the current Host retains a failed release', async t => {
  const journal = new InMemoryCommandJournal(), parent = 'session:retained-parent', child = 'session:idle-child', runId = 'run:retained';
  const capabilities = { messaging: false, continuation: false, delegation: false };
  const { runtime } = await finishingRun(journal, parent, runId, async () => {
    await journal.createSession({ sessionId: child, displayTitle: 'Child', workspaceBindings: [], agentContext: {
      ownerSessionId: parent, parentSessionId: parent, parentRunId: runId, parentCallId: 'call:spawn', capabilities,
    } });
    await journal.append({ type: 'agent.task.created', sessionId: parent, runId, callId: 'call:spawn', payload: {
      taskId: 'task:child', agentSessionId: child, capabilities, createsAgent: true, displayName: 'Child', text: 'A task', delivery: 'async',
    } });
    await journal.append({ type: 'agent.task.completed', sessionId: parent, runId, payload: {
      taskId: 'task:child', result: { outcome: 'failed', error: { code: 'start_failed', message: 'Child did not start' } },
    } });
  });
  await recordReleaseFailure(journal, parent, runId, runtime);
  const before = await Promise.all([child, parent].map(id => readEvents(journal, id)));
  const ownerError = new Error('This Host still holds the parent run');
  journal.assertSessionsDeletable = async ids => { assert.deepEqual(ids, [child, parent]); throw ownerError; };
  const service = new SessionService(journal, { async create() { assert.fail('Checking an owner must not recover an Actor'); } });
  t.after(() => service.dispose());
  await assert.rejects(service.deleteSession(parent), error => error === ownerError);
  assert.deepEqual(await Promise.all([child, parent].map(id => readEvents(journal, id))), before);
  journal.assertSessionsDeletable = async () => {}; // Same historical facts; no owner remains on the Host.
  assert.deepEqual(await service.deleteSession(parent), { deletedSessionIds: [child, parent] });
});

test('deletion refuses an in-flight cleanup retry even while the journal still says releaseFailed', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:delete-recovery', runId = 'run:delete-recovery';
  const { runtime } = await finishingRun(journal, sessionId, runId);
  await recordReleaseFailure(journal, sessionId, runId, runtime);
  let attempts = 0, enter, unblock;
  let entered, gate;
  function hold() {
    entered = new Promise(resolve => { enter = resolve; });
    gate = new Promise(resolve => { unblock = resolve; });
  }
  const service = new SessionService(journal, { async create() { return { composition: {
    provider: noProvider, kernel: emptyKernel(), async dispose() {}, runPreparation: {
      async prepare() { assert.fail('Recovery must not restore the executor'); },
      async release() { attempts++; enter(); await gate; throw new Error('retry failed'); },
    },
  } }; } });
  t.after(async () => { unblock(); await service.dispose(); });
  const checkBusy = async () => {
    await entered;
    const attemptsAtEntry = attempts;
    const history = await readEvents(journal, sessionId);
    await assert.rejects(service.deleteSession(sessionId), { message: `session_delete_active_run:${sessionId}` });
    assert.deepEqual(await readEvents(journal, sessionId), history);
    assert.equal(attempts, attemptsAtEntry);
    unblock();
  };
  hold();
  // Opening this Actor explicitly retries the historical release; deleting must not join or interrupt it.
  const open = service.submit({ schemaVersion: 'achbit.command.v3', type: 'session.mode.set', commandId: 'command:open', sessionId, mode: 'full' });
  await checkBusy();
  await open;
  hold();
  const retry = service.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel', commandId: 'command:retry', sessionId, runId });
  await checkBusy();
  await retry;
  assert.deepEqual((await service.snapshot(sessionId)).run, {
    runId, status: 'releaseFailed', mode: 'full', workspaceBindings: [], profileId: runtime.provider.profileId,
  });
  assert.deepEqual(await service.deleteSession(sessionId), { deletedSessionIds: [sessionId] });
  assert.equal(attempts, 2, 'only the explicit opening and cancel retried');
});

test('release receipt survives a failed settlement write and recovery keeps the original failure', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:release-write', runId = 'run:release-write';
  const { settlement } = await finishingRun(journal, sessionId, runId);
  const preparation = fakeRunPreparation();
  const append = journal.append.bind(journal), appendBatch = journal.appendBatch.bind(journal);
  const failure = new Error('fixture_settlement_write_failed');
  journal.append = async event => { if (event.type === 'run.settled') throw failure; return append(event); };
  journal.appendBatch = async events => { if (events.some(event => event.type === 'run.settled')) throw failure; return appendBatch(events); };
  const actor = actorWith(journal, sessionId, noProvider, emptyKernel(), preparation.port, 'release-write');
  t.after(() => actor.dispose());
  await assert.rejects(actor.recover(), error => error === failure);
  let events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'run.runtime.released').length, 1);
  assert.equal(events.filter(event => event.type === 'run.settled').length, 0);
  assert.equal(preparation.released.length, 1);
  await actor.dispose();
  journal.append = append;
  journal.appendBatch = appendBatch;
  const restored = actorWith(journal, sessionId, noProvider, emptyKernel(), {
    ...preparation.port, async release() { assert.fail('A durable release must not release again'); },
  }, 'restored');
  t.after(() => restored.dispose());
  await restored.recover();
  events = await readEvents(journal, sessionId);
  assert.equal(events.filter(event => event.type === 'run.runtime.released').length, 1);
  assert.deepEqual(events.find(event => event.type === 'run.settled').payload, settlement);
  assert.equal((await restored.snapshot()).run.status, 'failed');
});

test('cancel retries failed finalization without restoring a tool executor or changing its outcome', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:cancel-release', runId = 'run:cancel-release';
  const { runtime, settlement } = await finishingRun(journal, sessionId, runId);
  await recordReleaseFailure(journal, sessionId, runId, runtime);
  let releases = 0, enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const actor = actorWith(journal, sessionId, noProvider, emptyKernel(), {
    async prepare() { assert.fail('Finishing must not reconstruct a tool executor'); },
    async release(request) { releases++; enter(); await gate; return { kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
      alreadyReleased: false, recoveredAfterRestart: true }; },
  }, 'cancel-release');
  t.after(async () => { finish(); await actor.dispose(); });
  assert.deepEqual(await actor.activity(), { active: false, keepAwake: false });
  const pending = actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel',
    commandId: 'command:finish', sessionId, runId });
  await entered;
  assert.deepEqual(await actor.activity(), { active: true, keepAwake: true }, 'a real cleanup retry is work');
  finish();
  const reply = await pending;
  assert.equal(reply.status, 'accepted');
  assert.equal(releases, 1);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.find(event => event.type === 'run.settled').payload, settlement);
  assert.equal(events.find(event => event.type === 'run.runtime.released').payload.recoveredAfterRestart, true);
  assert.equal(events.filter(event => event.type === 'run.runtime.release_failed').length, 1);
  assert.equal((await actor.snapshot()).run.status, 'failed');
});
