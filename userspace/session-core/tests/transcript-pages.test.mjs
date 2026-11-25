// TCR: T-020-GUI_Startup-20261121/paged-transcript-debug-20261124/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../dist/index.js';
import { selectTranscriptPage } from '../dist/local-agent/transcriptPage.js';
import { projectSessionHistory, projectTranscriptFacts } from '../dist/local-agent/reducer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents, waitForProjection } from './local-agent-fixtures.mjs';

test('committed turns, usage partitions and all navigation keys agree with a complete snapshot without opening an execution Actor', async t=>{
  const id='session:paged',j=new InMemoryCommandJournal();await createSession(j,id);
  const actor=actorWith(j,id,{async *stream(req){yield providerEvent(req.requestId,'text.delta',{text:'independent canonical answer'});
    yield providerEvent(req.requestId,'completed',{usage:{inputTokens:30,outputTokens:3,contextWindowTokens:32000}});}},
    emptyKernel(),fakeRunPreparation({contextWindowTokens:32000}).port,'paged-test');
  t.after(()=>actor.dispose());
  for(let n=0;n<3;n++){await actor.submit(messageCommand(id,'cmd:'+n,'question '+n));await waitForProjection(actor,p=>p.run?.status==='completed'&&p.messages.filter(m=>m.role==='assistant').length===n+1);}
  const oracle=await actor.snapshot();const service=new SessionService(j,{async create(){assert.fail('history opened execution')}});t.after(()=>service.dispose());
  // TCR T-027 phase4. The desktop view consumes the same effective replay as the named snapshot.
  const desktop = await service.desktopSnapshot(id);
  assert.equal(desktop.kind, 'desktop.history.v1');
  assert.deepEqual(desktop.projection, await service.snapshot(id));
  const events = await readEvents(j, id);
  const starts = events.filter(event => event.type === 'run.started');
  const last = starts.at(-1);
  const readingOf = input => {
    const facts = { measurement: null, shellCompletions: new Map() };
    projectSessionHistory(id, input, facts);
    return facts.measurement;
  };
  const prefix = events.slice(0, last.sequence - 1);
  const previous = readingOf(prefix);
  assert.equal(previous.usage.runId, starts.at(-2).runId);
  assert.deepEqual(readingOf([...prefix, last]), previous, 'a pending follow-up retains the preceding measurement');
  const switchModel = { ...last, payload: { ...last.payload, contextStart: {
    previousProfileId: 'profile:previous', historyThroughSequence: last.sequence - 1 } } };
  assert.equal(readingOf([...prefix, switchModel]), null, 'a handoff hides measurements before its boundary');
  const revision = events.at(-1).sequence + 1;
  const edit = { type: 'conversation.revised', sessionId: id, sequence: revision, eventId: 'edit:last',
    occurredAt: 'now', payload: { fromSequence: last.sequence, throughSequence: revision - 1 } };
  assert.deepEqual(readingOf([...events, edit]), previous, 'editing away a later measurement reveals its effective predecessor');
  j.read=async function*(){assert.fail('history enumerated full journal')};
  const pages=[];let around;
  do{const r=await service.read({sessionId:id,view:'transcript',...(around===undefined?{}:{around})});pages.unshift(r.transcript);around=r.transcript.previous;}while(around!==null);
  assert.equal(pages.length,3);assert.deepEqual(pages.flatMap(p=>p.content.messages),oracle.messages);assert.deepEqual(pages.flatMap(p=>p.content.timeline),oracle.timeline);
  assert.deepEqual(pages.at(-1).current.run,oracle.run);assert.deepEqual(pages[0].navigation.map(n=>n.key),oracle.messages.filter(m=>m.role==='user').map(m=>m.messageId));
  const {overview}=await service.read({sessionId:id,view:'overview'});assert.deepEqual(overview.measurement.usage,oracle.contextUsage);
  assert.deepEqual(overview.measurement.receipt.partitions,oracle.contextCompositions.find(r=>r.providerRequestId===oracle.contextUsage.providerRequestId).partitions);
  assert.deepEqual(desktop.measurement, overview.measurement);
  assert.deepEqual(overview.totalTokenUsage,oracle.totalTokenUsage);
  const raw=await j.readTranscriptFacts(id);assert.ok(raw.compositions.length>0);assert.ok(raw.compositions.every(r=>!('messages' in r)));
  assert.throws(()=>projectTranscriptFacts(id,{...raw,compositions:[]}),/session_event_sequence_gap/);
  assert.throws(()=>projectTranscriptFacts(id,{...raw,events:raw.events.map((e,i)=>i?e:{...e,sessionId:'other'})}),/session_event_identity_mismatch/);
});

