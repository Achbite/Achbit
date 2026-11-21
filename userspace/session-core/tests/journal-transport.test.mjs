import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpCommandJournal } from '../dist/local-agent/httpPorts.js';

const sid = 'session:transport';
const event = { type:'message.committed', schemaVersion:'achbit.session-event.v5', sessionId:sid, sequence:2,
  payload:{role:'user',content:'读🦉\n\u001e "quoted" ' + '文字'.repeat(1024)} };
const settings = {'agent.permissions.shell':'ask','agent.permissions.workspaceMutation':'plan'};
const permissions = {[sid]:{revision:4,settings}};
const frame = value => '\u001e' + JSON.stringify(value,null,2) + '\n';

function sequence(text, width) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  let cursor = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (cursor >= bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, cursor + width);
    controller.enqueue(bytes.subarray(cursor,end)); cursor=end;
  }}), {headers:{'content-type':'application/json-seq'}});
}

test('negotiated journal reads validate all frames before exposing events or permissions and can retry', async () => {
  let reply;
  const journal = new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'secret',fetchImpl:async (url,init) => {
    assert.equal(new URL(url).searchParams.get('after'),'1');
    assert.equal(init.headers.accept,'application/json-seq');
    assert.equal(init.headers['x-achbit-session-service-token'],'secret');
    return reply;
  }});
  const delivered = [];
  journal.subscribePermissions(sid, value => delivered.push(value));
  const valid = frame(event)+frame({count:1,permissions});
  for (const damaged of [frame(event),valid.slice(0,-1),valid+frame(event),frame(event)+frame({count:2,permissions}),
    frame(event)+frame({count:1,permissions:null}),frame(event)+frame({count:1,permissions:{...permissions,other:{revision:-1,settings}}}),frame(event)+'\u001e{broken}\n',Buffer.from([30,0xff,10])]) {
    reply=sequence(damaged,71);
    await assert.rejects(journal.read(sid,1)[Symbol.asyncIterator]().next(),/journal_sequence_invalid/);
    assert.deepEqual(delivered,[]);
  }
  for (const width of [3,65536]) {
    reply=sequence(valid,width);
    const read=journal.read(sid,1)[Symbol.asyncIterator]();
    assert.deepEqual(await read.next(), {value:event,done:false});
    assert.equal(delivered.length,1);
    assert.equal(delivered[0]['agent.permissions.workspaceMutation'],'plan');
    assert.equal((await read.next()).done,true);
  }
  reply=sequence(frame({count:0,permissions:{}}),11);
  assert.equal((await journal.read(sid,1)[Symbol.asyncIterator]().next()).done,true);
});

test('sequence framing reads only the byte windows published by the transport', async () => {
  const journal = new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'fixture',fetchImpl:async () => {
    const bytes = Buffer.from(frame(event)+frame({count:1,permissions}));
    // Both excluded ends contain invalid record bytes. Split inside multibyte text too.
    return new Response(new ReadableStream({start(out) {
      for (let at=0; at<bytes.length; at+=37) {
        const part = bytes.subarray(at,at+37);
        const slab = new Uint8Array(part.length+8).fill(0x1e);
        slab.set(part,3); out.enqueue(slab.subarray(3,3+part.length));
      }
      out.close();
    }}), {headers:{'content-type':'application/json-seq'}});
  }});
  const seen=[]; journal.subscribePermissions(sid, settings=>seen.push(settings));
  assert.deepEqual(await Array.fromAsync(journal.read(sid,1)), [event]);
  assert.equal(seen.length,1);
});

test('a malformed byte window cancels an unfinished response without publishing permissions', async () => {
  let cancellations=0;
  const slab=Uint8Array.of(0,30,255,10,30,0);
  const body=new ReadableStream({
    start(controller) { controller.enqueue(slab.subarray(1,5)); },
    cancel() { cancellations++; },
  });
  const journal=new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'fixture',fetchImpl:async () =>
    new Response(body,{headers:{'content-type':'application/json-seq'}})});
  const seen=[]; journal.subscribePermissions(sid,settings=>seen.push(settings));
  await assert.rejects(journal.read(sid)[Symbol.asyncIterator]().next(),/journal_sequence_invalid/);
  assert.equal(cancellations,1); assert.equal(body.locked,false); assert.deepEqual(seen,[]);
});

test('legacy JSON responses, missing version capability and original journal errors remain usable', async () => {
  let reply;
  const journal = new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'secret',fetchImpl:async () => reply});
  reply=new Response('Not found',{status:404});
  assert.equal(await journal.historyVersion(),undefined);
  reply=Response.json({ok:true,data:{value:[event],permissions:{}}});
  assert.deepEqual(await Array.fromAsync(journal.read(sid)),[event]);
  reply=Response.json({ok:false,error:'session_event_corrupt',message:'original row diagnostic'});
  await assert.rejects(Array.fromAsync(journal.read(sid)),err => err.code==='session_event_corrupt' && err.message==='original row diagnostic');
});

test('archive owner preflight is a private non-deleting request and fails on an absent or invalid receipt', async () => {
  const members = [sid, 'session:child']; let reply;
  const journal = new HttpCommandJournal({ apiBase: 'http://fixture', serviceToken: 'private', fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/local-agent/journal/check-deletion');
    assert.equal(init.method, 'POST'); assert.equal(init.headers['x-achbit-session-service-token'], 'private');
    assert.deepEqual(JSON.parse(init.body), members); return reply;
  } });
  reply = Response.json({ ok: false, error: 'session_delete_active_run', message: 'original owner error' });
  await assert.rejects(journal.assertSessionsDeletable(members), e => e.code === 'session_delete_active_run' && e.message === 'original owner error');
  reply = Response.json({ ok: true });
  await assert.rejects(journal.assertSessionsDeletable(members), /session_delete_check_invalid/);
  reply = Response.json({ ok: true, data: true });
  await journal.assertSessionsDeletable(members);
});

test('a selected message publication requires its complete source revision before an observer receives permissions', async () => {
  let reply;
  const journal = new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'fixture',fetchImpl:async () => reply});
  const seen=[];
  journal.subscribePermissions(sid,value=>seen.push(value));
  reply=sequence(frame(event)+frame({count:1,permissions}),551);
  await assert.rejects(journal.readMessageHistory(sid),/message_history_revision_missing/);
  assert.deepEqual(seen,[]);
  reply=sequence(frame(event)+frame({count:1,revision:20,permissions}),551);
  assert.deepEqual(await journal.readMessageHistory(sid),{revision:20,events:[event]});
  assert.equal(seen.length,1);
  reply=new Response('Not found',{status:404});
  assert.equal(await journal.readMessageHistory(sid),undefined);
});
