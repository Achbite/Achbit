import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession } from './local-agent-fixtures.mjs';

test('concurrent history views share replay, isolate readers and reread subsequent journal facts without activating an Actor', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:cached-history';
  await createSession(journal, sessionId);
  let reads = 0;
  const read = journal.read.bind(journal);
  journal.read = async function* (...args) { reads++; yield* read(...args); };
  const service = new SessionService(journal, { async create() { throw new Error('history_activated_actor'); } });
  t.after(() => service.dispose());
  const snapshots = await Promise.all(Array.from({length:5},() => service.snapshot(sessionId)));
  assert.equal(reads,1);
  assert.deepEqual(snapshots[0],snapshots[4]);
  snapshots[0].display.creationTitle = 'not canonical';
  assert.notEqual((await service.snapshot(sessionId)).display.creationTitle,'not canonical');
  assert.equal(reads,2,'a subsequent read must consult the journal again, including malformed history at the same revision');
  await journal.append({type:'message.committed',sessionId,payload:{messageId:'message:changed',role:'user',content:'new journal fact'}});
  const changed = await service.snapshot(sessionId);
  assert.equal(reads,3); assert.equal(changed.messages.at(-1).content,'new journal fact');
  assert.ok(changed.revision > snapshots[0].revision);
  await journal.deleteSession(sessionId);
  await assert.rejects(service.snapshot(sessionId),/session_not_found/,'cached history never conceals a missing journal');
});

test('a failed history read is not cached and later explicit reads retain normal error propagation', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:retry-history';
  await createSession(journal,sessionId);
  const original = journal.read.bind(journal);
  let failed = true;
  journal.read = async function* (...args) { if (failed) throw new Error('original_journal_failure'); yield* original(...args); };
  const service = new SessionService(journal,{async create(){throw new Error('unexpected_actor');}});
  t.after(() => service.dispose());
  await assert.rejects(service.snapshot(sessionId),/original_journal_failure/);
  failed = false;
  assert.equal((await service.snapshot(sessionId)).sessionId,sessionId);
});