// TCR: T-020-GUI_Startup-20261121/bounded-transcript-pages-20261124/TCR.md
test('independent provider outputs paginate inside one run and preserve every ordered output and cursor', async t => {
  const id = 'session:large-turn';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, id);
  let requestCount = 0;
  const provider = { async *stream(request) {
    const n = ++requestCount;
    assert.ok(n <= 4);
    const count = n < 4 ? 13 : 1;
    for (let i = 0; i < count; i++) {
      yield providerEvent(request.requestId, 'output.item.completed', {
        outputIndex: i, item: { type: 'message', id: 'output-' + n + '-' + i, role: 'assistant',
          phase: n < 4 ? 'commentary' : 'final_answer', status: 'completed',
          content: [{ type: 'output_text', text: 'Output ' + n + '/' + i }] },
      });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, id, provider, emptyKernel(), fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 128000 }).port, 'large');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(id, 'cmd:large', 'Show all outputs'));
  const full = await waitForProjection(actor, p => p.run?.status === 'completed' || p.run?.status === 'failed');
  assert.equal(full.run.status, 'completed', JSON.stringify(full.terminalError));
  assert.equal(requestCount, 4);
  const service = new SessionService(journal, { async create() { assert.fail('history started an actor'); } });
  t.after(() => service.dispose());
  const reads = [];
  const read = journal.readTranscriptFacts.bind(journal);
  journal.readTranscriptFacts = async (...args) => {
    const facts = await read(...args);
    reads.push({ known: args[2], materialized: facts !== null });
    return facts;
  };
  const at = async around => (await service.read({ sessionId: id, view: 'transcript', around })).transcript;
  const first = await at(1);
  assert.equal(first.previous, null);
  assert.equal(first.current, undefined);
  assert.ok(first.next > 1 && first.next < full.revision);
  const last = await at(first.next);
  assert.equal(last.next, null);
  assert.equal(last.current.run.runId, full.run.runId);
  assert.equal(last.start, first.end + 1);
  assert.deepEqual(await at(last.previous), first);
  assert.deepEqual(await at(last.content.timeline.at(-1).sequence), last);
  assert.deepEqual([...first.content.timeline, ...last.content.timeline], full.timeline);
  assert.deepEqual([...first.content.narratives, ...last.content.narratives], full.narratives);
  assert.deepEqual([...first.content.messages, ...last.content.messages], full.messages);
  const owners = p => new Set(p.content.narratives.map(n => n.providerRequestId));
  for (const request of owners(first)) assert.ok(!owners(last).has(request), 'one provider output stays together');
  assert.deepEqual(reads.map(r => r.materialized), [true, false, false, false]);
  assert.ok(reads.slice(1).every(r => typeof r.known === 'string'));
  const answer = full.messages.at(-1);
  const updated = await actor.submit({ schemaVersion: 'achbit.command.v3', sessionId: id, commandId: 'feedback:large',
    type: 'message.feedback.set', messageId: answer.messageId, feedback: 'up' });
  const fresh = await at(last.start);
  assert.equal(fresh.revision, updated.revision);
  assert.equal(fresh.content.messages.find(m => m.messageId === answer.messageId).feedback, 'up');
  assert.deepEqual(reads.map(r => r.materialized), [true, false, false, false, true], 'one journal read per action, including a changed cut');
  await assert.rejects(at(updated.revision + 1), /conversation_read_anchor_not_found/);
});


test('a provider output and an interleaved event share a page until their source intervals close', () => {
  const message = sequence => ({ kind: 'message', sequence, timelineId: 'row-' + sequence, messageId: 'm-' + sequence });
  const provider = Array.from({ length: 28 }, (_, i) => message(101 + i));
  const interleaved = message(96);
  const following = message(140);
  const groups = [{ sequence: 2, items: provider }, { sequence: 96, items: [interleaved] },
    { sequence: 135, items: [following] }];
  const turn = { start: 1, end: 145 };
  const page = selectTranscriptPage(groups, turn, 96);
  assert.deepEqual(page.timeline, [...provider, interleaved], 'canonical producer order survives a journal inversion');
  assert.deepEqual([page.start, page.end], [1, 134]);
  assert.deepEqual(selectTranscriptPage(groups, turn, 135).timeline, [following]);
});

test('a multi-page turn larger than 16 MiB is retained for its neighboring page', async t => {
  const id = 'session:large-transcript', journal = new InMemoryCommandJournal();
  await createSession(journal, id);
  const length = 17 * 1024 * 1024;
  for (let i = 0; i < 28; i++) {
    await journal.append({ sessionId: id, type: 'message.committed', ...(i ? { runId: 'run:steered' } : {}), payload: {
      role: 'user', messageId: 'message:' + i, content: i === 0 ? 'x'.repeat(length) : 'row ' + i,
    } });
  }
  const materialized = [];
  const read = journal.readTranscriptFacts.bind(journal);
  journal.readTranscriptFacts = async (...args) => {
    const facts = await read(...args);
    materialized.push(facts !== null);
    return facts;
  };
  const service = new SessionService(journal, { async create() { assert.fail('unexpected actor'); } });
  t.after(() => service.dispose());
  const page = async around => (await service.read({ sessionId: id, view: 'transcript', around })).transcript;
  const first = await page(1);
  assert.equal(first.content.messages[0].content.length, length);
  assert.ok(first.next > first.end);
  const next = await page(first.next);
  assert.equal(next.start, first.end + 1);
  assert.equal(next.content.messages.at(-1).messageId, 'message:27');
  assert.deepEqual(materialized, [true, false]);
});
