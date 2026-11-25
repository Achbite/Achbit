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
  assert.notEqual(snapshots[4].display.creationTitle, 'not canonical', 'coalesced readers own independent nested fields');
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

test('versioned history follows committed facts, isolates callers and expires unused projections', async t => {
  const journal = new InMemoryCommandJournal();
  const ids = ['session:one', 'session:two', 'session:three'];
  for (const id of ids) await createSession(journal, id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let generation = 1;
  let unavailable = false;
  let creationTitle = 'First title';
  let malformed = false;
  const reads = new Map();
  const original = journal.read.bind(journal);
  journal.historyVersion = async () => {
    if (unavailable) throw new Error('journal_version_unavailable');
    return String(generation);
  };
  journal.read = async function* (id, ...args) {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    for await (const event of original(id, ...args)) {
      if (event.type === 'session.created') event.payload.displayTitle = creationTitle;
      if (malformed) event.sequence++;
      yield event;
    }
  };
  const service = new SessionService(journal, {async create() { throw new Error('unexpected_actor'); }});
  t.after(() => service.dispose());
  const [left, right] = await Promise.all([service.snapshot(ids[0]), service.snapshot(ids[0])]);
  left.display.creationTitle = 'edited by caller';
  assert.equal(right.display.creationTitle, creationTitle);
  await service.snapshot(ids[1]);
  assert.equal((await service.snapshot(ids[0])).display.creationTitle, creationTitle);
  assert.equal(reads.get(ids[0]), 1, 'switching back to recent history reuses its projection');
  await service.snapshot(ids[2]);
  await service.snapshot(ids[1]);
  assert.equal(reads.get(ids[1]), 2, 'third history evicts least recently visited view');
  creationTitle = 'Committed replacement';
  generation++;
  const changed = await service.snapshot(ids[0]);
  assert.equal(changed.revision, right.revision);
  assert.equal(changed.display.creationTitle, creationTitle);
  unavailable = true;
  await assert.rejects(service.snapshot(ids[0]), /journal_version_unavailable/);
  unavailable = false;
  malformed = true;
  generation++;
  await assert.rejects(service.snapshot(ids[0]), /session_event_sequence/);
  malformed = false;
  await service.snapshot(ids[0]);
  const beforeIdle = reads.get(ids[0]);
  t.mock.timers.tick(7_250);
  await service.snapshot(ids[0]);
  assert.equal(reads.get(ids[0]), beforeIdle, 'a brief absence retains the view');
  t.mock.timers.tick(30_001);
  await service.snapshot(ids[0]);
  assert.equal(reads.get(ids[0]), beforeIdle + 1);
  await journal.deleteSession(ids[0]);
  generation++;
  await assert.rejects(service.snapshot(ids[0]), /session_not_found/);
});

test('a write during slow replay cannot bind the previous view to a later journal version', async t => {
  const journal = new InMemoryCommandJournal();
  const id = 'session:concurrent-version';
  await createSession(journal, id);
  let version = 1;
  journal.historyVersion = async () => String(version);
  const original = journal.read.bind(journal);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  journal.read = async function* (...args) {
    const which = ++reads;
    const rows = [];
    for await (const event of original(...args)) rows.push(event);
    if (which === 1) { started.resolve(); await release.promise; }
    yield* rows;
  };
  const service = new SessionService(journal, {async create() { throw new Error('unexpected_actor'); }});
  t.after(() => service.dispose());
  const slow = service.snapshot(id);
  await started.promise;
  await journal.append({type:'message.committed',sessionId:id,payload:{messageId:'message:concurrent',role:'user',content:'new committed tail'}});
  version++;
  const latest = service.snapshot(id);
  await new Promise(resolve => setImmediate(resolve));
  const readsBeforeRelease = reads;
  release.resolve();
  assert.equal((await latest).messages.at(-1)?.content, 'new committed tail');
  assert.equal(readsBeforeRelease, 2, 'new version reads independently while previous read is held');
  assert.equal((await slow).messages.length, 0);
  assert.equal((await service.snapshot(id)).messages.at(-1).content, 'new committed tail');
  assert.equal(reads, 2);
});

test('retains large valid histories together and reports their serialized size until release', async t => {
  const journal = new InMemoryCommandJournal();
  const large = 'session:large-history', small = 'session:small-history';
  for (const id of [large, small]) await createSession(journal, id);
  const length = 17 * 1024 * 1024;
  await journal.append({ sessionId: large, type: 'message.committed',
    payload: { role: 'user', messageId: 'message:large', content: 'x'.repeat(length) } });
  journal.historyVersion = async () => 'same-cut';
  const reads = [];
  const read = journal.read.bind(journal);
  journal.read = async function* (id, ...args) { reads.push(id); yield* read(id, ...args); };
  const samples = [];
  const observation = { accept() {}, failed() {}, readingCacheChanged(usage) { samples.push(usage); } };
  const service = new SessionService(journal, { async create() { assert.fail('unexpected actor'); } },
    undefined, undefined, undefined, observation);
  t.after(() => service.dispose());
  assert.equal((await service.snapshot(large)).messages[0].content.length, length);
  await service.snapshot(small);
  assert.equal((await service.snapshot(large)).messages[0].content.length, length);
  await service.snapshot(small);
  assert.deepEqual(reads, [large, small]);
  assert.equal(samples.at(-1).snapshotEntries, 2);
  assert.ok(samples.at(-1).snapshotBytes >= length);
  assert.equal(samples.at(-1).totalBytes, samples.at(-1).snapshotBytes);
  await service.dispose();
  assert.equal(samples.at(-1).totalBytes, 0);
});
