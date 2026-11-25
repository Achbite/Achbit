import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../dist/index.js';
import { decodeConversationReadQuery } from '../dist/local-agent/conversationRead.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, emptyKernel, fakeRunPreparation, messageCommand, providerEvent, waitForProjection } from './local-agent-fixtures.mjs';

const view = 'readingWindow';
const serviceFor = (journal, t) => {
  const s = new SessionService(journal, { async create() { throw Error('reading_window_opened_an_actor'); } });
  t.after(() => s.dispose()); return s;
};

test('readingWindow requires an exact revision and has independent options; it does not widen older views', () => {
  const sessionId = 's', base = {sessionId, view, throughSequence: 6};
  assert.deepEqual(decodeConversationReadQuery({...base, anchorKey:'provider-stream:'+JSON.stringify(['s'.repeat(180),'run','r'.repeat(180),0]),limit:24}).limit, 24);
  for (const options of [{throughSequence:undefined},{throughSequence:0},{anchorKey:''},{limit:0},{limit:25},{limit:1.1},{messageId:'x'},{before:2},{offset:0},{imageIds:[]}]) {
    assert.throws(() => decodeConversationReadQuery({...base,...options}), /conversation_read_invalid/);
  }
  for (const v of ['summary','messages','tools','plans','images','context','reasoning']) assert.throws(() => decodeConversationReadQuery({...base,view:v,anchorKey:'x'}), /conversation_read_invalid/);
});

test('ordinary edited and rated answers use exactly the full Session timeline, messages and user navigation', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:window-ordinary';
  await createSession(journal, sessionId);
  let calls = 0;
  const actor = actorWith(journal, sessionId, {async *stream(request) {
    ++calls; yield providerEvent(request.requestId, 'text.delta', {text:`# 完整正文 ${calls}\n\n`+'正文🙂 {}'.repeat(3800)});
    yield providerEvent(request.requestId,'completed',{usage:{inputTokens:32,outputTokens:40,contextWindowTokens:100000}});
  }}, emptyKernel(), fakeRunPreparation({contextWindowTokens:100000}).port, 'window');
  t.after(() => actor.dispose());
  for (let i=1;i<=4;i++) {
    await actor.submit(messageCommand(sessionId,'q:'+i, '  Q'+i+' 标记  '));
    await waitForProjection(actor, p => calls===i && p.run?.status==='completed');
  }
  const service=serviceFor(journal,t);
  const oracle=async (anchorKey,limit=3) => {
    const p=await service.snapshot(sessionId), q={sessionId,view,throughSequence:p.revision,limit,...(anchorKey?{anchorKey}:{})};
    const page=await service.read(q), w=page.readingWindow;
    assert.deepEqual([page.sessionId,page.revision,page.items,page.nextBefore,w.kind],[sessionId,p.revision,[],null,'ready']);
    const canonical=p.timeline.map(item=>{assert.equal(item.kind,'message');const message=p.messages.find(m=>m.messageId===item.messageId);return {key:item.streamId??message.messageId,timelineId:item.timelineId,sequence:item.sequence,...(item.streamId?{streamId:item.streamId}:{}),message};});
    assert.deepEqual(w.rows,canonical.slice(w.startIndex,w.startIndex+limit));assert.equal(w.totalRows,canonical.length);
    assert.equal(w.anchorKey,anchorKey??canonical.at(-1).key);assert.ok(w.rows.some(r=>r.key===w.anchorKey));
    const users=canonical.filter(r=>r.message.role==='user');assert.deepEqual(w.navigation,{keys:users.map(r=>r.key),labels:users.map(r=>r.message.content.trim())});
    return {p,w};
  };
  const {p,w}=await oracle();assert.ok(w.rows.at(-1).message.content.length>12*1024);
  await oracle(p.timeline[0].messageId,1);await oracle(p.timeline[3].streamId,3);
  const old=w.rows.at(-1).message;
  await actor.submit({schemaVersion:'achbit.command.v3', type:'message.feedback.set', sessionId, commandId:'feedback:window', messageId:old.messageId, feedback:'up'});
  assert.equal((await oracle()).w.rows.at(-1).message.feedback,'up');
  await assert.rejects(service.read({sessionId,view,throughSequence:p.revision}),/conversation_read_revision_changed/);
  const revision=(await service.snapshot(sessionId)).revision;
  await assert.rejects(service.read({sessionId,view,throughSequence:revision+1}),/conversation_read_revision_changed/);
  await assert.rejects(service.read({sessionId,view,throughSequence:revision,anchorKey:'different-session-row'}),/conversation_read_anchor_not_found/);
  const previousCalls=calls;
  const reply=await actor.submit({schemaVersion:'achbit.command.v3',type:'message.edit',sessionId,commandId:'edit:window',messageId:p.messages[0].messageId,expectedRevision:revision,text:'Replacement'});
  assert.equal(reply.status,'accepted');await waitForProjection(actor,x=>x.run?.status==='completed'&&calls===previousCalls+1);
  const edited=await oracle();assert.deepEqual(edited.w.navigation.labels,['Replacement']);assert.ok(!edited.w.rows.some(r=>r.message.messageId===old.messageId));
});

