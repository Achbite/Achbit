import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../dist/index.js';

test('catalog status batches preserve input order, caller-specific revisions, and replay only edited histories', async t => {
  const ids=Array.from({length:260},(_,i)=>'session:catalog-'+i);
  const selected=ids[5];
  const run={type:'run.started',runId:'run:original',sessionId:selected,sequence:2,payload:{}};
  const edit={type:'conversation.revised',sessionId:selected,sequence:3,payload:{fromSequence:2,throughSequence:2}};
  const current={type:'run.started',runId:'run:current',sessionId:selected,sequence:4,payload:{}};
  let facts=[run], bad=false;const calls=[];
  const journal={
    async readRunLifecycles(cursors){
      calls.push(cursors);
      return cursors.map(({sessionId,after})=>({sessionId:bad?'session:wrong':sessionId,
        revision:sessionId===selected?facts.at(-1).sequence:1,events:sessionId===selected?facts.filter(e=>e.sequence>after):[]}));
    },
    async readRunLifecycle(){throw new Error('unexpected_per_session_request');},
  };
  const service=new SessionService(journal,{});t.after(()=>service.dispose());
  let result=await service.statuses(ids);
  assert.deepEqual(result.map(r=>r.sessionId),ids);
  assert.equal(result[5].run.runId,'run:original');assert.equal(result[5].revision,2);
  assert.ok(calls.length>1 && calls.length<10,'a large catalog uses bounded batches');
  facts=[run,edit,current];calls.length=0;
  result=await service.statuses(ids);
  assert.equal(result[5].run.runId,'run:current');assert.equal(result[5].revision,4);
  assert.deepEqual(calls.filter(batch=>batch.some(q=>q.after===0)),[[{sessionId:selected,after:0}]]);
  assert.deepEqual(await service.statuses([selected,selected]),[result[5],result[5]]);
  bad=true;await assert.rejects(service.statuses(ids.slice(0,2)),/session_event_identity_mismatch/);
});

test('unavailable batch support limits concurrent legacy reads without changing their statuses or errors',async t=>{
  const ids=Array.from({length:130},(_,i)=>'session:old-'+i);
  let running=0,peak=0,failed=false;
  const journal={async readRunLifecycles(){return undefined;},async readRunLifecycle(sessionId){
    running++;peak=Math.max(peak,running);
    try{await new Promise(r=>setImmediate(r));if(failed && sessionId===ids[2])throw new Error('original_store_error');
      return {sessionId,revision:2,events:[]};}finally{running--;}
  }};
  const service=new SessionService(journal,{});t.after(()=>service.dispose());
  assert.deepEqual((await service.statuses(ids)).map(r=>r.sessionId),ids);
  assert.ok(peak<ids.length && peak>0,'limited legacy requests');
  failed=true;await assert.rejects(service.statuses(ids),/original_store_error/);
});
