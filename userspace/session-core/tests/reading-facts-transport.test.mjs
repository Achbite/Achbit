import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpCommandJournal } from '../dist/local-agent/httpPorts.js';
import { readSessionEvents } from '../dist/local-agent/conversationRead.js';
const sid='s', media='application/vnd.achbit.reading-facts-v1+json-seq';
const event=(sequence,type,payload)=>({sessionId:sid,sequence,type,payload,eventId:'e:'+sequence,schemaVersion:'achbit.session-event.v5',occurredAt:'test'});
const created=event(1,'session.created',{}), entry={messageId:'same',content:'原始🙂[a,b]+',future:{value:[1,2]}};
const before=event(2,'context.composed',{messages:[entry,{...entry,content:'old'}],extra:'same'});
const suffix=event(3,'context.composed',{messages:[{...entry,content:'new'}],extra:'unchanged non-array field'});
const prefix={readingPrefix:1,baseSequence:2,prefixCount:1,event:suffix};
const receipt={count:3,permissions:{s:{revision:3,settings:{}}}};
const frame=x=>'\x1e'+JSON.stringify(x)+'\n';
const response=records=>{const bytes=Buffer.from(records.map(frame).join(''));return new Response(new ReadableStream({start(c){
  for(let i=0;i<bytes.length;i+=19)c.enqueue(bytes.subarray(i,i+19)); c.close();
}}),{headers:{'content-type':media}});};
test('private prefix frames reconstruct every original logical event, not just projected messages',async()=>{
  const end=event(4,'context.composed',{messages:[],extension:{x:true}});
  const j=new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'test',fetchImpl:async(u,init)=>{
    assert.ok(init.headers.accept.includes(media));assert.ok(init.headers.accept.includes('application/json-seq'));assert.equal(init.headers['x-achbit-session-service-token'],'test');
    return response([created,before,prefix,{readingPrefix:1,baseSequence:3,prefixCount:1,event:end},{...receipt,count:4}]);}});
  assert.deepEqual(await readSessionEvents(j,sid,true),[created,before,{...suffix,payload:{...suffix.payload,messages:[entry,...suffix.payload.messages]}},{...end,payload:{...end.payload,messages:[entry]}}]);
});
test('damaged private bases, counts, identities and incomplete publications never publish permission changes',async()=>{
  for(const bad of [[created,prefix,receipt],[created,before,{...prefix,baseSequence:1},receipt],[created,before,{...prefix,prefixCount:3},receipt],
    [created,before,{...prefix,readingPrefix:2},receipt],[created,before,{...prefix,event:{...suffix,sessionId:'other'}},receipt],
    [created,before,{...prefix,event:{...suffix,payload:{messages:'broken'}}},receipt],[created,before,prefix],
    [created,before,prefix,{...receipt,count:2}],[created,{...before,sessionId:'other'},{...receipt,count:2}],
    [created,{...before,sequence:4},{...receipt,count:2}]]){
    const seen=[];const j=new HttpCommandJournal({apiBase:'http://fixture',serviceToken:'test',fetchImpl:async()=>response(bad)});
    j.subscribePermissions(sid,v=>seen.push(v));await assert.rejects(readSessionEvents(j,sid,true));assert.deepEqual(seen,[]);
  }
});