test('fixed message count: two million Unicode code points of actual transcript text remain complete at tail and middle', async t => {
  const journal=new InMemoryCommandJournal(), sessionId='session:million-body'; await createSession(journal,sessionId);
  const makeText=i=>`${i} begin — `+'abc '.repeat(45)+'\n\n'+'真实正文 Latin🙂 / '.repeat(170)+`\n\n**middle ${i}**\n\n`+'英汉 mixed🙂 '.repeat(90)+`\n\n${i} end`;
  const stored=Array.from({length:1024},(_,i)=>makeText(i));
  assert.ok(stored.reduce((n,s)=>n+[...s].length,0)>=2_000_000);
  await journal.appendBatch(stored.map((content,i)=>({type:'message.committed',sessionId,payload:{role:'user',messageId:'line:'+i,content}})));
  const s=serviceFor(journal,t);const full=await s.snapshot(sessionId);
  // Message count and navigation label length are fixed. A bounded row fits even with
  // the complete 1,024-entry navigation, and the original full text must not become an excerpt.
  for (const requested of [undefined,'line:511']) {
    const page=await s.read({sessionId,view,throughSequence:full.revision,...(requested?{anchorKey:requested}:{}),limit:1});
    assert.equal(page.readingWindow.kind,'ready'); assert.equal(page.readingWindow.anchorKey,requested??'line:1023');
    const row=page.readingWindow.rows[0];assert.deepEqual(row.message,full.messages.find(m=>m.messageId===row.key));
    assert.deepEqual(page.readingWindow.navigation.keys,full.messages.map(m=>m.messageId));
  }
  assert.deepEqual(full.messages.map(m=>m.content),stored);
});

test('an over-budget row has no excerpt window; off-screen journal and permission errors propagate', async t=>{
  const j=new InMemoryCommandJournal(), sessionId='session:oversized-window';await createSession(j,sessionId);
  await j.append({type:'message.committed',sessionId,payload:{role:'user',messageId:'big',content:'x'.repeat(300000)}});
  const s=serviceFor(j,t); const revision=(await s.snapshot(sessionId)).revision;
  assert.deepEqual((await s.read({sessionId,view,throughSequence:revision})).readingWindow,{kind:'requiresProjection'});
  const full=j.read.bind(j);j.read=async function*(id){for await(const e of full(id)){yield {...e,sequence:e.sequence+1};}};
  await assert.rejects(s.read({sessionId,view,throughSequence:revision}),/session_event_sequence_gap/);
  j.read=async function*(){throw Error('original_permission_denial');};await assert.rejects(s.read({sessionId,view,throughSequence:revision}),/original_permission_denial/);
});
