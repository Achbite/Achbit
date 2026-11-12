import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, runtimeSnapshot, fakeRunPreparation, createSession, readEvents, emptyKernel } from './local-agent-fixtures.mjs';

async function finishingRun(journal, sessionId, runId) {
  await createSession(journal, sessionId);
  const runtime = runtimeSnapshot(runId);
  await journal.append({ type: 'message.committed', sessionId,
    payload: { messageId: 'message:original', role: 'user', content: 'Original task' } });
  await journal.append({ type: 'run.started', sessionId, runId,
    payload: { inputMessageId: 'message:original', workspaceBindings: [], runtimeSnapshot: runtime } });
  const settlement = { outcome: 'failed', error: { code: 'original_failure', message: 'Keep this error' } };
  await journal.append({ type: 'run.finishing', sessionId, runId, payload: settlement });
  return { runtime, settlement };
}

const noProvider = { async *stream() { assert.fail('Finishing must not call the Provider'); } };

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
  await journal.append({ type: 'run.runtime.release_failed', sessionId, runId, payload: {
    runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef, extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef, providerRuntimeRef: runtime.provider.providerRuntimeRef,
    error: { code: 'previous_release_failed', message: 'Previous Host lost its binding' },
  } });
  let releases = 0;
  const actor = actorWith(journal, sessionId, noProvider, emptyKernel(), {
    async prepare() { assert.fail('Finishing must not reconstruct a tool executor'); },
    async release(request) { releases++; return { kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
      alreadyReleased: false, recoveredAfterRestart: true }; },
  }, 'cancel-release');
  t.after(() => actor.dispose());
  const reply = await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'run.cancel',
    commandId: 'command:finish', sessionId, runId });
  assert.equal(reply.status, 'accepted');
  assert.equal(releases, 1);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.find(event => event.type === 'run.settled').payload, settlement);
  assert.equal(events.find(event => event.type === 'run.runtime.released').payload.recoveredAfterRestart, true);
  assert.equal(events.filter(event => event.type === 'run.runtime.release_failed').length, 1);
  assert.equal((await actor.snapshot()).run.status, 'failed');
});
