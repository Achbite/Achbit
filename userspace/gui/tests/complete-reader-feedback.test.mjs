// TCR: T-020-GUI_Startup-20261121/locality-fix/revision-window/stable-reader-evolution-01/TCR.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { loadGuiModule, loadGuiModelStore, installGuiFetch } from './gui-projection-contract.mjs';

test('visible unrendered page geometry cannot count as the reading scene; offscreen and zero height gaps do not hold it',async t=>{
 const {visibleReadingGap}=await loadGuiModule(t,'/tests/support/firstConversationFrame.ts');
 const rect=(top,height)=>({top,bottom:top+height,left:0,right:400,width:400,height});let parts=[];
 const body={getBoundingClientRect:()=>rect(100,300),querySelectorAll:()=>parts.map(r=>({getBoundingClientRect:()=>r}))};
 parts=[rect(-50,150),rect(400,20),rect(110,0)];assert.equal(visibleReadingGap(body),false);
 parts.push(rect(398,4));assert.equal(visibleReadingGap(body),true);
});

test('only a continuously observed, identical admitted parent can reuse its output membership; child events and reconnect invalidate it',async t=>{
 const {ChildDeliveryIndex}=await loadGuiModule(t,'/src/components/local-agent/childDeliveryIndex.ts');const cache=new ChildDeliveryIndex();const p={sessionId:'root',run:{status:'completed'}},items=[{artifactId:'first'}],children=new Set(['child','grandchild']);
 cache.connection(true);cache.save(p,children,items,new Set());assert.equal(cache.get(p),items);assert.equal(cache.get({...p}),undefined);
 cache.changed('unrelated');assert.equal(cache.get(p),items);const changes=new Set(),stop=cache.subscribe(id=>changes.add(id));cache.changed('grandchild');stop();assert.equal(cache.get(p),undefined);
 cache.save(p,children,items,changes);assert.equal(cache.get(p),undefined);cache.save(p,children,items,new Set());cache.connection(false);assert.equal(cache.get(p),undefined);
});

function prepare(t) {return (async()=>{
 const store=await loadGuiModelStore(t),id='session:feedback', p=projectSession(emptySessionState(id));p.revision=3;
 const profile={id:'p:test',enabled:true,thinking:'disabled'};store.setState({sessionId:id,projection:p,profiles:[profile],selectedProfileId:profile.id,runtimeReady:true});
 const submitted=Promise.withResolvers(),receipt=Promise.withResolvers(),startedRead=Promise.withResolvers(),full=Promise.withResolvers();
 installGuiFetch(t,async(url,init)=>{
  if(url.pathname.endsWith('/commands')){const c=JSON.parse(init.body);submitted.resolve(c);return Response.json({ok:true,data:{schemaVersion:'achbit.command-reply.v3',sessionId:id,commandId:c.commandId,revision:4,...await receipt.promise}})}
  if(url.pathname.endsWith('/projection')){startedRead.resolve();await full.promise;return Response.json({ok:true,data:{...p,revision:4}})}
  if(url.pathname.endsWith('/plugins'))return Response.json({ok:true,data:{revision:'r',plugins:[]}});
  if(url.pathname.endsWith('/catalog'))return Response.json({ok:true,data:{projects:[],sessions:[]}});
  throw Error('unexpected test route '+url.pathname);
 });
 return {store,id,p,submitted,receipt,startedRead,full};
 })()}

test('a slow ordinary send reports submitting, then its authenticated acceptance while full is held; it never invents a committed row',async t=>{
 const f=await prepare(t);const sent=f.store.getState().sendMessage('real draft');const c=await f.submitted.promise;
 try { assert.deepEqual(f.store.getState().messageSubmission,{sessionId:f.id,commandId:c.commandId,phase:'sending',text:'real draft'});
  f.receipt.resolve({status:'accepted'});await f.startedRead.promise;
  assert.deepEqual(f.store.getState().messageSubmission,{sessionId:f.id,commandId:c.commandId,phase:'accepted',text:'real draft',revision:4});
  assert.equal((await sent).status,'accepted');
  assert.equal(f.store.getState().projection.messages.length,0);
 }finally{f.receipt.resolve({status:'accepted'});f.full.resolve();await sent;await new Promise(setImmediate)}
 assert.equal(f.store.getState().messageSubmission,null);
});

test('a committed message followed by a failed display read stays accepted and the original read error remains visible',async t=>{
 const f=await prepare(t);const sent=f.store.getState().sendMessage('accepted once');await f.submitted.promise;
 f.receipt.resolve({status:'accepted'});await f.startedRead.promise;f.full.reject(Error('current display is unavailable'));
 const reply=await sent;assert.equal(reply.status,'accepted');await new Promise(setImmediate);assert.match(f.store.getState().error,/current display is unavailable/);
 assert.equal(f.store.getState().errorSource,'projection');assert.equal(f.store.getState().messageSubmission,null);
});

test('a reply from another command is not acceptance; submission feedback cannot leak through a selection change',async t=>{
 const f=await prepare(t);const sent=f.store.getState().sendMessage('first');await f.submitted.promise;
 f.store.getState().startNewSession();assert.equal(f.store.getState().messageSubmission,null);
 f.receipt.resolve({status:'accepted',commandId:'command:wrong'});f.full.resolve();await assert.rejects(sent,/conversation_command_reply_identity/);
 assert.equal(f.store.getState().messageSubmission,null);assert.equal(f.store.getState().sessionId,null);
});
